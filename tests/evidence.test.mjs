// Evidence for a finished run comes from dsh-baton, not the Harness reply: files created,
// changed or deleted since dsh_send, and the check commands run in the folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as evidence from '../src/evidence.mjs'
import { execFileSync } from 'node:child_process'

test('changes since dsh_send and check results are reported, once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'a\n')
  fs.writeFileSync(path.join(cwd, 'edit.txt'), 'a\nb\n')
  fs.writeFileSync(path.join(cwd, 'gone.txt'), 'x\n')
  fs.mkdirSync(path.join(cwd, 'node_modules'))
  evidence.prepare(home, { run_id: 'hrun-1', cwd, checks: ['node -e "process.exit(0)"', 'node -e "console.log(\'nope\'); process.exit(3)"'] })
  // The run's work:
  fs.writeFileSync(path.join(cwd, 'edit.txt'), 'a\nb\nc\n')
  fs.writeFileSync(path.join(cwd, 'new.mjs'), 'one\ntwo\n')
  fs.rmSync(path.join(cwd, 'gone.txt'))
  fs.writeFileSync(path.join(cwd, 'node_modules', 'ignored.js'), 'x')
  // Shared IDE settings are work like any other file.
  fs.mkdirSync(path.join(cwd, '.vscode'))
  fs.writeFileSync(path.join(cwd, '.vscode', 'tasks.json'), '{}\n')
  // Caches a test run leaves are not the run's work.
  fs.mkdirSync(path.join(cwd, '.pytest_cache'))
  fs.writeFileSync(path.join(cwd, '.pytest_cache', 'README.md'), 'cache')
  fs.writeFileSync(path.join(cwd, '.DS_Store'), 'x')
  const ev = evidence.collect(home, 'hrun-1')
  assert.deepEqual(ev.changes.created, [{ path: '.vscode/tasks.json', lines: 1 }, { path: 'new.mjs', lines: 2 }])
  assert.deepEqual(ev.changes.modified, [{ path: 'edit.txt', lines_before: 2, lines_after: 3 }])
  assert.deepEqual(ev.changes.deleted, ['gone.txt'])
  assert.equal(ev.checks[0].passed, true)
  assert.equal(ev.checks[1].exit_code, 3)
  assert.match(ev.checks[1].output_tail, /nope/)
  assert.equal(ev.all_checks_passed, false)
  // Computed once: a later change or a second wait does not run the checks again.
  fs.writeFileSync(path.join(cwd, 'later.txt'), 'z\n')
  assert.deepEqual(evidence.collect(home, 'hrun-1'), ev)
  assert.equal(evidence.collect(home, 'hrun-unknown'), null)
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true })
})

