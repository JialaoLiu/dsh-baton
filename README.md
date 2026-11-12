<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/hero-dark.gif"><img src="./assets/readme/en/hero.gif" width="100%" alt="dsh-baton: pass the baton from Claude Code or Codex to DeepSeek Harness, watch it run live, and get it handed back when it's done"></picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/English-2563EB?style=for-the-badge" alt="English">
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-8B95A5?style=for-the-badge" alt="中文"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-baton-host"><img src="https://img.shields.io/npm/v/dsh-baton-host?label=dsh-baton-host&color=CB3837" alt="npm version"></a>
  <img src="https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white" alt="macOS supported">
  <a href="WINDOWS.md"><img src="https://img.shields.io/badge/Windows-guide-0078D4" alt="Windows guide"></a>
  <img src="https://img.shields.io/badge/Node.js-not%20needed-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js not needed">
  <img src="https://img.shields.io/badge/dependencies-zero-2EA44F" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-DFB317" alt="MIT license"></a>
</p>

<p align="center"><a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp; <a href="#see-it-run"><b>See it run</b></a> &nbsp;·&nbsp; <a href="#how-it-compares"><b>How it compares</b></a> &nbsp;·&nbsp; <a href="#token-usage"><b>Token usage</b></a> &nbsp;·&nbsp; <a href="#how-it-works"><b>How it works</b></a> &nbsp;·&nbsp; <a href="#tools"><b>Tools</b></a> &nbsp;·&nbsp; <a href="#security-and-limits"><b>Security</b></a></p>

<br>

Hand coding tasks from Claude Code or Codex to DeepSeek Harness on your machine: the task runs live in the Harness window, the main agent hears back once when it ends, and it gets back the files that changed, the project's own test results and a requirement-by-requirement checklist.

