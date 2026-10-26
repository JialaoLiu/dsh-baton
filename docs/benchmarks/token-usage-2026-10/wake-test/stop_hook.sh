#!/bin/bash
# Codex Stop hook used as a wake-up: when the model ends its turn, block (no model tokens)
# until a background job writes $JOB_DIR/job.done, then return decision=block with the
# job result as the reason, which Codex feeds back to the model as a continuation prompt.
# On the continuation's own Stop (stop_hook_active=true) it lets the turn end.
JOB_DIR=${WAKE_JOB_DIR:-$(cd "$(dirname "$0")" && pwd)/job}
IN=$(cat)
echo "$(date +%s) stop-hook input: $IN" >> "$JOB_DIR/hook.log"
if echo "$IN" | grep -q '"stop_hook_active":true'; then exit 0; fi
[ -f "$JOB_DIR/job.pid" ] || exit 0        # nothing running: let the turn end
end=$(( $(date +%s) + ${WAKE_MAX_S:-900} ))
until [ -f "$JOB_DIR/job.done" ] || [ $(date +%s) -gt $end ]; do sleep 1; done
RES=$(cat "$JOB_DIR/job.done" 2>/dev/null || echo "job still running after wait limit")
echo "$(date +%s) stop-hook releasing: $RES" >> "$JOB_DIR/hook.log"
python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":"Background job finished: "+sys.argv[1]+". Report this result to the user in one line."}))' "$RES"
