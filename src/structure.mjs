// How the code of a finished run is laid out: the source files it touched and their sizes,
// so a backend piled into one file shows up, also across the runs of one session (the
// sizes when the session started are kept). Only a report: by default nothing is limited.
// With a file size limit (dsh_send max_file_lines, or DSH_BATON_MAX_FILE_LINES), Harness
// is asked to keep new source files under it, and files that end up over it after growing
// are listed as a warning that does not change whether the run succeeded.
import { setting } from '../host/lib/socket.js'

const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kts?|scala|rb|php|cs|swift|dart|lua|exs?|c|cc|cpp|h|hpp|m|mm|vue|svelte)$/i
// Tests are code too, but a large test file is not what this is about.
const TEST = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|[._-](?:test|spec)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/i
export const isCode = (p) => CODE.test(p)
export const isTest = (p) => TEST.test(p)
const LIST = 10
const GREW = 100

// The limit for one run: max_file_lines when given (0 turns it off), else the setting.
export function fileLimit(param, env = process.env) {
  const n = Math.floor(Number(param ?? setting('MAX_FILE_LINES', env)))
  return n >= 1 ? n : 0
}

// path -> lines of the code files in a snapshot, kept as a session's starting point.
export const codeLines = (files) => Object.fromEntries(Object.entries(files).filter(([p, f]) => isCode(p) && f.lines != null).map(([p, f]) => [p, f.lines]))

// before / after: path -> { hash, lines } of the run's folder; start: path -> lines when the
// session began (null when not known). Over the limit: a source file longer than it that is
// new in the session or grew by more than GREW since the session started. A file that was
// already long and only got a small edit is not flagged.
export function structureOf(before, after, start, limit = 0) {
  // From each file's line total, not a diff: an edit that keeps a file's length counts as 0.
  let added = 0, removed = 0
  const grow = (from, to) => { if (to > from) added += to - from; else removed += from - to }
  const changed = []
  for (const [p, f] of Object.entries(after)) {
    if (!isCode(p) || f.lines == null || before[p]?.hash === f.hash) continue
    if (before[p] && before[p].lines == null) continue
    grow(before[p]?.lines ?? 0, f.lines)
    if (!isTest(p)) changed.push(p)
  }
  for (const [p, f] of Object.entries(before)) if (!after[p] && isCode(p) && f.lines != null) grow(f.lines, 0)
  if (!changed.length && !added && !removed) return null
  changed.sort((a, b) => after[b].lines - after[a].lines || a.localeCompare(b))
  const files = changed.map((p) => {
    const f = { path: p, lines: after[p].lines }
    if (before[p]) f.before = before[p].lines
    if (start && start[p] !== f.before) f.session_start = start[p] ?? 0
    return f
  })
  const over = []
  if (limit) {
    for (const f of files) {
      const from = start ? start[f.path] : f.before
      if (f.lines <= limit) continue
      if (from === undefined) over.push({ path: f.path, lines: f.lines, new: true })
      else if (f.lines - from > GREW) over.push({ path: f.path, lines: f.lines, grew: f.lines - from })
    }
  }
  return {
    files: files.slice(0, LIST),
    ...(files.length > LIST ? { more_files: files.length - LIST } : {}),
    lines_added: added,
    lines_removed: removed,
    ...(limit ? { max_file_lines: limit } : {}),
    ...(over.length ? { over_limit: over } : {}),
  }
}

// What dsh-baton adds to a message for Harness, in the message's language: Chinese when it
// has CJK characters, else English.
export const isChinese = (text) => /[぀-ヿ㐀-鿿가-힯豈-﫿]/.test(text)

export function layoutRequest(message, limit) {
  if (!limit) return ''
  return isChinese(message)
    ? `\n\n---\n代码结构：新代码按职责放进新模块，新建的源文件不超过 ${limit} 行。已有的大文件照常修改，不要求拆分或重构。`
    : `\n\n---\nCode layout: put new code in new modules by responsibility, and keep each new source file under ${limit} lines. Edit existing large files as they are; they need no splitting or refactoring.`
}

// Said with checks: review from the evidence dsh-baton produced, read code only where it
// points, and send every fix back in one message. The last row only judges the layout.
export function reviewRequest(message) {
  return isChinese(message)
    ? '\n\n---\n完成后，启动一个只读子代理，对照上面的每一项需求检查，然后在最终回复末尾附上它的表格：需求 | 是否满足（是 / 否 / 不确定）| 证据（文件:行 或测试名）。表格最后加一行：新增代码是否按职责拆分、有没有重复的辅助函数（只做判断，不要为此重构）。标为"否"的需求先修好再回复。'
    : '\n\n---\nWhen the work is done, start a read-only sub-agent to check it against every requirement above, then end your final reply with its table: requirement | met (yes / no / unclear) | evidence (file:line or test name). Add a last row: is the new code split by responsibility, with no duplicated helper functions (judge only; do not refactor for it). Fix any requirement marked no before replying.'
}
