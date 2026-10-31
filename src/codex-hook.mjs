// The Codex Stop hook runner. Plugins 0.6.0–0.6.3 added a Stop hook that waited for a run
// after the model ended its turn and fed the result back ({"decision":"block","reason"}).
// dsh-baton now waits with long dsh_waits and the plugin takes the hook out (register.mjs),
// but Codex conversations opened before 0.6.4 keep a snapshot of their hooks and still run
// `dsh-baton codex-stop-hook` at every turn's end: it stays for them, and with nothing
// pending it ends quietly.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import * as core from './core.mjs'
import { codexConfigPath, HOOK_TIMEOUT_S } from './register.mjs'

export { HOOK_TIMEOUT_S } from './register.mjs'

const dir = () => path.join(core.config.batonHome, 'codex-hook')
const pendingFile = () => path.join(dir(), 'pending.json')
// Touched every time Codex runs the hook: a trace of conversations from before 0.6.4 that
// still call it.

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

// The model got this result itself (dsh_wait): the hook must not deliver it again.
export function delivered(runId, st) {
  const p = readPending()
  if (!p[runId]) return
  if (st?.needs_input) p[runId] = { ...p[runId], delivered: questionKey(st) }
  else delete p[runId]
  writePending(p)
}

const questionKey = (st) => `${st.needs_input}:${JSON.stringify(st.question?.questions?.map((q) => q.id ?? q.question) ?? st.waiting_on ?? null)}`

// The language of Codex's own interface. A language picked in Codex's settings is written as
// localeOverride in its config ([desktop]) and wins, English included. Without one, Codex
// (Electron) follows the system's preferred language, not its region format:
// AppleLanguages (then AppleLocale) on macOS, the user interface language that Node's ICU
// reports on Windows, LC_ALL / LC_MESSAGES / LANG elsewhere (C and POSIX say nothing).
// 'zh' when that starts with zh, else 'en' (also when nothing can be read). The hook runs
// at every Codex Stop, so the system is asked only without an override, once per process.
const defaults = (key) => execFileSync('defaults', ['read', '-g', key], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
const SYSTEM = {
  platform: process.platform,
  readAppleLanguages: () => /^\(\s*"?([^",\s)]+)/.exec(defaults('AppleLanguages'))?.[1],
  readAppleLocale: () => defaults('AppleLocale').trim(),
  intlLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
}
const attempt = (read) => { try { return read() || '' } catch { return '' } }
export function systemLocale(env = process.env, sys = SYSTEM) {
  const { platform, readAppleLanguages, readAppleLocale, intlLocale } = { ...SYSTEM, ...sys }
  if (platform === 'darwin') return attempt(readAppleLanguages) || attempt(readAppleLocale)
  if (platform === 'win32') return attempt(intlLocale)
  return [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && !/^(C|POSIX)([._@]|$)/.test(v)) ?? ''
}
let systemCached
export function codexLang(env = process.env, sys) {
  let picked
  try {
    picked = fs.readFileSync(codexConfigPath(env), 'utf8').match(/^\s*localeOverride\s*=\s*["']([^"']*)["']/m)?.[1]
  } catch { /* no config: Codex follows the system */ }
  const locale = picked || (sys ? systemLocale(env, sys) : (systemCached ??= systemLocale(env)))
  return /^zh/i.test(locale) ? 'zh' : 'en'
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

// One Stop-hook call. input is the JSON Codex writes to stdin; shape(st) turns a run's
// state into what dsh_wait returns. Returns the JSON to print, or null to let the turn end.
//
// The runs this conversation handed over wait as one batch: Codex is woken once, when the
// last of them ends, with all their results, so it reviews the parallel parts together.
// A run that stops to ask a question or fails wakes it at once (with whatever else has
// ended by then); the rest keep waiting for the next Stop.
export async function runHook(input, { shape, wait = core.api.wait, now = Date.now, chunk_s = 10, lang } = {}) {
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

