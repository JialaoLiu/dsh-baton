# dsh-baton-host

Hand coding tasks from Claude Code or Codex to DeepSeek Harness: they run live in this window and come back with the changed files and test results. [Full guide](https://github.com/JialaoLiu/dsh-baton#readme)

让 Claude Code 或 Codex 把编码任务交给 DeepSeek Harness：任务在这个窗口里实时跑，做完带着改动文件和测试结果交回去。[完整说明](https://github.com/JialaoLiu/dsh-baton/blob/main/README.zh-CN.md)

## Install / 安装

**Install / 安装**: Plugins / 插件 → Add plugin / 添加插件 → `dsh-baton-host` → Install / 安装 → Enable now / 立即启用. That registers dsh-baton for Claude Code and Codex. / 启用后会为 Claude Code 和 Codex 注册 dsh-baton。

**Check / 验证**:
1. Open a new chat in Claude Code or Codex; Codex asks once to approve the dsh-baton tools. / 在 Claude Code 或 Codex 里新开对话，Codex 第一次会请你批准 dsh-baton 的工具。
2. Ask it to call `dsh_list_workspaces`; it lists your Harness workspaces. / 让它调用 `dsh_list_workspaces`，会列出你的 Harness 工作区。

Not registered? / 没能注册？Run `npx -y dsh-baton-mcp setup`.

## Update / 更新

Version → **Update to x.y.z** (press **Recheck** first if it says up to date). On Harness 0.2.1: uninstall, then add `dsh-baton-host@x.y.z`.

版本一栏 → **更新到 x.y.z**（显示已是最新时先点 **重新检查**）。Harness 0.2.1：先卸载，再添加 `dsh-baton-host@x.y.z`。

## Remove / 卸载

Uninstall, then run `npx -y dsh-baton-mcp setup --remove`. / 卸载插件后运行 `npx -y dsh-baton-mcp setup --remove`。

---

[Socket protocol / 套接字协议](https://github.com/JialaoLiu/dsh-baton/blob/main/host/PROTOCOL.md) · MIT
