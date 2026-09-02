/**
 * **Art that nothing draws.**
 *
 * `CLAUDE.md`: *"Art existed and nothing drew it, six times. A catalogued sheet
 * with no reached call site now fails a test. Preloading does not count."*
 *
 * Six times is not bad luck, it is the loader's design showing through. Every
 * entry point in `render/sprites.js` returns `null`/`false` instead of throwing
 * so that a sheet which has not arrived costs a rectangle rather than a frame —
 * which means a sheet that arrives and is never asked for looks *exactly* like
 * a sheet that is working. There is no symptom to notice.
 *
 * So this file drives real frames of the real renderer against the real sheets
 * on disk, wraps the sprite book, and records what actually got drawn. Three
 * things then have to hold:
 *
 *  1. every `(sheet, animation)` in `SPRITE_USES` was **reached**, not merely
 *     preloaded — a returned-true `drawSprite`;
 *  2. every delivered sheet is either used or named in `SPRITE_NOT_YET_DRAWN`
 *     with a reason;
 *  3. every animation inside a used sheet is either used or named in
 *     `SPRITE_UNUSED_ANIMATIONS` with a reason.
 *
 * (3) is the half that hides: a sheet drawing six of its seven frames looks
 * completely healthy from outside.
 *
 * Mutation-check it by renaming any animation in `SPRITE_USES`, deleting an
 * entry from it, or dropping a sheet's draw call — all three fail here.
 */
import path from 'node:path';
import { CARRIER_MODE, addCar, createCarrier } from '../src/games/tower/sim/elevators.js';
import { FAMILY, createTower, placeObject } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { FLYERS } from '../src/games/tower/render/sky.js';
import { SHEET_READY } from '../src/games/tower/render/sprites.js';
import {
  PRELOAD_SHEETS, SPRITE_NOT_YET_DRAWN, SPRITE_UNUSED_ANIMATIONS, SPRITE_USES,
  makeRenderer,
} from '../src/games/tower/render/canvas.js';
import { seedDemoTower } from '../src/games/tower/ui/seed.js';
import {
  SPRITE_DIR, deliveredSheets, diskSpriteLoaders, pngSize, sheetAnimations, stubCanvas,
} from './_headless.js';

/** Renting sets BOTH: the lease band and the measured flag. */
const letUnit = (o) => { o.occupiedFlag = true; o.unitStatus = 0; return o; };

const assert = (c, m) => { if (!c) throw new Error(m); };

/** A tower holding one of everything the renderer knows how to draw. */
function towerWithEverything() {
  const tower = seedDemoTower({ seed: 1 });
  const trips = () => createSimTripRecord();
  const objects = [...tower.objects.values()];

  const offices = objects.filter((o) => o.family === FAMILY.office);
  const retail = objects.filter((o) => o.family === FAMILY.retail);

  // Offices: the first stays For Rent and its workers are the ones queuing for
  // a lift (which is the honest picture — they are trying to reach a unit that
  // has not rented). The second is let and furious, the third let and calm.
  // Keeping the furious one separate from the calm one matters: a room takes
  // the WORST band among its occupants, so one red worker in the calm office
  // would silently hide `occupied-day` behind `stressed`.
  letUnit(offices[1]);
  letUnit(offices[2]);
  for (const actor of tower.actors) {
    if (actor.objectId !== offices[1].id) continue;
    actor.tripCount = 1;
    actor.accumulatedElapsed = 300;      // the clamp: red band
  }

  // Retail: three let, so `object.id % 3` covers all three shop fronts, and one
  // left vacant so the empty shell is drawn too.
  for (const shop of retail.slice(0, 3)) letUnit(shop);
  const residues = new Set(retail.slice(0, 3).map((s) => s.id % 3));
  assert(residues.size === 3, 'the let shops must cover all three storefronts, got ' + [...residues]);

  // Condos, arranged the same way: For Rent, let-and-furious, let-and-calm.
  const condos = [54, 60, 66].map((left) => placeObject(tower,
    { family: FAMILY.condo, floor: 7, left, right: left + 5 }, trips).object);
  letUnit(condos[1]);
  letUnit(condos[2]);
  for (const actor of tower.actors) {
    if (actor.objectId !== condos[1].id) continue;
    actor.tripCount = 1;
    actor.accumulatedElapsed = 300;
  }

  // An express shaft beside the standard one. Nothing places one in the game
  // yet, but the sheets are delivered and the carrier model supports it.
  const express = createCarrier({
    id: 1, mode: CARRIER_MODE.EXPRESS, bottomFloor: 0, topFloor: 29, column: 20, homeFloor: 0,
  });
  addCar(express, 0);
  addCar(express, 4);
  tower.carriers.push(express);

  // One car per shaft standing with its doors open, one with them shut.
  tower.carriers[0].cars[0].dwell = 3;
  tower.carriers[0].cars[1].dwell = 0;
  express.cars[0].dwell = 3;
  express.cars[1].dwell = 0;

  // People waiting, one per stress band per figure sheet. The stress colour and
  // the posture come from the same band, so covering the bands covers the poses.
  const workers = tower.actors.filter((a) => a.family === FAMILY.office).slice(0, 3);
  const residents = tower.actors.filter((a) => a.family === FAMILY.condo).slice(0, 3);
  const bands = [0, 100, 300];
  for (const group of [workers, residents]) {
    group.forEach((actor, i) => {
      actor.waitingFloor = tower.objects.get(actor.objectId).floor;
      actor.tripCount = 1;
      actor.accumulatedElapsed = bands[i];
    });
  }

  return tower;
}

