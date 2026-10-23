#!/usr/bin/env node
// MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies.
import readline from 'node:readline'
import path from 'node:path'
import * as core from './core.mjs'
import { stableNodePath } from './setup.mjs'

const SERVER = { name: 'dsh-baton', version: core.VERSION }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const str = (description) => ({ type: 'string', description })
const int = (description, d) => ({ type: 'integer', description, default: d })

// How long one dsh_wait call waits, chosen by the server so it always ends before the
// client gives up on the tool call: Codex stops a call after 300 s, so it gets 270 s;
// other clients get 50 s (Claude Code waits with wait_command instead). DSH_BATON_WAIT_S
// overrides it for a client whose timeout was raised. A timeout_s from the model is
// ignored, so a model cannot pick a short wait and poll.
const MAX_WAIT_S = 24 * 3600
const envWait = Math.floor(Number(core.setting('WAIT_S')))
const isCodex = () => core.senderOf(clientName) === 'codex'
const waitSeconds = () => {
  if (envWait >= 1) return Math.min(envWait, MAX_WAIT_S)
  return isCodex() ? 270 : 50
}
const WAIT_CHUNK_S = 10
// The Codex app runs tools from a script cell that yields every 30 s and wakes the model
// to resume it; a yield longer than one dsh_wait keeps the whole wait in one turn.
const codeModeYield = () => {
  const ms = (waitSeconds() + 20) * 1000
  return `Required when you call tools from a script cell ("Script running with cell ID …"): the script that calls dsh_wait must start with the line // @exec: {"yield_time_ms": ${ms}}, never a shorter value; if the cell still yields, resume it with wait and yield_time_ms ${ms} (or the largest value wait accepts), never a short value such as 30000 or 55000.`
}
const NO_POLL = 'While waiting, make no other calls: no dsh_status, dsh_session_activity or dsh_read_session, and do not list or read the target folder or files to check progress. The final dsh_wait result carries the reply of the run; check files only after the run ends, if needed.'
const ARCHIVED = 'Sessions not in dsh_list_sessions are archived or gone: do not look for them on disk.'

// A shell command that blocks until a run ends and prints its reply. Run in the
// background by a client that wakes the model when the command exits (Claude Code),
// it waits without spending any turns. Plain "<node>" "<cli>" wait <id> form: it runs
// in POSIX shells and in Git Bash, which Claude Code uses on Windows too. Registered on
// Harness's own binary (no Node.js installed), the command keeps it in Node mode.
const quote = (p) => `"${p}"`
const nodeMode = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
const waitCommand = (runId) =>
  /^[\w.-]+$/.test(runId ?? '') ? `${nodeMode}${quote(stableNodePath())} ${quote(path.join(core.ROOT, 'src', 'cli.mjs'))} wait ${runId}` : undefined

// Wait in short chunks, reporting progress between them (clients that support it can
// show it or reset their timer). An unfinished wait returns only the state, not the run's
// recent events, so the client has nothing to summarise and simply waits again.
async function waitInChunks({ run_id }, progress) {
  const total = waitSeconds()
  const started = Date.now()
  const deadline = started + total * 1000
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000)
    const t0 = Date.now()
    const st = await core.api.wait({ run_id, timeout_s: Math.max(1, Math.min(WAIT_CHUNK_S, left)) })
    if (!st.timed_out) return st
    // Never spin: a chunk that came back early still takes a moment before the next one.
    if (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 500))
    if (Date.now() >= deadline) {
      return {
        run_id, state: st.state, timed_out: true,
        ...(st.waiting_on ? { waiting_on: st.waiting_on } : {}),
        hint: st.state === 'waiting'
          ? 'The run is waiting for a person to answer in the Harness UI. Tell the user, then call dsh_wait again.'
          : `Still ${st.state}. Call dsh_wait again with the same run_id, with no other calls in between and no progress note.`,
      }
    }
    progress?.(Math.round((Date.now() - started) / 1000), `run ${run_id} is ${st.state}`)
  }
}

// MCP tool annotations. Every tool only talks to the local Harness (no open world).
const hints = (readOnlyHint, destructiveHint, idempotentHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false })
const READ = hints(true, false, true)
const EDIT = hints(false, false, true) // changes something, and the same call again changes nothing more
const annotations = (title, h = READ) => ({ title, ...h })

