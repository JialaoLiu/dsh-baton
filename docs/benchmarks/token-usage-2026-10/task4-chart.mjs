// Task 4 · Kanban app (phased): Codex GPT-6 Astra high, working alone vs handed over with 0.6.2, one run each.
// Cost and 5-hour window side by side, in the style of charts-natural.mjs --combined.
//   node task4-chart.mjs [--zh]   -> charts/task4-kanban(.zh).svg
import fs from 'node:fs'
import path from 'node:path'

const ZH = process.argv.includes('--zh')
const OUT = path.join(import.meta.dirname, 'charts')
// USD at list price; DeepSeek V4.1 Flash 1017 at peak price. Window in points of the ChatGPT Plus 5-hour window.
const D = { alone: 8.69, own: 1.62, ds: 0.74, quotaAlone: 86, quotaHanded: 16 }
const C = { FG: '#0F172A', MUTED: '#5B6577', GRID: '#E2E7EF', BG: '#FFFFFF', DS: '#C3CAD5', ALONE: '#C27803', OWN: '#2563EB', GOOD: '#067647' }
const FONT = `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"`
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const T = ZH ? {
  title: '案例 4 · 看板应用（分阶段）：Codex · GPT-6 Astra high',
  sub: '三个阶段在同一个对话里依次给，55 项固定验收测试，两组都一次全过。美元，按标价。',
  cost: '每个任务的花费', quota: '占 ChatGPT Plus 5 小时额度',
  alone: '自己做', handed: '转交（0.6.2）', client: '主 Agent',
  legend: ['自己做', '转交：主 Agent', 'DeepSeek V4.1 Flash 1017（按高峰价，不占主 Agent 额度）'],
} : {
  title: 'Task 4 · Kanban app (phased): Codex · GPT-6 Astra high',
  sub: 'Three phases given one after another in the same conversation, 55 fixed acceptance tests, both passed all on the first try. USD, list price.',
  cost: 'Cost per task', quota: 'Share of the ChatGPT Plus 5-hour window',
  alone: 'Alone', handed: 'Handed over (0.6.2)', client: 'client',
  legend: ['Alone', 'Handed over: client', "DeepSeek V4.1 Flash 1017 (peak price, not the client's quota)"],
}
const W = 1200, H = 560, TOP = 128, BOT = 112, LEFT = 70, GAP = 96
const pw = (W - LEFT - 40 - GAP) / 2
const pct = (v, b) => `${v < b ? '−' : '+'}${Math.round(Math.abs(v / b - 1) * 100)}%`
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="${C.BG}"/>`,
  `<text x="24" y="38" font-size="20" font-weight="600" fill="${C.FG}">${esc(T.title)}</text>`,
  `<text x="24" y="66" font-size="13.5" fill="${C.MUTED}">${esc(T.sub)}</text>`]

function panel(x0, title, top, step, fmt, bars) {
  const y = (v) => TOP + (H - TOP - BOT) * (1 - v / top)
  out.push(`<text x="${x0 + pw / 2}" y="${TOP - 22}" font-size="15" font-weight="600" fill="${C.FG}" text-anchor="middle">${esc(title)}</text>`)
  for (let v = 0; v <= top + 1e-9; v += step) {
    out.push(`<line x1="${x0}" x2="${x0 + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${C.GRID}"/>`, `<text x="${x0 - 8}" y="${y(v) + 4}" font-size="11.5" fill="${C.MUTED}" text-anchor="end">${fmt(v)}</text>`)
  }
  const bw = 120, cx = x0 + pw / 2, xa = cx - bw - 10, xb = cx + 10
  const roundTop = (bx, y0, y1, fill) => `<path d="M${bx},${y0} V${y1 + 4} Q${bx},${y1} ${bx + 4},${y1} H${bx + bw - 4} Q${bx + bw},${y1} ${bx + bw},${y1 + 4} V${y0} Z" fill="${fill}"/>`
  bars(y, xa, xb, bw, roundTop)
  out.push(`<text x="${xa + bw / 2}" y="${y(0) + 20}" font-size="13" fill="${C.FG}" text-anchor="middle">${esc(T.alone)}</text>`,
    `<text x="${xb + bw / 2}" y="${y(0) + 20}" font-size="13" fill="${C.FG}" text-anchor="middle">${esc(T.handed)}</text>`)
}

// cost: alone vs client (blue) + DeepSeek (grey)
panel(LEFT, T.cost, 10, 2, (v) => `$${v.toFixed(2)}`, (y, xa, xb, bw, roundTop) => {
  const total = D.own + D.ds
  out.push(roundTop(xa, y(0), y(D.alone), C.ALONE), `<text x="${xa + bw / 2}" y="${y(D.alone) - 8}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">$${D.alone.toFixed(2)}</text>`,
    `<rect x="${xb}" y="${y(D.own)}" width="${bw}" height="${y(0) - y(D.own)}" fill="${C.OWN}"/>`, roundTop(xb, y(D.own) - 2, y(total), C.DS),
    `<text x="${xb + bw / 2}" y="${y(total) - 24}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">$${total.toFixed(2)}</text>`,
    `<text x="${xb + bw / 2}" y="${y(total) - 8}" font-size="12.5" font-weight="600" fill="${C.GOOD}" text-anchor="middle">${pct(total, D.alone)}</text>`,
    `<text x="${xb + bw / 2}" y="${y(D.own) + 17}" font-size="12" font-weight="600" fill="#FFFFFF" text-anchor="middle">${esc(T.client)} $${D.own.toFixed(2)}</text>`,
    `<text x="${xb + bw / 2}" y="${y(D.own) + 33}" font-size="12" font-weight="700" fill="#FFFFFF" text-anchor="middle">${pct(D.own, D.alone)}</text>`)
})

// window: alone vs handed (client only; DeepSeek does not use it)
panel(LEFT + pw + GAP, T.quota, 100, 20, (v) => `${v}%`, (y, xa, xb, bw, roundTop) => {
  out.push(roundTop(xa, y(0), y(D.quotaAlone), C.ALONE), `<text x="${xa + bw / 2}" y="${y(D.quotaAlone) - 8}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">${D.quotaAlone}%</text>`,
    roundTop(xb, y(0), y(D.quotaHanded), C.OWN),
    `<text x="${xb + bw / 2}" y="${y(D.quotaHanded) - 24}" font-size="14" font-weight="600" fill="${C.FG}" text-anchor="middle">≈${D.quotaHanded}%</text>`,
    `<text x="${xb + bw / 2}" y="${y(D.quotaHanded) - 8}" font-size="12.5" font-weight="600" fill="${C.GOOD}" text-anchor="middle">${pct(D.quotaHanded, D.quotaAlone)}</text>`)
})

let lx = 24
for (const [name, color] of [[T.legend[0], C.ALONE], [T.legend[1], C.OWN], [T.legend[2], C.DS]]) {
  out.push(`<rect x="${lx}" y="${H - 40}" width="13" height="13" rx="2" fill="${color}"/>`, `<text x="${lx + 20}" y="${H - 29}" font-size="13" fill="${C.FG}">${esc(name)}</text>`)
  lx += 44 + [...name].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 13 : 7.2), 0)
}
out.push('</svg>')
const file = path.join(OUT, `task4-kanban${ZH ? '.zh' : ''}.svg`)
fs.writeFileSync(file, out.join('\n') + '\n')
console.log(file)
