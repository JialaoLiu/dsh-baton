#!/usr/bin/env python3
"""Summarise a Codex rollout: tool calls/outputs with timestamps, and every token_count event
(per-request last_token_usage + rate_limits.primary.used_percent).
usage: rollout_summary.py <thread_id or rollout path>"""
import glob, json, sys
a = sys.argv[1]
path = a if a.endswith('.jsonl') else glob.glob(f"/Users/jarvislao/.codex/sessions/2026/10/*/*{a}*.jsonl")[0]
print(path)
n = 0
for line in open(path):
    o = json.loads(line); ts = o.get('timestamp', '')[11:23]; p = o.get('payload', {})
    t = o.get('type'); pt = p.get('type')
    if t == 'response_item' and pt in ('function_call', 'custom_tool_call'):
        print(ts, 'CALL', p.get('name'), (p.get('arguments') or p.get('input') or '')[:200])
    elif t == 'response_item' and pt in ('function_call_output', 'custom_tool_call_output'):
        out = p.get('output'); out = out if isinstance(out, str) else json.dumps(out)
        print(ts, 'OUT ', out[:300].replace('\n', ' | '))
    elif t == 'response_item' and pt == 'message' and p.get('role') in ('assistant', 'user', 'developer'):
        txt = ' '.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))
        if p.get('role') != 'developer' or 'sleep' in txt.lower():
            print(ts, 'MSG ', p.get('role'), txt[:200].replace('\n', ' | '))
    elif t == 'event_msg' and pt == 'token_count' and p.get('info'):
        n += 1
        u = p['info']['last_token_usage']; rl = (p.get('rate_limits') or {}).get('primary') or {}
        print(ts, f"TOKENS req#{n} in={u.get('input_tokens')} cached={u.get('cached_input_tokens')} out={u.get('output_tokens')} reason={u.get('reasoning_output_tokens')} primary_used%={rl.get('used_percent')}")
    elif t == 'event_msg' and pt not in ('token_count', 'agent_reasoning', 'agent_message', 'user_message', 'exec_command_output_delta'):
        print(ts, 'EVT ', pt, json.dumps(p)[:160])