/** Put one of each flyer in the air, and one cloud of each variant on screen. */
function stockTheSky(sky, viewW) {
  sky.flyers.length = 0;
  for (const kind of FLYERS) {
    sky.flyers.push({
      kind, dir: 1, count: 1, speed: 0,
      x: viewW / 2, y: 90, offsets: [{ dx: 0, dy: 0 }], bob: 0,
    });
  }
  ['small', 'medium', 'large'].forEach((variant, i) => {
    const cloud = sky.clouds[i];
    if (!cloud) return;
    cloud.variant = variant;
    // depth 0 and speed 0 make the drift formula collapse to `cloud.x`, so the
    // cloud sits where it is put instead of wherever the parallax lands it.
    cloud.depth = 0;
    cloud.speed = 0;
    cloud.x = cloud.w + viewW / 2;
  });
}

/** Every `(sheet, animation)` a real frame actually put on the context. */
async function recordDrawnSprites() {
  const canvas = stubCanvas(1200, 760);
  const renderer = makeRenderer(canvas, { sprites: diskSpriteLoaders });
  const tower = towerWithEverything();

  // The book loads lazily and a frame never waits on art, so a test that drew
  // immediately would record nothing and pass by drawing rectangles — which is
  // precisely the failure this file is about.
  await Promise.all(PRELOAD_SHEETS.map((name) => renderer.art.request(name)));

  const drawn = new Set();
  const book = renderer.art;
  const realDraw = book.drawSprite;
  book.drawSprite = (ctx, opts) => {
    const painted = realDraw(ctx, opts);
    // Only a draw that RETURNED TRUE counts. A call against a missing sheet is
    // the fallback path, and counting it would let this pass with no art at all.
    if (painted) drawn.add(opts.name + '/' + opts.animation);
    return painted;
  };

  renderer.resize();
  // The first frame is the one where `followCamera` frames the lobby for
  // itself, and it picks its own zoom. Spend it before choosing one, or the
  // camera silently overrides the choice and half the tower is off-screen —
  // which is how the express shaft went undrawn the first time this ran.
  tower.clock.dayTick = 200;      // mid-morning
  renderer.draw(tower, 0);
  renderer.setZoom(1);            // the whole 150-tile lot, so the street shows
  stockTheSky(renderer.sky, 1200);
  renderer.draw(tower, 0);

  // Seven 100 ms frames advance the animation clock by exactly 700 ms, which
  // flips the two-pose beat for EVERY waiting figure regardless of its phase
  // offset — `floor((t + p) / 700)` always gains exactly one. That is what
  // makes all four postures deterministic instead of hoped-for.
  for (let i = 0; i < 7; i++) {
    stockTheSky(renderer.sky, 1200);
    renderer.draw(tower, 100);
  }

  // Night, for every sheet with a lit-window variant.
  tower.clock.dayTick = 2450;
  stockTheSky(renderer.sky, 1200);
  renderer.draw(tower, 100);

  // A placement, so the scaffold-and-dust animation has something to play over.
  placeObject(tower, { family: FAMILY.office, floor: 8, left: 54, right: 59 },
    () => createSimTripRecord());
  tower.clock.dayTick = 300;
  stockTheSky(renderer.sky, 1200);
  renderer.draw(tower, 16);

  book.drawSprite = realDraw;
  return { drawn, renderer };
}

// Loading and driving twelve frames is not cheap; do it once and share it.
const recorded = await recordDrawnSprites();

