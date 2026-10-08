#!/usr/bin/env python3
"""
Draws the three sheets issue #9 (housekeeping) needs, straight to native size.

    python tools/gen_housekeeping_art.py

Writes into src/games/tower/assets/sprites/:

  housekeeping.png   96x32   day, night                       the facility
  room-status.png    144x32  dirty, infested (2 frames)       overlays for a hotel room
  person-staff.png   64x16   stand, wait, clean (2 frames)    a housekeeper

These are **procedural placeholder art**, in the house palette
(spec/sprite-manifest.md) — flat shapes on the 48x32 slot, no gradients — so the
mechanic can be seen and the loader, the catalogue and test/sprites.test.js have
something real to hold level. An artist can replace any of the three PNGs and
re-run `node src/games/tower/assets/sprites/sidecars.gen.mjs`; nothing else
needs to change, because the frames are listed in tools/sprite-catalog.json.

The overlays are drawn over the empty-room shell (`room-empty/hotel`), so they
are transparent where the room should show through.

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


# ------------------------------------------------------------- the facility

def facility(night):
    """48x32: a linen room. Teal is housekeeping's hue family (violet is hotel)."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    P = {
        'edge': hexc('#0e1116'),
        'rim': hexc('#1f5560' if not night else '#143038'),
        'ceil': hexc('#16313a' if not night else '#0b181d'),
        'wall': hexc('#24494f' if not night else '#10242a'),
        'panel': hexc('#2b5860' if not night else '#152d34'),
        'floor': hexc('#2a2f38' if not night else '#171a20'),
        'floor2': hexc('#3a4452' if not night else '#232932'),
        'shelf': hexc('#7a5a3a' if not night else '#3f2e1d'),
        'towel': hexc('#e8eef2' if not night else '#8c9499'),
        'towel2': hexc('#2fb5a8' if not night else '#175b55'),
        'towel3': hexc('#ff9ecd' if not night else '#7d4f66'),
        'cart': hexc('#9fb3c8' if not night else '#4c5864'),
        'cartd': hexc('#56687d' if not night else '#2b343d'),
        'bucket': hexc('#ffb703' if not night else '#7a5802'),
        'mop': hexc('#d8c9a8' if not night else '#665f4f'),
        'plate': hexc('#0b0f14'),
        'ink': hexc('#7fe6dc' if not night else '#ffd76a'),
    }
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    d.rectangle([1, 1, 46, 30], fill=P['rim'])
    d.rectangle([2, 2, 45, 4], fill=P['ceil'])
    d.rectangle([2, 5, 45, 25], fill=P['wall'])
    for x in range(8, 45, 8):
        d.line([x, 5, x, 25], fill=P['panel'])
    d.rectangle([2, 26, 45, 29], fill=P['floor'])
    d.line([2, 26, 45, 26], fill=P['floor2'])

    # linen shelves, left
    d.rectangle([3, 7, 15, 25], outline=P['shelf'])
    for y in (12, 18, 24):
        d.line([3, y, 15, y], fill=P['shelf'])
    stacks = [(4, 8, 'towel'), (8, 8, 'towel2'), (12, 9, 'towel'),
              (5, 13, 'towel2'), (9, 14, 'towel3'), (12, 13, 'towel'),
              (4, 19, 'towel'), (8, 20, 'towel'), (12, 19, 'towel2')]
    for x, y, k in stacks:
        d.rectangle([x, y + 1, x + 2, y + 3], fill=P[k])
        d.line([x, y + 2, x + 2, y + 2], fill=P['shelf'] if k != 'towel3' else P['towel'])

    # the cart, centre
    d.rectangle([19, 16, 31, 23], outline=P['cart'])
    d.rectangle([20, 12, 30, 17], fill=P['towel'])
    d.rectangle([22, 11, 25, 13], fill=P['towel2'])
    d.rectangle([26, 12, 29, 14], fill=P['towel3'])
    d.line([19, 20, 31, 20], fill=P['cartd'])
    d.line([31, 14, 33, 14], fill=P['cartd'])
    d.line([33, 14, 33, 24], fill=P['cartd'])
    for x in (21, 29):
        d.rectangle([x, 24, x + 1, 25], fill=P['edge'])

    # sign and bucket, right
    d.rectangle([36, 6, 45, 14], fill=P['plate'])
    d.rectangle([37, 7, 44, 13], outline=P['ink'])
    for (x, y) in [(38, 9), (38, 10), (38, 11), (39, 10), (40, 9), (40, 10), (40, 11),   # H
                   (42, 9), (42, 10), (42, 11), (43, 10), (43, 9), (43, 11)]:          # K
        d.point((x, y), fill=P['ink'])
    d.rectangle([38, 20, 44, 25], fill=P['bucket'])
    d.line([38, 20, 44, 20], fill=P['cartd'])
    d.line([41, 11 + 8, 36, 15], fill=P['mop'])        # the mop, leaning
    d.line([42, 19, 37, 15], fill=P['mop'])
    d.rectangle([35, 14, 37, 15], fill=P['towel'])
    if night:
        d.rectangle([21, 5, 27, 6], fill=hexc('#ffd76a'))      # the lamp over the cart
        d.rectangle([22, 7, 26, 7], fill=hexc('#a87d1a'))
    return im


