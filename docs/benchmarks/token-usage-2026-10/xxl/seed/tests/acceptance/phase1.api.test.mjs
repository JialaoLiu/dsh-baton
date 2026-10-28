// Phase 1 acceptance: HTTP API, validation, ordering and persistence. See docs/phase1.md.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startApp, api, seedBoard, getBoard, titlesOf } from './helpers.mjs'

let app
before(async () => { app = await startApp() })
after(async () => { await app?.stop() })
const call = (...a) => api(app.base, ...a)

test('health', async () => {
  const r = await call('GET', '/api/health')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
})

test('package.json has no dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)))
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0)
  assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0)
})

test('create, list, get, rename and delete boards', async () => {
  const a = await call('POST', '/api/boards', { name: '  Alpha  ' })
  assert.equal(a.status, 201)
  assert.equal(a.body.name, 'Alpha')
  assert.equal(typeof a.body.id, 'string')
  assert.deepEqual(a.body.columns, [])
  assert.ok(!Number.isNaN(Date.parse(a.body.createdAt)))
  const b = (await call('POST', '/api/boards', { name: 'Beta' })).body
  const list = (await call('GET', '/api/boards')).body
  const ids = list.map((x) => x.id)
  assert.ok(ids.indexOf(a.body.id) < ids.indexOf(b.id))
  const r = await call('PATCH', `/api/boards/${a.body.id}`, { name: 'Alpha 2' })
  assert.equal(r.status, 200)
  assert.equal(r.body.name, 'Alpha 2')
  assert.equal((await getBoard(app.base, a.body.id)).name, 'Alpha 2')
  assert.equal((await call('DELETE', `/api/boards/${b.id}`)).status, 204)
  assert.equal((await call('GET', `/api/boards/${b.id}`)).status, 404)
  assert.ok(!(await call('GET', '/api/boards')).body.some((x) => x.id === b.id))
})

test('columns are appended in order and can be renamed, reordered and deleted', async () => {
  const { board, cols } = await seedBoard(app.base, 'Cols', [['A', []], ['B', []], ['C', []], ['D', []]])
  let full = await getBoard(app.base, board.id)
  assert.deepEqual(full.columns.map((c) => c.name), ['A', 'B', 'C', 'D'])
  assert.deepEqual(full.columns.map((c) => c.position), [0, 1, 2, 3])
  assert.ok(full.columns.every((c) => c.boardId === board.id))
  const r = await call('PATCH', `/api/columns/${cols[3].id}`, { position: 0, name: 'D2' })
  assert.equal(r.status, 200)
  assert.equal(r.body.name, 'D2')
  full = await getBoard(app.base, board.id)
  assert.deepEqual(full.columns.map((c) => c.name), ['D2', 'A', 'B', 'C'])
  await call('PATCH', `/api/columns/${cols[0].id}`, { position: 99 })
  full = await getBoard(app.base, board.id)
  assert.deepEqual(full.columns.map((c) => c.name), ['D2', 'B', 'C', 'A'])
  assert.equal((await call('DELETE', `/api/columns/${cols[1].id}`)).status, 204)
  full = await getBoard(app.base, board.id)
  assert.deepEqual(full.columns.map((c) => c.name), ['D2', 'C', 'A'])
  assert.deepEqual(full.columns.map((c) => c.position), [0, 1, 2])
})

