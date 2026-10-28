// Phase 3 acceptance: versions and conflicts, WIP limits, done columns, bulk, server-sent events, stats.
// See docs/phase3.md.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { startApp, api, seedBoard, getBoard, titlesOf } from './helpers.mjs'

let app
before(async () => { app = await startApp() })
after(async () => { await app?.stop() })
const call = (...a) => api(app.base, ...a)
const card = async (boardId, id) => (await getBoard(app.base, boardId, '?includeArchived=1')).columns.flatMap((c) => c.cards).find((c) => c.id === id)

test('versions start at 1 and go up on each change', async () => {
  const { board, cols } = await seedBoard(app.base, 'Versions', [['A', ['a', 'b']], ['B', []]])
  let full = await getBoard(app.base, board.id)
  assert.equal(full.version, 1)
  assert.equal(full.columns[0].version, 1)
  assert.equal(full.columns[0].cards[0].version, 1)
  const r = await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { title: 'a2' })
  assert.equal(r.body.version, 2)
  assert.equal(r.headers.get('etag'), '"2"')
  assert.equal((await call('POST', `/api/cards/${cols[0].cards[0]}/move`, { columnId: cols[1].id, position: 0 })).body.version, 3)
  assert.equal((await card(board.id, cols[0].cards[1])).version, 1, 'reordering others does not bump their version')
  assert.equal((await call('POST', `/api/cards/${cols[0].cards[0]}/archive`)).body.version, 4)
  assert.equal((await call('PATCH', `/api/columns/${cols[0].id}`, { name: 'A2' })).body.version, 2)
  assert.equal((await call('PATCH', `/api/boards/${board.id}`, { name: 'Versions 2' })).body.version, 2)
  const g = await call('GET', `/api/boards/${board.id}`)
  assert.equal(g.headers.get('etag'), '"2"')
  await call('POST', `/api/boards/${board.id}/undo`) // reverts the column rename (board rename is not undoable)
  full = await getBoard(app.base, board.id)
  assert.equal(full.columns[0].name, 'A')
  assert.equal(full.columns[0].version, 3, 'undo bumps the version')
})

test('If-Match conflicts return 409 with the current object and change nothing', async () => {
  const { board, cols } = await seedBoard(app.base, 'Conflict', [['A', ['shared']], ['B', []]])
  const id = cols[0].cards[0]
  assert.equal((await call('PATCH', `/api/cards/${id}`, { title: 'first' }, { 'if-match': '1' })).status, 200)
  const stale = await call('PATCH', `/api/cards/${id}`, { title: 'second' }, { 'if-match': '1' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'conflict')
  assert.equal(stale.body.error.current.title, 'first')
  assert.equal(stale.body.error.current.version, 2)
  assert.equal((await call('POST', `/api/cards/${id}/move`, { columnId: cols[1].id, position: 0 }, { 'if-match': '1' })).status, 409)
  assert.equal((await call('POST', `/api/cards/${id}/archive`, undefined, { 'if-match': '"1"' })).status, 409, 'quoted ETag form also checked')
  assert.equal((await call('PATCH', `/api/columns/${cols[0].id}`, { name: 'x' }, { 'if-match': '7' })).status, 409)
  assert.equal((await call('PATCH', `/api/boards/${board.id}`, { name: 'x' }, { 'if-match': '7' })).status, 409)
  const c = await card(board.id, id)
  assert.equal(c.title, 'first')
  assert.equal(c.columnId, cols[0].id)
  assert.equal(c.archived, false)
  assert.equal((await call('PATCH', `/api/cards/${id}`, { title: 'third' }, { 'if-match': '"2"' })).status, 200)
})

test('WIP limits block new, moved-in and unarchived cards unless forced', async () => {
  const { board, cols } = await seedBoard(app.base, 'WIP', [['Todo', ['t1', 't2', 't3']], ['Doing', ['d1']]])
  const [todo, doing] = cols
  const set = await call('PATCH', `/api/columns/${doing.id}`, { wipLimit: 2 })
  assert.equal(set.status, 200)
  assert.equal(set.body.wipLimit, 2)
  assert.equal((await call('POST', `/api/cards/${todo.cards[0]}/move`, { columnId: doing.id, position: 0 })).status, 200)
  const blocked = await call('POST', `/api/cards/${todo.cards[1]}/move`, { columnId: doing.id, position: 0 })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'wip_limit')
  const add = await call('POST', `/api/columns/${doing.id}/cards`, { title: 'nope' })
  assert.equal(add.status, 409)
  assert.equal(add.body.error.code, 'wip_limit')
  assert.equal((await call('POST', `/api/cards/${doing.cards[0]}/move`, { columnId: doing.id, position: 1 })).status, 200, 'moving inside the column is fine')
  let full = await getBoard(app.base, board.id)
  assert.deepEqual(titlesOf(full.columns[1]), ['t1', 'd1'])
  assert.deepEqual(titlesOf(full.columns[0]), ['t2', 't3'])
  assert.equal((await call('POST', `/api/cards/${doing.cards[0]}/archive`)).status, 200)
  assert.equal((await call('POST', `/api/cards/${todo.cards[1]}/move`, { columnId: doing.id, position: 0 })).status, 200)
  const un = await call('POST', `/api/cards/${doing.cards[0]}/unarchive`)
  assert.equal(un.status, 409)
  assert.equal(un.body.error.code, 'wip_limit')
  assert.equal((await call('POST', `/api/cards/${doing.cards[0]}/unarchive?force=1`)).status, 200)
  assert.equal((await call('POST', `/api/columns/${doing.id}/cards?force=1`, { title: 'forced' })).status, 201)
  full = await getBoard(app.base, board.id)
  assert.equal(full.columns[1].cards.length, 4)
  assert.equal((await call('PATCH', `/api/columns/${doing.id}`, { wipLimit: 1 })).status, 200, 'lowering below the current count is allowed')
  for (const bad of [0, 1000, 2.5, '3']) assert.equal((await call('PATCH', `/api/columns/${doing.id}`, { wipLimit: bad })).status, 400, String(bad))
  assert.equal((await call('PATCH', `/api/columns/${doing.id}`, { wipLimit: null })).body.wipLimit, null)
  const created = await call('POST', `/api/boards/${board.id}/columns`, { name: 'Capped', wipLimit: 1, isDone: false })
  assert.equal(created.body.wipLimit, 1)
  assert.equal(created.body.isDone, false)
})

