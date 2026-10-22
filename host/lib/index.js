// dsh-baton-host: a DeepSeek Harness plugin that runs inside the Harness host
// (desktop app or `dsh web`) and serves a local control socket, so an outside
// orchestrator can list sessions, continue a specific session, and learn when
// its turn finishes. Everything goes through the host's own session controller,
// so prompts show up live in the Harness UI exactly like typed messages.
//
// Plugin form: named exports only (name / inject / apply), no default export.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { socketEndpoint, batonHome, socketPath as socketPathSetting } from './socket.js'

export const name = 'dsh-baton-host'
export const inject = ['sessionController', 'workspaceRegistry']

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const MAX_EVENTS = 200
const MAX_RUNS = 100
const QUIET_CONFIRM_MS = 2000
const CANCEL_ATTEMPTS = 3
const CANCEL_SETTLE_MS = 6000
const ACTIVITY_MAX_ERRORS = 10
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_WAIT_S = 24 * 3600
const MAX_HUMAN_INPUTS = 10
const PERSIST_DELAY_MS = 1000
// A relayed prompt's request id carries its sender ("dsh-baton.<sender>.<uuid>"), so the
// client half (lib/client.js) can label the message in the chat without any extra state.
const SENDER_RE = /^[a-z0-9-]{1,32}$/
const requestIdFor = (sender) => (sender ? `dsh-baton.${sender}.${crypto.randomUUID()}` : crypto.randomUUID())


const IS_WIN = process.platform === 'win32'

// A Unix socket file on macOS / Linux, a per-user named pipe on Windows (see socket.js).
function socketPath() {
  return socketEndpoint(socketPathSetting())
}

const probe = (sock) => new Promise((resolve) => {
  const conn = net.connect(sock)
  conn.on('connect', () => { conn.destroy(); resolve(true) })
  conn.on('error', () => resolve(false))
})

// Expand `~`, resolve, and follow symlinks when the path exists, so the same
// folder always compares equal (on macOS /tmp is a link to /private/tmp).
function normalizePath(p) {
  const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()))
  try { return fs.realpathSync.native(abs) } catch { return abs }
}

