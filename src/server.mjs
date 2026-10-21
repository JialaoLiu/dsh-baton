#!/usr/bin/env node
// MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies.
import readline from 'node:readline'
import path from 'node:path'
import * as core from './core.mjs'

const SERVER = { name: 'dsh-bridge', version: '0.2.0' }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const str = (description) => ({ type: 'string', description })
const int = (description, d) => ({ type: 'integer', description, default: d })

// How long one dsh_wait call waits by default. 50 s stays under Codex's default 60 s
// tool timeout; a client whose timeout was raised (Codex: tool_timeout_sec) sets
// DSH_BRIDGE_WAIT_S a little below it, so one call covers the whole run.
const MAX_WAIT_S = 24 * 3600
const envWait = Math.floor(Number(process.env.DSH_BRIDGE_WAIT_S))
const DEFAULT_WAIT_S = envWait >= 1 ? Math.min(envWait, MAX_WAIT_S) : 50
const WAIT_CHUNK_S = 10

// A shell command that blocks until a run ends and prints its reply. Run in the
// background by a client that wakes the model when the command exits (Claude Code),
// it waits without spending any turns. Plain "<node>" "<cli>" wait <id> form: it runs
// in POSIX shells and in Git Bash, which Claude Code uses on Windows too.
const quote = (p) => `"${p}"`
const waitCommand = (runId) =>
  /^[\w.-]+$/.test(runId ?? '') ? `${quote(process.execPath)} ${quote(path.join(core.ROOT, 'src', 'cli.mjs'))} wait ${runId}` : undefined

// Wait in short chunks so each one stays well inside any client's tool timeout,
// reporting progress between chunks (clients that support it reset their timer).
async function waitInChunks({ run_id, timeout_s = DEFAULT_WAIT_S }, progress) {
  const total = Number.isFinite(Number(timeout_s)) ? Math.max(0, Number(timeout_s)) : DEFAULT_WAIT_S
  const started = Date.now()
  const deadline = started + total * 1000
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000)
    const t0 = Date.now()
    const st = await core.api.wait({ run_id, timeout_s: Math.max(1, Math.min(WAIT_CHUNK_S, left)) })
    if (!st.timed_out) return st
    // Never spin: a chunk that came back early still takes a moment before the next one.
    if (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 500))
    if (Date.now() >= deadline) return { ...st, hint: `Still ${st.state}. Call dsh_wait again with run_id ${run_id} to keep waiting.` }
    progress?.(Math.round((Date.now() - started) / 1000), `run ${run_id} is ${st.state}`)
  }
}

