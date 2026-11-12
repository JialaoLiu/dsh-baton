// The MCP server itself (newline-delimited JSON-RPC 2.0 over stdio, no dependencies). It
// runs as a child of server.mjs, which starts a fresh one when a newer version is installed.
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'
import { stableNodePath } from './setup.mjs'
import { codexConfigPath, readCodexToolTimeout, codexTimeoutNoteFile, codexWaitSeconds, codexConfigReadAt, codexProcessStartedAtAsync } from './register.mjs'
import { conversationFolder, within } from './folder.mjs'
import { threadOf, delivered } from './codex-hook.mjs'

const SERVER = { name: 'dsh-baton', version: core.VERSION }
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const str = (description) => ({ type: 'string', description })
const int = (description, d) => ({ type: 'integer', description, default: d })

// How long one dsh_wait call waits, chosen by the server so it always ends before the
// client gives up on the tool call: Codex stops a call after its tool_timeout_sec for
// dsh-baton (an hour as dsh-baton registers it; 300 s when unset), so it gets that less
// 60 s, or 270 s; other clients get 50 s (Claude Code waits with wait_command instead).
// DSH_BATON_WAIT_S overrides it. A timeout_s from the model is ignored, so a model cannot
// pick a short wait and poll.
const MAX_WAIT_S = 24 * 3600
const envWait = Math.floor(Number(core.setting('WAIT_S')))
const isCodex = () => core.senderOf(clientName) === 'codex'
let codexTimeout = { mtime: null, value: null }
function codexToolTimeout() {
  try {
    const file = codexConfigPath()
    const mtime = fs.statSync(file).mtimeMs
    if (mtime !== codexTimeout.mtime) {
      const value = readCodexToolTimeout(fs.readFileSync(file, 'utf8'))
      // Since when the value has been there: the note, when it is for this value; else the
      // file's last change, which is never earlier.
      let since = mtime, prev = null
      try {
        const note = JSON.parse(fs.readFileSync(codexTimeoutNoteFile(), 'utf8'))
        if (note.value === value && Number(note.since) > 0) { since = Math.min(Number(note.since), mtime); prev = Number(note.prev) || null }
      } catch { /* no note */ }
      codexTimeout = { mtime, value, since, prev }
    }
    return codexTimeout
  } catch {
    return { value: null }
  }
}
// When the Codex process that runs this conversation started, looked up once from the client
// pid server.mjs passes. A shell from before 0.6.5 passes none, and then the thread id alone
// decides. It starts at initialize and a wait awaits it (on Windows it takes a second or more).
let codexStarted = null, codexLookup = null
const lookUpCodexStart = () => {
  const pid = Number(process.env.DSH_BATON_CLIENT_PID)
  codexLookup ??= pid > 1 ? codexProcessStartedAtAsync(pid).then((t) => { codexStarted = t }, () => {}) : Promise.resolve()
  return codexLookup
}
const codexStartedAt = () => codexStarted
// meta is the call's: Codex keeps the tool_timeout_sec a conversation read when it started or
// was loaded, so one open since before the value was written keeps 270 s (see
// noteCodexToolTimeout). Without meta (a tool description), the length a new conversation gets.
const waitSeconds = (meta) => {
  if (envWait >= 1) return Math.min(envWait, MAX_WAIT_S)
  if (!isCodex()) return 50
  return codexWaitSeconds(codexToolTimeout(), meta === undefined ? undefined : codexConfigReadAt(threadOf(meta), codexStartedAt()))
}
const WAIT_CHUNK_S = 10
// The Codex app runs tools from a script cell that yields every 30 s and wakes the model
// to resume it; a yield longer than one dsh_wait keeps the whole wait in one turn. When the
// user wants Codex to work meanwhile, yield_control() hands it back while the wait goes on.
const codeModeYield = () => {
  const ms = (waitSeconds() + 20) * 1000
  return `Required when you call tools from a script cell ("Script running with cell ID …"): the script that calls dsh_wait must start with the line // @exec: {"yield_time_ms": ${ms}}, never a shorter value; if the cell still yields, resume it with wait and yield_time_ms ${ms} (or the largest value wait accepts), never a short value such as 30000 or 55000. Only when the user asked you to work while the run goes on: in that cell call yield_control() right after starting dsh_wait, do the work, then resume the cell with wait as above to get the result (outside a script cell, do the work once dsh_wait returns).`
}
// Not "no calls at all": a model told only that kept waiting on the old request after the
// user added to it, and sent the change once the old run had finished. Nor "no reading":
// that overrode a user who asked Codex to analyse the project while Harness worked.
const NO_POLL = 'While waiting, do not check how the run is going: no dsh_status, dsh_session_activity or dsh_read_session, and no looking for its output or logs. Work the user asked you to do meanwhile is different and allowed: reading, reviewing or analysing the project, the target folder included, while dsh_wait runs, without editing files the run may change. If the user adds to or changes the request while you wait, send it at once with dsh_send mode steer and the same session_id (it joins the running turn), then dsh_wait the new run_id instead of the old one: both end together with one result.'
const INSTRUCTIONS = 'Hands tasks to a local DeepSeek Harness and brings the results back: start with dsh_send.'
const ARCHIVED = 'Sessions not in dsh_list_sessions are archived or gone: do not look for them on disk.'
// A shell command that blocks until a run ends and prints its reply. Run in the
// background by a client that wakes the model when the command exits (Claude Code),
// it waits without spending any turns. Plain "<node>" "<cli>" wait <id> form: it runs
// in POSIX shells and in Git Bash, which Claude Code uses on Windows too. Registered on
// Harness's own binary (no Node.js installed), the command keeps it in Node mode.
const quote = (p) => `"${p}"`
const nodeMode = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
const cliCommand = (args) => `${nodeMode}${quote(stableNodePath())} ${quote(path.join(core.ROOT, 'src', 'cli.mjs'))} ${args}`
const waitCommand = (runId) => (/^[\w.-]+$/.test(runId ?? '') ? cliCommand(`wait ${runId}`) : undefined)
// The same for following a session's goal: it ends at the next report.
// The same wait again from a cursor, for a run whose wait follows its goal (its checks run again at the end).
const waitOnCommand = (runId, until = 'goal', cursor, everyMin) => (/^[\w.-]+$/.test(runId ?? '')
  ? cliCommand(`wait ${runId} --until ${until}${/^\d+:\d+$/.test(cursor ?? '') ? ` --cursor ${cursor}` : ''}${everyMin ? ` --every ${everyMin}m` : ''}`)
  : undefined)
