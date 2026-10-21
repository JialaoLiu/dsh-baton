// Config editing for `dsh-bridge setup`, on strings only (no real config files touched).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editClaudeConfig, editCodexConfig } from '../src/setup.mjs'

const entry = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\dev\\dsh-bridge\\src\\server.mjs'] }

test('Codex: replaces earlier dsh-bridge tables, keeps everything else', () => {
  const before = `model = "gpt-6-luna"

[mcp_servers.dsh-bridge]
command = "/old/node"
args = ["/old/server.mjs"]
tool_timeout_sec = 1800

[mcp_servers.dsh-bridge.env]
DSH_BRIDGE_WAIT_S = "1740"

[mcp_servers.other]
command = "x"

[desktop]
localeOverride = "zh-CN"
`
  const after = editCodexConfig(before, entry)
  assert.doesNotMatch(after, /old|tool_timeout_sec|DSH_BRIDGE_WAIT_S/)
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "x"/)
  assert.match(after, /\[desktop\]\nlocaleOverride = "zh-CN"/)
  assert.match(after, /\[mcp_servers\.dsh-bridge\]\ncommand = 'C:\\Program Files\\nodejs\\node\.exe'\nargs = \['C:\\dev\\dsh-bridge\\src\\server\.mjs'\]\n$/)
  assert.equal(editCodexConfig(after, entry), after, 'running setup twice changes nothing')
  assert.equal(editCodexConfig(after, null).includes('dsh-bridge'), false)
})

test('Codex: an empty or missing config gets just the table; quotes fall back to basic strings', () => {
  assert.equal(editCodexConfig('', { command: '/n', args: ['/s'] }), "[mcp_servers.dsh-bridge]\ncommand = '/n'\nargs = ['/s']\n")
  assert.match(editCodexConfig('', { command: "/it's/node", args: [] }), /command = "\/it's\/node"/)
})

test('Claude Code: sets and removes the user-scope entry, keeps other keys', () => {
  const before = JSON.stringify({ numStartups: 3, mcpServers: { godot: { command: 'g' } }, projects: {} })
  const after = JSON.parse(editClaudeConfig(before, entry))
  assert.equal(after.numStartups, 3)
  assert.deepEqual(after.mcpServers.godot, { command: 'g' })
  assert.deepEqual(after.mcpServers['dsh-bridge'], { type: 'stdio', command: entry.command, args: entry.args, env: {} })
  const removed = JSON.parse(editClaudeConfig(JSON.stringify(after), null))
  assert.equal(removed.mcpServers['dsh-bridge'], undefined)
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
