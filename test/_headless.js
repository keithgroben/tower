/**
 * A canvas and a sprite loader that work in Node, so the renderer can be driven
 * by `node test/run.js` with **no `npm install`** — `CLAUDE.md`'s hard rule.
 *
 * Not a shim to make drawing assertable. Drawing is not assertable and
 * contorting the renderer to pretend otherwise is explicitly out of scope. This
 * exists for one job: proving that a real frame *reached* the art. The
 * predecessor shipped six sheets nothing ever drew, and the reason it could is
 * that the loader is designed to fall back silently — in Node every sheet
 * reports `missing` and the renderer draws rectangles, which looks identical to
 * working from outside.
 *
 * Named `_headless.js` so the runner's `*.test.js` glob skips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPRITE_DIR = path.join(here, '..', 'src', 'games', 'tower', 'assets', 'sprites');

/**
 * A PNG's pixel dimensions, straight out of the IHDR chunk.
 *
 * The sidecar parser bounds every animation's frame rects against the sheet's
 * real size, and that check is the one that catches an off-by-one column — a
 * column that samples transparent pixels and makes a room silently disappear,
 * which is worse than falling back because it looks deliberate. Handing the
 * parser a `null` size would switch the check off in exactly the test meant to
 * exercise it, so the header is read for real. It is twelve bytes in.
 */
export function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
  if (head.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** Loaders that read the real sheets off disk. */
export const diskSpriteLoaders = {
  basePath: SPRITE_DIR + path.sep,
  loadJson: (url) => fs.promises.readFile(url, 'utf8'),
  loadImage: async (url) => {
    const { width, height } = pngSize(url);
    // The renderer never inspects the pixels — `drawImage` on the stub context
    // is a no-op — so the dimensions are the whole of what a "decoded image"
    // has to be here.
    return { width, height, naturalWidth: width, naturalHeight: height };
  },
};

/** Every sheet with both a PNG and a sidecar, which is what "delivered" means. */
export function deliveredSheets() {
  return fs.readdirSync(SPRITE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((name) => fs.existsSync(path.join(SPRITE_DIR, name + '.png')))
    .sort();
}

/** One sheet's declared animation names, from its sidecar. */
export function sheetAnimations(name) {
  const raw = fs.readFileSync(path.join(SPRITE_DIR, name + '.json'), 'utf8');
  return Object.keys(JSON.parse(raw).animations ?? {});
}

/**
 * A 2D context that accepts every call the renderer makes and draws nothing.
 *
 * It records nothing on purpose. What a frame *painted* is not something a
 * headless assertion can judge; what a frame *asked the sprite book for* is,
 * and that is recorded by wrapping the book instead.
 */
export function stubContext() {
  const noop = () => {};
  return {
    canvas: null,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'left',
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    rect: noop, clip: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop,
    fillText: noop, setLineDash: noop, drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
  };
}

/** A canvas element stand-in: a fixed size and a context. */
export function stubCanvas(w = 1200, h = 760) {
  const ctx = stubContext();
  const canvas = {
    width: w, height: h,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }),
  };
  ctx.canvas = canvas;
  return canvas;
}
