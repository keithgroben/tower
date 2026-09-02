/**
 * The tower, drawn.
 *
 * Rewritten against the state shape in `sim/state.js`. The predecessor's
 * renderer read `state.units` / `state.shafts` / `state.floors` / `state.lobby`
 * and an evaluation model of appeal scores, desirability and service coverage
 * that no longer exists; roughly two thirds of it was pumping numbers from that
 * model onto the screen. What survived is the part that was about *drawing a
 * building*: the camera, the minimap, the sprite fallbacks, the earth and the
 * sky. See the report and `git log` for the full list of what went.
 *
 * ## The one rule
 *
 * **Nothing here writes to the tower.** Every function takes the tower and
 * returns pixels. The two mutable maps in `makeRenderer` — smoothed car
 * positions and the construction-dust timers — are render-local, keyed on
 * render time, and a tower plays identically with both switched off.
 *
 * ## What this screen is FOR
 *
 * `spec/simtower-loop.md` §3: *your elevator network doesn't just serve your
 * tenants — it decides whether you have any.* So the four things this draws
 * before anything decorative are:
 *
 *  - which offices are **let** and which are **For Rent**
 *  - each worker's **stress**, banded by `stressBand()` from `sim/stress.js`
 *  - the people **waiting** on a floor
 *  - the **cars** moving
 *
 * If those four are legible the loop is visible; everything else is scenery.
 *
 * ## Geometry
 *
 * The lot is `TILES_PER_FLOOR` (150) tiles across and floors run
 * `MIN_FLOOR..MAX_FLOOR` (−10..109) with **0 the ground lobby**. Never test a
 * floor for validity with `< 0` — `−1` is B1, a real floor (`CLAUDE.md`, the
 * sentinel section). `floorExists()` is the check.
 */
import { clockTime } from '../sim/clock.js';
import { CARRIER_MODE } from '../sim/elevators.js';
import {
  FAMILY, GROUND_FLOOR, MAX_FLOOR, MIN_FLOOR, TILES_PER_FLOOR,
  floorExists, floorLabel, isBasement, isInTransit, isRented, isSkyLobbyFloor,
} from '../sim/state.js';
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import FEEL from './feel.js';
import { makeSpriteBook } from './sprites.js';
import { cloudScale, daylight, flyerScale, makeSky, skyColors } from './sky.js';

// ---------------------------------------------------------------- the world
//
// Native art dimensions, from `spec/sprite-manifest.md`. `spec/tower-view.md`
// §8 fixes them: building higher makes the tower TALLER, it never makes it
// smaller. The predecessor's fit-to-viewport layout drew a slot at half the
// grid the art is drawn on by 60 floors, which is why its tower got *less*
// legible the better you played.

/**
 * One tile is 8 px wide at 1x, so the delivered 48 px art cell is exactly six
 * tiles — and six tiles is an office. `specs/facility/OFFICE.md` line 289
 * ("refreshes the 6-tile span") is where that number comes from, which is the
 * happy accident that lets the existing sheets survive the state-shape change
 * untouched.
 */
export const TILE_W = 8;
/** One floor is 32 px tall at 1x, forever. */
export const FLOOR_H = 32;
/** Tiles under one 48 px art cell. Objects wider than this tile their sheet. */
export const ART_CELL_TILES = 6;
/** Integer only: mixel art shears the moment it is scaled 1.5x. */
export const ZOOM_LEVELS = [1, 2, 3];

/**
 * World coordinates. `x` grows right from tile 0's left edge; `y` grows DOWN
 * from the ground line, which is floor 0's slab. Floor `f` occupies
 * `[-(f+1)*FLOOR_H, -f*FLOOR_H)`.
 *
 * The origin is the ground line rather than the bottom of the world, so
 * digging to B10 does not move the origin under the player.
 */
export function floorTopWorldY(floor) { return -(floor + 1) * FLOOR_H; }
export function floorBottomWorldY(floor) { return -floor * FLOOR_H; }
export function tileLeftWorldX(tile) { return tile * TILE_W; }
export function floorAtWorldY(worldY) { return Math.floor(-worldY / FLOOR_H); }
export function tileAtWorldX(worldX) { return Math.floor(worldX / TILE_W); }

export function clampZoom(zoom) {
  const z = Math.round(Number(zoom) || 1);
  return Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], Math.max(ZOOM_LEVELS[0], z));
}

/** Camera state is `{ x, y, zoom }`, where x/y is the world point at the CENTRE
 *  of the viewport. It lives in the renderer and nowhere else. */
export function makeCamera(x = 0, y = 0, zoom = 1) {
  return { x, y, zoom: clampZoom(zoom) };
}

export function worldToScreen(camera, viewport, worldX, worldY) {
  const z = clampZoom(camera.zoom);
  return [(worldX - camera.x) * z + viewport.w / 2, (worldY - camera.y) * z + viewport.h / 2];
}

/** The inverse transform every pick goes through. */
export function screenToWorld(camera, viewport, screenX, screenY) {
  const z = clampZoom(camera.zoom);
  return [(screenX - viewport.w / 2) / z + camera.x, (screenY - viewport.h / 2) / z + camera.y];
}

export function visibleWorldRect(camera, viewport) {
  const [left, top] = screenToWorld(camera, viewport, 0, 0);
  const [right, bottom] = screenToWorld(camera, viewport, viewport.w, viewport.h);
  return { left, top, right, bottom };
}

/**
 * Floors touching the viewport, so a 120-floor world only draws what it must.
 *
 * Clamped to `MIN_FLOOR..MAX_FLOOR` rather than to zero. The predecessor
 * clamped its low end with `Math.min(0, …)` because its world bottomed out at
 * the ground floor; here −10 is a floor you can build on.
 */
export function visibleFloorRange(camera, viewport) {
  const rect = visibleWorldRect(camera, viewport);
  return {
    low: Math.max(MIN_FLOOR, floorAtWorldY(rect.bottom)),
    high: Math.min(MAX_FLOOR, floorAtWorldY(rect.top)),
  };
}

/** Zoom while holding the world point under `(screenX, screenY)` still — what
 *  makes a wheel zoom land where the player was looking instead of drifting. */
export function cameraZoomedAt(camera, viewport, nextZoom, screenX, screenY) {
  const z = clampZoom(nextZoom);
  const [worldX, worldY] = screenToWorld(camera, viewport, screenX, screenY);
  return {
    x: worldX - (screenX - viewport.w / 2) / z,
    y: worldY - (screenY - viewport.h / 2) / z,
    zoom: z,
  };
}

// ----------------------------------------------------------------- minimap
//
// A narrow vertical strip, one row per floor, with a box marking what the main
// view is looking at. It is what makes a 120-floor world navigable, and it is
// why zoom stays clean integer 1x/2x/3x.
//
// Tiles are mapped PROPORTIONALLY across the strip rather than one cell each.
// The predecessor gave every column its own integer-width cell, which worked at
// its dozen-odd slots and would be 150 px wide here — wider than the strip.

export const MINIMAP = { width: 40, margin: 12, pad: 3, gutter: 5, minRowH: 1, maxRowH: 6 };

export function minimapMetrics(viewport, lowest = MIN_FLOOR, highest = MAX_FLOOR, tiles = TILES_PER_FLOOR) {
  const bottom = Math.round(lowest);
  const top = Math.max(bottom, Math.round(highest));
  const rowCount = top - bottom + 1;
  const availH = Math.max(MINIMAP.minRowH, viewport.h - MINIMAP.margin * 2 - MINIMAP.pad * 2);
  const rowH = Math.max(MINIMAP.minRowH, Math.min(MINIMAP.maxRowH, Math.floor(availH / rowCount)));
  const h = rowH * rowCount;
  const gridW = MINIMAP.width - MINIMAP.gutter;
  const w = MINIMAP.gutter + gridW;
  return {
    x: Math.max(MINIMAP.margin, viewport.w - MINIMAP.margin - MINIMAP.pad - w),
    // Anchored to the bottom, like the tower: the lowest floor is the bottom
    // row and the strip grows upward as the building does.
    y: Math.max(MINIMAP.margin, viewport.h - MINIMAP.margin - MINIMAP.pad - h),
    w, h, rowH, gridW,
    rows: rowCount, lowest: bottom, highest: top,
    tiles: Math.max(1, Math.round(tiles)),
    gutter: MINIMAP.gutter, pad: MINIMAP.pad,
  };
}

export function minimapRowY(metrics, floor) {
  return metrics.y + metrics.h - (floor - metrics.lowest + 1) * metrics.rowH;
}

export function minimapFloorAt(metrics, screenY) {
  const row = Math.floor((metrics.y + metrics.h - screenY) / metrics.rowH);
  return Math.min(metrics.highest, Math.max(metrics.lowest, metrics.lowest + row));
}

/** Screen x of a tile's left edge on the strip. Fractional on purpose. */
export function minimapTileX(metrics, tile) {
  return metrics.x + metrics.gutter + (tile / metrics.tiles) * metrics.gridW;
}

export function minimapTileAt(metrics, screenX) {
  const tile = Math.floor(((screenX - metrics.x - metrics.gutter) / metrics.gridW) * metrics.tiles);
  return Math.min(metrics.tiles - 1, Math.max(0, tile));
}

export function minimapContains(metrics, screenX, screenY) {
  return screenX >= metrics.x - metrics.pad && screenX <= metrics.x + metrics.w + metrics.pad &&
    screenY >= metrics.y - metrics.pad && screenY <= metrics.y + metrics.h + metrics.pad;
}

// ------------------------------------------------------------- the signals
//
// Pure readings of the tower. Everything the screen SAYS is derived here, so
// it can be tested without a canvas and so no two draw passes can disagree
// about what a room's status is.

/**
 * Is this unit actually let?
 *
 * ⚠️ Two fields, and at placement they disagree. `createObject` sets
 * Two independent facts, and a let office needs both. `occupiedFlag` means
 * "this facility's tenants are being measured" — it is set the moment
 * `eval_level` first goes nonzero, which happens to a *vacant* office before
 * anyone has reached it (`sim/office.js`, the bootstrap). `unitStatus` is the
 * lease: `<= 0x0f` is let, `>= 0x10` is For Rent.
 *
 * So the conjunction distinguishes three states the player can actually see:
 * placed and unmeasured, measured but nobody could get there, and let. The
 * middle one is the state this whole build exists to make visible.
 *
 * The band half goes through `isRented()` and never through a hand-written
 * comparison against `0x0f`, so the threshold has exactly one home.
 */
