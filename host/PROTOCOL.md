# dsh-baton-host socket protocol

The plugin runs inside the Harness host (desktop app or `dsh web`) and serves a local, owner-only Unix socket (`~/.dsh-baton/host.sock`; a per-user named pipe on Windows). The dsh-baton MCP server talks to it; everything goes through Harness's own session controller, so the messages show up live in the Harness UI.

Newline-delimited JSON: request `{"id", "method", "params"}`, reply `{"id", "result"}` or `{"id", "error"}`.

| Method | Params |
|---|---|
| `ping` | — (returns `name`, `version`, `pid`, `features`; `features` has `team` when `send` takes `team`) |
| `workspaces` | — |
| `create_workspace` | `path`, `title?`, `create_dir?` (default `true`) |
| `list_sessions` | `cwd?`, `query?`, `limit?` |
| `read_session` | `session_id`, `last?` |
| `models` | — |
| `send` | `message`, and `session_id` or `cwd` or `workspace_id`; `mode?` (`followup` \| `steer`; left out, Harness's busy-send setting, else `followup`); `sender?`, `model?`, `reasoning_effort?`, `team?` (`true` \| `false`), `conversation_folder?` (the client conversation's folder: a `cwd` inside it joins its workspace; the reply then has `work_folder`) |
| `status` | `run_id` and `tail?`, or `session_id` |
| `wait` | `run_id`, `timeout_s?` |
| `follow` | `session_id`, `until?` (`goal` \| `turn`), `cursor?`, `since_ms?`, `every_s?`, `timeout_s?` |
| `activity` | `session_id` |
| `cancel` | `run_id` or `session_id` |
| `rename_session` | `session_id`, `title` |
| `rename_workspace` | `workspace_id` or `path`, `title` |
| `list_runs` | `session_id?`, `limit?` |
| `answer` | `run_id`, `answers` (`[{ id?, choose?, text?, skip? }]`) |
| `update_queued` | `run_id`, `action` (`edit` \| `remove` \| `steer`), `message?` (for `edit`) |

`DSH_BATON_SOCKET` / `DSH_BATON_HOME` in the Harness process environment move the socket. `DSH_BATON_AUTO_REGISTER=0` turns off the MCP registration.

The Plugins page reads the registration outcome from `GET /dsh-baton/status` on the Harness web server.

The hand-over defaults (the model and reasoning effort a new session starts on when `send` names none) are read with `GET /dsh-baton/handover` (`model`, `reasoning_effort`, `approvals`, `supported`, `default`, `models` with `reasoning_efforts` as `{ id, name }`, `missing?`, `unreadable?`) and saved with `POST /dsh-baton/handover` and a JSON body `{ model?, reasoning_effort?, approvals? }`: `provider/model` exactly as listed (model ids may contain `/`), or `null` to follow Harness's default; a field left out keeps its saved value. A save must come from the plugin page, over a connection from this computer (a loopback peer): header `x-dsh-baton: handover`, `content-type: application/json`, a `Host` that is an IP address or a localhost name, and no `Origin` (the desktop window's proxy drops it) or one that is `dsh-app:` or matches the `Host`. They are kept in `$DSH_BATON_HOME/settings.json`. A default never fails a send: one that cannot be used is skipped. `send` replies with `model_source` `requested`, `handover_default`, `default` or `session`; `handover_default` lists which of `model` and `reasoning_effort` came from the defaults; `model_note` says when a default was skipped, or when Harness's default model changed since the last new session that followed it. A name several providers share (`DeepSeek-V4.1-Flash` from two providers) runs on the hand-over default when that is one of them, with a `model_note`. `approvals` is `allow` (the default, unless `settings.json` cannot be read or holds another value, which counts as `ask`: an approval Harness asks for in a session with a run of this plugin in progress is answered `allowed-once` and listed on the run as `approvals_allowed: [{ time, tool, reason? }]`; one Harness's Auto review turned down is left to Harness) or `ask` (left to the Harness UI; the run shows `waiting`, also for an approval asked inside a running tool call, seen from the session log's `approval/asked` and `approval/decided`).
