#!/usr/bin/env python3
"""
Draws the sheets issue #16 (the events) needs, straight to native size.

    python tools/gen_events_art.py
    node src/games/tower/assets/sprites/sidecars.gen.mjs

Writes into src/games/tower/assets/sprites/:

  person-vip.png    64x16   stand, fidget, wait, wait-annoyed   (the VIP: a yellow Sim)
  fire.png          32x32   flame x2                           (a fire front, two tiles wide)
  burned-area.png   48x32   scorch                             (ground a fire or a bomb took)
  explosion.png     96x32   blast x2                           (a bomb going off, one art cell)
  sky-santa.png     96x32   fly x2                             (a sleigh over the tower)

This is **procedural placeholder art**, in the house palette (spec/sprite-manifest.md) -
flat shapes, no gradients - so the VIP, the fire, the blast and Santa can be seen, and the
loader, the catalogue and test/sprites.test.js have something real to hold level. An artist
can replace any PNG and re-run the sidecar generator; nothing else changes, because the
frames are listed in tools/sprite-catalog.json.

The VIP is the one figure in the game that is yellow (the issue: *"yellow Sim sprite"*). He
stands in the same four postures as the other people, drawn from the same stress bands, so he
is read the same way: a calm VIP stands, a fed-up one taps a foot. A briefcase is the tell.

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


P = {
    'ink': hexc('#0e1116'),
    'skin': hexc('#f1c7a0'),
    'yellow': hexc('#ffd23f'),
    'yellow2': hexc('#d9a800'),
    'suit': hexc('#8a6d00'),
    'case': hexc('#3a2a14'),
    'shoe': hexc('#1d222c'),
    'red': hexc('#ef476f'),
    'orange': hexc('#ef8a3a'),
    'flame': hexc('#ffb703'),
    'core': hexc('#fff3b0'),
    'smoke': hexc('#3d4452'),
    'char': hexc('#1a1410'),
    'char2': hexc('#2b2018'),
    'ember': hexc('#7a2a14'),
    'sleigh': hexc('#c1121f'),
    'sleigh2': hexc('#8d0801'),
    'gold': hexc('#ffd23f'),
    'white': hexc('#f4f1de'),
    'brown': hexc('#6b4226'),
    'night': hexc('#0b0f14'),
}


def sheet(frames, w, h):
    s = Image.new('RGBA', (w * len(frames), h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        s.paste(f, (i * w, 0))
    return s


# ------------------------------------------------------------------ the VIP

def vip(pose):
    """A 16x16 yellow Sim in a suit, with a briefcase. `pose` is one of the four postures."""
    im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lean = {'stand': 0, 'fidget': 1, 'wait': 0, 'wait-annoyed': -1}[pose]
    x0 = 5 + lean
    # head
    d.rectangle([x0 + 1, 2, x0 + 4, 5], fill=P['skin'])
    d.rectangle([x0 + 1, 1, x0 + 4, 2], fill=P['ink'])          # hair
    # body: a yellow jacket, the one yellow thing in the tower
    d.rectangle([x0, 6, x0 + 5, 11], fill=P['yellow'])
    d.rectangle([x0, 10, x0 + 5, 11], fill=P['yellow2'])
    d.line([x0 + 3, 6, x0 + 3, 10], fill=P['suit'])               # lapel
    # legs
    d.rectangle([x0 + 1, 12, x0 + 2, 14], fill=P['suit'])
    d.rectangle([x0 + 3, 12, x0 + 4, 14], fill=P['suit'])
    d.rectangle([x0 + 1, 15, x0 + 2, 15], fill=P['shoe'])
    d.rectangle([x0 + 3, 15, x0 + 4, 15], fill=P['shoe'])
    # the briefcase, in the near hand (swung out when fidgeting)
    bx = x0 + 6 + (1 if pose == 'fidget' else 0)
    d.rectangle([bx, 10, bx + 3, 13], fill=P['case'])
    d.line([bx + 1, 9, bx + 2, 9], fill=P['case'])
    if pose == 'wait':                                            # looks at a watch
        d.point((x0 - 1, 8), fill=P['skin'])
        d.point((x0 - 1, 7), fill=P['skin'])
    if pose == 'wait-annoyed':                                    # a scowl and a red stripe
        d.line([x0 + 1, 4, x0 + 4, 4], fill=P['red'])
        d.rectangle([x0 + 4, 6, x0 + 5, 6], fill=P['red'])
        d.point((x0 - 1, 7), fill=P['skin'])
    return im


# --------------------------------------------------------------------- fire

def flame(frame):
    """A 16x32 flame column: two tiles wide, a floor tall. Two frames lick in opposite directions."""
    im = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    sway = 1 if frame == 0 else -1
    # the base, a bed of embers
    d.rectangle([1, 28, 14, 31], fill=P['ember'])
    # outer flame
    pts = [(1, 31), (3, 20 - sway), (5, 14), (7, 6), (8 + sway, 1), (10, 8), (12, 15 + sway), (14, 22), (15, 31)]
    d.polygon(pts, fill=P['red'])
    pts = [(3, 31), (5, 21), (7, 12 + sway), (8, 6), (9, 13), (11, 20), (13, 31)]
    d.polygon(pts, fill=P['orange'])
    pts = [(5, 31), (7, 22), (8, 15 - sway), (9, 22), (11, 31)]
    d.polygon(pts, fill=P['flame'])
    d.rectangle([7, 25, 9, 30], fill=P['core'])
    return im


def scorch():
    """48x32: a floor bay that burned. Black ground, a ruined slab, a few embers."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 1, 47, 29], fill=P['char'])
    d.rectangle([0, 1, 47, 3], fill=P['char2'])
    for x in range(2, 46, 7):                                     # broken stubs of wall
        h = 6 + (x * 5) % 9
        d.rectangle([x, 29 - h, x + 3, 29], fill=P['char2'])
    for x, y in [(6, 26), (19, 27), (31, 25), (42, 27), (13, 21), (37, 19)]:
        d.point((x, y), fill=P['ember'])
        d.point((x + 1, y), fill=P['orange'])
    d.rectangle([0, 29, 47, 31], fill=P['smoke'])                 # the slab, cracked
    d.line([0, 30, 47, 30], fill=P['char'])
    return im


