// The size of dsh-baton's tool catalogue as Codex shows it to the model: Codex puts the MCP
// server's instructions in front of every tool's description, so they count once per tool.
// Usage: node codex-catalog.mjs [path/to/mcp.mjs ...] (default: this checkout's src/mcp.mjs)
import { spawn } from 'node:child_process'
import path from 'node:path'

export async function codexCatalog(file, client = 'codex') {
  const p = spawn(process.execPath, [file], { env: { ...process.env, DSH_BATON_BACKEND: 'host', DSH_BATON_SOCKET: path.join(path.dirname(file), 'none.sock'), CODEX_HOME: path.join(path.dirname(file), 'no-codex-home') } })
  let buf = ''
  p.stdout.on('data', (d) => (buf += d))
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  p.stdin.end()
  await new Promise((r) => p.on('close', r))
  const [init, list] = buf.trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id)
  const instructions = init.result.instructions ?? ''
  const tools = list.result.tools
  const shown = tools.map((t) => (instructions ? `${instructions}\n\n${t.description}` : t.description))
  return {
    instructions: instructions.length,
    tools: tools.length,
    descriptions: tools.reduce((n, t) => n + t.description.length, 0),
    schemas: tools.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0),
    // What the model reads: each tool's text as Codex builds it, plus its input schema.
    total: shown.reduce((n, s) => n + s.length, 0) + tools.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2)
  for (const f of files.length ? files : [path.join(import.meta.dirname, '../src/mcp.mjs')]) {
    console.log(path.resolve(f), JSON.stringify(await codexCatalog(path.resolve(f))))
  }
}
