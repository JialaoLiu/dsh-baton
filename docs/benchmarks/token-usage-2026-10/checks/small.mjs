// Acceptance check for tasks/small.md. Usage: node checks/small.mjs <workspace>
import path from 'node:path'
import fs from 'node:fs'
import { checker } from './lib.mjs'

const dir = path.resolve(process.argv[2])
const { run, expect, done, tmp } = checker(dir)
const env = { TODO_FILE: path.join(tmp, 'todo.json') }
const t = (...args) => run('node', ['todo.mjs', ...args], env)
const same = (name, r, out, code = 0) => expect(name, r.out === out && r.code === code, `got ${JSON.stringify(r)}`)

expect('todo.mjs exists', fs.existsSync(path.join(dir, 'todo.mjs')))
same('empty list', t('list'), 'no tasks')
same('add 1', t('add', 'buy', 'milk'), 'added 1')
same('add 2', t('add', 'call mum'), 'added 2')
same('list two', t('list'), '1. [ ] buy milk\n2. [ ] call mum')
same('done 1', t('done', '1'), 'done 1')
same('list after done', t('list'), '1. [x] buy milk\n2. [ ] call mum')
let r = t('done', '9')
expect('done missing', r.code === 1 && r.err.includes('not found: 9'), JSON.stringify(r))
same('rm 1', t('rm', '1'), 'removed 1')
r = t('rm', '1')
expect('rm missing', r.code === 1 && r.err.includes('not found: 1'), JSON.stringify(r))
same('add after rm takes max+1', t('add', 'x'), 'added 3')
r = t('frobnicate')
expect('unknown command', r.code === 2 && r.err.length > 0, JSON.stringify(r))
r = t()
expect('no command', r.code === 2 && r.err.length > 0, JSON.stringify(r))
r = run('node', ['todo.mjs', 'list'], { TODO_FILE: path.join(tmp, 'missing', 'none.json') })
expect('missing file is empty', r.out === 'no tasks', JSON.stringify(r))
done()
