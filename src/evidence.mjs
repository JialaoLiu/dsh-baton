// Evidence for a finished run that does not come from the Harness model: which files the run
// created, changed or deleted (a snapshot of the folder taken at dsh_send, compared when the
// run ends), and the result of check commands the client gave with dsh_send, run here by
// dsh-baton in that folder. The Harness reply can say "all tests pass"; this says whether
// they do. Kept in a file per run, because the client may wait from another process.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.gradle'])
// Files no one wrote on purpose.
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])
// Files looked at (by size and time only) and, of those, the newest read at dsh_send for a
// line count and hash. A folder full of reference material (thousands of files) used to fill
// a 3000-file cap in directory order, so the files the run worked on were never seen.
const MAX_ENTRIES = 100_000
const MAX_READ = 3000
const MAX_TEXT = 512 * 1024
const CHECK_TIMEOUT_MS = 120_000
const CHECKS_TOTAL_MS = 180_000
const TAIL_LINES = 15
const DAY_MS = 24 * 3600 * 1000

const fileOf = (home, runId) => path.join(home, 'evidence', `${String(runId).replace(/[^\w.-]/g, '_')}.json`)
// The folder snapshot taken at dsh_send, apart from the small record: it can be megabytes, and
// the records of other runs are read for every collect.
const beforeOf = (file) => file.replace(/\.json$/, '.before.json')
const isBefore = (name) => name.endsWith('.before.json')

function git(dir, args) {
  try {
    // quotePath off: file names with Chinese or other non-ASCII letters come back as they are.
    const r = spawnSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : null
  } catch { return null }
}

// Git worktrees the run made inside the folder (Harness's "Git worktree" plugin puts them in
// .agents/worktrees and moves the session there): a new ".git" file that points at the
// repository. Newest last, as the session works in the last one it entered.
const WORKTREE_GITDIR = /[\\/]worktrees[\\/]/
function newWorktrees(cwd, created) {
  const out = []
  for (const c of created) {
    if (path.posix.basename(c.path) !== '.git') continue
    const dir = path.posix.dirname(c.path)
    if (dir === '.') continue
    try {
      const abs = path.join(cwd, c.path)
      // A linked worktree points into <repo>/.git/worktrees/; a submodule (.git/modules/) is not one.
      const text = fs.readFileSync(abs, 'utf8')
      if (text.startsWith('gitdir:') && WORKTREE_GITDIR.test(text)) out.push({ dir, at: fs.statSync(abs).mtimeMs })
    } catch { /* not a worktree */ }
  }
  return out.sort((a, b) => a.at - b.at).map((w) => w.dir)
}

// The worktrees git knows of for the repository around dir, as real paths; null outside one.
function listWorktrees(dir) {
  const out = git(dir, ['worktree', 'list', '--porcelain'])
  if (out == null) return null
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => realPath(l.slice('worktree '.length).trim()))
}
// The native call, as git reports paths: on Windows it also expands 8.3 short names (RUNNER~1).
const realPath = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }

// What a worktree changed against the commit the folder was on at dsh_send: committed and
// uncommitted alike, from git rather than a copy of the whole checkout. With no such commit,
// what is uncommitted in it. A git command that fails or times out marks the list incomplete.
function worktreeChanges(abs, base) {
  const created = [], modified = [], deleted = []
  let incomplete = false
  const run = (args) => { const out = git(abs, args); if (out == null) incomplete = true; return out ?? '' }
  if (base) {
    for (const line of run(['diff', '--name-status', '--no-renames', base]).split('\n')) {
      const [st, p] = line.split('\t')
      if (!p) continue
      ;(st === 'A' ? created : st === 'D' ? deleted : modified).push(p)
    }
  } else {
    for (const line of run(['status', '--porcelain=v1', '--untracked-files=no']).split('\n')) {
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      const p = line.slice(3).replace(/^.* -> /, '')
      ;(code.includes('A') ? created : code.includes('D') ? deleted : modified).push(p)
    }
  }
  for (const p of run(['ls-files', '--others', '--exclude-standard']).split('\n')) if (p && !created.includes(p)) created.push(p)
  const commits = base ? Number.parseInt(git(abs, ['rev-list', '--count', `${base}..HEAD`]) ?? '', 10) : NaN
  return {
    path: abs,
    branch: git(abs, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null,
    ...(base ? { base_commit: base } : {}),
    ...(Number.isFinite(commits) ? { commits } : {}),
    changes: { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() },
    ...(incomplete ? { incomplete: true } : {}),
  }
}

// The files under dir, skipping dependency, build and cache folders: [{ rel, abs, m, s }].
function walk(dir) {
  const out = []
  let truncated = false
  const visit = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) { truncated = true; return }
      const abs = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) visit(abs); continue }
      if (!e.isFile() || SKIP_FILES.has(e.name)) continue
      try {
        const st = fs.statSync(abs)
        out.push({ rel: path.relative(dir, abs).split(path.sep).join('/'), abs, m: st.mtimeMs, s: st.size })
      } catch { /* gone or unreadable: left out */ }
    }
  }
  visit(dir)
  return { list: out, truncated }
}

