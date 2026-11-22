// Simulation tests for the dsh-baton-host plugin: a fake Harness host context
// drives the plugin through the same events Harness emits, and the tests talk
// to it over its real local socket. No Harness installation is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../host/lib/index.js'
import { socketEndpoint } from '../host/lib/socket.js'

// A real folder for sends that start a session: a missing one is refused.
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ws-'))

const IS_WIN = process.platform === 'win32'
// Switching the plugin on registers the MCP server in the user's real config files: off
// here, except in the test that points it at a throwaway home.
process.env.DSH_BATON_AUTO_REGISTER = '0'

// goal: sessionId -> the goal projection's wire value (Harness's values.goal);
// log: sessionId -> the session's event log as inspect returns it; goals / agents: Harness's
// goals and agents services, reached through inject.
function startHost({ activity = () => [], sessions = [], workspaces = [], archived = [], sock: sockPath, home, web, settings, queue = false, recheckMs = 300, models, account, goal, log, goals, agents, agentTeams, promptGate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-'))
  // Run records go to the bridge home: keep them out of the real ~/.dsh-baton.
  const homeDir = home ?? path.join(dir, 'bridge')
  process.env.DSH_BATON_HOME = homeDir
  const sock = sockPath ?? path.join(dir, 'h.sock')
  const endpoint = socketEndpoint(sock) // where the host listens: the path itself, or a named pipe on Windows
  const logs = []
  const handlers = {}
  const disposers = []
  const calls = { prompt: [], create: [], cancel: [], stop: [], rename: [], updateQueue: [], events: [] }
  // Harness's inbox per session, as its projections report it (queue: true turns it on).
  const inbox = {}
  const pending = (id) => (inbox[id] ??= { 'next-turn': [], 'next-step': [] })
  const ws = workspaces.map((w) => ({ sessionIds: [], ...w, setTitle: async function (t) { this.title = t } }))
  const ctx = {
    on: (ev, fn) => (handlers[ev] ??= []).push(fn),
    effect: (fn) => disposers.push(fn()),
    waterfall: async (ev, { sessionId }) => activity(sessionId),
    logger: { info: () => {}, error: (m) => logs.push(m) },
    ...(web || settings || models?.viaInject || account || goals || agents || agentTeams ? {
      inject: (deps, fn) => {
        const services = { webServer: web, settings, agentDefaultModel: models?.viaInject ? models.agentDefaultModel : undefined, accountController: account, goals, agents, agentTeams }
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
      // DSHB_TEST_PAGED=1 stands in for Harness 0.2.2: no inspect, only paged history (two events
      // a page, so every log is read back across several pages) and the folder in the list.
      ...(process.env.DSHB_TEST_PAGED === '1' ? {
        // Harness lists every visible session; here that is the given rows plus the logged ones.
        list: async () => ({ items: [...sessions.map((s) => ({ cwd: '/w', ...s })), ...Object.keys(log ?? {}).filter((id) => !sessions.some((s) => s.sessionId === id)).map((sessionId) => ({ sessionId, cwd: '/w' }))] }),
        events: async ({ address, throughSeq, beforeSeq }) => {
          calls.events.push({ sessionId: address.sessionId, beforeSeq })
          const all = (log?.[address.sessionId] ?? []).map((e, i) => ({ seq: i, ...e }))
          const cut = throughSeq ?? all.length - 1
          const upto = all.filter((e) => e.seq <= cut && (beforeSeq === undefined || e.seq < beforeSeq))
          const page = upto.slice(-2)
          return { cursor: cut, records: page.map((event) => ({ type: 'event', event })), hasMore: upto.length > page.length }
        },
      } : {
        list: async () => ({ items: sessions }),
        inspect: async (id) => ({ meta: { cwd: '/w' }, events: log?.[id] ?? [] }),
      }),
      create: async (r) => { calls.create.push(r); return { sessionId: `new-${calls.create.length}` } },
      prompt: async (r) => {
        calls.prompt.push(r)
        if (promptGate) await promptGate
        if (queue) pending(r.sessionId)[r.mode === 'steer' ? 'next-step' : 'next-turn'].push({ id: `m${calls.prompt.length}`, content: r.content, source: { kind: 'user', rpcId: r.requestId } })
        return { accepted: true }
      },
      // Harness's wire view of the goal projection: the current goal itself, or null.
      ...(goal && !queue ? { projections: async ({ sessionId }) => ({ kind: 'sequenced', asOfSeq: 1, values: { goal: goal[sessionId] ?? null } }) } : {}),
      ...(queue ? {
        projections: async ({ sessionId }) => ({ kind: 'sequenced', asOfSeq: 1, values: { inbox: pending(sessionId), ...(goal ? { goal: goal[sessionId] ?? null } : {}) } }),
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
  // Harness asking for an approval: the approval/request waterfall, the Harness UI as `next`.
  const approve = (sessionId, toolName = 'bash', ui = async () => 'rejected', reason = 'write outside the workspace') => handlers['approval/request'][0]({ agent: { id: sessionId }, toolName, reason }, () => ui())
  return { ctx, emit, ask, approve, call, calls, ready, close, ws, logs, sock, inbox: pending, home: homeDir }
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

// It registers this repo's own server, which it only does for a git checkout (an unpacked copy is copied to the app folder).
test('switched on, the plugin registers the MCP server and serves the outcome to the Plugins page', { skip: !fs.existsSync(path.join(import.meta.dirname, '..', '.git')) && 'needs a git checkout' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  const saved = { ...process.env }
  t.after(() => { process.env = saved; fs.rmSync(dir, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(dir, '.claude'))
  fs.mkdirSync(path.join(dir, '.codex'))
  Object.assign(process.env, { HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: path.join(dir, '.codex'), DSH_BATON_AUTO_REGISTER: '1' })
  const routes = {}
  const h = startHost({ home: path.join(dir, '.dsh-baton'), web: { register: (r) => { routes[r.path] = r; return () => { delete routes[r.path] } } } })
  t.after(h.close)
  assert.ok(routes['/dsh-baton/status'] && routes['/dsh-baton/handover'], Object.keys(routes).join(', '))
  const route = routes['/dsh-baton/status']
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
  assert.deepEqual(s.registration.clients.map((c) => [c.id, c.state]), [['claude', 'registered'], ['codex', 'registered'], ['antigravity', 'not-installed']])
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
  const r = await h.call('send', { cwd: W, message: 'hi' })
  assert.deepEqual(h.calls.create, [{ workspaceId: 'w1' }])
  assert.equal(r.session_id, 'new-1')
  assert.equal(r.workspace.created, true)
})

test('a hand-over to a folder inside the conversation folder joins its workspace', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const coding = path.join(root, 'Coding')
  const app = path.join(coding, 'app')
  const other = path.join(root, 'Other')
  for (const d of [app, other]) fs.mkdirSync(d, { recursive: true })
  const h = startHost({ workspaces: [{ id: 'w1', path: coding, title: 'Coding' }] }); t.after(h.close); await h.ready
  const r = await h.call('send', { cwd: app, conversation_folder: coding, message: 'hi' })
  assert.deepEqual(h.calls.create[0], { workspaceId: 'w1' })
  assert.equal(r.workspace.created, false)
  assert.equal(r.work_folder, app)
  const esc = (p) => p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  assert.match(h.calls.prompt[0].content[0].text, new RegExp(`^\\(Working folder for this task: ${esc(app)}\\. Run every command there[^]*\\)\\n\\nhi$`))
  // The conversation folder itself: as before, no note.
  const same = await h.call('send', { cwd: coding, conversation_folder: coding, message: 'hi' })
  assert.equal(same.work_folder, undefined)
  assert.equal(h.calls.prompt[1].content[0].text, 'hi')
  // Outside the conversation folder: the conversation's workspace too (since 2026-11-20), with the note.
  const out = await h.call('send', { cwd: other, conversation_folder: coding, message: 'hi' })
  assert.equal(out.workspace.id, 'w1')
  assert.equal(out.work_folder, other)
  // No conversation folder (an older MCP server): its own workspace.
  const old = await h.call('send', { cwd: app, message: 'hi' })
  assert.equal(old.workspace.path, app)
})

test('folders made per conversation share one workspace', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const chat = path.join(root, 'Documents', 'Codex', '2026-11-17', 'new-chat')
  const scratch = path.join(root, 'Claude', 'scratch-workspaces', 'a1', 'b2', 'scratch-2026-11-17-ab12cd')
  const proj = path.join(root, 'proj')
  const tree = path.join(proj, '.claude', 'worktrees', 'fix-x')
  const codexTree = path.join(root, '.codex', 'worktrees', '1a2b', 'proj')
  for (const d of [chat, scratch, tree, codexTree]) fs.mkdirSync(d, { recursive: true })
  const h = startHost(); t.after(h.close); await h.ready
  const a = await h.call('send', { cwd: chat, conversation_folder: chat, message: 'hi' })
  assert.equal(a.workspace.path, path.join(root, 'Documents', 'Codex'))
  assert.equal(a.workspace.title, 'Codex chats')
  assert.equal(a.work_folder, chat)
  // A second chat joins the same workspace.
  const chat2 = path.join(root, 'Documents', 'Codex', '2026-11-18', 'new-chat-2')
  fs.mkdirSync(chat2, { recursive: true })
  const b = await h.call('send', { cwd: chat2, conversation_folder: chat2, message: 'hi' })
  assert.equal(b.workspace.id, a.workspace.id)
  assert.equal(b.workspace.created, false)
  const c = await h.call('send', { cwd: scratch, message: 'hi' })
  assert.equal(c.workspace.path, path.join(root, 'Claude', 'scratch-workspaces'))
  assert.equal(c.workspace.title, 'Claude scratch')
  const d = await h.call('send', { cwd: tree, conversation_folder: tree, message: 'hi' })
  assert.equal(d.workspace.path, path.join(proj, '.claude', 'worktrees'), 'the folder holding the worktrees, never the main checkout')
  assert.equal(d.workspace.title, 'Claude worktrees')
  assert.equal(d.work_folder, tree)
  const e = await h.call('send', { cwd: codexTree, conversation_folder: codexTree, message: 'hi' })
  assert.equal(e.workspace.path, path.join(root, '.codex', 'worktrees'))
  // A Codex chat handing over a real project elsewhere: the project's own workspace, no note.
  const f = await h.call('send', { cwd: proj, conversation_folder: chat, message: 'hi' })
  assert.equal(f.workspace.path, proj)
  assert.equal(f.work_folder, undefined)
})

test('Claude Code scratchpads and Antigravity scratch folders share one workspace each', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tmp = path.join(root, 'claude-501')
  const pad = (session, ...sub) => path.join(tmp, '-Users-me-Coding', session, 'scratchpad', ...sub)
  const proj = path.join(root, 'Coding')
  const ag = path.join(root, '.gemini', 'antigravity')
  const dirs = [pad('s1', 'dshws', 'g1_dsh_1'), pad('s1', 'dshws', 'g1_dsh_2'), pad('s2'), path.join(ag, 'scratch', 'demo'), path.join(ag, 'brain', 'c-1'), proj]
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  const h = startHost(); t.after(h.close); await h.ready
  // The 2026-11-20 case: a conversation in Coding gives each independent reviewer its own scratchpad subfolder.
  const [a, b, c] = []
    .concat(await h.call('send', { cwd: dirs[0], conversation_folder: proj, message: 'hi' }))
    .concat(await h.call('send', { cwd: dirs[1], conversation_folder: proj, message: 'hi' }))
    .concat(await h.call('send', { cwd: dirs[2], conversation_folder: dirs[2], message: 'hi' }))
  assert.equal(a.workspace.path, tmp)
  assert.equal(a.workspace.title, 'Claude scratch')
  assert.equal(a.work_folder, dirs[0])
  assert.equal(b.workspace.id, a.workspace.id)
  assert.equal(b.work_folder, dirs[1])
  assert.equal(c.workspace.id, a.workspace.id, 'another conversation\'s scratchpad joins too')
  const d = await h.call('send', { cwd: dirs[3], message: 'hi' })
  assert.equal(d.workspace.path, path.join(ag, 'scratch'))
  assert.equal(d.workspace.title, 'Antigravity scratch')
  const e = await h.call('send', { cwd: dirs[4], message: 'hi' })
  assert.equal(e.workspace.path, path.join(ag, 'brain'))
  // A real project is untouched.
  const f = await h.call('send', { cwd: proj, conversation_folder: proj, message: 'hi' })
  assert.equal(f.workspace.path, proj)
})

test('folders outside the conversation folder join the nearest workspace, else the conversation folder', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-out-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const coding = path.join(root, 'Coding')
  const day = path.join(root, 'DevData', 'paper', 'reviews', '2026-11-20')
  const known = path.join(root, 'DevData', 'app')
  const dirs = [path.join(day, 'g4'), path.join(day, 'g5'), path.join(known, 'sub'), coding]
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  const h = startHost({ workspaces: [{ id: 'w-coding', path: coding, title: 'Coding' }, { id: 'w-app', path: known, title: 'app' }] }); t.after(h.close); await h.ready
  // The 2026-11-20 case: a chat in Coding gives each reviewer a folder on another disk.
  const a = await h.call('send', { cwd: dirs[0], conversation_folder: coding, message: 'hi' })
  const b = await h.call('send', { cwd: dirs[1], conversation_folder: coding, message: 'hi' })
  assert.equal(a.workspace.id, 'w-coding')
  assert.equal(a.work_folder, dirs[0])
  assert.equal(b.workspace.id, 'w-coding')
  assert.equal(b.work_folder, dirs[1])
  const c = await h.call('send', { cwd: dirs[2], conversation_folder: coding, message: 'hi' })
  assert.equal(c.workspace.id, 'w-app', 'a folder inside another workspace joins that one')
  assert.equal(c.work_folder, dirs[2])
  // No conversation folder: the folder itself, as before.
  const d = await h.call('send', { cwd: dirs[0], message: 'hi' })
  assert.equal(d.workspace.path, dirs[0])
})

test('a linked Git worktree inside the conversation folder, or a folder that is a workspace already, is not grouped into the parent', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-group-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const wt = path.join(root, 'wt')
  const app = path.join(root, 'app')
  fs.mkdirSync(wt, { recursive: true }); fs.mkdirSync(app, { recursive: true })
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'wt')}\n`)
  const h = startHost({ workspaces: [{ id: 'w-app', path: app, title: 'app' }] }); t.after(h.close); await h.ready
  const a = await h.call('send', { cwd: wt, conversation_folder: root, message: 'hi' })
  assert.equal(a.workspace.path, wt, 'a worktree is a checkout of its own')
  assert.equal(a.work_folder, undefined)
  const b = await h.call('send', { cwd: app, conversation_folder: root, message: 'hi' })
  assert.equal(b.workspace.id, 'w-app', 'a workspace from before keeps its sessions')
  assert.equal(b.work_folder, undefined)
  // A message starting with a path is not a /command: the note goes before it, whole.
  const sub = path.join(root, 'sub'); fs.mkdirSync(sub)
  const c = await h.call('send', { cwd: sub, conversation_folder: root, message: '/Users/me/x.js has a bug' })
  assert.equal(c.work_folder, sub)
  assert.match(h.calls.prompt.at(-1).content[0].text, /^\(Working folder for this task: [^]*\)\n\n\/Users\/me\/x\.js has a bug$/)
})

test('send to a folder that does not exist says so plainly, and creates nothing', async (t) => {
  // Also when the folder is a workspace already (registered while its drive was connected).
  const gone = path.join(W, 'gone', 'proj')
  const h = startHost({ workspaces: [{ id: 'w1', path: gone, title: 'proj' }] }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { cwd: gone, message: 'hi' }),
    /^Error: The folder .*proj does not exist, so no session was started and nothing was sent\. Check the path \(a project on an external drive needs that drive connected\)/)
  assert.deepEqual(h.calls.create, [])
  assert.equal(fs.existsSync(path.join(W, 'gone')), false)
  // By workspace_id, a folder never registered, and a file where a folder should be: the same.
  await assert.rejects(h.call('send', { workspace_id: 'w1', message: 'hi' }), /^Error: The folder .*proj \(workspace w1\) does not exist/)
  await assert.rejects(h.call('send', { cwd: path.join(W, 'never', 'seen'), message: 'hi' }), /does not exist, so no session was started/)
  const file = path.join(W, 'a-file.txt')
  fs.writeFileSync(file, '')
  await assert.rejects(h.call('send', { cwd: file, message: 'hi' }), /a-file\.txt does not exist/)
  assert.deepEqual(h.calls.create, [])
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

// A background job (a test run, a build, a search) wakes the agent when it ends for a turn that
// is about the job, not about the task: that turn's text goes after the reply, not in its place.
test('a run that waited only on a background job keeps its reply; the job follow-up comes after it', async (t) => {
  let busyUntil = Date.now() + 2500
  const h = startHost({ activity: () => (Date.now() < busyUntil ? [{ kind: 'job', items: [{ id: 'j', label: 'npm test' }] }] : []) })
  t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'review it' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('the full review')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  await sleep(500)
  const mid = await h.call('status', { run_id: run.run_id })
  assert.equal(mid.state, 'running')
  assert.equal(mid.waiting_on[0].kind, 'job')
  setTimeout(() => { h.emit(...s.status('running')); h.emit(...s.text('that job ended')); h.emit(...s.turnEnd()); h.emit(...s.status('idle')) }, 2600)
  const done = await h.call('wait', { run_id: run.run_id, timeout_s: 10 })
  assert.equal(done.state, 'completed')
  assert.equal(done.final_text, 'the full review\n\nthat job ended')
})

// A job that does not end (a search over the whole home folder ran for 15 minutes, Mac,
// 2026-11-22) must not hold the reply back: past the limit the run completes, saying what is left.
test('a background job still running long after the turn ended does not hold the run open', async (t) => {
  process.env.DSH_BATON_JOB_WAIT_MS = '1500'
  t.after(() => { delete process.env.DSH_BATON_JOB_WAIT_MS })
  const h = startHost({ activity: () => [{ kind: 'job', items: [{ id: 'j', label: 'grep -rl x ~' }] }] })
  t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'review it' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('the full review')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  const done = await h.call('wait', { run_id: run.run_id, timeout_s: 15 })
  assert.equal(done.state, 'completed')
  assert.equal(done.final_text, 'the full review')
  assert.deepEqual(done.left_running, [{ kind: 'job', count: 1, labels: ['grep -rl x ~'] }])
  assert.equal(done.waiting_on, undefined)
})

// Sub-agents are part of the task: the run waits for them however long they take.
test('sub-agents still running are waited for past the job limit', async (t) => {
  process.env.DSH_BATON_JOB_WAIT_MS = '500'
  t.after(() => { delete process.env.DSH_BATON_JOB_WAIT_MS })
  let busyUntil = Date.now() + 3500
  const h = startHost({ activity: () => (Date.now() < busyUntil ? [{ kind: 'subagent', items: [{ id: 'c', label: 'child' }] }] : []) })
  t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'fan out' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId))
  h.emit(...s.text('started children')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  await sleep(2000)
  assert.equal((await h.call('status', { run_id: run.run_id })).state, 'running')
  setTimeout(() => { h.emit(...s.status('running')); h.emit(...s.text('all children done')); h.emit(...s.turnEnd()); h.emit(...s.status('idle')) }, 1700)
  const done = await h.call('wait', { run_id: run.run_id, timeout_s: 10 })
  assert.equal(done.final_text, 'all children done', 'a sub-agent summary is the reply')
  assert.equal(done.left_running, undefined)
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
  const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-real-')))
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

test('a run whose session is still at work when the plugin is reloaded is taken up again and finishes as usual', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const h1 = startHost({ home }); await h1.ready
  const live = await h1.call('send', { session_id: 'B', message: 'long' })
  const queued = await h1.call('send', { session_id: 'C', message: 'sub-agents only' })
  const b = S('B'); const c = S('C')
  h1.emit(...b.turnStart()); h1.emit(...b.userMessage(h1.calls.prompt[0].requestId)); h1.emit(...b.text('half way'))
  h1.emit(...c.turnStart()); h1.emit(...c.userMessage(h1.calls.prompt[1].requestId))
  h1.close() // switched off (or updated) while Harness goes on
  // B's turn still runs; C's turn ended unseen and one sub-agent is left.
  let bBusy = true
  let cBusy = true
  const h2 = startHost({ home, activity: (id) => (id === 'B' && bBusy ? [{ kind: 'turn', items: [{ id: 't' }] }] : id === 'C' && cBusy ? [{ kind: 'agent', items: [{ id: 'sub' }] }] : []) })
  t.after(h2.close); await h2.ready
  await new Promise((r) => setTimeout(r, 50))
  const st = await h2.call('status', { run_id: live.run_id })
  assert.notEqual(st.state, 'interrupted')
  assert.ok(st.recent_events.some((e) => e.type === 'plugin_reloaded'))
  const b2 = S('B')
  h2.emit(...b2.text('all done')); bBusy = false; h2.emit(...b2.turnEnd())
  h2.emit('agent/status', { agent: { id: 'B' }, status: 'idle' })
  cBusy = false
  const [wb, wc] = await Promise.all([h2.call('wait', { run_id: live.run_id, timeout_s: 10 }), h2.call('wait', { run_id: queued.run_id, timeout_s: 10 })])
  assert.equal(wc.state, 'completed', 'C ends once its last sub-agent is done, though its turn end was missed')
  assert.equal(wb.state, 'completed')
  assert.equal(wb.final_text, 'all done')
})

test('a send Harness is slow to take in comes back after the admission wait; Harness refusing it later fails the run', async (t) => {
  process.env.DSH_BATON_ADMIT_WAIT_MS = '300'
  t.after(() => { delete process.env.DSH_BATON_ADMIT_WAIT_MS })
  let refuse
  const promptGate = new Promise((_, reject) => { refuse = reject })
  promptGate.catch(() => {})
  const h = startHost({ promptGate }); t.after(h.close); await h.ready
  const t0 = Date.now()
  const r = await h.call('send', { session_id: 's1', message: 'hi' })
  assert.ok(Date.now() - t0 < 5000, `send came back while Harness had not answered (${Date.now() - t0} ms)`)
  assert.equal(r.admission_pending, true)
  assert.equal(r.state, 'queued')
  refuse(new Error('Harness refused the prompt'))
  const w = await h.call('wait', { run_id: r.run_id, timeout_s: 5 })
  assert.equal(w.state, 'failed')
  assert.match(w.error, /refused the prompt/)
})

test('a run taken up after a reload is not marked interrupted while Harness cannot say yet whether its session is busy', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const h1 = startHost({ home }); await h1.ready
  const live = await h1.call('send', { session_id: 'B', message: 'long' })
  const b = S('B')
  h1.emit(...b.turnStart()); h1.emit(...b.userMessage(h1.calls.prompt[0].requestId))
  h1.close()
  let reads = 0
  const h2 = startHost({ home, activity: () => { reads++; if (reads === 1) throw new Error('not ready'); return [{ kind: 'turn', items: [{ id: 't' }] }] } })
  t.after(h2.close); await h2.ready
  await new Promise((r) => setTimeout(r, 3500))
  const st = await h2.call('status', { run_id: live.run_id })
  assert.notEqual(st.state, 'interrupted', 'the first read failed; the second found the session busy')
  assert.ok(st.recent_events.some((e) => e.type === 'plugin_reloaded'))
})

test('a run whose message Harness had not taken in at a reload is looked for a while, then ends interrupted and wakes a wait', async (t) => {
  process.env.DSH_BATON_ADMIT_WAIT_MS = '100'
  process.env.DSH_BATON_TAKE_UP_ADMIT_MS = '1500'
  t.after(() => { delete process.env.DSH_BATON_ADMIT_WAIT_MS; delete process.env.DSH_BATON_TAKE_UP_ADMIT_MS })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const h1 = startHost({ home, promptGate: new Promise(() => {}) }); await h1.ready
  const r = await h1.call('send', { session_id: 'Q', message: 'cold start' })
  assert.equal(r.admission_pending, true)
  h1.close()
  const h2 = startHost({ home }); t.after(h2.close); await h2.ready
  const t0 = Date.now()
  const w = await h2.call('wait', { run_id: r.run_id, timeout_s: 30 })
  assert.equal(w.state, 'interrupted')
  assert.match(w.error, /never arrived/)
  assert.ok(Date.now() - t0 < 10_000, `the wait woke when the run ended (${Date.now() - t0} ms)`)
})

test('a question open when the plugin reloaded is left to the Harness window: the wait says so', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const h1 = startHost({ home }); await h1.ready
  const r = await h1.call('send', { session_id: 'W', message: 'ask me' })
  const w1 = S('W')
  h1.emit(...w1.turnStart()); h1.emit(...w1.userMessage(h1.calls.prompt[0].requestId))
  h1.ask('W', [{ id: 'f', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }])
  assert.ok((await h1.call('status', { run_id: r.run_id })).question)
  h1.close()
  const h2 = startHost({ home, activity: () => [{ kind: 'turn', items: [{ id: 't' }] }] }); t.after(h2.close); await h2.ready
  await new Promise((res) => setTimeout(res, 100))
  const st = await h2.call('wait', { run_id: r.run_id, timeout_s: 2 })
  assert.equal(st.needs_input, 'harness-ui')
  assert.equal(st.question, undefined)
  await assert.rejects(h2.call('answer', { run_id: r.run_id, answers: [{ choose: [1] }] }), /question left open when the plugin reloaded.*answer it in the Harness window/)
})

test('a queued run whose message reached the conversation while the plugin was reloading is claimed from the log', async (t) => {
  if (process.env.DSHB_TEST_PAGED !== '1') return t.skip('reads the paged log (host-paged.test.mjs)')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const log = { Q: [] }
  const h1 = startHost({ home, log }); await h1.ready
  const r = await h1.call('send', { session_id: 'Q', message: 'later' })
  h1.close() // the message had not shown up in the conversation yet
  log.Q.push({ type: 'user/message', data: { source: { kind: 'user', rpcId: h1.calls.prompt[0].requestId }, content: [{ type: 'text', text: 'later' }] } })
  const h2 = startHost({ home, log, activity: () => [{ kind: 'turn', items: [{ id: 't' }] }] }); t.after(h2.close); await h2.ready
  await new Promise((res) => setTimeout(res, 300))
  const st = await h2.call('status', { run_id: r.run_id })
  assert.equal(st.state, 'running', 'claimed: its message is in the session log')
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

test('an option chosen by a cleaned label matches one with the mark inside its brackets ("Markdown（.md，推荐）")', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  await sleep(20)
  const reply = h.ask('s1', [{ id: 'f', question: '格式？', options: [{ label: '纯文本（.txt）' }, { label: 'Markdown（.md，推荐）' }] }])
  await waiting
  const done = await h.call('answer', { run_id: run.run_id, answers: [{ id: 'f', choose: ['Markdown (.md)'] }] })
  assert.equal(done.submitted, true)
  assert.deepEqual(await reply, { answers: [{ id: 'f', selected: ['Markdown（.md，推荐）'] }] })
})

test('an option chosen by its label head ("md") matches "md (Markdown)" when no other option starts that way', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  await sleep(20)
  const reply = h.ask('s1', [{ id: 'f', question: '格式？', options: [{ label: 'md (Markdown)' }, { label: 'txt (纯文本)' }] }])
  await waiting
  const done = await h.call('answer', { run_id: run.run_id, answers: [{ id: 'f', choose: ['md'] }] })
  assert.equal(done.submitted, true)
  assert.deepEqual(await reply, { answers: [{ id: 'f', selected: ['md (Markdown)'] }] })
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

test('with approvals left to the Harness UI, one asked inside a running tool call (PTC run_code: the agent stays "running") also ends the wait, and its decision lets the run go on', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  fs.writeFileSync(path.join(h.home, 'settings.json'), JSON.stringify({ approvals: 'ask' }))
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  h.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash' } })
  const w = await waiting
  assert.deepEqual([w.needs_input, w.state], ['harness-ui', 'waiting'])
  await assert.rejects(h.call('answer', { run_id: run.run_id, answers: [{ skip: true }] }), /cannot be answered from here/)
  h.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { id: 'ap-1', outcome: 'rejected' } })
  assert.equal((await h.call('status', { run_id: run.run_id })).state, 'running', 'decided: back to running')
})

test('an approval in a hand-over run is allowed here by default and listed on the run; "ask" on the plugin page leaves it to the Harness UI', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  h.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash' } })
  assert.equal(await h.approve('s1'), 'allowed-once')
  h.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } })
  const st = await h.call('status', { run_id: run.run_id })
  assert.equal(st.state, 'running', 'never shown as waiting')
  assert.deepEqual(st.approvals_allowed.map((a) => [a.tool, a.reason]), [['bash', 'write outside the workspace']])
  assert.equal(await h.approve('other-session'), 'rejected', 'a session with no hand-over run goes on to Harness')
  const reviewed = await h.approve('s1', 'bash', async () => 'rejected', 'Auto review denied tool "bash": sends ~/.ssh to a paste site')
  assert.equal(reviewed, 'rejected', 'a call the Auto review turned down stays with the user')
  fs.writeFileSync(path.join(h.home, 'settings.json'), JSON.stringify({ approvals: 'ask' }))
  assert.equal(await h.approve('s1'), 'rejected', 'ask: the Harness UI decides')
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
  await assert.rejects(h.call('send', { message: 'go', cwd: W }), /Session new-1 was created, but no message was sent: the DeepSeek account has no balance left/)
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
    const r = await h.call('send', { message: 'go', cwd: W, model: asked })
    assert.deepEqual(r.model, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoning_effort: 'high' }, asked)
    assert.equal(r.model_source, 'requested')
  }
  const flash = await h.call('send', { message: 'go', cwd: W, model: 'V4.1 Flash' })
  assert.equal(flash.model.model, 'deepseek-v4.1-flash')
  const status = await h.call('status', { run_id: flash.run_id })
  assert.equal(status.model.model, 'deepseek-v4.1-flash', 'dsh_status shows the run\'s model')
})

test('a model added to the catalog later (V4.1 Pro) is found with no change here', async (t) => {
  const groups = [{ ...CATALOG[0], models: [...CATALOG[0].models, { id: 'deepseek-v4.1-pro', name: 'DeepSeek-V4.1-Pro' }] }]
  const m = fakeModels({ groups })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  assert.equal((await h.call('send', { message: 'go', cwd: W, model: 'V4.1 Pro' })).model.model, 'deepseek-v4.1-pro')
  assert.equal((await h.call('send', { message: 'go', cwd: W, model: 'v4 pro' })).model.model, 'deepseek-v4-pro', 'V4 Pro is still its own model')
})

test('a model that matches nothing, or several, fails the send before anything is created, listing what is there', async (t) => {
  const groups = [...CATALOG, { id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] }]
  const m = fakeModels({ groups })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'V5 Ultra' }), /No model in Harness matches "V5 Ultra"\. Available: deepseek-account\/deepseek-v4\.1-flash \(DeepSeek-V4\.1-Flash\), deepseek-account\/deepseek-v4-pro/)
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'Pro' }), /No model in Harness matches "Pro"/, 'a part of a name is no match')
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'V4 Pro' }), /matches several models: deepseek-account\/deepseek-v4-pro, deepseek-api\/deepseek-v4-pro\. Pass one of them as provider\/model/)
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'deepseek-account/V4 Pro', reasoning_effort: 'max' }), /has no reasoning effort "max"; it has low, high/)
  assert.equal(m.calls.create.length, 0)
  assert.equal(m.calls.prompt.length, 0)
  assert.equal((await h.call('send', { message: 'go', cwd: W, model: 'deepseek-api/v4-pro' })).model.provider, 'deepseek-api')
})

test('a name several providers share runs on the hand-over default when it is one of them (issue #1)', async (t) => {
  const groups = [...CATALOG, { id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] }]
  const m = fakeModels({ groups })
  const picks = []; const select = m.controller.selectModel
  m.controller.selectModel = async (r) => { picks.push(r); return select(r) }
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  saveDefaults(h, { model: 'deepseek-api/deepseek-v4-pro' })
  for (const session_id of [undefined, 's1']) {
    const r = await h.call('send', { message: 'go', model: 'V4 Pro', ...(session_id ? { session_id } : { cwd: W }) })
    assert.equal(r.model.provider, 'deepseek-api', session_id ?? 'new')
    assert.equal(r.model_source, 'requested')
    assert.match(r.model_note, /"V4 Pro" matches several models \(deepseek-account\/deepseek-v4-pro, deepseek-api\/deepseek-v4-pro\); it ran on deepseek-api\/deepseek-v4-pro, the hand-over default/)
  }
  assert.ok(picks.length >= 2 && picks.every((c) => !('note' in c)), 'the note never reaches Harness')
  saveDefaults(h, { model: 'deepseek-account/deepseek-v4.1-flash' })
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'V4 Pro' }), /matches several models/, 'a default outside the matches decides nothing')
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
    h.call('send', { message: 'a', cwd: W, model: 'V4 Pro' }),
    h.call('send', { message: 'b', cwd: W }),
    h.call('send', { message: 'c', cwd: W, model: 'V4.1 Flash', reasoning_effort: 'low' }),
    h.call('send', { message: 'd', cwd: W, model: 'V4 Pro' }),
    h.call('send', { message: 'e', cwd: W }),
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
  await h.call('send', { message: 'f', cwd: W, model: 'V4.1 Flash' })
  await m.settled()
  assert.equal(m.state.default.model, 'deepseek-v4-pro', 'a default the user changed in between is kept')
})

test('a Harness without selectModel/modelCatalog, or without its default-model service, refuses model clearly and still sends without it', async (t) => {
  const old = fakeModels({ selectModel: false })
  const h = startHost({ models: old }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'go', cwd: W, model: 'V4 Pro' }), /cannot choose a model per session/)
  assert.equal(old.calls.create.length, 0)
  const plain = await h.call('send', { message: 'go', cwd: W })
  assert.equal(plain.state, 'queued')
  assert.equal(old.calls.prompt.length, 1)

  const noDefault = fakeModels({ defaultService: false })
  const h2 = startHost({ models: noDefault }); t.after(h2.close); await h2.ready
  await assert.rejects(h2.call('send', { message: 'go', session_id: 's1', model: 'V4 Pro' }), /No message was sent: the model could not be set \(.*keep its default model/)
  assert.equal(noDefault.calls.prompt.length, 0)
  assert.equal(noDefault.state.order.length, 0, 'selectModel was never called, so the default never moved')
  assert.equal((await h2.call('send', { message: 'go', cwd: W })).state, 'queued')

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
    h.call('send', { message: 'a', cwd: W, model: 'DeepSeek-V4 Pro' }),
    h.call('send', { message: 'b', cwd: W }),
  ])
  assert.equal(pro.model.model, 'deepseek-v4-pro')
  assert.deepEqual(m.state.sessions[plain.session_id], original)
  await m.settled()
  assert.deepEqual(m.state.default, original)

  // Without the service at all, a send without model still goes through, unpinned.
  const none = fakeModels({ defaultService: false })
  none.viaInject = true
  const h2 = startHost({ models: none }); t.after(h2.close); await h2.ready
  const r = await h2.call('send', { message: 'b', cwd: W })
  assert.equal(r.state, 'queued')
  assert.equal(r.model_source, 'default')
  assert.equal(none.state.order.length, 0)
})

// --- hand-over defaults (plugin page) -----------------------------------------------

const PRO = { provider: 'deepseek-account', model: 'deepseek-v4-pro' }
const saveDefaults = (h, handover, extra = {}) => {
  fs.mkdirSync(h.home, { recursive: true })
  fs.writeFileSync(path.join(h.home, 'settings.json'), JSON.stringify({ handover, ...extra }))
}

test('a new hand-over session starts on the model and effort set on the plugin page; an explicit model wins and an existing session keeps its own', async (t) => {
  const m = fakeModels()
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  const original = { ...m.state.default }
  saveDefaults(h, { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'low' })
  const r = await h.call('send', { message: 'go', cwd: W })
  assert.deepEqual(r.model, { ...PRO, reasoning_effort: 'low' })
  assert.equal(r.model_source, 'handover_default')
  assert.equal(r.model_note, undefined)
  // Effort alone in the send: the page's model, the send's effort.
  const e = await h.call('send', { message: 'go', cwd: W, reasoning_effort: 'high' })
  assert.deepEqual(e.model, { ...PRO, reasoning_effort: 'high' })
  assert.equal(e.model_source, 'handover_default')
  // A model named in the send comes first; the page's effort still fills in.
  const x = await h.call('send', { message: 'go', cwd: W, model: 'V4.1 Flash' })
  assert.deepEqual(x.model, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoning_effort: 'low' })
  assert.equal(x.model_source, 'requested')
  // A session that exists keeps its own model.
  m.state.sessions.s9 = { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }
  const keep = await h.call('send', { message: 'more', session_id: 's9' })
  assert.equal(keep.model.model, 'deepseek-v4.1-flash')
  assert.equal(keep.model_source, 'session')
  await m.settled()
  assert.deepEqual(m.state.default, original, "Harness's default is left as it was")
})

test('a hand-over default that no longer fits is skipped with a note, never failing the send', async (t) => {
  const m = fakeModels({ groups: [...CATALOG, { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'glm-flash', name: 'GLM Flash' }] }] })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  saveDefaults(h, { model: 'zro/deepseek-v4.1-flash' })
  const gone = await h.call('send', { message: 'go', cwd: W })
  assert.equal(gone.state, 'queued')
  assert.equal(gone.model.model, 'deepseek-v4.1-flash')
  assert.equal(gone.model_source, 'default')
  assert.match(gone.model_note, /zro\/deepseek-v4\.1-flash \(set on the dsh-baton plugin page in Harness\) is not in Harness's model list now/)
  // A saved model is matched exactly, never by a similar name.
  saveDefaults(h, { model: 'deepseek-account/V4 Pro' })
  assert.match((await h.call('send', { message: 'go', cwd: W })).model_note, /is not in Harness's model list now/)
  // An effort the model does not have: its own default effort, said in the note.
  saveDefaults(h, { model: 'workbuddy/glm-flash', reasoning_effort: 'low' })
  const glm = await h.call('send', { message: 'go', cwd: W })
  assert.deepEqual(glm.model, { provider: 'workbuddy', model: 'glm-flash', reasoning_effort: null })
  assert.equal(glm.model_source, 'handover_default')
  assert.match(glm.model_note, /workbuddy\/glm-flash has no reasoning effort low/, 'a skipped effort is always said')
  saveDefaults(h, { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'max' })
  const pro = await h.call('send', { message: 'go', cwd: W })
  assert.deepEqual(pro.model, { ...PRO, reasoning_effort: 'high' })
  assert.match(pro.model_note, /has no reasoning effort max/)
  // A broken settings file is the same as no setting.
  fs.writeFileSync(path.join(h.home, 'settings.json'), '{ not json')
  const plain = await h.call('send', { message: 'go', cwd: W })
  assert.equal(plain.model_source, 'default')
})

test("a new hand-over that follows Harness's default says when that default changed since the last one", async (t) => {
  const m = fakeModels()
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  const first = await h.call('send', { message: 'a', cwd: W })
  assert.equal(first.model_source, 'default')
  assert.equal(first.model_note, undefined, 'nothing to compare with yet')
  await m.settled()
  assert.equal((await h.call('send', { message: 'b', cwd: W })).model_note, undefined, 'same default: no note')
  await m.settled()
  // The user picks V4 Pro in Harness's model menu: it becomes the default.
  m.state.default = { ...PRO, reasoningEffort: 'high' }
  const moved = await h.call('send', { message: 'c', cwd: W })
  assert.equal(moved.model.model, 'deepseek-v4-pro')
  assert.match(moved.model_note, /Harness's default model changed since the last new hand-over \(deepseek-account\/deepseek-v4\.1-flash then, deepseek-account\/deepseek-v4-pro now\)/)
  assert.match(moved.model_note, /choose a hand-over default model on the dsh-baton plugin page/)
  await m.settled()
  assert.equal((await h.call('send', { message: 'd', cwd: W })).model_note, undefined, 'said once')
  // Continuing a session or naming a model never says it.
  assert.equal((await h.call('send', { message: 'e', session_id: moved.session_id })).model_note, undefined)
})

test('the plugin page reads and saves the hand-over defaults; only the Harness page itself may save', async (t) => {
  const m = fakeModels()
  const routes = {}
  const web = { register: (r) => { routes[r.path] = r; return () => { delete routes[r.path] } } }
  const h = startHost({ models: m, web }); t.after(h.close); await h.ready
  const route = routes['/dsh-baton/handover']
  const PAGE = { host: '127.0.0.1:2007', 'content-type': 'application/json', 'x-dsh-baton': 'handover' }
  const request = (method, body, headers = PAGE) => new Promise((resolve) => {
    const req = Object.assign(Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method, headers })
    let code = 0
    route.handler(req, { writeHead: (c) => { code = c }, end: (b) => resolve({ code, body: JSON.parse(b) }) })
  })
  const got = await request('GET')
  assert.equal(got.code, 200)
  assert.deepEqual([got.body.model, got.body.reasoning_effort, got.body.supported], [null, null, true])
  assert.deepEqual(got.body.default, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoning_effort: 'high' })
  const effortsOf = (x) => x.reasoning_efforts.map((e) => `${e.id}:${e.name}`)
  assert.deepEqual(got.body.models.map((x) => [x.provider_name, x.name, effortsOf(x)]), [['DeepSeek', 'DeepSeek-V4.1-Flash', ['low:Low', 'high:High']], ['DeepSeek', 'DeepSeek-V4-Pro', ['low:Low', 'high:High']]])

  const saved = await request('POST', { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'low' })
  assert.equal(saved.code, 200)
  assert.deepEqual([saved.body.model, saved.body.reasoning_effort], ['deepseek-account/deepseek-v4-pro', 'low'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.home, 'settings.json'), 'utf8')).handover, { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'low' })
  assert.equal((await h.call('send', { message: 'go', cwd: W })).model_source, 'handover_default')

  // Checked against Harness's list: an unknown model or effort is refused and nothing changes.
  assert.match((await request('POST', { model: 'deepseek-account/V4 Pro' })).body.error, /No model deepseek-account\/V4 Pro/)
  assert.match((await request('POST', { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'max' })).body.error, /No reasoning effort max for deepseek-account\/deepseek-v4-pro; there is low, high/)
  assert.equal((await request('POST', '{ broken')).code, 400)
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'settings.json'), 'utf8')).handover.reasoning_effort, 'low')

  // Not the plugin page: no page header, another site, a form post, or a name rebound to loopback.
  for (const headers of [
    { host: '127.0.0.1:2007', 'content-type': 'application/json' },
    { host: '127.0.0.1:2007', origin: 'http://127.0.0.1:2007', 'content-type': 'application/json' },
    { ...PAGE, origin: 'https://evil.example' },
    { ...PAGE, 'content-type': 'text/plain' },
    { ...PAGE, host: 'rebind.example:2007' },
    { ...PAGE, host: 'rebind.example:2007', origin: 'http://rebind.example:2007' },
    { ...PAGE, origin: 'null' },
  ]) {
    const r = await request('POST', { model: null }, headers)
    assert.equal(r.code, 403, JSON.stringify(headers))
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'settings.json'), 'utf8')).handover.model, 'deepseek-account/deepseek-v4-pro')
  // The desktop window (no Origin through its proxy, or dsh-app://app) and dsh web in a browser (same origin).
  assert.equal((await request('POST', { model: 'deepseek-account/deepseek-v4-pro' }, { ...PAGE, origin: 'dsh-app://app' })).code, 200)
  assert.equal((await request('POST', { model: 'deepseek-account/deepseek-v4-pro' }, { ...PAGE, host: 'localhost:2007', origin: 'http://localhost:2007' })).code, 200)
  assert.equal((await request('POST', { model: null, reasoning_effort: null }, { ...PAGE, host: '[::1]:2007', 'content-type': 'application/json; charset=utf-8' })).code, 200)
  assert.equal((await request('GET')).body.model, null, 'back to following Harness')
  assert.equal((await request('PUT', {})).code, 405)
})

// The plugin page's route, called the way Harness's web server calls it.
function handoverRoute(t, opts = {}) {
  const routes = {}
  const web = { register: (r) => { routes[r.path] = r; return () => { delete routes[r.path] } } }
  const h = startHost({ ...opts, web }); t.after(h.close)
  const PAGE = { host: '127.0.0.1:2007', 'content-type': 'application/json', 'x-dsh-baton': 'handover' }
  const request = (method, body, headers = PAGE, extra = {}) => new Promise((resolve) => {
    const req = Object.assign(Readable.from(body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method, headers, ...extra })
    let code = 0
    let ret = null
    ret = routes['/dsh-baton/handover'].handler(req, { writeHead: (c) => { code = c }, end: (b) => { const at = code; queueMicrotask(() => resolve({ code: at, body: JSON.parse(b), returned: ret })) } })
  })
  return { h, request, PAGE }
}
const settingsOf = (h) => JSON.parse(fs.readFileSync(path.join(h.home, 'settings.json'), 'utf8'))

test('a saved default is used exactly as saved: a provider id with "deepseek" in it, a model id with slashes, a near-duplicate id', async (t) => {
  const groups = [...CATALOG,
    { id: 'deepseek', name: 'DeepSeek API', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }, { id: 'v4-pro', name: 'V4 Pro alias' }] },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
  ]
  const m = fakeModels({ groups })
  const { h, request } = handoverRoute(t, { models: m }); await h.ready
  for (const saved of ['deepseek/deepseek-v4-pro', 'deepseek/v4-pro', 'openrouter/deepseek/deepseek-v4-pro']) {
    assert.equal((await request('POST', { model: saved })).code, 200, saved)
    const r = await h.call('send', { message: 'go', cwd: W })
    assert.equal(`${r.model.provider}/${r.model.model}`, saved)
    assert.equal(r.model_source, 'handover_default')
    assert.deepEqual(r.handover_default, ['model'])
  }
  // Named in a send, a model id with slashes is found too.
  assert.equal((await h.call('send', { message: 'go', cwd: W, model: 'openrouter/deepseek/deepseek-v4-pro' })).model.provider, 'openrouter')
})

test('a saved default Harness cannot use never fails the send: no default-model service, a model Harness refuses, an unreadable catalog', async (t) => {
  // No default-model service: the page says it cannot be set, and a send skips the setting.
  const noService = fakeModels({ defaultService: false })
  const a = handoverRoute(t, { models: noService }); await a.h.ready
  assert.equal((await a.request('GET')).body.supported, false)
  saveDefaults(a.h, { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'low' })
  const r = await a.h.call('send', { message: 'go', cwd: W })
  assert.equal(r.state, 'queued')
  assert.match(r.model_note, /were not used: this DeepSeek Harness cannot choose a model per session/)
  assert.equal(noService.calls.prompt.length, 1)

  // Harness lists the model but refuses to select it (its provider signed out since).
  const refusing = fakeModels({ groups: [...CATALOG, { id: 'gone', name: 'Gone', models: [{ id: 'm1', name: 'M1' }] }] })
  const select = refusing.controller.selectModel
  refusing.controller.selectModel = async (q) => { if (q.provider === 'gone') throw new Error('session/model-unavailable'); return select(q) }
  const b = startHost({ models: refusing }); t.after(b.close); await b.ready
  saveDefaults(b, { model: 'gone/m1' })
  const s = await b.call('send', { message: 'go', cwd: W })
  assert.equal(s.state, 'queued')
  assert.equal(s.model.model, 'deepseek-v4.1-flash')
  assert.equal(s.model_source, 'default')
  assert.match(s.model_note, /could not be used \(setting the model: session\/model-unavailable\), so this session uses Harness's default model/)
  assert.equal(refusing.calls.prompt.length, 1)
  assert.equal(refusing.calls.create.length, 1, 'one session, not an empty one left behind')

  // The catalog cannot be read: the send goes on as if nothing were set.
  const flaky = fakeModels()
  const c = startHost({ models: flaky }); t.after(c.close); await c.ready
  saveDefaults(c, { model: 'deepseek-account/deepseek-v4-pro' })
  c.ctx.sessionController.modelCatalog = async () => { throw new Error('catalog offline') }
  const f = await c.call('send', { message: 'go', cwd: W })
  assert.equal(f.state, 'queued')
  assert.match(f.model_note, /model list could not be read \(catalog offline\)/)
})

test('an effort named in the send that the saved model lacks skips the saved model, with a note', async (t) => {
  const m = fakeModels({ groups: [...CATALOG, { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'glm-flash', name: 'GLM Flash' }] }] })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  saveDefaults(h, { model: 'workbuddy/glm-flash' })
  const r = await h.call('send', { message: 'go', cwd: W, reasoning_effort: 'high' })
  assert.deepEqual(r.model, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoning_effort: 'high' })
  assert.match(r.model_note, /workbuddy\/glm-flash \(set on the dsh-baton plugin page in Harness\) has no reasoning effort high/)
})

test('with only an effort saved, a new hand-over reads the default inside the pick queue: another send\'s pick never leaks in', async (t) => {
  const m = fakeModels({ saveMs: () => 60 })
  const h = startHost({ models: m }); t.after(h.close); await h.ready
  saveDefaults(h, { model: null, reasoning_effort: 'low' }, { lastDefaultModel: 'deepseek-account/deepseek-v4.1-flash' })
  const a = h.call('send', { message: 'a', session_id: 's1', model: 'V4 Pro' })
  await sleep(20)
  const b = await h.call('send', { message: 'b', cwd: W })
  await a
  assert.deepEqual(b.model, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoning_effort: 'low' })
  assert.equal(b.model_source, 'default')
  assert.deepEqual(b.handover_default, ['reasoning_effort'])
  assert.equal(b.model_note, undefined, 'no false "default changed" note')
  await m.settled()
  assert.equal(m.state.default.model, 'deepseek-v4.1-flash')
  assert.equal((await h.call('send', { message: 'c', cwd: W })).model_note, undefined)
})

test('a send refused after the drift check does not use up the "default changed" note', async (t) => {
  const m = fakeModels()
  let balance = { status: 'ready', value: [{ currency: 'CNY', balance: '5.00' }], bonusWallets: [] }
  const h = startHost({ models: m, account: { getBalance: async () => balance } }); t.after(h.close); await h.ready
  await h.call('send', { message: 'a', cwd: W })
  await m.settled()
  m.state.default = { ...PRO, reasoningEffort: 'high' }
  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '0.00' }], bonusWallets: [] }
  await sleep(10)
  // The balance seen a minute ago is trusted: this send goes through and says it.
  const said = await h.call('send', { message: 'b', cwd: W })
  assert.match(said.model_note, /default model changed/)
  await m.settled()
  m.state.default = { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }
  // A prompt Harness refuses: the run fails, and the next send still says the default moved.
  const prompt = m.controller.prompt
  h.ctx.sessionController.prompt = async () => { throw new Error('harness busy') }
  const failed = await h.call('send', { message: 'c', cwd: W })
  assert.equal(failed.state, 'failed')
  h.ctx.sessionController.prompt = prompt ?? (async (r) => { h.calls.prompt.push(r); return { accepted: true } })
  await m.settled()
  const next = await h.call('send', { message: 'd', cwd: W })
  assert.match(next.model_note, /deepseek-v4-pro then, deepseek-account\/deepseek-v4\.1-flash now/)
})

test('a settings file that cannot be read is reported, never taken for "nothing set" or overwritten by a send', async (t) => {
  const m = fakeModels()
  const { h, request } = handoverRoute(t, { models: m }); await h.ready
  fs.mkdirSync(h.home, { recursive: true })
  const torn = '{"handover":{"model":"deepseek-account/deepseek-v4-pro"},"lastDefaultModel":"x/y"'
  fs.writeFileSync(path.join(h.home, 'settings.json'), torn)
  const r = await h.call('send', { message: 'go', cwd: W })
  assert.equal(r.state, 'queued')
  assert.match(r.model_note, /could not be read \(not valid JSON\)/)
  assert.equal(fs.readFileSync(path.join(h.home, 'settings.json'), 'utf8'), torn, 'left as it was')
  assert.equal((await request('GET')).body.unreadable, 'not valid JSON')
  // A save from the page replaces it and keeps the broken one aside.
  assert.equal((await request('POST', { model: 'deepseek-account/deepseek-v4-pro' })).code, 200)
  assert.equal(settingsOf(h).handover.model, 'deepseek-account/deepseek-v4-pro')
  assert.ok(fs.readdirSync(h.home).some((f) => f.startsWith('settings.json.bad-')))
})

test('the page route: a field left out keeps its value, a saved model that left Harness can keep a new effort, any address or localhost name may save', async (t) => {
  const m = fakeModels()
  const { h, request, PAGE } = handoverRoute(t, { models: m }); await h.ready
  assert.equal((await request('POST', { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'low' })).code, 200)
  assert.equal((await request('POST', { reasoning_effort: 'high' })).code, 200)
  assert.deepEqual(settingsOf(h).handover, { model: 'deepseek-account/deepseek-v4-pro', reasoning_effort: 'high' })
  assert.equal((await request('POST', { model: null })).code, 200)
  assert.deepEqual(settingsOf(h).handover, { model: null, reasoning_effort: 'high' })
  // The saved model leaves Harness's list: the effort can still be changed, the model kept.
  saveDefaults(h, { model: 'gone/pro-v1', reasoning_effort: 'low' })
  const kept = await request('POST', { model: 'gone/pro-v1', reasoning_effort: 'high' })
  assert.equal(kept.code, 200, JSON.stringify(kept.body))
  assert.equal(kept.body.missing, true)
  assert.match((await request('POST', { model: 'other/gone' })).body.error, /No model other\/gone/)
  for (const host of ['127.0.0.2:2007', '198.51.100.20:2007', '[::ffff:127.0.0.1]:2007', 'harness.localhost:2007']) {
    assert.equal((await request('POST', { model: null }, { ...PAGE, host, origin: `http://${host}` })).code, 200, host)
  }
  assert.equal((await request('POST', { model: null }, { ...PAGE, host: 'evil.example:2007' })).code, 403)
  // The handler hands its promise back to the web server.
  assert.equal(typeof (await request('GET')).returned?.then, 'function')
  assert.equal((await request('POST', [1, 2])).code, 200, 'an array body changes nothing')
})

// --- Harness goals ---------------------------------------------------------------
// A goal makes Harness start the next round by itself a few ms after a turn ends.

// The goal projection's wire value (values.goal): the current goal, as Harness sends it.
const goalValue = (phase = 'active', extra = {}) => ({ goal: { id: 'goal-1', revision: 1, objective: 'finish the app', phase, maxGoalRounds: 256, ...extra }, roundsStarted: 25, createdAt: 1, updatedAt: 2 })
// One turn of a session log: the goal's message (round r), tool calls, text, and its end unless open.
const round = (turn, { round: r, text, tools = [], open = false, at = Date.now() } = {}) => [
  { type: 'turn/start', time: at, data: { turn } },
  ...(r != null ? [{ type: 'user/message', time: at, data: { source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: r }, content: [] } }] : []),
  ...tools.map((name) => ({ type: 'assistant/message', time: at, data: { message: { content: [{ type: 'tool-call', name }] } } })),
  ...(text ? [{ type: 'assistant/message', time: at, data: { message: { content: [{ type: 'text', text }] } } }] : []),
  ...(open ? [] : [{ type: 'turn/end', time: at, data: { turn, reason: { kind: 'completed' } } }]),
]
const logged = (h, id, type) => h.emit('session/event', { id }, { type, data: {} })

// Harness's goals service as the /goal command uses it: one goal per live agent.
function fakeGoals() {
  const byAgent = new Map()
  const calls = []
  return {
    calls,
    get: (agent) => byAgent.get(agent.id),
    create: (agent, { objective }) => {
      calls.push(['create', agent.id, objective])
      const cur = byAgent.get(agent.id)
      if (cur && cur.phase !== 'complete') throw Object.assign(new Error(`goal "${cur.id}" already exists with phase "${cur.phase}"`), { code: 'GOAL_ALREADY_EXISTS' })
      const g = { id: `goal-${calls.length}`, revision: 1, objective, phase: 'active', maxGoalRounds: 256, activation: 'armed' }
      byAgent.set(agent.id, g)
      return g
    },
    edit: (agent, ref, { objective }) => {
      calls.push(['edit', agent.id, objective])
      const g = { ...byAgent.get(agent.id), objective, revision: ref.revision + 1 }
      byAgent.set(agent.id, g)
      return g
    },
  }
}

test('a leading /goal sets the goal through the goals service and sends the objective', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-goal-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'app')
  fs.mkdirSync(app)
  const goals = fakeGoals()
  const agents = new Map()
  const h = startHost({ workspaces: [{ id: 'w1', path: root, title: 'Root' }], goal: {}, goals, agents: { get: (id) => (agents.has(id) ? agents.get(id) : (agents.set(id, { id }), agents.get(id))) } }); t.after(h.close); await h.ready
  const r = await h.call('send', { cwd: app, conversation_folder: root, message: '/goal make it pass' })
  // The objective goes in as the message, after the working-folder note, with the goal note.
  const text = h.calls.prompt[0].content[0].text
  assert.ok(!text.startsWith('/goal'))
  assert.match(text, /^\(Working folder for this task: [^]*\)\n\nmake it pass\n\n\(This message also set a Harness goal/)
  // The goal is set once the message is in, with the same objective (note included).
  assert.equal(goals.calls.length, 1)
  assert.equal(goals.calls[0][0], 'create')
  assert.equal(goals.calls[0][1], r.session_id)
  assert.match(goals.calls[0][2], /\)\n\nmake it pass$/)
  assert.deepEqual(r.goal_set, { id: 'goal-1', phase: 'active', max_rounds: 256 })
  // /goal edit replaces the objective of the goal there is.
  const e = await h.call('send', { session_id: r.session_id, message: '/goal edit make it fast' })
  assert.equal(goals.calls[1][0], 'edit')
  assert.equal(goals.calls[1][2], 'make it fast')
  assert.equal(e.goal_set.id, 'goal-1')
  assert.equal(h.calls.prompt[1].content[0].text.split('\n\n')[0], 'make it fast')
  // Control words are left to the Harness window; nothing is sent.
  for (const m of ['/goal', '/goal pause', '/goal clear']) {
    await assert.rejects(h.call('send', { session_id: r.session_id, message: m }), /Nothing was sent: dsh_send takes "\/goal <objective>"/)
  }
  assert.equal(h.calls.prompt.length, 2)
  // A path is not a command.
  await h.call('send', { session_id: r.session_id, message: '/goals.md is wrong' })
  assert.equal(h.calls.prompt[2].content[0].text, '/goals.md is wrong')
  assert.equal(goals.calls.length, 2)
})

