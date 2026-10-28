// Phase 3 acceptance: WIP badge and settings, toasts for WIP and conflicts, live updates, bulk bar, stats panel.
// See docs/phase3.md, section 前端.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { startApp, startBrowser, api, seedBoard, getBoard, titlesOf, columnSel, cardsIn } from './helpers.mjs'

let app, browser, page, board, cols
before(async () => {
  app = await startApp()
  browser = await startBrowser()
  ;({ board, cols } = await seedBoard(app.base, 'UI three', [['Todo', ['t1', 't2', 't3']], ['Doing', ['d1']], ['Done', []]]))
  page = await browser.newPage(`${app.base}/#/boards/${board.id}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 3`)
})
after(async () => { await browser?.close(); await app?.stop() })
const T = (id) => `[data-testid="${id}"]`
const card = (id) => `[data-testid="card"][data-card-id="${id}"]`
const inCol = (name, id) => `${columnSel(name)} ${T(id)}`
const toastText = () => page.waitFor(`[...document.querySelectorAll('[data-testid="toast"]')].map(t => t.textContent).join(' ').trim()`, 4000)

test('column settings set a WIP limit and a done column', async () => {
  await page.click(inCol('Doing', 'column-settings'))
  await page.type(T('column-wip-input'), '2')
  await page.click(T('column-settings-save'))
  await page.waitFor(`document.querySelector(${JSON.stringify(inCol('Doing', 'column-wip'))})?.textContent.replace(/\\s/g, '').includes('1/2')`)
  await page.click(inCol('Done', 'column-settings'))
  await page.evaluate(`(() => { const c = document.querySelector('[data-testid="column-done-input"]'); if (!c.checked) c.click() })()`)
  await page.click(T('column-settings-save'))
  await page.waitFor(`document.querySelector(${JSON.stringify(columnSel('Done'))})?.dataset.done === 'true'`)
  const full = await getBoard(app.base, board.id)
  assert.equal(full.columns[1].wipLimit, 2)
  assert.equal(full.columns[2].isDone, true)
})

test('WIP badge fills up and a blocked move shows a toast', async () => {
  await page.click(`${card(cols[0].cards[0])} ${T('card-move-right')}`)
  await page.waitFor(`document.querySelector(${JSON.stringify(inCol('Doing', 'column-wip'))})?.dataset.full === 'true'`)
  assert.match(await page.evaluate(`document.querySelector(${JSON.stringify(inCol('Doing', 'column-wip'))}).textContent.replace(/\\s/g, '')`), /2\/2/)
  await page.click(`${card(cols[0].cards[1])} ${T('card-move-right')}`)
  assert.match(await toastText(), /上限|WIP/i)
  await sleep(300)
  assert.equal(await page.count(cardsIn('Doing')), 2, 'the page shows the server state after the refusal')
  assert.equal(await page.count(cardsIn('Todo')), 2)
})

test('changes from elsewhere appear without a reload', async () => {
  await api(app.base, 'POST', `/api/columns/${cols[2].id}/cards`, { title: 'added by API' })
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(cardsIn('Done'))})].some(c => c.textContent.includes('added by API'))`, 2500)
  await api(app.base, 'PATCH', `/api/cards/${cols[0].cards[2]}`, { title: 't3 renamed' })
  await page.waitFor(`document.querySelector(${JSON.stringify(`${card(cols[0].cards[2])} [data-testid="card-title"]`)})?.textContent.includes('t3 renamed')`, 2500)
  const second = await browser.newPage(`${app.base}/#/boards/${board.id}`)
  await second.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 2`)
  await second.click(`${card(cols[0].cards[2])} ${T('card-delete')}`)
  await page.waitFor(`!document.querySelector(${JSON.stringify(card(cols[0].cards[2]))})`, 2500)
  await second.close()
})

test('saving over someone else\'s change shows a conflict toast', async () => {
  const id = cols[0].cards[1]
  await page.click(`${card(id)} ${T('card-title')}`)
  await page.waitFor(`document.querySelector('[data-testid="card-edit-title"]')`)
  await api(app.base, 'PATCH', `/api/cards/${id}`, { title: 'changed elsewhere' })
  await sleep(300)
  await page.type(T('card-edit-title'), 'my edit')
  await page.click(T('card-save'))
  assert.match(await toastText(), /冲突|conflict/i)
  const c = (await getBoard(app.base, board.id)).columns[0].cards.find((x) => x.id === id)
  assert.equal(c.title, 'changed elsewhere', 'the stale save did not overwrite')
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
})

test('bulk bar moves and archives selected cards', async () => {
  await page.goto(`${app.base}/#/boards/${board.id}`)
  for (const t of ['b1', 'b2', 'b3']) await api(app.base, 'POST', `/api/columns/${cols[0].id}/cards`, { title: t })
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 4`)
  const ids = (await getBoard(app.base, board.id)).columns[0].cards.filter((c) => c.title.startsWith('b')).map((c) => c.id)
  assert.equal(await page.visibleCount(T('bulk-bar')), 0)
  for (const id of ids.slice(0, 2)) await page.click(`${card(id)} ${T('card-select')}`)
  await page.waitFor(`[...document.querySelectorAll('[data-testid="bulk-bar"]')].some(e => e.offsetParent !== null)`)
  await page.evaluate(`(() => { const s = document.querySelector('[data-testid="bulk-move-target"]'); s.value = ${JSON.stringify(cols[2].id)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await page.click(T('bulk-move'))
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 3`)
  assert.deepEqual(titlesOf((await getBoard(app.base, board.id)).columns[2]), ['added by API', 'b1', 'b2'])
  await page.waitFor(`![...document.querySelectorAll('[data-testid="bulk-bar"]')].some(e => e.offsetParent !== null)`, 2000)
  await page.click(`${card(ids[2])} ${T('card-select')}`)
  await page.click(T('bulk-archive'))
  await page.waitFor(`!document.querySelector(${JSON.stringify(card(ids[2]))}) || document.querySelector(${JSON.stringify(card(ids[2]))}).offsetParent === null`)
  assert.equal((await getBoard(app.base, board.id, '?includeArchived=1')).columns[0].cards.find((c) => c.id === ids[2]).archived, true)
})

test('stats panel shows totals and updates', async () => {
  await page.waitFor(`document.querySelector('[data-testid="stats-panel"]')`)
  const total = async () => Number((await page.evaluate(`document.querySelector('[data-testid="stats-total"]').textContent`)).match(/\d+/)?.[0])
  const apiTotal = (await api(app.base, 'GET', `/api/boards/${board.id}/stats`)).body.totalCards
  await page.waitFor(`Number(document.querySelector('[data-testid="stats-total"]').textContent.match(/\\d+/)?.[0]) === ${apiTotal}`, 3000)
  assert.match(await page.evaluate(`document.querySelector('[data-testid="stats-completed"]').textContent`), /3/)
  assert.match(await page.evaluate(`document.querySelector('[data-testid="stats-cycle"]').textContent`), /\d/)
  await api(app.base, 'POST', `/api/columns/${cols[1].id}/cards?force=1`, { title: 'one more' })
  await page.waitFor(`Number(document.querySelector('[data-testid="stats-total"]').textContent.match(/\\d+/)?.[0]) === ${apiTotal + 1}`, 3000)
  assert.equal(await total(), apiTotal + 1)
  assert.deepEqual(page.errors, [], 'no uncaught errors in the page')
})
