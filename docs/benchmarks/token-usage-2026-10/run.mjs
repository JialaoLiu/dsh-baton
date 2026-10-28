// Runs the token-usage benchmark for one client.
//   node run.mjs --client codex|claude [--sizes small,medium,large] [--reps 2] [--arms A,B] [--start 1]
// Arm A: the client does the task alone (dsh-baton not loaded). Arm B: same prompt plus one line
// asking it to hand the task to DeepSeek Harness, with dsh-baton loaded. Every run starts a new
// conversation in a new empty folder. After a run the hidden check in checks/ is applied; on
// failure the same conversation gets the failures back, at most twice. One JSON line per run is
// appended to results/<client>.jsonl.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
const client = arg('client')
const sizes = arg('sizes', 'small,medium,large').split(',')
const arms = arg('arms', 'A,B').split(',')
const reps = Number(arg('reps', '2'))
const start = Number(arg('start', '1'))
// A label keeps runs of another dsh-baton build apart: own folders and results/<client>-<label>.jsonl.
const label = arg('label', '')
// --tasks natural: the plain-language requests in natural/ with behaviour checks (checks/natural-*.mjs).
const taskSet = arg('tasks', 'spec')
// --server: arm B uses this dsh-baton server.mjs (a worktree) instead of the installed ~/.dsh-baton/app.
const serverPath = path.resolve(arg('server', path.join(os.homedir(), '.dsh-baton', 'app', 'src', 'server.mjs')))
// --courier: the client gets the dsh-courier sub-agent (courier/), Luna for Codex, Haiku for Claude Code.
const courier = process.argv.includes('--courier')
const MAX_REWORK = 2
const ROOT = '/private/tmp/dshb-bench'

const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const CODEX_MODEL = arg('model', 'gpt-6.1-sol'), CODEX_EFFORT = 'high' // --model gpt-6-astra for the Astra check
// The newest Claude Code build the desktop app has installed (it updates itself).
const CLAUDE = (() => {
  const base = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code')
  const versions = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const v of versions.reverse()) for (const h of fs.readdirSync(path.join(base, v))) {
    const exe = path.join(base, v, h, 'claude.app/Contents/MacOS/claude')
    if (fs.existsSync(exe)) return exe
  }
  return null
})()
const CLAUDE_MODEL = 'claude-opus-5-5', CLAUDE_EFFORT = 'high'

const prompt = (size, arm) => taskSet === 'natural'
  ? fs.readFileSync(path.join(HERE, 'natural', `${size}.md`), 'utf8') + (arm === 'B' ? '\n交给 DeepSeek Harness 去做。\n' : '')
  : fs.readFileSync(path.join(HERE, 'prompts', `${size}-${arm === 'A' ? 'A-alone' : 'B-harness'}.md`), 'utf8')
const checkScript = (size) => path.join(HERE, 'checks', `${taskSet === 'natural' ? 'natural-' : ''}${size}.mjs`)
const reworkPrompt = (failures) => `验收没通过，失败项如下：\n${failures.map((f) => `- ${f}`).join('\n')}\n\n请修好。`

function exec(cmd, args, { cwd, input }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.end(input)
  })
}

