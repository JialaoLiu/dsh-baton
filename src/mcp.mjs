// The MCP server itself (newline-delimited JSON-RPC 2.0 over stdio, no dependencies). It
// runs as a child of server.mjs, which starts a fresh one when a newer version is installed.
import readline from 'node:readline'
import path from 'node:path'
import * as core from './core.mjs'
import { stableNodePath } from './setup.mjs'
import { conversationFolder, within } from './folder.mjs'
import { threadOf, remember, delivered, hookActive } from './codex-hook.mjs'

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
const NO_POLL = 'While waiting, make no other calls (no dsh_status, dsh_session_activity or dsh_read_session) and do not list or read the target folder to check progress.'
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
    if (st.needs_input || !st.timed_out) return core.waitResult(st)
    // Never spin: a chunk that came back early still takes a moment before the next one.
    if (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 500))
    if (Date.now() >= deadline) {
      return {
        run_id, state: st.state, timed_out: true,
        ...(st.waiting_on ? { waiting_on: st.waiting_on } : {}),
        hint: st.state === 'waiting'
          ? 'The run is still waiting for a person (see dsh_status for its question). Answer it with dsh_answer if you may, or tell the user; then call dsh_wait again.'
          : `Still ${st.state}. Call dsh_wait again with the same run_id, with no other calls in between and no progress note.`,
      }
    }
    progress?.(Math.round((Date.now() - started) / 1000), `run ${run_id} is ${st.state}`)
  }
}

// Long event texts are cut in results: the client rarely needs them whole (dsh_read_session has them).
const clip = (st) => (Array.isArray(st?.recent_events)
  ? { ...st, recent_events: st.recent_events.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v]))) }
  : st)

// MCP tool annotations. Every tool only talks to the local Harness (no open world).
const hints = (readOnlyHint, destructiveHint, idempotentHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false })
const READ = hints(true, false, true)
const EDIT = hints(false, false, true) // changes something, and the same call again changes nothing more
const annotations = (title, h = READ) => ({ title, ...h })

