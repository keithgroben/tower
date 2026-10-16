#!/usr/bin/env python3
"""
Draws the two sheets issue #13 (medical center, parking) needs that nobody has
delivered, straight to native size.

    python tools/gen_service_art.py

Writes into src/games/tower/assets/sprites/:

  medical.png       96x32   day, night   the medical center
  parking-ramp.png  48x32   tile         the parking ramp (one tile wide: the
                                         left 8px of the cell is what shows)

This is **procedural placeholder art**, in the house palette
(spec/sprite-manifest.md) - flat shapes on the 48x32 slot, no gradients - so the
facilities can be seen and the loader, the catalogue and test/sprites.test.js have
something real to hold level. White and clinic-teal are medical's hues (teal is
housekeeping's, but the red cross carries it), a grey slope with hazard stripes is
the ramp's. An artist can replace the PNGs and re-run
`node src/games/tower/assets/sprites/sidecars.gen.mjs`; nothing else needs to change,
because the frames are listed in tools/sprite-catalog.json.

The parking SPACE and the RECYCLING CENTER need nothing from here: the delivered
`basement-parking` (empty, one car, two cars) and `basement-utility` sheets are what
they draw.

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def clinic(night):
    """48x32: a ward - a bed, a cabinet, a nurse, and the red cross on the wall."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    P = {
        'edge': hexc('#0e1116'),
        'rim': hexc('#6fb8b0' if not night else '#2f5551'),
        'ceil': hexc('#dfe9ea' if not night else '#46585c'),
        'wall': hexc('#eef4f4' if not night else '#5d7075'),
        'wall2': hexc('#cfe0e0' if not night else '#4a5d62'),
        'floor': hexc('#9fb3b3' if not night else '#2b373a'),
        'floor2': hexc('#b9c9c9' if not night else '#37464a'),
        'cross': hexc('#ef476f'),
        'plate': hexc('#ffffff' if not night else '#aab7ba'),
        'bed': hexc('#d9e3e8' if not night else '#7d8c93'),
        'bedframe': hexc('#6b7a86'),
        'blanket': hexc('#8ecae6' if not night else '#4f7f96'),
        'cab': hexc('#8a9aa6' if not night else '#46525b'),
        'cabt': hexc('#c8d2dc' if not night else '#5d6a74'),
        'skin': hexc('#e0a47e'),
        'coat': hexc('#ffffff' if not night else '#b9c6cc'),
        'pants': hexc('#3a5a6a'),
        'hair': hexc('#4b3a2a'),
        'lamp': hexc('#ffd76a'),
    }
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    d.rectangle([1, 1, 46, 30], fill=P['rim'])
    d.rectangle([2, 2, 45, 4], fill=P['ceil'])
    d.rectangle([2, 5, 45, 25], fill=P['wall'])
    for x in range(6, 45, 8):
        d.line([x, 5, x, 25], fill=P['wall2'])
    d.rectangle([2, 26, 45, 29], fill=P['floor'])
    d.line([2, 26, 45, 26], fill=P['floor2'])

    # the sign: a white plate with the red cross
    d.rectangle([33, 6, 45, 18], fill=P['edge'])
    d.rectangle([34, 7, 44, 17], fill=P['plate'])
    d.rectangle([38, 8, 40, 16], fill=P['cross'])
    d.rectangle([35, 11, 43, 13], fill=P['cross'])

    # the bed, left: a frame, a mattress, a blanket and a pillow
    d.rectangle([4, 20, 24, 21], fill=P['bedframe'])
    d.rectangle([4, 22, 5, 26], fill=P['bedframe'])
    d.rectangle([23, 22, 24, 26], fill=P['bedframe'])
    d.rectangle([5, 17, 23, 19], fill=P['bed'])
    d.rectangle([11, 17, 23, 19], fill=P['blanket'])
    d.rectangle([6, 15, 10, 17], fill=P['plate'])

    # the cabinet in the middle
    d.rectangle([27, 13, 32, 25], fill=P['cab'])
    d.rectangle([27, 13, 32, 14], fill=P['cabt'])
    d.line([29, 15, 29, 25], fill=P['edge'])
    d.point((28, 19), fill=P['cabt'])
    d.point((31, 19), fill=P['cabt'])

    # the nurse, standing between the bed and the cabinet
    d.rectangle([25, 9, 26, 9], fill=P['hair'])
    d.rectangle([25, 10, 26, 12], fill=P['skin'])
    d.rectangle([24, 13, 27, 20], fill=P['coat'])
    d.rectangle([24, 21, 27, 25], fill=P['pants'])
    d.point((26, 15), fill=P['cross'])
    if night:
        d.rectangle([8, 4, 14, 4], fill=P['lamp'])
    return im


def ramp():
    """48x32: a one-tile ramp - the strip at the left is the whole of what shows."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    edge, road, line, hazard = hexc('#0e1116'), hexc('#3a4452'), hexc('#8fa0b3'), hexc('#ffb703')
    d.rectangle([0, 0, 7, 31], fill=edge)
    d.rectangle([1, 0, 6, 31], fill=road)
    # the slope: a diagonal of the lighter grey, stepping down to the right
    for i in range(6):
        d.line([1 + i, 4 + i * 4, 6, 4 + i * 4], fill=line)
    # hazard stripes at the mouth, top and bottom
    for y in (0, 1, 30, 31):
        for x in range(0, 8, 2):
            d.point((x + (y % 2), y), fill=hazard)
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheet = Image.new('RGBA', (96, 32), (0, 0, 0, 0))
    sheet.paste(clinic(False), (0, 0))
    sheet.paste(clinic(True), (48, 0))
    sheet.save(OUT / 'medical.png')
    ramp().save(OUT / 'parking-ramp.png')
    print('wrote medical.png and parking-ramp.png to', OUT)


if __name__ == '__main__':
    main()
