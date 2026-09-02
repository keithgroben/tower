"""Empty room shells and the two route columns -> the sheets the loader reads.

Both sheets are laid out as grids of subjects on magenta. The clustering from
ingest_sky does the finding, because these were generated the same way and
overflow their cells the same way.

Two shapes come out:
  room-empty.png   48x32 x4  — office, condo, shop, hotel, unfurnished
  stairs-segment   48x32 x2  — lower flight, upper flight (a switchback)
  escalator-segment 48x32 x2 — the two halves of one run

The route sheets are cut in HALF vertically and stacked as two frames because
the art is drawn as a two-storey run: the renderer picks a frame by floor
parity, so a stairwell of any height reads as a continuous switchback.

    python tools/ingest_rooms_routes.py
"""
from PIL import Image
from ingest_sky import subjects

OUT = 'src/games/lift/assets/sprites'


def harden(im):
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255 if a >= 128 else 0)
    return im


def stretched(im, box, w, h):
    """Fill the frame edge to edge. These subjects ARE the slot — their columns
    have to land on the slot's edges or the building stops lining up — so they
    stretch rather than letterbox."""
    return harden(im.crop(box).resize((w, h), Image.LANCZOS))


def rooms():
    im, boxes = subjects('raw/empty-rooms.png', 4, 2)
    strip = Image.new('RGBA', (48 * 4, 32), (0, 0, 0, 0))
    for i, box in enumerate(boxes):
        strip.alpha_composite(stretched(im, box, 48, 32), (i * 48, 0))
    strip.save(f'{OUT}/room-empty.png')
    print('room-empty.png', strip.size, '(office, condo, shop, hotel)')


def routes():
    im, boxes = subjects('raw/stairs-escalator.png', 2, 2)
    for name, box in zip(['stairs-segment', 'escalator-segment'], boxes):
        # One two-storey run, cut into a lower and an upper frame.
        tall = stretched(im, box, 48, 64)
        sheet = Image.new('RGBA', (96, 32), (0, 0, 0, 0))
        sheet.alpha_composite(tall.crop((0, 32, 48, 64)), (0, 0))   # frame 0: lower
        sheet.alpha_composite(tall.crop((0, 0, 48, 32)), (48, 0))   # frame 1: upper
        sheet.save(f'{OUT}/{name}.png')
        print(f'{name}.png', sheet.size, '(lower, upper)')


if __name__ == '__main__':
    rooms()
    routes()
