// Core logic shared by the MCP server and the CLI: locating DeepSeek Harness,
// reading its saved sessions, and running headless turns as detached background runs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setting, batonHome, socketEndpoint, hostEndpoints } from '../host/lib/socket.js'
import * as evidence from './evidence.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

const MAC_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

export const config = {
  dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  batonHome: batonHome(),
  // Extra --patch overlays, separated by the platform path delimiter.
  extraPatches: (setting('PATCHES') || '').split(path.delimiter).filter(Boolean),
  // Set DSH_BATON_ACCOUNT=0 to use the API-key route instead of the desktop account sign-in.
  useAccount: setting('ACCOUNT') !== '0',
}

const IS_WIN = process.platform === 'win32'

// The Windows desktop app has no standalone dsh launcher: its CLI is a script
// packed in app.asar, run by the app's own Electron binary in Node mode.
// It installs per user into %LOCALAPPDATA%\Programs by default, but the folder
// can be chosen at install time, so the uninstall entries are read as well.
function winHarnessExe() {
  const dirs = [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness')]
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/v', 'InstallLocation'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      for (const m of out.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) dirs.push(m[1].trim().replace(/^"|"$/g, ''))
    } catch { /* no such key */ }
  }
  return dirs.map((d) => path.join(d, 'DeepSeek Harness.exe')).find((exe) => fs.existsSync(exe))
}
const WIN_DSH_SCRIPT = ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']
const WIN_DSH_LAUNCHER = ['resources', 'runtime', 'cli', 'bin', 'dsh.cmd']

