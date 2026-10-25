// Charts for the natural-language round (results/*-n*.jsonl): the client's own cost per accepted
// task for each way of working, with DeepSeek stacked on top in grey, and the Codex 5-hour window
// used per task. Bars are the mean of the runs, labelled with the change against working alone. Large tasks
// use only runs made after the large check was fixed: earlier ones had one or two false reworks (bug 7).
// Codex runs that overlapped another Codex run share the account-wide 5-hour window, so their
// window share is estimated from GPT cost at the ratio measured on runs that ran alone.
//   node charts-natural.mjs [--zh]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = import.meta.dirname
const ZH = process.argv.includes('--zh')
// --astra: the same Codex token counts priced as GPT-6 Astra (a what-if for people who run Astra;
// Astra may use a different number of tokens, so this is an estimate, not a measurement).
const ASTRA = process.argv.includes('--astra')
// --release: only working alone vs the released build (0.6.0 = the review-table build), for the
// README; files get a -release suffix. Every chart of a set shows the same bars in the same order.
const RELEASE = process.argv.includes('--release')
// --combined: one chart, working alone vs 0.6.0 only, for Claude Code, Codex and Codex priced as
// Astra, with the model named under each pair of bars.
const COMBINED = process.argv.includes('--combined')
const OUT = path.join(HERE, 'charts')
fs.mkdirSync(OUT, { recursive: true })

const PRICE = { sol: ASTRA ? { input: 10, cached: 1, output: 50 } : { input: 2, cached: 0.10, output: 10 }, deepseek: { miss: 0.30, hit: 0.006, output: 1.20 } }
const rows = fs.readdirSync(path.join(HERE, 'results')).filter((f) => /-n\w+\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(path.join(HERE, 'results', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => r.tasks === 'natural' && r.valid !== false)

// Large runs that ended before the large check was fixed (bug 7, 2026-10-25 23:45 local) are left out.
const CHECK_FIXED = Date.parse('2026-10-25T13:15:00Z')
const valid = (r) => r.size !== 'large' || Date.parse(r.at) > CHECK_FIXED

const home = (p) => p.replace(/^~/, os.homedir())
const ASTRA_PRICE = { input: 10, cached: 1, output: 50 }
const costAt = (g, p) => ((g.input_tokens - g.cached_input_tokens) * p.input + g.cached_input_tokens * p.cached + g.output_tokens * p.output) / 1e6
const solCost = (g) => costAt(g, PRICE.sol)
const lastUsage = (file) => {
  const l = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.includes('"total_token_usage"')).at(-1)
  return l ? JSON.parse(l).payload.info.total_token_usage : null
}
// Codex courier runs: the sub-agent has its own rollout, started from the main thread; priced at Sol rates (upper bound).
function courierCost(r) {
  const dir = path.dirname(home(r.rollout))
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes(r.thread))
    .map((f) => path.join(dir, f)).filter((f) => { const head = fs.readFileSync(f, 'utf8').slice(0, 20000); return head.includes(r.thread) && head.includes(r.dir) })
    .reduce((a, f) => { const u = lastUsage(f); return a + (u ? solCost(u) : 0) }, 0)
}
// Runs made with Astra (--model gpt-6-astra) are priced as Astra; the rest as Sol (or Astra under --astra).
const mainCost = (r) => (r.gpt ? (/astra/.test(r.model) ? costAt(r.gpt, ASTRA_PRICE) : solCost(r.gpt)) + (r.courier ? courierCost(r) : 0) : r.cost_usd)
const dsCost = (r) => (r.harness ? (r.harness.deepseek.inputTokens * PRICE.deepseek.miss + r.harness.deepseek.cacheReadTokens * PRICE.deepseek.hit + r.harness.deepseek.outputTokens * PRICE.deepseek.output) / 1e6 : 0)
function measuredQuota(r) {
  const seen = fs.readFileSync(home(r.rollout), 'utf8').split('\n').filter((l) => l.includes('"token_count"') && l.includes('used_percent'))
    .map((l) => JSON.parse(l).payload.rate_limits?.primary?.used_percent).filter((v) => typeof v === 'number')
  return seen.length ? seen.at(-1) - seen[0] : null
}
const span = (r) => [Date.parse(r.at) - r.wall_s * 1000, Date.parse(r.at)]
const codexRows = rows.filter((r) => r.client === 'codex' && r.rollout)
// Back-to-back runs touch at the ends (start is derived from wall_s), so only a real overlap counts.
const overlapped = (r) => { const [a, b] = span(r); return codexRows.some((o) => o !== r && Math.min(b, span(o)[1]) - Math.max(a, span(o)[0]) > 120_000) }
const alone = codexRows.filter((r) => !overlapped(r) && measuredQuota(r) !== null && valid(r))
export const DOLLARS_PER_PERCENT = alone.reduce((a, r) => a + mainCost(r), 0) / alone.reduce((a, r) => a + measuredQuota(r), 0)
const quota = (r) => (overlapped(r) ? { v: mainCost(r) / DOLLARS_PER_PERCENT, estimated: true } : { v: measuredQuota(r), estimated: false })

