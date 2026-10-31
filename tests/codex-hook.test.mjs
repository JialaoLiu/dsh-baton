// The Codex Stop hook of plugins 0.6.0–0.6.3: taking its block out of Codex's config, and what
// one hook call returns (conversations opened before 0.6.4 still run it).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-hook-'))
process.env.DSH_BATON_HOME = home
// Not this machine's Codex config or system language, either would change the glance in reason.
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codexhome-'))
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), '[desktop]\nlocaleOverride = "en"\n')
const hook = await import('../src/codex-hook.mjs')
const { removeCodexHookBlock, codexHookBlockFor } = await import('../src/register.mjs')
// A config as 0.6.1–0.6.3 left it: our block appended after what was there.
const addHook = (text, command) => `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}${codexHookBlockFor(command)}`
after(() => {
  for (const d of [home, process.env.CODEX_HOME]) fs.rmSync(d, { recursive: true, force: true })
})
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs')
// The hook command 0.6.1–0.6.3 wrote: the wrapper script at a fixed place.
const WRAPPER = '/x/.dsh-baton/bin/codex-stop-hook'
// What dsh_send of 0.6.0–0.6.3 left for the hook: a run handed over in a conversation.
function remember(thread, runId) {
  const file = path.join(home, 'codex-hook', 'pending.json')
  let p = {}
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* none yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...p, [runId]: { thread, delivered: null, at: Date.now() } }))
}

