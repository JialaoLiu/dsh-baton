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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { within, antigravityConversationCwd } from '../src/folder.mjs'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

test('within: same folder or below it, not beside it', () => {
  assert.equal(within('/a/b', '/a/b'), true)
  assert.equal(within('/a/b/c', '/a/b'), true)
  assert.equal(within('/a/bc', '/a/b'), false)
  assert.equal(within('/a', '/a/b'), false)
})

async function sendFrom({ clientName, cwd, args, meta, env = {}, oldHost = false }) {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-f-'))
  const sock = path.join(dir, 'h.sock')
  const sends = []
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    if (req.method === 'send') sends.push(req.params)
    if (req.method === 'models' && oldHost) return c.end(JSON.stringify({ id: req.id, error: 'Unknown method: models' }) + '\n')
    if (req.method === 'ping' && oldHost) return c.end(JSON.stringify({ id: req.id, result: { name: 'dsh-baton-host', version: '0.6.11' } }) + '\n')
    if (req.method === 'ping') return c.end(JSON.stringify({ id: req.id, result: { name: 'dsh-baton-host', features: ['team'] } }) + '\n')
    c.end(JSON.stringify({ id: req.id, result: req.method === 'models' ? { models: [] } : { run_id: 'hrun-1', state: 'queued', mode: req.params?.mode ?? 'followup', ...(req.params?.session_id === 's1' ? { other_active_runs: ['hrun-0'] } : {}) } }) + '\n')
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
  // Windows will not delete a folder that a live process uses as its working directory, so
  // wait for the server to exit (it does when stdin closes) before the caller removes it.
  const exited = new Promise((r) => child.on('close', r))
  child.stdin.end(); server.close()
  await exited
  const result = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2).result
  const text = result.content[0].text
  const reply = result.isError ? { error: text } : JSON.parse(text)
  rm(dir)
  return { host: sends[0], reply }
}

test('Claude Code: no cwd means the project folder the server runs in', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const { host, reply } = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi' } })
  assert.equal(host.cwd, project)
  assert.equal(reply.cwd, project)
  const other = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', cwd: path.join(os.tmpdir(), 'elsewhere') } })
  assert.equal(other.host.cwd, path.join(os.tmpdir(), 'elsewhere'))
  assert.match(other.reply.folder_note, /This conversation works in/)
  const inside = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', cwd: path.join(project, 'sub') } })
  assert.equal(inside.reply.folder_note, undefined)
  // The conversation folder goes along, so the plugin can put a subfolder in its workspace.
  assert.equal(host.conversation_folder, project)
  assert.equal(inside.host.conversation_folder, project)
  const cont = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', session_id: 's1' } })
  assert.equal(cont.host.cwd, undefined, 'continuing a session adds no folder')
  assert.equal(cont.host.conversation_folder, undefined)
  rm(project)
})

