<p align="center">
  <img src="./assets/readme/zh/hero.gif" width="100%" alt="dsh-bridge：让 Claude Code 或 Codex 把任务派给 DeepSeek Harness，界面实时可见，做完那一刻就把你叫醒">
</p>

<p align="center">
  <a href="README.md">English</a> | 中文 · 非官方项目，与 DeepSeek 无关。
</p>

<p align="center">
  <img src="./assets/readme/zh/features.svg" width="100%" alt="新建工作区和对话、续接指定对话、界面实时可见、完成即唤醒、不用另配 key、零依赖只走本机">
</p>

<p align="center">
  <img src="./assets/readme/zh/flow.gif" width="100%" alt="典型流程：新建工作区、派发任务、后台等待、在同一个对话里续接追问">
</p>

## 快速上手

<p align="center">
  <img src="./assets/readme/zh/install.svg" width="100%" alt="第一步：Harness → 插件 → 添加插件 → 粘贴 dsh-bridge/host 文件夹的路径 → 安装 → 立即应用。第二步：在 Claude Code 和 Codex 里全局注册一次 src/server.mjs">
</p>

需要：DeepSeek Harness ≥ 0.2.1-rc.2 并已登录；Node.js ≥ 22.15；git。Windows 见 [WINDOWS.md](WINDOWS.md)。

> npm 包 `dsh-bridge-host` 和 `dsh-bridge-mcp` 还没发布，目前请按下面的方法从仓库源码安装。不需要 `npm install`：dsh-bridge 没有任何依赖。

终端里两条命令，再在 Harness 里粘贴一次：

```bash
git clone https://github.com/JialaoLiu/dsh-bridge.git
node dsh-bridge/src/cli.mjs setup
```

`setup` 会在用户级别给 Claude Code 和 Codex 注册一次 MCP 服务器：之后在任何文件夹新开的对话都有 `dsh_*` 工具。它直接写 `~/.claude.json` 和 `~/.codex/config.toml`（各留一份 `*.bak-dsh-bridge` 备份），所以只装了桌面应用、`claude` / `codex` 不在 `PATH` 里也能用。重复运行也没问题。

然后在 Harness 里完成最后一步。`setup` 已经把插件文件夹路径复制到剪贴板：

**插件** → **添加插件** → 粘贴 → **安装** → **立即启用**

检查：在 Claude Code 或 Codex 里**新开**一个对话，让它调用 `dsh_list_workspaces`，应该会列出你的 Harness 工作区。

**也可以让 Claude Code 或 Codex 帮你装：** 发给它 *"运行 `git clone https://github.com/JialaoLiu/dsh-bridge.git ~/dsh-bridge && node ~/dsh-bridge/src/cli.mjs setup`，然后告诉我它提示的 Harness 那一步。"*

不需要别的配置：
- **Claude Code** 在后台等待任务（`dsh_send` 返回的 `wait_command`），任务结束时只被唤醒一次。
- **Codex** 在 `dsh_wait` 里等待，每次最多 270 秒，刚好低于它 300 秒的工具超时。没做完时只返回状态，Codex 会直接再调用，不会去总结进度。Codex 不会收到 `wait_command`：它的终端无法在命令结束时唤醒它，只能轮询。
- Codex 调用 MCP 工具时会请你批准，批准 `dsh-bridge` 的工具即可；无人值守的 `codex exec` 加上 `--approve-for-me`。

**更新：** 在克隆目录里 `git pull`，然后重启 Harness 以加载插件改动；新开的对话会用上 MCP 服务器的改动。

**卸载：** `node dsh-bridge/src/cli.mjs setup --remove`，再到 Harness → 插件 → dsh-bridge-host → 卸载。

<details>
<summary>手动注册与 Claude 桌面应用</summary>

`setup` 写入的内容和下面两条命令等价（用 `node` 的绝对路径，因为桌面应用启动 MCP 服务器时没有你 shell 的 `PATH`）：

```bash
claude mcp add dsh-bridge -s user -- "$(command -v node)" "$PWD/dsh-bridge/src/server.mjs"
codex mcp add dsh-bridge -- "$(command -v node)" "$PWD/dsh-bridge/src/server.mjs"
```

`-s user` 很关键：不加的话，Claude Code 只给当前项目文件夹注册。

**Claude 桌面应用（可选）**：聊天应用的连接器（和 Claude Code 是两回事），把下面这段加到 `~/Library/Application Support/Claude/claude_desktop_config.json`，然后重启应用，会显示为 "Local dev" 连接器。

```json
{ "mcpServers": { "dsh-bridge": { "command": "/node 的绝对路径", "args": ["/dsh-bridge 的绝对路径/src/server.mjs"] } } }
```

</details>

## 工作原理

<p align="center">
  <img src="./assets/readme/zh/architecture.svg" width="100%" alt="MCP 客户端通过 stdio 调用 dsh-bridge-mcp，再经仅当前用户可访问的本地套接字连到 Harness 里的 dsh-bridge-host 插件，插件驱动 Harness 的对话并实时显示；插件不可用时退回 dsh headless">
</p>

<p align="center">
  <img src="./assets/readme/zh/comparison.svg" width="100%" alt="插件和 headless 对比：只有插件能在 Harness 界面实时可见、续接桌面版的对话、使用桌面版智能体预设；两者都沿用桌面版登录">
</p>

## 工具

<p align="center">
  <img src="./assets/readme/zh/tools.svg" width="100%" alt="工作区：列出、新建、改名。对话：列出、读取、当前活动、改名。运行：发送、状态、等待、取消、列出最近运行">
</p>