# --------------------------------------------------------------- the overlays

def room_dirty():
    """48x32, transparent: what a checked-out room looks like. Over the shell."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # stains on the floor
    d.ellipse([6, 24, 17, 28], fill=hexc('#4a3220', 190))
    d.ellipse([30, 26, 40, 29], fill=hexc('#3d3a22', 170))
    # a heap of used linen
    d.polygon([(10, 24), (13, 19), (18, 17), (24, 19), (27, 24)], fill=hexc('#cfd6dc'))
    d.polygon([(13, 24), (16, 20), (20, 19), (23, 24)], fill=hexc('#aab4bd'))
    d.line([13, 21, 18, 22], fill=hexc('#8793a0'))
    d.line([18, 19, 22, 21], fill=hexc('#8793a0'))
    # a bin bag, and what fell out of it
    d.ellipse([32, 18, 40, 26], fill=hexc('#1f3326'))
    d.polygon([(35, 18), (36, 15), (37, 18)], fill=hexc('#1f3326'))
    d.line([34, 18, 38, 18], fill=hexc('#ffb703'))
    for x, y, c in [(29, 27, '#ef476f'), (42, 25, '#ffb703'), (8, 21, '#e8eef2'), (44, 28, '#8ecae6'), (27, 28, '#e8eef2')]:
        d.rectangle([x, y, x + 1, y + 1], fill=hexc(c))
    # a cup on its side
    d.rectangle([21, 26, 24, 27], fill=hexc('#e8eef2'))
    d.point((25, 27), fill=hexc('#4a3220'))
    return im


def roach(d, x, y, flip, step):
    """A 5x3 cockroach with its legs in one of two steps."""
    body = hexc('#3a2312')
    back = hexc('#8a5a2a')
    sx = -1 if flip else 1
    d.rectangle([x, y, x + 4, y + 2], fill=body)
    d.line([x + 1, y + 1, x + 3, y + 1], fill=back)
    d.point((x + (0 if flip else 4) + sx * 1, y - 1), fill=body)      # antennae
    d.point((x + (0 if flip else 4) + sx * 2, y - 2), fill=body)
    legs = [(1, 3), (3, 3)] if step == 0 else [(0, 3), (2, 3), (4, 3)]
    for lx, ly in legs:
        d.point((x + lx, y + ly), fill=body)


def room_infested(step):
    """48x32, transparent: the room is lost. A tinted, crawling floor."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # sickly shadow in the corners and along the floor
    d.rectangle([0, 0, 47, 31], outline=hexc('#1b2a0c', 150))
    d.rectangle([1, 1, 46, 30], outline=hexc('#1b2a0c', 90))
    d.rectangle([2, 22, 45, 29], fill=hexc('#26330f', 110))
    d.polygon([(2, 5), (9, 5), (2, 13)], fill=hexc('#26330f', 120))
    d.polygon([(45, 5), (38, 5), (45, 13)], fill=hexc('#26330f', 120))
    # the swarm; the second frame shifts every one of them
    spots = [(5, 25, 0), (13, 21, 1), (19, 27, 0), (26, 23, 1), (33, 26, 0), (39, 21, 1), (22, 16, 0), (8, 14, 1), (41, 13, 0)]
    for i, (x, y, flip) in enumerate(spots):
        dx = 1 if step and i % 2 == 0 else (-1 if step else 0)
        dy = 1 if step and i % 3 == 0 else 0
        roach(d, x + dx, y + dy, bool(flip), (step + i) % 2)
    # a stink line or two
    for x in (11, 31):
        for k in range(5):
            d.point((x + (1 if (k + step) % 2 else 0), 12 - k * 2), fill=hexc('#8bb84a', 170))
    return im


