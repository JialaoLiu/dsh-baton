// Phase 2 acceptance: labels, due dates, priority, archive, search, undo/redo, activity, export/import.
// See docs/phase2.md.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, api, seedBoard, getBoard, titlesOf } from './helpers.mjs'

let app
before(async () => { app = await startApp() })
after(async () => { await app?.stop() })
const call = (...a) => api(app.base, ...a)
const label = async (boardId, name, color = '#336699') => (await call('POST', `/api/boards/${boardId}/labels`, { name, color })).body
// Phase 3 adds a version counter that undo/redo bump; compare states without it.
const noVersion = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'version' ? undefined : v)))
const snap = async (id) => noVersion(await getBoard(app.base, id, '?includeArchived=1'))
const patch = (id, body) => call('PATCH', `/api/cards/${id}`, body)
const search = async (boardId, q, today = '2026-10-15') => {
  const r = await call('GET', `/api/boards/${boardId}/search?q=${encodeURIComponent(q)}&today=${today}`)
  assert.equal(r.status, 200, `search ${q}: ${r.status} ${r.text}`)
  return r.body.cards.map((c) => c.title)
}

test('card defaults and new fields', async () => {
  const { board, cols } = await seedBoard(app.base, 'Fields', [['A', ['c']]])
  const full = await getBoard(app.base, board.id)
  assert.deepEqual(full.labels, [])
  const card = full.columns[0].cards[0]
  assert.deepEqual(card.labels, [])
  assert.equal(card.dueDate, null)
  assert.equal(card.priority, 'normal')
  assert.equal(card.archived, false)
  const bug = await label(board.id, 'bug', '#ff0000')
  assert.equal(bug.name, 'bug')
  assert.equal(bug.color, '#ff0000')
  const r = await patch(cols[0].cards[0], { labels: [bug.id], dueDate: '2026-11-03', priority: 'high' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.labels, [bug.id])
  assert.equal(r.body.dueDate, '2026-11-03')
  assert.equal(r.body.priority, 'high')
  assert.equal((await patch(cols[0].cards[0], { dueDate: null })).body.dueDate, null)
})

test('label and field validation', async () => {
  const { board, cols } = await seedBoard(app.base, 'LabelValid', [['A', ['c']]])
  const other = await seedBoard(app.base, 'Other', [])
  const foreign = await label(other.board.id, 'foreign')
  await label(board.id, 'Bug')
  const dup = await call('POST', `/api/boards/${board.id}/labels`, { name: ' bug ', color: '#000000' })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error.code, 'duplicate')
  for (const body of [{ name: '', color: '#000000' }, { name: 'x'.repeat(51), color: '#000000' }, { name: 'ok', color: 'red' }, { name: 'ok', color: '#12345' }, { name: 'ok' }]) {
    const r = await call('POST', `/api/boards/${board.id}/labels`, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.error.code, 'validation')
  }
  const id = cols[0].cards[0]
  for (const body of [{ labels: [foreign.id] }, { labels: ['nope'] }, { labels: 'x' }, { dueDate: '2026-02-30' }, { dueDate: '2026-1-5' }, { dueDate: 20261105 }, { priority: 'urgent' }]) {
    const r = await patch(id, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.error.code, 'validation')
  }
  assert.equal((await patch(id, { dueDate: '2028-02-29' })).status, 200)
  assert.equal((await call('DELETE', '/api/labels/nope')).status, 404)
})

test('deleting a label removes it from cards', async () => {
  const { board, cols } = await seedBoard(app.base, 'LabelDel', [['A', ['c1', 'c2']]])
  const a = await label(board.id, 'a'), b = await label(board.id, 'b')
  await patch(cols[0].cards[0], { labels: [a.id, b.id] })
  await patch(cols[0].cards[1], { labels: [a.id] })
  assert.equal((await call('DELETE', `/api/labels/${a.id}`)).status, 204)
  const full = await getBoard(app.base, board.id)
  assert.deepEqual(full.labels.map((l) => l.name), ['b'])
  assert.deepEqual(full.columns[0].cards.map((c) => c.labels), [[b.id], []])
})

