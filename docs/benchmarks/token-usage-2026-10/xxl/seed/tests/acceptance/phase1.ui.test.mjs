// Phase 1 acceptance: the front end in headless Chrome. See docs/phase1.md, section 前端.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { startApp, startBrowser, api, getBoard, titlesOf, columnSel, cardsIn } from './helpers.mjs'

let app, browser, page
before(async () => { app = await startApp(); browser = await startBrowser(); page = await browser.newPage(`${app.base}/`) })
after(async () => { await browser?.close(); await app?.stop() })
const T = (id) => `[data-testid="${id}"]`
const cardTitles = (col) => page.texts(`${cardsIn(col)} ${T('card-title')}`)
const cardById = (id) => `[data-testid="card"][data-card-id="${id}"]`
async function cardId(title) {
  return page.waitFor(`[...document.querySelectorAll('[data-testid="card"]')].find(c => c.querySelector('[data-testid="card-title"]')?.textContent.trim() === ${JSON.stringify(title)})?.dataset.cardId`)
}

test('create a board from the list page and open it', async () => {
  await page.type(T('board-name-input'), 'Launch plan')
  await page.click(T('board-create'))
  await page.waitFor(`[...document.querySelectorAll('[data-testid="board-item"]')].some(e => e.textContent.includes('Launch plan'))`)
  await page.type(T('board-name-input'), 'Second board', { enter: true })
  await page.waitFor(`[...document.querySelectorAll('[data-testid="board-item"]')].some(e => e.textContent.includes('Second board'))`)
  const boards = (await api(app.base, 'GET', '/api/boards')).body.map((b) => b.name)
  assert.deepEqual(boards, ['Launch plan', 'Second board'])
  await page.evaluate(`[...document.querySelectorAll('[data-testid="board-item"]')].find(e => e.textContent.includes('Launch plan')).click()`)
  await page.waitFor(`location.hash.startsWith('#/boards/')`)
  await page.waitFor(`document.querySelector('[data-testid="board-title"]')?.textContent.includes('Launch plan')`)
})

test('add columns and cards', async () => {
  for (const name of ['Todo', 'Doing', 'Done']) {
    await page.type(T('column-name-input'), name)
    await page.click(T('column-create'))
    await page.waitFor(`document.querySelector(${JSON.stringify(columnSel(name))})`)
  }
  assert.deepEqual(await page.texts(T('column-title')), ['Todo', 'Doing', 'Done'])
  await page.type(`${columnSel('Todo')} ${T('card-title-input')}`, 'Write spec')
  await page.click(`${columnSel('Todo')} ${T('card-create')}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 1`)
  for (const t of ['Build API', 'Ship it']) {
    await page.type(`${columnSel('Todo')} ${T('card-title-input')}`, t, { enter: true })
    await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))})].some(c => c.textContent.includes(${JSON.stringify(t)}))`)
  }
  assert.deepEqual(await cardTitles('Todo'), ['Write spec', 'Build API', 'Ship it'])
  const boardId = await page.evaluate(`location.hash.split('/')[2]`)
  assert.deepEqual(titlesOf((await getBoard(app.base, boardId)).columns[0]), ['Write spec', 'Build API', 'Ship it'])
})

test('move buttons move cards between and within columns', async () => {
  const id = await cardId('Build API')
  await page.click(`${cardById(id)} ${T('card-move-right')}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Doing'))}).length === 1`)
  assert.deepEqual(await cardTitles('Todo'), ['Write spec', 'Ship it'])
  assert.deepEqual(await cardTitles('Doing'), ['Build API'])
  const ship = await cardId('Ship it')
  await page.click(`${cardById(ship)} ${T('card-move-up')}`)
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(`${cardsIn('Todo')} [data-testid="card-title"]`)})].map(e => e.textContent.trim()).join('|') === 'Ship it|Write spec'`)
  await page.click(`${cardById(ship)} ${T('card-move-down')}`)
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(`${cardsIn('Todo')} [data-testid="card-title"]`)})].map(e => e.textContent.trim()).join('|') === 'Write spec|Ship it'`)
  await page.click(`${cardById(id)} ${T('card-move-left')}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 3`)
  assert.deepEqual(await cardTitles('Todo'), ['Write spec', 'Ship it', 'Build API'])
  const boardId = await page.evaluate(`location.hash.split('/')[2]`)
  const full = await getBoard(app.base, boardId)
  assert.deepEqual(titlesOf(full.columns[0]), ['Write spec', 'Ship it', 'Build API'])
})

test('edit a card in its detail view', async () => {
  const id = await cardId('Write spec')
  await page.click(`${cardById(id)} ${T('card-title')}`)
  await page.type(T('card-edit-title'), 'Write the spec')
  await page.type(T('card-edit-description'), 'Two pages, with API table')
  await page.click(T('card-save'))
  await page.waitFor(`(${JSON.stringify(cardById(id))} && document.querySelector(${JSON.stringify(`${cardById(id)} [data-testid="card-title"]`)})?.textContent.trim() === 'Write the spec')`)
  const card = (await api(app.base, 'GET', `/api/boards/${await page.evaluate(`location.hash.split('/')[2]`)}`)).body.columns[0].cards.find((c) => c.id === id)
  assert.equal(card.title, 'Write the spec')
  assert.equal(card.description, 'Two pages, with API table')
})

test('delete a card without a confirm dialog', async () => {
  const id = await cardId('Ship it')
  await page.click(`${cardById(id)} ${T('card-delete')}`)
  await page.waitFor(`!document.querySelector(${JSON.stringify(cardById(id))})`)
  assert.deepEqual(await cardTitles('Todo'), ['Write the spec', 'Build API'])
})

test('reload keeps the board and its data; back goes to the list', async () => {
  await page.reload()
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 2`)
  assert.match(await page.evaluate('document.querySelector(\'[data-testid="board-title"]\').textContent'), /Launch plan/)
  assert.deepEqual(await cardTitles('Todo'), ['Write the spec', 'Build API'])
  await page.click(T('back-to-boards'))
  await page.waitFor(`document.querySelectorAll('[data-testid="board-item"]').length === 2`)
})

test('changes made through the API show after opening the board', async () => {
  const b = (await api(app.base, 'POST', '/api/boards', { name: 'From API' })).body
  const c = (await api(app.base, 'POST', `/api/boards/${b.id}/columns`, { name: 'Inbox' })).body
  await api(app.base, 'POST', `/api/columns/${c.id}/cards`, { title: 'Hello <b>world</b>' })
  await page.goto(`${app.base}/#/boards/${b.id}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Inbox'))}).length === 1`)
  assert.deepEqual(await cardTitles('Inbox'), ['Hello <b>world</b>'], 'titles are shown as text, not HTML')
  await sleep(100)
  assert.deepEqual(page.errors, [], 'no uncaught errors in the page')
})