const TOOLS = [
  {
    name: 'dsh_list_workspaces',
    description: 'List the workspaces (project folders) shown in the DeepSeek Harness sidebar. Needs the dsh-bridge-host plugin.',
    inputSchema: { type: 'object', properties: {} },
    run: () => core.api.workspaces(),
  },
  {
    name: 'dsh_create_workspace',
    description: 'Register a folder as a workspace in the DeepSeek Harness sidebar (creates the folder unless create_dir is false). Idempotent: an already registered folder returns its existing workspace. Needs the dsh-bridge-host plugin.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Absolute folder path (~ allowed)'), title: str('Sidebar title; defaults to the folder name'), create_dir: { type: 'boolean', description: 'Create the folder if missing', default: true } } },
    run: (a) => core.api.create_workspace(a),
  },
  {
    name: 'dsh_list_sessions',
    description: 'List saved DeepSeek Harness sessions, newest first, with title, workspace folder (cwd) and whether a run is active. Use it to find the session_id to continue.',
    inputSchema: { type: 'object', properties: { cwd: str('Only sessions of this workspace folder'), query: str('Filter by text in title or folder'), limit: int('Max sessions', 20), include_subagents: { type: 'boolean', description: 'Also list sub-agent sessions', default: false } } },
    run: (a) => core.api.list_sessions(a),
  },
  {
    name: 'dsh_read_session',
    description: 'Read the recent visible conversation (user prompts and assistant replies, with tool names) of one session.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id, e.g. session-…'), last: int('How many recent messages', 10) } },
    run: (a) => core.api.read_session(a),
  },
  {
    name: 'dsh_send',
    description: 'Send a message to DeepSeek Harness. With session_id it continues that existing session (same context, no new session); with cwd or workspace_id it starts a new session there (a cwd that is not a workspace yet is registered in the sidebar first). Returns immediately with a run_id; the turn runs in the background. If the session is already working, mode followup (default) queues the message after the current turn and steer adds it to the running turn; each message gets its own run_id. The message is delivered verbatim as a user message, with no prefix or label added: write it in the language the user works in, self-contained (Harness does not see this conversation), and say who is asking only if it matters. Follow up with dsh_wait or dsh_status.',
    inputSchema: { type: 'object', required: ['message'], properties: { message: str('The task or reply to send'), session_id: str('Existing session to continue'), cwd: str('Workspace folder for a new session'), workspace_id: str('Harness workspace for a new session (from dsh_list_workspaces)'), mode: { type: 'string', enum: ['followup', 'steer'], description: 'followup queues after the current turn (default); steer injects into a running turn', default: 'followup' } } },
    run: async (a) => {
      const st = await core.api.send({ ...a, sender: core.senderOf(process.env.DSH_BRIDGE_SENDER || clientName) })
      return {
        ...st,
        wait_command: waitCommand(st.run_id),
        hint: 'Run started. If you can run a shell command in the background and are woken when it exits (Claude Code: Bash with run_in_background), run wait_command that way: it ends when the run ends and prints the reply, with no polling. Otherwise call dsh_wait with this run_id.',
      }
    },
  },
  {
    name: 'dsh_status',
    description: 'Progress of a run: state (queued/running/waiting/completed/failed/cancelled, or interrupted when a Harness restart cut it short), session_id, recent events (text, tool calls), final reply, waiting_on when the turn is over but sub-agents or background jobs are still working, and human_interjections when someone typed in the Harness UI during the run (its result then reflects that input too).',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send'), tail: int('How many recent events', 20) } },
    run: (a) => core.api.status(a),
  },
  {
    name: 'dsh_wait',
    description: `Wait for a run to finish and return its final status and reply. Prefer the background wait_command from dsh_send when your client can run background shell commands and wake you when they exit: it costs no turns while waiting. Returns after timeout_s (default ${DEFAULT_WAIT_S}, set with DSH_BRIDGE_WAIT_S to stay under the client's tool timeout) with timed_out: true if the run is still going: then call dsh_wait again with the same run_id. Sends progress notifications while waiting when the client asks for them.`,
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send'), timeout_s: int('Seconds to wait before returning with timed_out', DEFAULT_WAIT_S) } },
    run: (a, { progress }) => waitInChunks(a, progress),
  },
  {
    name: 'dsh_rename_session',
    description: 'Rename a DeepSeek Harness session (shown in the sidebar).',
    inputSchema: { type: 'object', required: ['session_id', 'title'], properties: { session_id: str('Session id'), title: str('New title') } },
    run: (a) => core.api.rename_session(a),
  },
  {
    name: 'dsh_rename_workspace',
    description: 'Rename a DeepSeek Harness workspace (sidebar title only; the folder is not moved). Identify it by workspace_id or path.',
    inputSchema: { type: 'object', required: ['title'], properties: { workspace_id: str('Workspace id'), path: str('Workspace folder'), title: str('New title') } },
    run: (a) => core.api.rename_workspace(a),
  },
  {
    name: 'dsh_session_activity',
    description: 'What a session is doing right now: its running turn, sub-agents (any depth), background jobs and reminders, plus bridge runs. Check this before sending to a session that might be busy.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id') } },
    run: (a) => core.api.activity(a),
  },
  {
    name: 'dsh_cancel',
    description: 'Stop everything a session is doing (running turn, sub-agents, background jobs), by run_id or session_id. Messages still waiting in the queue are not removed.',
    inputSchema: { type: 'object', properties: { run_id: str('Run id'), session_id: str('Session id (to stop work the bridge did not start)') } },
    run: (a) => core.api.cancel(a),
  },
  {
    name: 'dsh_list_runs',
    description: 'List recent runs started through this bridge, newest first.',
    inputSchema: { type: 'object', properties: { limit: int('Max runs', 10) } },
    run: (a) => core.api.list_runs(a),
  },
]

let clientName = null

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(req) {
  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion
      clientName = req.params?.clientInfo?.name ?? null
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: 'Bridge to a local DeepSeek Harness. Find a session with dsh_list_sessions, continue it with dsh_send {session_id, message}, then wait for the reply: run the wait_command it returns as a background shell command if your client wakes you when one exits, otherwise call dsh_wait. A run in state "waiting" needs a person to answer in the Harness UI.',
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...t }) => t) }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name)
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${req.params?.name}`), { code: -32602 })
      try {
        // MCP progress: only when the client sent a progressToken with this call.
        const token = req.params?._meta?.progressToken
        const progress = token === undefined ? undefined : (done, message) =>
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: done, message } })
        const result = await tool.run(req.params.arguments || {}, { progress })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 })
  }
}

const rl = readline.createInterface({ input: process.stdin })

// Exit when the client goes away: stdin closes, or the parent process dies
// and we get re-parented. Otherwise orphaned servers pile up.
let inFlight = 0
let stdinClosed = false
// Writes to a piped stdout are asynchronous: flush the last reply before exiting.
const exitIfDone = () => { if (stdinClosed && inFlight === 0) process.stdout.write('', () => process.exit(0)) }
rl.on('close', () => { stdinClosed = true; exitIfDone() })
const parentPid = process.ppid
// Windows does not re-parent orphans (ppid stays the same), so there the parent is checked directly.
const parentGone = () => {
  if (process.platform !== 'win32') return false
  try { process.kill(parentPid, 0); return false } catch (e) { return e.code !== 'EPERM' }
}
setInterval(() => { if (process.ppid !== parentPid || parentGone()) process.exit(0) }, 5000).unref()

rl.on('line', async (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    return send({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'Invalid Request' } })
  }
  if (req.id === undefined) return // notification
  inFlight++
  try {
    send({ jsonrpc: '2.0', id: req.id, result: await handle(req) })
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: e.code || -32603, message: e.message } })
  } finally {
    inFlight--
    exitIfDone()
  }
})
