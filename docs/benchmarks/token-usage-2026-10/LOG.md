# Experiment log: cutting the client's token use (natural-language round)

Live notes, newest last. Times are local (Australia).

## Setup (2026-10-25 evening)
- Request style: plain-language task requests (`natural/medium.md`, `natural/large.md`), the way a user talks; the client has to turn them into a spec itself. Arm B adds only `交给 DeepSeek Harness 去做。`
- Checks: behaviour, not exact output (`checks/natural-*.mjs`); validated on earlier runs (pass) and on an unrelated project (fail).
- Methods, all arm B, same request:
  - `n059`: dsh-baton 0.5.9 as installed (baseline), plus arm A (client alone).
  - `nevidence`: worktree `exp/evidence` (d0e05f7): dsh_send takes `checks`; when the run ends dsh-baton itself reports files created/changed/deleted since the send and runs the checks; tool list 16.8k → 8.3k chars (9 listed, the rest through dsh_call); finished results without the event log; status tail 5.
  - `ncourier`: worktree `exp/courier` (4fb5b76) = evidence + a `dsh-courier` sub-agent (Codex: gpt-6-luna low, from `~/.codex/agents/` for the runs only; Claude Code: Haiku via `--agents`). The request does not name the courier: the instructions say to use it when available.
- Models as before: Codex gpt-6.1-sol high, Claude Code Opus 5.5 high. Codex Plus 5-hour window at start: 48% used.
- Budget: one run per cell first; a second run only for cells that look decisive.

## Runs

### 2026-10-25 20:45–23:29: one run per cell, both clients side by side (16 runs, all accepted)

Cost per accepted task at list price. "Client" is GPT (Codex) or Claude (Claude Code); DeepSeek is deepseek-flash at peak price. Codex quota is the rise in the Plus 5-hour window during the run.

Codex (gpt-6.1-sol high)

| Method | Medium: client + DeepSeek = total | Large: client + DeepSeek = total | Quota (M / L) | Reworks (M / L) | Harness requests (M / L) |
|---|---|---|---|---|---|
| A, alone | $0.162 + 0 = $0.162 | $0.699 + 0 = $0.699 | 2% / 9% | 0 / 1 | – |
| n059 | $0.202 + $0.271 = $0.473 | $0.356 + $0.449 = $0.805 | 2% / 5% | 1 / 2 | 83 / 122 |
| nevidence | **$0.084** + $0.116 = **$0.200** | **$0.146** + $0.230 = **$0.376** | **1% / 2%** | 0 / 1 | 52 / 54 |
| ncourier | $0.255* + $0.137 = $0.392 | $1.021* + $0.323 = $1.344 | 1% / 7% | 0 / 1 | 35 / 90 |

\* Sol main thread plus the gpt-6-luna courier thread priced at Sol rates (upper bound; separate rollouts 01a17303-d339 and 01a1730c-1615). In the large run the main thread called `sleep` 65 times and `send_message` 16 times while the courier worked: 3.25M input tokens (98% cached) on the main thread alone.

Claude Code (Opus 5.5 high; cost from `total_cost_usd`, which includes the Haiku courier)

| Method | Medium total | Large total | Reworks (M / L) |
|---|---|---|---|
| A, alone | $1.088 | $4.804 | 0 / 1 |
| n059 | $0.368 + $0.097 = **$0.465** | $1.181 + $0.258 = **$1.439** | 0 / 1 |
| nevidence | $0.548 + $0.147 = $0.695 | $2.491 + $0.433 = $2.924 | 0 / 2 |
| ncourier | $0.420 + $0.109 = $0.529 | $1.447 + $0.428 = $1.875 | 0 / 2 |

Notes
- Every large rework (all 8 large runs, both clients, all methods) came from the check, not from unfinished work: it posts `due` and, on failure, `text`, and every build rejected unknown field names with 400 (the request only says "截止日期"). The message showed the fallback's error, so some clients fixed `text` first and needed a second round for `due`. Same for everyone, but it adds one or two rounds to every large cell. See bug 7.
- The one medium rework (Codex n059) was real: the help text did not mention priority, due date or tags.
- In this round no client sent work back on its own; every extra dsh_send was a rework the check asked for. So evidence did not catch an unfinished task here. Its saving for Codex came from fewer, smaller waits (dsh_wait 4 and 3 calls vs 6 and 8 in n059) and no folder reading.
- Codex window: 48% used at start, 77% at end (29 points for 8 Codex runs).
- `~/.codex/agents/dsh-courier.toml` was removed after the courier runs.