const followCommand = (sid, until = 'goal', cursor, everyMin) => (/^[\w.-]+$/.test(sid ?? '')
  ? cliCommand(`follow ${sid} --until ${until}${/^\d+:\d+$/.test(cursor ?? '') ? ` --cursor ${cursor}` : ''}${everyMin ? ` --every ${everyMin}m` : ''}`)
  : undefined)
// A run in a session with a Harness goal is waited for until the goal stops.
const GOAL_WAIT_HINT = (how) => `In a session with a Harness goal (a message starting with /goal sets one) the wait goes on until the goal stops; add ${how} only when the user asked for progress reports.`
const FOLLOW_COMMAND_HINT = ' Your client wakes you when a background command exits, so run follow_command that way instead of calling dsh_wait with session_id: it ends at the next report, with no polling.'
// Several runs in parallel: one dsh_wait for all of them, so whichever ends first is dealt with
// first. Waiting on one run at a time left a run that ended meanwhile unseen until the other
// wait returned (measured 2026-11-08: a result read 3 minutes late, its rework sent late).
const PARALLEL_HINT = 'If you are sending several parts in parallel, send them all first, then wait for them together: one dsh_wait with run_ids set to all their run_ids, never one run after another.'

// Wait in short chunks, reporting progress between them (clients that support it can
// show it or reset their timer). An unfinished wait returns only the state, not the run's
// recent events, so the client has nothing to summarise and simply waits again.
// A call the client cancelled (the user stopped the turn) stops at the next chunk.
async function waitInChunks({ run_id }, progress, signal, meta) {
  // An answer a multi-run wait got after it had returned (a question is reported only once).
  if (late.has(run_id)) return core.waitResult(takeLate(run_id))
  if (isCodex()) await lookUpCodexStart()
  const total = waitSeconds(meta ?? null)
  const started = Date.now()
  const deadline = started + total * 1000
  for (;;) {
    if (signal?.aborted) return { run_id, cancelled: true }
    const left = Math.ceil((deadline - Date.now()) / 1000)
    const t0 = Date.now()
    const st = await core.api.wait({ run_id, timeout_s: Math.max(1, Math.min(WAIT_CHUNK_S, left)) })
    if (st.needs_input || !st.timed_out) return core.waitResult(st)
    // Never spin: a chunk that came back early still takes a moment before the next one.
    if (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 500))
    if (Date.now() >= deadline) {
      if (st.harness_down) return { run_id, state: st.state, timed_out: true, harness_down: true, hint: core.HARNESS_DOWN_HINT }
      return {
        run_id, state: st.state, timed_out: true,
        ...(st.waiting_on ? { waiting_on: st.waiting_on } : {}),
        hint: st.state === 'waiting'
          ? 'The run is still waiting for a person (see dsh_status for its question). Answer it with dsh_answer if you may, or tell the user; then call dsh_wait again.'
          : `Still ${st.state}. Call dsh_wait again with the same run_id, with no progress check or progress note in between (work the user asked you to do meanwhile is fine).`,
      }
    }
    progress?.(Math.round((Date.now() - started) / 1000), `run ${run_id} is ${st.state}`)
  }
}

