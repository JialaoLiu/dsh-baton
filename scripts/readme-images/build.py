"""Builds the dsh-baton README images: python scripts/readme-images/build.py [--zh] [--gif]"""
import sys
from pathlib import Path
import svgkit
from svgkit import svg, t, r, write, prog, clamp, render_gif, text_width, tx

OUT = Path(__file__).resolve().parent.parent.parent / 'assets' / 'readme'

# palette E "clean white"
BG, PANEL, PANEL2, LINE, LINE2 = '#FFFFFF', '#F4F6FA', '#F8FAFC', '#E2E7EF', '#C9D2DF'
FG, MUTED, ACC, AMB, RED = '#0F172A', '#5B6577', '#2563EB', '#C27803', '#DC2626'
svgkit.BORDER = LINE


def eyebrow(x, y, s):
    return t(x, y, s, 18, MUTED, mono=True, ls=2)


# ---------------------------------------------------------------- hero (animated)
CMD = 'dsh_send cwd=~/code/new-app'


def hero(time=None):
    """time=None renders the settled final state (static fallback)."""
    T = 7.0
    if time is None:
        time = 5.0
    out = clamp((time - 6.3) / 0.6)            # fade back to the first frame
    vis = lambda p: p * (1 - out)
    typed = CMD[:int(len(CMD) * clamp((time - 0.3) / 1.3))] if out < 1 else ''
    caret = 0.3 <= time < 1.9 and int(time * 2.5) % 2 == 0
    p_run = vis(prog(time, 1.8, 2.3))
    p_pkt = prog(time, 2.3, 3.1)
    p_msg = vis(prog(time, 3.0, 3.5))
    st = 0 if time < 3.0 or out >= 1 else 1 if time < 3.7 else 2 if time < 4.6 else 3

    b = []
    b.append('<g id="title-block" transform="translate(64 0)">')
    b.append(eyebrow(0, 92, 'MCP SERVER  +  HARNESS PLUGIN'))
    b.append(t(-3, 170, 'dsh-baton', 76, FG, weight=700, ls=-2))
    b.append(t(0, 226, 'Pass the baton from Claude Code or Codex', 27, FG))
    b.append(t(0, 262, 'to DeepSeek Harness, watch it run live,', 27, FG))
    b.append(t(0, 298, f'and get it handed back <tspan fill="{ACC}">when it\'s done</tspan>.', 27, FG))
    b.append(t(0, 356, 'zero deps · local socket only · no API key · MIT', 18, MUTED, mono=True))
    b.append('</g>')

    b.append('<g id="proof" transform="translate(640 48)">')
    b.append(r(0, 0, 496, 124, 14, PANEL, LINE))
    b.append(t(22, 34, 'claude code', 18, MUTED, mono=True))
    b.append(t(22, 72, f'<tspan fill="{ACC}">›</tspan> {typed}' + ('▍' if caret else ''), 20, FG, mono=True))
    b.append(t(22, 104, '← run_id hrun-7f3a', 20, MUTED, mono=True, opacity=p_run))
    # socket link: dashed rail, packet travelling down while the request crosses
    b.append(f'<line x1="64" y1="124" x2="64" y2="200" stroke="{LINE2}" stroke-width="2" stroke-dasharray="6 6"/>')
    lit = vis(p_pkt)
    b.append(f'<line x1="64" y1="124" x2="64" y2="{124 + 76 * p_pkt:.1f}" stroke="{ACC}" stroke-width="2" '
             f'stroke-dasharray="6 6" opacity="{lit:.3f}"/>')
    if 0 < p_pkt < 1:
        b.append(f'<circle cx="64" cy="{124 + 76 * p_pkt:.1f}" r="7" fill="{ACC}"/>')
    b.append(f'<circle cx="64" cy="162" r="6" fill="{BG}" stroke="{ACC if lit > .5 else LINE2}" stroke-width="2"/>')
    b.append(t(88, 168, '~/.dsh-baton/host.sock  0600', 18, MUTED, mono=True))
    b.append(r(0, 200, 496, 124, 14, PANEL, LINE))
    b.append(t(22, 234, 'harness · session-91c2', 18, MUTED, mono=True))
    b.append(t(22, 272, 'Scaffold a Vite + React app…', 20, FG, opacity=p_msg))
    pills = [('queued', 0, 104), ('running', 116, 110), ('completed', 238, 132)]
    b.append('<g transform="translate(22 288)">')
    for k, (name, x, w) in enumerate(pills, start=1):
        on = st == k
        done = st > k
        if k == 3 and on:
            b.append(r(x, 0, w, 26, 13, ACC))
            b.append(t(x + w / 2, 19, name, 16, BG, mono=True, weight=700, anchor='middle'))
        else:
            col = (FG if k == 1 else AMB) if on else (MUTED if done else LINE2)
            b.append(r(x, 0, w, 26, 13, 'none', col))
            b.append(t(x + w / 2, 19, name, 16, col if on else MUTED, mono=True, anchor='middle'))
    b.append('</g></g>')
    return svg(1200, 420, 'dsh-baton',
               'dsh-baton lets Claude Code or Codex pass a task, like a relay baton, to a local DeepSeek Harness over an owner-only '
               'local socket. A dsh_send call returns a run id; the same session appears in Harness, runs, and completes.',
               '\n'.join(b), BG)