### 2026-10-25 23:45: check fixed (bug 7), Codex large re-run
- `checks/natural-large.mjs` now creates the task with the title only (`title`, then `text`, then `name`), marks it done through the boolean field the server returned, and reports every attempt when a step fails.
- Re-checked: all 8 natural large builds and the 4 spec-round large builds pass 13/13; the medium CLI project still fails (no page, no server).
- Medium check reviewed: it uses only the names the request gives (tasks.mjs, add/list/done/rm, TASKS_FILE); `stats` and `export` are guesses with fallbacks and matched all 8 builds. Spec-round checks test names the spec itself fixed.
- Re-run (rep 2, after the 5-hour window reset at 23:53): Codex large A, n059 B, nevidence B.

### 2026-10-26 00:15–00:27: can dsh-baton wake a Codex conversation when the run ends?
- Thread ID: yes. Every Codex `tools/call` carries `_meta["x-codex-turn-metadata"].thread_id` (also `turn_id`, `model`, `turn_trigger`), checked with a logging MCP server under `codex exec`.
- The official DSH sub-agent plugins (`@deepseek-ai/dsh-subagent-codex`, `-claude-code`, 0.0.1-rc.1) go the other way: DeepSeek is the main agent and starts a one-shot, ephemeral Codex (`codex app-server --stdio`) or Claude Code (Agent SDK) task and waits for its final answer. Nothing there wakes another conversation.
- Codex desktop app, test conversation in project ICT (gpt-6-luna): `codex exec resume <id>` from outside is refused while the app has the conversation open: "thread ... already has an active writer". The app's app-server talks to the app over stdio only; no control socket.
- The app's link `codex://threads/<id>?prompt=<text>` opens that conversation with the text filled in, but does not send it; a person (or a click) has to press send. Tested and cleared without sending.
- `codex exec` conversations (no app holding them) can be resumed from outside; the benchmark's rework messages already do this.

### 2026-10-26 00:00–00:37: Codex large re-run with the fixed check (rep 2, fresh 5-hour window)
| Method | GPT cost | DeepSeek | Window | Reworks asked by the check | dsh calls |
|---|---|---|---|---|---|
| A, alone | $0.231 | – | 3% | 0 | – |
| n059 | $0.108 | $0.242 | 1% | 0 | send 1, wait 3 |
| nevidence | $0.126 | $0.224 | 1% | 0 | send 2, wait 4 |
With the check fixed, the hand-over costs about half of working alone on the large task (A $0.231 → B $0.108–0.126). Rep 1 numbers were inflated by bug 7. In nevidence rep 2 the checks all passed, and Codex still sent one fix back on its own: a wrong /api/stats example in the README. Review was kept.

### 2026-10-26 00:40: DeepSeek price check, lean build, three-run batches started
- DeepSeek bill for 2026-10-25 (Harness key, dashboard): $3.92, 2,437 requests, 283.7M tokens (includes other Harness use that day). Our runs dated 2026-10-25 UTC: 1,529 requests, 200.9M tokens, $5.04 at the peak price we use. The published deepseek-flash price (CNY per million: hit 0.04 / miss 2 / output 8 at peak, half off-peak) matches ours after conversion (about $0.0056 / $0.28 / $1.13), so the per-token prices are right; our DeepSeek dollars are an upper bound, and the real bill ran at roughly 0.55–0.6 of it (off-peak hours).
- `nlean`: worktree `exp/evidence-lean` (e83cd20) = evidence + wording only: checks are the project's own test commands, ask Harness to write tests per requirement, do not write check scripts or reproduce failures yourself; with all checks passed, read code only for requirements no check covers.
- Batches (background): Claude Code nlean B ×3, n059 B reps 2–4, n059 A reps 2–3 (medium and large); Codex n059 A/B medium reps 2–3 and large reps 3–4, nevidence B the same.
- Evidence chain diagram from Codex nevidence large rep 2: `charts/evidence-chain.zh.png` (`evidence-chain.mjs`).
- 00:58: Claude Code switched to parallel runs (5 at once: nlean chain, n059 B medium, n059 B large, n059 A medium, n059 A large). Cost per run is read from each run's own transcript, Harness session and folder, so running side by side does not mix them. Codex stays one run at a time, because the Plus 5-hour window is one number for the whole account and parallel Codex runs would share it.
- 01:05: everything switched to parallel to finish tonight. Claude nlean reps 2–4 (medium and large, 6 at once; the half-done nlean medium rep 1 was stopped and is not counted). Codex: n059 A/B large reps 3–4, nevidence large reps 3–4 and medium reps 2–3, all at once, next to the still-running serial n059 medium reps 2–3. The 5-hour window is shared by parallel Codex runs, so for these runs the window share is estimated from GPT cost with the ratio measured on the serial runs (about $0.08 per 1%), as the user agreed.

