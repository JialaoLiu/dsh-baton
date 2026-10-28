<p align="center">
  <img src="./assets/readme/zh/hero.gif" width="100%" alt="dsh-baton：让 Claude Code 或 Codex 把接力棒交给 DeepSeek Harness，界面实时可见，跑完那一刻就交回给你">
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

<p align="center">
  macOS · Windows（<a href="WINDOWS.md">说明</a>）· 不用装 Node.js · 零依赖 · MIT
</p>

Claude Code 和 Codex 各派一个任务给 DeepSeek Harness，它的子代理用 1 小时 41 分搭出了这条雨夜街道（40 秒，建议开声音）：

https://github.com/user-attachments/assets/ed931637-acb3-4c16-8c52-72298ea90485

<p align="center">
  <img src="./assets/readme/zh/features.svg" width="100%" alt="新建工作区和对话、续接指定对话、界面实时可见并标明发送方、Claude Code 和 Codex 在运行结束时被唤醒、不用另配 key 且可选 Harness 里的任意模型、macOS 和 Windows 零依赖">
</p>

<p align="center">
  <img src="./assets/readme/zh/flow.gif" width="100%" alt="典型流程：新建工作区、派发任务、不轮询地等待（Claude Code 和 Codex 在运行结束时被唤醒）、在同一个对话里续接追问">
</p>

## 实际演示

一个 Codex 对话里完成新建、排队、插队和等待：

<p align="center">
  <img src="./assets/demos/s3-queue-zh.gif" width="100%" alt="左边 Codex 给 DeepSeek 派任务，再排队一条追问、插队修改正在跑的任务并等待；右边 DeepSeek Harness 实时执行">
</p>

Codex 和 Claude 轮流往同一个 Harness 对话发消息，每条都标明是谁发的：

<p align="center">
  <img src="./assets/demos/s8-relay-zh-zoom.gif" width="100%" alt="Harness 对话里 Codex 和 Claude 的消息交替出现，每条都带“由 ChatGPT / Claude 从另一个聊天发送”的标签">
</p>

<p align="center"><a href="docs/demos.zh-CN.md">更多演示 →</a></p>

## 快速上手

<p align="center">
  <img src="./assets/readme/zh/install.svg" width="100%" alt="第一步：Harness → 插件 → 添加插件 → 输入 dsh-baton-host → 安装 → 立即启用，它会为 Claude Code 和 Codex 注册 dsh-baton。第二步（仅 Codex，一次）：设置 → 钩子 → 信任 dsh-baton: waiting for the Harness run。第三步：新开对话，让它调用 dsh_list_workspaces">
</p>

需要：DeepSeek Harness ≥ 0.2.1-rc.2 并已登录；装了 Claude Code 或 Codex。别的都不用装，不用 Node.js，也不用开终端。macOS 和 Windows 步骤完全相同。

**1. 在 Harness 里添加插件：** 插件 → 添加插件 → 输入 `dsh-baton-host` → 安装 → 立即启用。

插件启用后会为 Claude Code 和 Codex 注册 dsh-baton（对所有文件夹生效），Harness 里会弹出提示。

**2. 仅 Codex，只需一次**：Codex **设置 → 钩子（Hooks）** → **信任** **dsh-baton: waiting for the Harness run**。钩子要插件 0.6.0 以上才有（没有 Node.js 时要 0.6.2 以上）；装好或更新插件后，先重启一次 Harness，再重启一次 Codex，它才会出现在这个列表里。不需要 Node.js：没有的话它和服务器一样用 Harness 自带运行环境。之后 Codex 在任务跑完时会被自动唤醒，不用再每 270 秒查一次。只需信任一次：以后升级、热更新、重启 Harness 都不用再信任。不信任也能用，Codex 会照旧用 `dsh_wait` 等，第一次交接时会提醒你。

**3. 检查**：在 Claude Code 或 Codex 里**新开**一个对话，让它调用 `dsh_list_workspaces`，会列出你的 Harness 工作区。