test('runs in the same folder at the same time are named in each other\'s evidence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  try {
    evidence.prepare(home, { run_id: 'hrun-a', cwd })
    evidence.prepare(home, { run_id: 'hrun-b', cwd })
    evidence.prepare(home, { run_id: 'hrun-c', cwd: other })
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'from a\n')
    const a = evidence.collect(home, 'hrun-a')
    assert.deepEqual(a.same_folder_runs, ['hrun-b'])
    // b ends after a: a was still at work when b started.
    assert.deepEqual(evidence.collect(home, 'hrun-b').same_folder_runs, ['hrun-a'])
    assert.equal(evidence.collect(home, 'hrun-c').same_folder_runs, undefined, 'another folder')
    // A run started after a and b ended does not count them.
    const later = Date.now() + 5
    while (Date.now() < later) { /* a later millisecond */ }
    evidence.prepare(home, { run_id: 'hrun-d', cwd })
    const d = evidence.collect(home, 'hrun-d')
    assert.deepEqual(d.same_folder_runs, undefined)
    // Records of earlier versions have no end time: one with a result ended when it was
    // written, one never collected and days old is long over.
    const old = path.join(home, 'evidence')
    fs.writeFileSync(path.join(old, 'hrun-old1.json'), JSON.stringify({ cwd, checks: [], at: 1000, result: { changes: {} } }))
    fs.utimesSync(path.join(old, 'hrun-old1.json'), new Date(2000), new Date(2000))
    fs.writeFileSync(path.join(old, 'hrun-old2.json'), JSON.stringify({ cwd, checks: [], at: 1000, before: { files: {} } }))
    const later2 = Date.now() + 5
    while (Date.now() < later2) { /* after d ended */ }
    // Ended by the plugin's own record though never collected here (steered into another run,
    // stopped by a restart); still running by it though old; and one of the same session.
    const runs = path.join(home, 'host-runs')
    fs.mkdirSync(runs)
    fs.writeFileSync(path.join(old, 'hrun-steered.json'), JSON.stringify({ cwd, checks: [], at: Date.now() - 1000, before: { files: {} } }))
    fs.writeFileSync(path.join(runs, 'hrun-steered.json'), JSON.stringify({ state: 'completed', endedAt: new Date(Date.now() - 500).toISOString() }))
    fs.writeFileSync(path.join(old, 'hrun-long.json'), JSON.stringify({ cwd, checks: [], at: 1000, before: { files: {} } }))
    fs.writeFileSync(path.join(runs, 'hrun-long.json'), JSON.stringify({ state: 'running', endedAt: null }))
    fs.writeFileSync(path.join(old, 'hrun-mine.json'), JSON.stringify({ cwd, session_id: 's-e', checks: [], at: Date.now() - 1000, before: { files: {} } }))
    evidence.prepare(home, { run_id: 'hrun-e', session_id: 's-e', cwd })
    assert.deepEqual(evidence.collect(home, 'hrun-e').same_folder_runs, ['hrun-long'])
  } finally {
    for (const d of [home, cwd, other]) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('a folder with thousands of reference files still shows the files the run changed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  try {
    // Read-only material that sorts before the work folder (a 3000-file cap once filled up on it).
    const ref = path.join(cwd, 'a-handoff')
    fs.mkdirSync(ref)
    for (let i = 0; i < 3200; i++) fs.writeFileSync(path.join(ref, `f${i}.txt`), `${i}\n`)
    fs.mkdirSync(path.join(cwd, 'work'))
    fs.writeFileSync(path.join(cwd, 'work', 'app.js'), 'a\nb\n')
    fs.writeFileSync(path.join(cwd, 'work', 'same.js'), 'x\n')
    evidence.prepare(home, { run_id: 'hrun-big', cwd })
    fs.writeFileSync(path.join(cwd, 'work', 'app.js'), 'a\nb\nc\n')
    fs.writeFileSync(path.join(cwd, 'work', 'new.js'), 'n\n')
    // Rewritten with the same content: not a change.
    const later = new Date(Date.now() + 5000)
    fs.writeFileSync(path.join(cwd, 'work', 'same.js'), 'x\n')
    fs.utimesSync(path.join(cwd, 'work', 'same.js'), later, later)
    const ev = evidence.collect(home, 'hrun-big')
    assert.deepEqual(ev.changes.modified, [{ path: 'work/app.js', lines_before: 2, lines_after: 3 }])
    assert.deepEqual(ev.changes.created, [{ path: 'work/new.js', lines: 1 }])
    assert.equal(ev.changes.truncated, undefined)
  } finally {
    for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('a record written before 0.6.5 (hashes only) is still compared by content', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  try {
    fs.writeFileSync(path.join(cwd, 'kept.txt'), 'k\n')
    fs.writeFileSync(path.join(cwd, 'edited.txt'), 'e\n')
    fs.mkdirSync(path.join(home, 'evidence'))
    const sha = (t) => crypto.createHash('sha1').update(t).digest('hex')
    fs.writeFileSync(path.join(home, 'evidence', 'hrun-old.json'), JSON.stringify({ cwd, checks: [], at: Date.now(), before: { files: { 'kept.txt': { hash: sha('k\n'), lines: 1 }, 'edited.txt': { hash: sha('old\n'), lines: 1 } }, truncated: false } }))
    const ev = evidence.collect(home, 'hrun-old')
    assert.deepEqual(ev.changes.modified, [{ path: 'edited.txt', lines_before: 1, lines_after: 1 }])
    assert.deepEqual(ev.changes.created, [])
  } finally {
    for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('files changed since a time, for a follow report: counted per folder, progress notes first', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  try {
    fs.mkdirSync(path.join(cwd, 'src'))
    fs.mkdirSync(path.join(cwd, 'docs'))
    fs.writeFileSync(path.join(cwd, 'old.txt'), 'o\n')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(path.join(cwd, 'old.txt'), old, old)
    const since = Date.now() - 1000
    for (const n of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(cwd, 'src', n), 'x\n')
    fs.writeFileSync(path.join(cwd, 'docs', 'MASTER-CHECKLIST.md'), '- [x] paging\n')
    fs.mkdirSync(path.join(cwd, 'node_modules'))
    fs.writeFileSync(path.join(cwd, 'node_modules', 'dep.js'), 'x\n')
    const c = evidence.changedSince(cwd, since)
    assert.equal(c.count, 4)
    assert.deepEqual(c.folders, [{ folder: 'src', count: 3 }, { folder: 'docs', count: 1 }])
    assert.equal(c.files[0], 'docs/MASTER-CHECKLIST.md')
    assert.equal(c.files.length, 4)
    assert.equal(evidence.changedSince(path.join(cwd, 'gone'), since), null)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('a big file is not read, and the folder snapshot is kept apart from the record until the run is collected', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  fs.writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(600 * 1024, 1))
  evidence.prepare(home, { run_id: 'hrun-b', cwd })
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'evidence', 'hrun-b.json'), 'utf8'))
  assert.equal('before' in rec, false, 'the record stays small')
  const snap = JSON.parse(fs.readFileSync(path.join(home, 'evidence', 'hrun-b.before.json'), 'utf8'))
  assert.equal(snap.files['big.bin'].hash, undefined, 'over the text limit: not read')
  fs.writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(700 * 1024, 2))
  fs.writeFileSync(path.join(cwd, 'render.bin'), Buffer.alloc(900 * 1024, 3))
  const ev = evidence.collect(home, 'hrun-b')
  assert.deepEqual(ev.changes.created, [{ path: 'render.bin', lines: null }])
  assert.deepEqual(ev.changes.modified, [{ path: 'big.bin', lines_before: null, lines_after: null }])
  assert.equal(fs.existsSync(path.join(home, 'evidence', 'hrun-b.before.json')), false, 'removed once collected')
  assert.deepEqual(evidence.collect(home, 'hrun-b'), ev, 'read back')
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true })
})

