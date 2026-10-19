// Simulation tests for the dsh-bridge-host plugin: a fake Harness host context
// drives the plugin through the same events Harness emits, and the tests talk
// to it over its real local socket. No Harness installation is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/lib/index.js'
import { socketEndpoint } from '../host/lib/socket.js'

const IS_WIN = process.platform === 'win32'

function startHost({ activity = () => [], sessions = [], workspaces = [], sock: sockPath, home } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-'))
  // Run records go to the bridge home: keep them out of the real ~/.dsh-bridge.
  process.env.DSH_BRIDGE_HOME = home ?? path.join(dir, 'bridge')
  const sock = sockPath ?? path.join(dir, 'h.sock')
  const endpoint = socketEndpoint(sock) // where the host listens: the path itself, or a named pipe on Windows
  const logs = []
  const handlers = {}
  const disposers = []
  const calls = { prompt: [], create: [], cancel: [], stop: [], rename: [] }
  const ws = workspaces.map((w) => ({ sessionIds: [], ...w, setTitle: async function (t) { this.title = t } }))
  const ctx = {
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    effect: (fn) => disposers.push(fn()),
    waterfall: async (ev, { sessionId }) => activity(sessionId),
    logger: { info: () => {}, error: (m) => logs.push(m) },
    workspaceRegistry: {
      list: () => ws,
      get: (id) => ws.find((w) => w.id === id),
      archivedSessionIds: [],
      resolveByPath: async (p) => ws.find((w) => w.path === p),
      create: async (p, title) => {
        const w = { id: `w${ws.length + 1}`, path: p, title: title ?? path.basename(p), sessionIds: [], setTitle: async function (t) { this.title = t } }
        ws.push(w)
        return w
      },
      stopSessionActivity: async (sessionId) => { calls.stop.push(sessionId) },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async () => ({ meta: { cwd: '/w' }, events: [] }),
      create: async (r) => { calls.create.push(r); return { sessionId: `new-${calls.create.length}` } },
      prompt: async (r) => { calls.prompt.push(r); return { accepted: true } },
      cancel: (r) => { calls.cancel.push(r) },
      rename: async (r) => { calls.rename.push(r); return { title: r.title } },
    },
  }
  process.env.DSH_BRIDGE_SOCKET = sock
  apply(ctx)
  const emit = (ev, ...args) => (handlers[ev] ?? []).forEach((fn) => fn(...args))
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const conn = net.connect(endpoint)
    let buf = ''
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, method, params }) + '\n'))
    conn.on('data', (d) => {
      buf += d
      if (!buf.includes('\n')) return
      conn.end()
      const msg = JSON.parse(buf)
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result)
    })
    conn.on('error', reject)
  })
  const ready = new Promise((r) => setTimeout(r, 50))
  const close = () => { disposers.forEach((d) => d?.()); fs.rmSync(dir, { recursive: true, force: true }) }
  return { ctx, emit, call, calls, ready, close, ws, logs, sock }
}

// Harness event helpers for one session.
const S = (id) => ({
  userMessage: (rpcId) => ['session/event', { id }, { type: 'user/message', data: { source: { kind: 'user', rpcId } } }],
  turnStart: () => ['session/event', { id }, { type: 'turn/start', data: {} }],
  text: (text) => ['session/event', { id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }],
  tool: (name) => ['session/event', { id }, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name }] } } }],
  turnEnd: (kind = 'completed') => ['session/event', { id }, { type: 'turn/end', data: { reason: { kind } } }],
  status: (status) => ['agent/status', { agent: { id }, status }],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('ping reports the plugin version', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const r = await h.call('ping')
  assert.equal(r.name, 'dsh-bridge-host')
  assert.match(r.version, /^\d+\.\d+\.\d+$/)
})

test('list_sessions reads titles from projections and hides sub-agent sessions', async (t) => {
  const h = startHost({ sessions: [
    { sessionId: 'a', cwd: '/w', projections: { values: { title: 'Main' } } },
    { sessionId: 'b', cwd: '/w', parentSessionId: 'a', projections: { values: { title: 'Child' } } },
  ] })
  t.after(h.close); await h.ready
  assert.deepEqual((await h.call('list_sessions')).map((s) => s.title), ['Main'])
  assert.equal((await h.call('list_sessions', { include_subagents: true })).length, 2)
})

