# Lift — art assets

Where a finished sprite goes so the renderer picks it up. Nothing here is
loaded by `sim/**`, ever.

## Where files go

```
src/games/lift/assets/sprites/<subject>.png    the sheet
src/games/lift/assets/sprites/<subject>.json   its sidecar
```

`<subject>` is the kebab-case file name from `spec/asset-request.md` **without
the extension** — `office`, `ground-street`, `person-worker`. The `.png` and
the `.json` must share it exactly; that pair *is* the sheet, and the loader
asks for both by name.

The directory sits beside `render/` so both servers reach it with no config:
`render/sprites.js` resolves `../assets/sprites/` from its own module URL, which
works under Vite (`npm run dev`) and under `harness/serve.js` (`npm run play`).

## The sidecar

```json
{
  "frameW": 48,
  "frameH": 32,
  "animations": {
    "vacant":         { "col": 0, "frames": 1 },
    "occupied-day":   { "col": 1, "frames": 2, "speed": "idle" },
    "occupied-night": { "col": 3, "frames": 1 },
    "stressed":       { "col": 4, "frames": 1, "speed": "blink" }
  }
}
```

- `frameW` / `frameH` — one frame in pixels, at 1x. A slot is `48x32`.
- `col` — the first frame's column, counting from 0. Default `0`.
- `frames` — how many frames the state uses, running **left to right**.
- `row` — only for a grid sheet; default `0`. One strip is the norm.
- `speed` — a key in `config.feel.sprites.fps` (`idle`, `walk`, `doors`,
  `blink`, `construction`, `escalator`, `default`). **Never a number** — an
  fps in an art file is a feel constant in the wrong place, and the loader
  refuses it and uses `default`.
- `loop` — `false` for a one-shot such as doors opening. Default `true`.

Animation names come from the "Frames / states" column of
`spec/asset-request.md`, kebab-cased.

## Rules the loader enforces

- **A missing or malformed sheet is normal.** Art lands one subject at a time;
  anything not yet drawable falls back to the coloured rectangle the renderer
  drew before. It never throws and never blocks a frame.
- **Every frame must exist on the sheet.** If `(col + frames) * frameW` runs
  past the PNG's width the whole sheet is refused, because sampling past the
  edge draws nothing and looks deliberate.
- **Nearest-neighbour, integer scale only.** 1x / 2x / 3x. No smoothing.
- 1x native size, transparent background — never a magenta key. Key the
  magenta out during production, not in the repo.

## placeholder.png

A checked-in three-frame stand-in (`vacant`, `occupied-day` x2) that exists so
the loader's tests do not wait on art. Regenerate with:

```bash
node src/games/lift/assets/sprites/placeholder.gen.mjs
```

Delete neither it nor its sidecar — `test/sprites.test.js` reads both.
