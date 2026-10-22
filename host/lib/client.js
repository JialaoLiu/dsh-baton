// dsh-baton-host, browser half. Two jobs:
//   - On the Plugins page: right after the plugin is switched on, and on its detail page,
//     say whether the host half registered the MCP server for Claude Code and Codex
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
    const { createElement: h, useState, useEffect } = require('react')
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
    const NAMES = { claude: 'Claude', codex: 'ChatGPT' }

    const PACKAGE = 'dsh-baton-host'
    const SETUP = 'npx -y dsh-baton-mcp setup'

    const zh = {
      sentFrom: '由 {name} 从另一个聊天发送',
      readyTitle: 'dsh-baton 已就绪',
      failTitle: 'dsh-baton 还差一步',
      pending: '正在为 Claude Code 和 Codex 注册 dsh-baton…',
      ready: '已为 {clients} 注册 dsh-baton。在 Claude Code 或 Codex 里新开一个对话，就能用 dsh_* 工具。',
      partial: '{clients} 没能注册：',
      noNode: '没找到 Node.js 22.15 或更新版本。装好 Node.js 后，',
      noClients: '没找到 Claude Code 或 Codex。装好之后，',
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
    }
    const en = {
      sentFrom: 'Sent by {name} from another chat',
      readyTitle: 'dsh-baton is ready',
      failTitle: 'dsh-baton needs one more step',
      pending: 'Registering dsh-baton for Claude Code and Codex…',
      ready: 'dsh-baton is registered for {clients}. Start a new conversation in Claude Code or Codex to use the dsh_* tools.',
      partial: 'Could not register for {clients}: ',
      noNode: 'Node.js 22.15 or later was not found. Once it is installed, ',
      noClients: 'Neither Claude Code nor Codex was found. Once one is installed, ',
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
      const list = (names) => names.join(` ${t('and')} `)
      const fix = (reg.error === 'no-node' ? t('noNode') : reg.error === 'no-clients' ? t('noClients') : '') + t('runSetup', { cmd: SETUP })
      if (reg.ok) return [t('readyTitle'), t('ready', { clients: list(done) })]
      if (done.length) return [t('failTitle'), `${t('ready', { clients: list(done) })} ${t('partial', { clients: list(failed) })}${fix}`]
      return [t('failTitle'), (reg.error === 'no-node' || reg.error === 'no-clients' ? '' : t('failed')) + fix]
    }

    // Shown once, right after "Enable now".
    function wrapActivation(t) {
      return function DshBatonActivation({ onDismiss }) {
        const [title, text] = describe(useRegistration(), t)
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

    // The plugin's detail page: one line per client.
    function wrapDetails(t) {
      return function DshBatonStatus({ view }) {
        const reg = useRegistration()
        if (view === 'summary') return null
        const [, text] = describe(reg, t)
        const word = (s) => (REGISTERED.includes(s) ? t('registered') : s === 'not-installed' ? t('notInstalled') : t('notRegistered'))
        const rows = (reg?.clients ?? []).map((c) => `${c.label}: ${word(c.state)}`)
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--dsw-alias-label-secondary)' } },
          h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('status')),
          rows.length ? h('span', null, rows.join(' · ')) : null,
          h('span', null, text))
      }
    }

    function senderOf(node) {
      const rpcId = node?.data?.source?.rpcId
      const m = typeof rpcId === 'string' ? RPC_RE.exec(rpcId) : null
      return m ? m[1] : null
    }
    const nameOf = (sender) => NAMES[sender] ?? sender.charAt(0).toUpperCase() + sender.slice(1)

    // Sender marks, drawn in the label's text colour like ChatGPT's own "sent from another chat" line.
    const MARKS = {
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
        const sender = senderOf(props.node)
        if (!sender) return h(Inner, props)
        return h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h(Label, { sender, text: t('sentFrom', { name: nameOf(sender) }) }),
          h(Inner, props))
      }
      return DshBatonUserMessage
    }

    module.exports.name = 'dsh-baton-host'
    module.exports.inject = ['slots', 'locale']
    module.exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-baton: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject(SLOT, function* () {
        // locale 'chat': the shipped renderer reads its strings through the `t` it is handed.
        for (const key of KEYS) yield ctx.slots.register({ name: SLOT, key, priority: PRIORITY, locale: 'chat' }, wrapperFor(ctx, key, t))
      })
      ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: PACKAGE, locale: NS }, wrapActivation(t)))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, wrapDetails(t)))
    }
    return module.exports
  },
})
