// `dsh-baton setup`: register the dsh-baton MCP server for Claude Code and Codex, user-wide
// (see register.mjs, which the Harness plugin also uses), and say what is left to do in Harness.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, VERSION, config, hostAvailable, hostVersionSeen as versionOfHost, versionWarning } from './core.mjs'
import { appDir, installApp, rewrite, stableNodePath, claudeConfigPath, codexConfigPath, editClaudeConfig, editCodexConfig } from './register.mjs'
import { editCodexHook, hookCommand } from './codex-hook.mjs'

export { appDir, installApp, stableNodePath, claudeConfigPath, codexConfigPath, editClaudeConfig, editCodexConfig }

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

// What setup says about the Harness plugin. The plugin is installed in Harness by its npm
// package name; a checkout of this repo (setup run from a git clone) is the exception and
// links its own host folder, so plugin changes can be tried before they are published.
export function pluginSteps({ current, old }, running, hostDir, fromSource = fs.existsSync(path.join(ROOT, '.git'))) {
  const isLink = (spec) => /^(link|file):/.test(spec ?? '')
  const ok = fromSource ? pluginFrom(current, hostDir) : current && !isLink(current)
  if (ok && !old && running) {
    const warning = versionWarning(running)
    return warning ? ['Harness plugin: running, but out of step.', `  ${warning}`] : [`Harness plugin: running (${running}).`]
  }
  const steps = ['Last step, in DeepSeek Harness:']
  // The plugin was renamed: Harness cannot load the old entry once its folder holds the new name.
  if (old) steps.push('  The plugin is installed under its old name: first Plugins (插件) → dsh-bridge-host → Uninstall (卸载).')
  if (current && !ok) {
    steps.push(isLink(current)
      ? `  The plugin installed now comes from a local folder (${current.replace(/^(link|file):/, '')}): first Plugins (插件) → dsh-baton-host → Uninstall (卸载).`
      : '  The plugin installed now comes from npm, not this checkout: first Plugins (插件) → dsh-baton-host → Uninstall (卸载).')
  }
  if (ok && !old) return ['Harness plugin: installed but not answering. Open Harness and check that dsh-baton-host is switched on in Plugins (插件).']
  if (fromSource) {
    const copied = copyToClipboard(hostDir)
    steps.push(`  Plugins (插件) → Add plugin (添加插件) → paste ${copied ? 'the path (already copied)' : 'this path'}: ${hostDir}`)
  } else {
    const copied = copyToClipboard(PLUGIN)
    steps.push(`  Plugins (插件) → Add plugin (添加插件) → registry: Official npm registry → package: ${PLUGIN}${copied ? ' (already copied)' : ''}`)
  }
  steps.push('  → Install (安装) → Enable now (立即启用)')
  return steps
}

const PLUGIN = 'dsh-baton-host'

const pluginFrom = (source, hostDir) => source === `link:${hostDir}` || source === `link:${hostDir.split(path.sep).join('/')}`

// Run through npx, the package sits in npm's cache, which npm may clear or replace at any
// time. setup then copies it to a stable folder and registers that copy instead.
export const inNpxCache = (root = ROOT) => root.split(/[\\/]/).includes('_npx')

export function sameVersionAt(dir, version = VERSION) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === version && fs.existsSync(path.join(dir, 'src', 'server.mjs'))
  } catch {
    return false
  }
}

export async function setup({ remove = false, codexHook = false } = {}) {
  // The same version is already in place (the Harness plugin copied it, say): leave it.
  const copy = !remove && inNpxCache() && !sameVersionAt(appDir())
  const root = !remove && inNpxCache() ? (copy ? installApp(ROOT) : appDir()) : ROOT
  const entry = remove ? null : { command: stableNodePath(), args: [path.join(root, 'src', 'server.mjs')] }
  const lines = []
  if (root !== ROOT) lines.push(copy ? `Installed dsh-baton to ${root}` : `dsh-baton ${VERSION} is already in ${root}`)
  const register = (label, file, present, edit) => {
    if (!remove && !present) return lines.push(`- ${label}: not installed, skipped`)
    try {
      const result = rewrite(file, (t) => edit(t, entry))
      const what = remove
        ? (result === 'unchanged' ? 'not registered in' : 'removed from')
        : 'registered in'
      lines.push(`- ${label}: ${what} ${file}${!remove && result === 'unchanged' ? ' (already up to date)' : ''}`)
    } catch (e) {
      lines.push(`- ${label}: FAILED to edit ${file}: ${e.message}`)
      process.exitCode = 1
    }
  }
  const claudeFile = claudeConfigPath()
  register('Claude Code', claudeFile, fs.existsSync(claudeFile) || fs.existsSync(path.join(os.homedir(), '.claude')), editClaudeConfig)
  const codexFile = codexConfigPath()
  register('Codex', codexFile, fs.existsSync(path.dirname(codexFile)), editCodexConfig)
  // The Codex Stop hook (opt-in): wakes Codex when a run ends instead of dsh_wait every few
  // minutes. Codex runs a new or changed hook only after the user trusts it in its hooks screen.
  if ((codexHook || remove) && fs.existsSync(path.dirname(codexFile))) {
    try {
      const result = rewrite(codexFile, (t) => editCodexHook(t, remove ? null : hookCommand(root)))
      if (remove) { if (result !== 'unchanged') lines.push(`- Codex Stop hook: removed from ${codexFile}`) }
      else lines.push(`- Codex Stop hook: ${result === 'unchanged' ? 'already in' : 'added to'} ${codexFile}. Trust it once in Codex (Settings → Hooks), or it does not run.`)
    } catch (e) {
      lines.push(`- Codex Stop hook: FAILED to edit ${codexFile}: ${e.message}`)
      process.exitCode = 1
    }
  }

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

  lines.push('', ...pluginSteps(installedPlugins(), await hostAvailable() ? versionOfHost() : null, path.join(root, 'host')))
  return lines.join('\n')
}
