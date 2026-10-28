// The Codex Stop hook: config editing, when the server trusts it, and what one hook call returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
  const posix = { platform: 'linux' }
  const wrapper = hook.hookCommand('/r', '/n', posix)
  assert.equal(wrapper, path.join(home, 'bin', 'codex-stop-hook'))
  const once = hook.editCodexHook(user, wrapper)
  assert.equal(once.match(/codex-stop-hook/g).length, 2) // the marker comment and the command
  assert.ok(once.endsWith(`command = ${JSON.stringify(wrapper)}\nstatusMessage = "dsh-baton: waiting for the Harness run"\ntimeout = 86400\n`))
  // Written once: another node or server only rewrites the wrapper, never the entry.
  assert.equal(hook.hookCommand('/r2', '/n2', posix), wrapper)
  assert.equal(hook.editCodexHook(once, hook.hookCommand('/r2', '/n2', posix)), once)
  // Entries from before 0.6.1's final form (a node line, no status message) are ours too.
  const legacy = `"/n" "${path.join('/r', 'src', 'cli.mjs')}" codex-stop-hook`
  const older = hook.editCodexHook(user, legacy).replace(/^statusMessage = .*\n/m, '')
  assert.equal(hook.editCodexHook(older, wrapper), once)
  assert.equal(hook.editCodexHook(older, null), user)
  assert.equal(hook.editCodexHook(once.replace(/^statusMessage = .*\n/m, ''), wrapper), once)
  assert.equal(hook.editCodexHook(once, null), user)
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
  // What the model reads is as before 0.6.2, word for word; the user sees a short line.
  assert.equal(out.reason, `dsh-baton: the Harness run hrun-a you handed over with dsh_send has ended (completed). This is its result, as dsh_wait would return it; act on it now (follow the hints):\n${JSON.stringify({ run_id: 'hrun-a', state: 'completed', final_text: 'done', hint: 'shaped' })}`)
  assert.equal(out.systemMessage, 'dsh-baton：Harness 任务 hrun-a（completed）已结束，结果已交回 Codex')
  assert.deepEqual(Object.keys(out), ['decision', 'reason', 'systemMessage'])
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
  assert.match(first.systemMessage, /^dsh-baton：Harness 任务 \S+ 在等回答，问题已交给 Codex$/)
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
  assert.match(first.systemMessage, /^dsh-baton：2 个 Harness 任务已交回 Codex：.*在等回答.*；还在运行 1 个$/)
  assert.ok(first.systemMessage.length < 120)
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

