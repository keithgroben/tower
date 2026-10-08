#!/usr/bin/env python3
"""
Draws the sheet issue #10 (restaurant) needs, straight to native size.

    python tools/gen_restaurant_art.py

Writes into src/games/tower/assets/sprites/:

  restaurant.png   96x32   day, night      the dinner venue

**Procedural placeholder art**, in the house palette (spec/sprite-manifest.md) -
flat shapes on the 48x32 slot, no gradients - so the restaurant can be seen and
the loader, the catalogue and test/sprites.test.js have something real to hold
level. It is deliberately NOT the shop's front: a shop is a daytime storefront
and shutters at night, a restaurant is the opposite - white tablecloths and a
red awning by day, a warm lit room with candles once the shops have closed. An
artist can replace the PNG and re-run
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


def restaurant(night):
    """48x32: awning over a window of laid tables, a door, a menu board."""
    im = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    P = {
        'edge': hexc('#0e1116'),
        'rim': hexc('#7a2b1e' if not night else '#46180f'),
        'wall': hexc('#3a2a24' if not night else '#1f1612'),
        'awnA': hexc('#e76f51' if not night else '#8a3f2e'),
        'awnB': hexc('#f4ece0' if not night else '#a39b8e'),
        'glass': hexc('#2b3a4d' if not night else '#ffcf6b'),
        'glass2': hexc('#3a4d66' if not night else '#ffb703'),
        'cloth': hexc('#f4ece0' if not night else '#e8d9b8'),
        'table': hexc('#8b5e3c' if not night else '#8b5e3c'),
        'chair': hexc('#5a3a24'),
        'plate': hexc('#dfe6ee'),
        'flame': hexc('#ffd76a'),
        'wine': hexc('#9b2335'),
        'door': hexc('#5a3a24' if not night else '#3a2416'),
        'knob': hexc('#ffb703'),
        'board': hexc('#0b0f14'),
        'chalk': hexc('#e8eef2'),
        'floor': hexc('#2a2f38' if not night else '#171a20'),
    }
    d.rectangle([0, 0, 47, 31], fill=P['edge'])
    d.rectangle([1, 1, 46, 30], fill=P['rim'])
    d.rectangle([2, 2, 45, 29], fill=P['wall'])

    # the awning: alternating stripes, scalloped along the bottom
    for i, x in enumerate(range(2, 46, 4)):
        d.rectangle([x, 3, x + 3, 8], fill=P['awnA'] if i % 2 == 0 else P['awnB'])
        d.rectangle([x, 9, x + 3, 9], fill=P['awnA'] if i % 2 == 0 else P['awnB'])
        d.point((x + 1, 10), fill=P['awnA'] if i % 2 == 0 else P['awnB'])
        d.point((x + 2, 10), fill=P['awnA'] if i % 2 == 0 else P['awnB'])
    d.line([2, 2, 45, 2], fill=P['edge'])

    # the window, left: two laid tables
    d.rectangle([4, 12, 30, 26], fill=P['edge'])
    d.rectangle([5, 13, 29, 25], fill=P['glass'])
    d.rectangle([5, 13, 29, 15], fill=P['glass2'])
    for tx in (8, 20):
        d.rectangle([tx, 20, tx + 7, 21], fill=P['cloth'])          # the cloth
        d.rectangle([tx + 3, 22, tx + 4, 25], fill=P['table'])       # the pedestal
        d.rectangle([tx + 1, 19, tx + 2, 19], fill=P['plate'])
        d.rectangle([tx + 5, 19, tx + 6, 19], fill=P['plate'])
        d.rectangle([tx - 1, 21, tx - 1, 25], fill=P['chair'])       # chairs
        d.rectangle([tx + 8, 21, tx + 8, 25], fill=P['chair'])
        d.point((tx + 3, 18), fill=P['flame'] if night else P['wine'])   # candle by night, wine by day
        d.point((tx + 4, 19), fill=P['wine'])
    d.line([5, 25, 29, 25], fill=P['floor'])

    # the door, right of the window, and the menu board beside it
    d.rectangle([33, 13, 40, 29], fill=P['edge'])
    d.rectangle([34, 14, 39, 29], fill=P['door'])
    d.rectangle([35, 15, 38, 20], fill=P['glass'])
    d.point((38, 24), fill=P['knob'])
    d.rectangle([41, 15, 45, 24], fill=P['board'])
    for y in (17, 19, 21, 23):
        d.line([42, y, 44, y], fill=P['chalk'])
    d.line([2, 29, 45, 29], fill=P['floor'])
    return im


def main():
    sheet = Image.new('RGBA', (96, 32), (0, 0, 0, 0))
    sheet.paste(restaurant(False), (0, 0))
    sheet.paste(restaurant(True), (48, 0))
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / 'restaurant.png')
    print('wrote', OUT / 'restaurant.png')


if __name__ == '__main__':
    main()