// hash and line count (null for a binary file), or null when it cannot be read. A file over
// MAX_TEXT (by its size from walk) is not read: no hash, lines null.
function readFile(abs, size = 0) {
  if (size > MAX_TEXT) return { lines: null }
  try {
    const buf = fs.readFileSync(abs)
    const text = buf.length <= MAX_TEXT && !buf.includes(0)
    return {
      hash: crypto.createHash('sha1').update(buf).digest('hex'),
      lines: text ? (buf.length ? buf.toString('utf8').split('\n').length - (buf.at(-1) === 10 ? 1 : 0) : 0) : null,
    }
  } catch { return null }
}

// path -> { m, s } for every file under dir, plus hash and lines for the newest MAX_READ.
function snapshot(dir) {
  const { list, truncated } = walk(dir)
  const files = {}
  for (const f of list) files[f.rel] = { m: f.m, s: f.s }
  for (const f of [...list].sort((a, b) => b.m - a.m).slice(0, MAX_READ)) Object.assign(files[f.rel], readFile(f.abs, f.s) ?? {})
  return { files, truncated }
}

// The files under dir changed since a time, for a follow report: how many, per folder, and
// the newest by name (progress notes such as STATUS or CHECKLIST files first).
const PROGRESS_FILE = /status|checklist|progress|todo|changelog|plan/i
export function changedSince(dir, sinceMs, { max = 20 } = {}) {
  if (!dir || !fs.existsSync(dir)) return null
  const { list, truncated } = walk(dir)
  const changed = list.filter((f) => f.m > sinceMs).sort((a, b) => b.m - a.m)
  const folders = new Map()
  for (const f of changed) { const d = path.posix.dirname(f.rel); folders.set(d, (folders.get(d) ?? 0) + 1) }
  const progress = changed.filter((f) => PROGRESS_FILE.test(path.posix.basename(f.rel)))
  const files = [...progress, ...changed.filter((f) => !progress.includes(f))].slice(0, max).map((f) => f.rel)
  return {
    count: changed.length,
    folders: [...folders].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([folder, count]) => ({ folder, count })),
    files,
    ...(changed.length > files.length ? { files_not_listed: changed.length - files.length } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}

export function prepare(home, { run_id, session_id = null, cwd, checks }) {
  if (!run_id || !cwd || !fs.existsSync(cwd)) return
  try {
    fs.mkdirSync(path.join(home, 'evidence'), { recursive: true, mode: 0o700 })
    const list = Array.isArray(checks) ? checks.filter((c) => typeof c === 'string' && c.trim()).slice(0, 10) : []
    const file = fileOf(home, run_id)
    fs.writeFileSync(beforeOf(file), JSON.stringify(snapshot(cwd)), { mode: 0o600 })
    const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
    const trees = listWorktrees(cwd)
    fs.writeFileSync(file, JSON.stringify({ cwd, session_id, checks: list, at: Date.now(), ...(head ? { git_head: head } : {}), ...(trees ? { worktrees_before: trees } : {}) }), { mode: 0o600 })
    // Keep the folder small: the 50 newest runs (with their snapshots).
    const dir = path.join(home, 'evidence')
    const old = fs.readdirSync(dir).filter((n) => !isBefore(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(50)
    for (const { n } of old) { fs.rmSync(path.join(dir, n), { force: true }); fs.rmSync(beforeOf(path.join(dir, n)), { force: true }) }
  } catch { /* evidence is extra; sending never fails over it */ }
}

// The run's check commands run again now (not kept): for a run whose wait followed its goal
// to the end, the checks then are the ones that count. Within budgetMs in all.
export function recheck(home, runId, budgetMs = CHECKS_TOTAL_MS) {
  let rec
  try { rec = JSON.parse(fs.readFileSync(fileOf(home, runId), 'utf8')) } catch { return null }
  // The worktree the run moved into: from collect, or else the newest one git lists now that it
  // did not at dsh_send (a goal followed to its end may recheck before any collect).
  const listedBefore = Array.isArray(rec.worktrees_before) ? rec.worktrees_before : null
  const moved = rec.checks_cwd ?? (listedBefore ? (listWorktrees(rec.cwd) ?? []).filter((p) => !listedBefore.includes(p)).at(-1) : undefined)
  const dir = moved && fs.existsSync(moved) ? moved : rec.cwd
  if (!rec.checks?.length || !fs.existsSync(dir)) return null
  const deadline = Date.now() + Math.min(budgetMs, CHECKS_TOTAL_MS)
  return rec.checks.map((c) => { const left = deadline - Date.now(); return left > 1000 ? runCheck(c, dir, Math.min(CHECK_TIMEOUT_MS, left)) : { command: c, skipped: 'out of time' } })
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

// When another run ended. Many are never collected here (one steered into another, one
// stopped by a restart), so the plugin's own record of the run comes first; then the end
// noted here (0.6.4 on), or the time an older record's result was written. One with neither
// counts as running for a day at most.
function endedAt(home, runId, rec, mtime) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(home, 'host-runs', `${runId}.json`), 'utf8'))
    if (['queued', 'running', 'waiting'].includes(run.state)) return Infinity
    const t = Date.parse(run.endedAt)
    if (t) return t
  } catch { /* not a host run, or no record */ }
  return rec.ended_at ?? (rec.result ? mtime : rec.at + DAY_MS)
}

