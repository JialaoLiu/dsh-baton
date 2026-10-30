// Simulation tests for the dsh-baton-host plugin: a fake Harness host context
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
// Switching the plugin on registers the MCP server in the user's real config files: off
// here, except in the test that points it at a throwaway home.
process.env.DSH_BATON_AUTO_REGISTER = '0'

function startHost({ activity = () => [], sessions = [], workspaces = [], archived = [], sock: sockPath, home, web, settings, queue = false, recheckMs = 300, models, account } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-'))
  // Run records go to the bridge home: keep them out of the real ~/.dsh-baton.
  process.env.DSH_BATON_HOME = home ?? path.join(dir, 'bridge')
  const sock = sockPath ?? path.join(dir, 'h.sock')
  const endpoint = socketEndpoint(sock) // where the host listens: the path itself, or a named pipe on Windows
  const logs = []
  const handlers = {}
  const disposers = []
  const calls = { prompt: [], create: [], cancel: [], stop: [], rename: [], updateQueue: [] }
  // Harness's inbox per session, as its projections report it (queue: true turns it on).
  const inbox = {}
  const pending = (id) => (inbox[id] ??= { 'next-turn': [], 'next-step': [] })
  const ws = workspaces.map((w) => ({ sessionIds: [], ...w, setTitle: async function (t) { this.title = t } }))
  const ctx = {
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    effect: (fn) => disposers.push(fn()),
    waterfall: async (ev, { sessionId }) => activity(sessionId),
    logger: { info: () => {}, error: (m) => logs.push(m) },
    ...(web || settings || models?.viaInject || account ? {
      inject: (deps, fn) => {
        const services = { webServer: web, settings, agentDefaultModel: models?.viaInject ? models.agentDefaultModel : undefined, accountController: account }
        if (deps.every((d) => services[d])) fn({ effect: (f) => disposers.push(f()), ...services })
      },
    } : {}),
    workspaceRegistry: {
      list: () => ws,
      get: (id) => ws.find((w) => w.id === id),
      archivedSessionIds: archived,
      resolveByPath: async (p) => ws.find((w) => w.path === p),
      create: async (p, title) => {
        const w = { id: `w${ws.length + 1}`, path: p, title: title ?? path.basename(p), sessionIds: [], setTitle: async function (t) { this.title = t } }
        ws.push(w)
        return w
      },
      stopSessionActivity: async (sessionId) => { calls.stop.push(sessionId); if (queue) pending(sessionId)['next-turn'] = [] },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async () => ({ meta: { cwd: '/w' }, events: [] }),
      create: async (r) => { calls.create.push(r); return { sessionId: `new-${calls.create.length}` } },
      prompt: async (r) => {
        calls.prompt.push(r)
        if (queue) pending(r.sessionId)[r.mode === 'steer' ? 'next-step' : 'next-turn'].push({ id: `m${calls.prompt.length}`, content: r.content, source: { kind: 'user', rpcId: r.requestId } })
        return { accepted: true }
      },
      ...(queue ? {
        projections: async ({ sessionId }) => ({ kind: 'sequenced', asOfSeq: 1, values: { inbox: pending(sessionId) } }),
        updateQueue: async (r) => {
          calls.updateQueue.push(r)
          const box = pending(r.sessionId)
          const list = box['next-turn']
          const i = list.findIndex((m) => m.id === r.itemId)
          if (i < 0) throw Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' })
          if (r.action.kind === 'edit') list[i] = { ...list[i], content: r.action.content }
          else list.splice(i, 1)
          return { accepted: true }
        },
      } : {}),
      cancel: (r) => { calls.cancel.push(r) },
      rename: async (r) => { calls.rename.push(r); return { title: r.title } },
      ...models?.controller,
    },
    ...(models?.agentDefaultModel && !models.viaInject ? { agentDefaultModel: models.agentDefaultModel } : {}),
  }
  // Harness (cordis) throws when a plugin reads a service it did not inject.
  if (models?.viaInject) Object.defineProperty(ctx, 'agentDefaultModel', { get: () => { throw new Error('cannot get property "agentDefaultModel" without inject') } })
  if (models) models.calls = calls
  process.env.DSH_BATON_SOCKET = sock
  process.env.DSH_BATON_QUEUE_RECHECK_MS = String(recheckMs)
  apply(ctx)
  const emit = (ev, ...args) => (handlers[ev] ?? []).forEach((fn) => fn(...args))
  // Harness asking the user: the user-questions/request waterfall, the Harness UI as `next`
  // (by default a window that never answers). The UI sees the request, signal included.
  const ask = (sessionId, questions, ui = () => new Promise(() => {})) => {
    const request = { agent: { id: sessionId }, questions }
    return handlers['user-questions/request'][0](request, () => ui(request))
  }
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
  return { ctx, emit, ask, call, calls, ready, close, ws, logs, sock, inbox: pending }
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
  assert.equal(r.name, 'dsh-baton-host')
  assert.match(r.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/)
})

