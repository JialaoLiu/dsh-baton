// Two things a client got wrong on 2026-11-19 (Claude Code, a project split into tasks):
// - it waited for runs with dsh_wait, a minute a call, while background wait_commands for the
//   same runs were already waiting; dsh_wait now says so at once (waiters.mjs);
// - every new task went to a new Harness session; a task for a folder where the conversation
//   has an idle session now continues that session, and a busy one is never taken.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { socketEndpoint } from '../host/lib/socket.js'
import { markWaiting, waitingInBackground } from '../src/waiters.mjs'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

// A fake host: a send without session_id opens session s1, s2, …; state.busy[sid] and
// state.run[run_id] say what status reports; wait answers after a short while, still running.
async function fakeHost(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-reuse-'))
  const sock = path.join(dir, 'h.sock')
  const sends = [], waits = []
  let sessions = 0, runs = 0
  const conns = new Set()
  const server = net.createServer((c) => { conns.add(c); c.on('close', () => conns.delete(c)); c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    const reply = (result) => c.end(JSON.stringify({ id: req.id, result }) + '\n')
    const p = req.params ?? {}
    if (req.method === 'ping') return reply({ name: 'dsh-baton-host', features: ['team'] })
    if (req.method === 'models') return reply({ models: [] })
    if (req.method === 'send') {
      sends.push(p)
      const session_id = p.session_id ?? `s${++sessions}`
      return reply({ run_id: `hrun-${++runs}`, session_id, state: 'queued', mode: p.mode ?? 'followup' })
    }
    if (req.method === 'status' && p.session_id) {
      if (state.gone?.includes(p.session_id)) return c.end(JSON.stringify({ id: req.id, error: `Unknown session: ${p.session_id}` }) + '\n')
      return reply({ session_id: p.session_id, busy: !!state.busy?.[p.session_id], activity: [], bridge_runs: [], turn_running: false })
    }
    if (req.method === 'status') return reply({ run_id: p.run_id, session_id: 's1', state: state.run?.[p.run_id] ?? 'running' })
    if (req.method === 'wait') { waits.push(p); return setTimeout(() => reply({ run_id: p.run_id, session_id: 's1', state: 'running', timed_out: true }), 200) }
    reply({})
  }) })
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  return { dir, sock, sends, waits, close: () => { for (const c of conns) c.destroy(); server.close(); rm(dir) } }
}

// One server, several tool calls in order; returns their replies.
async function session(host, { clientName = 'claude-code', cwd, env = {} }, calls) {
  const { DSH_BATON_SENDER, ...base } = process.env
  const child = spawn(process.execPath, [SERVER], { cwd, env: { ...base, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: host.sock, DSH_BATON_HOME: host.dir, DSH_BATON_WAIT_S: '1', ...env } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const results = []
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' } } }) + '\n')
    for (const [i, c] of calls.entries()) {
      if (typeof c === 'function') { await c(); continue }
      const id = i + 1
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: c.name, arguments: c.args, ...(c.meta ? { _meta: c.meta } : {}) } }) + '\n')
      for (const end = Date.now() + 20000; !out.split('\n').some((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));) {
        if (Date.now() > end) throw new Error(`no reply to call ${id}`)
        await new Promise((r) => setTimeout(r, 20))
      }
      const msg = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id)
      const text = msg.result.content[0].text
      results.push(msg.result.isError ? { error: text } : JSON.parse(text))
    }
  } finally {
    const exited = new Promise((r) => child.on('close', r))
    child.stdin.end()
    await exited
  }
  return results
}

const send = (args, meta) => ({ name: 'dsh_send', args: { message: 'task', ...args }, ...(meta ? { meta } : {}) })

test('a new task for the same folder continues the idle session; a busy one is not taken', async () => {
  const state = { busy: {} }
  const host = await fakeHost(state)
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  try {
    const [a, b, c, d, e] = await session(host, { cwd: project }, [
      send({}),
      // s1 is still busy: a part sent alongside it gets a session of its own.
      () => { state.busy.s1 = true },
      send({}),
      // Both done: the next task goes to the one used last.
      () => { state.busy = {} },
      send({}),
      // Asked for a fresh one.
      send({ new_session: true }),
      // Another folder: a new session there.
      send({ cwd: path.join(project, 'other') }),
    ])
    assert.equal(a.session_id, 's1')
    assert.equal(a.continued_session, undefined)
    assert.equal(b.session_id, 's2', 'a busy session is not reused')
    assert.equal(c.session_id, 's2')
    assert.equal(c.continued_session, 's2')
    assert.match(c.session_note, /new_session: true/)
    assert.equal(host.sends[2].session_id, 's2')
    assert.equal(host.sends[2].cwd, undefined, 'a continued session gets no folder')
    assert.equal(d.session_id, 's3')
    assert.equal(host.sends[3].new_session, undefined, 'new_session is not passed on')
    assert.equal(e.session_id, 's4')
  } finally { host.close(); rm(project) }
})

