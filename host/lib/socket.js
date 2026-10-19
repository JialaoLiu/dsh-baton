// Where the control socket lives. On macOS and Linux it is a Unix socket file.
// Node cannot listen on a socket file on Windows, so there the same path is
// mapped to a named pipe: \\.\pipe\dsh-bridge-<hash of the path>. The default
// path sits in the user's own bridge home, so the pipe name is per user, and
// DSH_BRIDGE_SOCKET may be either a path (mapped the same way) or a pipe name.
// src/core.mjs has the same function (hostSocket); keep the two in step.
import path from 'node:path'
import crypto from 'node:crypto'

const PIPE_PREFIX = /^\\\\[.?]\\pipe\\/i

export function socketEndpoint(p, platform = process.platform) {
  if (platform !== 'win32' || PIPE_PREFIX.test(p)) return p
  const key = path.win32.resolve(p).toLowerCase()
  return `\\\\.\\pipe\\dsh-bridge-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}
