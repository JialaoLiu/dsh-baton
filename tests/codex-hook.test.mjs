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
  assert.match(once, /command = "\\"\/n\\" \\"\/r\/src\/cli\.mjs\\" codex-stop-hook"\ntimeout = 86400\n$/)
  const twice = hook.editCodexHook(once, hook.hookCommand('/r2', '/n'))
  assert.equal(twice.match(/cli\.mjs/g).length, 1)
  assert.match(twice, /\/r2\/src/)
  assert.equal(hook.editCodexHook(twice, null), user)
  // Found by its command too, when the marker line was lost.
  const noMark = once.replace(/^# dsh-baton.*\n/m, '')
  assert.equal(hook.editCodexHook(noMark, null), user)
})

test('the hook counts as active only once it has run since the config last changed', async () => {
  const cfg = path.join(home, 'config.toml')
  fs.writeFileSync(cfg, hook.editCodexHook('', hook.hookCommand('/r', '/n')))
  assert.equal(hook.hookActive(cfg), false) // never ran: not trusted yet, perhaps
  assert.equal(hook.hookUntrusted(cfg), true)
  await hook.runHook({ session_id: 't0' }, { shape: (s) => s, wait: async () => ({}) })
  assert.equal(hook.hookActive(cfg), true)
  assert.equal(hook.hookUntrusted(cfg), false)
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(cfg, later, later) // config edited after: the hook needs trusting again
  assert.equal(hook.hookActive(cfg), false)
  fs.writeFileSync(cfg, 'model = "x"\n')
  await hook.runHook({ session_id: 't0' }, { shape: (s) => s, wait: async () => ({}) })
  assert.equal(hook.hookActive(cfg), false) // not installed
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
  fs.writeFileSync(path.join(codexHome, 'config.toml'), hook.editCodexHook('', hook.hookCommand('/r', '/n')))
  await hook.runHook({ session_id: 'warm' }, { shape: (s) => s, wait: async () => ({}) }) // the hook has fired
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
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes('"id":2')) { clearInterval(tick); resolve() } }, 50) })
  child.stdin.end(); server.close()
  const sent = JSON.parse(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2).result.content[0].text)
  assert.match(sent.hint, /End your turn now/)
  assert.doesNotMatch(sent.hint, /yield_time_ms/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'codex-hook', 'pending.json'), 'utf8'))['hrun-h'].thread, 'thread-9')
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
