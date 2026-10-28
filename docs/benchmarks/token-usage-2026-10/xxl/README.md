# Tsumiki: the three-phase large task

Replaces the rainy street-corner diorama as the large task. The diorama could not be checked by tests,
so working alone stopped at a small version that it judged good enough (843 lines). Tsumiki is a
kanban web app (Node built-ins only, vanilla front end) built in three phases in one project, and
each phase has fixed acceptance tests written before the run. Both groups get the same bar.

- `seed/docs/phase{1,2,3}.md`: the spec for each phase, in the workspace's `docs/`.
- `seed/tests/acceptance/`: acceptance tests (API and headless-Chrome UI) for each phase.
- `seed/package.json`: `npm test` runs every `tests/**/*.test.mjs`.
- `check.mjs <workspace> <phase> [out.json]`: copies the workspace, puts back the original acceptance tests for phases 1..N, runs them file by file and prints pass, counts and failing test names.

The tests were checked against a reference build made in a separate scratch folder (not shown to either group).

## Protocol

Workspace: `dsh-baton-test`, reset to a seed commit on top of `56163d4` with package.json, all three specs and all acceptance tests. Codex desktop, GPT-6 Astra high, one chat per group. The alone group runs with the dsh-baton MCP server disabled in `~/.codex/config.toml` (`enabled = false`), the hand-over group with it on and the Stop hook trusted. Groups run one after the other so the 5-hour window can be read for each.

All three phases go in one message (the user's call, 2026-10-29): the workspace starts with all three specs and all acceptance tests.

- Message, identical for both groups: `按 docs/phase1.md、docs/phase2.md、docs/phase3.md 把三个阶段都做完。验收测试在 tests/acceptance/，不能修改；npm test 全部通过才算完成。`
- Hand-over group: the same message plus `交给 DeepSeek Harness 去做。`
- After the turn ends, `check.mjs <workspace> 3`. If it fails, at most two fix rounds: `外部验收没通过，下面这些测试失败：<failing test names, one per line>。修到 npm test 全部通过。`

A first alone try (2026-10-29 00:00, phase 1 only, before the one-message decision) is kept as a data point: 8 min 52 s, $1.78, window 29 → 47 (18 points), check 20/20, about 800 lines. Evidence in /Volumes/LJL4T/dshb-bench-evidence/xxl-alone-phase1-only-2026-10-29.

Recorded per group: start and end time, check result, fix rounds, Codex rollout tokens and cost, DeepSeek usage from the Harness sessions, 5-hour window before and after (from `window.mjs`), lines of code.
