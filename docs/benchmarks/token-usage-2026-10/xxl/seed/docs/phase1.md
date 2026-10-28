# 第一阶段：看板应用「Tsumiki」的主体

做一个本地运行的看板（Kanban）网页应用：后端是 Node.js HTTP 服务，前端是浏览器里的单页应用。

## 硬性约束

- 只用 Node.js 24 自带的模块，**不要装任何 npm 依赖**（package.json 里不要有 dependencies / devDependencies），前端也不用框架和 CDN，原生 JS + CSS。
- `node server.mjs` 启动服务。端口读环境变量 `PORT`（默认 3000），数据目录读 `DATA_DIR`（默认 `./data`），目录不存在就创建。
- 数据存到 `DATA_DIR` 下的文件里，服务重启后数据还在。写文件要先写临时文件再改名，进程中途被杀也不能留下半个文件。
- `npm test` 跑 `tests/` 下所有测试，验收测试在 `tests/acceptance/`。**不能修改、删除、跳过 `tests/acceptance/` 里的任何文件**，验收时会用原版覆盖。你自己的测试放在 `tests/` 的其他位置，想加多少都行。
- `npm test` 全部通过才算完成。
- `vendor/` 文件夹与本项目无关，不用管。

## 数据模型

- 看板 board：`{ id, name, createdAt, columns }`
- 列 column：`{ id, boardId, name, position }`
- 卡片 card：`{ id, columnId, title, description, position, createdAt, updatedAt }`
- id 是字符串，全局唯一。时间是 ISO 8601 字符串。
- `position` 从 0 开始连续编号（0, 1, 2…）。任何增、删、移动之后，受影响的列里的卡片、看板里的列都要重新编成连续的。

## HTTP API

所有请求和响应体都是 JSON（`content-type: application/json`）。

| 方法 | 路径 | 说明 | 成功 |
|---|---|---|---|
| GET | `/api/health` | `{ "ok": true }` | 200 |
| GET | `/api/boards` | 看板列表 `[{ id, name, createdAt }]`，按创建时间先后 | 200 |
| POST | `/api/boards` | `{ name }` 新建，返回完整看板（`columns: []`） | 201 |
| GET | `/api/boards/:id` | 完整看板：`columns` 按 position 排，每列带 `cards`（按 position 排） | 200 |
| PATCH | `/api/boards/:id` | `{ name }` 改名，返回完整看板 | 200 |
| DELETE | `/api/boards/:id` | 删除看板和它的所有列、卡片 | 204 |
| POST | `/api/boards/:id/columns` | `{ name }` 在最右边加一列，返回列 | 201 |
| PATCH | `/api/columns/:id` | `{ name?, position? }` 改名或移动到新位置，返回列 | 200 |
| DELETE | `/api/columns/:id` | 删除列和列里的卡片 | 204 |
| POST | `/api/columns/:id/cards` | `{ title, description? }` 在列底部加卡片，返回卡片 | 201 |
| PATCH | `/api/cards/:id` | `{ title?, description? }` 修改，返回卡片，`updatedAt` 更新 | 200 |
| POST | `/api/cards/:id/move` | `{ columnId, position }` 移到某列的某个位置（可以是同一列），返回卡片 | 200 |
| DELETE | `/api/cards/:id` | 删除卡片 | 204 |

规则：

- `name`、`title` 先去掉首尾空白，长度必须 1 到 200；`description` 可选，字符串，最长 5000，默认 `""`。
- 移动卡片时 `position` 超出范围就夹到合法范围内（负数当 0，过大放到最后）。列的 `position` 同理。
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`：
  - 校验失败（缺字段、类型错、长度不对）：400，code `validation`
  - 请求体不是合法 JSON：400，code `bad_json`
  - id 不存在：404，code `not_found`
  - 路径不存在：404，code `not_found`
- 不认识的多余字段忽略。

## 前端

`GET /` 返回单页应用，静态文件也由这个服务提供。界面要好看、好用，下面这些元素必须有，并且带指定的 `data-testid`（测试靠它们找元素）：

- 首页（看板列表）：
  - 输入框 `board-name-input`，按钮 `board-create`（点按钮或在输入框里按回车都能新建）
  - 每个看板一项 `board-item`，点击进入该看板
- 看板页（URL 用 hash：`#/boards/<id>`，刷新后还在这个看板）：
  - 看板标题 `board-title`；返回首页的链接或按钮 `back-to-boards`
  - 加列：输入框 `column-name-input`，按钮 `column-create`
  - 每列一个容器 `column`，带属性 `data-column-id` 和 `data-column-name`（列名），列标题 `column-title`
  - 每列里有加卡片的输入框 `card-title-input` 和按钮 `card-create`（回车也行）
  - 每张卡片 `card`，带 `data-card-id`；卡片标题 `card-title`
  - 每张卡片有按钮 `card-move-left`、`card-move-right`（移到左边/右边那一列的底部）、`card-move-up`、`card-move-down`（在本列里上下移一格），和 `card-delete`（删除，不要弹确认框）
  - 卡片还要支持鼠标拖拽到其他列、其他位置
  - 点击卡片标题打开详情：可以编辑标题 `card-edit-title`、描述 `card-edit-description`，按钮 `card-save` 保存
- 操作之后界面要立即反映服务端的结果，刷新页面数据不丢。

## 交付

- 写 README.md：怎么启动、怎么跑测试、功能说明、API 一览。
