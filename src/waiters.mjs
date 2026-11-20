// Background waits: a wait_command the client runs in the background leaves a file named
// <run_id>.<pid> in ~/.dsh-baton/waiting while it waits. dsh_wait reads them, so a client
// that already waits in the background for a run is told so at once instead of waiting a
// second time in the foreground (Claude Code did that on 2026-11-19, a minute a call, while
// its background waits were still running).
import fs from 'node:fs'
import path from 'node:path'
import { batonHome } from '../host/lib/socket.js'

const dir = (home = batonHome()) => path.join(home, 'waiting')
const safe = (id) => /^[\w.-]+$/.test(id ?? '')

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// Marks this process as waiting for runId until it exits. Returns the function that clears it.
export function markWaiting(runId, { pid = process.pid, home } = {}) {
  if (!safe(runId)) return () => {}
  const file = path.join(dir(home), `${runId}.${pid}`)
  try {
    fs.mkdirSync(dir(home), { recursive: true })
    fs.writeFileSync(file, String(Date.now()))
  } catch { return () => {} }
  const clear = () => { try { fs.unlinkSync(file) } catch { /* gone already */ } }
  process.once('exit', clear)
  return clear
}

// Whether a live process waits for runId in the background. Files left by a process that is
// gone (killed without its exit handler) are removed on the way.
export function waitingInBackground(runId, { home } = {}) {
  if (!safe(runId)) return false
  let names
  try { names = fs.readdirSync(dir(home)) } catch { return false }
  let found = false
  for (const name of names) {
    if (!name.startsWith(`${runId}.`)) continue
    const pid = Number(name.slice(runId.length + 1))
    if (pid > 0 && alive(pid)) { found = true; continue }
    try { fs.unlinkSync(path.join(dir(home), name)) } catch { /* removed meanwhile */ }
  }
  return found
}
