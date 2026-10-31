// One dsh_wait for Codex lasts as long as Codex's tool_timeout_sec for dsh-baton allows
// (less a margin), and a call the client cancels stops waiting and gets no reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')
const MCP = path.join(path.dirname(SERVER), 'mcp.mjs')
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
const { DSH_BATON_WAIT_S, ...baseEnv } = process.env

function start(env, clientName = 'codex-mcp-client', script = SERVER) {
  const child = spawn(process.execPath, [script], { env: { ...baseEnv, DSH_BATON_BACKEND: 'host', ...env } })
  const replies = new Map()
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const m = JSON.parse(out.slice(0, i)); out = out.slice(i + 1)
      if (m.id !== undefined) replies.set(m.id, m)
    }
  })
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  const reply = async (id, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (replies.has(id)) return replies.get(id)
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName } } })
  const stop = () => new Promise((r) => { child.on('close', r); child.stdin.end() })
  return { send, reply, stop, replies }
}

async function waitDescription(codexHome, clientName) {
  const s = start({ CODEX_HOME: codexHome, DSH_BATON_SOCKET: path.join(codexHome, 'none.sock') }, clientName)
  s.send({ id: 2, method: 'tools/list' })
  const r = await s.reply(2)
  await s.stop()
  return r.result.tools.find((t) => t.name === 'dsh_wait').description
}

test('Codex waits up to its dsh-baton tool_timeout_sec less 60 s; 270 s without one; other clients 50 s', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  try {
    assert.match(await waitDescription(codexHome), /waits up to 270 s/)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), "[mcp_servers.other]\ntool_timeout_sec = 9000\n\n[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\ntool_timeout_sec = 3600\n")
    const long = await waitDescription(codexHome)
    assert.match(long, /waits up to 3540 s/)
    assert.match(long, /270 s in a conversation that was already open/)
    assert.match(long, /"yield_time_ms": 3560000/)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), "[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\ntool_timeout_sec = 120\n")
    const short = await waitDescription(codexHome)
    assert.match(short, /waits up to 90 s/, 'a timeout too short for the long wait: kept under it, less 30 s')
    assert.match(short, /"yield_time_ms": 110000/)
    assert.match(await waitDescription(codexHome, 'claude-code'), /waits up to 50 s/)
  } finally {
    rm(codexHome)
  }
})

test('a cancelled dsh_wait stops asking the plugin and sends no reply; other calls still answer', async () => {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const sock = path.join(dir, 'h.sock')
  let waits = 0
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    if (req.method === 'wait') waits++
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-1', state: 'running', timed_out: true } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const s = start({ CODEX_HOME: dir, DSH_BATON_SOCKET: sock, DSH_BATON_HOME: dir })
  try {
    await s.reply(1)
    s.send({ id: 3, method: 'tools/call', params: { name: 'dsh_wait', arguments: { run_id: 'hrun-1' } } })
    for (const end = Date.now() + 5000; waits < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 50))
    assert.ok(waits >= 2, 'the wait is asking the plugin')
    s.send({ method: 'notifications/cancelled', params: { requestId: 3, reason: 'user stopped' } })
    await new Promise((r) => setTimeout(r, 1500))
    const after = waits
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(waits, after, 'no more waits once cancelled')
    s.send({ id: 4, method: 'ping' })
    assert.ok(await s.reply(4), 'the server still answers')
    assert.equal(s.replies.has(3), false, 'no reply to the cancelled call')
  } finally {
    await s.stop()
    server.close()
    rm(dir)
  }
})

