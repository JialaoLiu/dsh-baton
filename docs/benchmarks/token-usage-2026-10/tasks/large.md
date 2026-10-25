在当前文件夹做一个任务管理网页应用：零依赖的 Node.js（18+）HTTP 服务器加一个静态前端，带测试和 README。只用 Node 内置模块，前端不用框架和 CDN。

结构：
- `package.json`（`"type": "module"`；`npm start` 启动服务器；`npm test` 运行 `node --test`）
- `server.mjs`：入口。端口取环境变量 PORT（默认 3000），数据文件取 DATA_FILE（默认 ./data/tasks.json，文件夹不存在就创建）。
- `src/store.mjs`（读写数据，写入先写临时文件再 rename）、`src/validate.mjs`（输入校验）、`src/routes.mjs`（路由和处理函数）。
- `public/index.html`、`public/app.css`、`public/app.js`：由服务器在 `/`、`/app.css`、`/app.js` 提供，Content-Type 分别是 text/html、text/css、text/javascript（可带 charset）。
- `test/` 下至少 10 个 node:test 测试，测试里在随机端口启动服务器，覆盖全部接口和错误情况。
- `README.md`：怎么启动、怎么测试、接口列表。

任务对象：`{ id, text, priority, due, tags, done, createdAt }`。id 是从 1 递增的整数；priority 是 high / medium / low（默认 medium）；due 是 YYYY-MM-DD 或 null；tags 是字符串数组；createdAt 是 ISO 时间字符串。

接口（请求和响应都是 JSON）：
- `GET /api/tasks`：可用查询参数 `status`（open / done / all，默认 all）、`tag`、`priority`、`q`（text 里不区分大小写的子串）。按 id 升序返回数组。
- `POST /api/tasks`：body `{ text, priority?, due?, tags? }`，成功返回 201 和新任务。text 为空或缺失、priority 或 due 不合法、JSON 解析失败时返回 400 和 `{ "error": "<说明>" }`。
- `PATCH /api/tasks/:id`：可改 text、priority、due（可设为 null）、tags、done，校验规则同上，返回 200 和更新后的任务。
- `DELETE /api/tasks/:id`：返回 204。
- `GET /api/stats`：返回 `{ "open": n, "done": n, "overdue": n }`；overdue 是未完成且 due 早于今天的数量，"今天"取环境变量 TASKS_TODAY（YYYY-MM-DD），没设时用本地日期。
- id 不存在返回 404 和 `{ "error": ... }`；其他未知路径返回 404。

前端：
- 显示任务列表，有按状态、优先级、标签的筛选和文字搜索。
- 添加表单（文本、优先级、截止日期、逗号分隔的标签），提交后不刷新页面就出现在列表里。
- 每条可以勾选完成、删除、点文字后就地编辑。
- 顶部显示 stats 数字，随操作更新。
- 表单控件有 label，窄屏（375px 宽）下不出现横向滚动。

写完运行 `npm test` 确认全部通过，再用 `npm start` 启动一次，用 curl 试一遍接口。