test('archive and unarchive', async () => {
  const { board, cols } = await seedBoard(app.base, 'Archive', [['A', ['a', 'b', 'c']], ['B', []]])
  const [a, b] = cols[0].cards
  let r = await call('POST', `/api/cards/${a}/archive`)
  assert.equal(r.status, 200)
  assert.equal(r.body.archived, true)
  assert.equal(r.body.position, null)
  let full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[0]), ['b', 'c'])
  assert.deepEqual(full.columns[0].cards.map((c) => c.position), [0, 1])
  full = await getBoard(app.base, board.id, '?includeArchived=1')
  assert.deepEqual(titlesOf(full.columns[0]), ['b', 'c', 'a'])
  assert.equal((await call('POST', `/api/cards/${a}/archive`)).status, 400)
  assert.equal((await call('POST', `/api/cards/${a}/move`, { columnId: cols[1].id, position: 0 })).status, 400)
  assert.equal((await patch(a, { title: 'a2' })).status, 200)
  await call('POST', `/api/cards/${b}/move`, { columnId: cols[0].id, position: 1 })
  r = await call('POST', `/api/cards/${a}/unarchive`)
  assert.equal(r.status, 200)
  assert.equal(r.body.archived, false)
  assert.equal(r.body.position, 2)
  full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[0]), ['c', 'b', 'a2'])
  assert.equal((await call('POST', `/api/cards/${a}/unarchive`)).status, 400)
})

async function searchBoard() {
  const { board, cols } = await seedBoard(app.base, 'Search', [
    ['Todo', ['Fix login bug', 'Write docs', 'Plan offsite']],
    ['In Review', ['Login page redesign', 'Billing export']],
    ['Done', ['Old task']],
  ])
  const bug = await label(board.id, 'bug'), rev = await label(board.id, 'in review'), ux = await label(board.id, 'UX')
  const [fix, docs, plan] = cols[0].cards, [redesign, billing] = cols[1].cards, [old] = cols[2].cards
  await patch(fix, { labels: [bug.id], dueDate: '2026-10-10', priority: 'high', description: 'Users see a 500 on submit' })
  await patch(docs, { dueDate: '2026-10-15', description: 'API reference, "quick start" guide' })
  await patch(plan, { priority: 'low' })
  await patch(redesign, { labels: [ux.id, rev.id], dueDate: '2026-10-20' })
  await patch(billing, { labels: [bug.id, rev.id], dueDate: '2026-10-16', priority: 'high' })
  await patch(old, { dueDate: '2026-09-01', description: 'login cleanup' })
  await call('POST', `/api/cards/${old}/archive`)
  return board.id
}

test('search: words, phrases, labels, columns, priority, negation', async () => {
  const id = await searchBoard()
  assert.deepEqual(await search(id, ''), ['Fix login bug', 'Write docs', 'Plan offsite', 'Login page redesign', 'Billing export'])
  assert.deepEqual(await search(id, 'login'), ['Fix login bug', 'Login page redesign'])
  assert.deepEqual(await search(id, 'LOGIN bug'), ['Fix login bug'])
  assert.deepEqual(await search(id, '500'), ['Fix login bug'], 'description is searched')
  assert.deepEqual(await search(id, '"quick start"'), ['Write docs'])
  assert.deepEqual(await search(id, '"start quick"'), [])
  assert.deepEqual(await search(id, 'label:BUG'), ['Fix login bug', 'Billing export'])
  assert.deepEqual(await search(id, 'label:"in review"'), ['Login page redesign', 'Billing export'])
  assert.deepEqual(await search(id, 'label:bug -label:"in review"'), ['Fix login bug'])
  assert.deepEqual(await search(id, 'column:"in review"'), ['Login page redesign', 'Billing export'])
  assert.deepEqual(await search(id, 'column:todo -login'), ['Write docs', 'Plan offsite'])
  assert.deepEqual(await search(id, 'priority:high'), ['Fix login bug', 'Billing export'])
  assert.deepEqual(await search(id, 'priority:normal'), ['Write docs', 'Login page redesign'])
  assert.deepEqual(await search(id, '-priority:normal -priority:high'), ['Plan offsite'])
  assert.deepEqual(await search(id, 'foo:bar'), [], 'unknown prefix is a plain word')
  assert.deepEqual(await search(id, '-"page redesign" -docs'), ['Fix login bug', 'Plan offsite', 'Billing export'])
})