test('switched on, the plugin registers the MCP server and serves the outcome to the Plugins page', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  const saved = { ...process.env }
  t.after(() => { process.env = saved; fs.rmSync(dir, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(dir, '.claude'))
  fs.mkdirSync(path.join(dir, '.codex'))
  Object.assign(process.env, { HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: path.join(dir, '.codex'), DSH_BATON_AUTO_REGISTER: '1' })
  let route = null
  const h = startHost({ home: path.join(dir, '.dsh-baton'), web: { register: (r) => { route = r; return () => { route = null } } } })
  t.after(h.close)
  assert.equal(route.path, '/dsh-baton/status')
  const status = async () => {
    let body = ''
    const res = { writeHead: () => {}, end: (b) => { body = b } }
    route.handler({ method: 'GET' }, res)
    return JSON.parse(body)
  }
  let s = await status()
  for (let i = 0; i < 50 && s.registration.state === 'pending'; i++) { await sleep(100); s = await status() }
  assert.equal(s.registration.state, 'done')
  assert.equal(s.registration.ok, true, JSON.stringify(s))
  assert.deepEqual(s.registration.clients.map((c) => [c.id, c.state]), [['claude', 'registered'], ['codex', 'registered']])
  // This repo is a git checkout: its own server is registered, no copy is made.
  const entry = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers['dsh-baton']
  assert.equal(entry.args[0], path.resolve(import.meta.dirname, '..', 'src', 'server.mjs'))
  assert.match(fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.dsh-baton\]/)
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

test('send refuses an archived session, and cancel settles a run that never started', async (t) => {
  const h = startHost({ archived: ['old'] }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { session_id: 'old', message: 'x' }), /archived/)
  assert.equal(h.calls.prompt.length, 0)
  assert.equal((await h.call('activity', { session_id: 'old' })).archived, true)
  const run = await h.call('send', { session_id: 's1', message: 'never delivered' })
  const r = await h.call('cancel', { run_id: run.run_id })
  assert.equal(r.run.state, 'cancelled')
  assert.equal((await h.call('wait', { run_id: run.run_id, timeout_s: 1 })).state, 'cancelled')
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
  assert.equal((await a.call('ping')).name, 'dsh-baton-host')
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

test('a sender is carried in the request id and reported on the run', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go', sender: 'claude' })
  assert.equal(run.sender, 'claude')
  assert.match(h.calls.prompt[0].requestId, /^dsh-baton\.claude\.[0-9a-f-]{36}$/)
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  h.emit(...s.text('done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const w = await h.call('wait', { run_id: run.run_id, timeout_s: 5 })
  assert.equal(w.state, 'completed')
  assert.equal(w.human_interjections, undefined)
  await h.call('send', { session_id: 's2', message: 'plain' })
  assert.match(h.calls.prompt[1].requestId, /^[0-9a-f-]{36}$/)
  await assert.rejects(h.call('send', { session_id: 's1', message: 'x', sender: 'Bad Name' }), /sender must be/)
})

const busySetting = (busyEnter) => ({ describe: () => [{ ns: 'ui-conversation', value: busyEnter ? { busyEnter } : {} }] })

test('without a mode, send follows the Harness busy-send setting; an explicit mode wins', async (t) => {
  for (const [setting, mode, source] of [['steer', 'steer', 'harness'], ['queue', 'followup', 'harness'], [undefined, 'followup', 'default']]) {
    const h = startHost({ settings: busySetting(setting) }); t.after(h.close); await h.ready
    const r = await h.call('send', { session_id: 's1', message: 'x' })
    assert.deepEqual([r.mode, r.mode_source, h.calls.prompt[0].mode], [mode, source, mode], String(setting))
    const e = await h.call('send', { session_id: 's1', message: 'y', mode: 'followup' })
    assert.deepEqual([e.mode, e.mode_source], ['followup', 'explicit'])
    h.close()
  }
  const h = startHost(); t.after(h.close); await h.ready // no settings service at all
  assert.equal((await h.call('send', { session_id: 's1', message: 'x' })).mode_source, 'default')
  await assert.rejects(h.call('send', { session_id: 's1', message: 'x', mode: 'later' }), /followup or steer/)
})

test('update_queued edits, steers and removes a queued message', async (t) => {
  const h = startHost({ queue: true }); t.after(h.close); await h.ready
  const s = S('s1')
  const first = await h.call('send', { session_id: 's1', message: 'long task' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.inbox('s1')['next-turn'].shift()
  const a = await h.call('send', { session_id: 's1', message: 'wrong' })
  const b = await h.call('send', { session_id: 's1', message: 'drop me' })
  const edited = await h.call('update_queued', { run_id: a.run_id, action: 'edit', message: 'right' })
  assert.equal(edited.message_preview, 'right')
  assert.deepEqual(h.calls.updateQueue[0], { sessionId: 's1', itemId: 'm2', action: { kind: 'edit', content: [{ type: 'text', text: 'right' }] } })
  assert.equal(h.inbox('s1')['next-turn'][0].content[0].text, 'right')
  const removed = await h.call('update_queued', { run_id: b.run_id, action: 'remove' })
  assert.equal(removed.state, 'cancelled')
  assert.equal((await h.call('wait', { run_id: b.run_id, timeout_s: 1 })).state, 'cancelled')
  const steered = await h.call('update_queued', { run_id: a.run_id, action: 'steer' })
  assert.equal(steered.action, 'steer')
  // The steer lands in the running turn: it joins the first run instead of closing it.
  h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  h.emit(...s.text('done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const [x, y] = await Promise.all([first, a].map((r) => h.call('wait', { run_id: r.run_id, timeout_s: 5 })))
  assert.deepEqual([x.final_text, y.final_text, x.superseded_by], ['done', 'done', undefined])
  // A run that already reached the conversation, or that left the queue, cannot be changed.
  await assert.rejects(h.call('update_queued', { run_id: first.run_id, action: 'remove' }), /completed; only a queued run/)
  const c = await h.call('send', { session_id: 's1', message: 'later' })
  h.inbox('s1')['next-turn'].length = 0
  await assert.rejects(h.call('update_queued', { run_id: c.run_id, action: 'remove' }), /no longer in the Harness queue/)
  await assert.rejects(h.call('update_queued', { run_id: c.run_id, action: 'edit', message: ' ' }), /non-empty/)
  await assert.rejects(h.call('update_queued', { run_id: c.run_id, action: 'move' }), /edit, remove or steer/)
})

test('update_queued says so when this Harness cannot change its queue', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const r = await h.call('send', { session_id: 's1', message: 'x' })
  await assert.rejects(h.call('update_queued', { run_id: r.run_id, action: 'remove' }), /cannot change queued messages/)
})

test('cancel reports the queued runs Harness dropped as cancelled', async (t) => {
  const h = startHost({ queue: true }); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.inbox('s1')['next-turn'].shift()
  const queued = await h.call('send', { session_id: 's1', message: 'later' })
  const r = await h.call('cancel', { run_id: run.run_id })
  assert.deepEqual(r.removed_from_queue, [queued.run_id])
  assert.deepEqual(r.queued_runs, [])
  assert.equal((await h.call('wait', { run_id: queued.run_id, timeout_s: 1 })).state, 'cancelled')
})

test('a queued message removed in the Harness UI ends its run; one that started does not', async (t) => {
  const h = startHost({ queue: true }); t.after(h.close); await h.ready
  const s = S('s1')
  await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.inbox('s1')['next-turn'].shift()
  const gone = await h.call('send', { session_id: 's1', message: 'removed in the UI' })
  const kept = await h.call('send', { session_id: 's1', message: 'still queued' })
  h.inbox('s1')['next-turn'].shift()
  h.emit('session/event', { id: 's1' }, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
  assert.equal((await h.call('wait', { run_id: gone.run_id, timeout_s: 4 })).state, 'cancelled')
  assert.equal((await h.call('status', { run_id: kept.run_id })).state, 'queued')
  // Should its message reach the conversation after all, the run is taken up again.
  h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  assert.equal((await h.call('status', { run_id: gone.run_id })).state, 'running')
})

test('an edited queued message that starts with its user/message trailing behind keeps its run', async (t) => {
  const h = startHost({ queue: true, recheckMs: 1500 }); t.after(h.close); await h.ready
  const s = S('s1')
  await h.call('send', { session_id: 's1', message: 'x' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.inbox('s1')['next-turn'].shift()
  const queued = await h.call('send', { session_id: 's1', message: 'X' })
  await h.call('update_queued', { run_id: queued.run_id, action: 'edit', message: 'RIGHT-X' })
  // Harness splices the edit in, then the turn ends and the edited message leaves the
  // inbox for the conversation; its user/message only shows up after the first check.
  const splice = (removedCount, inserted) => h.emit('session/event', { id: 's1' }, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount, inserted } })
  splice(1, [h.inbox('s1')['next-turn'][0]])
  h.emit(...s.turnEnd())
  h.inbox('s1')['next-turn'].shift()
  splice(1, [])
  await sleep(2200)
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[1].requestId))
  await sleep(1200)
  const st = await h.call('status', { run_id: queued.run_id })
  assert.equal(st.state, 'running')
  assert.equal(st.message_preview, 'RIGHT-X')
})

test('list_runs narrows to one session', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const a = await h.call('send', { session_id: 's1', message: 'one' })
  await h.call('send', { session_id: 's2', message: 'two' })
  assert.deepEqual((await h.call('list_runs', { session_id: 's1' })).map((r) => r.run_id), [a.run_id])
  assert.equal((await h.call('list_runs', {})).length, 2)
})

const QUESTIONS = [
  { id: 'path', header: 'Route', question: 'Which way?', options: [{ label: 'Retry (Recommended)', description: 'try again' }, { label: 'Rewrite' }, { label: 'Stop' }] },
  { id: 'notes', question: 'Anything else?', multiSelect: true, options: [{ label: 'Log' }, { label: 'Test' }] },
]

test('a question ends the wait at once, carries the questions, and dsh_answer replies', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  await sleep(20)
  let uiRequest
  const reply = h.ask('s1', QUESTIONS, (request) => { uiRequest = request; return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('ASK_ABORTED')))) })
  const w = await waiting
  assert.equal(w.needs_input, 'answer')
  assert.equal(w.state, 'waiting')
  assert.equal(w.question.count, 2)
  assert.deepEqual(w.question.questions[0].options.map((o) => [o.number, o.label, !!o.recommended]), [[1, 'Retry (Recommended)', true], [2, 'Rewrite', false], [3, 'Stop', false]])
  assert.equal(w.question.questions[1].multi_select, true)
  // A second wait does not return the same question again: it blocks.
  assert.equal((await h.call('wait', { run_id: run.run_id, timeout_s: 0.3 })).timed_out, true)
  // One question at a time: nothing reaches Harness until both have an answer.
  const first = await h.call('answer', { run_id: run.run_id, answers: [{ id: 'path', choose: [2] }] })
  assert.deepEqual([first.submitted, first.remaining], [false, ['notes']])
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ id: 'notes', choose: ['Nope'] }] }), /no option "Nope"/)
  const done = await h.call('answer', { run_id: run.run_id, answers: [{ id: 'notes', choose: ['log', 'Test'], text: 'and docs' }] })
  assert.equal(done.submitted, true)
  // The Harness window is told to drop its card.
  assert.equal(uiRequest.signal.aborted, true)
  assert.deepEqual(await reply, { answers: [{ id: 'path', selected: ['Rewrite'] }, { id: 'notes', selected: ['Log', 'Test'], custom: 'and docs' }] })
  await sleep(10)
  const st = await h.call('status', { run_id: run.run_id })
  assert.equal(st.question, undefined)
  assert.ok(st.recent_events.some((e) => e.type === 'question_answered' && e.by === 'dsh-baton'))
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ skip: true }] }), /no open question/)
})

