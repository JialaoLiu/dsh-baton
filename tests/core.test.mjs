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
process.env.DSH_BRIDGE_SOCKET = path.join(home, 's.sock')
process.env.DSH_BRIDGE_HOME = path.join(home, 'bridge')
process.env.DSH_BRIDGE_ACCOUNT = '0'
// A fake `dsh` that announces a session, then works for a while.
const fakeDsh = path.join(home, 'fake-dsh')
fs.writeFileSync(fakeDsh, `#!${process.execPath}
process.stdin.resume()
console.log(JSON.stringify({ type: 'session', sessionId: 'session-fake' }))
setTimeout(() => { console.log(JSON.stringify({ type: 'final', text: 'fake done' })); process.exit(0) }, 8000)
`, { mode: 0o755 })
process.env.DSH_BIN = fakeDsh
const core = await import('../src/core.mjs')
test.after(() => fs.rmSync(home, { recursive: true, force: true }))

function fakeServer(onLine) {
  fs.rmSync(process.env.DSH_BRIDGE_SOCKET, { force: true })
  const server = net.createServer((c) => c.on('data', () => onLine(c)))
  return new Promise((r) => server.listen(process.env.DSH_BRIDGE_SOCKET, () => r(server)))
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
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-n-')))
  fs.symlinkSync(real, `${real}-l`)
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
  const exit = JSON.parse(fs.readFileSync(path.join(process.env.DSH_BRIDGE_HOME, 'runs', runId, 'exit.json'), 'utf8'))
  assert.equal(exit.state, 'cancelled')
})

test('headless: cancelling a running child keeps the runner to record cancelled', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const runId = core.startRun({ cwd, message: 'x' })
  const dir = path.join(process.env.DSH_BRIDGE_HOME, 'runs', runId)
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, 'pid.json'))), 'runner never started')
  core.cancelRun(runId)
  const st = await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
  assert.equal(st.state, 'cancelled')
  assert.ok(fs.existsSync(path.join(dir, 'exit.json')), 'runner must write exit.json')
})

test('headless: run records are private to the user', async () => {
  const cwd = fs.mkdtempSync(path.join(home, 'w-'))
  const runId = core.startRun({ cwd, message: 'secret task' })
  const dir = path.join(process.env.DSH_BRIDGE_HOME, 'runs', runId)
  const mode = (p) => fs.statSync(p).mode & 0o777
  assert.equal(mode(process.env.DSH_BRIDGE_HOME), 0o700)
  assert.equal(mode(path.join(process.env.DSH_BRIDGE_HOME, 'runs')), 0o700)
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(path.join(dir, 'message.txt')), 0o600)
  assert.equal(mode(path.join(dir, 'meta.json')), 0o600)
  core.cancelRun(runId)
  await core.waitRun(runId, { timeout_s: 15, poll_ms: 100 })
})