test('Codex: no cwd means the thread cwd from its rollout, not the server folder', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const day = path.join(codexHome, 'sessions', '2026', '10', '26')
  fs.mkdirSync(day, { recursive: true })
  const thread = '00000000-0000-7000-8000-000000000001'
  fs.writeFileSync(path.join(day, `rollout-2026-10-26T00-26-22-${thread}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: '/projects/demo' } }) + '\n')
  const meta = { 'x-codex-turn-metadata': { thread_id: thread } }
  const { host } = await sendFrom({ clientName: 'codex-mcp-client', cwd: codexHome, args: { message: 'hi' }, meta, env: { CODEX_HOME: codexHome } })
  assert.equal(host.cwd, '/projects/demo')
  // Unknown thread, server started inside CODEX_HOME: no folder is guessed, and Codex is told
  // to name one instead of getting the host's bare "needs cwd".
  const none = await sendFrom({ clientName: 'codex-mcp-client', cwd: codexHome, args: { message: 'hi' }, meta: { 'x-codex-turn-metadata': { thread_id: 'nope' } }, env: { CODEX_HOME: codexHome } })
  assert.equal(none.host, undefined, 'nothing sent')
  assert.match(none.reply.error, /Could not tell which folder this Codex conversation works in, so nothing was sent\. Call dsh_send again with cwd/)
  // As 0.6.5 registers it: started in the home folder, which is never taken for a project.
  const home = await sendFrom({ clientName: 'codex-mcp-client', cwd: os.homedir(), args: { message: 'hi' }, meta: { 'x-codex-turn-metadata': { thread_id: 'nope' } }, env: { CODEX_HOME: codexHome } })
  assert.equal(home.host, undefined)
  const named = await sendFrom({ clientName: 'codex-mcp-client', cwd: os.homedir(), args: { message: 'hi', cwd: '/projects/x' }, meta: { 'x-codex-turn-metadata': { thread_id: 'nope' } }, env: { CODEX_HOME: codexHome } })
  assert.equal(named.host.cwd, '/projects/x')
  rm(codexHome)
})

// Antigravity's data folder with a conversation_summaries.db as Antigravity 2.32 writes it.
function antigravityData(rows) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ag-'))
  const db = new DatabaseSync(path.join(data, 'conversation_summaries.db'))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', workspace_uris text NOT NULL, project_id text NOT NULL DEFAULT '')")
  const add = db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris, project_id) VALUES (?, ?, ?)')
  for (const [id, uris, project] of rows) add.run(id, uris, project)
  // Left open, like Antigravity does: the rows are still in the -wal file.
  return { data, close: () => { db.close(); rm(data) } }
}
const agMeta = (data, id, root = id) => ({ 'antigravity.google/artifacts_dir': path.join(data, 'brain', id), 'antigravity.google/conversation_id': id, 'antigravity.google/root_conversation_id': root, progressToken: 'x:1' })

test('Antigravity folder lookup: a damaged database or an unknown id gives undefined; no artifacts_dir reads ~/.gemini/antigravity', () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-agbad-'))
  fs.writeFileSync(path.join(bad, 'conversation_summaries.db'), 'not a database')
  assert.equal(antigravityConversationCwd({ 'antigravity.google/conversation_id': 'c-bad' }, bad), undefined)
  // Ids that are not plain words are never looked up.
  assert.equal(antigravityConversationCwd({ 'antigravity.google/conversation_id': "x' OR 1=1 --" }, bad), undefined)
  rm(bad)

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-agproj-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-aghome-'))
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true })
  // Built in place and closed: Windows cannot move a folder with an open database in it.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'))
  db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, workspace_uris text NOT NULL, project_id text NOT NULL DEFAULT '')")
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('c-home', JSON.stringify([pathToFileURL(project).href]), 'p1')
  db.close()
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = process.env.USERPROFILE = home
  try {
    assert.equal(antigravityConversationCwd({ 'antigravity.google/conversation_id': 'c-home' }), project)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rm(home); rm(project)
  }
})

test('Antigravity: no cwd means the conversation\'s project folder; without a project it asks', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-agproj-')))
  const ag = antigravityData([
    ['c-proj', JSON.stringify([pathToFileURL(project).href]), 'p1'],
    ['c-none', '', 'outside-of-project'],
  ])
  try {
    // Antigravity starts the server in / for all its conversations.
    const root = path.parse(project).root
    const inProject = await sendFrom({ clientName: 'antigravity-client', cwd: root, args: { message: 'hi' }, meta: agMeta(ag.data, 'c-proj') })
    assert.equal(inProject.host.cwd, project)
    assert.equal(inProject.host.sender, 'antigravity')
    // Antigravity wakes the model when a background command exits: it is told to wait that way.
    if (process.platform === 'win32') {
      // Antigravity's terminal there may not open Harness's pipe: it waits with dsh_wait.
      assert.equal(inProject.reply.wait_command, undefined)
      assert.match(inProject.reply.hint, /^Run started\. Call dsh_wait with this run_id/)
    } else {
      assert.match(inProject.reply.wait_command, / wait hrun-1$/)
      assert.match(inProject.reply.hint, /^Run started\. Run wait_command now as a background terminal command and end your turn: Antigravity wakes you when it exits/)
      assert.match(inProject.reply.hint, /Do not call dsh_wait for it\./)
    }
    // A sub-agent's conversation has no row of its own: its root conversation's folder.
    const child = await sendFrom({ clientName: 'antigravity-client', cwd: root, args: { message: 'hi' }, meta: agMeta(ag.data, 'c-child', 'c-proj') })
    assert.equal(child.host.cwd, project)
    const none = await sendFrom({ clientName: 'antigravity-client', cwd: root, args: { message: 'hi' }, meta: agMeta(ag.data, 'c-none') })
    assert.equal(none.host, undefined, 'nothing sent')
    assert.match(none.reply.error, /Could not tell which folder this Antigravity conversation works in, so nothing was sent\. Call dsh_send again with cwd/)
    const named = await sendFrom({ clientName: 'antigravity-client', cwd: root, args: { message: 'hi', cwd: project }, meta: agMeta(ag.data, 'c-none') })
    assert.equal(named.host.cwd, project)
    const unknown = await sendFrom({ clientName: 'antigravity-client', cwd: root, args: { message: 'hi' }, meta: agMeta(ag.data, 'c-new') })
    assert.equal(unknown.host, undefined, 'a conversation not in the database yet: no guess')
  } finally { ag.close(); rm(project) }
})

test('a followup into a session says how to change it while it waits in the queue', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  try {
    const queued = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'next', session_id: 's1' } })
    // Claude Code lists dsh_update_queued; Codex reaches it only through dsh_call.
    assert.match(queued.reply.queue_hint, /you can change it with dsh_update_queued \{run_id, action: "edit" \(with message\) \| "remove" \| "steer"\}/)
    const codex = await sendFrom({ clientName: 'codex-mcp-client', cwd: project, args: { message: 'next', session_id: 's1' } })
    assert.match(codex.reply.queue_hint, /dsh_call \{name: "dsh_update_queued", arguments: \{run_id, action: "edit" \(with message\) \| "remove" \| "steer"\}\}\. It is not in your tool list/)
    const steer = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'now', session_id: 's1', mode: 'steer' } })
    assert.equal(steer.reply.queue_hint, undefined, 'a steer joins the running turn: nothing waits')
    const fresh = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'new' } })
    assert.equal(fresh.reply.queue_hint, undefined, 'a new session has no queue')
    // Every run starts out queued until Harness takes its prompt: with nothing ahead, no hint.
    const idle = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'next', session_id: 's-idle' } })
    assert.equal(idle.reply.queue_hint, undefined, 'an idle session: nothing to wait behind')
  } finally { rm(project) }
})

test('a hand-over with checks asks for a sub-agent review table in its language; a plain message is sent verbatim', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const handover = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'build it', checks: ['npm test'] } })
  assert.match(handover.host.message, /^build it\n\n---\nWhen the work is done, start a read-only sub-agent/)
  const zh = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: '做一个看板', checks: ['npm test'] } })
  assert.match(zh.host.message, /^做一个看板\n\n---\n完成后，启动一个只读子代理/)
  const plain = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'what changed?', session_id: 's1' } })
  assert.equal(plain.host.message, 'what changed?')
  rm(project)
})

test('model goes to the plugin with the message; a plugin too old to choose one gets nothing', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const { host } = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', model: 'V4 Pro', reasoning_effort: 'high' } })
  assert.equal(host.model, 'V4 Pro')
  assert.equal(host.reasoning_effort, 'high')
  const old = await sendFrom({ clientName: 'claude-code', cwd: project, oldHost: true, args: { message: 'hi', model: 'V4 Pro' } })
  assert.equal(old.host, undefined, 'nothing was sent')
  assert.match(old.reply.error, /too old to choose a model.*Nothing was sent/)
  const plain = await sendFrom({ clientName: 'claude-code', cwd: project, oldHost: true, args: { message: 'hi' } })
  assert.equal(plain.host.message, 'hi', 'without model an old plugin is used as before')
  rm(project)
})

test('team goes to the plugin with the message; a plugin before 0.6.12 gets nothing', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const { host } = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', team: true } })
  assert.equal(host.team, true)
  const old = await sendFrom({ clientName: 'claude-code', cwd: project, oldHost: true, args: { message: 'hi', team: true } })
  assert.equal(old.host, undefined, 'nothing was sent')
  assert.match(old.reply.error, /dsh-baton-host 0\.6\.11 is too old to turn on Agent Teams.*Nothing was sent/)
  rm(project)
})

test('team as the string "true" or "false" (a client with a tool list from before team) goes as a boolean', async () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const on = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', team: 'true' } })
  assert.equal(on.host.team, true)
  const off = await sendFrom({ clientName: 'claude-code', cwd: project, args: { message: 'hi', team: 'False' } })
  assert.equal(off.host.team, false)
  rm(project)
})

test('checks run in the work folder of a session that opened in a folder containing it, on later sends too', async () => {
  const { socketEndpoint } = await import('../host/lib/socket.js')
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-proj-')))
  const sub = path.join(project, 'app')
  fs.mkdirSync(sub)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-f-'))
  const sock = path.join(dir, 'h.sock')
  let n = 0
  const server = net.createServer((c) => c.on('data', (d) => {
    const req = JSON.parse(String(d).split('\n')[0])
    if (req.method === 'ping') return c.end(JSON.stringify({ id: req.id, result: { name: 'dsh-baton-host', features: ['team'] } }) + '\n')
    const first = req.method === 'send' && !req.params.session_id
    c.end(JSON.stringify({ id: req.id, result: { run_id: `hrun-${++n}`, session_id: 'sx', state: 'queued', mode: 'followup', ...(first ? { work_folder: sub } : {}) } }) + '\n')
  }))
  await new Promise((r) => server.listen(socketEndpoint(sock), r))
  const { DSH_BATON_SENDER, ...base } = process.env
  const child = spawn(process.execPath, [SERVER], { cwd: project, env: { ...base, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: sock, DSH_BATON_HOME: dir } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const until = (id) => new Promise((resolve) => { const tick = setInterval(() => { if (out.includes(`"id":${id}`)) { clearInterval(tick); resolve() } }, 50) })
  const call = (id, args) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'dsh_send', arguments: args } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '1' } } }) + '\n')
  call(2, { message: 'hi', cwd: sub, checks: ['npm test'] })
  await until(2)
  call(3, { message: 'more', session_id: 'sx', checks: ['npm test'] })
  await until(3)
  const exited = new Promise((r) => child.on('close', r))
  child.stdin.end(); server.close()
  await exited
  const cwdOf = (run) => JSON.parse(fs.readFileSync(path.join(dir, 'evidence', `${run}.json`), 'utf8')).cwd
  assert.equal(cwdOf('hrun-1'), sub)
  assert.equal(cwdOf('hrun-2'), sub)
  rm(dir); rm(project)
})
