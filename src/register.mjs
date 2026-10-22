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
  return e?.command ? { command: e.command, args: e.args ?? [] } : null
}

const tomlString = (s) => (/['\n\r]/.test(s) ? JSON.stringify(s) : `'${s}'`)
// Our own table and its sub-tables ([mcp_servers.dsh-baton], [mcp_servers.dsh-baton.env], …),
// under the current name or the one before the rename.
const OWN_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(["']?)dsh-(?:baton|bridge)\1\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_TABLE = /^\s*\[/

// ~/.codex/config.toml: replace any earlier dsh-baton tables with one fresh table at the
// end. Codex stops a tool call after 300 s; the server keeps each wait under that, so no
// tool_timeout_sec is needed.
export function editCodexConfig(text, entry) {
  const kept = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (OWN_TABLE.test(line)) skipping = true
    else if (ANY_TABLE.test(line)) skipping = false
    if (!skipping) kept.push(line)
  }
  let out = kept.join('\n').replace(/\s+$/, '')
  if (entry) {
    out += `${out ? '\n\n' : ''}[mcp_servers.${NAME}]\ncommand = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(', ')}]`
    const env = Object.entries(entry.env ?? {})
    if (env.length) out += `\n\n[mcp_servers.${NAME}.env]\n${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join('\n')}`
  }
  return out ? out + '\n' : ''
}

// The command and args of [mcp_servers.dsh-baton], as setup writes them (single-line strings).
export function readCodexEntry(text) {
  const str = String.raw`'[^'\n]*'|"(?:[^"\\\n]|\\.)*"`
  const unquote = (s) => (s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s))
  let inTable = false
  let command = null, args = []
  for (const line of text.split(/\r?\n/)) {
    if (ANY_TABLE.test(line)) inTable = /^\s*\[\s*mcp_servers\s*\.\s*(["']?)dsh-baton\1\s*\]/.test(line)
    else if (inTable) {
      const c = line.match(new RegExp(`^\\s*command\\s*=\\s*(${str})`))
      if (c) command = unquote(c[1])
      const a = line.match(/^\s*args\s*=\s*\[(.*)\]/)
      if (a) args = [...a[1].matchAll(new RegExp(str, 'g'))].map((m) => unquote(m[0]))
    }
  }
  return command ? { command, args } : null
}

// Write only when the content changes, keep one backup, and replace the file atomically.
export function rewrite(file, edit) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const after = edit(before)
  if (after === before) return 'unchanged'
  if (before) fs.copyFileSync(file, `${file}.bak-dsh-baton`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, after, { mode: before ? fs.statSync(file).mode : 0o600 })
  fs.renameSync(tmp, file)
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

// A Node.js for the MCP server when the caller is not one itself: the Harness plugin runs
// on the app's own binary, whose path changes with every Harness update. So: the first
// `node` on PATH, then the usual install folders, never one inside the Harness app, and
// only a new enough one.
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
  return to
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
  const result = { ok: false, version: versionOf(root), clients: [], error: null, node: null, runtime: null }
  try {
    let serverRoot = root
    if (!fs.existsSync(path.join(root, '.git')) && path.resolve(root) !== path.resolve(app)) {
      const installed = versionOf(app)
      if (!installed || !fs.existsSync(path.join(app, 'src', 'server.mjs')) || compareVersions(installed, result.version) < 0) installApp(root, app)
      serverRoot = app
    }
    const script = path.join(serverRoot, 'src', 'server.mjs')
    const works = (e) => e && fs.existsSync(e.command) && e.args?.[0] && fs.existsSync(e.args[0])
    const list = clients(env, home)
    let launch = node ? { command: node } : null
    for (const c of list) {
      if (!c.present) { result.clients.push({ id: c.id, label: c.label, state: 'not-installed' }); continue }
      try {
        const text = fs.existsSync(c.file) ? fs.readFileSync(c.file, 'utf8') : ''
        const current = c.read(text)
        if (works(current)) {
          const same = path.resolve(current.args[0]) === path.resolve(script)
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
