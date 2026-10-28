// What dsh-baton puts in a client's context: one short instructions sentence (Codex repeats
// it in front of every tool's description) and the rules in the tools' own descriptions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexCatalog } from '../docs/benchmarks/token-usage-2026-10/codex-catalog.mjs'

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.mjs')

function listTools(clientName, env = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-cat-'))
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, CODEX_HOME: path.join(dir, 'codex'), DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(dir, 'none.sock'), ...env } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => {
      fs.rmSync(dir, { recursive: true, force: true })
      const [init, list] = out.trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id)
      resolve({ instructions: init.result.instructions, tools: Object.fromEntries(list.result.tools.map((t) => [t.name, t])) })
    })
    child.stdin.end([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName } } },
      { id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n')
  })
}

test('instructions are one short sentence; the catalogue Codex builds stays under half of 0.6.1\'s 24,283 characters', async () => {
  const { instructions } = await listTools('codex-mcp-client')
  assert.ok(instructions.length <= 120, `instructions: ${instructions.length} chars`)
  assert.match(instructions, /dsh_send/)
  const size = await codexCatalog(MCP)
  assert.ok(size.total < 24283 / 2, `Codex catalogue: ${size.total} chars`)
})

test('the rules that left the instructions are in the tools that need them', async () => {
  for (const client of ['codex-mcp-client', 'claude-code']) {
    const { tools } = await listTools(client)
    const send = tools.dsh_send.description
    assert.match(send, /directly, no need to list anything first/)
    assert.match(send, /folder this conversation works in/)
    assert.match(send, /session_id continues that session/)
    assert.match(send, /full, explicit spec, asking for tests that cover each requirement/)
    assert.match(send, /hint saying how to wait/)
    assert.match(tools.dsh_send.inputSchema.properties.checks.description, /project's own test commands.*never check scripts you write yourself/)
    const answer = tools.dsh_answer.description
    assert.match(answer, /If the user told you to decide such questions yourself/)
    assert.match(answer, /My recommendation: <option>, because <reason>/)
    assert.match(answer, /Never answer on the user's behalf without that permission/)
    assert.match(tools.dsh_list_sessions.description, /archived or gone: do not look for them on disk/)
    assert.match(tools.dsh_call.description, /does not list \(dsh-baton was updated without a restart/)
    assert.match(tools.dsh_wait.description, /needs_input answer/)
  }
})
