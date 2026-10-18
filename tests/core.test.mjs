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
