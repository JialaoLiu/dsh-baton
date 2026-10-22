# dsh-baton-host

DeepSeek Harness plugin for [dsh-baton](../README.md). It runs inside the Harness host (desktop app or `dsh web`) and serves a local, owner-only Unix socket (`~/.dsh-baton/host.sock`; a per-user named pipe on Windows, see [WINDOWS.md](../WINDOWS.md)). Through it, an MCP client can list and create workspaces, create sessions, continue a specific session, and wait for its turn to finish. All of this goes through Harness's own session controller, so the messages show up live in the Harness UI.

DeepSeek Harness 插件，配合 [dsh-baton](../README.zh-CN.md) 使用。它运行在 Harness 内部，只开一个当前用户才能访问的本地套接字，让 MCP 客户端能新建工作区和对话、续接指定对话、等待任务完成。所有操作都走 Harness 官方会话服务，界面实时可见。

## Install / 安装

Harness → Plugins / 插件 → Add plugin / 添加插件 → `dsh-baton-host` → Install / 安装 → Enable now / 立即应用

Then connect the MCP server / 然后接入 MCP 服务器: see [dsh-baton](../README.md).

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

`DSH_BATON_SOCKET` / `DSH_BATON_HOME` in the Harness process environment move the socket.

## License

MIT
