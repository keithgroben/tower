"""Pull each subject out of a magenta sheet by clustering, not by grid.

The generated sheets are laid out roughly, not on a lattice: the explorer's
balloon and the airship both overflow the cell they were asked to sit in, so
cell-slicing cuts them in half. Finding the connected parts and grouping the
ones that belong together is layout-independent — it does not care where the
model actually put anything.
"""
import sys
from PIL import Image

def keyed(path):
    im = Image.open(path).convert('RGBA'); px = im.load(); W, H = im.size
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if r > 140 and b > 140 and g < 110 and (r - g) > 60 and (b - g) > 60:
                px[x, y] = (0, 0, 0, 0)
    return im

def components(im, min_px=40):
    a = im.split()[3]; W, H = im.size; apx = a.load()
    seen = bytearray(W * H); out = []
    for sy in range(H):
        for sx in range(W):
            if seen[sy * W + sx] or apx[sx, sy] == 0: continue
            st = [(sx, sy)]; seen[sy * W + sx] = 1
            mnx = mxx = sx; mny = mxy = sy; n = 0
            while st:
                x, y = st.pop(); n += 1
                mnx = min(mnx, x); mxx = max(mxx, x); mny = min(mny, y); mxy = max(mxy, y)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny * W + nx] and apx[nx, ny] > 0:
                        seen[ny * W + nx] = 1; st.append((nx, ny))
            if n >= min_px: out.append([n, [mnx, mny, mxx + 1, mxy + 1]])
    return out

def near(a, b, gap):
    return (a[0] - gap < b[2] and b[0] - gap < a[2] and a[1] - gap < b[3] and b[1] - gap < a[3])

def cluster(comps, gap=46):
    boxes = [c[1][:] for c in comps]
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(len(boxes) - 1, i, -1):
                if near(boxes[i], boxes[j], gap):
                    boxes[i] = [min(boxes[i][0], boxes[j][0]), min(boxes[i][1], boxes[j][1]),
                                max(boxes[i][2], boxes[j][2]), max(boxes[i][3], boxes[j][3])]
                    boxes.pop(j); merged = True
    return boxes

def gapof(a, b):
    dx = max(0, max(a[0] - b[2], b[0] - a[2]))
    dy = max(0, max(a[1] - b[3], b[1] - a[3]))
    return (dx * dx + dy * dy) ** 0.5

def subjects(path, expected, cols):
    im = keyed(path)
    # A tight gap first, or every subject on the sheet merges into one blob:
    # they sit closer to each other than the smoke trail sits to its plane.
    boxes = cluster(components(im), gap=12)
    boxes.sort(key=lambda b: -((b[2] - b[0]) * (b[3] - b[1])))
    subjects_, leftovers = boxes[:expected], boxes[expected:]
    # Then fold the strays back into whichever subject they belong to — the
    # smoke puffs behind the stunt plane are their own components and would
    # otherwise be dropped.
    for stray in leftovers:
        i = min(range(len(subjects_)), key=lambda k: gapof(subjects_[k], stray))
        s = subjects_[i]
        subjects_[i] = [min(s[0], stray[0]), min(s[1], stray[1]), max(s[2], stray[2]), max(s[3], stray[3])]
    boxes = subjects_
    # reading order: rows top to bottom, then left to right within a row
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows = [boxes[i:i + cols] for i in range(0, len(boxes), cols)]
    ordered = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda b: b[0]))
    return im, ordered

# Native sizes, chosen from what the art actually is rather than from what the
# request guessed. Aspect is preserved: a balloon squeezed into a box drawn for
# a different shape is worse than a slightly odd frame size.
FLIERS = {
    # Sized against a room, which is 48x32. The first pass took its sizes from
    # the source art and everything came out enormous — a bird was 20px wide
    # against a 48px room and read as a pterodactyl at 2x zoom (Keith: "the
    # birds are too big at 2x and honestly too big generally"). A bird should
    # be a mark in the sky, an airliner should look far away, and only the two
    # surprises are allowed to be big enough to look at.
    'bird':     ('sky-bird',     10,  8, 'fly'),
    'plane':    ('sky-plane',    34, 11, 'fly'),
    'balloon':  ('sky-balloon',  24, 32, 'drift'),
    'blimp':    ('sky-blimp',    38, 16, 'drift'),
    'explorer': ('sky-explorer', 34, 42, 'drift'),
    'stunt':    ('sky-stunt',    64, 27, 'fly'),
}
CLOUD_FRAME = (112, 32)
OUT = 'src/games/lift/assets/sprites'

def harden(im):
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255 if a >= 128 else 0)
    return im

def fit(im, box, w, h, scale=None):
    sub = im.crop(box)
    k = scale if scale else min(w / sub.width, h / sub.height)
    nw, nh = max(1, round(sub.width * k)), max(1, round(sub.height * k))
    return harden(sub.resize((nw, nh), Image.LANCZOS))

def run():
    from PIL import Image as _I
    # --- clouds: one strip, three frames, ONE shared scale so the three keep
    # their relative sizes. Fitting each to the frame would make them the same
    # height, which is the one thing that distinguishes them.
    im, boxes = subjects('src/games/lift/assets/sky-clouds.png', 3, 1)
    fw, fh = CLOUD_FRAME
    big = boxes[-1]
    k = min(fw / (big[2] - big[0]), fh / (big[3] - big[1]))
    strip = _I.new('RGBA', (fw * 3, fh), (0, 0, 0, 0))
    for i, b in enumerate(boxes):
        icon = fit(im, b, fw, fh, scale=k)
        strip.alpha_composite(icon, (i * fw + (fw - icon.width) // 2, (fh - icon.height) // 2))
        print(f'  cloud {i}: {icon.width}x{icon.height}')
    strip.save(f'{OUT}/sky-cloud.png')
    print('wrote sky-cloud.png', strip.size)

    # --- fliers: one sheet each, one frame each. The art came back as a single
    # pose per subject; the movement is the drift and bob the renderer applies.
    im, boxes = subjects('src/games/lift/assets/sky-fliers.png', 6, 2)
    for label, b in zip(['bird', 'plane', 'balloon', 'blimp', 'explorer', 'stunt'], boxes):
        name, w, h, anim = FLIERS[label]
        icon = fit(im, b, w, h)
        sheet = _I.new('RGBA', (w, h), (0, 0, 0, 0))
        sheet.alpha_composite(icon, ((w - icon.width) // 2, (h - icon.height) // 2))
        sheet.save(f'{OUT}/{name}.png')
        print(f'  {name}: {icon.width}x{icon.height} in {w}x{h} [{anim}]')

if __name__ == '__main__':
    run()
