# dsh-baton on Windows

dsh-baton runs on Windows 10/11 with the same tools and behaviour as on macOS. This page covers what differs and how to check that everything is connected.

Verified on Windows 11 with DeepSeek Harness 0.2.1-rc.3 (desktop app), Node.js 22.23, the Codex desktop app (codex-cli 0.166) and Claude Code 2.1.

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

Exactly as in the [README](README.md#quick-start): in Harness add the plugin `dsh-baton-host` and switch it on. Updating and removing are the same too ([Install details](README.md#install-details)). On Windows:

- Switched on, the plugin copies the MCP server to `%USERPROFILE%\.dsh-baton\app` and writes `%USERPROFILE%\.claude.json` and `%USERPROFILE%\.codex\config.toml` with the absolute path of `node.exe` (from `PATH`, `%ProgramFiles%\nodejs` or nvm-windows' `NVM_SYMLINK`). Without Node.js it registers `DeepSeek Harness.exe` itself with `ELECTRON_RUN_AS_NODE=1` (Node mode, no window), so nothing else needs installing, so the desktop apps work even though their `claude.exe` / `codex.exe` are usually not on `PATH`. If it reports that it could not register, run `npx -y dsh-baton-mcp setup` in PowerShell.
- Claude Code runs the background `wait_command` in Git Bash.
- Codex waits as on macOS: the plugin writes `tool_timeout_sec = 3600` into `[mcp_servers.dsh-baton]` in `%USERPROFILE%\.codex\config.toml`, so one `dsh_wait` covers a run of up to 59 minutes. Nothing to trust in Codex: **Settings → Hooks** stays empty.
- With the hoisted profile layout, uninstalling a plugin can leave a `node_modules\dsh-baton-host` (or old `dsh-bridge-host`) link in `%USERPROFILE%\.dsh\profiles\desktop`; `setup --remove` deletes it once the profile no longer lists the plugin.

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

   Pass no `--store-dir` or `--config.node-linker`. If you do not rename `node_modules` first, pnpm wants exactly the `storeDir` and `nodeLinker` recorded in `node_modules\.modules.yaml` and aborts on any other value (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Recent profiles use `nodeLinker: hoisted` with the store under `%LOCALAPPDATA%\pnpm\store`.

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
- **安装和 macOS 完全相同。** 在 Harness 插件页添加 `dsh-baton-host` 并启用，详见 [README](README.zh-CN.md#快速上手)。
- **Codex 的等待和 macOS 一样。** 插件在 `%USERPROFILE%\.codex\config.toml` 的 `[mcp_servers.dsh-baton]` 里写入 `tool_timeout_sec = 3600`，一次 `dsh_wait` 就能等完 59 分钟以内的任务。Codex 里不用信任任何东西，**设置 → 钩子** 一直是空的。
- **插件启用时自动注册 MCP。** 它把 MCP 服务器复制到 `%USERPROFILE%\.dsh-baton\app`，再直接写 Claude Code 和 Codex 的用户级配置（用 `PATH`、`%ProgramFiles%\nodejs` 或 nvm-windows 里找到的 `node.exe` 绝对路径；没装 Node.js 时，改用 `DeepSeek Harness.exe` 本身以 Node 模式运行，不弹窗口，不用另外安装任何东西），桌面版的 `claude` / `codex` 不在 `PATH` 里也没关系。之后新开对话就有 `dsh_*` 工具；Codex 每次最多等 270 秒，不用再配超时。没能注册时，在 PowerShell 里运行 `npx -y dsh-baton-mcp setup`。
- **插件页卸不掉或装不上时**（`ERR_PNPM_UNEXPECTED_STORE`，或提示"该插件已安装"）：是旧版 Harness 装 profile 时用了另一个 pnpm store。一次性修好：从菜单退出 Harness，把 `%USERPROFILE%\.dsh\profiles\desktop\node_modules` 改名备份，用 Harness 自带的 pnpm 运行 `install --frozen-lockfile`（不加 `--store-dir`；`$app` 改成你的安装目录，比如 `E:\Software\DeepSeek Harness`），再启动 Harness，插件页的卸载和添加就正常了；如果插件被关掉了，记得重新打开。
- **headless 需要独立凭据。** 要么登录账户，要么设置 `DEEPSEEK_API_KEY`。桌面版里保存的 Key，headless CLI 读不到。
