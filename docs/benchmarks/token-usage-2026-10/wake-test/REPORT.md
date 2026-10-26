# Can Codex wake the model when a background job ends? (2026-10-26)

Codex CLI 0.164.0-alpha.11.1 (the engine inside the desktop app), model `gpt-6-luna`, `model_reasoning_effort=medium`, `mcp_servers.dsh-baton.enabled=false`, all settings passed with `-c`, `~/.codex/config.toml` untouched, desktop app not used. Plus 5-hour quota: 56% before and 56% after all runs (secondary 9%).

## Short answer

Codex has no "background job ended, wake the model" event. Background terminals, the `sleep` tool and MCP notifications do not wake it. The one thing that works is a **Stop hook**: the model ends its turn, Codex runs the hook, the hook blocks for free until the job ends and returns `{"decision":"block","reason":"..."}`, and Codex feeds `reason` back to the model as a new prompt in the same turn. The wait costs no model requests (417 s in C2, no limit hit); the wake costs one request on the cached context.

| Idea | Wakes the model? | Cost of one wake | Notes |
|---|---|---|---|
| 1. Unified exec + long `write_stdin` | No (no wake on exit), but one long wait is 1 request | 1 request | `write_stdin` is clamped by `background_terminal_max_timeout` (default 300000 ms). In code mode the cell also yields after 30 s unless the script starts with `// @exec: {"yield_time_ms": N}` |
| 1b. Turn ends while terminal runs | No | – | Terminal keeps running; app-server sends the client `item/completed` when it exits; no new turn. `codex exec` exits at turn end |
| 2. `sleep` tool | Only on `turn/steer` | 1 request | On by default (`sleep {duration_ms}`). Terminal exit and MCP notifications do not end it early |
| 3. MCP notifications | No | – | `notifications/progress` and `notifications/message` during a call, and unsolicited ones after it, are dropped: not shown to the model, not even forwarded to the app-server client |
| 4a. **Stop hook** | **Yes** | **1 request** (about 22k input, almost all cached, at this test's context size) | Needs the hook to be trusted. While it waits the thread shows as running and user messages queue. Stop/interrupt kills the hook |
| 4b. app-server `turn/start` / `turn/steer` / `thread/inject_items` | Only from the client that owns the app-server | 1 request | The desktop app owns its app-server over stdio; no outside socket (`app-server-control.sock` absent) |

## 1. Unified exec background terminals

Scripts: `run_a.sh` (A1/A2), `run_a_codemode.sh` (A3/A4). Raw: `raw/A*.txt`.

gpt-6 models run tools in **code mode** here (the desktop default): the model writes a JS cell (`exec`) and calls `tools.exec_command` / `tools.write_stdin` from it. Two separate limits apply:

- **Code-mode cell yield.** With no pragma, a cell yields after 30 s and the model resumes it with `wait {cell_id, yield_time_ms: 30000}`: one model request every 31 s, about 22k input tokens each (A1/A2: 5 polls in 2.5 min, then stopped). The pragma `// @exec: {"yield_time_ms": 3600000}` was accepted: the cell did not yield during a 330 s wait.
- **`write_stdin` yield.** Clamped to `background_terminal_max_timeout`, default `300000` ms.
  - A3 (default): `write_stdin(yield_time_ms: 3600000)` returned after **300.0 s** with the process still running; a second script was needed (3 requests in all).
  - A4 (`-c background_terminal_max_timeout=3600000`): one `write_stdin` waited **328.9 s** and returned `DONE`, exit 0. The whole job took **2 requests** (start + wait, then the final reply).

  | Run | Requests | Input / cached per request |
  |---|---|---|
  | A3 | 3 | 22066/20864, 22241/21888, 22375/22016 |
  | A4 | 2 | 22066/12544, 22272/12544 |

So the largest accepted yield is whatever `background_terminal_max_timeout` allows (3,600,000 ms tested), and one long wait costs one request. This is a long blocking wait, not a wake: the model still issues the wait call and keeps the turn open. It is the same thing as the long MCP call tested separately.

**Turn ends with the terminal still running** (B1 phase `idle`): the model started `sleep 45; echo BG1_DONE` and replied `started`. The terminal kept running after `turn/completed`. At +48.8 s the app-server sent the client `item/commandExecution/outputDelta` ("BG1_DONE") and `item/completed` (commandExecution, exited). **No new turn started** in an 80 s watch. A client could react to that `item/completed` with `turn/start`, but the desktop app does not. `codex exec` exits when its turn completes, so nothing is left to wake there.

## 2. The `sleep` tool

`sleep_tool` is already `stable true` in `codex features list`. The model sees `sleep {duration_ms}` (range-checked; 300000 accepted). Config tables exist (`features.sleep_tool`: `mode` = `model_driven` | `always_on`; `features.current_time_reminder`: `reminder_interval_seconds`, `clock_source`, `delivery_mode`), but they do not change what ends a sleep.

All three in B1 (`appserver_test.py`, one app-server, one thread):

| What happened during the sleep | Result |
|---|---|
| `sleepbg`: background terminal `sleep 30` exited | No effect; full 120 s ("Sleep completed") |
| `sleepmcp`: MCP server sent `notifications/message`, `resources/updated`, `tools/list_changed` at +20 s | No effect; full 90 s |
| `steer`: client sent `turn/steer` at +45 s | **Ended early** at 43.4 s ("Sleep interrupted by new input."); the model answered in 1 request (in 31120, cached 30848, out 6) |

"New input" means user input steered into the active turn, which only the client connected to that app-server can send. dsh-baton cannot: the desktop app owns its app-server over stdio; `codex app-server proxy` needs `~/.codex/app-server-control/app-server-control.sock`, which does not exist; `~/.codex/ipc/ipc.sock` belongs to the desktop app and was not touched.

## 3. MCP server-to-client notifications

Server: `wake_mcp.py`. Raw: `raw/B1-mcp.jsonl`, `raw/B2-mcp.jsonl`.

- **During a call** (B2 `mcpprog`, `slow_job(40)`): Codex sent `progressToken: 1`; the server sent 8 `notifications/progress` and 8 `notifications/message`. The app-server emitted **no** `item/mcpToolCall/progress`; the model reported none. (From code mode the model wrapped this 40 s call in `@exec yield_time_ms 10000` then `wait 30000`, 2 extra requests: the MCP route needs the long pragma too.)
- **Unsolicited, no call open** (B1 `sleepmcp`, `idlemcp`): no client event, no `tools/list` refresh, no turn, in a 60 s watch.

Useful: every `tools/call` carries `_meta.threadId` (and `x-codex-turn-metadata.thread_id`), the Codex thread id. The Stop hook gets the same id as `session_id`.

## 4. Other ways in

### 4a. Stop hook (works)

Scripts: `stop_hook.sh`, `run_c_stophook.sh`, `appserver_test.py` phases `stophook*`. Raw: `raw/C*.txt`, `raw/B2*`, `raw/B3*`, `raw/stop-hook.log`.

Config, as a session flag for the tests:

    -c 'hooks.Stop=[{hooks=[{type="command",command="/abs/stop_hook.sh",timeout=3600}]}]'

In `config.toml`:

    [[hooks.Stop]]
    [[hooks.Stop.hooks]]
    type = "command"
    command = "/abs/stop_hook.sh"
    timeout = 3600

- Stdin JSON: `session_id` (= thread id), `turn_id`, `cwd`, `transcript_path`, `stop_hook_active`, `last_assistant_message`.
- With a job pending it blocks until the job ends, then prints `{"decision":"block","reason":"Background job finished: …"}`. Codex appends `<hook_prompt …>reason</hook_prompt>` as a user message and samples again in the same turn. On that continuation's own Stop, `stop_hook_active` is `true` and the hook exits 0.

| Run | Wait | Requests during wait | Wake request (in / cached / out) |
|---|---|---|---|
| C1, `codex exec`, 60 s job | about 9 s after the reply | 0 | 21979 / 21760 / 30 |
| C2, `codex exec`, 420 s job, `timeout=3600` | **417 s** | **0** | 21929 / 12544 / 37 |
| B2 `stophook`, app-server | 56 s | 0 | 22433 / 12544 / 13 |

- In every case the hand-over is 2 requests: the reply that ends the turn, plus the wake. No hook timeout cap was found or hit at 417 s.
- B2 `stophooksteer`: a `turn/steer` 25 s into the wait was accepted but **held until the hook returned**; the model then got both in 1 request.
- B3 `stophookinterrupt`: `turn/interrupt` ended the turn at once and **killed the hook**; the result was never delivered and no new turn started in 60 s.
- The app-server shows its client `hook/started` and `hook/completed`; the thread stays `active` while the hook waits, so the app shows it as running.
- **Trust.** Hooks run only when trusted; a new hook is `untrusted` (app-server `hooks/list`). Tests used `codex exec --dangerously-bypass-hook-trust` and app-server `thread/start` with `config: {"bypass_hook_trust": true}`. The persisted form works in a scratch `CODEX_HOME`:

      [hooks.state."<abs path of config.toml>:stop:<group>:<index>"]
      trusted_hash = "sha256:<currentHash from hooks/list>"

  The hash covers the hook definition (changing command or timeout makes it `modified`). Passing that table with `-c` did **not** trust a session-flag hook.

Not verified: the desktop app UI itself. It runs the same app-server and loads `~/.codex/config.toml` hooks (`hooks` feature `stable true`); one real desktop run is still needed to confirm the hook fires there and to see how a waiting turn looks.

### 4b. Other leads

- app-server client methods `turn/start`, `turn/steer`, `thread/inject_items`, `thread/queue/add` + `thread/queue/start`, `TurnStartParams.toolOutput`: only for the client that owns the app-server.
- Features under development `wake_on_agent_messages`, `send_message_to_user_async`, `agent_message_board`: sub-agent related, not tested.
- Multi-agent `wait`: waits for a sub-agent mailbox update and ends early on steered input; a sub-agent polling `dsh_wait` makes each poll cheaper but still costs requests.
- `features.current_time_reminder.clock_source` = external: a clock source only.

## How dsh-baton could use the Stop hook (no code changed)

1. `dsh_send` stores `{thread_id → run_id, delivered: false}` (thread id from `req.params._meta.threadId`).
2. A hook command such as `dsh-baton codex-stop-hook`, installed as a Codex Stop hook with a timeout of a few hours:
   - no undelivered run for `session_id` → `exit 0` at once (it runs at the end of every Codex turn);
   - otherwise wait for free until the run ends or needs input, then print `{"decision":"block","reason": <what dsh_wait returns now>}` and mark it delivered;
   - with `stop_hook_active: true`, block again only if another run is still undelivered, so it cannot loop.
3. On Codex with the hook installed, the `dsh_send` hint becomes "end your turn now with a one-line note; this conversation continues when the run ends; do not call dsh_wait". Without the hook, keep `dsh_wait`.
4. Install: writing the hook into `~/.codex/config.toml` changes the user's config, so ask first; the user trusts it once in the app's hooks screen, or the installer writes the `hooks.state` entry from `hooks/list` (`hooks_probe.py`). Never the bypass flag.
5. Edge cases: user messages queue while the hook waits; Stop kills the hook, so the next `dsh_*` call or turn should report the finished run; a Harness `needs_input` ends the wait at once.

Expected saving on the measured 48-min Astra hand-over: 11 `dsh_wait` returns (about $0.49, about 5% of the 5-hour quota) become 1 wake on the same cached context (about $0.045, roughly 0.5%).

Fallback without a hook: one long wait in a single request (long MCP call with `tool_timeout_sec=3600`, or `background_terminal_max_timeout=3600000` + `write_stdin`), with a long `@exec yield_time_ms` pragma on the code-mode cell. Both need a config change and keep the turn open.

## Files

- `run_a.sh`, `run_a_codemode.sh`: idea 1 via `codex exec`
- `appserver_test.py`: stdio JSON-RPC driver (phases `idle`, `sleepbg`, `sleepmcp`, `steer`, `mcpprog`, `idlemcp`, `stophook`, `stophooksteer`, `stophookinterrupt`)
- `wake_mcp.py`: test MCP server (progress/log during a call, unsolicited notifications after it)
- `stop_hook.sh`, `run_c_stophook.sh`: the Stop-hook wake
- `hooks_probe.py`: lists discovered hooks and their trust (no model calls)
- `rollout_summary.py`: tool calls and per-request token use from a rollout
- `raw/`: per-run rollout summaries, driver logs, MCP traffic, hook log

Run notes: A1/A2 stopped by PID after 5 polls each. B1 `mcpprog` hit "Selected model is at capacity" and was re-run in B2. In B2 the test hook re-delivered a stale `job.done` at the end of `mcpprog` (test artefact; a real hook must mark results delivered).