test('free text replaces a single choice, skip works, and the Harness UI can answer first', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  const reply = h.ask('s1', QUESTIONS)
  await h.call('answer', { run_id: run.run_id, answers: [{ id: 'path', choose: [1], text: 'my own way' }, { id: 'notes', skip: true }] })
  assert.deepEqual(await reply, { answers: [{ id: 'path', selected: [], custom: 'my own way' }, { id: 'notes', selected: [] }] })
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ id: 'path', choose: [1, 2] }] }), /no open question/)
  // The user answers in the Harness window: the run follows, dsh_answer then has nothing to answer.
  const fromUi = { answers: [{ id: 'one', selected: ['A'] }] }
  const r2 = h.ask('s1', [{ id: 'one', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }], async () => fromUi)
  assert.deepEqual(await r2, fromUi)
  await sleep(10)
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ choose: [2] }] }), /no open question/)
  assert.ok((await h.call('status', { run_id: run.run_id })).recent_events.some((e) => e.type === 'question_answered' && e.by === 'harness'))
})

test('a question in a session with no relayed run is left to Harness', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  let passed = false
  await h.ask('other', QUESTIONS, async () => { passed = true; return { answers: [] } })
  assert.equal(passed, true)
})

test('an approval wait (no question) also ends the wait once, and dsh_answer says it cannot help', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  h.emit(...s.status('waiting'))
  const w = await waiting
  assert.deepEqual([w.needs_input, w.state, w.question], ['harness-ui', 'waiting', undefined])
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ skip: true }] }), /cannot be answered from here/)
})

