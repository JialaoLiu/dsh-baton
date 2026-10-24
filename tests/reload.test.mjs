// A newer copy installed over the app folder is picked up by a running server.mjs on the
// next tools/list or tools/call, without restarting it; calls still running finish in the
// old process, and a copy that cannot start leaves the old one serving.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { installApp } from '../src/register.mjs'
import { socketEndpoint } from '../host/lib/socket.js'

const REPO = path.resolve(import.meta.dirname, '..')

function app() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-reload-'))
  const root = installApp(REPO, path.join(dir, 'app'))
  return { dir, root }
}

// Install a "new version" over root: another version number, and optionally one more tool.
function upgrade(root, version, { probe = true, broken = false } = {}) {
  const file = path.join(root, 'src', 'mcp.mjs')
  let code = fs.readFileSync(file, 'utf8')
  if (probe) code = code.replace('const TOOLS = [', "const TOOLS = [\n  { name: 'dsh_probe', description: 'probe', inputSchema: { type: 'object', properties: {} }, run: () => ({ version: core.VERSION }) },")
  if (broken) code = 'this is not javascript (\n'
  fs.writeFileSync(file, code)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2))
}

function start(root, env = {}) {
  const proc = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
    env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(os.tmpdir(), 'dshb-missing.sock'), ...env },
  })
  const waiting = new Map()
  const notes = []
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) } else notes.push(msg)
  })
  let id = 0
  const call = (method, params) => {
    const n = ++id
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    return new Promise((resolve) => waiting.set(n, resolve))
  }
  const tool = (name, args = {}) => call('tools/call', { name, arguments: args })
  const exited = new Promise((resolve) => proc.on('exit', resolve))
  const stop = () => { proc.stdin.end(); return exited }
  return { proc, call, tool, notes, stop, exited }
}

const texts = (reply) => reply.result.content.map((c) => c.text)
const names = (reply) => reply.result.tools.map((t) => t.name)

