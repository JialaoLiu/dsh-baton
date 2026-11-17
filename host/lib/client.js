// dsh-baton-host, browser half. Two jobs:
//   - On the Plugins page: right after the plugin is switched on, and on its detail page,
//     say whether the host half registered the MCP server for Claude Code, Codex and Antigravity
//     (it serves the outcome at /dsh-baton/status).
//   - In the chat: label messages sent through dsh-baton with their sender ("Sent by
//     Claude from another chat"). The host half puts the sender
// into the prompt's request id ("dsh-baton.<sender>.<uuid>"); the chat records it as
// the user message's source.rpcId, so the label survives reloads with no extra state.
//
// It wraps the chat's own user-message renderer: the wrapper registers at a lower
// slot priority (the lowest renders), draws the label, then renders the shipped
// renderer unchanged. If the wrapper throws, the slot retires it and the shipped
// renderer takes over again.
//
// Hand-written in the client module format (no build step): the host serves this
// file as the package's "./client" export.
window.__ModuleLoader__.load({
  id: 'dsh-baton-host',
  factory: (require) => {
    const module = { exports: {} }
    const { createElement: h, useState, useEffect, useRef } = require('react')
    // Harness's dialog and button; without them (an older or newer Harness), plain elements.
    let ui = null
    try { ui = require('@deepseek-ai/dsh-client-ui-primitives') } catch { /* fall back */ }

    const SLOT = 'conversation.chat.node'
    const KEYS = ['user', 'steering']
    const PRIORITY = -100
    const NS = 'dsh-baton'
    // dsh-bridge: messages sent before the project was renamed.
    const RPC_RE = /^dsh-(?:baton|bridge)\.([a-z0-9-]{1,32})\./
    // Codex shows as ChatGPT, the way the ChatGPT app labels its own cross-chat messages.
    const NAMES = { claude: 'Claude', codex: 'ChatGPT', antigravity: 'Antigravity' }

    const PACKAGE = 'dsh-baton-host'
    const SETUP = 'npx -y dsh-baton-mcp setup'

    const zh = {
      sentFrom: '由 {name} 从另一个聊天发送',
      readyTitle: 'dsh-baton 已就绪',
      failTitle: 'dsh-baton 还差一步',
      pending: '正在为 Claude Code、Codex 和 Antigravity 注册 dsh-baton…',
      ready: '已为 {clients} 注册 dsh-baton。在里面新开一个对话，就能用 dsh_* 工具。',
      restartAg: '在 Antigravity 里要先重启一次它。',
      partial: '{clients} 没能注册：',
      badJson: '{file} 不是有效的 JSON，改好后重启 Harness。',
      noNode: '没找到 Node.js 22.15 或更新版本。装好 Node.js 后，',
      noClients: '没找到 Claude Code、Codex 或 Antigravity。装好其中一个之后，',
      failed: '没能自动注册 MCP。',
      runSetup: '请在终端运行 {cmd}。',
      unknown: '如果新对话里没有 dsh_* 工具，请在终端运行 {cmd}。',
      off: '已关闭自动注册（DSH_BATON_AUTO_REGISTER=0）。',
      ok: '知道了',
      status: 'MCP 注册',
      registered: '已注册',
      notInstalled: '未安装',
      notRegistered: '未注册',
      and: '和',
      comma: '、',
      handoverTitle: '转交默认模型',
      handoverModel: '模型',
      handoverEffort: '推理强度',
      approvalsLabel: '转交会话里的审批',
      approvalsAllow: '自动允许',
      approvalsAsk: '交给我在 Harness 里处理',
      followDefaultPlain: '跟随默认',
      effortDefault: '跟随模型默认',
      missingOption: '{model}（已不在 Harness 里）',
      searchModels: '搜索模型…',
      noMatch: '没有匹配的模型',
      handoverMissing: '{model} 已不在 Harness 的模型列表里，转交会改用 Harness 默认。',
      handoverUnsupported: '这个版本的 Harness 不能按会话选模型，这里没法设置。',
      handoverLoadFailed: '没能读取模型列表。',
      handoverUnreadable: '设置文件读不出来（{error}），转交暂时不用这里的设置。重新选一次就会写好。',
      saved: '已保存',
      saveFailed: '没能保存：{error}',
      effortOff: '关',
      effortLow: '低',
      effortMedium: '中',
      effortHigh: '高',
      effortMax: '最高',
    }
    const en = {
      sentFrom: 'Sent by {name} from another chat',
      readyTitle: 'dsh-baton is ready',
      failTitle: 'dsh-baton needs one more step',
      pending: 'Registering dsh-baton for Claude Code, Codex and Antigravity…',
      ready: 'dsh-baton is registered for {clients}. Start a new conversation there to use the dsh_* tools.',
      restartAg: 'Restart Antigravity first.',
      partial: 'Could not register for {clients}: ',
      badJson: '{file} is not valid JSON: fix it, then restart Harness.',
      noNode: 'Node.js 22.15 or later was not found. Once it is installed, ',
      noClients: 'None of Claude Code, Codex or Antigravity was found. Once one is installed, ',
      failed: 'The MCP server could not be registered automatically. ',
      runSetup: 'run {cmd} in a terminal.',
      unknown: 'If new conversations have no dsh_* tools, run {cmd} in a terminal.',
      off: 'Automatic registration is off (DSH_BATON_AUTO_REGISTER=0).',
      ok: 'OK',
      status: 'MCP registration',
      registered: 'registered',
      notInstalled: 'not installed',
      notRegistered: 'not registered',
      and: 'and',
      comma: ', ',
      handoverTitle: 'Default model for hand-overs',
      handoverModel: 'Model',
      handoverEffort: 'Reasoning effort',
      approvalsLabel: 'Hand-over approvals',
      approvalsAllow: 'Allow automatically',
      approvalsAsk: 'Leave them to me in Harness',
      followDefaultPlain: 'Harness default',
      effortDefault: "The model's default",
      missingOption: '{model} (no longer in Harness)',
      searchModels: 'Search models…',
      noMatch: 'No model matches',
      handoverMissing: "{model} is no longer in Harness's model list, so hand-overs use Harness's default.",
      handoverUnsupported: 'This Harness cannot choose a model per session, so this cannot be set here.',
      handoverLoadFailed: 'The model list could not be read.',
      handoverUnreadable: 'The settings file could not be read ({error}), so hand-overs do not use these settings for now. Choosing again writes it afresh.',
      saved: 'Saved',
      saveFailed: 'Not saved: {error}',
      effortOff: 'Off',
      effortLow: 'Low',
      effortMedium: 'Medium',
      effortHigh: 'High',
      effortMax: 'Max',
    }

    // --- Plugins page ------------------------------------------------------------

    const statusUrl = () => new URL('dsh-baton/status', document.baseURI).pathname
    const REGISTERED = ['registered', 'unchanged', 'kept']

    // The host half registers right after it starts, so poll until it says it is done.
    function useRegistration() {
      const [reg, setReg] = useState(null)
      useEffect(() => {
        let stopped = false
        let tries = 0
        const poll = async () => {
          let next = null
          try {
            const res = await fetch(statusUrl(), { cache: 'no-store' })
            if (res.ok) next = (await res.json()).registration
          } catch { /* not served yet */ }
          if (stopped) return
          if (next && next.state !== 'pending') return setReg(next)
          if (++tries >= 30) return setReg({ state: 'unknown' })
          setTimeout(poll, 700)
        }
        poll()
        return () => { stopped = true }
      }, [])
      return reg
    }

    // What to tell the user: [title or null, text]. null while the host is still working.
    function describe(reg, t) {
      if (!reg || reg.state === 'pending') return [null, t('pending')]
      if (reg.state === 'off') return [t('readyTitle'), t('off')]
      if (reg.state === 'unknown') return [t('readyTitle'), t('unknown', { cmd: SETUP })]
      const clients = reg.clients ?? []
      const done = clients.filter((c) => REGISTERED.includes(c.state)).map((c) => c.label)
      const failed = clients.filter((c) => c.state === 'failed').map((c) => c.label)
      const list = (names) => (names.length > 2 ? `${names.slice(0, -1).join(t('comma'))} ${t('and')} ${names.at(-1)}` : names.join(` ${t('and')} `))
      // A config file that does not parse: setup would fail the same way, so the file is named.
      const broken = clients.filter((c) => c.state === 'failed' && c.error === 'bad-json')
      const fix = broken.length
        ? broken.map((c) => t('badJson', { file: c.file })).join(' ')
        : (reg.error === 'no-node' ? t('noNode') : reg.error === 'no-clients' ? t('noClients') : '') + t('runSetup', { cmd: SETUP })
      // Antigravity starts its MCP servers only when it starts: a new entry needs a restart.
      const fresh = clients.some((c) => c.id === 'antigravity' && c.state === 'registered')
      const ready = t('ready', { clients: list(done) }) + (fresh ? ` ${t('restartAg')}` : '')
      if (reg.ok) return [t('readyTitle'), ready]
      if (done.length) return [t('failTitle'), `${ready} ${t('partial', { clients: list(failed) })}${fix}`]
      return [t('failTitle'), (reg.error === 'no-node' || reg.error === 'no-clients' ? '' : t('failed')) + fix]
    }

    // Shown once, right after "Enable now".
    function wrapActivation(t) {
      return function DshBatonActivation({ onDismiss }) {
        const reg = useRegistration()
        const [title, text] = describe(reg, t)
        if (ui?.Modal && ui?.Button) {
          return h(ui.Modal, {
            open: true, title: title ?? t('readyTitle'), closeLabel: t('ok'), onClose: onDismiss,
            footer: h(ui.Button, { variant: 'primary', 'data-modal-autofocus': true, onClick: onDismiss }, t('ok')),
          }, h('p', null, text))
        }
        return h('div', { role: 'status', style: { margin: '12px 0', padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-primary)' } },
          title ? h('strong', null, title) : null,
          h('p', { style: { margin: '6px 0' } }, text),
          h('button', { type: 'button', onClick: onDismiss }, t('ok')))
      }
    }

    // The model and reasoning effort new hand-over sessions start on (host: /dsh-baton/handover).
    // A change is saved at once; the host checks it against Harness's model list.
    const handoverUrl = () => new URL('dsh-baton/handover', document.baseURI).pathname
    const EFFORT_KEYS = { off: 'effortOff', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', max: 'effortMax' }
    const FIELD = { display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }
    // The detail page's sections as Harness's own settings cards: rows with the name on the
    // left and the value or control on the right, so nothing stretches across the page.
    const STROKE = 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2))'
    const CARD = { display: 'flex', flexDirection: 'column', maxWidth: 560, borderRadius: 'var(--dsw-radius-lg, 10px)', border: `0.5px solid ${STROKE}`, background: 'var(--dsw-alias-settings-card-fill, transparent)' }
    // A row of a card; an optional first child that is a plain style object adjusts the row.
    const cardRow = (key, first, ...children) => {
      const own = children[0] && typeof children[0] === 'object' && !children[0].$$typeof && !Array.isArray(children[0]) && children[0] !== null && !('props' in children[0]) ? children.shift() : {}
      return h('div', { key, style: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, padding: '8px 14px', boxSizing: 'border-box', ...(first ? {} : { borderTop: `0.5px solid ${STROKE}` }), ...own } }, ...children)
    }
    const SECTION = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }
    const HEADING = { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }
    const ROW_NAME = { flex: '1 1 auto', minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 13 }
    // A dropdown in the style of Harness's own model menu (its theme tokens): a quiet trigger,
    // an elevated card with group headings, a search box for long lists, a check on the choice
    // and the detail (a price multiplier, a provider) muted on the right. Keyboard: arrows, Enter, Escape.
    const CHEVRON = h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-caption)' } },
      h('path', { d: 'M3 4.5 6 7.5 9 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const CHECK = h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true, style: { flex: '0 0 auto', color: 'var(--dsw-alias-state-business-primary)' } },
      h('path', { d: 'M3 7.2 5.8 10 11 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    const MUTED = { color: 'var(--dsw-alias-label-caption)', whiteSpace: 'nowrap', flex: '0 0 auto' }
    const CLIP = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    function Picker({ label, value, items, disabled, onPick, searchable, placeholder, empty, chosenDetail }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(-1)
      const root = useRef(null)
      const chosen = items.find((i) => i.value === value) ?? items[0]
      const q = query.trim().toLowerCase()
      const shown = items.filter((i) => !q || `${i.label} ${i.detail ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q))
      const pickable = shown.filter((i) => !i.disabled)
      useEffect(() => {
        if (!open) return
        const away = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
      }, [open])
      useEffect(() => { if (!open) { setQuery(''); setActive(-1) } }, [open])
      const pick = (i) => { setOpen(false); if (!i.disabled && i.value !== value) onPick(i.value) }
      const onKey = (e) => {
        if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false) } return }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (!open) return setOpen(true)
          const n = pickable.length
          if (n) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n))
          return
        }
        if (e.key === 'Enter' && open && pickable[active]) { e.preventDefault(); pick(pickable[active]) }
      }
      const trigger = h('button', {
        type: 'button', disabled, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': label,
        onClick: () => setOpen((o) => !o), onKeyDown: onKey,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34, padding: '0 10px', boxSizing: 'border-box',
          border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md, 8px)',
          background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', color: disabled ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-label-primary)',
          font: 'inherit', fontSize: 13, textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
        },
      },
      h('span', { style: { ...CLIP, flex: '1 1 auto' } }, chosen?.label ?? ''),
      (chosenDetail ?? chosen?.detail) ? h('span', { style: { ...MUTED, fontSize: 12 } }, chosenDetail ?? chosen.detail) : null,
      CHEVRON)
      let lastGroup
      const rows = []
      for (const i of shown) {
        if (i.group && i.group !== lastGroup) {
          lastGroup = i.group
          rows.push(h('div', { key: `g:${i.group}`, role: 'presentation', style: { padding: '8px 8px 4px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, i.group))
        }
        const on = i.value === value
        const hot = pickable[active] === i
        rows.push(h('div', {
          key: `o:${i.value}`, role: 'option', 'aria-selected': on, 'aria-disabled': i.disabled || undefined,
          onMouseDown: (e) => e.preventDefault(), onClick: () => pick(i), onMouseEnter: () => setActive(pickable.indexOf(i)),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '5px 8px', borderRadius: 'var(--dsw-radius-md, 8px)',
            background: hot ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', cursor: i.disabled ? 'default' : 'pointer', fontSize: 13,
            color: i.disabled ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-label-primary)',
          },
        },
        h('span', { style: { ...CLIP, flex: '1 1 auto', fontWeight: on ? 600 : 400 } }, i.label),
        i.detail ? h('span', { style: { ...MUTED, fontSize: 12 } }, i.detail) : null,
        h('span', { style: { width: 14, display: 'inline-flex' } }, on ? CHECK : null)))
      }
      const card = open ? h('div', {
        role: 'listbox', 'aria-label': label,
        style: {
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: '100%', width: 'max-content', maxWidth: 360, zIndex: 1100, display: 'flex', flexDirection: 'column',
          maxHeight: 360, padding: 4, boxSizing: 'border-box', borderRadius: 'var(--dsw-radius-lg, 10px)',
          background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base))', boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.25))',
          border: '0.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)',
        },
      },
      searchable ? h('input', {
        autoFocus: true, value: query, placeholder, onKeyDown: onKey,
        onChange: (e) => { setQuery(e.target.value); setActive(0) },
        style: { margin: '2px 0 4px', padding: '6px 8px', border: 'none', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', outline: 'none', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 },
      }) : null,
      h('div', { style: { overflowY: 'auto', minHeight: 0 } },
        ...(rows.length ? rows : [h('div', { key: 'none', style: { padding: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, empty)]))) : null
      return h('div', { ref: root, style: { position: 'relative' } }, trigger, card)
    }
    // "Fast · x0.34" (a WorkBuddy plugin puts the price in the name): the name, and the price apart.
    const splitName = (name) => { const m = /^(.*\S)\s+·\s+(x\d+(?:\.\d+)?)$/.exec(String(name ?? '')); return m ? [m[1], m[2]] : [String(name ?? ''), null] }
    function HandoverSettings({ t }) {
      const [view, setView] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      // Right after "Enable now" the host may not serve the route yet: ask again for a while.
      useEffect(() => {
        let stopped = false
        let tries = 0
        const load = async () => {
          let next = null
          try {
            const res = await fetch(handoverUrl(), { cache: 'no-store' })
            if (res.ok) next = await res.json()
          } catch { /* not served yet */ }
          if (stopped) return
          if (next) return setView(next)
          if (++tries >= 15) return setView({ failed: true })
          setTimeout(load, 700)
        }
        load()
        return () => { stopped = true }
      }, [])
      const title = h('span', { style: HEADING }, t('handoverTitle'))
      if (!view) return null
      if (view.failed) return h('div', { style: FIELD }, title, h('span', null, t('handoverLoadFailed')))
      // A Harness that cannot choose a model per session still has the approvals choice.
      const modelsOk = view.supported !== false
      const key = (m) => `${m.provider}/${m.model}`
      const models = view.models ?? []
      const current = models.find((m) => key(m) === view.model)
      const def = view.default ? models.find((m) => m.provider === view.default.provider && m.model === view.default.model) : null
      // Efforts come as { id, name }; ours are translated, any other shows Harness's name.
      const effortList = (m) => (m ? m.reasoning_efforts ?? [] : def?.reasoning_efforts ?? []).map((e) => (typeof e === 'string' ? { id: e, name: e } : e))
      const effortsOf = (m) => effortList(m).map((e) => e.id)
      const efforts = effortsOf(current)
      const effortName = (id) => (EFFORT_KEYS[id] ? t(EFFORT_KEYS[id]) : effortList(current).find((e) => e.id === id)?.name ?? id)
      async function save(next) {
        setBusy(true)
        setNote(null)
        try {
          const res = await fetch(handoverUrl(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-baton': 'handover' }, body: JSON.stringify(next) })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          setView(body)
          setNote(t('saved'))
        } catch (error) {
          setNote(t('saveFailed', { error: error?.message ?? String(error) }))
        } finally {
          setBusy(false)
        }
      }
      function pickModel(value) {
        const m = models.find((x) => key(x) === value)
        // An effort the new model does not have goes back to the model's own default.
        const keep = view.reasoning_effort && effortsOf(m).includes(view.reasoning_effort) ? view.reasoning_effort : null
        save({ model: value || null, reasoning_effort: keep })
      }
      const providerName = (p) => models.find((m) => m.provider === p)?.provider_name ?? p
      const modelItems = [
        // Short in the narrow trigger: the model Harness defaults to now goes on the right, muted.
        { value: '', label: t('followDefaultPlain'), ...(def ? { detail: def.name } : {}) },
        ...(view.model && !current ? [{ value: view.model, label: t('missingOption', { model: view.model }), disabled: true }] : []),
        // One group per provider, in Harness's order, as in Harness's own model menu.
        ...models.map((m) => { const [name, price] = splitName(m.name); return { value: key(m), label: name, detail: price, group: providerName(m.provider) } }),
      ]
      // The closed trigger shows the provider too: names repeat across providers.
      const chosenItem = modelItems.find((i) => i.value === (view.model ?? ''))
      const chosenDetail = chosenItem?.group ? [chosenItem.detail, chosenItem.group].filter(Boolean).join(' · ') : undefined
      const effortItems = [
        { value: '', label: t('effortDefault') },
        ...(view.reasoning_effort && !efforts.includes(view.reasoning_effort) ? [{ value: view.reasoning_effort, label: effortName(view.reasoning_effort), disabled: true }] : []),
        ...efforts.map((e) => ({ value: e, label: effortName(e) })),
      ]
      const row = (key, label, control, first = false) => cardRow(key, first, h('span', { style: ROW_NAME }, label), h('div', { style: { flex: '0 0 260px', width: 260 } }, control))
      return h('div', { style: { ...SECTION, maxWidth: 440 }, 'data-dsh-baton-handover': '' },
        title,
        modelsOk ? null : h('span', { style: { fontSize: 12 } }, t('handoverUnsupported')),
        h('div', { style: { ...CARD, maxWidth: 440 } },
        modelsOk && row('model', t('handoverModel'), h(Picker, {
          label: t('handoverModel'), value: view.model ?? '', items: modelItems, chosenDetail, disabled: busy, onPick: pickModel,
          searchable: models.length > 8, placeholder: t('searchModels'), empty: t('noMatch'),
        }), true),
        modelsOk && row('effort', t('handoverEffort'), h(Picker, {
          label: t('handoverEffort'), value: view.reasoning_effort ?? '', items: effortItems, disabled: busy || (!efforts.length && !view.reasoning_effort),
          onPick: (v) => save({ model: view.model ?? null, reasoning_effort: v || null }), empty: t('noMatch'),
        })),
        row('approvals', t('approvalsLabel'), h(Picker, {
          label: t('approvalsLabel'), value: view.approvals ?? 'allow', disabled: busy,
          items: [{ value: 'allow', label: t('approvalsAllow') }, { value: 'ask', label: t('approvalsAsk') }],
          onPick: (v) => save({ approvals: v }), empty: t('noMatch'),
        }), !modelsOk)),
        view.missing ? h('span', null, t('handoverMissing', { model: view.model })) : null,
        view.unreadable ? h('span', null, t('handoverUnreadable', { error: view.unreadable })) : null,
        note ? h('span', { role: 'status', style: { fontSize: 12 } }, note) : null)
    }

    // The plugin's detail page: one line per client, then the hand-over defaults.
    function wrapDetails(t) {
      return function DshBatonStatus({ view }) {
        const reg = useRegistration()
        if (view === 'summary') return null
        const [, text] = describe(reg, t)
        // One row per client: its mark and name, and its state as a dot and a word on the right.
        const state = (s) => (REGISTERED.includes(s)
          ? [t('registered'), 'var(--dsw-alias-state-success-primary, #2ea44f)']
          : s === 'not-installed' ? [t('notInstalled'), 'var(--dsw-alias-label-dimmed, #8b949e)'] : [t('notRegistered'), 'var(--dsw-alias-state-warn-primary, #d29922)'])
        const clients = reg?.clients ?? []
        const clientRow = (c, i) => {
          const [word, colour] = state(c.state)
          const mark = MARKS[c.id]
          return cardRow(c.id, i === 0, { minHeight: 40 },
            mark ? h('svg', { width: 18, height: 18, viewBox: mark.viewBox, 'aria-hidden': true, style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-primary)' } }, h('path', { d: mark.d, fill: 'currentColor' })) : null,
            h('span', { style: { ...ROW_NAME, fontWeight: 500 } }, c.label),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              h('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', background: colour } }), word))
        }
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 20, color: 'var(--dsw-alias-label-secondary)' } },
          h('div', { style: { ...SECTION, maxWidth: 380 } },
            h('span', { style: HEADING }, t('status')),
            clients.length ? h('div', { style: { ...CARD, maxWidth: 380 } }, ...clients.map(clientRow)) : null,
            h('span', { style: { fontSize: 12 } }, text)),
          h(HandoverSettings, { t }))
      }
    }

    function senderFrom(source) {
      const rpcId = source?.rpcId
      const m = typeof rpcId === 'string' ? RPC_RE.exec(rpcId) : null
      return m ? m[1] : null
    }
    const senderOf = (node) => senderFrom(node?.data?.source)
    const nameOf = (sender) => NAMES[sender] ?? sender.charAt(0).toUpperCase() + sender.slice(1)

    // Sender marks, drawn in the label's text colour like ChatGPT's own "sent from another chat" line.
    // Codex's and Antigravity's are the monochrome marks of lobe-icons (MIT).
    const MARKS = {
      antigravity: { viewBox: '0 0 24 24', d: 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z' },
      claude: { viewBox: '0 0 248 248', d: 'M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z' },
      codex: { viewBox: '0 0 24 24', d: 'M9.20509 8.76514V6.50548C9.20509 6.31517 9.27649 6.17237 9.44293 6.07733L13.9861 3.46091C14.6046 3.10416 15.342 2.93772 16.103 2.93772C18.9573 2.93772 20.7651 5.14986 20.7651 7.50457C20.7651 7.67101 20.7651 7.86132 20.7412 8.05164L16.0316 5.29243C15.7462 5.12599 15.4607 5.12599 15.1753 5.29243L9.20509 8.76514ZM19.8136 17.566V12.1665C19.8136 11.8334 19.6708 11.5955 19.3854 11.4291L13.4152 7.95637L15.3656 6.83836C15.5321 6.74332 15.6749 6.74332 15.8413 6.83836L20.3845 9.45477C21.6928 10.216 22.5728 11.8334 22.5728 13.4032C22.5728 15.2108 21.5025 16.8759 19.8136 17.5657V17.566ZM7.80173 12.8088L5.8513 11.6671C5.68486 11.5721 5.61346 11.4293 5.61346 11.239V6.00616C5.61346 3.46114 7.56389 1.53436 10.2042 1.53436C11.2033 1.53436 12.1307 1.86746 12.9159 2.46205L8.2301 5.17374C7.94475 5.34018 7.80196 5.57801 7.80196 5.91112V12.809L7.80173 12.8088ZM12 15.2349L9.20509 13.6651V10.3352L12 8.76537L14.7947 10.3352V13.6651L12 15.2349ZM13.7958 22.4659C12.7967 22.4659 11.8693 22.1328 11.0841 21.5382L15.7699 18.8265C16.0553 18.6601 16.198 18.4223 16.198 18.0892V11.1912L18.1723 12.3329C18.3388 12.4279 18.4102 12.5707 18.4102 12.7611V17.9939C18.4102 20.5389 16.4359 22.4657 13.7958 22.4657V22.4659ZM8.15848 17.1617L3.61528 14.5453C2.30696 13.784 1.42701 12.1667 1.42701 10.5969C1.42701 8.76537 2.52115 7.12417 4.20987 6.43431V11.8575C4.20987 12.1906 4.35266 12.4284 4.63802 12.5948L10.5846 16.0437L8.63415 17.1617C8.46771 17.2567 8.32492 17.2567 8.15848 17.1617ZM7.897 21.0626C5.20919 21.0626 3.23488 19.0407 3.23488 16.5432C3.23488 16.3529 3.25875 16.1626 3.2824 15.9723L7.96817 18.684C8.25352 18.8504 8.53911 18.8504 8.82447 18.684L14.7947 15.2351V17.4948C14.7947 17.6851 14.7233 17.8279 14.5568 17.9229L10.0136 20.5394C9.39518 20.8961 8.6578 21.0626 7.89677 21.0626H7.897ZM13.7958 23.8929C16.6739 23.8929 19.0762 21.8475 19.6235 19.1358C22.2874 18.4459 24 15.9484 24 13.4034C24 11.7383 23.2865 10.121 22.002 8.95546C22.121 8.45591 22.1924 7.95637 22.1924 7.45705C22.1924 4.05573 19.4331 1.51048 16.2458 1.51048C15.6037 1.51048 14.9852 1.60553 14.3668 1.81971C13.2963 0.773101 11.8215 0.107117 10.2042 0.107117C7.32606 0.107117 4.92383 2.15259 4.37653 4.86428C1.7126 5.55414 0 8.05164 0 10.5967C0 12.2617 0.713506 13.8791 1.99795 15.0446C1.87904 15.5441 1.80764 16.0437 1.80764 16.543C1.80764 19.9443 4.56685 22.4896 7.75421 22.4896C8.39632 22.4896 9.01478 22.3945 9.63324 22.1803C10.7035 23.2269 12.1783 23.8929 13.7958 23.8929Z' },
    }

    // Any other sender: a speech bubble with an arrow, "came in from another conversation".
    function Icon({ sender }) {
      const box = { width: 14, height: 14, 'aria-hidden': true, style: { flex: 'none' } }
      const mark = MARKS[sender]
      if (mark) return h('svg', { ...box, viewBox: mark.viewBox }, h('path', { d: mark.d, fill: 'currentColor' }))
      return h('svg', { ...box, viewBox: '0 0 16 16', fill: 'none' },
        h('path', { d: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { d: 'M6 7h4M8.5 5.5 10 7 8.5 8.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function Label({ sender, text }) {
      return h('div', {
        'data-dsh-baton-sender': '',
        style: {
          display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: '20px',
          marginBottom: 4, paddingRight: 4,
        },
      }, h(Icon, { sender }), h('span', null, text))
    }

    // The renderer this wrapper shadows: the best-ranked entry for the key that is not ours.
    function shipped(ctx, key, own) {
      return ctx.slots.entries(SLOT)
        .filter((e) => e.options?.key === key && e.component !== own && typeof e.component !== 'string')
        .sort((a, b) => (a.options?.priority ?? 0) - (b.options?.priority ?? 0))[0]?.component
    }

    function wrapperFor(ctx, key, t) {
      function DshBatonUserMessage(props) {
        const Inner = shipped(ctx, key, DshBatonUserMessage)
        if (!Inner) return null
        // Harness 0.2.2 hands each renderer the chain renderer of its own registration; a wrapper
        // has none to pass on, so the shipped renderer gets one that draws nothing.
        const inner = h(Inner, props.renderSlotChain ? props : { ...props, renderSlotChain: () => null })
        const sender = senderOf(props.node)
        if (!sender) return inner
        return h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h(Label, { sender, text: t('sentFrom', { name: nameOf(sender) }) }),
          inner)
      }
      return DshBatonUserMessage
    }

    // Harness 0.2.2 and later: the chat declares a seat above each user message (BEFORE) and
    // hands it the message's source, so the label sits there and the user renderer is left alone.
    // Steering messages do not get that seat, so they keep the wrapper.
    const BEFORE = 'conversation.chat.user.before'
    const seatsBefore = (e) => e?.options?.key === 'user' && !!(e.children?.[BEFORE] ?? e.options?.children?.[BEFORE])
    function beforeLabel(t) {
      return function DshBatonSender({ matched }) {
        return h(Label, { sender: matched, text: t('sentFrom', { name: nameOf(matched) }) })
      }
    }

    module.exports.name = 'dsh-baton-host'
    module.exports.inject = ['slots', 'locale']
    module.exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-baton: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject(SLOT, function* () {
        const seated = ctx.slots.entries(SLOT).some(seatsBefore)
        // locale 'chat': the shipped renderer reads its strings through the `t` it is handed.
        for (const key of KEYS) {
          if (key === 'user' && seated) continue
          yield ctx.slots.register({ name: SLOT, key, priority: PRIORITY, locale: 'chat' }, wrapperFor(ctx, key, t))
        }
      })
      // Runs only in a Harness that declares the seat; older ones never declare it.
      ctx.slots.inject(BEFORE, () => ctx.slots.register({ name: BEFORE, select: ({ source }) => senderFrom(source) }, beforeLabel(t)))
      ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: PACKAGE, locale: NS }, wrapActivation(t)))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, wrapDetails(t)))
    }
    return module.exports
  },
})
