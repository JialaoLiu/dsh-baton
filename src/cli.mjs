#!/usr/bin/env node
// Command-line entry. `wait` is meant for an orchestrator that runs it as a
// background shell command and is woken up when the command exits.
import path from 'node:path'
import * as core from './core.mjs'
import { setup, stableNodePath } from './setup.mjs'
import { runHook, parseHookInput } from './codex-hook.mjs'

const USAGE = `Usage: dsh-baton <command> [args]

  setup [--remove]                                        register the MCP server for Claude Code and Codex (user-wide)
  codex-stop-hook                                         the Codex Stop hook of plugins 0.6.0–0.6.3, for conversations opened before 0.6.4
  workspaces                                              list Harness sidebar workspaces (host plugin)
  new-workspace <dir> [--title <t>]                       register (and create) a folder as a workspace
  sessions [--cwd <dir>] [--query <text>] [--limit <n>]   list saved sessions
  read <session_id> [--last <n>]                          show recent messages
  send [--session <id> | --cwd <dir> | --workspace <id>] [--mode followup|steer] <message...>  start a run (message may be "-" for stdin)
  status <run_id> | <session_id>                          show a run's progress, or a session's (with its goal)
  wait <run_id> [--timeout <seconds>] [--until goal|turn] [--every 10m] [--cursor <c>]
                                                          block until the run ends (or asks a person), print it; in a
                                                          session with a Harness goal, until the goal stops
  follow <session_id> [--until goal|turn] [--every 10m] [--cursor <c>] [--timeout <seconds>]
                                                          follow a session's Harness goal without sending; print the next report
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

// This command line again, for a background command the client runs next (in Node mode when it
// runs on Harness's own binary).
const self = (args) => `${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}"${stableNodePath()}" "${process.argv[1]}" ${args}`

const print = (v) => console.log(JSON.stringify(v, null, 2))
// --every 10m | 600s | 10 (minutes), default 10 minutes.
function everySeconds(v) {
  const every = String(v ?? '10m').match(/^(\d+)\s*(m|min|s)?$/i)
  return every ? Number(every[1]) * (/^s$/i.test(every[2] ?? '') ? 1 : 60) : 600
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const buf = Buffer.concat(chunks)
  // UTF-16 with its BOM (FF FE), as some Windows pipes write it; otherwise UTF-8.
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString()
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)
  const { flags, rest } = parse(argv)
  switch (cmd) {
    case 'setup':
      return console.log(await setup({ remove: argv.includes('--remove') }))
    case 'codex-stop-hook': {
      // Never fail the user's turn: on any error the hook prints nothing and the turn ends.
      const input = parseHookInput(await readStdin().catch(() => ''))
      if (!input) return
      const out = await runHook(input, { shape: core.waitResult }).catch(() => null)
      if (out) console.log(JSON.stringify(out))
      return
    }
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
      return print(await core.api.status(rest[0]?.startsWith('session') || flags.session ? { session_id: flags.session ?? rest[0] } : { run_id: rest[0] }))
    case 'wait': {
      const total_s = Number(flags.timeout) || 24 * 3600
      const waitStarted = Date.now()
      const st = await core.api.wait({ run_id: rest[0], timeout_s: total_s })
      const stop = core.stopHint(st)
      // A Harness goal goes on after the run's own round: so does this wait, until the goal
      // stops (or the next report, with --until turn), with every round since the run began.
      if (core.goalGoesOn(st)) {
        const every_s = everySeconds(flags.every)
        // --timeout bounds the whole command, the run and the goal after it.
        const left = Math.max(1, total_s - Math.round((Date.now() - waitStarted) / 1000))
        const f = core.throughGoal(st, core.followResult(await core.followThrough({ session_id: st.session_id, until: flags.until ?? 'goal', ...(flags.cursor ? { cursor: flags.cursor } : { since_ms: Date.parse(st.started_at) || Date.now() }), every_s }, { total_s: left })))
        const again = f.cursor && ['report', 'following', 'needs_input'].includes(f.state)
          ? self(`wait ${rest[0]} --until ${f.until} --cursor ${f.cursor}${f.until === 'turn' ? ` --every ${every_s}s` : ''}`)
          : undefined
        print({ ...f, ...(again ? { follow_command: again, hint: `${f.hint} To go on following, run follow_command in the background (not dsh_wait).` } : {}) })
        process.exitCode = f.state === 'needs_input' ? 3 : 0
        return
      }
      if (st.needs_input && st.question) {
        const { run_id, state, session_id, needs_input, question } = st
        print(core.asking({ run_id, state, session_id, needs_input, question }, core.askHint(question.count ?? question.questions?.length ?? 1, 'dsh_answer (or dsh-baton answer)', 'wait again')))
        process.exitCode = 3
        return
      }
      print({
        ...(st.decided_for_user ? { hint: `${core.DECIDED_HINT} ${core.endedHint(st)}`, decided_for_user: st.decided_for_user } : {}),
        run_id: st.run_id, state: st.state, session_id: st.session_id, timed_out: !!st.timed_out, error: st.error, final_text: st.final_text,
        // A goal goes on after this run: the hint says so and how to follow it.
        ...(st.goal ? { goal: st.goal, ...(st.goal.phase === 'active' ? { follow_command: self(`follow ${st.session_id}`) } : {}) } : {}),
        // The hint points at evidence: it goes with it (files changed, checks run, other runs in the folder).
        ...(st.evidence ? { evidence: st.evidence } : {}),
        ...(st.state === 'completed' && !st.decided_for_user ? { hint: core.endedHint(st) } : {}),
        // Stopped by the user, cancelled, or cut off by a Harness restart: say so, or the client
        // takes it for a failure in the work and sends it again.
        ...(st.harness_down ? { harness_down: true, hint: core.harnessDownHint('run this same wait command again') } : {}),
        ...(stop ? { ...(st.turn_end ? { turn_end: st.turn_end } : {}), ...stop } : {}),
        ...(st.needs_input ? { needs_input: st.needs_input, hint: 'The run waits for a person in the Harness UI. Tell the user, then wait again.' } : {}) })
      process.exitCode = st.state === 'completed' ? 0 : st.needs_input ? 3 : 1
      return
    }
    case 'follow': {
      // Until the next report: waits in one call (no hour limit here), so a background
      // command wakes its client exactly then. --timeout makes it come back sooner.
      const every_s = everySeconds(flags.every)
      const st = core.followResult(await core.followThrough({ session_id: rest[0], until: flags.until ?? 'goal', cursor: flags.cursor, every_s }, { total_s: Number(flags.timeout) || 24 * 3600 }))
      const again = st.cursor && ['report', 'following', 'needs_input'].includes(st.state)
        ? self(`follow ${rest[0]} --until ${st.until} --cursor ${st.cursor}${st.until === 'turn' ? ` --every ${every_s}s` : ''}`)
        : undefined
      print({ ...st, ...(again ? { follow_command: again, hint: `${st.hint} To go on following, run follow_command in the background (not dsh_wait).` } : {}) })
      process.exitCode = st.state === 'needs_input' ? 3 : 0
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
