"""Builds merch/index.html and the merch section of the landing page (../index.html) from merch/ideas.json.

Run from the repo root: python3 merch/build.py
ideas.json holds the picks from the merch-ideas workflow; edit it and re-run to change the pages.
"""
import html
import json
import re
from pathlib import Path

here = Path(__file__).parent
root = here.parent
data = json.loads((here / 'ideas.json').read_text())
e = html.escape

FONTS = ('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Fraunces:ital,opsz,wght@0,9..144,500..700;1,9..144,400..600'
         '&family=DM+Serif+Display:ital@0;1&family=Jost:wght@400..700&family=Instrument+Serif:ital@0;1&family=Inter:wght@400..700'
         '&family=Rye&family=Archivo:wght@400..800&family=Barlow+Condensed:wght@600;700&family=Public+Sans:wght@400..700'
         '&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400..700&family=DM+Sans:opsz,wght@9..40,400..700&display=swap')

# Flat silhouettes on a 200x200 canvas; print areas live in merch.css.
SHAPES = {
    'tote': '<path class="strap-edge" d="M76 74 C76 28 124 28 124 74"/><path class="strap" d="M76 74 C76 28 124 28 124 74"/><rect class="fill" x="48" y="70" width="104" height="110" rx="4"/>',
    'tee': '<path class="fill" d="M70 32 L52 38 L28 62 L44 80 L58 70 L58 172 L142 172 L142 70 L156 80 L172 62 L148 38 L130 32 C124 44 112 50 100 50 C88 50 76 44 70 32 Z"/><path class="line" d="M70 32 C76 44 88 50 100 50 C112 50 124 44 130 32"/>',
    'mug': '<path class="strap-edge" d="M132 84 C164 84 164 138 132 138"/><path class="strap" d="M132 84 C164 84 164 138 132 138"/><rect class="fill" x="48" y="64" width="86" height="98" rx="10"/><path class="line" d="M48 74 L134 74"/>',
    'coffee-bag': '<rect class="fill" x="60" y="34" width="80" height="20" rx="2"/><path class="fill" d="M58 52 L142 52 L150 178 L50 178 Z"/><path class="line" d="M66 40 L134 40 M66 46 L134 46"/>',
    'jar': '<rect class="fill" x="56" y="70" width="88" height="110" rx="18"/><rect x="62" y="50" width="76" height="22" rx="4" fill="var(--accent)"/>',
    'candle': '<rect class="fill" x="56" y="78" width="88" height="100" rx="12"/><path class="line" d="M100 78 L100 62"/><path d="M100 46 C106 54 106 60 100 62 C94 60 94 54 100 46 Z" fill="var(--accent)"/>',
    'apron': '<path class="strap-edge" d="M80 32 C82 6 118 6 120 32"/><path class="strap" d="M80 32 C82 6 118 6 120 32"/><path class="fill" d="M74 30 L126 30 L128 70 C150 74 156 90 156 100 L148 182 L52 182 L44 100 C44 90 50 74 72 70 Z"/><path class="line" d="M84 120 L116 120 L116 146 L84 146 Z"/>',
    'poster': '<rect class="fill" x="40" y="16" width="120" height="168"/>',
    'pin': '<circle class="fill" cx="100" cy="100" r="62"/><circle class="line" cx="100" cy="100" r="55"/>',
    'cap': '<path class="fill" d="M50 120 C50 66 150 66 150 120 Z"/><path class="fill" d="M44 120 L156 120 C150 136 120 140 100 140 C80 140 50 136 44 120 Z"/><circle class="fill" cx="100" cy="70" r="5"/>',
    'box': '<rect class="fill" x="36" y="72" width="128" height="100"/><rect class="fill" x="32" y="58" width="136" height="22" rx="2"/>',
    'card': '<rect class="fill" x="30" y="50" width="140" height="100" rx="4"/>',
    'bandana': '<rect class="fill" x="38" y="38" width="124" height="124"/><rect class="line" x="46" y="46" width="108" height="108"/>',
    'tumbler': '<rect class="fill" x="62" y="30" width="76" height="14" rx="4"/><path class="fill" d="M66 42 L134 42 L126 178 L74 178 Z"/>',
    'other': '<rect class="fill" x="40" y="40" width="120" height="120" rx="16"/>',
}

BRANDS = [  # (match, css class, order, dark-by-default)
    ("peach", 'b-peachs', 0, False),
    ('parkway', 'b-parkway', 1, True),
    ('blanc', 'b-blanc', 2, False),
    ('sausage', 'b-rjc', 3, False),
    ('r.j.c', 'b-rjc', 3, False),
    ('mise', 'b-mise', 4, False),
    ('catering', 'b-romesjoy', 5, True),
    ("rome", 'b-romesjoy', 5, True),
]
DARK_WORDS = ('black', 'espresso', 'charcoal', 'dark', 'navy', 'forest', 'sage', 'ink', 'brown', 'chocolate')
LIGHT_WORDS = ('cream', 'ivory', 'white', 'natural', 'light', 'canvas', 'oat', 'paper', 'bone')


def brand_of(name):
    low = name.lower()
    for key, cls, order, dark in BRANDS:
        if key in low:
            return cls, order, dark
    return 'b-romesjoy', 6, True


def variant(cls, dark_default, palette):
    first = re.split(r'[,;/+&]| and ', palette.lower())[0]
    if dark_default:
        return ' light' if any(w in first for w in LIGHT_WORDS) else ''
    if any(w in first for w in DARK_WORDS):
        return ' dark'
    if cls == 'b-peachs' and ('peach' in first or 'orange' in first):
        return ' warm'
    return ''


