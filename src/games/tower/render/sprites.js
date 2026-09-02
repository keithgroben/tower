/**
 * Sprite sheet loader + animation clock. Renderer-only.
 *
 * Nothing here may touch sim state, and nothing under `sim/**` may import it.
 * A sprite is a *look*; if a look could change an outcome it stopped being a
 * sprite. Every fps constant is resolved out of `config.feel.sprites.fps` —
 * the sidecar names a speed, it never carries a number (see `spec/asset-
 * request.md`, "Sidecar JSON").
 *
 * The load-bearing property: **art lands one subject at a time, so a missing
 * or malformed sheet is the normal case, not an error case.** Every entry
 * point returns `null` / `false` instead of throwing, and the caller falls
 * back to the coloured rectangles it drew before:
 *
 *     if (!book.drawSprite(ctx, { name: 'office', animation: 'vacant', x, y, scale }))
 *       drawTheOldRectangle();
 *
 * Loads are fire-and-forget: `request()` returns immediately and the sheet
 * appears on some later frame. Nothing awaits a sheet inside a frame.
 */

/** Sheet lifecycle. Only 'ready' draws; every other state falls back. */
export const SHEET_IDLE = 'idle';
export const SHEET_LOADING = 'loading';
export const SHEET_READY = 'ready';
export const SHEET_MISSING = 'missing';     // no PNG / no sidecar / fetch failed
export const SHEET_MALFORMED = 'malformed'; // sidecar parsed but does not describe a sheet

/** Defaults used when `config.feel.sprites` is absent, so the loader still
 *  works standalone (tests, a bare harness page). */
const DEFAULT_FPS = { default: 6 };
const DEFAULT_MAX_SCALE = 3;
const DEFAULT_MAX_FRAME_STEP_MS = 120;

function spriteFeel(config) {
  return (config && config.feel && config.feel.sprites) || {};
}

/** The fps table lives in `config.feel` and nowhere else. */
export function fpsTable(config) {
  const table = spriteFeel(config).fps;
  return table && typeof table === 'object' ? table : DEFAULT_FPS;
}

/** Integer zoom only — mixel art shears the instant it is scaled 1.5x. */
export function integerScale(scale, config) {
  const max = spriteFeel(config).maxScale ?? DEFAULT_MAX_SCALE;
  if (!Number.isFinite(scale)) return 1;
  return Math.max(1, Math.min(max, Math.round(scale)));
}

/** Nearest-neighbour, on every context we touch. Never smooth, ever. */
export function applyPixelSampling(ctx) {
  if (!ctx) return false;
  ctx.imageSmoothingEnabled = false;
  // Prefixed forms still matter on older Safari/Firefox builds.
  if ('mozImageSmoothingEnabled' in ctx) ctx.mozImageSmoothingEnabled = false;
  if ('webkitImageSmoothingEnabled' in ctx) ctx.webkitImageSmoothingEnabled = false;
  if ('msImageSmoothingEnabled' in ctx) ctx.msImageSmoothingEnabled = false;
  return true;
}

// ---------------------------------------------------------------------------
// Sidecar manifest
// ---------------------------------------------------------------------------

/**
 * Parse a sidecar JSON into a validated sheet description. Pure, and never
 * throws — a bad sidecar comes back as `{ ok: false, error }`.
 *
 * Sidecar shape (one file per subject, frames left to right — exactly what
 * `spec/asset-request.md` asks the artist for):
 *
 *     {
 *       "frameW": 48,
 *       "frameH": 32,
 *       "animations": {
 *         "vacant":         { "col": 0, "frames": 1 },
 *         "occupied-day":   { "col": 1, "frames": 2, "speed": "idle" },
 *         "occupied-night": { "col": 3, "frames": 1 },
 *         "doors-opening":  { "col": 4, "frames": 3, "speed": "doors", "loop": false }
 *       }
 *     }
 *
 * `col` is the first frame's column (default 0) and `row` the row for the rare
 * grid sheet (default 0). `speed` names a key in `config.feel.sprites.fps`;
 * omit it for the `default` speed. A numeric `fps`/`speed` is refused — it
 * would put a feel constant in an art file — and the animation falls back to
 * the default speed with a warning rather than failing the whole sheet.
 *
 * @param raw     the sidecar text, or an already-parsed object
 * @param options `{ config, sheetW, sheetH }` — dimensions, when known, bound
 *                the frame rects so an animation cannot sample off the sheet.
 */