test('Windows: Codex writes the trust key (and may write the command) in single quotes', async () => {
  const { codexHookStatus } = await import('../src/register.mjs')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-win-'))
  const env = { ...process.env, CODEX_HOME: codexHome, DSH_BATON_HOME: home }
  const cfg = path.join(codexHome, 'config.toml')
  const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\app\\src\\cli.mjs" codex-stop-hook'
  const written = hook.editCodexHook('', cmd)
  fs.writeFileSync(cfg, written)
  assert.equal(codexHookStatus(env).trusted, false)
  fs.appendFileSync(cfg, "\n[hooks.state.'C:\\Users\\u\\.codex\\config.toml:stop:0:0']\ntrusted_hash = \"sha256:a\"\n")
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true })
  assert.equal(codexHookStatus(env).trusted, true)
  // The same command as a literal string is still ours: left in place, trust kept.
  const literal = fs.readFileSync(cfg, 'utf8').replace(JSON.stringify(cmd), `'${cmd}'`)
  assert.ok(literal.includes(`command = '${cmd}'`))
  assert.equal(hook.editCodexHook(literal, cmd), literal)
  fs.writeFileSync(cfg, literal)
  assert.equal(codexHookStatus(env).trusted, true)
  // A quote that does not close the same way is not a key.
  fs.writeFileSync(cfg, written + "\n[hooks.state.'x:stop:0:0\"]\ntrusted_hash = \"sha256:a\"\n")
  assert.equal(codexHookStatus(env).trusted, false)
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('Windows: the hook runs through a .cmd wrapper at a path without spaces', async () => {
  const { codexHookEntry, codexHookStatus } = await import('../src/register.mjs')
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const script = path.join('C:\\app 100%', 'src', 'server.mjs')
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-wrap-'))
  const at = codexHookEntry(node, script, { platform: 'win32', home: plain })
  assert.equal(at, path.join(plain, 'bin', 'codex-stop-hook.cmd'))
  assert.equal(fs.readFileSync(at, 'utf8'), `@"${node}" "${path.join('C:\\app 100%%', 'src', 'cli.mjs')}" codex-stop-hook\r\n`)
  // A home with a space: its 8.3 short path, or else PowerShell's call form.
  const spaced = path.join(plain, 'First Last')
  assert.equal(codexHookEntry(node, script, { platform: 'win32', home: spaced, shortPath: () => 'C:\\FIRSTL~1\\w.cmd' }), 'C:\\FIRSTL~1\\w.cmd')
  assert.equal(codexHookEntry(node, script, { platform: 'win32', home: spaced, shortPath: () => null }), `& "${node}" "${path.join('C:\\app 100%', 'src', 'cli.mjs')}" codex-stop-hook`)
  // Elsewhere: a sh script, and the entry names it (quoted when its path has a space).
  const shAt = codexHookEntry('/opt/it\'s/node', '/srv/app/src/server.mjs', { platform: 'darwin', home: plain })
  assert.equal(shAt, path.join(plain, 'bin', 'codex-stop-hook'))
  assert.equal(fs.readFileSync(shAt, 'utf8'), `#!/bin/sh\nexec '/opt/it'\\''s/node' '${path.join('/srv/app/src', 'cli.mjs')}' codex-stop-hook "$@"\n`)
  if (process.platform !== 'win32') assert.equal(fs.statSync(shAt).mode & 0o777, 0o700)
  assert.equal(codexHookEntry(node, script, { platform: 'linux', home: spaced }), JSON.stringify(path.join(spaced, 'bin', 'codex-stop-hook')))
  // Trusted through the wrapper: the command Codex hashed is the same whatever node it runs.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-wrapcfg-'))
  const env = { ...process.env, CODEX_HOME: codexHome, DSH_BATON_HOME: home }
  const cfg = path.join(codexHome, 'config.toml')
  fs.writeFileSync(cfg, hook.editCodexHook('', at))
  assert.deepEqual(codexHookStatus(env), { codex: true, installed: true, trusted: false })
  fs.appendFileSync(cfg, `\n[hooks.state.'${cfg}:stop:0:0']\ntrusted_hash = "sha256:a"\n`)
  fs.writeFileSync(path.join(home, 'codex-hook', 'alive'), JSON.stringify({ at: 1, node: '/elsewhere/node', cli: '/elsewhere/cli.mjs' }))
  assert.equal(codexHookStatus(env).trusted, true)
  // PowerShell's call form is checked against what the hook ran as, like the plain line.
  fs.writeFileSync(cfg, hook.editCodexHook('', `& "${node}" "C:\\a\\cli.mjs" codex-stop-hook`) + `\n[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  assert.equal(codexHookStatus(env).trusted, false)
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true })
  fs.rmSync(plain, { recursive: true, force: true })
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('on Harness\'s own runtime the wrapper sets Node mode first (sh and .cmd); the entry is the same', async () => {
  const { codexHookEntry } = await import('../src/register.mjs')
  const exe = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
  const script = path.join('C:\\app', 'src', 'server.mjs')
  const cli = path.join('C:\\app', 'src', 'cli.mjs')
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-hwrap-'))
  const at = codexHookEntry(exe, script, { platform: 'win32', home: plain, harness: true })
  assert.equal(at, codexHookEntry('C:\\node.exe', script, { platform: 'win32', home: plain }))
  codexHookEntry(exe, script, { platform: 'win32', home: plain, harness: true })
  assert.equal(fs.readFileSync(at, 'utf8'), `@set ELECTRON_RUN_AS_NODE=1\r\n@"${exe}" "${cli}" codex-stop-hook\r\n`)
  // No 8.3 name for a home with a space: PowerShell's call form, with Node mode set first.
  const spaced = path.join(plain, 'First Last')
  assert.equal(codexHookEntry(exe, script, { platform: 'win32', home: spaced, shortPath: () => 'C:\\FIRSTL~1\\w.cmd', harness: true }), 'C:\\FIRSTL~1\\w.cmd')
  assert.equal(codexHookEntry(exe, script, { platform: 'win32', home: spaced, shortPath: () => null, harness: true }), `$env:ELECTRON_RUN_AS_NODE='1'; & "${exe}" "${cli}" codex-stop-hook`)
  const mac = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
  const shAt = codexHookEntry(mac, '/srv/app/src/server.mjs', { platform: 'darwin', home: plain, harness: true })
  assert.equal(fs.readFileSync(shAt, 'utf8'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${mac}' '${path.join('/srv/app/src', 'cli.mjs')}' codex-stop-hook "$@"\n`)
  fs.rmSync(plain, { recursive: true, force: true })
})

