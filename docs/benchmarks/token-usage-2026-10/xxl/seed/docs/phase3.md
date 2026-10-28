# 第三阶段：并发冲突、WIP 上限、批量操作、实时同步、完成统计

在前两个阶段的基础上继续做。前两个阶段的全部要求和验收测试仍然有效。硬性约束不变：不装依赖，不能改 `tests/acceptance/`，`npm test` 全部通过才算完成。

## 1. 版本号和冲突检测

- 看板、列、卡片都多一个整数字段 `version`：新建时是 1，每次被修改（改名、改字段、移动、归档、取消归档、position 因别的操作重排不算）加 1。撤销 / 重做把对象恢复成某个状态时，`version` 也要再加 1（不是恢复成旧的版本号）。
- 修改请求（`PATCH /api/boards/:id`、`PATCH /api/columns/:id`、`PATCH /api/cards/:id`、`POST /api/cards/:id/move`、`/archive`、`/unarchive`）可以带请求头 `If-Match: <version>`。和当前版本不一致：409，code `conflict`，错误体里多一个 `current` 字段，是这个对象当前的完整内容。不带这个头就不检查。
- 响应带 `ETag: "<version>"` 头（GET 单个看板时是看板的版本；修改卡片、列时是那个对象的新版本）。
- 旧数据没有 `version` 的，启动时补成 1。

## 2. 列的 WIP 上限和完成列

- 列多两个字段：`wipLimit`（`null` 或 1–999 的整数，默认 `null`）和 `isDone`（布尔，默认 `false`），都能通过 `POST /api/boards/:id/columns` 和 `PATCH /api/columns/:id` 设置。
- 一列里未归档的卡片数已经达到 `wipLimit` 时，往这列新建卡片、把别的列的卡片移进来、在这列取消归档：409，code `wip_limit`。同一列里移动不受限制。请求加查询参数 `?force=1` 可以越过上限。把 `wipLimit` 改得比现有卡片数小是允许的（只拦以后放进来的）。
- 卡片多一个字段 `completedAt`：移进 `isDone` 的列时设为当前时间，从 `isDone` 的列移出去时变回 `null`。在 `isDone` 的列里直接新建的卡片，`completedAt` 是创建时间。把一列改成 `isDone` / 取消 `isDone` 时，这列现有卡片的 `completedAt` 跟着设上 / 清空。

## 3. 批量操作

`POST /api/boards/:id/bulk`，请求体 `{ cardIds: [...], action, ... }`：

| action | 额外字段 | 效果 |
|---|---|---|
| `move` | `columnId` | 把这些卡片按 `cardIds` 的顺序追加到目标列底部 |
| `archive` | – | 全部归档 |
| `delete` | – | 全部删除 |
| `label` | `labelId`、`mode: "add" \| "remove"` | 给全部加上 / 去掉一个标签 |
| `priority` | `priority` | 全部设成这个优先级 |

- 全有或全无：`cardIds` 为空、有重复、有不存在或不属于这个看板的卡片、`move` 违反 WIP 上限（按移动后的总数算，同样可以 `?force=1`）、`archive` 里有已归档的卡片，等等——任何一条不满足就返回错误（400 `validation`，WIP 是 409 `wip_limit`，不存在的卡片 404 `not_found`），**什么都不改**。
- 成功返回 `{ board: <完整看板>, count: <处理的卡片数> }`，状态 200。
- 一次批量操作在撤销历史里只算一步，活动日志里只记一条，type 是 `bulk.<action>`（如 `bulk.move`），summary 写上卡片数。

## 4. 实时同步（Server-Sent Events）

- `GET /api/boards/:id/events` 返回 `text/event-stream`，连接后马上发一条 `event: hello`（data 是 `{"version": <看板版本>}`）。
- 之后这个看板每发生一次会改变数据的操作（包括撤销、重做、批量、导入不算因为是新看板），推一条 `event: change`，data 是 JSON：`{ "type": <和活动日志的 type 一样>, "boardId": ..., "cardId"?: ..., "columnId"?: ... }`。看板改名推 `board.updated`，删除看板推 `board.deleted` 然后关闭连接。
- 每 15 秒发一条注释行（`: ping`）保活。客户端断开时服务器要清理，不能泄漏。
- 看板不存在：404 `not_found`（普通 JSON 错误）。

## 5. 统计

`GET /api/boards/:id/stats?today=YYYY-MM-DD` 返回：

```json
{
  "totalCards": 12,
  "archivedCards": 2,
  "byColumn": [{ "columnId": "…", "name": "Todo", "count": 5, "wipLimit": 6 }],
  "byLabel": [{ "labelId": "…", "name": "bug", "count": 3 }],
  "byPriority": { "low": 1, "normal": 8, "high": 3 },
  "overdue": 2,
  "completed": 4,
  "avgCycleHours": 30.5
}
```

- 除 `archivedCards` 以外，所有计数只算未归档的卡片。`byColumn` 按列顺序，`byLabel` 按标签创建顺序（计数为 0 的也列出来）。
- `overdue`：有截止日期、早于 today、并且不在完成列里的卡片数。`today` 缺省用服务器本地日期。
- `completed`：在完成列里的卡片数。`avgCycleHours`：这些卡片 `completedAt - createdAt` 的平均小时数，保留一位小数；没有就是 `null`。

## 前端

新增（之前的 `data-testid` 全部保留）：

- 每列标题旁边显示 `column-wip`：有上限时是 `数量/上限`（如 `3/4`），满了要有警示样式并带 `data-full="true"`；没有上限时显示数量。完成列带 `data-done="true"` 属性（加在 `column` 容器上）。
- 列设置：每列有 `column-settings` 按钮，打开后有上限输入框 `column-wip-input`（空表示不限）、完成列复选框 `column-done-input`、保存按钮 `column-settings-save`。
- 被 WIP 上限或冲突挡回的操作要给用户提示：`toast` 元素出现，文字说明原因（WIP 的提示里要有"上限"或"WIP"，冲突的提示里要有"冲突"或"conflict"），然后界面恢复成服务端的真实状态。
- 前端修改卡片和列时要带 `If-Match`，所以两个人同时改同一张卡片时，后保存的那个人会收到冲突提示。
- 打开看板后订阅 SSE：别处（另一个标签页、API）的修改，2 秒内自动出现在页面上，不用刷新。断线后自动重连。
- 多选和批量：每张卡片有复选框 `card-select`；选中至少一张时出现批量工具栏 `bulk-bar`，上面有 `bulk-archive`、`bulk-delete` 按钮，以及移动用的 `<select data-testid="bulk-move-target">`（选项的 value 是列 id）和 `bulk-move` 按钮。操作完成后清空选择。
- 统计面板 `stats-panel`：里面显示总卡片数 `stats-total`、逾期 `stats-overdue`、完成数 `stats-completed`、平均周期 `stats-cycle`（文字里包含小时数，没有时显示 `—`），数据变化后自动更新。

README 补上新功能和新 API。
