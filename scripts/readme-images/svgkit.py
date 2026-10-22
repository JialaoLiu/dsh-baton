"""Tiny helpers shared by the README asset builders."""
from html import escape
from pathlib import Path

SANS = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, sans-serif'
MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'


BORDER = None  # optional outline colour for the outer frame
TR = {}  # optional translation table applied to every text run


def tx(s):
    return TR.get(s, s)


def text_width(s, size):
    """Rough rendered width: CJK glyphs are ~1em, latin ~0.53em."""
    return sum(size if ord(ch) > 0x2E80 else size * 0.53 for ch in tx(s))


def svg(w, h, title, desc, body, bg, rx=24):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'role="img" aria-labelledby="title desc">\n'
        f'  <title id="title">{escape(title)}</title>\n'
        f'  <desc id="desc">{escape(desc)}</desc>\n'
        f'  <rect width="{w}" height="{h}" rx="{rx}" fill="{bg}"/>\n'
        f'{body}\n</svg>\n'
    )


def _fonts(mono):
    import svgkit  # read the live module globals so callers can swap stacks
    return svgkit.MONO if mono else svgkit.SANS


def t(x, y, s, size=20, fill='#F2F0EA', mono=False, weight=None, anchor=None, ls=None, opacity=None):
    s = tx(s)
    a = [f'x="{x}"', f'y="{y}"', f'font-family="{_fonts(mono)}"', f'font-size="{size}"', f'fill="{fill}"']
    if weight: a.append(f'font-weight="{weight}"')
    if anchor: a.append(f'text-anchor="{anchor}"')
    if ls is not None: a.append(f'letter-spacing="{ls}"')
    if opacity is not None: a.append(f'opacity="{opacity:.3f}"')
    return f'<text {" ".join(a)}>{s}</text>'


def r(x, y, w, h, rx=12, fill='none', stroke=None, sw=1, dash=None, opacity=None):
    a = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"'
    if stroke: a += f' stroke="{stroke}" stroke-width="{sw}"'
    if dash: a += f' stroke-dasharray="{dash}"'
    if opacity is not None: a += f' opacity="{opacity:.3f}"'
    return a + '/>'


def write(path, content):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(content, encoding='utf-8')
    print('wrote', path)


KEY = (255, 0, 255)


# ---- easing / timeline helpers for animated frames ----
def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease_out(p):
    p = clamp(p)
    return 1 - (1 - p) ** 3


def prog(time, start, end):
    """0..1 eased progress of a segment."""
    return ease_out((time - start) / (end - start)) if end > start else float(time >= start)


def render_gif(frame_fn, duration, out_path, width=1200, fps=24, colors=256):
    """Render frame_fn(t) -> svg string into a GIF; identical frames are merged."""
    import io
    import resvg_py
    from PIL import Image

    frames, durs, last = [], [], None
    n = int(round(duration * fps))
    for i in range(n):
        s = frame_fn(i / fps)
        if s == last:
            durs[-1] += 1000 / fps
            continue
        png = resvg_py.svg_to_bytes(svg_string=s, width=width)
        f = Image.open(io.BytesIO(bytes(png))).convert('RGBA')
        # transparent corners become a chroma key that is marked transparent below
        rgb = Image.new('RGB', f.size, KEY)
        rgb.paste(f, mask=f.split()[3].point(lambda a: 255 if a >= 128 else 0))
        frames.append(rgb)
        durs.append(1000 / fps)
        last = s
    # one shared palette from every distinct frame keeps colors stable across the loop
    h = frames[0].height
    sample = Image.new('RGB', (frames[0].width, h * len(frames)))
    for k, f in enumerate(frames):
        sample.paste(f, (0, h * k))
    pal = sample.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    flat = pal.getpalette()[:colors * 3]
    key = min(range(len(flat) // 3), key=lambda i: sum((flat[3 * i + c] - KEY[c]) ** 2 for c in range(3)))
    out[0].save(out_path, save_all=True, append_images=out[1:], duration=[round(d) for d in durs],
                loop=0, transparency=key, disposal=1)
    size = Path(out_path).stat().st_size / 1e6
    print(f'wrote {out_path}: {len(out)} unique frames, {size:.2f} MB')
