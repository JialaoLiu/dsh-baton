// Registering the dsh-baton MCP server for Claude Code and Codex, user-wide, by writing
// their config files directly. This needs no `claude` or `codex` on PATH (desktop-only
// installs have neither) and no hand-editing of TOML.
//
// Two callers: `dsh-baton setup` (src/setup.mjs), and the Harness plugin, which runs
// autoRegister() when it is switched on. So this module imports nothing that does work
// at load time: it runs inside the Harness host process as well.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { batonHome } from '../host/lib/socket.js'

export const NAME = 'dsh-baton'
// The name before the rename: its entries are removed so the tools are not listed twice.
const OLD_NAME = 'dsh-bridge'

export const claudeConfigPath = (env = process.env, home = os.homedir()) =>
  path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')
export const codexConfigPath = (env = process.env, home = os.homedir()) =>
  path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')

// ~/.claude.json: the top-level "mcpServers" map is Claude Code's user scope.
export function editClaudeConfig(text, entry) {
  const cfg = text.trim() ? JSON.parse(text) : {}
  const servers = { ...(cfg.mcpServers ?? {}) }
  delete servers[OLD_NAME]
  if (entry) servers[NAME] = { type: 'stdio', command: entry.command, args: entry.args, env: entry.env ?? {} }
  else delete servers[NAME]
  return JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + '\n'
}

export function readClaudeEntry(text) {
  const e = text.trim() ? JSON.parse(text).mcpServers?.[NAME] : null
  if (!e?.command) return null
  return { command: e.command, args: e.args ?? [], ...(e.env && Object.keys(e.env).length ? { env: e.env } : {}) }
}

