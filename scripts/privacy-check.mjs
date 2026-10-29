// Fails when the repo would publish something private: a real home-folder path, a mounted
// drive, a LAN address, Codex/Claude session files, or a screenshot or video outside assets/
// (the patterns are in privacy-rules.mjs). Extra words to block (names, folder names) can be
// listed one per line in .privacy-words, which stays local (.gitignore).
//   node scripts/privacy-check.mjs                 tracked files as they are in the working tree
//   node scripts/privacy-check.mjs --staged        what is staged (pre-commit)
//   node scripts/privacy-check.mjs --range A..B    every line each commit in the range adds, so
//                                                  something added and removed again is caught (pre-push, CI)
// Anything after --range goes to git rev-list as is (e.g. --range <sha> --not --remotes).
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { rules, MEDIA } from './privacy-rules.mjs'

const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
process.chdir(git('rev-parse', '--show-toplevel').trim())
const list = (out) => out.split('\0').filter(Boolean)

const SELF = 'scripts/privacy-rules.mjs'
const words = fs.existsSync('.privacy-words') ? fs.readFileSync('.privacy-words', 'utf8').split('\n').map((w) => w.trim()).filter(Boolean) : []
const all = words.length ? [...rules, { name: 'private word', re: new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') }] : rules

const problems = []
function scan(where, text, firstLine = 1) {
  for (const r of all) {
    for (const m of text.matchAll(r.re)) {
      if (r.ok?.(m)) continue
      problems.push(`${where}:${firstLine + text.slice(0, m.index).split('\n').length - 1}: ${r.name}: ${m[0].slice(0, 60)}`)
    }
  }
}
function scanFile(where, file, read) {
  if (file === SELF) return
  if (MEDIA.test(file)) {
    if (!file.startsWith('assets/')) problems.push(`${where}: screenshot or video outside assets/`)
    return
  }
  let text
  try { text = read() } catch { return }
  if (!text.includes('\0')) scan(where, text)
}

const at = process.argv.indexOf('--range')
let checked
if (at !== -1) {
  // Merges are left out: the commits they bring in are in the range themselves.
  const commits = git('rev-list', '--no-merges', ...process.argv.slice(at + 1)).split('\n').filter(Boolean)
  for (const sha of commits) {
    const id = sha.slice(0, 7)
    for (const f of list(git('show', '--format=', '--name-only', '--diff-filter=ACR', '-z', sha))) {
      if (MEDIA.test(f) && !f.startsWith('assets/')) problems.push(`${id} ${f}: screenshot or video outside assets/`)
    }
    // The lines each file gains, with their line numbers in that commit. A file's header
    // runs from "diff --git" to its first hunk (an added line may start with "++" too).
    let file = null, line = 0, head = false
    for (const l of git('show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', sha).split('\n')) {
      if (l.startsWith('diff --git ')) head = true
      else if (head && l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6).replace(/\t$/, '')
      else if (l.startsWith('@@')) { head = false; line = Number(/\+(\d+)/.exec(l)[1]) }
      else if (!head && l.startsWith('+') && file && file !== SELF) scan(`${id} ${file}`, l.slice(1), line++)
    }
  }
  checked = `${commits.length} commits`
} else {
  const staged = process.argv.includes('--staged')
  const files = list(staged ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z') : git('ls-files', '-z'))
  for (const f of files) scanFile(f, f, () => (staged ? git('show', `:${f}`) : fs.readFileSync(f, 'utf8')))
  checked = `${files.length} files`
}

if (problems.length) {
  console.error(`privacy check failed (${problems.length}):\n${problems.slice(0, 50).join('\n')}`)
  process.exit(1)
}
console.log(`privacy check passed (${checked})`)