<p align="center">
  <img src="./assets/readme/zh/states.svg" width="100%" alt="运行状态：queued、running、waiting、completed、failed、cancelled。对话正忙时，followup 进排队栏，steer 在下一步插话">
</p>

<details>
<summary>完整工具说明</summary>

| 工具 | 作用 |
|---|---|
| `dsh_list_workspaces` | 列出 Harness 侧边栏里的工作区 |
| `dsh_create_workspace` | 把一个文件夹登记为工作区（文件夹不存在会先创建）；已登记的直接返回原来那个 |
| `dsh_list_sessions` | 列出对话（最新在前），带标题、目录、是否在跑；可按目录或关键字过滤 |
| `dsh_read_session` | 读某个对话最近的消息和回复（含用到的工具名） |
| `dsh_send` | 发消息。带 `session_id` 续接那个对话；带 `cwd` 或 `workspace_id` 新开对话（`cwd` 还不是工作区时会先登记）。立即返回 `run_id`。Harness 里这条消息会标注「由 Claude / ChatGPT 从另一个聊天发送」 |
| `dsh_status` | 查看运行进度：状态、最近的文字和工具调用、最终回复；回合结束但子智能体/后台任务还在跑时给出 `waiting_on`；中途有人在 Harness 界面里发消息时给出 `human_interjections`；被 Harness 重启打断的任务状态为 `interrupted` |
| `dsh_wait` | 等运行结束：Codex 每次最多等 270 秒，其他客户端 50 秒。没做完会带 `timed_out`，只返回状态，再调用一次即可。能在后台等待的客户端改用 `dsh_send` 返回的 `wait_command`。`dsh_status` 只用来看一眼，不用来等待 |
| `dsh_session_activity` | 对话此刻在做什么：正在跑的回合、子智能体（任意层级）、后台任务 |
| `dsh_cancel` | 按 `run_id` 或 `session_id` 停掉整个对话的工作：当前回合、子智能体、后台任务（排队中的消息不会被删） |
| `dsh_rename_session` | 给对话改名 |
| `dsh_rename_workspace` | 给工作区改名（只改侧边栏标题，不动文件夹） |
| `dsh_list_runs` | 列出最近的运行 |

</details>

## 命令行

```bash
dsh-bridge workspaces
dsh-bridge new-workspace ~/code/new-app --title "New App"
dsh-bridge sessions --cwd ~/code/new-app
dsh-bridge send --cwd ~/code/new-app "搭项目骨架"
dsh-bridge send --session session-xxxx "继续：补上测试"
dsh-bridge send --session session-xxxx --mode steer "插话：先别改 API"
dsh-bridge wait hrun-xxxx              # 阻塞到结束，打印最终回复；成功退出码 0
dsh-bridge status hrun-xxxx
dsh-bridge activity session-xxxx       # 正在跑的回合、子智能体、后台任务
dsh-bridge cancel --session session-xxxx
dsh-bridge rename session-xxxx 新标题
dsh-bridge rename-workspace ~/code/new-app 新名字
```

（从源码运行时用 `node src/cli.mjs …`。）

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_BRIDGE_BACKEND` | `auto` | `auto`、`host` 或 `headless` |
| `DSH_BRIDGE_HOME` | `~/.dsh-bridge` | 套接字和 headless 运行记录的位置 |
| `DSH_BRIDGE_SOCKET` | `$DSH_BRIDGE_HOME/host.sock` | 插件套接字路径（插件和 MCP 两边要一致）；Windows 上映射为按用户区分的命名管道，见 [WINDOWS.md](WINDOWS.md) |
| `DSH_BRIDGE_WAIT_S` | Codex 为 `270`，其他为 `50` | 一次 `dsh_wait` 等多久；只有调大了客户端的工具超时才需要设，并且要小于那个超时 |
| `DSH_BIN` | macOS 应用内的 `dsh`，否则查 `PATH` | headless 模式用的 Harness 命令行 |
| `DSH_HOME` | `~/.dsh` | Harness 数据目录（headless 模式读取对话用） |
| `DSH_BRIDGE_ACCOUNT` | `1` | headless 模式下设为 `0` 则改用 API key 路线 |
| `DSH_BRIDGE_PATCHES` | 空 | headless 模式额外的 `--patch` 覆盖文件，用 `:` 分隔 |

<details>
<summary>headless 后备模式说明</summary>

插件不可用时，MCP 服务器会自动改用 Harness 自带的 `dsh headless` 命令。它只能续接自己新建的对话，不能续接桌面版里建的对话（headless 不加载 `standard` 等智能体预设）；新建的对话也不会出现在桌面版侧边栏。默认通过 [`patches/account.patch.yml`](patches/account.patch.yml) 沿用桌面版的 DeepSeek 账号登录，不需要 API key。

</details>

## 安全与限制

<p align="center">
  <img src="./assets/readme/zh/security.svg" width="100%" alt="目录 0700、套接字 0600，只有当前用户能连；不开网络端口；任务按 Harness 的沙箱和审批设置执行">
</p>

<p align="center">
  <img src="./assets/readme/zh/limits.svg" width="100%" alt="使用须知：任务进行中在界面里发的话会作为人工插话记到任务上；任务记录在 Harness 重启后还在，被打断的标为 interrupted；Claude Code 结束时唤醒一次，Codex 每次最多等 270 秒">
</p>

任何能以你的身份运行程序的进程都能通过这个套接字驱动 Harness，这和直接运行 `dsh` 的权限一样。本项目依赖 Harness 0.2.1 系列的内部服务接口，Harness 大版本更新后可能需要跟进。

## 许可证

MIT
