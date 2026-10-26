#!/bin/bash
# Test 4a: Stop hook as a zero-polling wake in `codex exec`.
# A fake background job (sleep N, then writes job.done) runs outside Codex; the model just ends
# its turn; the Stop hook blocks until job.done and returns decision=block with the result.
# usage: run_c_stophook.sh <workdir> <job_seconds> [extra -c args...]
DIR=$1; SECS=$2; shift 2
W=$(cd "$(dirname "$0")" && pwd)
C=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
export WAKE_JOB_DIR="$DIR/job"; mkdir -p "$WAKE_JOB_DIR"; rm -f "$WAKE_JOB_DIR"/job.*
( sleep "$SECS"; echo "RESULT_42 at $(date +%s)" > "$WAKE_JOB_DIR/job.done" ) &
echo $! > "$WAKE_JOB_DIR/job.pid"
cd "$DIR"; date +%s > start.txt
"$C" exec --json --skip-git-repo-check -C "$DIR" -m gpt-6-luna -c model_reasoning_effort=medium \
  -c 'mcp_servers.dsh-baton.enabled=false' \
  -c "hooks.Stop=[{hooks=[{type=\"command\",command=\"$W/stop_hook.sh\",timeout=${HOOK_TIMEOUT:-900}}]}]" "$@" < /dev/null \
  "This is a hook test. A background job is already running outside this conversation. Do not run any tools. Reply with the single word: waiting." \
  > events.jsonl 2> stderr.txt
date +%s > end.txt