def mark_html(mark, prefix):
    return {
        'peachs-wordmark': '<span class="mark mark-mask mark-peachs-wordmark"></span>',
        'peachs-portrait': f'<img class="mark mark-img mark-portrait" src="{prefix}assets/img/brand/peach-portrait.png" alt="">',
        'peachs-badge': f'<img class="mark mark-img" src="{prefix}assets/img/brand/badge.png" alt="">',
        'parkway-wordmark': '<span class="mark mark-parkway">parkway<span>social</span></span>',
        'blanc-mark': '<span class="mark mark-blanc">blanc</span>',
        'rjc-stripes': '<span class="mark mark-rjc"></span>',
        'mise-logo': f'<img class="mark mark-mise" src="{prefix}mise-en-place/img/logo.webp" alt="">',
        'romesjoy-mark': '<span class="mark mark-mask mark-romesjoy"></span>',
    }.get(mark, '')


def mock(pick, prefix):
    m = pick['mockup']
    cls, _, dark = brand_of(pick['brand'])
    obj = m['object'] if m['object'] in SHAPES else 'other'
    lines = ''.join(f'<span class="l{i + 1}">{e(t)}</span>' for i, t in enumerate(m['text'][:4]))
    narrow = obj in ('mug', 'tumbler', 'cap', 'pin', 'jar', 'candle', 'tee', 'apron')
    busy = sum(len(t) for t in m['text'][:4]) + (12 if m['mark'] != 'none' else 0)
    dense = ' dense' if busy > (34 if narrow else 52) else ''
    return (f'<div class="mock {cls}{variant(cls, dark, m.get("palette", ""))}{dense}" data-obj="{obj}" role="img" '
            f'aria-label="{e(m["object"])} mockup: {e(" / ".join(m["text"]))}">'
            f'<svg class="obj" viewBox="0 0 200 200" aria-hidden="true">{SHAPES[obj]}</svg>'
            f'<div class="print">{mark_html(m["mark"], prefix)}{lines}</div></div>')


COST = {'low': 'Low up-front cost', 'medium': 'Medium up-front cost', 'high': 'Higher up-front cost'}
picks = sorted(data['picks'], key=lambda p: brand_of(p['brand'])[1])

cards = []
for p in picks:
    cards.append(f'''
      <article class="idea">
        {mock(p, '../')}
        <div class="idea__body">
          <p class="tag">{e(p["brand"])}</p>
          <h2>{e(p["name"])}</h2>
          <p class="tagline">{e(p["tagline"])}</p>
          <p class="why">{e(p["why"])}</p>
          <dl>
            <div><dt>What it is</dt><dd>{e(p["product"])}</dd></div>
            <div><dt>Sells at</dt><dd>{e(p["channel"])}</dd></div>
            <div><dt>Made by</dt><dd>{e(p["production"])}</dd></div>
            <div><dt>First step</dt><dd>{e(p["firstStep"])}</dd></div>
          </dl>
          <p class="cost cost--{e(p["costTier"])}">{COST.get(p["costTier"], "")}</p>
        </div>
      </article>''')

cut = ''.join(f'<li>{e(c)}</li>' for c in data.get('cut', []))
page = (here / 'template.html').read_text()
page = (page.replace('{{FONTS}}', FONTS).replace('{{INTRO}}', e(data['intro'])).replace('{{N}}', str(len(picks)))
            .replace('{{CARDS}}', ''.join(cards)).replace('{{CUT}}', cut))
(here / 'index.html').write_text(page)

# Landing-page section: four ideas from four different brands, then a link to the rest.
seen, teaser = set(), []
for p in picks:
    b = brand_of(p['brand'])[0]
    if b in seen:
        continue
    seen.add(b)
    teaser.append(f'''
          <a class="card mini" href="merch/">
            {mock(p, '')}
            <span class="mini__body"><span class="tag">{e(p["brand"])}</span><span class="mini__name">{e(p["name"])}</span></span>
          </a>''')
    if len(teaser) == 4:
        break
section = f'''<!-- merch:start (generated by merch/build.py) -->
    <section class="block" id="merch" aria-labelledby="merch-title">
      <div class="block-head">
        <p class="tag">Merch ideas</p>
        <h2 id="merch-title">{len(picks)} things to sell across the family</h2>
        <p>{e(data["intro"])}</p>
      </div>
      <div class="minis">{"".join(teaser)}
      </div>
      <p><a class="text-link" href="merch/">See all {len(picks)} ideas, with how to start each one →</a></p>
    </section>
<!-- merch:end -->'''
index = (root / 'index.html').read_text()
if '<!-- merch:start' in index:
    index = re.sub(r'<!-- merch:start.*?<!-- merch:end -->', lambda _: section, index, flags=re.S)
else:
    index = index.replace('{{MERCH_SECTION}}', section)
index = re.sub(r'(Merch ideas <span>)(\{\{MERCH_N\}\}|\d+)(</span>)', rf'\g<1>{len(picks)}\3', index)
if 'merch/merch.css' not in index:
    index = index.replace('</head>', f'  <link rel="stylesheet" href="{FONTS}">\n  <link rel="stylesheet" href="merch/merch.css">\n</head>', 1)
(root / 'index.html').write_text(index)
print(f'{len(picks)} picks; teaser brands: {sorted(seen)}')
