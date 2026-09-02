/**
 * The camera and the minimap: pure coordinate maths, so it is testable and so
 * it is tested.
 *
 * The theme running through this file is the sentinel hazard from `CLAUDE.md`.
 * The predecessor's world bottomed out at the ground floor, so half its camera
 * helpers clamped a floor with `Math.min(0, …)` or validated one with `< 0`.
 * Here **−1 is B1**, a real floor somebody builds shops on, and that exact bug
 * has already shipped in this repo once. Several assertions below exist only to
 * make it impossible to reintroduce quietly.
 */
import { MAX_FLOOR, MIN_FLOOR, TILES_PER_FLOOR, floorExists } from '../src/games/tower/sim/state.js';
import {
  ART_CELL_TILES, FLOOR_H, MINIMAP, TILE_W, ZOOM_LEVELS,
  cameraZoomedAt, clampZoom, floorAtWorldY, floorBottomWorldY, floorTopWorldY,
  makeCamera, minimapContains, minimapFloorAt, minimapMetrics, minimapRowY,
  minimapTileAt, minimapTileX, screenToWorld, tileAtWorldX, tileLeftWorldX,
  visibleFloorRange, visibleWorldRect, worldToScreen,
} from '../src/games/tower/render/canvas.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const VIEW = { w: 1200, h: 760 };