test('a /goal into a session whose goal is still active, or to a Harness without goals, sends nothing', async (t) => {
  const h = startHost({ goal: { s1: goalValue() }, goals: fakeGoals(), agents: { get: (id) => ({ id }) } }); t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { session_id: 's1', message: '/goal ship it' }), /No message was sent: session s1 already has a goal \(active: finish the app\)/)
  assert.equal(h.calls.prompt.length, 0)
  const bare = startHost(); t.after(bare.close); await bare.ready
  await assert.rejects(bare.call('send', { session_id: 's1', message: '/goal ship it' }), /Nothing was sent: this DeepSeek Harness cannot set a goal/)
  assert.equal(bare.calls.prompt.length, 0)
})

test('a run in a session with an active goal ends with its own round and says the goal goes on', async (t) => {
  const h = startHost({ goal: { s1: goalValue() } }); t.after(h.close); await h.ready
  const s = S('s1')
  const r = await h.call('send', { session_id: 's1', message: 'keep going' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.text('stage one done')); h.emit(...s.turnEnd())
  // The goal's next round starts at once, before any quiet check: its work is not this run's.
  h.emit(...s.turnStart())
  h.emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 19 } } })
  h.emit(...s.text('round 19 work'))
  const w = await h.call('wait', { run_id: r.run_id, timeout_s: 5 })
  assert.equal(w.state, 'completed')
  assert.equal(w.final_text, 'stage one done')
  assert.equal(w.superseded_by, 'goal')
  assert.deepEqual(w.goal, { id: 'goal-1', phase: 'active', objective: 'finish the app', rounds_started: 25, max_rounds: 256, activation: null })
  assert.equal((await h.call('status', { run_id: r.run_id })).goal.phase, 'active')

  // A session without a goal: no goal field at all, as before.
  const s2 = S('s2')
  const r2 = await h.call('send', { session_id: 's2', message: 'hi' })
  h.emit(...s2.turnStart()); h.emit(...s2.userMessage(h.calls.prompt[1].requestId)); h.emit(...s2.text('hello')); h.emit(...s2.turnEnd()); h.emit(...s2.status('idle'))
  const w2 = await h.call('wait', { run_id: r2.run_id, timeout_s: 5 })
  assert.equal(w2.state, 'completed')
  assert.equal('goal' in w2, false)
})