test('done columns set and clear completedAt', async () => {
  const { board, cols } = await seedBoard(app.base, 'Done', [['Todo', ['a', 'b']], ['Done', []]])
  const done = await call('PATCH', `/api/columns/${cols[1].id}`, { isDone: true })
  assert.equal(done.body.isDone, true)
  const a = cols[0].cards[0]
  assert.equal((await card(board.id, a)).completedAt, null)
  const moved = await call('POST', `/api/cards/${a}/move`, { columnId: cols[1].id, position: 0 })
  assert.ok(!Number.isNaN(Date.parse(moved.body.completedAt)))
  const back = await call('POST', `/api/cards/${a}/move`, { columnId: cols[0].id, position: 0 })
  assert.equal(back.body.completedAt, null)
  const born = await call('POST', `/api/columns/${cols[1].id}/cards`, { title: 'born done' })
  assert.equal(born.body.completedAt, born.body.createdAt)
  await call('PATCH', `/api/columns/${cols[0].id}`, { isDone: true })
  assert.ok((await card(board.id, cols[0].cards[1])).completedAt, 'marking a column done stamps its cards')
  await call('PATCH', `/api/columns/${cols[0].id}`, { isDone: false })
  assert.equal((await card(board.id, cols[0].cards[1])).completedAt, null)
})

