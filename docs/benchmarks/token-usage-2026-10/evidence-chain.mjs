// Draws the evidence chain of one real run (Codex, natural large task, evidence build, rep 2):
// who did what, and which record proves each step. Numbers are taken from that run's rollout,
// Harness session and results/codex-nevidence.jsonl.
//   node evidence-chain.mjs   -> charts/evidence-chain.zh.svg / .png
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const OUT = path.join(import.meta.dirname, 'charts')
const ACTOR = {
  user: { name: '用户', color: '#5B6577' },
  codex: { name: 'Codex（主 Agent）', color: '#2563EB' },
  baton: { name: 'dsh-baton', color: '#C27803' },
  ds: { name: 'DeepSeek Harness', color: '#0E9F6E' },
  check: { name: '独立验收', color: '#0F172A' },
}
const STEPS = [
  ['user', '提出需求', '一段口语化的需求：做一个任务管理小网页（Node 服务器 + 前端页面）'],
  ['codex', '写规格 + 验收命令，dsh_send', '规格 1,401 字符；验收命令 2 条：npm test、检查 package.json 零依赖'],
  ['baton', '发送前给文件夹拍快照', '记录每个文件的哈希和行数（当时文件夹为空）'],
  ['ds', '干活', '54 次模型请求，写出 11 个文件：server.js 452 行、public/app.js 818 行、测试 600 行…'],
  ['baton', '运行结束：自己比对文件、自己跑验收', '新建 11 个、修改 0、删除 0；npm test 退出码 0（9 项测试全过）；零依赖检查通过'],
  ['codex', '看证据 + 复查，打回 1 处', '发现 README 里 /api/stats 示例 total=6，应为 5；只发这一处修改，附一条新验收命令'],
  ['ds', '修改', '只改 README.md 一处'],
  ['baton', '再次比对 + 验收', 'README.md 修改（251 行 → 251 行）；"total": 5 检查通过'],
  ['codex', '验收通过', 'Codex 全程 $0.126，占 Plus 5 小时额度 1%；DeepSeek $0.224（按高峰价估算）'],
  ['check', '基准测试的独立验收', '13/13 通过：启动、增删改查、统计、400/404、数据写入 DATA_FILE'],
]

const W = 900, TOP = 114, ROW = 74, L = 24
const H = TOP + STEPS.length * ROW + 64
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const FONT = `font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"`
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`,
  `<text x="${L}" y="36" font-size="19" font-weight="600" fill="#0F172A">证据链：一次真实转交从需求到验收</text>`,
  `<text x="${L}" y="62" font-size="13" fill="#5B6577">Codex（gpt-6.1-sol high）+ dsh-baton 加证据版，自然语言大号任务，2026-10-26。</text>`,
  `<text x="${L}" y="82" font-size="13" fill="#5B6577">橙框步骤的结果由 dsh-baton 自己比对文件、自己跑命令得出，不是 DeepSeek 的自述。</text>`]
STEPS.forEach(([who, title, detail], i) => {
  const a = ACTOR[who], y = TOP + i * ROW
  if (i < STEPS.length - 1) out.push(`<line x1="${L + 74}" x2="${L + 74}" y1="${y + 54}" y2="${y + ROW}" stroke="#C3CAD5" stroke-width="2"/>`)
  out.push(`<rect x="${L}" y="${y}" width="148" height="54" rx="8" fill="${a.color}"/>`,
    `<text x="${L + 74}" y="${y + 32}" font-size="13.5" font-weight="600" fill="#FFFFFF" text-anchor="middle">${esc(a.name)}</text>`,
    `<rect x="${L + 160}" y="${y}" width="${W - L * 2 - 160}" height="54" rx="8" fill="#F4F6F9" stroke="${who === 'baton' ? a.color : '#E2E7EF'}" stroke-width="${who === 'baton' ? 2 : 1}"/>`,
    `<text x="${L + 176}" y="${y + 22}" font-size="14" font-weight="600" fill="#0F172A">${i + 1}. ${esc(title)}</text>`,
    `<text x="${L + 176}" y="${y + 42}" font-size="12.5" fill="#3B4556">${esc(detail)}</text>`)
})
out.push(`<text x="${L}" y="${H - 26}" font-size="12" fill="#5B6577">原始记录：results/codex-nevidence.jsonl（rep 2）、对应的 Codex rollout 和 Harness 会话文件；证据字段 source = "dsh-baton, not the Harness model"。</text>`, '</svg>')
const svg = path.join(OUT, 'evidence-chain.zh.svg')
fs.writeFileSync(svg, out.join('\n') + '\n')
spawnSync('rsvg-convert', ['-z', '2', '-o', svg.replace(/\.svg$/, '.png'), svg])
console.log(svg)
