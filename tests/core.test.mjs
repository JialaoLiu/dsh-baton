// Tests for src/core.mjs pieces that do not need Harness: the socket client and
// the headless session-file reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-core-'))
process.env.DSH_HOME = path.join(home, 'dsh')
process.env.DSH_BATON_SOCKET = path.join(home, 's.sock')
process.env.DSH_BATON_HOME = path.join(home, 'bridge')
process.env.DSH_BATON_ACCOUNT = '0'
// A fake `dsh` that announces a session, then works for a while.
const fakeScript = path.join(home, 'fake-dsh')
fs.writeFileSync(fakeScript, `#!${process.execPath}
process.stdin.resume()
console.log(JSON.stringify({ type: 'session', sessionId: 'session-fake' }))
setTimeout(() => { console.log(JSON.stringify({ type: 'final', text: 'fake done' })); process.exit(0) }, 8000)
`, { mode: 0o755 })
// Windows cannot run a shebang script: there a .cmd launcher (with a space in
// its path) wraps it, which also exercises the cmd.exe route in dshCommand().
const IS_WIN = process.platform === 'win32'
const fakeDsh = IS_WIN ? path.join(home, 'fake dsh.cmd') : fakeScript
if (IS_WIN) fs.writeFileSync(fakeDsh, `@"${process.execPath}" "${fakeScript}" %*\r\n`)
process.env.DSH_BIN = fakeDsh
const core = await import('../src/core.mjs')
test.after(() => fs.rmSync(home, { recursive: true, force: true }))

// A fresh socket per server: a closed named pipe on Windows stays taken until its
// last connection handle is gone, so reusing one name races the previous test.
let servers = 0
function fakeServer(onLine) {
  process.env.DSH_BATON_SOCKET = path.join(home, `s${++servers}.sock`)
  fs.rmSync(process.env.DSH_BATON_SOCKET, { force: true })
  const server = net.createServer((c) => c.on('data', () => onLine(c)))
  return new Promise((r) => server.listen(core.hostSocket(), () => r(server)))
}

test('hostCall rejects an unreadable reply instead of crashing', async () => {
  const server = await fakeServer((c) => c.write('not json\n'))
  await assert.rejects(core.hostCall('ping', {}, { timeoutMs: 2000 }), /unreadable reply/)
  server.close()
})

test('hostCall rejects when the host closes without answering', async () => {
  const server = await fakeServer((c) => c.end())
  await assert.rejects(core.hostCall('ping', {}, { timeoutMs: 0 }), /closed the connection/)
  server.close()
})

test('hostCall returns the result of a normal reply', async () => {
  const server = await fakeServer((c) => c.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n'))
  assert.deepEqual(await core.hostCall('ping'), { ok: true })
  server.close()
})

test('session reader decodes appended frames and skips false frame starts', () => {
  const dir = path.join(process.env.DSH_HOME, 'sessions', '--w--', 'session-x')
  fs.mkdirSync(dir, { recursive: true })
  const line = (o) => JSON.stringify(o) + '\n'
  const frames = [
    zlib.zstdCompressSync(line({ type: 'session', id: 'session-x', cwd: '/w', createdAt: 0 })),
    zlib.zstdCompressSync(line({ type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } })),
    zlib.zstdCompressSync(line({ type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } })),
  ]
  // Junk that contains the zstd magic bytes but is not a frame.
  const junk = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frames[0], junk, frames[1], frames[2]]))
  const s = core.readSession({ session_id: 'session-x' })
  assert.equal(s.cwd, '/w')
  assert.deepEqual(s.messages.map((m) => m.text), ['hello', 'hi'])
})

test('normalizePath expands ~ and follows symlinks', () => {
  assert.equal(core.normalizePath('~'), fs.realpathSync(os.homedir()))
  // .native, like normalizePath: it also expands Windows 8.3 short names (RUNNER~1 on CI).
  const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-n-')))
  fs.symlinkSync(real, `${real}-l`, IS_WIN ? 'junction' : undefined) // a junction needs no admin rights on Windows
  assert.equal(core.normalizePath(`${real}-l`), real)
  fs.unlinkSync(`${real}-l`); fs.rmSync(real, { recursive: true })
})

test('hostCall rejects a null reply', async () => {
  const server = await fakeServer((c) => c.write('null\n'))
  await assert.rejects(core.hostCall('ping', {}, { timeoutMs: 2000 }), /unreadable reply/)
  server.close()
})

const waitFor = async (cond, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return true
  return false
}

test('headless: a cancel before the child starts stops the run and records cancelled', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const runId = core.startRun({ cwd, message: 'x' })
  core.cancelRun(runId)
  const st = await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
  assert.equal(st.state, 'cancelled')
  const exit = JSON.parse(fs.readFileSync(path.join(process.env.DSH_BATON_HOME, 'runs', runId, 'exit.json'), 'utf8'))
  assert.equal(exit.state, 'cancelled')
})

test('headless: cancelling a running child keeps the runner to record cancelled', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const runId = core.startRun({ cwd, message: 'x' })
  const dir = path.join(process.env.DSH_BATON_HOME, 'runs', runId)
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, 'pid.json'))), 'runner never started')
  core.cancelRun(runId)
  const st = await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
  assert.equal(st.state, 'cancelled')
  assert.ok(fs.existsSync(path.join(dir, 'exit.json')), 'runner must write exit.json')
})