const C = { FG: '#0F172A', MUTED: '#5B6577', GRID: '#E2E7EF', BG: '#FFFFFF', DS: '#C3CAD5' }
// Validated categorical order (dataviz validator: lightness, chroma, contrast pass; one CVD pair at 7.8, so every bar is also named).
// The courier build (one run per cell, costlier for Codex) is left out; the report has its numbers.
// The 0.5.9 hand-over is left out of the charts too (the report table keeps it): the charts
// compare working alone with the builds that could ship.
const METHODS = [
  { key: 'A', label: 'n059', color: '#C27803', zh: '自己做', en: 'Alone' },
  { key: 'B', label: 'nevidence', color: '#0E9F6E', zh: '加证据', en: 'Evidence' },
  { key: 'B', label: 'nlean', color: '#7C3AED', zh: '精简证据', en: 'Lean evidence' },
  { key: 'B', label: 'nreview', color: '#C0267A', zh: '复查表', en: 'Review table' },
]
if (RELEASE) METHODS.splice(1, METHODS.length - 1, { key: 'B', label: 'nreview', color: '#2563EB', zh: '转交（0.6.0）', en: 'Handed over (0.6.0)' })
const T = ZH
  ? { medium: '中号任务', large: '大号任务', ds: 'DeepSeek 费用（按高峰价，不占主 Agent 额度）', title: (c) => `${c}：主 Agent 每个任务花多少钱（按标价，美元）`, note: '只算主 Agent 自己的花费（占订阅额度的部分），不含 DeepSeek。', totalTitle: (c) => `${c}：加上 DeepSeek 的总价（美元）`, totalNote: '彩色 = 主 Agent，灰色 = DeepSeek（按高峰价）；“自己做”不用 DeepSeek，所以没有灰色。柱顶 = 合计，两段交界处 = 只算主 Agent。', note2: '每根柱子是跑 3 次的平均值。绿色百分比 = 比自己做省多少，红色 = 比自己做贵多少。', quotaTitle: 'Codex Plus：每个任务占用的 5 小时额度（%）', quotaNote: '同时跑的几次按 GPT 花费估算（约每 1% 对应 $RATE），单独跑的为实测。' }
  : { medium: 'Medium task', large: 'Large task', ds: 'DeepSeek cost (peak price, not the client’s quota)', title: (c) => `${c}: the client’s own cost per task (list price, USD)`, note: 'Only the client model (the part that uses the subscription quota), without DeepSeek.', totalTitle: (c) => `${c}: total with DeepSeek (USD)`, totalNote: 'Colour = client model, grey = DeepSeek (peak price); working alone uses no DeepSeek, so it has no grey. Top = total; where the two meet = the client alone.', note2: 'Each bar is the mean of 3 runs. Green % = cheaper than working alone, red % = dearer.', quotaTitle: 'Codex Plus: 5-hour window used per task (%)', quotaNote: 'Runs that overlapped are estimated from GPT cost (about $RATE per 1%); runs alone are measured.' }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const FONT = `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"`
