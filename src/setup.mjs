// One-step setup: register the dsh-bridge MCP server for Claude Code and Codex, user-wide,
// by writing their config files directly. This needs no `claude` or `codex` on PATH
// (desktop-only installs have neither) and no hand-editing of TOML.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, config, hostAvailable } from './core.mjs'

const NAME = 'dsh-bridge'

export const claudeConfigPath = (env = process.env, home = os.homedir()) =>
  path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')
export const codexConfigPath = (env = process.env, home = os.homedir()) =>
  path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')

// ~/.claude.json: the top-level "mcpServers" map is Claude Code's user scope.
export function editClaudeConfig(text, entry) {
  const cfg = text.trim() ? JSON.parse(text) : {}
  const servers = { ...(cfg.mcpServers ?? {}) }
  if (entry) servers[NAME] = { type: 'stdio', command: entry.command, args: entry.args, env: {} }
  else delete servers[NAME]
  return JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + '\n'
}

const tomlString = (s) => (/['\n\r]/.test(s) ? JSON.stringify(s) : `'${s}'`)
// Our own table and its sub-tables ([mcp_servers.dsh-bridge], [mcp_servers.dsh-bridge.env], …).
const OWN_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:dsh-bridge|"dsh-bridge"|'dsh-bridge')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_TABLE = /^\s*\[/

// ~/.codex/config.toml: replace any earlier dsh-bridge tables with one fresh table at the
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
  if (before) fs.copyFileSync(file, `${file}.bak-dsh-bridge`)
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

// Where the Harness desktop profile links dsh-bridge-host from, if anywhere.
function installedPluginSource() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.dshHome, 'profiles', 'desktop', 'package.json'), 'utf8'))
    return pkg.dependencies?.['dsh-bridge-host'] ?? null
  } catch {
    return null
  }
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

export async function setup({ remove = false } = {}) {
  const entry = remove ? null : { command: stableNodePath(), args: [path.join(ROOT, 'src', 'server.mjs')] }
  const lines = []
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
    lines.push('', 'To remove the Harness plugin: Harness → Plugins → dsh-bridge-host → Uninstall.')
    return lines.join('\n')
  }
  lines.push('', 'MCP server registered user-wide: new conversations in Claude Code and Codex have the dsh_* tools.')

  const hostDir = path.join(ROOT, 'host')
  const source = installedPluginSource()
  const fromHere = source === `link:${hostDir}` || source === `link:${hostDir.split(path.sep).join('/')}`
  const running = await hostAvailable()
  if (running && (fromHere || !source)) {
    lines.push('', 'Harness plugin: running.')
  } else {
    const copied = copyToClipboard(hostDir)
    lines.push('', 'Last step, in DeepSeek Harness:')
    if (source && !fromHere) lines.push(`  The plugin installed now comes from another folder (${source}): first Plugins (插件) → dsh-bridge-host → Uninstall (卸载).`)
    lines.push(
      `  Plugins (插件) → Add plugin (添加插件) → paste ${copied ? 'the path (already copied)' : 'this path'}: ${hostDir}`,
      '  → Install (安装) → Enable now (立即启用)')
  }
  return lines.join('\n')
}
