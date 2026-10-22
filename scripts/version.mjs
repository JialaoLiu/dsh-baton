#!/usr/bin/env node
// dsh-baton-mcp and dsh-baton-host are released together with one version. The plugin
// depends on exactly that version of the MCP server (it registers it when switched on),
// and server.json (the MCP Registry entry) carries it too.
//   node scripts/version.mjs          check that they all agree (prepublishOnly)
//   node scripts/version.mjs 0.5.0    set them all
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const files = ['package.json', 'host/package.json'].map((f) => path.join(ROOT, f))
const registry = path.join(ROOT, 'server.json')
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const write = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n')
const next = process.argv[2]

// Every place that names the version, as [label, value].
function versions() {
  const [mcp, host] = files.map(read)
  const reg = read(registry)
  return [
    ['dsh-baton-mcp', mcp.version],
    ['dsh-baton-host', host.version],
    ["dsh-baton-host's dependency on dsh-baton-mcp", host.dependencies?.['dsh-baton-mcp']],
    ['server.json', reg.version],
    ['server.json package', reg.packages?.[0]?.version],
  ]
}

if (next) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) throw new Error(`not a version: ${next}`)
  const [mcp, host] = files.map(read)
  write(files[0], { ...mcp, version: next })
  write(files[1], { ...host, version: next, dependencies: { ...host.dependencies, 'dsh-baton-mcp': next } })
  const reg = read(registry)
  write(registry, { ...reg, version: next, packages: reg.packages.map((p) => ({ ...p, version: next })) })
  console.log(`dsh-baton-mcp, dsh-baton-host and server.json set to ${next}`)
} else {
  const all = versions()
  if (new Set(all.map(([, v]) => v)).size !== 1) {
    console.error(`Versions differ: ${all.map(([k, v]) => `${k} ${v}`).join(', ')}. Run: node scripts/version.mjs <version>`)
    process.exit(1)
  }
  console.log(`dsh-baton-mcp, dsh-baton-host and server.json are all ${all[0][1]}`)
}
