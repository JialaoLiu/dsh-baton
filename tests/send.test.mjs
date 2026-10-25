// dsh_send: a new session without cwd starts in the folder the client's conversation works in
// (Codex's thread cwd from its rollout file, or the server's folder), and a hand-over with
// checks asks Harness for a sub-agent review table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { within } from '../src/folder.mjs'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')

test('within: same folder or below it, not beside it', () => {
  assert.equal(within('/a/b', '/a/b'), true)
  assert.equal(within('/a/b/c', '/a/b'), true)
  assert.equal(within('/a/bc', '/a/b'), false)
  assert.equal(within('/a', '/a/b'), false)
})

async function sendFrom({ clientName, cwd, args, meta, env = {} }) {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-f-'))
  const sock = path.join(dir, 'h.sock')
  const sends = []
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    if (req.method === 'send') sends.push(req.params)
    c.end(JSON.stringify({ id: req.id, result: { run_id: 'hrun-1', state: 'queued' } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const { DSH_BATON_SENDER, ...base } = process.env
  const child = spawn(process.execPath, [SERVER], { cwd, env: { ...base, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock, DSH_BATON_HOME: dir, ...env } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  for (const m of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' } } },
    { id: 2, method: 'tools/call', params: { name: 'dsh_send', arguments: args, ...(meta ? { _meta: meta } : {}) } },
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  await new Promise((resolve) => { const tick = setInterval(() => { if (out.includes('"id":2')) { clearInterval(tick); resolve() } }, 50) })
  child.stdin.end(); server.close()
  const reply = JSON.parse(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2).result.content[0].text)
  fs.rmSync(dir, { recursive: true, force: true })
  return { host: sends[0], reply }
}

test('Claude Code: no cwd means the project folder the server runs in', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const { host, reply } = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi' } })
  assert.equal(host.cwd, project)
  assert.equal(reply.cwd, project)
  const other = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', cwd: path.join(os.tmpdir(), 'elsewhere') } })
  assert.equal(other.host.cwd, path.join(os.tmpdir(), 'elsewhere'))
  assert.match(other.reply.folder_note, /This conversation works in/)
  const inside = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', cwd: path.join(project, 'sub') } })
  assert.equal(inside.reply.folder_note, undefined)
  const cont = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', session_id: 's1' } })
  assert.equal(cont.host.cwd, undefined, 'continuing a session adds no folder')
  fs.rmSync(project, { recursive: true, force: true })
})

test('Codex: no cwd means the thread cwd from its rollout, not the server folder', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const day = path.join(codexHome, 'sessions', '2026', '10', '26')
  fs.mkdirSync(day, { recursive: true })
  const thread = '01a17359-1d10-7b12-b26c-e166cf9f0759'
  fs.writeFileSync(path.join(day, `rollout-2026-10-26T00-26-22-${thread}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: '/projects/ICT' } }) + '\n')
  const meta = { 'x-codex-turn-metadata': { thread_id: thread } }
  const { host } = await sendFrom({ clientName: 'codex-mcp-client', cwd: codexHome, args: { message: 'hi' }, meta, env: { CODEX_HOME: codexHome } })
  assert.equal(host.cwd, '/projects/ICT')
  // Unknown thread, server started inside CODEX_HOME: no folder is guessed.
  const none = await sendFrom({ clientName: 'codex-mcp-client', cwd: codexHome, args: { message: 'hi' }, meta: { 'x-codex-turn-metadata': { thread_id: 'nope' } }, env: { CODEX_HOME: codexHome } })
  assert.equal(none.host.cwd, undefined)
  fs.rmSync(codexHome, { recursive: true, force: true })
})

test('a hand-over with checks asks for a sub-agent review table; a plain message is sent verbatim', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const handover = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'build it', checks: ['npm test'] } })
  assert.match(handover.host.message, /^build it\n\n---\nWhen the work is done, start a read-only sub-agent/)
  const plain = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'what changed?', session_id: 's1' } })
  assert.equal(plain.host.message, 'what changed?')
  fs.rmSync(project, { recursive: true, force: true })
})