// Harness's binary runs cli.mjs only with ELECTRON_RUN_AS_NODE=1. Stood in for by a
// "runtime" that refuses to start without it and then runs this node.
test('the Harness-runtime wrapper starts the hook in Node mode', async () => {
  const { codexHookEntry } = await import('../src/register.mjs')
  const at = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-erun-'))
  const win = process.platform === 'win32'
  const runtime = path.join(at, win ? 'harness.cmd' : 'harness')
  fs.writeFileSync(runtime, win
    ? `@if not "%ELECTRON_RUN_AS_NODE%"=="1" exit /b 9\r\n@"${process.execPath}" %*\r\n`
    : `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 9\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 })
  const entry = codexHookEntry(runtime, SERVER, { home: at, harness: true })
  const env = { ...process.env, DSH_BATON_HOME: at }
  delete env.ELECTRON_RUN_AS_NODE
  const alive = path.join(at, 'codex-hook', 'alive')
  const r = win
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/C', entry], { input: '{"session_id":"no-runs-here"}', env, windowsHide: true, timeout: 60000 })
    : spawnSync('/bin/sh', ['-c', entry], { input: '{"session_id":"no-runs-here"}', env, timeout: 60000 })
  assert.equal(r.status, 0, String(r.stderr))
  assert.ok(fs.existsSync(alive), entry)
  // Without Node mode the stand-in refuses: the wrapper is what sets it.
  fs.rmSync(alive)
  const plain = codexHookEntry(runtime, SERVER, { home: at })
  const bad = win
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/C', plain], { input: '{}', env, windowsHide: true })
    : spawnSync('/bin/sh', ['-c', plain], { input: '{}', env })
  assert.equal(bad.status, 9)
  // Windows with 8.3 names off for the volume (fsutil 8dot3name) and a home with a space:
  // no short path, so the entry is PowerShell's call form with Node mode set first.
  if (win) {
    const spaced = path.join(at, 'First Last')
    const call = codexHookEntry(runtime, SERVER, { home: spaced, shortPath: () => null, harness: true })
    assert.match(call, /^\$env:ELECTRON_RUN_AS_NODE='1'; & "/)
    const spacedAlive = path.join(spaced, 'codex-hook', 'alive')
    for (const shell of ['powershell', 'pwsh']) {
      fs.rmSync(spacedAlive, { force: true })
      const r2 = spawnSync(shell, ['-NoProfile', '-Command', call], { input: '{"session_id":"no-runs-here"}', env: { ...env, DSH_BATON_HOME: spaced }, windowsHide: true, timeout: 60000 })
      if (r2.error?.code === 'ENOENT') continue
      assert.equal(r2.status, 0, `${shell}: ${r2.stderr}`)
      assert.ok(fs.existsSync(spacedAlive), `${shell} -Command ${call}`)
    }
  }
  fs.rmSync(at, { recursive: true, force: true })
})

test('why the hook was not added is one sentence, only when the plugin noted a reason', () => {
  const file = path.join(home, 'codex-hook', 'registered.json')
  const note = (r) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(r)) }
  fs.rmSync(file, { force: true })
  assert.equal(hook.hookSkipReason(), null) // no plugin from 0.6.2 on yet
  note({ state: 'added', reason: null })
  assert.equal(hook.hookSkipReason(), null)
  note({ state: 'off', reason: null }) // Codex not installed: nothing to say
  assert.equal(hook.hookSkipReason(), null)
  note({ state: 'off', reason: 'disabled' })
  assert.match(hook.hookSkipReason(), /^dsh-baton's Codex Stop hook is not set up because it is turned off with DSH_BATON_CODEX_HOOK=0 .*dsh_wait\.$/)
  note({ state: 'skipped', reason: 'no-cli' })
  assert.match(hook.hookSkipReason(), /cli\.mjs/)
  note({ state: 'failed', reason: 'EACCES: permission denied' })
  assert.match(hook.hookSkipReason(), /adding it failed \(EACCES: permission denied\)/)
  fs.rmSync(file, { force: true })
})

// What Codex does on Windows: the whole command as one argument to PowerShell -Command,
// or to cmd /C when no shell is set. Run the generated command both ways, for real.
test('Windows: the generated hook command runs under PowerShell and cmd', { skip: process.platform !== 'win32' }, async () => {
  const { codexHookEntry } = await import('../src/register.mjs')
  const { execFileSync } = await import('node:child_process')
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-run-'))
  const spaced = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb run '))
  const run = (shell, args, home) => {
    const alive = path.join(home, 'codex-hook', 'alive')
    fs.rmSync(alive, { force: true })
    spawnSync(shell, args, { input: '\uFEFF{"session_id":"no-runs-here"}', env: { ...process.env, DSH_BATON_HOME: home }, windowsHide: true, timeout: 60000 })
    return fs.existsSync(alive)
  }
  const shells = ['pwsh', 'powershell'].filter((s) => { try { execFileSync(s, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }); return true } catch { return false } })
  assert.ok(shells.length)
  const cmd = process.env.ComSpec || 'cmd.exe'
  for (const home of [plain, spaced]) {
    const entry = codexHookEntry(process.execPath, SERVER, { home })
    for (const s of shells) assert.ok(run(s, ['-NoProfile', '-Command', entry], home), `${s} -Command ${entry}`)
    // The wrapper (no spaces in its path) runs under cmd too; the call form is PowerShell's.
    if (!entry.startsWith('& ')) assert.ok(run(cmd, ['/C', entry], home), `cmd /C ${entry}`)
  }
  assert.doesNotMatch(codexHookEntry(process.execPath, SERVER, { home: plain }), /^& /)
  const call = codexHookEntry(process.execPath, SERVER, { home: spaced, shortPath: () => null })
  assert.match(call, /^& "/)
  for (const s of shells) assert.ok(run(s, ['-NoProfile', '-Command', call], spaced), `${s} -Command ${call}`)
  fs.rmSync(plain, { recursive: true, force: true })
  fs.rmSync(spaced, { recursive: true, force: true })
})

test('Mac/Linux: the generated hook command runs under sh, with or without a space in the path', { skip: process.platform === 'win32' }, async () => {
  const { codexHookEntry } = await import('../src/register.mjs')
  for (const prefix of ['dshb-sh-', 'dshb sh ']) {
    const at = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const entry = codexHookEntry(process.execPath, SERVER, { home: at })
    spawnSync('/bin/sh', ['-c', entry], { input: '{"session_id":"no-runs-here"}', env: { ...process.env, DSH_BATON_HOME: at }, timeout: 60000 })
    assert.ok(fs.existsSync(path.join(at, 'codex-hook', 'alive')), entry)
    fs.rmSync(at, { recursive: true, force: true })
  }
})

test('hook stdin: a BOM is dropped; input that does not parse is kept for diagnosis', () => {
  const bad = path.join(home, 'codex-hook', 'last-bad-stdin')
  fs.rmSync(bad, { force: true })
  assert.deepEqual(hook.parseHookInput('\uFEFF{"session_id":"t"}'), { session_id: 't' })
  assert.equal(fs.existsSync(bad), false)
  assert.equal(hook.parseHookInput('not json ' + 'x'.repeat(5000)), null)
  const kept = fs.readFileSync(bad)
  assert.equal(kept.length, 4096)
  assert.ok(kept.toString().startsWith('not json'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(bad).mode & 0o777, 0o600)
  assert.equal(hook.parseHookInput(''), null)
})

test('the hook command reads UTF-8 with a BOM and UTF-16 stdin, and notes that it ran', async () => {
  const cli = path.join(path.dirname(SERVER), 'cli.mjs')
  const alive = path.join(home, 'codex-hook', 'alive')
  const json = '{"session_id":"no-runs-here","hook_event_name":"Stop"}'
  for (const input of [Buffer.from('\uFEFF' + json), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])]) {
    fs.rmSync(alive, { force: true })
    const child = spawn(process.execPath, [cli, 'codex-stop-hook'], { env: { ...process.env, DSH_BATON_HOME: home } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stdin.end(input)
    const code = await new Promise((r) => child.on('exit', r))
    assert.equal(code, 0)
    assert.equal(out, '') // no runs for this conversation: the turn just ends
    assert.ok(fs.existsSync(alive))
  }
})

test('a rewritten hook drops the trust Codex gave the old one, until the user trusts it again', async () => {
  const { codexHookStatus } = await import('../src/register.mjs')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-retrust-'))
  const env = { ...process.env, CODEX_HOME: codexHome, DSH_BATON_HOME: home }
  const cfg = path.join(codexHome, 'config.toml')
  const wrapper = hook.hookCommand('/r', '/n', { platform: 'linux' })
  const mine = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n'
  const theirs = `\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:mine"\n`
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true }) // no run yet: the lenient case
  // Trusted in its 0.6.0 form (a node line, no status message); ours is the second Stop group.
  const old = hook.editCodexHook(mine, '"/n" "/r/src/cli.mjs" codex-stop-hook').replace(/^statusMessage = .*\n/m, '') +
    theirs + `\n[hooks.state.'${cfg}:stop:1:0']\ntrusted_hash = "sha256:old"\nenabled = true\n`
  fs.writeFileSync(cfg, old)
  assert.equal(codexHookStatus(env).trusted, true)
  const now = hook.editCodexHook(old, wrapper)
  fs.writeFileSync(cfg, now)
  assert.equal(codexHookStatus(env).trusted, false) // Codex sees it as modified
  assert.doesNotMatch(now, /sha256:old|enabled = true/)
  assert.match(now, /sha256:mine/) // the user's own hook keeps its trust
  // Every later run leaves the file byte for byte as it is.
  for (let i = 0; i < 3; i++) assert.equal(hook.editCodexHook(now, hook.hookCommand('/r', `/n${i}`, { platform: 'linux' })), now)
  fs.appendFileSync(cfg, `\n[hooks.state."${cfg}:stop:1:0"]\ntrusted_hash = "sha256:new"\n`)
  assert.equal(codexHookStatus(env).trusted, true) // trusted again
  // Someone edits the entry (here its timeout): it is put back, and the trust starts over.
  const edited = fs.readFileSync(cfg, 'utf8').replace('timeout = 86400', 'timeout = 60')
  fs.writeFileSync(cfg, hook.editCodexHook(edited, wrapper))
  assert.equal(codexHookStatus(env).trusted, false)
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
  // Calls 2 and 3 come from one conversation and run at the same time, so either may be
  // the one that carries the note: exactly one does.
  const told = [replies[2], replies[3]].filter((r) => r.note_for_user)
  assert.equal(told.length, 1) // same conversation: once is enough
  assert.match(told[0].note_for_user, /Settings → Hooks/)
  assert.match(told[0].hint, /^First, start your reply to the user with note_for_user/)
  for (const r of [replies[2], replies[3]]) assert.match(r.hint, /dsh_wait/)
  assert.ok(replies[4].note_for_user) // a new conversation is told again
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('Codex without the hook: the first hand-over of a conversation says why in its hint', async () => {
  const net = await import('node:net')
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-nohook-'))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n')
  const file = path.join(home, 'codex-hook', 'registered.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ state: 'off', reason: 'disabled', at: 1 }))
  const sock = path.join(home, 'n.sock')
  let n = 0
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    c.end(JSON.stringify({ id: req.id, result: { run_id: `hrun-n${++n}`, state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: codexHome, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const send = (id, threadId) => ({ id, method: 'tools/call', params: { name: 'dsh_send', arguments: { session_id: 's1', message: 'hi' }, _meta: { threadId } } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } }) + '\n')
  for (const m of [send(2, 'thread-n1'), send(3, 'thread-n1')]) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes(`"id":${m.id}`)) { clearInterval(tick); resolve() } }, 50) })
  }
  child.stdin.end(); server.close()
  const replies = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id > 1).map((m) => [m.id, JSON.parse(m.result.content[0].text)]))
  assert.match(replies[2].hint, /^dsh-baton's Codex Stop hook is not set up because it is turned off with DSH_BATON_CODEX_HOOK=0.*Tell the user so in one line, in their language\. Run started\. Call dsh_wait/)
  assert.equal(replies[2].note_for_user, undefined)
  assert.match(replies[3].hint, /^Run started\. Call dsh_wait/) // once per conversation
  fs.rmSync(file, { force: true })
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('moving the MCP table keeps the hook marker that follows it, and the hook entry as written', async () => {
  const { editCodexConfig } = await import('../src/register.mjs')
  const entry = { command: '/n', args: ['/s'] }
  const withHook = hook.editCodexHook(editCodexConfig('model = "x"\n', entry), hook.hookCommand('/r', '/n'))
  const block = withHook.slice(withHook.indexOf('# dsh-baton: wakes'))
  assert.match(withHook, /args = \['\/s'\]\n\n# dsh-baton: wakes/, 'the hook block directly follows the MCP table')
  const moved = editCodexConfig(withHook, { command: '/n2', args: ['/s2'] })
  assert.ok(moved.includes(block.trimEnd()), 'marker and the 4 hook fields are kept byte for byte')
  assert.match(moved, /\[mcp_servers\.dsh-baton\]\ncommand = '\/n2'/)
  assert.equal(hook.editCodexHook(moved, hook.hookCommand('/r', '/n')), moved, 'the hook is still recognised as written')
  assert.equal(editCodexConfig(moved, null).includes('# dsh-baton: wakes'), true, 'removing the MCP server leaves the hook alone')
})

test('Codex\'s dsh_wait description follows the hook: wait without it, end the turn with it trusted', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const cfg = path.join(codexHome, 'config.toml')
  const describe = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: codexHome, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(home, 'none.sock') } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.find((t) => t.name === 'dsh_wait').description))
    child.stdin.end([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } },
      { id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n')
  })
  const none = await describe()
  assert.doesNotMatch(none, /end your turn/)
  assert.match(none, /call dsh_wait again with the same run_id/)
  fs.writeFileSync(cfg, `${hook.editCodexHook('', hook.hookCommand('/r', '/n'))}\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  fs.rmSync(path.join(home, 'codex-hook', 'alive'), { force: true })
  assert.match(await describe(), /when dsh_send's hint says to end your turn, end it, and the result comes back by itself/)
  fs.rmSync(codexHome, { recursive: true, force: true })
})
