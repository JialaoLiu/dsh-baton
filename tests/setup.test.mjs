// `dsh-baton setup`: config editing on strings, and the npx install copy in a temp folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editClaudeConfig, editCodexConfig } from '../src/setup.mjs'
import { readCodexToolTimeout, addCodexToolTimeout } from '../src/register.mjs'

const entry = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\dev\\dsh-baton\\src\\server.mjs'] }

test('Codex: replaces earlier dsh-baton tables, keeps everything else', () => {
  const before = `model = "gpt-6-luna"

[mcp_servers.dsh-baton]
command = "/old/node"
args = ["/old/server.mjs"]
tool_timeout_sec = 1800

[mcp_servers.dsh-baton.env]
DSH_BATON_WAIT_S = "1740"

[mcp_servers.other]
command = "x"

[desktop]
localeOverride = "zh-CN"
`
  const after = editCodexConfig(before, entry)
  assert.doesNotMatch(after, /old|DSH_BATON_WAIT_S/)
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "x"/)
  assert.match(after, /\[desktop\]\nlocaleOverride = "zh-CN"/)
  assert.match(after, /\[mcp_servers\.dsh-baton\]\ncommand = 'C:\\Program Files\\nodejs\\node\.exe'\nargs = \['C:\\dev\\dsh-baton\\src\\server\.mjs'\]\ntool_timeout_sec = 1800\n$/, 'a tool_timeout_sec the user set is kept')
  assert.match(editCodexConfig('model = "x"\n', entry), /\ntool_timeout_sec = 3600\n$/, 'else an hour')
  assert.equal(editCodexConfig(after, entry), after, 'running setup twice changes nothing')
  assert.equal(editCodexConfig(after, null).includes('dsh-baton'), false)
})

test('Codex: an empty or missing config gets just the table; quotes fall back to basic strings', () => {
  assert.equal(editCodexConfig('', { command: '/n', args: ['/s'] }), "[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\ntool_timeout_sec = 3600\n")
  assert.match(editCodexConfig('', { command: "/it's/node", args: [] }), /command = "\/it's\/node"/)
})

test('Codex tool timeout: read from our table only; added to an older table, a value already there kept', () => {
  const old = `[mcp_servers.other]\ntool_timeout_sec = 99\n\n[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\n\n[mcp_servers.dsh-baton.env]\nX = '1'\n`
  assert.equal(readCodexToolTimeout(old), null)
  const added = addCodexToolTimeout(old)
  assert.match(added, /args = \['\/s'\]\ntool_timeout_sec = 3600\n\n\[mcp_servers\.dsh-baton\.env\]/)
  assert.equal(readCodexToolTimeout(added), 3600)
  assert.equal(addCodexToolTimeout(added), added, 'adding twice changes nothing')
  const own = old.replace("args = ['/s']", "args = ['/s']\ntool_timeout_sec = 900")
  assert.equal(addCodexToolTimeout(own), own)
  assert.equal(readCodexToolTimeout(own), 900)
  assert.equal(addCodexToolTimeout('model = "x"\n'), 'model = "x"\n', 'no dsh-baton table: unchanged')
})

test('Claude Code: sets and removes the user-scope entry, keeps other keys', () => {
  const before = JSON.stringify({ numStartups: 3, mcpServers: { godot: { command: 'g' } }, projects: {} })
  const after = JSON.parse(editClaudeConfig(before, entry))
  assert.equal(after.numStartups, 3)
  assert.deepEqual(after.mcpServers.godot, { command: 'g' })
  assert.deepEqual(after.mcpServers['dsh-baton'], { type: 'stdio', command: entry.command, args: entry.args, env: {} })
  const removed = JSON.parse(editClaudeConfig(JSON.stringify(after), null))
  assert.equal(removed.mcpServers['dsh-baton'], undefined)
  assert.deepEqual(removed.mcpServers.godot, { command: 'g' })
})

