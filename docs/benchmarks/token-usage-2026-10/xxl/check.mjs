// External acceptance run for the Tsumiki task. Copies the workspace (without node_modules, data or
// .git), puts back the original tests/acceptance for phases 1..N, runs them with node --test and
// prints the result as JSON: pass, counts and the names of failing tests.
// Usage: node xxl/check.mjs <workspace> <phase 1-3> [<out.json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [ws, phaseArg, outFile] = process.argv.slice(2)
const phase = Number(phaseArg)
if (!ws || ![1, 2, 3].includes(phase)) { console.error('usage: check.mjs <workspace> <1|2|3> [out.json]'); process.exit(2) }
const seed = path.join(import.meta.dirname, 'seed', 'tests', 'acceptance')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsumiki-check-'))
const skip = new Set(['node_modules', '.git', 'data', 'vendor'])
fs.cpSync(path.resolve(ws), tmp, { recursive: true, filter: (src) => !skip.has(path.basename(src)) || path.dirname(src) !== path.resolve(ws) })
fs.rmSync(path.join(tmp, 'tests', 'acceptance'), { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, 'tests', 'acceptance'), { recursive: true })
const files = ['helpers.mjs']
for (let p = 1; p <= phase; p++) files.push(`phase${p}.api.test.mjs`, `phase${p}.ui.test.mjs`)
for (const f of files) fs.copyFileSync(path.join(seed, f), path.join(tmp, 'tests', 'acceptance', f))

// One node --test process per file, so each result is tied to its file.
const results = []
let out = '', stderr = '', exit = 0
for (const f of files.filter((x) => x.endsWith('.test.mjs'))) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `tests/acceptance/${f}`], {
    cwd: tmp, encoding: 'utf8', timeout: 10 * 60 * 1000, env: { ...process.env, NODE_ENV: 'test' },
  })
  out += `### ${f}\n${r.stdout || ''}`
  stderr += r.stderr || ''
  if (r.status !== 0) exit = r.status ?? 1
  let n = 0
  for (const line of (r.stdout || '').split('\n')) {
    const t = line.match(/^(not ok|ok) \d+ - (.*?)(\s+# .*)?$/)
    if (t) { results.push({ file: f, test: t[2], pass: t[1] === 'ok' }); n++ }
  }
  if (n === 0) results.push({ file: f, test: '(file did not run)', pass: false })
}
const failed = results.filter((x) => !x.pass)
const result = {
  phase, pass: exit === 0 && failed.length === 0 && results.length > 0,
  passed: results.length - failed.length, failed: failed.length, total: results.length,
  failures: failed.map((x) => `${x.file} › ${x.test}`), exit, checkedAt: new Date().toISOString(),
}
if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
  fs.writeFileSync(outFile.replace(/\.json$/, '.tap.txt'), out + '\n--- stderr ---\n' + stderr)
}
console.log(JSON.stringify(result, null, 2))
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(result.pass ? 0 : 1)