# ---------------------------------------------------------------- feature grid
def icon(kind, x, y):
    s = f'stroke="{ACC}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"'
    g = f'<g transform="translate({x} {y})" {s}>'
    shapes = {
        'workspace': '<path d="M2 10 h12 l4 5 h20 v21 h-36 z"/><path d="M20 21 v10 M15 26 h10"/>',
        'continue': '<path d="M6 20 a14 14 0 1 1 6 11"/><path d="M2 14 l4 7 l7 -4"/>',
        'live': '<rect x="2" y="6" width="36" height="28" rx="4"/><path d="M2 14 h36"/><circle cx="20" cy="24" r="4" fill="' + ACC + '"/>',
        'done': '<path d="M10 28 v-10 a10 10 0 0 1 20 0 v10 l3 4 h-26 z"/><path d="M17 36 h6"/>',
        'key': '<circle cx="12" cy="20" r="7"/><path d="M19 20 h17 M30 20 v6 M35 20 v4"/><path d="M4 36 L36 4" stroke="' + MUTED + '"/>',
        'local': '<rect x="7" y="18" width="26" height="18" rx="3"/><path d="M13 18 v-6 a7 7 0 0 1 14 0 v6"/>',
    }
    return g + shapes[kind] + '</g>'


def features():
    cards = [
        ('workspace', 'Workspaces + sessions', ['Start Harness in any folder;', 'it shows in the sidebar.']),
        ('continue', 'Continue a session', ['Send by session_id and keep', 'its full context.']),
        ('live', 'Live in the Harness UI', ['Runs as if typed in Harness,', 'labelled with who sent it.']),
        ('done', "Woken when it's done", ['Claude Code and Codex wake', 'up when a run ends.']),
        ('key', 'No extra API key', ['Desktop sign-in and presets;', 'pick any model Harness has.']),
        ('local', 'macOS + Windows', ['Zero deps; owner-only socket', 'or pipe, no network port.']),
    ]
    W, H, gap, x0, y0 = 341, 196, 24, 64, 56
    b = []
    for i, (ic, title, lines) in enumerate(cards):
        x, y = x0 + (i % 3) * (W + gap), y0 + (i // 3) * (H + gap)
        b.append(r(x, y, W, H, 16, PANEL, LINE))
        b.append(icon(ic, x + 26, y + 24))
        b.append(t(x + 26, y + 104, title, 24, FG, weight=700))
        for k, ln in enumerate(lines):
            b.append(t(x + 26, y + 142 + k * 28, ln, 20, MUTED))
    h = y0 * 2 + H * 2 + gap
    return svg(1200, h, 'What dsh-baton does',
               'Six capabilities: create workspaces and sessions, continue a specific session, run live in the '
               'Harness UI labelled with the sender, Claude Code and Codex woken when a run ends, no extra API key and any Harness model, macOS and Windows with zero dependencies.',
               '\n'.join(b), BG)


# ---------------------------------------------------------------- comparison
def mark(cx, cy, yes, note=None):
    if yes:
        s = (f'<circle cx="{cx}" cy="{cy}" r="15" fill="{ACC}"/>'
             f'<path d="M{cx-7} {cy} l5 5 l9 -10" stroke="{BG}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    else:
        s = (f'<circle cx="{cx}" cy="{cy}" r="14" fill="none" stroke="{LINE2}" stroke-width="2"/>'
             f'<path d="M{cx-6} {cy} h12" stroke="{MUTED}" stroke-width="3" stroke-linecap="round"/>')
    if note:
        s += t(cx + 28, cy + 7, note, 18, MUTED, mono=True)
    return s


def comparison():
    rows = [
        ('Shows up live in the Harness UI', True, False, None),
        ('Continues sessions made in the desktop app', True, False, None),
        ('Uses your desktop agent presets', True, False, None),
        ('Desktop sign-in, no API key', True, True, None),
    ]
    c1, c2 = 700, 940
    b = [t(64, 76, 'Plugin vs headless', 30, FG, weight=700),
         t(c1, 76, 'dsh-baton', 22, ACC, weight=700, anchor='middle'),
         t(c2, 76, 'dsh headless', 22, MUTED, weight=700, anchor='middle'),
         f'<line x1="64" y1="100" x2="1136" y2="100" stroke="{LINE}"/>']
    for i, (label, a, h, note) in enumerate(rows):
        y = 150 + i * 70
        b.append(t(64, y + 8, label, 22, FG))
        b.append(mark(c1, y, a))
        b.append(mark(c2, y, h, note))
        if i < len(rows) - 1:
            b.append(f'<line x1="64" y1="{y + 35}" x2="1136" y2="{y + 35}" stroke="{LINE}"/>')
    b.insert(0, r(c1 - 110, 40, 220, 400, 14, PANEL))
    return svg(1200, 470, 'dsh-baton plugin compared with dsh headless',
               'With the plugin, runs show up live in the Harness UI, can continue sessions created in the desktop '
               'app, and use desktop agent presets. dsh headless does none of these. Both reuse the desktop sign-in; '
               'headless does it through the account patch.', '\n'.join(b), BG)


# ---------------------------------------------------------------- install steps
def install():
    """Same order as the Quick start text: add the plugin in Harness (it registers the MCP server),
    trust the Codex hook once, then check."""
    gap, x0, y0, H = 24, 64, 104, 300
    W = (1072 - 2 * gap) // 3
    b = [eyebrow(64, 64, 'THREE STEPS')]
    steps = [
        ('1', 'Add in Harness', [('crumb', ['Plugins', 'Add plugin']), ('crumb', ['dsh-baton-host']),
                                 ('crumb', ['Install', 'Enable now']),
                                 ('text', 'Registers Claude Code + Codex.')]),
        ('2', 'Codex: trust once', [('crumb', ['Settings', 'Hooks', 'Trust']),
                                    ('text', 'dsh-baton: waiting for the'), ('text', 'Harness run. Codex is then'),
                                    ('text', 'woken when a run ends.')]),
        ('3', 'Check', [('text', 'Open a new chat and ask for'), ('mono', 'dsh_list_workspaces'),
                        ('text', 'It lists your Harness workspaces.')]),
    ]
    for i, (n, head, rows) in enumerate(steps):
        x = x0 + i * (W + gap)
        b.append(r(x, y0, W, H, 16, PANEL, LINE))
        b.append(t(x + 24, y0 + 58, n, 44, ACC, weight=700))
        b.append(t(x + 66, y0 + 52, head, 23, FG, weight=700))
        y = y0 + 100
        for kind, val in rows:
            if kind == 'mono':
                b.append(r(x + 20, y - 22, W - 40, 32, 8, BG, LINE))
                b.append(t(x + 30, y - 1, val, 15, MUTED if val.startswith('#') else ACC, mono=True))
                y += 40
            elif kind == 'text':
                b.append(t(x + 24, y, val, 18, MUTED))
                y += 28
            else:
                cx = x + 20
                for k, c in enumerate(val):
                    w = int(text_width(c, 17)) + 26
                    hl = c == 'dsh-baton-host'
                    b.append(r(cx, y - 24, w, 34, 17, '#EAF1FE' if hl else BG, ACC if hl else LINE2))
                    b.append(t(cx + w / 2, y - 1, c, 17, ACC if hl else FG, anchor='middle'))
                    cx += w
                    if k < len(val) - 1:
                        b.append(f'<path d="M{cx + 6} {y - 13} l6 6 l-6 6" stroke="{MUTED}" stroke-width="2" fill="none"/>')
                        cx += 20
                y += 50
        if i < len(steps) - 1:
            ax = x + W + 4
            b.append(f'<path d="M{ax} {y0 + H / 2} h{gap - 8}" stroke="{MUTED}" stroke-width="2"/>')
    return svg(1200, y0 + H + 40, 'Set up dsh-baton in three steps',
               tx('Step 1: in Harness open Plugins, Add plugin, enter dsh-baton-host, Install, Enable now; it registers '
                  'dsh-baton for Claude Code and Codex. Step 2, Codex only, once: Settings, Hooks, trust "dsh-baton: waiting '
                  'for the Harness run", so Codex is woken when a run ends. Step 3: in a new chat, ask for '
                  'dsh_list_workspaces; it lists your Harness workspaces.'), '\n'.join(b), BG)


# ---------------------------------------------------------------- tools map
def tools():
    # listed in tools/list (0.6.0); the rest are hidden and reached through dsh_call
    groups = [
        ('FIND', [('dsh_list_workspaces', 'sidebar workspaces'),
                  ('dsh_list_sessions', 'newest first, with model'),
                  ('dsh_read_session', 'recent prompts + replies'),
                  ('dsh_list_models', 'models Harness can run')]),
        ('RUNS', [('dsh_send', 'start a run, pick a model'),
                  ('dsh_status', 'progress + final reply'),
                  ('dsh_wait', 'until it ends, with evidence')]),
        ('CONTROL', [('dsh_answer', "answer a run's questions"),
                     ('dsh_cancel', 'stop turn, agents, jobs'),
                     ('dsh_call', 'reaches the six below')]),
    ]
    hidden = [('dsh_create_workspace', 'register a folder'),
              ('dsh_rename_workspace', 'sidebar title only'),
              ('dsh_session_activity', 'turn, sub-agents, jobs'),
              ('dsh_rename_session', 'rename a session'),
              ('dsh_update_queued', 'edit a queued message'),
              ('dsh_list_runs', 'recent runs')]
    W, gap, x0 = 341, 24, 64
    b = [t(64, 76, '10 tools listed, 6 more through dsh_call', 30, FG, weight=700)]
    for i, (name, items) in enumerate(groups):
        x = x0 + i * (W + gap)
        b.append(r(x, 104, W, 340, 16, PANEL, LINE))
        b.append(t(x + 26, 146, name, 18, ACC, mono=True, ls=2))
        for k, (tool, what) in enumerate(items):
            y = 196 + k * 64
            hot = tool == 'dsh_call'
            b.append(t(x + 26, y, tool, 20, ACC if hot else FG, mono=True, weight=600))
            b.append(t(x + 26, y + 28, what, 18, MUTED))
    b.append(r(x0, 468, 3 * W + 2 * gap, 212, 16, PANEL2, LINE2, sw=1.5, dash='8 6'))
    b.append(t(x0 + 26, 510, 'LESS USED · NOT IN THE TOOL LIST', 18, MUTED, mono=True, ls=2))
    for k, (tool, what) in enumerate(hidden):
        x = x0 + (k % 3) * (W + gap) + 26
        y = 560 + (k // 3) * 64
        b.append(t(x, y, tool, 20, MUTED, mono=True, weight=600))
        b.append(t(x, y + 28, what, 18, MUTED, opacity=0.8))
    return svg(1200, 720, 'dsh-baton MCP tools',
               'Listed: list workspaces, list sessions, read session, list models, send, status, wait, answer, cancel, call. '
               'Less used, reached through dsh_call: create and rename workspace, session activity, '
               'rename session, update queued, list runs.', '\n'.join(b), BG)


# ---------------------------------------------------------------- run states
def states():
    def node(x, y, label, col, filled=False, w=170):
        return (r(x, y, w, 52, 26, col if filled else PANEL, col, sw=2) +
                t(x + w / 2, y + 33, label, 20, BG if filled else col, mono=True, weight=700, anchor='middle'))

    def arrow(d, col=MUTED, dash=None):
        da = f' stroke-dasharray="{dash}"' if dash else ''
        return f'<path d="{d}" stroke="{col}" stroke-width="2" fill="none"{da} marker-end="url(#ah)"/>'

    b = ['<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
         f'<path d="M0 0 L10 5 L0 10 z" fill="{MUTED}"/></marker></defs>',
         t(64, 76, 'Every message gets its own run', 30, FG, weight=700),
         '<g transform="translate(0 56)">',
         node(64, 150, 'queued', FG), arrow('M234 176 H 306'),
         node(310, 150, 'running', AMB), arrow('M480 176 H 552'),
         node(556, 150, 'completed', ACC, True, 190),
         node(556, 236, 'failed', RED), node(556, 64 + 0, 'cancelled', MUTED),
         arrow('M480 186 C 520 186, 520 262, 552 262'), arrow('M480 166 C 520 166, 520 90, 552 90'),
         node(310, 290, 'waiting', '#7C3AED'),
         arrow('M380 202 V 286'), arrow('M410 290 V 206', dash='4 5'),
         t(310, 372, 'Harness needs a person:', 18, MUTED), t(310, 398, 'an approval or a question.', 18, MUTED),
         t(556, 340, 'completed = turn ended and', 18, MUTED), t(556, 366, 'sub-agents + jobs finished.', 18, MUTED),
         node(64, 290, 'interrupted', MUTED, w=190), arrow('M318 202 C 300 260, 290 316, 258 316', dash='4 5'),
         t(64, 372, 'Harness restarted', 18, MUTED), t(64, 398, 'mid-run.', 18, MUTED), '</g>']
    # busy-session modes
    x = 820
    b += [r(x, 160, 316, 320, 16, PANEL, LINE),
          t(x + 26, 202, 'SESSION BUSY?', 18, ACC, mono=True, ls=2),
          t(x + 26, 252, 'followup', 22, FG, mono=True, weight=700), t(x + 150, 252, 'default', 18, MUTED),
          t(x + 26, 282, 'Queued, runs after the', 20, MUTED), t(x + 26, 310, 'current task.', 20, MUTED),
          f'<line x1="{x + 26}" y1="346" x2="{x + 290}" y2="346" stroke="{LINE}"/>',
          t(x + 26, 390, 'steer', 22, FG, mono=True, weight=700),
          t(x + 26, 420, "Interjects at the agent's", 20, MUTED), t(x + 26, 448, 'next step.', 20, MUTED)]
    return svg(1200, 520, 'dsh-baton run states',
               'A run moves from queued to running and ends completed, failed or cancelled, or interrupted if Harness restarts mid-run. Running can pause in '
               'waiting when Harness needs a person. When a session is busy, followup queues the message and steer '
               'interjects at the next step.', '\n'.join(b), BG)


# ---------------------------------------------------------------- security + limits
def cards_row(title, eyebrow_txt, items, col, h_card, total_h, alt):
    W, gap, x0 = 341, 24, 64
    b = [t(64, 76, title, 30, FG, weight=700)]
    for i, (head, lines) in enumerate(items):
        x = x0 + (i % 3) * (W + gap)
        y = 104 + (i // 3) * (h_card + gap)
        b.append(r(x, y, W, h_card, 16, PANEL, LINE))
        b.append(f'<rect x="{x}" y="{y + 26}" width="4" height="30" fill="{col}"/>')
        b.append(t(x + 26, y + 50, head, 22, FG, weight=700))
        for k, ln in enumerate(lines):
            b.append(t(x + 26, y + 92 + k * 28, ln, 20, MUTED))
    return svg(1200, total_h, tx(title), tx(alt), '\n'.join(b), BG)


def security():
    return cards_row('Security', 'LOCAL ONLY', [
        ('Owner-only channel', ['Socket 0600 on macOS/Linux,', 'per-user pipe on Windows.']),
        ('No network port', ['Contacts no external', 'service at all.']),
        ('Harness rules apply', ["Runs use Harness's own", 'sandbox and approvals.']),
    ], ACC, 180, 320,
        'The socket is 0600 on macOS and Linux and a per-user named pipe on Windows, so only your OS user can drive it; the plugin opens no '
        'network port and contacts no external service; runs follow Harness sandbox and approval settings.')


def limits():
    return cards_row('Good to know', 'HEADS UP', [
        ('UI input is flagged', ['A message typed in the UI', 'mid-run is recorded on the', 'run as a human interjection.']),
        ('Runs survive restarts', ['Run records are kept on', 'disk; a run cut short by a', 'restart shows interrupted.']),
        ('Waits without polling', ['Claude Code and Codex are', 'woken once, when a run', 'ends; nothing polls.']),
    ], '#2F855A', 210, 350,
        'A message typed in the Harness UI during a relayed run is recorded on that run as a human interjection; '
        'run records survive a Harness restart and a run cut short by one is marked interrupted; Claude Code waits '
        'in the background and Codex ends its turn with its Stop hook; both are woken once, when the run ends.')


# ---------------------------------------------------------------- typical flow (animated)
FLOW = [
    ('1', 'Create a workspace', 'dsh_create_workspace', ['~/code/new-app', 'joins the sidebar']),
    ('2', 'Send the task', 'dsh_send', ['returns run_id +', 'session_id at once']),
    ('3', 'Wait, no polling', 'wait_command', ['Claude Code: woken once', 'Codex: woken by its hook']),
    ('4', 'Follow up', 'dsh_send session_id', ['same session, same', 'context: "fix tests"']),
]


def flow(time=None):
    T = 8.0
    settled = time is None
    W, gap, x0, y0 = 250, 24, 64, 112
    b = [t(64, 76, 'Typical flow', 30, FG, weight=700)]
    if not settled:
        out = clamp((time - 7.4) / 0.5)
    for i, (n, head, tool, lines) in enumerate(FLOW):
        x = x0 + i * (W + gap)
        if settled:
            a, act = 1.0, False
        else:
            start = 0.4 + i * 1.3
            a = prog(time, start, start + 0.6) * (1 - out)
            act = start <= time < start + 1.3 and out == 0
        border = ACC if act else LINE
        b.append(r(x, y0, W, 250, 16, PANEL, border, sw=2 if act else 1))
        b.append(t(x + 24, y0 + 60, n, 44, ACC if a > .5 else LINE2, weight=700))
        b.append(t(x + 24, y0 + 108, head, 21, FG, weight=700, opacity=.35 + .65 * a))
        b.append(r(x + 24, y0 + 128, W - 48, 34, 8, BG, opacity=a))
        b.append(t(x + 36, y0 + 151, tool, 16 if len(tool) > 17 else 18, ACC, mono=True, opacity=a))
        for k, ln in enumerate(lines):
            b.append(t(x + 24, y0 + 198 + k * 26, ln, 17, MUTED, opacity=a))
        if i < 3:
            ax = x + W + 3
            b.append(f'<path d="M{ax} {y0 + 125} l14 0" stroke="{ACC if a > .5 else LINE2}" stroke-width="2.5"/>')
    return svg(1200, 400, 'Typical dsh-baton flow',
               'Create a workspace, send the task and get a run id, wait without polling (Claude Code and Codex '
               'are each woken once, when the run ends), then follow up in the same session.', '\n'.join(b), BG)


if __name__ == '__main__':
    if '--zh' in sys.argv:
        from zh import ZH
        svgkit.TR = ZH
        # name a CJK face first so renderers don't pick a random fallback for Chinese runs
        svgkit.SANS = '&quot;Microsoft YaHei&quot;, &quot;PingFang SC&quot;, ' + svgkit.SANS
        svgkit.MONO = svgkit.MONO.replace(', monospace', ', &quot;Microsoft YaHei&quot;, &quot;PingFang SC&quot;, monospace')
        OUT = OUT / 'zh'
    write(OUT / 'hero.svg', hero())
    write(OUT / 'features.svg', features())
    write(OUT / 'comparison.svg', comparison())
    write(OUT / 'install.svg', install())
    write(OUT / 'tools.svg', tools())
    write(OUT / 'states.svg', states())
    write(OUT / 'security.svg', security())
    write(OUT / 'limits.svg', limits())
    write(OUT / 'flow.svg', flow())
    if '--gif' in sys.argv:
        render_gif(hero, 7.0, OUT / 'hero.gif')
        render_gif(flow, 8.0, OUT / 'flow.gif')