test('a session log read again walks back only to the events it already has (paged history), and a shorter log is read whole', async (t) => {
  if (process.env.DSHB_TEST_PAGED !== '1') return t.skip('paged history only (host-paged.test.mjs)')
  const log = { s1: [...round(1, { round: 1, text: 'r1' }), ...round(2, { round: 2, text: 'r2' }), ...round(3, { round: 3, text: 'r3' })] }
  const h = startHost({ log }); t.after(h.close); await h.ready
  const first = await h.call('read_session', { session_id: 's1' })
  const whole = h.calls.events.length
  assert.ok(whole > 3, `the first read walks the whole log (${whole} pages)`)
  log.s1.push(...round(4, { round: 4, text: 'r4' }))
  const again = await h.call('read_session', { session_id: 's1' })
  assert.ok(h.calls.events.length - whole <= 3, `a read after new events takes only the newest pages (${h.calls.events.length - whole})`)
  assert.deepEqual(again.messages.slice(0, first.messages.length), first.messages)
  assert.match(JSON.stringify(again.messages.at(-1)), /r4/)
  // A log rewritten shorter no longer holds the last event read: read whole, nothing stale kept.
  log.s1.splice(0, log.s1.length, ...round(1, { round: 1, text: 'fresh' }))
  const reset = await h.call('read_session', { session_id: 's1' })
  assert.doesNotMatch(JSON.stringify(reset.messages), /r4/)
  assert.match(JSON.stringify(reset.messages), /fresh/)
})