test('cards: create, edit, positions stay contiguous', async () => {
  const { board, cols } = await seedBoard(app.base, 'Cards', [['Todo', ['one', 'two', 'three']]])
  let col = (await getBoard(app.base, board.id)).columns[0]
  assert.deepEqual(titlesOf(col), ['one', 'two', 'three'])
  assert.deepEqual(col.cards.map((c) => c.position), [0, 1, 2])
  const card = col.cards[0]
  assert.equal(card.description, '')
  assert.equal(card.columnId, cols[0].id)
  await new Promise((r) => setTimeout(r, 15))
  const r = await call('PATCH', `/api/cards/${card.id}`, { title: ' uno ', description: 'first' })
  assert.equal(r.status, 200)
  assert.equal(r.body.title, 'uno')
  assert.equal(r.body.description, 'first')
  assert.ok(Date.parse(r.body.updatedAt) > Date.parse(card.updatedAt))
  assert.equal((await call('DELETE', `/api/cards/${cols[0].cards[1]}`)).status, 204)
  col = (await getBoard(app.base, board.id)).columns[0]
  assert.deepEqual(titlesOf(col), ['uno', 'three'])
  assert.deepEqual(col.cards.map((c) => c.position), [0, 1])
  const withDesc = await call('POST', `/api/columns/${cols[0].id}/cards`, { title: 'x', description: 'hello' })
  assert.equal(withDesc.status, 201)
  assert.equal(withDesc.body.description, 'hello')
  assert.equal(withDesc.body.position, 2)
})

test('moving cards within and across columns, with clamping', async () => {
  const { board, cols } = await seedBoard(app.base, 'Move', [['L', ['a', 'b', 'c', 'd']], ['R', ['x', 'y']]])
  const [L, R] = cols
  let r = await call('POST', `/api/cards/${L.cards[0]}/move`, { columnId: L.id, position: 2 })
  assert.equal(r.status, 200)
  let full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[0]), ['b', 'c', 'a', 'd'])
  r = await call('POST', `/api/cards/${L.cards[3]}/move`, { columnId: R.id, position: 1 })
  assert.equal(r.body.columnId, R.id)
  assert.equal(r.body.position, 1)
  full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[0]), ['b', 'c', 'a'])
  assert.deepEqual(titlesOf(full.columns[1]), ['x', 'd', 'y'])
  assert.deepEqual(full.columns[0].cards.map((c) => c.position), [0, 1, 2])
  assert.deepEqual(full.columns[1].cards.map((c) => c.position), [0, 1, 2])
  await call('POST', `/api/cards/${R.cards[0]}/move`, { columnId: L.id, position: 100 })
  await call('POST', `/api/cards/${R.cards[1]}/move`, { columnId: L.id, position: -5 })
  full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[0]), ['y', 'b', 'c', 'a', 'x'])
  assert.deepEqual(titlesOf(full.columns[1]), ['d'])
})

test('moving to a column on another board or a missing column fails', async () => {
  const one = await seedBoard(app.base, 'One', [['A', ['card']]])
  const two = await seedBoard(app.base, 'Two', [['B', []]])
  const r = await call('POST', `/api/cards/${one.cols[0].cards[0]}/move`, { columnId: two.cols[0].id, position: 0 })
  assert.equal(r.status, 400)
  assert.equal(r.body.error.code, 'validation')
  const m = await call('POST', `/api/cards/${one.cols[0].cards[0]}/move`, { columnId: 'nope', position: 0 })
  assert.equal(m.status, 404)
  assert.equal(m.body.error.code, 'not_found')
})

test('validation errors', async () => {
  const { board, cols } = await seedBoard(app.base, 'Valid', [['A', ['ok']]])
  const cases = [
    ['POST', '/api/boards', {}],
    ['POST', '/api/boards', { name: '   ' }],
    ['POST', '/api/boards', { name: 'x'.repeat(201) }],
    ['POST', '/api/boards', { name: 42 }],
    ['PATCH', `/api/boards/${board.id}`, { name: '' }],
    ['POST', `/api/boards/${board.id}/columns`, { name: '' }],
    ['PATCH', `/api/columns/${cols[0].id}`, { position: 'first' }],
    ['POST', `/api/columns/${cols[0].id}/cards`, { title: '' }],
    ['POST', `/api/columns/${cols[0].id}/cards`, { title: 'ok', description: 'x'.repeat(5001) }],
    ['POST', `/api/columns/${cols[0].id}/cards`, { title: 'ok', description: 7 }],
    ['PATCH', `/api/cards/${cols[0].cards[0]}`, { title: '  ' }],
    ['POST', `/api/cards/${cols[0].cards[0]}/move`, { columnId: cols[0].id }],
    ['POST', `/api/cards/${cols[0].cards[0]}/move`, { position: 0 }],
  ]
  for (const [m, u, b] of cases) {
    const r = await call(m, u, b)
    assert.equal(r.status, 400, `${m} ${u} ${JSON.stringify(b).slice(0, 60)} -> ${r.status}`)
    assert.equal(r.body?.error?.code, 'validation', `${m} ${u}`)
    assert.equal(typeof r.body.error.message, 'string')
  }
  assert.equal((await call('POST', '/api/boards', { name: 'x'.repeat(200) })).status, 201)
  // Nothing changed by the rejected requests.
  const full = await getBoard(app.base, board.id)
  assert.equal(full.name, 'Valid')
  assert.deepEqual(titlesOf(full.columns[0]), ['ok'])
})