test('search: due dates and archived cards', async () => {
  const id = await searchBoard()
  assert.deepEqual(await search(id, 'due:overdue'), ['Fix login bug'])
  assert.deepEqual(await search(id, 'due:overdue', '2026-10-17'), ['Fix login bug', 'Write docs', 'Billing export'])
  assert.deepEqual(await search(id, 'due:today'), ['Write docs'])
  assert.deepEqual(await search(id, 'due:none'), ['Plan offsite'])
  assert.deepEqual(await search(id, 'due:2026-10-16'), ['Billing export'])
  assert.deepEqual(await search(id, 'due:<2026-10-16'), ['Fix login bug', 'Write docs'])
  assert.deepEqual(await search(id, 'due:<=2026-10-16'), ['Fix login bug', 'Write docs', 'Billing export'])
  assert.deepEqual(await search(id, 'due:>2026-10-16'), ['Login page redesign'])
  assert.deepEqual(await search(id, 'due:>=2026-10-15 -due:>2026-10-16'), ['Write docs', 'Billing export'])
  assert.deepEqual(await search(id, '-due:none -due:overdue'), ['Write docs', 'Login page redesign', 'Billing export'])
  assert.deepEqual(await search(id, 'is:archived'), ['Old task'])
  assert.deepEqual(await search(id, 'is:archived login'), ['Old task'])
  assert.deepEqual(await search(id, 'login -is:archived'), ['Fix login bug', 'Login page redesign'])
  for (const q of ['due:soon', 'due:<2026-13-01', 'priority:urgent', 'due:']) {
    const r = await call('GET', `/api/boards/${id}/search?q=${encodeURIComponent(q)}&today=2026-10-15`)
    assert.equal(r.status, 400, q)
    assert.equal(r.body.error.code, 'validation', q)
  }
  assert.equal((await call('GET', `/api/boards/nope/search?q=x`)).status, 404)
})

test('undo and redo card operations restore exact state', async () => {
  const { board, cols } = await seedBoard(app.base, 'Undo', [['A', ['a', 'b', 'c']], ['B', ['x']]])
  const undo = () => call('POST', `/api/boards/${board.id}/undo`)
  const redo = () => call('POST', `/api/boards/${board.id}/redo`)
  const s0 = await snap(board.id)
  await call('POST', `/api/cards/${cols[0].cards[0]}/move`, { columnId: cols[1].id, position: 0 })
  await patch(cols[0].cards[1], { title: 'b2', priority: 'low' })
  await call('DELETE', `/api/cards/${cols[0].cards[2]}`)
  await call('POST', `/api/cards/${cols[1].cards[0]}/archive`)
  const s4 = await snap(board.id)
  for (let i = 0; i < 4; i++) {
    const r = await undo()
    assert.equal(r.status, 200, `undo ${i}`)
    assert.ok(Array.isArray(r.body.columns))
  }
  assert.deepEqual(await snap(board.id), s0, 'four undos restore the start exactly (ids, positions, timestamps)')
  // A board with no undoable changes yet (board creation itself is not undoable).
  const fresh = (await call('POST', '/api/boards', { name: 'Fresh' })).body
  const none = await call('POST', `/api/boards/${fresh.id}/undo`)
  assert.equal(none.status, 409)
  assert.equal(none.body.error.code, 'nothing_to_undo')
  for (let i = 0; i < 4; i++) assert.equal((await redo()).status, 200)
  assert.deepEqual(await snap(board.id), s4)
  const noRedo = await redo()
  assert.equal(noRedo.status, 409)
  assert.equal(noRedo.body.error.code, 'nothing_to_redo')
  await undo()
  await call('POST', `/api/columns/${cols[0].id}/cards`, { title: 'new' })
  assert.equal((await redo()).status, 409, 'a new change clears redo')
})

test('undo column delete and label delete restore everything', async () => {
  const { board, cols } = await seedBoard(app.base, 'UndoCol', [['A', ['a1']], ['B', ['b1', 'b2']], ['C', []]])
  const l = await label(board.id, 'keep')
  await patch(cols[1].cards[0], { labels: [l.id] })
  await patch(cols[0].cards[0], { labels: [l.id] })
  const before = await snap(board.id)
  await call('DELETE', `/api/columns/${cols[1].id}`)
  await call('DELETE', `/api/labels/${l.id}`)
  await call('PATCH', `/api/columns/${cols[2].id}`, { position: 0, name: 'C2' })
  await call('POST', `/api/boards/${board.id}/columns`, { name: 'D' })
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', `/api/boards/${board.id}/undo`)).status, 200)
  assert.deepEqual(await snap(board.id), before)
})