test('following a goal: nothing to follow without one; until goal returns when the goal stops, with every round since', async (t) => {
  const goal = { s1: goalValue() }
  const log = { s1: [...round(1, { round: 1, text: 'r1' })] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  const none = await h.call('follow', { session_id: 's2', timeout_s: 5 })
  assert.equal(none.state, 'no_goal')
  await assert.rejects(h.call('follow', { session_id: 's1', until: 'forever' }), /until must be goal or turn/)
  let result = null
  const p = h.call('follow', { session_id: 's1', timeout_s: 10 }).then((r) => { result = r; return r })
  await sleep(100)
  log.s1.push(...round(2, { round: 2, text: 'r2', tools: ['pwsh', 'pwsh', 'read_image'] }))
  logged(h, 's1', 'turn/end')
  await sleep(200)
  assert.equal(result, null, 'a round end alone does not report in goal mode')
  // The goal is marked complete during round 3, which still finishes its reply after that.
  log.s1.push(...round(3, { round: 3, open: true }))
  goal.s1 = goalValue('complete')
  logged(h, 's1', 'goal/change')
  await sleep(200)
  assert.equal(result, null, 'waits for the round that completed the goal to end')
  log.s1.push({ type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'all done' }] } } }, { type: 'turn/end', time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } })
  logged(h, 's1', 'turn/end')
  const r = await p
  assert.equal(r.state, 'goal_ended')
  assert.equal(r.ended_because, 'complete')
  // The latest round in full; the ones before it as one-line digests.
  assert.deepEqual(r.rounds.map((x) => [x.goal_round, x.summary ?? null, x.final_text ?? null]), [[2, 'r2', null], [3, null, 'all done']], 'round 1 was before the follow began')
  assert.deepEqual(r.rounds[0].tools, { pwsh: 2, read_image: 1 })
  assert.match(r.cursor, /^3:\d+$/)
  assert.equal(r.cwd, '/w')
  // Blocked comes back with Harness's reason; a cleared goal ends a follow that had one.
  goal.s1 = goalValue('blocked', { blockedReason: { code: 'needs-key', message: 'An API key is missing' } })
  const b = await h.call('follow', { session_id: 's1', cursor: r.cursor, timeout_s: 5 })
  assert.deepEqual([b.state, b.ended_because, b.goal.blocked_reason.code], ['goal_ended', 'blocked', 'needs-key'])
  goal.s1 = undefined
  log.s1.push({ type: 'goal/change', time: Date.now() - 60000, data: { operation: 'clear' } })
  assert.deepEqual([(await h.call('follow', { session_id: 's1', cursor: r.cursor, timeout_s: 5 })).ended_because], ['cleared'])
})