export const tests = {
  'every delivered sheet has a PNG the sidecar actually fits'() {
    // The sidecar parser bounds each animation against the sheet's real size,
    // so an off-by-one column is caught here rather than silently sampling
    // transparent pixels — which is worse than a missing sheet, because a room
    // that vanishes looks deliberate.
    const sheets = deliveredSheets();
    assert(sheets.length > 20, 'expected the delivered art, found ' + sheets.length + ' sheets');
    for (const name of sheets) {
      const { width, height } = pngSize(path.join(SPRITE_DIR, name + '.png'));
      assert(width > 0 && height > 0, name + '.png has no pixels');
    }
  },

  'every sheet the renderer preloads is one it declares it uses'() {
    // The preload list is derived from SPRITE_USES rather than written beside
    // it. Written twice, the two drift — and the drift IS the bug: a sheet
    // preloaded and never drawn is exactly the shape that hid six times.
    assert(PRELOAD_SHEETS.length === Object.keys(SPRITE_USES).length, 'the lists are the same length');
    for (const name of PRELOAD_SHEETS) assert(SPRITE_USES[name], name + ' is preloaded but not declared');
  },

  'the sheets really loaded — this test would otherwise pass on rectangles'() {
    for (const name of PRELOAD_SHEETS) {
      assert(recorded.renderer.art.status(name) === SHEET_READY,
        `${name} is "${recorded.renderer.art.status(name)}", not ready — the run below proves nothing`);
    }
  },

  '⚠️ every declared sprite was REACHED by a real frame'() {
    const missed = [];
    for (const [name, animations] of Object.entries(SPRITE_USES)) {
      for (const animation of animations) {
        if (!recorded.drawn.has(name + '/' + animation)) missed.push(name + '/' + animation);
      }
    }
    assert(missed.length === 0,
      'declared but never drawn (art nobody sees, or a call site that went away):\n       '
      + missed.join('\n       '));
  },

  'every delivered sheet is either used or accounted for'() {
    const unclassified = deliveredSheets()
      .filter((name) => !SPRITE_USES[name] && !SPRITE_NOT_YET_DRAWN[name]);
    assert(unclassified.length === 0,
      'delivered art that nothing draws and nothing explains: ' + unclassified.join(', ')
      + '\n       Draw it, or add it to SPRITE_NOT_YET_DRAWN with the reason.');

    // And the ledger cannot rot the other way: an excuse for a sheet that is
    // now drawn, or for one that was never delivered, is a lie in a comment.
    for (const name of Object.keys(SPRITE_NOT_YET_DRAWN)) {
      assert(!SPRITE_USES[name], name + ' is drawn now — take it out of SPRITE_NOT_YET_DRAWN');
      assert(deliveredSheets().includes(name), name + ' is excused but was never delivered');
      assert(SPRITE_NOT_YET_DRAWN[name].length > 20, name + ' needs a real reason, not a shrug');
    }
  },

  'every animation inside a used sheet is either drawn or accounted for'() {
    // The half that hides. A sheet drawing six of its seven frames looks
    // completely healthy from outside.
    const orphans = [];
    for (const name of Object.keys(SPRITE_USES)) {
      const declared = new Set(SPRITE_USES[name]);
      const excused = SPRITE_UNUSED_ANIMATIONS[name] ?? {};
      for (const animation of sheetAnimations(name)) {
        if (declared.has(animation) || excused[animation]) continue;
        orphans.push(name + '/' + animation);
      }
    }
    assert(orphans.length === 0,
      'frames the artist delivered that nothing draws and nothing explains:\n       '
      + orphans.join('\n       '));

    for (const [name, excuses] of Object.entries(SPRITE_UNUSED_ANIMATIONS)) {
      const declared = new Set(SPRITE_USES[name] ?? []);
      const real = new Set(sheetAnimations(name));
      for (const [animation, reason] of Object.entries(excuses)) {
        assert(real.has(animation), `${name}/${animation} is excused but is not in the sidecar`);
        assert(!declared.has(animation), `${name}/${animation} is both drawn and excused`);
        assert(reason.length > 20, `${name}/${animation} needs a real reason`);
      }
    }
  },

  'the four things the loop is made of all reached the screen'() {
    // Not a duplicate of the sweep above: those check the catalogue is honest,
    // this checks the catalogue is about the right things. If these four ever
    // stop drawing, the game still runs and the loop becomes invisible — which
    // is the failure this whole build exists to prevent.
    const required = {
      'a let office': 'office/occupied-day',
      'a vacant office': 'room-empty/office',
      'a stressed office': 'office/stressed',
      'somebody waiting, fed up': 'person-worker/wait-annoyed',
      'somebody waiting, calm': 'person-worker/stand',
      'a lift car with its doors open': 'elevator-car/open',
      'a lift car under way': 'elevator-car/closed',
      'the shaft they ride in': 'shaft-column/tile',
    };
    for (const [what, key] of Object.entries(required)) {
      assert(recorded.drawn.has(key), `${what} (${key}) never reached the screen`);
    }
  },

  'a basement draws as an excavation, not as more tower'() {
    // The sentinel bug's visual half. `seedDemoTower` puts retail on B1 and B2 for
    // exactly this reason: a renderer that skipped floors below zero would draw
    // soil where the shops are, and nothing would error.
    for (const key of ['basement-empty/tile', 'earth-edge/tile', 'foundation-slab/tile']) {
      assert(recorded.drawn.has(key), key + ' never drew — is anything below ground being skipped?');
    }
  },
};
