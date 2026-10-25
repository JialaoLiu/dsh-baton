// Draws the report charts from results/*.jsonl as SVG (and PNG through rsvg-convert):
//   charts/cost-<client>.svg    cost per accepted task at list price, by size, A vs B (and the
//                               newer build's B when there is one); B split into the client's
//                               own model and DeepSeek; whiskers show the lowest and highest run.
//   charts/codex-quota.svg      Codex Plus 5-hour window used per task, by size, A vs B.
// Prices (USD per million tokens) are the published list prices on 2026-10-25.
//   node charts.mjs [--zh]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = import.meta.dirname
const ZH = process.argv.includes('--zh')
// --release: only the released build (0.5.9), for the README; files get a -release suffix.
const RELEASE = process.argv.includes('--release')
const OUT = path.join(HERE, 'charts')
fs.mkdirSync(OUT, { recursive: true })

const PRICE = {
  sol: { input: 2, cached: 0.10, output: 10 },
  deepseek: { miss: 0.30, hit: 0.006, output: 1.20 },
}
const rows = fs.readdirSync(path.join(HERE, 'results')).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(path.join(HERE, 'results', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .map((r) => ({ label: 'baseline', ...r })).filter((r) => r.valid !== false && (!RELEASE || r.label === 'baseline'))

const mainCost = (r) => r.gpt
  ? ((r.gpt.input_tokens - r.gpt.cached_input_tokens) * PRICE.sol.input + r.gpt.cached_input_tokens * PRICE.sol.cached + r.gpt.output_tokens * PRICE.sol.output) / 1e6
  : r.cost_usd
const dsCost = (r) => r.harness ? (r.harness.deepseek.inputTokens * PRICE.deepseek.miss + r.harness.deepseek.cacheReadTokens * PRICE.deepseek.hit + r.harness.deepseek.outputTokens * PRICE.deepseek.output) / 1e6 : 0

// The 5-hour window used by one Codex run: last minus first used_percent seen in its rollout.
const home = (p) => p.replace(/^~/, os.homedir()) // results store paths under ~
function quota(r) {
  const seen = fs.readFileSync(home(r.rollout), 'utf8').split('\n').filter((l) => l.includes('"token_count"') && l.includes('used_percent'))
    .map((l) => JSON.parse(l).payload.rate_limits?.primary?.used_percent).filter((v) => typeof v === 'number')
  return seen.length ? seen.at(-1) - seen[0] : null
}

const C = { A: '#C27803', B: '#2563EB', DS: '#1baf7a', FG: '#0F172A', MUTED: '#5B6577', GRID: '#E2E7EF', BG: '#FFFFFF' }
const T = ZH
  ? { small: '小', medium: '中', large: '大', A: '直接做（A）', B: '转交 Harness（B）', B2: '转交，新版（B）', ds: 'DeepSeek 部分', notRun: '未测', costTitle: (c) => `${c}：每个通过验收的任务的费用（按标价，美元）`, quotaTitle: 'Codex Plus：每个任务占用的 5 小时额度（%）', note: '柱高为平均值，细线为最低到最高的一次。', quotaNote: '额度只按整数百分比报告，小任务误差大。' }
  : { small: 'Small', medium: 'Medium', large: 'Large', A: 'Alone (A)', B: 'Handed to Harness (B)', B2: 'Handed over, new build (B)', ds: 'DeepSeek share', notRun: 'not run', costTitle: (c) => `${c}: cost per accepted task (list price, USD)`, quotaTitle: 'Codex Plus: 5-hour window used per task (%)', note: 'Bar = mean, whisker = lowest to highest run.', quotaNote: 'The window is reported in whole percent, so small tasks are coarse.' }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const FONT = `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"`

// Grouped bars. groups: [{ name, bars: [{ key, color, parts: [{ v, color }], min, max }] }]
function barChart({ title, note, groups, legend, unit, file }) {
  const W = 760, H = 380, L = 64, R = 24, TOP = 78, BOT = 64
  const max = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.max ?? b.parts.reduce((a, p) => a + p.v, 0))))
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50].find((s) => max / s <= 5) ?? 100
  const top = Math.ceil(max / step) * step
  const y = (v) => TOP + (H - TOP - BOT) * (1 - v / top)
  const gw = (W - L - R) / groups.length
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="${C.BG}"/>`,
    // The newer build's B bars: the same blue as B, hatched, so they differ by texture and not by a second blue.
    `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#DBE6FD"/><rect width="3" height="6" fill="${C.B}"/></pattern></defs>`,
    `<text x="${L - 40}" y="30" font-size="17" font-weight="600" fill="${C.FG}">${esc(title)}</text>`,
    `<text x="${L - 40}" y="52" font-size="12.5" fill="${C.MUTED}">${esc(note)}</text>`]
  for (let v = 0; v <= top + 1e-9; v += step) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C.GRID}" stroke-width="1"/>`)
    out.push(`<text x="${L - 8}" y="${y(v) + 4}" font-size="11.5" fill="${C.MUTED}" text-anchor="end">${unit(v)}</text>`)
  }
  groups.forEach((g, gi) => {
    const n = g.bars.length, bw = Math.min(56, (gw - 40) / n), x0 = L + gi * gw + (gw - n * bw - (n - 1) * 4) / 2
    g.bars.forEach((b, bi) => {
      const x = x0 + bi * (bw + 4)
      // A bar with no runs is a gap in the data, not a zero: say so instead of drawing $0.
      if (!b.parts.length) { out.push(`<text x="${x + bw / 2}" y="${y(0) - 8}" font-size="11" fill="${C.MUTED}" text-anchor="middle">${T.notRun}</text>`); return }
      let acc = 0
      b.parts.forEach((p, pi) => {
        if (p.v <= 0) return
        const y1 = y(acc + p.v), y0 = y(acc)
        const last = pi === b.parts.length - 1 || b.parts.slice(pi + 1).every((q) => q.v <= 0)
        out.push(last
          ? `<path d="M${x},${y0} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${y1 + 4} V${y0} Z" fill="${p.color}"/>`
          : `<rect x="${x}" y="${y1 + 2}" width="${bw}" height="${Math.max(0, y0 - y1 - 2)}" fill="${p.color}"/>`) // 2px gap above, to the next segment
        acc += p.v
      })
      if (b.min !== undefined && b.max !== b.min) {
        const cx = x + bw / 2
        out.push(`<line x1="${cx}" x2="${cx}" y1="${y(b.min)}" y2="${y(b.max)}" stroke="${C.FG}" stroke-width="1.5"/>`, `<line x1="${cx - 6}" x2="${cx + 6}" y1="${y(b.max)}" y2="${y(b.max)}" stroke="${C.FG}" stroke-width="1.5"/>`, `<line x1="${cx - 6}" x2="${cx + 6}" y1="${y(b.min)}" y2="${y(b.min)}" stroke="${C.FG}" stroke-width="1.5"/>`)
      }
      const total = b.parts.reduce((a, p) => a + p.v, 0)
      out.push(`<text x="${x + bw / 2}" y="${y(Math.max(total, b.max ?? 0)) - 7}" font-size="11.5" fill="${C.FG}" text-anchor="middle">${unit(total, true)}</text>`)
    })
    out.push(`<text x="${L + gi * gw + gw / 2}" y="${H - BOT + 22}" font-size="13" fill="${C.FG}" text-anchor="middle">${esc(g.name)}</text>`)
  })
  let lx = L
  for (const it of legend) {
    out.push(`<rect x="${lx}" y="${H - 26}" width="12" height="12" rx="2" fill="${it.color}"/>`, `<text x="${lx + 18}" y="${H - 16}" font-size="12.5" fill="${C.FG}">${esc(it.name)}</text>`)
    lx += 34 + [...it.name].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 13 : 7.2), 0)
  }
  out.push('</svg>')
  const svg = path.join(OUT, `${file}${RELEASE ? '-release' : ''}${ZH ? '.zh' : ''}.svg`)
  fs.writeFileSync(svg, out.join('\n') + '\n')
  spawnSync('rsvg-convert', ['-z', '2', '-o', svg.replace(/\.svg$/, '.png'), svg])
  return svg
}

