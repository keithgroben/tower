/**
 * The shell, end to end and headless: seed a tower, run the composition in
 * `ui/tick.js` for a full day, draw it.
 *
 * The point is that the browser is not the only thing that can say "it boots".
 * A broken seed, a carrier span the model refuses, a checkpoint that throws —
 * all of those are a blank page and a console nobody has open, and all of them
 * are catchable here in a second.
 */
import { TICKS_PER_DAY } from '../src/games/tower/sim/clock.js';
import { CARRIER_MODE, MAX_CARS_PER_CARRIER } from '../src/games/tower/sim/elevators.js';
import {
  FAMILY, GROUND_FLOOR, MAX_FLOOR, MIN_FLOOR, OCCUPANTS, STATE_UNPLACED_OCCUPANT,
  TILES_PER_FLOOR, floorExists, population,
} from '../src/games/tower/sim/state.js';
import { officeIsLet, makeRenderer } from '../src/games/tower/render/canvas.js';
import { LAYOUT, seedDemoTower } from '../src/games/tower/ui/seed.js';
import { makeTowerScheduler } from '../src/games/tower/ui/tick.js';
import { diskSpriteLoaders, stubCanvas } from './_headless.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const objects = (tower) => [...tower.objects.values()];

export const tests = {
  'the seed builds a tower somebody could plausibly have built'() {
    const tower = seedDemoTower();
    const offices = objects(tower).filter((o) => o.family === FAMILY.office);
    const lobbies = objects(tower).filter((o) => o.family === FAMILY.lobby);

    assert(lobbies.length === 1, 'one ground lobby, got ' + lobbies.length);
    assert(lobbies[0].floor === GROUND_FLOOR, 'and it is on the ground floor');
    assert(offices.length === LAYOUT.officeFloors.length * LAYOUT.officeTiles.length,
      'every office in the layout was placed, got ' + offices.length);
    assert(tower.actors.length === offices.length * OCCUPANTS[FAMILY.office],
      'six workers an office, from placement — got ' + tower.actors.length);
    assert(tower.actors.every((a) => a.state === STATE_UNPLACED_OCCUPANT),
      'every worker starts parked in 0x20, waiting to be routed');
    assert(population(tower) === 0, 'and nobody LIVES here yet: population counts tenants');
  },

  'the seed digs, because a tower that never goes below zero hides a bug class'() {
    // `CLAUDE.md`'s sentinel section: `if (alight < 0)` matched a rider bound
    // for B1, and idle cars read "no target" as a floor and parked in the first
    // basement. Neither is reachable in a tower with nothing underground, which
    // is why the opening tower has some.
    const tower = seedDemoTower();
    const below = objects(tower).filter((o) => o.floor < GROUND_FLOOR);
    assert(below.length > 0, 'the opening tower has to have a basement in it');
    for (const o of below) assert(floorExists(o.floor), `${o.floor} is outside the world`);
    assert(tower.carriers[0].bottomFloor < GROUND_FLOOR, 'and the lift has to reach it');
  },

  'nothing in the seed overlaps the lift shaft or runs off the lot'() {
    const tower = seedDemoTower();
    const carrier = tower.carriers[0];
    const shaft = { left: carrier.column, right: carrier.column + carrier.shaftWidth - 1 };
    for (const o of objects(tower)) {
      assert(o.left >= 0 && o.right < TILES_PER_FLOOR, `object ${o.id} runs off the lot`);
      // The lobby is the exception: the lift lands INSIDE it, which is the
      // whole point of a lobby.
      if (o.family === FAMILY.lobby) continue;
      if (o.floor < carrier.bottomFloor || o.floor > carrier.topFloor) continue;
      assert(o.right < shaft.left || o.left > shaft.right,
        `object ${o.id} on floor ${o.floor} (${o.left}..${o.right}) sits in the shaft`);
    }
  },

  'the shaft is a legal carrier with cars in it'() {
    const tower = seedDemoTower();
    assert(tower.carriers.length === 1, 'one shaft to start with');
    const carrier = tower.carriers[0];
    assert(carrier.mode === CARRIER_MODE.STANDARD, 'a standard lift, not an express one');
    assert(carrier.cars.length === LAYOUT.cars && carrier.cars.length <= MAX_CARS_PER_CARRIER,
      'the cars asked for were all added, got ' + carrier.cars.length);
    assert(carrier.cars.every((c) => c.active && c.currentFloor === GROUND_FLOOR),
      'every car starts active, on the ground floor');
    assert(carrier.bottomFloor >= MIN_FLOOR && carrier.topFloor <= MAX_FLOOR,
      'the shaft stays inside the world');
  },

  'a full day of ticks runs, and the clock comes out where it went in'() {
    const tower = seedDemoTower();
    const scheduler = makeTowerScheduler(tower, {});
    const startTick = tower.clock.dayTick;
    const startDay = tower.clock.dayCounter;

    scheduler.advance(tower, TICKS_PER_DAY);

    assert(tower.clock.dayTick === startTick, 'a whole day returns the tick to where it started');
    assert(tower.clock.dayCounter === startDay + 1, 'and moves the day counter exactly once');
    // The tick-0 checkpoint is the only thing wired, and it has to have fired.
    assert(tower.routeTables, 'the start-of-day checkpoint never rebuilt the route tables');
    assert(tower.routeTables.failureNotices.length === 120, 'one notice byte per floor');
  },

  '⚠️ with no family handler NOTHING moves, and that is the scheduler being right'() {
    // Not a complaint about the missing module — a statement about the seam.
    // `createScheduler` services an actor only when `families[actor.family]`
    // exists, so an empty map is a tower that ticks and does not live. When a
    // family module lands this test still passes; it is about the contract, not
    // about the hole.
    const tower = seedDemoTower();
    const scheduler = makeTowerScheduler(tower, {});
    const results = scheduler.advance(tower, 500);

    assert(results.every((r) => r.serviced === 0), 'no actor can be serviced without a handler');
    assert(tower.actors.every((a) => a.state === STATE_UNPLACED_OCCUPANT), 'so every worker is still parked');
    assert(objects(tower).every((o) => !officeIsLet(o)), 'and not one office has rented');
    assert(population(tower) === 0, 'population stays at zero');
    // The cars are the half that DOES run every tick — they just have nothing
    // to do, so they must sit still rather than wander.
    assert(tower.carriers[0].cars.every((c) => c.currentFloor === GROUND_FLOOR),
      'an idle car parks where it is, it does not drive off to a basement');
  },

  'a frame draws against the real sheets without throwing'() {
    const tower = seedDemoTower();
    const scheduler = makeTowerScheduler(tower, {});
    const renderer = makeRenderer(stubCanvas(1200, 760), { sprites: diskSpriteLoaders });
    renderer.resize();
    // Across a whole day, so every hour of the piecewise clock gets drawn —
    // including the overnight window at 2300-2599 that carries the NEXT day's
    // number under a night sky.
    for (let i = 0; i < TICKS_PER_DAY; i += 37) {
      scheduler.advance(tower, 37);
      renderer.draw(tower, 16);
    }
    assert(renderer.size[0] === 1200, 'the renderer measured its canvas');
  },

  'the camera can be driven to the roof and to the deepest basement'() {
    const tower = seedDemoTower();
    const renderer = makeRenderer(stubCanvas(1200, 760), { sprites: diskSpriteLoaders });
    renderer.resize();
    for (const floor of [MAX_FLOOR, MIN_FLOOR, GROUND_FLOOR, -1]) {
      renderer.goTo(floor);
      renderer.draw(tower, 16);
    }
    // A pick well below the ground line has to name a basement, not `null`.
    // `floorAt` returning null for a real floor would make every basement
    // unclickable, and the failure looks like an unresponsive UI.
    renderer.goTo(-5);
    const picked = renderer.floorAt(600, 380);
    assert(picked !== null && picked < GROUND_FLOOR,
      'the centre of a view aimed at B5 picked ' + picked);
  },
};