// --- choosing a model --------------------------------------------------------

const CATALOG = [
  { id: 'deepseek-account', name: 'DeepSeek', models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
  ] },
]

// Harness's model side as its session controller and default-model service behave:
// selectModel installs the pick for the session and saves it as the default in the
// background; saves commit in the order they are made, each after a delay, and the
// default reads the last committed one.
function fakeModels({ groups = CATALOG, saveMs = () => 20, selectModel = true, defaultService = true } = {}) {
  const state = { default: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }, sessions: {}, saves: [], order: [] }
  let chain = Promise.resolve()
  const agentDefaultModel = {
    currentSelection: () => ({ ...state.default }),
    saveSelection(next) {
      const saved = chain.then(() => sleep(saveMs())).then(() => { state.default = { ...next }; state.saves.push({ ...next }) })
      chain = saved.catch(() => {})
      return saved
    },
  }
  const fake = { state, agentDefaultModel: defaultService ? agentDefaultModel : undefined, settled: () => chain }
  fake.controller = {
    modelCatalog: async () => ({ default: { ...state.default }, routableProviders: groups.map((g) => g.id), groups, failures: [] }),
    projections: async ({ sessionId }) => ({ kind: 'sequenced', asOfSeq: 1, values: { modelSelection: { lastUsed: null, next: state.sessions[sessionId] ?? null } } }),
    ...(selectModel ? {
      selectModel: async (r) => {
        const entry = groups.find((g) => g.id === r.provider)?.models.find((m) => m.id === r.model)
        if (!entry) throw new Error('session/model-unavailable')
        const selected = { provider: r.provider, model: r.model, ...(r.reasoningEffort ?? entry.reasoning?.defaultEffort ? { reasoningEffort: r.reasoningEffort ?? entry.reasoning.defaultEffort } : {}) }
        state.sessions[r.sessionId] = selected
        state.order.push(`select:${r.sessionId}`)
        agentDefaultModel.saveSelection(selected).catch(() => {})
        return { selected: { ...selected } }
      },
    } : {}),
  }
  return fake
}

