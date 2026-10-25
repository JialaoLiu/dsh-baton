// Copies the raw evidence of every run (Codex rollout, Claude Code transcript, Harness session
// files, the finished workspace) to an archive folder outside the repo, and writes
// results/evidence.json with each file's SHA256 and, per run, the token lines the tables use.
// The raw files hold account ids and system prompts, so they stay out of the repo.
//   node archive.mjs [/Volumes/LJL4T/dshb-bench-evidence]
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const OUT = process.argv[2] ?? '/Volumes/LJL4T/dshb-bench-evidence'
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const evidence = []

for (const file of fs.readdirSync(path.join(HERE, 'results')).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(HERE, 'results', file), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line)
    const id = path.basename(r.dir)
    const dest = path.join(OUT, id)
    fs.mkdirSync(dest, { recursive: true })
    const files = []
    const keep = (src, name) => {
      src = src?.replace(/^~/, os.homedir())
      if (!src || !fs.existsSync(src)) return
      const to = path.join(dest, name)
      fs.cpSync(src, to, { recursive: true, filter: (s) => !s.includes('node_modules') })
      if (fs.statSync(to).isFile()) files.push({ name, sha256: sha(to), bytes: fs.statSync(to).size })
    }
    keep(r.rollout, 'codex-rollout.jsonl')
    keep(r.transcript, 'claude-transcript.jsonl')
    keep(r.dir, 'workspace')
    const hs = path.join(os.homedir(), '.dsh/sessions', `--${r.dir.slice(1).replace(/\//g, '-')}--`)
    if (fs.existsSync(hs)) {
      for (const s of fs.readdirSync(hs).filter((n) => n.startsWith('session-'))) keep(path.join(hs, s, 'session.v4.jsonl.zstd'), `harness-${s}.jsonl.zstd`)
    }
    // The lines the token numbers come from, small enough to keep in the repo.
    let tokenLines = []
    const rollout = r.rollout?.replace(/^~/, os.homedir())
    if (rollout && fs.existsSync(rollout)) {
      tokenLines = fs.readFileSync(rollout, 'utf8').split('\n').filter((l) => l.includes('"token_count"') && l.includes('"total_token_usage"'))
        .map((l) => { const o = JSON.parse(l); return { timestamp: o.timestamp, total_token_usage: o.payload.info.total_token_usage, last_token_usage: o.payload.info.last_token_usage, primary_used_percent: o.payload.rate_limits?.primary?.used_percent ?? null } })
    }
    evidence.push({ run: id, label: r.label ?? 'baseline', thread: r.thread, archived_to: dest.replace(os.homedir(), '~'), files, codex_token_counts: tokenLines })
  }
}
fs.writeFileSync(path.join(HERE, 'results', 'evidence.json'), JSON.stringify(evidence, null, 1) + '\n')
console.log(`${evidence.length} runs archived to ${OUT}; hashes in results/evidence.json`)