const TOOLS = [
  {
    name: 'dsh_list_workspaces',
    annotations: annotations('List workspaces'),
    description: 'List the workspaces (project folders) in the DeepSeek Harness sidebar; dsh_list_sessions lists the sessions inside them and dsh_create_workspace adds one. Returns id, path, title and session_count for each; the id is the workspace_id for dsh_send and dsh_rename_workspace. Read-only. Needs the dsh-baton-host plugin.',
    inputSchema: { type: 'object', properties: {} },
    run: () => core.api.workspaces(),
  },
  {
    name: 'dsh_create_workspace',
    annotations: annotations('Create workspace', EDIT),
    description: 'Add a folder to the DeepSeek Harness sidebar as a workspace without starting a session; dsh_list_workspaces only lists existing ones, and dsh_send with a cwd registers the folder by itself. Creates the folder unless create_dir is false. Idempotent: an already registered folder returns its existing workspace. Returns id, path, title and created (false when it already existed). Needs the dsh-baton-host plugin.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Absolute folder path (~ allowed)'), title: str('Sidebar title; defaults to the folder name'), create_dir: { type: 'boolean', description: 'Create the folder if missing', default: true } } },
    run: (a) => core.api.create_workspace(a),
  },
  {
    name: 'dsh_list_sessions',
    annotations: annotations('List sessions'),
    description: `List saved DeepSeek Harness sessions (conversations), newest first, to find a session_id; dsh_list_runs lists only the messages sent through dsh_send. Returns session_id, title, cwd, updated_at, running and bridge_runs (active dsh-baton run ids) for each. There is no paging: the list stops at limit, so to see older sessions raise limit or narrow it with cwd or query. Read-only. ${ARCHIVED}`,
    inputSchema: { type: 'object', properties: { cwd: str('Only sessions of this workspace folder'), query: str('Case-insensitive text to match in title, folder or session id'), limit: int('Max sessions returned', 20), include_subagents: { type: 'boolean', description: 'Also list sub-agent sessions', default: false } } },
    run: (a) => core.api.list_sessions(a),
  },
  {
    name: 'dsh_read_session',
    annotations: annotations('Read session'),
    description: 'Read what was said in one session (its past messages), to catch up before continuing it; dsh_session_activity shows what it is doing now and dsh_status follows one run. Returns title, cwd, total_messages and the last messages, each with role (user or assistant), time, text and the names of tools the assistant called (tool output is not included). Read-only.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id from dsh_list_sessions, e.g. session-…'), last: int('How many of the most recent messages to return; total_messages tells how many there are', 10) } },
    run: (a) => core.api.read_session(a),
  },
  {
    name: 'dsh_send',
    annotations: annotations('Send message', hints(false, false, false)),
    description: 'Send a message to a DeepSeek Harness session and return at once with a run_id, without waiting for the reply; dsh_wait then waits for it. With session_id it continues that existing session (same context, no new session); with cwd or workspace_id it starts a new session there (a cwd that is not a workspace yet is registered in the sidebar first). The turn runs in the background. If the session is already working, mode followup (default) queues the message after the current turn and steer adds it to the running turn; each message gets its own run_id. The message is delivered verbatim as a user message, with no prefix or label added: write it in the language the user works in, self-contained (Harness does not see this conversation), and say who is asking only if it matters. Then wait for the reply with dsh_wait (or the wait_command it returns, where offered).',
    inputSchema: { type: 'object', required: ['message'], properties: { message: str('The task or reply to send'), session_id: str('Existing session to continue'), cwd: str('Workspace folder for a new session'), workspace_id: str('Harness workspace for a new session (from dsh_list_workspaces)'), mode: { type: 'string', enum: ['followup', 'steer'], description: 'followup queues after the current turn (default); steer injects into a running turn', default: 'followup' } } },
    run: async (a) => {
      const st = await core.api.send({ ...a, sender: core.senderOf(core.setting('SENDER') || clientName) })
      // Codex has no wake-on-exit for shell commands: offered wait_command, it runs it in a
      // terminal and polls that, so it gets dsh_wait only.
      if (isCodex()) return { ...st, hint: `Run started. Call dsh_wait with this run_id; it returns when the run ends. ${NO_POLL} ${codeModeYield()}` }
      return {
        ...st,
        wait_command: waitCommand(st.run_id),
        hint: 'Run started. If you can run a shell command in the background and are woken when it exits (Claude Code: Bash with run_in_background), run wait_command that way: it ends when the run ends and prints the reply, with no polling. Otherwise call dsh_wait with this run_id.',
      }
    },
  },
  {
    name: 'dsh_status',
    annotations: annotations('Run status'),
    description: 'Look once at one run sent with dsh_send, without waiting; dsh_wait waits for it to end and dsh_session_activity covers the whole session. Returns state (queued/running/waiting/completed/failed/cancelled, or interrupted when a Harness restart cut it short), session_id, recent events (text, tool calls), final reply, waiting_on when the turn is over but sub-agents or background jobs are still working, and human_interjections when someone typed in the Harness UI during the run (its result then reflects that input too). A one-off look, never a way to wait: to wait for the reply use dsh_wait, and if dsh_wait timed out, call dsh_wait again.',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send'), tail: int('How many recent events', 20) } },
    run: (a) => core.api.status(a),
  },
  {
    name: 'dsh_wait',
    annotations: annotations('Wait for run'),
    description: () => `Wait for a run sent with dsh_send to end and return its final status and reply; dsh_status only looks once.${isCodex() ? '' : ' Prefer the background wait_command from dsh_send when your client can run background shell commands and wake you when they exit: it costs no turns while waiting.'} Each call waits up to ${waitSeconds()} s (set by the server to stay under this client's tool timeout); if the run is still going it returns timed_out: true with just the state: then call dsh_wait again with the same run_id, without summarising progress.${isCodex() ? ` ${NO_POLL} ${codeModeYield()}` : ''} Sends progress notifications while waiting when the client asks for them.`,
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send') } },
    run: (a, { progress }) => waitInChunks(a, progress),
  },
  {
    name: 'dsh_rename_session',
    annotations: annotations('Rename session', EDIT),
    description: 'Set the title of one DeepSeek Harness session (a conversation); dsh_rename_workspace renames a workspace (project folder) instead. Only the title changes; the conversation and any running turn are untouched. Can be called again at any time to change it back or to something else. Returns session_id and the saved title.',
    inputSchema: { type: 'object', required: ['session_id', 'title'], properties: { session_id: str('Session id from dsh_list_sessions'), title: str('New title; surrounding spaces are trimmed and it must not be empty') } },
    run: (a) => core.api.rename_session(a),
  },
  {
    name: 'dsh_rename_workspace',
    annotations: annotations('Rename workspace', EDIT),
    description: 'Set the sidebar title of a DeepSeek Harness workspace (project folder); dsh_rename_session renames a single session instead. The folder on disk is not moved or renamed. Identify it by workspace_id or path. Can be called again to change it back. Returns id, path and the saved title.',
    inputSchema: { type: 'object', required: ['title'], properties: { workspace_id: str('Workspace id from dsh_list_workspaces'), path: str('Workspace folder, used when workspace_id is not given'), title: str('New title; surrounding spaces are trimmed and it must not be empty') } },
    run: (a) => core.api.rename_workspace(a),
  },
  {
    name: 'dsh_session_activity',
    annotations: annotations('Session activity'),
    description: 'Show what one session is doing right now, across all its work; dsh_status follows a single run and dsh_read_session shows past messages. Returns busy, activity (its running turn, sub-agents at any depth, background jobs and reminders) and bridge_runs (active dsh-baton runs). Read-only. Check it before dsh_send to a session that might be busy, or before dsh_cancel.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id from dsh_list_sessions') } },
    run: (a) => core.api.activity(a),
  },
  {
    name: 'dsh_cancel',
    annotations: annotations('Cancel session work', hints(false, true, true)),
    description: 'Stop everything a session is doing (running turn, sub-agents, background jobs, reminders), by run_id or session_id; the session itself is kept, and this is the only tool that stops work. It retries a few times until the session is quiet, then returns session_id, run (when run_id was given), attempts, still_busy, activity (whatever is still going) and queued_runs. Messages still waiting in the queue are not removed. Safe to repeat: on an idle session it does nothing and returns still_busy: false. Use dsh_session_activity first to see what would be stopped.',
    inputSchema: { type: 'object', properties: { run_id: str('Run id from dsh_send; stops the session that run belongs to'), session_id: str('Session id, to stop work dsh-baton did not start') } },
    run: (a) => core.api.cancel(a),
  },
  {
    name: 'dsh_list_runs',
    annotations: annotations('List runs'),
    description: 'List the runs sent through dsh_send (the latest 100 are kept), newest first, to recover a lost run_id or review past hand-overs; dsh_list_sessions lists Harness sessions instead. Returns run_id, session_id, state, started_at, ended_at, message_preview, final_text and error for each; dsh_status shows one run in detail. Read-only.',
    inputSchema: { type: 'object', properties: { limit: int('Max runs returned', 10) } },
    run: (a) => core.api.list_runs(a),
  },
]

