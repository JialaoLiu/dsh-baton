# dsh-baton-host socket protocol

The plugin runs inside the Harness host (desktop app or `dsh web`) and serves a local, owner-only Unix socket (`~/.dsh-baton/host.sock`; a per-user named pipe on Windows). The dsh-baton MCP server talks to it; everything goes through Harness's own session controller, so the messages show up live in the Harness UI.

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
