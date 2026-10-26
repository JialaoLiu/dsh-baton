// Acceptance check for natural/xl.md (the large task: a rainy-night street-corner diorama in
// three.js). The request fixes no file layout beyond index.html and vendor/three, so the check
// looks at what a viewer sees: the page renders a night scene without errors, keeps moving, swings
// when dragged, zooms on the wheel, runs smoothly, and loads nothing from outside the folder and no
// image or model files. Screenshots for the blind review are written to <out>.
// Usage: node checks/natural-xl.mjs <workspace> [<out dir>]
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { expect, done, tmp } = checker(dir)
const out = path.resolve(process.argv[3] ?? path.join(tmp, 'shots'))
fs.mkdirSync(out, { recursive: true })
const W = 1600, H = 900

expect('index.html and README exist', fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'README.md')))
const assetExt = /\.(png|jpe?g|webp|gif|avif|ktx2|basis|glb|gltf|bin|obj|fbx|hdr|exr|dds)$/i
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

// Static server for the folder.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' }
const port = await freePort()
const server = http.createServer((req, res) => {
  const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
}).listen(port, '127.0.0.1')
const origin = `http://127.0.0.1:${port}`

// Headless Chrome on the real GPU, driven over the DevTools protocol.
const cdpPort = await freePort()
const profile = path.join(tmp, 'chrome')
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore', detached: true })
let wsUrl
for (let i = 0; i < 100 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(150) } }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map(), listeners = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) }
  else for (const fn of listeners) fn(m)
})
let session
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })) })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId

const errors = [], requests = []
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails?.text)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url ?? '')) errors.push(m.params.entry.text)
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
})
for (const d of ['Page', 'Runtime', 'Log', 'Network']) await send(`${d}.enable`)
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value

// Screenshots decoded to RGB so frames can be compared (8-bit PNG, any colour type Chrome emits).
function decode(buf) {
  let i = 8, w, h, bpp, idat = []
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bpp = { 2: 3, 6: 4 }[data[9]] }
    if (type === 'IDAT') idat.push(data)
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      px[y * stride + x] = row[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]
    }
  }
  return { w, h, bpp, px }
}
const shot = async (name) => {
  const buf = Buffer.from((await send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64')
  fs.writeFileSync(path.join(out, `${name}.png`), buf)
  return decode(buf)
}
const lumaStats = ({ w, h, bpp, px }) => {
  let s = 0, s2 = 0, n = 0
  for (let i = 0; i < w * h * bpp; i += bpp * 4) { const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; s += l; s2 += l * l; n++ }
  return { mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2) }
}
// Frames are compared as 20x20-pixel block averages, so rain streaks and flicker count for little
// and a camera move (whole shapes shifting) counts for a lot.
const blocks = ({ w, h, bpp, px }, B = 20) => {
  const bw = Math.floor(w / B), bh = Math.floor(h / B), out = new Float64Array(bw * bh)
  for (let y = 0; y < bh * B; y++) for (let x = 0; x < bw * B; x++) { const i = (y * w + x) * bpp; out[Math.floor(y / B) * bw + Math.floor(x / B)] += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / (B * B) }
  return out
}
const diff = (a, b) => { const x = blocks(a), y = blocks(b); let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length }
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, ...extra })
const drag = async (dx) => {
  const x0 = W / 2, y = H / 2
  await mouse('mouseMoved', x0, y, { buttons: 0, button: 'none' })
  await mouse('mousePressed', x0, y, { clickCount: 1 })
  for (let k = 1; k <= 20; k++) { await mouse('mouseMoved', x0 + (dx * k) / 20, y); await sleep(16) }
  await mouse('mouseReleased', x0 + dx, y, { clickCount: 1 })
}
const check = async (name, fn) => { try { const [pass, detail] = await fn(); expect(name, pass, detail) } catch (e) { expect(name, false, String(e)) } }

await send('Page.navigate', { url: `${origin}/index.html` })
let canvas = null
for (let i = 0; i < 80 && !canvas; i++) { await sleep(250); canvas = await evaluate(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; if (!c) return null; const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, gl: !!(c.getContext('webgl2') || c.getContext('webgl')) } })()`) }
await sleep(4000)
await check('a WebGL canvas fills the window', async () => [!!canvas?.gl && canvas.w * canvas.h >= 0.8 * W * H, JSON.stringify(canvas)])

const front = await shot('front')
await check('the frame shows a night scene, not a blank screen', async () => { const s = lumaStats(front); return [s.sd > 12 && s.mean > 6 && s.mean < 150, JSON.stringify(s)] })
await sleep(1500)
const later = await shot('front-later')
const idle = diff(front, later)
await check('the scene moves on its own (rain, lights)', async () => [idle > 0.3, `mean pixel change ${idle.toFixed(2)}`])

await check('runs smoothly (frames per second)', async () => {
  const fps = await evaluate('new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(f) : r(n / ((performance.now() - t0) / 1000)) }; requestAnimationFrame(f) })')
  return [fps >= 30, `${fps?.toFixed(1)} fps at ${W}x${H}`]
})

const beforeDrag = await shot('before-drag')
await sleep(1150)
const idleDrag = diff(beforeDrag, await shot('idle-control'))
await drag(-500)
await sleep(800)
const left = await shot('swing-left')
await drag(1000)
await sleep(800)
const right = await shot('swing-right')
// Left against right, since some scenes sway the camera on their own while nobody drags.
await check('dragging swings the camera', async () => { const d = diff(left, right); return [d > Math.max(4, 2 * idleDrag), `left vs right ${d.toFixed(2)} vs ${idleDrag.toFixed(2)} without dragging`] })
await drag(-500)
await sleep(800)

const beforeZoom = await shot('before-zoom')
for (let k = 0; k < 8; k++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: -240 }); await sleep(40) }
await sleep(800)
const near = await shot('zoom-in')
await check('the wheel zooms', async () => { const d = diff(beforeZoom, near); return [d > Math.max(4, 2 * idleDrag), `change ${d.toFixed(2)} vs ${idleDrag.toFixed(2)} without input`] })

// Watch long enough for one train pass (about 40 s) while recording frames for the review.
for (let k = 0; k < 9; k++) { await sleep(5000); if (k % 3 === 2) await shot(`watch-${k}`) }

await check('no errors in the page', async () => [errors.length === 0, errors.slice(0, 5).join(' | ')])
await check('nothing loaded from outside the folder', async () => { const ext = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')); return [ext.length === 0, ext.slice(0, 5).join(' ')] })
await check('no image, texture or model files loaded', async () => { const a = requests.filter((u) => u.startsWith(origin) && assetExt.test(new URL(u).pathname)); return [a.length === 0, a.slice(0, 5).join(' ')] })
const files = fs.readdirSync(dir, { recursive: true }).filter((f) => !f.startsWith('vendor') && !f.includes('node_modules') && /\.(glb|gltf|fbx|obj|hdr|exr|ktx2)$/i.test(f))
expect('no model or HDR files in the folder', files.length === 0, files.join(' '))

ws.close()
try { process.kill(-chrome.pid, 'SIGKILL') } catch {}
server.close()
if (process.argv[3] === undefined) fs.rmSync(out, { recursive: true, force: true })
done()
