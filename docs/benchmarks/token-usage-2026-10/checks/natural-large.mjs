// Acceptance check for natural/large.md. The request names npm start, PORT, DATA_FILE,
// /api/tasks and /api/stats, nothing else, so field names and shapes are matched loosely:
// a task is created with its title only, and later steps use the field names the server
// itself returned. A failed step reports every attempt, not just the last one.
// Usage: node checks/natural-large.mjs <workspace>
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { run, expect, done, tmp } = checker(dir)
const html = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.html') && !f.includes('node_modules'))
expect('package.json and README exist', fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'README.md')))
expect('a page exists', html.length > 0)
const npm = run('npm', ['test'])
expect('npm test passes', npm.code === 0, npm.out.split('\n').slice(-6).join(' | '))

const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
const dataFile = path.join(tmp, 'data', 'tasks.json')
const server = spawn('npm', ['start'], { cwd: dir, env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, TASKS_TODAY: '2026-10-25' }, stdio: 'ignore', detached: true })
const base = `http://127.0.0.1:${port}`
let up = false
for (let i = 0; i < 60 && !up; i++) { try { await fetch(base + '/api/stats'); up = true } catch { await new Promise((r) => setTimeout(r, 250)) } }
expect('npm start serves on PORT', up)
const req = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, type: res.headers.get('content-type') || '', json, text }
}
const ok = (s) => s >= 200 && s < 300
const unwrap = (j) => (j && typeof j === 'object' && !Array.isArray(j) && (j.task || j.data) ? j.task || j.data : j)
const listOf = (j) => (Array.isArray(j) ? j : Array.isArray(j?.tasks) ? j.tasks : Array.isArray(j?.data) ? j.data : [])
const has = (task, s) => task && Object.values(task).some((v) => v === s)
const check = async (name, fn) => { try { const [pass, detail] = await fn(); expect(name, pass, detail) } catch (e) { expect(name, false, String(e)) } }

if (up) {
  await check('page served at /', async () => { const r = await req('GET', '/'); return [r.status === 200 && r.type.includes('html'), `${r.status} ${r.type}`] })
  let task
  const tried = (r, body) => `${JSON.stringify(body)} -> ${r.status} ${r.text.slice(0, 150)}`
  await check('create a task', async () => {
    const log = []
    for (const body of [{ title: 'Pay rent' }, { text: 'Pay rent' }, { name: 'Pay rent' }]) {
      const r = await req('POST', '/api/tasks', body)
      log.push(tried(r, body))
      if (ok(r.status)) { task = unwrap(r.json); break }
    }
    return [has(task, 'Pay rent') && task.id !== undefined, log.join(' | ')]
  })
  const id = task?.id
  await check('list contains it', async () => { const r = await req('GET', '/api/tasks'); return [listOf(r.json).some((x) => has(x, 'Pay rent')), r.text.slice(0, 200)] })
  await check('mark it done', async () => {
    // The completion flag is whichever boolean field the created task carries.
    const flags = Object.keys(task ?? {}).filter((k) => typeof task[k] === 'boolean')
    const keys = [...flags.sort((a, b) => /done|complet/i.test(b) - /done|complet/i.test(a)), 'done', 'completed'].filter((k, i, a) => a.indexOf(k) === i)
    const log = []
    for (const k of keys) {
      for (const [method, body] of [['PATCH', { [k]: true }], ['PUT', { ...task, [k]: true }]]) {
        const r = await req(method, `/api/tasks/${id}`, body)
        log.push(`${method} ${tried(r, body)}`)
        const t = unwrap(r.json)
        if (ok(r.status) && t?.[k] === true) return [true, log.join(' | ')]
      }
    }
    return [false, log.join(' | ')]
  })
  await check('stats returns counts', async () => { const r = await req('GET', '/api/stats'); const nums = Object.values(unwrap(r.json) ?? {}).filter((v) => typeof v === 'number'); return [r.status === 200 && nums.length >= 2, r.text.slice(0, 200)] })
  await check('bad input is 400', async () => { const r = await req('POST', '/api/tasks', {}); return [r.status === 400, `${r.status}`] })
  await check('unknown id is 404', async () => { const r = await req('DELETE', '/api/tasks/987654'); return [r.status === 404, `${r.status}`] })
  await check('delete it', async () => { const r = await req('DELETE', `/api/tasks/${id}`); const l = await req('GET', '/api/tasks'); return [ok(r.status) && !listOf(l.json).some((x) => has(x, 'Pay rent')), `${r.status}`] })
  await check('data saved to DATA_FILE', async () => [fs.existsSync(dataFile), dataFile])
}
try { process.kill(-server.pid) } catch { server.kill() }
done()