test('a 0.6.4 record with the hash of a big file: the file left as it was is not counted as changed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  const big = Buffer.alloc(600 * 1024, 7)
  fs.writeFileSync(path.join(cwd, 'big.bin'), big)
  fs.mkdirSync(path.join(home, 'evidence'), { recursive: true })
  const sha = crypto.createHash('sha1').update(big).digest('hex')
  fs.writeFileSync(path.join(home, 'evidence', 'hrun-l.json'), JSON.stringify({ cwd, checks: [], at: Date.now(), before: { files: { 'big.bin': { hash: sha, lines: null } }, truncated: false } }))
  assert.deepEqual(evidence.collect(home, 'hrun-l').changes.modified, [])
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true })
})

test('a Git worktree the run made in the folder is reported from git, not as a copy of every file, and the checks run in it', (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-wt-'))
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }) })
  git(cwd, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(cwd, 'add.js'), 'module.exports = (a, b) => a + b\n')
  fs.writeFileSync(path.join(cwd, 'old.js'), 'x\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'base')
  evidence.prepare(home, { run_id: 'hrun-wt', cwd, checks: ['node -e "console.log(require(\'fs\').existsSync(\'sub.js\') ? \'here\' : \'elsewhere\')"'] })
  // What Harness's worktree tool does: a checkout under .agents/worktrees, then work and a commit in it.
  fs.mkdirSync(path.join(cwd, '.agents', 'worktrees'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.agents', 'worktrees', '.gitignore'), '*\n')
  git(cwd, 'worktree', 'add', '-q', '-b', 'wt-sub', path.join(cwd, '.agents', 'worktrees', 'wt-sub'))
  const wt = path.join(cwd, '.agents', 'worktrees', 'wt-sub')
  fs.writeFileSync(path.join(wt, 'sub.js'), 'module.exports = (a, b) => a - b\n')
  fs.writeFileSync(path.join(wt, 'add.js'), 'module.exports = (a, b) => b + a\n')
  fs.rmSync(path.join(wt, 'old.js'))
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'sub')
  fs.writeFileSync(path.join(wt, 'notes.md'), 'not committed\n')
  // And one file in the folder itself.
  fs.writeFileSync(path.join(cwd, 'top.txt'), 'y\n')
  const ev = evidence.collect(home, 'hrun-wt')
  assert.deepEqual(ev.changes.created.map((f) => f.path), ['top.txt'], 'the checkout copy is left out')
  assert.equal(ev.worktrees.length, 1)
  const w = ev.worktrees[0]
  assert.equal(fs.realpathSync.native(w.path), fs.realpathSync.native(wt))
  assert.equal(w.branch, 'wt-sub')
  assert.equal(w.commits, 1)
  assert.deepEqual(w.changes, { created: ['notes.md', 'sub.js'], modified: ['add.js'], deleted: ['old.js'] })
  assert.equal(ev.checks_folder, w.path)
  assert.equal(ev.checks[0].output_tail, 'here', 'checks ran in the worktree')
  assert.equal(evidence.recheck(home, 'hrun-wt')[0].output_tail, 'here', 'and again there on a recheck')
})