def blast(frame):
    """48x32: a fireball filling one art cell. Frame 1 is the bigger, paler puff."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = 11 if frame == 0 else 14
    cx, cy = 24, 16
    d.ellipse([cx - r - 3, cy - r - 2, cx + r + 3, cy + r + 2], fill=P['smoke'])
    d.ellipse([cx - r, cy - r + 1, cx + r, cy + r - 1], fill=P['red'])
    d.ellipse([cx - r + 4, cy - r + 4, cx + r - 4, cy + r - 4], fill=P['orange'])
    d.ellipse([cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8], fill=P['flame'])
    if frame == 0:
        d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=P['core'])
    for i, (dx, dy) in enumerate([(-15, -9), (15, -8), (-13, 10), (14, 11), (0, -15)]):
        d.rectangle([cx + dx, cy + dy, cx + dx + 2 + frame, cy + dy + 2 + frame], fill=P['flame'])
    return im


# -------------------------------------------------------------------- Santa

def santa(frame):
    """48x32: a sleigh and a reindeer. Two frames: hooves up, hooves down."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    up = frame == 0
    # the sleigh, on the right
    d.polygon([(24, 14), (44, 14), (46, 11), (43, 21), (26, 21)], fill=P['sleigh'])
    d.line([24, 22, 44, 22], fill=P['gold'])                      # the runner
    d.line([24, 22, 22, 20], fill=P['gold'])
    d.rectangle([30, 8, 37, 14], fill=P['sleigh2'])               # Santa
    d.rectangle([31, 5, 36, 8], fill=P['skin'])
    d.rectangle([31, 3, 36, 5], fill=P['sleigh'])
    d.point((36, 3), fill=P['white'])
    d.rectangle([31, 7, 36, 8], fill=P['white'])                  # beard
    d.rectangle([38, 10, 43, 14], fill=P['brown'])                # a sack of presents
    # the reindeer, on the left
    y = 14 if up else 16
    d.rectangle([6, y, 16, y + 5], fill=P['brown'])
    d.rectangle([14, y - 4, 18, y], fill=P['brown'])
    d.point((17, y - 3), fill=P['ink'])
    d.rectangle([18, y - 3, 19, y - 2], fill=P['red'])            # a red nose
    d.line([15, y - 5, 13, y - 8], fill=P['brown'])               # antlers
    d.line([17, y - 5, 18, y - 8], fill=P['brown'])
    for x in (7, 9, 13, 15):
        d.line([x, y + 6, x + (2 if up else -1), y + 8], fill=P['brown'])
    d.line([18, y + 3, 24, 18], fill=P['gold'])                   # the harness
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    poses = ['stand', 'fidget', 'wait', 'wait-annoyed']
    sheet([vip(p) for p in poses], 16, 16).save(OUT / 'person-vip.png')
    sheet([flame(0), flame(1)], 16, 32).save(OUT / 'fire.png')
    sheet([scorch()], 48, 32).save(OUT / 'burned-area.png')
    sheet([blast(0), blast(1)], 48, 32).save(OUT / 'explosion.png')
    sheet([santa(0), santa(1)], 48, 32).save(OUT / 'sky-santa.png')
    print('wrote person-vip, fire, burned-area, explosion, sky-santa to', OUT)


if __name__ == '__main__':
    main()