// Prepare the socket path without touching anything that is not ours: only our
// own directory gets 0700, only a stale socket is removed, and a live host that
// already answers there is left alone.
async function claimSocket(sock) {
  // A named pipe has no file to own, chmod or clean up; it disappears with its
  // server. Only refuse to start when another host already answers on it.
  if (IS_WIN) {
    if (await probe(sock)) throw new Error(`another dsh-baton-host already serves ${sock}; set DSH_BATON_SOCKET for a second host`)
    return
  }
  const dir = path.dirname(sock)
  const ours = dir === batonHome() || !fs.existsSync(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (ours) fs.chmodSync(dir, 0o700)
  let st
  try { st = fs.lstatSync(sock) } catch { return }
  if (!st.isSocket()) throw new Error(`${sock} exists and is not a socket; point DSH_BATON_SOCKET somewhere else`)
  const live = await probe(sock)
  if (live) throw new Error(`another dsh-baton-host already serves ${sock}; set DSH_BATON_SOCKET for a second host`)
  fs.unlinkSync(sock)
}

const parts = (content) => (Array.isArray(content) ? content.filter((c) => c && typeof c === 'object') : [])

const textOf = (content) => parts(content).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

function toolCallsOf(content) {
  return parts(content).filter((c) => c.type !== 'text' && c.type !== 'reasoning')
    .map((c) => ({ kind: c.type, name: c.name ?? c.toolName, input: c.input ?? c.arguments }))
}

const iso = (t) => (typeof t === 'number' ? new Date(t).toISOString() : t ?? null)

export function apply(ctx) {
  // This code runs inside the Harness host process: an uncaught error here can
  // take Harness down. Every event listener and timer goes through guard().
  const guard = (label, fn) => (...args) => {
    try {
      const result = fn(...args)
      if (result && typeof result.catch === 'function') result.catch((error) => logError(label, error))
    } catch (error) {
      logError(label, error)
    }
  }
  const logError = (label, error) => {
    try { ctx.logger?.error?.(`dsh-baton-host ${label}: ${error?.stack ?? error}`) } catch { /* logging must never throw */ }
  }

  const controller = ctx.sessionController
  const registry = ctx.workspaceRegistry
  const runs = new Map() // runId -> run
  const waiters = new Map() // runId -> Set<resolve>

  // --- run bookkeeping ------------------------------------------------------

  const publicRun = (run, tail = 20) => ({
    run_id: run.id, session_id: run.sessionId, state: run.state, started_at: run.startedAt, ended_at: run.endedAt,
    message_preview: run.preview, final_text: run.finalText, turn_end: run.turnEnd, error: run.error,
    ...(run.sender ? { sender: run.sender } : {}),
    ...(run.waitingOn ? { waiting_on: run.waitingOn } : {}),
    ...(run.supersededBy ? { superseded_by: run.supersededBy } : {}),
    ...(run.humanInputs?.length ? { human_interjections: run.humanInputs } : {}),
    ...(tail ? { recent_events: run.events.slice(-tail) } : {}),
  })

  const ACTIVE = ['queued', 'running', 'waiting']
  const isActive = (run) => ACTIVE.includes(run.state)

  function settle(run, state, extra = {}) {
    if (!isActive(run)) return
    Object.assign(run, extra, { state, endedAt: new Date().toISOString() })
    for (const resolve of waiters.get(run.id) ?? []) resolve()
    waiters.delete(run.id)
    persist(run)
    if (!activeRunsFor(run.sessionId).length) forgetSession(run.sessionId)
  }

  // Per-session bookkeeping only lives while the session has active runs, so a
  // host that stays up for days does not accumulate state for idle sessions.
  function forgetSession(sessionId) {
    clearTimeout(quietTimers.get(sessionId))
    quietTimers.delete(sessionId)
    quietSinceBySession.delete(sessionId)
    lastRunningAt.delete(sessionId)
    activityErrors.delete(sessionId)
  }

  // Active relayed runs of one session, oldest first. Several can be active at
  // once: a followup waits in Harness's queue behind the current turn, and a
  // steer joins the turn that is already running.
  const activeRunsFor = (sessionId) => [...runs.values()].filter((r) => r.sessionId === sessionId && isActive(r))
  // Runs whose prompt has entered the conversation and that are not finished yet.
  const receiversFor = (sessionId) => activeRunsFor(sessionId).filter((r) => r.sawPrompt)
  // Of those, the runs the current turn's output belongs to. A run is closed for
  // output once a newer user-started turn begins; it may still wait for its
  // sub-agents or jobs before it completes.
  const outputReceiversFor = (sessionId) => receiversFor(sessionId).filter((r) => !r.outputClosed)

  function pushEvent(run, e) {
    run.events.push(e)
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS)
    persist(run)
  }

  // --- persistence: run records survive a Harness restart -----------------------
  // One JSON file per run under <baton home>/host-runs, written at most once a
  // second per change burst. Enabled only once this host owns the socket, so a
  // second host never overwrites the first one's records.

  const store = { dir: path.join(batonHome(), 'host-runs'), enabled: false, dirty: new Set(), timer: null }
  const RUN_FILE = /^(hrun-[\w-]+)\.json$/

  function persist(run) {
    if (!store.enabled) return
    store.dirty.add(run.id)
    if (!store.timer) store.timer = setTimeout(guard('persist runs', flushRuns), PERSIST_DELAY_MS)
  }

  function writeRunFile(run) {
    const file = path.join(store.dir, `${run.id}.json`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(run), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function flushRuns() {
    clearTimeout(store.timer)
    store.timer = null
    for (const id of store.dirty) {
      const run = runs.get(id)
      try {
        if (run) writeRunFile(run)
        else fs.rmSync(path.join(store.dir, `${id}.json`), { force: true })
      } catch (error) { logError('persist run', error) }
    }
    store.dirty.clear()
  }

  // Load earlier records. A run that was active when Harness went away cannot
  // finish any more (Harness ends the turn on restart), so it is marked interrupted.
  function enableStore() {
    fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 })
    if (!IS_WIN) fs.chmodSync(store.dir, 0o700)
    const loaded = []
    for (const name of fs.readdirSync(store.dir)) {
      const m = RUN_FILE.exec(name)
      if (!m) { if (name.endsWith('.tmp')) fs.rmSync(path.join(store.dir, name), { force: true }); continue }
      try {
        const run = JSON.parse(fs.readFileSync(path.join(store.dir, name), 'utf8'))
        if (run?.id === m[1]) loaded.push(run)
      } catch { fs.rmSync(path.join(store.dir, name), { force: true }) }
    }
    loaded.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    for (const old of loaded.splice(0, Math.max(0, loaded.length - MAX_RUNS))) fs.rmSync(path.join(store.dir, `${old.id}.json`), { force: true })
    store.enabled = true
    for (const run of loaded) {
      if (runs.has(run.id)) continue
      run.events ??= []
      runs.set(run.id, run)
      if (isActive(run)) {
        Object.assign(run, { state: 'interrupted', endedAt: new Date().toISOString(), error: 'Harness restarted while this run was active; its turn was stopped.' })
        persist(run)
      }
    }
  }

  // Per-session turn state: whether the current turn has produced assistant
  // output yet. A user message before any output opens the turn (a queued
  // followup, or someone typing in the Harness UI); one after it is a steer.
  const turns = new Map() // sessionId -> { hasOutput }

  ctx.on('session/event', guard('session/event', (session, event) => {
    const data = event.data ?? {}
    // Turn state is kept only for a turn in progress and dropped at its end.
    if (event.type === 'turn/start') turns.set(session.id, { hasOutput: false })
    else if (event.type === 'assistant/message' && turns.has(session.id)) turns.get(session.id).hasOutput = true
    const active = activeRunsFor(session.id)
    if (event.type === 'turn/end' && !active.some((r) => r.sawPrompt)) turns.delete(session.id)
    if (!active.length) return
    if (event.type === 'user/message') {
      const run = active.find((r) => r.requestId === data.source?.rpcId)
      const opensTurn = !turns.get(session.id)?.hasOutput
      // A user message no relayed run sent: someone typing in the Harness UI (or
      // another client). Mid-turn it joins the work of the runs in progress, so
      // they record it: their result then reflects that input too.
      const fromBridge = run || [...runs.values()].some((r) => r.requestId === data.source?.rpcId)
      if (data.source?.kind === 'user' && !fromBridge && !opensTurn) {
        const text = textOf(data.content).slice(0, 500)
        for (const r of outputReceiversFor(session.id)) {
          r.humanInputs = [...(r.humanInputs ?? []), { time: iso(event.time) ?? new Date().toISOString(), text }].slice(-MAX_HUMAN_INPUTS)
          pushEvent(r, { type: 'human_input', text })
        }
      }
      if (data.source?.kind === 'user' && opensTurn && run?.mode !== 'steer') {
        // A new user-started turn: runs whose own turn already ended keep their
        // result instead of absorbing this turn's output, but still wait for any
        // sub-agents or jobs they started. Turns woken by sub-agent results carry
        // no user message, and a relayed steer joins the current work, so neither
        // closes earlier runs.
        let closed = false
        for (const prev of active) {
          if (prev !== run && prev.sawPrompt && prev.turnEnd && !prev.outputClosed) {
            Object.assign(prev, { outputClosed: true, supersededBy: run?.id ?? 'user' })
            closed = true
          }
        }
        if (closed) scheduleQuietCheck(session.id, 0)
      }
      if (run) { Object.assign(run, { sawPrompt: true, state: 'running' }); persist(run) }
      return
    }
    const receivers = outputReceiversFor(session.id)
    if (!receivers.length) return
    if (event.type === 'assistant/message') {
      const content = data.message?.content
      const text = textOf(content)
      for (const run of receivers) {
        for (const call of toolCallsOf(content)) pushEvent(run, { type: 'tool_call', ...call })
        if (text) {
          pushEvent(run, { type: 'text', text })
          run.finalText = text
        }
      }
    } else if (event.type === 'tool/result') {
      for (const run of receivers) pushEvent(run, { type: 'tool_result', status: data.status ?? (data.error ? 'error' : 'completed') })
    } else if (event.type === 'turn/end') {
      // The turn that carried these prompts is over. A failed turn ends the run; a
      // completed one ends it only once the session is quiet (no sub-agents or jobs
      // left), because Harness wakes the agent again when those report back.
      const reason = data.reason ?? null
      for (const run of receivers) { run.turnEnd = reason; persist(run) }
      if (reason?.kind && reason.kind !== 'completed') for (const run of receivers) settle(run, 'failed')
      else scheduleQuietCheck(session.id, 1000)
      turns.delete(session.id)
    }
  }))

  // --- completion: wait until the session has no running turn, sub-agents or jobs

  const quietTimers = new Map() // sessionId -> timeout
  const quietSinceBySession = new Map() // sessionId -> ms when activity was first seen empty
  const lastRunningAt = new Map() // sessionId -> ms of the last running status
  const activityErrors = new Map() // sessionId -> consecutive activity read failures

  function scheduleQuietCheck(sessionId, delayMs) {
    clearTimeout(quietTimers.get(sessionId))
    quietTimers.set(sessionId, setTimeout(guard('quiet check', () => checkQuiet(sessionId)), delayMs))
  }

  async function sessionActivity(sessionId) {
    return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  }

  async function checkQuiet(sessionId) {
    quietTimers.delete(sessionId)
    const receivers = receiversFor(sessionId)
    if (!receivers.length) return
    let items
    try {
      items = await sessionActivity(sessionId)
      if (!Array.isArray(items)) throw new Error('session activity is not a list')
      activityErrors.delete(sessionId)
    } catch (error) {
      // Unknown is not idle: keep waiting and retry; give up only after repeated failures.
      const count = (activityErrors.get(sessionId) ?? 0) + 1
      activityErrors.set(sessionId, count)
      const message = `could not read session activity: ${error?.message ?? error}`
      if (count >= ACTIVITY_MAX_ERRORS) {
        activityErrors.delete(sessionId)
        for (const run of receivers) settle(run, 'completed', { error: `${message} (gave up after ${count} tries; sub-agents may still be running)` })
      } else {
        for (const run of receivers) run.error = message
        scheduleQuietCheck(sessionId, 3000)
      }
      return
    }
    const summary = (list) => list.map((g) => ({ kind: g.kind, count: g.items?.length ?? 0, labels: (g.items ?? []).map((i) => i.label ?? i.id) }))
    // Closed runs: the running turn belongs to a newer run, so only their
    // background work (sub-agents, jobs, reminders) keeps them open.
    const background = items.filter((g) => g.kind !== 'turn')
    for (const run of receivers.filter((r) => r.outputClosed)) {
      if (background.length === 0) settle(run, 'completed', { waitingOn: null, error: null })
      else { run.waitingOn = summary(background); persist(run) }
    }
    // A run whose own turn has not ended (and that has not seen the agent idle) is not done yet.
    const open = receivers.filter((r) => !r.outputClosed && (r.turnEnd || r.idleSeen))
    if (items.length === 0 && open.length) {
      // After waiting on sub-agents or jobs, Harness wakes the agent for a final
      // turn shortly after they finish. Confirm the quiet holds for a moment (no
      // new running status) so that last turn is not missed.
      const waited = open.some((r) => r.waitingOn)
      const quietSince = quietSinceBySession.get(sessionId)
      if (waited && (quietSince === undefined || (lastRunningAt.get(sessionId) ?? 0) > quietSince)) {
        quietSinceBySession.set(sessionId, Date.now())
        scheduleQuietCheck(sessionId, QUIET_CONFIRM_MS)
        return
      }
      quietSinceBySession.delete(sessionId)
      for (const run of open) settle(run, 'completed', { waitingOn: null, error: null })
      return
    }
    quietSinceBySession.delete(sessionId)
    for (const run of open) run.waitingOn = items.length ? summary(items) : run.waitingOn
    if (receiversFor(sessionId).length) scheduleQuietCheck(sessionId, 3000)
  }

  ctx.effect(() => () => { for (const t of quietTimers.values()) clearTimeout(t) }, 'dsh-baton-host quiet timers')

  ctx.on('agent/status', guard('agent/status', ({ agent, status }) => {
    if (!agent) return
    const receivers = receiversFor(agent.id)
    if (status === 'running' && receivers.length) lastRunningAt.set(agent.id, Date.now())
    for (const run of outputReceiversFor(agent.id)) {
      if (status === 'running') run.state = 'running'
      else if (status === 'waiting') run.state = 'waiting' // needs a person in the Harness UI (approval / question)
      else if (status === 'error') settle(run, 'failed')
      else if (status === 'idle') run.idleSeen = true
    }
    if (status === 'idle' && receivers.length) scheduleQuietCheck(agent.id, 0)
  }))

  ctx.on('agent/error', guard('agent/error', ({ agent, error }) => {
    for (const run of agent ? outputReceiversFor(agent.id) : []) run.error = String(error?.message ?? error)
  }))

  // --- operations -----------------------------------------------------------

  const signal = () => new AbortController().signal

  function workspaces() {
    return registry.list().map((w) => ({ id: w.id, path: w.path, title: w.title, session_count: w.sessionIds.length }))
  }

  // Register a folder as a sidebar workspace (idempotent: an already registered
  // path returns its existing workspace). Creates the folder when asked.
  async function createWorkspace({ path: dir, title, create_dir = true }) {
    if (!dir) throw new Error('path is required')
    if (create_dir) fs.mkdirSync(normalizePath(dir), { recursive: true })
    const abs = normalizePath(dir)
    const existed = await registry.resolveByPath(abs).catch(() => undefined)
    const ws = existed ?? (await registry.create(abs, title))
    return { id: ws.id, path: ws.path, title: ws.title, created: !existed }
  }

  // archivedSessionIds may be any iterable, so read it through a Set.
  const isArchived = (sessionId) => new Set(registry.archivedSessionIds ?? []).has(sessionId)

  async function listSessions({ cwd, query, limit = 20, include_subagents = false } = {}) {
    const { items } = await controller.list({}, signal())
    const want = cwd ? normalizePath(cwd) : null
    const q = query?.toLowerCase()
    const archived = new Set(registry.archivedSessionIds)
    const out = []
    for (const item of items) {
      if (archived.has(item.sessionId)) continue
      if (item.parentSessionId && !include_subagents) continue
      const row = {
        session_id: item.sessionId, cwd: item.cwd ?? null, title: item.title ?? item.projections?.values?.title ?? null,
        updated_at: iso(item.updatedAt), running: !!item.running, blank: !!item.blank,
        bridge_runs: activeRunsFor(item.sessionId).map((r) => r.id),
      }
      if (want && (!row.cwd || normalizePath(row.cwd) !== want)) continue
      if (q && !`${row.title ?? ''} ${row.cwd ?? ''} ${row.session_id}`.toLowerCase().includes(q)) continue
      out.push(row)
      if (out.length >= limit) break
    }
    return out
  }

  async function readSession({ session_id, last = 10 }) {
    const { meta, events } = await controller.inspect(session_id, signal())
    const messages = []
    let title = null
    for (const e of events) {
      if (e.type === 'session/title') title = e.data?.title ?? title
      else if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
        messages.push({ role: 'user', time: iso(e.time), text: textOf(e.data.content) })
      } else if (e.type === 'assistant/message') {
        const content = e.data?.message?.content
        const tools = toolCallsOf(content).map((t) => t.name ?? t.kind)
        const text = textOf(content)
        if (text || tools.length) messages.push({ role: 'assistant', time: iso(e.time), text, ...(tools.length ? { tools } : {}) })
      }
    }
    return { session_id, ...(isArchived(session_id) ? { archived: true } : {}), cwd: meta?.cwd ?? null, title, total_messages: messages.length, messages: messages.slice(-last) }
  }

  async function send({ message, session_id, cwd, workspace_id, mode = 'followup', sender }) {
    if (!message || !message.trim()) throw new Error('message is required')
    if (sender != null && !SENDER_RE.test(sender)) throw new Error('sender must be 1-32 characters of a-z, 0-9 or -')
    let sessionId = session_id
    let workspace = null
    // Harness never runs a prompt sent to an archived session: the run would stay queued forever.
    if (sessionId && isArchived(sessionId)) {
      throw new Error(`Session ${sessionId} is archived. Unarchive it in Harness, or start a new session with cwd or workspace_id.`)
    }
    if (!sessionId) {
      if (!cwd && !workspace_id) throw new Error('A new session needs cwd or workspace_id. Pass session_id to continue an existing one.')
      // A folder that is not a workspace yet is registered first, so the new session shows in the sidebar.
      workspace = workspace_id ? { id: workspace_id } : await createWorkspace({ path: cwd, create_dir: false })
      sessionId = (await controller.create({ workspaceId: workspace.id })).sessionId
    }
    const ahead = activeRunsFor(sessionId).map((r) => r.id)
    const run = {
      id: `hrun-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      sessionId, requestId: requestIdFor(sender), ...(sender ? { sender } : {}), mode, state: 'queued', sawPrompt: false,
      startedAt: new Date().toISOString(), endedAt: null, preview: message.slice(0, 200),
      events: [], finalText: null, turnEnd: null, error: null,
    }
    remember(run)
    try {
      await controller.prompt({ sessionId, requestId: run.requestId, content: [{ type: 'text', text: message }], mode }, signal())
    } catch (error) {
      settle(run, 'failed', { error: String(error?.message ?? error) })
    }
    return {
      ...publicRun(run),
      mode,
      ...(ahead.length ? { other_active_runs: ahead } : {}),
      ...(workspace ? { workspace } : {}),
    }
  }

  // Keep at most MAX_RUNS records, dropping the oldest finished one; active runs are never evicted.
  function remember(run) {
    runs.set(run.id, run)
    persist(run)
    if (runs.size <= MAX_RUNS) return
    for (const [id, r] of runs) {
      if (!isActive(r)) { runs.delete(id); persist({ id }); return }
    }
  }

  function getRun(runId) {
    const run = runs.get(runId)
    if (!run) throw new Error(`Unknown run: ${runId} (only the latest 100 runs are kept)`)
    return run
  }

  async function wait({ run_id, timeout_s = 300 }) {
    const run = getRun(run_id)
    const seconds = Number.isFinite(Number(timeout_s)) ? Math.min(Math.max(Number(timeout_s), 0), MAX_WAIT_S) : 300
    if (isActive(run)) {
      await new Promise((resolve) => {
        const set = waiters.get(run.id) ?? new Set()
        waiters.set(run.id, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          resolve()
        }
        const timer = setTimeout(done, seconds * 1000)
        set.add(done)
      })
    }
    const done = !isActive(run)
    return { ...publicRun(run), ...(done ? {} : { timed_out: true }) }
  }

  // What a session is doing right now, as Harness reports it for archiving:
  // its running turn, sub-agents (any depth), background jobs and reminders.
  async function activity({ session_id }) {
    if (!session_id) throw new Error('session_id is required')
    const items = await sessionActivity(session_id)
    return {
      session_id,
      ...(isArchived(session_id) ? { archived: true } : {}),
      busy: items.length > 0,
      activity: items,
      bridge_runs: activeRunsFor(session_id).map((r) => ({ run_id: r.id, state: r.state, in_conversation: r.sawPrompt })),
    }
  }

  // Stop everything a session is doing (its turn, sub-agents, jobs, reminders)
  // through the same providers Harness uses when archiving, without archiving it.
  async function cancel({ run_id, session_id }) {
    const run = run_id ? getRun(run_id) : null
    const sessionId = run?.sessionId ?? session_id
    if (!sessionId) throw new Error('run_id or session_id is required')
    // A stop that arrives while sub-agents are still starting can be lost: the turn
    // carries on and starts them again. Re-issue it until the session is quiet.
    let attempts = 0
    let still
    while (attempts < CANCEL_ATTEMPTS) {
      attempts++
      await registry.stopSessionActivity(sessionId)
      for (const r of receiversFor(sessionId)) settle(r, 'cancelled')
      const deadline = Date.now() + CANCEL_SETTLE_MS
      do {
        await new Promise((r) => setTimeout(r, 1000))
        still = await activity({ session_id: sessionId })
      } while (still.busy && Date.now() < deadline)
      if (!still.busy) break
    }
    // The named run never reached the conversation (still queued, or sent to a session
    // that will not run it): settle it too, so nothing waits on it forever.
    if (run && isActive(run) && !run.sawPrompt) settle(run, 'cancelled')
    return {
      session_id: sessionId,
      ...(run ? { run: publicRun(run, 0) } : {}),
      attempts,
      still_busy: still.busy,
      activity: still.activity,
      queued_runs: activeRunsFor(sessionId).filter((r) => !r.sawPrompt).map((r) => r.id),
    }
  }

  async function renameSession({ session_id, title }) {
    if (!session_id || !title?.trim()) throw new Error('session_id and title are required')
    const result = await controller.rename({ sessionId: session_id, title: title.trim() })
    return { session_id, title: result?.title ?? title.trim() }
  }

  async function renameWorkspace({ workspace_id, path: dir, title }) {
    if (!title?.trim()) throw new Error('title is required')
    const ws = workspace_id ? registry.get(workspace_id) : dir ? await registry.resolveByPath(normalizePath(dir)).catch(() => undefined) : undefined
    if (!ws) throw new Error(`Workspace not found: ${workspace_id ?? dir}`)
    await ws.setTitle(title.trim())
    return { id: ws.id, path: ws.path, title: ws.title }
  }

  const methods = {
    ping: () => ({ name, version: VERSION, pid: process.pid }),
    workspaces,
    create_workspace: createWorkspace,
    list_sessions: listSessions,
    read_session: readSession,
    send,
    status: ({ run_id, tail }) => publicRun(getRun(run_id), tail ?? 20),
    wait,
    cancel,
    activity,
    rename_session: renameSession,
    rename_workspace: renameWorkspace,
    list_runs: ({ limit = 10 } = {}) => [...runs.values()].reverse().slice(0, limit).map((r) => publicRun(r, 0)),
  }

  // --- local socket (owner-only) ---------------------------------------------

  const connections = new Set()

  function serve(conn) {
    let buf = ''
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.setEncoding('utf8')
    conn.on('error', () => {})
    conn.on('data', (chunk) => {
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        conn.destroy()
        return
      }
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handle(line)
      }
    })
    async function handle(line) {
      try { await answer(line) } catch (error) { logError('socket request', error) }
    }
    async function answer(line) {
      let req
      try { req = JSON.parse(line) } catch { return conn.write(JSON.stringify({ id: null, error: 'parse error' }) + '\n') }
      try {
        const fn = typeof req.method === 'string' && Object.hasOwn(methods, req.method) ? methods[req.method] : undefined
        if (!fn) throw new Error(`Unknown method: ${req.method}`)
        const result = await fn(req.params ?? {})
        if (!conn.destroyed) conn.write(JSON.stringify({ id: req.id, result }) + '\n')
      } catch (error) {
        if (!conn.destroyed) conn.write(JSON.stringify({ id: req?.id ?? null, error: String(error?.message ?? error) }) + '\n')
      }
    }
  }


  ctx.effect(() => {
    const sock = socketPath()
    let server = null
    let disposed = false
    claimSocket(sock).then(() => {
      if (disposed) return
      try { enableStore() } catch (error) { logError('run store', error) }
      server = net.createServer(serve)
      server.on('error', (error) => ctx.logger?.error?.(`dsh-baton-host socket error: ${error.message}`))
      server.listen(sock, () => {
        if (!IS_WIN) try { fs.chmodSync(sock, 0o600) } catch { /* best effort */ }
        ctx.logger?.info?.(`dsh-baton-host listening on ${sock}`)
      })
    }).catch((error) => ctx.logger?.error?.(`dsh-baton-host not started: ${error.message}`))
    return () => {
      disposed = true
      if (store.enabled) { try { flushRuns() } catch (error) { logError('persist runs', error) } }
      store.enabled = false
      // Release callers blocked in wait() and close open connections, so an
      // unloaded or reloaded plugin leaves no timers or sockets behind.
      for (const set of waiters.values()) for (const done of [...set]) done()
      waiters.clear()
      for (const conn of connections) conn.destroy()
      if (!server) return
      server.close()
      if (!IS_WIN) try { if (fs.lstatSync(sock).isSocket()) fs.unlinkSync(sock) } catch { /* gone */ }
    }
  }, 'dsh-baton-host socket')
}
