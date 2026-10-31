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
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { socketEndpoint, batonHome, setting, socketPath as socketPathSetting } from './socket.js'

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

// The MCP server package this plugin registers: the checkout or ~/.dsh-baton/app folder
// this host folder sits in, else the dsh-baton-mcp package installed with the plugin. That
// one must be this plugin's own version (its exact dependency): a copy of another version
// left nested in the plugin folder (pnpm moves a link: plugin's folder in on uninstall) is
// not installed over ~/.dsh-baton/app.
function serverRoot() {
  const up = fileURLToPath(new URL('../../', import.meta.url))
  if (fs.existsSync(path.join(up, 'src', 'register.mjs'))) return path.resolve(up)
  // Looked up from here (a nested copy first), then from the folder the plugin is installed in.
  for (const from of [import.meta.url, pathToFileURL(path.join(fileURLToPath(new URL('../../', import.meta.url)), 'x.js')).href]) {
    try {
      const pkg = createRequire(from).resolve('dsh-baton-mcp/package.json')
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).version === VERSION) return path.dirname(pkg)
    } catch { /* not there */ }
  }
  return null
}

// The Harness install this process runs from, so its bundled Node (whose path changes
// with every Harness update) is never registered.
function harnessDir() {
  const exe = process.execPath
  const app = exe.match(/^(.*?\.app)(?=[\\/])/)
  if (app) return app[1]
  // Windows: the install folder, e.g. %LOCALAPPDATA%\Programs\DeepSeek Harness.
  const i = exe.toLowerCase().indexOf('deepseek harness')
  const end = i < 0 ? -1 : exe.slice(i).search(/[\\/]/)
  return end > 0 ? exe.slice(0, i + end) : null
}

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

  // A waterfall listener must never break Harness's chain: on any error of its own it
  // hands the request on untouched.
  const guardWaterfall = (fn) => function (request, next) {
    try { return fn(request, next) } catch (error) { logError('waterfall', error); return next() }
  }

  const controller = ctx.sessionController
  const registry = ctx.workspaceRegistry
  // Harness's settings service, when this Harness has one: read for its busy-send setting.
  let settings = null
  // Harness's default-model service (see defaultModel()), when this Harness has one.
  let defaultModelService = null
  // Harness's DeepSeek account service, when this Harness has one: read for the balance.
  let accountService = null
  const runs = new Map() // runId -> run
  let stopping = false // set when the plugin unloads: release every wait()
  const waiters = new Map() // runId -> Set<resolve>

  // --- run bookkeeping ------------------------------------------------------

  const publicRun = (run, tail = 20) => ({
    run_id: run.id, session_id: run.sessionId, state: run.state, started_at: run.startedAt, ended_at: run.endedAt,
    message_preview: run.preview, final_text: run.finalText, turn_end: run.turnEnd, error: run.error,
    ...(run.sender ? { sender: run.sender } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.waitingOn ? { waiting_on: run.waitingOn } : {}),
    ...(run.supersededBy ? { superseded_by: run.supersededBy } : {}),
    ...(run.humanInputs?.length ? { human_interjections: run.humanInputs } : {}),
    ...(run.question ? { question: run.question } : {}),
    ...(tail ? { recent_events: run.events.slice(-tail) } : {}),
  })

  const ACTIVE = ['queued', 'running', 'waiting']
  const isActive = (run) => ACTIVE.includes(run.state)

  // Release callers blocked in wait() without ending the run (it needs a person now).
  function wake(run) {
    for (const resolve of [...(waiters.get(run.id) ?? [])]) resolve()
  }

  // The run now waits for a person. The next wait() returns at once with what is asked
  // (once per episode: a second wait() blocks again until the run moves on).
  function needsPerson(run, delayMs = 0) {
    Object.assign(run, { state: 'waiting', waitNoticed: false })
    persist(run)
    if (delayMs) setTimeout(guard('waiting', () => wake(run)), delayMs)
    else wake(run)
  }

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
    // A run settled as removed from the queue whose message reaches the conversation
    // after all (the removal check guessed wrong) is taken up again.
    if (event.type === 'user/message') {
      const lost = [...runs.values()].find((r) => r.removedFromQueue && r.state === 'cancelled' && r.sessionId === session.id && r.requestId === data.source?.rpcId)
      if (lost) {
        Object.assign(lost, { state: 'queued', removedFromQueue: false, error: null, endedAt: null })
        pushEvent(lost, { type: 'queue_delivered' })
      }
    }
    const active = activeRunsFor(session.id)
    if (event.type === 'turn/end' && !active.some((r) => r.sawPrompt)) turns.delete(session.id)
    if (!active.length) return
    // Something left Harness's queue: a queued run may have been removed (session stopped,
    // or Remove in the Harness UI) rather than started. Checked once the dust settles.
    if (event.type === 'agent/inbox/spliced' && data.removedCount > 0 && active.some((r) => !r.sawPrompt)) {
      scheduleQueueCheck(session.id)
      return
    }
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
      // Needs a person: a question (see user-questions/request) or an approval in the
      // Harness UI. Waiters wake a moment later, so a question that comes with it is on the run.
      else if (status === 'waiting') { if (run.state !== 'waiting') needsPerson(run, 500) }
      else if (status === 'error') settle(run, 'failed')
      else if (status === 'idle') run.idleSeen = true
    }
    if (status === 'idle' && receivers.length) scheduleQuietCheck(agent.id, 0)
  }))

  ctx.on('agent/error', guard('agent/error', ({ agent, error }) => {
    for (const run of agent ? outputReceiversFor(agent.id) : []) run.error = String(error?.message ?? error)
  }))

  // --- Harness's queue (inbox) ------------------------------------------------
  // A followup sent while the session is busy waits in Harness's inbox until the turn
  // ends. Each pending message carries the request id it was sent with (source.rpcId),
  // so a run finds its own message there.

  const QUEUE_UNSUPPORTED = 'This DeepSeek Harness version cannot change queued messages: its session controller has no projections/updateQueue.'
  const queueTimers = new Map() // sessionId -> timeout
  const QUEUE_RECHECK_MS = Number(process.env.DSH_BATON_QUEUE_RECHECK_MS) || 2000

  // Messages still pending in a session's inbox, or null when this Harness cannot say.
  async function pendingMessages(sessionId) {
    if (typeof controller.projections !== 'function') return null
    const baseline = await controller.projections({ sessionId }, signal())
    if (baseline === null) return [] // no such session: nothing is pending
    const inbox = baseline?.values?.inbox
    if (!inbox) return null
    return [...(inbox['next-turn'] ?? []), ...(inbox['next-step'] ?? [])]
  }

  // Settle the runs whose message left the inbox without reaching the conversation:
  // Harness drops the queue when a session is stopped, and the Harness UI can remove one.
  // A message taken into the conversation also leaves the inbox, and its user/message
  // event can trail behind (edited messages, a busy disk), so a run counts as removed
  // only when it is still missing from both the inbox and the log a moment later.
  async function reconcileQueue(sessionId) {
    let gone = await missingFromQueue(sessionId, activeRunsFor(sessionId).filter((r) => r.admitted && !r.sawPrompt))
    if (!gone.length) return []
    await new Promise((resolve) => setTimeout(resolve, QUEUE_RECHECK_MS))
    gone = await missingFromQueue(sessionId, gone.filter((r) => isActive(r) && !r.sawPrompt))
    for (const run of gone) settle(run, 'cancelled', { error: 'Removed from the Harness queue before it ran.', removedFromQueue: true })
    return gone.map((r) => r.id)
  }

  // Of these runs, the ones whose message is neither pending in the inbox nor in the
  // session log. Nothing is missing when either cannot be read.
  async function missingFromQueue(sessionId, waiting) {
    if (!waiting.length) return []
    const pending = await pendingMessages(sessionId)
    if (pending === null) return []
    const ids = new Set(pending.map((m) => m?.source?.rpcId))
    const gone = waiting.filter((r) => !ids.has(r.requestId))
    if (!gone.length) return []
    const log = await controller.inspect(sessionId, signal()).catch(() => null)
    if (!Array.isArray(log?.events)) return []
    const delivered = new Set(log.events.filter((e) => e.type === 'user/message').map((e) => e.data?.source?.rpcId))
    return gone.filter((r) => !delivered.has(r.requestId) && !r.sawPrompt)
  }

  function scheduleQueueCheck(sessionId) {
    clearTimeout(queueTimers.get(sessionId))
    queueTimers.set(sessionId, setTimeout(guard('queue check', () => { queueTimers.delete(sessionId); return reconcileQueue(sessionId) }), 1500))
  }

  ctx.effect(() => () => { for (const t of queueTimers.values()) clearTimeout(t) }, 'dsh-baton-host queue timers')

  // Change a relayed message that is still waiting in Harness's queue: edit its text,
  // remove it, or move it into the running turn as a steer.
  async function updateQueued({ run_id, action, message }) {
    if (!['edit', 'remove', 'steer'].includes(action)) throw new Error('action must be edit, remove or steer')
    if (action === 'edit' && !message?.trim()) throw new Error('edit needs a non-empty message')
    const run = getRun(run_id)
    if (!isActive(run)) throw new Error(`Run ${run.id} is ${run.state}; only a queued run can be changed.`)
    if (run.sawPrompt) throw new Error(`Run ${run.id} has already reached the conversation and can no longer be changed. Send a correction with dsh_send mode steer, or stop the session with dsh_cancel.`)
    if (typeof controller.updateQueue !== 'function') throw new Error(QUEUE_UNSUPPORTED)
    const pending = await pendingMessages(run.sessionId)
    if (pending === null) throw new Error(QUEUE_UNSUPPORTED)
    const item = pending.find((m) => m?.source?.rpcId === run.requestId)
    const gone = `Run ${run.id} is no longer in the Harness queue: it has just started, or it was removed.`
    if (!item) throw new Error(gone)
    const change = action === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: message }] } : { kind: action }
    try {
      await controller.updateQueue({ sessionId: run.sessionId, itemId: item.id, action: change })
    } catch (error) {
      if (error?.code === 'session/queue-item-not-found') throw new Error(gone)
      if (error?.code === 'session/steer-unavailable') throw new Error(`The current turn of ${run.sessionId} no longer takes steering; the message stays queued.`)
      throw error
    }
    if (action === 'edit') {
      run.preview = message.slice(0, 200)
      pushEvent(run, { type: 'queue_edit', text: message.slice(0, 500) })
    } else if (action === 'steer') {
      run.mode = 'steer'
      pushEvent(run, { type: 'queue_steer' })
    } else {
      pushEvent(run, { type: 'queue_remove' })
      settle(run, 'cancelled', { error: null })
    }
    return { ...publicRun(run, 0), action }
  }

  // --- questions (ask_user_question) ----------------------------------------
  // Harness asks the user through the user-questions/request waterfall, whose answerer
  // is the Harness UI. Listening first, the plugin puts the question on the runs of that
  // turn (so wait() returns with it) and lets either side answer: the Harness UI, or
  // dsh_answer through answerQuestion(). The first answer wins.

  const questions = new Map() // sessionId -> open question
  const RECOMMENDED = /\(recommended\)|（推荐）|\(推荐\)|推荐/i

  function publicQuestion(entry) {
    return {
      question_id: entry.id,
      count: entry.items.length,
      questions: entry.items.map((q) => ({
        id: q.id,
        ...(q.header ? { header: q.header } : {}),
        question: q.question,
        ...(q.detail ? { detail: q.detail } : {}),
        multi_select: !!q.multiSelect,
        options: (q.options ?? []).map((o, i) => ({ number: i + 1, label: o.label, ...(o.description ? { description: o.description } : {}), ...(RECOMMENDED.test(o.label) ? { recommended: true } : {}) })),
        free_text: true,
        ...(entry.answers.has(q.id) ? { answered: true } : {}),
      })),
    }
  }

  function onQuestion(request, next) {
    const sessionId = request?.agent?.id
    const asked = sessionId && Array.isArray(request.questions) ? outputReceiversFor(sessionId) : []
    if (!asked.length) return next()
    const entry = { id: `q-${crypto.randomBytes(4).toString('hex')}`, sessionId, items: request.questions, answers: new Map(), runs: asked }
    const ours = new Promise((resolve) => { entry.resolve = resolve })
    questions.set(sessionId, entry)
    for (const run of asked) {
      run.question = publicQuestion(entry)
      pushEvent(run, { type: 'question', question_id: entry.id, count: entry.items.length })
      needsPerson(run)
    }
    // The Harness UI (next) gets its own signal: once dsh_answer wins, aborting it tells
    // the window to drop its question card, which it otherwise keeps open.
    const ui = new AbortController()
    const harnessSignal = request.signal
    request.signal = harnessSignal ? AbortSignal.any([harnessSignal, ui.signal]) : ui.signal
    // With no Harness window to answer, only dsh_answer can: that is not a failure here.
    const theirs = Promise.resolve().then(next).catch((error) => (error?.code === 'NO_PROVIDER' || ui.signal.aborted ? new Promise(() => {}) : Promise.reject(error)))
    const aborted = new Promise((_, reject) => harnessSignal?.addEventListener('abort', () => reject(harnessSignal.reason), { once: true }))
    const answered = (by) => (value) => {
      for (const run of asked) pushEvent(run, { type: 'question_answered', question_id: entry.id, by })
      return value
    }
    const fromBaton = ours.then((value) => { ui.abort(new Error('answered through dsh-baton')); return value })
    return Promise.race([theirs.then(answered('harness')), fromBaton.then(answered('dsh-baton')), aborted]).finally(() => {
      if (questions.get(sessionId) === entry) questions.delete(sessionId)
      for (const run of asked) {
        if (run.question?.question_id !== entry.id) continue
        delete run.question
        if (run.state === 'waiting') run.state = 'running'
        persist(run)
      }
    })
  }

  // Answer the open question of a run's turn. answers: [{ id?, choose?: [number | label],
  // text?, skip? }]; questions not answered yet stay open until every one has an answer.
  function answerQuestion({ run_id, answers }) {
    const run = getRun(run_id)
    const entry = questions.get(run.sessionId)
    if (!isActive(run) || !entry || run.question?.question_id !== entry.id) {
      if (run.state === 'waiting') throw new Error(`Run ${run.id} is waiting for something in the Harness UI (an approval, for example) that cannot be answered from here; tell the user.`)
      throw new Error(`Run ${run.id} is ${run.state} and has no open question to answer.`)
    }
    if (!Array.isArray(answers) || !answers.length) throw new Error('answers must list at least one answer')
    const staged = new Map()
    for (const a of answers) {
      const q = a?.id != null ? entry.items.find((item) => item.id === a.id) : entry.items.length === 1 ? entry.items[0] : undefined
      if (!q) throw new Error(a?.id != null ? `No question ${a.id}; the questions are ${entry.items.map((i) => i.id).join(', ')}` : 'id is required when there are several questions')
      const options = q.options ?? []
      const chosen = (a.choose ?? []).map((c) => {
        const byNumber = typeof c === 'number' || /^\d+$/.test(String(c)) ? options[Number(c) - 1] : undefined
        const option = byNumber ?? options.find((o) => o.label === c) ?? options.find((o) => o.label.toLowerCase().replace(RECOMMENDED, '').trim() === String(c).toLowerCase().replace(RECOMMENDED, '').trim())
        if (!option) throw new Error(`Question ${q.id} has no option ${JSON.stringify(c)}; options: ${options.map((o, i) => `${i + 1}. ${o.label}`).join('; ')}`)
        return option.label
      })
      const text = typeof a.text === 'string' && a.text.trim() ? a.text : undefined
      if (a.skip && (chosen.length || text)) throw new Error(`Question ${q.id}: skip cannot come with choose or text`)
      if (!a.skip && !chosen.length && !text) throw new Error(`Question ${q.id}: give choose, text or skip`)
      if (!q.multiSelect && chosen.length > 1) throw new Error(`Question ${q.id} takes one option`)
      // Single choice: typed text replaces the option (Harness's own rule).
      staged.set(q.id, a.skip ? { id: q.id, selected: [] } : !q.multiSelect && text ? { id: q.id, selected: [], custom: text } : { id: q.id, selected: chosen, ...(text ? { custom: text } : {}) })
    }
    for (const [id, item] of staged) entry.answers.set(id, item)
    const remaining = entry.items.filter((q) => !entry.answers.has(q.id)).map((q) => q.id)
    if (remaining.length) {
      for (const r of entry.runs) { if (r.question?.question_id === entry.id) { r.question = publicQuestion(entry); persist(r) } }
      return { ...publicRun(run, 0), submitted: false, remaining }
    }
    entry.resolve({ answers: entry.items.map((q) => entry.answers.get(q.id)) })
    return { ...publicRun(run, 0), submitted: true, answers: entry.items.map((q) => entry.answers.get(q.id)) }
  }

  ctx.on('user-questions/request', guardWaterfall(onQuestion), { global: true, prepend: true })

  // Harness's own "busy send" setting (Settings → sending while busy: queue or steer),
  // as a dsh-baton mode, or null when this Harness has no such setting to read.
  function harnessBusyMode() {
    try {
      const form = settings?.describe?.()?.find?.((d) => d.ns === 'ui-conversation')
      const value = form?.value?.busyEnter
      return value === 'steer' ? 'steer' : value === 'queue' ? 'followup' : null
    } catch { return null }
  }

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
        model: shownModel(item.projections?.values?.modelSelection?.next ?? item.projections?.values?.modelSelection?.lastUsed),
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

  // --- models -----------------------------------------------------------------
  // Harness's own catalog decides which names exist: "V4 Pro", "v4-pro" and "DeepSeek-V4-Pro"
  // all name the model whose id or name reads that way once case, spaces, hyphens,
  // underscores and a leading "deepseek" are left out. No model name is written here.

  const MODELS_UNSUPPORTED = 'This DeepSeek Harness version cannot choose a model per session: its session controller has no modelCatalog/selectModel. Leave out model and reasoning_effort, or update Harness.'
  const modelKey = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, '').replace(/^deepseek/, '')
  // Harness's default-model service comes through inject (below); reading it off ctx
  // without that throws in Harness, so that read is only a fallback.
  const defaultModel = () => {
    if (defaultModelService) return defaultModelService
    try { return ctx.agentDefaultModel ?? null } catch { return null }
  }
  const canSelect = () => typeof controller.modelCatalog === 'function' && typeof controller.selectModel === 'function'
  const shownModel = (s) => (s ? { provider: s.provider, model: s.model, reasoning_effort: s.reasoningEffort ?? null } : null)

  async function catalog() {
    if (typeof controller.modelCatalog !== 'function') throw new Error(MODELS_UNSUPPORTED)
    return controller.modelCatalog()
  }

  async function models() {
    const c = await catalog()
    return {
      default: shownModel(c.default),
      models: c.groups.flatMap((g) => g.models.map((m) => ({
        provider: g.id, model: m.id, name: m.name ?? m.id,
        ...(m.reasoning ? { reasoning_efforts: m.reasoning.efforts.map((e) => e.id), default_effort: m.reasoning.defaultEffort ?? null } : {}),
      }))),
      ...(c.failures?.length ? { failures: c.failures.map((f) => ({ provider: f.id, error: f.message })) } : {}),
    }
  }

  const listed = (c) => c.groups.flatMap((g) => g.models.map((m) => `${g.id}/${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''}`)).join(', ') || 'none'

  // One model, or an error naming what is there: never a near miss in its place.
  // "provider/model" picks between providers that offer the same model.
  function matchModel(c, asked) {
    const slash = String(asked).lastIndexOf('/')
    const provider = slash > 0 ? modelKey(String(asked).slice(0, slash)) : null
    const want = modelKey(slash > 0 ? String(asked).slice(slash + 1) : asked)
    const hits = c.groups.flatMap((g) => (provider && modelKey(g.id) !== provider ? [] : g.models
      .filter((m) => modelKey(m.id) === want || modelKey(m.name) === want)
      .map((m) => ({ provider: g.id, entry: m }))))
    if (!want || !hits.length) throw new Error(`No model in Harness matches ${JSON.stringify(asked)}. Available: ${listed(c)}.`)
    if (hits.length > 1) throw new Error(`${JSON.stringify(asked)} matches several models: ${hits.map((h) => `${h.provider}/${h.entry.id}`).join(', ')}. Pass one of them as provider/model.`)
    return hits[0]
  }

  function matchEffort(hit, asked) {
    const efforts = hit.entry.reasoning?.efforts ?? []
    if (!efforts.length) throw new Error(`${hit.provider}/${hit.entry.id} has no reasoning effort to choose.`)
    const e = efforts.find((x) => modelKey(x.id) === modelKey(asked) || modelKey(x.name) === modelKey(asked))
    if (!e) throw new Error(`${hit.provider}/${hit.entry.id} has no reasoning effort ${JSON.stringify(asked)}; it has ${efforts.map((x) => x.id).join(', ')}.`)
    return e.id
  }

  // What a session will run with next: its own choice or last request, else Harness's default.
  async function sessionModel(sessionId) {
    try {
      const p = typeof controller.projections === 'function' ? await controller.projections({ sessionId }, signal()) : null
      const s = p?.values?.modelSelection
      return s?.next ?? s?.lastUsed ?? null
    } catch { return null }
  }

  // selectModel also saves the pick as Harness's default model (in the background).
  // Every pick goes through this queue and the default it found is saved back after
  // it. Harness commits default saves in the order they are made, so the restore lands
  // after the pick's save. The default is read once per busy spell: a pick that starts
  // while another is still restoring would otherwise read that other pick as "the default".
  let modelQueue = Promise.resolve()
  let busyPicks = 0
  let keptDefault = null
  function keepingDefault(fn) {
    const dm = defaultModel()
    if (typeof dm?.currentSelection !== 'function' || typeof dm?.saveSelection !== 'function') {
      return Promise.reject(new Error('This DeepSeek Harness version does not let dsh-baton keep its default model while choosing one for a session, so no model was chosen. Leave out model and reasoning_effort, or update Harness.'))
    }
    busyPicks++
    const step = modelQueue.then(async () => {
      keptDefault ??= dm.currentSelection()
      try { return await fn(keptDefault) } finally {
        await dm.saveSelection(keptDefault).catch((error) => logError('restore default model', error))
      }
    }).finally(() => { if (--busyPicks === 0) keptDefault = null })
    modelQueue = step.catch(() => {})
    return step
  }

  // Work out the model a send asks for before anything is created, so a name that
  // matches nothing (or several) fails the send with the list of what is there.
  async function planModel(sessionId, { model, reasoning_effort }) {
    if (model == null && reasoning_effort == null) return null
    if (!canSelect()) throw new Error(MODELS_UNSUPPORTED)
    const c = await catalog()
    let hit
    if (model != null) hit = matchModel(c, model)
    else {
      // Effort alone: the model the session runs with now (a new one: Harness's default).
      const current = (sessionId && (await sessionModel(sessionId))) || c.default
      const entry = c.groups.find((g) => g.id === current?.provider)?.models.find((m) => m.id === current?.model)
      if (!entry) throw new Error(`The model ${current?.provider}/${current?.model} is not in Harness's catalog now; pass model too. Available: ${listed(c)}.`)
      hit = { provider: current.provider, entry }
    }
    return { provider: hit.provider, model: hit.entry.id, ...(reasoning_effort != null ? { reasoningEffort: matchEffort(hit, reasoning_effort) } : {}) }
  }

  // Put the session on its model before the prompt goes in. Without a plan, a new session
  // is pinned to the default as it stands, so a pick running for another send cannot leak
  // into it (Harness reads the default only when the first request is built); an existing
  // one keeps its own. The pin is best effort: if it fails, the session just uses the default.
  async function applyModel(sessionId, plan, isNew) {
    if (plan) {
      const { selected } = await keepingDefault(() => controller.selectModel({ sessionId, ...plan }))
      return { model: shownModel(selected), source: 'requested' }
    }
    if (isNew && canSelect() && defaultModel()) {
      try {
        const { selected } = await keepingDefault((kept) => controller.selectModel({ sessionId, ...kept }))
        return { model: shownModel(selected), source: 'default' }
      } catch (error) { logError('pin default model', error) }
    }
    return { model: shownModel(await sessionModel(sessionId)), source: isNew ? 'default' : 'session' }
  }

  // --- balance ------------------------------------------------------------------
  // A run on the DeepSeek account with no balance fails within a second, and clients
  // tended to send it again and again. So the send is refused up front when Harness's
  // account service says every wallet is empty. Anything else (not signed in, an API key
  // provider, the read failing) lets the send go ahead. A balance that was there is
  // trusted for a minute.
  const ACCOUNT_PROVIDER = 'deepseek-account'
  const BALANCE_TTL_MS = 60_000
  let balanceSeen = 0
  async function emptyBalance() {
    if (!accountService || typeof accountService.getBalance !== 'function' || Date.now() - balanceSeen < BALANCE_TTL_MS) return null
    try {
      const client = { version: VERSION, locale: 'en', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
      const b = await Promise.race([accountService.getBalance(client), new Promise((resolve) => setTimeout(resolve, 5000, null))])
      if (b?.status !== 'ready') return null
      const wallets = [...(b.value ?? []), ...(b.bonusWallets ?? [])]
      if (wallets.some((w) => Number(w.balance) > 0)) { balanceSeen = Date.now(); return null }
      return wallets.map((w) => `${w.currency} ${w.balance}`).join(', ') || 'none'
    } catch (error) {
      logError('read balance', error)
      return null
    }
  }

  async function send({ message, session_id, cwd, workspace_id, mode: asked, sender, model, reasoning_effort }) {
    if (!message || !message.trim()) throw new Error('message is required')
    if (asked != null && asked !== 'followup' && asked !== 'steer') throw new Error('mode must be followup or steer')
    // Without a mode, a message to a busy session does what Harness's own busy-send setting says.
    const fromHarness = asked == null ? harnessBusyMode() : null
    const mode = asked ?? fromHarness ?? 'followup'
    const modeSource = asked != null ? 'explicit' : fromHarness ? 'harness' : 'default'
    if (sender != null && !SENDER_RE.test(sender)) throw new Error('sender must be 1-32 characters of a-z, 0-9 or -')
    let sessionId = session_id
    let workspace = null
    // Harness never runs a prompt sent to an archived session: the run would stay queued forever.
    if (sessionId && isArchived(sessionId)) {
      throw new Error(`Session ${sessionId} is archived. Unarchive it in Harness, or start a new session with cwd or workspace_id.`)
    }
    if (!sessionId && !cwd && !workspace_id) throw new Error('A new session needs cwd or workspace_id. Pass session_id to continue an existing one.')
    const plan = await planModel(sessionId, { model, reasoning_effort })
    const isNew = !sessionId
    if (isNew) {
      // A folder that is not a workspace yet is registered first, so the new session shows in the sidebar.
      workspace = workspace_id ? { id: workspace_id } : await createWorkspace({ path: cwd, create_dir: false })
      sessionId = (await controller.create({ workspaceId: workspace.id })).sessionId
    }
    // A model that cannot be set fails the send before the prompt goes in.
    const chosen = await applyModel(sessionId, plan, isNew).catch((error) => {
      throw new Error(`${isNew ? `Session ${sessionId} was created, but no message was sent: ` : 'No message was sent: '}the model could not be set (${error?.message ?? error})`)
    })
    // A session that never picked a model runs on Harness's default.
    let provider = chosen.model?.provider
    if (!provider) try { provider = defaultModel()?.currentSelection?.()?.provider } catch { /* unknown: no check */ }
    if (provider === ACCOUNT_PROVIDER) {
      const empty = await emptyBalance()
      if (empty) throw new Error(`${isNew ? `Session ${sessionId} was created, but no message was sent` : 'No message was sent'}: the DeepSeek account has no balance left (${empty}), so the run would fail at once. Do not send again until the user has topped up (Harness → Settings → Account, or platform.deepseek.com).`)
    }
    const ahead = activeRunsFor(sessionId).map((r) => r.id)
    const run = {
      id: `hrun-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      sessionId, requestId: requestIdFor(sender), ...(sender ? { sender } : {}), mode, state: 'queued', sawPrompt: false,
      startedAt: new Date().toISOString(), endedAt: null, preview: message.slice(0, 200),
      events: [], finalText: null, turnEnd: null, error: null,
      ...(chosen.model ? { model: chosen.model } : {}),
    }
    remember(run)
    try {
      await controller.prompt({ sessionId, requestId: run.requestId, content: [{ type: 'text', text: message }], mode }, signal())
      run.admitted = true // in Harness's queue (or conversation) now
    } catch (error) {
      settle(run, 'failed', { error: String(error?.message ?? error) })
    }
    return {
      ...publicRun(run),
      mode,
      mode_source: modeSource,
      model: chosen.model,
      model_source: chosen.source,
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
    const unseenWait = () => run.state === 'waiting' && !run.waitNoticed
    const deadline = Date.now() + seconds * 1000
    // A wake can also come for another reason (the delayed one for a waiting status): wait on.
    while (isActive(run) && !unseenWait() && !stopping && Date.now() < deadline) {
      await new Promise((resolve) => {
        const set = waiters.get(run.id) ?? new Set()
        waiters.set(run.id, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          resolve()
        }
        const timer = setTimeout(done, deadline - Date.now())
        set.add(done)
      })
    }
    const done = !isActive(run)
    if (!done && unseenWait()) {
      run.waitNoticed = true
      return { ...publicRun(run), needs_input: run.question ? 'answer' : 'harness-ui' }
    }
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
    // Stopping a session also empties Harness's queue: the runs waiting there are over.
    const removed = await reconcileQueue(sessionId).catch((error) => { logError('queue check', error); return [] })
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
      ...(removed.length ? { removed_from_queue: removed } : {}),
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
    models,
    send,
    status: ({ run_id, tail }) => publicRun(getRun(run_id), tail ?? 20),
    wait,
    cancel,
    activity,
    rename_session: renameSession,
    rename_workspace: renameWorkspace,
    list_runs: ({ limit = 10, session_id } = {}) => [...runs.values()].reverse().filter((r) => !session_id || r.sessionId === session_id).slice(0, limit).map((r) => publicRun(r, 0)),
    update_queued: updateQueued,
    answer: answerQuestion,
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


  // --- MCP registration -----------------------------------------------------
  // Switching the plugin on registers the dsh-baton MCP server for Claude Code and Codex,
  // the same entries `dsh-baton setup` writes, so adding the plugin is the whole install.
  // It runs again on every Harness start: a plugin update brings the server along, and an
  // entry that is already right is left untouched. The Plugins page reads the outcome from
  // GET /dsh-baton/status (lib/client.js). DSH_BATON_AUTO_REGISTER=0 turns it off.
  let registration = { state: 'pending' }
  if (setting('AUTO_REGISTER') !== '0') {
    setImmediate(guard('register', async () => {
      const root = serverRoot()
      if (!root) { registration = { state: 'done', ok: false, error: 'no-server', clients: [] }; return }
      const { autoRegister, harnessRuntime } = await import(pathToFileURL(path.join(root, 'src', 'register.mjs')).href)
      // Inside the desktop app, its own binary can stand in for a missing Node.js.
      const fallback = process.versions.electron && harnessRuntime ? harnessRuntime(process.execPath) : null
      const result = autoRegister({ root, harnessDir: harnessDir(), fallback })
      registration = { state: 'done', ...result }
      const summary = result.clients.map((c) => `${c.label}: ${c.state}${c.error ? ` (${c.error})` : ''}`).join(', ')
      ctx.logger?.[result.ok ? 'info' : 'error']?.(`dsh-baton-host MCP registration: ${summary || result.error}${result.codexHook && result.codexHook !== 'none' ? `; old Codex Stop hook: ${result.codexHook}` : ''}`)
    }))
  } else {
    registration = { state: 'off' }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => {
      settings = child.settings
      child.effect(() => () => { if (settings === child.settings) settings = null }, 'dsh-baton-host settings')
    })
    ctx.inject(['accountController'], (child) => {
      accountService = child.accountController
      child.effect(() => () => { if (accountService === child.accountController) accountService = null }, 'dsh-baton-host account')
    })
    ctx.inject(['agentDefaultModel'], (child) => {
      defaultModelService = child.agentDefaultModel
      child.effect(() => () => { if (defaultModelService === child.agentDefaultModel) defaultModelService = null }, 'dsh-baton-host default model')
    })
    ctx.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/dsh-baton/status',
        handler: (request, response) => {
          const { state, ok, error, version, runtime, clients = [] } = registration
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ version: VERSION, registration: { state, ok, error, version, runtime, clients: clients.map(({ id, label, state }) => ({ id, label, state })) } }))
        },
      }), 'dsh-baton-host status route')
    })
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
      stopping = true
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
