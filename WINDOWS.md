# dsh-baton on Windows

dsh-baton runs on Windows 10/11 with the same tools and behaviour as on macOS. This page covers what differs and how to check that everything is connected.

Verified on Windows 11 with DeepSeek Harness 0.2.1-rc.2 (desktop app), Node.js 22.23, Codex 0.163 and Claude Code 2.1.

## What is different on Windows

- **The control socket is a named pipe.** Node cannot listen on a Unix socket file on Windows. The plugin and the MCP server therefore map the socket path to a named pipe, `\\.\pipe\dsh-baton-<hash>`. The hash is taken from the path, `%USERPROFILE%\.dsh-baton\host.sock` by default, so every Windows user gets their own pipe.
  - `DSH_BATON_HOME` / `DSH_BATON_SOCKET` still move it. A path is mapped the same way on both sides, and a value that is already `\\.\pipe\…` is used as is.
  - There is no file to clean up: the pipe disappears when Harness exits.
  - Access: Windows' default pipe security lets other standard users only read it, so they cannot drive Harness through it. Administrators and SYSTEM can, as with any process you run.
- **The headless backend uses Harness's own CLI.** The desktop app ships no `dsh.exe`. Harness ≥ 0.2.1 has a launcher at `resources\runtime\cli\bin\dsh.cmd`; older builds only have the CLI packed in `resources\app.asar`, which runs on the app's own Electron binary. dsh-baton finds it automatically, in this order:
  1. `DSH_BIN`, if set;
  2. `dsh` on `PATH`, preferring `.exe` / `.cmd` / `.bat` over extensionless shims (Harness's "add dsh to PATH" setting puts `dsh.cmd` there);
  3. the Harness install, either the default `%LOCALAPPDATA%\Programs\DeepSeek Harness` or any `InstallLocation` from the uninstall registry entries, so a custom folder such as `E:\Software\DeepSeek Harness` works. There its `dsh.cmd` launcher is used, or the packed CLI on older builds.

  A `.cmd` launcher is started through `cmd.exe`.
- **Cancelling stops the whole process tree** of that one run (`taskkill /PID <pid> /T /F`). It never kills by image name.

## Install

Requires DeepSeek Harness ≥ 0.2.1-rc.2 and Node.js ≥ 22.15. In PowerShell:

```powershell
npx -y dsh-baton-mcp setup
```

`setup` copies itself to `%USERPROFILE%\.dsh-baton\app` (npx's cache is not a stable place) and registers the MCP server once, user-wide, for Claude Code (`%USERPROFILE%\.claude.json`) and Codex (`%USERPROFILE%\.codex\config.toml`), with the absolute path of `node`. It edits the files directly, so it works with the desktop apps alone: their `claude.exe` / `codex.exe` are usually not on `PATH`. It also copies the plugin path to the clipboard.

Then, in Harness: **Plugins / 插件** → **Add plugin / 添加插件** → paste the path it copied (`%USERPROFILE%\.dsh-baton\app\host`) → **Install / 安装** → **Enable now / 立即启用**. The pipe appears right away (see [Verify](#verify)); if it does not, restart Harness.

Nothing else to configure: Claude Code waits for a run in the background (Git Bash runs the `wait_command` that `dsh_send` returns), and Codex waits up to 270 s per `dsh_wait` call, under its 300 s tool timeout. Approve the `dsh-baton` tools when Codex asks; for unattended `codex exec`, add `--approve-for-me`.

Remove: `npx -y dsh-baton-mcp setup --remove`, then Harness → Plugins → dsh-baton-host → Uninstall, then `setup --remove` once more to delete the app folder.

From source instead: `git clone https://github.com/JialaoLiu/dsh-baton.git C:\dev\dsh-baton` and `node C:\dev\dsh-baton\src\cli.mjs setup`; the plugin path is then `C:\dev\dsh-baton\host`.

### If the Plugins page cannot uninstall or install it

**Uninstall fails with `ERR_PNPM_UNEXPECTED_STORE`** ("Unexpected store location"), or Add plugin says the plugin is already installed (该插件已安装) while Uninstall fails. This happens when the profile was installed by an older Harness build that used another pnpm store. Move the profile onto the current store once, and the Plugins page works again:

1. Quit Harness from its menu (应用 → 退出), including its tray icon.
2. Rename `%USERPROFILE%\.dsh\profiles\desktop\node_modules` to keep it as a backup, for example `node_modules.old-store`.
3. Reinstall the profile with Harness's bundled pnpm, without `--store-dir`. Set `$app` to your Harness folder, for example `E:\Software\DeepSeek Harness` for a custom install.

   ```powershell
   $app = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
   $env:ELECTRON_RUN_AS_NODE = '1'
   $env:DSH_DESKTOP_NODE_EXECUTABLE = "$app\DeepSeek Harness.exe"
   $env:Path = "$app\resources\runtime\bin;$env:Path"
   cd "$env:USERPROFILE\.dsh\profiles\desktop"
   # Harness ≥ 0.2.1; older builds have it at resources\runtime\pnpm\bin\pnpm.mjs
   $pnpm = "$app\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
   & "$app\DeepSeek Harness.exe" $pnpm install --frozen-lockfile
   ```

4. Start Harness. Plugins → dsh-baton-host → Uninstall now works; then Add plugin as above. A failed uninstall earlier may have left the plugin switched off: switch it on if so.

`dsh plugin --profile desktop` cannot do this: it refuses with "profile "desktop" is managed exclusively by the Electron application".

## Verify

1. **The plugin is up.** Harness is running, and the pipe exists:

   ```powershell
   [IO.Directory]::GetFiles('\\.\pipe\') | Select-String dsh-baton
   ```

2. **The MCP server reaches it.** Run this from the repo:

   ```powershell
   node -e "import('./src/core.mjs').then(async c => { console.log(c.hostSocket()); console.log(await c.hostCall('ping')) })"
   ```

   It prints the same pipe and `{ name: 'dsh-baton-host', version: …, pid: … }`.
3. **The clients see it, user-wide.** `claude mcp get dsh-baton` shows `Scope: User config` and `✓ Connected`, and `codex mcp list` shows `dsh-baton … enabled`. Start a new conversation: the `dsh_*` tools are there without reconnecting.
4. **A real round trip.** Ask the client: *"Use dsh-baton: dsh_send with cwd C:\temp\dsh-test and message 'Reply with exactly one word: pong', then dsh_wait on the run_id."*
   - It should come back `completed` with `pong`.
   - The new session shows up under the `dsh-test` workspace in the Harness sidebar.

## Headless backend (no plugin)

`DSH_BATON_BACKEND=headless`, or `auto` when the plugin is not running, runs one-shot turns through the CLI described above.

It needs credentials that the standalone CLI can read:
- **Desktop account sign-in** (the default): the account must be signed in.
- **API-key route** (`DSH_BATON_ACCOUNT=0`): needs `DEEPSEEK_API_KEY` in the environment, or stored through the web Models page.

A key stored only in the desktop app's settings is not visible to the headless CLI. Without one, the run fails with `ACCOUNT_SIGN_IN_REQUIRED` or `MISSING_CREDENTIAL`. The host plugin route has no such requirement.

## Tests

```powershell
npm test
```

The suite runs on Windows with named pipes. Two POSIX-only checks are skipped: file modes, and refusing a regular file at the socket path.

---

## 中文要点

- **套接字改为命名管道。** Windows 上 Node 不能监听 Unix 套接字文件，所以同一路径被映射成按用户区分的命名管道 `\\.\pipe\dsh-baton-<哈希>`。插件和 MCP 两边算法一致，`DSH_BATON_SOCKET` 仍然可用，Harness 退出后管道自动消失。
- **headless 用 Harness 自带的 CLI。** Harness ≥ 0.2.1 自带 `resources\runtime\cli\bin\dsh.cmd`；更早的版本只有打包在 `app.asar` 里的 CLI，由 Harness 自己的 exe 以 Node 模式运行。会按顺序自动查找：`DSH_BIN`、`PATH` 里的 `dsh`、默认安装位置，以及注册表里的自定义安装目录。
- **插件用 Harness 插件页安装。** 插件 → 添加插件 → 粘贴 `%USERPROFILE%\.dsh-baton\app\host` → 安装 → 立即启用（`setup` 已把路径复制到剪贴板）。
- **一条命令注册 MCP。** `npx -y dsh-baton-mcp setup` 把自己复制到 `%USERPROFILE%\.dsh-baton\app`，再直接写 Claude Code 和 Codex 的用户级配置（用 `node` 的绝对路径），桌面版的 `claude` / `codex` 不在 `PATH` 里也没关系。之后新开对话就有 `dsh_*` 工具；Codex 每次最多等 270 秒，不用再配超时。
- **插件页卸不掉或装不上时**（`ERR_PNPM_UNEXPECTED_STORE`，或提示"该插件已安装"）：是旧版 Harness 装 profile 时用了另一个 pnpm store。一次性修好：从菜单退出 Harness，把 `%USERPROFILE%\.dsh\profiles\desktop\node_modules` 改名备份，用 Harness 自带的 pnpm 运行 `install --frozen-lockfile`（不加 `--store-dir`；`$app` 改成你的安装目录，比如 `E:\Software\DeepSeek Harness`），再启动 Harness，插件页的卸载和添加就正常了；如果插件被关掉了，记得重新打开。
- **headless 需要独立凭据。** 要么登录账户，要么设置 `DEEPSEEK_API_KEY`。桌面版里保存的 Key，headless CLI 读不到。
