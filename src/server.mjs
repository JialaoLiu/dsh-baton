#!/usr/bin/env node
// What MCP clients start: a thin shell that holds the stdio connection and passes every
// message to the server proper (mcp.mjs), run as a child process. Before each tools/list
// and tools/call it checks package.json; when a newer copy was installed over this folder
// (by the Harness plugin, setup or by hand) it starts a fresh child from the new files and
// sends the call there, so an open conversation uses the new version without a restart or
// a reconnect. Calls still running in the old child (a long dsh_wait) finish there first.
// If the new child cannot start, the old one keeps serving and the reply says why.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = Number(process.env.DSH_BATON_START_TIMEOUT_MS) || 15000

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// What identifies an installed copy: its version, and the time package.json was written
// (a copy with the same version, such as a test build, still counts as new). The installer
// writes package.json after src, so a new stamp means the new files are in place.
function stamp() {
  try {
    const file = path.join(ROOT, 'package.json')
    return `${JSON.parse(fs.readFileSync(file, 'utf8')).version}@${fs.statSync(file).mtimeMs}`
  } catch {
    return null
  }
}

let nextInternal = 0
const CANCELLED = Symbol('cancelled') // a client call whose reply is not passed on
const children = new Set()

function startChild() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  })
  const child = {
    proc,
    clientCalls: new Map(), // client request id -> optional rewrite of the result
    internal: new Map(), // the shell's own requests: id -> { resolve, reject }
    retired: false,
    exited: false,
    write(msg) { if (!this.exited && proc.stdin.writable) proc.stdin.write(JSON.stringify(msg) + '\n') },
    request(method, params) {
      const id = `dsh-baton-shell-${++nextInternal}`
      return new Promise((resolve, reject) => {
        this.internal.set(id, { resolve, reject })
        this.write({ jsonrpc: '2.0', id, method, params })
      })
    },
    // Stop taking calls; it exits on its own once the last one it holds has answered.
    retire() { this.retired = true; this.closeIfIdle() },
    closeIfIdle() { if (this.retired && this.clientCalls.size === 0 && this.internal.size === 0) proc.stdin.end() },
  }
  children.add(child)
  proc.stdin.on('error', () => {})
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const own = child.internal.get(msg.id)
    if (own) {
      child.internal.delete(msg.id)
      msg.error ? own.reject(new Error(msg.error.message)) : own.resolve(msg.result)
    } else if (msg.id !== undefined && child.clientCalls.has(msg.id)) {
      const rewrite = child.clientCalls.get(msg.id)
      child.clientCalls.delete(msg.id)
      if (rewrite !== CANCELLED) send(rewrite && msg.result ? { ...msg, result: rewrite(msg.result) } : msg)
    } else {
      send(msg) // notifications (progress) and replies to malformed requests
    }
    child.closeIfIdle()
  })
  proc.on('error', () => {})
  proc.on('exit', (code) => {
    child.exited = true
    children.delete(child)
    for (const [id, rewrite] of child.clientCalls) if (rewrite !== CANCELLED) send({ jsonrpc: '2.0', id, error: { code: -32603, message: `The dsh-baton server process stopped (exit code ${code}).` } })
    for (const [, own] of child.internal) own.reject(new Error(`exited with code ${code}`))
    child.clientCalls.clear()
    child.internal.clear()
    if (current === child) current = null
    exitIfDone()
  })
  return child
}

let current = null
let currentStamp = null
let currentVersion = null
let failedStamp = null
let initParams = null
let lastTools = null // the tool list the client last saw, to tell it when that changes
let note = null // said once, with the next tools/call result

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms).unref()),
])

// A child that stopped is replaced on the next message; once the client has initialized,
// the replacement is initialized the same way before it takes calls.
async function ensureChild() {
  if (current) return current
  currentStamp = stamp()
  const child = current = startChild()
  if (initParams) {
    try {
      const init = await withTimeout(child.request('initialize', initParams), START_TIMEOUT_MS, 'The restarted server')
      currentVersion = init?.serverInfo?.version ?? currentVersion
      child.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    } catch { /* its calls then fail with the reason */ }
  }
  return child
}

