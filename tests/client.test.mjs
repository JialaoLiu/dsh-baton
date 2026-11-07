// The browser half's sender label, against a fake slot registry shaped like Harness's:
// up to 0.2.1 the label wraps the user renderer; from 0.2.2 it sits in the chat's seat above
// user messages (conversation.chat.user.before), and steering messages keep the wrapper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'host', 'lib', 'client.js'), 'utf8')

const SLOT = 'conversation.chat.node'
const BEFORE = 'conversation.chat.user.before'
const h = (type, props, ...children) => ({ type, props: props ?? {}, children })

function load() {
  let mod
  const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(require) } } }
  function require(name) {
    if (name === 'react') return { createElement: h, useState: (v) => [v, () => {}], useEffect: () => {} }
    throw new Error(`no ${name}`)
  }
  vm.runInNewContext(source, { window })
  return mod
}

// A registry where `declared` slots exist; the chat's own entries are registered first.
function harness({ seat }) {
  const entries = new Map()
  const declared = new Set([SLOT, 'plugins.bundle.activation', 'plugins.bundle.config'])
  const add = (options, component) => {
    const list = entries.get(options.name) ?? []
    list.push({ options, component, children: options.children })
    entries.set(options.name, list)
  }
  const Shipped = (props) => h('bubble', props)
  add({ name: SLOT, key: 'user', ...(seat ? { children: { [BEFORE]: { kind: 'chain', scope: 'session' } } } : {}) }, Shipped)
  add({ name: SLOT, key: 'steering' }, Shipped)
  if (seat) declared.add(BEFORE)
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key, vars) => `${key}:${vars?.name ?? ''}` },
    slots: {
      inject(key, callback) {
        if (!declared.has(key)) return
        const out = callback()
        if (out && typeof out[Symbol.iterator] === 'function' && !out.options) for (const _ of out);
      },
      register(options, component) { add(options, component); return options },
      entries: (key) => entries.get(key) ?? [],
    },
  }
  return { ctx, entries, Shipped }
}

const ours = (list) => list.filter((e) => e.options.priority === -100)
const node = (kind, rpcId) => ({ kind, data: { source: { kind: 'user', ...(rpcId ? { rpcId } : {}) } } })
const RPC = 'dsh-baton.claude.0b6f7d2e-0000-4000-8000-000000000000'

test('Harness up to 0.2.1: both user and steering messages are wrapped and labelled', () => {
  const mod = load()
  const { ctx, entries, Shipped } = harness({ seat: false })
  mod.apply(ctx)
  assert.deepEqual(ours(entries.get(SLOT)).map((e) => e.options.key), ['user', 'steering'])
  assert.equal(entries.get(BEFORE), undefined)
  const wrap = ours(entries.get(SLOT))[0].component
  const out = wrap({ node: node('user', RPC) })
  assert.equal(out.type, 'div')
  assert.match(JSON.stringify(out.children[0]), /sentFrom:Claude/)
  assert.equal(wrap({ node: node('user') }).type, Shipped)
})

test('Harness 0.2.2: the label sits in the seat above user messages; steering keeps the wrapper', () => {
  const mod = load()
  const { ctx, entries } = harness({ seat: true })
  mod.apply(ctx)
  assert.deepEqual(ours(entries.get(SLOT)).map((e) => e.options.key), ['steering'])
  const [seat] = entries.get(BEFORE)
  assert.equal(seat.options.select({ source: { rpcId: RPC }, kind: 'user' }), 'claude')
  assert.equal(seat.options.select({ source: { kind: 'user' }, kind: 'user' }), null)
  assert.equal(seat.options.select({ source: { rpcId: 'dsh-bridge.codex.x' } }), 'codex')
  assert.match(JSON.stringify(seat.component({ matched: 'codex' })), /sentFrom:ChatGPT/)
})

test('a wrapped renderer in Harness 0.2.2 gets a chain renderer that draws nothing', () => {
  const mod = load()
  const { ctx, entries, Shipped } = harness({ seat: true })
  mod.apply(ctx)
  const steer = ours(entries.get(SLOT))[0].component
  const out = steer({ node: node('steering', RPC) })
  const inner = out.children[1]
  assert.equal(inner.type, Shipped)
  assert.equal(typeof inner.props.renderSlotChain, 'function')
  assert.equal(inner.props.renderSlotChain(), null)
  const own = () => 'own'
  assert.equal(steer({ node: node('steering'), renderSlotChain: own }).props.renderSlotChain, own)
})
