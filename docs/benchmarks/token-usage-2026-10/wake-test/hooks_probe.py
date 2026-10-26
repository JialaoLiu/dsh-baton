#!/usr/bin/env python3
"""Ask a throwaway app-server which hooks it discovered (hooks/list), no model calls.
usage: hooks_probe.py <cwd> [extra app-server args...]"""
import json, os, subprocess, sys, time
C = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
p = subprocess.Popen([C, "app-server"] + ([] if os.environ.get("CODEX_HOME") else ["-c", "mcp_servers.dsh-baton.enabled=false"]) + sys.argv[2:],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def rpc(i, m, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": params}) + "\n"); p.stdin.flush()
    while True:
        o = json.loads(p.stdout.readline())
        if o.get("id") == i: return o
rpc(1, "initialize", {"clientInfo": {"name": "probe", "version": "0"}, "capabilities": {"experimentalApi": True}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized"}) + "\n"); p.stdin.flush()
print(json.dumps(rpc(2, "hooks/list", {"cwds": [sys.argv[1]]}), indent=1)[:3000])
p.stdin.close(); p.wait(10)
