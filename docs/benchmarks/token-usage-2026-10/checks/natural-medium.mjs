// Acceptance check for natural/medium.md. The request names the entry file, the commands
// (add/list/done/rm) and TASKS_FILE, nothing else, so this checks behaviour, not exact output.
// Usage: node checks/natural-medium.mjs <workspace>
import path from 'node:path'
import fs from 'node:fs'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { run, expect, done, tmp } = checker(dir)
const file = path.join(tmp, 'tasks.json')
const t = (...args) => run('node', ['tasks.mjs', ...args], { TASKS_FILE: file, TASKS_TODAY: '2026-10-25' })
const idIn = (out, text) => Number((out.split('\n').find((l) => l.includes(text)) ?? '').match(/\d+/)?.[0])

expect('tasks.mjs exists', fs.existsSync(path.join(dir, 'tasks.mjs')))
const sources = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.m?js$/.test(f) && !/node_modules|test/.test(f))
expect('split into modules (≥ 3 source files)', sources.length >= 3, `found ${sources.length}`)
const npm = run('npm', ['test'])
expect('npm test passes', npm.code === 0, npm.out.split('\n').slice(-6).join(' | '))

expect('add works', t('add', '买牛奶').code === 0)
const add2 = t('add', '交房租')
expect('second add works', add2.code === 0, JSON.stringify(add2))
expect('data saved to TASKS_FILE', fs.existsSync(file))
let list = t('list')
expect('list shows both tasks', list.out.includes('买牛奶') && list.out.includes('交房租'), list.out)
const milk = idIn(list.out, '买牛奶'), rent = idIn(list.out, '交房租')
expect('list shows ids', Number.isInteger(milk) && Number.isInteger(rent) && milk !== rent, list.out)
const d = t('done', String(milk))
expect('done works', d.code === 0, JSON.stringify(d))
list = t('list')
expect('default list hides done tasks', !list.out.includes('买牛奶') && list.out.includes('交房租'), list.out)
const help = [t('--help'), t('help'), t()].map((r) => `${r.out}\n${r.err}`).join('\n').toLowerCase()
expect('usage mentions priority, due date and tags', /priority|优先级/.test(help) && /due|截止/.test(help) && /tag|标签/.test(help), help.slice(0, 300))
const stats = t('stats')
expect('stats prints numbers', stats.code === 0 && /\d/.test(stats.out), JSON.stringify(stats))
const csv = [t('export', '--format', 'csv'), t('export', 'csv'), t('export')].find((r) => r.code === 0 && r.out.includes(','))
expect('CSV export', !!csv && csv.out.includes('交房租'), csv ? csv.out.slice(0, 200) : 'no export command worked')
const rm = t('rm', String(rent))
expect('rm works', rm.code === 0, JSON.stringify(rm))
list = t('list', ...[])
expect('removed task is gone', !list.out.includes('交房租'), list.out)
const bad = t('done', '99999')
expect('unknown id is an error', bad.code !== 0, JSON.stringify(bad))
done()
