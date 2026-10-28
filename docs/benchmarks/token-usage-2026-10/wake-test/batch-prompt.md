# Batch wake test (0.6.1 after 6bdd3b9)

Codex desktop, new conversation in the dsh-baton-test project (folder reset to 56163d4), model GPT-6 Luna · Medium. Pasted as is:

```
把下面三件小事交给 DeepSeek Harness 并行去做，每件开一个独立会话，各自只写自己的文件：
1. hello.txt：写一行"你好，雨夜"。
2. primes.mjs：导出一个函数，返回前 N 个素数；直接运行时打印前 50 个。再写 primes.test.mjs，用 node --test 测试。
3. story.md：写一篇约 1,500 字的中文短篇，讲雨夜里便利店的店员和一位常客，分 5 个小节，每节有小标题；写完自己通读一遍，改掉错别字。
三件都交回后再一起检查。然后给写 story.md 的那个会话发一条具体的修改意见（把结尾改成开放式），等它改完交回后，再给我一个简短总结。
```

What to check in the rollout and `~/.dsh-baton/codex-hook/`:
1. After the three `dsh_send` calls the turn ends; no `dsh_wait`, no polling.
2. One wake only, after the last of the three runs ends (story.md takes longest), carrying all three results; hello.txt finishing first does not wake Codex.
3. In that woken turn the rework `dsh_send` (to the existing story session) gets "End your turn now", and the turn ends.
4. A second wake when the rework ends; then the summary.

## Result (2026-10-27, GPT-6 Luna · Medium, main at 6bdd3b9): all four pass

| Time (UTC) | What |
|---|---|
| 01:23:04 | three `dsh_send` in one cell; reply "End your turn now"; turn ends after one short reply (01:23:07) |
| 01:23:16 / 01:24:39 / 01:25:46 | the three runs end (hello.txt first, story.md last); no request in between |
| 01:25:46 | one wake: "3 Harness runs you handed over with dsh_send have come back", all three results |
| 01:25:54 | rework `dsh_send` to the story session in the woken turn; reply "End your turn now"; turn ends (01:25:56) |
| 01:27:23 | second wake with the rework's result; summary; task_complete 01:27:29 |

No `dsh_wait` call at all. 9 model requests: 385,960 input (334,464 cached), 1,537 output.

## Windows (2026-10-28, GPT-6 Luna · Medium, b24801a, hook trusted): all four pass

Codex desktop on Windows, new conversation in an empty folder, same prompt. 06:12:12 → 06:14:55 UTC (2 min 43 s). As reported by the Windows test session from its rollout:

- First tool cell: three `dsh_send` in parallel (the primes session with `checks: node --test primes.test.mjs`); the turn ends.
- First wake: "3 Harness runs … have come back", all three results.
- Review found hello.txt written as 「你好，雨夜。」 (an extra full stop). In one cell Codex sent two follow-ups in parallel: a fix to the hello session and the open-ending rework to the story session; the turn ends.
- Second wake: "2 Harness runs …"; final check, summary, task_complete.
- 5 `dsh_send` (3 new, 2 follow-ups), no `dsh_wait`, no `dsh_answer`.
- Output: hello.txt 15 bytes, no full stop; `node --test` 13/13; story.md 5 sections, 1,552 Chinese characters, open ending.
- 9 model requests: 433,362 input (376,832 cached), 2,659 output (761 reasoning). About 47k more input than the Mac run, mostly the extra hello fix, plus Windows' larger AGENTS.md and memory.
