# 第二阶段：标签、截止日期、搜索、归档、撤销、活动日志、导入导出

在第一阶段的基础上继续做。第一阶段的全部要求和验收测试仍然有效（`tests/acceptance/phase1.*` 也必须继续通过）。硬性约束不变：不装依赖，不能改 `tests/acceptance/`，`npm test` 全部通过才算完成。

## 数据模型变化

- 看板多一个 `labels: [{ id, name, color }]`（按创建先后）。
- 卡片多四个字段：
  - `labels`：标签 id 数组（只能是同一看板的标签），默认 `[]`
  - `dueDate`：`"YYYY-MM-DD"` 或 `null`，默认 `null`，必须是真实存在的日期（`2026-02-30` 不行）
  - `priority`：`"low" | "normal" | "high"`，默认 `"normal"`
  - `archived`：布尔，默认 `false`
- 旧数据（第一阶段存下来的文件）启动时要能读，缺的字段按默认值补上。

## 新增和变化的 API

| 方法 | 路径 | 说明 | 成功 |
|---|---|---|---|
| POST | `/api/boards/:id/labels` | `{ name, color }` 新建标签。`name` 去空白后 1–50 字符，同一看板里不区分大小写不能重名（重名 409，code `duplicate`）；`color` 是 `#rrggbb` | 201 |
| DELETE | `/api/labels/:id` | 删除标签，并从所有卡片上去掉 | 204 |
| PATCH | `/api/cards/:id` | 新增可改字段 `labels`、`dueDate`、`priority` | 200 |
| POST | `/api/cards/:id/archive` | 归档，返回卡片 | 200 |
| POST | `/api/cards/:id/unarchive` | 取消归档，放回原列的最底部，返回卡片 | 200 |
| GET | `/api/boards/:id?includeArchived=1` | 默认不返回归档卡片；带这个参数时，每列的 `cards` 先按 position 列出未归档的，再列出归档的 | 200 |
| GET | `/api/boards/:id/search?q=...&today=YYYY-MM-DD` | 搜索，返回 `{ cards: [...] }` | 200 |
| POST | `/api/boards/:id/undo` | 撤销，返回完整看板 | 200 |
| POST | `/api/boards/:id/redo` | 重做，返回完整看板 | 200 |
| GET | `/api/boards/:id/activity?limit=N` | 活动日志 | 200 |
| GET | `/api/boards/:id/export` | 导出 JSON | 200 |
| GET | `/api/boards/:id/export.csv` | 导出 CSV | 200 |
| POST | `/api/import` | 导入 JSON，新建一个看板，返回完整看板 | 201 |

### 归档

- 归档的卡片不占列里的位置：`position` 变成 `null`，同列其他卡片重新连续编号。归档的卡片不能移动（400 `validation`），但可以 PATCH。
- 对已归档的再归档、对未归档的取消归档：400 `validation`。

### 搜索语法

`q` 按空白切成若干条件，双引号包起来的部分算一个（`"in review"`、`label:"in review"`）。所有条件同时满足（AND）。条件前加 `-` 表示取反。

| 条件 | 含义 |
|---|---|
| 普通词或短语 | 标题或描述里包含它（不区分大小写） |
| `label:名字` | 带这个标签（名字不区分大小写） |
| `column:名字` | 在这一列（不区分大小写） |
| `priority:low/normal/high` | 优先级等于 |
| `due:overdue` | 有截止日期且早于 today |
| `due:today` | 截止日期等于 today |
| `due:none` | 没有截止日期 |
| `due:YYYY-MM-DD`、`due:<日期`、`due:<=日期`、`due:>日期`、`due:>=日期` | 按截止日期比较；没有截止日期的卡片不满足任何比较 |
| `is:archived` | 已归档 |

- 默认不搜归档卡片；只有出现 `is:archived` 时才只搜归档卡片（`-is:archived` 等于默认）。
- `today` 参数缺省时用服务器本地日期。
- 不认识的前缀（比如 `foo:bar`）当普通词。`due:` 后面的值不合法、`priority:` 后面不是三个值之一：400 `validation`。
- 空的 `q` 返回所有未归档卡片。
- 结果顺序：先按列的 position，再按卡片 position（归档卡片按 `updatedAt` 从早到晚）。

### 撤销 / 重做

