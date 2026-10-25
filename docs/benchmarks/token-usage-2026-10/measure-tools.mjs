// Prints the size of what dsh-baton puts in a client's context: the instructions, each tool's
// description and input schema. Usage: node measure-tools.mjs [path/to/mcp.mjs] [client name]
import { spawn } from 'node:child_process'
import path from 'node:path'

const file = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../src/mcp.mjs'))
const client = process.argv[3] ?? 'codex'
const p = spawn(process.execPath, [file], { env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: '/tmp/dshb-none.sock' } })
let buf = ''
p.stdout.on('data', (d) => (buf += d))
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } }) + '\n')
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
setTimeout(() => {
  p.kill()
  const [init, list] = buf.trim().split('\n').map((l) => JSON.parse(l))
  const tools = list.result.tools
  console.log(`client ${client}: instructions ${init.result.instructions.length} chars, tools/list ${JSON.stringify(tools).length} chars, ${tools.length} tools`)
  for (const t of tools) console.log(`  ${t.name.padEnd(22)} description ${String(t.description.length).padStart(5)}  schema ${String(JSON.stringify(t.inputSchema).length).padStart(5)}`)
}, 1500)