test('following right after "/goal …" was sent: waits for that turn to create the goal, and counts from its start', async (t) => {
  const goal = {}
  const turnStart = Date.now() - 3000
  const log = { s1: [...round(1, { open: true, at: turnStart })], s2: [...round(1, { open: true })] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  let result = null
  const p = h.call('follow', { session_id: 's1', timeout_s: 10 }).then((r) => { result = r; return r })
  await sleep(150)
  assert.equal(result, null, 'no goal yet while the turn runs is not no_goal')
  goal.s1 = goalValue('active', { maxGoalRounds: 3 })
  logged(h, 's1', 'goal/change')
  await sleep(150)
  assert.equal(result, null)
  log.s1.push({ type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  goal.s1 = goalValue('complete')
  logged(h, 's1', 'turn/end')
  const r = await p
  assert.deepEqual([r.state, r.ended_because, r.rounds.length], ['goal_ended', 'complete', 1])
  assert.equal(r.since, new Date(turnStart).toISOString(), 'what the running turn wrote before the follow began counts')
  // A turn that ends without creating one: no_goal then, also across a cursor from a timed-out call.
  const quick = await h.call('follow', { session_id: 's2', timeout_s: 0.2 })
  assert.deepEqual([quick.state, quick.timed_out], ['following', true])
  const q = h.call('follow', { session_id: 's2', cursor: quick.cursor, timeout_s: 10 })
  await sleep(100)
  log.s2.push({ type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  logged(h, 's2', 'turn/end')
  assert.equal((await q).state, 'no_goal')
})

test('a run\'s wait going on through its goal: since_ms counts the run\'s own round in', async (t) => {
  const runStart = Date.now() - 5000
  const goal = { s1: goalValue('complete') }
  const log = { s1: [...round(1, { text: 'old work', at: runStart - 60000 }), ...round(2, { text: 'stage one', at: runStart + 1000 }), ...round(3, { round: 1, text: 'all done', at: runStart + 2000 })] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  const r = await h.call('follow', { session_id: 's1', since_ms: runStart, timeout_s: 5 })
  assert.deepEqual([r.state, r.ended_because], ['goal_ended', 'complete'])
  assert.deepEqual(r.rounds.map((x) => x.final_text ?? x.summary), ['stage one', 'all done'], 'the turn before the run is left out')
  assert.equal(r.since, new Date(runStart).toISOString())
  // Still going when the call is up: how many rounds wait, not their texts (they come with the report).
  goal.s1 = goalValue()
  const beat = await h.call('follow', { session_id: 's1', since_ms: runStart, timeout_s: 0.3 })
  assert.deepEqual([beat.state, beat.timed_out, beat.rounds_since_report, 'rounds' in beat], ['following', true, 2, false])
})

test('a goal marked complete before the log shows its last round: the report waits for that round\'s reply', async (t) => {
  process.env.DSH_BATON_GOAL_SETTLE_MS = '600'
  t.after(() => { delete process.env.DSH_BATON_GOAL_SETTLE_MS })
  const goal = { s1: goalValue() }
  const log = { s1: [...round(1, { round: 1, text: 'r1', at: Date.now() - 5000 })] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  let result = null
  const p = h.call('follow', { session_id: 's1', timeout_s: 10 }).then((r) => { result = r; return r })
  await sleep(100)
  // Complete now, while the log does not show the final round yet.
  goal.s1 = { ...goalValue('complete'), updatedAt: Date.now() }
  logged(h, 's1', 'goal/change')
  await sleep(200)
  assert.equal(result, null, 'waits for the round that completed the goal')
  log.s1.push(...round(2, { round: 2, text: 'all done, summary' }))
  logged(h, 's1', 'turn/end')
  const r = await p
  assert.deepEqual([r.state, r.rounds.at(-1).final_text], ['goal_ended', 'all done, summary'])
  assert.equal('changedAt' in JSON.parse(JSON.stringify(r.goal)), false, 'not in results')
  // Changed in the Harness UI with no round to come: returns once the settle time is up.
  goal.s1 = { ...goalValue('paused'), updatedAt: Date.now() }
  const t0 = Date.now()
  const paused = await h.call('follow', { session_id: 's1', cursor: r.cursor, timeout_s: 10 })
  assert.equal(paused.ended_because, 'paused')
  assert.ok(Date.now() - t0 >= 400, 'after the settle time')
})

test('a call that runs out of time while the round that completed the goal still runs: timed out, and the next call gets that round', async (t) => {
  const goal = { s1: goalValue('complete') }
  const log = { s1: [...round(1, { round: 1, text: 'r1', at: Date.now() - 5000 }), ...round(2, { round: 2, open: true })] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  const first = await h.call('follow', { session_id: 's1', since_ms: Date.now() - 10000, timeout_s: 0.3 })
  assert.deepEqual([first.state, first.timed_out], ['following', true], 'not goal_ended without the final round')
  log.s1.push({ type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'wrap-up' }] } } }, { type: 'turn/end', time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } })
  const next = await h.call('follow', { session_id: 's1', cursor: first.cursor, timeout_s: 5 })
  assert.deepEqual([next.state, next.rounds.at(-1).final_text], ['goal_ended', 'wrap-up'])
})

test('goal edge cases: cleared within one call, a projection that cannot be read, a first call after the goal stopped', async (t) => {
  const goal = { s1: goalValue(), s2: goalValue('complete') }
  const log = { s1: [...round(1, { round: 1, text: 'r1', at: Date.now() - 3000 })], s2: [...round(1, { text: 'stage', at: Date.now() - 9000 }), ...round(2, { round: 1, text: 'final words', at: Date.now() - 5000 })] }
  const h = startHost({ goal, log, goals: { get: () => ({ id: 'goal-1', activation: 'armed' }) }, agents: { get: (id) => ({ id }) } }); t.after(h.close); await h.ready
  // Seen active, then cleared in the same call (no cursor): the goal ended, not "no goal".
  const p = h.call('follow', { session_id: 's1', timeout_s: 10 })
  await sleep(100)
  goal.s1 = undefined
  log.s1.push({ type: 'goal/change', time: Date.now() - 60000, data: { operation: 'clear' } })
  logged(h, 's1', 'goal/change')
  assert.deepEqual([(await p).state, (await p).ended_because], ['goal_ended', 'cleared'])
  // The projection fails for a moment: not taken for a cleared goal.
  Object.defineProperty(goal, 's1', { get() { throw new Error('projection failed') }, configurable: true })
  const odd = await h.call('follow', { session_id: 's1', cursor: '1:1', timeout_s: 0.5 })
  assert.deepEqual([odd.state, odd.timed_out], ['following', true])
  // Following a goal that already stopped: its last round comes with the report.
  const late = await h.call('follow', { session_id: 's2', timeout_s: 5 })
  assert.deepEqual([late.state, late.rounds.map((x) => x.final_text)], ['goal_ended', ['final words']])
})

test('a run whose goal finished before anyone waited: the result still says so, so the wait reports the later rounds', async (t) => {
  const goal = { s1: goalValue() }
  const h = startHost({ goal }); t.after(h.close); await h.ready
  const s = S('s1')
  const r = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.text('first stage')); h.emit(...s.turnEnd())
  h.emit(...s.turnStart())
  h.emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 } } })
  h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  goal.s1 = { ...goalValue('complete'), updatedAt: Date.now() }
  const w = await h.call('wait', { run_id: r.run_id, timeout_s: 5 })
  assert.deepEqual([w.state, w.goal.phase, w.goal.ended_since_run], ['completed', 'complete', true])
  // A goal complete before the run began is not this run's.
  goal.s1 = { ...goalValue('complete'), updatedAt: 1 }
  assert.equal('goal' in (await h.call('wait', { run_id: r.run_id, timeout_s: 5 })), false)
})

