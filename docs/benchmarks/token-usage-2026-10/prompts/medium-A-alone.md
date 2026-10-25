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
