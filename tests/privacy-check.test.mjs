// scripts/privacy-check.mjs, run in a throwaway git repo. The private-looking strings are put
// together at run time from placeholder parts, so this file passes the check itself.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const made = []
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

const HOME = ['', 'Users', 'someone', 'project'].join('/')
const WIN = ['C:', 'Users', 'someone', 'project'].join('\\')
const SESSION = ['', '.codex', 'sessions', '2026', '01', 'rollout.jsonl'].join('\\')

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-privacy-'))
  made.push(dir)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const f of ['privacy-check.mjs', 'privacy-rules.mjs']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, 'scripts', f))
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '--no-verify', '-m', msg); return git('rev-parse', 'HEAD').trim() }
  const check = (args = [], cwd = dir) => {
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'privacy-check.mjs'), ...args], { cwd, encoding: 'utf8' })
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }
  }
  write('README.md', 'Placeholder paths are fine: /Users/me/project, C:\\Users\\USER\\x.\n')
  return { dir, git, write, commit, check, base: commit('start') }
}

test('a clean repo passes, the rules file included; placeholders and URLs with /home/ are not flagged', () => {
  const r = repo()
  r.write('docs/links.md', 'See https://example.com/home/page and http://example.org/home/someone.\n')
  r.commit('links')
  const out = r.check()
  assert.ok(out.ok, out.out)
  assert.match(out.out, /privacy check passed \(4 files\)/)
})

test('a home folder path is found, in Mac, Windows and lower-case Windows form, and in non-ASCII file names', () => {
  const r = repo()
  r.write('notes.md', `one\npath ${HOME}\n`)
  r.write('win.txt', `${WIN}\n${WIN.toLowerCase()}\n`)
  r.write('笔记/说明.md', `${HOME}\n`)
  r.commit('paths')
  const out = r.check()
  assert.equal(out.ok, false)
  assert.match(out.out, /notes\.md:2: home folder path/)
  assert.match(out.out, /win\.txt:1: home folder path/)
  assert.match(out.out, new RegExp(`win\\.txt:2: home folder path: ${WIN.toLowerCase().slice(0, 16).replace(/\\/g, '\\\\')}`))
  assert.match(out.out, /笔记\/说明\.md:1: home folder path/)
})

test('session files are found with forward or back slashes', () => {
  const r = repo()
  r.write('a.txt', `${SESSION}\n${SESSION.replaceAll('\\', '/')}\n`)
  r.commit('sessions')
  const out = r.check()
  assert.match(out.out, /a\.txt:1: Codex or Claude session file/)
  assert.match(out.out, /a\.txt:2: Codex or Claude session file/)
})

test('run from a sub-folder, the result is the same, private words included', () => {
  const r = repo()
  fs.writeFileSync(path.join(r.dir, '.privacy-words'), 'placeholderproject\n')
  r.write('src/deep/a.md', 'built for PlaceholderProject\n')
  r.git('add', 'src')
  r.git('commit', '-q', '--no-verify', '-m', 'word')
  const top = r.check()
  const sub = r.check([], path.join(r.dir, 'src', 'deep'))
  assert.equal(top.ok, false)
  assert.match(top.out, /src\/deep\/a\.md:1: private word: PlaceholderProject/)
  assert.deepEqual(sub, top)
})

test('--staged checks what is staged, not the working tree', () => {
  const r = repo()
  r.write('a.md', `${HOME}\n`)
  r.git('add', 'a.md')
  r.write('a.md', 'fixed, but not staged\n')
  const out = r.check(['--staged'])
  assert.equal(out.ok, false)
  assert.match(out.out, /^a\.md:1: home folder path/m)
  assert.ok(r.check([]).ok) // the working tree alone looks clean
})

test('--range finds a path a commit added even when a later one removed it, and media outside assets/', () => {
  const r = repo()
  r.write('a.md', `line\n${HOME}\n`)
  const bad = r.commit('add')
  r.write('a.md', 'line\n')
  r.write('assets/ok.gif', 'GIF89a')
  r.write('shot.png', 'png')
  r.commit('remove')
  assert.ok(r.check().ok === false) // shot.png
  fs.rmSync(path.join(r.dir, 'shot.png'))
  r.commit('drop shot')
  assert.ok(r.check().ok)
  const out = r.check(['--range', `${r.base}..HEAD`])
  assert.equal(out.ok, false)
  assert.match(out.out, new RegExp(`${bad.slice(0, 7)} a\\.md:2: home folder path`))
  assert.match(out.out, /shot\.png: screenshot or video outside assets\//)
  assert.doesNotMatch(out.out, /ok\.gif/)
  assert.match(r.check(['--range', 'HEAD~1..HEAD']).out, /privacy check passed \(1 commits\)/)
})
