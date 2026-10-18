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
  <img src="./assets/readme/zh/install.svg" width="100%" alt="第一步：Harness → 插件 → 添加插件 → dsh-bridge-host → 安装 → 立即应用。第二步：把 Claude Code、Codex 或其他 MCP 客户端接到 dsh-bridge-mcp">
</p>

需要：DeepSeek Harness ≥ 0.2.1-rc.2 并已登录；Node.js ≥ 22.15。

**最快：** 把下面这段发给 Claude Code 或 Codex，让它帮你装：

```text
帮我装好 dsh-bridge。
1. 接入 MCP 服务器。Claude Code 里运行：claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
   Codex 则在 ~/.codex/config.toml 里加入：
   [mcp_servers.dsh-bridge]
   command = "npx"
   args = ["-y", "dsh-bridge-mcp"]
2. 提醒我自己在 DeepSeek Harness 里装插件：插件 → 添加插件 → dsh-bridge-host → 安装 → 立即应用。等我确认装好。
3. 需要的话重启后，调用 dsh_list_workspaces 检查是否连通，把结果给我看。
```

或者手动安装：

### 1. 在 Harness 里装插件

Harness → **插件** → **添加插件** → 粘贴下面的包名 → **安装** → **立即应用**。

```text
dsh-bridge-host
```

### 2. 接入你的 MCP 客户端

**Claude Code**

```bash
claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.dsh-bridge]
command = "npx"
args = ["-y", "dsh-bridge-mcp"]
```

从源码装：插件那一步把包名换成本仓库 `host` 文件夹的绝对路径（改了插件代码后需要重启 Harness）；MCP 服务器用 `node /绝对路径/dsh-bridge/src/server.mjs`。

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
| `dsh_send` | 发消息。带 `session_id` 续接那个对话；带 `cwd` 或 `workspace_id` 新开对话（`cwd` 还不是工作区时会先登记）。立即返回 `run_id` |
| `dsh_status` | 查看运行进度：状态、最近的文字和工具调用、最终回复；回合结束但子智能体/后台任务还在跑时给出 `waiting_on` |
| `dsh_wait` | 等到运行结束（或超时）再返回结果 |
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
| `DSH_BRIDGE_SOCKET` | `$DSH_BRIDGE_HOME/host.sock` | 插件套接字路径（插件和 MCP 两边要一致） |
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
  <img src="./assets/readme/zh/limits.svg" width="100%" alt="已知限制：桥接任务在跑时别在界面里往同一个对话发消息；Harness 重启后 run_id 会重置；长任务用后台 wait">
</p>

任何能以你的身份运行程序的进程都能通过这个套接字驱动 Harness，这和直接运行 `dsh` 的权限一样。本项目依赖 Harness 0.2.1 系列的内部服务接口，Harness 大版本更新后可能需要跟进。

## 许可证

MIT
