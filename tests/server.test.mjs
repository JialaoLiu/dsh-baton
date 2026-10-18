// MCP protocol tests for src/server.mjs, run without Harness (host backend forced,
// socket pointed at a path that does not exist).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')

function rpc(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DSH_BRIDGE_BACKEND: 'host', DSH_BRIDGE_SOCKET: path.join(os.tmpdir(), 'dshb-missing.sock') },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))))
    for (const m of messages) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    setTimeout(() => child.stdin.end(), 1500)
  })
}

test('initialize, tools/list and an unreachable-host tool call', async () => {
  const replies = await rpc([
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'dsh_list_workspaces', arguments: {} } },
    { id: 4, method: 'nope' },
  ])
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))
  assert.equal(byId[1].result.serverInfo.name, 'dsh-bridge')
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  const names = byId[2].result.tools.map((t) => t.name)
  for (const n of ['dsh_send', 'dsh_wait', 'dsh_cancel', 'dsh_session_activity', 'dsh_rename_session', 'dsh_create_workspace']) assert.ok(names.includes(n), n)
  assert.equal(byId[3].result.isError, true)
  assert.match(byId[3].result.content[0].text, /not reachable/)
  assert.equal(byId[4].error.code, -32601)
  assert.equal(replies.length, 4) // the notification gets no reply
})

test('a null or malformed request gets an error reply and the server keeps working', async () => {
  const raw = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DSH_BRIDGE_BACKEND: 'host', DSH_BRIDGE_SOCKET: path.join(os.tmpdir(), 'dshb-missing.sock') } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, lines: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }))
    child.stdin.write('null\n[]\n42\n{"jsonrpc":"2.0","id":7}\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n')
    setTimeout(() => child.stdin.end(), 800)
  })
  assert.equal(raw.code, 0)
  assert.equal(raw.lines.filter((l) => l.error?.code === -32600).length, 4)
  assert.deepEqual(raw.lines.find((l) => l.id === 8).result, {})
})
