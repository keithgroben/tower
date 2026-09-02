"""A grid of icons on magenta -> the single left-to-right strip the loader reads.

Image models cannot emit a 576x32 strip, so the icon sheet is requested as a
6x3 grid in one 1024x1024 image (see spec/asset-request.md). This turns that
into `palette-icons.png`: magenta keyed out, each icon cropped, scaled to fit
32x32 without distortion, and composed in palette order.

    python tools/ingest_icon_grid.py [lanczos]

`lanczos` (recommended for a ~5:1 downscale) resamples smoothly; the default
is nearest-neighbour, which at a non-integer ratio drops most of the pixels
and reads as noise. Both are one-time production steps — the game itself never
scales anything but by an integer.
"""
import sys
from PIL import Image

SRC = r'C:\dev\GitHub\keithgroben\lift\src\games\lift\assets\tool-icons.png'
COLS, ROWS, N = 6, 3, 18
FRAME = 32

im = Image.open(SRC).convert('RGBA')
W, H = im.size
px = im.load()

# Key magenta per channel — generated magenta is shaded, so distance to
# #FF00FF misses it while "red high, blue high, green low" catches it.
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if r > 140 and b > 140 and g < 110 and (r - g) > 60 and (b - g) > 60:
            px[x, y] = (0, 0, 0, 0)

cw, ch = W / COLS, H / ROWS
strip = Image.new('RGBA', (FRAME * N, FRAME), (0, 0, 0, 0))
report = []
mode = Image.LANCZOS if len(sys.argv) > 1 and sys.argv[1] == 'lanczos' else Image.NEAREST

for i in range(N):
    col, row = i % COLS, i // COLS
    cell = im.crop((int(col * cw), int(row * ch), int((col + 1) * cw), int((row + 1) * ch)))
    # Largest connected blob wins. Row/column thresholds were not enough:
    # a faint line of un-keyed pixels along a cell edge still dragged the crop
    # to the cell boundary and squashed the icon (the office came out a
    # 17px-wide sliver). An icon is one connected thing; anything else in the
    # cell is bleed from its neighbour.
    a = cell.split()[3]
    cwid, chei = cell.size
    apx = a.load()
    seen = bytearray(cwid * chei)
    blobs = []
    for sy in range(chei):
        for sx in range(cwid):
            if seen[sy * cwid + sx] or apx[sx, sy] == 0:
                continue
            stack = [(sx, sy)]
            seen[sy * cwid + sx] = 1
            minx = maxx = sx
            miny = maxy = sy
            size = 0
            while stack:
                x, y = stack.pop()
                size += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < cwid and 0 <= ny < chei and not seen[ny * cwid + nx] and apx[nx, ny] > 0:
                        seen[ny * cwid + nx] = 1
                        stack.append((nx, ny))
            blobs.append((size, (minx, miny, maxx + 1, maxy + 1)))
    if not blobs:
        report.append(f'cell {i} is EMPTY'); continue
    # Union of every SUBSTANTIAL part, not just the biggest one. Taking only
    # the largest blob cropped the recycling symbol down to one of its three
    # arrows; taking everything let a stray keyed-through pixel on the cell
    # edge stretch the crop to the cell boundary. A real part of an icon is
    # within an order of magnitude of its largest part.
    biggest = max(b[0] for b in blobs)
    keep = [b[1] for b in blobs if b[0] >= biggest * 0.08]
    bbox = (min(b[0] for b in keep), min(b[1] for b in keep),
            max(b[2] for b in keep), max(b[3] for b in keep))
    icon = cell.crop(bbox)
    # contain: preserve aspect inside 32x32, centred
    scale = min(FRAME / icon.width, FRAME / icon.height)
    w, h = max(1, round(icon.width * scale)), max(1, round(icon.height * scale))
    icon = icon.resize((w, h), mode)
    # harden alpha so nothing draws as a ghost
    ipx = icon.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = ipx[x, y]
            ipx[x, y] = (r, g, b, 255 if a >= 128 else 0)
    strip.alpha_composite(icon, (i * FRAME + (FRAME - w) // 2, (FRAME - h) // 2))
    report.append(f'{i}: cell{bbox} -> {w}x{h}')

out = r'C:\dev\GitHub\keithgroben\lift\src\games\lift\assets\sprites\palette-icons.png'
strip.save(out)
print('\n'.join(report))
print('wrote', out, strip.size, 'mode', mode)
