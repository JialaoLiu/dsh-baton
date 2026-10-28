// Registration as the Harness plugin runs it when switched on (src/register.mjs), in a
// throwaway home folder: copy to the app folder, write each client's entry, leave alone
// what is already right.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { autoRegister, harnessRuntime, findNode, readClaudeEntry, readCodexEntry, editClaudeConfig, editCodexConfig, compareVersions, nodeVersionOk } from '../src/register.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version

// A home with Claude Code and Codex installed, and a package root that looks like the
// dsh-baton-mcp package installed with the plugin (no .git).
function sandbox({ claude = true, codex = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-reg-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  if (claude) fs.mkdirSync(path.join(home, '.claude'))
  if (codex) fs.mkdirSync(path.join(home, '.codex'))
  const pkg = path.join(dir, 'pkg')
  for (const part of ['src', 'host', 'package.json']) fs.cpSync(path.join(REPO, part), path.join(pkg, part), { recursive: true })
  const env = { PATH: '' }
  const app = path.join(home, '.dsh-baton', 'app')
  const run = (opts = {}) => autoRegister({ root: pkg, home, env, app, find: () => process.execPath, ...opts })
  const claudeFile = path.join(home, '.claude.json')
  const codexFile = path.join(home, '.codex', 'config.toml')
  return { dir, home, pkg, app, run, claudeFile, codexFile, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const states = (r) => Object.fromEntries(r.clients.map((c) => [c.id, c.state]))

test('reads back the entries setup writes', () => {
  const entry = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\o'neil\\app\\src\\server.mjs"] }
  assert.deepEqual(readCodexEntry(editCodexConfig('model = "x"\n', entry)), entry)
  assert.deepEqual(readClaudeEntry(editClaudeConfig('{}', entry)), entry)
  assert.equal(readCodexEntry('[mcp_servers.other]\ncommand = "x"\n'), null)
  assert.equal(readClaudeEntry(''), null)
})

test('first switch-on copies the server to the app folder and registers it for both clients', () => {
  const s = sandbox()
  try {
    const r = s.run()
    assert.equal(r.ok, true)
    assert.deepEqual(states(r), { claude: 'registered', codex: 'registered' })
    const script = path.join(s.app, 'src', 'server.mjs')
    assert.ok(fs.existsSync(script))
    assert.deepEqual(readClaudeEntry(fs.readFileSync(s.claudeFile, 'utf8')), { command: process.execPath, args: [script] })
    assert.deepEqual(readCodexEntry(fs.readFileSync(s.codexFile, 'utf8')), { command: process.execPath, args: [script] })
    // Every Harness start runs it again: nothing changes.
    const before = fs.readFileSync(s.claudeFile, 'utf8')
    assert.deepEqual(states(s.run()), { claude: 'unchanged', codex: 'unchanged' })
    assert.equal(fs.readFileSync(s.claudeFile, 'utf8'), before)
  } finally { s.done() }
})

test('keeps other servers and a working entry that starts another copy; repairs a broken one', () => {
  const s = sandbox()
  try {
    const clone = path.join(s.dir, 'clone', 'src', 'server.mjs')
    fs.mkdirSync(path.dirname(clone), { recursive: true })
    fs.writeFileSync(clone, '')
    fs.writeFileSync(s.claudeFile, JSON.stringify({ numStartups: 2, mcpServers: { godot: { command: 'g' }, 'dsh-baton': { command: process.execPath, args: [clone] } } }))
    fs.writeFileSync(s.codexFile, `[mcp_servers.dsh-baton]\ncommand = '${process.execPath}'\nargs = ['/gone/server.mjs']\n\n[mcp_servers.other]\ncommand = "o"\n`)
    const r = s.run()
    assert.deepEqual(states(r), { claude: 'kept', codex: 'registered' })
    const claude = JSON.parse(fs.readFileSync(s.claudeFile, 'utf8'))
    assert.equal(claude.mcpServers['dsh-baton'].args[0], clone)
    assert.deepEqual(claude.mcpServers.godot, { command: 'g' })
    const codex = fs.readFileSync(s.codexFile, 'utf8')
    assert.match(codex, /\[mcp_servers\.other\]\ncommand = "o"/)
    assert.equal(readCodexEntry(codex).args[0], path.join(s.app, 'src', 'server.mjs'))
    assert.ok(fs.existsSync(`${s.codexFile}.bak-dsh-baton`), 'a backup of the edited file')
  } finally { s.done() }
})

test('an npx entry from an MCP directory is kept; a bare node with a missing script is repaired', () => {
  const s = sandbox()
  try {
    fs.writeFileSync(s.claudeFile, JSON.stringify({ mcpServers: { 'dsh-baton': { command: 'npx', args: ['-y', 'dsh-baton-mcp'] } } }))
    fs.writeFileSync(s.codexFile, `[mcp_servers.dsh-baton]\ncommand = 'node'\nargs = ['/gone/server.mjs']\n`)
    assert.deepEqual(states(s.run()), { claude: 'kept', codex: 'registered' })
    assert.deepEqual(readClaudeEntry(fs.readFileSync(s.claudeFile, 'utf8')), { command: 'npx', args: ['-y', 'dsh-baton-mcp'] })
  } finally { s.done() }
})

test('a newer server in the app folder is not replaced by an older plugin', () => {
  const s = sandbox()
  try {
    fs.mkdirSync(path.join(s.app, 'src'), { recursive: true })
    fs.writeFileSync(path.join(s.app, 'src', 'server.mjs'), '// newer')
    fs.writeFileSync(path.join(s.app, 'package.json'), JSON.stringify({ version: '99.0.0' }))
    s.run()
    assert.equal(fs.readFileSync(path.join(s.app, 'src', 'server.mjs'), 'utf8'), '// newer')
    fs.writeFileSync(path.join(s.app, 'package.json'), JSON.stringify({ version: '0.0.1' }))
    s.run()
    assert.notEqual(fs.readFileSync(path.join(s.app, 'src', 'server.mjs'), 'utf8'), '// newer')
  } finally { s.done() }
})

test('the same version with other files is copied again; the same files are left alone', () => {
  const s = sandbox()
  try {
    s.run()
    const server = path.join(s.app, 'src', 'server.mjs')
    const pkg = path.join(s.app, 'package.json')
    const stamp = fs.statSync(pkg).mtimeMs
    s.run()
    assert.equal(fs.statSync(pkg).mtimeMs, stamp) // nothing changed: no copy, no reload
    fs.writeFileSync(server, '// stale build of this version')
    s.run()
    assert.notEqual(fs.readFileSync(server, 'utf8'), '// stale build of this version')
  } finally { s.done() }
})

test('a git checkout is registered where it is, without a copy', () => {
  const s = sandbox()
  try {
    fs.mkdirSync(path.join(s.pkg, '.git'))
    s.run()
    assert.equal(readClaudeEntry(fs.readFileSync(s.claudeFile, 'utf8')).args[0], path.join(s.pkg, 'src', 'server.mjs'))
    assert.equal(fs.existsSync(s.app), false)
  } finally { s.done() }
})

test('without a Node.js of its own, the server runs on Harness in Node mode', () => {
  const s = sandbox()
  try {
    const exe = path.join(s.dir, 'DeepSeek Harness')
    fs.writeFileSync(exe, '')
    const r = s.run({ find: () => null, fallback: harnessRuntime(exe) })
    assert.equal(r.ok, true)
    assert.equal(r.runtime, 'harness')
    const script = path.join(s.app, 'src', 'server.mjs')
    const claude = JSON.parse(fs.readFileSync(s.claudeFile, 'utf8')).mcpServers['dsh-baton']
    assert.deepEqual(claude, { type: 'stdio', command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } })
    const codex = fs.readFileSync(s.codexFile, 'utf8')
    assert.deepEqual(readCodexEntry(codex), { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } })
    assert.match(codex, /\[mcp_servers\.dsh-baton\.env\]\nELECTRON_RUN_AS_NODE = '1'\n(\n# dsh-baton: wakes Codex|$)/)
    // A later run finds it working and leaves it, and a later edit replaces the env table too.
    assert.deepEqual(states(s.run({ find: () => null, fallback: harnessRuntime(exe) })), { claude: 'unchanged', codex: 'unchanged' })
    assert.doesNotMatch(editCodexConfig(codex, { command: '/n', args: ['/s'] }), /ELECTRON_RUN_AS_NODE/)
    // Without Node mode, Harness's binary would open the app: such an entry is rewritten.
    fs.writeFileSync(s.codexFile, editCodexConfig('', { command: exe, args: [script] }))
    assert.equal(states(s.run({ find: () => null, fallback: harnessRuntime(exe) })).codex, 'registered')
    assert.equal(readCodexEntry(fs.readFileSync(s.codexFile, 'utf8')).env.ELECTRON_RUN_AS_NODE, '1')
    // The user's own Node.js still comes first.
    fs.rmSync(s.claudeFile); fs.rmSync(s.codexFile)
    assert.equal(s.run({ fallback: harnessRuntime(exe) }).runtime, 'node')
  } finally { s.done() }
})

test('says why when it cannot register: no Node.js, no clients', () => {
  let s = sandbox()
  try {
    const r = s.run({ find: () => null })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'no-node')
    assert.deepEqual(states(r), { claude: 'failed', codex: 'failed' })
    assert.equal(fs.existsSync(s.claudeFile), false)
  } finally { s.done() }
  s = sandbox({ claude: false, codex: false })
  try {
    const r = s.run()
    assert.equal(r.ok, false)
    assert.equal(r.error, 'no-clients')
    assert.deepEqual(states(r), { claude: 'not-installed', codex: 'not-installed' })
  } finally { s.done() }
  s = sandbox({ codex: false })
  try {
    const r = s.run()
    assert.equal(r.ok, true, 'one client is enough')
    assert.deepEqual(states(r), { claude: 'registered', codex: 'not-installed' })
  } finally { s.done() }
})

test('finds a new enough node on PATH, never the one inside Harness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-node-'))
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  try {
    const harness = path.join(dir, 'DeepSeek Harness.app')
    const mine = path.join(dir, 'bin')
    for (const d of [path.join(harness, 'runtime'), mine]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, exe), '') }
    const env = { PATH: [path.join(harness, 'runtime'), mine].join(path.delimiter) }
    const opts = { env, platform: process.platform, exclude: [harness] }
    assert.equal(findNode({ ...opts, version: () => 'v24.1.0' }), path.join(mine, exe))
    assert.notEqual(findNode({ ...opts, version: (b) => (b.startsWith(mine) ? 'v20.0.0' : 'v24.1.0') }), path.join(mine, exe), 'an old node on PATH is skipped')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  assert.equal(nodeVersionOk('v22.15.0'), true)
  assert.equal(nodeVersionOk('v22.14.1'), false)
  assert.equal(nodeVersionOk(''), false)
})

