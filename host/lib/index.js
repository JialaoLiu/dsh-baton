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
const admitWaitMs = () => Number(process.env.DSH_BATON_ADMIT_WAIT_MS) || 10_000
const MAX_RUNS = 100
const QUIET_CONFIRM_MS = 2000
const CANCEL_ATTEMPTS = 3
const CANCEL_SETTLE_MS = 6000
const ACTIVITY_MAX_ERRORS = 10
// A run taken up after a plugin reload whose message Harness had not admitted yet.
const TAKE_UP_RETRY_MS = 3000
const takeUpAdmitMs = () => Number(process.env.DSH_BATON_TAKE_UP_ADMIT_MS) || 5 * 60_000
// How long a run whose own turn ended waits for background jobs or reminders (not sub-agents,
// which are part of the task) before it completes anyway, saying what is left (left_running).
// A search over the whole home folder held a reply back for 15 minutes (Mac, 2026-11-22).
const jobWaitMs = () => Number(process.env.DSH_BATON_JOB_WAIT_MS) || 5 * 60_000
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
const isDirectory = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

function normalizePath(p) {
  const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()))
  try { return fs.realpathSync.native(abs) } catch { return abs }
}

// Where a new session goes. Harness keeps every session of a workspace in the workspace's own
// folder, so a hand-over to a folder that is not a workspace would get a workspace of its own,
// one more in the sidebar for each subfolder or throw-away folder. Instead it joins:
// - the conversation's own folder (base), when the target is inside it: a Claude Code chat in
//   Coding handing over Coding/app joins the Coding workspace;
// - for a target outside it, the nearest workspace around the target, else the conversation's
//   own folder: a chat in Coding handing over a folder on another disk joins the Coding workspace;
// - for folders clients make per conversation, one shared folder: Codex chats without a project
//   (Documents/Codex/<date>/<chat>), Claude scratch folders (…/scratch-workspaces/…, Claude
//   Code's <tmp>/claude-<uid>/…/scratchpad), Antigravity's scratch and brain folders, Claude
//   worktrees (<project>/.claude/worktrees/<name>, joined to the project) and Codex worktrees
//   (~/.codex/worktrees/…).
// The session then starts in that folder and the message names the target folder.
const CASELESS = process.platform === 'win32' || process.platform === 'darwin'
const same = (a, b) => (CASELESS ? a.toLowerCase() === b.toLowerCase() : a === b)
function isInside(dir, parent) {
  const r = path.relative(CASELESS ? parent.toLowerCase() : parent, CASELESS ? dir.toLowerCase() : dir)
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r)
}
const DAY = /^\d{4}-\d{2}-\d{2}$/
function sharedFolder(dir) {
  const parts = dir.split(path.sep)
  const upto = (i) => parts.slice(0, i).join(path.sep) || path.sep
  for (let i = parts.length - 2; i >= 1; i--) {
    const at = parts[i]
    // Claude Code worktrees share the folder that holds them, never the project's main checkout.
    if (same(at, 'worktrees') && i >= 2 && same(parts[i - 1], '.claude')) return { path: upto(i + 1), title: 'Claude worktrees' }
    if (same(at, 'worktrees') && same(parts[i - 1], '.codex')) return { path: upto(i + 1), title: 'Codex worktrees' }
    if (same(at, 'scratch-workspaces')) return { path: upto(i + 1), title: 'Claude scratch' }
    // Antigravity: chats outside a project work in <data>/scratch, artifacts sit in <data>/brain/<id>.
    if ((same(at, 'scratch') || same(at, 'brain')) && /^antigravity/i.test(parts[i - 1] ?? '') && same(parts[i - 2] ?? '', '.gemini')) return { path: upto(i + 1), title: 'Antigravity scratch' }
    if (same(at, 'Codex') && same(parts[i - 1], 'Documents') && DAY.test(parts[i + 1] ?? '')) return { path: upto(i + 1), title: 'Codex chats' }
  }
  // Claude Code's per-conversation scratchpad: <tmp>/claude[-<uid>]/<project>/<session>/scratchpad;
  // every conversation's goes to the claude[-<uid>] folder (2026-11-20: a paper review gave each
  // reviewer its own scratchpad subfolder, five workspaces).
  for (let s = parts.length - 1; s >= 3; s--) {
    if (same(parts[s], 'scratchpad') && /^claude(-\d+)?$/i.test(parts[s - 3])) return { path: upto(s - 2), title: 'Claude scratch' }
  }
  return null
}
// A Git worktree (its .git is a file pointing into another repository's worktrees): a checkout
// of its own, so a session for it must not open in the folder around it, which may be the main checkout.
function isLinkedWorktree(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, '.git'), 'utf8')
    return text.startsWith('gitdir:') && /[\\/]worktrees[\\/]/.test(text)
  } catch { return false }
}
// known: the folders that are workspaces already.
function sessionHome(target, base, known = []) {
  const usable = (dir) => dir && !same(dir, os.homedir()) && dir !== path.parse(dir).root && isDirectory(dir)
  const linked = isLinkedWorktree(target)
  let b
  let baseShared = null
  if (base && !linked) {
    b = normalizePath(base)
    baseShared = sharedFolder(b)
    if (baseShared && isDirectory(baseShared.path)) b = baseShared.path
    if (usable(b) && isInside(target, b)) return { path: b, ...(baseShared && same(b, baseShared.path) && baseShared.title ? { title: baseShared.title } : {}) }
  }
  const shared = sharedFolder(target)
  if (shared && usable(shared.path)) return shared
  if (b) {
    // A folder outside the conversation's folder (2026-11-20: a chat in Coding gave each reviewer
    // a folder of its own on another disk, one workspace each): the nearest workspace around it,
    // else the conversation's own folder. Not a chat's throw-away folder (a Codex chat without
    // a project): a project handed over from there keeps a workspace of its own.
    const around = known.filter((dir) => dir && usable(dir) && isInside(target, dir)).sort((x, y) => y.length - x.length)[0]
    if (around) return { path: around }
    if (b && !baseShared && usable(b)) return { path: b }
  }
  return { path: target }
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
  // Followers of a session's Harness goal (see follow()): woken by what may end their wait.
  const followers = new Map() // sessionId -> Set<wake>
  const FOLLOW_EVENTS = new Set(['turn/start', 'turn/end', 'goal/change'])
  // A moment's delay, so the event that woke a follower is in the log it reads.
  // Each such event also counts up the session's generation (50 ms later, once the log has it), so
  // a follow that was reading the log when it came reads again instead of sleeping past it.
  const eventGen = new Map() // sessionId -> count
  const wakeFollowers = (sessionId) => setTimeout(guard('wake followers', () => {
    eventGen.set(sessionId, (eventGen.get(sessionId) ?? 0) + 1)
    for (const wake of [...(followers.get(sessionId) ?? [])]) wake()
  }), 50)
  // Sessions whose agent waits for a person (agent/status waiting), and how often each began to.
  const waitingSessions = new Set()
  const uiEpisodes = new Map() // sessionId -> count
  const waitingSince = new Map() // sessionId -> ms the current wait began
  // Sessions a follow wait is on, until when: a question that comes between two calls of one
  // follow (a client's chunks, its round trip) is still taken up for dsh_answer.
  const followedUntil = new Map() // sessionId -> ms

  // --- run bookkeeping ------------------------------------------------------

  const publicRun = (run, tail = 20) => ({
    run_id: run.id, session_id: run.sessionId, state: run.state, started_at: run.startedAt, ended_at: run.endedAt,
    message_preview: run.preview, final_text: run.finalText, turn_end: run.turnEnd, error: run.error,
    ...(run.sender ? { sender: run.sender } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.waitingOn ? { waiting_on: run.waitingOn } : {}),
    ...(run.leftRunning ? { left_running: run.leftRunning } : {}),
    ...(run.supersededBy ? { superseded_by: run.supersededBy } : {}),
    ...(run.humanInputs?.length ? { human_interjections: run.humanInputs } : {}),
    ...(run.approvalsAllowed?.length ? { approvals_allowed: run.approvalsAllowed } : {}),
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

  // A write refused for a moment (Windows: an antivirus holding the file) is tried again a few
  // times: a record left saying "running" would come back as interrupted after a restart.
  const writeTries = new Map()
  function flushRuns() {
    clearTimeout(store.timer)
    store.timer = null
    const again = new Set()
    for (const id of store.dirty) {
      const run = runs.get(id)
      try {
        if (run) writeRunFile(run)
        else fs.rmSync(path.join(store.dir, `${id}.json`), { force: true })
        writeTries.delete(id)
      } catch (error) {
        logError('persist run', error)
        const tries = (writeTries.get(id) ?? 0) + 1
        if (['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) && tries < 5) { writeTries.set(id, tries); again.add(id) } else writeTries.delete(id)
      }
    }
    store.dirty = again
    if (again.size) store.timer = setTimeout(guard('persist runs', flushRuns), PERSIST_DELAY_MS)
  }

  // Load earlier records. A run that was active when the plugin went away is taken up again
  // when its session is still at work: the plugin was reloaded (switched off and on, or
  // updated) while Harness kept running. Otherwise it cannot finish any more (Harness ends the
  // turn on restart), so it is marked interrupted.
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
    const resumable = []
    for (const run of loaded) {
      if (runs.has(run.id)) continue
      run.events ??= []
      runs.set(run.id, run)
      if (isActive(run)) resumable.push(run)
    }
    for (const run of resumable) guard('take up runs', takeUp)(run)
  }
  async function takeUp(run, tries = 0) {
    const items = run.sessionId ? await sessionActivity(run.sessionId).catch(() => null) : []
    if (!isActive(run)) return
    // A message that reached the conversation while no plugin listened: the run is in it.
    if (!run.sawPrompt && run.sessionId) {
      const log = await sessionLog(run.sessionId).catch(() => null)
      // Ended meanwhile (a late refusal of the prompt, a cancel): left as it is.
      if (!isActive(run)) return
      if (Array.isArray(log?.events) && log.events.some((e) => e.type === 'user/message' && e.data?.source?.rpcId === run.requestId)) {
        Object.assign(run, { sawPrompt: true, state: 'running', admitted: true })
      }
    }
    // Unknown is not idle (Harness may not answer yet right after the reload): look again a few
    // times. A message Harness had not taken in yet may still arrive: a cold start took 2 min 35 s
    // to admit one (Mac, 2026-11-18), so that is looked for up to takeUpAdmitMs().
    const notYetIn = !run.admitted && !run.sawPrompt
    const again = items === null ? tries < ACTIVITY_MAX_ERRORS : notYetIn && !items?.length && (tries + 1) * TAKE_UP_RETRY_MS < takeUpAdmitMs()
    if (again) {
      setTimeout(guard('take up runs', () => takeUp(run, tries + 1)), TAKE_UP_RETRY_MS)
      return
    }
    if (Array.isArray(items) && items.length) {
      // Its turn may have ended while no plugin listened: with no turn left, only background
      // work (sub-agents, jobs), the run ends once that is done, as after a seen turn end.
      if (run.sawPrompt && !items.some((g) => g.kind === 'turn')) run.idleSeen = true
      // A question asked through the plugin that went away cannot be answered from here any more
      // (its request belonged to the old plugin): the wait says to answer it in the Harness window.
      if (run.question && !questions.has(run.sessionId)) {
        delete run.question
        if (run.state === 'waiting') run.waitNoticed = false
      }
      pushEvent(run, { type: 'plugin_reloaded' })
      persist(run)
      scheduleQuietCheck(run.sessionId, 1000)
      return
    }
    // settle, so a wait that began since the reload wakes now.
    settle(run, 'interrupted', { error: notYetIn ? 'The plugin reloaded before Harness took the message in, and it never arrived; send it again if it is still wanted.' : 'Harness restarted while this run was active; its turn was stopped.' })
  }

  // Per-session turn state: whether the current turn has produced assistant
  // output yet. A user message before any output opens the turn (a queued
  // followup, or someone typing in the Harness UI); one after it is a steer.
  const turns = new Map() // sessionId -> { hasOutput }

  // An approval asked inside a tool call (the run_code of Harness's PTC mode, for one) leaves the
  // agent "running", so its status never says "waiting". The session log's approval/asked and
  // approval/decided pair does: the run waits for the Harness UI from the first open approval
  // to the last decision.
  const openApprovals = new Map() // sessionId -> Map(approval id -> whether it waits for a person)
  let approvalSeq = 0
  const personApproval = (sessionId) => [...(openApprovals.get(sessionId)?.values() ?? [])].some(Boolean)
  // What Harness's Auto review puts in the approval it asks for after turning a call down.
  const AUTO_REVIEW_DENIAL = /^Auto review denied tool/
  function onApproval(sessionId, type, data) {
    const open = openApprovals.get(sessionId) ?? new Map()
    if (type === 'approval/asked') {
      // One this plugin answers itself (onApprovalRequest) is decided at once: no person to wait for.
      const forPerson = !(approvalsMode() === 'allow' && outputReceiversFor(sessionId).length && !AUTO_REVIEW_DENIAL.test(String(data.reason ?? '')))
      open.set(data.id ?? `asked-${++approvalSeq}`, forPerson)
    } else if (data.id) open.delete(data.id)
    else { const oldest = open.keys().next(); if (!oldest.done) open.delete(oldest.value) } // no id: the oldest one
    if (open.size) openApprovals.set(sessionId, open)
    else openApprovals.delete(sessionId)
    // Any open approval that waits for a person, whatever else is open, puts the run in waiting.
    if (personApproval(sessionId)) {
      if (!waitingSessions.has(sessionId)) { uiEpisodes.set(sessionId, (uiEpisodes.get(sessionId) ?? 0) + 1); waitingSince.set(sessionId, Date.now()) }
      waitingSessions.add(sessionId)
      for (const run of outputReceiversFor(sessionId)) if (run.state !== 'waiting') needsPerson(run, 500)
    } else if (type === 'approval/decided') {
      waitingSessions.delete(sessionId)
      waitingSince.delete(sessionId)
      for (const run of outputReceiversFor(sessionId)) if (run.state === 'waiting' && !questions.has(sessionId)) { run.state = 'running'; persist(run) }
    }
    wakeFollowers(sessionId)
  }

  ctx.on('session/event', guard('session/event', (session, event) => {
    const data = event.data ?? {}
    if (FOLLOW_EVENTS.has(event.type)) wakeFollowers(session.id)
    if (event.type === 'approval/asked' || event.type === 'approval/decided') onApproval(session.id, event.type, data)
    // Harness asks for approvals only inside a turn, so none is open after it: one whose
    // decision never came is not left to hold the session's waiting state.
    if (event.type === 'turn/end' && openApprovals.has(session.id)) { openApprovals.delete(session.id); onApproval(session.id, 'approval/decided', { id: null }) }
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
      // A round a Harness goal starts by itself counts like a user-started turn: the run whose
      // turn just ended keeps that turn's reply instead of running on with the goal.
      if ((data.source?.kind === 'user' || data.source?.kind === 'goal') && opensTurn && run?.mode !== 'steer') {
        // A new user-started turn: runs whose own turn already ended keep their
        // result instead of absorbing this turn's output, but still wait for any
        // sub-agents or jobs they started. Turns woken by sub-agent results carry
        // no user message, and a relayed steer joins the current work, so neither
        // closes earlier runs.
        let closed = false
        for (const prev of active) {
          if (prev !== run && prev.sawPrompt && prev.turnEnd && !prev.outputClosed) {
            Object.assign(prev, { outputClosed: true, supersededBy: run?.id ?? (data.source.kind === 'goal' ? 'goal' : 'user') })
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
      for (const run of receivers) {
        // The reply of the run's own turn, kept apart from what later wake-up turns say.
        if (!run.turnEnd && (!reason?.kind || reason.kind === 'completed')) run.turnText = run.finalText ?? null
        run.turnEnd = reason
        persist(run)
      }
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
    // Only jobs or reminders left, past the limit since the run's own turn ended: done anyway.
    const outlasted = (run) => {
      if (!background.length || items.some((g) => g.kind === 'turn' || g.kind === 'subagent')) { delete run.jobsSince; return false }
      run.jobsSince ??= Date.now()
      return Date.now() - run.jobsSince >= jobWaitMs()
    }
    for (const run of receivers.filter((r) => r.outputClosed)) {
      noteWaited(run, background)
      if (background.length === 0) finishQuiet(run)
      else if (outlasted(run)) finishQuiet(run, { leftRunning: summary(background) })
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
      for (const run of open) finishQuiet(run)
      return
    }
    quietSinceBySession.delete(sessionId)
    for (const run of open) noteWaited(run, items)
    const late = open.filter((r) => r.turnEnd && outlasted(r))
    for (const run of late) finishQuiet(run, { leftRunning: summary(background) })
    for (const run of open.filter((r) => !late.includes(r))) run.waitingOn = items.length ? summary(items) : run.waitingOn
    if (receiversFor(sessionId).length) scheduleQuietCheck(sessionId, 3000)
  }

  // The kinds of background work a run has waited for, to tell what its later turns are about.
  function noteWaited(run, list) {
    const kinds = list.map((g) => g.kind).filter((k) => k !== 'turn' && !(run.waitedKinds ?? []).includes(k))
    if (kinds.length) run.waitedKinds = [...(run.waitedKinds ?? []), ...kinds]
  }
  // A run that waited for sub-agents ends with their summary turn as its reply. One that waited
  // only for jobs or reminders keeps its own turn's reply, with what the later turns said after it:
  // a turn woken by a job is about that job, and replacing the reply with it lost a whole
  // review (Antigravity, 2026-11-22).
  function finishQuiet(run, extra = {}) {
    const reply = run.turnText
    const later = run.finalText
    const kinds = run.waitedKinds ?? []
    const keep = reply && later && later !== reply && kinds.length && !kinds.includes('subagent')
    settle(run, 'completed', { waitingOn: null, error: null, ...(keep ? { finalText: `${reply}\n\n${later}` } : {}), ...extra })
  }

  ctx.effect(() => () => { for (const t of quietTimers.values()) clearTimeout(t) }, 'dsh-baton-host quiet timers')

  ctx.on('agent/status', guard('agent/status', ({ agent, status }) => {
    if (!agent) return
    // An approval asked inside a tool call keeps the run waiting though the agent says "running".
    const approvalOpen = personApproval(agent.id)
    if (status === 'waiting') { if (!waitingSessions.has(agent.id)) { uiEpisodes.set(agent.id, (uiEpisodes.get(agent.id) ?? 0) + 1); waitingSince.set(agent.id, Date.now()) } waitingSessions.add(agent.id) }
    else if (!approvalOpen) { waitingSessions.delete(agent.id); waitingSince.delete(agent.id) }
    wakeFollowers(agent.id)
    const receivers = receiversFor(agent.id)
    if (status === 'running' && receivers.length) lastRunningAt.set(agent.id, Date.now())
    for (const run of outputReceiversFor(agent.id)) {
      if (status === 'running') { if (!approvalOpen) run.state = 'running' }
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
    const log = await sessionLog(sessionId).catch(() => null)
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
    // Taken up too when someone follows the session's goal: the follow wait brings it back.
    const followed = followers.has(sessionId) || (followedUntil.get(sessionId) ?? 0) > Date.now()
    if (!asked.length && !(followed && Array.isArray(request.questions))) return next()
    const entry = { id: `q-${crypto.randomBytes(4).toString('hex')}`, sessionId, items: request.questions, answers: new Map(), runs: asked }
    const ours = new Promise((resolve) => { entry.resolve = resolve })
    questions.set(sessionId, entry)
    wakeFollowers(sessionId)
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
      wakeFollowers(sessionId)
      for (const run of asked) {
        if (run.question?.question_id !== entry.id) continue
        delete run.question
        if (run.state === 'waiting') run.state = 'running'
        persist(run)
      }
    })
  }

  // Answer the open question of a run's turn, or of a session a follow wait reported it for.
  // answers: [{ id?, choose?: [number | label], text?, skip? }]; questions not answered yet
  // stay open until every one has an answer.
  function answerQuestion({ run_id, session_id, answers }) {
    if (!run_id && !session_id) throw new Error('run_id or session_id is required')
    const run = run_id ? getRun(run_id) : null
    const entry = questions.get(run?.sessionId ?? session_id)
    if (run && (!isActive(run) || !entry || run.question?.question_id !== entry.id)) {
      if (run.state === 'waiting') throw new Error(`Run ${run.id} is waiting for something in the Harness UI (an approval, or a question left open when the plugin reloaded) that cannot be answered from here; tell the user to answer it in the Harness window.`)
      throw new Error(`Run ${run.id} is ${run.state} and has no open question to answer.`)
    }
    if (!entry) {
      if (waitingSessions.has(session_id)) throw new Error(`Session ${session_id} is waiting for something in the Harness UI (an approval, or a question left open when the plugin reloaded) that cannot be answered from here; tell the user to answer it in the Harness window.`)
      throw new Error(`Session ${session_id} has no open question to answer.`)
    }
    const shown = run ? publicRun(run, 0) : { session_id }
    if (!Array.isArray(answers) || !answers.length) throw new Error('answers must list at least one answer')
    const staged = new Map()
    for (const a of answers) {
      const q = a?.id != null ? entry.items.find((item) => item.id === a.id) : entry.items.length === 1 ? entry.items[0] : undefined
      if (!q) throw new Error(a?.id != null ? `No question ${a.id}; the questions are ${entry.items.map((i) => i.id).join(', ')}` : 'id is required when there are several questions')
      const options = q.options ?? []
      const chosen = (a.choose ?? []).map((c) => {
        const byNumber = typeof c === 'number' || /^\d+$/.test(String(c)) ? options[Number(c) - 1] : undefined
        // Labels compared on letters and digits, the asker's mark left out: "Markdown（.md，推荐）" and "Markdown (.md)" are one option.
        const bareLabel = (v) => String(v).toLowerCase().replace(/\(recommended\)|recommended|推荐/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
        const option = byNumber ?? options.find((o) => o.label === c) ?? options.find((o) => o.label.toLowerCase().replace(RECOMMENDED, '').trim() === String(c).toLowerCase().replace(RECOMMENDED, '').trim()) ?? (bareLabel(c) ? options.find((o) => bareLabel(o.label) === bareLabel(c)) : undefined) ?? (() => {
          // The label's head: "md" for "md (Markdown)", when only one option starts that way.
          const heads = bareLabel(c) ? options.filter((o) => bareLabel(String(o.label).split(/[(（]/)[0]) === bareLabel(c)) : []
          return heads.length === 1 ? heads[0] : undefined
        })()
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
      return { ...shown, submitted: false, remaining }
    }
    entry.resolve({ answers: entry.items.map((q) => entry.answers.get(q.id)) })
    return { ...shown, submitted: true, answers: entry.items.map((q) => entry.answers.get(q.id)) }
  }

  ctx.on('user-questions/request', guardWaterfall(onQuestion), { global: true, prepend: true })

  // Approvals in a hand-over run: allowed once here unless the plugin page says to leave them
  // to the Harness UI (the user's choice, 2026-11-17: a hand-over must not stall on one). Only
  // sessions with a run of this plugin in progress; every other approval goes on to Harness.
  // Each one is listed on the run (approvals_allowed), so the client sees what was let through.
  const MAX_ALLOWED = 20
  function onApprovalRequest(request, next) {
    const sessionId = request?.agent?.id
    const runs = sessionId ? outputReceiversFor(sessionId) : []
    if (!runs.length || approvalsMode() !== 'allow' || request?.signal?.aborted) return next()
    // A call Harness's own Auto review model turned down (it never lets a high-risk one, such as
    // sending secrets out, through) stays with the user: allowing it here would undo that review.
    if (AUTO_REVIEW_DENIAL.test(String(request.reason ?? ''))) return next()
    const entry = { time: new Date().toISOString(), tool: String(request.toolName ?? 'tool'), ...(request.reason ? { reason: String(request.reason).slice(0, 300) } : {}) }
    for (const run of runs) {
      run.approvalsAllowed = [...(run.approvalsAllowed ?? []), entry].slice(-MAX_ALLOWED)
      pushEvent(run, { type: 'approval_allowed', tool: entry.tool })
      persist(run)
    }
    return 'allowed-once'
  }
  ctx.on('approval/request', guardWaterfall(onApprovalRequest), { global: true, prepend: true })

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

  // A session's whole event log and its folder. Harness up to 0.2.1 has sessionController.inspect;
  // 0.2.2 replaced it with paged history (events): the newest page first, beforeSeq walks back,
  // throughSeq pins every page to the same cut. The folder then comes from the session list.
  // A log read before (the last few sessions) is kept, so a later read walks back only to the
  // last event it has instead of reading the whole log again (a follow reads it each round). A
  // log that no longer holds that event, or has fewer events, is read whole.
  const logCache = new Map()
  async function sessionLog(sessionId) {
    if (typeof controller.inspect === 'function') return controller.inspect(sessionId, signal())
    if (typeof controller.events !== 'function') throw new Error('This DeepSeek Harness version cannot read a session log.')
    const events = await pagedLog(sessionId, logCache.get(sessionId))
    const { items } = await controller.list({}, signal())
    return { meta: { cwd: items.find((it) => it.sessionId === sessionId)?.cwd ?? null }, events }
  }
  async function pagedLog(sessionId, known) {
    const address = { kind: 'session', sessionId }
    const pages = []
    let throughSeq
    let beforeSeq
    let joined = false
    for (;;) {
      const page = await controller.events({ address, maxMessages: 500, ...(throughSeq === undefined ? {} : { throughSeq }), ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal())
      throughSeq ??= page.cursor
      const events = (page.records ?? []).filter((r) => r?.type === 'event' && r.event).map((r) => r.event)
      pages.unshift(events)
      if (known && events.length && events[0].seq <= known.lastSeq) { joined = true; break }
      if (!page.hasMore || !events.length || events[0].seq === beforeSeq) break
      beforeSeq = events[0].seq
    }
    const seen = new Set()
    let events = pages.flat().filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)))
    if (joined) {
      if (!events.some((e) => e.seq === known.lastSeq)) return pagedLog(sessionId, null)
      events = [...known.events, ...events.filter((e) => e.seq > known.lastSeq)]
    }
    const lastSeq = events.at(-1)?.seq
    logCache.delete(sessionId)
    // Read-only for callers; a very long log is not kept (memory).
    if (Number.isFinite(lastSeq) && events.length <= 50_000 && events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)) {
      logCache.set(sessionId, { events, lastSeq })
      if (logCache.size > 8) logCache.delete(logCache.keys().next().value)
    }
    return events
  }

  async function readSession({ session_id, last = 10 }) {
    const { meta, events } = await sessionLog(session_id)
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

  // --- Harness goals --------------------------------------------------------------
  // A session with a goal starts its next round by itself a few ms after a turn ends, until
  // the goal is complete, paused or blocked, or its rounds run out. The goal's durable state is
  // a session projection (values.goal). Whether this process will really go on with it
  // (activation: armed, or disarmed, e.g. after a Harness restart until a person resumes it)
  // is not in it: only Harness's goals service and its goal/activation-changed event say.

  let goalsService = null
  let agentsService = null
  let teamsService = null
  const activations = new Map() // sessionId -> 'armed' | 'disarmed', from goal/activation-changed
  ctx.on('goal/activation-changed', guard('goal activation', ({ sessionId, goal } = {}) => {
    if (!sessionId) return
    if (goal?.activation) activations.set(sessionId, goal.activation)
    else activations.delete(sessionId)
    wakeFollowers(sessionId)
  }))

  // armed, disarmed, or null when this Harness does not say. A session not loaded (no live
  // agent, as after a Harness restart until it is opened) runs nothing: disarmed.
  function activationOf(sessionId, goalId) {
    try {
      if (agentsService && typeof goalsService?.get === 'function') {
        const agent = agentsService.get(sessionId)
        if (!agent) return 'disarmed'
        const view = goalsService.get(agent)
        if (view?.id === goalId && view.activation) return view.activation
      }
    } catch { /* not live here: the event is all there is */ }
    return activations.get(sessionId) ?? null
  }

  const clipText = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s ?? null)

  // The session's current goal, null (none, or this Harness has no goals), or undefined when
  // the projection could not be read just now (not the same as no goal).
  async function goalOf(sessionId) {
    let current
    if (typeof controller.projections !== 'function') return null
    try {
      const p = await controller.projections({ sessionId }, signal())
      // The projection's wire view is the current goal itself (null when none); the stored
      // state, as the projection cache keeps it, wraps it in { current, seenGoalIds, failure }.
      const v = p?.values?.goal
      current = v && typeof v === 'object' && 'current' in v ? v.current : v
    } catch { return undefined }
    const g = current?.goal
    if (!g?.id) return null
    const view = {
      id: g.id, phase: g.phase, objective: clipText(g.objective, 300),
      rounds_started: current.roundsStarted ?? 0, max_rounds: g.maxGoalRounds ?? null,
      activation: activationOf(sessionId, g.id),
      ...(g.blockedReason ? { blocked_reason: { code: g.blockedReason.code, message: g.blockedReason.message } } : {}),
    }
    // When it last changed, for follow() only (left out of results).
    return Object.defineProperty(view, 'changedAt', { value: Number(current.updatedAt) || 0 })
  }


  // A session log's turns, oldest first: when each ended, its goal round (when a goal started
  // it), its closing text and the tools it called.
  function turnsOf(events) {
    const ended = []
    let cur = null
    for (const e of events ?? []) {
      if (e.type === 'turn/start') cur = { turn: e.data?.turn ?? ended.length + 1, round: null, text: null, tools: {}, started_at: Date.parse(iso(e.time)) || null }
      else if (!cur) continue
      else if (e.type === 'user/message' && e.data?.source?.kind === 'goal') cur.round = e.data.source.round ?? null
      else if (e.type === 'assistant/message') {
        const content = e.data?.message?.content
        const text = textOf(content)
        if (text) cur.text = text
        for (const call of toolCallsOf(content)) { const n = call.name ?? call.kind; cur.tools[n] = (cur.tools[n] ?? 0) + 1 }
      } else if (e.type === 'turn/end') {
        ended.push({ ...cur, ended_at: iso(e.time) ?? new Date().toISOString(), end: e.data?.reason?.kind ?? null })
        cur = null
      }
    }
    return { ended, running: cur !== null, runningSince: cur?.started_at ?? null }
  }

  const MAX_ROUNDS_SHOWN = 100
  const shownRound = (t) => ({
    turn: t.turn, ...(t.round != null ? { goal_round: t.round } : {}), ended_at: t.ended_at,
    ...(t.end && t.end !== 'completed' ? { ended_as: t.end } : {}),
    final_text: clipText(t.text, 1500), ...(Object.keys(t.tools).length ? { tools: t.tools } : {}),
  })
  // An earlier round of a report, in one line: the latest round's reply usually sums up the
  // goal so far, and a client reads any round in full with dsh_read_session.
  const digestRound = (t) => ({
    turn: t.turn, ...(t.round != null ? { goal_round: t.round } : {}),
    ...(t.end && t.end !== 'completed' ? { ended_as: t.end } : {}),
    summary: clipText(t.text?.replace(/\s+/g, ' ').trim() || null, 100), ...(Object.keys(t.tools).length ? { tools: t.tools } : {}),
  })
  // Every round since the last report: the latest in full, the ones before as digests (up to
  // MAX_ROUNDS_SHOWN, then a count), so no round goes missing however long the wait was.
  const shownRounds = (list) => {
    const earlier = list.slice(0, -1)
    const kept = earlier.slice(-(MAX_ROUNDS_SHOWN - 1))
    return {
      rounds: [...kept.map(digestRound), ...list.slice(-1).map(shownRound)],
      ...(earlier.length > kept.length ? { earlier_rounds_not_shown: earlier.length - kept.length } : {}),
    }
  }

  // Where a follow wait has got to: rounds already reported, and when it last reported.
  const cursorOf = (mark) => `${mark.rounds}:${mark.at}`
  function parseCursor(cursor) {
    const m = /^(\d+):(\d+)$/.exec(String(cursor ?? ''))
    return m ? { rounds: Number(m[1]), at: Number(m[2]) } : null
  }
  const GOAL_QUIET_MS = Number(process.env.DSH_BATON_GOAL_QUIET_MS) || 5 * 60_000
  // How long a stopped goal waits for the round that stopped it to show its end in the log.
  const GOAL_SETTLE_MS = Number(process.env.DSH_BATON_GOAL_SETTLE_MS) || 15_000
  // The question or Harness UI wait a follower was already told about (one report per episode).
  const noticed = new Map() // sessionId -> { key, at }
  // A question still open is reported again to a call that comes back after this long (the
  // report may never have reached anyone); a Harness UI wait once per episode.
  const RENOTICE_MS = 60_000
  // A waiting status with no question yet: the question usually follows within this time.
  const QUESTION_GRACE_MS = 500

  // Wait on a session's goal without sending anything. until "goal": until the goal stops
  // (complete, paused, blocked, cleared). since_ms (without a cursor): count from then, e.g.
  // a run's start, so its own round is in the report too. until "turn": at the first round end once every_s
  // have passed since the last report, with every round since then. Both return at once when
  // Harness needs a person, or the goal will not go on by itself (disarmed; when that cannot
  // be read, no new round for GOAL_QUIET_MS). The cursor carries what was reported, so a
  // next call, in either mode, neither repeats nor misses a round.
  async function follow({ session_id, until = 'goal', cursor, since_ms, every_s = 600, timeout_s = 300 }) {
    if (!session_id) throw new Error('session_id is required')
    if (until !== 'goal' && until !== 'turn') throw new Error('until must be goal or turn')
    if (typeof controller.projections !== 'function') throw new Error('This DeepSeek Harness version has no session projections, so its goals cannot be followed.')
    const every = Math.max(1, Number(every_s) || 600) * 1000
    const seconds = Number.isFinite(Number(timeout_s)) ? Math.min(Math.max(Number(timeout_s), 0), MAX_WAIT_S) : 300
    const deadline = Date.now() + seconds * 1000
    let mark = parseCursor(cursor)
    const since = !mark && Number(since_ms) > 0 ? Number(since_ms) : null
    let sawGoal = false
    for (;;) {
      // Followed from now on (a question that comes while the log is read is taken up), and
      // the events so far, to tell whether one came during the read.
      followedUntil.set(session_id, Date.now() + 60_000)
      const gen = eventGen.get(session_id) ?? 0
      const [goal, log] = await Promise.all([goalOf(session_id), sessionLog(session_id)])
      const { ended, running, runningSince } = turnsOf(log?.events)
      // A first call counts from the start of the round under way, so what it already wrote is
      // reported; one that comes after the goal stopped, from the start of the last round.
      mark ??= since
        ? { rounds: ended.filter((t) => Date.parse(t.ended_at) < since).length, at: since }
        : goal && goal.phase !== 'active' && !running && ended.length
          ? { rounds: ended.length - 1, at: ended.at(-1).started_at ?? Date.parse(ended.at(-1).ended_at) }
          : { rounds: ended.length, at: running && runningSince ? Math.min(runningSince, Date.now()) : Date.now() }
      // The goal could not be read just now: decide nothing, look again shortly.
      if (goal === undefined) {
        if (stopping || Date.now() >= deadline) return { session_id, state: 'following', until, cwd: log?.meta?.cwd ?? null, since: iso(mark.at), rounds_since_report: ended.length - Math.min(mark.rounds, ended.length), timed_out: true, cursor: cursorOf(mark) }
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      if (goal) sawGoal = true
      const fresh = ended.slice(Math.min(mark.rounds, ended.length))
      // A call that comes back in between (timed out, or Harness needs a person) names how many
      // rounds wait, not their texts, and keeps the cursor: the rounds come once, in the report.
      const out = (state, extra = {}) => {
        const between = !!extra.timed_out || state === 'needs_input'
        followedUntil.set(session_id, Date.now() + 60_000)
        return {
          session_id, state, until, goal, cwd: log?.meta?.cwd ?? null, since: iso(mark.at),
          ...(between ? { rounds_since_report: fresh.length } : shownRounds(fresh)), ...extra,
          cursor: between ? cursorOf(mark) : cursorOf({ rounds: ended.length, at: Date.now() }),
        }
      }
      // A goal gone since a call that had one was cleared. Without one so far, the turn that
      // sends "/goal …" creates it partway through: no_goal only once no turn is running.
      const goalChanges = (log?.events ?? []).filter((e) => e.type === 'goal/change')
      const hadGoal = sawGoal || ((!!cursor || !!since) && goalChanges.length > 0)
      const endedBecause = !hadGoal ? null : !goal ? 'cleared' : goal.phase !== 'active' ? goal.phase : null
      const lastEnd = ended.length ? Date.parse(ended.at(-1).ended_at) : 0
      // From state the cursor carries, so the quiet also adds up across a client's short calls.
      const quietSince = Math.max(lastEnd, mark.at)
      // The round that stopped the goal (or used its last round) often still finishes its reply
      // after that, and the log may not show that round running yet: settled once no round runs
      // and one has ended since the goal changed, or GOAL_SETTLE_MS after the change.
      // A cleared goal has no view left: when its last change was logged.
      const changedAt = goal?.changedAt ?? (Date.parse(iso(goalChanges.at(-1)?.time)) || 0)
      const settled = !running && (lastEnd >= changedAt || Date.now() - changedAt >= GOAL_SETTLE_MS)
      const atLimit = !!(goal?.max_rounds && goal.rounds_started >= goal.max_rounds)
      const question = questions.get(session_id)
      const waitedFor = waitingSessions.has(session_id) ? Date.now() - (waitingSince.get(session_id) ?? 0) : null
      if (!hadGoal) {
        if (!running || stopping) return out('no_goal', { ended_because: null })
      } else if (endedBecause) {
        // Out of time before that round ends: a timed-out call, so the next one (same cursor)
        // still waits for it; ending here would lose its reply.
        if (settled || stopping) return out('goal_ended', { ended_because: endedBecause })
      } else {
        if (atLimit && settled) return out('goal_ended', { ended_because: 'round_limit' })
        // A waiting status with no question yet is an approval in the Harness UI only once the
        // question had time to come; an open question again to a call that comes back later.
        const key = question ? `q:${question.id}` : waitedFor >= QUESTION_GRACE_MS ? `ui:${uiEpisodes.get(session_id)}` : null
        const seen = noticed.get(session_id)
        if (key && (seen?.key !== key || (question && Date.now() - seen.at >= RENOTICE_MS))) {
          noticed.set(session_id, { key, at: Date.now() })
          return out('needs_input', question ? { needs_input: 'answer', question: publicQuestion(question) } : { needs_input: 'harness-ui' })
        }
        if (goal.activation === 'disarmed') return out('needs_resume')
        if (goal.activation == null && !running && Date.now() - quietSince >= GOAL_QUIET_MS) return out('goal_stalled')
        if (until === 'turn' && fresh.length && (lastEnd >= mark.at + every || (Date.now() >= mark.at + every && !running))) return out('report')
      }
      if (stopping || Date.now() >= deadline) return out('following', { timed_out: true })
      // Something happened while the log was read: read it again rather than sleep past it.
      if ((eventGen.get(session_id) ?? 0) !== gen) continue
      // Sleep until something happens, the next report is due, or the quiet runs out.
      const due = [deadline, ...(until === 'turn' ? [mark.at + every] : []), ...(goal && goal.activation == null && !running ? [quietSince + GOAL_QUIET_MS] : []), ...((endedBecause || atLimit) && changedAt ? [changedAt + GOAL_SETTLE_MS] : []), ...(waitedFor != null && waitedFor < QUESTION_GRACE_MS ? [Date.now() - waitedFor + QUESTION_GRACE_MS] : [])]
      const wakeAt = Math.max(Date.now() + 50, Math.min(...due.filter((t) => t > Date.now())))
      await new Promise((resolve) => {
        const set = followers.get(session_id) ?? new Set()
        followers.set(session_id, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          if (!set.size && followers.get(session_id) === set) followers.delete(session_id)
          resolve()
        }
        const timer = setTimeout(done, wakeAt - Date.now())
        set.add(done)
      })
    }
  }

  // A session at a glance, for a client that holds only its id: what it is doing, its goal
  // and the reply of its last turn.
  async function sessionStatus({ session_id }) {
    const [act, goal, log] = await Promise.all([activity({ session_id }), goalOf(session_id), sessionLog(session_id).catch(() => null)])
    const { ended, running } = turnsOf(log?.events)
    const question = questions.get(session_id)
    return {
      ...act, turn_running: running,
      ...(goal ? { goal } : {}),
      ...(question ? { needs_input: 'answer', question: publicQuestion(question) } : waitingSessions.has(session_id) ? { needs_input: 'harness-ui' } : {}),
      ...(ended.length ? { last_turn: shownRound(ended.at(-1)) } : {}),
    }
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
  function modelHits(c, asked) {
    const slash = String(asked).lastIndexOf('/')
    const provider = slash > 0 ? modelKey(String(asked).slice(0, slash)) : null
    const want = modelKey(slash > 0 ? String(asked).slice(slash + 1) : asked)
    const hits = want ? c.groups.flatMap((g) => (provider && modelKey(g.id) !== provider ? [] : g.models
      .filter((m) => modelKey(m.id) === want || modelKey(m.name) === want)
      .map((m) => ({ provider: g.id, entry: m })))) : []
    return { want, hits }
  }
  function matchModel(c, asked) {
    const { want, hits } = modelHits(c, asked)
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
  // `hit` is a catalog entry already found exactly (a hand-over default): it is used as it
  // is, never matched again by name.
  async function planModel(sessionId, { model, reasoning_effort, hit: exact }) {
    if (model == null && reasoning_effort == null && !exact) return null
    if (!canSelect()) throw new Error(MODELS_UNSUPPORTED)
    const c = await catalog()
    let hit
    if (exact) hit = exact
    else if (model != null) {
      hit = exactModel(c, String(model))
      if (!hit) {
        // A name several providers share: the hand-over default on the plugin page decides
        // when it is one of them (issue #1, "DeepSeek-V4.1-Flash" from three providers).
        const { hits } = modelHits(c, model)
        const pin = hits.length > 1 ? handoverDefaults() : null
        const pinned = pin?.model && !pin.unreadable ? exactModel(c, pin.model) : null
        const chosen = pinned && hits.find((h) => h.provider === pinned.provider && h.entry.id === pinned.entry.id)
        if (chosen) {
          const plan = { provider: chosen.provider, model: chosen.entry.id, ...(reasoning_effort != null ? { reasoningEffort: matchEffort(chosen, reasoning_effort) } : {}) }
          return { ...plan, note: `${JSON.stringify(model)} matches several models (${hits.map((h) => `${h.provider}/${h.entry.id}`).join(', ')}); it ran on ${chosen.provider}/${chosen.entry.id}, the hand-over default set on ${PAGE}.` }
        }
        hit = matchModel(c, model)
      }
    } else if (!sessionId) {
      // Effort alone on a new session: Harness's default model, read inside the pick queue
      // (applyModel), so a pick running for another send cannot stand in for it. Checked
      // here against the default as it is now, so a wrong effort fails before anything is made.
      const entry = defaultHit(c)
      if (!entry) throw new Error(`The model ${c.default?.provider}/${c.default?.model} is not in Harness's catalog now; pass model too. Available: ${listed(c)}.`)
      matchEffort({ provider: c.default.provider, entry }, reasoning_effort)
      return { followDefault: true, reasoningEffort: reasoning_effort, catalog: c }
    } else {
      // Effort alone: the model the session runs with now.
      const current = (await sessionModel(sessionId)) || c.default
      const entry = c.groups.find((g) => g.id === current?.provider)?.models.find((m) => m.id === current?.model)
      if (!entry) throw new Error(`The model ${current?.provider}/${current?.model} is not in Harness's catalog now; pass model too. Available: ${listed(c)}.`)
      hit = { provider: current.provider, entry }
    }
    return { provider: hit.provider, model: hit.entry.id, ...(reasoning_effort != null ? { reasoningEffort: matchEffort(hit, reasoning_effort) } : {}) }
  }

  // --- hand-over defaults (Plugins page) ------------------------------------------
  // The model and reasoning effort a new hand-over session starts on when the send names
  // none, chosen on the plugin's page. Unset, a new session follows Harness's default model,
  // and that default moves whenever a model is picked in Harness's model menu. Kept in
  // settings.json in the dsh-baton home, with the last Harness default a hand-over followed,
  // so a change of that default is said in the reply instead of passing unnoticed.
  // A setting never fails a send: one that cannot be used is skipped and said in model_note.
  const SETTINGS_FILE = path.join(batonHome(), 'settings.json')
  const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* no wait */ } }
  // { data } or { data: {}, error, corrupt? }. A missing file is no settings; a file another
  // process holds (Windows antivirus or indexer) is read again once; one that is not JSON
  // is reported, never taken for "nothing set".
  function loadSettings() {
    let text
    for (let attempt = 0; ; attempt++) {
      try { text = fs.readFileSync(SETTINGS_FILE, 'utf8'); break } catch (error) {
        if (error?.code === 'ENOENT') return { data: {} }
        if (attempt >= 1) return { data: {}, error: error?.code ?? String(error?.message ?? error) }
        pause(50)
      }
    }
    try {
      const s = JSON.parse(text.replace(/^﻿/, ''))
      if (s && typeof s === 'object' && !Array.isArray(s)) return { data: s }
    } catch { /* below */ }
    return { data: {}, error: 'not valid JSON', corrupt: true }
  }
  // Merge a change into the file. An unreadable file is never overwritten from scratch:
  // only a save from the page replaces a broken one, after keeping it as settings.json.bad-<time>.
  function writeSettings(change, { replaceBroken = false } = {}) {
    const now = loadSettings()
    if (now.error && !(replaceBroken && now.corrupt)) throw new Error(`${SETTINGS_FILE} could not be read (${now.error}), so it was left as it is`)
    if (now.corrupt) fs.renameSync(SETTINGS_FILE, `${SETTINGS_FILE}.bad-${Date.now()}`)
    const next = { ...now.data, ...change }
    const body = JSON.stringify(next, null, 2) + '\n'
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body)
    // Windows refuses the rename while another process has the file open: try again shortly.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, SETTINGS_FILE); return next } catch (error) {
        if (attempt >= 5) { fs.rmSync(tmp, { force: true }); throw error }
        pause(40)
      }
    }
  }
  const filled = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  // How approvals in a hand-over run are answered: 'allow' (the default) or 'ask' (the Harness UI).
  // Fails closed: a settings file that cannot be read, or a value other than the two, is 'ask'.
  function approvalsMode() {
    const { data, error } = loadSettings()
    if (error) return 'ask'
    return data.approvals == null || data.approvals === 'allow' ? 'allow' : 'ask'
  }
  function handoverDefaults() {
    const { data, error } = loadSettings()
    const h = data.handover && typeof data.handover === 'object' ? data.handover : {}
    return { model: filled(h.model), reasoning_effort: filled(h.reasoning_effort), ...(error ? { unreadable: error } : {}) }
  }
  // A saved "provider/model" names one catalog entry exactly; nothing else stands in for it.
  // Model ids may hold slashes themselves (openrouter/deepseek/deepseek-v4-pro).
  function exactModel(c, saved) {
    for (const g of c.groups) {
      if (!saved.startsWith(`${g.id}/`)) continue
      const entry = g.models.find((m) => m.id === saved.slice(g.id.length + 1))
      if (entry) return { provider: g.id, entry }
    }
    return null
  }
  const efforts = (hit) => (hit?.entry.reasoning?.efforts ?? []).map((e) => e.id)
  const hasEffort = (hit, asked) => { try { matchEffort(hit, asked); return true } catch { return false } }
  const defaultHit = (c) => c.groups.find((g) => g.id === c.default?.provider)?.models.find((m) => m.id === c.default?.model)
  // Choosing a model for a session needs Harness's default-model service as well, to put
  // the default back after the pick (keepingDefault).
  const canKeepDefault = () => {
    const dm = defaultModel()
    return typeof dm?.currentSelection === 'function' && typeof dm?.saveSelection === 'function'
  }
  const PAGE = 'the dsh-baton plugin page in Harness'

  // What a new session's send asks for once the hand-over defaults fill in what it left out.
  async function withHandoverDefaults({ model, reasoning_effort }) {
    const out = { model, reasoning_effort, hit: null, used: { model: false, reasoning_effort: false }, notes: [] }
    const pin = handoverDefaults()
    if (pin.unreadable) {
      out.notes.push(`The hand-over defaults on ${PAGE} could not be read (${pin.unreadable}), so they were not used. Choose them on that page again if this goes on.`)
      return out
    }
    const wantModel = model == null && pin.model
    const wantEffort = reasoning_effort == null && pin.reasoning_effort
    if (!wantModel && !wantEffort) return out
    if (!canSelect() || !canKeepDefault()) {
      out.notes.push(`The hand-over defaults on ${PAGE} were not used: this DeepSeek Harness cannot choose a model per session.`)
      return out
    }
    let c
    try { c = await catalog() } catch (error) {
      out.notes.push(`Harness's model list could not be read (${error?.message ?? error}), so the hand-over defaults on ${PAGE} were not used.`)
      return out
    }
    let target = null
    if (wantModel) {
      const hit = exactModel(c, pin.model)
      if (!hit) out.notes.push(`The hand-over default model ${pin.model} (set on ${PAGE}) is not in Harness's model list now, so this session uses Harness's default model instead.`)
      else if (reasoning_effort != null && !hasEffort(hit, reasoning_effort)) out.notes.push(`The hand-over default model ${pin.model} (set on ${PAGE}) has no reasoning effort ${reasoning_effort}, so this session uses Harness's default model with that effort.`)
      else { out.hit = hit; out.used.model = true; target = hit }
    }
    if (wantEffort) {
      if (!target && model != null) { try { target = exactModel(c, String(model)) ?? matchModel(c, model) } catch { target = null } }
      if (!target && model == null) { const entry = defaultHit(c); target = entry ? { provider: c.default.provider, entry } : null }
      if (target && efforts(target).includes(pin.reasoning_effort)) { out.reasoning_effort = pin.reasoning_effort; out.used.reasoning_effort = true }
      else if (target) out.notes.push(`${target.provider}/${target.entry.id} has no reasoning effort ${pin.reasoning_effort} (the hand-over default on ${PAGE}), so it runs with its own default effort.`)
    }
    return out
  }

  // A new session that followed Harness's default: if that default is not the one the last
  // such hand-over ran on, say so, since nothing else shows it moved. The new default is
  // recorded only once the message is in (rememberDefault), so a refused send does not use
  // up the note.
  function defaultDrift(selected) {
    const now = selected ? `${selected.provider}/${selected.model}` : null
    if (!now) return null
    const saved = loadSettings()
    if (saved.error) return null
    const before = filled(saved.data.lastDefaultModel)
    if (before === now) return null
    return { now, note: before ? `Harness's default model changed since the last new hand-over (${before} then, ${now} now), so this session runs on ${now}. Picking a model in Harness's model menu changes that default. To keep new hand-overs on one model, choose a hand-over default model on ${PAGE}.` : null }
  }
  function rememberDefault(now) {
    try { writeSettings({ lastDefaultModel: now }) } catch (error) { logError('save last default model', error) }
  }

  // The plugin page reads and saves the defaults through these.
  async function handoverView() {
    const pin = handoverDefaults()
    const view = { model: pin.model, reasoning_effort: pin.reasoning_effort, approvals: approvalsMode(), ...(pin.unreadable ? { unreadable: pin.unreadable } : {}) }
    if (!canSelect() || !canKeepDefault()) return { ...view, supported: false }
    const c = await catalog()
    return {
      ...view,
      supported: true,
      default: shownModel(c.default),
      models: c.groups.flatMap((g) => g.models.map((m) => ({
        provider: g.id, provider_name: g.name ?? g.id, model: m.id, name: m.name ?? m.id,
        reasoning_efforts: (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id })),
      }))),
      ...(pin.model && !exactModel(c, pin.model) ? { missing: true } : {}),
    }
  }
  // A field left out of the body keeps its saved value; null clears it. A saved model that
  // left Harness's list may be kept as it is (the provider may come back), but not chosen anew.
  async function saveHandover(body) {
    if ('approvals' in body && !['allow', 'ask'].includes(body.approvals)) throw new Error(`approvals is "allow" or "ask", not ${JSON.stringify(body.approvals)}.`)
    const touchesModel = 'model' in body || 'reasoning_effort' in body
    let model = null
    let reasoning_effort = null
    if (touchesModel) {
      const pin = handoverDefaults()
      model = 'model' in body ? filled(body.model) : pin.model
      reasoning_effort = 'reasoning_effort' in body ? filled(body.reasoning_effort) : pin.reasoning_effort
      if (model != null || reasoning_effort != null) {
        if (!canSelect() || !canKeepDefault()) throw new Error(MODELS_UNSUPPORTED)
        const c = await catalog()
        const hit = model != null ? exactModel(c, model) : null
        if (model != null && !hit && model !== pin.model) throw new Error(`No model ${model} in Harness's model list.`)
        const allowed = hit ? efforts(hit) : [...new Set(c.groups.flatMap((g) => g.models.flatMap((m) => efforts({ entry: m }))))]
        if (reasoning_effort != null && !allowed.includes(reasoning_effort)) throw new Error(`No reasoning effort ${reasoning_effort}${hit ? ` for ${model}` : ''}; there is ${allowed.join(', ') || 'none'}.`)
      }
    }
    // Only what this save names is written. A field it left out is read again now, after the
    // catalogue wait, so a save from another page in the meantime is not undone.
    const change = {}
    if (touchesModel) {
      const latest = handoverDefaults()
      change.handover = { model: 'model' in body ? model : latest.model, reasoning_effort: 'reasoning_effort' in body ? reasoning_effort : latest.reasoning_effort }
    }
    if ('approvals' in body) change.approvals = body.approvals
    // A broken file that is replaced: the approvals choice in it is unknown, so the safe one.
    else if (loadSettings().corrupt) change.approvals = 'ask'
    writeSettings(change, { replaceBroken: true })
    return handoverView()
  }

  // Put the session on its model before the prompt goes in. Without a plan, a new session
  // is pinned to the default as it stands, so a pick running for another send cannot leak
  // into it (Harness reads the default only when the first request is built); an existing
  // one keeps its own. The pin is best effort: if it fails, the session just uses the default.
  async function applyModel(sessionId, plan, isNew) {
    if (plan?.followDefault) {
      // Effort alone on a new session: the default as it stands inside the queue, with that effort if it has it.
      let dropped = null
      const { selected } = await keepingDefault((kept) => {
        const entry = plan.catalog.groups.find((g) => g.id === kept?.provider)?.models.find((m) => m.id === kept?.model)
        const effort = entry && hasEffort({ provider: kept.provider, entry }, plan.reasoningEffort) ? matchEffort({ provider: kept.provider, entry }, plan.reasoningEffort) : null
        if (!effort) dropped = plan.reasoningEffort
        return controller.selectModel({ sessionId, ...kept, ...(effort ? { reasoningEffort: effort } : {}) })
      })
      return { model: shownModel(selected), source: 'requested', ...(dropped ? { droppedEffort: dropped } : {}) }
    }
    if (plan) {
      const { note: _note, ...pick } = plan // the note is for the reply, not for Harness
      const { selected } = await keepingDefault(() => controller.selectModel({ sessionId, ...pick }))
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

  // --- Agent Teams ----------------------------------------------------------------
  // Harness 0.2.2-rc.2 turns a root session's Team mode on or off from its model menu
  // ("Use Agent Teams"): agentTeams.setEnabled with the session's live root Agent. The
  // selection is saved in the session, so it holds for later messages and restarts.
  const TEAMS_UNSUPPORTED = 'this DeepSeek Harness cannot turn Agent Teams on per session; that needs Harness 0.2.2-rc.2 or later: update Harness, or send without team'
  async function setTeam(sessionId, enabled) {
    if (typeof teamsService?.setEnabled !== 'function') throw new Error(TEAMS_UNSUPPORTED)
    const agent = await liveAgent(sessionId)
    // A finished sub-agent's session is never loaded again: name the likely cause.
    if (!agent) throw new Error(`session ${sessionId} is not loaded in Harness; if it is a sub-agent's (teammate's) session, change Team mode on its root session instead`)
    await teamsService.setEnabled(agent, enabled)
  }

  // The exact live Agent from Harness's registry, as its own UI lookup takes it: Team and goals
  // reject any other object ("subagent tree access requires the exact live caller"). A session
  // not loaded yet is loaded first. undefined when it cannot be loaded.
  async function liveAgent(sessionId) {
    let agent = agentsService?.get?.(sessionId)
    if (!agent && typeof controller.resolveAgent === 'function') {
      await controller.resolveAgent(sessionId)
      agent = agentsService?.get?.(sessionId)
    }
    return agent
  }

  // --- /goal ------------------------------------------------------------------------
  // Harness runs /goal as a composer command (commands.execute), not as text for the model:
  // sent as a prompt it set no goal (Windows rc.2 on 11-17, Mac rc.5 on 11-21). So a leading
  // "/goal <objective>" sets the goal through Harness's goals service, as the command does, and
  // the objective goes in as the run's message. The goal is set once Harness has taken that
  // message in, so its round driver sees a queued prompt and waits: the run's own turn comes
  // first, then Harness goes on with the goal's rounds by itself.
  const GOAL_UNSUPPORTED = 'this DeepSeek Harness cannot set a goal from a plugin (no goals service); type /goal in the Harness window, or update Harness'
  function goalCommand(message) {
    const m = /^\/goal(?:\s+([^]*))?$/i.exec(message.trim())
    if (!m) return null
    const rest = (m[1] ?? '').trim()
    const word = rest.toLowerCase()
    if (!rest || ['clear', 'pause', 'resume', 'edit'].includes(word)) return { kind: 'control', word: word || 'show' }
    if (/^edit\s/i.test(rest)) return { kind: 'edit', objective: rest.slice(4).trim() }
    return { kind: 'create', objective: rest }
  }
  const GOAL_NOTE = '(This message also set a Harness goal for this session, with the text above as its objective. When all of it is done and verified, mark the goal complete; if work remains, leave it active and Harness starts the next goal round after this turn.)'

  async function setGoal(run, cmd, objective) {
    try {
      const agent = await liveAgent(run.sessionId)
      if (!agent) throw new Error(`session ${run.sessionId} is not loaded in Harness`)
      const current = goalsService.get(agent)
      const view = cmd.kind === 'edit' && current && current.phase !== 'complete'
        ? goalsService.edit(agent, { id: current.id, revision: current.revision }, { objective })
        : goalsService.create(agent, { objective })
      run.goalSet = { id: view.id, phase: view.phase, max_rounds: view.maxGoalRounds ?? null }
      pushEvent(run, { type: 'goal_set', goal_id: view.id, edited: cmd.kind === 'edit' && view.revision > 1 })
    } catch (error) {
      run.goalError = String(error?.message ?? error)
      pushEvent(run, { type: 'goal_failed', error: run.goalError })
      logError('set goal', error)
    }
  }

  async function send({ message, session_id, cwd, workspace_id, conversation_folder, mode: asked, sender, model, reasoning_effort, team }) {
    if (!message || !message.trim()) throw new Error('message is required')
    if (asked != null && asked !== 'followup' && asked !== 'steer') throw new Error('mode must be followup or steer')
    if (team != null && typeof team !== 'boolean') throw new Error('team must be true or false')
    // Checked before a new session is made, so a Harness without them is left as it was.
    if (team != null && typeof teamsService?.setEnabled !== 'function') throw new Error(`Nothing was sent: ${TEAMS_UNSUPPORTED}`)
    // Without a mode, a message to a busy session does what Harness's own busy-send setting says.
    const fromHarness = asked == null ? harnessBusyMode() : null
    const mode = asked ?? fromHarness ?? 'followup'
    const modeSource = asked != null ? 'explicit' : fromHarness ? 'harness' : 'default'
    if (sender != null && !SENDER_RE.test(sender)) throw new Error('sender must be 1-32 characters of a-z, 0-9 or -')
    let sessionId = session_id
    let workspace = null
    let workFolder = null
    // Harness never runs a prompt sent to an archived session: the run would stay queued forever.
    if (sessionId && isArchived(sessionId)) {
      throw new Error(`Session ${sessionId} is archived. Unarchive it in Harness, or start a new session with cwd or workspace_id.`)
    }
    if (!sessionId && !cwd && !workspace_id) throw new Error('A new session needs cwd or workspace_id. Pass session_id to continue an existing one.')
    const goalCmd = goalCommand(message)
    if (goalCmd?.kind === 'control') throw new Error(`Nothing was sent: dsh_send takes "/goal <objective>" or "/goal edit <objective>"; /goal ${goalCmd.word === 'show' ? '' : goalCmd.word} works only in the Harness window. dsh_status with session_id shows a session's goal.`)
    if (goalCmd && (typeof goalsService?.create !== 'function' || typeof agentsService?.get !== 'function')) throw new Error(`Nothing was sent: ${GOAL_UNSUPPORTED}`)
    if (goalCmd?.kind === 'create' && sessionId) {
      const current = await goalOf(sessionId)
      if (current && current.phase !== 'complete') throw new Error(`No message was sent: session ${sessionId} already has a goal (${current.phase}: ${current.objective}). Send "/goal edit <objective>" to replace its objective, or clear it in the Harness window first.`)
    }
    if (goalCmd) message = goalCmd.objective
    // A missing folder is not created: a mistyped path, or a project on a drive that is not
    // connected, would get an empty folder (under /Volumes, even). Checked before the registry,
    // which answers a bare ENOENT, or nothing at all for a folder registered while it was there.
    if (!sessionId) {
      const dir = workspace_id ? registry.get?.(workspace_id)?.path : normalizePath(cwd)
      if (dir && !isDirectory(dir)) {
        throw new Error(`The folder ${dir}${workspace_id ? ` (workspace ${workspace_id})` : ''} does not exist, so no session was started and nothing was sent. Check the path (a project on an external drive needs that drive connected), or create the folder first.`)
      }
    }
    // Agent Teams belong to the whole session: changed while a turn runs (for a message that
    // waits behind it, or one steered into it), they would change that turn too.
    if (team != null && sessionId) {
      const busy = activeRunsFor(sessionId).length > 0 || (await sessionActivity(sessionId).catch(() => [])).length > 0
      if (busy) throw new Error(`No message was sent: the session is busy, and Agent Teams apply to the whole session, so turning them ${team ? 'on' : 'off'} now would change the running turn too. Send it again once the session is idle, or without team.`)
    }
    const isNew = !sessionId
    // A new session takes the plugin page's hand-over defaults for what the send leaves out;
    // a session that exists keeps its own model.
    const want = isNew ? await withHandoverDefaults({ model, reasoning_effort }) : { model, reasoning_effort, hit: null, used: {}, notes: [] }
    const fromPage = () => want.used.model || want.used.reasoning_effort
    // A send fails only over what it asked for itself: if the plan fails because of a
    // hand-over default, the send is planned again without the defaults.
    const dropDefaults = (error, what) => {
      want.notes.push(`The hand-over defaults on ${PAGE} could not be used (${what}: ${error?.message ?? error}), so this session uses ${model != null ? 'the model asked for' : "Harness's default model"}.`)
      want.used = { model: false, reasoning_effort: false }
      want.hit = null
    }
    let plan
    try { plan = await planModel(sessionId, want) } catch (error) {
      if (!fromPage()) throw error
      dropDefaults(error, 'planning')
      plan = await planModel(sessionId, { model, reasoning_effort })
    }
    if (isNew) {
      // A folder that is not a workspace yet is registered first, so the new session shows in the sidebar.
      if (workspace_id) workspace = { id: workspace_id }
      else {
        const target = normalizePath(cwd)
        // A folder that is a workspace already (sessions from before 0.6.15) keeps it.
        const own = await registry.resolveByPath(target).catch(() => undefined)
        const home = own ? { path: target } : sessionHome(target, conversation_folder, registry.list().map((w) => w.path))
        workspace = await createWorkspace({ path: home.path, title: home.title, create_dir: false })
        if (!same(home.path, target)) {
          workFolder = target
          // First, not last: a message saying "the current directory" otherwise ran in the parent
          // (Windows, 2 of 3 runs). A leading /command (/goal) stays first.
          const note = `(Working folder for this task: ${target}. Run every command there: set each shell command's working directory to ${target}, or cd into it first. "The current directory", "here" and relative paths below all mean ${target}; this session opened in ${home.path}, a folder that contains it.)`
          // A command such as /goal, not a path such as /Users/me/app/x.js.
          const slash = /^(\/[A-Za-z][\w-]*)(\s+|$)/.exec(message)
          message = slash ? `${slash[1]} ${note}\n\n${message.slice(slash[0].length)}` : `${note}\n\n${message}`
        }
      }
      sessionId = (await controller.create({ workspaceId: workspace.id })).sessionId
    }
    // A model that cannot be set fails the send before the prompt goes in.
    const notSet = (error) => new Error(`${isNew ? `Session ${sessionId} was created, but no message was sent: ` : 'No message was sent: '}the model could not be set (${error?.message ?? error})`)
    let chosen
    try { chosen = await applyModel(sessionId, plan, isNew) } catch (error) {
      if (!fromPage()) throw notSet(error)
      // A default Harness would not take (a provider signed out since): the send's own request instead.
      logError('apply hand-over default', error)
      dropDefaults(error, 'setting the model')
      try { chosen = await applyModel(sessionId, await planModel(sessionId, { model, reasoning_effort }), isNew) } catch (again) { throw notSet(again) }
    }
    let modelSource = chosen.source
    if (want.used.model) modelSource = 'handover_default'
    else if (want.used.reasoning_effort && model == null) modelSource = 'default' // Harness's default model, the effort set on the page
    const modelNotes = [...want.notes]
    if (plan?.note) modelNotes.push(plan.note)
    if (chosen.droppedEffort) modelNotes.push(`${chosen.model?.provider}/${chosen.model?.model} has no reasoning effort ${chosen.droppedEffort}, so it runs with its own default effort.`)
    let drift = null
    if (isNew && modelSource === 'default') {
      let followed = chosen.model
      if (!followed) try { followed = shownModel(defaultModel()?.currentSelection?.()) } catch { /* unknown */ }
      drift = defaultDrift(followed)
      if (drift?.note) modelNotes.push(drift.note)
    }
    const pagePart = [...(want.used.model ? ['model'] : []), ...(want.used.reasoning_effort ? ['reasoning_effort'] : [])]
    // A session that never picked a model runs on Harness's default.
    let provider = chosen.model?.provider
    if (!provider) try { provider = defaultModel()?.currentSelection?.()?.provider } catch { /* unknown: no check */ }
    if (provider === ACCOUNT_PROVIDER) {
      const empty = await emptyBalance()
      if (empty) throw new Error(`${isNew ? `Session ${sessionId} was created, but no message was sent` : 'No message was sent'}: the DeepSeek account has no balance left (${empty}), so the run would fail at once. Do not send again until the user has topped up (Harness → Settings → Account, or platform.deepseek.com).`)
    }
    // Team mode goes on (or off) before the prompt, so the first step already has the Team tools,
    // and after the checks that can refuse the send, so a refused send leaves it as it was.
    if (team != null) {
      await setTeam(sessionId, team).catch((error) => {
        throw new Error(`${isNew ? `Session ${sessionId} was created, but no message was sent: ` : 'No message was sent: '}Agent Teams could not be turned ${team ? 'on' : 'off'} (${error?.message ?? error})`)
      })
    }
    const ahead = activeRunsFor(sessionId).map((r) => r.id)
    // A followup into a busy session waits in its queue, behind our runs or a turn the user
    // typed in Harness: said back, so the client knows it can still change it.
    const queuedBehind = !isNew && mode === 'followup' && (ahead.length > 0 || (await sessionActivity(sessionId).catch(() => [])).length > 0)
    const run = {
      id: `hrun-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      sessionId, requestId: requestIdFor(sender), ...(sender ? { sender } : {}), mode, state: 'queued', sawPrompt: false,
      startedAt: new Date().toISOString(), endedAt: null, preview: message.slice(0, 200),
      events: [], finalText: null, turnEnd: null, error: null,
      ...(chosen.model ? { model: chosen.model } : {}),
    }
    remember(run)
    // Harness answers the prompt once it has taken the message in; on a cold start (the first
    // session after a restart) that took 2 min 35 s, and the client sat in dsh_send all along
    // (Mac, 2026-11-18). So the reply waits at most admitWaitMs() (10 s); Harness's answer still settles
    // the run when it comes (a refusal fails it, and dsh_wait says so).
    const admitted = controller.prompt({ sessionId, requestId: run.requestId, content: [{ type: 'text', text: goalCmd ? `${message}\n\n${GOAL_NOTE}` : message }], mode }, signal())
      .then(async () => {
        run.admitted = true // in Harness's queue (or conversation) now
        if (goalCmd) await setGoal(run, goalCmd, message)
        if (drift) rememberDefault(drift.now)
        return true
      }, (error) => {
        settle(run, 'failed', { error: String(error?.message ?? error) })
        return true
      })
    let timer
    const answered = await Promise.race([admitted, new Promise((r) => { timer = setTimeout(() => r(false), admitWaitMs()) })])
    clearTimeout(timer)
    if (!answered) pushEvent(run, { type: 'admission_pending' })
    return {
      ...(answered ? {} : { admission_pending: true }),
      ...publicRun(run),
      mode,
      mode_source: modeSource,
      model: chosen.model,
      model_source: modelSource,
      ...(pagePart.length ? { handover_default: pagePart } : {}),
      ...(modelNotes.length ? { model_note: modelNotes.join(' ') } : {}),
      ...(team != null ? { team } : {}),
      ...(goalCmd && answered ? (run.goalSet ? { goal_set: run.goalSet } : { goal_error: run.goalError ?? 'not set' }) : {}),
      ...(ahead.length ? { other_active_runs: ahead } : {}),
      ...(queuedBehind ? { queued_behind: true } : {}),
      ...(workspace ? { workspace } : {}),
      ...(workFolder ? { work_folder: workFolder } : {}),
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
    return { ...publicRun(run), ...(done ? await goalField(run) : { timed_out: true }) }
  }

  // A run that completed in a session with a goal: the goal goes on after it.
  // The session's goal, for whoever waited on a run: one that goes on after it, or one that
  // stopped since the run began (its later rounds belong to the run's work: ended_since_run).
  // A goal complete before the run is left out.
  const goalField = async (run) => {
    const goal = run.state === 'completed' ? await goalOf(run.sessionId) : null
    if (!goal) return {}
    const since = goal.phase !== 'active' && goal.changedAt >= (Date.parse(run.startedAt) || Infinity)
    return goal.phase !== 'complete' || since ? { goal: since ? { ...goal, ended_since_run: true } : goal } : {}
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
    // features: what this plugin can do that an older one cannot (team: dsh_send team).
    ping: () => ({ name, version: VERSION, pid: process.pid, features: ['team'] }),
    workspaces,
    create_workspace: createWorkspace,
    list_sessions: listSessions,
    read_session: readSession,
    models,
    send,
    status: async ({ run_id, session_id, tail }) => {
      if (!run_id && session_id) return sessionStatus({ session_id })
      const run = getRun(run_id)
      return { ...publicRun(run, tail ?? 20), ...(isActive(run) ? {} : await goalField(run)) }
    },
    follow,
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


  // --- hand-over defaults route -----------------------------------------------
  // GET /dsh-baton/handover: the saved defaults and Harness's model list, for the plugin page.
  // POST (JSON): save new ones. Only the plugin page itself may save. Its request carries the
  // header x-dsh-baton: handover and a JSON body, which a page on another site can only send
  // after a CORS preflight that this route never answers. The Host must be an address or a
  // localhost name, never another name, so a site that rebinds its own name to this machine
  // is refused too. The desktop app's window (dsh-app://app) reaches the web server through a
  // proxy that drops Origin, so a missing Origin is allowed; one that is there must be the
  // app's own or match the Host (dsh web in a browser).
  function localHost(hostname) {
    const bare = hostname.replace(/^\[|\]$/g, '')
    return bare === 'localhost' || bare.endsWith('.localhost') || net.isIP(bare) !== 0
  }
  // The peer of the connection: on this computer only, whatever the Host says (a Harness web
  // server bound to the network would otherwise take a save from another machine).
  const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
  function fromHarnessPage(request) {
    const headers = request.headers ?? {}
    const peer = request.socket?.remoteAddress
    if (peer != null && !LOOPBACK.test(peer)) return false
    if (headers['x-dsh-baton'] !== 'handover') return false
    if (!String(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false
    let host
    try { host = new URL(`http://${headers.host}`) } catch { return false }
    if (!localHost(host.hostname)) return false
    if (headers.origin == null) return true
    let origin
    try { origin = new URL(headers.origin) } catch { return false }
    return origin.protocol === 'dsh-app:' || origin.host === host.host
  }
  function readBody(request, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) { reject(new Error('request body too large')); request.destroy() } else chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }
  function replyJson(response, code, body) {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  async function serveHandover(request, response) {
    try {
      if (request.method === 'GET') return replyJson(response, 200, await handoverView())
      if (request.method !== 'POST') return replyJson(response, 405, { error: 'GET or POST only' })
      if (!fromHarnessPage(request)) return replyJson(response, 403, { error: 'These settings can only be saved from the Harness window on this computer.' })
      const raw = await readBody(request)
      const body = raw.trim() ? JSON.parse(raw) : {}
      replyJson(response, 200, await saveHandover(body && typeof body === 'object' && !Array.isArray(body) ? body : {}))
    } catch (error) {
      replyJson(response, 400, { error: String(error?.message ?? error) })
    }
  }

  // --- MCP registration -----------------------------------------------------
  // Switching the plugin on registers the dsh-baton MCP server for Claude Code, Codex and Antigravity,
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
    ctx.inject(['goals'], (child) => {
      goalsService = child.goals
      child.effect(() => () => { if (goalsService === child.goals) goalsService = null }, 'dsh-baton-host goals')
    })
    ctx.inject(['agents'], (child) => {
      agentsService = child.agents
      child.effect(() => () => { if (agentsService === child.agents) agentsService = null }, 'dsh-baton-host agents')
    })
    ctx.inject(['agentTeams'], (child) => {
      teamsService = child.agentTeams
      child.effect(() => () => { if (teamsService === child.agentTeams) teamsService = null }, 'dsh-baton-host agent teams')
    })
    ctx.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/dsh-baton/status',
        handler: (request, response) => {
          const { state, ok, error, version, runtime, clients = [] } = registration
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ version: VERSION, registration: { state, ok, error, version, runtime, clients: clients.map(({ id, label, state, error, file }) => ({ id, label, state, ...(error === 'bad-json' ? { error, file } : {}) })) } }))
        },
      }), 'dsh-baton-host status route')
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/dsh-baton/handover',
        // The promise goes back to the web server, and nothing in the last resort can throw.
        handler: (request, response) => serveHandover(request, response).catch((error) => {
          logError('hand-over route', error)
          try { replyJson(response, 500, { error: String(error?.message ?? error) }) } catch { try { response.destroy() } catch { /* gone */ } }
        }),
      }), 'dsh-baton-host hand-over route')
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
      for (const set of followers.values()) for (const done of [...set]) done()
      for (const conn of connections) conn.destroy()
      if (!server) return
      server.close()
      if (!IS_WIN) try { if (fs.lstatSync(sock).isSocket()) fs.unlinkSync(sock) } catch { /* gone */ }
    }
  }, 'dsh-baton-host socket')
}