// Start a child from the newly installed files and make it the one that takes calls.
async function reloadIfInstalled() {
  if (!initParams || !current) return
  const now = stamp()
  if (!now || now === currentStamp || now === failedStamp) return
  const next = startChild()
  try {
    const init = await withTimeout(next.request('initialize', initParams), START_TIMEOUT_MS, 'The new version')
    next.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const { tools } = await withTimeout(next.request('tools/list', {}), START_TIMEOUT_MS, 'The new version')
    // What the old version had, to name what is new (the client may not show new tools).
    const had = await withTimeout(current.request('tools/list', {}), 5000, 'The old version').then((r) => r.tools.map((t) => t.name), () => null)
    const added = had ? tools.map((t) => t.name).filter((n) => !had.includes(n)) : []
    const before = currentVersion
    current.retire()
    current = next
    currentStamp = now
    currentVersion = init?.serverInfo?.version ?? null
    note = `dsh-baton was updated from ${before} to ${currentVersion} without a restart; this call already used ${currentVersion}.` +
      (added.length ? ` New in this version: ${added.join(', ')}. If this conversation does not show them, call them through dsh_call {name, arguments}.` : '')
    if (lastTools !== null && JSON.stringify(tools) !== lastTools) {
      lastTools = JSON.stringify(tools)
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
  } catch (e) {
    next.proc.kill()
    failedStamp = now
    const version = now.split('@')[0]
    note = `A new dsh-baton (${version}) is installed but could not be started (${e.message}); this call still used ${currentVersion}. Restart this client to load it, or reinstall.`
  }
}

const appendNote = (result) => {
  if (!note || !Array.isArray(result.content)) return result
  const text = note
  note = null
  return { ...result, content: [...result.content, { type: 'text', text: `Note for the user: ${text}` }] }
}

async function route(line) {
  let msg
  try { msg = JSON.parse(line) } catch { msg = null }
  const ok = msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.method === 'string'
  if (!ok) return (await ensureChild()).proc.stdin.write(line + '\n') // the child sends the error reply

  if (msg.id === undefined) {
    // A cancellation goes to the child running that call; other notifications to the current one.
    // The client gets no reply to a cancelled call: the child's (it stops within seconds) is dropped.
    if (msg.method === 'notifications/cancelled') {
      for (const c of children) {
        if (!c.clientCalls.has(msg.params?.requestId)) continue
        c.clientCalls.set(msg.params.requestId, CANCELLED)
        return c.write(msg)
      }
      return
    }
    return current?.write(msg)
  }

  let rewrite = null
  if (msg.method === 'initialize') {
    await ensureChild()
    initParams = msg.params ?? {}
    rewrite = (result) => {
      currentVersion = result.serverInfo?.version ?? null
      return { ...result, capabilities: { ...result.capabilities, tools: { ...result.capabilities?.tools, listChanged: true } } }
    }
  } else if (msg.method === 'tools/list' || msg.method === 'tools/call') {
    await reloadIfInstalled()
    rewrite = msg.method === 'tools/list'
      ? (result) => { lastTools = JSON.stringify(result.tools); return result }
      : appendNote
  }
  const child = await ensureChild()
  child.clientCalls.set(msg.id, rewrite)
  child.write(msg)
}

// Messages are passed on in the order they came, even while a new child starts.
let queue = Promise.resolve()
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  queue = queue.then(() => route(line)).catch((e) => process.stderr.write(`dsh-baton: ${e.stack ?? e}\n`))
})

// Exit once the client is gone and every child has answered and stopped.
let stdinClosed = false
function exitIfDone() {
  if (stdinClosed && children.size === 0) process.stdout.write('', () => process.exit(0))
}
rl.on('close', () => {
  stdinClosed = true
  queue.then(() => {
    for (const c of children) c.retire()
    exitIfDone()
  })
})
// The parent process died and we were re-parented (or, on Windows, the parent is gone).
const parentPid = process.ppid
const parentGone = () => {
  if (process.platform !== 'win32') return false
  try { process.kill(parentPid, 0); return false } catch (e) { return e.code !== 'EPERM' }
}
setInterval(() => {
  if (process.ppid !== parentPid || parentGone()) {
    for (const c of children) c.proc.kill()
    process.exit(0)
  }
}, 5000).unref()