const tomlString = (s) => (/['\n\r]/.test(s) ? JSON.stringify(s) : `'${s}'`)
// Our own table and its sub-tables ([mcp_servers.dsh-baton], [mcp_servers.dsh-baton.env], …),
// under the current name or the one before the rename.
const OWN_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(["']?)dsh-(?:baton|bridge)\1\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_TABLE = /^\s*\[/

// Codex stops an MCP tool call after 300 s unless the server's table sets tool_timeout_sec.
// dsh-baton sets an hour, so one dsh_wait waits up to about that long: one model request
// per hour of a run instead of one every 270 s.
export const CODEX_TOOL_TIMEOUT_S = 3600
const TIMEOUT_KEY = /^\s*(["']?)tool_timeout_sec\1\s*=\s*([\d_.]+)\s*(?:#.*)?$/
const HAS_TIMEOUT = /^\s*(["']?)tool_timeout_sec\1\s*=/

// The lines of [mcp_servers.dsh-baton] (not its sub-tables): [start, end) indexes, or null.
function ownMainTable(lines) {
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(["']?)dsh-baton\1\s*\]\s*(?:#.*)?$/.test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && (ANY_TABLE.test(l) || l === HOOK_MARK))
  if (end < 0) end = lines.length
  return [start, end]
}

// tool_timeout_sec in [mcp_servers.dsh-baton], in seconds, or null.
export function readCodexToolTimeout(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const t = ownMainTable(lines)
  if (!t) return null
  for (const l of lines.slice(...t)) {
    const m = l.match(TIMEOUT_KEY)
    const n = m && Number(m[2].replace(/_/g, ''))
    if (n > 0) return n
  }
  return null
}

// Adds tool_timeout_sec to an existing [mcp_servers.dsh-baton] that has none (entries
// written before it existed); a value already there, the user's own, is kept.
export function addCodexToolTimeout(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const t = ownMainTable(lines)
  if (!t || lines.slice(...t).some((l) => HAS_TIMEOUT.test(l))) return text
  let at = t[1]
  while (at > t[0] + 1 && !lines[at - 1].trim()) at--
  lines.splice(at, 0, `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_S}`)
  return lines.join('\n')
}

// Codex reads tool_timeout_sec when a conversation starts and keeps it: a conversation opened
// before the value was written still stops calls at 300 s. So when the value appears or
// changes, the time is noted here; the server gives the long wait only to conversations
// started after it (a Codex thread id is a UUIDv7, which carries its start time). fresh: the
// value was just put back (something had taken it out, and conversations opened meanwhile
// stop at 300 s), so the time is noted again even though the value is the same.
export const codexTimeoutNoteFile = (env = process.env, home = os.homedir()) => path.join(batonHome(env, home), 'codex-timeout.json')
export function noteCodexToolTimeout(file, env = process.env, home = os.homedir(), fresh = false) {
  try {
    const value = readCodexToolTimeout(fs.readFileSync(file, 'utf8'))
    const note = codexTimeoutNoteFile(env, home)
    let seen = null
    try { seen = JSON.parse(fs.readFileSync(note, 'utf8')) } catch { /* none yet */ }
    if (!value || (!fresh && seen?.value === value)) return
    fs.mkdirSync(path.dirname(note), { recursive: true, mode: 0o700 })
    // prev: what conversations opened before still have (none: Codex's default 300 s).
    fs.writeFileSync(note, JSON.stringify({ value, since: Date.now(), prev: fresh ? null : seen?.value ?? null }))
  } catch { /* no note: the server goes by the config file's time */ }
}

// How long one Codex dsh_wait may wait: tool_timeout_sec less 60 s for a conversation that
// started after the value was written (started: from its UUIDv7 thread id), else 270 s,
// under Codex's default 300 s, or under the value before when the user had set one. A value
// too short for the long wait (the user's own) is kept under, less 30 s (half, under a
// minute). started undefined: the length a new conversation gets.
export const threadStartedAt = (threadId) => {
  const id = String(threadId ?? '').replace(/-/g, '')
  return /^[0-9a-f]{12}7/i.test(id) ? parseInt(id.slice(0, 12), 16) : null
}
const shortWait = (value) => (!value ? 270 : value > 60 ? Math.min(270, Math.floor(value - 30)) : Math.max(1, Math.floor(value / 2)))
export function codexWaitSeconds({ value, since, prev = null }, started) {
  const long = value && value - 60 > 270 ? Math.min(Math.floor(value - 60), 24 * 3600) : null
  const now = long ?? shortWait(value)
  if (started === undefined) return now
  // Opened before the value was written: Codex still holds it to the one before.
  return started && since && started > since ? now : Math.min(now, shortWait(prev))
}

// ~/.codex/config.toml: replace any earlier dsh-baton tables with one fresh table at the
// end, with tool_timeout_sec (see CODEX_TOOL_TIMEOUT_S; a value the user set is kept).
export function editCodexConfig(text, entry) {
  const timeout = readCodexToolTimeout(text) ?? CODEX_TOOL_TIMEOUT_S
  const kept = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (OWN_TABLE.test(line)) skipping = true
    // The hook's marker line heads the hook block that follows, not our table before it.
    else if (ANY_TABLE.test(line) || line === HOOK_MARK) skipping = false
    if (!skipping) kept.push(line)
  }
  let out = kept.join('\n').replace(/\s+$/, '')
  if (entry) {
    out += `${out ? '\n\n' : ''}[mcp_servers.${NAME}]\ncommand = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(', ')}]\ntool_timeout_sec = ${timeout}`
    const env = Object.entries(entry.env ?? {})
    if (env.length) out += `\n\n[mcp_servers.${NAME}.env]\n${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join('\n')}`
  }
  return out ? out + '\n' : ''
}

// The command, args and env of [mcp_servers.dsh-baton] (and its .env table), as setup
// writes them (single-line strings).
export function readCodexEntry(text) {
  const str = String.raw`'[^'\n]*'|"(?:[^"\\\n]|\\.)*"`
  const unquote = (s) => (s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s))
  let table = null
  let command = null, args = []
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    if (ANY_TABLE.test(line)) {
      const m = line.match(/^\s*\[\s*mcp_servers\s*\.\s*(["']?)dsh-baton\1\s*(\.\s*env\s*)?\]/)
      table = m ? (m[2] ? 'env' : 'main') : null
    } else if (table === 'main') {
      const c = line.match(new RegExp(`^\\s*command\\s*=\\s*(${str})`))
      if (c) command = unquote(c[1])
      const a = line.match(/^\s*args\s*=\s*\[(.*)\]/)
      if (a) args = [...a[1].matchAll(new RegExp(str, 'g'))].map((m) => unquote(m[0]))
    } else if (table === 'env') {
      const kv = line.match(new RegExp(`^\\s*([\\w-]+)\\s*=\\s*(${str})`))
      if (kv) env[kv[1]] = unquote(kv[2])
    }
  }
  return command ? { command, args, ...(Object.keys(env).length ? { env } : {}) } : null
}

// The Codex Stop hook dsh-baton added before 0.6.4 (src/codex-hook.mjs), known here so it
// can be taken out (see removeCodexHookBlock) without touching hooks of the user's own. Every
// version wrote it as its own [[hooks.Stop]] group with one hook, after a marker line.
const HOOK_MARK = '# dsh-baton: wakes Codex when a Harness run ends (dsh-baton codex-stop-hook)'
// How long one hook call may wait; Codex kills the hook after the timeout in its config.
export const HOOK_TIMEOUT_S = 24 * 3600
// What Codex shows for the hook (0.6.1 on; the builds before had no status message).
const HOOK_STATUS = 'dsh-baton: waiting for the Harness run'
// Its command: the wrapper in ~/.dsh-baton/bin (0.6.1 on, also in PowerShell's call form of
// the node line it runs), or that node line itself (before 0.6.1). A wrapper written as an
// 8.3 short path, or under another DSH_BATON_HOME, is known by HOOK_STATUS instead.
const OUR_COMMAND = /(?:[\\/]\.dsh-baton[\\/]bin[\\/]codex-stop-hook(?:\.cmd)?"?|"[^"]*[\\/]cli\.mjs" codex-stop-hook)$/i
const HEADER = /^\s*\[/
// [[hooks.Stop]] and [[hooks.Stop.hooks]] headers, spaced or with a comment after them.
const STOP_GROUP = /^\s*\[\[\s*hooks\s*\.\s*Stop\s*\]\]\s*(?:#.*)?$/
const STOP_HOOK = /^\s*\[\[\s*hooks\s*\.\s*Stop\s*\.\s*hooks\s*\]\]\s*(?:#.*)?$/

// A TOML string as written: basic ("..." with escapes, which JSON reads) or literal ('...',
// what Codex itself writes when the text holds backslashes, as Windows paths do).
function readTomlString(v) {
  const t = v.trim()
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1)
  try { return JSON.parse(t) } catch { return null }
}

// The [[hooks.Stop]] groups in file order: { start, end } line ranges (end exclusive, trailing
// blank and comment lines left to what follows) and whether the group is our hook alone.
function stopGroups(lines) {
  const groups = []
  for (let i = 0; i < lines.length; i++) {
    if (!STOP_GROUP.test(lines[i])) continue
    let end = i + 1
    while (end < lines.length && !(HEADER.test(lines[end]) && !STOP_HOOK.test(lines[end]))) end++
    while (end > i + 1 && (!lines[end - 1].trim() || lines[end - 1].trim().startsWith('#'))) end--
    const body = lines.slice(i + 1, end)
    const hooks = body.filter((l) => STOP_HOOK.test(l)).length
    const value = (key) => body.map((l) => l.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`))).find(Boolean)?.[1]
    const command = readTomlString(value('command') ?? '') ?? ''
    const ours = hooks === 1 && (OUR_COMMAND.test(command) || readTomlString(value('statusMessage') ?? '') === HOOK_STATUS)
    groups.push({ start: i, end, ours })
    i = end - 1
  }
  return groups
}

// Codex keeps its trust in [hooks.state."<config file>:stop:<group>:<hook>"] tables, keyed by
// place. Each table: its key's file, group and hook, and its lines.
function trustTables(lines) {
  const tables = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*$/)
    const key = m && readTomlString(m[1])
    const k = key?.match(/^(.*):stop:(\d+):(\d+)$/)
    if (!k) continue
    let end = i + 1
    while (end < lines.length && !HEADER.test(lines[end])) end++
    tables.push({ start: i, end, file: k[1], group: Number(k[2]), hook: Number(k[3]), quote: m[1][0] })
  }
  return tables
}

const sameFile = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

// dsh-baton no longer uses a Codex Stop hook: long dsh_waits (tool_timeout_sec) cost about
// as little, read as an ordinary tool result and need nothing trusted, where the hook's
// message reads badly. So plugin start and setup take out the one 0.6.0–0.6.3 added; updating
// is all the user does. Conversations opened before keep calling it, so its wrapper in
// ~/.dsh-baton/bin stays; with nothing pending it ends quietly (codex-hook.mjs).
//
// Takes our hook groups out of a Codex config, with their trust records. The groups after
// one move up a place, so their trust records are renumbered to match and the user's own
// hooks stay trusted. file: the config's path, to touch only trust records keyed by it
// (records of other config layers are left alone); without it any record counts.
// Returns the text unchanged when there is nothing of ours.
export function removeCodexHookBlock(text, file = null) {
  let lines = String(text ?? '').split(/\r?\n/)
  if (!stopGroups(lines).some((x) => x.ours)) return text
  for (;;) {
    const groups = stopGroups(lines)
    const g = groups.findIndex((x) => x.ours)
    if (g < 0) break
    let { start, end } = groups[g]
    // With the marker line. A blank line before it stays to part what was before from what
    // follows, so the blank lines after the block go.
    if (start > 0 && lines[start - 1] === HOOK_MARK) start--
    if (start === 0 || !lines[start - 1].trim()) while (end < lines.length && !lines[end].trim()) end++
    const mine = (t) => !file || sameFile(t.file, file)
    const drop = new Set()
    for (let i = start; i < end; i++) drop.add(i)
    const rename = new Map()
    for (const t of trustTables(lines).filter(mine)) {
      if (t.group === g) for (let i = t.start; i < t.end; i++) drop.add(i)
      else if (t.group > g) {
        const key = `${t.file}:stop:${t.group - 1}:${t.hook}`
        rename.set(t.start, `[hooks.state.${t.quote === "'" && !key.includes("'") ? `'${key}'` : JSON.stringify(key)}]`)
      }
    }
    lines = lines.flatMap((l, i) => (drop.has(i) ? [] : [rename.get(i) ?? l]))
  }
  lines = lines.filter((l) => l !== HOOK_MARK)
  const after = lines.join('\n').replace(/\s+$/, '')
  return after ? `${after}\n` : ''
}

// Writes an old-style hook block (tests build the configs 0.6.1-0.6.3 left with it).
export function codexHookBlockFor(command) {
  return `${HOOK_MARK}\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\nstatusMessage = ${JSON.stringify(HOOK_STATUS)}\ntimeout = ${HOOK_TIMEOUT_S}\n`
}

// Write only when the content changes, keep one backup, and replace the file atomically.
export function rewrite(file, edit) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  let after = edit(before)
  // The edits join lines with \n; a file written with \r\n (Windows) keeps them.
  if (before.includes('\r\n') && after !== before) after = after.replace(/\r?\n/g, '\r\n')
  if (after === before) return 'unchanged'
  if (before) fs.copyFileSync(file, `${file}.bak-dsh-baton`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, after, { mode: before ? fs.statSync(file).mode : 0o600 })
  // On Windows a file another process has open (Codex reading its config just after a
  // change, an antivirus scan) refuses the rename for a moment: try again shortly. The file
  // is read again each time, so a change saved meanwhile (Codex's own settings) is kept.
  let seen = before
  for (let tries = 0; ; tries++) {
    try { fs.renameSync(tmp, file); break } catch (e) {
      if (tries < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        let now = seen
        try { now = fs.readFileSync(file, 'utf8') } catch { /* still locked: as before */ }
        if (now !== seen) {
          seen = now
          let next = edit(now)
          if (now.includes('\r\n') && next !== now) next = next.replace(/\r?\n/g, '\r\n')
          if (next === now) { fs.rmSync(tmp, { force: true }); return 'unchanged' }
          fs.writeFileSync(tmp, next)
        }
        continue
      }
      try { fs.rmSync(tmp, { force: true }) } catch { /* left behind */ }
      throw e
    }
  }
  return 'updated'
}

// Which clients are installed for this user, and where their config lives.
export function clients(env = process.env, home = os.homedir()) {
  const claude = claudeConfigPath(env, home)
  const codex = codexConfigPath(env, home)
  return [
    { id: 'claude', label: 'Claude Code', file: claude, present: fs.existsSync(claude) || fs.existsSync(path.join(home, '.claude')), edit: editClaudeConfig, read: readClaudeEntry },
    { id: 'codex', label: 'Codex', file: codex, present: fs.existsSync(path.dirname(codex)), edit: editCodexConfig, read: readCodexEntry },
  ]
}

// The node to register: the one on PATH when it is this same binary, since that path
// survives upgrades (Homebrew's /opt/homebrew/bin/node, not the versioned Cellar path
// that process.execPath resolves to); otherwise the running binary itself.
export function stableNodePath(env = process.env, execPath = process.execPath) {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }
  const target = real(execPath)
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (candidate !== execPath && target && real(candidate) === target) return candidate
    }
  }
  return execPath
}

export const MIN_NODE = [22, 15]
export function nodeVersionOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

// The user's own Node.js for the MCP server, preferred over Harness's runtime (see
// harnessRuntime): the first `node` on PATH, then the usual install folders, never the
// launcher scripts inside the Harness app (they only work from Harness itself), and only
// a new enough one.
export function findNode({ env = process.env, platform = process.platform, exclude = [], version = nodeVersion } = {}) {
  const exe = platform === 'win32' ? 'node.exe' : 'node'
  const p = platform === 'win32' ? path.win32 : path.posix
  const dirs = (env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean)
  if (platform === 'win32') {
    dirs.push(...[env.NVM_SYMLINK, env.ProgramFiles && p.join(env.ProgramFiles, 'nodejs'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs', 'nodejs')].filter(Boolean))
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  }
  const real = (x) => { try { return fs.realpathSync(x) } catch { return x } }
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s)
  const skip = exclude.filter(Boolean).map((x) => fold(real(x)))
  const seen = new Set()
  for (const dir of dirs) {
    const candidate = p.join(dir, exe)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (!fs.existsSync(candidate)) continue
    const at = fold(real(candidate))
    if (skip.some((x) => at === x || at.startsWith(x + p.sep))) continue
    if (nodeVersionOk(version(candidate))) return candidate
  }
  return null
}

function nodeVersion(bin) {
  try {
    return execFileSync(bin, ['--version'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).toString().trim()
  } catch {
    return ''
  }
}

// The stable folder the server runs from when it came from a package cache (npx's, or
// the Harness profile's): those can be cleared or replaced at any time.
export const appDir = (home = batonHome()) => path.join(home, 'app')
const APP_PARTS = ['src', 'host', 'patches', 'package.json', 'LICENSE']

export function installApp(from, to = appDir()) {
  fs.mkdirSync(to, { recursive: true })
  for (const part of APP_PARTS) {
    const src = path.join(from, part)
    if (!fs.existsSync(src)) continue
    // Replace each part whole, so files dropped in a newer version do not linger.
    fs.rmSync(path.join(to, part), { recursive: true, force: true })
    fs.cpSync(src, path.join(to, part), { recursive: true })
  }
  // A running server reloads when package.json's version or time changes (server.mjs).
  // Copies can keep the source's time (Windows does; npm packs all files as 1985-10-26),
  // so a same-version copy would go unnoticed: date it now, after everything else is in.
  const pkg = path.join(to, 'package.json')
  if (fs.existsSync(pkg)) { const t = new Date(); fs.utimesSync(pkg, t, t) }
  return to
}

// A hash of the files installApp copies (paths and contents), to tell two copies of one
// version apart.
export function appDigest(root) {
  const hash = crypto.createHash('sha256')
  const walk = (rel) => {
    const at = path.join(root, rel)
    let st
    try { st = fs.statSync(at) } catch { return }
    if (st.isDirectory()) { for (const n of fs.readdirSync(at).sort()) walk(path.join(rel, n)); return }
    hash.update(`${rel.split(path.sep).join('/')}\0`).update(fs.readFileSync(at)).update('\0')
  }
  for (const part of APP_PARTS) walk(part)
  return hash.digest('hex')
}

const versionOf = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version } catch { return null } }
export function compareVersions(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  // A prerelease sorts before its release.
  return (String(b).includes('-') ? 1 : 0) - (String(a).includes('-') ? 1 : 0)
}

// Without a Node.js of the user's own, the server runs on Harness's: the app binary in
// Node mode, the way Harness runs its own scripts. Its path is the app's own (it moves
// only if the app does), and if it ever breaks, the next Harness start rewrites it.
export const harnessRuntime = (exe) => ({ command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } })

// Run by the Harness plugin when it is switched on (and on every Harness start, so a
// plugin update brings the server along). `root` holds the MCP server package: the repo
// checkout the plugin was added from, or the dsh-baton-mcp package installed with it.
//   - The server is copied to ~/.dsh-baton/app, unless root is a git checkout (registered
//     as is, like `setup` from a clone) or that copy is already as new.
//   - An entry that already starts this server, or a working one that starts another copy
//     (a clone, say), is left alone; a missing or broken one is (re)written.
//   - It starts the server with the user's Node.js when there is a new enough one, else
//     with `fallback` (Harness's own runtime, see harnessRuntime).
// Never throws: the result says what happened to each client.
export function autoRegister({ root, home = os.homedir(), env = process.env, node = null, harnessDir = null, fallback = null, find = findNode, app = appDir(batonHome(env, home)) } = {}) {
  const result = { ok: false, version: versionOf(root), clients: [], error: null, node: null, runtime: null, codexHook: null }
  try {
    let serverRoot = root
    if (!fs.existsSync(path.join(root, '.git')) && path.resolve(root) !== path.resolve(app)) {
      const installed = versionOf(app)
      const older = !installed || compareVersions(installed, result.version) < 0
      // Same version, other files (a fix synced before its release): copied too.
      const changed = !older && compareVersions(installed, result.version) === 0 && appDigest(app) !== appDigest(root)
      if (older || changed || !fs.existsSync(path.join(app, 'src', 'server.mjs'))) installApp(root, app)
      serverRoot = app
    }
    const script = path.join(serverRoot, 'src', 'server.mjs')
    // Whether an entry can start a server. A bare command (`npx -y dsh-baton-mcp`, as MCP
    // directories suggest) is the user's own choice and resolved on the client's PATH: kept.
    // Harness's own binary only works in Node mode.
    const bare = (cmd) => !/[\\/]/.test(cmd)
    const works = (e) => {
      if (!e?.command) return false
      // `node /old/path/server.mjs` with that file gone is still broken.
      if (bare(e.command)) return !e.args?.[0] || bare(e.args[0]) || fs.existsSync(e.args[0])
      if (!fs.existsSync(e.command) || !e.args?.[0] || !fs.existsSync(e.args[0])) return false
      return !fallback || path.resolve(e.command) !== path.resolve(fallback.command) || e.env?.ELECTRON_RUN_AS_NODE === '1'
    }
    const list = clients(env, home)
    // Whether Codex's table already had tool_timeout_sec: one written now (below, or with a
    // fresh table) is noted as new, so conversations opened without it keep 270 s.
    const codexFile = list.find((c) => c.id === 'codex')?.file
    let hadTimeout = false
    try { hadTimeout = readCodexToolTimeout(fs.readFileSync(codexFile, 'utf8')) !== null } catch { /* no config yet */ }
    let launch = node ? { command: node } : null
    for (const c of list) {
      if (!c.present) { result.clients.push({ id: c.id, label: c.label, state: 'not-installed' }); continue }
      try {
        const text = fs.existsSync(c.file) ? fs.readFileSync(c.file, 'utf8') : ''
        const current = c.read(text)
        if (works(current)) {
          const same = !bare(current.command) && path.resolve(current.args[0]) === path.resolve(script)
          result.clients.push({ id: c.id, label: c.label, state: same ? 'unchanged' : 'kept', script: current.args[0] })
          continue
        }
        if (!launch) {
          const found = find({ env, exclude: [harnessDir] })
          launch = found ? { command: found } : fallback
        }
        if (!launch) { result.clients.push({ id: c.id, label: c.label, state: 'failed', error: 'no-node' }); continue }
        rewrite(c.file, (t) => c.edit(t, { ...launch, args: [script] }))
        result.clients.push({ id: c.id, label: c.label, state: 'registered' })
      } catch (e) {
        result.clients.push({ id: c.id, label: c.label, state: 'failed', error: e.message })
      }
    }
    const codex = list.find((c) => c.id === 'codex')
    // Entries written before tool_timeout_sec existed get it here, and the old Codex Stop
    // hook goes (see removeCodexHookBlock), in one write: Codex may still have the file open
    // from the edit before, and Windows refuses to replace it then.
    result.codexHook = 'none'
    try {
      if (codex?.present && fs.existsSync(codex.file)) {
        rewrite(codex.file, (t) => {
          const timed = addCodexToolTimeout(t)
          const out = removeCodexHookBlock(timed, codex.file)
          result.codexHook = out === timed ? 'none' : 'removed'
          return out
        })
        noteCodexToolTimeout(codex.file, env, home, !hadTimeout)
      }
    } catch (e) {
      result.codexHook = `failed (${e.code ?? e.message})`
      // Codex then keeps 270 s waits and the old hook: say so where the Plugins page looks.
      const c = result.clients.find((x) => x.id === 'codex')
      if (c && c.state !== 'not-installed') Object.assign(c, { state: 'failed', error: `could not update ${codex.file}: ${e.code ?? e.message}` })
    }
    // State the hook of 0.6.0–0.6.3 kept that nothing reads any more (pending.json stays:
    // conversations opened before still run the hook, which reads it).
    for (const f of ['registered.json', 'trust-noted.json', 'wanted', 'alive']) {
      try { fs.rmSync(path.join(batonHome(env, home), 'codex-hook', f), { force: true }) } catch { /* left */ }
    }
    result.node = launch?.command ?? null
    result.runtime = !launch ? null : launch === fallback ? 'harness' : 'node'
    const present = result.clients.filter((c) => c.state !== 'not-installed')
    result.ok = present.length > 0 && present.every((c) => c.state !== 'failed')
    if (!present.length) result.error = 'no-clients'
    else if (present.some((c) => c.error === 'no-node')) result.error = 'no-node'
  } catch (e) {
    result.error = e.message
  }
  return result
}

