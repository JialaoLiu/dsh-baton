#!/usr/bin/env node
// dsh-baton-mcp and dsh-baton-host are released together with one version.
//   node scripts/version.mjs          check both package.json files agree (prepublishOnly)
//   node scripts/version.mjs 0.4.0    set both
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const files = ['package.json', 'host/package.json'].map((f) => path.join(ROOT, f))
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const next = process.argv[2]

if (next) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) throw new Error(`not a version: ${next}`)
  for (const f of files) fs.writeFileSync(f, JSON.stringify({ ...read(f), version: next }, null, 2) + '\n')
  console.log(`dsh-baton-mcp and dsh-baton-host set to ${next}`)
} else {
  const [mcp, host] = files.map((f) => read(f).version)
  if (mcp !== host) {
    console.error(`Versions differ: dsh-baton-mcp ${mcp}, dsh-baton-host ${host}. Run: node scripts/version.mjs <version>`)
    process.exit(1)
  }
  console.log(`dsh-baton-mcp and dsh-baton-host are both ${mcp}`)
}
