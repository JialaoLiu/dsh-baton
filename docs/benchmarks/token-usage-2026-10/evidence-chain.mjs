// Draws the evidence chain of one real run (Codex, natural large task, evidence build, rep 2):
// who did what, and which record proves each step. Numbers are taken from that run's rollout,
// Harness session and results/codex-nevidence.jsonl.
//   node evidence-chain.mjs        -> charts/evidence-chain.zh.svg / .png
//   node evidence-chain.mjs --en   -> charts/evidence-chain.svg / .png (same run, same numbers)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const OUT = path.join(import.meta.dirname, 'charts')
const EN = process.argv.includes('--en')
const ZH_ACTOR = {
  user: { name: '用户', color: '#5B6577' },
  codex: { name: 'Codex（主 Agent）', color: '#2563EB' },
  baton: { name: 'dsh-baton', color: '#C27803' },
  ds: { name: 'DeepSeek Harness', color: '#0E9F6E' },
  check: { name: '独立验收', color: '#0F172A' },
}
const ZH_STEPS = [
  ['user', '提出需求', '一段口语化的需求：做一个任务管理小网页（Node 服务器 + 前端页面）'],
  ['codex', '写规格 + 验收命令，dsh_send', '规格 1,401 字符；验收命令 2 条：npm test、检查 package.json 零依赖'],
  ['baton', '发送前给文件夹拍快照', '记录每个文件的哈希和行数（当时文件夹为空）'],
  ['ds', '干活', 'DeepSeek V4.1 Flash 1017，49 次模型请求，写出 11 个文件：server.js 452 行、public/app.js 818 行、测试 600 行…'],
  ['baton', '运行结束：自己比对文件、自己跑验收', '新建 11 个、修改 0、删除 0；npm test 退出码 0（9 项测试全过）；零依赖检查通过'],
  ['codex', '看证据 + 复查，主动打回 1 处', '发现 README 里 /api/stats 示例 total=6，应为 5；只发这一处修改，附一条新验收命令'],
  ['ds', '修改', '只改 README.md 一处'],
  ['baton', '再次比对 + 验收', 'README.md 修改（251 行 → 251 行）；"total": 5 检查通过'],
  ['codex', '验收通过', 'Codex 全程 $0.126，约占 Plus 5 小时额度 1%（额度只按整数显示）；DeepSeek $0.224（按高峰价估算）'],
  ['check', '基准测试的独立验收', '13/13 通过：启动、增删改查、统计、400/404、数据写入 DATA_FILE'],
]

const EN_ACTOR = {
  user: { name: 'User', color: '#5B6577' },
  codex: { name: 'Codex (main agent)', color: '#2563EB' },
  baton: { name: 'dsh-baton', color: '#C27803' },
  ds: { name: 'DeepSeek Harness', color: '#0E9F6E' },
  check: { name: 'Independent test', color: '#0F172A' },
}
const EN_STEPS = [
  ['user', 'Asks for it', 'One plain-language request: a small task manager web app (Node server + front-end page)'],
  ['codex', 'Writes spec + checks, dsh_send', 'Spec of 1,401 characters; 2 checks: npm test, and package.json has zero dependencies'],
  ['baton', 'Snapshots the folder before sending', "Records every file's hash and line count (the folder was empty then)"],
  ['ds', 'Does the work', 'DeepSeek V4.1 Flash 1017: 49 requests, writes 11 files: server.js 452 lines, public/app.js 818, tests 600…'],
  ['baton', 'Run ends: compares files, runs the checks itself', '11 created, 0 changed, 0 deleted; npm test exit code 0 (9 tests pass); zero-dependency check passes'],
  ['codex', 'Reads the evidence and reviews; sends one fix back on its own', 'README /api/stats example says total=6, should be 5; sends only this fix, with one new check'],
  ['ds', 'Fixes it', 'Changes one place in README.md'],
  ['baton', 'Compares and checks again', 'README.md changed (251 lines → 251 lines); "total": 5 check passes'],
  ['codex', 'Accepts', 'Codex $0.126 in total, about 1% of the Plus 5-hour window (shown in whole percent); DeepSeek $0.224 (at peak price)'],
  ['check', "The benchmark's own acceptance test", '13/13 pass: start, create/read/update/delete, stats, 400/404, data written to DATA_FILE'],
]
const ACTOR = EN ? EN_ACTOR : ZH_ACTOR
const STEPS = EN ? EN_STEPS : ZH_STEPS
const TEXT = EN ? {
  title: 'Evidence chain: one real hand-over, from request to acceptance',
  foot: 'Raw records: results/codex-nevidence.jsonl (rep 2), its Codex rollout and Harness session files; evidence field source = "dsh-baton, not the Harness model".',
} : {
  title: '证据链：一次真实转交从需求到验收',
  foot: '原始记录：results/codex-nevidence.jsonl（rep 2）、对应的 Codex rollout 和 Harness 会话文件；证据字段 source = "dsh-baton, not the Harness model"。',
}

const W = 900, TOP = 64, ROW = 74, L = 24
const H = TOP + STEPS.length * ROW + 64
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const FONT = `font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif"`
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`, `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`,
  `<text x="${L}" y="36" font-size="19" font-weight="600" fill="#0F172A">${esc(TEXT.title)}</text>`]
STEPS.forEach(([who, title, detail], i) => {
  const a = ACTOR[who], y = TOP + i * ROW
  if (i < STEPS.length - 1) out.push(`<line x1="${L + 74}" x2="${L + 74}" y1="${y + 54}" y2="${y + ROW}" stroke="#C3CAD5" stroke-width="2"/>`)
  out.push(`<rect x="${L}" y="${y}" width="148" height="54" rx="8" fill="${a.color}"/>`,
    `<text x="${L + 74}" y="${y + 32}" font-size="13.5" font-weight="600" fill="#FFFFFF" text-anchor="middle">${esc(a.name)}</text>`,
    `<rect x="${L + 160}" y="${y}" width="${W - L * 2 - 160}" height="54" rx="8" fill="#F4F6F9" stroke="${who === 'baton' ? a.color : '#E2E7EF'}" stroke-width="${who === 'baton' ? 2 : 1}"/>`,
    `<text x="${L + 176}" y="${y + 22}" font-size="14" font-weight="600" fill="#0F172A">${i + 1}. ${esc(title)}</text>`,
    `<text x="${L + 176}" y="${y + 42}" font-size="12.5" fill="#3B4556">${esc(detail)}</text>`)
})
out.push(`<text x="${L}" y="${H - 26}" font-size="12" fill="#5B6577">${esc(TEXT.foot)}</text>`, '</svg>')
const svg = path.join(OUT, EN ? 'evidence-chain.svg' : 'evidence-chain.zh.svg')
fs.writeFileSync(svg, out.join('\n') + '\n')
spawnSync('rsvg-convert', ['-z', '2', '-o', svg.replace(/\.svg$/, '.png'), svg])
console.log(svg)