export const tests = {
  // ------------------------------------------------------------- the grid

  'six tiles is one art cell, which is one office'() {
    // `specs/facility/OFFICE.md` line 289 gives an office a 6-tile span, and
    // every delivered sheet is 48 px wide. If these two ever disagree the art
    // stops lining up with the objects and nothing errors — the rooms just
    // drift. Pinned in both directions.
    assert(ART_CELL_TILES * TILE_W === 48, 'an art cell is 48 px: ' + ART_CELL_TILES * TILE_W);
    assert(FLOOR_H === 32, 'a floor is 32 px tall');
    assert(TILES_PER_FLOOR * TILE_W === 1200, 'the whole lot is 1200 px at 1x');
  },

  'zoom is integer only, and clamped to the levels the art survives'() {
    // Mixel art shears the instant it is scaled 1.5x, so a fractional zoom is
    // not a smaller version of the tower, it is a broken one.
    assert(clampZoom(1.5) === 2, 'a fractional zoom rounds');
    assert(clampZoom(0) === ZOOM_LEVELS[0], 'below the floor clamps up');
    assert(clampZoom(99) === ZOOM_LEVELS.at(-1), 'above the ceiling clamps down');
    assert(clampZoom('nonsense') === 1, 'garbage falls back to 1x, not NaN');
    assert(ZOOM_LEVELS.every(Number.isInteger), 'every level is a whole number');
  },

  // ------------------------------------------------ world <-> screen

  'the transform round-trips at every zoom'() {
    for (const zoom of ZOOM_LEVELS) {
      const camera = makeCamera(300, -700, zoom);
      for (const [wx, wy] of [[0, 0], [1199, -3488], [-40, 320]]) {
        const [sx, sy] = worldToScreen(camera, VIEW, wx, wy);
        const [rx, ry] = screenToWorld(camera, VIEW, sx, sy);
        assert(near(rx, wx, 1e-6) && near(ry, wy, 1e-6),
          `zoom ${zoom}: (${wx},${wy}) -> (${sx},${sy}) -> (${rx},${ry})`);
      }
    }
  },

  'the camera point sits at the CENTRE of the viewport'() {
    const camera = makeCamera(500, -200, 2);
    const [sx, sy] = worldToScreen(camera, VIEW, 500, -200);
    assert(near(sx, VIEW.w / 2) && near(sy, VIEW.h / 2), `centre landed at ${sx},${sy}`);
  },

  'y grows DOWN from the ground line, so a floor is above its own bottom'() {
    // The origin is the ground line, not the bottom of the world, so digging to
    // B10 does not move it under the player.
    assert(floorBottomWorldY(0) === 0, 'floor 0 sits on world y = 0');
    assert(floorTopWorldY(0) === -FLOOR_H, 'floor 0 reaches up to -32');
    assert(floorTopWorldY(5) < floorTopWorldY(4), 'higher floors are further up');
    assert(floorBottomWorldY(-1) === FLOOR_H, 'B1 hangs below the ground line');
  },

  'floorAtWorldY inverts the floor band, basements included'() {
    // The band is half-open as `(top, bottom]`: a floor OWNS the slab it stands
    // on and its ceiling belongs to the storey above. That orientation is not
    // arbitrary — it is what puts the ground line itself (world y = 0) on floor
    // 0 rather than on B1, so a click on the pavement picks the lobby.
    for (const floor of [MIN_FLOOR, -3, -1, 0, 1, 14, MAX_FLOOR]) {
      const top = floorTopWorldY(floor);
      const bottom = floorBottomWorldY(floor);
      assert(floorAtWorldY(bottom) === floor,
        `the slab under ${floor} reads back as ${floorAtWorldY(bottom)}`);
      assert(floorAtWorldY(top + 0.001) === floor, `just inside ${floor} reads back wrong`);
      assert(floorAtWorldY(top) === floor + 1, `the ceiling of ${floor} belongs to ${floor + 1}`);
    }
    assert(floorAtWorldY(0) === 0, 'the ground line is the lobby, not B1');
    assert(floorAtWorldY(1) === -1, 'one pixel below it is B1');
  },

  'tileAtWorldX inverts the tile, and the lot is 150 wide'() {
    assert(tileLeftWorldX(0) === 0, 'tile 0 starts at the origin');
    assert(tileAtWorldX(tileLeftWorldX(37) + 1) === 37, 'a point inside tile 37 is tile 37');
    assert(tileAtWorldX(tileLeftWorldX(TILES_PER_FLOOR) ) === TILES_PER_FLOOR,
      'one past the lot reads as one past the lot — clamping is the caller\'s job');
  },

  // --------------------------------------------------------- the sentinel

  'the visible range reaches the basements'() {
    // ⚠️ The bug this exists to prevent: the predecessor clamped its low end
    // with `Math.min(0, lowest)` because its world stopped at the ground floor.
    // Ported here, a camera looking at B4 would report an empty range and the
    // whole basement would simply not draw — no error, no warning, just soil.
    const camera = makeCamera(600, floorBottomWorldY(-5), 2);
    const range = visibleFloorRange(camera, VIEW);
    assert(range.low <= -5 && range.high >= -5,
      `looking at B5 gave the range ${range.low}..${range.high}`);
    assert(range.low >= MIN_FLOOR, 'the range never goes below the world: ' + range.low);
  },

  'the visible range is clamped to the world at both ends, and never by sign'() {
    // Way below the deepest basement.
    const low = visibleFloorRange(makeCamera(600, floorBottomWorldY(MIN_FLOOR) + 5000, 1), VIEW);
    assert(low.low === MIN_FLOOR, 'the bottom clamps to MIN_FLOOR, got ' + low.low);
    assert(floorExists(low.low), 'and MIN_FLOOR is a floor that exists');
    // Way above the roof.
    const high = visibleFloorRange(makeCamera(600, floorTopWorldY(MAX_FLOOR) - 5000, 1), VIEW);
    assert(high.high === MAX_FLOOR, 'the top clamps to MAX_FLOOR, got ' + high.high);
  },

  'the whole basement range is representable, all ten floors'() {
    // A guard written as `floor < 0` reads as a validity check and is not one.
    // Every basement floor has to be a floor the camera can name.
    for (let f = MIN_FLOOR; f < 0; f++) {
      assert(floorExists(f), `${f} must be a real floor`);
      assert(floorAtWorldY(floorBottomWorldY(f)) === f, `${f} does not round-trip`);
    }
  },

  // ------------------------------------------------------------ zoom anchor

  'zooming holds the world point under the cursor still'() {
    // What makes a wheel zoom land where the player was looking instead of
    // drifting. Checked at a corner, not the centre, because the centre is the
    // one point that stays put even when the maths is wrong.
    const camera = makeCamera(400, -300, 1);
    const anchor = [200, 120];
    const before = screenToWorld(camera, VIEW, ...anchor);
    const moved = cameraZoomedAt(camera, VIEW, 3, ...anchor);
    const after = screenToWorld(moved, VIEW, ...anchor);
    assert(near(before[0], after[0], 1e-6) && near(before[1], after[1], 1e-6),
      `the anchor drifted from ${before} to ${after}`);
    assert(moved.zoom === 3, 'the zoom actually changed');
  },

  'a zoom that clamps to the same level still leaves the camera alone'() {
    const camera = makeCamera(400, -300, 3);
    const moved = cameraZoomedAt(camera, VIEW, 9, 10, 10);
    assert(moved.zoom === 3, 'clamped to the ceiling');
  },

  'the visible rect widens as you zoom out'() {
    const wide = visibleWorldRect(makeCamera(0, 0, 1), VIEW);
    const tight = visibleWorldRect(makeCamera(0, 0, 3), VIEW);
    assert(wide.right - wide.left > tight.right - tight.left, 'zoom 1 sees more than zoom 3');
    assert(near(wide.right - wide.left, VIEW.w), 'at 1x one screen pixel is one world pixel');
  },

  // -------------------------------------------------------------- minimap

  'the strip covers every floor in the world, bottom row first'() {
    const m = minimapMetrics(VIEW);
    assert(m.rows === MAX_FLOOR - MIN_FLOOR + 1, 'all 120 floors get a row, got ' + m.rows);
    assert(minimapRowY(m, MIN_FLOOR) > minimapRowY(m, MAX_FLOOR),
      'the deepest basement is the BOTTOM row — the strip grows upward like the tower');
    assert(near(minimapRowY(m, MIN_FLOOR) + m.rowH, m.y + m.h), 'the bottom row ends at the bottom');
  },

  'a click on the strip round-trips to the floor it points at'() {
    const m = minimapMetrics(VIEW);
    for (const floor of [MIN_FLOOR, -1, 0, 1, 60, MAX_FLOOR]) {
      const y = minimapRowY(m, floor) + m.rowH / 2;
      assert(minimapFloorAt(m, y) === floor, `row for ${floor} picked ${minimapFloorAt(m, y)}`);
    }
  },

  'a click off either end of the strip clamps into the world'() {
    const m = minimapMetrics(VIEW);
    assert(minimapFloorAt(m, m.y + m.h + 999) === MIN_FLOOR, 'below the strip is the deepest floor');
    assert(minimapFloorAt(m, m.y - 999) === MAX_FLOOR, 'above the strip is the top floor');
  },

  'tiles map proportionally, so 150 of them fit a 40 px strip'() {
    // One integer cell per tile would be 150 px wide — wider than the strip
    // itself. The predecessor could afford per-cell columns at a dozen slots
    // and cannot here, so the mapping is a proportion and the inverse has to
    // agree with it.
    const m = minimapMetrics(VIEW);
    assert(m.w <= MINIMAP.width, 'the strip stays inside its declared width');
    assert(near(minimapTileX(m, 0), m.x + m.gutter), 'tile 0 is at the left of the grid');
    assert(near(minimapTileX(m, TILES_PER_FLOOR), m.x + m.gutter + m.gridW), 'the last tile ends at the right');
    for (const tile of [0, 1, 75, 149]) {
      const x = minimapTileX(m, tile) + m.gridW / TILES_PER_FLOOR / 2;
      assert(minimapTileAt(m, x) === tile, `tile ${tile} picked ${minimapTileAt(m, x)}`);
    }
  },

  'the strip knows what is on it and what is beside it'() {
    const m = minimapMetrics(VIEW);
    assert(minimapContains(m, m.x + 2, m.y + 2), 'a point on the strip is on the strip');
    assert(!minimapContains(m, m.x - 40, m.y + 2), 'a point well left of it is not');
    assert(!minimapContains(m, m.x + 2, m.y - 40), 'nor one well above it');
  },

  'the strip fits inside the viewport it was measured against'() {
    // A short window is the case that breaks a strip sized per-row: 120 rows at
    // one pixel each is 120 px, which must still fit a 300 px-tall browser.
    for (const view of [{ w: 400, h: 300 }, { w: 1920, h: 1080 }, { w: 320, h: 200 }]) {
      const m = minimapMetrics(view);
      assert(m.rowH >= MINIMAP.minRowH, 'a row never collapses to nothing');
      assert(m.y >= 0 && m.x >= 0, `the strip left the viewport at ${view.w}x${view.h}`);
    }
  },
};
