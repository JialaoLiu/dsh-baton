#!/bin/bash
# Test 1a (code-mode variant, the default for gpt-6 models): one script cell that starts a
# background terminal and waits on it with write_stdin, with a long @exec yield pragma.
# usage: run_a_codemode.sh <workdir> <sleep_seconds> [extra -c args...]
DIR=$1; SECS=$2; shift 2
C=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
mkdir -p "$DIR"
PROMPT="This is a tool-behaviour test. Follow exactly, no other actions.
1. Run exactly this script with your exec tool (keep the first pragma line):
// @exec: {\"yield_time_ms\": 3600000}
const a = await tools.exec_command({cmd: \"sleep $SECS; echo DONE\", yield_time_ms: 1000});
const t0 = Date.now();
const b = await tools.write_stdin({session_id: a.session_id, chars: \"\", yield_time_ms: 3600000});
text(JSON.stringify({waited_s: (Date.now() - t0) / 1000, b}));
2. If the cell yields while still running, call wait on it with yield_time_ms 3600000, repeatedly, until the script completes.
3. If the script result shows the process still running (no DONE), run another script with the same pragma that calls write_stdin on the same session_id with yield_time_ms 3600000; repeat until DONE.
4. Reply with one line per tool call: the call and the wall time it reported. Then stop."
cd "$DIR"
date +%s > start.txt
"$C" exec --json --skip-git-repo-check -C "$DIR" -m gpt-6-luna -c model_reasoning_effort=medium \
  -c 'mcp_servers.dsh-baton.enabled=false' "$@" "$PROMPT" > events.jsonl 2> stderr.txt
date +%s > end.txt