export function parseSheetManifest(raw, options = {}) {
  const { config = null, sheetW = null, sheetH = null } = options;
  const table = fpsTable(config);
  const warnings = [];

  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); }
    catch (e) { return { ok: false, error: `sidecar is not valid JSON: ${e.message}`, warnings }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'sidecar is not an object', warnings };
  }

  const frameW = data.frameW, frameH = data.frameH;
  if (!Number.isInteger(frameW) || frameW <= 0) return { ok: false, error: 'frameW must be a positive integer', warnings };
  if (!Number.isInteger(frameH) || frameH <= 0) return { ok: false, error: 'frameH must be a positive integer', warnings };

  const src = data.animations;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, error: 'animations must be an object', warnings };
  }
  const names = Object.keys(src);
  if (names.length === 0) return { ok: false, error: 'sheet declares no animations', warnings };

  const animations = {};
  for (const name of names) {
    const a = src[name];
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return { ok: false, error: `animation "${name}" is not an object`, warnings };
    }
    const frames = a.frames;
    if (!Number.isInteger(frames) || frames <= 0) {
      return { ok: false, error: `animation "${name}" needs a positive integer frames`, warnings };
    }
    const row = a.row ?? 0;
    const col = a.col ?? 0;
    if (!Number.isInteger(row) || row < 0) return { ok: false, error: `animation "${name}" has a bad row`, warnings };
    if (!Number.isInteger(col) || col < 0) return { ok: false, error: `animation "${name}" has a bad col`, warnings };

    // The sheet must physically contain every frame it promises. Without this
    // an off-by-one column samples transparent pixels and the room silently
    // disappears — worse than falling back, because it looks deliberate.
    if (Number.isFinite(sheetW) && sheetW !== null && (col + frames) * frameW > sheetW) {
      return { ok: false, error: `animation "${name}" runs past the right edge of the sheet`, warnings };
    }
    if (Number.isFinite(sheetH) && sheetH !== null && (row + 1) * frameH > sheetH) {
      return { ok: false, error: `animation "${name}" runs past the bottom of the sheet`, warnings };
    }

    const speedKey = a.speed ?? a.fps ?? 'default';
    let speed = 'default';
    if (typeof speedKey === 'number') {
      warnings.push(`animation "${name}" carries a numeric fps; fps lives in config.feel.sprites.fps — using "default"`);
    } else if (typeof speedKey !== 'string') {
      warnings.push(`animation "${name}" has a non-string speed — using "default"`);
    } else if (!Object.prototype.hasOwnProperty.call(table, speedKey)) {
      warnings.push(`animation "${name}" names unknown speed "${speedKey}" — using "default"`);
    } else {
      speed = speedKey;
    }

    const fps = Number(table[speed] ?? table.default ?? DEFAULT_FPS.default);
    animations[name] = {
      name,
      row, col, frames,
      speed,
      fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS.default,
      loop: a.loop !== false,
    };
  }

  return { ok: true, warnings, sheet: { frameW, frameH, animations, sheetW, sheetH } };
}

/**
 * Where frame `index` of `animation` sits on the sheet. Returns `null` for an
 * unknown animation, never throws. A looping animation wraps an out-of-range
 * index; a one-shot clamps to its last frame.
 */
export function frameRect(sheet, animation, index = 0) {
  if (!sheet || !sheet.animations) return null;
  const anim = sheet.animations[animation];
  if (!anim) return null;
  const i = normalizeFrameIndex(anim, index);
  return {
    sx: (anim.col + i) * sheet.frameW,
    sy: anim.row * sheet.frameH,
    sw: sheet.frameW,
    sh: sheet.frameH,
  };
}

function normalizeFrameIndex(anim, index) {
  if (!Number.isFinite(index)) return 0;
  const i = Math.floor(index);
  if (!anim.loop) return Math.max(0, Math.min(anim.frames - 1, i));
  const wrapped = i % anim.frames;
  return wrapped < 0 ? wrapped + anim.frames : wrapped;
}

/**
 * Which frame an animation is showing after `elapsedMs` of render time.
 * `phaseMs` de-synchronises instances so a floor of offices does not blink in
 * lockstep — the caller derives it from something stable (a room id), never
 * from a random number, so a replay looks the same twice.
 */