test('a record with no commit of its own (sent by an older dsh-baton) still gets the worktree changes from where it left the folder\'s line', (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-wt-'))
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }) })
  git(cwd, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(cwd, 'a.js'), '1\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'base')
  evidence.prepare(home, { run_id: 'hrun-old', cwd, checks: [] })
  // As an older dsh-baton wrote it: no git_head.
  const file = path.join(home, 'evidence', 'hrun-old.json')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')); delete rec.git_head; fs.writeFileSync(file, JSON.stringify(rec))
  const wt = path.join(cwd, '.agents', 'worktrees', 'wt-x')
  git(cwd, 'worktree', 'add', '-q', '-b', 'wt-x', wt)
  fs.writeFileSync(path.join(wt, 'b.js'), '2\n')
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'b')
  const ev = evidence.collect(home, 'hrun-old')
  assert.deepEqual(ev.worktrees[0].changes, { created: ['b.js'], modified: [], deleted: [] })
  assert.equal(ev.worktrees[0].commits, 1)
})

test('worktree evidence: a submodule is not a worktree, one made outside the work folder is found, non-ASCII names stay readable, and with no base commit the uncommitted changes show', (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' })
  const tmp = fs.realpathSync.native(os.tmpdir())
  const home = fs.mkdtempSync(path.join(tmp, 'dshb-ev-home-'))
  const repo = fs.mkdtempSync(path.join(tmp, 'dshb-ev-repo-'))
  const lib = fs.mkdtempSync(path.join(tmp, 'dshb-ev-lib-'))
  const loose = fs.mkdtempSync(path.join(tmp, 'dshb-ev-loose-'))
  t.after(() => { for (const d of [home, repo, lib, loose]) fs.rmSync(d, { recursive: true, force: true }) })
  git(lib, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(lib, 'l.js'), '1\n'); git(lib, 'add', '.'); git(lib, 'commit', '-q', '-m', 'l')
  git(repo, 'init', '-q', '-b', 'main')
  fs.mkdirSync(path.join(repo, 'app'))
  fs.writeFileSync(path.join(repo, 'app', 'a.js'), '1\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  // 1. The work folder is a subfolder; the worktree goes to the repository root.
  const app = path.join(repo, 'app')
  evidence.prepare(home, { run_id: 'hrun-out', cwd: app, checks: ['node -e "console.log(process.cwd())"'] })
  const wt = path.join(repo, '.agents', 'worktrees', 'wt-cn')
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-cn', wt)
  fs.writeFileSync(path.join(wt, 'app', '文件.txt'), '中\n')
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'cn')
  const out = evidence.collect(home, 'hrun-out')
  assert.equal(out.worktrees.length, 1, 'found through git though it is outside the work folder')
  assert.equal(out.worktrees[0].path, wt)
  assert.deepEqual(out.worktrees[0].changes.created, ['app/文件.txt'], 'the name as it is, not git-quoted')
  assert.equal(out.checks[0].output_tail, wt)
  // 2. A submodule added in the work folder is not a worktree: its files stay in changes, checks stay put.
  evidence.prepare(home, { run_id: 'hrun-sub', cwd: app, checks: ['node -e "console.log(process.cwd())"'] })
  git(app, 'submodule', '-q', 'add', lib, 'vendor/lib')
  const sub = evidence.collect(home, 'hrun-sub')
  assert.equal(sub.worktrees, undefined)
  assert.ok(sub.changes.created.some((f) => f.path === 'vendor/lib/l.js'))
  assert.equal(sub.checks[0].output_tail, app)
  // 3. A folder that is not a repository, holding one: no base commit, so what is uncommitted shows.
  const inner = path.join(loose, 'inner')
  fs.mkdirSync(inner); git(inner, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(inner, 'x.js'), '1\n'); git(inner, 'add', '.'); git(inner, 'commit', '-q', '-m', 'x')
  evidence.prepare(home, { run_id: 'hrun-loose', cwd: loose, checks: [] })
  const wt2 = path.join(inner, '.agents', 'worktrees', 'w2')
  git(inner, 'worktree', 'add', '-q', '-b', 'w2', wt2)
  fs.writeFileSync(path.join(wt2, 'x.js'), '2\n')
  const lo = evidence.collect(home, 'hrun-loose')
  assert.deepEqual(lo.worktrees[0].changes.modified, ['x.js'])
  assert.equal(lo.worktrees[0].incomplete, undefined)
})

