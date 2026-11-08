// dsh_wait with run_ids: several runs sent in parallel are waited for together, and the call
// returns as soon as any of them ends or stops to ask, with every one that has and the rest.
// Before 0.6.8 Codex waited on one run at a time, and a run that ended meanwhile sat unseen
// (measured 2026-11-08: a backend result read 3 minutes late, its rework sent late).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { socketEndpoint } from '../host/lib/socket.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')

// A fake host whose runs end at given times (ms after start; Infinity: never). A run with
// `ask` stops to ask a person at that time, and its question is reported once, like the host's.
async function fakeHost(runs) {
  // Times count from the first request, so a slow server start does not shift them.
  let t0
  const asked = new Set()
  const calls = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-any-'))
  const sock = path.join(dir, 'h.sock')
  const conns = new Set()
  const server = net.createServer((c) => { conns.add(c); c.on('close', () => conns.delete(c)); c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    calls.push(req)
    t0 ??= Date.now()
    const reply = (msg) => c.end(JSON.stringify({ id: req.id, ...msg }) + '\n')
    const run = runs[req.params?.run_id]
    if (!run) return reply({ error: `Unknown run: ${req.params?.run_id} (only the latest 100 runs are kept)` })
    const at = run.ask ?? run.end
    const left = at - (Date.now() - t0)
    const timeout = (req.params.timeout_s ?? 1) * 1000
    setTimeout(() => {
      const base = { run_id: req.params.run_id, session_id: `s-${req.params.run_id}`, backend: 'host' }
      if (Date.now() - t0 < at) return reply({ result: { ...base, state: 'running', timed_out: true } })
      if (run.ask !== undefined) {
        if (asked.has(req.params.run_id)) return reply({ result: { ...base, state: 'waiting', timed_out: true } })
        asked.add(req.params.run_id)
        return reply({ result: { ...base, state: 'waiting', needs_input: 'harness-ui' } })
      }
      reply({ result: { ...base, state: 'completed', final_text: `done ${req.params.run_id}` } })
    }, Math.max(0, Math.min(left, timeout)))
  }) })
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  return { sock, calls, firstRequestAt: () => t0, close: () => { for (const c of conns) c.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

// Polls until cond holds; gives up after ms, so a reply that never comes fails the test
// instead of keeping the test process alive.
async function until(cond, what, ms = 30000) {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// These tests measure timing in the hundreds of milliseconds. A busy CI runner can stall a
// process for that long, so a timing test gets up to three tries; each try builds its own host.
async function tries(body, n = 3) {
  for (let i = 1; ; i++) {
    try { return await body() } catch (e) { if (i >= n) throw e }
  }
}

async function call(host, args, env = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: path.dirname(host.sock), DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: host.sock, ...env } })
  try {
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_wait', arguments: args } }) + '\n')
    await until(() => out.includes('"id":1'), 'the dsh_wait reply')
    // Counted from the wait's first question to the host: a cold runner can take seconds to start the server.
    const ms = Date.now() - host.firstRequestAt()
    const msg = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 1)
    return { ms, result: JSON.parse(msg.result.content[0].text) }
  } finally {
    child.kill()
  }
}

test('the run that ends first comes back first, with the ones still going', () => tries(async () => {
  const host = await fakeHost({ 'hrun-api': { end: 300 }, 'hrun-fe': { end: 4000 }, 'hrun-be': { end: Infinity } })
  // Listed slowest first: the order of run_ids does not decide which comes back.
  const { ms, result } = await call(host, { run_ids: ['hrun-be', 'hrun-fe', 'hrun-api'] }).finally(host.close)
  assert.ok(ms < 3000, `returned soon after api ended (${ms} ms)`)
  assert.deepEqual(result.ended.map((r) => r.run_id), ['hrun-api'])
  assert.equal(result.ended[0].final_text, 'done hrun-api')
  assert.match(result.ended[0].hint, /evidence is produced by dsh-baton/, 'each ended run keeps its own hint')
  assert.deepEqual(result.still_running.map((r) => r.run_id).sort(), ['hrun-be', 'hrun-fe'])
  assert.match(result.hint, /dsh_wait again with run_ids: the ones still running \(hrun-be, hrun-fe\) plus the run_id of every fix you sent/)
  assert.match(result.hint, /send any fixes with dsh_send to the same session_id right away/)
}))

test('runs that end together come back in one result', () => tries(async () => {
  const host = await fakeHost({ 'hrun-a': { end: 200 }, 'hrun-b': { end: 220 }, 'hrun-c': { end: Infinity } })
  const { result } = await call(host, { run_ids: ['hrun-a', 'hrun-b', 'hrun-c'] }).finally(host.close)
  assert.deepEqual(result.ended.map((r) => r.run_id).sort(), ['hrun-a', 'hrun-b'])
  assert.deepEqual(result.still_running.map((r) => r.run_id), ['hrun-c'])
}))