- **Watch it and step in:** the task runs live in the Harness window and you can type into it at any time. Every message is labelled "Sent by ChatGPT / Claude from another chat". When Harness stops to ask a question, the main agent answers it if you told it to decide, or brings it to you with its own recommendation.
- **Less of the 5-hour window:** a long Codex job takes 16% of a ChatGPT Plus 5-hour window instead of 86% (GPT-6 Astra, the kanban task). The rest of the numbers are under [Token usage](#token-usage).
- **Nothing to watch or poll:** the main agent waits without polling and gets the result when the run ends. With several runs going at once, each one comes back within a second of finishing.

Needs DeepSeek Harness ≥ 0.2.1-rc.2 (signed in) and Claude Code or Codex. [Quick start →](#quick-start)

## What it is

dsh-baton is an MCP server plus a small Harness plugin. The main agent hands the task to an ordinary Harness session with one tool call: you watch it run in the Harness window and can step in at any time, and the main agent hears back once, without polling. Unlike a plain MCP bridge to another model, the work stays visible and the proof comes back with the result.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## How it compares

|  | **dsh-baton** | Model-swap gateway | Background sub-agent |
|---|---|---|---|
| The main agent keeps its own model | **Yes** | No, the whole chat runs on the other model | Yes |
| You can watch the work | **Yes, live in the Harness window** | Yes, in the same chat | The main chat gets a summary |
| You can step in mid-run | **Yes, in Harness, or the main agent steers it in** | Yes | Usually not |
| Each message says who sent it | **Yes, sent by ChatGPT / Claude** | One side only | Not needed |
| Changed files and test results come back | **dsh-baton lists the files and runs your tests itself** | No hand-over step | The sub-agent's own summary |
| Questions reach you | **Yes, with the main agent's recommendation** | It asks you directly | Usually not |

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Why split the work

Beyond the savings, the split itself helps:

- **A spec before the code.** The main agent turns your loose request into clear requirements before handing it over, so Harness gets a clear spec rather than a relayed "build me an X".
- **Checked on evidence.** The result carries the changed files, your project's own test output and a point-by-point check against the request; anything missing goes back for another round, instead of taking "done" on trust.
- **The main conversation keeps the decisions.** Hundreds of steps of reading files, editing and running tests stay in the Harness session; the main conversation holds your request and the conclusions.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Quick start

**Install in one step, check in two.**

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/install-dark.svg"><img src="./assets/readme/en/install.svg" width="100%" alt="Install: in Harness open Plugins, Add plugin, enter dsh-baton-host, Install, Enable now; it registers dsh-baton for Claude Code and Codex. Then check that it works: open a new conversation in Claude Code or Codex (Codex asks once to approve the dsh-baton tools), and ask it to call dsh_list_workspaces; it lists your Harness workspaces."></picture>
</p>

Nothing else to install: no Node.js, no terminal. It is the same on macOS and Windows.

**Install:** in Harness, **Plugins** (插件) → **Add plugin** (添加插件) → type `dsh-baton-host` → **Install** (安装) → **Enable now** (立即启用). Switched on, the plugin registers dsh-baton for Claude Code and Codex, for every folder, and Harness says so.

**Check that it works:**

① **Open a new chat:** in Claude Code or Codex, start a **new** conversation; one that was already open does not see dsh-baton yet. It is the same in both. Codex asks you to approve MCP tool calls: approve the `dsh-baton` tools (for unattended `codex exec` runs, add `--approve-for-me`).

② **Ask for the workspaces:** ask it to call `dsh_list_workspaces`. It lists your Harness workspaces.

That is all. To hand a task over, end the request with "hand it to DeepSeek Harness". Updating, removing, Windows, and registering by hand when the plugin could not, are [further down](#install-details).

**Installed on the day of a release?** For about a day after a release, Harness installs the previous version, and its install dialog says so. Open the plugin's page and press **Update to x.y.z** (更新到), or add the plugin with its version, such as `dsh-baton-host@x.y.z`.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## See it run

Codex and Claude take turns in the same Harness session, and every message says who sent it:

<p align="center">
  <img src="./assets/demos/s8-label-en.gif" alt="Harness chat where messages alternate between Codex and Claude, each labelled Sent by ChatGPT or Sent by Claude from another chat">
</p>

Queue and steer: the first task is running, the steer joins the same turn, and the queued follow-up waits above the input:

<p align="center">
  <img src="./assets/demos/s3-steer-en.gif" alt="Harness chat: the first task runs, the steer arrives as a new message in the same turn, and the queued follow-up sits in the queue above the input">
</p>

<p align="center"><a href="docs/demos.md">All demos (full recordings) →</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Token usage

**In short: hand over the big, long jobs.** With Claude Code the total cost, DeepSeek included, is 51–78% lower. With Codex on GPT-6 Astra it is 47–81% lower, and the long kanban app takes 16.01% of a ChatGPT Plus 5-hour window instead of 86.01%.

**Hand it over:** big jobs, long jobs, and whenever the 5-hour window is running low. The main agent's own spend drops 61–87% on every task and model.

**The three test tasks**, asked the way a user would (the requests are in Chinese, linked as written):
- **Task 1 · CLI tool:** a command-line task manager in Node, no dependencies, split into modules, with tests. [Request](docs/benchmarks/token-usage-2026-10/natural/medium.md)
- **Task 2 · Web app:** a task manager with a Node server and a page, REST API, stats, tests and a README. [Request](docs/benchmarks/token-usage-2026-10/natural/large.md)
- **Task 3 · Kanban app (phased):** a kanban board in plain Node and a plain front end, in three phases given one after another in the same conversation: ① the core (REST API, storage, drag and drop); ② labels, due dates, search syntax, archive, undo and redo, activity log, import and export; ③ version conflicts, WIP limits, bulk actions, live sync over SSE, stats. 55 acceptance tests written beforehand, the same for both arms. Requests: [phase 1](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase1.md) · [phase 2](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase2.md) · [phase 3](docs/benchmarks/token-usage-2026-10/xxl/seed/docs/phase3.md)

| Task 3 | Alone | Handed over |
|---|---|---|
| Opus 5.5 high | 55/55, 39 min | 55/55, 93 min |
| GPT-6.1 Sol high | 55/55, 18 min | 55/55, 101 min |
| GPT-6 Astra high | 55/55, about 31 min | 55/55, about 87 min |

Cost per task at list price, DeepSeek V4.1 Flash 1017 at its peak price. Opus 5.5 runs in Claude Code, GPT-6.1 Sol and GPT-6 Astra in Codex, all at high effort:

| Task | Model | Alone | Handed over: main agent | Handed over: DeepSeek | Handed over: total | Total | Main agent |
|---|---|---|---|---|---|---|---|
| Task 1 · CLI tool | Opus 5.5 high | $1.07 | $0.42 | $0.10 | $0.52 | −51.2% | −60.8% |
| | GPT-6 Astra high | $0.79 | $0.30 | $0.12 | $0.42 | −47.4% | −62.0% |
| Task 2 · Web app | Opus 5.5 high | $2.13 | $0.47 | $0.13 | $0.60 | −71.7% | −77.7% |
| | GPT-6 Astra high | $2.27 | $0.30 | $0.13 | $0.42 | −81.4% | −86.9% |
| Task 3 · Kanban app (phased) | Opus 5.5 high | $14.18 | $2.32 | $0.84 | $3.16 | −77.7% | −83.6% |
| | GPT-6 Astra high | $8.69 | $1.62 | $0.74 | $2.35 | −72.9% | −81.4% |

Share of a ChatGPT Plus 5-hour window in Codex, and the main agent's own spend:

| Task | Model | 5-hour window, alone → handed over | Main agent |
|---|---|---|---|
| Task 1 · CLI tool | GPT-6.1 Sol high | 2.08% → 0.77% | −62.9% |
| | GPT-6 Astra high | 7.83% → 2.98% | −62.0% |
| Task 2 · Web app | GPT-6.1 Sol high | 5.08% → 0.79% | −84.5% |
| | GPT-6 Astra high | 22.43% → 2.94% | −86.9% |
| Task 3 · Kanban app (phased) | GPT-6.1 Sol high | 13.71% → 2.67% | −80.5% |
| | GPT-6 Astra high | 86.01% → 16.01% | −81.4% |

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/cost.svg" width="100%" alt="Cost per task in USD, working alone vs handed over, grouped by model. Opus 5.5 high: $1.07 vs $0.52, $2.13 vs $0.60, $14.18 vs $3.16. GPT-6 Astra high: $0.79 vs $0.42, $2.27 vs $0.42, $8.69 vs $2.35">
</p>

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/quota.svg" width="100%" alt="Share of a ChatGPT Plus 5-hour window in Codex, working alone vs handed over, grouped by model. GPT-6.1 Sol high: 2.08% vs 0.77%, 5.08% vs 0.79%, 13.71% vs 2.67%. GPT-6 Astra high: 7.83% vs 2.98%, 22.43% vs 2.94%, 86.01% vs 16.01%">
</p>

**A bigger task: a lighthouse animation.** The same 23-item request, byte for byte, both on GPT-6 Astra, dsh-baton 0.6.5:

| | Alone | Handed over |
|---|---|---|
| ChatGPT Plus 5-hour window | 178%–186% (over three 5-hour windows) | 80%–84% |
| Weekly quota | 30% | 14% |
| Codex requests | 142 | 40 |
| DeepSeek | — | $4.20 (peak price), 930 steps |

Working alone, Astra rated its own work 23/23; the independent check found 17/23. Handed over, the side that checks is not the side that wrote the code.

<details>
<summary>What was tested, and how</summary>

- **The only difference** in the hand-over runs is one line added at the end of the request: 交给 DeepSeek Harness 去做。 ("Hand it to DeepSeek Harness.")
- Same model and effort in both arms, and every run judged by the same acceptance check, which the model never sees.
- Tasks 1 and 2: the mean of three runs per cell. Task 3: one run per cell. Every run passed its acceptance check, with no rework.
- Prices are list prices. DeepSeek is counted at its peak price; the real DeepSeek bill came to about 58% of that.
- The 5-hour window share is worked out from each run's cost: 12.27 points per $1 for GPT-6.1 Sol, 9.90 for GPT-6 Astra.
- The Codex runs were measured with dsh-baton 0.6.1 to 0.6.3.

</details>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## How it works

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/architecture-dark.gif"><img src="./assets/readme/en/architecture.gif" width="100%" alt="MCP clients call dsh-baton-mcp over stdio; it reaches the dsh-baton-host plugin inside Harness through an owner-only local socket; the plugin drives Harness sessions live, with dsh headless as fallback"></picture>
</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/flow-dark.gif"><img src="./assets/readme/en/flow.gif" width="100%" alt="Typical flow: create a workspace, send the task, wait without polling (Claude Code is woken once, Codex waits up to 59 minutes in one dsh_wait call), follow up in the same session"></picture>
</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/comparison-dark.svg"><img src="./assets/readme/en/comparison.svg" width="100%" alt="Plugin mode (the default) vs the headless fallback, both dsh-baton: only plugin mode shows runs live in the Harness UI, continues desktop sessions and uses desktop agent presets; both reuse the desktop sign-in"></picture>
</p>

**Pick a model:** just say which one, for example "hand it to DeepSeek, V4 Pro". `dsh_send` passes it as `model` (and `reasoning_effort`), matched against the models Harness lists, so a model Harness adds later works as soon as it shows up. It applies to that session only; Harness's default model stays as it was. `dsh_list_models` shows what is available.

**Agent Teams:** ask for them, for example "hand it to DeepSeek with Agent Teams". `dsh_send` passes `team: true` and the session runs with Harness's Agent Teams on (Harness 0.2.2-rc.2 or later): the lead splits the work on a shared task board with its teammates, and the run comes back once they are done. `team: false` turns them off again.

**Answering Harness's questions:** the main agent answers the way the task needs, rather than picking the least bad option. See `dsh_answer` under [Tools](#tools).

**Several runs at once.** When a task is split across sessions, the main agent sends them all and waits for them together; whichever ends first comes back first, so it can review it and send a fix while the rest still run.

**Sessions with a Harness goal.** A session with a goal (set by a message starting with `/goal`) starts its next round by itself; dsh-baton waits until the goal stops before handing back, and can report progress at an interval you ask for.

<details>
<summary>Waiting in detail: each client, several runs, goals, changing the request</summary>

- **Claude Code** waits for a run in the background (the `wait_command` that `dsh_send` returns) and is woken once, when the run ends.
- **Codex** waits inside `dsh_wait`. The plugin sets Codex's tool timeout for dsh-baton to an hour (`tool_timeout_sec = 3600`), so one call waits up to 59 minutes: a run that ends within the hour costs one model request to wait for, however long it takes, and the result comes back as an ordinary tool result in the chat. A longer run returns `timed_out` with just the state after 59 minutes, and Codex calls again without summarising. Pressing Stop ends the wait at once. Codex gets no `wait_command`: its terminal cannot wake it, so it would poll. A conversation without that setting waits 270 s per call. Measured in the Codex desktop app: a 28-minute run took one `dsh_wait` call; a 62-minute run took two, the first returning `timed_out` after 59 minutes and the second getting the result 3 minutes later, with no `dsh_status` calls in between.
- **Several runs at once.** When a task is split across sessions (say docs, front end and back end, each in its own worktree), the client sends them all, then waits for them together: Claude Code runs one `wait_command` per run in the background, and Codex calls `dsh_wait` with `run_ids`. That call returns as soon as any of the runs ends or stops to ask a person, with every run that has (`ended`) and the ones still going (`still_running`); the client reviews those, sends fixes right away, and waits again with the rest plus the fixes. Measured on a three-part task: waiting for one run at a time, the back end that ended first was read 2 min 53 s late; waiting with `run_ids`, each result was read within a second of its run ending.
- **Sessions with a Harness goal.** A goal (a message starting with `/goal` sets one) makes Harness start the next round by itself as soon as a turn ends. A run sent to such a session is waited for until the goal stops, not just its first round, so "hand this to Harness" brings back the finished work; sessions without a goal are waited for as before. When the user asks for progress reports ("report every 10 minutes"), the client passes `until` `turn`: it then reports at the end of a round once 10 minutes (`every_minutes`) have passed since the last report, with every round since. To follow a session without sending anything, the client calls `dsh_wait` with `session_id` (Claude Code runs the `follow_command` in the background instead). Each report carries every round since the last one (the latest round's closing reply (up to 1500 characters), each earlier round as a one-line digest with its tools; any round in full through `dsh_read_session`), the files changed in the folder since the last report (since the run began, for the first), and the goal's state (phase, rounds started of the most allowed, whether Harness goes on with it), plus a `cursor` that the next call passes back, so switching between the two modes neither repeats nor misses a round. Both return at once when Harness asks a question (answer it with `dsh_answer` and `session_id`) or waits for an approval, when the goal is complete, paused, blocked or cleared, or when Harness will not go on with it by itself (for example after a Harness restart, until you press Continue). In Codex one call follows a goal for at most 15 minutes and Codex then calls again, so a message you type reaches it within that time; such an in-between return carries only the goal's state and how many rounds wait, not their texts.
- **Changing the request while it waits.** In Codex, send the change with **Steer**: Codex stops waiting at once, steers it into the same Harness session (`dsh_send` with `mode` `steer`) and waits on the new run; Harness does both in the same turn. Sent with **Queue**, Codex sees it only when the run ends; you can also press Stop first and then send it. In Claude Code, just send it: it waits in the background, so it steers the change in right away. A steered run ends together with the original and they share one result; a queued run comes back on its own. Runs working in the same folder at the same time are named in each other's results, so neither removes the other's files.

</details>

### How a hand-over is checked

You don't have to take DeepSeek's word for it. Before the run, dsh-baton notes what is in the folder. When the run ends it shows exactly which files were created, changed or deleted, and runs your project's own tests itself (`npm test`, or whatever the client passes as `checks`). A second, read-only DeepSeek agent then goes through the request point by point and ends with a table: requirement, met or not, and where (file:line). Claude or GPT reads just that, sends anything missing back in one message, and opens code only where a row says "not met". Unless `cwd` names another folder, the new Harness session starts in the folder you're already working in.

<p align="center">
  <img src="./docs/benchmarks/token-usage-2026-10/charts/evidence-chain.svg" width="100%" alt="Evidence chain of one real hand-over: the user asks, Codex writes the spec and checks, dsh-baton snapshots the folder, DeepSeek Harness writes 11 files, dsh-baton lists the changed files and runs npm test itself, Codex sends one fix back on its own, dsh-baton checks again, Codex accepts, and the benchmark's own test passes 13 of 13">
</p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Tools

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/tools-dark.svg"><img src="./assets/readme/en/tools.svg" width="100%" alt="Ten tools in the tool list: list workspaces, list sessions, read session, list models, send, status, wait, answer, cancel, call. Six less used tools are reached through dsh_call: create and rename workspace, session activity, rename session, update queued, list runs"></picture>
</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/states-dark.gif"><img src="./assets/readme/en/states.gif" width="100%" alt="Run states: queued, running, waiting, completed, failed, cancelled, and interrupted when Harness restarts mid-run. A busy session takes followup (queued) or steer (interjects) messages; left unset, your Harness setting decides"></picture>
</p>

When you want the exact parameters and return fields of each tool:

<details>
<summary>Full tool reference</summary>

The server's MCP instructions are a single sentence; how to hand over, wait and answer is in each tool's own description. Codex repeats the instructions in front of every tool's description, so the catalogue it shows the model is now about 9.7k characters instead of 24.3k.

| Tool | What it does |
|---|---|
| `dsh_list_workspaces` | Workspaces in the Harness sidebar |
| `dsh_create_workspace` | Through `dsh_call`. Register a folder as a workspace (creates the folder if missing); returns the existing one if already registered |
| `dsh_list_sessions` | Sessions newest first, with title, folder, running state and `model` (what its next request uses); filter by folder or text. Archived sessions are left out |
| `dsh_list_models` | The models Harness can run (provider, id, name, reasoning efforts) and its default model |
| `dsh_read_session` | Recent prompts and replies of one session (with tool names); `archived: true` for an archived session |
| `dsh_send` | Send a message: `session_id` continues that session; otherwise a new one starts in `cwd` or `workspace_id`, or, with neither, in the folder the conversation works in (a `cwd` that is not a workspace yet is registered first; a `cwd` outside the conversation's folder is allowed and noted in `folder_note`). `checks`: test commands dsh-baton runs itself when the run ends (see [How a hand-over is checked](#how-a-hand-over-is-checked)). Returns a `run_id` at once. In Harness the message is marked "Sent by Claude / ChatGPT from another chat". An archived session is refused: unarchive it in Harness, or start a new session. To a busy session, `mode` `followup` queues the message after the current turn and `steer` adds it to the running turn; left out, it does what Harness's own setting says (Settings → sending while busy: queue or steer), and `followup` when that cannot be read. `mode_source` says which applied. `model` only when the user names one ("DeepSeek-V4 Pro", "v4-pro"; `reasoning_effort` likewise): it is matched against Harness's own model list, ignoring case, spaces, hyphens and a leading DeepSeek, so a model Harness adds later (V4.1 Pro) works as soon as Harness lists it; a name that matches nothing or several fails the send, before anything is created, with the list (`provider/model` picks one). It is set on that session before the message goes in, and Harness's default model is put back as it was (Harness saves a session's pick as the default too). Left out, a continued session keeps its own model and a new one uses Harness's default. The reply says which in `model` and `model_source`. `team` (Harness 0.2.2-rc.2 or later): `true` turns Agent Teams on for the session before the message goes in, `false` turns them off; refused, with nothing sent, on an older Harness or on a sub-agent's session |
| `dsh_status` | Run progress: state, recent text and tool calls, final reply; `waiting_on` when the turn is over but sub-agents or jobs still run; `human_interjections` when someone typed in the Harness UI mid-run; state `interrupted` for a run cut short by a Harness restart; `model` the run was sent with. With `session_id` instead of `run_id`: what the session is doing, its Harness goal and its last turn's reply |
| `dsh_wait` | Wait for the run to end; a finished run carries `evidence` (files changed, check results) when the message was sent with `checks` (or until it stops to ask a person, see `dsh_answer`): up to 3540 s per call for Codex (its tool timeout for dsh-baton less 60 s; 270 s when that is not set), 50 s for other clients. Still going: returns `timed_out` with just the state; call it again. Clients that can wait in the background use `dsh_send`'s `wait_command` instead. `dsh_status` is a one-off look, not a way to wait. A run in a session with a Harness goal is waited for until the goal stops (`until` `turn` and `every_minutes` for progress reports). With `session_id` instead of `run_id` it follows the session's Harness goal without sending anything (`until`, `cursor`, `every_minutes`; see How each client waits). With `run_ids` it waits for several runs and returns as soon as any ends or asks (`ended`, `still_running`) |
| `dsh_answer` | Answer the questions a run stopped to ask (Harness's ask_user_question): per question, an option number or label, free text, or skip; on a single choice, free text replaces the option. `dsh_wait` and `wait_command` return as soon as a run asks, with the questions (`needs_input`, `question`; the option Harness's model would pick is in `harness_suggested`) and a layout for passing them on (`relay`, `question_tool`). When you let the main agent decide, it takes an option only if it fits as written, and otherwise answers in its own words; before it picks an option for you, the first call is held back and it writes the answer you would want without the options, sending the option only if the two agree. Otherwise it brings you the questions with its recommendation first, which may be an answer outside the options; pick that and only the answer itself is sent. You can also answer in the Harness window: whoever answers first wins |
| `dsh_session_activity` | Through `dsh_call`. What a session is doing now: running turn, sub-agents (any depth), background jobs; `archived: true` for an archived session |
| `dsh_update_queued` | Through `dsh_call`. Change a message still waiting in the queue of a busy session, by its `run_id`: `edit` its text, `remove` it, or `steer` it into the running turn now. Once it has reached the conversation it can no longer be changed |
| `dsh_cancel` | Stop everything a session is doing, by `run_id` or `session_id`: turn, sub-agents, jobs. Harness also drops the messages waiting in its queue; their runs end as `cancelled` |
| `dsh_rename_session` | Through `dsh_call`. Rename a session |
| `dsh_rename_workspace` | Through `dsh_call`. Rename a workspace (sidebar title only; the folder is not moved) |
| `dsh_list_runs` | Through `dsh_call`. Recent runs, optionally of one session |
| `dsh_call` | Calls any `dsh_*` tool by name: the less used tools (create and rename workspace, rename session, session activity, update queued, list runs) are not in the tool list, to keep every request short, and are reached this way; also for a conversation whose tool list predates an update. An unknown name lists the tools |

</details>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Command line and configuration

When you want to drive Harness from a terminal or a script instead of a chat:

<details>
<summary>CLI commands</summary>

```bash
dsh-baton workspaces
dsh-baton new-workspace ~/code/new-app --title "New App"
dsh-baton sessions --cwd ~/code/new-app
dsh-baton send --cwd ~/code/new-app "Scaffold the project"
dsh-baton send --session session-xxxx "Next: add tests"
dsh-baton send --session session-xxxx --mode steer "Interjection: don't change the API"
dsh-baton wait hrun-xxxx              # blocks, prints the final reply; exit 0 on success
dsh-baton status hrun-xxxx
dsh-baton follow session-xxxx --until turn --every 10m   # a session's Harness goal: blocks until the next report
dsh-baton activity session-xxxx       # running turn, sub-agents, background jobs
dsh-baton cancel --session session-xxxx
dsh-baton rename session-xxxx "New title"
dsh-baton rename-workspace ~/code/new-app "New name"
```

(From source, use `node src/cli.mjs …`.)

</details>

When the defaults don't fit, for example a different socket path or forcing headless mode:

<details>
<summary>Environment variables</summary>

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BATON_BACKEND` | `auto` | `auto`, `host` or `headless` |
| `DSH_BATON_HOME` | `~/.dsh-baton` | Socket and headless run records |
| `DSH_BATON_SOCKET` | `$DSH_BATON_HOME/host.sock` | Plugin socket path (must match on both sides); on Windows mapped to a per-user named pipe, see [WINDOWS.md](WINDOWS.md) |
| `DSH_BATON_WAIT_S` | Codex: its `tool_timeout_sec` for dsh-baton less 60 (3540 as the plugin sets it, else 270); others `50` | How long one `dsh_wait` call waits; keep it below the client's tool timeout |
| `DSH_BIN` | the `dsh` inside the macOS app, else `PATH` | Harness CLI for headless mode |
| `DSH_HOME` | `~/.dsh` | Harness data folder (headless session reads) |
| `DSH_BATON_ACCOUNT` | `1` | `0` uses the API-key route in headless mode |
| `DSH_BATON_PATCHES` | empty | Extra headless `--patch` overlays, `:`-separated |

</details>

When the Harness plugin is not reachable:

<details>
<summary>Headless fallback details</summary>

When the plugin is unreachable, the MCP server falls back to Harness's `dsh headless` command. It can only continue sessions it created itself (headless does not load agent presets such as `standard`), and new sessions do not appear in the desktop sidebar. By default [`patches/account.patch.yml`](patches/account.patch.yml) reuses the desktop app's DeepSeek account sign-in, so no API key is needed.

</details>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Install details

Version history is on [GitHub Releases](https://github.com/JialaoLiu/dsh-baton/releases). When you update or remove the plugin, come from dsh-bridge, run from source, or the plugin could not register:

<details>
<summary>What the plugin does, updating, removing, upgrading from dsh-bridge, installing from source, Windows</summary>

**What the plugin does when switched on.** It copies the MCP server to `~/.dsh-baton/app`, a folder that stays put, and writes the MCP entry into `~/.claude.json` and `~/.codex/config.toml` directly, keeping a `*.bak-dsh-baton` backup of each. It starts the server with your own Node.js ≥ 22.15 when it finds one on `PATH`; without one, with Harness's own runtime (the Harness app in Node mode, `ELECTRON_RUN_AS_NODE=1`), so nothing else has to be installed. Either way it works with only the desktop apps installed, when `claude` / `codex` are not on your `PATH`. It runs again on each Harness start: an entry that is already right, or a working one that starts another copy of dsh-baton, is left alone. In Harness, the source switches to the npm registry ("Official npm registry", 「npm 官方源」) by itself once you type the package name, and no restart is needed. To turn the registration off, set `DSH_BATON_AUTO_REGISTER=0` for Harness.

**Codex's tool timeout.** Codex stops an MCP tool call after 300 s unless the server's table sets `tool_timeout_sec`. The plugin writes `tool_timeout_sec = 3600` into `[mcp_servers.dsh-baton]` in `~/.codex/config.toml`, and adds it to an existing table that has none; a value you set yourself is kept. The server reads it and makes each `dsh_wait` that long less 60 s. Codex reads the setting when it starts or loads a conversation and keeps it: new conversations get it without restarting Codex, and so does every conversation after Codex restarts, while conversations open since before keep Codex's 300 s limit. dsh-baton tells them apart by when the conversation and the Codex process started (`~/.dsh-baton/codex-timeout.json` holds when the value was written) and keeps their waits at 270 s.

**Codex's cwd for dsh-baton.** Codex starts an MCP server in the conversation's folder unless its table sets `cwd`; when that folder is gone (a project on an external drive that is not connected) the server cannot start and the conversation has no `dsh_*` tools. The plugin writes `cwd` (your home folder) into `[mcp_servers.dsh-baton]` and adds it to an existing table that has none; a `cwd` you set yourself is kept.

**Updates need no restart.** When a newer version lands in `~/.dsh-baton/app` (a plugin update, `setup`, or a copy by hand), or the same version with changed files, conversations already open in Claude Code and Codex use it from their next `dsh_*` call: the server checks the folder before each call, starts the new version, and says once in that call's result that it was updated. A `dsh_wait` that is already running finishes on the old version first. If the new version cannot start, the old one keeps working and the result says why. A tool added in the new version shows up in Claude Code at once (the server tells the client its tool list changed); Codex keeps the tool list a conversation started with, so it does not show a new tool until the next conversation; it can still use one at once through `dsh_call`, which the update note points to, and the tools it already has run the new code right away.

**`npx -y dsh-baton-mcp setup`** does the same registration from a terminal: for a plugin that could not register, or when you come from an MCP directory. With the plugin already registered it changes nothing, then points you to the plugin if it is missing.

**Updating.** On Harness 0.2.2 and later: Plugins → dsh-baton-host → **Update to x.y.z** (更新到) under Version; if it still says up to date, press **Check again** (重新检查) first. Harness 0.2.1 has no update button for this plugin: **Uninstall**, then **Add plugin** → `dsh-baton-host`. For about a day after a release, Harness installs the previous version instead (pnpm's `minimumReleaseAge` holds back versions published very recently, and the install dialog says so); to get the new one at once, type the version: `dsh-baton-host@x.y.z`. A pre-release must always be added by its exact version, such as `dsh-baton-host@0.6.0-next.0`: Harness resolves `@next` to a broken placeholder. Plain `dsh-baton-host` gets the latest release. Switched on again, the plugin brings the MCP server to the same version; new conversations use it. If the two are ever out of step, the first tool call that notices it says so, naming the older side and the newer side's exact version to install.

**Removing.** Harness → Plugins → dsh-baton-host → **Uninstall**, then `npx -y dsh-baton-mcp setup --remove`. The plugin cannot tell an uninstall from Harness quitting, so it leaves the MCP entries to that command, which also deletes `~/.dsh-baton/app`; run records stay in `~/.dsh-baton` until you delete it.

**Upgrading from dsh-bridge.** In Harness, uninstall `dsh-bridge-host`, then add `dsh-baton-host`; switched on, it replaces the old `dsh-bridge` MCP entries. `DSH_BRIDGE_*` variables and an existing `~/.dsh-bridge` folder keep working for now. Tools get a new prefix (`mcp__dsh-baton__…`), so update any permission allowlists.

**From source** (to follow `main` or change the code): `git clone https://github.com/JialaoLiu/dsh-baton.git`, then in Harness add the plugin from the clone's `host` folder (Add plugin → paste the path). Switched on, it registers the clone itself, so changes run before they are published. Update with `git pull`. `node dsh-baton/src/cli.mjs setup` registers the clone from a terminal.

**Windows.** Same steps; [WINDOWS.md](WINDOWS.md) covers what differs (a named pipe instead of a socket file) and fixes for a Plugins page that cannot install or uninstall.

</details>

When you register by hand, or want dsh-baton in the Claude desktop chat app (not Claude Code):

<details>
<summary>Manual registration and the Claude desktop app</summary>

The plugin and `setup` write the same entries these commands would (with the absolute path of `node`, since desktop apps start MCP servers without your shell's `PATH`):

```bash
claude mcp add dsh-baton -s user -- "$(command -v node)" "$PWD/dsh-baton/src/server.mjs"
codex mcp add dsh-baton -- "$(command -v node)" "$PWD/dsh-baton/src/server.mjs"
```

`-s user` matters: without it, Claude Code registers the server for the current project folder only.

**Claude desktop app (optional)**: for the chat app's connectors (separate from Claude Code), add this to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart the app. It shows as a "Local dev" connector.

```json
{ "mcpServers": { "dsh-baton": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/dsh-baton/src/server.mjs"] } } }
```

</details>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## Security and limits

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/security-dark.svg"><img src="./assets/readme/en/security.svg" width="100%" alt="Owner-only channel (socket 0600 on macOS and Linux, per-user named pipe on Windows), no network port, Harness sandbox and approvals apply"></picture>
</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/limits-dark.svg"><img src="./assets/readme/en/limits.svg" width="100%" alt="Good to know: a message typed in the UI mid-run is flagged on the run as a human interjection, run records survive a Harness restart (cut-short runs show interrupted), Claude Code is woken once when a run ends, Codex waits up to 59 minutes in one call"></picture>
</p>

Any process running as your OS user can drive Harness through the socket, the same as running `dsh` directly. dsh-baton relies on Harness's internal service APIs (0.2.1 and 0.2.2 today), so a major Harness update may need a follow-up release.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/readme/en/divider-dark.svg"><img src="./assets/readme/en/divider.svg" width="100%" alt=""></picture></p>

## License

MIT
