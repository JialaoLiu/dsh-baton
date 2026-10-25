// The folder the client's conversation works in, so a new Harness session starts next to it
// instead of in a folder the model guessed (an old workspace from dsh_list_workspaces, or
// ~/.codex). Codex sends its thread id with every tool call; that thread's rollout file starts
// with a session_meta line that records the thread's cwd. The MCP server's own folder is not
// enough there: the Codex app starts it in one folder for all of its projects. Other clients
// (Claude Code) start the server in the project folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const DAYS_SEARCHED = 120
const found = new Map()

const newestFirst = (dir) => { try { return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse() } catch { return [] } }

// sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread id>.jsonl, newest days first.
function codexThreadCwd(threadId) {
  if (!/^[\w-]+$/.test(threadId ?? '')) return undefined
  if (found.has(threadId)) return found.get(threadId)
  const root = path.join(codexHome(), 'sessions')
  let days = 0
  for (const y of newestFirst(root)) for (const m of newestFirst(path.join(root, y))) for (const d of newestFirst(path.join(root, y, m))) {
    if (++days > DAYS_SEARCHED) return undefined
    const dir = path.join(root, y, m, d)
    const file = fs.readdirSync(dir).find((n) => n.endsWith(`-${threadId}.jsonl`))
    if (!file) continue
    try {
      const fd = fs.openSync(path.join(dir, file), 'r')
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const cwd = JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]).payload?.cwd
      if (typeof cwd === 'string' && cwd) { found.set(threadId, cwd); return cwd }
    } catch { /* unreadable: fall back */ }
    return undefined
  }
  return undefined
}

// The server's own folder counts only when it looks like a project: not the home folder,
// not the file-system root and not a client's own settings folder.
function serverCwd() {
  const cwd = process.cwd()
  const home = os.homedir()
  const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
  const inside = (dir) => { const r = path.relative(real(dir), real(cwd)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
  if (cwd === home || cwd === path.parse(cwd).root) return undefined
  if (inside(codexHome()) || inside(path.join(home, '.claude'))) return undefined
  return cwd
}

export function conversationFolder(meta, isCodex) {
  if (isCodex) {
    const threadId = meta?.['x-codex-turn-metadata']?.thread_id ?? meta?.threadId
    const cwd = codexThreadCwd(threadId)
    if (cwd) return cwd
  }
  return serverCwd()
}

const norm = (p) => {
  const r = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()))
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}
// True when folder is the conversation's folder or inside it.
export function within(folder, conversation) {
  const r = path.relative(norm(conversation), norm(folder))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
