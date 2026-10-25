// Shared helpers for the acceptance checks: run a command in the workspace and collect failures.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function checker(dir) {
  const failures = []
  let passed = 0
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-check-'))
  const run = (cmd, args, env = {}) => {
    const r = spawnSync(cmd, args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 })
    return { code: r.status, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trimEnd() }
  }
  const expect = (name, ok, detail = '') => {
    if (ok) passed++
    else failures.push(detail ? `${name}: ${detail}` : name)
  }
  const done = () => {
    fs.rmSync(tmp, { recursive: true, force: true })
    const result = { pass: failures.length === 0, passed, failed: failures.length, failures }
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.pass ? 0 : 1)
  }
  return { run, expect, done, tmp, failures }
}