export function officeIsLet(object) {
  if (!object) return false;
  return Boolean(object.occupiedFlag) && isRented(object.unitStatus);
}

/** The tag written over a leasable unit. Empty string when it carries none. */
export function objectStatusTag(object) {
  if (!object) return '';
  if (!LEASABLE.has(object.family)) return '';
  return officeIsLet(object) ? '' : 'FOR RENT';
}

/** Families that can be let, and therefore carry a status tag and a stress
 *  strip. The lobby is infrastructure: it is never "For Rent". */
const LEASABLE = new Set([FAMILY.office, FAMILY.condo, FAMILY.fastFood, FAMILY.retail]);

/**
 * The manual's three stress colours, `specs/PEOPLE.md` § Stress Color Bands,
 * keyed by the band name `stressBand()` returns.
 *
 * "black" is drawn as a pale slate rather than actual black: on a dark tower a
 * black dot is an absent dot, and the band that means *this person is fine* is
 * the one that must not read as missing art.
 */
export const STRESS_COLORS = { black: '#9fb3c8', pink: '#ff9ecd', red: '#ef476f' };

/** One actor's stress score. Higher is worse; 0 means no trips yet. */
export const actorStress = (actor) => computeRuntimeTileStressAverage(actor);

/** The colour for one actor, via `stressBand()` — never a threshold of ours. */
export const actorStressColor = (actor) => STRESS_COLORS[stressBand(actorStress(actor))];

/**
 * Every actor standing on a floor waiting for a ride, grouped by floor.
 *
 * `waitingFloor` is written by `resolveRouteBetweenFloors` on results `2`
 * (queued on a carrier) and `0` (source queue full) and cleared on the others,
 * so it is the sim's own answer to "who is standing here", not a guess.
 */
export function waitingActorsByFloor(tower) {
  const byFloor = new Map();
  for (const actor of tower.actors) {
    if (!actor || actor.waitingFloor == null) continue;
    const list = byFloor.get(actor.waitingFloor);
    if (list) list.push(actor); else byFloor.set(actor.waitingFloor, [actor]);
  }
  return byFloor;
}

/**
 * How many requests are queued on one carrier at one floor, both directions.
 *
 * Read off the rings rather than counted from actors: the ring is what the car
 * actually serves, and the two can legitimately differ for a rider whose route
 * was cancelled. When the badge and the car disagree, the badge should be
 * wrong about the person and right about the queue.
 */
export function carrierQueueDepth(carrier, floor) {
  const slot = floor - carrier.bottomFloor;
  if (carrier.mode === CARRIER_MODE.EXPRESS) {
    // An express carrier's slots are its stop list, not a contiguous range, so
    // its ring index is not `floor - bottom`. Nothing places one yet; when
    // something does, this needs `carrierSlotIndex` rather than arithmetic.
    return 0;
  }
  if (slot < 0 || slot >= carrier.slotCount) return 0;
  const rings = carrier.queues[slot];
  return (rings?.up.count ?? 0) + (rings?.down.count ?? 0);
}

/** Total queued requests on a floor across every carrier that serves it. */
export function queueDepthAt(tower, floor) {
  let total = 0;
  for (const carrier of tower.carriers) total += carrierQueueDepth(carrier, floor);
  return total;
}

/**
 * Queue pressure as a 0..1 ratio and a palette key. Twelve waiting is the
 * critical point — a full 40-entry ring is a tower that has already failed, and
 * a scale that only saturates there would read "fine" through the whole
 * failure.
 */
export const QUEUE_CRITICAL = 12;
export function queuePressure(count) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  const ratio = Math.min(1, n / QUEUE_CRITICAL);
  return { count: n, ratio, colorKey: ratio >= 0.75 ? 'bad' : ratio >= 0.35 ? 'warn' : 'good' };
}

/**
 * Which sheet and animation a placed object draws as, or `null` for a family
 * the art does not cover yet — which simply keeps the coloured rectangle.
 *
 * A vacant leasable unit draws the empty *shell* (`room-empty`), never the
 * furnished sheet's own "vacant" frame: the delivered vacant frames still have
 * desks and figures in them, so at a glance a room waiting for a tenant looked
 * exactly like one full of them. That was a real complaint against the
 * predecessor and it is the single most important distinction on this screen.
 */
export function objectSprite(object, { night = false, stressed = false } = {}) {
  const family = object?.family;
  if (family === FAMILY.lobby) return { name: 'lobby', animation: night ? 'night' : 'day' };
  if (!LEASABLE.has(family)) return null;
  if (!officeIsLet(object)) {
    const shell = { [FAMILY.office]: 'office', [FAMILY.condo]: 'condo', [FAMILY.fastFood]: 'shop', [FAMILY.retail]: 'shop' };
    return { name: 'room-empty', animation: shell[family] };
  }
  if (family === FAMILY.fastFood || family === FAMILY.retail) {
    if (night) return { name: 'shop', animation: 'closed-night' };
    const fronts = ['open-grocery', 'open-cafe', 'open-awning'];
    return { name: 'shop', animation: fronts[object.id % fronts.length] };
  }
  const name = family === FAMILY.condo ? 'condo' : 'office';
  if (stressed) return { name, animation: 'stressed' };
  return { name, animation: night ? 'occupied-night' : 'occupied-day' };
}

// ------------------------------------------------------- the rent moment
//
// **The one thing on this screen that has to be unmissable.**
//
// `spec/simtower-loop.md` §4: an office rents when a worker's lobby-to-office
// route actually resolves. Not when a score clears a bar — because somebody got
// there. That sentence is the reason this repository exists, and Keith has
// never watched it happen. Drawn as a colour change on a room, in a tower of
// forty rooms, it would be invisible: the thing we rebuilt everything to see
// would go past unseen.
//
// So it gets motion, contrast, a word, and a mark on the minimap for when the
// room is off-screen. Render-local and render-timed throughout: pause the game
// and a moment in flight freezes with it, and a tower plays identically with
// the whole thing switched off.

/** Easing for everything below. Fast out of the gate, settles at the end. */
export const easeOutCubic = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/**
 * The timeline, in milliseconds of render time.
 *
 * `totalMs` is derived rather than declared: a hand-written total that
 * disagreed with its own parts would cut the stamp off mid-fade, and the bug
 * would look like a rendering glitch rather than a wrong number.
 */
export const LET_MOMENT = {
  /** A hard flash over the room. Short — this is the punctuation, not the sentence. */
  flashMs: 200,
  /** A ring expanding out of the room, so the eye is pulled from anywhere on screen. */
  ringMs: 900,
  /** A light running up the shaft the tenant actually rode in. */
  shaftMs: 700,
  /** The word punching down to size, holding, then fading. */
  stampInMs: 240,
  stampHoldMs: 1500,
  stampOutMs: 600,
  /**
   * How many moments may run at once. A tower's first morning can rent a dozen
   * offices inside a few seconds, and forty simultaneous flashes is a strobe
   * that reads as a fault rather than as good news. The oldest is dropped.
   */
  maxConcurrent: 14,
};
LET_MOMENT.totalMs = LET_MOMENT.stampInMs + LET_MOMENT.stampHoldMs + LET_MOMENT.stampOutMs;

/**
 * A moment's state at `ageMs`, or `null` once it is over.
 *
 * Pure, and separate from every drawing call, so the timing can be tested
 * without a canvas — the shape of this animation is the whole deliverable, and
 * "it looked right when I ran it" is not a check anybody can repeat.
 *
 * @returns `{ flash, ring, shaft, stamp: {scale, alpha} }` — `flash` is an
 *   alpha, `ring` and `shaft` are 0..1 progress or `null` when finished.
 */
export function letMomentPhase(ageMs) {
  const age = Number(ageMs);
  if (!Number.isFinite(age) || age < 0 || age >= LET_MOMENT.totalMs) return null;

  const flash = age < LET_MOMENT.flashMs ? 1 - easeOutCubic(age / LET_MOMENT.flashMs) : 0;
  const ring = age < LET_MOMENT.ringMs ? age / LET_MOMENT.ringMs : null;
  const shaft = age < LET_MOMENT.shaftMs ? easeOutCubic(age / LET_MOMENT.shaftMs) : null;

  // The stamp lands big and settles, which is what makes it read as an event
  // rather than as a label that was always there.
  let stamp;
  if (age < LET_MOMENT.stampInMs) {
    stamp = { scale: 1 + 0.8 * (1 - easeOutCubic(age / LET_MOMENT.stampInMs)), alpha: 1 };
  } else if (age < LET_MOMENT.stampInMs + LET_MOMENT.stampHoldMs) {
    stamp = { scale: 1, alpha: 1 };
  } else {
    const out = (age - LET_MOMENT.stampInMs - LET_MOMENT.stampHoldMs) / LET_MOMENT.stampOutMs;
    stamp = { scale: 1, alpha: 1 - out };
  }
  return { flash, ring, shaft, stamp };
}

/**
 * The two directions, and why they do not look alike.
 *
 * A let is an arrival: it gets outward motion, a ring, a light in the shaft.
 * A closure is not caused by one journey, it is caused by every journey having
 * been bad — so it gets no ring and no shaft light, because there is no single
 * trip to point at. Giving them the same fanfare would say the two events are
 * the same kind of thing, and they are opposites.
 */
export const LET_MOMENT_STYLE = {
  let: { word: 'LET', ink: '#06d6a0', flash: '255,255,255', ring: true, shaft: true },
  vacated: { word: 'VACATED', ink: '#ef476f', flash: '239,71,111', ring: false, shaft: false },
};

