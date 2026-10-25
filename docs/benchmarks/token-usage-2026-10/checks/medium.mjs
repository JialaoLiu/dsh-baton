// Acceptance check for tasks/medium.md. Usage: node checks/medium.mjs <workspace>
import path from 'node:path'
import fs from 'node:fs'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { run, expect, done, tmp } = checker(dir)
const env = { TASKS_FILE: path.join(tmp, 'tasks.json'), TASKS_TODAY: '2026-10-25' }
const t = (...args) => run('node', ['tasks.mjs', ...args], env)
const same = (name, r, out, code = 0) => expect(name, r.out === out && r.code === code, `got ${JSON.stringify(r)}`)

for (const f of ['package.json', 'tasks.mjs', 'src/storage.mjs', 'src/tasks.mjs', 'src/cli.mjs']) expect(`${f} exists`, fs.existsSync(path.join(dir, f)))
const tests = fs.existsSync(path.join(dir, 'test')) ? fs.readdirSync(path.join(dir, 'test'), { recursive: true }).filter((f) => /\.m?js$/.test(f)) : []
const count = tests.map((f) => (fs.readFileSync(path.join(dir, 'test', f), 'utf8').match(/\btest\(|\bit\(/g) || []).length).reduce((a, b) => a + b, 0)
expect('at least 8 tests', count >= 8, `found ${count}`)
const npm = run('npm', ['test'])
expect('npm test passes', npm.code === 0, npm.out.split('\n').slice(-8).join(' | '))

same('empty list', t('list'), 'no tasks')
same('add a', t('add', 'write', 'report', '--priority', 'low', '--due', '2026-10-20', '--tag', 'work'), 'added 1')
same('add b', t('add', 'pay rent', '--priority', 'high', '--due', '2026-11-01'), 'added 2')
same('add c', t('add', 'call, "Bob"', '--tag', 'home', '--tag', 'phone'), 'added 3')
same('add d', t('add', 'plan trip', '--priority', 'high'), 'added 4')
same('list sorted', t('list'), [
  '2\topen\thigh\t2026-11-01\tpay rent\t-',
  '4\topen\thigh\t-\tplan trip\t-',
  '3\topen\tmedium\t-\tcall, "Bob"\thome,phone',
  '1\topen\tlow\t2026-10-20\twrite report\twork',
].join('\n'))
same('filter tag', t('list', '--tag', 'home'), '3\topen\tmedium\t-\tcall, "Bob"\thome,phone')
same('filter priority', t('list', '--priority', 'low'), '1\topen\tlow\t2026-10-20\twrite report\twork')
let r = t('add', 'x', '--priority', 'urgent')
expect('invalid priority', r.code === 2 && r.err.includes('invalid priority: urgent'), JSON.stringify(r))
r = t('add', 'x', '--due', '2026-13-45')
expect('invalid due', r.code === 2 && r.err.includes('invalid due: 2026-13-45'), JSON.stringify(r))
same('stats', t('stats'), 'open: 4, done: 0, overdue: 1')
same('done 4', t('done', '4'), 'done 4')
same('list done', t('list', '--status', 'done'), '4\tdone\thigh\t-\tplan trip\t-')
r = t('list', '--status', 'all')
expect('list all', r.code === 0 && r.out.split('\n').length === 4, JSON.stringify(r))
same('edit', t('edit', '1', '--text', 'write final report', '--priority', 'high', '--due', 'none'), 'updated 1')
same('list after edit', t('list', '--priority', 'high'), [
  '2\topen\thigh\t2026-11-01\tpay rent\t-',
  '1\topen\thigh\t-\twrite final report\twork',
].join('\n'))
same('stats after', t('stats'), 'open: 3, done: 1, overdue: 0')
same('export csv', t('export', '--format', 'csv'), [
  'id,text,priority,due,tags,status',
  '1,write final report,high,,work,open',
  '2,pay rent,high,2026-11-01,,open',
  '3,"call, ""Bob""",medium,,home;phone,open',
  '4,plan trip,high,,,done',
].join('\n'))
same('rm', t('rm', '2'), 'removed 2')
r = t('done', '2')
expect('not found', r.code === 1 && r.err.includes('not found: 2'), JSON.stringify(r))
r = t('bogus')
expect('unknown command', r.code === 2 && r.err.length > 0, JSON.stringify(r))
same('next id after rm', t('add', 'y'), 'added 5')
done()
