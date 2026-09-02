# tools/

Developer-side utilities. Nothing here is imported by the game, and nothing
here may become required to run `npm test` or a headless sweep — that
invariant is the whole point of the repo (see CLAUDE.md). These are allowed
dependencies the game itself is not allowed to have.

Not `harness/`: that is the game-agnostic simulation runner, and it stays
zero-dependency, zero-build, Node-only.

---

## `ingest_sprite.py` — raw generated image → game-ready sheet

The image model produces what `spec/asset-request.md` asks for: one subject per
image, ~1024 px, centred on flat magenta, frames left to right. The renderer
wants a 48x32-per-frame strip with a transparent background and a sidecar JSON.
This bridges the two, and it is the only thing that should ever cut one.

The first art drop arrived already at native size, so it did not need this —
`sidecars.gen.mjs` gave those sheets their sidecars and nothing touched the
pixels. This is for the next drop, and for every redraw that comes back raw.

**Convert a batch — the file stem is the asset name:**

```bash
python tools/ingest_sprite.py raw/*.png
```

**One file whose name does not match its asset:**

```bash
python tools/ingest_sprite.py "~/Downloads/office final v3.png" --name office
```

Sheets land in `src/games/lift/assets/sprites/` as `<name>.png` + `<name>.json`,
ready to draw. Re-run after a redraw; it overwrites and says so. `raw/` is
gitignored, so the 1024 px originals stay out of the repo.

| Flag | Why you would reach for it |
|---|---|
| `--list` | every asset name, its native size and its states |
| `--dry-run` | run every check, write nothing — a pre-flight for a batch |
| `--fuzz 0.3` | the generated background drifted further from `#FF00FF` than usual |
| `--fit contain` | pad to preserve the subject's proportions instead of filling the frame |
| `--aspect-tolerance 0.4` | you have looked at it and the squash is acceptable |
| `--out DIR` | somewhere other than the game's asset directory |

Needs **Pillow** (installed). ImageMagick 7 is also on this machine and
resamples identically; Pillow won because the quality gates below are pixel
statistics, and getting those out of `magick` means a dozen fragile
`%[fx:...]` shell round-trips.

### What it does

Keys out the magenta (per channel — high red, high blue, low green, which
catches a *shaded* or pale background that a distance-to-`#FF00FF` test
misses), crops to the subject's bounding box, slices into evenly spaced frames,
downscales each frame to native size with **nearest-neighbour**, hardens the
alpha so no half-transparent edge pixel survives, and writes the strip plus a
sidecar built from `sprite-catalog.json`.

### What it refuses

It exits `2` and explains itself rather than writing a sprite that is quietly
wrong — the failure mode that costs the most, because a mushy sprite in the
game looks like a choice somebody made.

- The background did not key out (or everything did) — wrong background colour,
  or a blank image.
- A frame is empty: the image does not hold as many frames as the asset needs.
  Names the states it expected.
- The source is smaller than the native frame, so it would be scaled *up*.
- Filling the frame would squash the art past `--aspect-tolerance` — either the
  subject is framed wrong or a frame is missing off the end of the strip.
- The asset name is not in the catalogue, with a spelling suggestion.

## `sprite-catalog.json` — the contract

Every delivered subject: native frame size, the states packed into its strip
and their order, and whether the art fills its frame (`stretch`) or is padded
to keep its proportions (`contain`).

Three things share it, which is what keeps them from drifting apart:

- `ingest_sprite.py` cuts frames and writes sidecars from it.
- `src/games/lift/assets/sprites/sidecars.gen.mjs` rewrites every sidecar from
  it after an art drop.
- `test/sprites.test.js` holds it level with `spec/asset-request.md` and with
  the real width of every PNG — a frame-count mistake fails `npm test` instead
  of drawing a sliver of the neighbouring frame in-game.

It describes **the art that exists**, not the art that was requested. Where the
two disagree the sheet on disk wins; the gaps are recorded under "Open
questions from the first delivery" in `spec/asset-request.md`.