test('a report on a long wait: every round since is there, the latest in full and the ones before as one-line digests', async (t) => {
  const start = Date.now() - 100000
  const long = 'x'.repeat(400)
  const goal = { s1: goalValue('complete') }
  const log = { s1: Array.from({ length: 30 }, (_, i) => round(i + 1, { round: i + 1, text: i === 29 ? 'final summary' : `round ${i + 1} ${long}`, tools: ['bash'], at: start + i * 1000 })).flat() }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  const r = await h.call('follow', { session_id: 's1', since_ms: start - 1, timeout_s: 5 })
  assert.equal(r.rounds.length, 30, 'no round dropped')
  assert.equal('earlier_rounds_not_shown' in r, false)
  assert.deepEqual(r.rounds.at(-1).final_text, 'final summary')
  assert.equal(r.rounds[0].final_text, undefined)
  assert.ok(r.rounds[0].summary.startsWith('round 1 x') && r.rounds[0].summary.length <= 101, 'a digest is one short line')
  assert.deepEqual(r.rounds[0].tools, { bash: 1 })
})

test('following until turn: a report at the first round end once every_s have passed, with every round since', async (t) => {
  const goal = { s1: goalValue() }
  const log = { s1: [] }
  const h = startHost({ goal, log }); t.after(h.close); await h.ready
  const t0 = Date.now()
  const p = h.call('follow', { session_id: 's1', until: 'turn', every_s: 1, timeout_s: 10 })
  await sleep(100)
  log.s1.push(...round(1, { round: 1, text: 'one' }), ...round(2, { round: 2, text: 'two' }))
  logged(h, 's1', 'turn/end')
  await sleep(100)
  // Round 3 is still running when the second is up: the report waits for its end.
  log.s1.push(...round(3, { round: 3, text: 'three', open: true }))
  logged(h, 's1', 'turn/start')
  await sleep(1200)
  log.s1.push({ type: 'turn/end', time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } })
  logged(h, 's1', 'turn/end')
  const first = await p
  assert.equal(first.state, 'report')
  assert.ok(Date.now() - t0 >= 1300, 'not before round 3 ended')
  assert.deepEqual(first.rounds.map((x) => x.final_text ?? x.summary), ['one', 'two', 'three'])
  // Next: one round ends at once and nothing runs after it, so it is reported when the time is up.
  const t1 = Date.now()
  const p2 = h.call('follow', { session_id: 's1', until: 'turn', every_s: 1, cursor: first.cursor, timeout_s: 10 })
  await sleep(100)
  log.s1.push(...round(4, { round: 4, text: 'four' }))
  logged(h, 's1', 'turn/end')
  const second = await p2
  assert.equal(second.state, 'report')
  assert.ok(Date.now() - t1 >= 900)
  assert.deepEqual(second.rounds.map((x) => x.final_text), ['four'], 'nothing repeated')
  // Switching to goal mode with the same cursor goes on from there.
  log.s1.push(...round(5, { round: 5, text: 'five' }))
  goal.s1 = goalValue('complete')
  const last = await h.call('follow', { session_id: 's1', cursor: second.cursor, timeout_s: 5 })
  assert.deepEqual(last.rounds.map((x) => x.final_text), ['five'])
  // Nothing due: the call times out and hands the same cursor back.
  goal.s1 = goalValue()
  const idle = await h.call('follow', { session_id: 's1', until: 'turn', every_s: 600, cursor: last.cursor, timeout_s: 1 })
  assert.deepEqual([idle.state, idle.timed_out, idle.cursor], ['following', true, last.cursor])
})

