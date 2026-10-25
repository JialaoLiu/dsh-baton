// Turns results/<client>.jsonl into results/runs.csv, results/summary.json and a Markdown table.
//   node summarize.mjs
import fs from 'node:fs'
import path from 'node:path'

const HERE = import.meta.dirname
const rows = fs.readdirSync(path.join(HERE, 'results')).filter((f) => f.endsWith('.jsonl')).sort()
  .flatMap((f) => fs.readFileSync(path.join(HERE, 'results', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .map((r) => ({ label: 'baseline', ...r }))
  // A run that broke the protocol (an arm B run that never handed the task over) is kept in the raw
  // data but left out of the tables.
  .filter((r) => r.valid !== false)

// Codex's input_tokens already include cached input; Claude's three input fields are disjoint.
const input = (r) => r.gpt ? r.gpt.input_tokens : r.claude.input_tokens + r.claude.cache_creation_input_tokens + r.claude.cache_read_input_tokens
const cached = (r) => r.gpt ? r.gpt.cached_input_tokens : r.claude.cache_read_input_tokens
const output = (r) => r.gpt ? r.gpt.output_tokens : r.claude.output_tokens
const reasoning = (r) => r.gpt ? r.gpt.reasoning_output_tokens : null
const uncached = (r) => input(r) - cached(r)
const dshSends = (r) => Object.entries(r.dsh_calls || {}).filter(([k]) => /dsh_send$/.test(k)).reduce((a, [, v]) => a + v, 0)

const flat = rows.map((r) => ({
  client: r.client, label: r.label, model: r.model, size: r.size, arm: r.arm, rep: r.rep, pass: r.pass, reworks: r.reworks, wall_s: r.wall_s,
  model_requests: r.model_requests, tool_calls: r.tool_calls, dsh_sends: dshSends(r),
  input: input(r), cached_input: cached(r), uncached_input: uncached(r), output: output(r), reasoning: reasoning(r),
  claude_cost_usd: r.cost_usd ?? null,
  deepseek_requests: r.harness?.model_requests ?? null, deepseek_input: r.harness ? r.harness.deepseek.inputTokens + r.harness.deepseek.cacheReadTokens : null,
  deepseek_cached: r.harness?.deepseek.cacheReadTokens ?? null, deepseek_output: r.harness?.deepseek.outputTokens ?? null,
  deepseek_model: r.harness?.models?.join(' ') ?? null,
}))
const cols = Object.keys(flat[0])
fs.writeFileSync(path.join(HERE, 'results', 'runs.csv'), [cols.join(','), ...flat.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n')

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const groups = {}
for (const r of flat) (groups[`${r.client}|${r.label}|${r.size}|${r.arm}`] ??= []).push(r)
const summary = Object.entries(groups).map(([k, g]) => {
  const [client, label, size, arm] = k.split('|')
  const stat = (f) => { const v = g.map(f); return { mean: Math.round(mean(v)), min: Math.min(...v), max: Math.max(...v) } }
  return {
    client, label, size, arm, runs: g.length, passed: g.filter((r) => r.pass).length, reworks: g.map((r) => r.reworks),
    input: stat((r) => r.input), uncached_input: stat((r) => r.uncached_input), output: stat((r) => r.output),
    reasoning: g[0].reasoning === null ? null : stat((r) => r.reasoning),
    model_requests: stat((r) => r.model_requests), wall_s: stat((r) => r.wall_s), dsh_sends: stat((r) => r.dsh_sends),
    claude_cost_usd: g[0].claude_cost_usd === null ? null : Number(mean(g.map((r) => r.claude_cost_usd)).toFixed(3)),
    deepseek_input: arm === 'B' ? stat((r) => r.deepseek_input ?? 0) : null,
    deepseek_output: arm === 'B' ? stat((r) => r.deepseek_output ?? 0) : null,
  }
})
fs.writeFileSync(path.join(HERE, 'results', 'summary.json'), JSON.stringify(summary, null, 2) + '\n')

const n = (x) => x.toLocaleString('en-US')
const cell = (s) => s.min === s.max ? n(s.mean) : `${n(s.mean)} (${n(s.min)}–${n(s.max)})`
const order = ['small', 'medium', 'large']
for (const client of ['codex', 'claude']) for (const label of [...new Set(summary.map((s) => s.label))]) {
  const rowsOf = summary.filter((s) => s.client === client && s.label === label).sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size) || a.arm.localeCompare(b.arm))
  if (!rowsOf.length) continue
  console.log(`\n### ${client} (${label})\n`)
  console.log('| Size | Arm | Passed | Reworks | Input | Uncached input | Output | Model requests | Wall time (s) | DeepSeek input / output |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const s of rowsOf) console.log(`| ${s.size} | ${s.arm} | ${s.passed}/${s.runs} | ${s.reworks.join(', ')} | ${cell(s.input)} | ${cell(s.uncached_input)} | ${cell(s.output)} | ${cell(s.model_requests)} | ${cell(s.wall_s)} | ${s.deepseek_input ? `${cell(s.deepseek_input)} / ${cell(s.deepseek_output)}` : '-'} |`)
  if (!rowsOf.some((s) => s.arm === 'A')) continue // a build measured on arm B only has no ratio to show
  console.log('\n| Size | B / A input | B / A uncached input | B / A output |')
  console.log('|---|---|---|---|')
  for (const size of order) {
    const a = rowsOf.find((s) => s.size === size && s.arm === 'A'), b = rowsOf.find((s) => s.size === size && s.arm === 'B')
    if (a && b) console.log(`| ${size} | ${(b.input.mean / a.input.mean).toFixed(2)} | ${(b.uncached_input.mean / a.uncached_input.mean).toFixed(2)} | ${(b.output.mean / a.output.mean).toFixed(2)} |`)
  }
}
