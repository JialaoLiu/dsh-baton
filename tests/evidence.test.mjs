// Evidence for a finished run comes from dsh-baton, not the Harness reply: files created,
// changed or deleted since dsh_send, and the check commands run in the folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as evidence from '../src/evidence.mjs'

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