let clientName = null
let versionWarned = false

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
        instructions: `Hands tasks to a local DeepSeek Harness and passes the results back. Typical flow: dsh_list_workspaces (or dsh_create_workspace) to pick a folder, dsh_list_sessions to find a session, dsh_send {session_id, message} to continue it (or {cwd, message} to start one), then wait for the reply: ${isCodex() ? 'call dsh_wait with the run_id until it returns the final state (not dsh_status)' : 'run the wait_command it returns as a background shell command if your client wakes you when one exits, otherwise call dsh_wait'}. Then dsh_read_session to read the conversation, dsh_session_activity to see what a session is doing, and dsh_cancel to stop it; dsh_list_runs recovers a lost run_id. A run in state "waiting" needs a person to answer in the Harness UI. ${ARCHIVED}`,
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...t }) => ({ ...t, description: typeof t.description === 'function' ? t.description() : t.description })) }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name)
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${req.params?.name}`), { code: -32602 })
      try {
        // MCP progress: only when the client sent a progressToken with this call.
        const token = req.params?._meta?.progressToken
        const progress = token === undefined ? undefined : (done, message) =>
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: done, message } })
        const result = await tool.run(req.params.arguments || {}, { progress })
        const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        // Said once per server process, the first time a call finds the versions apart.
        const warning = !versionWarned && core.versionWarning()
        if (warning) { versionWarned = true; content.push({ type: 'text', text: `Note for the user: ${warning}` }) }
        return { content }
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
