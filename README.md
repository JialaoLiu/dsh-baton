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
  <img src="./assets/readme/install.svg" width="100%" alt="Step 1: Harness, Plugins, Add plugin, dsh-bridge-host, Install, Apply now. Step 2: connect Claude Code, Codex or any MCP client to dsh-bridge-mcp">
</p>

Requires DeepSeek Harness ≥ 0.2.1-rc.2 (signed in) and Node.js ≥ 22.15. On Windows, see [WINDOWS.md](WINDOWS.md).

**Fastest:** paste this into Claude Code or Codex and let it do the setup:

```text
Set up dsh-bridge for me.
1. Connect the MCP server. In Claude Code run: claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
   In Codex add this to ~/.codex/config.toml:
   [mcp_servers.dsh-bridge]
   command = "npx"
   args = ["-y", "dsh-bridge-mcp"]
2. Tell me to install the plugin in DeepSeek Harness myself: Plugins → Add plugin → dsh-bridge-host → Install → Apply now. Wait until I confirm.
3. After a restart if needed, call dsh_list_workspaces to check the connection and show me the result.
```

Or do it by hand:

### 1. Install the plugin in Harness

Harness → **Plugins** → **Add plugin** → paste the package name below → **Install** → **Apply now**.

```text
dsh-bridge-host
```

### 2. Connect your MCP client

**Claude Code**

```bash
claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dsh-bridge]
command = "npx"
args = ["-y", "dsh-bridge-mcp"]
```

From source: install the plugin from this repo's absolute `host` folder path, and run the MCP server with `node /absolute/path/dsh-bridge/src/server.mjs`.

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
| `dsh_send` | Send a message: `session_id` continues that session; `cwd` or `workspace_id` starts a new one (a `cwd` that is not a workspace yet is registered first). Returns a `run_id` at once |
| `dsh_status` | Run progress: state, recent text and tool calls, final reply; `waiting_on` when the turn is over but sub-agents or jobs still run |
| `dsh_wait` | Wait until the run ends (or times out) |
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
  <img src="./assets/readme/limits.svg" width="100%" alt="Known limitations: don't type into a session during a bridge run, run ids reset when Harness restarts, prefer the background wait command">
</p>

Any process running as your OS user can drive Harness through the socket, the same as running `dsh` directly. dsh-bridge relies on Harness 0.2.1-series internal service APIs, so a major Harness update may need a follow-up release.

## License

MIT