test('versions compare numerically, a prerelease before its release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('0.5.0-next.0', '0.5.0') < 0)
  assert.equal(compareVersions(VERSION, VERSION), 0)
})

test('the Codex Stop hook goes in with the server, once, and only with a real node', () => {
  const s = sandbox()
  try {
    const r = s.run()
    assert.equal(r.codexHook, 'added')
    const text = fs.readFileSync(s.codexFile, 'utf8')
    const cli = path.join(s.app, 'src', 'cli.mjs')
    // The entry names the wrapper script; node and cli.mjs are in the script.
    const wrapper = path.join(s.home, '.dsh-baton', 'bin', process.platform === 'win32' ? 'codex-stop-hook.cmd' : 'codex-stop-hook')
    assert.ok(text.includes(`command = ${JSON.stringify(wrapper)}`))
    const script = fs.readFileSync(wrapper, 'utf8')
    if (process.platform === 'win32') assert.equal(script, `@"${process.execPath}" "${cli}" codex-stop-hook\r\n`)
    else assert.equal(script, `#!/bin/sh\nexec '${process.execPath}' '${cli}' codex-stop-hook "$@"\n`)
    // Codex adds its trust record; later starts leave the file alone.
    fs.appendFileSync(s.codexFile, '\n[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:1"\n')
    const trusted = fs.readFileSync(s.codexFile, 'utf8')
    assert.equal(s.run().codexHook, 'unchanged')
    assert.equal(fs.readFileSync(s.codexFile, 'utf8'), trusted)
  } finally { s.done() }
  const off = sandbox()
  try {
    assert.equal(off.run({ env: { PATH: '', DSH_BATON_CODEX_HOOK: '0' } }).codexHook, 'off')
    assert.doesNotMatch(fs.readFileSync(off.codexFile, 'utf8'), /codex-stop-hook/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(off.home, '.dsh-baton', 'codex-hook', 'registered.json'), 'utf8')).reason, 'disabled')
  } finally { off.done() }
  const bare = sandbox()
  try {
    // A bare command (npx) has no cli.mjs to run: skipped, and the reason noted.
    fs.writeFileSync(bare.codexFile, editCodexConfig('', { command: 'npx', args: ['-y', 'dsh-baton-mcp'] }))
    assert.equal(bare.run().codexHook, 'skipped')
    assert.equal(JSON.parse(fs.readFileSync(path.join(bare.home, '.dsh-baton', 'codex-hook', 'registered.json'), 'utf8')).reason, 'no-cli')
  } finally { bare.done() }
})