# ----------------------------------------------------------------- the staff

PEOPLE_PALETTE = {
    '.': None,
    'K': '#0e1116',      # outline
    'H': '#3b2a20',      # hair
    'S': '#e0a47e',      # skin
    'C': '#2fb5a8',      # uniform
    'c': '#1c7f78',      # uniform, shade
    'W': '#e8eef2',      # apron / linen
    'G': '#56687d',      # trousers
    'B': '#1b2430',      # boots
    'M': '#d8c9a8',      # mop and handle
    'Y': '#ffb703',      # bucket
}

STAND = [
    "................",
    "......KKKK......",
    ".....KCCCCK.....",
    "....KCCCCCCK....",
    "....KHSSSSHK....",
    ".....KSSSSK.....",
    ".....KSSSSK.....",
    "....KcCCCCcK....",
    "...KcCWWWWCcK...",
    "...KSCWWWWCSK...",
    "...KSCWWWWCSK...",
    "....KCCCCCCK....",
    ".....KGGGGK.....",
    ".....KGKKGK.....",
    ".....KBKKBK.....",
    ".....BBKKBB.....",
]

# Same figure holding a bundle of linen in both arms: someone waiting for a lift.
WAIT = [
    "................",
    "......KKKK......",
    ".....KCCCCK.....",
    "....KCCCCCCK....",
    "....KHSSSSHK....",
    ".....KSSSSK.....",
    ".....KSSSSK.....",
    "....KcCCCCcK....",
    "...KcCWWWWCcK...",
    "..KWWWWWWWWWWK..",
    "..KWWWWWWWWWWK..",
    "..KSWWWWWWWWSK..",
    ".....KGGGGK.....",
    ".....KGKKGK.....",
    ".....KBKKBK.....",
    ".....BBKKBB.....",
]


def mop(frame):
    """The stand pose with a mop in the right hand; the head swings between frames."""
    rows = [list(r) for r in STAND]
    # the right hand grips the handle
    rows[9][11] = 'S'
    rows[10][12] = 'M'
    for i, r in enumerate((11, 12, 13, 14)):
        col = 12 + (1 if frame else 0) + (i // 2)
        col = min(col, 15)
        rows[r][col] = 'M'
    head = 15
    for c in range(11 + (2 if frame else 0), 16 if not frame else 16):
        if 0 <= c < 16 and rows[head][c] == '.':
            rows[head][c] = 'W'
    return [''.join(r) for r in rows]


def sprite(rows):
    im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        assert len(row) == 16, (y, row)
        for x, ch in enumerate(row):
            colour = PEOPLE_PALETTE[ch]
            if colour:
                im.putpixel((x, y), hexc(colour))
    return im


def strip(frames, w, h):
    sheet = Image.new('RGBA', (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * w, 0))
    return sheet


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    strip([facility(False), facility(True)], 48, 32).save(OUT / 'housekeeping.png')
    strip([room_dirty(), room_infested(0), room_infested(1)], 48, 32).save(OUT / 'room-status.png')
    strip([sprite(STAND), sprite(WAIT), sprite(mop(0)), sprite(mop(1))], 16, 16).save(OUT / 'person-staff.png')
    print('wrote housekeeping.png, room-status.png, person-staff.png to', OUT)


if __name__ == '__main__':
    main()
