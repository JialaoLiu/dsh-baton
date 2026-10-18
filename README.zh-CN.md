# dsh-bridge

[English](README.md) | 中文

让 Claude Code、Codex 或任何 MCP 客户端把任务派给本机的 **DeepSeek Harness**，像同事一样协作：

- **新建工作区和对话**：让 Harness 在指定文件夹开工，工作区和对话都会出现在 Harness 侧边栏。
- **续接指定对话**：按 `session_id` 往已有对话继续发消息，沿用原来的上下文，不另开子对话。
- **界面实时可见**：消息由 Harness 自己处理，和你在 Harness 里打字一样，实时显示在界面上。
- **完成即通知**：`dsh_wait` 等到任务结束；或者把 `dsh-bridge wait <run_id>` 当后台命令跑，任务结束那一刻派活的一方就会被唤醒。
- **不用另配 key**：用的是 Harness 桌面版已有的登录、预设和配置。
- **零依赖、只走本机**：只用 Node.js 标准库；插件只开一个仅当前用户可访问的本地套接字，不开端口、不经第三方。

> 非官方项目，与 DeepSeek 无关。

## 组成

```
Claude Code / Codex ──MCP──▶ dsh-bridge-mcp（本仓库 src/）
                                  │ 本地套接字 ~/.dsh-bridge/host.sock（仅当前用户）
                                  ▼
             dsh-bridge-host（本仓库 host/，装在 Harness 里的插件）
                                  │ Harness 官方会话服务
                                  ▼
                     Harness 的工作区、对话和界面
```

| 包 | 装在哪 | 作用 |
|---|---|---|
| [`dsh-bridge-host`](host/) | DeepSeek Harness 桌面版（或 `dsh web`） | 把 Harness 的会话服务开放到本机套接字 |
| `dsh-bridge-mcp` | Claude Code、Codex 等 MCP 客户端 | 提供 `dsh_*` 工具 |

## 安装

需要：DeepSeek Harness ≥ 0.2.1-rc.2 并已登录；Node.js ≥ 22.15。

### 1. 在 Harness 里装插件

Harness → **插件** → **添加插件** → 输入 `dsh-bridge-host` → **安装** → **立即应用**。

（从源码装：把输入框里的包名换成本仓库 `host` 文件夹的绝对路径。改了插件代码后需要重启 Harness。）

### 2. 把 MCP 服务器接到你的客户端

**Claude Code**：

```bash
claude mcp add dsh-bridge -s user -- npx -y dsh-bridge-mcp
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.dsh-bridge]
command = "npx"
args = ["-y", "dsh-bridge-mcp"]
```

从源码运行时把命令换成 `node /绝对路径/dsh-bridge/src/server.mjs`。

## 工具

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

运行状态有 `queued` / `running` / `waiting` / `completed` / `failed` / `cancelled`。`waiting` 表示 Harness 在等人处理（比如审批或提问），需要到 Harness 界面里操作。

**对话正在忙时也能发**：`mode: "followup"`（默认）会进入 Harness 的排队栏，等当前任务做完再处理；`mode: "steer"` 是插话，在当前任务的下一步就交给智能体。每条消息有自己的 `run_id`，分别追踪到完成。只有当回合结束、并且子智能体和后台任务都结束后，运行才算 `completed`。

### 典型流程

1. `dsh_create_workspace {"path": "~/code/new-app"}`
2. `dsh_send {"cwd": "~/code/new-app", "message": "搭一个 Vite + React 项目骨架，跑通 dev server"}` → 得到 `run_id` 和 `session_id`
3. 后台运行 `dsh-bridge wait <run_id>`，结束时被唤醒
4. 审查改动，再 `dsh_send {"session_id": "...", "message": "测试没过，修一下 …"}` 续接同一个对话

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

## 没开 Harness 时：headless 后备模式

插件不可用时，MCP 服务器会自动改用 Harness 自带的 `dsh headless` 命令。这个模式有明显限制：

- 只能续接它自己新建的对话，**不能续接桌面版里建的对话**（Harness 的 headless 不加载 `standard` 等智能体预设）；
- 新建的对话**不会出现在桌面版侧边栏**；
- 默认通过 [`patches/account.patch.yml`](patches/account.patch.yml) 沿用桌面版的 DeepSeek 账号登录，不需要 API key。

`DSH_BRIDGE_BACKEND` 可强制选择：`auto`（默认）、`host`、`headless`。

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_BRIDGE_BACKEND` | `auto` | 选择后端 |
| `DSH_BRIDGE_HOME` | `~/.dsh-bridge` | 套接字和 headless 运行记录的位置 |
| `DSH_BRIDGE_SOCKET` | `$DSH_BRIDGE_HOME/host.sock` | 插件套接字路径（插件和 MCP 两边要一致） |
| `DSH_BIN` | macOS 应用内的 `dsh`，否则查 `PATH` | headless 模式用的 Harness 命令行 |
| `DSH_HOME` | `~/.dsh` | Harness 数据目录（headless 模式读取对话用） |
| `DSH_BRIDGE_ACCOUNT` | `1` | headless 模式下设为 `0` 则改用 API key 路线 |
| `DSH_BRIDGE_PATCHES` | 空 | headless 模式额外的 `--patch` 覆盖文件，用 `:` 分隔 |

## 安全

- 套接字目录权限 `0700`、套接字 `0600`，只有当前系统用户能连。任何能以你的身份运行程序的进程都能用它驱动 Harness，这和直接运行 `dsh` 的权限一样。
- 插件不开网络端口，不连任何外部服务。
- 发出去的任务由 Harness 按它自己的权限设置执行（沙箱、审批）。

## 已知限制

- 桥接任务还在跑时，如果你在 Harness 界面里往同一个对话手动发消息，那一轮的输出会被记到这个桥接任务上（或让它以 `superseded_by: "user"` 结束）。手动操作时，等桥接任务结束，或换一个对话。
- 运行记录（`run_id`）保存在 Harness 进程内存里，Harness 重启后旧的 `run_id` 查不到了；对话本身不受影响。
- MCP 客户端对单次工具调用可能有超时；长任务建议用后台 `wait` 命令，而不是长时间的 `dsh_wait`。
- 依赖 Harness 0.2.1 系列的内部服务接口，Harness 大版本更新后可能需要跟进。

## 许可证

MIT