就这些。如果 Harness 提示没能注册，在终端运行 `npx -y dsh-baton-mcp setup`（这需要 Node.js ≥ 22.15），它做的是同样的注册。更新、卸载和 Windows 说明在[后面](#安装细节)。

## 工作原理

<p align="center">
  <img src="./assets/readme/zh/architecture.svg" width="100%" alt="MCP 客户端通过 stdio 调用 dsh-baton-mcp，再经仅当前用户可访问的本地套接字连到 Harness 里的 dsh-baton-host 插件，插件驱动 Harness 的对话并实时显示；插件不可用时退回 dsh headless">
</p>

<p align="center">
  <img src="./assets/readme/zh/comparison.svg" width="100%" alt="插件和 headless 对比：只有插件能在 Harness 界面实时可见、续接桌面版的对话、使用桌面版智能体预设；两者都沿用桌面版登录">
</p>

**各客户端怎么等待**（不需要配置）：
- **Claude Code** 在后台等待任务（`dsh_send` 返回的 `wait_command`），任务结束时只被唤醒一次。
- **Codex**（0.6.1 起）信任了 dsh-baton 的 Stop 钩子后：`dsh_send` 之后直接结束这一轮；钩子在模型之外等任务，任务结束或停下来提问时，带着结果继续同一个对话。每个任务只唤醒模型一次，而不是每 270 秒一次。
- **Codex** 没有钩子时在 `dsh_wait` 里等待，每次最多 270 秒，刚好低于它 300 秒的工具超时。没做完时只返回状态，Codex 会直接再调用，不会去总结进度。Codex 不会收到 `wait_command`：它的终端无法在命令结束时唤醒它，只能轮询。
- Codex 调用 MCP 工具时会请你批准，批准 `dsh-baton` 的工具即可；无人值守的 `codex exec` 加上 `--approve-for-me`。

**指定模型**（0.6.1 起）：直接说用哪个就行，比如「交给 DeepSeek，用 V4 Pro」。`dsh_send` 会把它作为 `model`（以及 `reasoning_effort`）传过去，按 Harness 自己的模型列表匹配，所以 Harness 以后新加的模型一出现就能用。只对这个对话生效，Harness 的默认模型保持不变。`dsh_list_models` 可以看有哪些模型。

**转交之后怎么验收**（0.6.0 起）

不用光听 DeepSeek 自己说做完了。运行前，dsh-baton 先记下文件夹里有什么；运行结束后，它会列出到底新建、修改、删除了哪些文件，并亲自跑一遍项目自己的测试（`npm test`，或者客户端在 `checks` 里给的命令）。接着，另一个只读的 DeepSeek 子智能体会对照需求逐条检查，最后给一张表：哪条需求、做到没有、依据在哪个文件第几行。Claude 或 GPT 只看这些，没做到的一次性发回去改，只有表里写着「没做到」的地方才去翻代码。不用 `cwd` 指定的话，新对话就开在你当前工作的文件夹里。

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/evidence-chain.zh.svg" width="100%" alt="一次真实转交的证据链：用户提需求，Codex 写规格和验收命令，dsh-baton 给文件夹拍快照，DeepSeek Harness 写出 11 个文件，dsh-baton 自己列出改动并跑 npm test，Codex 主动打回一处，dsh-baton 再次验收，Codex 通过，基准测试自己的验收 13/13 通过">
</p>

## Token 用量实测

**一句话：大活、长活交给它**。一次性做一个跨很多文件的功能、一次大重构、一整个小应用，这种时候最省：Claude Code 连 DeepSeek 一起算，总花费少 51–72%。Codex 现在两个案例都省（案例 2 任务管理网页，Sol 少 40%，Astra 少 81%）；GPT-6 Astra 做案例 2，ChatGPT Plus 5 小时额度从占 22% 降到 3%。更长的活，比如分三个阶段的看板应用（案例 4），Astra 总花费少 73%，额度从 86% 降到约 16%。

**说实话**：案例 1 这种小的命令行工具，Codex 用 GPT-6.1 Sol 自己做，总价还略便宜一点：转交反而多花 15%，多出来的几乎全是 DeepSeek 那部分。转交值得的场景是：你想让 Claude 或 GPT 负责规划和把关，让更便宜的模型去动手写，又不想老是撞上 5 小时额度上限。

**适合谁**：大多数人用 Claude 或 ChatGPT 走的是订阅套餐（Plus、Pro、Max 5x 之类），而 DeepSeek 是充值后按用量扣费，所以每次转交都是套餐之外多花的钱。如果你的套餐额度本来就够用，就不用折腾这套流程，省一点是一点。如果你像我一样，经常跑又长又杂、要反复修改的大任务，老是撞上额度上限，那花一点 DeepSeek 的钱，就能让你已经付费的套餐多干很多活。

**两个测试案例**，都按普通用户的口吻提需求（原文可以直接点开看）：
- **案例 1 · 命令行工具**：用 Node 写一个命令行任务管理工具，零依赖，分模块，带测试。[需求原文](docs/benchmarks/token-usage-2026-10/natural/medium.md) · [验收脚本](docs/benchmarks/token-usage-2026-10/checks/natural-medium.mjs)
- **案例 2 · 任务管理网页**：Node 服务器加前端页面，REST 接口、统计、测试和 README。[需求原文](docs/benchmarks/token-usage-2026-10/natural/large.md) · [验收脚本](docs/benchmarks/token-usage-2026-10/checks/natural-large.mjs)

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/natural-combined.zh.svg" width="100%" alt="每个任务的花费，自己做与用 0.6.2 转交，案例 1 · 命令行工具和案例 2 · 任务管理网页：Claude Code（Opus 5.5）和 Codex（GPT-6.1 Sol、GPT-6 Astra），各用自己的刻度">
</p>

每个任务的花费，按标价计，DeepSeek V4.1 Flash 1017 按高峰价：

| 客户端 · 模型 | 案例 | 自己做 | 转交，只算客户端 | 转交，含 DeepSeek |
|---|---|---|---|---|
| Claude Code · Opus 5.5 high | 案例 1 · 命令行工具 | $1.07 | $0.42（−61%） | $0.52（−51%） |
| Claude Code · Opus 5.5 high | 案例 2 · 任务管理网页 | $2.13 | $0.47（−78%） | $0.60（−72%） |
| Codex · GPT-6.1 Sol high | 案例 1 · 命令行工具 | $0.17 | $0.06（−63%） | $0.20（+15%） |
| Codex · GPT-6.1 Sol high | 案例 2 · 任务管理网页 | $0.41 | $0.06（−84%） | $0.25（−40%） |
| Codex · GPT-6 Astra high | 案例 1 · 命令行工具 | $0.79 | $0.30（−62%） | $0.42（−47%） |
| Codex · GPT-6 Astra high | 案例 2 · 任务管理网页 | $2.27 | $0.30（−87%） | $0.42（−81%） |

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/natural-quota-combined.zh.svg" width="80%" alt="Codex 每个任务占 ChatGPT Plus 5 小时额度，自己做与用 0.6.2 转交：GPT-6.1 Sol 和 GPT-6 Astra">
</p>

每个任务占 ChatGPT Plus 5 小时额度：案例 1 Sol 1.9% → ≈0.6%，案例 2 Sol 4.3% → ≈0.6%，案例 1 Astra 7% → 3%，案例 2 Astra 22% → 3%（≈ 为按花费估算）。

**为什么更省了**：0.6.1 起 Codex 由 Stop 钩子唤醒，不再用 `dsh_wait` 轮询；0.6.2 把 MCP 说明缩成一句话，Codex 每次转交少读几千到一万多个新输入 token。

**案例 4 · 看板应用（分阶段）**：只用 Node 内置模块和原生前端的看板应用，分三个阶段在同一个对话里依次给：① 主体（REST 接口、持久化、前端拖拽）；② 标签、截止日期、搜索语法、归档、撤销重做、活动日志、导入导出；③ 版本冲突检测、WIP 上限、批量操作、SSE 实时同步、统计。每个阶段都有事先写好的验收测试，两组用同一套，共 55 项。需求原文：[阶段 1](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase1.md) · [阶段 2](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase2.md) · [阶段 3](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase3.md) · [验收测试](docs/benchmarks/token-usage-2026-10/xxl/seed/tests/acceptance/) · [验收脚本](docs/benchmarks/token-usage-2026-10/xxl/check.mjs) · [测试流程](docs/benchmarks/token-usage-2026-10/xxl/README.md)

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/task4-kanban.zh.svg" width="100%" alt="案例 4 · 看板应用（分阶段），Codex GPT-6 Astra high：自己做 $8.69，用 0.6.2 转交 $2.36（主 Agent $1.62，−81%）；5 小时额度 86% 对约 16%">
</p>

| Codex · GPT-6 Astra high | 自己做 | 转交（0.6.2） |
|---|---|---|
| 主 Agent | $8.69 | $1.62（−81%） |
| DeepSeek | – | $0.74 |
| 合计 | $8.69 | $2.36（−73%） |
| 5 小时额度 | 86% | 约 16%（−81%） |
| 验收测试 | 55/55，一次通过 | 55/55，一次通过 |
| 用时 | 约 31 分钟 | 约 87 分钟 |
| 代码量 | 1,876 行 | 9,953 行 |

案例 3 是同一个看板应用、三个阶段一次给完的版本，Opus 和 Sol 正在测，结果下一次更新补上。

<details>
<summary>测了什么、怎么测的</summary>

- **转交组唯一的区别**，是在需求末尾多一句：交给 DeepSeek Harness 去做。
- 两组用同一个模型、同样的推理强度；每次都用同一套验收脚本检查，模型看不到这个脚本。
- 自己做：沿用之前每格 3 次的平均值（Astra 各 1 次）。用 0.6.2 转交：每格跑 1 次，6 次全部一次通过，没有返工，也没有调用 `dsh_wait`。
- 价格按标价算。DeepSeek 按高峰价，是最保守的算法；实际 DeepSeek 账单大约是这个数的 58%。
- 每一次运行：[运行日志](docs/benchmarks/token-usage-2026-10/LOG.md)（「0.6.2 hand-over rerun」一节）；原始数据在 `docs/benchmarks/token-usage-2026-10/results/*-n062*.jsonl`；方法和更早的版本见[完整报告](docs/benchmarks/token-usage-2026-10.md)。

</details>

## 工具

<p align="center">
  <img src="./assets/readme/zh/tools.svg" width="100%" alt="工具列表里有 10 个：列出工作区、列出对话、读取对话、列出模型、发送、状态、等待、回答、取消、dsh_call。另外 6 个不常用的经 dsh_call 调用：新建和改名工作区、对话动态、给对话改名、修改排队消息、列出运行">
</p>

<p align="center">
  <img src="./assets/readme/zh/states.svg" width="100%" alt="运行状态：queued、running、waiting、completed、failed、cancelled，Harness 中途重启则为 interrupted。对话正忙时，followup 进排队栏，steer 在下一步插话">
</p>

<details>
<summary>完整工具说明</summary>

服务器的 MCP instructions 只有一句话（0.6.2 起）；怎么转交、怎么等、怎么回答问题，都写在各个工具自己的说明里。Codex 会在每个工具的说明前面重复一遍 instructions，所以它给模型看的工具目录从约 2.43 万字符降到约 0.97 万字符。

| 工具 | 作用 |
|---|---|
| `dsh_list_workspaces` | 列出 Harness 侧边栏里的工作区 |
| `dsh_create_workspace` | 经 `dsh_call` 调用。把一个文件夹登记为工作区（文件夹不存在会先创建）；已登记的直接返回原来那个 |
| `dsh_list_sessions` | 列出对话（最新在前），带标题、目录、是否在跑和 `model`（下一次请求用的模型）；可按目录或关键字过滤。已归档的对话不会列出 |
| `dsh_list_models` | 列出 Harness 能用的模型（provider、id、名称、推理强度）和它的默认模型 |
| `dsh_read_session` | 读某个对话最近的消息和回复（含用到的工具名）；已归档的对话会带 `archived: true` |
| `dsh_send` | 发消息。带 `session_id` 续接那个对话；否则新开对话，建在 `cwd` 或 `workspace_id` 指定的位置，都不带时建在当前对话所在的文件夹（`cwd` 还不是工作区时会先登记；指定的 `cwd` 在当前对话文件夹之外也可以，结果里的 `folder_note` 会提醒）。`checks`：运行结束后 dsh-baton 自己跑的测试命令（见「转交之后怎么验收」）。立即返回 `run_id`。Harness 里这条消息会标注「由 Claude / ChatGPT 从另一个聊天发送」。已归档的对话会被拒绝：先在 Harness 里取消归档，或新开对话。对话正忙时，`mode` 为 `followup` 会排在当前回合之后，`steer` 会插进正在跑的回合；不传时跟随 Harness 自己的设置（设置 → 繁忙时的发送行为：排队发送或插话发送），读不到设置时按 `followup`。返回里的 `mode_source` 说明用的是哪种。`model` 只在用户点名模型时传（如“DeepSeek-V4 Pro”“v4-pro”；`reasoning_effort` 同理）：按 Harness 自己的模型列表匹配，不分大小写，忽略空格、连字符和开头的 DeepSeek，所以 Harness 以后上线的模型（如 V4.1 Pro）一出现在列表里就能用；匹配不到或匹配到多个时，发送直接失败、什么都不创建，并列出可用模型（用 `provider/model` 指定其一）。模型在消息发出前设到该对话上，Harness 的默认模型会恢复原样（Harness 会把对话里选的模型同时存成默认）。不传时，续接的对话沿用它自己的模型，新对话用 Harness 默认模型。返回值的 `model` 和 `model_source` 写明用的是哪个 |
| `dsh_status` | 查看运行进度：状态、最近的文字和工具调用、最终回复；回合结束但子智能体/后台任务还在跑时给出 `waiting_on`；中途有人在 Harness 界面里发消息时给出 `human_interjections`；被 Harness 重启打断的任务状态为 `interrupted`；以及这次运行发送时用的 `model` |
| `dsh_wait` | 信任了 Stop 钩子的 Codex 用不到它。等运行结束；发消息时带了 `checks` 的，结束后会附上 `evidence`（改了哪些文件、测试结果）（或者等到它停下来问人，见 `dsh_answer`）：Codex 每次最多等 270 秒，其他客户端 50 秒。没做完会带 `timed_out`，只返回状态，再调用一次即可。能在后台等待的客户端改用 `dsh_send` 返回的 `wait_command`。`dsh_status` 只用来看一眼，不用来等待 |
| `dsh_answer` | 回答运行中途提出的问题（Harness 的 ask_user_question）：每道题可以填选项编号或选项文字、自由填写，或者跳过；可以逐题回答，也可以一次答完。运行一提问，`dsh_wait` 和 `wait_command` 就会立刻返回，并带上题目（`needs_input`、`question`；Harness 那边模型推荐的选项单独放在 `harness_suggested` 里，不再写在选项文字中）。只有你说过让它自己决定时，助手才会按自己的判断回答，这时它会带上 `reason`，并告诉你选了什么、为什么；否则它会把题目转给你，开头先写它自己的建议和理由。你也可以直接在 Harness 窗口里回答，谁先答就算谁的 |
| `dsh_session_activity` | 经 `dsh_call` 调用。对话此刻在做什么：正在跑的回合、子智能体（任意层级）、后台任务；已归档的对话会带 `archived: true` |
| `dsh_update_queued` | 经 `dsh_call` 调用。按 `run_id` 修改还在忙碌对话队列里等待的消息：`edit` 改文字，`remove` 撤回，`steer` 立刻插进正在跑的回合。消息一旦进入对话就改不了了 |
| `dsh_cancel` | 按 `run_id` 或 `session_id` 停掉整个对话的工作：当前回合、子智能体、后台任务。Harness 会同时清掉队列里等待的消息，这些运行记为 `cancelled` |
| `dsh_rename_session` | 经 `dsh_call` 调用。给对话改名 |
| `dsh_rename_workspace` | 经 `dsh_call` 调用。给工作区改名（只改侧边栏标题，不动文件夹） |
| `dsh_list_runs` | 经 `dsh_call` 调用。列出最近的运行，可按会话筛选 |
| `dsh_call` | 按名字调用任意 `dsh_*` 工具：0.6.0 起，不常用的工具（新建和重命名工作区、重命名对话、对话动态、修改排队消息、运行列表）不再出现在工具列表里，好让每次请求更短，改由这里调用；对话的工具列表还是更新前的旧版时也用它。名字不存在时会列出所有可用工具 |

</details>

## 命令行

```bash
dsh-baton workspaces
dsh-baton new-workspace ~/code/new-app --title "New App"
dsh-baton sessions --cwd ~/code/new-app
dsh-baton send --cwd ~/code/new-app "搭项目骨架"
dsh-baton send --session session-xxxx "继续：补上测试"
dsh-baton send --session session-xxxx --mode steer "插话：先别改 API"
dsh-baton wait hrun-xxxx              # 阻塞到结束，打印最终回复；成功退出码 0
dsh-baton status hrun-xxxx
dsh-baton activity session-xxxx       # 正在跑的回合、子智能体、后台任务
dsh-baton cancel --session session-xxxx
dsh-baton rename session-xxxx 新标题
dsh-baton rename-workspace ~/code/new-app 新名字
```

（从源码运行时用 `node src/cli.mjs …`。）

## 配置（环境变量）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_BATON_BACKEND` | `auto` | `auto`、`host` 或 `headless` |
| `DSH_BATON_HOME` | `~/.dsh-baton` | 套接字和 headless 运行记录的位置 |
| `DSH_BATON_SOCKET` | `$DSH_BATON_HOME/host.sock` | 插件套接字路径（插件和 MCP 两边要一致）；Windows 上映射为按用户区分的命名管道，见 [WINDOWS.md](WINDOWS.md) |
| `DSH_BATON_WAIT_S` | Codex 为 `270`，其他为 `50` | 一次 `dsh_wait` 等多久；只有调大了客户端的工具超时才需要设，并且要小于那个超时 |
| `DSH_BATON_CODEX_HOOK` | `1` | 给 Harness 设为 `0`，插件就不再添加 Codex 的 Stop 钩子 |
| `DSH_BIN` | macOS 应用内的 `dsh`，否则查 `PATH` | headless 模式用的 Harness 命令行 |
| `DSH_HOME` | `~/.dsh` | Harness 数据目录（headless 模式读取对话用） |
| `DSH_BATON_ACCOUNT` | `1` | headless 模式下设为 `0` 则改用 API key 路线 |
| `DSH_BATON_PATCHES` | 空 | headless 模式额外的 `--patch` 覆盖文件，用 `:` 分隔 |

<details>
<summary>headless 后备模式说明</summary>

插件不可用时，MCP 服务器会自动改用 Harness 自带的 `dsh headless` 命令。它只能续接自己新建的对话，不能续接桌面版里建的对话（headless 不加载 `standard` 等智能体预设）；新建的对话也不会出现在桌面版侧边栏。默认通过 [`patches/account.patch.yml`](patches/account.patch.yml) 沿用桌面版的 DeepSeek 账号登录，不需要 API key。

</details>

## 安装细节

<details>
<summary>插件做了什么、更新、卸载、从 dsh-bridge 升级、从源码安装、Windows</summary>

**插件启用时做了什么**。它把 MCP 服务器复制到 `~/.dsh-baton/app` 这个固定的文件夹，再直接把 MCP 注册写进 `~/.claude.json` 和 `~/.codex/config.toml`，各留一份 `*.bak-dsh-baton` 备份。电脑上有 Node.js ≥ 22.15（在 `PATH` 里能找到）就用它启动服务器；没有的话，就用 Harness 自带的运行环境（Harness 应用本身以 Node 模式运行，`ELECTRON_RUN_AS_NODE=1`），不用另外安装任何东西。两种情况下，只装了桌面应用、`claude` / `codex` 不在 `PATH` 里也能用。每次 Harness 启动都会再检查一遍：已经正确的注册、或者指向另一份可用 dsh-baton 的注册，都不会改动。在 Harness 里输入包名后，安装源会自动切到「npm 官方源」（英文界面是 "Official npm registry"），不用另外选择，也不用重启。不想让插件自动注册，给 Harness 设置 `DSH_BATON_AUTO_REGISTER=0`。

**Codex 的 Stop 钩子**。插件会在 `~/.codex/config.toml` 里加一段带 `# dsh-baton` 标记的 `[[hooks.Stop]]`，Codex 里显示为 **dsh-baton: waiting for the Harness run**，你信任之后才会运行（dsh-baton 不会替你信任）。这一段只写了一个小脚本的路径 `~/.dsh-baton/bin/codex-stop-hook`（Windows 上是 `codex-stop-hook.cmd`），Node.js 和服务器这些会变的路径都放在脚本里。所以这一段本身永远不变：升级、同版本刷新、重启 Harness 都不会动它，信任一直有效。万一这一段被改写，dsh-baton 会清掉旧的信任记录，Codex 会请你重新信任。Windows 上用 `.cmd`，是因为 Codex 通过 `PowerShell -Command` 运行钩子，启动不了带引号的程序路径。没有自己的 Node.js 时，脚本和服务器一样以 Node 模式（`ELECTRON_RUN_AS_NODE=1`）运行 Harness 程序本身；插件每次启动都会重写它，所以 Harness 更新后路径也会跟上。只有没装 Codex、设了 `DSH_BATON_CODEX_HOOK=0`、或 Codex 里的 dsh-baton 条目没指向服务器目录（比如裸的 `npx` 命令）时才不加；这时 Codex 对话里第一次交接会说明原因。手动添加用 `dsh-baton setup --codex-hook`，`setup --remove` 会删掉它，给 Harness 设置 `DSH_BATON_CODEX_HOOK=0` 则插件不再添加。

**更新不用重启**。新版本装进 `~/.dsh-baton/app` 后（插件更新、`setup` 或手动复制），或者同一版本但文件有改动时，Claude Code 和 Codex 里已经开着的对话，下一次调用 `dsh_*` 工具时就会用上：服务器每次调用前检查这个文件夹，启动新版本，并在这次调用的结果里提示一次已经更新。正在进行的 `dsh_wait` 会先在旧版本里跑完。新版本启动失败时，旧版本继续工作，结果里会说明原因。新版本新增的工具，Claude Code 里马上就能用（服务器会通知客户端工具列表变了）；Codex 一直用对话开始时的工具列表，新工具要到下一个新对话才会显示；从 0.5.9 起，旧对话里也能通过 `dsh_call` 马上用上新功能（更新提示里会写明），已有的工具也会立刻用上新代码。这个功能从 0.5.8 之后的版本开始有效；由 0.5.8 或更早版本启动的服务器，还需要最后重启一次（或在 `/mcp` 里重新连接）。

**`npx -y dsh-baton-mcp setup`** 在终端里做同样的注册：用于插件没能注册的情况，或者从 MCP 目录过来的用户。插件已经注册过时它什么都不改；插件没装的话，它会提示去添加。

**更新**。Harness 只给官方插件提供"更新"按钮，所以要：插件 → dsh-baton-host → **卸载**，再**添加插件** → `dsh-baton-host`。新版本刚发布的一段时间里，Harness 会装上一个版本（pnpm 的 `minimumReleaseAge` 会暂缓刚发布的版本，安装弹窗里会说明）；想马上用新版，输入带版本号的名字：`dsh-baton-host@0.6.2`。预发布版必须写确切版本号添加，比如 `dsh-baton-host@0.6.0-next.0`：Harness 会把 `@next` 解析成一个坏掉的占位包。只输入 `dsh-baton-host` 装的是最新正式版。重新启用后，插件会把 MCP 服务器也更新到同一版本，新开的对话就会用上。万一两边版本对不上，第一次发现不一致的工具调用会提示，并写明哪一边旧、另一边的确切版本号。

**卸载**。Harness → 插件 → dsh-baton-host → **卸载**，再运行 `npx -y dsh-baton-mcp setup --remove`。插件分不清"被卸载"和"Harness 退出"，所以 MCP 注册交给这条命令删，它也会删掉 `~/.dsh-baton/app`；运行记录留在 `~/.dsh-baton`，不需要的话自己删掉。

**从 dsh-bridge 升级**。在 Harness 里先卸载 `dsh-bridge-host`，再添加 `dsh-baton-host`；启用后它会替换掉旧的 `dsh-bridge` MCP 注册。`DSH_BRIDGE_*` 环境变量和已有的 `~/.dsh-bridge` 文件夹暂时继续可用。工具前缀变成 `mcp__dsh-baton__…`，权限白名单里写了旧前缀的要改一下。0.4 之前通过粘贴 `~/.dsh-baton/app/host` 装的插件仍然能用，但不会跟着 npm 更新：卸载它，再按包名添加 `dsh-baton-host`。

**从源码安装**（想跟进 `main` 或改代码）：`git clone https://github.com/JialaoLiu/dsh-baton.git`，然后在 Harness 里从克隆目录的 `host` 文件夹添加插件（添加插件 → 粘贴路径）。启用后注册的就是克隆目录本身，改动在发布前就能跑起来；更新用 `git pull`。在终端里运行 `node dsh-baton/src/cli.mjs setup` 也能注册克隆目录。

**Windows**。步骤相同；[WINDOWS.md](WINDOWS.md) 说明了不同之处（用命名管道代替套接字文件），以及插件页装不上或卸不掉时的修法。

<details>
<summary>手动注册与 Claude 桌面应用</summary>

插件和 `setup` 写入的内容和下面两条命令等价（用 `node` 的绝对路径，因为桌面应用启动 MCP 服务器时没有你 shell 的 `PATH`）：

```bash
claude mcp add dsh-baton -s user -- "$(command -v node)" "$PWD/dsh-baton/src/server.mjs"
codex mcp add dsh-baton -- "$(command -v node)" "$PWD/dsh-baton/src/server.mjs"
```

`-s user` 很关键：不加的话，Claude Code 只给当前项目文件夹注册。

**Claude 桌面应用（可选）**：聊天应用的连接器（和 Claude Code 是两回事），把下面这段加到 `~/Library/Application Support/Claude/claude_desktop_config.json`，然后重启应用，会显示为 "Local dev" 连接器。

```json
{ "mcpServers": { "dsh-baton": { "command": "/node 的绝对路径", "args": ["/dsh-baton 的绝对路径/src/server.mjs"] } } }
```

</details>

</details>

## 安全与限制

<p align="center">
  <img src="./assets/readme/zh/security.svg" width="100%" alt="仅当前用户可连（macOS/Linux 用 0600 套接字，Windows 用按用户的命名管道），不开网络端口，沿用 Harness 的沙箱和审批">
</p>

<p align="center">
  <img src="./assets/readme/zh/limits.svg" width="100%" alt="使用须知：任务进行中在界面里发的话会作为人工插话记到任务上；任务记录在 Harness 重启后还在，被打断的标为 interrupted；Claude Code 和 Codex 都只在运行结束时被唤醒一次">
</p>

任何能以你的身份运行程序的进程都能通过这个套接字驱动 Harness，这和直接运行 `dsh` 的权限一样。本项目依赖 Harness 0.2.1 系列的内部服务接口，Harness 大版本更新后可能需要跟进。

<p align="center"><a href="docs/demos.zh-CN.md">更多演示 →</a></p>

## 许可证

MIT