test('undo keeps at most 50 steps and board operations are not undoable', async () => {
  const { board, cols } = await seedBoard(app.base, 'Depth', [['A', ['card']]])
  const before = await call('POST', `/api/boards/${board.id}/undo`)
  assert.equal(before.status, 200, 'seeding (column + card creation) is undoable')
  await call('POST', `/api/boards/${board.id}/redo`)
  for (let i = 0; i < 55; i++) await patch(cols[0].cards[0], { title: `t${i}` })
  await call('PATCH', `/api/boards/${board.id}`, { name: 'Depth renamed' })
  let n = 0
  while ((await call('POST', `/api/boards/${board.id}/undo`)).status === 200) n++
  assert.equal(n, 50)
  const full = await getBoard(app.base, board.id)
  assert.equal(full.name, 'Depth renamed')
  assert.equal(full.columns[0].cards[0].title, 't4')
})

test('activity log', async () => {
  const { board, cols } = await seedBoard(app.base, 'Activity', [['Todo', ['Alpha card']], ['Done', []]])
  await patch(cols[0].cards[0], { title: 'Alpha card v2' })
  await call('POST', `/api/cards/${cols[0].cards[0]}/move`, { columnId: cols[1].id, position: 0 })
  await call('POST', `/api/cards/${cols[0].cards[0]}/archive`)
  await call('POST', `/api/boards/${board.id}/undo`)
  await call('POST', `/api/boards/${board.id}/redo`)
  await label(board.id, 'later')
  const r = await call('GET', `/api/boards/${board.id}/activity`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.map((e) => e.type), [
    'label.created', 'redo', 'undo', 'card.archived', 'card.moved', 'card.updated', 'column.created', 'card.created', 'column.created',
  ])
  const moved = r.body.find((e) => e.type === 'card.moved')
  assert.equal(moved.cardId, cols[0].cards[0])
  assert.match(moved.summary, /Alpha card v2/)
  assert.match(r.body.find((e) => e.type === 'column.created').summary, /Done|Todo/)
  assert.ok(r.body.every((e) => typeof e.id === 'string' && !Number.isNaN(Date.parse(e.at))))
  assert.equal((await call('GET', `/api/boards/${board.id}/activity?limit=3`)).body.length, 3)
  for (const bad of ['0', '-1', 'abc', '2.5']) assert.equal((await call('GET', `/api/boards/${board.id}/activity?limit=${bad}`)).status, 400, bad)
  for (let i = 0; i < 205; i++) await patch(cols[0].cards[0], { description: `d${i}` })
  assert.equal((await call('GET', `/api/boards/${board.id}/activity?limit=500`)).body.length, 200)
  const firstTen = (await call('GET', `/api/boards/${board.id}/activity?limit=10`)).body
  await app.stop()
  app = await startApp({ dataDir: app.dataDir })
  assert.deepEqual((await call('GET', `/api/boards/${board.id}/activity?limit=10`)).body, firstTen, 'activity survives a restart')
})

async function richBoard() {
  const { board, cols } = await seedBoard(app.base, 'Export, "quoted"', [['To do', ['Plain', 'Tricky']], ['Done', ['Shipped', 'Hidden']]])
  const bug = await label(board.id, 'bug', '#ff0000'), ui = await label(board.id, 'ui', '#00aa00')
  await patch(cols[0].cards[0], { description: 'simple', labels: [ui.id], priority: 'low' })
  await patch(cols[0].cards[1], { description: 'has, comma and "quotes"\nand a second line', labels: [bug.id, ui.id], dueDate: '2026-12-01', priority: 'high' })
  await call('POST', `/api/cards/${cols[1].cards[1]}/archive`)
  return board.id
}