test('a send on the DeepSeek account is refused when every wallet is empty; any balance, a failed read or another provider lets it through', async (t) => {
  const m = fakeModels({ groups: [...CATALOG, { id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] })
  let balance = { status: 'ready', value: [{ currency: 'CNY', balance: '0.00' }], bonusWallets: [{ currency: 'CNY', balance: '0' }] }
  const reads = []
  const account = { getBalance: async (client) => { reads.push(client); if (balance instanceof Error) throw balance; return balance } }
  const h = startHost({ models: m, account }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'go', session_id: 's1' }), /No message was sent: the DeepSeek account has no balance left \(CNY 0\.00, CNY 0\)/)
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w' }), /Session new-1 was created, but no message was sent: the DeepSeek account has no balance left/)
  assert.equal(m.calls.prompt.length, 0, 'nothing reached Harness')
  assert.equal(typeof reads[0].version, 'string')
  assert.equal(typeof reads[0].timezoneOffsetSeconds, 'number')
  // Another provider: the account balance is not its business.
  await h.call('send', { message: 'go', session_id: 's2', model: 'deepseek-api/deepseek-chat' })
  assert.equal(m.calls.prompt.length, 1)
  for (const b of [null, { status: 'failed' }, new Error('platform down')]) {
    balance = b
    await h.call('send', { message: 'go', session_id: 's1' })
  }
  assert.equal(m.calls.prompt.length, 4, 'not signed in, a failed read or an error: sent')
  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '0.00' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }] }
  await h.call('send', { message: 'go', session_id: 's1' })
  const before = reads.length
  balance = { status: 'ready', value: [], bonusWallets: [] }
  await h.call('send', { message: 'go', session_id: 's1' })
  assert.equal(reads.length, before, 'a balance seen in the last minute is not read again')
  assert.equal(m.calls.prompt.length, 6)
})

