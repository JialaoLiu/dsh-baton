// Evidence for a finished run comes from dsh-baton, not the Harness reply: files created,
// changed or deleted since dsh_send, and the check commands run in the folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as evidence from '../src/evidence.mjs'
import * as structure from '../src/structure.mjs'

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
  const ev = evidence.collect(home, 'hrun-1')
  assert.deepEqual(ev.changes.created, [{ path: 'new.mjs', lines: 2 }])
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

// structure: the source files a run touched and their sizes, also across a session's runs.
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

test('structure counts source files only; tests are in the line totals but never the largest or over the limit', () => {
  for (const p of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.tsx', 'a.jsx', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.rb', 'a.php', 'a.cs', 'a.swift', 'a.kt']) assert.ok(structure.isCode(p), p)
  for (const p of ['a.css', 'a.html', 'a.md', 'a.json', 'a.txt', 'a.mjs.map']) assert.ok(!structure.isCode(p), p)
  for (const p of ['tests/a.mjs', 'src/__tests__/a.js', 'a.test.ts', 'a.spec.js', 'a_test.go', 'test_a.py']) assert.ok(structure.isTest(p), p)
  assert.ok(!structure.isTest('src/latest.mjs'))
  const f = (n, h = String(n)) => ({ hash: h, lines: n })
  const before = { 'src/keep.mjs': f(10), 'src/edit.py': f(40), 'src/gone.js': f(5), 'style.css': f(100) }
  const after = { 'src/keep.mjs': f(10), 'src/edit.py': f(30), 'src/new.ts': f(80), 'tests/new.test.mjs': f(900), 'style.css': f(400), 'big.bin': { hash: 'b', lines: null } }
  const st = structure.structureOf(before, after, null, 50)
  assert.deepEqual(st.files, [{ path: 'src/new.ts', lines: 80 }, { path: 'src/edit.py', lines: 30, before: 40 }])
  assert.equal(st.lines_added, 980) // 80 + 900 (the test file counts here)
  assert.equal(st.lines_removed, 15) // 10 from edit.py, 5 from gone.js
  assert.deepEqual(st.over_limit, [{ path: 'src/new.ts', lines: 80, new: true }])
  // The same number of lines, other content: still a changed file.
  assert.deepEqual(structure.structureOf({ 'a.js': f(5, 'x') }, { 'a.js': f(5, 'y') }, null).files, [{ path: 'a.js', lines: 5, before: 5 }])
  assert.equal(structure.structureOf({ 'a.md': f(1) }, { 'a.md': f(9) }, null), null) // nothing in code
  // At most 10 files are listed, largest first.
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}.js`, f(i + 1)]))
  const big = structure.structureOf({}, many, null)
  assert.equal(big.files.length, 10)
  assert.equal(big.files[0].path, 'm11.js')
  assert.equal(big.more_files, 2)
  assert.equal(big.max_file_lines, undefined) // no limit, no limit fields
  assert.equal(big.over_limit, undefined)
})

test('over the limit: a source file longer than it that is new in the session or grew by more than 100 lines', () => {
  const f = (n) => ({ hash: String(n), lines: n })
  const start = { 'main.js': 1400, 'grows.js': 700, 'small.js': 100 }
  const before = { 'main.js': f(1400), 'grows.js': f(700), 'small.js': f(100), 'early.js': f(500) }
  const after = { 'main.js': f(1450), 'grows.js': f(820), 'small.js': f(650), 'early.js': f(700), 'fresh.js': f(601), 'ok.js': f(600) }
  const st = structure.structureOf(before, after, start, 600)
  assert.deepEqual(st.over_limit, [
    { path: 'grows.js', lines: 820, grew: 120 },
    { path: 'early.js', lines: 700, new: true }, // new in the session, made by an earlier run
    { path: 'small.js', lines: 650, grew: 550 }, // small at the start, piled up past the limit
    { path: 'fresh.js', lines: 601, new: true },
  ])
  // main.js was big already and grew by 50: edited as it is, not flagged.
  assert.equal(structure.structureOf(before, after, start, 0).over_limit, undefined)
  // Without a session start, the run's own before decides.
  assert.deepEqual(structure.structureOf(before, after, null, 600).over_limit.map((o) => o.path), ['grows.js', 'early.js', 'small.js', 'fresh.js'])
  // A file that only just crossed the limit with a small edit is not flagged.
  assert.equal(structure.structureOf({ 'a.js': f(590) }, { 'a.js': f(610) }, null, 600).over_limit, undefined)
})

test('a session\'s runs: sizes since the session started, the limit from dsh_send', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-ev-cwd-'))
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x\n')
  evidence.prepare(home, { run_id: 'hrun-s1', cwd, session_id: 'sess-1', max_file_lines: 600 })
  fs.writeFileSync(path.join(cwd, 'server.mjs'), lines(900))
  const first = evidence.collect(home, 'hrun-s1').structure
  assert.deepEqual(first.files, [{ path: 'server.mjs', lines: 900 }])
  assert.deepEqual(first.over_limit, [{ path: 'server.mjs', lines: 900, new: true }])
  // Continued: the run starts from 900, the session from nothing.
  evidence.prepare(home, { run_id: 'hrun-s2', cwd, session_id: 'sess-1' })
  fs.writeFileSync(path.join(cwd, 'server.mjs'), lines(2012))
  const second = evidence.collect(home, 'hrun-s2').structure
  assert.deepEqual(second.files, [{ path: 'server.mjs', lines: 2012, before: 900, session_start: 0 }])
  assert.equal(second.lines_added, 1112)
  assert.equal(second.max_file_lines, undefined) // this run had no limit
  // No code touched: no structure at all.
  evidence.prepare(home, { run_id: 'hrun-s3', cwd, session_id: 'sess-1' })
  fs.writeFileSync(path.join(cwd, 'README.md'), 'y\n')
  assert.equal(evidence.collect(home, 'hrun-s3').structure, undefined)
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true })
})

test('the limit: max_file_lines over the setting, 0 turns it off; the request to Harness in the message\'s language', () => {
  assert.equal(structure.fileLimit(undefined, {}), 0)
  assert.equal(structure.fileLimit(undefined, { DSH_BATON_MAX_FILE_LINES: '600' }), 600)
  assert.equal(structure.fileLimit(undefined, { DSH_BATON_MAX_FILE_LINES: '0' }), 0)
  assert.equal(structure.fileLimit(undefined, { DSH_BATON_MAX_FILE_LINES: 'lots' }), 0)
  assert.equal(structure.fileLimit(400, { DSH_BATON_MAX_FILE_LINES: '600' }), 400)
  assert.equal(structure.fileLimit(0, { DSH_BATON_MAX_FILE_LINES: '600' }), 0)
  assert.equal(structure.layoutRequest('build it', 0), '')
  assert.match(structure.layoutRequest('build it', 600), /^\n\n---\nCode layout: put new code in new modules by responsibility, and keep each new source file under 600 lines\. Edit existing large files as they are/)
  assert.match(structure.layoutRequest('做一个看板', 600), /^\n\n---\n代码结构：新代码按职责放进新模块，新建的源文件不超过 600 行。已有的大文件照常修改，不要求拆分或重构。$/)
  assert.match(structure.layoutRequest('ボードを作る', 600), /代码结构/) // CJK
  assert.match(structure.reviewRequest('build it'), /Add a last row: is the new code split by responsibility, with no duplicated helper functions \(judge only; do not refactor for it\)/)
  assert.match(structure.reviewRequest('做一个看板'), /^\n\n---\n完成后，启动一个只读子代理.*表格最后加一行：新增代码是否按职责拆分、有没有重复的辅助函数（只做判断，不要为此重构）/)
})
