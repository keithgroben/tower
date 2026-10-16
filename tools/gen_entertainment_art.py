#!/usr/bin/env python3
"""
Draws the two sheets issue #11 (movie theater and party hall) needs, straight to
native size.

    python tools/gen_entertainment_art.py

Writes into src/games/tower/assets/sprites/:

  theater.png     144x32   upper, lower, showing   the movie theater, one frame per floor
  party-hall.png  144x32   upper, lower, party     the party hall, one frame per floor

**Procedural placeholder art**, in the house palette (spec/sprite-manifest.md) -
flat shapes on the 48x32 slot, no gradients - so both facilities can be seen and
the loader, the catalogue and test/sprites.test.js have something real to hold
level. Each venue is TWO floors, so each sheet carries a frame for the upper
floor and one for the lower, and a third that lights the primary floor while the
venue's day is running ("showing": the screen is on; "party": the hall is lit).
An artist can replace the PNGs and re-run
`node src/games/tower/assets/sprites/sidecars.gen.mjs`; nothing else needs to
change, because the frames are listed in tools/sprite-catalog.json.

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def frame(rim, wall):
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 47, 31], fill=hexc('#0e1116'))
    d.rectangle([1, 1, 46, 30], fill=hexc(rim))
    d.rectangle([2, 2, 45, 29], fill=hexc(wall))
    return im, d


# ---------------------------------------------------------------- the theater

def theater_upper():
    """The balcony floor: a marquee of chasing bulbs over two posters."""
    im, d = frame('#4a2c6b', '#241838')
    # the marquee
    d.rectangle([4, 4, 43, 10], fill=hexc('#0e1116'))
    for x in range(6, 43, 4):
        d.point((x, 5), fill=hexc('#ffd76a'))
        d.point((x + 2, 9), fill=hexc('#ffd76a'))
    d.rectangle([8, 6, 39, 8], fill=hexc('#c77dff'))
    # two posters in frames
    for px, col in ((6, '#e76f51'), (28, '#06d6a0')):
        d.rectangle([px, 13, px + 13, 28], fill=hexc('#0e1116'))
        d.rectangle([px + 1, 14, px + 12, 27], fill=hexc(col))
        d.rectangle([px + 4, 17, px + 9, 23], fill=hexc('#241838'))
        d.line([px + 2, 25, px + 11, 25], fill=hexc('#f4ece0'))
    d.line([2, 29, 45, 29], fill=hexc('#171a20'))
    return im


def theater_lower():
    """The ground of the building: a box office window and the double doors."""
    im, d = frame('#4a2c6b', '#2e2046')
    # the box office
    d.rectangle([4, 10, 19, 28], fill=hexc('#0e1116'))
    d.rectangle([5, 11, 18, 27], fill=hexc('#3a4d66'))
    d.rectangle([7, 15, 16, 21], fill=hexc('#ffb703'))
    d.rectangle([8, 16, 15, 20], fill=hexc('#0b0f14'))
    d.line([7, 23, 16, 23], fill=hexc('#dfe6ee'))
    # double doors, carpet
    d.rectangle([24, 8, 41, 29], fill=hexc('#0e1116'))
    d.rectangle([25, 9, 32, 29], fill=hexc('#8b2331'))
    d.rectangle([33, 9, 40, 29], fill=hexc('#8b2331'))
    d.line([32, 9, 32, 29], fill=hexc('#0e1116'))
    d.point((31, 20), fill=hexc('#ffb703'))
    d.point((34, 20), fill=hexc('#ffb703'))
    d.rectangle([22, 28, 43, 29], fill=hexc('#c77dff'))
    return im


def theater_showing():
    """The balcony floor with the picture on: a lit screen, the audience dark against it."""
    im, d = frame('#4a2c6b', '#150f22')
    d.rectangle([5, 4, 42, 19], fill=hexc('#0e1116'))
    d.rectangle([6, 5, 41, 18], fill=hexc('#dfe6ee'))
    d.rectangle([6, 5, 41, 8], fill=hexc('#8ecae6'))
    d.polygon([(6, 18), (16, 11), (26, 15), (34, 9), (41, 14), (41, 18)], fill=hexc('#2b3a4d'))
    d.ellipse([33, 6, 38, 11], fill=hexc('#ffd76a'))
    # rows of seats with heads
    for y, shade in ((22, '#3a2a50'), (26, '#2b1f40')):
        d.rectangle([4, y, 43, y + 3], fill=hexc(shade))
        for x in range(7, 42, 6):
            d.rectangle([x, y - 2, x + 2, y], fill=hexc('#0e1116'))
    return im


# ------------------------------------------------------------- the party hall

def hall_upper():
    """The gallery floor: a railing with bunting hung across it."""
    im, d = frame('#7a1e4d', '#3b1530')
    d.line([4, 9, 43, 9], fill=hexc('#dfe6ee'))
    for i, x in enumerate(range(5, 43, 5)):
        col = ('#ff70a6', '#ffd76a', '#06d6a0', '#8ecae6')[i % 4]
        d.polygon([(x, 9), (x + 4, 9), (x + 2, 15)], fill=hexc(col))
    d.rectangle([4, 20, 43, 21], fill=hexc('#dfe6ee'))
    for x in range(5, 44, 4):
        d.line([x, 21, x, 28], fill=hexc('#dfe6ee'))
    d.line([2, 29, 45, 29], fill=hexc('#1c0a18'))
    return im


def hall_lower():
    """The hall with the party not yet started: drawn curtains, a banner, a table."""
    im, d = frame('#7a1e4d', '#2b1024')
    d.rectangle([4, 4, 43, 8], fill=hexc('#0e1116'))
    d.rectangle([6, 5, 41, 7], fill=hexc('#ff70a6'))
    for x in (4, 38):
        d.rectangle([x, 9, x + 5, 28], fill=hexc('#8b2331'))
        for y in range(10, 28, 4):
            d.line([x + 1, y, x + 1, y + 2], fill=hexc('#a8293d'))
    d.rectangle([14, 20, 33, 22], fill=hexc('#f4ece0'))
    d.rectangle([16, 23, 17, 28], fill=hexc('#8b5e3c'))
    d.rectangle([30, 23, 31, 28], fill=hexc('#8b5e3c'))
    d.rectangle([22, 15, 25, 19], fill=hexc('#ffd76a'))
    return im


def hall_party():
    """The hall lit and full: balloons, a glitter ball, a crowd."""
    im, d = frame('#7a1e4d', '#1c0a18')
    d.ellipse([20, 3, 27, 10], fill=hexc('#dfe6ee'))
    for (x, y, c) in ((4, 5, '#ff70a6'), (10, 9, '#ffd76a'), (38, 5, '#06d6a0'), (33, 10, '#8ecae6'),
                      (14, 4, '#06d6a0'), (30, 4, '#ff70a6')):
        d.ellipse([x, y, x + 3, y + 4], fill=hexc(c))
        d.line([x + 1, y + 5, x + 1, y + 9], fill=hexc('#dfe6ee'))
    d.polygon([(8, 29), (20, 12), (28, 12), (40, 29)], fill=hexc('#2d1b3d'))
    for i, x in enumerate(range(7, 42, 5)):
        d.rectangle([x, 22, x + 2, 24], fill=hexc('#0e1116'))
        d.rectangle([x, 25, x + 2, 28], fill=hexc(('#ff70a6', '#ffd76a', '#06d6a0', '#8ecae6')[i % 4]))
    d.line([2, 29, 45, 29], fill=hexc('#1c0a18'))
    return im


def sheet(frames):
    out = Image.new('RGBA', (48 * len(frames), 32), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        out.paste(f, (48 * i, 0))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheet([theater_upper(), theater_lower(), theater_showing()]).save(OUT / 'theater.png')
    print('wrote', OUT / 'theater.png')
    sheet([hall_upper(), hall_lower(), hall_party()]).save(OUT / 'party-hall.png')
    print('wrote', OUT / 'party-hall.png')


if __name__ == '__main__':
    main()
