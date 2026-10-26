#!/bin/bash
# Test 1a: unified exec background terminal + one long write_stdin wait, via `codex exec`.
# usage: run_a.sh <workdir> <sleep_seconds> [extra -c args...]
DIR=$1; SECS=$2; shift 2
C=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
PROMPT="This is a tool-behaviour test. Follow exactly, no other actions.
1. Call exec_command with cmd \"sleep $SECS; echo DONE\" and yield_time_ms 1000.
2. It will still be running. Call write_stdin with that session_id, chars \"\" (empty) and yield_time_ms 3600000.
3. If the output does not contain DONE and the process is still running, repeat step 2 (same arguments). Repeat until DONE appears.
4. Reply with one line per write_stdin call: the wall time the call reported and whether DONE appeared. Then stop."
cd "$DIR"
date +%s > start.txt
"$C" exec --json --skip-git-repo-check -C "$DIR" -m gpt-6-luna -c model_reasoning_effort=medium \
  -c 'mcp_servers.dsh-baton.enabled=false' "$@" "$PROMPT" > events.jsonl 2> stderr.txt
date +%s > end.txt