test('a run that stops to ask a person returns at once, and its question is not lost', async () => {
  const host = await fakeHost({ 'hrun-fe': { ask: 300 }, 'hrun-be': { end: Infinity } })
  const { result } = await call(host, { run_ids: ['hrun-fe', 'hrun-be'] }).finally(host.close)
  assert.equal(result.ended.length, 1)
  assert.equal(result.ended[0].needs_input, 'harness-ui')
  assert.match(result.ended[0].hint, /only a person can do in the Harness UI/)
  assert.deepEqual(result.still_running.map((r) => r.run_id), ['hrun-be'])
})

test('when none ends in time it says so and asks for the same run_ids again', async () => {
  const host = await fakeHost({ 'hrun-a': { end: Infinity }, 'hrun-b': { end: Infinity } })
  const { ms, result } = await call(host, { run_ids: ['hrun-a', 'hrun-b'] }, { DSH_BATON_WAIT_S: '2' }).finally(host.close)
  assert.ok(ms < 6000, `kept to its 2 s budget (${ms} ms)`)
  assert.equal(result.timed_out, true)
  assert.deepEqual(result.still_running.map((r) => r.run_id), ['hrun-a', 'hrun-b'])
  assert.match(result.hint, /Call dsh_wait again with the same run_ids/)
})

test('an unknown run id comes back as such instead of failing the whole wait', async () => {
  const host = await fakeHost({ 'hrun-a': { end: Infinity } })
  const { result } = await call(host, { run_ids: ['hrun-a', 'hrun-gone'] }).finally(host.close)
  assert.equal(result.ended[0].run_id, 'hrun-gone')
  assert.equal(result.ended[0].state, 'unknown')
  assert.match(result.ended[0].hint, /leave it out of the next dsh_wait/)
  assert.deepEqual(result.still_running.map((r) => r.run_id), ['hrun-a'])
})

test('run_ids with one id, or the same id twice, is the ordinary one-run wait', async () => {
  const host = await fakeHost({ 'hrun-a': { end: 100 } })
  const one = await call(host, { run_ids: ['hrun-a'] })
  const twice = await call(host, { run_id: 'hrun-a', run_ids: ['hrun-a'] }).finally(host.close)
  for (const { result } of [one, twice]) {
    assert.equal(result.ended, undefined)
    assert.equal(result.run_id, 'hrun-a')
    assert.equal(result.final_text, 'done hrun-a')
  }
})

test('Codex is told to wait for parallel runs together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-any-s-'))
  const sock = path.join(dir, 'h.sock')
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-1', state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: dir, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  try {
    for (const m of [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } },
      { id: 2, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' } } },
      { id: 3, method: 'tools/list' },
    ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    // tools/list can answer before dsh_send, which waits on the host: wait for both replies.
    await until(() => out.includes('"id":2') && out.includes('"id":3'), 'the dsh_send and tools/list replies')
  } finally {
    child.kill(); server.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const sent = JSON.parse(lines.find((m) => m.id === 2).result.content[0].text)
  assert.match(sent.hint, /one dsh_wait with run_ids set to all their run_ids, never one run after another/)
  const tools = lines.find((m) => m.id === 3).result.tools
  const wait = tools.find((t) => t.name === 'dsh_wait')
  assert.equal(wait.inputSchema.properties.run_ids.type, 'array')
  assert.match(wait.description, /all ids in run_ids, never one by one/)
  assert.match(tools.find((t) => t.name === 'dsh_send').description, /wait for them together \(dsh_wait run_ids\), review each as it returns and send its fixes at once/)
})

test('a question that comes after the wait returned is kept for the next wait', () => tries(async () => {
  // hrun-a ends first; hrun-b asks later, while the chunk's wait for it is still out (chunks are 5 s).
  const host = await fakeHost({ 'hrun-a': { end: 300 }, 'hrun-b': { ask: 3000 } })
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: path.dirname(host.sock), DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: host.sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const ask = async (id, args) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'dsh_wait', arguments: args } }) + '\n')
    await until(() => out.includes(`"id":${id}`), `dsh_wait reply ${id}`)
    return JSON.parse(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id).result.content[0].text)
  }
  try {
    const first = await ask(1, { run_ids: ['hrun-a', 'hrun-b'] })
    assert.deepEqual(first.ended.map((r) => r.run_id), ['hrun-a'])
    // Past hrun-b's question, so the first wait's still-open request is the one that sees it.
    await until(() => Date.now() - host.firstRequestAt() > 3500, 'hrun-b to ask')
    const second = await ask(2, { run_ids: ['hrun-b'] })
    assert.equal(second.run_id, 'hrun-b')
    assert.equal(second.needs_input, 'harness-ui', 'the question the host reported once is not lost')
  } finally {
    child.kill(); host.close()
  }
}))
