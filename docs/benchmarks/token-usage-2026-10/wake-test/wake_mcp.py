#!/usr/bin/env python3
"""Tiny stdio MCP server for the Codex wake tests.

Tools:
  slow_job(seconds)      blocks `seconds`, sending notifications/progress (when the
                         client sent a progressToken) and notifications/message every 5 s.
  notify_later(delay)    returns at once; `delay` s later sends unsolicited
                         notifications/message, notifications/resources/updated and
                         notifications/tools/list_changed (no request open).
Every message in/out is logged with a timestamp to $WAKE_MCP_LOG.
"""
import json, os, sys, threading, time

LOG = os.environ.get("WAKE_MCP_LOG", "/dev/null")
lock = threading.Lock()


def log(kind, obj):
    with open(LOG, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "kind": kind, "msg": obj}) + "\n")


def send(obj):
    with lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    log("out", obj)


TOOLS = [
    {"name": "slow_job", "description": "Blocks for `seconds` seconds, then returns 'slow_job finished'.",
     "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}, "required": ["seconds"]}},
    {"name": "notify_later", "description": "Returns immediately. After `delay` seconds the server emits MCP notifications.",
     "inputSchema": {"type": "object", "properties": {"delay": {"type": "number"}}, "required": ["delay"]}},
]


def slow_job(req):
    args = req["params"].get("arguments", {})
    secs = float(args.get("seconds", 30))
    token = (req["params"].get("_meta") or {}).get("progressToken")
    t0 = time.time(); n = 0
    while time.time() - t0 < secs:
        time.sleep(min(5, secs - (time.time() - t0)))
        n += 1
        el = round(time.time() - t0)
        if token is not None:
            send({"jsonrpc": "2.0", "method": "notifications/progress",
                  "params": {"progressToken": token, "progress": el, "total": secs,
                             "message": f"PROGRESS_MARKER_{n} elapsed {el}s"}})
        send({"jsonrpc": "2.0", "method": "notifications/message",
              "params": {"level": "info", "logger": "wake_mcp", "data": f"LOG_MARKER_{n} elapsed {el}s"}})
    send({"jsonrpc": "2.0", "id": req["id"],
          "result": {"content": [{"type": "text", "text": f"slow_job finished after {round(time.time()-t0)}s"}]}})


def notify_later(req):
    delay = float(req["params"].get("arguments", {}).get("delay", 20))
    send({"jsonrpc": "2.0", "id": req["id"],
          "result": {"content": [{"type": "text", "text": f"scheduled notifications in {delay}s"}]}})
    time.sleep(delay)
    send({"jsonrpc": "2.0", "method": "notifications/message",
          "params": {"level": "warning", "logger": "wake_mcp", "data": "UNSOLICITED_JOB_DONE_MARKER"}})
    send({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": "wake://job/1"}})
    send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    log("in", req)
    m = req.get("method")
    if m == "initialize":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {
            "protocolVersion": req["params"].get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": True}, "logging": {}, "resources": {"subscribe": True}},
            "serverInfo": {"name": "wake_mcp", "version": "0.1"}}})
    elif m == "tools/list":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {"tools": TOOLS}})
    elif m == "tools/call":
        fn = {"slow_job": slow_job, "notify_later": notify_later}.get(req["params"]["name"])
        if fn:
            threading.Thread(target=fn, args=(req,), daemon=True).start()
        else:
            send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "no such tool"}})
    elif m == "resources/list":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {"resources": []}})
    elif m == "resources/templates/list":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {"resourceTemplates": []}})
    elif m == "prompts/list":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {"prompts": []}})
    elif m in ("logging/setLevel", "ping") or (m and "id" in req and not m.startswith("notifications/")):
        send({"jsonrpc": "2.0", "id": req["id"], "result": {}})
