# dsh-bridge

English | [中文](README.zh-CN.md)

Let Claude Code, Codex, or any MCP client hand work to a local **DeepSeek Harness** and collaborate with it:

- **Create workspaces and sessions**: start Harness in a given folder; the workspace and session appear in the Harness sidebar.
- **Continue a specific session**: send to an existing session by `session_id`, keeping its context, instead of spawning a sub-conversation.
- **Visible live in the UI**: Harness handles the message itself, exactly as if you typed it, so it shows up live.
- **Know the moment it finishes**: `dsh_wait` blocks until the run ends, or run `dsh-bridge wait <run_id>` as a background command and the orchestrator is woken when it exits.
- **No extra API key**: uses the desktop app's existing sign-in, presets and settings.
- **Zero dependencies, local only**: Node.js standard library; the plugin opens one owner-only local socket, no ports, no third parties.

> Unofficial; not affiliated with DeepSeek.

## Parts

```
Claude Code / Codex ──MCP──▶ dsh-bridge-mcp (src/)
                                  │ local socket ~/.dsh-bridge/host.sock (owner only)
                                  ▼
             dsh-bridge-host (host/, a plugin installed in Harness)
                                  │ Harness's own session controller
                                  ▼
                 Harness workspaces, sessions and UI
```

| Package | Installed in | Role |
|---|---|---|
| [`dsh-bridge-host`](host/) | DeepSeek Harness desktop (or `dsh web`) | Exposes Harness's session service on a local socket |
| `dsh-bridge-mcp` | Claude Code, Codex, other MCP clients | Provides the `dsh_*` tools |

## Install

Requires DeepSeek Harness ≥ 0.2.1-rc.2 (signed in) and Node.js ≥ 22.15.

### 1. Install the plugin in Harness

Harness → **Plugins** → **Add plugin** → enter `dsh-bridge-host` → **Install** → **Apply now**.

(From source: enter the absolute path of this repo's `host` folder instead. Restart Harness after changing plugin code.)

### 2. Connect the MCP server

**Claude Code**:

```bash
claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.dsh-bridge]
command = "npx"
args = ["-y", "dsh-bridge-mcp"]
```

From source, use `node /absolute/path/dsh-bridge/src/server.mjs`.

## Tools

| Tool | What it does |
|---|---|
| `dsh_list_workspaces` | Workspaces in the Harness sidebar |
| `dsh_create_workspace` | Register a folder as a workspace (creates the folder if missing); returns the existing one if already registered |
| `dsh_list_sessions` | Sessions newest first, with title, folder and running state; filter by folder or text |
| `dsh_read_session` | Recent prompts and replies of one session (with tool names) |
| `dsh_send` | Send a message: `session_id` continues that session; `cwd` or `workspace_id` starts a new one (a `cwd` that is not a workspace yet is registered first). Returns a `run_id` at once |
| `dsh_status` | Run progress: state, recent text and tool calls, final reply; `waiting_on` when the turn is over but sub-agents or jobs still run |
| `dsh_wait` | Wait until the run ends (or times out) |
| `dsh_session_activity` | What a session is doing now: running turn, sub-agents (any depth), background jobs |
| `dsh_cancel` | Stop everything a session is doing, by `run_id` or `session_id`: turn, sub-agents, jobs (queued messages stay) |
| `dsh_rename_session` | Rename a session |
| `dsh_rename_workspace` | Rename a workspace (sidebar title only; the folder is not moved) |
| `dsh_list_runs` | Recent runs |

Run states: `queued` / `running` / `waiting` / `completed` / `failed` / `cancelled`. `waiting` means Harness needs a person (an approval or a question) in its UI.

**Sending to a busy session works**: `mode: "followup"` (default) goes into Harness's queue and runs after the current task; `mode: "steer"` interjects at the agent's next step. Each message gets its own `run_id`. A run is `completed` only when its turn has ended and its sub-agents and background jobs have finished.

### Typical flow

1. `dsh_create_workspace {"path": "~/code/new-app"}`
2. `dsh_send {"cwd": "~/code/new-app", "message": "Scaffold a Vite + React app and get the dev server running"}` → `run_id`, `session_id`
3. Run `dsh-bridge wait <run_id>` in the background; get woken when it ends
4. Review, then `dsh_send {"session_id": "...", "message": "Tests fail, please fix …"}` in the same session

## CLI

```bash
dsh-bridge workspaces
dsh-bridge new-workspace ~/code/new-app --title "New App"
dsh-bridge sessions --cwd ~/code/new-app
dsh-bridge send --cwd ~/code/new-app "Scaffold the project"
dsh-bridge send --session session-xxxx "Next: add tests"
dsh-bridge send --session session-xxxx --mode steer "Interjection: don't change the API"
dsh-bridge wait hrun-xxxx              # blocks, prints the final reply; exit 0 on success
dsh-bridge status hrun-xxxx
dsh-bridge activity session-xxxx       # running turn, sub-agents, background jobs
dsh-bridge cancel --session session-xxxx
dsh-bridge rename session-xxxx "New title"
dsh-bridge rename-workspace ~/code/new-app "New name"
```

## Without Harness running: headless fallback

When the plugin is unreachable, the MCP server falls back to Harness's `dsh headless` command, with real limits:

- it can only continue sessions it created itself, **not sessions created in the desktop app** (headless does not load agent presets such as `standard`);
- new sessions **do not appear in the desktop sidebar**;
- by default [`patches/account.patch.yml`](patches/account.patch.yml) reuses the desktop app's DeepSeek account sign-in, so no API key is needed.

Force a backend with `DSH_BRIDGE_BACKEND`: `auto` (default), `host`, `headless`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BRIDGE_BACKEND` | `auto` | Backend choice |
| `DSH_BRIDGE_HOME` | `~/.dsh-bridge` | Socket and headless run records |
| `DSH_BRIDGE_SOCKET` | `$DSH_BRIDGE_HOME/host.sock` | Plugin socket path (must match on both sides) |
| `DSH_BIN` | the `dsh` inside the macOS app, else `PATH` | Harness CLI for headless mode |
| `DSH_HOME` | `~/.dsh` | Harness data folder (headless session reads) |
| `DSH_BRIDGE_ACCOUNT` | `1` | `0` uses the API-key route in headless mode |
| `DSH_BRIDGE_PATCHES` | empty | Extra headless `--patch` overlays, `:`-separated |

## Security

- Socket directory `0700`, socket `0600`: only your OS user can connect. Any process running as you can drive Harness through it, the same as running `dsh` directly.
- The plugin opens no network port and contacts no external service.
- Tasks run under Harness's own permission settings (sandbox, approvals).

## Known limitations

- If you type into a session in the Harness UI while a bridge run on that session is still active, your turn's output is attributed to that run (or ends it with `superseded_by: "user"`). Let bridge runs finish, or use another session, when working by hand.
- Run records (`run_id`) live in the Harness process; after a Harness restart old run ids are gone (sessions are unaffected).
- MCP clients may time out long tool calls; prefer the background `wait` command over a long `dsh_wait`.
- Relies on Harness 0.2.1-series internal service APIs; a major Harness update may need follow-up.

## License

MIT