test('after a hot update, a server.mjs from before 0.6.4 still lets go of a cancelled call', async () => {
  // That shell passes the cancellation on and waits for a reply: mcp.mjs, run on its own
  // here, answers with an error (the new shell drops it, see the test above).
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const sock = path.join(dir, 'h.sock')
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    setTimeout(() => c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-1', state: 'running', timed_out: true } }) + '\n'), 300)
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const s = start({ CODEX_HOME: dir, DSH_BATON_SOCKET: sock, DSH_BATON_HOME: dir }, 'codex-mcp-client', MCP)
  try {
    await s.reply(1)
    s.send({ id: 3, method: 'tools/call', params: { name: 'dsh_wait', arguments: { run_id: 'hrun-1' } } })
    await new Promise((r) => setTimeout(r, 800))
    s.send({ method: 'notifications/cancelled', params: { requestId: 3 } })
    const r = await s.reply(3, 15000)
    assert.equal(r?.error?.code, -32800)
  } finally {
    await s.stop()
    server.close()
    rm(dir)
  }
})

test('Codex always waits with dsh_wait, even with a trusted hook still in config, in new and old conversations alike', async () => {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const { codexHookBlockFor, editCodexConfig } = await import('../src/register.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const cfg = path.join(dir, 'config.toml')
  const conf = `${editCodexConfig('', { command: '/n', args: ['/s'] })}\n${codexHookBlockFor('/h/codex-stop-hook')}`
  fs.writeFileSync(cfg, `${conf}\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  fs.writeFileSync(path.join(dir, 'codex-timeout.json'), JSON.stringify({ value: 3600, since: 1000 }))
  const sock = path.join(dir, 'h.sock')
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-h', state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  // A v7 thread id that started long after the timeout was noted, and one from before it.
  const fresh = `${Date.now().toString(16).padStart(12, '0').replace(/(.{8})(.{4})/, '$1-$2')}-7000-8000-000000000000`
  const send = async (id, threadId) => {
    s.send({ id, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' }, _meta: { threadId } } })
    return JSON.parse((await s.reply(id)).result.content[0].text)
  }
  const s = start({ CODEX_HOME: dir, DSH_BATON_SOCKET: sock, DSH_BATON_HOME: dir })
  try {
    await s.reply(1)
    for (const [id, thread] of [[2, fresh], [3, '00000000-0001-7000-8000-000000000000'], [4, undefined]]) {
      const r = await send(id, thread)
      assert.match(r.hint, /^Run started\. Call dsh_wait with this run_id/)
      assert.doesNotMatch(r.hint, /End your turn/)
      assert.equal(r.note_for_user, undefined)
    }
    assert.equal(fs.existsSync(path.join(dir, 'codex-hook', 'pending.json')), false, 'nothing left for the hook')
  } finally {
    await s.stop()
    server.close()
    rm(dir)
  }
})

test('a conversation started after tool_timeout_sec was written waits long; an older one keeps 270 s', async () => {
  const { codexWaitSeconds, threadStartedAt } = await import('../src/register.mjs')
  assert.equal(threadStartedAt('01a18e43-ef83-7561-a6aa-f15eea378837'), 0x01a18e43ef83)
  assert.equal(threadStartedAt('not-a-uuid'), null)
  assert.equal(threadStartedAt('01a18e43-ef83-4561-a6aa-f15eea378837'), null, 'only v7 ids carry a time')
  const t = { value: 3600, since: 1000 }
  assert.equal(codexWaitSeconds(t, 2000), 3540)
  assert.equal(codexWaitSeconds(t, 500), 270, 'opened before the value: Codex still stops it at 300 s')
  assert.equal(codexWaitSeconds(t, null), 270, 'no thread id: the safe length')
  assert.equal(codexWaitSeconds(t, undefined), 3540, 'a description: what a new conversation gets')
  assert.equal(codexWaitSeconds({ value: null, since: 1 }, 2000), 270)
  assert.equal(codexWaitSeconds({ value: 300, since: 1 }, 2000), 270, 'too short for a margin')
  assert.equal(codexWaitSeconds({ value: 120, since: 1 }, 2000), 90, 'a short value of the user\'s own: under it')
  assert.equal(codexWaitSeconds({ value: 20, since: 1 }, 2000), 10)
  assert.equal(codexWaitSeconds({ value: 5, since: 1 }, 2000), 2, 'never above the value itself')
  // Opened while the user's earlier short value held: kept under that one.
  assert.equal(codexWaitSeconds({ value: 3600, since: 1000, prev: 120 }, 500), 90)
  assert.equal(codexWaitSeconds({ value: 3600, since: 1000, prev: 120 }, 2000), 3540)
  assert.equal(codexWaitSeconds({ value: 3600, since: 1000, prev: null }, 500), 270)
})

test('the time tool_timeout_sec appears or changes is noted once', async () => {
  const { noteCodexToolTimeout, codexTimeoutNoteFile } = await import('../src/register.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const env = { DSH_BATON_HOME: dir }
  const cfg = path.join(dir, 'config.toml')
  try {
    fs.writeFileSync(cfg, "[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\n")
    noteCodexToolTimeout(cfg, env, dir)
    assert.equal(fs.existsSync(codexTimeoutNoteFile(env, dir)), false, 'no value, no note')
    fs.writeFileSync(cfg, "[mcp_servers.dsh-baton]\ncommand = '/n'\nargs = ['/s']\ntool_timeout_sec = 3600\n")
    noteCodexToolTimeout(cfg, env, dir)
    const first = JSON.parse(fs.readFileSync(codexTimeoutNoteFile(env, dir), 'utf8'))
    assert.equal(first.value, 3600)
    await new Promise((r) => setTimeout(r, 20))
    noteCodexToolTimeout(cfg, env, dir)
    assert.deepEqual(JSON.parse(fs.readFileSync(codexTimeoutNoteFile(env, dir), 'utf8')), first, 'same value: kept')
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('3600', '7200'))
    noteCodexToolTimeout(cfg, env, dir)
    const second = JSON.parse(fs.readFileSync(codexTimeoutNoteFile(env, dir), 'utf8'))
    assert.equal(second.value, 7200)
    assert.ok(second.since > first.since)
    // Put back after something took it out: conversations opened meanwhile stop at 300 s.
    await new Promise((r) => setTimeout(r, 20))
    noteCodexToolTimeout(cfg, env, dir, true)
    assert.ok(JSON.parse(fs.readFileSync(codexTimeoutNoteFile(env, dir), 'utf8')).since > second.since)
  } finally {
    rm(dir)
  }
})

test('tool_timeout_sec is read under a quoted key too, and never added twice', async () => {
  const { readCodexToolTimeout, addCodexToolTimeout } = await import('../src/register.mjs')
  const quoted = "[mcp_servers.dsh-baton]\ncommand = '/n'\n'tool_timeout_sec' = 900\n"
  assert.equal(readCodexToolTimeout(quoted), 900)
  assert.equal(addCodexToolTimeout(quoted), quoted)
  assert.equal(readCodexToolTimeout('[mcp_servers.dsh-baton]\n"tool_timeout_sec" = 1200\n'), 1200)
  assert.equal(readCodexToolTimeout('[mcp_servers.dsh-baton]\ntool_timeout_sec = 1_800\n'), 1800)
})

test('a Codex config written with CRLF keeps CRLF when dsh-baton edits it', async () => {
  const { rewrite, addCodexToolTimeout } = await import('../src/register.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const file = path.join(dir, 'config.toml')
  try {
    fs.writeFileSync(file, "model = 'x'\r\n\r\n[mcp_servers.dsh-baton]\r\ncommand = '/n'\r\nargs = ['/s']\r\n")
    assert.equal(rewrite(file, addCodexToolTimeout), 'updated')
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /args = \['\/s'\]\r\ntool_timeout_sec = 3600\r\n/)
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF')
  } finally {
    rm(dir)
  }
})

test('a config another process holds for a moment (Windows) is replaced after a retry; a lasting failure leaves no temp file', async () => {
  const { rewrite } = await import('../src/register.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const file = path.join(dir, 'config.toml')
  const rename = fs.renameSync
  try {
    fs.writeFileSync(file, 'a\n')
    let refused = 0
    fs.renameSync = (...args) => { if (refused++ < 2) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return rename(...args) }
    assert.equal(rewrite(file, () => 'b\n'), 'updated')
    assert.equal(fs.readFileSync(file, 'utf8'), 'b\n')
    // Something saved the file while it was held: its change is kept, and ours applied on top.
    let once = true
    fs.renameSync = (...args) => {
      if (once) { once = false; fs.writeFileSync(file, 'b\nsaved-by-codex\n'); throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
      return rename(...args)
    }
    assert.equal(rewrite(file, (t) => t.includes('ours') ? t : `${t}ours\n`), 'updated')
    assert.equal(fs.readFileSync(file, 'utf8'), 'b\nsaved-by-codex\nours\n')
    fs.renameSync = () => { throw Object.assign(new Error('nope'), { code: 'EXDEV' }) }
    assert.throws(() => rewrite(file, () => 'c\n'), /nope/)
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [])
  } finally {
    fs.renameSync = rename
    rm(dir)
  }
})

test('wait_command prints the evidence its hint points at', async () => {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const evidence = await import('../src/evidence.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lw-cwd-'))
  const sock = path.join(dir, 'h.sock')
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    const result = req.method === 'wait' ? { run_id: 'hrun-e', state: 'completed', final_text: 'done' } : { version: '0' }
    c.end(JSON.stringify({ id: req.id, result }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  try {
    evidence.prepare(dir, { run_id: 'hrun-e', cwd })
    fs.writeFileSync(path.join(cwd, 'made.py'), 'x = 1\n')
    const cli = path.join(path.dirname(SERVER), 'cli.mjs')
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'wait', 'hrun-e'], { env: { ...baseEnv, DSH_BATON_HOME: dir, DSH_BATON_SOCKET: sock, DSH_BATON_BACKEND: 'host' } })
      let s = ''
      child.stdout.on('data', (d) => { s += d })
      child.on('close', () => resolve(s))
    })
    const st = JSON.parse(out)
    assert.deepEqual(st.evidence.changes.created, [{ path: 'made.py', lines: 1 }])
    assert.match(st.hint, /sent without checks/)
  } finally {
    server.close()
    rm(dir)
    rm(cwd)
  }
})