test('a recheck before any collect runs in the worktree git lists as new since dsh_send', (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' })
  const tmp = fs.realpathSync.native(os.tmpdir())
  const home = fs.mkdtempSync(path.join(tmp, 'dshb-ev-home-'))
  const repo = fs.mkdtempSync(path.join(tmp, 'dshb-ev-re-'))
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }) })
  git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), '1\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'a')
  evidence.prepare(home, { run_id: 'hrun-re', cwd: repo, checks: ['node -e "console.log(process.cwd())"'] })
  const wt = path.join(repo, '.agents', 'worktrees', 'g')
  git(repo, 'worktree', 'add', '-q', '-b', 'g', wt)
  assert.equal(evidence.recheck(home, 'hrun-re')[0].output_tail, wt)
})

test('a later send to a session already in a worktree: its changes stay in changes, and the evidence says it is a worktree', (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' })
  const tmp = fs.realpathSync.native(os.tmpdir())
  const home = fs.mkdtempSync(path.join(tmp, 'dshb-ev-home-'))
  const repo = fs.mkdtempSync(path.join(tmp, 'dshb-ev-again-'))
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }) })
  git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.js'), '1\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'a')
  const wt = path.join(repo, '.agents', 'worktrees', 'wt-x')
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-x', wt)
  evidence.prepare(home, { run_id: 'hrun-again', cwd: wt, checks: ['node -e "console.log(process.cwd())"'] })
  fs.writeFileSync(path.join(wt, 'a.js'), '1\n2\n')
  const ev = evidence.collect(home, 'hrun-again')
  assert.deepEqual(ev.changes.modified.map((f) => f.path), ['a.js'])
  assert.deepEqual(ev.worktrees, [{ path: wt, branch: 'wt-x', changes_in: 'changes' }])
  assert.equal(ev.checks[0].output_tail, wt)
})

// A file with a size but no blocks stands in for an iCloud Drive placeholder (a sparse file
// made with truncate has none on APFS): reading one downloads it, so it is never read.
test('a file whose content is not on disk (cloud placeholder) is compared by size and time only, not read', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  fs.writeFileSync(path.join(cwd, 'note.md'), 'a\nb\n')
  const cloud = path.join(cwd, 'font.ttf')
  fs.writeFileSync(cloud, '')
  fs.truncateSync(cloud, 4096)
  if (fs.statSync(cloud).blocks !== 0) { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); return }
  evidence.prepare(home, { run_id: 'hrun-c', cwd })
  const snap = JSON.parse(fs.readFileSync(path.join(home, 'evidence', 'hrun-c.before.json'), 'utf8'))
  assert.equal(snap.files['font.ttf'].hash, undefined, 'not read')
  assert.equal(snap.files['font.ttf'].s, 4096, 'still listed by size')
  assert.equal(snap.files['note.md'].lines, 2, 'a file on disk is read as before')
  const ev = evidence.collect(home, 'hrun-c')
  assert.deepEqual(ev.changes.modified, [], 'left as it was: not counted')
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true })
})
