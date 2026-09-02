#!/usr/bin/env python3
"""
Turn a raw generated image into a game-ready sprite sheet + sidecar.

    python tools/ingest_sprite.py raw/office.png

The image model produces what `spec/asset-request.md` asks for: one subject per
image, ~1024 px square, centred on flat magenta, frames left to right. The
renderer wants a 48x32-per-frame strip with a transparent background and a
sidecar JSON. This is the bridge, and it is the only thing that should ever cut
one of these by hand.

Everything about a subject - native frame size, which states are in the strip
and in what order - comes from `tools/sprite-catalog.json`, keyed by asset
name. The name is the file stem unless `--name` says otherwise, so a whole
batch is one command.

Developer-side only. `npm test` and the headless sweeps never touch this file;
the game itself stays zero-dependency (CLAUDE.md). Needs Pillow.

Chosen over ImageMagick because the quality gates below are pixel statistics -
how much of the image was actually keyed, whether every frame has content in
it - and getting those out of `magick` means a dozen fragile `%[fx:...]` shell
round-trips. The resampling itself is identical: both do true nearest-neighbour.

Exit codes: 0 wrote a sheet | 2 refused (see the message) | 1 bad usage.
"""

import argparse
import json
import os
import sys

try:
    from PIL import Image, ImageChops
except ImportError:  # pragma: no cover - environment problem, not a code path
    sys.exit("this tool needs Pillow: python -m pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_PATH = os.path.join(ROOT, "tools", "sprite-catalog.json")
DEFAULT_OUT = os.path.join(ROOT, "src", "games", "lift", "assets", "sprites")

# The background the artist is told to use. Never exactly this in practice -
# a generated "flat magenta" drifts a few percent in every channel, which is
# what --fuzz is for.
KEY_RGB = (255, 0, 255)


class Refused(Exception):
    """A refusal the operator can act on. Loud, specific, never a silent pass."""


def load_catalog():
    with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return {k: v for k, v in raw.items() if not k.startswith("$")}


def columns(entry):
    return sum(int(s["frames"]) for s in entry["states"])


def sidecar_for(entry):
    """The sidecar JSON, built from the catalogue. Column offsets accumulate in
    state order, which is the order the frames sit in the strip."""
    animations, col = {}, 0
    for state in entry["states"]:
        frames = int(state["frames"])
        anim = {"col": col, "frames": frames}
        if state.get("speed"):
            anim["speed"] = state["speed"]
        if state.get("loop") is False:
            anim["loop"] = False
        animations[state["name"]] = anim
        col += frames
    return {"frameW": entry["frameW"], "frameH": entry["frameH"], "animations": animations}


def key_out_background(img, fuzz):
    """Magenta -> transparent. Returns (image, fraction_keyed).

    Tested per channel rather than by distance to #FF00FF: the failure mode in
    practice is a *shaded* magenta (the model lit the background) or a pale
    one, both of which sit far from the exact colour in RGB distance while
    still being obviously the backdrop. High red, high blue, low green catches
    every one of those and cannot catch a sprite pixel that reads as magenta
    to the eye, because those are the same thing.
    """
    r, g, b, a = img.split()
    slack = int(round(255 * fuzz))
    high, low = 255 - slack, slack

    mask = ImageChops.multiply(
        ImageChops.multiply(
            r.point(lambda v: 255 if v >= high else 0),
            b.point(lambda v: 255 if v >= high else 0),
        ),
        g.point(lambda v: 255 if v <= low else 0),
    )

    keyed = mask.histogram()[255]
    total = img.width * img.height
    img.putalpha(ImageChops.multiply(a, ImageChops.invert(mask)))
    return img, keyed / float(total)


def harden_alpha(img):
    """No semi-transparent pixels, ever. A soft edge survives a nearest-
    neighbour downscale as a stray halo pixel and reads as dirt at 1x."""
    r, g, b, a = img.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda v: 255 if v >= 128 else 0)))