const textW = (s, px) => [...s].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? px : px * 0.56), 0)

const pick = (client, size, m) => rows.filter((r) => r.client === client && r.size === size && r.arm === m.key && r.label === m.label && valid(r))

function chart({ title, note, note2, groups, legend, unit, file, foot, width = 940, height = 450, innerBelow = false }) {
  const W = width, H = height, L = 60, R = 24, TOP = 96, BOT = groups.some((g) => g.section) ? 156 : 92
  const max = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.parts.reduce((a, p) => a + p.v, 0))))
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find((s) => max / s <= 5) ?? 20
  const top = Math.ceil(max / step) * step
  const y = (v) => TOP + (H - TOP - BOT) * (1 - v / top)
  const gw = (W - L - R) / groups.length
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="${C.BG}"/>`,
    `<text x="20" y="30" font-size="17" font-weight="600" fill="${C.FG}">${esc(title)}</text>`,
    `<text x="20" y="53" font-size="12.5" fill="${C.MUTED}">${esc(note)}</text>`]
  if (note2) out.push(`<text x="20" y="72" font-size="12.5" fill="${C.MUTED}">${esc(note2)}</text>`)
  for (let v = 0; v <= top + 1e-9; v += step) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C.GRID}"/>`, `<text x="${L - 8}" y="${y(v) + 4}" font-size="11.5" fill="${C.MUTED}" text-anchor="end">${unit(v)}</text>`)
  }
  groups.forEach((g, gi) => {
    const n = g.bars.length, gap = 10, bw = Math.min(64, (gw - 40 - gap * (n - 1)) / n), x0 = L + gi * gw + (gw - n * bw - (n - 1) * gap) / 2
    g.bars.forEach((b, bi) => {
      const x = x0 + bi * (bw + gap), cx = x + bw / 2
      out.push(`<text x="${cx}" y="${y(0) + 17}" font-size="11.5" fill="${C.FG}" text-anchor="middle">${esc(b.name)}</text>`)
      if (!b.parts.length) { out.push(`<text x="${cx}" y="${y(0) - 8}" font-size="11" fill="${C.MUTED}" text-anchor="middle">${ZH ? '未测' : 'not run'}</text>`); return }
      let acc = 0
      b.parts.forEach((p, pi) => {
        if (p.v <= 0) return
        const y1 = y(acc + p.v), y0 = y(acc)
        const last = b.parts.slice(pi + 1).every((q) => q.v <= 0)
        out.push(last
          ? `<path d="M${x},${y0} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${y1 + 4} V${y0} Z" fill="${p.color}"/>`
          : `<rect x="${x}" y="${y1 + 2}" width="${bw}" height="${Math.max(0, y0 - y1 - 2)}" fill="${p.color}"/>`)
        acc += p.v
      })
      // The value sits on the bar it describes; under it, the change against working alone.
      const value = b.label ?? b.parts[0].v
      out.push(`<text x="${cx}" y="${y(acc) - (b.change ? 22 : 8)}" font-size="13" font-weight="600" fill="${C.FG}" text-anchor="middle">${unit(value, true)}${b.est ? '≈' : ''}</text>`)
      const changeColor = (c) => (c.startsWith('+') ? '#B42318' : '#067647')
      if (b.change) out.push(`<text x="${cx}" y="${y(acc) - 7}" font-size="11.5" font-weight="600" fill="${changeColor(b.change)}" text-anchor="middle">${b.change}</text>`)
      // In a stacked bar, the client's own cost is written at the bottom of the grey DeepSeek
      // part, just above the coloured part it measures (two lines when the grey part has room).
      // When the grey part is too thin for the text, it goes just inside the top of the coloured part, in white.
      if (b.inner && innerBelow) {
        out.push(`<text x="${cx}" y="${y(0) + 34}" font-size="11" fill="${C.MUTED}" text-anchor="middle">${ZH ? '主 Agent ' : 'client '}${unit(b.inner.value, true)}<tspan dx="6" font-weight="600" fill="${changeColor(b.inner.change)}">${b.inner.change}</tspan></text>`)
      } else if (b.inner) {
        const lines = b.inner.change ? 2 : 1
        const inGrey = y(b.parts[0].v) - y(acc) >= 16 * lines + 10
        const first = inGrey ? y(b.parts[0].v) - 8 - 15 * (lines - 1) : y(b.parts[0].v) + 18
        const ink = inGrey ? C.FG : '#FFFFFF'
        out.push(`<text x="${cx}" y="${first}" font-size="12" font-weight="600" fill="${ink}" text-anchor="middle">${unit(b.inner.value, true)}</text>`)
        if (lines === 2) out.push(`<text x="${cx}" y="${first + 15}" font-size="11" font-weight="600" fill="${inGrey ? changeColor(b.inner.change) : '#FFFFFF'}" text-anchor="middle">${b.inner.change}</text>`)
      }
    })
    out.push(`<text x="${L + gi * gw + gw / 2}" y="${y(0) + (innerBelow ? 58 : 40)}" font-size="13.5" font-weight="600" fill="${C.FG}" text-anchor="middle">${esc(g.name)}</text>`)
  })
  // A section label (the model) under each run of groups that share it, with a rule above it.
  for (let i = 0; i < groups.length;) {
    let j = i
    while (j + 1 < groups.length && groups[j + 1].section === groups[i].section) j++
    if (groups[i].section) {
      const x0 = L + i * gw + 12, x1 = L + (j + 1) * gw - 12
      out.push(`<line x1="${x0}" x2="${x1}" y1="${y(0) + 70}" y2="${y(0) + 70}" stroke="${C.GRID}" stroke-width="2"/>`,
        `<text x="${(x0 + x1) / 2}" y="${y(0) + 90}" font-size="13.5" font-weight="600" fill="${C.FG}" text-anchor="middle">${esc(groups[i].section)}</text>`)
    }
    i = j + 1
  }
  let lx = 20
  for (const it of legend) {
    out.push(`<rect x="${lx}" y="${H - 34}" width="12" height="12" rx="2" fill="${it.color}"/>`, `<text x="${lx + 18}" y="${H - 24}" font-size="12.5" fill="${C.FG}">${esc(it.name)}</text>`)
    lx += 34 + textW(it.name, 13)
  }
  if (foot) out.push(`<text x="20" y="${H - 8}" font-size="11.5" fill="${C.MUTED}">${esc(foot)}</text>`)
  out.push('</svg>')
  const svg = path.join(OUT, `${file}${ZH ? '.zh' : ''}.svg`)
  fs.writeFileSync(svg, out.join('\n') + '\n')
  spawnSync('rsvg-convert', ['-z', '2', '-o', svg.replace(/\.svg$/, '.png'), svg])
}

