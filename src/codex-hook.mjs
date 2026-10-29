// Waking Codex when a run ends. Codex has no wake-on-exit for background commands, but it
// runs Stop hooks when a turn ends: a hook that prints {"decision":"block","reason"} makes
// Codex feed reason back to the model in the same turn. `dsh-baton codex-stop-hook` is such
// a hook: after dsh_send the model ends its turn, the hook waits for the run without any
// model requests, and returns the result as dsh_wait would. One wake instead of a dsh_wait
// call every few minutes.
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'
import { codexConfigPath, stableNodePath, codexHookEntry, codexHookStatus, hookResultFile, HOOK_TIMEOUT_S } from './register.mjs'

export { editCodexHook, HOOK_TIMEOUT_S } from './register.mjs'

const dir = () => path.join(core.config.batonHome, 'codex-hook')
const pendingFile = () => path.join(dir(), 'pending.json')
// Touched every time Codex runs the hook, so the server knows the hook is installed,
// trusted and firing (an untrusted or edited hook never runs).
const aliveFile = () => path.join(dir(), 'alive')

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) } catch { return {} }
}
function writePending(p) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const tmp = `${pendingFile()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
  fs.renameSync(tmp, pendingFile())
}

// The Codex conversation a tool call came from (every Codex tools/call carries it).
export const threadOf = (meta) => meta?.threadId ?? meta?.['x-codex-turn-metadata']?.thread_id ?? null

export function remember(threadId, runId) {
  if (!threadId || !runId) return
  writePending({ ...readPending(), [runId]: { thread: threadId, delivered: null, at: Date.now() } })
}

// The model got this result itself (dsh_wait): the hook must not deliver it again.
export function delivered(runId, st) {
  const p = readPending()
  if (!p[runId]) return
  if (st?.needs_input) p[runId] = { ...p[runId], delivered: questionKey(st) }
  else delete p[runId]
  writePending(p)
}

const questionKey = (st) => `${st.needs_input}:${JSON.stringify(st.question?.questions?.map((q) => q.id ?? q.question) ?? st.waiting_on ?? null)}`

// The hook is in Codex's config and the user has trusted it (see codexHookStatus).
// Not "has run since the config last changed": Codex rewrites its config for its own
// settings (the app language, say), which says nothing about the hook.
export function hookActive(env = process.env) {
  try {
    const st = codexHookStatus(env)
    return st.installed && st.trusted
  } catch {
    return false
  }
}

// The hook is in Codex's config but the user has not trusted it (see codexHookStatus).
export function hookUntrusted() {
  try {
    const st = codexHookStatus()
    return st.installed && !st.trusted
  } catch {
    return false
  }
}

// Why the plugin did not add the hook (see addCodexHook), in one sentence, or null: when
// it was added, when Codex is not installed, or when no plugin from 0.6.2 on has run yet.
const SKIP_REASONS = {
  disabled: 'it is turned off with DSH_BATON_CODEX_HOOK=0 in the environment Harness runs with',
  'no-cli': "Codex's dsh-baton entry does not name a server folder with cli.mjs in it (a bare command such as npx, or a folder that is gone)",
}
export function hookSkipReason(env = process.env) {
  let r = null
  try { r = JSON.parse(fs.readFileSync(hookResultFile(env), 'utf8')) } catch { return null }
  if (!['off', 'skipped', 'failed'].includes(r?.state) || !r.reason) return null
  const why = SKIP_REASONS[r.reason] ?? `adding it failed (${String(r.reason).slice(0, 200)})`
  return `dsh-baton's Codex Stop hook is not set up because ${why}, so Codex waits with dsh_wait.`
}

// Each Codex conversation is told about trusting the hook once.
const notedFile = () => path.join(dir(), 'trust-noted.json')
export function noteOnce(thread) {
  if (!thread) return false
  let seen = []
  try { seen = JSON.parse(fs.readFileSync(notedFile(), 'utf8')) } catch { /* none yet */ }
  if (seen.includes(thread)) return false
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(notedFile(), JSON.stringify([...seen.slice(-199), thread]))
  return true
}

