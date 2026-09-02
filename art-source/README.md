# Source art

The raw generated sheets every sprite in `src/games/lift/assets/sprites/` was
cut from — one file per batch, as delivered, magenta background and all.

**These are tracked on purpose.** They were `.gitignore`d as scratch, which
meant the provenance of every sprite in the game existed on exactly one
laptop. Re-cutting a sheet at a different size, fixing a crop, or pulling one
more subject out of a batch all need the original; without it the only route
is to ask an image model for the whole batch again and accept different art.

| File | Cut into | By |
|---|---|---|
| `tool-icons-grid.png` | `palette-icons.png` (18 icons, 32x32) | `tools/ingest_icon_grid.py` |
| `sky-clouds.png` | `sky-cloud.png` (3 frames, shared scale) | `tools/ingest_sky.py` |
| `sky-fliers.png` | `sky-bird/plane/balloon/blimp/explorer/stunt` | `tools/ingest_sky.py` |
| `empty-rooms.png` | `room-empty.png` (office, condo, shop, hotel) | `tools/ingest_rooms_routes.py` |
| `stairs-escalator.png` | `stairs-segment`, `escalator-segment` (2 frames each) | `tools/ingest_rooms_routes.py` |

The ingest tools read from `raw/` by default; point them here, or drop a new
batch in `raw/` (still untracked scratch for work in progress) and move it
in once it has been cut.

Sizes come from `tools/sprite-catalog.json`, which is the contract between
these files and the renderer. `spec/asset-request.md` is what was asked for,
including a "Withdrawn" section for two sheets that were deliberately dropped.
