#!/usr/bin/env python3
"""
Draws the sheets issue #17 (the cathedral and the Tower rank) needs, straight to native size.

    python tools/gen_cathedral_art.py
    node src/games/tower/assets/sprites/sidecars.gen.mjs

Writes into src/games/tower/assets/sprites/:

  cathedral.png   720x32   s1..s5 (the five floors, bottom to top), then s1..s5 -wedding,
                           then s1..s5 -crowned                          (15 frames of 48x32)
  fireworks.png   1152x64  burst-red x6, burst-gold x6, burst-blue x6    (18 frames of 64x64)

This is **procedural placeholder art**, in the house palette (spec/sprite-manifest.md) - flat
shapes, no gradients - so the cathedral and the finish can be seen, and the loader, the
catalogue and test/sprites.test.js have something real to hold level. An artist can replace
either PNG and re-run the sidecar generator; nothing else changes, because the frames are
listed in tools/sprite-catalog.json.

The cathedral is a five-floor stack, 28 tiles wide, and the renderer repeats one 48x32 cell
(six tiles) along the span - so every frame is a TILEABLE slice:

  s1  the porch: a pointed door in every cell, buttresses at the cell edges
  s2  the nave: two tall stained-glass lancets per cell (their lower halves)
  s3  the nave: the same lancets, with a rose in the middle of the cell
  s4  the clerestory: the lancets' pointed tops
  s5  the roof: slate gables with a finial on each peak

  -wedding  the same slice with every window lit warm and bunting on the porch (EVALUATION.md:
            aux value 3, while guests are arriving)
  -crowned  the same slice picked out in gold (aux value 2, once the Tower rank is awarded)

The fireworks are the finish's burst: a flash, then twelve sparks flying out and falling,
six frames, three colours.

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


P = {
    'edge': hexc('#0e1116'),
    'stone': hexc('#8c8576'),
    'stone2': hexc('#6f695d'),
    'stone3': hexc('#a39c8b'),
    'slate': hexc('#3a4658'),
    'slate2': hexc('#2a3342'),
    'slate3': hexc('#52627a'),
    'door': hexc('#4a2f1f'),
    'door2': hexc('#2d1c12'),
    'glass_b': hexc('#4a7fd1'),
    'glass_r': hexc('#d1495b'),
    'glass_g': hexc('#e0a526'),
    'dark': hexc('#1a2030'),
    'warm': hexc('#ffd76a'),
    'warm2': hexc('#ffb703'),
    'gold': hexc('#ffcf40'),
    'gold2': hexc('#c8941a'),
    'white': hexc('#f4f1e8'),
    'rose': hexc('#ef476f'),
    'flag1': hexc('#ef476f'),
    'flag2': hexc('#4cc9f0'),
    'flag3': hexc('#ffd23f'),
}


def base(fill):
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    d.rectangle([0, 1, 47, 30], fill=fill)
    return im, d


def masonry(d, fill_a, fill_b):
    """Courses of stone: the wall is read as stone from a long way off."""
    for y in range(1, 31, 5):
        d.line([0, y, 47, y], fill=fill_b)
        off = 4 if (y // 5) % 2 else 0
        for x in range(off, 48, 8):
            d.line([x, y, x, min(30, y + 4)], fill=fill_b)


def lancet(d, x, top, bottom, glass, lit, gold):
    """A pointed window: 8 wide, with a mullion."""
    frame = P['gold'] if gold else P['stone3']
    d.rectangle([x - 1, top, x + 8, bottom], fill=frame)
    d.rectangle([x, top + 1, x + 7, bottom], fill=P['warm'] if lit else glass)
    d.line([x + 3, top + 1, x + 3, bottom], fill=P['gold2'] if gold else P['dark'])
    d.line([x + 4, top + 1, x + 4, bottom], fill=P['warm2'] if lit else P['dark'])


def slice_frame(n, look):
    lit = look == 'wedding'
    gold = look == 'crowned'
    glass = [P['glass_b'], P['glass_r'], P['glass_g']]
    if n == 5:
        im, d = base(P['slate'])
        for x in range(0, 48, 24):
            # a gable per half cell: two slopes and a finial
            d.polygon([(x, 30), (x + 12, 6), (x + 24, 30)], fill=P['slate3'])
            d.polygon([(x + 12, 6), (x + 24, 30), (x + 12, 30)], fill=P['slate2'])
            d.line([x + 12, 6, x + 12, 2], fill=P['gold'] if gold else P['stone3'])
            d.point((x + 12, 1), fill=P['gold'] if gold else P['white'])
            d.line([x + 10, 3, x + 14, 3], fill=P['gold'] if gold else P['stone3'])
            if lit:
                d.rectangle([x + 10, 18, x + 13, 22], fill=P['warm'])
        d.line([0, 30, 47, 30], fill=P['gold'] if gold else P['stone2'])
        return im
    im, d = base(P['stone'])
    masonry(d, P['stone'], P['stone2'])
    trim = P['gold'] if gold else P['stone3']
    d.line([0, 1, 47, 1], fill=trim)
    d.line([0, 30, 47, 30], fill=trim)
    # buttresses at the cell edge
    d.rectangle([0, 1, 2, 30], fill=P['stone3'])
    d.rectangle([45, 1, 47, 30], fill=P['stone3'])
    if gold:
        d.line([2, 1, 2, 30], fill=P['gold'])
        d.line([45, 1, 45, 30], fill=P['gold'])
    if n == 1:
        # the porch: a pointed door
        d.polygon([(14, 30), (14, 14), (24, 4), (34, 14), (34, 30)], fill=P['stone3'])
        d.polygon([(16, 30), (16, 15), (24, 7), (32, 15), (32, 30)], fill=P['door'])
        d.line([24, 7, 24, 30], fill=P['door2'])
        d.rectangle([20, 20, 21, 21], fill=P['gold2'])
        d.rectangle([27, 20, 28, 21], fill=P['gold2'])
        if lit:
            # bunting, and a lit doorway
            d.rectangle([21, 22, 27, 30], fill=P['warm'])
            for i, x in enumerate(range(4, 44, 6)):
                col = [P['flag1'], P['flag2'], P['flag3']][i % 3]
                d.polygon([(x, 3), (x + 4, 3), (x + 2, 8)], fill=col)
            d.line([3, 3, 44, 3], fill=P['white'])
        if gold:
            d.line([14, 14, 24, 4], fill=P['gold'])
            d.line([24, 4, 34, 14], fill=P['gold'])
    else:
        # two lancets per cell: lower halves in s2, with a rose in s3, pointed tops in s4
        for i, x in enumerate((8, 31)):
            g = glass[(i + n) % 3]
            if n == 2:
                lancet(d, x, 3, 30, g, lit, gold)
            elif n == 3:
                lancet(d, x, 0, 30, g, lit, gold)
                d.ellipse([20, 11, 27, 18], fill=P['warm'] if lit else P['glass_r'], outline=P['gold'] if gold else P['stone3'])
                d.point((23, 14), fill=P['warm2'] if lit else P['dark'])
            else:
                lancet(d, x, 6, 30, g, lit, gold)
                d.polygon([(x - 1, 6), (x + 3, 0), (x + 4, 0), (x + 8, 6)], fill=P['gold'] if gold else P['stone3'])
                d.polygon([(x, 6), (x + 3, 2), (x + 4, 2), (x + 7, 6)], fill=P['warm'] if lit else g)
    return im


def burst(color, frame):
    """One firework frame: a flash, then twelve sparks flying out and falling."""
    im = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = 32, 30
    core = hexc('#fff3b0')
    if frame == 0:
        d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=core)
        d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=color)
        return im
    radius = 6 + frame * 5
    fade = 1.0 - (frame - 1) / 6.0
    sparks = 12
    for k in range(sparks):
        angle = 2 * math.pi * k / sparks + (0.15 if k % 2 else 0.0)
        x = cx + math.cos(angle) * radius
        y = cy + math.sin(angle) * radius + frame * frame * 0.6   # falling
        size = 2 if frame < 4 else 1
        shade = (color[0], color[1], color[2], int(255 * max(0.25, fade)))
        d.rectangle([x - size, y - size, x + size, y + size], fill=shade)
        if frame < 5:
            tx = cx + math.cos(angle) * (radius - 4)
            ty = cy + math.sin(angle) * (radius - 4) + (frame - 1) * (frame - 1) * 0.6
            d.point((tx, ty), fill=core)
    # a pale ring that thins out
    if frame < 4:
        ring = (color[0], color[1], color[2], int(120 * fade))
        d.ellipse([cx - radius + 3, cy - radius + 3, cx + radius - 3, cy + radius - 3], outline=ring)
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    frames = [slice_frame(n, look) for look in ('idle', 'wedding', 'crowned') for n in range(1, 6)]
    sheet = Image.new('RGBA', (48 * len(frames), 32), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        sheet.paste(frame, (i * 48, 0))
    sheet.save(OUT / 'cathedral.png')
    print('wrote cathedral.png to', OUT, sheet.size)

    colours = [hexc('#ef476f'), hexc('#ffd23f'), hexc('#4cc9f0')]
    bursts = [burst(c, f) for c in colours for f in range(6)]
    fw = Image.new('RGBA', (64 * len(bursts), 64), (0, 0, 0, 0))
    for i, frame in enumerate(bursts):
        fw.paste(frame, (i * 64, 0))
    fw.save(OUT / 'fireworks.png')
    print('wrote fireworks.png to', OUT, fw.size)


if __name__ == '__main__':
    main()