const name = (m) => (ZH ? m.zh : m.en)
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length
// Change against working alone, as people read it: "−53%" cheaper, "+27%" dearer.
const change = (v, base) => (base ? `${v < base ? '−' : '+'}${Math.round(Math.abs(v / base - 1) * 100)}%` : '')
// Only the ways of working that were run for this client.
// The same bars for every client and chart, so the charts line up; a bar with no runs says so.
const methodsFor = () => METHODS
for (const client of ASTRA ? ['codex'] : ['codex', 'claude']) {
  const who = client === 'codex' ? (ASTRA ? (ZH ? 'Codex 换算成 GPT-6 Astra high' : 'Codex priced as GPT-6 Astra high') : 'Codex（gpt-6.1-sol high）') : 'Claude Code（Opus 5.5 high）'
  const cells = (withDs) => ['medium', 'large'].map((size) => {
    const total = (list) => mean(list.map((r) => mainCost(r) + (withDs ? dsCost(r) : 0)))
    const base = pick(client, size, METHODS[0])
    return {
      name: T[size],
      bars: methodsFor(client).map((m) => {
        const list = pick(client, size, m)
        if (!list.length) return { name: name(m), parts: [] }
        const parts = [{ v: mean(list.map(mainCost)), color: m.color }, ...(withDs ? [{ v: mean(list.map(dsCost)), color: C.DS }] : [])]
        const own = mean(list.map(mainCost))
        const ownBase = base.length ? mean(base.map(mainCost)) : 0
        const isBase = m === METHODS[0] || !base.length
        // Total on top; with DeepSeek in the bar, the client's own cost too, inside it.
        const inner = withDs && list.some((r) => dsCost(r) > 0) ? { value: own, change: isBase ? '' : change(own, ownBase) } : undefined
        return { name: name(m), label: total(list), change: isBase ? '' : change(total(list), total(base)), inner, parts }
      }),
    }
  })
  const legend = methodsFor(client).map((m) => ({ name: name(m), color: m.color }))
  const astraNote = ZH ? '估算：用 Sol 实测的 token 数，按 Astra 标价（每百万 输入 $10、缓存 $1、输出 $50）重新计价；3 次平均。' : 'Estimate: the token counts measured with Sol, priced at Astra list prices ($10 input, $1 cached, $50 output per million); mean of 3 runs.'
  const n2 = ASTRA ? astraNote : T.note2
  chart({ title: T.title(who), note: T.note, note2: n2, groups: cells(false), file: `natural-cost-${client}${ASTRA ? '-astra' : ''}${RELEASE ? '-release' : ''}`, unit: (v) => `$${v.toFixed(2)}`, legend })
  chart({ title: T.totalTitle(who), note: T.totalNote, note2: n2, groups: cells(true), file: `natural-total-${client}${ASTRA ? '-astra' : ''}${RELEASE ? '-release' : ''}`, unit: (v) => `$${v.toFixed(2)}`, legend: [...legend, { name: T.ds, color: C.DS }] })
}