test('bulk operations are all-or-nothing and one undo step', async () => {
  const { board, cols } = await seedBoard(app.base, 'Bulk', [['A', ['a1', 'a2', 'a3', 'a4']], ['B', ['b1']]])
  const other = await seedBoard(app.base, 'Elsewhere', [['X', ['x1']]])
  const bulk = (body, q = '') => call('POST', `/api/boards/${board.id}/bulk${q}`, body)
  const [a1, a2, a3, a4] = cols[0].cards
  const snapshot = JSON.stringify(await getBoard(app.base, board.id, '?includeArchived=1'))
  for (const [body, status] of [
    [{ cardIds: [], action: 'archive' }, 400],
    [{ cardIds: [a1, a1], action: 'archive' }, 400],
    [{ cardIds: [a1, other.cols[0].cards[0]], action: 'archive' }, 400],
    [{ cardIds: [a1, 'missing'], action: 'delete' }, 404],
    [{ cardIds: [a1], action: 'explode' }, 400],
    [{ cardIds: [a1], action: 'move' }, 400],
    [{ cardIds: [a1], action: 'priority', priority: 'urgent' }, 400],
    [{ cardIds: [a1], action: 'label', labelId: 'missing', mode: 'add' }, 400],
  ]) {
    const r = await bulk(body)
    assert.equal(r.status, status, JSON.stringify(body))
  }
  assert.equal(JSON.stringify(await getBoard(app.base, board.id, '?includeArchived=1')), snapshot, 'failed bulk requests change nothing')
  let r = await bulk({ cardIds: [a3, a1], action: 'move', columnId: cols[1].id })
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 2)
  assert.deepEqual(titlesOf(r.body.board.columns[1]), ['b1', 'a3', 'a1'])
  assert.deepEqual(titlesOf(r.body.board.columns[0]), ['a2', 'a4'])
  const undo = await call('POST', `/api/boards/${board.id}/undo`)
  assert.deepEqual(titlesOf(undo.body.columns[0]), ['a1', 'a2', 'a3', 'a4'], 'one undo reverts the whole bulk move')
  assert.deepEqual(titlesOf(undo.body.columns[1]), ['b1'])
  await call('PATCH', `/api/columns/${cols[1].id}`, { wipLimit: 2 })
  r = await bulk({ cardIds: [a1, a2], action: 'move', columnId: cols[1].id })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'wip_limit')
  assert.deepEqual(titlesOf((await getBoard(app.base, board.id)).columns[1]), ['b1'])
  assert.equal((await bulk({ cardIds: [a1, a2], action: 'move', columnId: cols[1].id }, '?force=1')).status, 200)
  const l = (await call('POST', `/api/boards/${board.id}/labels`, { name: 'tag', color: '#00ff00' })).body
  r = await bulk({ cardIds: [a3, a4], action: 'label', labelId: l.id, mode: 'add' })
  assert.equal(r.status, 200)
  assert.deepEqual((await card(board.id, a3)).labels, [l.id])
  await bulk({ cardIds: [a3], action: 'label', labelId: l.id, mode: 'remove' })
  assert.deepEqual((await card(board.id, a3)).labels, [])
  await bulk({ cardIds: [a3, a4], action: 'priority', priority: 'high' })
  assert.equal((await card(board.id, a4)).priority, 'high')
  await bulk({ cardIds: [a3], action: 'archive' })
  assert.equal((await bulk({ cardIds: [a3, a4], action: 'archive' })).status, 400, 'already archived')
  assert.equal((await card(board.id, a4)).archived, false)
  r = await bulk({ cardIds: [a4, a3], action: 'delete' })
  assert.equal(r.body.count, 2)
  assert.equal(await card(board.id, a4), undefined)
  const activity = (await call('GET', `/api/boards/${board.id}/activity?limit=10`)).body
  assert.equal(activity[0].type, 'bulk.delete')
  assert.match(activity[0].summary, /2/)
  assert.ok(activity.some((e) => e.type === 'bulk.move'))
})

// Minimal SSE client: collects events until closed.
function subscribe(url) {
  const events = []
  let req, res, buf = ''
  const ready = new Promise((resolve, reject) => {
    req = http.get(url, (r) => {
      res = r
      resolve(r)
      r.setEncoding('utf8')
      r.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = { event: 'message', data: '' }
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim()
            else if (line.startsWith('data:')) ev.data += line.slice(5).trim()
          }
          if (block.split('\n').every((l) => l.startsWith(':'))) continue
          try { ev.json = JSON.parse(ev.data) } catch {}
          events.push(ev)
        }
      })
    })
    req.on('error', reject)
  })
  return { events, ready, close: () => req.destroy(), res: () => res, waitFor: async (pred, ms = 3000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(20) }
    throw new Error(`no matching event; got ${JSON.stringify(events)}`)
  } }
}

test('server-sent events for board changes', async () => {
  const { board, cols } = await seedBoard(app.base, 'Live', [['A', ['a']], ['B', []]])
  const missing = await call('GET', '/api/boards/missing/events')
  assert.equal(missing.status, 404)
  const sub = subscribe(`${app.base}/api/boards/${board.id}/events`)
  const res = await sub.ready
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  const hello = await sub.waitFor((e) => e.event === 'hello')
  assert.equal(hello.json.version, 1)
  await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { title: 'a2' })
  const ev = await sub.waitFor((e) => e.event === 'change' && e.json?.type === 'card.updated')
  assert.equal(ev.json.cardId, cols[0].cards[0])
  assert.equal(ev.json.boardId, board.id)
  await call('POST', `/api/cards/${cols[0].cards[0]}/move`, { columnId: cols[1].id, position: 0 })
  await sub.waitFor((e) => e.json?.type === 'card.moved')
  await call('POST', `/api/boards/${board.id}/undo`)
  await sub.waitFor((e) => e.json?.type === 'undo')
  await call('POST', `/api/boards/${board.id}/bulk`, { cardIds: [cols[0].cards[0]], action: 'priority', priority: 'low' })
  await sub.waitFor((e) => e.json?.type === 'bulk.priority')
  await call('PATCH', `/api/boards/${board.id}`, { name: 'Live 2' })
  await sub.waitFor((e) => e.json?.type === 'board.updated')
  // Another board's changes are not sent here.
  const other = await seedBoard(app.base, 'Quiet', [['Q', []]])
  await call('PATCH', `/api/columns/${other.cols[0].id}`, { name: 'Q2' })
  await sleep(200)
  assert.ok(!sub.events.some((e) => e.json?.columnId === other.cols[0].id))
  const closed = new Promise((r) => sub.res().once('end', r))
  await call('DELETE', `/api/boards/${board.id}`)
  await sub.waitFor((e) => e.json?.type === 'board.deleted')
  await Promise.race([closed, sleep(3000).then(() => assert.fail('stream not closed after board.deleted'))])
})