// --- Codex -----------------------------------------------------------------------------------
async function codexTurn(dir, arm, text, thread) {
  const args = ['exec', '--json', '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${CODEX_EFFORT}"`, '--skip-git-repo-check', '-C', dir]
  if (arm === 'A') args.push('-c', 'mcp_servers.dsh-baton.enabled=false')
  else args.push('-c', `mcp_servers.dsh-baton.args=[${JSON.stringify(serverPath)}]`)
  if (thread) args.push('resume', thread)
  args.push('-')
  const r = await exec(CODEX, args, { cwd: dir, input: text })
  const started = r.out.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((e) => e?.type === 'thread.started')
  return { thread: thread || started?.thread_id, code: r.code, tail: r.err.slice(-500) }
}

function codexUsage(thread) {
  const file = spawnSync('find', [path.join(os.homedir(), '.codex/sessions'), '-name', `*${thread}*.jsonl`], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const counts = lines.filter((l) => l.type === 'event_msg' && l.payload?.type === 'token_count' && l.payload.info)
  const last = counts.at(-1).payload
  const items = lines.filter((l) => l.type === 'response_item').map((l) => l.payload)
  const calls = items.filter((p) => /call$/.test(p.type || ''))
  // Codex calls tools from an `exec` script (tools.mcp__dsh_baton__dsh_send(...)), so count names in the script.
  const dshCalls = {}
  for (const c of calls) for (const [, n] of JSON.stringify(c.input ?? c.arguments ?? '').matchAll(/mcp__dsh_baton__(dsh_\w+)/g)) dshCalls[n] = (dshCalls[n] || 0) + 1
  return {
    rollout: file,
    gpt: last.info.total_token_usage,
    model_requests: counts.length,
    tool_calls: calls.length,
    dsh_calls: dshCalls,
    rate_limit_used_percent: last.rate_limits?.primary?.used_percent ?? null,
  }
}

// The 5-hour window's used percent right now, from Codex's own app-server (window.mjs).
function codexWindow() {
  const r = spawnSync('node', [path.join(HERE, 'window.mjs')], { encoding: 'utf8', timeout: 60000 })
  try { return JSON.parse(r.stdout).rateLimits.primary.usedPercent } catch { return null }
}

// --- Claude Code -----------------------------------------------------------------------------
async function claudeTurn(dir, arm, text, session) {
  // Arm A loads no MCP server; arm B loads only the installed dsh-baton (~/.dsh-baton/app).
  const cfg = path.join(os.tmpdir(), `dshb-bench-mcp-${arm}.json`)
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: arm === 'A' ? {} : { 'dsh-baton': { command: process.execPath, args: [serverPath] } } }))
  const args = ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL, '--effort', CLAUDE_EFFORT, '--dangerously-skip-permissions', '--strict-mcp-config', '--mcp-config', cfg]
  if (courier && arm === 'B') args.push('--agents', path.join(HERE, 'courier', 'claude-agents.json'))
  if (session) args.push('--resume', session)
  const r = await exec(CLAUDE, args, { cwd: dir, input: text })
  let res = null
  try { res = JSON.parse(r.out) } catch {}
  return { thread: session || res?.session_id, code: r.code, result: res, tail: (r.err || r.out).slice(-500) }
}

function claudeUsage(session, results) {
  const sum = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
  let cost = 0, turns = 0
  for (const r of results) {
    if (!r) continue
    cost += r.total_cost_usd || 0
    turns += r.num_turns || 0
    for (const m of Object.values(r.modelUsage || {})) {
      sum.input_tokens += m.inputTokens; sum.cache_creation_input_tokens += m.cacheCreationInputTokens
      sum.cache_read_input_tokens += m.cacheReadInputTokens; sum.output_tokens += m.outputTokens
    }
  }
  // Tool calls from the transcript.
  const file = spawnSync('find', [path.join(os.homedir(), '.claude/projects'), '-name', `${session}.jsonl`], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
  const dshCalls = {}
  let toolCalls = 0, requests = new Set()
  if (file) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const o = JSON.parse(l)
      if (o.type !== 'assistant') continue
      requests.add(o.message?.id)
      for (const c of o.message?.content || []) {
        if (c.type !== 'tool_use') continue
        toolCalls++
        if (/dsh/.test(c.name)) dshCalls[c.name] = (dshCalls[c.name] || 0) + 1
      }
    }
  }
  return { transcript: file, claude: sum, cost_usd: Number(cost.toFixed(4)), num_turns: turns, model_requests: requests.size, tool_calls: toolCalls, dsh_calls: dshCalls }
}

