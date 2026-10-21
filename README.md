<p align="center">
  <img src="./assets/readme/hero.gif" width="100%" alt="dsh-bridge: hand a task from Claude Code or Codex to DeepSeek Harness, watch it run live, and get woken when it is done">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">中文</a> · Unofficial; not affiliated with DeepSeek.
</p>

<p align="center">
  <img src="./assets/readme/features.svg" width="100%" alt="Create workspaces and sessions, continue a session, run live in the Harness UI, get woken when it is done, no extra API key, zero dependencies and local only">
</p>

<p align="center">
  <img src="./assets/readme/flow.gif" width="100%" alt="Typical flow: create a workspace, send the task, wait in the background, follow up in the same session">
</p>

## Quick start

<p align="center">
  <img src="./assets/readme/install.svg" width="100%" alt="Step 1: in Harness open Plugins, Add plugin, paste the path of the dsh-bridge/host folder, Install, Enable now. Step 2: register src/server.mjs once, user-wide, in Claude Code and Codex">
</p>

Requires DeepSeek Harness ≥ 0.2.1-rc.2 (signed in), Node.js ≥ 22.15 and git. On Windows, see [WINDOWS.md](WINDOWS.md).

> The npm packages `dsh-bridge-host` and `dsh-bridge-mcp` are not published yet, so install from a clone of this repo as below. There is nothing to `npm install`: dsh-bridge has no dependencies.

Two commands in a terminal, then one paste in Harness:

```bash
git clone https://github.com/JialaoLiu/dsh-bridge.git
node dsh-bridge/src/cli.mjs setup
```

`setup` registers the MCP server once, user-wide, for Claude Code and Codex: every new conversation, in any folder, has the `dsh_*` tools. It writes `~/.claude.json` and `~/.codex/config.toml` directly (a backup of each is kept as `*.bak-dsh-bridge`), so it also works when only the desktop apps are installed and `claude` / `codex` are not on your `PATH`. Running it again is safe.

Then finish in Harness. `setup` copies the plugin folder path to your clipboard:

**Plugins** (插件) → **Add plugin** (添加插件) → paste → **Install** (安装) → **Enable now** (立即启用)

Check: start a **new** conversation in Claude Code or Codex and ask it to call `dsh_list_workspaces`. It lists your Harness workspaces.

**Or let Claude Code or Codex do it:** paste *"Run `git clone https://github.com/JialaoLiu/dsh-bridge.git ~/dsh-bridge && node ~/dsh-bridge/src/cli.mjs setup`, then tell me the Harness step it prints."*

Nothing else to configure:
- **Claude Code** waits for a run in the background (the `wait_command` that `dsh_send` returns) and is woken once, when the run ends.
- **Codex** waits inside `dsh_wait`, up to 270 s per call, just under its 300 s tool timeout. An unfinished wait returns only the state, so Codex calls again without summarising.
- Codex asks you to approve MCP tool calls: approve the `dsh-bridge` tools. For unattended `codex exec` runs, add `--approve-for-me`.

**Updating:** `git pull` in the clone, then restart Harness to load plugin changes; new conversations pick up MCP server changes.

**Removing:** `node dsh-bridge/src/cli.mjs setup --remove`, then Harness → Plugins → dsh-bridge-host → Uninstall.

<details>
<summary>Manual registration and the Claude desktop app</summary>