const sizes = ['small', 'medium', 'large']
const stat = (list, f) => { const v = list.map(f); return { mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) } }

for (const client of ['codex', 'claude']) {
  const name = client === 'codex' ? 'Codex (gpt-6.1-sol, high)' : 'Claude Code (Opus 5.5, high)'
  const hasV2 = rows.some((r) => r.client === client && r.label !== 'baseline')
  const groups = sizes.map((size) => {
    const pick = (arm, label) => rows.filter((r) => r.client === client && r.size === size && r.arm === arm && r.label === label)
    const bars = []
    for (const [arm, label, color] of [['A', 'baseline', C.A], ['B', 'baseline', C.B], ...(hasV2 ? [['B', 'v2', 'url(#hatch)']] : [])]) {
      const list = pick(arm, label)
      if (!list.length) { bars.push({ parts: [] }); continue }
      const m = stat(list, mainCost), d = stat(list, dsCost), t = stat(list, (r) => mainCost(r) + dsCost(r))
      bars.push({ parts: [{ v: m.mean, color }, { v: d.mean, color: C.DS }], min: t.min, max: t.max })
    }
    return { name: T[size], bars }
  })
  barChart({
    title: T.costTitle(name), note: T.note, groups, file: `cost-${client}`,
    unit: (v, label) => `$${v.toFixed(label && v >= 1 ? 1 : 2)}`, // axis ticks all two decimals
    legend: [{ name: T.A, color: C.A }, { name: T.B, color: C.B }, ...(hasV2 ? [{ name: T.B2, color: 'url(#hatch)' }] : []), { name: T.ds, color: C.DS }],
  })
}

const quotaGroups = sizes.map((size) => {
  const bars = []
  const labels = [['A', 'baseline', C.A], ['B', 'baseline', C.B], ...(rows.some((r) => r.client === 'codex' && r.label !== 'baseline') ? [['B', 'v2', 'url(#hatch)']] : [])]
  for (const [arm, label, color] of labels) {
    const list = rows.filter((r) => r.client === 'codex' && r.size === size && r.arm === arm && r.label === label).map(quota).filter((v) => v !== null)
    if (!list.length) { bars.push({ parts: [] }); continue }
    const s = stat(list, (v) => v)
    bars.push({ parts: [{ v: s.mean, color }], min: s.min, max: s.max })
  }
  return { name: T[size], bars }
})
barChart({
  title: T.quotaTitle, note: T.quotaNote, groups: quotaGroups, file: 'codex-quota',
  unit: (v) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`,
  legend: [{ name: T.A, color: C.A }, { name: T.B, color: C.B }, ...(rows.some((r) => r.client === 'codex' && r.label !== 'baseline') ? [{ name: T.B2, color: 'url(#hatch)' }] : [])],
})
console.log(`charts written to ${OUT}`)