export function frameIndexAt(anim, elapsedMs, phaseMs = 0) {
  if (!anim || !Number.isFinite(anim.frames) || anim.frames <= 1) return 0;
  const fps = anim.fps;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  const t = (Number(elapsedMs) || 0) + (Number(phaseMs) || 0);
  return normalizeFrameIndex(anim, Math.floor((t * fps) / 1000));
}

/**
 * The animation clock. Driven by *render* dt (`renderDtMs` in `ui/app.js`),
 * never by sim time — animation is feel, and the sim's fixed timestep must not
 * be able to see it.
 */
export function makeAnimationClock(config = null) {
  const maxStep = spriteFeel(config).maxFrameStepMs ?? DEFAULT_MAX_FRAME_STEP_MS;
  let elapsedMs = 0;
  return {
    /** @returns the new elapsed time, so callers can read it in one call. */
    advance(dtMs) {
      const dt = Number(dtMs);
      // A backgrounded tab hands back a multi-second dt on return. Clamping
      // keeps a one-shot (doors opening) from teleporting to its last frame.
      if (Number.isFinite(dt) && dt > 0) elapsedMs += Math.min(dt, maxStep);
      return elapsedMs;
    },
    get elapsedMs() { return elapsedMs; },
    reset() { elapsedMs = 0; },
  };
}

// ---------------------------------------------------------------------------
// Default async loaders (browser). Absent in Node — that is a fallback, not a
// failure: every sheet reports `missing` and the renderer draws rectangles.
// ---------------------------------------------------------------------------

function defaultLoadJson(url) {
  if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch in this environment'));
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  });
}

