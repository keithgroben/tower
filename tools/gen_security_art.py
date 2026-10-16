#!/usr/bin/env python3
"""
Draws the sheet issue #12 (security) needs, straight to native size.

    python tools/gen_security_art.py

Writes into src/games/tower/assets/sprites/:

  security.png   96x32   day, night      the security office

This is **procedural placeholder art**, in the house palette
(spec/sprite-manifest.md) - flat shapes on the 48x32 slot, no gradients - so the
facility can be seen and the loader, the catalogue and test/sprites.test.js have
something real to hold level. Blue is security's hue family (teal is
housekeeping, violet is hotel). An artist can replace the PNG and re-run
`node src/games/tower/assets/sprites/sidecars.gen.mjs`; nothing else needs to
change, because the frames are listed in tools/sprite-catalog.json.

The room is a control room: a wall of camera monitors, a desk with a radio, a
guard on duty, and the lamp on the wall that goes red when something is wrong
(the fire and bomb work is issue #16's; the lamp is just furniture today).

Needs Pillow. Nothing in the game imports this; it is a developer tool.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'games' / 'tower' / 'assets' / 'sprites'


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def office(night):
    """48x32: a control room, in blue."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    P = {
        'edge': hexc('#0e1116'),
        'rim': hexc('#2a3f73' if not night else '#18264a'),
        'ceil': hexc('#1a2848' if not night else '#0d1528'),
        'wall': hexc('#2c3e66' if not night else '#141d36'),
        'panel': hexc('#364b7a' if not night else '#1a2542'),
        'floor': hexc('#2a2f38' if not night else '#171a20'),
        'floor2': hexc('#3a4452' if not night else '#232932'),
        'bezel': hexc('#0b0f14'),
        'screen': hexc('#5dd6a2' if not night else '#8cf5c6'),
        'screen2': hexc('#2f8f6b' if not night else '#4fbf92'),
        'static': hexc('#9fb3c8' if not night else '#cfe0f2'),
        'desk': hexc('#6b5a48' if not night else '#3a3128'),
        'deskt': hexc('#8a7560' if not night else '#4b4034'),
        'radio': hexc('#c8d2dc' if not night else '#6f7a85'),
        'lamp': hexc('#ef476f'),
        'lampoff': hexc('#6b2a3a' if not night else '#3a1822'),
        'plate': hexc('#0b0f14'),
        'ink': hexc('#9ec1ff' if not night else '#ffd76a'),
        'cap': hexc('#1d2d57'),
        'skin': hexc('#e0a47e'),
        'shirt': hexc('#8fb0e8' if not night else '#5f7aa8'),
        'belt': hexc('#0e1116'),
        'trou': hexc('#1d2d57'),
        'badge': hexc('#ffb703'),
    }
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    d.rectangle([1, 1, 46, 30], fill=P['rim'])
    d.rectangle([2, 2, 45, 4], fill=P['ceil'])
    d.rectangle([2, 5, 45, 25], fill=P['wall'])
    for x in range(8, 45, 8):
        d.line([x, 5, x, 25], fill=P['panel'])
    d.rectangle([2, 26, 45, 29], fill=P['floor'])
    d.line([2, 26, 45, 26], fill=P['floor2'])

    # the monitor wall, left: two rows of three, each a different picture
    for row in range(2):
        for col in range(3):
            x, y = 4 + col * 8, 7 + row * 7
            d.rectangle([x, y, x + 6, y + 5], fill=P['bezel'])
            d.rectangle([x + 1, y + 1, x + 5, y + 4], fill=P['screen2'])
            kind = (row * 3 + col) % 3
            if kind == 0:
                d.line([x + 1, y + 3, x + 5, y + 3], fill=P['screen'])
            elif kind == 1:
                d.rectangle([x + 2, y + 1, x + 3, y + 2], fill=P['screen'])
                d.point((x + 4, y + 4), fill=P['screen'])
            else:
                for k in range(5):
                    d.point((x + 1 + k, y + 1 + (k * 2) % 4), fill=P['static'])

    # the sign, right
    d.rectangle([34, 6, 45, 14], fill=P['plate'])
    d.rectangle([35, 7, 44, 13], outline=P['ink'])
    for (x, y) in [(36, 9), (37, 9), (36, 10), (37, 11), (36, 11),                  # S
                   (39, 9), (40, 9), (39, 10), (39, 11), (40, 11), (40, 10),      # E (blocky)
                   (42, 9), (43, 9), (42, 10), (42, 11), (43, 11)]:                # C
        d.point((x, y), fill=P['ink'])
    # the lamp over the door
    d.rectangle([40, 16, 43, 18], fill=P['lamp'] if night else P['lampoff'])
    d.rectangle([39, 19, 44, 19], fill=P['edge'])

    # the desk and the radio
    d.rectangle([4, 21, 30, 23], fill=P['deskt'])
    d.rectangle([5, 24, 29, 25], fill=P['desk'])
    d.rectangle([6, 24, 7, 26], fill=P['desk'])
    d.rectangle([27, 24, 28, 26], fill=P['desk'])
    d.rectangle([22, 18, 27, 21], fill=P['radio'])
    d.rectangle([23, 19, 24, 20], fill=P['bezel'])
    d.line([26, 18, 27, 15], fill=P['radio'])

    # the guard, seated at the desk, facing the wall
    d.rectangle([13, 11, 18, 12], fill=P['cap'])           # cap
    d.rectangle([12, 12, 19, 12], fill=P['cap'])           # brim
    d.rectangle([14, 13, 17, 15], fill=P['skin'])          # face
    d.rectangle([12, 16, 19, 21], fill=P['shirt'])         # torso
    d.rectangle([12, 18, 19, 18], fill=P['belt'])
    d.point((17, 17), fill=P['badge'])
    d.rectangle([11, 18, 12, 21], fill=P['shirt'])         # arms on the desk
    d.rectangle([19, 18, 20, 21], fill=P['shirt'])
    d.rectangle([13, 24, 18, 26], fill=P['trou'])
    if night:
        d.rectangle([8, 4, 14, 4], fill=hexc('#ffd76a'))   # the lamp over the desk
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheet = Image.new('RGBA', (96, 32), (0, 0, 0, 0))
    sheet.paste(office(False), (0, 0))
    sheet.paste(office(True), (48, 0))
    sheet.save(OUT / 'security.png')
    print('wrote security.png to', OUT)


if __name__ == '__main__':
    main()