const quotaGroups = ['medium', 'large'].map((size) => ({
  name: T[size],
  bars: methodsFor('codex').map((m) => {
    const q = pick('codex', size, m).map(quota).filter((x) => x.v !== null)
    if (!q.length) return { name: name(m), parts: [] }
    const base = pick('codex', size, METHODS[0]).map(quota).filter((x) => x.v !== null).map((x) => x.v)
    const v = mean(q.map((x) => x.v))
    return { name: name(m), est: q.some((x) => x.estimated), change: m === METHODS[0] || !base.length ? '' : change(v, mean(base)), parts: [{ v, color: m.color }] }
  }),
}))
if (!ASTRA) chart({ title: T.quotaTitle, note: T.quotaNote.replace('$RATE', `$${DOLLARS_PER_PERCENT.toFixed(3)}`), note2: ZH ? '每根柱子是 3 次的平均值；≈ 表示含估算。绿色百分比 = 比自己做省多少。' : 'Each bar is the mean of 3 runs; ≈ marks estimates. Green % = less than working alone.', groups: quotaGroups, file: `natural-codex-quota${RELEASE ? '-release' : ''}`, unit: (v) => `${v.toFixed(1)}%`, legend: methodsFor('codex').map((m) => ({ name: name(m), color: m.color })) })
// One row, two panels with their own y-axis (Claude Code costs several times what Codex does):
// working alone vs 0.6.0 only. The total sits on top of each hand-over bar; the client's own
// cost sits inside the bar where the grey DeepSeek part meets the blue client part.
if (COMBINED) {
  const handedLabel = 'nreview', DS_NAME = 'DeepSeek V4.1 Flash 1017'
  const cell = (client, size, label, sub) => {
    const base = pick(client, size, { ...METHODS[0], label: label ?? METHODS[0].label })
    const list = pick(client, size, { key: 'B', label: label ?? handedLabel })
    const alone = mean(base.map(mainCost)), own = mean(list.map(mainCost)), ds = mean(list.map(dsCost))
    return { size, sub, alone, own, ds, total: own + ds }
  }
  const panels = [
    { title: 'Claude Code · Opus 5.5 high', cells: [cell('claude', 'medium'), cell('claude', 'large')] },
    { title: 'Codex · GPT-6.1 Sol high', cells: [cell('codex', 'medium'), cell('codex', 'large')] },
    { title: 'Codex · GPT-6 Astra high', cells: [cell('codex', 'medium', 'nastra', ZH ? '转交为 2 次平均' : 'hand-over: mean of 2'), cell('codex', 'large', 'nastra', ZH ? '各 1 次' : '1 run each')] },
  ]
  const W = 1600, H = 640, TOP = 120, BOT = 150, GAP = 76, LEFT = 70
  const usable = W - LEFT - 30 - GAP * (panels.length - 1) - 20
  const n = panels.reduce((a, p) => a + p.cells.length, 0)
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="${C.BG}"/>`,
    `<text x="24" y="38" font-size="20" font-weight="600" fill="${C.FG}">${esc(ZH ? '自己做 vs 交给 DeepSeek Harness（0.6.0）：每个任务花多少钱' : 'Working alone vs handing over to DeepSeek Harness (0.6.0): cost per task')}</text>`,
    `<text x="24" y="66" font-size="13.5" fill="${C.MUTED}">${esc(ZH ? '柱顶 = 含 DeepSeek 的总价；柱子里 = 只算主 Agent。绿色 = 比自己做省，红色 = 比自己做贵。美元，按标价。' : 'Top = total with DeepSeek; inside = the client alone. Green = less than working alone, red = more. USD, list price.')}</text>`]
  const pct = (v, b) => `${v < b ? '−' : '+'}${Math.round(Math.abs(v / b - 1) * 100)}%`
  const col = (c) => (c.startsWith('+') ? '#B42318' : '#067647')
  let x = LEFT
  for (const pnl of panels) {
    const pw = usable * pnl.cells.length / n
    const max = Math.max(...pnl.cells.flatMap((c) => [c.alone, c.total]))
    const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1].find((st) => max / st <= 5) ?? 2
    const top = Math.ceil(max * 1.12 / step) * step
    const y = (v) => TOP + (H - TOP - BOT) * (1 - v / top)
    out.push(`<text x="${x + pw / 2}" y="${TOP - 22}" font-size="15" font-weight="600" fill="${C.FG}" text-anchor="middle">${esc(pnl.title)}</text>`)
    for (let v = 0; v <= top + 1e-9; v += step) {
      out.push(`<line x1="${x}" x2="${x + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${C.GRID}"/>`, `<text x="${x - 8}" y="${y(v) + 4}" font-size="11.5" fill="${C.MUTED}" text-anchor="end">$${v.toFixed(2)}</text>`)
    }
    const gw = pw / pnl.cells.length
    pnl.cells.forEach((c, gi) => {
      const bw = Math.min(104, gw / 2 - 16), cx0 = x + gi * gw + gw / 2
      const xa = cx0 - bw - 6, xb = cx0 + 6
      const roundTop = (bx, y0, y1, fill) => `<path d="M${bx},${y0} V${y1 + 4} Q${bx},${y1} ${bx + 4},${y1} H${bx + bw - 4} Q${bx + bw},${y1} ${bx + bw},${y1 + 4} V${y0} Z" fill="${fill}"/>`
      // alone
      out.push(roundTop(xa, y(0), y(c.alone), METHODS[0].color), `<text x="${xa + bw / 2}" y="${y(c.alone) - 8}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">$${c.alone.toFixed(2)}</text>`)
      // handed: blue (client) + grey (DeepSeek)
      out.push(`<rect x="${xb}" y="${y(c.own)}" width="${bw}" height="${y(0) - y(c.own)}" fill="#2563EB"/>`, roundTop(xb, y(c.own) - 2, y(c.total), C.DS))
      const totalC = pct(c.total, c.alone), ownC = pct(c.own, c.alone)
      out.push(`<text x="${xb + bw / 2}" y="${y(c.total) - 24}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">$${c.total.toFixed(2)}</text>`,
        `<text x="${xb + bw / 2}" y="${y(c.total) - 8}" font-size="12.5" font-weight="600" fill="${col(totalC)}" text-anchor="middle">${totalC}</text>`)
      // client-only label at the bottom of the grey part (inside the grey when it fits, else white at the top of the blue)
      const greyH = y(c.own) - y(c.total), blueH = y(0) - y(c.own)
      // Three short lines (label, amount, change) so they fit the bar's width.
      const inGrey = greyH >= 58
      const l1 = inGrey ? y(c.own) - 40 : y(c.own) + 18
      if (!inGrey && blueH < 58 && blueH >= 36) {
        // Short blue part: two lines, label and amount together.
        out.push(`<text x="${xb + bw / 2}" y="${y(c.own) + 17}" font-size="12" font-weight="600" fill="#FFFFFF" text-anchor="middle">${ZH ? '主 Agent' : 'client'} $${c.own.toFixed(2)}</text>`,
          `<text x="${xb + bw / 2}" y="${y(c.own) + 33}" font-size="12" font-weight="700" fill="#FFFFFF" text-anchor="middle">${ownC}</text>`)
      } else if (inGrey || blueH >= 58) {
        const ink = inGrey ? C.FG : '#FFFFFF'
        out.push(`<text x="${xb + bw / 2}" y="${l1}" font-size="11.5" fill="${ink}" text-anchor="middle">${ZH ? '主 Agent' : 'client'}</text>`,
          `<text x="${xb + bw / 2}" y="${l1 + 16}" font-size="13" font-weight="600" fill="${ink}" text-anchor="middle">$${c.own.toFixed(2)}</text>`,
          `<text x="${xb + bw / 2}" y="${l1 + 32}" font-size="12" font-weight="700" fill="${inGrey ? col(ownC) : '#FFFFFF'}" text-anchor="middle">${ownC}</text>`)
      }
      const by = y(0)
      out.push(`<text x="${xa + bw / 2}" y="${by + 18}" font-size="12" fill="${C.FG}" text-anchor="middle">${esc(name(METHODS[0]))}</text>`,
        `<text x="${xb + bw / 2}" y="${by + 18}" font-size="12" fill="${C.FG}" text-anchor="middle">${esc(ZH ? '转交（0.6.0）' : 'Handed over')}</text>`,
        `<text x="${cx0}" y="${by + 44}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">${esc(T[c.size])}</text>`)
      if (c.sub) out.push(`<text x="${cx0}" y="${by + 63}" font-size="12" fill="${C.MUTED}" text-anchor="middle">${esc(c.sub)}</text>`)
    })
    x += pw + GAP
  }
  let lx = 24
  for (const it of [{ name: name(METHODS[0]), color: METHODS[0].color }, { name: ZH ? '转交（0.6.0）：主 Agent' : 'Handed over (0.6.0): client', color: '#2563EB' }, { name: ZH ? `${DS_NAME}（按高峰价，不占主 Agent 额度）` : `${DS_NAME} (peak price, not the client's quota)`, color: C.DS }]) {
    out.push(`<rect x="${lx}" y="${H - 38}" width="13" height="13" rx="2" fill="${it.color}"/>`, `<text x="${lx + 20}" y="${H - 27}" font-size="13" fill="${C.FG}">${esc(it.name)}</text>`)
    lx += 40 + textW(it.name, 13.5)
  }
  out.push('</svg>')
  const svg = path.join(OUT, `natural-combined${ZH ? '.zh' : ''}.svg`)
  fs.writeFileSync(svg, out.join('\n') + '\n')
  spawnSync('rsvg-convert', ['-z', '2', '-o', svg.replace(/\.svg$/, '.png'), svg])
}
console.log(`charts written to ${OUT}; $ per 1% of the Codex window: ${DOLLARS_PER_PERCENT.toFixed(4)} (from ${alone.length} runs alone)`)
