#!/usr/bin/env node
// Command-line entry. `wait` is meant for an orchestrator that runs it as a
// background shell command and is woken up when the command exits.
import path from 'node:path'
import * as core from './core.mjs'
import { setup } from './setup.mjs'

const USAGE = `Usage: dsh-baton <command> [args]

  setup [--remove]                                        register the MCP server for Claude Code and Codex (user-wide)
  workspaces                                              list Harness sidebar workspaces (host plugin)
  new-workspace <dir> [--title <t>]                       register (and create) a folder as a workspace
  sessions [--cwd <dir>] [--query <text>] [--limit <n>]   list saved sessions
  read <session_id> [--last <n>]                          show recent messages
  send [--session <id> | --cwd <dir> | --workspace <id>] [--mode followup|steer] <message...>  start a run (message may be "-" for stdin)
  status <run_id>                                         show a run's progress
  wait <run_id> [--timeout <seconds>]                     block until the run ends (or asks a person), print it
  rename <session_id> <title>                             rename a session
  rename-workspace <workspace_id|dir> <title>             rename a workspace (sidebar title)
  activity <session_id>                                   what the session is doing now (turn, sub-agents, jobs)
  cancel <run_id> | --session <id>                        stop the session's turn, sub-agents and jobs
  queued <run_id> edit <message...> | remove | steer      change a message still waiting in Harness's queue
  answer <run_id> '<answers JSON>'                         answer the questions a run is waiting on
  runs [--session <id>] [--limit <n>]                     list recent runs`

function parse(argv) {
  const flags = {}, rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
    else rest.push(argv[i])
  }
  return { flags, rest }
}

const print = (v) => console.log(JSON.stringify(v, null, 2))

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString()
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)
  const { flags, rest } = parse(argv)
  switch (cmd) {
    case 'setup':
      return console.log(await setup({ remove: argv.includes('--remove') }))
    case '_run':
      return core.executeRun(rest[0])
    case 'workspaces':
      return print(await core.api.workspaces())
    case 'new-workspace':
      return print(await core.api.create_workspace({ path: rest[0], title: flags.title }))
    case 'sessions':
      return print(await core.api.list_sessions({ cwd: flags.cwd, query: flags.query, limit: Number(flags.limit) || 20 }))
    case 'read':
      return print(await core.api.read_session({ session_id: rest[0], last: Number(flags.last) || 10 }))
    case 'send': {
      const message = rest.join(' ') === '-' ? await readStdin() : rest.join(' ')
      return print(await core.api.send({ message, sender: core.senderOf(), session_id: flags.session, cwd: flags.cwd, workspace_id: flags.workspace, ...(flags.mode ? { mode: flags.mode } : {}) }))
    }
    case 'status':
      return print(await core.api.status({ run_id: rest[0] }))
    case 'wait': {
      const st = await core.api.wait({ run_id: rest[0], timeout_s: Number(flags.timeout) || 24 * 3600 })
      print({
        ...(st.decided_for_user ? { hint: 'Required in your reply: you chose an answer for the user during this run, so start your reply by telling the user, in their language, what you chose and why (decided_for_user: answers and reason), then give the result. Passing on only final_text is not enough. ' + core.ENDED_HINT, decided_for_user: st.decided_for_user } : {}),
        run_id: st.run_id, state: st.state, session_id: st.session_id, timed_out: !!st.timed_out, error: st.error, final_text: st.final_text,
        ...(st.state === 'completed' && !st.decided_for_user ? { hint: core.ENDED_HINT } : {}),
        ...(core.failedHint(st) ? { hint: core.failedHint(st) } : {}),
        ...(st.needs_input ? { needs_input: st.needs_input, question: st.question, ...(st.question ? { relay: core.relayText(st.question) } : {}), hint: st.question ? 'The run asks the user something. If the user allowed you to decide, choose by your own judgment and answer with dsh_answer (or dsh-baton answer), passing reason, and tell the user what you chose and why. Otherwise show the user relay, written in the user\'s language, with its first line filled in with your own pick and a reason from your own judgment of the question and the task (harness_suggested is only the asker\'s pick, never a reason by itself), and ask the user first. Then wait again.' : 'The run waits for a person in the Harness UI. Tell the user, then wait again.' } : {}) })
      process.exitCode = st.state === 'completed' ? 0 : st.needs_input ? 3 : 1
      return
    }
    case 'cancel':
      return print(await core.api.cancel(rest[0]?.startsWith('session') || flags.session ? { session_id: flags.session ?? rest[0] } : { run_id: rest[0] }))
    case 'queued':
      return print(await core.api.update_queued({ run_id: rest[0], action: rest[1], ...(rest[1] === 'edit' ? { message: rest.slice(2).join(' ') } : {}) }))
    case 'answer':
      return print(await core.api.answer({ run_id: rest[0], answers: JSON.parse(rest.slice(1).join(' ')) }))
    case 'rename':
      return print(await core.api.rename_session({ session_id: rest[0], title: rest.slice(1).join(' ') }))
    case 'rename-workspace':
      // A path (also C:\… on Windows) or a workspace id.
      return print(await core.api.rename_workspace(rest[0]?.startsWith('/') || rest[0]?.startsWith('~') || path.isAbsolute(rest[0] ?? '') ? { path: rest[0], title: rest.slice(1).join(' ') } : { workspace_id: rest[0], title: rest.slice(1).join(' ') }))
    case 'activity':
      return print(await core.api.activity({ session_id: rest[0] }))
    case 'runs':
      return print(await core.api.list_runs({ limit: Number(flags.limit) || 10, session_id: flags.session }))
    default:
      console.error(USAGE)
      process.exitCode = cmd ? 2 : 0
  }
}

main().catch((e) => { console.error(`dsh-baton: ${e.message}`); process.exitCode = 1 })