test('a newer install is used from the next call on, with list_changed and a note', async () => {
  const { dir, root } = app()
  const s = start(root)
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })
    const before = init.result.serverInfo.version
    assert.equal(init.result.capabilities.tools.listChanged, true)
    assert.ok(!names(await s.call('tools/list')).includes('dsh_probe'))
    const first = await s.tool('dsh_list_workspaces')
    assert.equal(first.result.content.length, 1, 'no note before an update')

    upgrade(root, '9.9.9')
    const probe = await s.tool('dsh_probe')
    assert.equal(JSON.parse(texts(probe)[0]).version, '9.9.9')
    assert.match(texts(probe)[1], new RegExp(`updated from ${before} to 9\\.9\\.9 without a restart`))
    assert.match(texts(probe)[1], /New in this version: dsh_probe\. If this conversation does not show them, call them through dsh_call/)
    assert.ok(s.notes.some((m) => m.method === 'notifications/tools/list_changed'))
    assert.ok(names(await s.call('tools/list')).includes('dsh_probe'))
    const again = await s.tool('dsh_probe')
    assert.equal(again.result.content.length, 1, 'the note is said once')
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh_call reaches a tool added by an update that the client\'s tool list does not show', async () => {
  const { dir, root } = app()
  const s = start(root)
  try {
    await s.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } })
    const tools = (await s.call('tools/list')).result.tools
    const call = tools.find((t) => t.name === 'dsh_call')
    assert.deepEqual([call.annotations.readOnlyHint, call.annotations.destructiveHint, call.annotations.openWorldHint], [false, true, false])
    const unknown = await s.tool('dsh_call', { name: 'dsh_probe' })
    assert.equal(unknown.result.isError, true)
    assert.match(texts(unknown)[0], /No dsh-baton tool named "dsh_probe"/)
    assert.match(texts(unknown)[0], /"name": "dsh_send"/)
    upgrade(root, '9.9.9')
    // The client never lists tools again (as Codex does), and calls the new tool by name.
    const probe = await s.tool('dsh_call', { name: 'dsh_probe', arguments: {} })
    assert.equal(JSON.parse(texts(probe)[0]).version, '9.9.9')
    assert.match(texts(probe)[1], /New in this version: dsh_probe/)
    // Same path as a direct call: errors of the named tool come back as they are.
    const direct = await s.tool('dsh_list_workspaces')
    const viaCall = await s.tool('dsh_call', { name: 'dsh_list_workspaces' })
    assert.equal(texts(viaCall)[0], texts(direct)[0])
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a test build with the same version number counts as new too', async () => {
  const { dir, root } = app()
  const s = start(root)
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18' })
    await s.call('tools/list')
    await new Promise((r) => setTimeout(r, 20)) // a later mtime for package.json
    upgrade(root, init.result.serverInfo.version)
    assert.ok(names(await s.call('tools/list')).includes('dsh_probe'))
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a dsh_wait already running finishes in the old process while new calls go to the new one', async () => {
  const { dir, root } = app()
  const sock = path.join(dir, 'h.sock')
  // Fake host: every wait chunk times out after a short while.
  const host = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    setTimeout(() => c.end(JSON.stringify({ id: req.id, result: { run_id: req.params.run_id, state: 'running', timed_out: true } }) + '\n'), 50)
  }))
  await new Promise((r) => host.listen(socketEndpoint(sock), r))
  const s = start(root, { DSH_BATON_SOCKET: sock, DSH_BATON_WAIT_S: '3' })
  try {
    await s.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })
    const t0 = Date.now()
    const waiting = s.tool('dsh_wait', { run_id: 'hrun-x' })
    await new Promise((r) => setTimeout(r, 500))
    upgrade(root, '9.9.9')
    const probe = await s.tool('dsh_probe')
    assert.equal(JSON.parse(texts(probe)[0]).version, '9.9.9')
    assert.ok(Date.now() - t0 < 2500, 'the new call did not wait behind dsh_wait')
    const waited = await waiting
    assert.equal(waited.result.isError, undefined)
    assert.equal(JSON.parse(texts(waited)[0]).timed_out, true)
    assert.ok(Date.now() - t0 >= 2900, 'dsh_wait ran its full length')
  } finally {
    await s.stop()
    host.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a new install that cannot start leaves the old version serving, and says so once', async () => {
  const { dir, root } = app()
  const s = start(root, { DSH_BATON_START_TIMEOUT_MS: '3000' })
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18' })
    const before = init.result.serverInfo.version
    await s.call('tools/list')
    upgrade(root, '9.9.9', { broken: true })
    const reply = await s.tool('dsh_list_workspaces')
    assert.match(texts(reply)[0], /not reachable/, 'the old version answered the call')
    assert.match(texts(reply)[1], new RegExp(`9\\.9\\.9\\) is installed but could not be started .*still used ${before}`))
    const next = await s.tool('dsh_list_workspaces')
    assert.equal(next.result.content.length, 1)
    assert.ok(!s.notes.some((m) => m.method === 'notifications/tools/list_changed'))
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a server process that stops is replaced and initialized again', async () => {
  const { dir, root } = app()
  const s = start(root)
  try {
    await s.call('initialize', { protocolVersion: '2025-06-18' })
    // Find the child (mcp.mjs) and stop it.
    const { execFileSync } = await import('node:child_process')
    if (process.platform === 'win32') return
    const pid = Number(execFileSync('pgrep', ['-P', String(s.proc.pid)]).toString().trim().split('\n')[0])
    process.kill(pid)
    await new Promise((r) => setTimeout(r, 300))
    const list = await s.call('tools/list')
    assert.ok(names(list).includes('dsh_send'))
    const reply = await s.tool('dsh_list_workspaces')
    assert.match(texts(reply)[0], /not reachable/)
  } finally {
    await s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the shell exits once the client closes stdin', async () => {
  const { dir, root } = app()
  const s = start(root)
  await s.call('initialize', { protocolVersion: '2025-06-18' })
  const code = await Promise.race([s.stop(), new Promise((r) => setTimeout(() => r('hung'), 5000))])
  assert.equal(code, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