test('JSON export has no ids and round-trips through import', async () => {
  const id = await richBoard()
  const r = await call('GET', `/api/boards/${id}/export`)
  assert.equal(r.status, 200)
  const ex = r.body
  assert.equal(ex.version, 1)
  assert.ok(!Number.isNaN(Date.parse(ex.exportedAt)))
  assert.deepEqual(ex.board, {
    name: 'Export, "quoted"',
    labels: [{ name: 'bug', color: '#ff0000' }, { name: 'ui', color: '#00aa00' }],
    columns: [
      { name: 'To do', cards: [
        { title: 'Plain', description: 'simple', labels: ['ui'], dueDate: null, priority: 'low', archived: false },
        { title: 'Tricky', description: 'has, comma and "quotes"\nand a second line', labels: ['bug', 'ui'], dueDate: '2026-12-01', priority: 'high', archived: false },
      ] },
      { name: 'Done', cards: [
        { title: 'Shipped', description: '', labels: [], dueDate: null, priority: 'normal', archived: false },
        { title: 'Hidden', description: '', labels: [], dueDate: null, priority: 'normal', archived: true },
      ] },
    ],
  })
  const imp = await call('POST', '/api/import', ex)
  assert.equal(imp.status, 201)
  assert.notEqual(imp.body.id, id)
  assert.equal(imp.body.name, 'Export, "quoted"')
  const again = (await call('GET', `/api/boards/${imp.body.id}/export`)).body
  assert.deepEqual(again.board, ex.board)
  const oldIds = new Set(JSON.stringify(await getBoard(app.base, id, '?includeArchived=1')).match(/"id":"[^"]+"/g))
  const newIds = JSON.stringify(await getBoard(app.base, imp.body.id, '?includeArchived=1')).match(/"id":"[^"]+"/g)
  assert.ok(newIds.every((x) => !oldIds.has(x)), 'import creates new ids')
})

test('import rejects invalid documents and creates nothing', async () => {
  const id = await richBoard()
  const ex = (await call('GET', `/api/boards/${id}/export`)).body
  const count = (await call('GET', '/api/boards')).body.length
  const broken = [
    { ...ex, version: 2 },
    { version: 1 },
    { ...ex, board: { ...ex.board, name: '' } },
    { ...ex, board: { ...ex.board, columns: [{ name: 'X', cards: [{ title: 'ok', labels: ['missing-label'] }] }] } },
    { ...ex, board: { ...ex.board, columns: [{ name: 'X', cards: [{ title: 'ok', priority: 'urgent' }] }] } },
    { ...ex, board: { ...ex.board, columns: [{ name: 'X', cards: [{ title: 'ok', dueDate: '2026-02-30' }] }] } },
    { ...ex, board: { ...ex.board, labels: [{ name: 'a', color: '#000000' }, { name: 'A', color: '#111111' }] } },
    { ...ex, board: { ...ex.board, columns: [{ name: 'Fine', cards: [{ title: 'fine' }] }, { name: '', cards: [] }] } },
  ]
  for (const doc of broken) {
    const r = await call('POST', '/api/import', doc)
    assert.equal(r.status, 400, JSON.stringify(doc).slice(0, 120))
    assert.equal(r.body.error.code, 'validation')
  }
  assert.equal((await call('GET', '/api/boards')).body.length, count)
  const minimal = await call('POST', '/api/import', { version: 1, board: { name: 'Min', labels: [], columns: [{ name: 'C', cards: [{ title: 'only title' }] }] } })
  assert.equal(minimal.status, 201, 'optional card fields default')
  const card = minimal.body.columns[0].cards[0]
  assert.equal(card.priority, 'normal')
  assert.equal(card.description, '')
})

test('CSV export', async () => {
  const id = await richBoard()
  const res = await fetch(`${app.base}/api/boards/${id}/export.csv`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/csv/)
  const text = await res.text()
  assert.equal(text,
    'column,title,description,labels,dueDate,priority,archived\r\n' +
    'To do,Plain,simple,ui,,low,false\r\n' +
    'To do,Tricky,"has, comma and ""quotes""\nand a second line",bug;ui,2026-12-01,high,false\r\n' +
    'Done,Shipped,,,,normal,false\r\n' +
    'Done,Hidden,,,,normal,true\r\n')
})

test('phase 1 data files still load', async () => {
  // A board written before phase 2 has no labels or new card fields; it must still read with defaults.
  const { board } = await seedBoard(app.base, 'Upgrade', [['A', ['old']]])
  await app.stop()
  app = await startApp({ dataDir: app.dataDir })
  const card = (await getBoard(app.base, board.id)).columns[0].cards[0]
  assert.equal(card.priority, 'normal')
  assert.deepEqual(card.labels, [])
})