test('a goal Harness will not go on with by itself comes back at once; with no way to tell, a goal with no new round does', async (t) => {
  // Harness's goals service says disarmed (e.g. after a restart, until a person resumes it).
  const goal = { s1: goalValue(), s2: goalValue() }
  const h = startHost({ goal, log: {}, goals: { get: (agent) => ({ id: 'goal-1', activation: agent.id === 's1' ? 'disarmed' : 'armed' }) }, agents: { get: (id) => ({ id }) } })
  t.after(h.close); await h.ready
  assert.equal((await h.call('follow', { session_id: 's1', timeout_s: 5 })).state, 'needs_resume')
  const armed = await h.call('follow', { session_id: 's2', timeout_s: 1 })
  assert.deepEqual([armed.state, armed.timed_out, armed.goal.activation], ['following', true, 'armed'])
  // A session Harness has not loaded (no live agent, e.g. after a restart) runs nothing.
  const h4 = startHost({ goal: { s5: goalValue() }, log: {}, goals: { get: () => ({ id: 'goal-1', activation: 'armed' }) }, agents: { get: () => undefined } })
  t.after(h4.close); await h4.ready
  assert.equal((await h4.call('follow', { session_id: 's5', timeout_s: 5 })).state, 'needs_resume')
  // Without the services, the activation event says it.
  const h2 = startHost({ goal: { s3: goalValue() }, log: {} }); t.after(h2.close); await h2.ready
  h2.emit('goal/activation-changed', { sessionId: 's3', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } })
  assert.equal((await h2.call('follow', { session_id: 's3', timeout_s: 5 })).state, 'needs_resume')
  // Nothing says: no new round for the quiet time counts as stopped.
  process.env.DSH_BATON_GOAL_QUIET_MS = '300'
  const h3 = startHost({ goal: { s4: goalValue() }, log: {} })
  delete process.env.DSH_BATON_GOAL_QUIET_MS
  t.after(h3.close); await h3.ready
  const t0 = Date.now()
  const stalled = await h3.call('follow', { session_id: 's4', timeout_s: 5 })
  assert.equal(stalled.state, 'goal_stalled')
  assert.ok(Date.now() - t0 < 2000)
  // Also when the client follows in calls shorter than the quiet: it adds up through the cursor.
  let st = await h3.call('follow', { session_id: 's4', timeout_s: 0.1 })
  for (let i = 0; i < 20 && st.timed_out; i++) st = await h3.call('follow', { session_id: 's4', cursor: st.cursor, timeout_s: 0.1 })
  assert.equal(st.state, 'goal_stalled')
})

