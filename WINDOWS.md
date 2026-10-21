# dsh-bridge on Windows

dsh-bridge runs on Windows 10/11 with the same tools and behaviour as on macOS. This page covers what differs and how to check that everything is connected.

Verified on Windows 11 with DeepSeek Harness 0.2.1-rc.2 (desktop app), Node.js 22.23, Codex 0.163 and Claude Code 2.1.

## What is different on Windows

- **The control socket is a named pipe.** Node cannot listen on a Unix socket file on Windows. The plugin and the MCP server therefore map the socket path to a named pipe, `\\.\pipe\dsh-bridge-<hash>`. The hash is taken from the path, `%USERPROFILE%\.dsh-bridge\host.sock` by default, so every Windows user gets their own pipe.
  - `DSH_BRIDGE_HOME` / `DSH_BRIDGE_SOCKET` still move it. A path is mapped the same way on both sides, and a value that is already `\\.\pipe\…` is used as is.
  - There is no file to clean up: the pipe disappears when Harness exits.
  - Access: Windows' default pipe security lets other standard users only read it, so they cannot drive Harness through it. Administrators and SYSTEM can, as with any process you run.
- **The headless backend uses Harness's own CLI.** The desktop app ships no `dsh.exe`. Harness ≥ 0.2.1 has a launcher at `resources\runtime\cli\bin\dsh.cmd`; older builds only have the CLI packed in `resources\app.asar`, which runs on the app's own Electron binary. dsh-bridge finds it automatically, in this order:
  1. `DSH_BIN`, if set;
  2. `dsh` on `PATH`, preferring `.exe` / `.cmd` / `.bat` over extensionless shims (Harness's "add dsh to PATH" setting puts `dsh.cmd` there);
  3. the Harness install, either the default `%LOCALAPPDATA%\Programs\DeepSeek Harness` or any `InstallLocation` from the uninstall registry entries, so a custom folder such as `E:\Software\DeepSeek Harness` works. There its `dsh.cmd` launcher is used, or the packed CLI on older builds.

  A `.cmd` launcher is started through `cmd.exe`.
- **Cancelling stops the whole process tree** of that one run (`taskkill /PID <pid> /T /F`). It never kills by image name.

## Install

Requires DeepSeek Harness ≥ 0.2.1-rc.2, Node.js ≥ 22.15 and git. The npm packages are not published yet, so install from a clone, for example:

```powershell
git clone https://github.com/JialaoLiu/dsh-bridge.git C:\dev\dsh-bridge
```

### 1. The plugin in Harness

Harness → **Plugins / 插件** → **Add plugin / 添加插件** → paste `C:\dev\dsh-bridge\host` → **Install** → **Enable now / 立即应用**. The pipe appears right away (see [Verify](#verify)); if it does not, restart Harness.

**If the Add plugin dialog refuses the folder**, link it by hand. `dsh plugin --profile desktop` refuses with "profile "desktop" is managed exclusively by the Electron application", so do this instead:

1. Quit Harness, including its tray icon.
2. In `%USERPROFILE%\.dsh\profiles\desktop\package.json`, add the link to `dependencies` and the bundle to `dsh.profile.bundles`:

   ```json
   "dependencies": { "dsh-bridge-host": "link:C:/dev/dsh-bridge/host" },
   "dsh": { "profile": { "bundles": [ "...existing bundles...", "dsh-bridge-host" ] } }
   ```

3. Install with Harness's bundled pnpm and its own store. Adjust `$app` to your install folder. Without `--store-dir`, pnpm wants to delete and rebuild `node_modules`.

   ```powershell
   $app = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
   $env:ELECTRON_RUN_AS_NODE = '1'
   $env:DSH_DESKTOP_NODE_EXECUTABLE = "$app\DeepSeek Harness.exe"
   $env:Path = "$app\resources\runtime\bin;$env:Path"
   cd "$env:USERPROFILE\.dsh\profiles\desktop"
   # Harness ≥ 0.2.1; older builds have it at resources\runtime\pnpm\bin\pnpm.mjs
   $pnpm = "$app\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
   & "$app\DeepSeek Harness.exe" $pnpm install --store-dir "$env:USERPROFILE\.dsh\desktop\pnpm\store\v11"
   ```

   `node_modules\dsh-bridge-host` becomes a junction to your `host` folder.
4. Start Harness. Restart it after changing plugin code.

### 2. The MCP server, registered once for every conversation

Register it at user scope, not per conversation or per project, so every new conversation already has the `dsh_*` tools. Use the absolute path of `node`: desktop apps start MCP servers without your shell's `PATH`, and they cannot start `npx.cmd` directly.

**Claude Code**: `-s user` is the important part. Without it, Claude Code registers the server for the current project folder only.

```powershell
claude mcp add dsh-bridge -s user -- (Get-Command node).Source C:\dev\dsh-bridge\src\server.mjs
```

Check: `claude mcp get dsh-bridge` shows `Scope: User config (available in all your projects)` and `Status: ✓ Connected`.

**Codex**: `codex mcp add` is already user-wide. It writes to `%USERPROFILE%\.codex\config.toml`, which the Codex CLI and app share.

```powershell
codex mcp add dsh-bridge --env DSH_BRIDGE_WAIT_S=1740 -- (Get-Command node).Source C:\dev\dsh-bridge\src\server.mjs
```

Then add `tool_timeout_sec = 1800` to the `[mcp_servers.dsh-bridge]` entry in `%USERPROFILE%\.codex\config.toml`, so one `dsh_wait` can cover a whole run instead of returning every 50 s (Codex stops a tool call after 60 s by default).

Claude Code needs nothing more: it runs the `wait_command` that `dsh_send` returns as a background command and is woken when the run ends.

Check: `codex mcp list` lists `dsh-bridge`. Approve the `dsh-bridge` tools when Codex asks; for unattended `codex exec`, add `--approve-for-me`.

**If `claude` or `codex` is not on `PATH`** (desktop apps only), write the same user-wide entry by hand:

- Claude Code: under the top-level `"mcpServers"` key of `%USERPROFILE%\.claude.json`: `"dsh-bridge": { "type": "stdio", "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["C:\\dev\\dsh-bridge\\src\\server.mjs"] }`.
- Codex: in `%USERPROFILE%\.codex\config.toml`:

  ```toml
  [mcp_servers.dsh-bridge]
  command = 'C:\Program Files\nodejs\node.exe'
  args = ['C:\dev\dsh-bridge\src\server.mjs']
  tool_timeout_sec = 1800

  [mcp_servers.dsh-bridge.env]
  DSH_BRIDGE_WAIT_S = '1740'
  ```

**Claude desktop app (optional)**: the same `"mcpServers"` entry in `%APPDATA%\Claude\claude_desktop_config.json`, then restart the app.

## Verify

1. **The plugin is up.** Harness is running, and the pipe exists:

   ```powershell
   [IO.Directory]::GetFiles('\\.\pipe\') | Select-String dsh-bridge
   ```

2. **The MCP server reaches it.** Run this from the repo:

   ```powershell
   node -e "import('./src/core.mjs').then(async c => { console.log(c.hostSocket()); console.log(await c.hostCall('ping')) })"
   ```

   It prints the same pipe and `{ name: 'dsh-bridge-host', version: …, pid: … }`.
3. **The clients see it, user-wide.** `claude mcp get dsh-bridge` shows `Scope: User config` and `✓ Connected`, and `codex mcp list` shows `dsh-bridge … enabled`. Start a new conversation: the `dsh_*` tools are there without reconnecting.
4. **A real round trip.** Ask the client: *"Use dsh-bridge: dsh_send with cwd C:\temp\dsh-test and message 'Reply with exactly one word: pong', then dsh_wait on the run_id."*
   - It should come back `completed` with `pong`.
   - The new session shows up under the `dsh-test` workspace in the Harness sidebar.

## Headless backend (no plugin)

`DSH_BRIDGE_BACKEND=headless`, or `auto` when the plugin is not running, runs one-shot turns through the CLI described above.

It needs credentials that the standalone CLI can read:
- **Desktop account sign-in** (the default): the account must be signed in.
- **API-key route** (`DSH_BRIDGE_ACCOUNT=0`): needs `DEEPSEEK_API_KEY` in the environment, or stored through the web Models page.

A key stored only in the desktop app's settings is not visible to the headless CLI. Without one, the run fails with `ACCOUNT_SIGN_IN_REQUIRED` or `MISSING_CREDENTIAL`. The host plugin route has no such requirement.

## Tests

```powershell
npm test
```

The suite runs on Windows with named pipes. Two POSIX-only checks are skipped: file modes, and refusing a regular file at the socket path.

---

## 中文要点

- **套接字改为命名管道。** Windows 上 Node 不能监听 Unix 套接字文件，所以同一路径被映射成按用户区分的命名管道 `\\.\pipe\dsh-bridge-<哈希>`。插件和 MCP 两边算法一致，`DSH_BRIDGE_SOCKET` 仍然可用，Harness 退出后管道自动消失。
- **headless 用 Harness 自带的 CLI。** Harness ≥ 0.2.1 自带 `resources\runtime\cli\bin\dsh.cmd`；更早的版本只有打包在 `app.asar` 里的 CLI，由 Harness 自己的 exe 以 Node 模式运行。会按顺序自动查找：`DSH_BIN`、`PATH` 里的 `dsh`、默认安装位置，以及注册表里的自定义安装目录。
- **从源码安装插件要手动来。** `dsh plugin --profile desktop` 会拒绝桌面版托管的 profile，所以：
  1. 退出 Harness；
  2. 在 profile 的 `package.json` 里加 `link:` 依赖，并在 `dsh.profile.bundles` 里加上 `dsh-bridge-host`；
  3. 用 Harness 自带的 pnpm 安装，记得加 `--store-dir`；
  4. 启动 Harness。
- **MCP 服务器要全局注册。** npm 包还没发布，所以用 `node` 的绝对路径加克隆下来的 `src\server.mjs`。Claude Code 用 `claude mcp add … -s user`（用户级，所有项目都能用）；Codex 用 `codex mcp add --env DSH_BRIDGE_WAIT_S=1740`，本来就写在用户级的 `config.toml` 里，再在那一项里加 `tool_timeout_sec = 1800`，一次 `dsh_wait` 就能等完整个任务。注册一次后，新开对话不用再连。
- **headless 需要独立凭据。** 要么登录账户，要么设置 `DEEPSEEK_API_KEY`。桌面版里保存的 Key，headless CLI 读不到。