test('headless: a dsh that cannot start fails the run with a reason', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const saved = process.env.DSH_BIN
  process.env.DSH_BIN = path.join(home, IS_WIN ? 'missing-dsh.exe' : 'missing-dsh')
  let runId
  try { runId = core.startRun({ cwd, message: 'x' }) } finally { process.env.DSH_BIN = saved }
  const st = await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
  assert.equal(st.state, 'failed')
  assert.match(st.error ?? '', /could not start/)
})

// POSIX modes only: on Windows the records sit in the user profile, private through its ACL.
test('headless: run records are private to the user', { skip: IS_WIN && 'POSIX file modes' }, async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const runId = core.startRun({ cwd, message: 'secret task' })
  const dir = path.join(process.env.DSH_BATON_HOME, 'runs', runId)
  const mode = (p) => fs.statSync(p).mode & 0o777
  assert.equal(mode(process.env.DSH_BATON_HOME), 0o700)
  assert.equal(mode(path.join(process.env.DSH_BATON_HOME, 'runs')), 0o700)
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(path.join(dir, 'message.txt')), 0o600)
  assert.equal(mode(path.join(dir, 'meta.json')), 0o600)
  core.cancelRun(runId)
  await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
})

test('senderOf maps MCP client names to a short sender', () => {
  assert.equal(core.senderOf('claude-code'), 'claude')
  assert.equal(core.senderOf('claude-ai'), 'claude')
  assert.equal(core.senderOf('codex-mcp-client'), 'codex')
  assert.equal(core.senderOf('Cursor (vscode)'), 'cursor-vscode')
  assert.equal(core.senderOf(''), undefined)
  assert.equal(core.senderOf(null), undefined)
})

test('a plugin on another major.minor than the MCP server gets a warning; a patch difference does not', async () => {
  const core = await import('../src/core.mjs')
  assert.equal(core.versionWarning('0.4.1', '0.4.0'), null)
  assert.equal(core.versionWarning(null, '0.4.0'), null)
  assert.match(core.versionWarning('0.3.1', '0.4.0'), /dsh-baton-host is 0\.3\.1 but this MCP server is 0\.4\.0/)
})

test('a relayed question keeps the asker\'s pick apart from the option labels', () => {
  const q = core.shapeQuestion({
    question_id: 'q-1', count: 1, questions: [{
      id: 'name', question: 'Which name?', multi_select: false, free_text: true, options: [
        { number: 1, label: '（推荐）一步待办', description: 'short', recommended: true },
        { number: 2, label: 'listy' },
        { number: 3, label: 'csvmd (Recommended)' },
      ],
    }, { id: 'plain', question: 'Go on?', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }] }],
  })
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['一步待办', 'listy', 'csvmd'])
  assert.ok(q.questions[0].options.every((o) => !('recommended' in o)))
  assert.deepEqual(q.questions[0].harness_suggested, { number: 1, label: '一步待办' })
  assert.equal(q.questions[1].harness_suggested, undefined)
  assert.equal(core.shapeQuestion(undefined), undefined)
})

test('answer keeps reason for the client and sends Harness only the answers', async () => {
  let sent = null
  process.env.DSH_BATON_SOCKET = path.join(home, `s${++servers}.sock`)
  fs.rmSync(process.env.DSH_BATON_SOCKET, { force: true })
  const server = net.createServer((c) => c.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      const req = JSON.parse(line)
      if (req.method === 'answer') sent = req.params
      const result = req.method === 'answer'
        ? { run_id: 'hrun-1', state: 'waiting', submitted: true, answers: [{ id: 'name', selected: ['csvmd (Recommended)'] }] }
        : req.method === 'wait' ? { run_id: req.params.run_id, state: 'completed', final_text: 'GOT: csvmd' }
          : { version: core.VERSION }
      c.write(JSON.stringify({ id: req.id, result }) + '\n')
    }
  }))
  await new Promise((r) => server.listen(core.hostSocket(), r))
  try {
    const st = await core.api.answer({ run_id: 'hrun-1', answers: [{ choose: [1] }], reason: '  short and says what it does ' })
    assert.deepEqual(sent, { run_id: 'hrun-1', answers: [{ choose: [1] }] })
    assert.equal(st.reason, 'short and says what it does')
    assert.deepEqual(st.answers[0].selected, ['csvmd'])
    // The final wait carries the choice and reason, so the client tells the user then.
    const done = await core.api.wait({ run_id: 'hrun-1', timeout_s: 5 })
    assert.deepEqual(done.decided_for_user, { answers: [{ id: 'name', selected: ['csvmd'] }], reason: 'short and says what it does' })
    const bare = await core.api.answer({ run_id: 'hrun-2', answers: [{ choose: [1] }] })
    assert.equal(bare.reason, undefined)
    assert.equal((await core.api.wait({ run_id: 'hrun-2', timeout_s: 5 })).decided_for_user, undefined)
  } finally {
    server.close()
  }
})

test('relay lays the question out with the first line left for the client\'s own pick', () => {
  const text = core.relayText(core.shapeQuestion({ questions: [{ id: 'n', question: 'Which name?', options: [{ number: 1, label: 'csvmd (Recommended)', description: 'short' }, { number: 2, label: 'tabula' }] }] }))
  assert.equal(text, 'My recommendation: <your pick>, because <your own reason>\n\nWhich name?\n  1. csvmd - short\n  2. tabula\n  (The model in Harness that asked would pick: csvmd)')
  assert.equal(core.relayText(undefined), undefined)
})