/**
 * Which leasable units changed hands since the last frame.
 *
 * The sim emits no events, so the transition is *observed* by diffing what was
 * on screen last frame against what is on screen now. That keeps the rule in
 * one place — `officeIsLet()` — instead of the renderer holding a second
 * opinion about what "let" means, and it means the moment fires for any cause:
 * a route resolving, an evaluation closing a unit, a save being loaded.
 *
 * A unit seen for the FIRST time is recorded silently. Without that, opening
 * the page on an existing tower would fire a moment for every occupied room in
 * it — a celebration of nothing, which teaches a player to ignore the one that
 * matters.
 *
 * `seen` is mutated: it is the caller's frame-to-frame memory.
 *
 * @returns `[{ object, direction }]` where direction is `'let'` or `'vacated'`
 */
export function diffLetStatus(seen, tower) {
  const changes = [];
  for (const object of tower.objects.values()) {
    if (!LEASABLE.has(object.family) || object.occupants.length === 0) continue;
    const now = officeIsLet(object);
    const before = seen.get(object.id);
    seen.set(object.id, now);
    if (before === undefined || before === now) continue;
    changes.push({ object, direction: now ? 'let' : 'vacated' });
  }
  // A demolished unit must not sit in the map forever pinning a stale answer.
  if (seen.size > tower.objects.size) {
    for (const id of seen.keys()) if (!tower.objects.has(id)) seen.delete(id);
  }
  return changes;
}

/**
 * The sheets and animations this renderer is capable of asking for.
 *
 * `CLAUDE.md`: *"Art existed and nothing drew it, six times."* This catalogue
 * is what `test/sprites.test.js` checks two ways — every entry must exist in
 * the shipped sidecar, and every entry must be reached by a real `drawSprite`
 * call during an actual frame. Preloading does not count, which is why the
 * preload list below is derived from this object rather than written beside it.
 */
export const SPRITE_USES = {
  'ground-street': ['tile'],
  'earth-fill': ['tile'],
  'earth-edge': ['tile'],
  'foundation-slab': ['tile'],
  'floor-slab': ['tile'],
  'roof-cap': ['plain', 'antenna'],
  'basement-empty': ['tile'],
  'slot-empty': ['empty'],
  'slot-construction': ['building'],
  lobby: ['day', 'night'],
  'lobby-wing': ['day', 'night'],
  office: ['occupied-day', 'occupied-night', 'stressed'],
  condo: ['occupied-day', 'occupied-night', 'stressed'],
  shop: ['open-grocery', 'open-cafe', 'open-awning', 'closed-night'],
  'room-empty': ['office', 'condo', 'shop'],
  'shaft-column': ['tile'],
  'elevator-car': ['closed', 'open'],
  'elevator-car-express': ['closed', 'open'],
  'person-worker': ['stand', 'fidget', 'wait', 'wait-annoyed'],
  'person-resident': ['stand', 'fidget', 'wait', 'wait-annoyed'],
  'sky-cloud': ['small', 'medium', 'large'],
  'sky-bird': ['fly'],
  'sky-plane': ['fly'],
  'sky-balloon': ['drift'],
  'sky-blimp': ['drift'],
  'sky-explorer': ['drift'],
  'sky-stunt': ['fly'],
};

/**
 * Delivered sheets this build cannot draw yet, each with the reason.
 *
 * The point is that unused art is *accounted for* rather than silently dead.
 * `test/sprites.test.js` fails on any shipped sheet that is in neither this map
 * nor `SPRITE_USES`, so a new delivery has to be classified the day it lands,
 * and adding the family that uses one forces its removal from here.
 */
export const SPRITE_NOT_YET_DRAWN = {
  hotel: 'no hotel family in sim/state.js — FAMILY has lobby/office/condo/fastFood/retail only',
  'basement-parking': 'parking is an object type nothing places yet (sim/economy.js prices it, sim/state.js has no family)',
  'basement-utility': 'same — no utility family',
  'stairs-segment': 'sim/routing.js models segments, but nothing constructs one yet',
  'escalator-segment': 'same as stairs-segment',
  'palette-icons': 'no build palette in this shell; placement is seeded, not clicked',
  'person-guest': 'drawn by the hotel family, which does not exist',
  placeholder: 'the loader fallback sheet, deliberately never drawn',
};

/**
 * Frames inside a *used* sheet that this build does not draw, each with why.
 *
 * `SPRITE_NOT_YET_DRAWN` catches a whole sheet going unused; this catches the
 * subtler half — a sheet that draws six of its seven frames, which is the shape
 * that hides. Every animation in every delivered sidecar has to appear either
 * in `SPRITE_USES` or here, so the artist's work is always accounted for one
 * way or the other.
 */
export const SPRITE_UNUSED_ANIMATIONS = {
  'slot-empty': {
    selected: 'no build palette in this shell, so no cell is ever selected',
    unavailable: 'no build palette, so placement legality is never previewed',
    highlighted: 'no build palette, so no cell is ever hovered for a placement',
  },
  office: { vacant: 'a vacant unit draws room-empty instead: this sheet\'s own vacant frame still has desks and figures in it, so an empty office looked exactly like a full one' },
  condo: { vacant: 'the furnished sheet\'s vacant frame is not empty enough to read as vacant — see office/vacant' },
  shop: { vacant: 'the furnished sheet\'s vacant frame is not empty enough to read as vacant — see office/vacant' },
  'room-empty': { hotel: 'no hotel family in sim/state.js, so no hotel unit can be vacant' },
  'elevator-car': { opening: 'the doors are open (dwell > 0) or closed; the sim has no intermediate door state to key a transition off' },
  'elevator-car-express': { opening: 'no intermediate door state to key a transition off — see elevator-car/opening' },
  'person-worker': {
    'walk-left': 'nobody walks. ROUTING.md § Stair / Escalator Transit Timing moves an actor across a local segment in ONE refresh stride — the difference between stairs and an escalator is 35 stress a floor against 16, not a walk loop. A walk cycle would be the renderer inventing motion the sim does not have',
    'walk-right': 'nobody walks; a local segment is crossed in one refresh stride — see person-worker/walk-left',
  },
  'person-resident': {
    'walk-left': 'nobody walks; a local segment is crossed in one refresh stride — see person-worker/walk-left',
    'walk-right': 'nobody walks; a local segment is crossed in one refresh stride — see person-worker/walk-left',
    carrying: 'the errand states that would justify it belong to a family module that does not exist',
  },
};

/** Every sheet the renderer preloads. Derived, so it can never drift from what
 *  is actually drawn — the exact drift that produced six undrawn sheets. */
export const PRELOAD_SHEETS = Object.keys(SPRITE_USES);

/**
 * The sky reads the *displayed* clock, not the raw tick.
 *
 * `spec/TICK-MODEL.md` §2: the clock is piecewise, and daypart 0 alone spans
 * five displayed hours. Mapping ticks linearly onto a day is what put the
 * predecessor's morning rush at 01:55 — and would put dawn there too. Driving
 * the sky from `clockTime()` means the light matches the hand on the clock.
 */
export function timeOfDay(dayTick) {
  const { hour24, minute } = clockTime(dayTick);
  return (hour24 * 60 + minute) / 1440;
}

// ---------------------------------------------------------------- renderer

/**
 * @param canvas   an HTMLCanvasElement, or anything with `getContext('2d')` and
 *                 `getBoundingClientRect()` — the tests hand it a stub.
 * @param options  `{ sprites, feel }`. `sprites` is forwarded to
 *   `makeSpriteBook`, so a test can supply loaders that read the real sheets off
 *   disk instead of the network. Without it the book takes its browser defaults
 *   and, in Node, reports every sheet missing — which is the fallback path, not
 *   the art path, and is how six sheets went unnoticed.
 */
