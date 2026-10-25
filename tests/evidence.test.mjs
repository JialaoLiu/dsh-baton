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