test('model matches Harness\'s catalog by id or name, ignoring case, spaces, hyphens and a DeepSeek prefix', async (t) => {
  const m = fakeModels()
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  for (const asked of ['V4 Pro', 'v4-pro', 'DeepSeek-V4-Pro', 'deepseek v4 pro', 'DEEPSEEK_V4_PRO', 'deepseek-account/V4 Pro']) {
    const r = await h.call('send', { message: 'go', cwd: '/w', model: asked })
    assert.deepEqual(r.model, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoning_effort: 'high' }, asked)
    assert.equal(r.model_source, 'requested')
  }
  const flash = await h.call('send', { message: 'go', cwd: '/w', model: 'V4.1 Flash' })
  assert.equal(flash.model.model, 'deepseek-v4.1-flash')
  const status = await h.call('status', { run_id: flash.run_id })
  assert.equal(status.model.model, 'deepseek-v4.1-flash', 'dsh_status shows the run\'s model')
})

test('a model added to the catalog later (V4.1 Pro) is found with no change here', async (t) => {
  const groups = [{ ...CATALOG[0], models: [...CATALOG[0].models, { id: 'deepseek-v4.1-pro', name: 'DeepSeek-V4.1-Pro' }] }]
  const m = fakeModels({ groups })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  assert.equal((await h.call('send', { message: 'go', cwd: '/w', model: 'V4.1 Pro' })).model.model, 'deepseek-v4.1-pro')
  assert.equal((await h.call('send', { message: 'go', cwd: '/w', model: 'v4 pro' })).model.model, 'deepseek-v4-pro', 'V4 Pro is still its own model')
})

