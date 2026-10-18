#!/usr/bin/env node
// Live end-to-end check against a running DeepSeek Harness with the
// dsh-bridge-host plugin. It only touches the workspace folder you pass and the
// sessions it creates there.
//
//   node tests/live.mjs <workspace-folder>
//
// Takes several minutes: it asks the agent to do real work, including sub-agents.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, hostCall } from '../src/core.mjs'

const dir = process.argv[2] && path.resolve(process.argv[2])
if (!dir) {
  console.error('usage: node tests/live.mjs <workspace-folder>')
  process.exit(2)
}
process.env.DSH_BRIDGE_BACKEND = 'host'
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'package.json'), 'utf8'))
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const wait = (run, timeout_s = 600) => api.wait({ run_id: run.run_id, timeout_s })

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, secs: Math.round((Date.now() - t0) / 1000), note: note ?? '' })
  } catch (e) {
    results.push({ name, ok: false, secs: Math.round((Date.now() - t0) / 1000), note: e.message })
  }
  const r = results.at(-1)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.secs}s) ${r.note}`)
}
function expect(cond, msg) { if (!cond) throw new Error(msg) }

fs.mkdirSync(dir, { recursive: true })
for (const f of ['live-1.txt', 'live-order.txt', 'live-sub-a.txt', 'live-sub-b.txt', 'live-cancel-a.txt', 'live-cancel-b.txt']) fs.rmSync(path.join(dir, f), { force: true })
let session

await check('plugin reachable, version matches', async () => {
  const p = await hostCall('ping')
  expect(p.version === pkg.version, `plugin ${p.version} != package ${pkg.version} (restart Harness?)`)
  return `v${p.version}`
})

await check('create workspace (idempotent)', async () => {
  const a = await api.create_workspace({ path: dir, title: 'dsh-bridge live test' })
  const b = await api.create_workspace({ path: dir })
  expect(a.id === b.id && b.created === false, 'second call should return the same workspace')
})

await check('new session + wait', async () => {
  const run = await api.send({ cwd: dir, message: 'Create live-1.txt in the current folder containing exactly the line: bridge live ok. Then reply with one short sentence.' })
  session = run.session_id
  const done = await wait(run)
  expect(done.state === 'completed', `state ${done.state}`)
  expect(read('live-1.txt')?.trim() === 'bridge live ok', 'live-1.txt missing or wrong')
})

await check('continue the same session (context kept)', async () => {
  const done = await wait(await api.send({ session_id: session, message: 'Which file did you just create? Answer with the file name only.' }))
  expect(done.state === 'completed' && /live-1\.txt/.test(done.final_text ?? ''), `reply: ${done.final_text}`)
})

await check('steer mid-task + queued followup', async () => {
  const long = await api.send({ session_id: session, message: 'Run three steps one after another. In each step run `sleep 15` with bash, then append the line "step N" (N = 1, 2, 3) to live-order.txt. Reply "steps done" at the end.' })
  for (let i = 0; i < 60 && !(read('live-order.txt') ?? '').includes('step 1'); i++) await sleep(1000)
  const queued = await api.send({ session_id: session, message: 'Append the line "followup" to live-order.txt, then reply "followup done".' })
  const steer = await api.send({ session_id: session, mode: 'steer', message: 'Interjection: right now append the line "steer" to live-order.txt, then continue with the remaining steps.' })
  const [a, s, q] = await Promise.all([long, steer, queued].map((r) => wait(r)))
  const lines = (read('live-order.txt') ?? '').trim().split('\n').map((l) => l.trim())
  expect([a, s, q].every((r) => r.state === 'completed'), `states ${a.state}/${s.state}/${q.state}`)
  expect(lines.at(-1) === 'followup', `followup should be last: ${lines.join(' | ')}`)
  const si = lines.indexOf('steer')
  expect(si > 0 && si < lines.indexOf('step 3'), `steer should land mid-task: ${lines.join(' | ')}`)
  expect(/followup done/i.test(q.final_text ?? '') && !/followup done/i.test(a.final_text ?? ''), 'followup result leaked into the first run')
  return lines.join(' → ')
})

await check('run completes only after sub-agents finish', async () => {
  const run = await api.send({ session_id: session, message: 'Use the subagent tool to start two sub-agents in parallel. Sub-agent A runs `sleep 20` with bash and then writes "A done" to live-sub-a.txt. Sub-agent B runs `sleep 30` and then writes "B done" to live-sub-b.txt. When both are finished, reply "sub-agents done".' })
  let sawSubagents = false
  for (let i = 0; i < 20 && !sawSubagents; i++) {
    await sleep(2000)
    sawSubagents = (await api.activity({ session_id: session })).activity.some((g) => g.kind === 'subagent')
  }
  const done = await wait(run)
  expect(sawSubagents, 'activity never showed sub-agents')
  expect(done.state === 'completed', `state ${done.state}`)
  expect(read('live-sub-a.txt') && read('live-sub-b.txt'), 'run completed before both sub-agent files existed')
  return `final: ${(done.final_text ?? '').slice(0, 60)}`
})

await check('cancel stops sub-agents', async () => {
  const run = await api.send({ session_id: session, message: 'Use the subagent tool to start two sub-agents in parallel. Each runs `sleep 120` with bash and then writes a file: live-cancel-a.txt and live-cancel-b.txt. Wait for both.' })
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    if ((await api.activity({ session_id: session })).activity.some((g) => g.kind === 'subagent')) break
  }
  await api.cancel({ run_id: run.run_id })
  let busy = true
  for (let i = 0; i < 15 && busy; i++) { await sleep(2000); busy = (await api.activity({ session_id: session })).busy }
  expect(!busy, 'session still busy 30s after cancel')
  expect(!read('live-cancel-a.txt') && !read('live-cancel-b.txt'), 'a cancelled sub-agent still wrote its file')
})

await check('rename session and workspace', async () => {
  const s = await api.rename_session({ session_id: session, title: 'dsh-bridge live test session' })
  const w = await api.rename_workspace({ path: dir, title: 'dsh-bridge live test' })
  const listed = await api.list_sessions({ cwd: dir, limit: 50 })
  expect(listed.some((x) => x.session_id === session && x.title === s.title), 'renamed session not listed with its new title')
  expect(w.title === 'dsh-bridge live test', 'workspace title not updated')
  expect(!listed.some((x) => x.title?.startsWith('Sub-agent')), 'sub-agent sessions should be hidden')
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed · session ${session ?? '-'}`)
process.exitCode = failed.length ? 1 : 0