test('the old hook block is taken out in every form it was written, and only its own lines', () => {
  const user = 'model = "x"\n\n[mcp_servers.a]\ncommand = "n"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "my-own-hook"\n'
  const once = addHook(user, WRAPPER)
  assert.equal(removeCodexHookBlock(once), user)
  // Before 0.6.1's final form: a node line and no status message.
  const legacy = `"/n" "${path.join('/r', 'src', 'cli.mjs')}" codex-stop-hook`
  assert.equal(removeCodexHookBlock(addHook(user, legacy).replace(/^statusMessage = .*\n/m, '')), user)
  // Windows: the .cmd wrapper, its 8.3 short form (known by the status message), PowerShell's call form.
  assert.equal(removeCodexHookBlock(addHook(user, 'C:\\Users\\a\\.dsh-baton\\bin\\codex-stop-hook.cmd')), user)
  assert.equal(removeCodexHookBlock(addHook(user, 'C:\\FIRSTL~1\\DSH-BA~1\\bin\\CODEX-~1.CMD')), user)
  assert.equal(removeCodexHookBlock(addHook(user, `& "C:\\n\\node.exe" "C:\\a\\src\\cli.mjs" codex-stop-hook`).replace(/^statusMessage = .*\n/m, '')), user)
  // The marker line lost, or the command rewritten in single quotes by Codex.
  assert.equal(removeCodexHookBlock(once.replace(/^# dsh-baton.*\n/m, '')), user)
  assert.equal(removeCodexHookBlock(once.replace(JSON.stringify(WRAPPER), `'${WRAPPER}'`)), user)
  // Nothing of ours: the very same text back, blank lines inside a multi-line string included.
  assert.equal(removeCodexHookBlock(user), user)
  const spaced = `${user}\n\n\ndeveloper_instructions = """\nline1\n\n\n\nline2\n"""\n`
  assert.equal(removeCodexHookBlock(spaced), spaced)
  // With ours, only its own lines go; what is elsewhere stays byte for byte.
  assert.equal(removeCodexHookBlock(addHook(spaced, WRAPPER)), spaced.replace(/\s+$/, '\n'))
})

test('a hook of the user\'s own is never taken: one right after ours, one of a similar name', () => {
  const theirs = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "/usr/local/bin/my-notify"\nstatusMessage = "mine"\ntimeout = 30\n'
  // Directly after our block, with no blank line between.
  const tight = codexHookBlockFor(WRAPPER) + theirs
  assert.equal(removeCodexHookBlock(tight), theirs)
  // A name that only contains ours.
  const similar = theirs.replace('/usr/local/bin/my-notify', '/usr/local/bin/codex-stop-hook-shim')
  assert.equal(removeCodexHookBlock(similar), similar)
  assert.equal(removeCodexHookBlock(`${similar}\n${codexHookBlockFor(WRAPPER)}`), similar)
  // A comment the user put before their own group stays with it.
  assert.equal(removeCodexHookBlock(`${codexHookBlockFor(WRAPPER)}\n# my notifier\n${theirs}`), `# my notifier\n${theirs}`)
  // Headers spaced or with a comment after them are headers all the same.
  const commented = theirs.replace('[[hooks.Stop]]', '[[hooks.Stop]] # my notifier').replace('[[hooks.Stop.hooks]]', '[[ hooks.Stop.hooks ]]  # another plugin')
  assert.equal(removeCodexHookBlock(codexHookBlockFor(WRAPPER) + commented), commented)
  const sharedCommented = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "${WRAPPER}"\n[[hooks.Stop.hooks]] # another plugin\ntype = "command"\ncommand = "mine"\n`
  assert.equal(removeCodexHookBlock(sharedCommented), sharedCommented)
  // A group of several hooks is not ours to take, even with our command in it.
  const shared = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "${WRAPPER}"\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n`
  assert.equal(removeCodexHookBlock(shared), shared)
})

test('one hook call: nothing pending ends the turn; a finished run comes back once', async () => {
  const shape = (st) => ({ ...st, hint: 'shaped' })
  assert.equal(await hook.runHook({ session_id: 'other' }, { shape, wait: async () => assert.fail('no wait') }), null)
  remember('t1', 'hrun-a')
  let calls = 0
  const wait = async ({ run_id }) => (++calls < 3 ? { run_id, timed_out: true, state: 'running' } : { run_id, state: 'completed', final_text: 'done' })
  const out = await hook.runHook({ session_id: 't1' }, { shape, wait, chunk_s: 0 })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /hrun-a .* has ended \(completed\)/)
  assert.match(out.reason, /"final_text":"done","hint":"shaped"/)
  // A glance for the person, then the text the model read before, word for word.
  assert.equal(out.reason, `dsh-baton · hrun-a: completed\n\ndsh-baton: the Harness run hrun-a you handed over with dsh_send has ended (completed). This is its result, as dsh_wait would return it; act on it now (follow the hints):\n${JSON.stringify({ run_id: 'hrun-a', state: 'completed', final_text: 'done', hint: 'shaped' })}`)
  assert.equal(out.systemMessage, 'dsh-baton: Harness run hrun-a (completed) ended, result passed to Codex') // no Codex language set
  assert.deepEqual(Object.keys(out), ['decision', 'reason', 'systemMessage'])
  assert.equal(calls, 3)
  // Delivered: the continuation's own Stop lets the turn end.
  assert.equal(await hook.runHook({ session_id: 't1', stop_hook_active: true }, { shape, wait }), null)
})

test('a question is passed on once; if nobody answers, the turn ends instead of waiting', async () => {
  const shape = (st) => st
  remember('t2', 'hrun-q')
  const asking = async ({ run_id }) => ({ run_id, state: 'waiting', needs_input: 'answer', question: { count: 1, questions: [{ id: 'q1', question: 'Which?' }] } })
  const first = await hook.runHook({ session_id: 't2' }, { shape, wait: asking, lang: 'zh' })
  assert.match(first.reason, /stopped to ask a question/)
  assert.match(first.systemMessage, /^dsh-baton：Harness 任务 \S+ 在等回答，问题已交给 Codex$/)
  assert.equal(await hook.runHook({ session_id: 't2', stop_hook_active: true }, { shape, wait: asking }), null)
  // Answered (with dsh_answer), the run goes on: the next Stop waits for it again.
  const done = await hook.runHook({ session_id: 't2' }, { shape, wait: async ({ run_id }) => ({ run_id, state: 'completed' }) })
  assert.match(done.reason, /ended \(completed\)/)
})

test('runs handed over together wake Codex once, when the last one ends, with every result', async () => {
  for (const id of ['b1', 'b2', 'b3']) remember('tb', `hrun-${id}`)
  const endsAt = { 'hrun-b1': 1, 'hrun-b2': 3, 'hrun-b3': 5 } // in rounds of waiting
  const calls = {}
  const wait = async ({ run_id }) => {
    calls[run_id] = (calls[run_id] ?? 0) + 1
    return calls[run_id] < endsAt[run_id] ? { run_id, timed_out: true, state: 'running' } : { run_id, state: 'completed', final_text: `done ${run_id}` }
  }
  const out = await hook.runHook({ session_id: 'tb' }, { shape: (s) => s, wait, chunk_s: 0 })
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /3 Harness runs you handed over with dsh_send have come back/)
  for (const id of ['b1', 'b2', 'b3']) assert.match(out.reason, new RegExp(`"final_text":"done hrun-${id}"`))
  assert.doesNotMatch(out.reason, /Still running/)
  assert.equal(calls['hrun-b1'], 1) // an ended run is not asked again while the others finish
  // All three handed back: the next Stop lets the turn end.
  assert.equal(await hook.runHook({ session_id: 'tb', stop_hook_active: true }, { shape: (s) => s, wait: async () => assert.fail('no wait') }), null)
})

test('a run that asks a question or fails wakes Codex at once; the rest keep waiting', async () => {
  for (const id of ['q1', 'q2', 'q3']) remember('tq', `hrun-${id}`)
  const states = {
    'hrun-q1': { state: 'completed', final_text: 'ok' },
    'hrun-q2': { state: 'waiting', needs_input: 'answer', question: { count: 1, questions: [{ id: 'x', question: 'Red or blue?' }] } },
    'hrun-q3': { timed_out: true, state: 'running' },
  }
  const wait = async ({ run_id }) => ({ run_id, ...states[run_id] })
  const first = await hook.runHook({ session_id: 'tq' }, { shape: (s) => s, wait, chunk_s: 0, lang: 'zh' })
  assert.match(first.reason, /2 Harness runs/)
  assert.match(first.reason, /Red or blue\?/)
  assert.match(first.reason, /Still running, not reviewed yet: hrun-q3/)
  assert.match(first.systemMessage, /^dsh-baton：2 个 Harness 任务已交回 Codex：.*在等回答.*；还在运行 1 个$/)
  assert.ok(first.systemMessage.length < 120)
  // The question is answered elsewhere; q3 fails next: that wakes it too, alone.
  states['hrun-q3'] = { state: 'failed', error: 'boom' }
  const second = await hook.runHook({ session_id: 'tq', stop_hook_active: true }, { shape: (s) => s, wait, chunk_s: 0 })
  assert.match(second.reason, /hrun-q3 you handed over with dsh_send has ended \(failed\)/)
  assert.doesNotMatch(second.reason, /hrun-q1/) // already handed back
})

test('reason opens with a glance in Codex\'s language, then the full results for the model', async () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const done = {
    run_id: 'hrun-g1', state: 'completed', started_at: at(0), ended_at: at(252), final_text: 'ok',
    evidence: { changes: { created: [{ path: 'a' }], modified: [{ path: 'b' }, { path: 'c' }], deleted: [] }, checks: [{ passed: true }, { passed: true }], all_checks_passed: true },
  }
  const failed = { run_id: 'hrun-g2', state: 'failed', started_at: at(0), ended_at: at(45), error: 'boom', evidence: { changes: { created: [], modified: [], deleted: [] }, checks: [{ passed: true }, { passed: false }], all_checks_passed: false } }
  const long = 'x'.repeat(150)
  const asking = { run_id: 'hrun-g3', state: 'waiting', needs_input: 'answer', question: { count: 2, questions: [{ id: 'q', question: `Which one?\n${long}` }, { id: 'r', question: 'And?' }] } }
  const approval = { run_id: 'hrun-g4', state: 'waiting', needs_input: 'harness-ui' }

  assert.equal(hook.glanceFor([done]), 'dsh-baton · hrun-g1: completed in 4m 12s · 3 files changed · checks passed (2/2)')
  assert.equal(hook.glanceFor([done], [], 'zh'), 'dsh-baton · hrun-g1：已完成，用时 4 分 12 秒 · 改动 3 个文件 · 项目测试通过（2/2）')
  assert.equal(hook.glanceFor([failed]), 'dsh-baton · hrun-g2: failed in 45s · 0 files changed · checks failed (1/2)')
  assert.equal(hook.glanceFor([failed], [], 'zh'), 'dsh-baton · hrun-g2：失败，用时 45 秒 · 改动 0 个文件 · 项目测试未通过（1/2）')
  // A question: its first 100 characters, on one line; no time, the run has not ended.
  const q = `Which one? ${'x'.repeat(89)}…`
  assert.equal(hook.glanceFor([asking]), `dsh-baton · hrun-g3: waiting for an answer (2 questions): "${q}"`)
  assert.equal(hook.glanceFor([asking], [], 'zh'), `dsh-baton · hrun-g3：在等回答（共 2 个问题）：「${q}」`)
  assert.equal(hook.glanceFor([approval], [], 'zh'), 'dsh-baton · hrun-g4：在等你在 Harness 里批准')
  // Fields the result does not hold are left out, not looked up.
  assert.equal(hook.glanceFor([{ run_id: 'hrun-g5', state: 'cancelled' }]), 'dsh-baton · hrun-g5: cancelled')
  assert.equal(hook.glanceFor([{ run_id: 'h', state: 'completed', started_at: at(0), ended_at: at(3725) }]), 'dsh-baton · h: completed in 1h 2m')
  // Several runs: one line each, and the ones still going.
  assert.equal(hook.glanceFor([done, asking], ['hrun-g6', 'hrun-g7']), [
    'dsh-baton: 2 Harness runs are back',
    '- hrun-g1: completed in 4m 12s · 3 files changed · checks passed (2/2)',
    `- hrun-g3: waiting for an answer (2 questions): "${q}"`,
    'Still running: hrun-g6, hrun-g7',
  ].join('\n'))
  assert.equal(hook.glanceFor([done, failed], ['hrun-g6'], 'zh'), [
    'dsh-baton：2 个 Harness 任务回来了',
    '- hrun-g1：已完成，用时 4 分 12 秒 · 改动 3 个文件 · 项目测试通过（2/2）',
    '- hrun-g2：失败，用时 45 秒 · 改动 0 个文件 · 项目测试未通过（1/2）',
    '还在运行：hrun-g6',
  ].join('\n'))

  // The language comes from Codex's config; the JSON after the glance is unchanged.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lang-'))
  const env = { CODEX_HOME: codexHome }
  assert.equal(hook.codexLang(env, { platform: 'linux', intlLocale: () => 'zh-CN' }), 'en') // no config, nothing in env
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n\n[desktop]\nlocaleOverride = "zh-CN"\n')
  assert.equal(hook.codexLang(env), 'zh')
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "ja-JP"\n')
  assert.equal(hook.codexLang(env), 'en')
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "zh-CN"\n')
  const saved = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  try {
    remember('tg', 'hrun-g1')
    remember('tg', 'hrun-g2')
    const states = { 'hrun-g1': done, 'hrun-g2': failed }
    const out = await hook.runHook({ session_id: 'tg' }, { shape: (s) => s, wait: async ({ run_id }) => states[run_id], chunk_s: 0 })
    const [glance, rest] = out.reason.split('\n\n')
    assert.equal(glance, hook.glanceFor([done, failed], [], 'zh'))
    assert.ok(rest.startsWith('dsh-baton: 2 Harness runs you handed over with dsh_send have come back.'))
    assert.ok(rest.endsWith(`act on them now (follow the hints):\n${JSON.stringify([done, failed])}`))
    assert.match(out.systemMessage, /^dsh-baton：2 个 Harness 任务已交回 Codex/) // as before
  } finally {
    process.env.CODEX_HOME = saved
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

test('without localeOverride the language is the system\'s, read only then', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-lang-'))
  const config = (text) => fs.writeFileSync(path.join(codexHome, 'config.toml'), text)
  const env = { CODEX_HOME: codexHome }
  const unused = () => assert.fail('system asked although Codex has a language')
  const never = { platform: 'darwin', readAppleLanguages: unused, readAppleLocale: unused, intlLocale: unused }
  const mac = (languages, locale = 'en_US') => ({ platform: 'darwin', readAppleLanguages: languages, readAppleLocale: () => locale })
  const fail = () => { throw new Error('defaults: timed out') }
  try {
    config('[desktop]\nlocaleOverride = "zh-Hans"\n')
    assert.equal(hook.codexLang(env, never), 'zh')
    config('[desktop]\nlocaleOverride = "en-US"\n')
    assert.equal(hook.codexLang(env, never), 'en') // English picked on a Chinese system stays English

    config('model = "x"\n[desktop]\n')
    assert.equal(hook.codexLang(env, mac(() => 'zh-Hans-AU')), 'zh')
    assert.equal(hook.codexLang(env, mac(() => 'en-AU', 'zh_CN')), 'en') // the preferred language, not the region
    assert.equal(hook.codexLang(env, mac(() => undefined, 'zh_CN')), 'zh') // no AppleLanguages: AppleLocale
    assert.equal(hook.codexLang(env, mac(fail, '')), 'en')
    assert.equal(hook.codexLang(env, { platform: 'darwin', readAppleLanguages: fail, readAppleLocale: fail }), 'en')

    const linux = (vars) => hook.codexLang({ ...env, ...vars }, { platform: 'linux' })
    assert.equal(linux({ LANG: 'zh_CN.UTF-8' }), 'zh')
    assert.equal(linux({ LANG: 'C' }), 'en')
    assert.equal(linux({ LC_ALL: 'C.UTF-8', LANG: 'zh_CN.UTF-8' }), 'zh') // C says nothing, LANG decides
    assert.equal(linux({ LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en')
    assert.equal(linux({}), 'en')

    assert.equal(hook.codexLang(env, { platform: 'win32', intlLocale: () => 'zh-CN' }), 'zh')
    assert.equal(hook.codexLang(env, { platform: 'win32', intlLocale: () => 'en-US' }), 'en')
    assert.equal(hook.codexLang(env, { platform: 'win32', intlLocale: fail }), 'en')
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
})

test('checks: passed, failed, skipped for lack of time, and both, each said as it is', () => {
  const line = (checks, lang) => hook.glanceFor([{ run_id: 'h', state: 'completed', evidence: { checks } }], [], lang)
  const ok = { passed: true }, bad = { passed: false, exit_code: 1 }, skip = { command: 'npm test', skipped: 'out of time' }
  assert.equal(line([ok, ok]), 'dsh-baton · h: completed · checks passed (2/2)')
  assert.equal(line([ok, ok], 'zh'), 'dsh-baton · h：已完成 · 项目测试通过（2/2）')
  assert.equal(line([ok, bad]), 'dsh-baton · h: completed · checks failed (1/2)')
  assert.equal(line([ok, bad], 'zh'), 'dsh-baton · h：已完成 · 项目测试未通过（1/2）')
  // Not run is not failed.
  assert.equal(line([ok, ok, skip]), 'dsh-baton · h: completed · checks 2/3 passed, 1 skipped')
  assert.equal(line([ok, ok, skip], 'zh'), 'dsh-baton · h：已完成 · 项目测试 2/3 通过，1 个超时未跑')
  assert.equal(line([ok, bad, skip, skip]), 'dsh-baton · h: completed · checks 1/4 passed, 1 failed, 2 skipped')
  assert.equal(line([ok, bad, skip, skip], 'zh'), 'dsh-baton · h：已完成 · 项目测试 1/4 通过，1 个未通过，2 个超时未跑')
  // More files than the snapshot could hold.
  const many = { changes: { created: [{}], modified: [{}, {}], deleted: [], truncated: true } }
  assert.equal(hook.glanceFor([{ run_id: 'h', state: 'completed', evidence: many }]), 'dsh-baton · h: completed · 3+ files changed')
  assert.equal(hook.glanceFor([{ run_id: 'h', state: 'completed', evidence: many }], [], 'zh'), 'dsh-baton · h：已完成 · 改动 3+ 个文件')
})

test('a question is cut by characters: an emoji or a Chinese character is never split', () => {
  const ask = (q) => hook.glanceFor([{ run_id: 'h', state: 'waiting', needs_input: 'answer', question: { questions: [{ question: q }] } }])
  const emoji = ask(`${'a'.repeat(99)}😀tail`)
  assert.ok(emoji.endsWith(`${'a'.repeat(99)}😀…"`))
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  assert.ok(ask('中'.repeat(120)).endsWith(`"${'中'.repeat(100)}…"`))
  assert.ok(ask('短问题？').endsWith('"短问题？"'))
})

test('systemMessage follows Codex\'s language too', async () => {
  const runs = [{ run_id: 'hrun-1', state: 'completed' }, { run_id: 'hrun-2', state: 'waiting', needs_input: 'answer' }]
  assert.equal(hook.summaryFor(runs, ['hrun-3']), 'dsh-baton: 2 Harness runs passed to Codex: hrun-1 (completed), hrun-2 waiting for an answer; 1 still running')
  assert.equal(hook.summaryFor(runs.slice(1)), 'dsh-baton: Harness run hrun-2 waiting for an answer, question passed to Codex')
  assert.equal(hook.summaryFor(runs, ['hrun-3'], 'zh'), 'dsh-baton：2 个 Harness 任务已交回 Codex：hrun-1（completed），hrun-2 在等回答；还在运行 1 个')
  remember('ts', 'hrun-s')
  const out = await hook.runHook({ session_id: 'ts' }, { shape: (s) => s, wait: async ({ run_id }) => ({ run_id, state: 'completed' }), lang: 'zh' })
  assert.equal(out.systemMessage, 'dsh-baton：Harness 任务 hrun-s（completed）已结束，结果已交回 Codex')
  assert.ok(out.reason.startsWith('dsh-baton · hrun-s：已完成\n\n'))
})

test('a glance that fails leaves the results; a message that cannot be built keeps the run pending', async () => {
  // checks that are not a list: the glance throws, JSON does not.
  remember('tf', 'hrun-f')
  const odd = async ({ run_id }) => ({ run_id, state: 'completed', evidence: { checks: { length: 1 } } })
  const out = await hook.runHook({ session_id: 'tf' }, { shape: (s) => s, wait: odd })
  assert.ok(out.reason.startsWith('dsh-baton: the Harness run hrun-f you handed over with dsh_send has ended (completed).'))
  assert.equal(await hook.runHook({ session_id: 'tf', stop_hook_active: true }, { shape: (s) => s, wait: odd }), null) // delivered
  // The message itself fails (a value JSON cannot hold): nothing is marked delivered.
  remember('tf2', 'hrun-f2')
  const done = async ({ run_id }) => ({ run_id, state: 'completed' })
  await assert.rejects(hook.runHook({ session_id: 'tf2' }, { shape: (s) => ({ ...s, n: 1n }), wait: done }))
  const again = await hook.runHook({ session_id: 'tf2' }, { shape: (s) => s, wait: done })
  assert.match(again.reason, /hrun-f2 you handed over with dsh_send has ended \(completed\)/)
})

test('a result the model already got with dsh_wait is not delivered again', async () => {
  remember('t3', 'hrun-w')
  hook.delivered('hrun-w', { state: 'completed' })
  assert.equal(await hook.runHook({ session_id: 't3' }, { shape: (s) => s, wait: async () => assert.fail('no wait') }), null)
})

test('the thread id comes from Codex tool-call metadata', () => {
  assert.equal(hook.threadOf({ threadId: 'a' }), 'a')
  assert.equal(hook.threadOf({ 'x-codex-turn-metadata': { thread_id: 'b' } }), 'b')
  assert.equal(hook.threadOf(undefined), null)
})

test('hook stdin: a BOM is dropped; input that does not parse is kept for diagnosis', () => {
  const bad = path.join(home, 'codex-hook', 'last-bad-stdin')
  fs.rmSync(bad, { force: true })
  assert.deepEqual(hook.parseHookInput('\uFEFF{"session_id":"t"}'), { session_id: 't' })
  assert.equal(fs.existsSync(bad), false)
  assert.equal(hook.parseHookInput('not json ' + 'x'.repeat(5000)), null)
  const kept = fs.readFileSync(bad)
  assert.equal(kept.length, 4096)
  assert.ok(kept.toString().startsWith('not json'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(bad).mode & 0o777, 0o600)
  assert.equal(hook.parseHookInput(''), null)
})

test('the hook command reads UTF-8 with a BOM and UTF-16 stdin', async () => {
  const cli = path.join(path.dirname(SERVER), 'cli.mjs')
  const json = '{"session_id":"no-runs-here","hook_event_name":"Stop"}'
  for (const input of [Buffer.from('\uFEFF' + json), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])]) {
    const child = spawn(process.execPath, [cli, 'codex-stop-hook'], { env: { ...process.env, DSH_BATON_HOME: home } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stdin.end(input)
    const code = await new Promise((r) => child.on('exit', r))
    assert.equal(code, 0)
    assert.equal(out, '') // no runs for this conversation: the turn just ends
  }
})

test('taking the hook out drops the trust Codex gave it; the user\'s own hooks keep theirs', () => {
  const cfg = '/u/.codex/config.toml'
  const mine = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n'
  const trust = (file, g, hash, q = '"') => `\n[hooks.state.${q}${file}:stop:${g}:0${q}]\ntrusted_hash = "sha256:${hash}"\n`
  // Ours second: its record goes, the user's (first) stays as it is.
  const second = addHook(mine, WRAPPER) + trust(cfg, 0, 'mine') + `\n[hooks.state.'C:\\u\\.codex\\config.toml:stop:1:0']\ntrusted_hash = "sha256:old"\nenabled = true\n`
  const out = removeCodexHookBlock(second)
  assert.doesNotMatch(out, /codex-stop-hook|sha256:old|enabled = true/)
  assert.equal(out, mine + trust(cfg, 0, 'mine'))
  // Ours first: the user's group moves up a place, so its record is renumbered and stays trusted.
  const first = `${codexHookBlockFor(WRAPPER)}\n${mine}${trust(cfg, 0, 'ours')}${trust(cfg, 1, 'mine')}`
  assert.equal(removeCodexHookBlock(first, cfg), `${mine}${trust(cfg, 0, 'mine')}`)
  // Windows writes the key in single quotes; it keeps them.
  const win = 'C:\\u\\.codex\\config.toml'
  assert.equal(removeCodexHookBlock(`${codexHookBlockFor(WRAPPER)}\n${mine}${trust(win, 0, 'ours', "'")}${trust(win, 1, 'mine', "'")}`, win), `${mine}${trust(win, 0, 'mine', "'")}`)
  // Records of another config layer are not ours to touch.
  const other = trust('/p/.codex/hooks.json', 0, 'layer')
  assert.equal(removeCodexHookBlock(`${codexHookBlockFor(WRAPPER)}${trust(cfg, 0, 'ours')}${other}`, cfg), other.replace(/^\n/, ''))
})

test('moving the MCP table keeps an old hook block that follows it whole, for its removal', async () => {
  const { editCodexConfig } = await import('../src/register.mjs')
  const entry = { command: '/n', args: ['/s'] }
  const withHook = addHook(editCodexConfig('model = "x"\n', entry), WRAPPER)
  const block = withHook.slice(withHook.indexOf('# dsh-baton: wakes'))
  assert.match(withHook, /args = \['\/s'\]\ntool_timeout_sec = 3600\n\n# dsh-baton: wakes/, 'the hook block directly follows the MCP table')
  const moved = editCodexConfig(withHook, { command: '/n2', args: ['/s2'] })
  assert.ok(moved.includes(block.trimEnd()), 'marker and the 4 hook fields are kept byte for byte')
  assert.match(moved, /\[mcp_servers\.dsh-baton\]\ncommand = '\/n2'/)
  assert.equal(removeCodexHookBlock(moved), editCodexConfig('model = "x"\n', { command: '/n2', args: ['/s2'] }), 'and taken out whole')
  assert.equal(editCodexConfig(moved, null).includes('# dsh-baton: wakes'), true, 'removing the MCP server leaves the hook alone')
})

test('Codex\'s dsh_wait description never says to end the turn, even with a trusted hook still in config', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-codex-'))
  const cfg = path.join(codexHome, 'config.toml')
  const describe = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CODEX_HOME: codexHome, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(home, 'none.sock') } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.find((t) => t.name === 'dsh_wait').description))
    child.stdin.end([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } },
      { id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n')
  })
  const none = await describe()
  assert.doesNotMatch(none, /end your turn/)
  assert.match(none, /call dsh_wait again with the same run_id/)
  fs.writeFileSync(cfg, `${codexHookBlockFor(WRAPPER)}\n[hooks.state."${cfg}:stop:0:0"]\ntrusted_hash = "sha256:a"\n`)
  assert.equal(await describe(), none)
  fs.rmSync(codexHome, { recursive: true, force: true })
})