`setup` writes the same entries these commands would (with the absolute path of `node`, since desktop apps start MCP servers without your shell's `PATH`):

```bash
claude mcp add dsh-bridge -s user -- "$(command -v node)" "$PWD/dsh-bridge/src/server.mjs"
codex mcp add dsh-bridge -- "$(command -v node)" "$PWD/dsh-bridge/src/server.mjs"
```

`-s user` matters: without it, Claude Code registers the server for the current project folder only.

**Claude desktop app (optional)**: for the chat app's connectors (separate from Claude Code), add this to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart the app. It shows as a "Local dev" connector.

```json
{ "mcpServers": { "dsh-bridge": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/dsh-bridge/src/server.mjs"] } } }
```

</details>

## How it works

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="MCP clients call dsh-bridge-mcp over stdio; it reaches the dsh-bridge-host plugin inside Harness through an owner-only local socket; the plugin drives Harness sessions live, with dsh headless as fallback">
</p>

<p align="center">
  <img src="./assets/readme/comparison.svg" width="100%" alt="Plugin vs headless: only the plugin shows runs live in the Harness UI, continues desktop sessions and uses desktop agent presets; both reuse the desktop sign-in">
</p>

## Tools

<p align="center">
  <img src="./assets/readme/tools.svg" width="100%" alt="Workspaces: list, create, rename. Sessions: list, read, activity, rename. Runs: send, status, wait, cancel, list runs">
</p>

<p align="center">
  <img src="./assets/readme/states.svg" width="100%" alt="Run states: queued, running, waiting, completed, failed, cancelled. A busy session takes followup (queued) or steer (interjects) messages">
</p>

<details>
<summary>Full tool reference</summary>

| Tool | What it does |
|---|---|
| `dsh_list_workspaces` | Workspaces in the Harness sidebar |
| `dsh_create_workspace` | Register a folder as a workspace (creates the folder if missing); returns the existing one if already registered |
| `dsh_list_sessions` | Sessions newest first, with title, folder and running state; filter by folder or text |
| `dsh_read_session` | Recent prompts and replies of one session (with tool names) |
| `dsh_send` | Send a message: `session_id` continues that session; `cwd` or `workspace_id` starts a new one (a `cwd` that is not a workspace yet is registered first). Returns a `run_id` at once. In Harness the message is marked "Sent by Claude / ChatGPT from another chat" |
| `dsh_status` | Run progress: state, recent text and tool calls, final reply; `waiting_on` when the turn is over but sub-agents or jobs still run; `human_interjections` when someone typed in the Harness UI mid-run; state `interrupted` for a run cut short by a Harness restart |
| `dsh_wait` | Wait for the run to end: up to 270 s per call for Codex, 50 s for other clients. Still going: returns `timed_out` with just the state; call it again. Clients that can wait in the background use `dsh_send`'s `wait_command` instead |
| `dsh_session_activity` | What a session is doing now: running turn, sub-agents (any depth), background jobs |
| `dsh_cancel` | Stop everything a session is doing, by `run_id` or `session_id`: turn, sub-agents, jobs (queued messages stay) |
| `dsh_rename_session` | Rename a session |
| `dsh_rename_workspace` | Rename a workspace (sidebar title only; the folder is not moved) |
| `dsh_list_runs` | Recent runs |

</details>

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

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BRIDGE_BACKEND` | `auto` | `auto`, `host` or `headless` |
| `DSH_BRIDGE_HOME` | `~/.dsh-bridge` | Socket and headless run records |
| `DSH_BRIDGE_SOCKET` | `$DSH_BRIDGE_HOME/host.sock` | Plugin socket path (must match on both sides); on Windows mapped to a per-user named pipe |
| `DSH_BRIDGE_WAIT_S` | `270` for Codex, else `50` | How long one `dsh_wait` call waits; set it only if you raised the client's tool timeout, and keep it below that |
| `DSH_BIN` | the `dsh` inside the macOS app, else `PATH` | Harness CLI for headless mode |
| `DSH_HOME` | `~/.dsh` | Harness data folder (headless session reads) |
| `DSH_BRIDGE_ACCOUNT` | `1` | `0` uses the API-key route in headless mode |
| `DSH_BRIDGE_PATCHES` | empty | Extra headless `--patch` overlays, `:`-separated |

<details>
<summary>Headless fallback details</summary>

When the plugin is unreachable, the MCP server falls back to Harness's `dsh headless` command. It can only continue sessions it created itself (headless does not load agent presets such as `standard`), and new sessions do not appear in the desktop sidebar. By default [`patches/account.patch.yml`](patches/account.patch.yml) reuses the desktop app's DeepSeek account sign-in, so no API key is needed.

</details>

## Security and limits

<p align="center">
  <img src="./assets/readme/security.svg" width="100%" alt="Owner-only socket (folder 0700, socket 0600), no network port, Harness sandbox and approvals apply">
</p>

<p align="center">
  <img src="./assets/readme/limits.svg" width="100%" alt="Good to know: a message typed in the UI mid-run is flagged on the run as a human interjection, run records survive a Harness restart (cut-short runs show interrupted), Claude Code is woken once when a run ends and Codex waits up to 270 s per call">
</p>

Any process running as your OS user can drive Harness through the socket, the same as running `dsh` directly. dsh-bridge relies on Harness 0.2.1-series internal service APIs, so a major Harness update may need a follow-up release.

## License

MIT