### 2026-10-26 02:33–03:05: gap-fill batch stopped (not counted)
- Started to fill Codex lean and Claude evidence cells. The DeepSeek account ran out of balance during the batch, so these runs are marked `valid: false` (`invalid_reason` in the rows) and left out of every chart; the last two were stopped.
- The 0.6.0 (review table) runs had finished before (all 12 by 02:30) and are unaffected.
- Charts: one combined chart (`charts/natural-combined[.zh]`) compares working alone with 0.6.0 for Claude Code, Codex (Sol) and Codex priced as Astra, with the model named under each pair. The Codex desktop run was not done.

### 2026-10-26 02:57–03:20: Codex with GPT-6 Astra (high), medium task, one run each, run one after the other
| | GPT tokens in / cached / out | Astra list price | DeepSeek | 5-hour window |
|---|---|---|---|---|
| Alone | 163,329 / 152,320 / 10,562 | $0.79 | – | 61% → 68% (7%) |
| Handed over (0.6.0-next.0) | 202,236 / 181,632 / 1,318 | $0.45 | $0.19 | 69% → 72% (3%) |
- Both passed the first time. The earlier estimate (Sol tokens at Astra prices) was $0.93 alone and $0.54 handed over: Astra used slightly fewer tokens than Sol, so the estimate ran about 15% high; the savings were close (−43% measured vs −41%).
- About $0.11–0.15 of Astra per 1% of the Plus window, close to Sol's $0.10: the window tracks list price. The estimated Astra charts are removed; the combined chart shows these measured runs.

### 2026-10-26 03:24–03:37: Codex with GPT-6 Astra, large task
- Alone: passed first time; 1,062,294 GPT input tokens (1,031,552 cached), 18,540 output; $2.27 at Astra list price; 5-hour window 73% → 95% (22%).
- Handed over: stopped at 99% of the window, before the run ended, so it would not hit the limit; its Harness run was cancelled. Not counted. To rerun after the window resets (04:54 local).

### 2026-10-26 04:40: Windows verification of 0.6.0-next.0 passed
- Install by exact version (`dsh-baton-host@0.6.0-next.0`; `@next` resolves to a broken 0.0.0-stage tarball in Harness). Session created in the conversation's folder; evidence block present (13 files created, npm test 64/64, source "dsh-baton, not the Harness model"); Harness's final reply ended with a sub-agent requirement table, and the audit found and fixed a prototype-key validation bug with regression tests. Only odd thing: Harness left its own todo list showing in progress after the run ended (UI state).

### 2026-10-26 04:56–05:15: Astra large, handed over (0.6.0), rerun after the window reset
- Passed the first time. GPT input 231,829 (210,304 cached), output 1,106: $0.48 at Astra list price; DeepSeek $0.30; total $0.78. Window 0% → 4%.
- Against Astra alone on the same task ($2.27, 22%): client −79%, total −66%, window −82%.

### Why the Astra medium hand-over saved less (run 1, 7 requests)
- Request 1: Codex filtered its tool catalogue (`ALL_TOOLS`) for "deepseek|harness" and printed it: 22.7k characters, about 9.4k new input tokens. Every dsh-baton tool entry in that catalogue repeats the server instructions, so the instructions are paid for once per tool (bug 2, still open).
- Request 2: writing the spec and sending it, 5.5k new tokens. Requests 3–6: four waits, under 300 new tokens each. Request 7: the finished result (final text with the review table, plus evidence), 9.5k characters, 4.1k new tokens.
- So about half of the hand-over's new input is the catalogue read, which is the same for a medium or a large task. Shortening the server instructions (they are repeated per tool in Codex) is the next cut, for 0.6.1.

### 2026-10-26 05:15–05:40: Astra medium hand-over, run 2
- Passed the first time; $0.67 at Astra list price (run 1: $0.45), DeepSeek $0.17, window 5% → 9% (4%).
- Why dearer than run 1: six waits instead of four, and after one 270 s wait the provider's prompt cache had dropped most of the conversation (16k new input tokens on that request instead of a few hundred). The catalogue read at the start was again about 9.4k new tokens.
- Astra medium hand-over, mean of 2: $0.56 client (−29% vs alone), $0.75 with DeepSeek (−6%), 3.5% of the window (alone 7%). Astra large: $0.48 client (−79%), $0.78 total (−65%), 4% vs 22%. README table and combined chart (now three panels: Claude, Sol, Astra) updated.