test('a model that matches nothing, or several, fails the send before anything is created, listing what is there', async (t) => {
  const groups = [...CATALOG, { id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] }]
  const m = fakeModels({ groups })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w', model: 'V5 Ultra' }), /No model in Harness matches "V5 Ultra"\. Available: deepseek-account\/deepseek-v4\.1-flash \(DeepSeek-V4\.1-Flash\), deepseek-account\/deepseek-v4-pro/)
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w', model: 'Pro' }), /No model in Harness matches "Pro"/, 'a part of a name is no match')
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w', model: 'V4 Pro' }), /matches several models: deepseek-account\/deepseek-v4-pro, deepseek-api\/deepseek-v4-pro\. Pass one of them as provider\/model/)
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w', model: 'deepseek-account/V4 Pro', reasoning_effort: 'max' }), /has no reasoning effort "max"; it has low, high/)
  assert.equal(m.calls.create.length, 0)
  assert.equal(m.calls.prompt.length, 0)
  assert.equal((await h.call('send', { message: 'go', cwd: '/w', model: 'deepseek-api/v4-pro' })).model.provider, 'deepseek-api')
})

test('the model is set on the session before its prompt, and Harness\'s default model is left as it was', async (t) => {
  const m = fakeModels()
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  const original = { ...m.state.default }
  const r = await h.call('send', { message: 'go', session_id: 's1', model: 'V4 Pro', reasoning_effort: 'Low' })
  assert.deepEqual(r.model, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoning_effort: 'low' })
  assert.equal(m.calls.prompt.length, 1)
  assert.deepEqual(m.state.order, ['select:s1'])
  await m.settled()
  assert.deepEqual(m.state.default, original, 'the default ends where it was')
  assert.deepEqual(m.state.saves.at(-1), original, 'and the restore is the last save')
  // Effort alone keeps the session's model.
  const e = await h.call('send', { message: 'again', session_id: 's1', reasoning_effort: 'high' })
  assert.deepEqual(e.model, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoning_effort: 'high' })
  // Nothing asked: an existing session keeps its own model, untouched.
  const before = m.state.order.length
  const keep = await h.call('send', { message: 'more', session_id: 's1' })
  assert.equal(keep.model.model, 'deepseek-v4-pro')
  assert.equal(keep.model_source, 'session')
  assert.equal(m.state.order.length, before, 'no selectModel for it')
  await m.settled()
  assert.deepEqual(m.state.default, original)
})

