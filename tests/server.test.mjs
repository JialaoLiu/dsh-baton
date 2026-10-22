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
      env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(os.tmpdir(), 'dshb-missing.sock') },
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
  assert.equal(byId[1].result.serverInfo.name, 'dsh-baton')
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
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(os.tmpdir(), 'dshb-missing.sock') } })
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

test('dsh_wait waits in short chunks, reports progress, and returns before the client times out', async () => {
  const net = await import('node:net')
  const fs = await import('node:fs')
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-w-'))
  const sock = path.join(dir, 'h.sock')
  const waits = []
  // Fake host: every wait chunk times out (the run never finishes).
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    waits.push(req.params?.timeout_s)
    setTimeout(() => c.end(JSON.stringify({ id: req.id, result: { run_id: req.params.run_id, state: 'running', timed_out: true } }) + '\n'), 50)
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock, DSH_BATON_WAIT_S: '2' } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const t0 = Date.now()
  // timeout_s from the model is ignored: the server's wait length (2 s here) applies.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_wait', arguments: { run_id: 'hrun-x', timeout_s: 600 }, _meta: { progressToken: 'p1' } } }) + '\n')
  const reply = await new Promise((resolve) => {
    const tick = setInterval(() => {
      const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const r = msgs.find((m) => m.id === 1)
      if (r) { clearInterval(tick); resolve({ r, msgs }) }
    }, 50)
  })
  child.stdin.end(); server.close(); fs.rmSync(dir, { recursive: true, force: true })
  const result = JSON.parse(reply.r.result.content[0].text)
  assert.equal(result.timed_out, true)
  assert.match(result.hint, /Call dsh_wait again/)
  assert.equal(result.recent_events, undefined, 'an unfinished wait carries no event log')
  assert.ok(Date.now() - t0 < 6000, 'returned near its 2 s budget')
  assert.ok(waits.every((s) => s >= 1 && s <= 10), `chunks: ${waits}`)
  const progress = reply.msgs.filter((m) => m.method === 'notifications/progress')
  assert.ok(progress.length >= 1, 'sent progress notifications')
  assert.equal(progress[0].params.progressToken, 'p1')
})

async function sendAs(clientName) {
  const net = await import('node:net')
  const fs = await import('node:fs')
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-s-'))
  const sock = path.join(dir, 'h.sock')
  const sends = []
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    if (req.method === 'send') sends.push(req.params)
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-1', state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const { DSH_BATON_SENDER, ...env } = process.env
  const child = spawn(process.execPath, [SERVER], { env: { ...env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  for (const m of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' } } },
    { id: 2, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' } } },
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes('"id":2')) { clearInterval(tick); resolve() } }, 50) })
  child.stdin.end(); server.close(); fs.rmSync(dir, { recursive: true, force: true })
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { host: sends[0], instructions: lines.find((m) => m.id === 1).result.instructions, sent: JSON.parse(lines.find((m) => m.id === 2).result.content[0].text) }
}

test('dsh_send tells the host who is sending, from the client name in initialize', async () => {
  const { host } = await sendAs('codex-mcp-client')
  assert.equal(host.sender, 'codex')
  assert.equal(host.message, 'hi')
})

test('Claude Code gets a background wait_command; Codex, which cannot be woken by one, gets dsh_wait only', async () => {
  const claude = await sendAs('claude-code')
  assert.match(claude.sent.wait_command, /cli\.mjs" wait hrun-1$/)
  assert.match(claude.sent.hint, /background/)
  assert.match(claude.instructions, /wait_command/)
  const codex = await sendAs('codex-mcp-client')
  assert.equal(codex.sent.wait_command, undefined)
  assert.match(codex.sent.hint, /Call dsh_wait/)
  assert.match(codex.sent.hint, /dsh_session_activity/)
  assert.match(codex.sent.hint, /must start with the line \/\/ @exec: \{"yield_time_ms": 290000\}/)
  assert.match(codex.sent.hint, /do not list or read the target folder/)
  assert.match(codex.instructions, /archived/)
  assert.doesNotMatch(codex.instructions, /wait_command/)
})

test('dsh_wait length is chosen per client, and DSH_BATON_WAIT_S overrides it', async () => {
  const { DSH_BATON_WAIT_S, ...base } = process.env
  const run = (env, clientName) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...base, ...env } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.find((t) => t.name === 'dsh_wait').description))
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n')
  })
  const codex = await run({}, 'codex-mcp-client')
  assert.match(codex, /up to 270 s/)
  assert.doesNotMatch(codex, /wait_command/)
  assert.match(codex, /"yield_time_ms": 290000/)
  const claude = await run({}, 'claude-code')
  assert.match(claude, /up to 50 s/)
  assert.match(claude, /wait_command/)
  assert.doesNotMatch(claude, /yield_time_ms/)
  assert.match(await run({ DSH_BATON_WAIT_S: '1740' }, 'codex-mcp-client'), /up to 1740 s/)
  assert.match(await run({ DSH_BATON_WAIT_S: 'nope' }, 'codex-mcp-client'), /up to 270 s/)
})