test('create_workspace is idempotent', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ws-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = await h.call('create_workspace', { path: dir, title: 'Demo' })
  const b = await h.call('create_workspace', { path: dir })
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(a.id, b.id)
})

test('send with cwd registers the folder as a workspace before creating the session', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const r = await h.call('send', { cwd: '/proj', message: 'hi' })
  assert.deepEqual(h.calls.create, [{ workspaceId: 'w1' }])
  assert.equal(r.session_id, 'new-1')
  assert.equal(r.workspace.created, true)
})

test('a run completes with its final text once the session is idle', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  assert.equal(run.state, 'queued')
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  h.emit(...s.tool('bash')); h.emit(...s.text('done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const w = await h.call('wait', { run_id: run.run_id, timeout_s: 5 })
  assert.equal(w.state, 'completed')
  assert.equal(w.final_text, 'done')
  assert.ok(w.recent_events.some((e) => e.type === 'tool_call' && e.name === 'bash'))
})

test('steer joins the running turn; followup waits and keeps results separate', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const first = await h.call('send', { session_id: 's1', message: 'long task' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  h.emit(...s.tool('bash'))
  const queued = await h.call('send', { session_id: 's1', message: 'next' })
  const steer = await h.call('send', { session_id: 's1', message: 'change', mode: 'steer' })
  assert.deepEqual(steer.other_active_runs, [first.run_id, queued.run_id])
  assert.equal(h.calls.prompt[2].mode, 'steer')
  h.emit(...s.userMessage(h.calls.prompt[2].requestId)) // steer lands mid-turn
  h.emit(...s.text('turn 1 done')); h.emit(...s.turnEnd())
  // The queued followup opens the next turn before the quiet check runs.
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  h.emit(...s.text('turn 2 done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const [a, b, c] = await Promise.all([first, steer, queued].map((r) => h.call('wait', { run_id: r.run_id, timeout_s: 5 })))
  assert.equal(a.final_text, 'turn 1 done')
  assert.equal(b.final_text, 'turn 1 done')
  assert.equal(c.final_text, 'turn 2 done')
  assert.equal(a.superseded_by, queued.run_id)
  assert.equal(c.state, 'completed')
})

test('a run waits for sub-agents before completing', async (t) => {
  let busyUntil = Date.now() + 2500
  const h = startHost({ activity: () => (Date.now() < busyUntil ? [{ kind: 'subagent', items: [{ id: 'c', label: 'child' }] }] : []) })
  t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'fan out' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('started children')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  await sleep(500)
  const mid = await h.call('status', { run_id: run.run_id })
  assert.equal(mid.state, 'running')
  assert.equal(mid.waiting_on[0].kind, 'subagent')
  // Children report back: Harness wakes the parent for a final turn without a user message.
  setTimeout(() => { h.emit(...s.status('running')); h.emit(...s.text('all children done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle')) }, 2600)
  const done = await h.call('wait', { run_id: run.run_id, timeout_s: 10 })
  assert.equal(done.state, 'completed')
  assert.equal(done.final_text, 'all children done')
})

test('a failed turn fails the run', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.turnEnd('error'))
  assert.equal((await h.call('wait', { run_id: run.run_id, timeout_s: 2 })).state, 'failed')
})

test('cancel stops the whole session through the archive stop path', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  const queued = await h.call('send', { session_id: 's1', message: 'later' })
  const r = await h.call('cancel', { run_id: run.run_id })
  assert.deepEqual(h.calls.stop, ['s1'])
  assert.equal(r.run.state, 'cancelled')
  assert.deepEqual(r.queued_runs, [queued.run_id])
})

test('cancel re-issues the stop when the first one is lost', async (t) => {
  let h
  // Sub-agents keep running until the second stop (the first raced their startup).
  h = startHost({ activity: () => (h.calls.stop.length < 2 ? [{ kind: 'subagent', items: [{ id: 'c' }] }] : []) })
  t.after(h.close); await h.ready
  const r = await h.call('cancel', { session_id: 's1' })
  assert.equal(r.attempts, 2)
  assert.equal(r.still_busy, false)
  assert.deepEqual(h.calls.stop, ['s1', 's1'])
})

test('wait returns timed_out while the run is still going', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const run = await h.call('send', { session_id: 's1', message: 'x' })
  const w = await h.call('wait', { run_id: run.run_id, timeout_s: 0.2 })
  assert.equal(w.timed_out, true)
})

