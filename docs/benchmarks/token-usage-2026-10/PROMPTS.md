# 三轮测试用的 prompt

## 第 1 轮：规格版任务，dsh-baton 0.5.9（小、中、大 × A/B × 2 次）

## 第 2 轮：规格版任务，精简版 dsh-baton（只跑 B 组：中、大）

两轮用的是同一套文件。B 组 = A 组原文 + 最后一行「交给 DeepSeek Harness。」

### small（A 组原文）

```
在当前文件夹写一个单文件 Node.js 命令行工具 todo.mjs，只用 Node 内置模块（Node 18+），不要 package.json 以外的依赖。

- 数据存在环境变量 TODO_FILE 指定的路径；没设时用当前目录的 todo.json。文件不存在时当作空列表。
- `node todo.mjs add <文本...>`：添加一条（多个参数用空格连起来），id 取现有最大 id + 1（从 1 开始），输出 `added <id>`。
- `node todo.mjs list`：每条一行，未完成 `<id>. [ ] <文本>`，已完成 `<id>. [x] <文本>`，按 id 升序；没有任务时输出 `no tasks`。
- `node todo.mjs done <id>`：标记完成，输出 `done <id>`。
- `node todo.mjs rm <id>`：删除，输出 `removed <id>`。
- done/rm 的 id 不存在时，往 stderr 输出 `not found: <id>`，退出码 1。
- 没有命令或命令未知时，往 stderr 输出用法说明，退出码 2。

写完自己跑一遍确认能用。
```

### medium（A 组原文）

```
在当前文件夹做一个任务管理命令行工具，Node.js（18+），只用内置模块，分成几个文件，并带测试。

结构：
- `package.json`（`"type": "module"`，`npm test` 运行 `node --test`）
- `src/storage.mjs`：读写数据文件。路径取环境变量 TASKS_FILE，没设时用当前目录的 tasks.json；文件不存在当作空列表；写入先写临时文件再 rename。
- `src/tasks.mjs`：增删改查、过滤、排序、统计、导出的纯逻辑。
- `src/cli.mjs` 和入口 `tasks.mjs`（`node tasks.mjs <命令>`）。
- `test/` 下至少 8 个 node:test 测试，覆盖逻辑和命令行。

任务字段：id（从 1 递增，取最大 id + 1）、text、priority（high / medium / low，默认 medium）、due（YYYY-MM-DD 或空）、tags（字符串数组）、done（布尔）。

命令：
- `add <文本...> [--priority P] [--due YYYY-MM-DD] [--tag T]...`：输出 `added <id>`。priority 或 due 格式不对时 stderr 输出 `invalid <字段>: <值>`，退出码 2。
- `list [--status open|done|all] [--tag T] [--priority P]`：默认只列未完成。排序：priority（high 在前）、再按 due（有日期的在前，早的在前）、再按 id。每行用 Tab 分隔：`<id>\t<open|done>\t<priority>\t<due 或 ->\t<text>\t<tags 用逗号连接或 ->`。没有结果时输出 `no tasks`。
- `done <id>`、`rm <id>`：输出 `done <id>`、`removed <id>`。
- `edit <id> [--text 新文本] [--priority P] [--due YYYY-MM-DD|none]`：输出 `updated <id>`；`--due none` 清空日期。
- `stats`：输出一行 `open: <n>, done: <n>, overdue: <n>`。overdue 是未完成且 due 早于今天的数量；"今天"取环境变量 TASKS_TODAY（YYYY-MM-DD），没设时用本地日期。
- `export --format csv`：第一行 `id,text,priority,due,tags,status`，之后每条一行，按 id 升序；tags 用分号连接；status 是 open 或 done；包含逗号或引号的字段按 CSV 规则加双引号。
- id 不存在时 stderr 输出 `not found: <id>`，退出码 1；命令未知时 stderr 输出用法，退出码 2。

写完运行 `npm test` 并确认全部通过。
```

### large（A 组原文）

```
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
```

## 第 3 轮：自然语言任务（进行中）

A 组、B 组 0.5.9、B 组 evidence、B 组 courier 四种都用同一段话。B 组只在最后加一行「交给 DeepSeek Harness 去做。」

### medium

```
帮我在这个文件夹里做个命令行的任务管理小工具，用 Node 写，别装第三方依赖。入口叫 tasks.mjs，大概 node tasks.mjs add/list/done/rm 这种用法。

想要的功能：加任务的时候可以设优先级（高中低）、截止日期和几个标签；列表默认只看没做完的，按优先级和日期排好，也能按标签或优先级筛；能改任务、标完成、删掉；能看个统计，比如还剩几个、做完几个、过期几个；还能导出 CSV。数据存在本地一个 JSON 文件里，路径可以用环境变量 TASKS_FILE 指定。

代码别全塞一个文件，分几个模块，再写点测试，npm test 能跑。
```

### large

```
帮我在这个文件夹里做个任务管理的小网页应用：一个 Node 写的服务器加一个前端页面，零依赖，别用框架和 CDN。

服务器用 npm start 启动，端口读 PORT 环境变量，数据存成 JSON 文件，路径读 DATA_FILE 环境变量。接口走 REST 风格，放在 /api/tasks 下面，能增删改查；任务有标题、优先级、截止日期、标签和是否完成；再给一个 /api/stats 返回还剩几个、做完几个、过期几个。乱传参数要返回 400，找不到返回 404。

页面上能看列表、按状态和优先级筛选、搜索，能新增、勾选完成、删除和改标题，顶部显示统计，手机上看也别乱。

写测试，npm test 能跑，再写个 README 说明怎么用。
```