export function makeRenderer(canvas, options = {}) {
  const config = options.feel ?? FEEL;
  const ctx = canvas.getContext('2d');
  const [BG, PANEL, GOOD, WARN, BAD, INFO] = config.feel.palette;
  const indicatorColor = (key) => (key === 'good' ? GOOD : key === 'bad' ? BAD : WARN);

  const sprites = makeSpriteBook(config, options.sprites ?? {});
  // The sky owns its own clock and its own randomness. Decoration only: a
  // tower plays identically with it switched off.
  const sky = makeSky(config);
  sprites.preload(PRELOAD_SHEETS);

  /**
   * Smoothed car positions, so a 12-tick/s sim reads as continuous motion.
   *
   * Deliberately NOT interpolated from `car.prevFloor`. `CLAUDE.md` spends a
   * paragraph on that field: it is the last floor a car *stopped* at, not the
   * last one it passed, and the acceleration profile is hidden in it. A
   * renderer that treats it as "where the car just was" would draw a car
   * sliding backwards across half the tower every time it left a stop.
   */
  const smooth = new Map();

  /** Cells with a build landing on them, and when it started. Render-time only;
   *  nothing in here can change what was built or when. */
  const landing = new Map();
  let knownObjects = null;
  let framedTower = null;

  /** Last frame's answer to "is this let", per object. See `diffLetStatus`. */
  const letSeen = new Map();
  /** Rent and closure moments in flight: object id -> `{ object, direction, at, carrierId }`. */
  const letMoments = new Map();
  /**
   * The last carrier each actor was actually SEEN queued on.
   *
   * Observed, never inferred. When an office rents, the shaft light runs up the
   * lift its new tenants were watched riding — not up whichever lift the
   * renderer guesses the router would have picked. Guessing would put a
   * confident bright line on the wrong shaft, and a picture that lies about
   * cause is worse than no picture, in a build whose entire claim is that
   * transport is the cause.
   */
  const lastCarrierOf = new Map();

  let W = 0, H = 0, dpr = 1;
  /** Seconds of render time, for cloud drift and smoke trails. */
  let skyDrift = 0;
  /** How many crowd figures are left in this frame's budget. */
  let crowdBudget = 0;

  const camera = makeCamera(0, 0, 2);
  const viewport = () => ({ w: W, h: H });

  // Fixed relative positions so stars do not re-roll every frame or reload.
  const STARS = [
    [0.06, 10], [0.13, 26], [0.19, 8], [0.27, 34], [0.34, 14], [0.41, 28],
    [0.58, 12], [0.66, 30], [0.73, 6], [0.81, 22], [0.88, 36], [0.94, 16],
  ];

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    const maxDpr = config.feel.maxDpr ?? 1.25;
    const pixelBudget = config.feel.maxCanvasPixels ?? 2000000;
    dpr = Math.min(globalThis.devicePixelRatio || 1, maxDpr, Math.sqrt(pixelBudget / Math.max(1, W * H)));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** A stable per-thing number, so two neighbours do not animate in lockstep. */
  const idPhase = (id) => (id * 2654435761) % 1000;

  /** Day-ness, the same curve the sky is painted from. */
  const dayness = (tod) => daylight(tod);
  const isNight = (tod) => dayness(tod) < 0.35;

  // ------------------------------------------------------------ the layout

  /**
   * The camera transform, in the shape the drawing code speaks: `x0`/`y0` are
   * where world (0, 0) — tile 0's left edge, the ground line — lands on screen.
   */
  function layout() {
    const tw = TILE_W * camera.zoom;
    const fh = FLOOR_H * camera.zoom;
    const [x0, y0] = worldToScreen(camera, viewport(), 0, 0);
    return {
      tw, fh, x0, y0, zoom: camera.zoom,
      floorY: (f) => y0 - (f + 1) * fh,
      tileX: (t) => x0 + t * tw,
    };
  }

  /** Keep the tower reachable without snapping: the player may pan a quarter of
   *  a viewport past its edges and no further, so the view can never be lost. */
  function clampCamera() {
    const z = camera.zoom;
    const slackX = W / (4 * z) + TILE_W * ART_CELL_TILES;
    const slackY = H / (4 * z) + FLOOR_H;
    camera.x = Math.min(TILES_PER_FLOOR * TILE_W + slackX, Math.max(-slackX, camera.x));
    camera.y = Math.min(floorBottomWorldY(MIN_FLOOR) + slackY,
      Math.max(floorTopWorldY(MAX_FLOOR) - slackY, camera.y));
  }

  function centerOn(floor, tile) {
    camera.x = tileLeftWorldX(tile);
    camera.y = floorTopWorldY(floor) + FLOOR_H / 2;
    clampCamera();
  }

  /** The opening shot: the lobby framed on bare ground, at the chunkiest zoom
   *  whose ground floor still has room to build above it. */
  function frameLobby(tower) {
    const fits = ZOOM_LEVELS.filter((z) => FLOOR_H * 10 * z <= H - 80);
    camera.zoom = clampZoom(Math.min(3, fits[fits.length - 1] ?? 1));
    camera.x = builtCentreTile(tower) * TILE_W;
    // Ground line at about 72% of the viewport height: street and a little
    // earth below it, sky and room to build above it.
    camera.y = -(H * 0.28) / camera.zoom;
    clampCamera();
  }

  /** The middle of what has been built, so the opening shot is not empty lot. */
  function builtCentreTile(tower) {
    let low = Infinity, high = -Infinity;
    for (const o of tower.objects.values()) {
      if (o.left < low) low = o.left;
      if (o.right > high) high = o.right;
    }
    if (low > high) return TILES_PER_FLOOR / 2;
    return (low + high + 1) / 2;
  }

  /**
   * The camera stays where the player put it. It may move itself in exactly
   * three cases — first load (frame the lobby), a confirmed placement that
   * landed off-screen, and an explicit `goTo`. Anything else is a bug.
   */
  function followCamera(tower, L) {
    if (!W || !H) return;
    if (framedTower !== tower) {
      framedTower = tower;
      knownObjects = new Set(tower.objects.keys());
      frameLobby(tower);
      return;
    }
    let offscreen = null;
    for (const [id, o] of tower.objects) {
      if (knownObjects.has(id)) continue;
      knownObjects.add(id);
      // Anything that just landed plays its scaffold-and-dust once, on the
      // RENDER clock — pause the game and the dust settles with it.
      landing.set(id, { object: o, at: sprites.elapsedMs });
      if (!offscreen && !objectVisible(L, o)) offscreen = o;
    }
    if (offscreen) centerOn(offscreen.floor, (offscreen.left + offscreen.right + 1) / 2);
  }

  const objectVisible = (L, o) => {
    const x = L.tileX(o.left);
    const y = L.floorY(o.floor);
    return x + (o.right - o.left + 1) * L.tw > 0 && x < W && y + L.fh > 0 && y < H;
  };

  // ------------------------------------------------------------- the frame

  /**
   * One frame. `dtMs` is RENDER time — the animation clock and the sky run off
   * it, and the sim's fixed timestep must never see it.
   */
  function draw(tower, dtMs = 0) {
    if (!W || !H) resize();
    clampCamera();
    crowdBudget = Math.max(0, Number(config.feel?.sprites?.maxCrowdFigures) || 0);
    sprites.advance(dtMs);
    skyDrift += Math.min(120, Math.max(0, dtMs || 0)) / 1000;

    const tod = timeOfDay(tower.clock.dayTick);
    const night = isNight(tod);
    sky.update(dtMs, tod, W, H);
    followCamera(tower, layout());

    const L = layout();
    const visible = visibleFloorRange(camera, viewport());
    const byFloor = objectsByFloor(tower);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintSky(tod);
    drawEarth(L, byFloor);

    for (let f = visible.low; f <= visible.high; f++) drawStorey(L, f, byFloor.get(f));
    drawFoundation(L, byFloor);
    drawRoofCap(L, byFloor);
    drawStreet(L, byFloor.get(GROUND_FLOOR));

    for (const o of tower.objects.values()) drawObject(L, o, night, tower);
    // Shafts go OVER the rooms, not under. A lift lands inside the lobby, and
    // drawing the column first let a 54-tile lobby paint straight over its own
    // doors — the shaft vanished on exactly the floor it matters most.
    for (const carrier of tower.carriers) drawShaft(L, carrier, visible);
    drawConstruction(L);
    for (const carrier of tower.carriers) drawCars(L, carrier, dtMs);
    drawWaiting(L, tower, visible, byFloor);
    for (const o of tower.objects.values()) drawUnitSignals(L, o, tower);
    // Last of the world passes, and it has to stay last: the whole point is
    // that nothing draws over it.
    noteLetChanges(tower);
    drawLetMoments(L, tower);
    // Over everything, because it is about to BE everything: the ghost is what
    // the next click does, and anything drawn on top of it would be describing
    // a tower that is one moment out of date.
    drawGhost(L);

    drawMinimap(L, tower);
  }

  /** Objects grouped by floor, built once a frame and shared by every pass.
   *  Without it each pass re-scans the whole tower, sixty times a second. */
  function objectsByFloor(tower) {
    const byFloor = new Map();
    for (const o of tower.objects.values()) {
      const list = byFloor.get(o.floor);
      if (list) list.push(o); else byFloor.set(o.floor, [o]);
    }
    return byFloor;
  }

  /** Leftmost and rightmost tile built on a floor, or null when it is bare. */
  function builtSpan(objects) {
    if (!objects || !objects.length) return null;
    let left = Infinity, right = -Infinity;
    for (const o of objects) {
      if (o.left < left) left = o.left;
      if (o.right > right) right = o.right;
    }
    return { left, right };
  }

  /**
   * One storey: its shell, its slab, and its label.
   *
   * A storey is only as wide as what stands on it, and the gaps INSIDE that
   * span are empty floor you can see into. Painting the whole 150-tile lot as a
   * slab made one office read as a finished floor; painting only the built
   * cells left a lift shaft floating with a hole between it and the building.
   * A building is continuous between its own ends and nowhere else.
   */
  function drawStorey(L, floor, objects) {
    const span = builtSpan(objects);
    if (!span) return;
    const y = L.floorY(floor);
    if (y + L.fh < 0 || y > H) return;
    const under = isBasement(floor);

    ctx.fillStyle = under ? '#171d1a' : floor === GROUND_FLOOR ? '#141c26' : 'rgba(27,36,48,0.55)';
    const x = L.tileX(span.left);
    const w = (span.right - span.left + 1) * L.tw;
    ctx.fillRect(x, y, w, L.fh - 2);

    // Shell art tiles on the 6-tile art grid, aligned to the span's left edge —
    // and clipped to the span, because a storey 4 tiles past a cell boundary
    // would otherwise paint two tiles of slab and shell into the open air. It
    // reads as a ledge growing out of the building, which is exactly the kind
    // of thing that looks like a deliberate architectural flourish until you
    // notice every floor has one.
    const cellW = ART_CELL_TILES * L.tw;
    const occupied = new Set();
    for (const o of objects) for (let t = o.left; t <= o.right; t++) occupied.add(t);
    withSpanClip(L, span, y, L.fh, () => {
      for (let t = span.left; t <= span.right; t += ART_CELL_TILES) {
        const cx = L.tileX(t);
        if (cx + cellW < 0 || cx > W) continue;
        if (under) {
          sprites.drawSprite(ctx, { name: 'basement-empty', animation: 'tile', x: cx, y, scale: L.zoom });
        } else if (!occupied.has(t)) {
          // Unbuilt space inside the building: the shell, not the sky.
          sprites.drawSprite(ctx, { name: 'slot-empty', animation: 'empty', x: cx, y, scale: L.zoom });
        }
      }
    });

    // Where a dug storey ends, the earth it was cut out of begins. Drawn
    // OUTSIDE the span: the edge is soil, not a buildable tile.
    if (under) {
      for (const t of [span.left - ART_CELL_TILES, span.right + 1]) {
        const ex = L.tileX(t);
        if (ex + cellW < 0 || ex > W) continue;
        sprites.drawSprite(ctx, { name: 'earth-edge', animation: 'tile', x: ex, y, scale: L.zoom });
      }
    }

    // The line between storeys. Without it a stack of rooms reads as one tall
    // column of colour; the slab is what makes them floors.
    const slabH = Math.max(1, Math.round(4 * L.zoom));
    withSpanClip(L, span, y, L.fh, () => {
      for (let t = span.left; t <= span.right; t += ART_CELL_TILES) {
        const cx = L.tileX(t);
        if (cx + cellW < 0 || cx > W) continue;
        sprites.drawSprite(ctx, { name: 'floor-slab', animation: 'tile', x: cx, y: y + L.fh - slabH, scale: L.zoom });
      }
    });

    // A sky lobby is a transfer floor, and the player has to be able to find
    // one from across the building. `isSkyLobbyFloor` is the sim's rule; the
    // renderer only colours it.
    ctx.fillStyle = under ? 'rgba(198,166,124,0.5)' : isSkyLobbyFloor(floor) ? INFO : 'rgba(142,202,230,0.35)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(floorLabel(floor), x - 8, y + L.fh * 0.68);
  }

  /** The slab the whole tower stands on, under the deepest built storey. */
  function drawFoundation(L, byFloor) {
    let bottom = GROUND_FLOOR;
    for (const floor of byFloor.keys()) if (floor < bottom) bottom = floor;
    const y = L.floorY(bottom) + L.fh;
    if (y < -20 || y > H + 20) return;
    const span = builtSpan(byFloor.get(bottom)) ?? { left: 0, right: TILES_PER_FLOOR - 1 };
    const cellW = ART_CELL_TILES * L.tw;
    const h = Math.max(2, Math.round(6 * L.zoom));
    withSpanClip(L, span, y, h, () => {
      for (let t = span.left; t <= span.right; t += ART_CELL_TILES) {
        const x = L.tileX(t);
        if (x + cellW < 0 || x > W) continue;
        if (sprites.drawSprite(ctx, { name: 'foundation-slab', animation: 'tile', x, y, scale: L.zoom })) continue;
        ctx.fillStyle = '#2a2520';
        ctx.fillRect(x, y, cellW, h);
      }
    });
  }

  /** The parapet, so the top storey reads as finished rather than cut off. The
   *  first cell gets the antenna, because a skyline needs one thing sticking up. */
  function drawRoofCap(L, byFloor) {
    let roof = null;
    for (const floor of byFloor.keys()) if (roof === null || floor > roof) roof = floor;
    if (roof === null || roof < GROUND_FLOOR) return;
    const span = builtSpan(byFloor.get(roof));
    if (!span) return;
    const h = Math.max(2, Math.round(12 * L.zoom));
    const y = L.floorY(roof) - h;
    if (y > H || y + h < 0) return;
    const cellW = ART_CELL_TILES * L.tw;
    withSpanClip(L, span, y, h, () => {
      for (let t = span.left; t <= span.right; t += ART_CELL_TILES) {
        const x = L.tileX(t);
        if (x + cellW < 0 || x > W) continue;
        // The antenna belongs to the building's left corner, not to whichever
        // cell happens to be drawn first — so it is keyed to the span, and pans
        // off the screen with the corner it sits on.
        sprites.drawSprite(ctx, {
          name: 'roof-cap', animation: t === span.left ? 'antenna' : 'plain', x, y, scale: L.zoom,
        });
      }
    });
  }

  /**
   * Run `paint` clipped to a storey's built span.
   *
   * The art grid is 6 tiles and a storey can end anywhere, so every tiled pass
   * over a span has to be clipped or it spills up to five tiles past the end of
   * the building.
   */
  function withSpanClip(L, span, y, h, paint) {
    const x = L.tileX(span.left);
    const w = (span.right - span.left + 1) * L.tw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    try { paint(); } finally { ctx.restore(); }
  }

  function drawEarth(L, byFloor) {
    let bottom = GROUND_FLOOR;
    for (const floor of byFloor.keys()) if (floor < bottom) bottom = floor;
    const groundY = L.floorY(bottom) + L.fh;
    if (groundY > H + 60) return;
    const top = Math.max(-60, groundY);

    // Tiled soil, aligned to the WORLD grid rather than the screen, so the
    // earth holds still while the camera moves over it.
    const tileW = ART_CELL_TILES * L.tw, tileH = FLOOR_H * L.zoom;
    const firstX = L.x0 - Math.ceil((L.x0 + 60) / tileW) * tileW;
    const firstY = groundY + Math.floor((top - groundY) / tileH) * tileH;
    if (tileAcross('earth-fill', 'tile', firstX, firstY, W + 60, H + 60, tileW, tileH)) return;

    const soil = ctx.createLinearGradient(0, groundY, 0, groundY + H + 120);
    soil.addColorStop(0, '#3b2d21');
    soil.addColorStop(1, '#150f0b');
    ctx.fillStyle = soil;
    ctx.fillRect(-60, top, W + 120, H + 120 - top);
  }

  /** Sidewalk, curb, and the ground line itself. */
  function drawStreet(L, groundObjects) {
    const groundY = L.y0;
    const sh = 16 * L.zoom;
    const streetTop = groundY - sh;
    if (streetTop < H && groundY > -sh) {
      const paveW = ART_CELL_TILES * L.tw;
      const firstPave = L.x0 - Math.ceil((L.x0 + 60) / paveW) * paveW;
      // A tile the lobby stands in is its own ground; paving it too would run
      // the curb line straight through the entrance.
      const skipX = new Set();
      for (const o of groundObjects ?? []) {
        if (o.family !== FAMILY.lobby) continue;
        for (let t = o.left; t <= o.right; t += ART_CELL_TILES) skipX.add(Math.round(L.tileX(t)));
      }
      if (!tileAcross('ground-street', 'tile', firstPave, streetTop, W + 60, groundY, paveW, sh, skipX)) {
        ctx.fillStyle = '#48525e';
        ctx.fillRect(-60, streetTop, W + 120, sh);
        ctx.fillStyle = '#69747f';
        ctx.fillRect(-60, streetTop, W + 120, Math.max(1, L.zoom));
      }
    }
    ctx.strokeStyle = PANEL;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-60, groundY + 1);
    ctx.lineTo(W + 60, groundY + 1);
    ctx.stroke();
  }

  /** Paint a sheet across a rectangle, one frame per art cell. */
  function tileAcross(name, animation, x0, y0, x1, y1, tileW, tileH, skipX = null) {
    if (!sprites.has(name, animation)) return false;
    for (let y = y0; y < y1; y += tileH) {
      for (let x = x0; x < x1; x += tileW) {
        if (skipX && skipX.has(Math.round(x))) continue;
        if (!sprites.drawSprite(ctx, { name, animation, x, y, scale: tileW / (ART_CELL_TILES * TILE_W) })) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------- the rooms

  /**
   * One placed object's art. Sprites tile on the 6-tile art grid and are
   * clipped to the object's real span, so a 4-tile unit is not drawn 6 wide.
   */
  function drawObject(L, o, night, tower) {
    const x = L.tileX(o.left);
    const y = L.floorY(o.floor);
    const w = (o.right - o.left + 1) * L.tw;
    if (x + w < 0 || x > W || y + L.fh < 0 || y > H) return;

    const let_ = officeIsLet(o);
    const art = objectSprite(o, { night, stressed: let_ && unitStressBand(tower, o) === 'red' });

    // The fallback the renderer drew before there was any art, and it stays: a
    // sheet can always be missing, and an unfinished subject must cost a
    // rectangle, not a blank room.
    ctx.fillStyle = o.family === FAMILY.lobby ? '#2b3a4d'
      : let_ ? KIND_COLOR[o.family] ?? INFO : 'rgba(120,132,148,0.35)';
    ctx.fillRect(x, y, w, L.fh - 2);

    if (art) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, L.fh);
      ctx.clip();
      const cellW = ART_CELL_TILES * L.tw;
      for (let cx = x; cx < x + w; cx += cellW) {
        sprites.drawSprite(ctx, { ...art, x: cx, y, scale: L.zoom, phaseMs: idPhase(o.id) });
      }
      // A multi-cell lobby gets wings on its ends, which is what turns a row of
      // identical doors into one entrance.
      if (o.family === FAMILY.lobby && w > cellW) {
        const wing = { name: 'lobby-wing', animation: night ? 'night' : 'day' };
        sprites.drawSprite(ctx, { ...wing, x, y, scale: L.zoom });
        sprites.drawSprite(ctx, { ...wing, x: x + w - cellW, y, scale: L.zoom });
      }
      ctx.restore();
    }
  }

  const KIND_COLOR = {
    [FAMILY.office]: '#8ecae6',
    [FAMILY.condo]: '#06d6a0',
    [FAMILY.fastFood]: '#ffb703',
    [FAMILY.retail]: '#ffb703',
  };

  /** The worst band among a unit's occupants — what the room's own art shows. */
  function unitStressBand(tower, o) {
    let worst = 'black';
    for (const actor of occupantsOf(tower, o)) {
      const band = stressBand(actorStress(actor));
      if (band === 'red') return 'red';
      if (band === 'pink') worst = 'pink';
    }
    return worst;
  }

  /** An object's actors. Linear over the actor table, which is fine at this
   *  size and keeps the renderer from caching sim state it does not own. */
  function occupantsOf(tower, o) {
    const out = [];
    for (const actor of tower.actors) if (actor && actor.objectId === o.id) out.push(actor);
    return out;
  }

  /**
   * What the room SAYS: its lease status, and one dot per occupant coloured by
   * that person's stress band.
   *
   * Per-occupant, not averaged, because the loop is about individuals: five
   * fine commutes and one that cannot route is a very different room from six
   * mediocre ones, and the average hides exactly that. `CLAUDE.md`: numbers
   * worth showing go in the world, not in a sidebar.
   */
  function drawUnitSignals(L, o, tower) {
    if (!LEASABLE.has(o.family)) return;
    const x = L.tileX(o.left);
    const y = L.floorY(o.floor);
    const w = (o.right - o.left + 1) * L.tw;
    if (x + w < 0 || x > W || y + L.fh < 0 || y > H) return;
    if (L.fh < 14) return;   // below this the dots are noise, not signal

    const tag = objectStatusTag(o);
    if (tag) {
      ctx.fillStyle = 'rgba(11,15,20,0.72)';
      ctx.fillRect(x + 1, y + 2, w - 2, Math.min(11, L.fh * 0.4));
      ctx.fillStyle = WARN;
      ctx.textAlign = 'center';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText(tag, x + w / 2, y + Math.min(10, L.fh * 0.36));
      return;
    }

    const occupants = occupantsOf(tower, o);
    if (!occupants.length) return;
    const r = Math.max(1.5, L.zoom);
    const gap = r * 2.6;
    const row = y + L.fh - r - 3;
    let dotX = x + w / 2 - ((occupants.length - 1) * gap) / 2;
    for (const actor of occupants) {
      ctx.fillStyle = actorStressColor(actor);
      ctx.beginPath();
      ctx.arc(dotX, row, r, 0, Math.PI * 2);
      ctx.fill();
      // A person in transit is hollow, so "six dots" never reads as "six people
      // sitting in the office" when half of them are on a lift.
      if (isInTransit(actor.state)) {
        ctx.fillStyle = 'rgba(11,15,20,0.85)';
        ctx.beginPath();
        ctx.arc(dotX, row, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      dotX += gap;
    }
  }

  // ---------------------------------------------------------- the ghost

  /**
   * What the next click would do, drawn where it would land.
   *
   * Set by `ui/main.js` from `preview()`, never computed here — the renderer
   * does not decide whether a build is legal, it draws somebody else's answer.
   * `null` clears it.
   *
   * @param preview `{ ok, reason, cost, footprint, note }` or null
   */
  function setGhost(preview) { ghost = preview ?? null; }
  let ghost = null;

  /**
   * The ghost: a footprint, a price, and — when it will not land — the reason,
   * in the sim's own words.
   *
   * Green for yes and red for no is the whole interface here, so the two must
   * not be the only difference: a refused ghost also carries its sentence, and
   * a permitted one carries its price. Colour alone is a poor signal and an
   * unreadable one for the eight percent of players who cannot separate those
   * two hues.
   */
  function drawGhost(L) {
    if (!ghost?.footprint) return;
    const ink = ghost.ok ? GOOD : BAD;
    const box = ghostBox(L, ghost.footprint);
    if (!box) return;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = ghost.ok ? 'rgba(6,214,160,0.18)' : 'rgba(239,71,111,0.20)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.setLineDash(ghost.ok ? [] : [5, 4]);
    ctx.strokeRect(Math.round(box.x) + 1, Math.round(box.y) + 1, box.w - 2, box.h - 2);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // The label sits ABOVE the footprint where there is room and inside it
    // where there is not, so a ghost on the top floor does not write into the
    // sky and a ghost at the bottom does not write into the earth.
    // A price when there is one, a note when there is not, both when both.
    // "free" alone is a poor label for a rent change, and a rent change with a
    // price is a lie — the tier is the thing that moved, not the balance.
    const text = ghost.ok
      ? [ghost.cost ? '$' + ghost.cost.toLocaleString('en-US') : null, ghost.note].filter(Boolean).join(' · ') || 'free'
      : ghost.reason;
    if (text) {
      ctx.font = '700 10px ui-monospace, monospace';
      const w = ctx.measureText(text).width + 10;
      const above = box.y - 15 > 0;
      const lx = Math.max(2, Math.min(W - w - 2, box.x + box.w / 2 - w / 2));
      const ly = above ? box.y - 15 : Math.min(H - 15, box.y + 2);
      ctx.fillStyle = 'rgba(11,15,20,0.9)';
      roundRect(ctx, lx, ly, w, 13, 3);
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.fillText(text, lx + 5, ly + 10);
    }
    ctx.restore();
  }

  /** Screen rectangle for a footprint, or null when it is off the world. */
  function ghostBox(L, f) {
    if (f.kind === 'room') {
      return {
        x: L.tileX(f.left), y: L.floorY(f.floor),
        w: (f.right - f.left + 1) * L.tw, h: L.fh - 2,
      };
    }
    if (f.kind === 'shaft') {
      const top = L.floorY(f.top);
      return { x: L.tileX(f.column), y: top, w: f.width * L.tw, h: L.floorY(f.bottom) + L.fh - top };
    }
    if (f.kind === 'carrier' && f.carrier) {
      const top = L.floorY(f.carrier.topFloor);
      return {
        x: L.tileX(f.carrier.column), y: top,
        w: f.carrier.shaftWidth * L.tw, h: L.floorY(f.carrier.bottomFloor) + L.fh - top,
      };
    }
    return null;
  }

  // --------------------------------------------------- the rent moment

  /** Open a moment for every unit that changed hands this frame. */
  function noteLetChanges(tower) {
    for (const { object, direction } of diffLetStatus(letSeen, tower)) {
      // The shaft light runs up whichever lift this unit's own people were last
      // watched riding. No sighting, no light — see `lastCarrierOf`.
      let carrierId = null;
      for (const id of object.occupants) {
        const seen = lastCarrierOf.get(id);
        if (seen != null) { carrierId = seen; break; }
      }
      if (letMoments.size >= LET_MOMENT.maxConcurrent) {
        // Drop the oldest rather than refusing the newest: the moment a player
        // is most likely to be looking for is the one that just happened.
        let oldest = null;
        for (const [id, m] of letMoments) if (!oldest || m.at < oldest[1].at) oldest = [id, m];
        if (oldest) letMoments.delete(oldest[0]);
      }
      letMoments.set(object.id, { object, direction, at: sprites.elapsedMs, carrierId });
    }
  }

  /**
   * Draw every moment in flight: a flash, a ring, a light up the shaft, and the
   * word. Anything whose unit has been demolished, or whose timeline has run
   * out, is dropped here rather than accumulating.
   */
  function drawLetMoments(L, tower) {
    if (!letMoments.size) return;
    for (const [id, moment] of letMoments) {
      const phase = letMomentPhase(sprites.elapsedMs - moment.at);
      if (!phase || !tower.objects.has(id)) { letMoments.delete(id); continue; }
      const style = LET_MOMENT_STYLE[moment.direction];
      const o = moment.object;
      const x = L.tileX(o.left);
      const y = L.floorY(o.floor);
      const w = (o.right - o.left + 1) * L.tw;
      const cx = x + w / 2;
      const cy = y + L.fh / 2;

      // The shaft light first, so it runs UNDER the room it is arriving at.
      if (style.shaft && phase.shaft !== null && moment.carrierId != null) {
        drawArrivalLight(L, tower, moment.carrierId, o.floor, phase.shaft);
      }

      const onScreen = x + w > 0 && x < W && y + L.fh > 0 && y < H;
      if (!onScreen) continue;   // the minimap pip is this moment's whole story

      if (phase.flash > 0) {
        ctx.fillStyle = `rgba(${style.flash},${(phase.flash * 0.85).toFixed(3)})`;
        ctx.fillRect(x, y, w, L.fh - 2);
      }

      if (style.ring && phase.ring !== null) {
        const t = easeOutCubic(phase.ring);
        ctx.globalAlpha = (1 - phase.ring) * 0.9;
        ctx.strokeStyle = style.ink;
        ctx.lineWidth = Math.max(1.5, 2 * L.zoom);
        ctx.beginPath();
        ctx.arc(cx, cy, (w * 0.35) + t * w * 1.1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (phase.stamp) {
        const size = Math.max(9, Math.round(9 * L.zoom));
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(phase.stamp.scale, phase.stamp.scale);
        ctx.globalAlpha = phase.stamp.alpha;
        ctx.font = '700 ' + size + 'px ui-monospace, monospace';
        ctx.textAlign = 'center';
        const half = ctx.measureText(style.word).width / 2 + size * 0.5;
        // A plate under the word, because the word sits on top of furnished
        // art and unreadable good news is not good news.
        ctx.fillStyle = 'rgba(11,15,20,0.82)';
        roundRect(ctx, -half, -size * 0.85, half * 2, size * 1.7, size * 0.3);
        ctx.fill();
        ctx.strokeStyle = style.ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = style.ink;
        ctx.fillText(style.word, 0, size * 0.36);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  }

  /**
   * A light travelling up (or down) a shaft, from the ground lobby to the floor
   * that just rented — the journey that caused it, redrawn.
   *
   * This is the causal half of the moment. Without it the room simply lights
   * up, which says "an office rented" and not "an office rented *because
   * somebody could get there*", and the second sentence is the entire thesis.
   */
  function drawArrivalLight(L, tower, carrierId, toFloor, progress) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return;
    const x = L.tileX(carrier.column);
    const width = carrier.shaftWidth * L.tw;
    if (x + width < 0 || x > W) return;
    const from = Math.max(carrier.bottomFloor, Math.min(carrier.topFloor, GROUND_FLOOR));
    const startY = L.floorY(from) + L.fh / 2;
    const endY = L.floorY(toFloor) + L.fh / 2;
    const headY = startY + (endY - startY) * progress;
    const tail = Math.max(L.fh, Math.abs(endY - startY) * 0.35);
    const towards = endY < startY ? -1 : 1;

    const gradient = ctx.createLinearGradient(0, headY - towards * tail, 0, headY);
    gradient.addColorStop(0, 'rgba(6,214,160,0)');
    gradient.addColorStop(1, 'rgba(6,214,160,0.75)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, Math.min(headY, headY - towards * tail), width, tail);
  }

  /** Scaffold and dust over anything placed in the last half second. */
  function drawConstruction(L) {
    if (!landing.size) return;
    const anim = sprites.animation('slot-construction', 'building');
    if (!anim) { landing.clear(); return; }   // no sheet, nothing to play
    const windowMs = (anim.frames * 1000) / anim.fps;
    const cellW = ART_CELL_TILES * L.tw;
    for (const [id, placed] of landing) {
      const age = sprites.elapsedMs - placed.at;
      if (!(age >= 0) || age >= windowMs) { landing.delete(id); continue; }
      const frame = Math.min(anim.frames - 1, Math.floor((age * anim.fps) / 1000));
      const o = placed.object;
      const y = L.floorY(o.floor);
      if (y + L.fh < 0 || y > H) continue;
      for (let t = o.left; t <= o.right; t += ART_CELL_TILES) {
        const x = L.tileX(t);
        if (x + cellW < 0 || x > W) continue;
        sprites.drawSprite(ctx, { name: 'slot-construction', animation: 'building', x, y, scale: L.zoom, frame });
      }
    }
  }

  // ------------------------------------------------------------ the transport

  /** The shaft itself: a column of art from the carrier's bottom to its top. */
  function drawShaft(L, carrier, visible) {
    const x = L.tileX(carrier.column);
    const w = carrier.shaftWidth * L.tw;
    if (x + w < 0 || x > W) return;
    const low = Math.max(carrier.bottomFloor, visible.low);
    const high = Math.min(carrier.topFloor, visible.high);
    const cellW = ART_CELL_TILES * L.tw;
    for (let f = low; f <= high; f++) {
      const y = L.floorY(f);
      ctx.fillStyle = carrier.mode === CARRIER_MODE.EXPRESS ? '#241b33' : '#12181f';
      ctx.fillRect(x, y, w, L.fh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, L.fh);
      ctx.clip();
      // The delivered column is one 6-tile art cell, and `SHAFT_WIDTH` makes a
      // standard shaft 4 tiles. Centre it and clip, the way the car is: drawn
      // from the left edge you get two thirds of the art and the guide rails
      // sit off to one side, which reads as a misaligned sprite rather than a
      // narrow shaft.
      const artW = ART_CELL_TILES * L.tw;
      sprites.drawSprite(ctx, { name: 'shaft-column', animation: 'tile', x: x + (w - artW) / 2, y, scale: L.zoom });
      ctx.restore();
      // The queue depth at this stop, in the shaft, where the wait is.
      const depth = carrierQueueDepth(carrier, f);
      if (depth > 0 && L.fh >= 16) {
        const p = queuePressure(depth);
        ctx.fillStyle = indicatorColor(p.colorKey);
        ctx.fillRect(x, y + 2, Math.max(2, L.zoom), L.fh - 6);
        ctx.textAlign = 'left';
        ctx.font = '700 8px ui-monospace, monospace';
        ctx.fillText(String(p.count), x + w + 3, y + L.fh * 0.62);
      }
    }
  }

  /**
   * The cars. Position is eased toward `car.currentFloor` on the RENDER clock —
   * see the note on `smooth` for why `prevFloor` is not used.
   */
  function drawCars(L, carrier, dtMs) {
    const x = L.tileX(carrier.column);
    const w = carrier.shaftWidth * L.tw;
    if (x + w < 0 || x > W) return;
    const sheet = carrier.mode === CARRIER_MODE.EXPRESS ? 'elevator-car-express' : 'elevator-car';
    // Ease so a 12 tick/s step reads as travel; fast enough that the car is
    // never more than a fraction of a floor behind where the sim says it is.
    const k = Math.min(1, (Math.max(0, dtMs) / 1000) * 12);
    for (let i = 0; i < carrier.cars.length; i++) {
      const car = carrier.cars[i];
      if (!car.active) continue;
      const key = carrier.id + ':' + i;
      const previous = smooth.get(key);
      const shown = previous == null ? car.currentFloor : previous + (car.currentFloor - previous) * k;
      smooth.set(key, shown);

      const y = L.floorY(shown);
      if (y + L.fh < 0 || y > H) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y - L.fh, w, L.fh * 3);
      ctx.clip();
      // The car art is 40 px against a 32 px standard shaft, so it is centred
      // and clipped rather than scaled — integer zoom only, and a 0.8x car
      // would shear.
      const artW = 40 * L.zoom;
      const drew = sprites.drawSprite(ctx, {
        name: sheet, animation: car.dwell > 0 ? 'open' : 'closed',
        x: x + (w - artW) / 2, y: y + (L.fh - 26 * L.zoom) / 2, scale: L.zoom,
      });
      if (!drew) {
        ctx.fillStyle = car.dwell > 0 ? WARN : '#dbe4ee';
        ctx.fillRect(x + 1, y + 2, w - 2, L.fh - 6);
      }
      ctx.restore();
    }
  }

  /**
   * The people waiting. **The single most important thing on this screen**: if
   * the player cannot see the line growing, the bottleneck is invisible — the
   * predecessor's headless sweep proved a tower can fail 97% of its trips while
   * every number on the HUD looks calm.
   *
   * Each figure is coloured by its own stress band, so the crowd carries the
   * same signal the room's dots do, in a second channel.
   */
  function drawWaiting(L, tower, visible, objectsOnFloor) {
    const byFloor = waitingActorsByFloor(tower);
    for (const [floor, actors] of byFloor) {
      if (floor < visible.low || floor > visible.high) continue;
      const y = L.floorY(floor);
      const feet = y + L.fh - 2;
      // The queue cannot spill past the end of the storey it is standing on.
      // Unbounded, a floor with thirty people waiting drew a ribbon of figures
      // out through the wall and into the sky — which reads as a rendering bug
      // and, worse, buries the one signal it was drawn to carry.
      const span = builtSpan(objectsOnFloor.get(floor));
      const rightEdge = span ? L.tileX(span.right + 1) : W;

      // Stand them beside the shaft they are queued on, which is where the
      // wait physically is. A rider with no carrier leg waits at their unit.
      const groups = new Map();
      for (const actor of actors) {
        const carrierId = actor.route?.carrierId ?? null;
        // Remember who rode what. This is the only place a rider and a carrier
        // are seen together, and the rent moment's shaft light depends on it
        // having been an observation rather than a guess.
        if (carrierId != null) lastCarrierOf.set(actor.id, carrierId);
        const list = groups.get(carrierId);
        if (list) list.push(actor); else groups.set(carrierId, [actor]);
      }
      for (const [carrierId, group] of groups) {
        const carrier = carrierId == null ? null : tower.carriers.find((c) => c.id === carrierId);
        const anchorTile = carrier ? carrier.column + carrier.shaftWidth : anchorTileOf(tower, group[0]);
        // Wide enough that a queue reads as *people*. Packed tighter (7 px
        // against a 16 px figure) they merged into a solid yellow ribbon —
        // legible as "a lot of something", useless as "eleven workers, two of
        // them fed up", which is the whole reason the crowd is drawn at all.
        const stride = Math.max(6, 12 * L.zoom);
        const figureW = 16 * L.zoom;
        let px = L.tileX(anchorTile) + 2;
        let drawn = 0;
        // `QUEUE_CRITICAL` twice over is the cap, so the row length is tied to
        // the same scale the pressure colours use rather than to the zoom.
        const cap = QUEUE_CRITICAL * 2;
        for (const actor of group) {
          if (drawn >= cap || px + figureW > rightEdge || px > W) break;
          if (px + figureW > 0) drawWaitingFigure(L, actor, px, feet);
          px += stride;
          drawn++;
        }
        const hidden = group.length - drawn;
        if (hidden > 0 && L.fh >= 16) {
          // Never silently truncate a queue: a crowd that stops at the wall
          // would make a failing floor look calmer than a coping one.
          ctx.fillStyle = indicatorColor(queuePressure(group.length).colorKey);
          ctx.textAlign = 'left';
          ctx.font = '700 9px ui-monospace, monospace';
          ctx.fillText('+' + hidden, Math.min(px + 2, rightEdge - 18), feet - 3);
        }
      }
    }
  }

  const anchorTileOf = (tower, actor) => tower.objects.get(actor.objectId)?.left ?? 0;

  function drawWaitingFigure(L, actor, x, feetY) {
    const score = actorStress(actor);
    const band = stressBand(score);
    const h = 16 * L.zoom;
    if (crowdBudget > 0) {
      crowdBudget--;
      // Posture carries the same signal as the colour: a person near the red
      // band is visibly fed up. Two poses alternated off a stable per-actor
      // phase, since the delivered sheets have one frame per pose.
      const beat = Math.floor((sprites.elapsedMs + idPhase(actor.id)) / 700) % 2 === 1;
      const pose = band === 'red' ? (beat ? 'wait-annoyed' : 'wait')
        : band === 'pink' ? (beat ? 'fidget' : 'wait')
          : (beat ? 'fidget' : 'stand');
      const sheet = actor.family === FAMILY.condo ? 'person-resident' : 'person-worker';
      if (sprites.drawSprite(ctx, { name: sheet, animation: pose, x, y: feetY - h, scale: L.zoom })) {
        // A stress pip under the feet, because the figure's own colours belong
        // to the art and must not be tinted away.
        ctx.fillStyle = STRESS_COLORS[band];
        ctx.fillRect(x + 2 * L.zoom, feetY - 1, Math.max(2, 12 * L.zoom - 4), Math.max(1, L.zoom));
        return;
      }
    }
    ctx.fillStyle = STRESS_COLORS[band];
    ctx.fillRect(x, feetY - Math.max(3, h * 0.5), Math.max(2, 3 * L.zoom), Math.max(3, h * 0.5));
  }

  // --------------------------------------------------------------- the sky

  function paintSky(tod) {
    const k = daylight(tod);
    const [top, low] = skyColors(tod);
    const g = ctx.createLinearGradient(0, -60, 0, H);
    g.addColorStop(0, 'rgb(' + top.join(',') + ')');
    g.addColorStop(0.72, 'rgb(' + low.join(',') + ')');
    g.addColorStop(1, BG);
    ctx.fillStyle = g;
    ctx.fillRect(-60, -60, W + 120, H + 120);

    if (k < 0.4) {
      const starAlpha = ((0.4 - k) / 0.4) * 0.8;
      ctx.fillStyle = 'rgba(219,228,238,' + starAlpha.toFixed(2) + ')';
      for (const [fx, sy] of STARS) {
        ctx.beginPath();
        ctx.arc(fx * W, sy, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const isDay = k > 0.5;
    ctx.globalAlpha = isDay ? 0.92 : 0.8;
    ctx.fillStyle = isDay ? '#ffd76a' : '#cfd8e8';
    ctx.beginPath();
    ctx.arc(40 + tod * (W - 80), 26 + (1 - k) * 40, isDay ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    drawClouds(k);
    drawFlyers(k);
  }

  /** Clouds sit at a depth and answer the camera by it, which is what gives the
   *  sky behind a 100-floor tower any sense of distance. They scale with the
   *  zoom like everything else: sky is at effectively infinite distance, so a
   *  zoom magnifies it without moving it, the way a telescope does. */
  function drawClouds(k) {
    const zoom = camera.zoom;
    for (const cloud of sky.clouds) {
      const span = W + cloud.w * 2;
      const raw = cloud.x + skyDrift * cloud.speed - camera.x * cloud.depth * 0.35;
      const x = ((raw % span) + span) % span - cloud.w;
      if (x < -cloud.w * 2 * zoom || x > W + cloud.w * zoom) continue;
      const y = cloud.y * (0.6 + cloud.depth * 0.6);
      const scale = cloudScale(cloud.depth, zoom);
      ctx.globalAlpha = (0.25 + cloud.depth * 0.45) * (0.4 + k * 0.6);
      if (!sprites.drawSprite(ctx, { name: 'sky-cloud', animation: cloud.variant, x, y, scale: Math.max(1, Math.round(scale)) })) {
        const lit = 0.35 + k * 0.5;
        ctx.fillStyle = 'rgb(' + [190 * lit + 40, 200 * lit + 40, 215 * lit + 40].map(Math.round).join(',') + ')';
        const w = cloud.w * scale, h = w * 0.34;
        roundRect(ctx, x, y, w, h, h / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawFlyers(k) {
    const zoom = flyerScale(camera.zoom);
    for (const f of sky.flyers) {
      for (let i = 0; i < f.count; i++) {
        const o = f.offsets[i] ?? { dx: 0, dy: 0 };
        const x = f.x - f.dir * o.dx * zoom;
        const y = f.y + (o.dy + Math.sin(f.bob + i) * 3) * zoom;
        if (x < -120 * zoom || x > W + 120 * zoom) continue;
        ctx.save();
        ctx.translate(x, y);
        if (f.dir < 0) ctx.scale(-1, 1);
        if (!sprites.drawSprite(ctx, { name: f.kind.sprite, animation: f.kind.animation, x: 0, y: 0, scale: zoom, phaseMs: i * 120 })) {
          ctx.fillStyle = k > 0.4 ? 'rgba(24,32,44,0.85)' : 'rgba(190,205,225,0.8)';
          ctx.fillRect(-4 * zoom, -1 * zoom, 8 * zoom, 2 * zoom);
        }
        ctx.restore();
      }
    }
  }

  // ------------------------------------------------------------ the minimap

  /**
   * One row per floor, coloured by what stands on it, with a pressure gutter
   * and a box marking what the main view is looking at.
   *
   * The gutter is the whole point of the strip: a queue building on F41 has to
   * be visible while you are looking at F3.
   */
  function drawMinimap(L, tower) {
    if (!W || !H) return;
    const m = minimapMetrics(viewport(), MIN_FLOOR, MAX_FLOOR, TILES_PER_FLOOR);
    ctx.fillStyle = 'rgba(10,13,18,0.86)';
    roundRect(ctx, m.x - m.pad, m.y - m.pad, m.w + m.pad * 2, m.h + m.pad * 2, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(142,202,230,0.32)';
    ctx.lineWidth = 1;
    ctx.stroke();

    for (let f = m.lowest; f <= m.highest; f++) {
      ctx.fillStyle = isBasement(f) ? 'rgba(59,45,33,0.7)' : 'rgba(27,36,48,0.7)';
      ctx.fillRect(m.x + m.gutter, minimapRowY(m, f), m.gridW, m.rowH);
    }
    const span = (o) => {
      const x = minimapTileX(m, o.left);
      return [x, Math.max(1, minimapTileX(m, o.right + 1) - x)];
    };
    for (const o of tower.objects.values()) {
      const [x, w] = span(o);
      ctx.fillStyle = o.family === FAMILY.lobby ? '#5aa9e6'
        : officeIsLet(o) ? KIND_COLOR[o.family] ?? INFO : 'rgba(140,150,165,0.55)';
      ctx.fillRect(x, minimapRowY(m, o.floor), w, m.rowH);
    }
    for (const carrier of tower.carriers) {
      const x = minimapTileX(m, carrier.column);
      const w = Math.max(1, minimapTileX(m, carrier.column + carrier.shaftWidth) - x);
      ctx.fillStyle = carrier.mode === CARRIER_MODE.EXPRESS ? '#c77dff' : '#5aa9e6';
      for (let f = carrier.bottomFloor; f <= carrier.topFloor; f++) {
        ctx.fillRect(x, minimapRowY(m, f), w, m.rowH);
      }
    }

    for (let f = m.lowest; f <= m.highest; f++) {
      const p = queuePressure(queueDepthAt(tower, f));
      if (p.count === 0) continue;
      ctx.globalAlpha = 0.35 + p.ratio * 0.65;
      ctx.fillStyle = indicatorColor(p.colorKey);
      ctx.fillRect(m.x, minimapRowY(m, f), m.gutter - 1, m.rowH);
      ctx.globalAlpha = 1;
    }

    // A unit that just changed hands, marked on the strip.
    //
    // This is the half of the moment that matters most: a tower is a hundred
    // floors and a window shows twenty, so the office that rents while you are
    // looking somewhere else would otherwise announce itself to nobody. The
    // whole row lights, because a two-pixel pip on a six-pixel row is not an
    // announcement.
    for (const moment of letMoments.values()) {
      const phase = letMomentPhase(sprites.elapsedMs - moment.at);
      if (!phase) continue;
      const style = LET_MOMENT_STYLE[moment.direction];
      ctx.globalAlpha = 0.35 + (phase.stamp?.alpha ?? 0) * 0.65;
      ctx.fillStyle = style.ink;
      ctx.fillRect(m.x, minimapRowY(m, moment.object.floor), m.w, Math.max(2, m.rowH));
      ctx.globalAlpha = 1;
    }

    const rect = visibleWorldRect(camera, viewport());
    const high = Math.min(m.highest, Math.max(m.lowest, floorAtWorldY(rect.top)));
    const low = Math.min(high, Math.max(m.lowest, floorAtWorldY(rect.bottom)));
    const clampTile = (worldX) => Math.min(m.tiles, Math.max(0, worldX / TILE_W));
    const boxX = minimapTileX(m, clampTile(rect.left));
    const boxRight = minimapTileX(m, clampTile(rect.right));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(boxX) + 0.5, Math.round(minimapRowY(m, high)) + 0.5,
      Math.max(2, Math.round(boxRight - boxX) - 1),
      Math.max(2, Math.round(minimapRowY(m, low) + m.rowH - minimapRowY(m, high)) - 1),
    );

    ctx.fillStyle = 'rgba(142,202,230,0.7)';
    ctx.textAlign = 'right';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.fillText(camera.zoom + 'x', m.x + m.w, m.y - m.pad - 5);
  }

  // ------------------------------------------------------------------ picks
  // The UI drives these; it never reads or writes the camera itself, which is
  // what keeps every pick going through the one inverse transform.

  function floorAt(px, py) {
    const [, worldY] = screenToWorld(camera, viewport(), px, py);
    const floor = floorAtWorldY(worldY);
    return floorExists(floor) ? floor : null;     // never `< 0`: −1 is B1
  }

  function tileAt(px) {
    const [worldX] = screenToWorld(camera, viewport(), px, 0);
    const tile = tileAtWorldX(worldX);
    return tile >= 0 && tile < TILES_PER_FLOOR ? tile : null;
  }

  function objectAt(tower, px, py) {
    const floor = floorAt(px, py);
    const tile = tileAt(px);
    if (floor === null || tile === null) return null;
    for (const o of tower.objects.values()) {
      if (o.floor === floor && tile >= o.left && tile <= o.right) return o;
    }
    return null;
  }

  function dragBy(dx, dy) {
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    clampCamera();
  }

  function setZoom(nextZoom, anchorX = W / 2, anchorY = H / 2) {
    const next = clampZoom(nextZoom);
    if (next !== camera.zoom) {
      const moved = cameraZoomedAt(camera, viewport(), next, anchorX, anchorY);
      camera.x = moved.x;
      camera.y = moved.y;
      camera.zoom = moved.zoom;
      clampCamera();
    }
    return camera.zoom;
  }

  const zoomBy = (steps, anchorX, anchorY) => setZoom(camera.zoom + steps, anchorX, anchorY);

  function goTo(floor, tile = TILES_PER_FLOOR / 2) {
    const wanted = Math.round(floor) || 0;
    centerOn(Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, wanted)), tile);
  }

  const minimapAt = (px, py) => {
    const m = minimapMetrics(viewport(), MIN_FLOOR, MAX_FLOOR, TILES_PER_FLOOR);
    return minimapContains(m, px, py) ? { floor: minimapFloorAt(m, py), tile: minimapTileAt(m, px) } : null;
  };

  /** Click or drag the strip to jump. False when the point was not on it. */
  function minimapJump(px, py) {
    const hit = minimapAt(px, py);
    if (!hit) return false;
    centerOn(hit.floor, hit.tile);
    return true;
  }

  /** The shaft under a point, for the add-car tool. */
  function carrierAt(tower, px, py) {
    const floor = floorAt(px, py);
    const tile = tileAt(px);
    if (floor === null || tile === null) return null;
    for (const c of tower.carriers) {
      if (floor < c.bottomFloor || floor > c.topFloor) continue;
      if (tile >= c.column && tile < c.column + c.shaftWidth) return c;
    }
    return null;
  }

  /**
   * The shaft standing in this COLUMN, whatever floor the pointer is on.
   *
   * Extending a lift means pointing at the sky above it, where by definition
   * there is no lift yet — so the floor-bounded pick above cannot answer, and
   * the tool would be unusable at exactly the place it is used.
   */
  function carrierColumnAt(tower, px) {
    const tile = tileAt(px);
    if (tile === null) return null;
    for (const c of tower.carriers) {
      if (tile >= c.column && tile < c.column + c.shaftWidth) return c;
    }
    return null;
  }

  return {
    draw, resize, layout, setGhost,
    floorAt, tileAt, objectAt, carrierAt, carrierColumnAt,
    dragBy, setZoom, zoomBy, goTo, frameLobby, minimapAt, minimapJump,
    /** The sky, so a check can put something in the air on demand rather than
     *  waiting out a rate meant to make surprises rare. */
    sky,
    /** The sheet book, so a test can wait for the real art to load and then
     *  assert that a frame actually asked for it. */
    art: sprites,
    get size() { return [W, H]; },
    get camera() { return { ...camera }; },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
