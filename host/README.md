<p align="center">
  <img src="https://raw.githubusercontent.com/JialaoLiu/dsh-baton/main/assets/readme/en/hero.gif" width="100%" alt="dsh-baton: pass the baton from Claude Code or Codex to DeepSeek Harness, watch it run live, and get it handed back when it's done">
</p>

<p align="center">
  <a href="https://github.com/JialaoLiu/dsh-baton#readme">dsh-baton</a> · <a href="https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md">中文说明</a>
</p>

<p align="center">
  macOS · Windows (<a href="https://github.com/JialaoLiu/dsh-baton/blob/main/WINDOWS.md">guide</a>) · no Node.js needed · zero dependencies · MIT
</p>

# dsh-baton-host

The DeepSeek Harness plugin for [dsh-baton](https://github.com/JialaoLiu/dsh-baton#readme). It runs inside the Harness host (desktop app or `dsh web`) and serves a local, owner-only Unix socket (`~/.dsh-baton/host.sock`; a per-user named pipe on Windows). Through it, an MCP client can list and create workspaces, create sessions, continue a specific session, and wait for its turn to finish. All of this goes through Harness's own session controller, so the messages show up live in the Harness UI.

DeepSeek Harness 插件，配合 [dsh-baton](https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md) 使用。它运行在 Harness 内部，只开一个当前用户才能访问的本地套接字，让 MCP 客户端能新建工作区和对话、续接指定对话、等待任务完成。所有操作都走 Harness 官方会话服务，界面实时可见。

<p align="center">
  <img src="https://raw.githubusercontent.com/JialaoLiu/dsh-baton/main/assets/readme/en/features.svg" width="100%" alt="Create workspaces and sessions, continue a session, run live in the Harness UI labelled with the sender, get woken when it is done, no extra API key, macOS and Windows with zero dependencies">
</p>

## Install / 安装

<p align="center">
  <img src="https://raw.githubusercontent.com/JialaoLiu/dsh-baton/main/assets/readme/en/install.svg" width="100%" alt="Step 1: in Harness open Plugins, Add plugin, enter dsh-baton-host, Install, Enable now; it registers dsh-baton for Claude Code and Codex. Step 2: in a new chat, ask for dsh_list_workspaces">
</p>

Harness → Plugins / 插件 → Add plugin / 添加插件 → `dsh-baton-host` → Install / 安装 → Enable now / 立即启用

That is the whole install: switched on, the plugin registers the dsh-baton MCP server (the `dsh-baton-mcp` package, installed with it) for Claude Code and Codex, user-wide, and Harness says so. New conversations then have the `dsh_*` tools. If it could not register, run `npx -y dsh-baton-mcp setup`. Details: [dsh-baton](https://github.com/JialaoLiu/dsh-baton#install-details).

装好就完成了：插件启用时会为 Claude Code 和 Codex 注册 dsh-baton MCP 服务器（`dsh-baton-mcp` 包，随插件一起安装），Harness 里会提示。新开的对话就有 `dsh_*` 工具。没能注册的话，运行 `npx -y dsh-baton-mcp setup`。详见 [dsh-baton](https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md#安装细节)。

Codex needs nothing extra: from 0.6.4 it waits for a run in one `dsh_wait` call of up to 59 minutes, with no hook to trust. / Codex 不用额外设置：从 0.6.4 起一次 `dsh_wait` 最长等 59 分钟，不需要信任钩子。

Update / 更新: uninstall, then add it again; the MCP server is updated with it. Right after a release, type the exact version, such as `dsh-baton-host@0.6.4`. / 先卸载再重新添加，MCP 服务器会一起更新；刚发版时请输入完整版本号，例如 `dsh-baton-host@0.6.4`。

Remove / 卸载: uninstall, then `npx -y dsh-baton-mcp setup --remove` / 卸载插件后运行 `npx -y dsh-baton-mcp setup --remove`.

## How it works / 工作原理

<p align="center">
  <img src="https://raw.githubusercontent.com/JialaoLiu/dsh-baton/main/assets/readme/en/architecture.gif" width="100%" alt="MCP clients call dsh-baton-mcp over stdio; it reaches the dsh-baton-host plugin inside Harness through an owner-only local socket; the plugin drives Harness sessions live, with dsh headless as fallback">
</p>

## Socket protocol / 套接字协议

Newline-delimited JSON: request `{"id", "method", "params"}`, reply `{"id", "result"}` or `{"id", "error"}`.

| Method | Params |
|---|---|
| `ping` | — |
| `workspaces` | — |
| `create_workspace` | `path`, `title?`, `create_dir?` (default `true`) |
| `list_sessions` | `cwd?`, `query?`, `limit?` |
| `read_session` | `session_id`, `last?` |
| `models` | — |
| `send` | `message`, and `session_id` or `cwd` or `workspace_id`; `mode?` (`followup` \| `steer`; left out, Harness's busy-send setting, else `followup`) |
| `status` | `run_id`, `tail?` |
| `wait` | `run_id`, `timeout_s?` |
| `activity` | `session_id` |
| `cancel` | `run_id` or `session_id` |
| `rename_session` | `session_id`, `title` |
| `rename_workspace` | `workspace_id` or `path`, `title` |
| `list_runs` | `session_id?`, `limit?` |
| `answer` | `run_id`, `answers` (`[{ id?, choose?, text?, skip? }]`) |
| `update_queued` | `run_id`, `action` (`edit` \| `remove` \| `steer`), `message?` (for `edit`) |

`DSH_BATON_SOCKET` / `DSH_BATON_HOME` in the Harness process environment move the socket. `DSH_BATON_AUTO_REGISTER=0` turns off the MCP registration.

The Plugins page reads the registration outcome from `GET /dsh-baton/status` on the Harness web server.

## License

MIT