const TOOLS = [
  {
    name: 'dsh_list_workspaces',
    annotations: annotations('List workspaces'),
    description: 'List the DeepSeek Harness workspaces (project folders): id, path, title and session_count. The id is the workspace_id for dsh_send. Read-only. Needs the dsh-baton-host plugin.',
    inputSchema: { type: 'object', properties: {} },
    run: () => core.api.workspaces(),
  },
  {
    name: 'dsh_create_workspace',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('Create workspace', EDIT),
    description: 'Register a folder as a Harness workspace without starting a session (dsh_send with cwd does this too). Creates the folder unless create_dir is false; an already registered folder returns its workspace. Returns id, path, title and created. Needs the dsh-baton-host plugin.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Absolute folder path (~ allowed)'), title: str('Sidebar title; defaults to the folder name'), create_dir: { type: 'boolean', description: 'Create the folder if missing', default: true } } },
    run: (a) => core.api.create_workspace(a),
  },
  {
    name: 'dsh_list_sessions',
    annotations: annotations('List sessions'),
    description: `List Harness sessions, newest first, to find a session_id: session_id, title, cwd, updated_at, running and bridge_runs. No paging: raise limit or narrow it with cwd or query. Read-only. ${ARCHIVED}`,
    inputSchema: { type: 'object', properties: { cwd: str('Only sessions of this workspace folder'), query: str('Case-insensitive text to match in title, folder or session id'), limit: int('Max sessions returned', 20), include_subagents: { type: 'boolean', description: 'Also list sub-agent sessions', default: false } } },
    run: (a) => core.api.list_sessions(a),
  },
  {
    name: 'dsh_read_session',
    annotations: annotations('Read session'),
    description: 'Read the last messages of a session (role, time, text and the names of tools called; no tool output), to catch up before continuing it. Read-only.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id from dsh_list_sessions, e.g. session-…'), last: int('How many of the most recent messages to return; total_messages tells how many there are', 10) } },
    run: (a) => core.api.read_session(a),
  },
  {
    name: 'dsh_send',
    annotations: annotations('Send message', hints(false, false, false)),
    description: 'Send a message to a Harness session and return at once with a run_id; then wait for the reply with dsh_wait (or the wait_command it returns, where offered). session_id continues that session; without it a new session starts in cwd or workspace_id, or, with neither, in the folder this conversation works in (a new cwd is registered first). If the session is busy, mode followup queues the message and steer adds it to the running turn; leave mode out to follow the Harness setting. The message arrives verbatim as a user message (with checks, a short request for a sub-agent review table is appended): make it self-contained (Harness does not see this conversation), in the user\'s language.',
    inputSchema: { type: 'object', required: ['message'], properties: { message: str('The task or reply to send'), session_id: str('Existing session to continue'), cwd: str('Workspace folder for a new session; leave out to use the folder this conversation works in'), workspace_id: str('Harness workspace for a new session (from dsh_list_workspaces)'), mode: { type: 'string', enum: ['followup', 'steer'], description: "followup queues after the current turn; steer injects into a running turn. Omit to follow Harness's busy-send setting" }, checks: { type: 'array', items: { type: 'string' }, description: 'The project\'s own test commands, e.g. npm test (ask Harness in the message to write tests for each requirement). Do not write check scripts yourself. dsh-baton runs them in the folder when the run ends and returns exit codes and the last output lines as evidence.' } } },
    run: async (a, { meta } = {}) => {
      // A new session goes to this conversation's folder unless the call names another one;
      // a different folder is allowed but said back, so a wrong guess does not go unnoticed.
      const here = a.session_id ? undefined : conversationFolder(meta, isCodex())
      const args = here && !a.cwd && !a.workspace_id ? { ...a, cwd: here } : a
      const folder = here && a.cwd && !within(a.cwd, here)
        ? { folder_note: `This conversation works in ${here}; the new session was started in ${a.cwd} as asked. If that was not intended, cancel it and send again without cwd.` }
        : args !== a ? { cwd: here } : {}
      const st = { ...(await core.api.send({ ...args, sender: core.senderOf(core.setting('SENDER') || clientName) })), ...folder }
      // Codex has no wake-on-exit for shell commands: offered wait_command, it runs it in a
      // terminal and polls that, so it gets dsh_wait only.
      if (isCodex()) {
        // With dsh-baton's Stop hook installed and firing, the model ends its turn and the
        // hook brings the result back into this conversation: no model requests while waiting.
        const thread = threadOf(meta)
        if (thread && hookActive()) {
          remember(thread, st.run_id)
          return { ...st, hint: `Run started. End your turn now: reply to the user in one short line (in their language) that the task is with DeepSeek Harness. Do not call dsh_wait, dsh_status or any other tool, and do not read the target folder. When the run ends or stops to ask something, dsh-baton continues this conversation by itself with the result (the same as dsh_wait returns). If the conversation is ever resumed without it, call dsh_wait with this run_id.` }
        }
        return { ...st, hint: `Run started. Call dsh_wait with this run_id; it returns when the run ends or stops to ask the user something. ${NO_POLL} ${codeModeYield()}` }
      }
      return {
        ...st,
        wait_command: waitCommand(st.run_id),
        hint: 'Run started. If you can run a shell command in the background and are woken when it exits (Claude Code: Bash with run_in_background), run wait_command that way: it ends when the run ends, or stops to ask the user something, and prints the reply or the questions, with no polling. Otherwise call dsh_wait with this run_id.',
      }
    },
  },
  {
    name: 'dsh_status',
    annotations: annotations('Run status'),
    description: 'Look once at a run without waiting: state (queued/running/waiting/completed/failed/cancelled/interrupted), recent events, final reply, waiting_on (sub-agents or jobs still working) and human_interjections. Never a way to wait: use dsh_wait.',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send'), tail: int('How many recent events', 5) } },
    run: async (a) => clip(await core.api.status({ tail: 5, ...a })),
  },
  {
    name: 'dsh_wait',
    annotations: annotations('Wait for run'),
    description: () => `Wait for a run sent with dsh_send to end and return its state and final reply.${isCodex() ? '' : ' Prefer the background wait_command from dsh_send if your client wakes you when a background command exits: it costs no turns.'} It also returns at once when the run stops to ask a person: needs_input answer (question and relay; reply with dsh_answer) or harness-ui (an approval only a person can give in Harness). Each call waits up to ${waitSeconds()} s; if it returns timed_out: true, call dsh_wait again with the same run_id, without a progress note.${isCodex() ? ` ${NO_POLL} ${codeModeYield()}` : ''}`,
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: str('Run id from dsh_send') } },
    run: async (a, { progress }) => {
      const result = await waitInChunks(a, progress)
      // Got here, the result must not come again through the Codex Stop hook.
      if (!result.timed_out) delivered(a.run_id, result)
      return result
    },
  },
  {
    name: 'dsh_answer',
    annotations: annotations('Answer question', hints(false, false, false)),
    description: 'Answer the questions a waiting run asked (question in dsh_wait or dsh_status). Per question: option numbers or labels in choose, text for a free answer, or skip. Pass reason when the user let you decide. The answer reaches Harness once every question has one (submitted: true; remaining lists the rest); then wait for the run again. If the user already answered in Harness, it reports that there is no open question.',
    inputSchema: {
      type: 'object', required: ['run_id', 'answers'], properties: {
        run_id: str('Run id that is waiting (needs_input: answer)'),
        answers: {
          type: 'array', description: 'One entry per question answered now', items: {
            type: 'object', properties: {
              id: str('Question id from question.questions[].id; may be left out when there is one question'),
              choose: { type: 'array', items: { type: ['integer', 'string'] }, description: 'Option numbers (1 = first) or labels; one for a single-choice question' },
              text: str('Free-text answer'),
              skip: { type: 'boolean', description: 'Skip this question' },
            },
          },
        },
        reason: str('Required when the user let you decide: one sentence on why you chose this, from your own judgment of the question and the task; it is returned for you to tell the user and not sent to Harness'),
      },
    },
    run: async (a) => {
      const st = await core.api.answer(a)
      return {
        ...st,
        hint: st.reason
          ? 'Tell the user what you chose and this reason. Then wait for the run again.'
          : 'If you chose on the user\'s behalf, tell them what you chose and why, from your own judgment of the task (that the asker suggested it is not a reason); next time pass reason. Then wait for the run again.',
      }
    },
  },
  {
    name: 'dsh_rename_session',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('Rename session', EDIT),
    description: 'Set the title of a Harness session; nothing else changes. Returns session_id and title.',
    inputSchema: { type: 'object', required: ['session_id', 'title'], properties: { session_id: str('Session id from dsh_list_sessions'), title: str('New title; surrounding spaces are trimmed and it must not be empty') } },
    run: (a) => core.api.rename_session(a),
  },
  {
    name: 'dsh_rename_workspace',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('Rename workspace', EDIT),
    description: 'Set the sidebar title of a workspace, by workspace_id or path; the folder is not renamed. Returns id, path and title.',
    inputSchema: { type: 'object', required: ['title'], properties: { workspace_id: str('Workspace id from dsh_list_workspaces'), path: str('Workspace folder, used when workspace_id is not given'), title: str('New title; surrounding spaces are trimmed and it must not be empty') } },
    run: (a) => core.api.rename_workspace(a),
  },
  {
    name: 'dsh_session_activity',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('Session activity'),
    description: 'What a session is doing now: busy, activity (running turn, sub-agents, background jobs, reminders) and bridge_runs. Read-only. Check it before dsh_send to a busy session or before dsh_cancel.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: str('Session id from dsh_list_sessions') } },
    run: (a) => core.api.activity(a),
  },
  {
    name: 'dsh_cancel',
    annotations: annotations('Cancel session work', hints(false, true, true)),
    description: 'Stop everything a session is doing (turn, sub-agents, background jobs, reminders), by run_id or session_id; the session is kept. Messages queued in it are dropped too (removed_from_queue); to drop one queued message use dsh_update_queued. Safe to repeat. Returns still_busy, activity and removed_from_queue.',
    inputSchema: { type: 'object', properties: { run_id: str('Run id from dsh_send; stops the session that run belongs to'), session_id: str('Session id, to stop work dsh-baton did not start') } },
    run: (a) => core.api.cancel(a),
  },
  {
    name: 'dsh_update_queued',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('Change queued message', hints(false, true, false)),
    description: 'Change a dsh_send message still queued behind a running turn: edit replaces its text, remove deletes it, steer sends it into the running turn now. Only while its run is queued.',
    inputSchema: { type: 'object', required: ['run_id', 'action'], properties: { run_id: str('Run id from dsh_send of the queued message'), action: { type: 'string', enum: ['edit', 'remove', 'steer'], description: 'edit replaces the text, remove deletes the message, steer sends it into the running turn now' }, message: str('New text for action edit (plain text, not empty)') } },
    run: (a) => core.api.update_queued(a),
  },
  {
    name: 'dsh_list_runs',
    hidden: true, // not in tools/list; reachable directly or through dsh_call
    annotations: annotations('List runs'),
    description: 'List the runs sent with dsh_send, newest first (the last 100 are kept), to recover a run_id: run_id, session_id, state, times, message_preview, final_text and error. Read-only.',
    inputSchema: { type: 'object', properties: { session_id: str('Only runs sent to this session'), limit: int('Max runs returned', 10) } },
    run: (a) => core.api.list_runs(a),
  },
]