test('bad JSON and not found', async () => {
  const bad = await call('POST', '/api/boards', '{"name": ')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'bad_json')
  for (const [m, u, b] of [
    ['GET', '/api/boards/missing'], ['PATCH', '/api/boards/missing', { name: 'x' }], ['DELETE', '/api/boards/missing'],
    ['POST', '/api/boards/missing/columns', { name: 'x' }], ['PATCH', '/api/columns/missing', { name: 'x' }],
    ['DELETE', '/api/columns/missing'], ['POST', '/api/columns/missing/cards', { title: 'x' }],
    ['PATCH', '/api/cards/missing', { title: 'x' }], ['DELETE', '/api/cards/missing'],
    ['POST', '/api/cards/missing/move', { columnId: 'x', position: 0 }], ['GET', '/api/nothing-here'],
  ]) {
    const r = await call(m, u, b)
    assert.equal(r.status, 404, `${m} ${u}`)
    assert.equal(r.body?.error?.code, 'not_found', `${m} ${u}`)
  }
})

test('deleting a board removes its columns and cards', async () => {
  const { board, cols } = await seedBoard(app.base, 'Gone', [['A', ['c1']]])
  await call('DELETE', `/api/boards/${board.id}`)
  assert.equal((await call('PATCH', `/api/columns/${cols[0].id}`, { name: 'x' })).status, 404)
  assert.equal((await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { title: 'x' })).status, 404)
})

test('data survives a restart and no temp files are left behind', async () => {
  const { board } = await seedBoard(app.base, 'Persist', [['Keep', ['k1', 'k2']], ['Also', ['k3']]])
  await call('POST', `/api/cards/${(await getBoard(app.base, board.id)).columns[0].cards[0].id}/move`, {
    columnId: (await getBoard(app.base, board.id)).columns[1].id, position: 0,
  })
  const before = await getBoard(app.base, board.id)
  await app.stop()
  app = await startApp({ dataDir: app.dataDir })
  const afterRestart = await getBoard(app.base, board.id)
  assert.deepEqual(afterRestart, before)
  assert.ok(fs.readdirSync(app.dataDir).length > 0, 'data files are written to DATA_DIR')
  assert.ok(!fs.readdirSync(app.dataDir).some((f) => /\.tmp|~$|\.part$/i.test(f)), 'no temp files left')
})

test('many concurrent writes are all kept', async () => {
  const { board, cols } = await seedBoard(app.base, 'Burst', [['A', []]])
  await Promise.all(Array.from({ length: 40 }, (_, i) => call('POST', `/api/columns/${cols[0].id}/cards`, { title: `c${i}` })))
  const col = (await getBoard(app.base, board.id)).columns[0]
  assert.equal(col.cards.length, 40)
  assert.deepEqual(col.cards.map((c) => c.position), [...Array(40).keys()])
  assert.equal(new Set(col.cards.map((c) => c.title)).size, 40)
  await app.stop()
  app = await startApp({ dataDir: app.dataDir })
  assert.equal((await getBoard(app.base, board.id)).columns[0].cards.length, 40)
})

test('serves the front end', async () => {
  const r = await fetch(`${app.base}/`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/html/)
})