// --- DeepSeek Harness side -------------------------------------------------------------------
function harnessUsage(dir) {
  const slug = `--${dir.slice(1).replace(/\//g, '-')}--`
  const base = path.join(os.homedir(), '.dsh/sessions', slug)
  if (!fs.existsSync(base)) return null
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
  const models = new Set()
  let messages = 0, sessions = 0
  for (const s of fs.readdirSync(base).filter((n) => n.startsWith('session-'))) {
    const f = path.join(base, s, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    sessions++
    const text = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout
    for (const [, m] of text.matchAll(/"model":"([^"]+)"/g)) models.add(m)
    for (const l of text.split('\n')) {
      if (!l.includes('"usage"')) continue
      let o; try { o = JSON.parse(l) } catch { continue }
      const u = o.data?.usage
      if (!u) continue
      messages++
      for (const k of Object.keys(sum)) sum[k] += u[k] || 0
    }
  }
  return { sessions, model_requests: messages, deepseek: sum, models: [...models] }
}

// --- One run ---------------------------------------------------------------------------------
async function runOne(size, arm, rep) {
  const dir = path.join(ROOT, `${client}-${taskSet === 'natural' ? 'n' : ''}${size}-${arm}-${rep}${label ? `-${label}` : ''}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const turn = client === 'codex' ? codexTurn : claudeTurn
  const windowBefore = client === 'codex' ? codexWindow() : null
  const t0 = Date.now()
  const turns = []
  let thread = null, check = null, reworks = 0
  let text = prompt(size, arm)
  for (;;) {
    const r = await turn(dir, arm, text, thread)
    thread = r.thread
    turns.push({ code: r.code, result: r.result, tail: r.code ? r.tail : undefined })
    const c = spawnSync('node', [checkScript(size), dir], { encoding: 'utf8', timeout: 300000 })
    try { check = JSON.parse(c.stdout) } catch { check = { pass: false, failures: [`check crashed: ${(c.stderr || c.stdout).slice(-300)}`] } }
    if (check.pass || reworks >= MAX_REWORK || !thread) break
    reworks++
    text = reworkPrompt(check.failures)
  }
  const wall_s = Math.round((Date.now() - t0) / 1000)
  const usage = client === 'codex' ? codexUsage(thread) : claudeUsage(thread, turns.map((t) => t.result))
  const windowAfter = client === 'codex' ? codexWindow() : null
  const row = {
    client, label: label || 'baseline', tasks: taskSet, server: serverPath, courier, model: client === 'codex' ? `${CODEX_MODEL} (${CODEX_EFFORT})` : `${CLAUDE_MODEL} (${CLAUDE_EFFORT})`,
    size, arm, rep, dir, thread, at: new Date().toISOString(), wall_s,
    pass: check.pass, checks_passed: check.passed, checks_failed: check.failed, failures: check.failures,
    reworks, exit_codes: turns.map((t) => t.code), errors: turns.map((t) => t.tail).filter(Boolean),
    ...usage,
    ...(client === 'codex' ? { window_before: windowBefore, window_after: windowAfter } : {}),
    harness: arm === 'B' ? harnessUsage(dir) : null,
  }
  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true })
  // Paths are stored under ~ so the results can be published without the local user name.
  fs.appendFileSync(path.join(HERE, 'results', `${client}${label ? `-${label}` : ''}.jsonl`), JSON.stringify(row).replaceAll(os.homedir(), '~') + '\n')
  console.log(`${client}${label ? ` [${label}]` : ''} ${size} ${arm} #${rep}: pass=${row.pass} reworks=${reworks} wall=${wall_s}s`)
}

// The Codex courier is a custom agent file, which Codex reads only from ~/.codex/agents/: it is
// put there for these runs and removed afterwards.
const codexAgent = path.join(os.homedir(), '.codex', 'agents', 'dsh-courier.toml')
if (courier && client === 'codex') { fs.mkdirSync(path.dirname(codexAgent), { recursive: true }); fs.copyFileSync(path.join(HERE, 'courier', 'dsh-courier.toml'), codexAgent) }
try {
  for (let rep = start; rep < start + reps; rep++) for (const size of sizes) for (const arm of arms) await runOne(size, arm, rep)
} finally {
  if (courier && client === 'codex') fs.rmSync(codexAgent, { force: true })
}
