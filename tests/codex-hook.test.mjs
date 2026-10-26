// The Codex Stop hook: config editing, when the server trusts it, and what one hook call returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-hook-'))
process.env.DSH_BATON_HOME = home
const hook = await import('../src/codex-hook.mjs')
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')

test('setup adds the hook once, replaces it, and removes only its own lines', () => {
  const user = 'model = "x"\n\n[mcp_servers.a]\ncommand = "n"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "my-own-hook"\n'
  const once = hook.editCodexHook(user, hook.hookCommand('/r', '/n'))
  assert.equal(once.match(/codex-stop-hook/g).length, 2) // the marker comment and the command
  assert.equal(hook.hookCommand('/r', '/n'), `"/n" "${path.join('/r', 'src', 'cli.mjs')}" codex-stop-hook`)
  assert.ok(once.endsWith(`command = ${JSON.stringify(hook.hookCommand('/r', '/n'))}\ntimeout = 86400\n`))
  const twice = hook.editCodexHook(once, hook.hookCommand('/r2', '/n'))
  assert.equal(twice.match(/cli\.mjs/g).length, 1)
  assert.ok(twice.includes(JSON.stringify(hook.hookCommand('/r2', '/n'))))
  assert.equal(hook.editCodexHook(twice, null), user)
  // Found by its command too, when the marker line was lost.
  const noMark = once.replace(/^# dsh-baton.*\n/m, '')
  assert.equal(hook.editCodexHook(noMark, null), user)
})

test('the hook counts as active once trusted, whatever else Codex changes in its config', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-active-'))
  const env = { ...process.env, CODEX_HOME: codexHome }
  const cfg = path.join(codexHome, 'config.toml')
  fs.writeFileSync(cfg, hook.editCodexHook('localeOverride = "en-US"\n', hook.hookCommand('/r', '/n')))
  assert.equal(hook.hookActive(env), false) // not trusted yet
  fs.appendFileSync(cfg, `\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  assert.equal(hook.hookActive(env), true)
  // Codex saves one of its own settings: the hook stays trusted (it once fell back to dsh_wait here).
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('en-US', 'zh-CN'))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(cfg, later, later)
  assert.equal(hook.hookActive(env), true)
  fs.writeFileSync(cfg, 'model = "x"\n')
  assert.equal(hook.hookActive(env), false) // not installed
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('one hook call: nothing pending ends the turn; a finished run comes back once', async () => {
  const shape = (st) => ({ ...st, hint: 'shaped' })
  assert.equal(await hook.runHook({ session_id: 'other' }, { shape, wait: async () => assert.fail('no wait') }), null)
  hook.remember('t1', 'hrun-a')
  let calls = 0
  const wait = async ({ run_id }) => (++calls < 3 ? { run_id, timed_out: true, state: 'running' } : { run_id, state: 'completed', final_text: 'done' })
  const out = await hook.runHook({ session_id: 't1' }, { shape, wait, chunk_s: 0 })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /hrun-a .* has ended \(completed\)/)
  assert.match(out.reason, /"final_text":"done","hint":"shaped"/)
  assert.equal(calls, 3)
  // Delivered: the continuation's own Stop lets the turn end.
  assert.equal(await hook.runHook({ session_id: 't1', stop_hook_active: true }, { shape, wait }), null)
})

test('a question is passed on once; if nobody answers, the turn ends instead of waiting', async () => {
  const shape = (st) => st
  hook.remember('t2', 'hrun-q')
  const asking = async ({ run_id }) => ({ run_id, state: 'waiting', needs_input: 'answer', question: { count: 1, questions: [{ id: 'q1', question: 'Which?' }] } })
  const first = await hook.runHook({ session_id: 't2' }, { shape, wait: asking })
  assert.match(first.reason, /stopped to ask a question/)
  assert.equal(await hook.runHook({ session_id: 't2', stop_hook_active: true }, { shape, wait: asking }), null)
  // Answered (with dsh_answer), the run goes on: the next Stop waits for it again.
  const done = await hook.runHook({ session_id: 't2' }, { shape, wait: async ({ run_id }) => ({ run_id, state: 'completed' }) })
  assert.match(done.reason, /ended \(completed\)/)
})

test('runs handed over together wake Codex once, when the last one ends, with every result', async () => {
  for (const id of ['b1', 'b2', 'b3']) hook.remember('tb', `hrun-${id}`)
  const endsAt = { 'hrun-b1': 1, 'hrun-b2': 3, 'hrun-b3': 5 } // in rounds of waiting
  const calls = {}
  const wait = async ({ run_id }) => {
    calls[run_id] = (calls[run_id] ?? 0) + 1
    return calls[run_id] < endsAt[run_id] ? { run_id, timed_out: true, state: 'running' } : { run_id, state: 'completed', final_text: `done ${run_id}` }
  }
  const out = await hook.runHook({ session_id: 'tb' }, { shape: (s) => s, wait, chunk_s: 0 })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /3 Harness runs you handed over with dsh_send have come back/)
  for (const id of ['b1', 'b2', 'b3']) assert.match(out.reason, new RegExp(`"final_text":"done hrun-${id}"`))
  assert.doesNotMatch(out.reason, /Still running/)
  assert.equal(calls['hrun-b1'], 1) // an ended run is not asked again while the others finish
  // All three handed back: the next Stop lets the turn end.
  assert.equal(await hook.runHook({ session_id: 'tb', stop_hook_active: true }, { shape: (s) => s, wait: async () => assert.fail('no wait') }), null)
})

test('a run that asks a question or fails wakes Codex at once; the rest keep waiting', async () => {
  for (const id of ['q1', 'q2', 'q3']) hook.remember('tq', `hrun-${id}`)
  const states = {
    'hrun-q1': { state: 'completed', final_text: 'ok' },
    'hrun-q2': { state: 'waiting', needs_input: 'answer', question: { count: 1, questions: [{ id: 'x', question: 'Red or blue?' }] } },
    'hrun-q3': { timed_out: true, state: 'running' },
  }
  const wait = async ({ run_id }) => ({ run_id, ...states[run_id] })
  const first = await hook.runHook({ session_id: 'tq' }, { shape: (s) => s, wait, chunk_s: 0 })
  assert.match(first.reason, /2 Harness runs/)
  assert.match(first.reason, /Red or blue\?/)
  assert.match(first.reason, /Still running, not reviewed yet: hrun-q3/)
  // The question is answered elsewhere; q3 fails next: that wakes it too, alone.
  states['hrun-q3'] = { state: 'failed', error: 'boom' }
  const second = await hook.runHook({ session_id: 'tq', stop_hook_active: true }, { shape: (s) => s, wait, chunk_s: 0 })
  assert.match(second.reason, /hrun-q3 you handed over with dsh_send has ended \(failed\)/)
  assert.doesNotMatch(second.reason, /hrun-q1/) // already handed back
})

test('a result the model already got with dsh_wait is not delivered again', async () => {
  hook.remember('t3', 'hrun-w')
  hook.delivered('hrun-w', { state: 'completed' })
  assert.equal(await hook.runHook({ session_id: 't3' }, { shape: (s) => s, wait: async () => assert.fail('no wait') }), null)
})

test('the thread id comes from Codex tool-call metadata', () => {
  assert.equal(hook.threadOf({ threadId: 'a' }), 'a')
  assert.equal(hook.threadOf({ 'x-codex-turn-metadata': { thread_id: 'b' } }), 'b')
  assert.equal(hook.threadOf(undefined), null)
})

test('Codex with the hook active is told to end its turn; the run is remembered for the hook', async () => {
  const net = await import('node:net')
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const trusted = path.join(codexHome, 'config.toml')
  fs.writeFileSync(trusted, `${hook.editCodexHook('', hook.hookCommand('/r', '/n'))}\n[hooks.state."${trusted}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true }) // trusted, not run as anything else
  const sock = path.join(home, 'h.sock')
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-h', state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: codexHome, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  for (const m of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } },
    { id: 2, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' }, _meta: { threadId: 'thread-9' } } },
    // In the turn the hook woke, after Codex saved one of its own settings: rework steered
    // into a running session still ends the turn (0.6.1 fell back to dsh_wait here).
    { id: 3, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's2', message: 'fix the rain', mode: 'steer' }, _meta: { threadId: 'thread-9' } } },
  ]) {
    if (m.id === 3) {
      fs.writeFileSync(trusted, `localeOverride = "zh-CN"\n${fs.readFileSync(trusted, 'utf8')}`)
      const later = new Date(Date.now() + 5000)
      fs.utimesSync(trusted, later, later)
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  }
  await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes('"id":3')) { clearInterval(tick); resolve() } }, 50) })
  child.stdin.end(); server.close()
  const steered = JSON.parse(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 3).result.content[0].text)
  assert.match(steered.hint, /End your turn now/)
  const sent = JSON.parse(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2).result.content[0].text)
  assert.match(sent.hint, /End your turn now/)
  assert.doesNotMatch(sent.hint, /yield_time_ms/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'codex-hook', 'pending.json'), 'utf8'))['hrun-h'].thread, 'thread-9')
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('trusted or not: Codex\'s trust record, and what the hook last ran as', async () => {
  const { codexHookStatus, codexHookCommand } = await import('../src/register.mjs')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-trust-'))
  const env = { ...process.env, CODEX_HOME: codexHome, DSH_BATON_HOME: home }
  const cfg = path.join(codexHome, 'config.toml')
  const node = process.execPath
  const cli = path.join(path.dirname(SERVER), 'cli.mjs')
  const cmd = codexHookCommand(node, SERVER)
  assert.deepEqual(codexHookStatus(env), { codex: true, installed: false, trusted: false })
  const other = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n'
  fs.writeFileSync(cfg, hook.editCodexHook(other, cmd))
  assert.equal(codexHookStatus(env).trusted, false) // installed, never trusted
  // Ours is the second Stop group: Codex keys its trust record by that place.
  fs.appendFileSync(cfg, `\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  assert.equal(codexHookStatus(env).trusted, false)
  fs.appendFileSync(cfg, `\n[hooks.state."${cfg}:stop:1:0"]\ntrusted_hash = "sha256:b"\n`)
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true })
  assert.equal(codexHookStatus(env).trusted, true) // trusted, no turn ended since
  await hook.runHook({ session_id: 'none' }, { shape: (s) => s, wait: async () => ({}), self: { node: fs.realpathSync(node), cli: fs.realpathSync(cli) } })
  assert.equal(codexHookStatus(env).trusted, true) // and it ran as exactly this hook
  // Rewritten since (another node): the old trust record no longer covers it.
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(JSON.stringify(cmd), JSON.stringify(codexHookCommand('/other/node', SERVER))))
  assert.equal(codexHookStatus(env).trusted, false)
  assert.deepEqual(codexHookStatus({ CODEX_HOME: path.join(codexHome, 'nope') }), { codex: false, installed: false, trusted: false })
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('the trust note is given once per conversation', () => {
  assert.equal(hook.noteOnce('c1'), true)
  assert.equal(hook.noteOnce('c1'), false)
  assert.equal(hook.noteOnce('c2'), true)
  assert.equal(hook.noteOnce(null), false)
})

test('Codex with the hook not trusted yet: dsh_wait, and the user is told once per conversation', async () => {
  const net = await import('node:net')
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const cfg = path.join(codexHome, 'config.toml')
  fs.writeFileSync(cfg, hook.editCodexHook('', hook.hookCommand('/r', '/n')))
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(cfg, later, later) // not run since: not active
  const sock = path.join(home, 'u.sock')
  let n = 0
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    c.end(JSON.stringify({ id: req.id, result: { run_id: `hrun-u${++n}`, state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: codexHome, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const send = (id, threadId) => ({ id, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' }, _meta: { threadId } } })
  for (const m of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } },
    send(2, 'thread-u1'), send(3, 'thread-u1'), send(4, 'thread-u2'),
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes('"id":4')) { clearInterval(tick); resolve() } }, 50) })
  child.stdin.end(); server.close()
  const replies = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id > 1).map((m) => [m.id, JSON.parse(m.result.content[0].text)]))
  assert.match(replies[2].note_for_user, /Settings → Hooks/)
  assert.match(replies[2].hint, /^First, start your reply to the user with note_for_user/)
  assert.match(replies[2].hint, /dsh_wait/)
  assert.equal(replies[3].note_for_user, undefined) // same conversation: once is enough
  assert.ok(replies[4].note_for_user) // a new conversation is told again
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