function defaultLoadImage(url) {
  if (typeof Image !== 'function') return Promise.reject(new Error('no Image in this environment'));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not decode ${url}`));
    img.src = url;
  });
}

/** Assets sit beside the renderer so both Vite and `harness/serve.js` serve
 *  them without a config entry. Resolved from this module's own URL — kept in
 *  a const rather than inline so Vite's `new URL(<literal>, import.meta.url)`
 *  asset rewriting leaves it alone; this is a directory, not an import. */
const SPRITE_DIR = '../assets/sprites/';

/**
 * Where the sheets live, resolved against the PAGE rather than this module.
 *
 * Module-relative worked in dev, where this file sits two directories from the
 * art, and would have broken in a production build, where it is bundled into
 * one chunk somewhere else entirely. Resolving against `document.baseURI`
 * gives the same answer in both, because the page and the assets move
 * together. Node has no document, so the module URL stays as the fallback and
 * the tests keep working.
 */
function defaultBasePath() {
  try {
    if (typeof document !== 'undefined' && document.baseURI) {
      return new URL('assets/sprites/', document.baseURI).href;
    }
  } catch { /* fall through to the module-relative path */ }
  try { return new URL(SPRITE_DIR, import.meta.url).href; }
  catch { return SPRITE_DIR; }
}

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

/**
 * A lazy collection of sheets plus the clock that animates them.
 *
 * @param config  the game config; only `config.feel.sprites` is read.
 * @param options `{ basePath, loadImage, loadJson, onWarn }` — the loaders are
 *                injectable so tests can drive load, failure and malformed
 *                sidecars without a DOM.
 */
export function makeSpriteBook(config, options = {}) {
  const {
    basePath = defaultBasePath(),
    loadImage = defaultLoadImage,
    loadJson = defaultLoadJson,
    onWarn = null,
  } = options;

  const entries = new Map();
  const clock = makeAnimationClock(config);

  const warn = (message) => { if (typeof onWarn === 'function') { try { onWarn(message); } catch { /* a logger must never break a frame */ } } };
  const url = (file) => `${basePath}${file}`;

  function entry(name) {
    let e = entries.get(name);
    if (!e) { e = { name, status: SHEET_IDLE, sheet: null, image: null, error: null, pending: null }; entries.set(name, e); }
    return e;
  }

  function fail(e, status, error) {
    e.status = status;
    e.sheet = null;
    e.image = null;
    e.error = error;
    warn(`sprite sheet "${e.name}": ${error}`);
    return e;
  }

  /**
   * Start loading a sheet. Returns immediately and always resolves — a frame
   * never waits on art. Calling it repeatedly is free: an in-flight load hands
   * back the same promise, and a settled one resolves at once.
   */
  function request(name) {
    const e = entry(name);
    if (e.pending) return e.pending;
    if (e.status !== SHEET_IDLE) return Promise.resolve(e);
    e.status = SHEET_LOADING;

    const both = Promise.all([
      Promise.resolve().then(() => loadJson(url(`${name}.json`))),
      Promise.resolve().then(() => loadImage(url(`${name}.png`))),
    ]);

    e.pending = both.then(
      ([raw, image]) => {
        const sheetW = Number.isFinite(image?.naturalWidth) ? image.naturalWidth
          : (Number.isFinite(image?.width) ? image.width : null);
        const sheetH = Number.isFinite(image?.naturalHeight) ? image.naturalHeight
          : (Number.isFinite(image?.height) ? image.height : null);
        const parsed = parseSheetManifest(raw, { config, sheetW, sheetH });
        if (!parsed.ok) return fail(e, SHEET_MALFORMED, parsed.error);
        for (const w of parsed.warnings) warn(`sprite sheet "${name}": ${w}`);
        e.sheet = parsed.sheet;
        e.image = image;
        e.error = null;
        e.status = SHEET_READY;
        return e;
      },
      (err) => fail(e, SHEET_MISSING, err && err.message ? err.message : String(err)),
    ).then((settled) => { e.pending = null; return settled; });
    return e.pending;
  }

  function preload(names) {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) request(n);
    return list.length;
  }

  function status(name) { return entries.get(name)?.status ?? SHEET_IDLE; }

  /** The sheet if it is drawable, else `null`. Requests it on first ask so a
   *  caller can simply try to draw and let the art turn up later. */
  function sheetFor(name) {
    const e = entries.get(name);
    if (!e) { request(name); return null; }
    return e.status === SHEET_READY ? e.sheet : null;
  }

  function animation(name, animName) {
    const sheet = sheetFor(name);
    if (!sheet) return null;
    return sheet.animations[animName] ?? null;
  }

  /** Whether a specific animation can be drawn right now. */
  function has(name, animName) {
    return animation(name, animName) !== null;
  }

  /**
   * Draw one frame. **Returns `false` whenever it drew nothing** — missing
   * sheet, missing animation, no context — which is the caller's cue to draw
   * its rectangle. It never throws.
   *
   * `x`/`y` are the destination top-left in device pixels, `scale` is rounded
   * to an integer, and both are floored so a sprite lands on the pixel grid.
   */
  function drawSprite(ctx, opts = {}) {
    if (!ctx || typeof ctx.drawImage !== 'function') return false;
    const { name, animation: animName, x = 0, y = 0, scale = 1, phaseMs = 0, frame = null } = opts;
    const e = entries.get(name);
    if (!e) { request(name); return false; }
    if (e.status !== SHEET_READY) return false;

    const anim = e.sheet.animations[animName];
    if (!anim) return false;

    const index = frame === null ? frameIndexAt(anim, clock.elapsedMs, phaseMs) : frame;
    const rect = frameRect(e.sheet, animName, index);
    if (!rect) return false;

    const k = integerScale(scale, config);
    applyPixelSampling(ctx);
    try {
      ctx.drawImage(
        e.image,
        rect.sx, rect.sy, rect.sw, rect.sh,
        Math.floor(x), Math.floor(y), rect.sw * k, rect.sh * k,
      );
    } catch (err) {
      // A decoded-but-broken image can still throw on draw. One bad sheet must
      // not take the frame down with it.
      fail(e, SHEET_MALFORMED, err && err.message ? err.message : String(err));
      return false;
    }
    return true;
  }

  return {
    // clock
    advance(dtMs) { return clock.advance(dtMs); },
    get elapsedMs() { return clock.elapsedMs; },
    resetClock() { clock.reset(); },
    // sheets
    request, preload, status, sheetFor, animation, has, drawSprite,
    basePath,
    /** Counts by status — for a debug readout, not for logic. */
    stats() {
      const out = { total: 0 };
      for (const e of entries.values()) { out.total++; out[e.status] = (out[e.status] ?? 0) + 1; }
      return out;
    },
  };
}

export default makeSpriteBook;
