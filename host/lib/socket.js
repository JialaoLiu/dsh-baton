// Shared by the host plugin and the MCP server / CLI (src/core.mjs imports it):
// settings, the home folder, and where the control socket lives.
//
// The project was called dsh-bridge before it became dsh-baton. For one version the
// old names keep working: DSH_BRIDGE_* settings (with a warning), an existing
// ~/.dsh-bridge home, and the old pipe name on Windows, so an MCP server that is
// already updated still reaches a host plugin that is not restarted yet.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const warned = new Set()

// DSH_BATON_<name>, else the old DSH_BRIDGE_<name>.
export function setting(name, env = process.env) {
  if (env[`DSH_BATON_${name}`] !== undefined) return env[`DSH_BATON_${name}`]
  const old = env[`DSH_BRIDGE_${name}`]
  if (old !== undefined && env === process.env && !warned.has(name)) {
    warned.add(name)
    process.emitWarning(`DSH_BRIDGE_${name} is deprecated; rename it to DSH_BATON_${name}`)
  }
  return old
}

// ~/.dsh-baton, unless only an earlier ~/.dsh-bridge exists: then keep using that, so
// run records and the socket stay where an installed host plugin expects them.
export function batonHome(env = process.env, home = os.homedir()) {
  const set = setting('HOME', env)
  if (set) return set
  const fresh = path.join(home, '.dsh-baton')
  const old = path.join(home, '.dsh-bridge')
  return !fs.existsSync(fresh) && fs.existsSync(old) ? old : fresh
}

const PIPE_PREFIX = /^\\\\[.?]\\pipe\\/i

// A Unix socket file on macOS and Linux. Node cannot listen on a socket file on
// Windows, so there the same path maps to a named pipe: \\.\pipe\dsh-baton-<hash of
// the path>. The default path sits in the user's own home folder, so the pipe name is
// per user. DSH_BATON_SOCKET may be either a path (mapped the same way) or a pipe name.
export function socketEndpoint(p, platform = process.platform, prefix = 'dsh-baton') {
  if (platform !== 'win32' || PIPE_PREFIX.test(p)) return p
  const key = path.win32.resolve(p).toLowerCase()
  return `\\\\.\\pipe\\${prefix}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export const socketPath = (env = process.env) => setting('SOCKET', env) || path.join(batonHome(env), 'host.sock')

// Where a client looks for the host: the current endpoint, then the one a host
// plugin from before the rename listens on (differs only on Windows).
export function hostEndpoints(env = process.env, platform = process.platform) {
  const p = socketPath(env)
  return [...new Set([socketEndpoint(p, platform), socketEndpoint(p, platform, 'dsh-bridge')])]
}
