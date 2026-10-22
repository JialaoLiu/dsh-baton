# README images

Builds the SVG cards and animated GIFs in `assets/readme/` (English) and `assets/readme/zh/` (Chinese).

```bash
pip install resvg-py Pillow        # only needed for --gif
python scripts/readme-images/build.py            # English SVGs
python scripts/readme-images/build.py --zh       # Chinese SVGs
python scripts/readme-images/build.py --gif      # also hero.gif and flow.gif
python scripts/readme-images/build.py --zh --gif
```

- `build.py` has one function per image: `hero`, `features`, `comparison`, `install`, `tools`, `states`, `security`, `limits`, `flow`. Edit the English text there.
- `zh.py` maps each English string to its Chinese text. A string with no entry is drawn in English, so add a `zh.py` entry whenever you add or change English text.
- `svgkit.py` holds the shared helpers: `svg`, `t` (text), `r` (rect), `text_width`, `render_gif`.
- Palette: white background, blue `#2563EB` accent. Keep text at 15 px or larger in the 1200-wide viewBox.
- `architecture.svg` is drawn by hand and is not built here.
- Each run overwrites every SVG it builds, so check `git diff assets/readme` before committing.
