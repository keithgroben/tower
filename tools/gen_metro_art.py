#!/usr/bin/env python3
"""
Draws the sheet issue #15 (the metro station) needs, straight to native size.

    python tools/gen_metro_art.py
    node src/games/tower/assets/sprites/sidecars.gen.mjs

Writes into src/games/tower/assets/sprites/:

  metro.png   288x32   top, top-train, middle, middle-train, bottom, bottom-train

This is **procedural placeholder art**, in the house palette
(spec/sprite-manifest.md) - flat shapes on the 48x32 slot, no gradients - so the
station can be seen and the loader, the catalogue and test/sprites.test.js have
something real to hold level. Orange is the metro's hue (teal is housekeeping,
blue security, violet hotel). An artist can replace the PNG and re-run the sidecar
generator; nothing else needs to change, because the frames are listed in
tools/sprite-catalog.json.

The station is a three-floor stack, 30 tiles wide, and the renderer repeats one
48x32 cell (six tiles) along the span - so every frame is a TILEABLE slice, and a
train is a carriage that joins its neighbours into one long train:

  top      the concourse: ticket hall, a gate, the line sign (METRO.md: the anchor
           floor, the one the lifts reach and the commuters come up from)
  middle   the stairs and the platform's upper deck
  bottom   the platform and the track
  *-train  the same slice with a train standing at the platform (METRO.md's `+0xc`
           display variant `2`; `0` is the empty platform)

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


P = {
    'edge': hexc('#0e1116'),
    'wall': hexc('#2d3340'),
    'wall2': hexc('#394152'),
    'ceil': hexc('#1d222c'),
    'tile': hexc('#586173'),
    'tile2': hexc('#434b5b'),
    'rail': hexc('#8a93a3'),
    'sleeper': hexc('#4a3b30'),
    'pit': hexc('#14181f'),
    'orange': hexc('#ef8a3a'),
    'orange2': hexc('#b5611f'),
    'lamp': hexc('#ffd76a'),
    'glass': hexc('#8ecae6'),
    'glass2': hexc('#5d93b0'),
    'body': hexc('#c8d2dc'),
    'body2': hexc('#9aa6b5'),
    'plate': hexc('#0b0f14'),
    'ink': hexc('#ffb703'),
}


def base():
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    return im, d


def top(train):
    """The concourse. A ticket gate every cell, and the line sign on the wall."""
    im, d = base()
    d.rectangle([0, 1, 47, 3], fill=P['ceil'])
    d.rectangle([0, 4, 47, 25], fill=P['wall'])
    d.line([0, 4, 47, 4], fill=P['wall2'])
    d.rectangle([0, 26, 47, 31], fill=P['tile'])
    d.line([0, 26, 47, 26], fill=P['tile2'])
    for x in range(0, 48, 12):
        d.line([x, 27, x, 31], fill=P['tile2'])
    # the line sign: an orange roundel with an M
    d.rectangle([3, 7, 18, 16], fill=P['plate'])
    d.rectangle([4, 8, 17, 15], outline=P['orange'])
    for (x, y) in [(6, 14), (6, 13), (6, 12), (6, 11), (7, 10), (8, 11), (9, 12),
                   (10, 12), (11, 11), (12, 10), (13, 11), (13, 12), (13, 13), (13, 14)]:
        d.point((x, y), fill=P['ink'])
    # a ticket gate: two posts and a flap
    d.rectangle([26, 17, 27, 25], fill=P['rail'])
    d.rectangle([38, 17, 39, 25], fill=P['rail'])
    d.rectangle([28, 20, 37, 21], fill=P['orange'] if not train else P['glass'])
    d.rectangle([29, 14, 36, 16], fill=P['plate'])
    d.rectangle([30, 15, 35, 15], fill=P['lamp'] if train else P['orange2'])  # the "train arriving" lamp
    # the glow of an arriving train on the floor
    if train:
        d.rectangle([2, 27, 46, 28], fill=hexc('#f4c36a'))
    return im


def middle(train):
    """The upper deck: a stair well and the lip of the platform."""
    im, d = base()
    d.rectangle([0, 1, 47, 4], fill=P['ceil'])
    d.rectangle([0, 5, 47, 24], fill=P['wall'])
    d.line([0, 5, 47, 5], fill=P['wall2'])
    # tiled wall
    for x in range(0, 48, 8):
        d.line([x, 6, x, 24], fill=P['wall2'])
    d.rectangle([0, 25, 47, 31], fill=P['tile'])
    d.line([0, 25, 47, 25], fill=P['tile2'])
    # stairs, descending left to right
    for i in range(5):
        d.rectangle([4 + i * 3, 12 + i * 2, 6 + i * 3, 24], fill=P['tile2'])
        d.line([4 + i * 3, 12 + i * 2, 6 + i * 3, 12 + i * 2], fill=P['rail'])
    d.line([3, 11, 20, 21], fill=P['rail'])
    # the yellow safety edge
    d.line([0, 30, 47, 30], fill=P['ink'])
    if train:
        # the carriage roof, seen from above the platform
        d.rectangle([0, 6, 47, 12], fill=P['body'])
        d.line([0, 12, 47, 12], fill=P['body2'])
        for x in range(2, 47, 12):
            d.rectangle([x, 8, x + 5, 10], fill=P['glass'])
    return im


def bottom(train):
    """The platform and the track."""
    im, d = base()
    d.rectangle([0, 1, 47, 3], fill=P['ceil'])
    d.rectangle([0, 4, 47, 15], fill=P['wall'])
    d.line([0, 4, 47, 4], fill=P['wall2'])
    # the platform edge, with its safety line
    d.rectangle([0, 16, 47, 21], fill=P['tile'])
    d.line([0, 16, 47, 16], fill=P['ink'])
    d.line([0, 21, 47, 21], fill=P['tile2'])
    # the track pit, the rails, the sleepers
    d.rectangle([0, 22, 47, 30], fill=P['pit'])
    for x in range(1, 48, 6):
        d.rectangle([x, 27, x + 2, 29], fill=P['sleeper'])
    d.line([0, 26, 47, 26], fill=P['rail'])
    d.line([0, 30, 47, 30], fill=P['rail'])
    # pillars with the orange stripe
    d.rectangle([22, 4, 25, 21], fill=P['wall2'])
    d.rectangle([22, 10, 25, 11], fill=P['orange'])
    if train:
        # a carriage standing at the platform, joined to its neighbours at both edges
        d.rectangle([0, 8, 47, 25], fill=P['body'])
        d.rectangle([0, 8, 47, 9], fill=P['body2'])
        d.rectangle([0, 17, 47, 19], fill=P['orange'])
        for x in range(3, 45, 14):
            d.rectangle([x, 11, x + 8, 16], fill=P['glass'])
            d.rectangle([x, 15, x + 8, 16], fill=P['glass2'])
        d.rectangle([0, 24, 47, 25], fill=P['body2'])
        for x in (6, 30):
            d.rectangle([x, 26, x + 5, 29], fill=P['plate'])
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    frames = [top(False), top(True), middle(False), middle(True), bottom(False), bottom(True)]
    sheet = Image.new('RGBA', (48 * len(frames), 32), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        sheet.paste(frame, (i * 48, 0))
    sheet.save(OUT / 'metro.png')
    print('wrote metro.png to', OUT, sheet.size)


if __name__ == '__main__':
    main()
