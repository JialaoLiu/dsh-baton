// The folder the client's conversation works in, so a new Harness session starts next to it
// instead of in a folder the model guessed (an old workspace from dsh_list_workspaces, or
// ~/.codex). Codex sends its thread id with every tool call; that thread's rollout file starts
// with a session_meta line that records the thread's cwd. The MCP server's own folder is not
// enough there: dsh-baton registers it to start in the home folder (register.mjs), which is
// never taken for a project. Antigravity starts one server for all its conversations, in /,
// and sends the conversation id with every tool call; its conversation_summaries.db records
// each conversation's project folder. Other clients (Claude Code) start the server in the
// project folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (norm(real(cwd)) === norm(real(home)) || cwd === path.parse(cwd).root) return undefined
  if (inside(codexHome()) || inside(path.join(home, '.claude'))) return undefined
  return cwd
}

const AG = 'antigravity.google/'
// The Antigravity data folder: the parent of brain/ in the artifacts folder Antigravity sends
// (it differs per profile), else ~/.gemini/antigravity.
function antigravityDataDir(meta) {
  const artifacts = meta?.[`${AG}artifacts_dir`]
  if (typeof artifacts === 'string' && path.basename(path.dirname(artifacts)) === 'brain') return path.dirname(path.dirname(artifacts))
  return path.join(os.homedir(), '.gemini', 'antigravity')
}

// The project folder of an Antigravity conversation (or of its root conversation, for a
// sub-agent's): a path, null when the conversation has no project ("outside-of-project"),
// or undefined when it cannot be told. Antigravity keeps the database open in WAL mode, so
// it is read from a copy, never in place, and on every send: a conversation can move to
// another project.
export function antigravityConversationCwd(meta, dataDir = antigravityDataDir(meta)) {
  const ids = [meta?.[`${AG}conversation_id`], meta?.[`${AG}root_conversation_id`]].filter((id) => /^[\w-]+$/.test(id ?? ''))
  if (!ids.length) return undefined
  const db = path.join(dataDir, 'conversation_summaries.db')
  if (!fs.existsSync(db)) return undefined
  const sqlite = loadSqlite()
  if (!sqlite?.DatabaseSync) return undefined
  let tmp
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baton-ag-'))
    // Not -shm: SQLite rebuilds it from -wal, and on Windows it is the file Antigravity keeps locked.
    for (const ext of ['', '-wal']) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, path.join(tmp, 'c.db' + ext))
    const conn = new sqlite.DatabaseSync(path.join(tmp, 'c.db'))
    try {
      const row = (id) => conn.prepare('SELECT workspace_uris, project_id FROM conversation_summaries WHERE conversation_id = ?').get(id)
      for (const id of ids) {
        const r = row(id)
        if (!r) continue
        let uris = []
        try { uris = JSON.parse(r.workspace_uris || '[]') } catch { /* not JSON */ }
        const uri = Array.isArray(uris) ? uris.find((u) => typeof u === 'string' && u.startsWith('file:')) : undefined
        if (uri) return fileURLToPath(uri)
        if (r.project_id === 'outside-of-project') return null
      }
      return undefined
    } finally { conn.close() }
  } catch {
    return undefined
  } finally {
    // A copy an antivirus is still scanning (Windows) is left for the system to clear, not
    // allowed to fail a send whose folder was found.
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch { /* left behind */ }
  }
}

// node:sqlite, without the "SQLite is an experimental feature" warning it prints on load
// (Node 22-24), which clients show in their MCP server log.
let sqliteModule
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  const emit = process.emitWarning
  process.emitWarning = (w, ...rest) => { if (!/SQLite/i.test(String(w?.message ?? w))) emit.call(process, w, ...rest) }
  try { sqliteModule = process.getBuiltinModule?.('node:sqlite') ?? null } catch { sqliteModule = null } finally { process.emitWarning = emit }
  return sqliteModule
}

// client: 'codex', 'antigravity' or another client's name.
export function conversationFolder(meta, client) {
  if (client === 'codex' || client === true) {
    const threadId = meta?.['x-codex-turn-metadata']?.thread_id ?? meta?.threadId
    const cwd = codexThreadCwd(threadId)
    if (cwd) return cwd
  }
  if (client === 'antigravity') return antigravityConversationCwd(meta) ?? undefined
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