test('rename session and workspace', async (t) => {
  const h = startHost({ workspaces: [{ id: 'w1', path: '/w', title: 'old' }] }); t.after(h.close); await h.ready
  assert.equal((await h.call('rename_session', { session_id: 's1', title: ' New ' })).title, 'New')
  assert.deepEqual(h.calls.rename, [{ sessionId: 's1', title: 'New' }])
  assert.equal((await h.call('rename_workspace', { workspace_id: 'w1', title: 'Renamed' })).title, 'Renamed')
  await assert.rejects(h.call('rename_workspace', { workspace_id: 'nope', title: 'x' }), /not found/)
})

test('unknown methods and bad input are reported, not thrown', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  await assert.rejects(h.call('nope'), /Unknown method/)
  await assert.rejects(h.call('send', { message: 'x' }), /needs cwd or workspace_id/)
  await assert.rejects(h.call('status', { run_id: 'hrun-missing' }), /Unknown run/)
})

// On Windows the path maps to a named pipe, so a file at the path is never looked at or touched.
test('refuses to start over a regular file and leaves it alone', { skip: IS_WIN && 'named pipes on Windows' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-f-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'not-a-socket')
  fs.writeFileSync(file, 'keep me')
  const h = startHost({ sock: file }); t.after(h.close); await h.ready
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me')
  assert.match(h.logs.join('\n'), /is not a socket/)
})

test('a second host does not take over a live socket', async (t) => {
  const a = startHost(); t.after(a.close); await a.ready
  const b = startHost({ sock: a.sock }); t.after(b.close); await b.ready
  assert.match(b.logs.join('\n'), /already serves/)
  assert.equal((await a.call('ping')).name, 'dsh-bridge-host')
})

test('inherited object keys are not callable methods', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  for (const m of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) await assert.rejects(h.call(m), /Unknown method/)
})

test('run eviction keeps active runs', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const first = await h.call('send', { session_id: 'busy', message: 'still going' })
  for (let i = 0; i < 101; i++) {
    const r = await h.call('send', { session_id: `s${i}`, message: 'x' })
    h.emit('session/event', { id: `s${i}` }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    h.emit('session/event', { id: `s${i}` }, { type: 'user/message', data: { source: { kind: 'user', rpcId: h.calls.prompt.at(-1).requestId } } })
    h.emit('session/event', { id: `s${i}` }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    assert.ok(r.run_id)
  }
  assert.equal((await h.call('status', { run_id: first.run_id })).state, 'queued')
})

test('list_sessions cwd filter follows symlinks', async (t) => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-real-')))
  const link = `${real}-link`
  fs.symlinkSync(real, link, IS_WIN ? 'junction' : undefined) // a junction needs no admin rights on Windows
  t.after(() => { fs.unlinkSync(link); fs.rmSync(real, { recursive: true, force: true }) })
  const h = startHost({ sessions: [{ sessionId: 'a', cwd: real }, { sessionId: 'b', cwd: '/elsewhere' }] }); t.after(h.close); await h.ready
  assert.deepEqual((await h.call('list_sessions', { cwd: link })).map((r) => r.session_id), ['a'])
})