def coverage(img):
    """Fraction of the image that is opaque."""
    hist = img.split()[3].histogram()
    return hist[255] / float(img.width * img.height) if img.width and img.height else 0.0


def resize_frame(frame, target_w, target_h, fit):
    """Nearest-neighbour, always. `stretch` fills the frame; `contain` keeps the
    subject's proportions and centres it with transparent padding."""
    if fit == "stretch":
        return frame.resize((target_w, target_h), Image.NEAREST)

    scale = min(target_w / frame.width, target_h / frame.height)
    w = max(1, int(round(frame.width * scale)))
    h = max(1, int(round(frame.height * scale)))
    shrunk = frame.resize((min(w, target_w), min(h, target_h)), Image.NEAREST)
    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    canvas.paste(shrunk, ((target_w - shrunk.width) // 2, (target_h - shrunk.height) // 2))
    return canvas


def ingest(src_path, name, entry, args):
    cols = columns(entry)
    frame_w, frame_h = entry["frameW"], entry["frameH"]
    fit = args.fit or entry.get("fit", "stretch")

    try:
        img = Image.open(src_path)
    except Exception as e:
        raise Refused(f"could not open {src_path}: {e}")
    img = img.convert("RGBA")

    img, keyed = key_out_background(img, args.fuzz)

    # --- gates. Each one is a way to end up with a mushy or wrong sprite that
    # --- looks deliberate once it is in the game.
    if keyed < 0.02:
        raise Refused(
            f"only {keyed:.1%} of the image keyed out - the background is not the flat "
            f"magenta #FF00FF the request asks for. Raise --fuzz (now {args.fuzz:.0%}) "
            f"or re-generate on magenta."
        )
    if keyed > 0.98:
        raise Refused(
            f"{keyed:.1%} of the image keyed out - almost nothing is left. The subject "
            f"is itself magenta, or the image is blank. Lower --fuzz (now {args.fuzz:.0%})."
        )

    box = img.split()[3].getbbox()
    if box is None:
        raise Refused("nothing opaque left after keying - there is no subject here")
    img = img.crop(box)
    src_w, src_h = img.size

    per_frame_w = src_w / float(cols)
    if per_frame_w < frame_w or src_h < frame_h:
        raise Refused(
            f"source frames are {per_frame_w:.0f}x{src_h}, smaller than the native "
            f"{frame_w}x{frame_h} - scaling up would produce mush. Re-generate larger."
        )

    # Slice on rounded boundaries, then prove every frame actually has art in
    # it. An empty or near-empty slice is how "the model drew 3 frames but the
    # catalogue says 5" shows up, and it is invisible until the game is running.
    frames, thin = [], []
    for i in range(cols):
        x0 = int(round(i * src_w / float(cols)))
        x1 = int(round((i + 1) * src_w / float(cols)))
        slice_img = img.crop((x0, 0, x1, src_h))
        cov = coverage(slice_img)
        if cov < 0.01:
            raise Refused(
                f"frame {i + 1} of {cols} is empty ({cov:.1%} opaque) - this image does "
                f"not hold {cols} evenly spaced frames. '{name}' needs "
                f"{describe_states(entry)}."
            )
        if cov < 0.05:
            thin.append((i + 1, cov))
        frames.append(slice_img)

    if fit == "stretch":
        want = frame_w / float(frame_h)
        for i, f in enumerate(frames):
            got = f.width / float(f.height)
            if max(got / want, want / got) > 1 + args.aspect_tolerance:
                raise Refused(
                    f"frame {i + 1} is {f.width}x{f.height} ({got:.2f}:1) but the native "
                    f"frame is {frame_w}x{frame_h} ({want:.2f}:1) - filling it would "
                    f"squash the art by more than {args.aspect_tolerance:.0%}. Either the "
                    f"subject is framed wrong, or the image does not hold {cols} frames "
                    f"('{name}' needs {describe_states(entry)}). Re-frame it, or pass "
                    f"--fit contain to pad instead of stretch."
                )

    sheet = Image.new("RGBA", (frame_w * cols, frame_h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(harden_alpha(resize_frame(f, frame_w, frame_h, fit)), (i * frame_w, 0))

    png_path = os.path.join(args.out, f"{name}.png")
    json_path = os.path.join(args.out, f"{name}.json")
    scale = per_frame_w / float(frame_w)

    print(f"{name}: {src_w}x{src_h} subject -> {cols} frame(s) of {frame_w}x{frame_h} "
          f"({sheet.width}x{sheet.height} strip), 1/{scale:.1f} scale, {keyed:.0%} keyed, fit={fit}")
    for index, cov in thin:
        print(f"  note: frame {index} is only {cov:.1%} opaque - check it is not a stray mark")

    if args.dry_run:
        print("  dry run - nothing written")
        return

    os.makedirs(args.out, exist_ok=True)
    replaced = " (replaced)" if os.path.exists(png_path) else ""
    sheet.save(png_path, optimize=True)
    with open(json_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(sidecar_for(entry), fh, indent=2)
        fh.write("\n")
    shown = os.path.relpath(png_path, ROOT)
    if shown.startswith(".."):
        shown = png_path
    print(f"  wrote {shown} + .json{replaced}")


def describe_states(entry):
    parts = [f"{s['name']}({s['frames']}f)" if int(s["frames"]) > 1 else s["name"] for s in entry["states"]]
    return ", ".join(parts)


def main(argv):
    catalog = load_catalog()

    p = argparse.ArgumentParser(
        prog="ingest_sprite.py",
        description="Raw generated image -> game-ready sprite sheet + sidecar.",
        epilog="Asset names come from tools/sprite-catalog.json. --list prints them.",
    )
    p.add_argument("sources", nargs="*", help="raw image(s); the file stem is the asset name")
    p.add_argument("--name", help="asset name, when it is not the file stem (single source only)")
    p.add_argument("--out", default=DEFAULT_OUT, help="output directory (default: the game's assets/sprites)")
    p.add_argument("--fuzz", type=float, default=0.20,
                   help="magenta tolerance, 0-1 (default 0.20). Generated magenta is never exact.")
    p.add_argument("--fit", choices=["stretch", "contain"], help="override the catalogue's fit")
    p.add_argument("--aspect-tolerance", type=float, default=0.25,
                   help="how far a stretch fit may squash the art before it is refused (default 0.25)")
    p.add_argument("--dry-run", action="store_true", help="run every check, write nothing")
    p.add_argument("--list", action="store_true", help="list the catalogue and exit")
    args = p.parse_args(argv)

    if args.list:
        for name in sorted(catalog):
            e = catalog[name]
            print(f"  {name:<22} {e['frameW']}x{e['frameH']} x{columns(e)}f  [{describe_states(e)}]")
        return 0

    if not args.sources:
        p.error("no source images (use --list to see the catalogue)")
    if args.name and len(args.sources) > 1:
        p.error("--name takes a single source; a batch names each asset by its file stem")

    failures = 0
    for src in args.sources:
        name = args.name or os.path.splitext(os.path.basename(src))[0]
        entry = catalog.get(name)
        if entry is None:
            near = [n for n in catalog if n.startswith(name[:4])] if len(name) >= 4 else []
            hint = f" Did you mean: {', '.join(sorted(near))}?" if near else " Run --list for the catalogue."
            print(f"REFUSED {src}: '{name}' is not an asset in spec/asset-request.md.{hint}", file=sys.stderr)
            failures += 1
            continue
        try:
            ingest(src, name, entry, args)
        except Refused as e:
            print(f"REFUSED {src}: {e}", file=sys.stderr)
            failures += 1

    if failures:
        print(f"\n{failures} of {len(args.sources)} refused - nothing was guessed at.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
