// Platform-dependent choices, checked for both win32 and POSIX on any OS: where
// the control socket lives, and how dsh is started.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { socketEndpoint as hostEndpoint } from '../host/lib/socket.js'
import { socketEndpoint as coreEndpoint, dshCommand } from '../src/core.mjs'

test('POSIX keeps the socket path exactly as given', () => {
  for (const p of ['/Users/a/.dsh-baton/host.sock', '/tmp/x y/h.sock', 'relative/h.sock']) {
    for (const platform of ['darwin', 'linux']) {
      assert.equal(hostEndpoint(p, platform), p)
      assert.equal(coreEndpoint(p, platform), p)
    }
  }
})

test('Windows maps a socket path to a per-path named pipe', () => {
  const pipe = hostEndpoint('C:\\Users\\a\\.dsh-baton\\host.sock', 'win32')
  assert.match(pipe, /^\\\\\.\\pipe\\dsh-baton-[0-9a-f]{16}$/)
  // case- and separator-insensitive, like Windows paths
  assert.equal(hostEndpoint('c:/users/A/.dsh-baton/HOST.sock', 'win32'), pipe)
  // another user's home (or another DSH_BATON_HOME) gets another pipe
  assert.notEqual(hostEndpoint('C:\\Users\\b\\.dsh-baton\\host.sock', 'win32'), pipe)
})

test('the host plugin and the MCP server agree on the endpoint', () => {
  for (const p of ['C:\\Users\\a\\.dsh-baton\\host.sock', 'D:\\x\\h.sock', '/Users/a/.dsh-baton/host.sock']) {
    for (const platform of ['win32', 'darwin']) assert.equal(coreEndpoint(p, platform), hostEndpoint(p, platform))
  }
})

test('an explicit pipe name is used as is on Windows', () => {
  for (const p of ['\\\\.\\pipe\\my-bridge', '\\\\?\\pipe\\other']) assert.equal(hostEndpoint(p, 'win32'), p)
})

test('dsh is spawned directly on POSIX', () => {
  assert.deepEqual(dshCommand(['headless', '--json', '-'], '/opt/dsh', 'darwin'), { file: '/opt/dsh', args: ['headless', '--json', '-'], options: {} })
})

test('a .cmd launcher on Windows goes through cmd.exe with quoted arguments', () => {
  const c = dshCommand(['headless', '--patch', 'C:\\a b\\x.yml', '-'], 'C:\\Program Files\\dsh\\dsh.cmd', 'win32')
  assert.match(c.file, /cmd(\.exe)?$/i)
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(c.args[3], '""C:\\Program Files\\dsh\\dsh.cmd" headless --patch "C:\\a b\\x.yml" -"')
  assert.equal(c.options.windowsVerbatimArguments, true)
})

test('the Windows desktop app runs its packed CLI in Node mode', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
  const c = dshCommand(['headless', '-'], exe, 'win32')
  assert.equal(c.file, exe)
  assert.equal(c.args[0], path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.deepEqual(c.args.slice(1), ['headless', '-'])
  assert.equal(c.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('a plain .exe on Windows is spawned directly', () => {
  assert.deepEqual(dshCommand(['headless'], 'C:\\bin\\dsh.exe', 'win32'), { file: 'C:\\bin\\dsh.exe', args: ['headless'], options: {} })
})

test('names from before the rename keep working: DSH_BRIDGE_* settings, ~/.dsh-bridge, the old pipe', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { setting, batonHome, hostEndpoints } = await import('../host/lib/socket.js')
  assert.equal(setting('WAIT_S', { DSH_BRIDGE_WAIT_S: '60' }), '60')
  assert.equal(setting('WAIT_S', { DSH_BRIDGE_WAIT_S: '60', DSH_BATON_WAIT_S: '90' }), '90')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-home-'))
  assert.equal(batonHome({}, home), path.join(home, '.dsh-baton'))
  fs.mkdirSync(path.join(home, '.dsh-bridge'))
  assert.equal(batonHome({}, home), path.join(home, '.dsh-bridge'))
  fs.mkdirSync(path.join(home, '.dsh-baton'))
  assert.equal(batonHome({}, home), path.join(home, '.dsh-baton'))
  fs.rmSync(home, { recursive: true, force: true })
  const win = hostEndpoints({ DSH_BATON_SOCKET: 'C:\\Users\\me\\.dsh-baton\\host.sock' }, 'win32')
  assert.equal(win.length, 2)
  assert.match(win[0], /\\pipe\\dsh-baton-[0-9a-f]{16}$/)
  assert.match(win[1], /\\pipe\\dsh-bridge-[0-9a-f]{16}$/)
  assert.deepEqual(hostEndpoints({ DSH_BATON_SOCKET: '/tmp/h.sock' }, 'darwin'), ['/tmp/h.sock'])
})