test('sessions are kept per conversation where one server serves several (Codex threads)', async () => {
  const host = await fakeHost({ busy: {} })
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  try {
    const t = (id) => ({ 'x-codex-turn-metadata': { thread_id: id } })
    const [a, b, c] = await session(host, { clientName: 'codex-mcp-client', cwd: os.homedir() }, [
      send({ cwd: project }, t('thread-a')),
      send({ cwd: project }, t('thread-b')),
      send({ cwd: project }, t('thread-a')),
    ])
    assert.equal(a.session_id, 's1')
    assert.equal(b.session_id, 's2', 'another conversation does not take it')
    assert.equal(c.continued_session, 's1')
  } finally { host.close(); rm(project) }
})

test('a session that is gone is dropped and a new one starts', async () => {
  const state = { busy: {}, gone: [] }
  const host = await fakeHost(state)
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  try {
    const [, b] = await session(host, { cwd: project }, [send({}), () => { state.gone.push('s1') }, send({})])
    assert.equal(b.session_id, 's2')
    assert.equal(b.continued_session, undefined)
  } finally { host.close(); rm(project) }
})

test('waiters: a live process counts, a file left by one that is gone is removed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-wait-'))
  try {
    assert.equal(waitingInBackground('hrun-x', { home }), false)
    const clear = markWaiting('hrun-x', { home })
    assert.equal(waitingInBackground('hrun-x', { home }), true)
    clear()
    assert.equal(waitingInBackground('hrun-x', { home }), false)
    fs.mkdirSync(path.join(home, 'waiting'), { recursive: true })
    fs.writeFileSync(path.join(home, 'waiting', 'hrun-y.999999999'), '0')
    assert.equal(waitingInBackground('hrun-y', { home }), false)
    assert.equal(fs.existsSync(path.join(home, 'waiting', 'hrun-y.999999999')), false)
    assert.equal(waitingInBackground('../x', { home }), false)
  } finally { rm(home) }
})

test('dsh_wait returns at once for runs a background wait_command waits for; Codex still waits', async () => {
  const state = { run: { 'hrun-9': 'running', 'hrun-8': 'running', 'hrun-done': 'completed' } }
  const host = await fakeHost(state)
  const mark = (id) => markWaiting(id, { home: host.dir })
  try {
    const clears = ['hrun-9', 'hrun-8', 'hrun-done'].map(mark)
    const [one, many, done, codex] = [
      ...await session(host, {}, [
        { name: 'dsh_wait', args: { run_id: 'hrun-9' } },
        { name: 'dsh_wait', args: { run_ids: ['hrun-9', 'hrun-8'] } },
        // Ended: the ordinary wait returns it.
        { name: 'dsh_wait', args: { run_id: 'hrun-done' } },
      ]),
      ...await session(host, { clientName: 'codex-mcp-client', cwd: os.homedir() }, [{ name: 'dsh_wait', args: { run_id: 'hrun-9' } }]),
    ]
    assert.equal(one.waiting_in_background, true)
    assert.equal(one.state, 'running')
    assert.match(one.hint, /Do not call dsh_wait for it/)
    assert.equal(many.waiting_in_background, true)
    assert.deepEqual(many.still_running.map((r) => r.run_id), ['hrun-9', 'hrun-8'])
    assert.equal(done.waiting_in_background, undefined)
    assert.equal(codex.waiting_in_background, undefined, 'Codex has no background waits: it waits as before')
    assert.ok(host.waits.some((w) => w.run_id === 'hrun-done'))
    assert.ok(host.waits.filter((w) => w.run_id === 'hrun-9').length >= 1, 'only the Codex wait reached the host for hrun-9')
    clears.forEach((c) => c())
    // No background wait any more: dsh_wait waits as before.
    const [again] = await session(host, {}, [{ name: 'dsh_wait', args: { run_id: 'hrun-9' } }])
    assert.equal(again.waiting_in_background, undefined)
    assert.equal(again.timed_out, true)
  } finally { host.close() }
})

test('the dsh_send hint tells Claude Code not to also call dsh_wait', async () => {
  const host = await fakeHost({ busy: {} })
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  try {
    const [a] = await session(host, { cwd: project }, [send({})])
    assert.match(a.hint, /do not also call dsh_wait for it/)
  } finally { host.close(); rm(project) }
})