// Several runs (dsh_wait run_ids): returns as soon as any of them ends or stops to ask a person,
// with every one that has by then and the ones still running. Each round asks about all of them
// together for a short chunk, so an ending is seen within MULTI_CHUNK_S. Every answer is kept:
// a wait that sees a question marks it as seen, so dropping one would lose the question.
const MULTI_CHUNK_S = 5
// Runs that end within this of the first come back with it.
const TOGETHER_MS = 200
const isDone = (st) => !!st.needs_input || !st.timed_out
// A chunk's wait for another run can answer after the multi-run wait has returned. The host
// reports a question only once, so such an answer is kept here and given to the next wait.
const late = new Map()
const takeLate = (run_id) => { const st = late.get(run_id); late.delete(run_id); return st }
async function waitAnyInChunks(run_ids, progress, signal, meta) {
  if (isCodex()) await lookUpCodexStart()
  const total = waitSeconds(meta ?? null)
  const started = Date.now()
  const deadline = started + total * 1000
  for (;;) {
    if (signal?.aborted) return { run_ids, cancelled: true }
    const left = Math.ceil((deadline - Date.now()) / 1000)
    const t0 = Date.now()
    const timeout_s = Math.max(1, Math.min(MULTI_CHUNK_S, left))
    const answers = new Map()
    const asks = run_ids.map((run_id) => (late.has(run_id)
      ? Promise.resolve(takeLate(run_id))
      : core.api.wait({ run_id, timeout_s }).then((st) => ({ run_id, ...st }), (error) => ({ run_id, state: 'unknown', error: error?.message ?? String(error) })))
      .then((st) => { answers.set(run_id, st); return st }))
    // On until one is done or every one has answered, then a moment for any ending with it.
    await new Promise((resolve) => {
      let n = 0
      for (const ask of asks) ask.then((st) => { n += 1; if (isDone(st) || n === asks.length) resolve() })
    })
    if (answers.size < asks.length) await new Promise((r) => setTimeout(r, TOGETHER_MS))
    const done = [...answers.values()].filter(isDone)
    if (done.length) {
      run_ids.forEach((run_id, i) => {
        if (!answers.has(run_id)) asks[i].then((st) => { if (isDone(st)) late.set(run_id, st) })
      })
      const running = run_ids.filter((run_id) => !done.some((st) => st.run_id === run_id)).map((run_id) => {
        const st = answers.get(run_id) ?? { run_id, state: 'running' }
        return { run_id, state: st.state, ...(st.session_id ? { session_id: st.session_id } : {}) }
      })
      return { done, running }
    }
    const running = [...answers.values()].map((st) => ({ run_id: st.run_id, state: st.state, ...(st.session_id ? { session_id: st.session_id } : {}) }))
    if (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 500))
    if (Date.now() >= deadline) {
      const asking = running.filter((r) => r.state === 'waiting').map((r) => r.run_id)
      if ([...answers.values()].some((st) => st.harness_down)) return { run_ids, timed_out: true, harness_down: true, still_running: running, hint: core.harnessDownHint('call dsh_wait again with the same run_ids') }
      return {
        run_ids, timed_out: true, still_running: running,
        hint: `None of these runs has ended yet. Call dsh_wait again with the same run_ids, with no progress check or progress note in between (work the user asked you to do meanwhile is fine).${asking.length ? ` ${asking.join(', ')} still wait${asking.length === 1 ? 's' : ''} for a person (see dsh_status for the question): answer with dsh_answer if you may, or tell the user.` : ''}`,
      }
    }
    progress?.(Math.round((Date.now() - started) / 1000), `${running.length} runs still going`)
  }
}
// The result of a multi-run wait: each ended run as dsh_wait returns it for one run, then what next.
function anyResult({ done, running }) {
  const ended = done.map((st) => {
    const res = st.state === 'unknown' ? { ...st, hint: 'This run_id is not known here (only the latest 100 runs are kept); leave it out of the next dsh_wait.' } : core.waitResult(st)
    if (res.state !== 'unknown') delivered(st.run_id, res)
    return core.goalGoesOn(res)
      ? { ...res, hint: `${res.hint} Its Harness goal goes on after this round: once the other runs are dealt with, follow it on its own with dsh_wait session_id ${res.session_id}.` }
      : res
  })
  const ids = running.map((r) => r.run_id)
  // Stopped by the user, cancelled or cut off by a Harness restart: not work to send back.
  const stopped = ended.filter((r) => r.stopped_by_user || r.state === 'interrupted' || r.state === 'cancelled').map((r) => r.run_id)
  const leave = stopped.length ? ` ${stopped.join(', ')} did not end by ${stopped.length === 1 ? 'its' : 'their'} own work (stopped by the user, cancelled or cut off by a Harness restart, see ${stopped.length === 1 ? 'its' : 'each'} hint): send ${stopped.length === 1 ? 'it' : 'them'} nothing more on your own and leave ${stopped.length === 1 ? 'it' : 'them'} out of the next wait.` : ''
  const next = ids.length
    ? `Then call dsh_wait again with run_ids: the ones still running (${ids.join(', ')}) plus the run_id of every fix you sent, so whichever ends next comes back first. Do not wait for one run on its own while others are going.`
    : 'None of these runs is still going.'
  return {
    ended, still_running: running,
    hint: `${ended.length} of the runs ${ended.length === 1 ? 'has' : 'have'} ended or stopped to ask (ended; each has its own hint). Deal with ${ended.length === 1 ? 'it' : 'them'} now: review against what you asked, and send any fixes with dsh_send to the same session_id right away, or answer a question.${leave} ${next}`,
  }
}

