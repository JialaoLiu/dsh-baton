#!/usr/bin/env python3
"""Codex app-server wake tests (stdio JSON-RPC).

One long-lived `codex app-server`, one thread, several scripted turns (phases).
Every JSON-RPC message is logged with a timestamp to <outdir>/appserver.jsonl.

usage: appserver_test.py <outdir> <phase,phase,...>
phases:
  idle    model starts a 45 s background terminal, ends its turn; watch 80 s for a
          spontaneous new turn when the terminal exits.
  sleepbg model starts a 30 s background terminal, then calls the sleep tool for 120 s.
  sleepmcp model calls wake_mcp.notify_later(20) and then sleeps 90 s.
  steer   model sleeps 300 s; client sends turn/steer after 20 s.
  mcpprog model calls wake_mcp.slow_job(40); server sends progress/log notifications.
  stophook a fake job (60 s) runs outside Codex; model ends its turn; a Stop hook (configured
          with -c on the command line) blocks until the job is done, then continues the turn.
  stophooksteer same, but the client sends turn/steer 20 s into the hook's wait.
  stophookinterrupt same, but the client sends turn/interrupt 25 s into the hook's wait,
          then waits 60 s more to see whether the hook still continues the thread.
  idlemcp after an idle turn, the MCP server emits unsolicited notifications; watch 60 s.
"""
import json, os, subprocess, sys, threading, time, queue

OUT = sys.argv[1]
PHASES = sys.argv[2].split(",")
EXTRA = sys.argv[3:]
os.makedirs(OUT, exist_ok=True)
WORK = os.path.join(OUT, "work"); os.makedirs(WORK, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))
CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
LOGF = open(os.path.join(OUT, "appserver.jsonl"), "a")
T0 = time.time()

args = [CODEX, "app-server",
        "-c", "model=\"gpt-6-luna\"", "-c", "model_reasoning_effort=\"medium\"",
        "-c", "mcp_servers.dsh-baton.enabled=false",
        "-c", f"mcp_servers.wake_mcp.command=\"python3\"",
        "-c", f"mcp_servers.wake_mcp.args=[\"{HERE}/wake_mcp.py\"]",
        "-c", f"mcp_servers.wake_mcp.env={{WAKE_MCP_LOG=\"{OUT}/mcp.jsonl\"}}",
        "-c", "mcp_servers.wake_mcp.tool_timeout_sec=600",
        "-c", "mcp_servers.wake_mcp.default_tools_approval_mode=\"approve\"",
        ] + EXTRA
proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(os.path.join(OUT, "stderr.txt"), "w"), text=True, bufsize=1)
open(os.path.join(OUT, "pid.txt"), "w").write(str(proc.pid))

events = queue.Queue()
pending = {}
next_id = [1]
wlock = threading.Lock()


def log(direction, msg):
    LOGF.write(json.dumps({"t": round(time.time() - T0, 3), "dir": direction, "msg": msg}) + "\n"); LOGF.flush()


def write(msg):
    with wlock:
        proc.stdin.write(json.dumps(msg) + "\n"); proc.stdin.flush()
    log("out", msg)