test('a followup does not complete a run whose sub-agents are still working', async (t) => {
  let childBusy = true
  const h = startHost({ activity: () => (childBusy ? [{ kind: 'subagent', items: [{ id: 'c', label: 'child' }] }] : []) })
  t.after(h.close); await h.ready
  const s = S('s1')
  const first = await h.call('send', { session_id: 's1', message: 'fan out' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('children started')); h.emit(...s.turnEnd())
  const next = await h.call('send', { session_id: 's1', message: 'something else' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  h.emit(...s.text('something else done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  await sleep(400)
  const mid = await h.call('status', { run_id: first.run_id })
  assert.equal(mid.state, 'running', 'first run must wait for its sub-agent')
  assert.equal(mid.superseded_by, next.run_id)
  assert.equal(mid.final_text, 'children started')
  assert.equal(mid.waiting_on[0].kind, 'subagent')
  childBusy = false
  const done = await h.call('wait', { run_id: first.run_id, timeout_s: 10 })
  assert.equal(done.state, 'completed')
  assert.equal(done.final_text, 'children started')
})

test('a bridge steer in a turn woken by sub-agents does not close the earlier run', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const first = await h.call('send', { session_id: 's1', message: 'fan out' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('waiting for children')); h.emit(...s.turnEnd())
  h.emit(...s.turnStart()) // woken by sub-agent results: no user message
  const steer = await h.call('send', { session_id: 's1', message: 'also do X', mode: 'steer' })
  h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  const st = await h.call('status', { run_id: first.run_id })
  assert.equal(st.superseded_by, undefined)
  h.emit(...s.text('children done, X done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const [a, b] = await Promise.all([first, steer].map((r) => h.call('wait', { run_id: r.run_id, timeout_s: 5 })))
  assert.equal(a.final_text, 'children done, X done')
  assert.equal(b.final_text, 'children done, X done')
})

test('an activity read failure is not treated as idle', async (t) => {
  let broken = true
  const h = startHost({ activity: () => { if (broken) throw new Error('provider down'); return [] } })
  t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  await sleep(300)
  const mid = await h.call('status', { run_id: run.run_id })
  assert.equal(mid.state, 'running')
  assert.match(mid.error, /provider down/)
  broken = false
  const done = await h.call('wait', { run_id: run.run_id, timeout_s: 10 })
  assert.equal(done.state, 'completed')
  assert.equal(done.error, null)
})

test('a message typed in the Harness UI mid-turn is recorded on the running run', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const run = await h.call('send', { session_id: 'A', message: 'build it' })
  const a = S('A')
  h.emit(...a.turnStart()); h.emit(...a.userMessage(h.calls.prompt[0].requestId)); h.emit(...a.text('working'))
  h.emit('session/event', { id: 'A' }, { type: 'user/message', time: 1, data: { source: { kind: 'user', rpcId: 'ui-typed' }, content: [{ type: 'text', text: 'use tabs, not spaces' }] } })
  const st = await h.call('status', { run_id: run.run_id })
  assert.equal(st.human_interjections.length, 1)
  assert.equal(st.human_interjections[0].text, 'use tabs, not spaces')
  assert.ok(st.recent_events.some((e) => e.type === 'human_input'))
  // a bridge steer is not counted as a human interjection
  await h.call('send', { session_id: 'A', message: 'steer', mode: 'steer' })
  h.emit(...a.userMessage(h.calls.prompt[1].requestId))
  assert.equal((await h.call('status', { run_id: run.run_id })).human_interjections.length, 1)
})

test('run records survive a host restart; an interrupted run is marked as such', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const h1 = startHost({ home }); await h1.ready
  const done = await h1.call('send', { session_id: 'A', message: 'quick' })
  const a = S('A')
  h1.emit(...a.turnStart()); h1.emit(...a.userMessage(h1.calls.prompt[0].requestId)); h1.emit(...a.text('done!')); h1.emit(...a.turnEnd())
  h1.emit('agent/status', { agent: { id: 'A' }, status: 'idle' })
  await h1.call('wait', { run_id: done.run_id, timeout_s: 5 })
  const live = await h1.call('send', { session_id: 'B', message: 'long' })
  const b = S('B')
  h1.emit(...b.turnStart()); h1.emit(...b.userMessage(h1.calls.prompt[1].requestId))
  h1.close() // flushes the store, like Harness shutting the plugin down
  if (!IS_WIN) assert.equal(fs.statSync(path.join(home, 'host-runs')).mode & 0o777, 0o700)
  const h2 = startHost({ home }); t.after(h2.close); await h2.ready
  const kept = await h2.call('status', { run_id: done.run_id })
  assert.equal(kept.state, 'completed'); assert.equal(kept.final_text, 'done!')
  const lost = await h2.call('status', { run_id: live.run_id })
  assert.equal(lost.state, 'interrupted'); assert.match(lost.error, /restarted/)
  assert.equal((await h2.call('wait', { run_id: live.run_id, timeout_s: 5 })).state, 'interrupted')
})

test('per-session state is dropped once a session has no active runs', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  // many idle sessions producing turns must not accumulate anything observable as leaks
  for (let i = 0; i < 200; i++) { const s = S(`idle-${i}`); h.emit(...s.turnStart()); h.emit(...s.text('x')); h.emit(...s.turnEnd()) }
  const run = await h.call('send', { session_id: 'A', message: 'x' })
  const a = S('A')
  h.emit(...a.turnStart()); h.emit(...a.userMessage(h.calls.prompt[0].requestId)); h.emit(...a.text('ok')); h.emit(...a.turnEnd())
  h.emit('agent/status', { agent: { id: 'A' }, status: 'idle' })
  assert.equal((await h.call('wait', { run_id: run.run_id, timeout_s: 5 })).state, 'completed')
})