test('concurrent sends with different models and slow, uneven default saves leave the default as it was', async (t) => {
  let n = 0
  const m = fakeModels({ saveMs: () => [60, 5, 30, 1, 45][n++ % 5] })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  const original = { ...m.state.default }
  const sends = await Promise.all([
    h.call('send', { message: 'a', cwd: '/w', model: 'V4 Pro' }),
    h.call('send', { message: 'b', cwd: '/w' }),
    h.call('send', { message: 'c', cwd: '/w', model: 'V4.1 Flash', reasoning_effort: 'low' }),
    h.call('send', { message: 'd', cwd: '/w', model: 'V4 Pro' }),
    h.call('send', { message: 'e', cwd: '/w' }),
  ])
  assert.deepEqual(sends.map((s) => s.model.model), ['deepseek-v4-pro', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash'])
  // A new session without model is pinned to the default as it stood, never to another send's pick.
  for (const i of [1, 4]) {
    assert.equal(sends[i].model_source, 'default')
    assert.deepEqual(m.state.sessions[sends[i].session_id], original)
  }
  await m.settled()
  assert.deepEqual(m.state.default, original)
  assert.deepEqual(m.state.saves.at(-1), original)
  // The next pick after the spell reads the default afresh.
  m.state.default = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
  await h.call('send', { message: 'f', cwd: '/w', model: 'V4.1 Flash' })
  await m.settled()
  assert.equal(m.state.default.model, 'deepseek-v4-pro', 'a default the user changed in between is kept')
})

test('a Harness without selectModel/modelCatalog, or without its default-model service, refuses model clearly and still sends without it', async (t) => {
  const old = fakeModels({ selectModel: false })
  const h = startHost({ models: old }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'go', cwd: '/w', model: 'V4 Pro' }), /cannot choose a model per session/)
  assert.equal(old.calls.create.length, 0)
  const plain = await h.call('send', { message: 'go', cwd: '/w' })
  assert.equal(plain.state, 'queued')
  assert.equal(old.calls.prompt.length, 1)

  const noDefault = fakeModels({ defaultService: false })
  const h2 = startHost({ models: noDefault }); t.after(h2.close); await h2.ready
  await assert.rejects(h2.call('send', { message: 'go', session_id: 's1', model: 'V4 Pro' }), /No message was sent: the model could not be set \(.*keep its default model/)
  assert.equal(noDefault.calls.prompt.length, 0)
  assert.equal(noDefault.state.order.length, 0, 'selectModel was never called, so the default never moved')
  assert.equal((await h2.call('send', { message: 'go', cwd: '/w' })).state, 'queued')

  const bare = startHost(); t.after(bare.close); await bare.ready
  await assert.rejects(bare.call('models'), /cannot choose a model per session/)
})

test('models lists the catalog and the default; list_sessions shows each session\'s model', async (t) => {
  const m = fakeModels()
  const sessions = [{ sessionId: 's1', title: 'A', projections: { values: { modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, next: null } } } }, { sessionId: 's2', title: 'B' }]
  const h = startHost({ models: m, sessions }); t.after(h.close); await h.ready
  const r = await h.call('models')
  assert.deepEqual(r.default, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoning_effort: 'high' })
  assert.deepEqual(r.models.map((x) => x.name), ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro'])
  assert.deepEqual(r.models[1].reasoning_efforts, ['low', 'high'])
  const list = await h.call('list_sessions')
  assert.equal(list[0].model.model, 'deepseek-v4-pro')
  assert.equal(list[1].model, null)
})

test('Harness\'s default-model service is taken through inject, as Harness requires', async (t) => {
  const m = fakeModels()
  m.viaInject = true
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  const original = { ...m.state.default }
  const [pro, plain] = await Promise.all([
    h.call('send', { message: 'a', cwd: '/w', model: 'DeepSeek-V4 Pro' }),
    h.call('send', { message: 'b', cwd: '/w' }),
  ])
  assert.equal(pro.model.model, 'deepseek-v4-pro')
  assert.deepEqual(m.state.sessions[plain.session_id], original)
  await m.settled()
  assert.deepEqual(m.state.default, original)

  // Without the service at all, a send without model still goes through, unpinned.
  const none = fakeModels({ defaultService: false })
  none.viaInject = true
  const h2 = startHost({ models: none }); t.after(h2.close); await h2.ready
  const r = await h2.call('send', { message: 'b', cwd: '/w' })
  assert.equal(r.state, 'queued')
  assert.equal(r.model_source, 'default')
  assert.equal(none.state.order.length, 0)
})
