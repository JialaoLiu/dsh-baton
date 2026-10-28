// Shared helpers for the acceptance tests: start the app on a free port with its own data folder,
// call the HTTP API, and drive headless Chrome over the DevTools protocol.
// Do not edit: the acceptance run replaces this folder with its own copy.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')

export const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

// Starts `node server.mjs` with PORT and DATA_DIR set. Pass dataDir to reuse a folder (restart tests).
export async function startApp({ dataDir, env = {} } = {}) {
  const port = await freePort()
  const data = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tsumiki-data-'))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: data, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    if (child.exitCode !== null || i > 100) throw new Error(`server did not start on ${base}\n${log}`)
    await sleep(100)
  }
  const stop = async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  return { base, port, dataDir: data, stop, log: () => log }
}

// JSON request. Returns { status, body, headers }; body is parsed JSON, or text when not JSON.
export async function api(base, method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] ??= 'application/json'
  }
  const res = await fetch(base + url, init)
  const text = await res.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, body: parsed, headers: res.headers, text }
}

// Builds a board with the given columns and card titles: { board, cols: [{ id, cards: [ids] }] }.
export async function seedBoard(base, name, columns) {
  const board = (await api(base, 'POST', '/api/boards', { name })).body
  const cols = []
  for (const [colName, titles] of columns) {
    const col = (await api(base, 'POST', `/api/boards/${board.id}/columns`, { name: colName })).body
    const cards = []
    for (const title of titles) cards.push((await api(base, 'POST', `/api/columns/${col.id}/cards`, { title })).body.id)
    cols.push({ id: col.id, cards })
  }
  return { board, cols }
}

export const getBoard = async (base, id, query = '') => (await api(base, 'GET', `/api/boards/${id}${query}`)).body
export const titlesOf = (column) => column.cards.map((c) => c.title)

// Headless Chrome. One browser per test file; pages are tabs.
export async function startBrowser() {
  const cdpPort = await freePort()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tsumiki-chrome-'))
  const bin = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const chrome = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(150) }
  }
  if (!wsUrl) throw new Error('Chrome did not start')
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map(), listeners = new Set()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
    else for (const fn of listeners) fn(m)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

  async function newPage(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const errors = []
    listeners.add((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails?.text)
    })
    const s = (method, params) => send(method, params, sessionId)
    for (const d of ['Page', 'Runtime']) await s(`${d}.enable`)
    // window.confirm/alert/prompt must not block the page: answer them.
    listeners.add((m) => { if (m.sessionId === sessionId && m.method === 'Page.javascriptDialogOpening') s('Page.handleJavaScriptDialog', { accept: true }) })
    const evaluate = async (expression) => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result?.value
    }
    const page = {
      errors,
      evaluate,
      async goto(u) { await s('Page.navigate', { url: u }); await page.waitFor('document.readyState === "complete"') },
      async reload() { await s('Page.reload', {}); await sleep(200); await page.waitFor('document.readyState === "complete"') },
      // Polls a JS expression until truthy (default 5 s). Returns its value.
      async waitFor(expression, timeout = 5000) {
        const end = Date.now() + timeout
        let last
        while (Date.now() < end) {
          try { last = await evaluate(expression); if (last) return last } catch {}
          await sleep(50)
        }
        throw new Error(`timed out waiting for: ${expression}`)
      },
      // CSS selector helpers. `within` scopes to the nth match of a container selector.
      count: (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
      texts: (sel) => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map(e => e.textContent.trim())`),
      visibleCount: (sel) => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null).length`),
      async click(sel) {
        await page.waitFor(`document.querySelector(${JSON.stringify(sel)})`)
        await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`)
      },
      // Sets an input's value the way typing does (input + change events), then optionally presses Enter.
      async type(sel, text, { enter = false } = {}) {
        await page.waitFor(`document.querySelector(${JSON.stringify(sel)})`)
        await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)})
          el.focus()
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          ${enter ? `for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))` : ''}
        })()`)
      },
      close: () => send('Target.closeTarget', { targetId }),
    }
    if (url) await page.goto(url)
    return page
  }

  const close = async () => {
    try { ws.close() } catch {}
    chrome.kill('SIGTERM')
    await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(3000)])
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
    fs.rmSync(profile, { recursive: true, force: true })
  }
  return { newPage, close }
}

// Selector for the column whose title is `name`, and for cards inside it.
export const columnSel = (name) => `[data-testid="column"][data-column-name=${JSON.stringify(name)}]`
export const cardsIn = (name) => `${columnSel(name)} [data-testid="card"]`
