// Acceptance check for tasks/large.md. Usage: node checks/large.mjs <workspace>
// Covers the API, the static files and npm test; the page itself is only checked statically
// (labels, viewport, fetch calls), not in a browser.
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { run, expect, done, tmp } = checker(dir)
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' } }

for (const f of ['package.json', 'server.mjs', 'src/store.mjs', 'src/validate.mjs', 'src/routes.mjs', 'public/index.html', 'public/app.css', 'public/app.js', 'README.md']) expect(`${f} exists`, fs.existsSync(path.join(dir, f)))
const tests = fs.existsSync(path.join(dir, 'test')) ? fs.readdirSync(path.join(dir, 'test'), { recursive: true }).filter((f) => /\.m?js$/.test(f)) : []
const count = tests.map((f) => (fs.readFileSync(path.join(dir, 'test', f), 'utf8').match(/\btest\(|\bit\(/g) || []).length).reduce((a, b) => a + b, 0)
expect('at least 10 tests', count >= 10, `found ${count}`)
const npm = run('npm', ['test'])
expect('npm test passes', npm.code === 0, npm.out.split('\n').slice(-8).join(' | '))

const html = read('public/index.html'), js = read('public/app.js')
expect('page has viewport meta', /name=["']viewport["']/.test(html))
expect('page loads app.js and app.css', /app\.js/.test(html) && /app\.css/.test(html))
expect('form controls have labels', (html.match(/<label/g) || []).length >= 3 || /<label/.test(js))
expect('app.js calls the API', /\/api\/tasks/.test(js) && /\/api\/stats/.test(js))

const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
const server = spawn('node', ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port), DATA_FILE: path.join(tmp, 'd', 'tasks.json'), TASKS_TODAY: '2026-10-25' }, stdio: 'ignore' })
const base = `http://127.0.0.1:${port}`
let up = false
for (let i = 0; i < 50 && !up; i++) { try { await fetch(base + '/api/stats'); up = true } catch { await new Promise((r) => setTimeout(r, 200)) } }
expect('server starts', up)
const req = async (method, url, body, raw) => {
  const res = await fetch(base + url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, type: res.headers.get('content-type') || '', json, text }
}
const check = async (name, fn) => { try { const [ok, detail] = await fn(); expect(name, ok, detail) } catch (e) { expect(name, false, String(e)) } }

if (up) {
  await check('static /', async () => { const r = await req('GET', '/'); return [r.status === 200 && r.type.startsWith('text/html'), `${r.status} ${r.type}`] })
  await check('static /app.css', async () => { const r = await req('GET', '/app.css'); return [r.status === 200 && r.type.startsWith('text/css'), `${r.status} ${r.type}`] })
  await check('static /app.js', async () => { const r = await req('GET', '/app.js'); return [r.status === 200 && /javascript/.test(r.type), `${r.status} ${r.type}`] })
  await check('empty list', async () => { const r = await req('GET', '/api/tasks'); return [r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r.text] })
  let a
  await check('create', async () => {
    const r = await req('POST', '/api/tasks', { text: 'Pay Rent', priority: 'high', due: '2026-10-20', tags: ['home'] }); a = r.json
    const ok = r.status === 201 && a?.id === 1 && a.text === 'Pay Rent' && a.priority === 'high' && a.due === '2026-10-20' && a.tags?.[0] === 'home' && a.done === false && !Number.isNaN(Date.parse(a.createdAt))
    return [ok, `${r.status} ${r.text}`]
  })
  await check('create defaults', async () => { const r = await req('POST', '/api/tasks', { text: 'write report' }); return [r.status === 201 && r.json?.id === 2 && r.json.priority === 'medium' && r.json.due === null && Array.isArray(r.json.tags) && r.json.tags.length === 0, `${r.status} ${r.text}`] })
  await req('POST', '/api/tasks', { text: 'buy milk', priority: 'low', tags: ['home', 'shop'] })
  for (const [name, body, raw] of [['empty text', { text: '' }], ['missing text', {}], ['bad priority', { text: 'x', priority: 'urgent' }], ['bad due', { text: 'x', due: '2026-02-30' }], ['bad json', undefined, '{oops']]) {
    await check(`400 on ${name}`, async () => { const r = await req('POST', '/api/tasks', raw ? undefined : body, raw); return [r.status === 400 && typeof r.json?.error === 'string', `${r.status} ${r.text}`] })
  }
  await check('filter tag', async () => { const r = await req('GET', '/api/tasks?tag=home'); return [r.json?.map((t) => t.id).join() === '1,3', r.text] })
  await check('filter priority', async () => { const r = await req('GET', '/api/tasks?priority=low'); return [r.json?.map((t) => t.id).join() === '3', r.text] })
  await check('search q', async () => { const r = await req('GET', '/api/tasks?q=RENT'); return [r.json?.map((t) => t.id).join() === '1', r.text] })
  await check('stats', async () => { const r = await req('GET', '/api/stats'); return [r.json?.open === 3 && r.json.done === 0 && r.json.overdue === 1, r.text] })
  await check('patch done', async () => { const r = await req('PATCH', '/api/tasks/1', { done: true, due: null }); return [r.status === 200 && r.json?.done === true && r.json.due === null && r.json.text === 'Pay Rent', `${r.status} ${r.text}`] })
  await check('patch invalid', async () => { const r = await req('PATCH', '/api/tasks/2', { priority: 'nope' }); return [r.status === 400, `${r.status} ${r.text}`] })
  await check('status filters', async () => { const d = await req('GET', '/api/tasks?status=done'), o = await req('GET', '/api/tasks?status=open'); return [d.json?.map((t) => t.id).join() === '1' && o.json?.map((t) => t.id).join() === '2,3', d.text + ' ' + o.text] })
  await check('stats after', async () => { const r = await req('GET', '/api/stats'); return [r.json?.open === 2 && r.json.done === 1 && r.json.overdue === 0, r.text] })
  await check('delete', async () => { const r = await req('DELETE', '/api/tasks/3'); return [r.status === 204, `${r.status}`] })
  await check('404 missing id', async () => { const p = await req('PATCH', '/api/tasks/3', { done: true }), d = await req('DELETE', '/api/tasks/99'); return [p.status === 404 && d.status === 404 && typeof p.json?.error === 'string', `${p.status} ${d.status}`] })
  await check('404 unknown path', async () => { const r = await req('GET', '/api/nothing'); return [r.status === 404, `${r.status}`] })
  await check('persisted to DATA_FILE', async () => [fs.existsSync(path.join(tmp, 'd', 'tasks.json')), ''])
  await check('new id after delete is unused', async () => { const r = await req('POST', '/api/tasks', { text: 'z' }); return [Number.isInteger(r.json?.id) && r.json.id > 2, r.text] })
}
server.kill()
done()