// The language of Codex's own interface: 'zh' when localeOverride in its config ([desktop])
// starts with zh, else 'en' (also when it is not set or the config cannot be read).
export function codexLang(env = process.env) {
  try {
    const m = fs.readFileSync(codexConfigPath(env), 'utf8').match(/^\s*localeOverride\s*=\s*["']([^"']*)["']/m)
    return /^zh/i.test(m?.[1] ?? '') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

// Codex desktop shows reason as is and folds the rest of a long message away, so it opens
// with a few lines a person reads at a glance: per run, its state, how long it took, and
// the files and checks dsh-baton saw (only what the result already holds).
const WORDS = {
  en: {
    state: { completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted' },
    asks: (q, n) => `waiting for an answer${n > 1 ? ` (${n} questions)` : ''}${q ? `: "${q}"` : ''}`,
    approval: 'waiting for an approval in Harness',
    took: (t) => ` in ${t}`, units: ['h', 'm', 's'], join: ' ',
    files: (n, more) => `${n}${more ? '+' : ''} file${n === 1 && !more ? '' : 's'} changed`,
    checks: (ok, bad, skipped, all) => (skipped
      ? `checks ${ok}/${all} passed${bad ? `, ${bad} failed` : ''}, ${skipped} skipped`
      : `checks ${bad ? 'failed' : 'passed'} (${ok}/${all})`),
    many: (n) => `dsh-baton: ${n} Harness runs are back`,
    running: (ids) => `Still running: ${ids.join(', ')}`,
    sep: ': ', dot: ' · ',
  },
  zh: {
    state: { completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '被中断' },
    asks: (q, n) => `在等回答${n > 1 ? `（共 ${n} 个问题）` : ''}${q ? `：「${q}」` : ''}`,
    approval: '在等你在 Harness 里批准',
    took: (t) => `，用时 ${t}`, units: [' 小时', ' 分', ' 秒'], join: ' ',
    files: (n, more) => `改动 ${n}${more ? '+' : ''} 个文件`,
    checks: (ok, bad, skipped, all) => (skipped
      ? `项目测试 ${ok}/${all} 通过${bad ? `，${bad} 个未通过` : ''}，${skipped} 个超时未跑`
      : `项目测试${bad ? '未通过' : '通过'}（${ok}/${all}）`),
    many: (n) => `dsh-baton：${n} 个 Harness 任务回来了`,
    running: (ids) => `还在运行：${ids.join('、')}`,
    sep: '：', dot: ' · ',
  },
}

function took(r, w) {
  const ms = Date.parse(r.ended_at) - Date.parse(r.started_at)
  if (!(ms >= 0)) return null
  const s = Math.round(ms / 1000)
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
  const parts = h ? [[h, 0], [m, 1]] : m ? [[m, 1], [sec, 2]] : [[sec, 2]]
  return parts.filter(([v], i) => v || i === 0).map(([v, u]) => `${v}${w.units[u]}`).join(w.join)
}

// By characters, not UTF-16 units, so an emoji is never cut in half.
const clip = (text, n = 100) => {
  const t = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  return t.length > n ? `${t.slice(0, n).join('')}…` : t.join('')
}

function runLine(r, w) {
  if (r.needs_input) {
    const qs = r.question?.questions ?? []
    return r.needs_input === 'harness-ui' && !qs.length ? w.approval : w.asks(clip(qs[0]?.question), qs.length)
  }
  const t = took(r, w)
  const bits = [`${w.state[r.state] ?? r.state}${t ? w.took(t) : ''}`]
  const ch = r.evidence?.changes
  if (ch) bits.push(w.files((ch.created?.length ?? 0) + (ch.modified?.length ?? 0) + (ch.deleted?.length ?? 0), ch.truncated))
  // A check skipped for lack of time did not fail: it is counted apart.
  const checks = r.evidence?.checks
  if (checks?.length) {
    const ok = checks.filter((c) => c.passed).length
    const skipped = checks.filter((c) => c.skipped).length
    bits.push(w.checks(ok, checks.length - ok - skipped, skipped, checks.length))
  }
  return bits.join(w.dot)
}

export function glanceFor(results, running = [], lang = 'en') {
  const w = WORDS[lang] ?? WORDS.en
  const lines = results.length === 1
    ? [`dsh-baton${w.dot}${results[0].run_id}${w.sep}${runLine(results[0], w)}`]
    : [w.many(results.length), ...results.map((r) => `- ${r.run_id}${w.sep}${runLine(r, w)}`)]
  if (running.length) lines.push(w.running(running))
  return lines.join('\n')
}

// What the model is told: a glance for the person first, then each run's result as
// dsh_wait returns it, and which runs of the same batch are still going (when one came
// back early to ask something or failed).
// Should the glance fail on an odd result, the model still gets everything.
function reasonFor(results, running, lang) {
  let glance = ''
  try { glance = `${glanceFor(results, running, lang)}\n\n` } catch { /* results only */ }
  return `${glance}${modelPart(results, running)}`
}

function modelPart(results, running) {
  const one = results.length === 1 ? results[0] : null
  const what = one
    ? `the Harness run ${one.run_id} you handed over with dsh_send has ${one.needs_input ? 'stopped to ask a question' : `ended (${one.state})`}`
    : `${results.length} Harness runs you handed over with dsh_send have come back`
  const still = running.length
    ? ` Still running, not reviewed yet: ${running.join(', ')}; dsh-baton brings them back when they end, so do not wait for them yourself: deal with what is here, then end your turn.`
    : ''
  const body = one ? JSON.stringify(one) : JSON.stringify(results)
  return `dsh-baton: ${what}.${still} ${one ? 'This is its result' : 'These are their results'}, as dsh_wait would return ${one ? 'it' : 'them'}; act on ${one ? 'it' : 'them'} now (follow the hints):\n${body}`
}

// What Codex shows the user for the wake (systemMessage), instead of the JSON in reason:
// a short line per run with its id and state, in Codex's language. The model reads reason only.
export function summaryFor(results, running = [], lang = 'en') {
  if (lang === 'zh') {
    const one = (r) => r.needs_input ? `${r.run_id} 在等回答` : `${r.run_id}（${r.state}）`
    const head = results.length === 1
      ? (results[0].needs_input ? `dsh-baton：Harness 任务 ${one(results[0])}，问题已交给 Codex` : `dsh-baton：Harness 任务 ${one(results[0])}已结束，结果已交回 Codex`)
      : `dsh-baton：${results.length} 个 Harness 任务已交回 Codex：${results.map(one).join('，')}`
    return running.length ? `${head}；还在运行 ${running.length} 个` : head
  }
  const one = (r) => r.needs_input ? `${r.run_id} waiting for an answer` : `${r.run_id} (${r.state})`
  const head = results.length === 1
    ? (results[0].needs_input ? `dsh-baton: Harness run ${one(results[0])}, question passed to Codex` : `dsh-baton: Harness run ${one(results[0])} ended, result passed to Codex`)
    : `dsh-baton: ${results.length} Harness runs passed to Codex: ${results.map(one).join(', ')}`
  return running.length ? `${head}; ${running.length} still running` : head
}

// The JSON Codex writes to the hook's stdin, or null. A leading BOM is dropped (seen on
// Windows). Input that does not parse is kept (its first 4 KB) in last-bad-stdin, so a
// hook that ran and gave up can be told from one Codex never ran.
export function parseHookInput(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  try { return JSON.parse(text) } catch { /* kept below */ }
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const file = path.join(dir(), 'last-bad-stdin')
    fs.writeFileSync(file, Buffer.from(text).subarray(0, 4096), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch { /* nowhere to keep it */ }
  return null
}

// The node and cli.mjs this hook process runs as (what Codex trusted).
function ranAs() {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
  return { node: real(process.execPath), cli: real(process.argv[1] ?? '') }
}

// One Stop-hook call. input is the JSON Codex writes to stdin; shape(st) turns a run's
// state into what dsh_wait returns. Returns the JSON to print, or null to let the turn end.
//
// The runs this conversation handed over wait as one batch: Codex is woken once, when the
// last of them ends, with all their results, so it reviews the parallel parts together.
// A run that stops to ask a question or fails wakes it at once (with whatever else has
// ended by then); the rest keep waiting for the next Stop.
export async function runHook(input, { shape, wait = core.api.wait, now = Date.now, chunk_s = 10, self = ranAs(), lang } = {}) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(aliveFile(), JSON.stringify({ at: now(), ...self }))
  const thread = input?.session_id
  if (!thread) return null
  const deadline = now() + (HOOK_TIMEOUT_S - 60) * 1000
  const ended = new Map() // run_id -> state, held until the batch is handed back
  for (;;) {
    const mine = Object.entries(readPending()).filter(([, v]) => v.thread === thread)
    if (!mine.length && !ended.size) return null
    const running = []
    let urgent = false
    for (const [runId, entry] of mine) {
      if (ended.has(runId)) continue
      let st
      try {
        st = await wait({ run_id: runId, timeout_s: chunk_s })
      } catch (e) {
        // Harness not answering (quit or restarting): keep waiting, it may come back.
        await new Promise((r) => setTimeout(r, chunk_s * 1000))
        running.push(runId)
        continue
      }
      if (st.timed_out) { running.push(runId); continue }
      // A question already passed on: it waits for an answer, not for this hook.
      if (st.needs_input && entry.delivered === questionKey(st)) continue
      ended.set(runId, st)
      if (st.needs_input || st.state !== 'completed') urgent = true
    }
    if (ended.size && (urgent || !running.length)) {
      // Marked delivered only once the message exists, so a failure here loses no result.
      const results = [...ended].map(([run_id, st]) => ({ run_id, ...shape(st) }))
      const language = lang ?? codexLang()
      const out = { decision: 'block', reason: reasonFor(results, running, language), systemMessage: summaryFor(results, running, language) }
      for (const [runId, st] of ended) delivered(runId, st)
      return out
    }
    if (!running.length) return null
    if (now() > deadline) return null
  }
}

// The hook entry for Codex's config.toml (see register.mjs, which also writes it).
export function hookCommand(root = core.ROOT, node = stableNodePath(), { platform, harness = Boolean(process.versions.electron) } = {}) {
  return codexHookEntry(node, path.join(root, 'src', 'server.mjs'), { platform, home: core.config.batonHome, harness })
}