test('on Harness\'s own runtime the hook goes in too: the wrapper runs it in Node mode, the entry is the same', () => {
  const exe = process.execPath
  const wrapper = (s) => path.join(s.home, '.dsh-baton', 'bin', process.platform === 'win32' ? 'codex-stop-hook.cmd' : 'codex-stop-hook')
  const hookBlock = (text) => text.match(/# dsh-baton: wakes Codex[^]*?\ntimeout = \d+\n/)[0]
  const harness = sandbox()
  try {
    const r = harness.run({ find: () => null, fallback: harnessRuntime(exe) })
    assert.equal(r.runtime, 'harness')
    assert.equal(r.codexHook, 'added')
    const cli = path.join(harness.app, 'src', 'cli.mjs')
    const script = fs.readFileSync(wrapper(harness), 'utf8')
    if (process.platform === 'win32') assert.equal(script, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${exe}" "${cli}" codex-stop-hook\r\n`)
    else assert.equal(script, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${exe}' '${cli}' codex-stop-hook "$@"\n`)
    const noted = JSON.parse(fs.readFileSync(path.join(harness.home, '.dsh-baton', 'codex-hook', 'registered.json'), 'utf8'))
    assert.equal(noted.state, 'added')
    assert.ok(fs.readFileSync(harness.codexFile, 'utf8').includes(`command = ${JSON.stringify(noted.command)}`))
  } finally { harness.done() }
  // A user who trusted the hook on their own Node.js, then moved to Harness's runtime:
  // only the wrapper changes; the entry, byte for byte, and Codex's trust record stay.
  const moved = sandbox()
  try {
    assert.equal(moved.run().codexHook, 'added')
    fs.appendFileSync(moved.codexFile, '\n[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:1"\n')
    const before = fs.readFileSync(moved.codexFile, 'utf8')
    const script = path.join(moved.app, 'src', 'server.mjs')
    fs.writeFileSync(moved.codexFile, editCodexConfig(before, { ...harnessRuntime(exe), args: [script] }))
    const switched = fs.readFileSync(moved.codexFile, 'utf8')
    assert.equal(moved.run({ find: () => null, fallback: harnessRuntime(exe) }).codexHook, 'unchanged')
    const after = fs.readFileSync(moved.codexFile, 'utf8')
    assert.equal(after, switched)
    assert.equal(hookBlock(after), hookBlock(before))
    assert.match(after, /trusted_hash = "sha256:1"/)
    assert.match(fs.readFileSync(wrapper(moved), 'utf8'), /ELECTRON_RUN_AS_NODE=1/)
  } finally { moved.done() }
})
