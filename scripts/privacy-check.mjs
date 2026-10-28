// Fails when a tracked (or, with --staged, a staged) file would publish something private:
// a real home-folder path, a mounted drive, a LAN address, Codex/Claude session files, or a
// screenshot or video outside assets/. Extra words to block (names, folder names) can be listed
// one per line in .privacy-words, which stays local (.gitignore).
//   node scripts/privacy-check.mjs [--staged]
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const staged = process.argv.includes('--staged')
const files = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter(Boolean)
const read = (f) => (staged ? execFileSync('git', ['show', `:${f}`], { encoding: 'utf8', maxBuffer: 1 << 28 }) : fs.readFileSync(f, 'utf8'))

// Placeholder user names that tests and docs use on purpose.
const PLACEHOLDER = new Set(['a', 'b', 'x', 'me', 'you', 'user', 'name', 'runner', 'USER', 'USERNAME', 'example', 'alice', 'bob', 'Shared'])
const rules = [
  { name: 'home folder path', re: /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s'"`<>{}$]+)/g, ok: (m) => PLACEHOLDER.has(m[1]) || m[1].length === 1 || m[1].startsWith('%') || /^\.\.\.|^…/.test(m[1]) },
  { name: 'mounted drive', re: /\/Volumes\/[^\s'"`]+/g },
  { name: 'LAN address', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'Codex or Claude session file', re: /\.codex\/sessions\/20|\.claude\/projects\/-/g },
]
const extra = fs.existsSync('.privacy-words') ? fs.readFileSync('.privacy-words', 'utf8').split('\n').map((w) => w.trim()).filter(Boolean) : []
if (extra.length) rules.push({ name: 'private word', re: new RegExp(extra.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') })

const MEDIA = /\.(png|jpe?g|gif|webp|mov|mp4|webm|heic)$/i
const problems = []
for (const f of files) {
  if (f === 'scripts/privacy-check.mjs') continue
  if (MEDIA.test(f) && !f.startsWith('assets/')) problems.push(`${f}: screenshot or video outside assets/`)
  if (MEDIA.test(f)) continue
  let text
  try { text = read(f) } catch { continue }
  if (text.includes('\0')) continue
  for (const r of rules) {
    for (const m of text.matchAll(r.re)) {
      if (r.ok?.(m)) continue
      const line = text.slice(0, m.index).split('\n').length
      problems.push(`${f}:${line}: ${r.name}: ${m[0].slice(0, 60)}`)
    }
  }
}
if (problems.length) {
  console.error(`privacy check failed (${problems.length}):\n${problems.slice(0, 50).join('\n')}`)
  process.exit(1)
}
console.log(`privacy check passed (${files.length} files)`)
