# dsh-baton-host

DeepSeek Harness plugin for [dsh-baton](https://github.com/JialaoLiu/dsh-baton#readme). It runs inside the Harness host (desktop app or `dsh web`) and serves a local, owner-only Unix socket (`~/.dsh-baton/host.sock`; a per-user named pipe on Windows, see [WINDOWS.md](https://github.com/JialaoLiu/dsh-baton/blob/main/WINDOWS.md)). Through it, an MCP client can list and create workspaces, create sessions, continue a specific session, and wait for its turn to finish. All of this goes through Harness's own session controller, so the messages show up live in the Harness UI.

DeepSeek Harness 插件，配合 [dsh-baton](https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md) 使用。它运行在 Harness 内部，只开一个当前用户才能访问的本地套接字，让 MCP 客户端能新建工作区和对话、续接指定对话、等待任务完成。所有操作都走 Harness 官方会话服务，界面实时可见。

## Install / 安装

Harness → Plugins / 插件 → Add plugin / 添加插件 → `dsh-baton-host` → Install / 安装 → Enable now / 立即启用

That is the whole install: switched on, the plugin registers the dsh-baton MCP server (the `dsh-baton-mcp` package, installed with it) for Claude Code and Codex, user-wide, and Harness says so. New conversations then have the `dsh_*` tools. If it could not register, run `npx -y dsh-baton-mcp setup`. Details: [dsh-baton](https://github.com/JialaoLiu/dsh-baton#install-details).

装好就完成了：插件启用时会为 Claude Code 和 Codex 注册 dsh-baton MCP 服务器（`dsh-baton-mcp` 包，随插件一起安装），Harness 里会提示。新开的对话就有 `dsh_*` 工具。没能注册的话，运行 `npx -y dsh-baton-mcp setup`。详见 [dsh-baton](https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md#安装细节)。

Update / 更新: uninstall, then add it again; the MCP server is updated with it / 先卸载再重新添加，MCP 服务器会一起更新.

Remove / 卸载: uninstall, then `npx -y dsh-baton-mcp setup --remove` / 卸载插件后运行 `npx -y dsh-baton-mcp setup --remove`.

## Socket protocol / 套接字协议

Newline-delimited JSON: request `{"id", "method", "params"}`, reply `{"id", "result"}` or `{"id", "error"}`.

| Method | Params |
|---|---|
| `ping` | — |
| `workspaces` | — |
| `create_workspace` | `path`, `title?`, `create_dir?` (default `true`) |
| `list_sessions` | `cwd?`, `query?`, `limit?` |
| `read_session` | `session_id`, `last?` |
| `send` | `message`, and `session_id` or `cwd` or `workspace_id`; `mode?` (`followup` \| `steer`) |
| `status` | `run_id`, `tail?` |
| `wait` | `run_id`, `timeout_s?` |
| `activity` | `session_id` |
| `cancel` | `run_id` or `session_id` |
| `rename_session` | `session_id`, `title` |
| `rename_workspace` | `workspace_id` or `path`, `title` |
| `list_runs` | `limit?` |

`DSH_BATON_SOCKET` / `DSH_BATON_HOME` in the Harness process environment move the socket. `DSH_BATON_AUTO_REGISTER=0` turns off the MCP registration.

The Plugins page reads the registration outcome from `GET /dsh-baton/status` on the Harness web server.

## License

MIT
