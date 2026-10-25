在当前文件夹写一个单文件 Node.js 命令行工具 todo.mjs，只用 Node 内置模块（Node 18+），不要 package.json 以外的依赖。

- 数据存在环境变量 TODO_FILE 指定的路径；没设时用当前目录的 todo.json。文件不存在时当作空列表。
- `node todo.mjs add <文本...>`：添加一条（多个参数用空格连起来），id 取现有最大 id + 1（从 1 开始），输出 `added <id>`。
- `node todo.mjs list`：每条一行，未完成 `<id>. [ ] <文本>`，已完成 `<id>. [x] <文本>`，按 id 升序；没有任务时输出 `no tasks`。
- `node todo.mjs done <id>`：标记完成，输出 `done <id>`。
- `node todo.mjs rm <id>`：删除，输出 `removed <id>`。
- done/rm 的 id 不存在时，往 stderr 输出 `not found: <id>`，退出码 1。
- 没有命令或命令未知时，往 stderr 输出用法说明，退出码 2。

写完自己跑一遍确认能用。

交给 DeepSeek Harness。
