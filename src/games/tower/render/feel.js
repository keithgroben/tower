/**
 * Presentation constants. Colours, animation speeds, sky density, budgets.
 *
 * This is deliberately NOT `config.js`. Per `CLAUDE.md`'s blast-radius table,
 * `config.js` is "data only — but the numbers are the reference's, not ours",
 * and changing one there is a deviation. Nothing in this file is the
 * reference's: it is all feel, which `spec/TICK-MODEL.md` §9 says is free.
 * Keeping them apart means a colour change can never look like a spec change.
 *
 * The shape is `{ feel: … }` because `render/sprites.js` and `render/sky.js`
 * both read `config.feel.*` and predate this file. Handing them the same
 * object they already expect beats editing two working modules to save one
 * level of nesting.
 */

/**
 * The fps table. `spec/asset-request.md` is explicit that a sidecar names a
 * *speed* and never carries a number, so every key an animation can name has
 * to exist here or the sheet loads with a warning and falls back.
 *
 * The four named keys are exactly the ones the delivered sidecars use:
 * `idle` (a room breathing), `blink` (a stressed room's warning), `walk` (a
 * two-frame figure), `construction` (the three-frame scaffold).
 */
export const SPRITE_FPS = {
  default: 6,
  idle: 2,
  blink: 3,
  walk: 8,
  construction: 6,
};

export const FEEL = {
  feel: {
    /**
     * `[background, panel, good, warn, bad, info]`. Ordered, not named, because
     * that is the order the renderer destructures — and because the HUD's CSS
     * mirrors it, the two are checked against each other by a test rather than
     * by eye.
     */
    palette: ['#0b0f14', '#1b2430', '#06d6a0', '#ffb703', '#ef476f', '#8ecae6'],

    /**
     * Device-pixel ratio ceiling and a total pixel budget. A 4K display at
     * dpr 2 is 8.3M pixels a frame for art that is drawn at 1x; the cap keeps
     * a full redraw comfortably inside a 12 tick/s frame without the renderer
     * ever needing to know what machine it is on.
     */
    maxDpr: 1.25,
    maxCanvasPixels: 2_000_000,

    sprites: {
      fps: SPRITE_FPS,
      /** Integer only — mixel art shears the instant it is scaled 1.5x. */
      maxScale: 3,
      /** A backgrounded tab hands back a multi-second dt; clamp the catch-up. */
      maxFrameStepMs: 120,
      /**
       * Figures drawn per frame before the crowd falls back to dots. A grown
       * tower can have a queue on every visible floor at once, so the worst
       * case wants to be bounded by a number here rather than by how badly the
       * player is doing.
       */
      maxCrowdFigures: 220,
    },

    sky: {
      cloudCount: 9,
      maxFlyers: 4,
    },
  },
};

export default FEEL;
