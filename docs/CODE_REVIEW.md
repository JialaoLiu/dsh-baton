# Code review — dsh-bridge 0.2.0

Method: open-code-review in delegate mode (`ocr delegate preview` / `ocr delegate rule` chose the files and the rule set; the review itself was done by hand). Reviewed on a temporary Git copy, 2026-10-18.

**Coverage:** 14/14 reviewable files reviewed (100%). Excluded by OCR: the three README files.

## High

1. **`host/lib/index.js:364-367` [security]** ✅ **Fixed** — On startup the plugin runs `chmod 0700` on the socket's parent directory and `unlink`s whatever is at the socket path. With the default `~/.dsh-bridge/host.sock` this is fine, but `DSH_BRIDGE_SOCKET` can point anywhere: pointing it at `/tmp/x.sock` would try to `chmod 0700 /tmp`, and a mistyped path would delete a regular file. It also silently takes the socket over from another running host (for example `dsh web` next to the desktop app), leaving the first one unreachable.
   > Fix: only `chmod` a directory the plugin created itself (or the default bridge home); `lstat` the path and unlink only if it is a socket; try to connect first and refuse to start if another host answers.

## Medium

2. **`host/lib/index.js:265-266` [bug]** ✅ **Fixed** — When more than `MAX_RUNS` (100) runs exist, the oldest is evicted even if it is still active. Its `wait` callers then hang until timeout and `status` reports "Unknown run".
   > Fix: evict the oldest *finished* run; keep active ones.

3. **`src/core.mjs:57-66` [bug]** ✅ **Fixed** — `hostCall` parses the reply inside the socket `data` handler; a malformed reply throws there and crashes the MCP server process instead of rejecting. If the host closes the connection without a newline, the call only ends at the timeout (never, with `timeoutMs: 0`).
   > Fix: wrap `JSON.parse` in try/catch and reject; also reject on `close`/`end` when no reply arrived.

4. **`host/lib/index.js:386` [security/robustness]** ✅ **Fixed** — `methods[req.method]` also resolves inherited names such as `constructor`, `toString` or `hasOwnProperty`, so those are callable over the socket.
   > Fix: `Object.hasOwn(methods, req.method)` (or a `Map`).

5. **`host/lib/index.js:286-298` [performance]** ✅ **Fixed** — `wait` never clears its timer and never removes its resolver from the waiter set when it times out. Repeated short waits on a long run pile up resolvers and timers until the run ends.
   > Fix: keep the timer handle, clear it on settle, delete the resolver on timeout.

6. **`host/lib/index.js:201, 210, 339` [bug]** ✅ **Fixed** — Paths are handled three different ways: `create_workspace` expands `~`, `rename_workspace` and the `cwd` filter of `list_sessions` do not; the list filter compares `path.resolve` strings, so `/tmp/x` never matches a session recorded as `/private/tmp/x` (macOS symlink).
   > Fix: one `normalizePath()` helper (expand `~`, `realpath` when the path exists) used everywhere.

7. **`host/lib/index.js:88-100` [bug, known design limit]** 📝 **Documented** (README known limitations) — Any user message that opens a turn while a bridge run is active is treated as part of the bridge's work; a person typing in the Harness UI during a run gets their turn's output attributed to that run (or ends it via `superseded_by: "user"`).
   > Fix: document it now; later, distinguish bridge prompts from UI prompts by `rpcId` ownership only.

8. **`src/core.mjs:85-104` [bug, headless only]** ✅ **Fixed** — Session files are split on the zstd magic bytes. When those bytes also occur inside compressed data, the real frame is cut short and both slices fail to decode, so a whole frame of records is dropped from listings and `read_session`.
   > Fix: decode frame by frame using the frame header's content size, or retry with the next real start when a slice fails.

## Low (kept because they are cheap)

9. **`host/lib/index.js:81, 131-132` [performance]** — `turns`, `quietSinceBySession` and `lastRunningAt` are never pruned; they grow by one small entry per session touched.
10. **`src/core.mjs:70-74` [maintainability]** ✅ **Fixed** — `hostKnownUp` is written but never read (dead variable).
11. **`src/cli.mjs:17-24` [bug]** — Any message word starting with `--` is taken as a flag, so `send … "use --json"` loses `--json`. Use `--` to end flags, or read the message from stdin.

## Found by tests and already fixed

- **Sub-agent race on completion** (simulation test) — when sub-agents finished, the session went quiet for a moment before Harness woke the parent for its final turn; a poll in that gap ended the run early and lost the final reply. Fixed with a 2 s quiet-confirm (`QUIET_CONFIRM_MS`).
- **Cancel lost during sub-agent startup** (live test) — a stop that arrived while sub-agents were starting was dropped; the turn carried on and started them again. `cancel` now re-issues the stop until the session is quiet (up to 3 times, `CANCEL_ATTEMPTS`). Live re-test: stopped in 17 s.
- **Followup result overwrote the previous run** (Codex test, fixed in the forked session) — runs now finish with their own result and `superseded_by`.

## Not issues (checked)

- Socket protocol output: `JSON.stringify` never emits raw newlines, so line framing is safe.
- Run ids are validated before building headless file paths (`/^run-[\w-]+$/`), so no path traversal.
- Package manifests: no dependencies, no `latest`/`*` versions; the `test` script uses only Node built-ins.
- YAML keys in both patch files are spelled correctly.
- No `var`, no loose equality, no Chinese text in code (international audience).