// A client keeps the tool list a conversation started with (Codex does), so a tool added by
// an update installed without a restart is missing there. dsh_call reaches it by name, along
// the same path as a direct call.
const firstSentence = (text) => text.split(/(?<=\.)\s/)[0]
const catalog = () => TOOLS.filter((t) => t.name !== 'dsh_call').map((t) => ({
  name: t.name,
  description: firstSentence(typeof t.description === 'function' ? t.description() : t.description),
  inputSchema: t.inputSchema,
}))
TOOLS.push({
  name: 'dsh_call',
  annotations: annotations('Call dsh-baton tool by name', hints(false, true, false)),
  description: 'Call a dsh-baton tool by name, for a tool this conversation does not list (dsh-baton was updated without a restart; the update note names it). Runs the same code as a direct call, so it can do whatever that tool does. An unknown name changes nothing and returns the tools with their input schemas.',
  inputSchema: {
    type: 'object', required: ['name'], properties: {
      name: str('Tool name, e.g. dsh_send or a tool added by an update'),
      arguments: { type: 'object', description: 'Arguments for that tool, as its input schema describes them (see the list returned for an unknown name)', default: {} },
    },
  },
  run: (a, ctx) => {
    const tool = TOOLS.find((t) => t.name === a.name && t.name !== 'dsh_call')
    if (!tool) throw new Error(`No dsh-baton tool named ${JSON.stringify(a.name ?? null)}. Available tools (call them with dsh_call {name, arguments} if this conversation does not show them):\n${JSON.stringify(catalog(), null, 2)}`)
    return tool.run(a.arguments && typeof a.arguments === 'object' ? a.arguments : {}, ctx)
  },
})

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
        instructions: `Hands tasks to a local DeepSeek Harness and passes the results back. To hand over a task, call dsh_send {message, checks} directly (no need to list anything first; the new session starts in the folder this conversation works in, or pass cwd for another folder): message is the full, explicit spec (ask for tests that cover each requirement), checks are the project's own test commands such as npm test; do not write check scripts yourself. To continue a session, dsh_send {session_id, message}. Then wait for the reply: ${isCodex() ? 'call dsh_wait with the run_id until it returns the final state (not dsh_status)' : 'run the wait_command it returns as a background shell command if your client wakes you when one exits, otherwise call dsh_wait'}. A run that stops to ask the user something ends the wait with needs_input and the questions; answer with dsh_answer. ${core.ASKED} ${ARCHIVED} If a note says dsh-baton was updated and names a tool you do not have, call it through dsh_call {name, arguments}.`,
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.filter((t) => !t.hidden).map(({ run, hidden, ...t }) => ({ ...t, description: typeof t.description === 'function' ? t.description() : t.description })) }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name)
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${req.params?.name}`), { code: -32602 })
      try {
        // MCP progress: only when the client sent a progressToken with this call.
        const token = req.params?._meta?.progressToken
        const progress = token === undefined ? undefined : (done, message) =>
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: done, message } })
        const result = await tool.run(req.params.arguments || {}, { progress, meta: req.params?._meta })
        // Compact JSON: indentation is paid for again on every later request of the conversation.
        const content = [{ type: 'text', text: JSON.stringify(result) }]
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
