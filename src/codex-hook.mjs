// Waking Codex when a run ends. Codex has no wake-on-exit for background commands, but it
// runs Stop hooks when a turn ends: a hook that prints {"decision":"block","reason"} makes
// Codex feed reason back to the model in the same turn. `dsh-baton codex-stop-hook` is such
// a hook: after dsh_send the model ends its turn, the hook waits for the run without any
// model requests, and returns the result as dsh_wait would. One wake instead of a dsh_wait
// call every few minutes. See docs/benchmarks/token-usage-2026-10/wake-test/REPORT.md.
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'
import { codexConfigPath, stableNodePath, codexHookCommand, codexHookStatus, HOOK_TIMEOUT_S } from './register.mjs'

export { editCodexHook, HOOK_TIMEOUT_S } from './register.mjs'

const dir = () => path.join(core.config.batonHome, 'codex-hook')
const pendingFile = () => path.join(dir(), 'pending.json')
// Touched every time Codex runs the hook, so the server knows the hook is installed,
// trusted and firing (an untrusted or edited hook never runs).
const aliveFile = () => path.join(dir(), 'alive')

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) } catch { return {} }
}
function writePending(p) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const tmp = `${pendingFile()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
  fs.renameSync(tmp, pendingFile())
}

// The Codex conversation a tool call came from (every Codex tools/call carries it).
export const threadOf = (meta) => meta?.threadId ?? meta?.['x-codex-turn-metadata']?.thread_id ?? null

export function remember(threadId, runId) {
  if (!threadId || !runId) return
  writePending({ ...readPending(), [runId]: { thread: threadId, delivered: null, at: Date.now() } })
}

// The model got this result itself (dsh_wait): the hook must not deliver it again.
export function delivered(runId, st) {
  const p = readPending()
  if (!p[runId]) return
  if (st?.needs_input) p[runId] = { ...p[runId], delivered: questionKey(st) }
  else delete p[runId]
  writePending(p)
}

const questionKey = (st) => `${st.needs_input}:${JSON.stringify(st.question?.questions?.map((q) => q.id ?? q.question) ?? st.waiting_on ?? null)}`

// The hook is in Codex's config and has run since that config last changed: an edited
// hook needs trusting again and does not run until then.
export function hookActive(configFile = codexConfigPath()) {
  try {
    if (!fs.readFileSync(configFile, 'utf8').includes('codex-stop-hook')) return false
    return fs.statSync(aliveFile()).mtimeMs >= fs.statSync(configFile).mtimeMs
  } catch {
    return false
  }
}

// The hook is in Codex's config but the user has not trusted it (see codexHookStatus).
export function hookUntrusted() {
  try {
    const st = codexHookStatus()
    return st.installed && !st.trusted
  } catch {
    return false
  }
}

// Each Codex conversation is told about trusting the hook once.
const notedFile = () => path.join(dir(), 'trust-noted.json')
export function noteOnce(thread) {
  if (!thread) return false
  let seen = []
  try { seen = JSON.parse(fs.readFileSync(notedFile(), 'utf8')) } catch { /* none yet */ }
  if (seen.includes(thread)) return false
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(notedFile(), JSON.stringify([...seen.slice(-199), thread]))
  return true
}

// What the model is told when the run ends: the same result dsh_wait returns.
function reasonFor(runId, result) {
  return `dsh-baton: the Harness run ${runId} you handed over with dsh_send has ${result.needs_input ? 'stopped to ask a question' : `ended (${result.state})`}. This is its result, as dsh_wait would return it; act on it now (follow its hint):\n${JSON.stringify(result)}`
}

// The node and cli.mjs this hook process runs as (what Codex trusted).
function ranAs() {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
  return { node: real(process.execPath), cli: real(process.argv[1] ?? '') }
}

// One Stop-hook call. input is the JSON Codex writes to stdin; shape(st) turns a run's
// state into what dsh_wait returns. Returns the JSON to print, or null to let the turn end.
export async function runHook(input, { shape, wait = core.api.wait, now = Date.now, chunk_s = 10, self = ranAs() } = {}) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(aliveFile(), JSON.stringify({ at: now(), ...self }))
  const thread = input?.session_id
  if (!thread) return null
  const deadline = now() + (HOOK_TIMEOUT_S - 60) * 1000
  for (;;) {
    const mine = Object.entries(readPending()).filter(([, v]) => v.thread === thread)
    if (!mine.length) return null
    let open = 0
    for (const [runId, entry] of mine) {
      let st
      try {
        st = await wait({ run_id: runId, timeout_s: chunk_s })
      } catch (e) {
        // Harness not answering (quit or restarting): keep waiting, it may come back.
        await new Promise((r) => setTimeout(r, chunk_s * 1000))
        open++
        continue
      }
      if (st.timed_out) { open++; continue }
      // A question already passed on: the turn ends so the user (or the model) can answer.
      if (st.needs_input && entry.delivered === questionKey(st)) continue
      delivered(runId, st)
      return { decision: 'block', reason: reasonFor(runId, shape(st)) }
    }
    if (!open) return null
    if (now() > deadline) return null
  }
}

// The hook entry for Codex's config.toml (see register.mjs, which also writes it).
export function hookCommand(root = core.ROOT, node = stableNodePath()) {
  return codexHookCommand(node, path.join(root, 'src', 'server.mjs'))
}
