// Prints the Codex 5-hour window as Codex's own app-server reports it (account/rateLimits/read).
//   node window.mjs
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const p = spawn('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
const rl = readline.createInterface({ input: p.stdout })
let id = 0
const wait = new Map()
rl.on('line', (l) => { let m; try { m = JSON.parse(l) } catch { return } if (m.id != null && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id) } })
const req = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); p.stdin.write(JSON.stringify({ id: i, method, params }) + '\n') })
await req('initialize', { clientInfo: { name: 'dshb-bench', version: '0' } })
p.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const r = await req('account/rateLimits/read', null)
console.log(JSON.stringify({ at: new Date().toISOString(), ...(r.result ?? { error: r.error }) }))
p.kill()