def request(method, params, wait=True):
    i = next_id[0]; next_id[0] += 1
    ev = threading.Event(); pending[i] = [ev, None]
    write({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    if not wait:
        return None
    ev.wait(120)
    return pending.pop(i)[1]


def reader():
    for line in proc.stdout:
        try:
            msg = json.loads(line)
        except Exception:
            log("raw", line); continue
        log("in", msg)
        if "id" in msg and ("result" in msg or "error" in msg) and "method" not in msg:
            p = pending.get(msg["id"])
            if p: p[1] = msg; p[0].set()
        elif "id" in msg and "method" in msg:
            # server -> client request: approve everything, log it
            m = msg["method"]
            if m == "mcpServer/elicitation/request":
                res = {"action": "accept", "content": {}}
            elif m == "currentTime/read":
                res = {"currentTime": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
            else:
                res = {"decision": "accept"}
            write({"jsonrpc": "2.0", "id": msg["id"], "result": res})
            events.put(("request", m, msg))
        else:
            events.put(("note", msg.get("method"), msg))


threading.Thread(target=reader, daemon=True).start()

r = request("initialize", {"clientInfo": {"name": "waketest", "version": "0.1"},
                           "capabilities": {"experimentalApi": True}})
write({"jsonrpc": "2.0", "method": "initialized"})
r = request("thread/start", {"cwd": WORK, "approvalPolicy": "never", "sandbox": "workspace-write",
                             "model": "gpt-6-luna",
                             "config": json.loads(os.environ.get("THREAD_CONFIG", "null"))})
thread = r["result"]["thread"]; tid = thread["id"]
print("thread", tid, thread.get("path"), flush=True)
open(os.path.join(OUT, "thread.txt"), "w").write(json.dumps(thread))


def mark(text):
    log("mark", text); print(f"[{time.time()-T0:7.1f}] {text}", flush=True)


def drain_until(pred, timeout):
    """Consume events until pred(evt) is true or timeout; returns the matching event or None."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            e = events.get(timeout=max(0.1, end - time.time()))
        except queue.Empty:
            return None
        kind, m, msg = e
        if m in ("turn/started", "turn/completed", "item/started", "item/completed", "item/mcpToolCall/progress",
                 "thread/tokenUsage/updated", "mcpServer/event/stream/notification", "warning", "error"):
            brief = json.dumps(msg.get("params", {}))[:220]
            mark(f"evt {m} {brief}")
        if pred(e):
            return e
    return None


def is_turn_completed(e): return e[1] == "turn/completed"


def run_turn(text, timeout=900, during=None):
    mark("turn/start: " + text[:80])
    r = request("turn/start", {"threadId": tid, "input": [{"type": "text", "text": text}]})
    turn_id = r.get("result", {}).get("turn", {}).get("id")
    mark(f"turn id {turn_id}")
    if during:
        during(turn_id)
    e = drain_until(is_turn_completed, timeout)
    mark("turn completed" if e else "turn TIMEOUT")
    return turn_id


PREFIX = "This is a tool-behaviour test. Follow exactly, take no other actions. "

for ph in PHASES:
    mark(f"===== PHASE {ph}")
    if ph == "idle":
        run_turn(PREFIX + "Call exec_command with cmd \"sleep 45; echo BG1_DONE\" and yield_time_ms 1000. "
                 "Do NOT wait for it and do not poll it. Immediately end your turn with the single word: started.")
        mark("idle watch 80 s for spontaneous turn")
        e = drain_until(lambda e: e[1] == "turn/started", 80)
        mark("SPONTANEOUS TURN STARTED" if e else "no spontaneous turn in 80 s")
        if e:
            drain_until(is_turn_completed, 300)
    elif ph == "sleepbg":
        run_turn(PREFIX + "1. Call exec_command with cmd \"sleep 30; echo BG2_DONE\" and yield_time_ms 1000. "
                 "2. Then call the sleep tool for 120 seconds (do not poll the terminal). "
                 "3. Reply with the sleep tool's result text verbatim, then stop.")
    elif ph == "sleepmcp":
        run_turn(PREFIX + "1. Call the wake_mcp notify_later tool with delay 20. "
                 "2. Then call the sleep tool for 90 seconds. "
                 "3. Reply with the sleep tool's result text verbatim, then stop.")
    elif ph == "steer":
        def steer_later(turn_id):
            def go():
                time.sleep(45)
                mark("sending turn/steer")
                rr = request("turn/steer", {"threadId": tid, "expectedTurnId": turn_id,
                                            "input": [{"type": "text", "text": "JOB_FINISHED: the background job is done. Stop sleeping and reply DONE_ACK."}]})
                mark("turn/steer response " + json.dumps(rr)[:300])
            threading.Thread(target=go, daemon=True).start()
        run_turn(PREFIX + "Call the sleep tool for 300 seconds. When it returns, reply with its result text verbatim "
                 "and follow any new user message.", during=steer_later)
    elif ph == "mcpprog":
        run_turn(PREFIX + "Call the wake_mcp slow_job tool with seconds 40. Then reply with its result text verbatim and "
                 "list any progress or log messages you saw while it ran (or say none).")
    elif ph == "idlemcp":
        run_turn(PREFIX + "Call the wake_mcp notify_later tool with delay 15, then immediately end your turn with: scheduled.")
        mark("idle watch 60 s after unsolicited MCP notifications")
        e = drain_until(lambda e: e[1] == "turn/started", 60)
        mark("SPONTANEOUS TURN STARTED" if e else "no spontaneous turn in 60 s")
        if e:
            drain_until(is_turn_completed, 300)

    elif ph in ("stophook", "stophooksteer", "stophookinterrupt"):
        jd = os.environ["WAKE_JOB_DIR"]; os.makedirs(jd, exist_ok=True)
        for f in ("job.done", "job.pid"):
            if os.path.exists(os.path.join(jd, f)): os.remove(os.path.join(jd, f))
        job = subprocess.Popen(["/bin/bash", "-c", f"sleep 60; echo RESULT_{ph}_$(date +%s) > {jd}/job.done"])
        open(os.path.join(jd, "job.pid"), "w").write(str(job.pid))
        mark(f"fake job pid {job.pid} started (60 s)")
        def steer_in_hook(turn_id):
            if ph == "stophookinterrupt":
                def gi():
                    time.sleep(25)
                    mark("sending turn/interrupt during Stop-hook wait")
                    rr = request("turn/interrupt", {"threadId": tid, "turnId": turn_id})
                    mark("turn/interrupt response " + json.dumps(rr)[:300])
                threading.Thread(target=gi, daemon=True).start()
                return
            if ph != "stophooksteer": return
            def go():
                time.sleep(25)
                mark("sending turn/steer during Stop-hook wait")
                rr = request("turn/steer", {"threadId": tid, "expectedTurnId": turn_id,
                                            "input": [{"type": "text", "text": "USER_TYPED_DURING_HOOK: say ACK_USER."}]})
                mark("turn/steer response " + json.dumps(rr)[:300])
            threading.Thread(target=go, daemon=True).start()
        run_turn(PREFIX + "A background job runs outside this conversation. Do not run any tools. Reply with the single word: waiting.",
                 during=steer_in_hook)
        if ph == "stophookinterrupt":
            e = drain_until(lambda e: e[1] == "turn/started", 60)
            mark("turn started after interrupt" if e else "no new turn within 60 s after interrupt")

mark("done; shutting down app-server")
try:
    proc.stdin.close(); proc.wait(15)
except Exception:
    proc.kill()