- 每个看板各有一条历史，最多保留最近 50 步。
- 能撤销的操作：卡片的新建、修改、移动、删除、归档、取消归档；列的新建、修改（改名、移动）、删除；标签的新建、删除。看板本身的新建、改名、删除不算。
- 撤销就是回到那一步之前的状态，一模一样（包括 `updatedAt` 等时间戳）；重做回到那一步之后的状态。
- 撤销一次删除要原样恢复：同样的 id、同样的位置、同样的字段，删列要连同卡片一起恢复，删标签要恢复到原来那些卡片上。
- 撤销之后做了新的操作，重做历史清空。
- 没有可撤销的：409，code `nothing_to_undo`；没有可重做的：409，code `nothing_to_redo`。
- 历史不要求重启后保留。

### 活动日志

- 每次能撤销的操作，加上每次撤销、重做，都记一条：`{ id, type, at, summary, cardId?, columnId? }`。
- `type` 取值：`card.created`、`card.updated`、`card.moved`、`card.deleted`、`card.archived`、`card.unarchived`、`column.created`、`column.updated`、`column.deleted`、`label.created`、`label.deleted`、`undo`、`redo`。
- `summary` 是给人看的一句话，要带上卡片标题或列名。
- 返回最新的在前；`limit` 默认 50，最大 200，超过按 200；不是正整数 400 `validation`。
- 活动日志要持久化，重启后还在。

### 导出 / 导入

JSON 导出不含任何 id，格式：

```json
{
  "version": 1,
  "exportedAt": "2026-10-28T12:00:00.000Z",
  "board": {
    "name": "…",
    "labels": [{ "name": "bug", "color": "#ff0000" }],
    "columns": [
      { "name": "Todo", "cards": [
        { "title": "…", "description": "…", "labels": ["bug"], "dueDate": null, "priority": "normal", "archived": false }
      ] }
    ]
  }
}
```

- 每列的卡片先按 position 列未归档的，再按 `updatedAt` 列归档的。卡片的 `labels` 是标签名。
- CSV：`content-type: text/csv`，第一行表头 `column,title,description,labels,dueDate,priority,archived`，行尾 `\r\n`，行的顺序和 JSON 一样。`labels` 用 `;` 连接，`dueDate` 为空时留空，`archived` 写 `true` / `false`。字段里有逗号、双引号、换行时用双引号包起来，里面的双引号写两遍（RFC 4180）。
- 导入：请求体就是导出的 JSON。`version` 必须是 1，结构和字段要满足和 API 一样的校验规则，卡片引用的标签名必须在 `labels` 里。任何一处不合法：400 `validation`，什么都不创建。导入成功生成全新的 id，导出再导入再导出，`board` 部分完全一样。

## 前端

新增元素（第一阶段的 `data-testid` 全部保留）：

- 标签管理（看板页）：输入框 `label-name-input`、颜色 `label-color-input`（`<input type="color">`）、按钮 `label-create`
- 卡片上：每个标签一个 `card-label`（文字是标签名，背景用标签颜色）；优先级 `card-priority`（文字是 `low` / `normal` / `high`）；有截止日期时显示 `card-due`（文字包含 `YYYY-MM-DD`），过期的要有明显的样式，并带 `data-overdue="true"`
- 卡片详情：优先级 `<select data-testid="card-edit-priority">`；截止日期 `<input type="date" data-testid="card-edit-due">`；每个标签一个复选框 `card-edit-label`，带 `data-label-id`；归档按钮 `card-archive`（归档后卡片从列里消失）。这些和标题、描述一起由 `card-save` 保存（归档按钮立即生效）
- 搜索框 `search-input`：输入后 300 毫秒内只显示匹配的卡片（语法和搜索 API 一样，不匹配的卡片不渲染或隐藏）；清空后恢复全部
- 撤销 `board-undo`、重做 `board-redo` 按钮；在看板页按 Ctrl+Z / Cmd+Z 撤销，Ctrl+Shift+Z / Cmd+Shift+Z 重做（焦点在输入框里时不拦截）
- 活动日志面板 `activity-panel`，每条一个 `activity-item`，最新的在上面，操作后自动更新
- 导出按钮 `board-export`（下载 JSON 文件）、`board-export-csv`（下载 CSV 文件）；首页导入：`<input type="file" data-testid="board-import">`，选中 JSON 文件后导入并出现在列表里

README 补上新功能和新 API。
