// One-step setup: register the dsh-baton MCP server for Claude Code and Codex, user-wide,
// by writing their config files directly. This needs no `claude` or `codex` on PATH
// (desktop-only installs have neither) and no hand-editing of TOML.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, config, hostAvailable } from './core.mjs'

const NAME = 'dsh-baton'
// The name before the rename: setup removes its entries so the tools are not listed twice.
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
  if (entry) servers[NAME] = { type: 'stdio', command: entry.command, args: entry.args, env: {} }
  else delete servers[NAME]
  return JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + '\n'
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
  }
  return out ? out + '\n' : ''
}

// Write only when the content changes, keep one backup, and replace the file atomically.
function rewrite(file, edit) {
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

function copyToClipboard(text) {
  try {
    if (process.platform === 'darwin') execFileSync('pbcopy', { input: text })
    else if (process.platform === 'win32') execFileSync('clip', { input: text })
    else return false
    return true
  } catch {
    return false
  }
}

// Where the Harness desktop profile links the plugin from, under its current name and
// under the name before the rename (dsh-bridge-host), if anywhere.
function installedPlugins() {
  try {
    const deps = JSON.parse(fs.readFileSync(path.join(config.dshHome, 'profiles', 'desktop', 'package.json'), 'utf8')).dependencies ?? {}
    return { current: deps['dsh-baton-host'] ?? null, old: deps['dsh-bridge-host'] ?? null }
  } catch {
    return { current: null, old: null }
  }
}

// With pnpm's hoisted layout, uninstalling the plugin can leave its node_modules link
// behind. Remove such a link once the profile no longer lists the plugin; only the
// link itself goes, never the folder it points to. Returns the links removed and the
// ones that could not be.
export function cleanStalePluginLinks(profile = path.join(config.dshHome, 'profiles', 'desktop')) {
  let deps
  try { deps = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8')).dependencies ?? {} } catch { return { removed: [], failed: [] } }
  const removed = [], failed = []
  for (const name of ['dsh-baton-host', 'dsh-bridge-host']) {
    const link = path.join(profile, 'node_modules', name)
    if (deps[name]) continue
    let st
    try { st = fs.lstatSync(link) } catch { continue }
    if (!st.isSymbolicLink()) continue
    try {
      // A Windows junction is a directory link: rmdir removes the link, not its target.
      try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) }
      removed.push(link)
    } catch {
      failed.push(link)
    }
  }
  return { removed, failed }
}

const pluginFrom = (source, hostDir) => source === `link:${hostDir}` || source === `link:${hostDir.split(path.sep).join('/')}`

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

// Run through npx, the package sits in npm's cache, which npm may clear or replace at any
// time. setup then copies it to a stable folder and registers that copy instead.
export const appDir = () => path.join(config.batonHome, 'app')
export const inNpxCache = (root = ROOT) => root.split(/[\\/]/).includes('_npx')
const APP_PARTS = ['src', 'host', 'patches', 'package.json', 'LICENSE']

export function installApp(from = ROOT, to = appDir()) {
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

export async function setup({ remove = false } = {}) {
  const root = !remove && inNpxCache() ? installApp() : ROOT
  const entry = remove ? null : { command: stableNodePath(), args: [path.join(root, 'src', 'server.mjs')] }
  const lines = []
  if (root !== ROOT) lines.push(`Installed dsh-baton to ${root}`)
  const register = (label, file, present, edit) => {
    if (!remove && !present) return lines.push(`- ${label}: not installed, skipped`)
    try {
      const result = rewrite(file, (t) => edit(t, entry))
      lines.push(`- ${label}: ${remove ? 'removed from' : 'registered in'} ${file}${result === 'unchanged' ? ' (already up to date)' : ''}`)
    } catch (e) {
      lines.push(`- ${label}: FAILED to edit ${file}: ${e.message}`)
      process.exitCode = 1
    }
  }
  const claudeFile = claudeConfigPath()
  register('Claude Code', claudeFile, fs.existsSync(claudeFile) || fs.existsSync(path.join(os.homedir(), '.claude')), editClaudeConfig)
  const codexFile = codexConfigPath()
  register('Codex', codexFile, fs.existsSync(path.dirname(codexFile)), editCodexConfig)

  if (remove) {
    const plugins = installedPlugins()
    if (plugins.current || plugins.old) {
      lines.push('', `To remove the Harness plugin: Harness → Plugins → ${plugins.current ? 'dsh-baton-host' : 'dsh-bridge-host'} → Uninstall.`)
    } else {
      lines.push('', 'Harness plugin: not installed.')
      const links = cleanStalePluginLinks()
      for (const l of links.removed) lines.push(`Removed the leftover plugin link ${l}.`)
      for (const l of links.failed) lines.push(`Could not remove the leftover plugin link ${l}: quit Harness and delete it.`)
    }
    const app = appDir()
    if (fs.existsSync(app)) {
      // Harness loads the plugin from this folder: delete it only once the plugin is gone.
      if (pluginFrom(plugins.current, path.join(app, 'host'))) lines.push(`Then run this again to delete ${app}.`)
      else { fs.rmSync(app, { recursive: true, force: true }); lines.push(`Deleted ${app}.`) }
    }
    const home = config.batonHome
    if (['runs', 'host-runs'].some((d) => fs.existsSync(path.join(home, d)))) {
      lines.push(`Run records are kept in ${home} (runs, host-runs); delete that folder to remove them too.`)
    }
    return lines.join('\n')
  }
  lines.push('', 'MCP server registered user-wide: new conversations in Claude Code and Codex have the dsh_* tools.')

  const hostDir = path.join(root, 'host')
  const { current: source, old } = installedPlugins()
  const fromHere = pluginFrom(source, hostDir)
  const running = await hostAvailable()
  if (running && !old && (fromHere || !source)) {
    lines.push('', 'Harness plugin: running.')
  } else {
    const copied = copyToClipboard(hostDir)
    lines.push('', 'Last step, in DeepSeek Harness:')
    // The plugin was renamed: Harness cannot load the old entry once its folder holds the new name.
    if (old) lines.push('  The plugin is installed under its old name: first Plugins (插件) → dsh-bridge-host → Uninstall (卸载).')
    if (source && !fromHere) lines.push(`  The plugin installed now comes from another folder (${source}): first Plugins (插件) → dsh-baton-host → Uninstall (卸载).`)
    lines.push(
      `  Plugins (插件) → Add plugin (添加插件) → paste ${copied ? 'the path (already copied)' : 'this path'}: ${hostDir}`,
      '  → Install (安装) → Enable now (立即启用)')
  }
  return lines.join('\n')
}