// The evidence for a run that ended, computed once and then read back.
export function collect(home, runId) {
  const file = fileOf(home, runId)
  let rec
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  if (rec.result) return rec.result
  // A record from before 0.6.5 carries its snapshot inline.
  let snap = rec.before
  if (!snap) { try { snap = JSON.parse(fs.readFileSync(beforeOf(file), 'utf8')) } catch { return null } }
  const after = walk(rec.cwd)
  const before = snap.files
  const created = [], modified = [], deleted = []
  const seen = new Set()
  // At most MAX_READ files are read here too (a run that writes thousands of files gets their
  // paths, not their line counts).
  let reads = 0
  const read = (f, whole = false) => (reads++ < MAX_READ ? readFile(f.abs, whole ? 0 : f.s) : null)
  for (const f of after.list) {
    seen.add(f.rel)
    const b = before[f.rel]
    if (!b) { created.push({ path: f.rel, lines: read(f)?.lines ?? null }); continue }
    // Same size and time: unchanged. Otherwise the content decides when it was read before
    // (a record from before 0.6.5 has only the hash).
    if (b.m === f.m && b.s === f.s) continue
    // A record from before 0.6.5 has a hash of every file, big ones too: read it whole to compare.
    const now = b.hash || b.m === undefined ? read(f, b.m === undefined) : null
    if (b.hash && now?.hash === b.hash) continue
    modified.push({ path: f.rel, lines_before: b.lines ?? null, lines_after: (now ?? read(f))?.lines ?? null })
  }
  for (const p of Object.keys(before)) if (!seen.has(p)) deleted.push(p)
  // A worktree made during the run is a whole checkout: its files are not the run's work. Its
  // changes come from git instead, and the checks run in the newest one, where the session went.
  // Found two ways: a new ".git" file in the folder, and a new entry in git's own worktree list
  // (one outside the folder, such as the repository root's .agents/worktrees when the work
  // folder is a subfolder, or one past a folder snapshot that was cut off).
  const inFolder = newWorktrees(rec.cwd, created).map((d) => realPath(path.join(rec.cwd, d)))
  const listedBefore = Array.isArray(rec.worktrees_before) ? rec.worktrees_before : null
  const listedNew = listedBefore ? (listWorktrees(rec.cwd) ?? []).filter((p) => !listedBefore.includes(p)) : []
  const mtime = (p) => { try { return fs.statSync(path.join(p, '.git')).mtimeMs } catch { return 0 } }
  const trees = [...new Set([...inFolder, ...listedNew])].sort((a, b) => mtime(a) - mtime(b))
  let worktrees = []
  if (trees.length) {
    const root = realPath(rec.cwd)
    const inside = trees.map((t) => path.relative(root, t)).filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r)).map((r) => r.split(path.sep).join('/'))
    // The .gitignore Harness writes in the folder that holds its worktrees goes with them.
    const holders = new Set(inside.map((d) => path.posix.dirname(d)).filter((d) => /(^|\/)\.agents\/worktrees$/.test(d)))
    const drop = (p) => inside.some((d) => p === d || p.startsWith(`${d}/`)) || (holders.has(path.posix.dirname(p)) && path.posix.basename(p) === '.gitignore')
    for (const list of [created, modified]) list.splice(0, list.length, ...list.filter((f) => !drop(f.path)))
    deleted.splice(0, deleted.length, ...deleted.filter((p) => !drop(p)))
    // The commit the folder was on at dsh_send (a record from before 0.6.15 has none: the folder's
    // HEAD now), and per worktree where it left that line, so its own commits count.
    const main = rec.git_head ?? git(rec.cwd, ['rev-parse', 'HEAD'])?.trim()
    worktrees = trees.map((abs) => worktreeChanges(abs, main ? (git(abs, ['merge-base', 'HEAD', main])?.trim() || main) : null))
  }
  // A later send to a session that already works in a worktree: the folder itself is that
  // worktree, and its changes above are this run's. Said, so the client knows where they are.
  if (!worktrees.length) {
    try {
      const text = fs.readFileSync(path.join(rec.cwd, '.git'), 'utf8')
      if (text.startsWith('gitdir:') && WORKTREE_GITDIR.test(text)) {
        worktrees = [{ path: rec.cwd, branch: git(rec.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null, changes_in: 'changes' }]
      }
    } catch { /* not a worktree */ }
  }
  const checksCwd = worktrees.length ? worktrees.at(-1).path : rec.cwd
  created.sort((a, b) => a.path.localeCompare(b.path))
  modified.sort((a, b) => a.path.localeCompare(b.path))
  deleted.sort()
  // Other runs in the same folder at the same time: their changes show up here too, and
  // cannot be told from this run's.
  const now = Date.now()
  const overlapping = []
  try {
    for (const n of fs.readdirSync(path.join(home, 'evidence'))) {
      if (isBefore(n)) continue
      const other = n.replace(/\.json$/, '')
      if (other === String(runId).replace(/[^\w.-]/g, '_')) continue
      let o, mtime
      try { mtime = fs.statSync(path.join(home, 'evidence', n)).mtimeMs; o = JSON.parse(fs.readFileSync(path.join(home, 'evidence', n), 'utf8')) } catch { continue }
      // A run of the same session (one steered into this one) is the same work.
      if (o.cwd !== rec.cwd || (rec.session_id && o.session_id === rec.session_id)) continue
      if (o.at <= now && endedAt(home, other, o, mtime) >= rec.at) overlapping.push(other)
    }
  } catch { /* no others */ }
  const checks = []
  const deadline = Date.now() + CHECKS_TOTAL_MS
  for (const c of rec.checks) {
    const left = deadline - Date.now()
    checks.push(left > 1000 ? runCheck(c, checksCwd, Math.min(CHECK_TIMEOUT_MS, left)) : { command: c, skipped: 'out of time' })
  }
  const result = {
    source: 'dsh-baton, not the Harness model',
    changes: { created, modified, deleted, ...(after.truncated || snap.truncated ? { truncated: true } : {}) },
    ...(worktrees.length ? { worktrees, ...(checks.length ? { checks_folder: checksCwd } : {}) } : {}),
    ...(overlapping.length ? { same_folder_runs: overlapping } : {}),
    ...(checks.length ? { checks, all_checks_passed: checks.every((c) => c.passed) } : {}),
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ ...rec, before: undefined, result, ended_at: now, ...(checksCwd !== rec.cwd ? { checks_cwd: checksCwd } : {}) }), { mode: 0o600 })
    fs.rmSync(beforeOf(file), { force: true })
  } catch { /* recomputed next time */ }
  return result
}