test('many SSE clients connect and disconnect without breaking the server', async () => {
  const { board, cols } = await seedBoard(app.base, 'Crowd', [['A', ['a']]])
  for (let round = 0; round < 3; round++) {
    const subs = Array.from({ length: 20 }, () => subscribe(`${app.base}/api/boards/${board.id}/events`))
    await Promise.all(subs.map((s) => s.ready))
    await Promise.all(subs.map((s) => s.waitFor((e) => e.event === 'hello')))
    subs.forEach((s) => s.close())
    await sleep(100)
  }
  const sub = subscribe(`${app.base}/api/boards/${board.id}/events`)
  await sub.ready
  await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { title: 'still fine' })
  await sub.waitFor((e) => e.json?.type === 'card.updated')
  sub.close()
})

test('stats', async () => {
  const { board, cols } = await seedBoard(app.base, 'Stats', [['Todo', ['t1', 't2', 't3']], ['Done', ['d1', 'd2']], ['Empty', []]])
  await call('PATCH', `/api/columns/${cols[1].id}`, { isDone: true })
  await call('PATCH', `/api/columns/${cols[0].id}`, { wipLimit: 5 })
  const bug = (await call('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' })).body
  const ux = (await call('POST', `/api/boards/${board.id}/labels`, { name: 'ux', color: '#00ff00' })).body
  await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { labels: [bug.id], dueDate: '2026-10-01', priority: 'high' })
  await call('PATCH', `/api/cards/${cols[0].cards[1]}`, { dueDate: '2026-12-01', priority: 'low' })
  await call('PATCH', `/api/cards/${cols[1].cards[0]}`, { labels: [bug.id], dueDate: '2026-09-01' })
  await call('POST', `/api/cards/${cols[0].cards[2]}/archive`)
  const r = await call('GET', `/api/boards/${board.id}/stats?today=2026-10-15`)
  assert.equal(r.status, 200)
  const s = r.body
  assert.equal(s.totalCards, 4)
  assert.equal(s.archivedCards, 1)
  assert.deepEqual(s.byColumn.map((c) => [c.name, c.count, c.wipLimit]), [['Todo', 2, 5], ['Done', 2, null], ['Empty', 0, null]])
  assert.deepEqual(s.byLabel.map((l) => [l.name, l.count]), [['bug', 2], ['ux', 0]])
  assert.equal(s.byLabel[1].labelId, ux.id)
  assert.deepEqual(s.byPriority, { low: 1, normal: 2, high: 1 })
  assert.equal(s.overdue, 1, 'overdue ignores done cards')
  assert.equal(s.completed, 2)
  assert.equal(typeof s.avgCycleHours, 'number')
  assert.ok(s.avgCycleHours >= 0 && s.avgCycleHours < 1)
  assert.equal(Math.round(s.avgCycleHours * 10) / 10, s.avgCycleHours, 'one decimal place')
  const empty = await seedBoard(app.base, 'No stats', [])
  const e = (await call('GET', `/api/boards/${empty.board.id}/stats`)).body
  assert.equal(e.totalCards, 0)
  assert.equal(e.avgCycleHours, null)
  assert.equal((await call('GET', '/api/boards/missing/stats')).status, 404)
})

test('version, wipLimit and isDone survive a restart', async () => {
  const { board, cols } = await seedBoard(app.base, 'Persist3', [['A', ['a']]])
  await call('PATCH', `/api/columns/${cols[0].id}`, { wipLimit: 3, isDone: true })
  await call('PATCH', `/api/cards/${cols[0].cards[0]}`, { title: 'a2' })
  const before = await getBoard(app.base, board.id)
  await app.stop()
  app = await startApp({ dataDir: app.dataDir })
  const after = await getBoard(app.base, board.id)
  assert.deepEqual(after, before)
  assert.equal(after.columns[0].cards[0].version, 2)
})