test('setup registers the node on PATH when it is the running binary', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { stableNodePath } = await import('../src/setup.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-node-'))
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  try {
    fs.symlinkSync(process.execPath, path.join(dir, name))
  } catch {
    return // no symlink permission (Windows without developer mode)
  }
  assert.equal(stableNodePath({ PATH: dir }), path.join(dir, name))
  assert.equal(stableNodePath({ PATH: '' }), process.execPath)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an npx run is detected, and installApp copies the package to a stable folder, replacing old files', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { inNpxCache, installApp } = await import('../src/setup.mjs')
  assert.equal(inNpxCache('/Users/me/.npm/_npx/1a2b/node_modules/dsh-baton-mcp'), true)
  assert.equal(inNpxCache('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\dsh-baton-mcp'), true)
  assert.equal(inNpxCache('/Users/me/dsh-baton'), false)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-app-'))
  const to = path.join(dir, 'app')
  fs.mkdirSync(path.join(to, 'src'), { recursive: true })
  fs.writeFileSync(path.join(to, 'src', 'dropped.mjs'), '')
  installApp(path.resolve(import.meta.dirname, '..'), to)
  assert.ok(fs.existsSync(path.join(to, 'src', 'server.mjs')))
  assert.ok(fs.existsSync(path.join(to, 'host', 'lib', 'client.js')))
  assert.ok(!fs.existsSync(path.join(to, 'src', 'dropped.mjs')))
  // A packed source dates every file 1985-10-26; the copy's package.json is dated now,
  // so a running server sees a same-version update.
  const packed = path.join(dir, 'packed')
  fs.mkdirSync(path.join(packed, 'src'), { recursive: true })
  fs.writeFileSync(path.join(packed, 'package.json'), '{"version":"0.0.1"}')
  const old = new Date('1985-10-26T08:15:00Z')
  fs.utimesSync(path.join(packed, 'package.json'), old, old)
  const before = Date.now() - 2000
  installApp(packed, to)
  assert.ok(fs.statSync(path.join(to, 'package.json')).mtimeMs >= before)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('setup drops the registrations made under the old name, dsh-bridge', () => {
  const claude = JSON.parse(editClaudeConfig(JSON.stringify({ mcpServers: { 'dsh-bridge': { command: 'old' }, other: {} } }), entry))
  assert.deepEqual(Object.keys(claude.mcpServers).sort(), ['dsh-baton', 'other'])
  const codex = editCodexConfig(`[mcp_servers.dsh-bridge]\ncommand = "old"\n\n[mcp_servers."dsh-bridge".env]\nX = "1"\n\n[other]\nk = 1\n`, entry)
  assert.doesNotMatch(codex, /dsh-bridge/)
  assert.match(codex, /\[other\]/)
  assert.match(codex, /\[mcp_servers\.dsh-baton\]/)
})

test('a plugin link the profile no longer lists is removed, never its target or a listed one', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { cleanStalePluginLinks } = await import('../src/setup.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-prof-'))
  const target = path.join(dir, 'host')
  fs.mkdirSync(target)
  fs.mkdirSync(path.join(dir, 'node_modules'))
  const link = (name) => fs.symlinkSync(target, path.join(dir, 'node_modules', name), 'junction')
  link('dsh-baton-host'); link('dsh-bridge-host')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-bridge-host': 'link:../host' } }))
  const r = cleanStalePluginLinks(dir)
  assert.deepEqual(r.removed, [path.join(dir, 'node_modules', 'dsh-baton-host')])
  assert.ok(fs.existsSync(target))
  assert.ok(fs.lstatSync(path.join(dir, 'node_modules', 'dsh-bridge-host')).isSymbolicLink())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('setup points to the plugin by npm package name, and flags local-path or old installs', async () => {
  const { pluginSteps } = await import('../src/setup.mjs')
  const { VERSION } = await import('../src/core.mjs')
  const host = '/x/app/host'
  const say = (plugins, running, fromSource = false) => pluginSteps(plugins, running, host, fromSource).join('\n')
  assert.match(say({ current: null, old: null }, null), /Official npm registry → package: dsh-baton-host/)
  assert.doesNotMatch(say({ current: null, old: null }, null), /\/x\/app\/host/)
  assert.match(say({ current: `link:${host}`, old: null }, VERSION), /from a local folder \(\/x\/app\/host\): first .* Uninstall[\s\S]*package: dsh-baton-host/)
  assert.match(say({ current: '0.4.0', old: 'link:/old/host' }, VERSION), /old name: first .* dsh-bridge-host/)
  assert.equal(say({ current: '^0.4.0', old: null }, VERSION), `Harness plugin: running (${VERSION}).`)
  assert.match(say({ current: '0.3.1', old: null }, '0.3.1'), /out of step[\s\S]*dsh-baton-host is 0\.3\.1/)
  assert.match(say({ current: '0.4.0', old: null }, null), /not answering/)
  // A git checkout links its own host folder instead.
  assert.match(say({ current: null, old: null }, null, true), /paste .*\/x\/app\/host/)
  assert.equal(say({ current: `link:${host}`, old: null }, VERSION, true), `Harness plugin: running (${VERSION}).`)
})

test('setup leaves an app folder that already holds this version alone', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { sameVersionAt } = await import('../src/setup.mjs')
  const { VERSION } = await import('../src/core.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-same-'))
  assert.equal(sameVersionAt(dir), false)
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'server.mjs'), '')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: VERSION }))
  assert.equal(sameVersionAt(dir), true)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.0.1' }))
  assert.equal(sameVersionAt(dir), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('setup --remove takes out the MCP table and the Codex Stop hook 0.6.0-0.6.3 added, with its trust', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { codexHookBlockFor } = await import('../src/register.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-rm-'))
  const codexHome = path.join(dir, '.codex')
  fs.mkdirSync(codexHome)
  const cfg = path.join(codexHome, 'config.toml')
  const own = 'model = "x"\n'
  fs.writeFileSync(cfg, `${editCodexConfig(own, entry)}\n${codexHookBlockFor('/x/.dsh-baton/bin/codex-stop-hook')}\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: dir, DSH_HOME: path.join(dir, '.dsh'), DSH_BATON_HOME: path.join(dir, '.dsh-baton'), DSH_BATON_SOCKET: path.join(dir, 'none.sock') }
  try {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'setup', '--remove'], { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Codex Stop hook: removed from/)
    assert.equal(fs.readFileSync(cfg, 'utf8'), own)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
