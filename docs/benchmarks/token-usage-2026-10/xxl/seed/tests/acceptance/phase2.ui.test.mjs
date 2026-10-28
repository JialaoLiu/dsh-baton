// Phase 2 acceptance: labels, details, search box, undo/redo, activity panel, import in the browser.
// See docs/phase2.md, section 前端.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { startApp, startBrowser, api, seedBoard, getBoard, titlesOf, cardsIn } from './helpers.mjs'

let app, browser, page, board, cols
before(async () => {
  app = await startApp()
  browser = await startBrowser()
  ;({ board, cols } = await seedBoard(app.base, 'UI two', [['Todo', ['Fix login bug', 'Write docs', 'Plan offsite']], ['Done', ['Shipped']]]))
  page = await browser.newPage(`${app.base}/#/boards/${board.id}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))}).length === 3`)
})
after(async () => { await browser?.close(); await app?.stop() })
const T = (id) => `[data-testid="${id}"]`
const card = (id) => `[data-testid="card"][data-card-id="${id}"]`
const visibleTitles = (col) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(cardsIn(col))})].filter(c => c.offsetParent !== null).map(c => c.querySelector('[data-testid="card-title"]').textContent.trim())`)

test('create labels and set labels, priority and due date in the detail view', async () => {
  await page.type(T('label-name-input'), 'bug')
  await page.type(T('label-color-input'), '#ff0000')
  await page.click(T('label-create'))
  await page.type(T('label-name-input'), 'docs')
  await page.type(T('label-color-input'), '#0000ff')
  await page.click(T('label-create'))
  const labels = await page.waitFor(`fetch('/api/boards/${board.id}').then(r => r.json()).then(b => b.labels.length === 2 && b.labels)`)
  const bug = labels.find((l) => l.name === 'bug')
  assert.equal(bug.color, '#ff0000')
  const fix = cols[0].cards[0]
  await page.click(`${card(fix)} ${T('card-title')}`)
  await page.waitFor(`document.querySelector('[data-testid="card-edit-priority"]')`)
  await page.evaluate(`(() => { const s = document.querySelector('[data-testid="card-edit-priority"]'); s.value = 'high'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await page.type(T('card-edit-due'), '2020-01-15')
  await page.evaluate(`(() => { const c = document.querySelector('[data-testid="card-edit-label"][data-label-id="${bug.id}"]'); if (!c.checked) c.click() })()`)
  await page.click(T('card-save'))
  await page.waitFor(`document.querySelector(${JSON.stringify(`${card(fix)} ${T('card-label')}`)})?.textContent.includes('bug')`)
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(`${card(fix)} ${T('card-priority')}`)}).textContent.trim()`), 'high')
  const due = await page.evaluate(`(() => { const d = document.querySelector(${JSON.stringify(`${card(fix)} ${T('card-due')}`)}); return d && { text: d.textContent, overdue: d.dataset.overdue } })()`)
  assert.match(due.text, /2020-01-15/)
  assert.equal(due.overdue, 'true')
  const saved = (await getBoard(app.base, board.id)).columns[0].cards[0]
  assert.equal(saved.priority, 'high')
  assert.equal(saved.dueDate, '2020-01-15')
  assert.deepEqual(saved.labels, [bug.id])
})

test('search box filters cards with the search syntax and clearing restores them', async () => {
  await page.type(T('search-input'), 'label:bug')
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))})].filter(c => c.offsetParent !== null).length === 1`, 3000)
  assert.deepEqual(await visibleTitles('Todo'), ['Fix login bug'])
  assert.deepEqual(await visibleTitles('Done'), [])
  await page.type(T('search-input'), '-docs')
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))})].filter(c => c.offsetParent !== null).length === 2`, 3000)
  assert.deepEqual(await visibleTitles('Todo'), ['Fix login bug', 'Plan offsite'])
  assert.deepEqual(await visibleTitles('Done'), ['Shipped'])
  await page.type(T('search-input'), '')
  await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(cardsIn('Todo'))})].filter(c => c.offsetParent !== null).length === 3`, 3000)
})

test('undo and redo buttons and keyboard shortcuts', async () => {
  const plan = cols[0].cards[2]
  await page.click(`${card(plan)} ${T('card-move-right')}`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 2`)
  await page.click(T('board-undo'))
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 1`)
  assert.deepEqual(titlesOf((await getBoard(app.base, board.id)).columns[0]), ['Fix login bug', 'Write docs', 'Plan offsite'])
  await page.click(T('board-redo'))
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 2`)
  await page.evaluate(`document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: navigator.platform.includes('Mac'), bubbles: true, cancelable: true }))`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 1`)
  await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', shiftKey: true, ctrlKey: true, metaKey: navigator.platform.includes('Mac'), bubbles: true, cancelable: true }))`)
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(cardsIn('Done'))}).length === 2`)
  // Inside an input the shortcut belongs to the input.
  const before = JSON.stringify(await getBoard(app.base, board.id))
  await page.evaluate(`(() => { const i = document.querySelector('[data-testid="search-input"]'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: navigator.platform.includes('Mac'), bubbles: true, cancelable: true })) })()`)
  await sleep(400)
  assert.equal(JSON.stringify(await getBoard(app.base, board.id)), before)
})

test('activity panel lists the newest change first and updates by itself', async () => {
  await page.evaluate(`document.activeElement?.blur()`)
  await page.waitFor(`document.querySelectorAll('[data-testid="activity-item"]').length > 0`)
  const docs = cols[0].cards[1]
  await page.click(`${card(docs)} ${T('card-move-right')}`)
  await page.waitFor(`document.querySelector('[data-testid="activity-panel"] [data-testid="activity-item"]')?.textContent.includes('Write docs')`)
})

test('archive from the detail view hides the card', async () => {
  const docs = cols[0].cards[1]
  await page.click(`${card(docs)} ${T('card-title')}`)
  await page.click(T('card-archive'))
  await page.waitFor(`!document.querySelector(${JSON.stringify(card(docs))}) || document.querySelector(${JSON.stringify(card(docs))}).offsetParent === null`)
  const c = (await getBoard(app.base, board.id, '?includeArchived=1')).columns[1].cards.find((x) => x.id === docs)
  assert.equal(c.archived, true)
})

test('export buttons exist and import adds a board on the list page', async () => {
  assert.equal(await page.count(T('board-export')), 1)
  assert.equal(await page.count(T('board-export-csv')), 1)
  const doc = { version: 1, board: { name: 'Imported via UI', labels: [{ name: 'x', color: '#123456' }], columns: [{ name: 'Only', cards: [{ title: 'From file', labels: ['x'] }] }] } }
  await page.click(T('back-to-boards'))
  await page.waitFor(`document.querySelector('[data-testid="board-import"]')`)
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="board-import"]')
    const dt = new DataTransfer()
    dt.items.add(new File([${JSON.stringify(JSON.stringify(doc))}], 'board.json', { type: 'application/json' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await page.waitFor(`[...document.querySelectorAll('[data-testid="board-item"]')].some(e => e.textContent.includes('Imported via UI'))`)
  const list = (await api(app.base, 'GET', '/api/boards')).body
  const imported = list.find((b) => b.name === 'Imported via UI')
  assert.ok(imported)
  assert.equal((await getBoard(app.base, imported.id)).columns[0].cards[0].title, 'From file')
  assert.deepEqual(page.errors, [], 'no uncaught errors in the page')
})