// Following a session's goal (dsh_wait with session_id). Codex sees a message the user types
// only once the tool call returns, so one call waits at most 15 minutes; it then returns
// timed_out with the same cursor and Codex simply calls again.
const FOLLOW_MAX_S = 900
const FOLLOW_CHUNK_S = 30
async function followInChunks({ session_id, until = 'goal', cursor, every_minutes = 10, since_ms, max_s = FOLLOW_MAX_S }, progress, signal, meta) {
  if (isCodex()) await lookUpCodexStart()
  const total = Math.min(waitSeconds(meta ?? null), FOLLOW_MAX_S, max_s)
  const started = Date.now()
  const deadline = started + total * 1000
  const every_s = Math.max(1, Number(every_minutes) || 10) * 60
  const st = await core.followThrough({ session_id, until, cursor, since_ms, every_s }, {
    total_s: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)), chunk_s: FOLLOW_CHUNK_S, signal,
    onChunk: () => progress?.(Math.round((Date.now() - started) / 1000), `following ${session_id}`),
  })
  return st.cancelled ? st : core.followResult(st)
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
    description: `List Harness sessions, newest first, to find a session_id: session_id, title, cwd, updated_at, running, bridge_runs and model (what its next request uses). No paging: raise limit or narrow it with cwd or query. Read-only. ${ARCHIVED}`,
    inputSchema: { type: 'object', properties: { cwd: str('Only sessions of this workspace folder'), query: str('Case-insensitive text to match in title, folder or session id'), limit: int('Max sessions returned', 20), include_subagents: { type: 'boolean', description: 'Also list sub-agent sessions', default: false } } },
    run: (a) => core.api.list_sessions(a),
  },
  {
    name: 'dsh_list_models',
    annotations: annotations('List models'),
    description: 'List the models this DeepSeek Harness can run (provider, model id, name, reasoning efforts) and its default model, to check a name before passing model to dsh_send. Read-only. Needs the dsh-baton-host plugin.',
    inputSchema: { type: 'object', properties: {} },
    run: () => core.api.models(),
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
    description: 'Hand a task to DeepSeek Harness, or continue a session: returns at once with a run_id and a hint saying how to wait for the reply; follow it. Call it directly, no need to list anything first. A new session starts in the folder this conversation works in, or in cwd or workspace_id (a new cwd is registered first); session_id continues that session. message arrives verbatim as a user message, and Harness does not see this conversation: make it self-contained, in the user\'s language, the full, explicit spec, asking for tests that cover each requirement. Keep a leading /goal (it sets a Harness goal) and the user\'s goal text as written. For a large task, write a concrete spec (goal, modules and the files each owns, level of detail, acceptance criteria) rather than passing the user\'s words on, and send independent parts to separate sessions in parallel, each owning its own files; wait for them together (dsh_wait run_ids), review each as it returns and send its fixes at once. With checks, a short request for a sub-agent review table is appended. To a busy session, mode followup queues the message and steer adds it to the running turn; left out, the Harness setting decides.',
    inputSchema: { type: 'object', required: ['message'], properties: { message: str('The task or reply to send'), session_id: str('Existing session to continue'), cwd: str('Workspace folder for a new session; leave out to use the folder this conversation works in'), workspace_id: str('Harness workspace for a new session (from dsh_list_workspaces)'), mode: { type: 'string', enum: ['followup', 'steer'], description: "followup queues after the current turn; steer injects into a running turn. Omit to follow Harness's busy-send setting" }, model: str('Only when the user names a model for this run (e.g. "DeepSeek-V4 Pro"); otherwise the session keeps its own, or Harness\'s default for a new one. Matched ignoring case, spaces, hyphens and a leading DeepSeek; no match or several fails the send with the list (provider/model picks one). Sets this session only'), team: { type: 'boolean', description: 'Only when the user asks for Agent Teams: true turns them on for this session, false off' }, reasoning_effort: str('Only when the user names a reasoning effort, e.g. high; one of the efforts dsh_list_models shows for the model'), checks: { type: 'array', items: { type: 'string' }, description: 'The project\'s own test commands, e.g. npm test, or python -m pytest (a bare pytest is often not on PATH, on Windows especially); never check scripts you write yourself. dsh-baton runs them in the folder when the run ends and returns exit codes and the last output lines as evidence.' } } },
    run: async (a, { meta } = {}) => {
      // A new session goes to this conversation's folder unless the call names another one;
      // a different folder is allowed but said back, so a wrong guess does not go unnoticed.
      const here = a.session_id ? undefined : conversationFolder(meta, isCodex())
      // Codex starts the server in the home folder (register.mjs), so its conversation folder
      // comes from the thread's rollout only; when that is not found, ask rather than guess.
      if (!here && !a.session_id && !a.cwd && !a.workspace_id && isCodex()) {
        throw new Error('Could not tell which folder this Codex conversation works in, so nothing was sent. Call dsh_send again with cwd set to the project folder (or workspace_id from dsh_list_workspaces).')
      }
      const args = here && !a.cwd && !a.workspace_id ? { ...a, cwd: here } : a
      const folder = here && a.cwd && !within(a.cwd, here)
        ? { folder_note: `This conversation works in ${here}; the new session was started in ${a.cwd} as asked. If that was not intended, cancel it and send again without cwd.` }
        : args !== a ? { cwd: here } : {}
      const st = { ...(await core.api.send({ ...args, sender: core.senderOf(core.setting('SENDER') || clientName) })), ...folder }
      // Codex has no wake-on-exit for shell commands: offered wait_command, it runs it in a
      // terminal and polls that, so it gets dsh_wait only.
      if (isCodex()) {
        return { ...st, hint: `Run started. Call dsh_wait with this run_id; it returns when the run ends or stops to ask the user something. ${PARALLEL_HINT} ${GOAL_WAIT_HINT('until turn and every_minutes')} ${NO_POLL} ${codeModeYield()}` }
      }
      return {
        ...st,
        wait_command: waitCommand(st.run_id),
        hint: `Run started. If you can run a shell command in the background and are woken when it exits (Claude Code: Bash with run_in_background), run wait_command that way: it ends when the run ends, or stops to ask the user something, and prints the reply or the questions, with no polling (several runs: one background wait_command each, so whichever ends first wakes you). Otherwise call dsh_wait with this run_id (several runs: one dsh_wait with run_ids). ${GOAL_WAIT_HINT('--until turn --every 10m on wait_command')}`,
      }
    },
  },
  {
    name: 'dsh_status',
    annotations: annotations('Run status'),
    description: 'Look once at a run or a session without waiting. A run (run_id): state, recent events, final reply, waiting_on (sub-agents or jobs still working) and human_interjections. A session (session_id): busy, activity, its Harness goal (phase, rounds, whether Harness goes on with it), needs_input, and its last turn\'s reply. Never a way to wait: use dsh_wait.',
    inputSchema: { type: 'object', properties: { run_id: str('Run id from dsh_send'), session_id: str('Session id, when you have no run_id (for example to look at a session whose goal you follow)'), tail: int('How many recent events of a run', 5) } },
    run: async (a) => clip(await core.api.status({ tail: 5, ...a })),
  },
  {
    name: 'dsh_wait',
    annotations: annotations('Wait for run'),
    description: () => `Wait for a run sent with dsh_send to end and return its state and final reply.${!isCodex() ? ' Prefer the background wait_command from dsh_send if your client wakes you when a background command exits: it costs no turns.' : ''} It also returns at once when the run stops to ask a person: needs_input answer (reply with dsh_answer) or harness-ui (an approval in the Harness window). Each call waits up to ${waitSeconds()} s${isCodex() && waitSeconds() > 270 ? ' (270 s in a conversation that was already open when dsh-baton set Codex\'s tool timeout)' : ''}; if it returns timed_out: true, call dsh_wait again with the same run_id, without a progress note. Parallel runs: all ids in run_ids, never one by one; returns once any ends or asks (ended; the rest in still_running); then wait again with the rest plus your fixes. A run in a session with a Harness goal is followed on until the goal stops, with every round since the run began. With session_id instead of run_id it follows that session's Harness goal (see until) without sending anything; it also returns when Harness needs a person or will not go on by itself. Pass back the cursor each result gives.${isCodex() ? ` ${NO_POLL} ${codeModeYield()}` : ''}`,
    inputSchema: {
      type: 'object', properties: {
        run_id: str('Run id from dsh_send'),
        run_ids: { type: 'array', items: { type: 'string' }, description: 'Several run ids, to wait for whichever ends first' },
        session_id: str('Follow this session\'s Harness goal instead of waiting for a run (no message is sent)'),
        until: { type: 'string', enum: ['goal', 'turn'], description: 'Harness goal: goal (default) reports once when it stops; turn (only if the user asked for progress reports) at a round end once every_minutes passed since the last report, with every round since' },
        cursor: str('The cursor from the previous result (nothing is reported twice or missed)'),
        every_minutes: int('With until turn: least minutes between reports', 10),
      },
    },
    run: async (a, { progress, signal, meta }) => {
      const ids = [...new Set([...(Array.isArray(a.run_ids) ? a.run_ids : []), ...(a.run_id ? [a.run_id] : [])].filter((id) => typeof id === 'string' && id))]
      if (ids.length > 1) {
        const r = await waitAnyInChunks(ids, progress, signal, meta)
        return r.cancelled || r.timed_out ? r : anyResult(r)
      }
      if (ids.length === 1) a = { ...a, run_id: ids[0] }
      if (!a.run_id && a.session_id) {
        const st = await followInChunks(a, progress, signal, meta)
        if (isCodex() || st.cancelled || !['report', 'following', 'needs_input'].includes(st.state)) return st
        return { ...st, follow_command: followCommand(a.session_id, a.until, st.cursor, a.until === 'turn' ? (a.every_minutes ?? 10) : undefined), hint: `${st.hint}${FOLLOW_COMMAND_HINT}` }
      }
      if (!a.run_id) throw new Error('run_id is required (or session_id, to follow a session\'s goal)')
      const callStarted = Date.now()
      const result = await waitInChunks(a, progress, signal, meta)
      // Got here, the result must not come again through the Codex Stop hook (conversations
      // from before 0.6.4 still run it).
      if (!result.timed_out && !result.cancelled) delivered(a.run_id, result)
      // A Harness goal goes on after the run's own round: so does the wait, in the same call
      // while it has time, with every round since the run began.
      const left = waitSeconds(meta ?? null) - Math.round((Date.now() - callStarted) / 1000)
      if (core.goalGoesOn(result) && left >= 5) {
        // Room kept for the checks to run again at the goal's end.
        const forChecks = result.evidence?.checks?.length ? Math.min(180, Math.floor(left / 4)) : 0
        const f = await followInChunks({ session_id: result.session_id, until: a.until, every_minutes: a.every_minutes, ...(a.cursor ? { cursor: a.cursor } : { since_ms: Date.parse(result.started_at) || callStarted }), max_s: left - forChecks }, progress, signal, meta)
        const budget_ms = (waitSeconds(meta ?? null) - Math.round((Date.now() - callStarted) / 1000) - 5) * 1000
        const st = f.cancelled ? f : core.throughGoal(result, f, { budget_ms })
        if (isCodex() || st.cancelled || !['report', 'following', 'needs_input'].includes(st.state)) return st
        return { ...st, follow_command: waitOnCommand(a.run_id, st.until, st.cursor, st.until === 'turn' ? (a.every_minutes ?? 10) : undefined), hint: `${st.hint}${FOLLOW_COMMAND_HINT}` }
      }
      if (result.goal && !isCodex() && result.goal.phase === 'active') return { ...result, follow_command: followCommand(result.session_id), hint: `${result.hint}${FOLLOW_COMMAND_HINT}` }
      return result
    },
  },
  {
    name: 'dsh_answer',
    annotations: annotations('Answer question', hints(false, false, false)),
    description: `Answer the questions a waiting run asked (needs_input in dsh_wait or dsh_status). ${core.ASKED} Per question: choose (option numbers or labels), text (your own answer, complete on its own), or skip. It reaches Harness once every question has an answer (submitted: true; remaining lists the rest); then wait again. If the user already answered in Harness, it says there is no open question.`,
    inputSchema: {
      type: 'object', required: ['answers'], properties: {
        run_id: str('Run id that is waiting (needs_input: answer)'),
        session_id: str('Instead of run_id: the session a follow wait (dsh_wait with session_id) reported the question for'),
        answers: {
          type: 'array', description: 'One entry per question answered now', items: {
            type: 'object', properties: {
              id: str('Question id from question.questions[].id; may be left out when there is one question'),
              choose: { type: 'array', items: { type: ['integer', 'string'] }, description: 'Option numbers (1 = first) or labels; one for a single-choice question' },
              text: str('Your own answer in words'),
              skip: { type: 'boolean', description: 'Skip this question' },
            },
          },
        },
        reason: str('Required when the user let you decide: one sentence on why you chose this, from your own judgment of the question and the task; it is returned for you to tell the user and not sent to Harness'),
      },
    },
    run: async (a) => {
      const st = await core.api.answer(a)
      // The second look at an option chosen for the user: nothing was sent, its hint says what next.
      if (st.check) return st
      if (!a.run_id) return { ...st, hint: `${st.reason ? 'Tell the user what you chose and this reason. ' : ''}Then call dsh_wait again as before (the same run_id or session_id), with the same until and the last cursor.` }
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
      if (isCodex()) lookUpCodexStart()
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        // One sentence: Codex repeats it in front of every tool's description, while a client
        // that lists MCP tools by name only (Claude Code's tool search) still learns what the
        // server is for. The rules live in the tools' own descriptions.
        instructions: INSTRUCTIONS,
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
        const result = await tool.run(req.params.arguments || {}, { progress, meta: req.params?._meta, signal: aborts.get(req.id)?.signal })
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
const aborts = new Map() // request id -> AbortController, while the call runs
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

// A cancelled request gets no reply to the client (MCP): server.mjs drops this one. It is
// sent all the same so that a server.mjs from before 0.6.4, still running after a hot
// update, lets go of the call (it then passes it on, as 0.6.3 did with late replies).
const CANCELLED = (id) => ({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Request cancelled' } })

rl.on('line', async (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    return send({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'Invalid Request' } })
  }
  if (req.id === undefined) {
    if (req.method === 'notifications/cancelled') aborts.get(req.params?.requestId)?.abort()
    return
  }
  inFlight++
  const abort = new AbortController()
  aborts.set(req.id, abort)
  try {
    const result = await handle(req)
    send(abort.signal.aborted ? CANCELLED(req.id) : { jsonrpc: '2.0', id: req.id, result })
  } catch (e) {
    send(abort.signal.aborted ? CANCELLED(req.id) : { jsonrpc: '2.0', id: req.id, error: { code: e.code || -32603, message: e.message } })
  } finally {
    aborts.delete(req.id)
    inFlight--
    exitIfDone()
  }
})