export function dshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  if (fs.existsSync(MAC_DSH)) return MAC_DSH
  try {
    const hits = execFileSync(IS_WIN ? 'where' : 'which', ['dsh'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    // `where` also lists extensionless shell shims that Windows cannot start; prefer a runnable one.
    const hit = (IS_WIN && hits.find((h) => /\.(exe|cmd|bat)$/i.test(h))) || hits[0]
    if (hit) return hit
  } catch { /* not on PATH */ }
  const exe = IS_WIN && winHarnessExe()
  if (exe) {
    // Harness ≥ 0.2.1 ships its own launcher (the one its "add dsh to PATH" setting
    // exposes); older builds only have the CLI packed in app.asar.
    const launcher = path.join(path.dirname(exe), ...WIN_DSH_LAUNCHER)
    return fs.existsSync(launcher) ? launcher : exe
  }
  throw new Error('DeepSeek Harness CLI not found. Install DeepSeek Harness or set DSH_BIN to the dsh launcher.')
}

// How to start dsh with these arguments: { file, args, options }. On Windows a
// .cmd/.bat launcher needs cmd.exe (Node refuses to spawn it directly), and the
// desktop app's own exe runs the packed CLI script with ELECTRON_RUN_AS_NODE=1.
export function dshCommand(args, bin = dshBin(), platform = process.platform) {
  if (platform !== 'win32') return { file: bin, args, options: {} }
  if (/\.(cmd|bat)$/i.test(bin)) {
    const quote = (a) => (/[\s"&|<>^()%!]/.test(a) || a === '' ? `"${a.replace(/"/g, '""')}"` : a)
    const line = [bin, ...args].map(quote).join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
  }
  if (/DeepSeek Harness\.exe$/i.test(bin)) {
    return { file: bin, args: [path.join(path.dirname(bin), ...WIN_DSH_SCRIPT), ...args], options: { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } }
  }
  return { file: bin, args, options: {} }
}

// Stop a process. On Windows the dsh we started may be cmd.exe or Electron with
// children of its own, so the whole tree of that one pid is ended.
function stopProcess(pid) {
  if (!IS_WIN) return process.kill(pid, 'SIGTERM')
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

// Expand `~`, resolve, and follow symlinks when the path exists, so the same
// folder always compares equal (on macOS /tmp is a link to /private/tmp).
export function normalizePath(p) {
  const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()))
  try { return fs.realpathSync.native(abs) } catch { return abs }
}

function patchArgs() {
  const patches = []
  if (config.useAccount) patches.push(path.join(ROOT, 'patches', 'account.patch.yml'))
  patches.push(...config.extraPatches)
  return patches.flatMap((p) => ['--patch', p])
}

// ---------------------------------------------------------------------------
// Host plugin (dsh-baton-host) running inside the Harness desktop app / `dsh web`.
// Preferred backend: prompts go through the host's own session controller, so
// they work on any session and show up live in the Harness UI.

// The socket helpers are shared with the host plugin, so the two always agree.
export { socketEndpoint, setting }
export const hostSocket = () => hostEndpoints()[0]

// Tries each endpoint in turn: a host plugin from before the rename listens on the old
// pipe name on Windows until Harness restarts.
export async function hostCall(method, params, options) {
  const endpoints = hostEndpoints()
  for (let i = 0; ; i++) {
    try {
      return await hostCallAt(endpoints[i], method, params, options)
    } catch (e) {
      if (!e.hostDown || i === endpoints.length - 1) throw e
    }
  }
}

function hostCallAt(endpoint, method, params = {}, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(endpoint)
    let buf = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      error ? reject(error) : resolve(value)
    }
    const timer = timeoutMs ? setTimeout(() => finish(new Error(`dsh-baton-host did not answer ${method} in time`)), timeoutMs) : null
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, method, params }) + '\n'))
    conn.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      let msg
      try { msg = JSON.parse(buf.slice(0, nl)) } catch { msg = null }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return finish(new Error(`dsh-baton-host sent an unreadable reply to ${method}`))
      msg.error ? finish(new Error(String(msg.error))) : finish(null, msg.result)
    })
    conn.on('error', (e) => finish(Object.assign(e, { hostDown: true })))
    conn.on('close', () => finish(new Error(`dsh-baton-host closed the connection before answering ${method}`)))
  })
}

export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

// The plugin version from the last successful ping.
let hostVersion = null

export async function hostAvailable() {
  try {
    hostVersion = (await hostCall('ping', {}, { timeoutMs: 2000 }))?.version ?? null
    return true
  } catch {
    return false
  }
}

export const hostVersionSeen = () => hostVersion

// The plugin and the MCP server update separately (Harness and npx), so they can drift.
// A different major.minor gets a note asking to update the older side; patch releases mix.
const minorOf = (v) => String(v).split('.').slice(0, 2).join('.')
export function versionWarning(plugin = hostVersion, server = VERSION) {
  if (!plugin || minorOf(plugin) === minorOf(server)) return null
  return `The Harness plugin dsh-baton-host is ${plugin} but this MCP server is ${server}. Update the older one: the server with \`npx -y dsh-baton-mcp@latest setup\`, the plugin in Harness (Plugins → dsh-baton-host → Uninstall, then Add plugin → dsh-baton-host).`
}

// Who a relayed message is from, shown on it in the Harness chat: DSH_BATON_SENDER if set,
// else the MCP client's name (claude-code, claude-ai → claude; codex-mcp-client → codex).
export function senderOf(clientName = setting('SENDER')) {
  const n = String(clientName ?? '').toLowerCase()
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex')) return 'codex'
  const slug = n.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || undefined
}

export const isHostRun = (runId) => typeof runId === 'string' && runId.startsWith('hrun-')

// ---------------------------------------------------------------------------
// Sessions (headless fallback: read straight from ~/.dsh/sessions)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// A session file is a sequence of appended zstd frames, each holding JSONL records.
// maxBytes stops decoding early once enough text is read (for cheap listing).
function readSessionRecords(file, maxBytes = Infinity) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i)
  const records = []
  let text = ''
  // The magic bytes can also occur inside compressed data. A frame cut at such a
  // false start fails to decode, so extend it to the next candidate start until it
  // decodes; a start that never decodes is itself a false start and is skipped.
  let k = 0
  while (k < starts.length && text.length <= maxBytes) {
    let next = k + 1
    for (let j = k + 1; j <= starts.length; j++) {
      try {
        text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[j] ?? buf.length)).toString()
        next = j
        break
      } catch { /* cut inside this frame; try the next candidate end */ }
    }
    k = next
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    try { records.push(JSON.parse(line)) } catch { /* partial line */ }
  }
  return records
}

function sessionsRoot() {
  return path.join(config.dshHome, 'sessions')
}

function sessionFile(dir) {
  return path.join(dir, 'session.v4.jsonl.zstd')
}

// Every session directory, newest first.
function allSessionDirs() {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const out = []
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws)
    let entries
    try { entries = fs.readdirSync(wsDir) } catch { continue }
    for (const id of entries) {
      const file = sessionFile(path.join(wsDir, id))
      try { out.push({ id, dir: path.join(wsDir, id), mtime: fs.statSync(file).mtimeMs }) } catch { /* not a session */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function findSessionDir(sessionId) {
  const hit = allSessionDirs().find((s) => s.id === sessionId)
  if (!hit) throw new Error(`Unknown session: ${sessionId}`)
  return hit
}

function summarize(records, fallbackId) {
  const header = records.find((r) => r.type === 'session') || {}
  let title = null
  for (const r of records) if (r.type === 'session/title') title = r.data?.title ?? title
  return { session_id: header.id || fallbackId, cwd: header.cwd || null, title, created_at: header.createdAt ? new Date(header.createdAt).toISOString() : null }
}

export function listSessions({ cwd, query, limit = 20 } = {}) {
  const want = cwd ? normalizePath(cwd) : null
  const q = query ? query.toLowerCase() : null
  const out = []
  for (const s of allSessionDirs()) {
    if (out.length >= limit) break
    let info
    try { info = summarize(readSessionRecords(sessionFile(s.dir), 256 * 1024), s.id) } catch { continue }
    if (want && (!info.cwd || normalizePath(info.cwd) !== want)) continue
    if (q && !`${info.title ?? ''} ${info.cwd ?? ''} ${info.session_id}`.toLowerCase().includes(q)) continue
    out.push({ ...info, updated_at: new Date(s.mtime).toISOString(), busy: activeRunFor(info.session_id)?.run_id ?? null })
  }
  return out
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

// The visible conversation: user prompts and assistant replies, oldest first.
export function readSession({ session_id, last = 10 }) {
  const s = findSessionDir(session_id)
  const records = readSessionRecords(sessionFile(s.dir))
  const messages = []
  for (const r of records) {
    if (r.type === 'user/message' && r.data?.source?.kind === 'user') {
      messages.push({ role: 'user', time: new Date(r.time).toISOString(), text: textOf(r.data.content) })
    } else if (r.type === 'assistant/message') {
      const content = r.data?.message?.content || []
      const tools = content.filter((c) => c.type !== 'text' && c.type !== 'reasoning').map((c) => c.name || c.type)
      const text = textOf(content)
      if (text || tools.length) messages.push({ role: 'assistant', time: new Date(r.time).toISOString(), text, ...(tools.length ? { tools } : {}) })
    }
  }
  return { ...summarize(records, s.id), total_messages: messages.length, messages: messages.slice(-last) }
}

// ---------------------------------------------------------------------------
// Runs: one headless turn per run, executed by a detached runner process so it
// survives the MCP server restarting. Each run lives in <batonHome>/runs/<id>/.

function runsDir() {
  return path.join(config.batonHome, 'runs')
}

// Run records hold full prompts and replies: keep them private to this user.
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function runDir(runId) {
  if (!/^run-[\w-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`)
  return path.join(runsDir(), runId)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const cancelFlag = (dir) => path.join(dir, 'cancelled')

function writeExit(dir, exit) {
  writeJson(path.join(dir, 'exit.json'), { ended_at: new Date().toISOString(), ...exit })
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function activeRunFor(sessionId) {
  if (!sessionId || !fs.existsSync(runsDir())) return null
  for (const id of fs.readdirSync(runsDir())) {
    const st = runStatus(id, { tail: 0 })
    if (st.session_id === sessionId && st.state === 'running') return st
  }
  return null
}

export function startRun({ message, session_id, cwd }) {
  if (!message || !message.trim()) throw new Error('message is required')
  let workdir
  if (session_id) {
    const busy = activeRunFor(session_id)
    if (busy) throw new Error(`Session ${session_id} is already running ${busy.run_id}; wait for it or cancel it first.`)
    const info = summarize(readSessionRecords(sessionFile(findSessionDir(session_id).dir), 64 * 1024), session_id)
    workdir = info.cwd
  } else {
    if (!cwd) throw new Error('A new session needs cwd (the workspace folder). Pass session_id to continue an existing one.')
    workdir = normalizePath(cwd)
  }
  if (!workdir || !fs.existsSync(workdir)) throw new Error(`Workspace folder does not exist: ${workdir}`)

  const runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`
  const dir = runDir(runId)
  ensurePrivateDir(config.batonHome)
  ensurePrivateDir(runsDir())
  ensurePrivateDir(dir)
  fs.writeFileSync(path.join(dir, 'message.txt'), message, { mode: 0o600 })
  writeJson(path.join(dir, 'meta.json'), {
    run_id: runId, session_id: session_id || null, cwd: workdir, started_at: new Date().toISOString(),
    message_preview: message.slice(0, 200),
  })

  const runner = spawn(process.execPath, [path.join(HERE, 'cli.mjs'), '_run', runId], {
    detached: true, stdio: 'ignore', cwd: workdir, env: process.env, windowsHide: true,
  })
  runner.unref()
  return runId
}

// Executed inside the detached runner process.
export async function executeRun(runId) {
  const dir = runDir(runId)
  const meta = readJson(path.join(dir, 'meta.json'))
  const args = ['headless', ...patchArgs(), '--json']
  if (meta.session_id) args.push('--session-id', meta.session_id)
  args.push('-')

  // A cancel that arrived before the child started: never start it.
  if (fs.existsSync(cancelFlag(dir))) return writeExit(dir, { exit_code: null, signal: null, state: 'cancelled' })

  const events = fs.createWriteStream(path.join(dir, 'events.ndjson'), { mode: 0o600 })
  const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'w', 0o600)
  // No dsh found at all is a failed run with a reason, not a runner that dies silently.
  let launch
  try { launch = dshCommand(args) } catch (error) {
    events.end()
    fs.writeSync(stderr, `dsh: ${error.message}\n`)
    return writeExit(dir, { exit_code: null, signal: null, state: 'failed' })
  }
  const child = spawn(launch.file, launch.args, { cwd: meta.cwd, stdio: ['pipe', 'pipe', stderr], env: process.env, windowsHide: true, ...launch.options })
  // A dsh that cannot start (missing, not executable) is a failed run, not a crashed runner.
  const started = new Promise((resolve) => child.once('error', (error) => resolve(error)))
  child.stdin.on('error', () => {})
  writeJson(path.join(dir, 'pid.json'), { runner: process.pid, dsh: child.pid })
  // A cancel that arrived while the child was starting (before pid.json existed).
  if (fs.existsSync(cancelFlag(dir))) { try { IS_WIN ? stopProcess(child.pid) : child.kill('SIGTERM') } catch { /* not started */ } }
  fs.createReadStream(path.join(dir, 'message.txt')).pipe(child.stdin)

  // Keep only JSON lines; the CLI also prints plain log lines on stdout.
  let pending = ''
  child.stdout.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw // CRLF output on Windows
      if (line.startsWith('{')) events.write(line + '\n')
    }
  })

  const spawnError = await Promise.race([started, new Promise((resolve) => child.once('spawn', () => resolve(null)))])
  if (spawnError) {
    events.end()
    fs.writeSync(stderr, `dsh: could not start ${launch.file}: ${spawnError.message}\n`)
    return writeExit(dir, { exit_code: null, signal: null, state: 'failed' })
  }
  const [code, signal] = await new Promise((resolve) => child.on('close', (c, s) => resolve([c, s])))
  if (pending.startsWith('{')) events.write(pending + '\n')
  await new Promise((resolve) => events.end(resolve))
  const cancelled = fs.existsSync(cancelFlag(dir))
  writeExit(dir, { exit_code: code, signal, state: cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed' })
}

export function runStatus(runId, { tail = 20 } = {}) {
  const dir = runDir(runId)
  const meta = readJson(path.join(dir, 'meta.json'))
  if (!meta) throw new Error(`Unknown run: ${runId}`)
  const exit = readJson(path.join(dir, 'exit.json'))
  const pids = readJson(path.join(dir, 'pid.json'))

  let sessionId = meta.session_id, finalText = null, turnEnd = null, usage = { inputTokens: 0, outputTokens: 0 }
  const timeline = []
  let raw = ''
  try { raw = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8') } catch { /* not started */ }
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'session') sessionId = e.sessionId
    else if (e.type === 'final') finalText = e.text
    else if (e.type === 'text' && e.text) timeline.push({ type: 'text', text: e.text })
    else if (e.type === 'status' && e.phase === 'turn_end') turnEnd = e.reason
    else if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
      usage.inputTokens += e.usage.inputTokens || 0
      usage.outputTokens += e.usage.outputTokens || 0
    } else if (e.type !== 'status' && e.type !== 'thinking') timeline.push(e)
  }

  let state = exit?.state
  // No pid file yet means the runner is still starting; give it 30 s before calling it failed.
  if (!state) state = pids ? (alive(pids.runner) ? 'running' : 'failed') : (Date.now() - Date.parse(meta.started_at) < 30_000 ? 'running' : 'failed')
  if (state === 'failed' && !exit && fs.existsSync(cancelFlag(dir))) state = 'cancelled'
  let error = timeline.filter((e) => e.type === 'error').map((e) => e.message).join('\n') || null
  if (state === 'failed' && !error) {
    try { error = fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8').split('\n').filter((l) => l.startsWith('dsh: ') || /error/i.test(l)).slice(-5).join('\n') || null } catch { /* none */ }
  }
  return {
    run_id: runId, state, session_id: sessionId, cwd: meta.cwd, started_at: meta.started_at, ended_at: exit?.ended_at ?? null,
    message_preview: meta.message_preview, turn_end: turnEnd, final_text: finalText, usage, error,
    ...(tail ? { recent_events: timeline.slice(-tail) } : {}),
  }
}

export async function waitRun(runId, { timeout_s = 300, poll_ms = 1000 } = {}) {
  const deadline = Date.now() + timeout_s * 1000
  for (;;) {
    const st = runStatus(runId)
    if (st.state !== 'running') return st
    if (Date.now() >= deadline) return { ...st, timed_out: true }
    await new Promise((r) => setTimeout(r, poll_ms))
  }
}

// Resolves once the run has reported its session id (new sessions get one at start).
export async function waitForSessionId(runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = runStatus(runId, { tail: 0 })
    if (st.session_id || st.state !== 'running') return st
    await new Promise((r) => setTimeout(r, 250))
  }
  return runStatus(runId, { tail: 0 })
}

// Stop only the dsh child; the runner stays alive to record the cancelled state.
// Without a pid yet, the runner sees the flag and does not start (or stops) the child.
export function cancelRun(runId) {
  const dir = runDir(runId)
  const st = runStatus(runId, { tail: 0 })
  if (st.state !== 'running') return st
  fs.writeFileSync(cancelFlag(dir), '', { mode: 0o600 })
  const pids = readJson(path.join(dir, 'pid.json'))
  if (pids?.dsh) { try { stopProcess(pids.dsh) } catch { /* already gone */ } }
  if (pids && !alive(pids.runner)) writeExit(dir, { exit_code: null, signal: null, state: 'cancelled' })
  return { ...st, state: 'cancelling' }
}

export function listRuns({ limit = 10, session_id } = {}) {
  if (!fs.existsSync(runsDir())) return []
  const ids = fs.readdirSync(runsDir()).filter((d) => d.startsWith('run-')).sort().reverse()
  return (session_id ? ids : ids.slice(0, limit))
    .map((id) => { try { return runStatus(id, { tail: 0 }) } catch { return null } })
    .filter((r) => r && (!session_id || r.session_id === session_id)).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Backend routing. DSH_BATON_BACKEND = auto (default) | host | headless.
// auto uses the host plugin when its socket answers, else falls back to headless.

async function useHost() {
  const mode = setting('BACKEND') || 'auto'
  if (mode === 'headless') return false
  const up = await hostAvailable()
  if (!up && mode === 'host') throw new Error(`dsh-baton-host is not reachable at ${hostSocket()}. Is DeepSeek Harness running with the dsh-baton-host plugin enabled?`)
  return up
}

// Said with a finished run's reply: review from the evidence dsh-baton produced, read code only
// where it points, and send every fix back in one message.
export const REVIEW_REQUEST = '\n\n---\nWhen the work is done, start a read-only sub-agent to check it against every requirement above, then end your final reply with its table: requirement | met (yes / no / unclear) | evidence (file:line or test name). Fix anything marked no before replying.'

export const ENDED_HINT = 'evidence is produced by dsh-baton (files changed, checks it ran), not by the Harness reply: trust it over final_text. If a check failed, a requirement has no check, or a file the task needs is missing from evidence.changes, send all fixes back in one message to the same session, quoting the failing output; do not reproduce failures or write test scripts yourself. If every check passed and final_text ends with a review table whose rows are all met, accept it without reading code; read code only for rows marked no or unclear.'

// The asking model marks its favourite option in the label ("(Recommended)", "（推荐）").
// Clients relaying the question tended to repeat that mark as their own advice, so the
// label is cleaned and the mark moves to harness_suggested: what the asker suggests, kept
// apart from the recommendation the client has to form itself. Harness still matches a
// cleaned label when it is chosen by label.
const MARK = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*/gi
const cleanLabel = (label) => String(label).replace(MARK, ' ').trim()
export function shapeQuestion(question) {
  if (!Array.isArray(question?.questions)) return question
  return {
    ...question,
    questions: question.questions.map((q) => {
      let suggested = null
      const options = (q.options ?? []).map(({ recommended, ...o }) => {
        const label = cleanLabel(o.label)
        if (!suggested && (recommended || label !== o.label)) suggested = { number: o.number, label }
        return { ...o, label }
      })
      return { ...q, options, ...(suggested ? { harness_suggested: suggested } : {}) }
    }),
  }
}
// The question laid out for the user, ready to show: the first line is left for the
// client's own recommendation, the asker's pick comes last and only as information.
// Weaker models fill in a template more reliably than they follow a paragraph of rules.
export function relayText(question) {
  if (!Array.isArray(question?.questions)) return undefined
  const blocks = question.questions.map((q, i) => {
    const head = `${question.questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${q.multi_select ? ' (several can be chosen)' : ''}`
    const options = (q.options ?? []).map((o) => `  ${o.number}. ${o.label}${o.description ? ` - ${o.description}` : ''}`)
    const asker = q.harness_suggested ? [`  (The model in Harness that asked would pick: ${q.harness_suggested.label})`] : []
    return [head, ...options, ...asker].join('\n')
  })
  return ['My recommendation: <your pick>, because <your own reason>', '', ...blocks].join('\n')
}

// When the client chose for the user (dsh_answer with reason), the choice and reason are
// kept until the run ends: the final wait result carries them, so the client tells the
// user then, instead of only passing on the reply. A file, because the client may wait
// from another process (wait_command).
const reasonsFile = () => path.join(config.batonHome, 'answer-reasons.json')
const readReasons = () => { try { return JSON.parse(fs.readFileSync(reasonsFile(), 'utf8')) } catch { return {} } }
function rememberReason(runId, answers, reason) {
  try {
    const all = readReasons()
    all[runId] = { answers: (answers ?? []).map((a) => ({ id: a.id, selected: (a.selected ?? []).map(cleanLabel), ...(a.custom ? { text: a.custom } : {}) })), reason, at: Date.now() }
    const kept = Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, 50)
    ensurePrivateDir(config.batonHome)
    fs.writeFileSync(reasonsFile(), JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 })
  } catch { /* the reason is a courtesy; answering never fails over it */ }
}
const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const shaped = (st) => {
  if (!st || typeof st !== 'object') return st
  let out = st.question ? { ...st, question: shapeQuestion(st.question) } : st
  const decided = ENDED.has(st.state) && st.run_id ? readReasons()[st.run_id] : null
  if (decided) out = { ...out, decided_for_user: { answers: decided.answers, reason: decided.reason } }
  return Array.isArray(st.answers) ? { ...out, answers: st.answers.map((a) => (Array.isArray(a?.selected) ? { ...a, selected: a.selected.map(cleanLabel) } : a)) } : out
}

// The folder a run works in: given with dsh_send, or that of its workspace or session.
async function runFolder(a, st) {
  if (a.cwd) return path.resolve(a.cwd.replace(/^~(?=$|[\\/])/, os.homedir()))
  if (st?.cwd) return st.cwd
  try {
    if (a.workspace_id) return (await api.workspaces()).find((w) => w.id === a.workspace_id)?.path
    const sid = a.session_id ?? st?.session_id
    if (sid) return (await api.list_sessions({ query: sid, limit: 5 })).find((x) => x.session_id === sid)?.cwd
  } catch { /* no folder, no evidence */ }
  return undefined
}
const withEvidence = (st) => {
  if (!st || !ENDED.has(st.state) || !st.run_id) return st
  const ev = evidence.collect(config.batonHome, st.run_id)
  return ev ? { ...st, evidence: ev } : st
}

const tag = (backend, value) => (Array.isArray(value) ? value.map((v) => ({ ...v, backend })) : { ...value, backend })

export const api = {
  async workspaces() {
    if (!(await useHost())) throw new Error('Listing workspaces needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    return hostCall('workspaces')
  },
  async create_workspace(a) {
    if (!(await useHost())) throw new Error('Creating workspaces needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    return hostCall('create_workspace', a)
  },
  async list_sessions(a = {}) {
    return (await useHost()) ? tag('host', await hostCall('list_sessions', a)) : tag('headless', listSessions(a))
  },
  async read_session(a) {
    return (await useHost()) ? tag('host', await hostCall('read_session', a)) : tag('headless', readSession(a))
  },
  // checks stay here: dsh-baton runs them itself when the run ends (see evidence.mjs).
  // A hand-over (a message with checks) also asks Harness to have a read-only sub-agent
  // review the work against the spec and end with a table, so the client can decide from
  // that table and the evidence instead of reading the code itself.
  async send({ checks, ...a }) {
    if (Array.isArray(checks) && checks.length && typeof a.message === 'string') a = { ...a, message: `${a.message}${REVIEW_REQUEST}` }
    const st = (await useHost()) ? tag('host', await hostCall('send', a)) : tag('headless', await waitForSessionId(startRun(a)))
    evidence.prepare(config.batonHome, { run_id: st.run_id, cwd: await runFolder(a, st), checks })
    return st
  },
  async status({ run_id, tail = 20 }) {
    return withEvidence(shaped(isHostRun(run_id) ? tag('host', await hostCall('status', { run_id, tail })) : tag('headless', runStatus(run_id, { tail }))))
  },
  async wait({ run_id, timeout_s = 300 }) {
    if (isHostRun(run_id)) return withEvidence(shaped(tag('host', await hostCall('wait', { run_id, timeout_s }, { timeoutMs: (timeout_s + 15) * 1000 }))))
    return withEvidence(tag('headless', await waitRun(run_id, { timeout_s })))
  },
  async cancel({ run_id, session_id }) {
    if (run_id && !isHostRun(run_id)) return tag('headless', cancelRun(run_id))
    return tag('host', await hostCall('cancel', { run_id, session_id }, { timeoutMs: 40000 }))
  },
  async rename_session(a) {
    if (!(await useHost())) throw new Error('Renaming needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    return hostCall('rename_session', a)
  },
  async rename_workspace(a) {
    if (!(await useHost())) throw new Error('Renaming needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    return hostCall('rename_workspace', a)
  },
  async activity({ session_id }) {
    if (!(await useHost())) throw new Error('Session activity needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    return hostCall('activity', { session_id })
  },
  async update_queued(a) {
    if (!(await useHost())) throw new Error('Changing a queued message needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    try {
      return await hostCall('update_queued', a)
    } catch (error) {
      if (!/Unknown method: update_queued/.test(error?.message)) throw error
      throw new Error(`The Harness plugin dsh-baton-host ${hostVersion ?? ''} is too old to change queued messages; this MCP server is ${VERSION}. Update the plugin in Harness: Plugins → dsh-baton-host → Uninstall, then Add plugin → dsh-baton-host@${VERSION}.`.replace('  ', ' '))
    }
  },
  // reason (why the client chose, when the user let it decide) stays here: it is for the
  // user, not for Harness.
  async answer({ reason, ...a }) {
    if (!(await useHost())) throw new Error('Answering a question needs the dsh-baton-host plugin running inside DeepSeek Harness.')
    try {
      const result = shaped(await hostCall('answer', a))
      if (!(typeof reason === 'string' && reason.trim())) return result
      if (result.submitted) rememberReason(a.run_id, result.answers, reason.trim())
      return { ...result, reason: reason.trim() }
    } catch (error) {
      if (!/Unknown method: answer/.test(error?.message)) throw error
      throw new Error(`The Harness plugin dsh-baton-host ${hostVersion ?? ''} is too old to answer questions; this MCP server is ${VERSION}. Answer in the Harness window, or update the plugin: Plugins → dsh-baton-host → Uninstall, then Add plugin → dsh-baton-host@${VERSION}.`.replace('  ', ' '))
    }
  },
  async list_runs({ limit = 10, session_id } = {}) {
    // An older plugin ignores session_id, so the host's runs are filtered here too.
    const host = (await hostAvailable()) ? tag('host', await hostCall('list_runs', { limit: session_id ? 100 : limit, session_id })).filter((r) => !session_id || r.session_id === session_id) : []
    return [...host, ...tag('headless', listRuns({ limit, session_id }))].sort((x, y) => String(y.started_at).localeCompare(String(x.started_at))).slice(0, limit).map(shaped)
  },
}