test('Harness asking during a follow: a question that comes just after the waiting status is still one to answer; rounds before it stay for the report', async (t) => {
  const start = Date.now() - 10000
  const goal = { s1: goalValue() }
  const log = { s1: [...round(1, { round: 1, text: 'r1', at: start + 1000 }), ...round(2, { round: 2, text: 'r2', at: start + 2000 })] }
  const h = startHost({ goal, log, goals: { get: () => ({ id: 'goal-1', activation: 'armed' }) }, agents: { get: (id) => ({ id }) } }); t.after(h.close); await h.ready
  const p = h.call('follow', { session_id: 's1', since_ms: start, timeout_s: 5 })
  await sleep(100)
  h.emit(...S('s1').status('waiting'))
  await sleep(150)
  h.ask('s1', [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }])
  const q = await p
  assert.deepEqual([q.state, q.needs_input, q.rounds_since_report, 'rounds' in q], ['needs_input', 'answer', 2, false], 'not an approval: the question came within the grace time')
  assert.equal((await h.call('answer', { session_id: 's1', answers: [{ choose: [1] }] })).submitted, true)
  h.emit(...S('s1').status('running'))
  log.s1.push(...round(3, { round: 3, text: 'r3' }))
  goal.s1 = goalValue('complete')
  const end = await h.call('follow', { session_id: 's1', cursor: q.cursor, timeout_s: 5 })
  assert.deepEqual([end.state, end.rounds.map((x) => x.final_text ?? x.summary)], ['goal_ended', ['r1', 'r2', 'r3']], 'no round lost to the question')
  // A question asked between two calls of one follow is taken up too.
  goal.s1 = goalValue()
  h.ask('s1', [{ id: 'q2', question: 'Again?', options: [{ label: 'B' }] }])
  const again = await h.call('follow', { session_id: 's1', cursor: end.cursor, timeout_s: 5 })
  assert.deepEqual([again.state, again.question.questions[0].question], ['needs_input', 'Again?'])
})

test('the last round allowed: the report waits for it, also when the log does not show it running yet', async (t) => {
  const goal = { s1: { ...goalValue('active', { maxGoalRounds: 3 }), roundsStarted: 2 } }
  const log = { s1: [...round(1, { round: 2, text: 'r2', at: Date.now() - 1000 })] }
  const h = startHost({ goal, log, goals: { get: () => ({ id: 'goal-1', activation: 'armed' }) }, agents: { get: (id) => ({ id }) } }); t.after(h.close); await h.ready
  let result = null
  const p = h.call('follow', { session_id: 's1', timeout_s: 10 }).then((r) => { result = r; return r })
  await sleep(100)
  goal.s1 = { ...goalValue('active', { maxGoalRounds: 3 }), roundsStarted: 3, updatedAt: Date.now() }
  logged(h, 's1', 'goal/change')
  await sleep(200)
  assert.equal(result, null, 'the last round has not shown its end')
  log.s1.push(...round(2, { round: 3, text: 'last round summary' }))
  logged(h, 's1', 'turn/end')
  const r = await p
  assert.deepEqual([r.state, r.ended_because, r.rounds.at(-1).final_text], ['goal_ended', 'round_limit', 'last round summary'])
})

test('following: Harness asking or waiting for an approval comes back once, and its question is answered by session', async (t) => {
  const h = startHost({ goal: { s1: goalValue() }, log: { s1: [] } }); t.after(h.close); await h.ready
  const p = h.call('follow', { session_id: 's1', timeout_s: 5 })
  await sleep(100)
  h.emit(...S('s1').status('waiting'))
  const ui = await p
  assert.deepEqual([ui.state, ui.needs_input], ['needs_input', 'harness-ui'])
  const again = await h.call('follow', { session_id: 's1', cursor: ui.cursor, timeout_s: 1 })
  assert.equal(again.timed_out, true, 'the same wait is not reported twice')
  h.emit(...S('s1').status('running'))
  const p2 = h.call('follow', { session_id: 's1', cursor: ui.cursor, timeout_s: 5 })
  await sleep(100)
  const reply = h.ask('s1', [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }])
  const q = await p2
  assert.equal(q.needs_input, 'answer')
  assert.equal(q.question.questions[0].question, 'Which database?')
  const a = await h.call('answer', { session_id: 's1', answers: [{ choose: [2] }] })
  assert.deepEqual([a.submitted, a.session_id], [true, 's1'])
  assert.deepEqual(await reply, { answers: [{ id: 'db', selected: ['Postgres'] }] })
  await assert.rejects(h.call('answer', { session_id: 's1', answers: [{ choose: [1] }] }), /no open question/)
})

test('status by session id: what it is doing, its goal and its last turn\'s reply', async (t) => {
  const h = startHost({ goal: { s1: goalValue() }, log: { s1: [...round(7, { round: 6, text: 'wired up paging', tools: ['pwsh'] })] }, activity: () => [{ kind: 'turn', items: [] }] })
  t.after(h.close); await h.ready
  const st = await h.call('status', { session_id: 's1' })
  assert.equal(st.busy, true)
  assert.equal(st.goal.phase, 'active')
  assert.deepEqual([st.last_turn.turn, st.last_turn.goal_round, st.last_turn.final_text], [7, 6, 'wired up paging'])
  assert.equal(st.turn_running, false)
  const plain = await h.call('status', { session_id: 's2' })
  assert.equal('goal' in plain, false)
})

test('team: Agent Teams go on for the session before the prompt; a Harness without them sends nothing', async (t) => {
  const order = []
  const agentTeams = { setEnabled: async (agent, enabled) => { order.push(['team', agent.id, enabled]) } }
  const agents = { get: (id) => ({ id }) }
  const h = startHost({ agentTeams, agents })
  t.after(h.close); await h.ready
  const prompt = h.ctx.sessionController.prompt
  h.ctx.sessionController.prompt = async (r) => { order.push(['prompt', r.sessionId]); return prompt(r) }
  assert.deepEqual((await h.call('ping')).features, ['team'], 'the MCP server reads team support from ping')
  const st = await h.call('send', { message: 'split this up', cwd: W, team: true })
  assert.equal(st.team, true)
  assert.deepEqual(order, [['team', 'new-1', true], ['prompt', 'new-1']])
  // Agent Teams belong to the session: not changed for a message that would wait behind a
  // running turn (that turn would change too).
  await assert.rejects(h.call('send', { message: 'alone now', session_id: 'new-1', team: false }), /No message was sent: the session is busy, and Agent Teams apply to the whole session/)
  assert.equal(order.length, 2, 'nothing changed')
  const s = S('new-1')
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  h.emit(...s.text('split')); h.emit(...s.turnEnd()); h.emit(...s.status('idle'))
  assert.equal((await h.call('wait', { run_id: st.run_id, timeout_s: 5 })).state, 'completed')
  const off = await h.call('send', { message: 'alone now', session_id: 'new-1', team: false })
  assert.equal(off.team, false)
  assert.deepEqual(order.slice(2), [['team', 'new-1', false], ['prompt', 'new-1']])
  const plain = await h.call('send', { message: 'more', session_id: 'new-1' })
  assert.equal('team' in plain, false)
  assert.equal(order.length, 5, 'no team, no change')
  await assert.rejects(h.call('send', { message: 'x', session_id: 'new-1', team: 'yes' }), /team must be true or false/)
})

test('team on a Harness without per-session Agent Teams (0.2.2-rc.1 has only the install-wide one): no session is made, nothing is sent', async (t) => {
  const h = startHost({ agentTeams: { listMembers: () => [] }, agents: { get: (id) => ({ id }) } })
  t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'split this up', cwd: W, team: true }), /Nothing was sent: this DeepSeek Harness cannot turn Agent Teams on per session; that needs Harness 0\.2\.2-rc\.2 or later/)
  assert.deepEqual([h.calls.create.length, h.calls.prompt.length], [0, 0], 'no session is made')
})

test('team: Harness\'s own refusal (not the root session) comes back and nothing is sent', async (t) => {
  const agentTeams = { setEnabled: async () => { throw new Error('change Team mode from the root Session') } }
  const h = startHost({ agentTeams, agents: { get: (id) => ({ id }) } })
  t.after(h.close); await h.ready
  await assert.rejects(h.call('send', { message: 'x', session_id: 'child-1', team: true }), /No message was sent: Agent Teams could not be turned on \(change Team mode from the root Session\)/)
  assert.equal(h.calls.prompt.length, 0)
})

test('approvals after review: a broken or odd setting means ask, an approval for a person waits whatever else is open, "running" does not clear it, an id-less decision closes one', async (t) => {
  const h = startHost(); t.after(h.close); await h.ready
  const s = S('s1')
  const run = await h.call('send', { session_id: 's1', message: 'go' })
  h.emit(...s.turnStart()); h.emit(...s.userMessage(h.calls.prompt[0].requestId)); h.emit(...s.status('running'))
  for (const bad of ['{ not json', JSON.stringify({ approvals: 'Ask' }), JSON.stringify({ approvals: 'never' })]) {
    fs.writeFileSync(path.join(h.home, 'settings.json'), bad)
    assert.equal(await h.approve('s1'), 'rejected', `${bad}: left to the Harness UI`)
  }
  fs.writeFileSync(path.join(h.home, 'settings.json'), '{}')
  // A is allowed here and still open when B, turned down by Auto review, asks the user.
  h.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'A', toolName: 'bash' } })
  const waiting = h.call('wait', { run_id: run.run_id, timeout_s: 30 })
  h.emit('session/event', { id: 's1' }, { type: 'approval/asked', data: { id: 'B', toolName: 'bash', reason: 'Auto review denied tool "bash": x' } })
  const w = await waiting
  assert.deepEqual([w.needs_input, w.state], ['harness-ui', 'waiting'])
  h.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { id: 'A', outcome: 'allowed-once' } })
  h.emit(...s.status('running'))
  assert.equal((await h.call('status', { run_id: run.run_id })).state, 'waiting', 'B is still open: "running" and A\'s decision leave the wait')
  h.emit('session/event', { id: 's1' }, { type: 'approval/decided', data: { outcome: 'rejected' } })
  assert.equal((await h.call('status', { run_id: run.run_id })).state, 'running', 'the id-less decision closes the one open approval')
})

test('the settings route after review: a save from another machine is refused, a save names only its own fields, approvals save without model support, a broken file replaced keeps ask', async (t) => {
  const m = fakeModels()
  const { h, request, PAGE } = handoverRoute(t, { models: m }); await h.ready
  assert.equal((await request('POST', { approvals: 'ask' }, PAGE, { socket: { remoteAddress: '198.51.100.20' } })).code, 403, 'another machine on the network')
  assert.equal((await request('POST', { approvals: 'allow' }, PAGE, { socket: { remoteAddress: '::ffff:127.0.0.1' } })).code, 200)
  // Two saves at once: a model save waiting on the catalogue must not undo an approvals save.
  const slow = request('POST', { model: 'deepseek-account/deepseek-v4-pro' })
  const quick = request('POST', { approvals: 'ask' })
  await Promise.all([slow, quick])
  assert.deepEqual([settingsOf(h).handover.model, settingsOf(h).approvals], ['deepseek-account/deepseek-v4-pro', 'ask'])
  const effortOnly = await request('POST', { reasoning_effort: 'low' })
  assert.equal(effortOnly.code, 200)
  assert.equal(settingsOf(h).approvals, 'ask', 'a model or effort save leaves approvals alone')
  fs.writeFileSync(path.join(h.home, 'settings.json'), '{ broken')
  assert.equal((await request('POST', { model: null })).code, 200)
  assert.equal(settingsOf(h).approvals, 'ask', 'a broken file replaced: its approvals choice is unknown, so ask')
  assert.equal((await request('POST', { approvals: 'sometimes' })).code, 400)
  // A Harness that cannot choose a model per session: approvals still save, and show.
  const old = handoverRoute(t, { models: fakeModels({ selectModel: false }) }); await old.h.ready
  const saved = await old.request('POST', { approvals: 'ask' })
  assert.deepEqual([saved.code, saved.body.supported, saved.body.approvals], [200, false, 'ask'])
})

