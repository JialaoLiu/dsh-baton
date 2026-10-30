// Evidence for a finished run that does not come from the Harness model: which files the run
// created, changed or deleted (a snapshot of the folder taken at dsh_send, compared when the
// run ends), and the result of check commands the client gave with dsh_send, run here by
// dsh-baton in that folder. The Harness reply can say "all tests pass"; this says whether
// they do. Kept in a file per run, because the client may wait from another process.
// It also says how the code is laid out (structure.mjs).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { structureOf, codeLines } from './structure.mjs'

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target'])
const MAX_FILES = 3000
const MAX_TEXT = 512 * 1024
const CHECK_TIMEOUT_MS = 120_000
const CHECKS_TOTAL_MS = 180_000
const TAIL_LINES = 15

const safe = (id) => String(id).replace(/[^\w.-]/g, '_')
const fileOf = (home, runId) => path.join(home, 'evidence', `${safe(runId)}.json`)
// The code file sizes in a session's folder when dsh-baton first sent to it, so a file
// that grows run after run in one session is seen as a whole.
const startOf = (home, sessionId) => path.join(home, 'evidence-sessions', `${safe(sessionId)}.json`)
const newest = (dir, keep) => {
  const old = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(keep)
  for (const { n } of old) fs.rmSync(path.join(dir, n), { force: true })
}

// path -> { hash, lines } for the files under dir (bounded; big or binary files keep only a hash).
function snapshot(dir) {
  const files = {}
  let count = 0, truncated = false
  const walk = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (count >= MAX_FILES) { truncated = true; return }
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue }
      if (!e.isFile()) continue
      count++
      try {
        const buf = fs.readFileSync(p)
        const text = buf.length <= MAX_TEXT && !buf.includes(0)
        files[path.relative(dir, p).split(path.sep).join('/')] = {
          hash: crypto.createHash('sha1').update(buf).digest('hex'),
          lines: text ? (buf.length ? buf.toString('utf8').split('\n').length - (buf.at(-1) === 10 ? 1 : 0) : 0) : null,
        }
      } catch { /* unreadable: left out */ }
    }
  }
  walk(dir)
  return { files, truncated }
}

export function prepare(home, { run_id, cwd, checks, session_id, max_file_lines = 0 }) {
  if (!run_id || !cwd || !fs.existsSync(cwd)) return
  try {
    fs.mkdirSync(path.join(home, 'evidence'), { recursive: true, mode: 0o700 })
    const list = Array.isArray(checks) ? checks.filter((c) => typeof c === 'string' && c.trim()).slice(0, 10) : []
    const before = snapshot(cwd)
    let start = null
    if (session_id) {
      const file = startOf(home, session_id)
      try { start = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first send to it */ }
      if (start?.cwd !== cwd) {
        start = { cwd, lines: codeLines(before.files) }
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, JSON.stringify(start), { mode: 0o600 })
        newest(path.dirname(file), 50)
      }
    }
    fs.writeFileSync(fileOf(home, run_id), JSON.stringify({ cwd, checks: list, before, start: start?.lines ?? null, max_file_lines, at: Date.now() }), { mode: 0o600 })
    // Keep the folder small: the 50 newest runs.
    newest(path.join(home, 'evidence'), 50)
  } catch { /* evidence is extra; sending never fails over it */ }
}

function runCheck(command, cwd, timeout) {
  const t0 = Date.now()
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1' } })
  const out = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`.trimEnd().split('\n')
  return {
    command,
    exit_code: r.status,
    passed: r.status === 0,
    ...(r.error?.code === 'ETIMEDOUT' || r.signal ? { timed_out: true } : {}),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    output_tail: out.slice(-TAIL_LINES).join('\n'),
  }
}

// The evidence for a run that ended, computed once and then read back.
export function collect(home, runId) {
  const file = fileOf(home, runId)
  let rec
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  if (rec.result) return rec.result
  const after = snapshot(rec.cwd)
  const before = rec.before.files
  const created = [], modified = [], deleted = []
  for (const [p, f] of Object.entries(after.files)) {
    if (!before[p]) created.push({ path: p, lines: f.lines })
    else if (before[p].hash !== f.hash) modified.push({ path: p, lines_before: before[p].lines, lines_after: f.lines })
  }
  for (const p of Object.keys(before)) if (!after.files[p]) deleted.push(p)
  const checks = []
  const deadline = Date.now() + CHECKS_TOTAL_MS
  for (const c of rec.checks) {
    const left = deadline - Date.now()
    checks.push(left > 1000 ? runCheck(c, rec.cwd, Math.min(CHECK_TIMEOUT_MS, left)) : { command: c, skipped: 'out of time' })
  }
  const structure = structureOf(before, after.files, rec.start, rec.max_file_lines)
  const result = {
    source: 'dsh-baton, not the Harness model',
    changes: { created, modified, deleted, ...(after.truncated || rec.before.truncated ? { truncated: true } : {}) },
    ...(structure ? { structure } : {}),
    ...(checks.length ? { checks, all_checks_passed: checks.every((c) => c.passed) } : {}),
  }
  try { fs.writeFileSync(file, JSON.stringify({ ...rec, before: undefined, start: undefined, result }), { mode: 0o600 }) } catch { /* recomputed next time */ }
  return result
}
