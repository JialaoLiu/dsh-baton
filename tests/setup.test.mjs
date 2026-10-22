// `dsh-baton setup`: config editing on strings, and the npx install copy in a temp folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editClaudeConfig, editCodexConfig } from '../src/setup.mjs'

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
  assert.doesNotMatch(after, /old|tool_timeout_sec|DSH_BATON_WAIT_S/)
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "x"/)
  assert.match(after, /\[desktop\]\nlocaleOverride = "zh-CN"/)
  assert.match(after, /\[mcp_servers\.dsh-baton\]\ncommand = 'C:\\Program Files\\nodejs\\node\.exe'\nargs = \['C:\\dev\\dsh-baton\\src\\server\.mjs'\]\n$/)
  assert.equal(editCodexConfig(after, entry), after, 'running setup twice changes nothing')
  assert.equal(editCodexConfig(after, null).includes('dsh-baton'), false)
})

test('Codex: an empty or missing config gets just the table; quotes fall back to basic strings', () => {
  assert.equal(editCodexConfig('', { command: '/n', args: ['/s'] }), "[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\n")
  assert.match(editCodexConfig('', { command: "/it's/node", args: [] }), /command = "\/it's\/node"/)
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
