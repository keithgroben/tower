/**
 * Fixtures for the windows and map views (issue #18). Named `_windows.js` so the runner's
 * `*.test.js` glob skips it.
 *
 * Everything is built through `applyAction`, the same seam the player uses, except where a test
 * needs a condition no honest play reaches in one step (a worker's stress written directly, a hotel
 * room's band set) - those say so where they do it.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { __resetIds } from '../src/games/tower/sim/state.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';

export const assert = (c, m) => { if (!c) throw new Error(m); };

/** A rich world with a standard shaft at `column`, floors 0..`top`, and its route tables built. */
export function liftedWorld({ stars = 5, column = 40, top = 12, cash = 90_000_000, lift = true } = {}) {
  __resetIds();
  const world = newTowerWorld({ seed: 1, cash });
  world.tower.starCount = stars;
  if (lift) {
    const r = applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column });
    assert(r.ok, 'fixture lift: ' + r.reason);
  }
  rebuildRouteTables(world.tower);
  return world;
}

/** Build something and return the placed object. */
export function build(world, what, floor, left) {
  const r = applyAction(world, { type: 'build', what, floor, left });
  assert(r.ok, `fixture: ${what} on F${floor} at ${left}: ${r.reason}`);
  rebuildRouteTables(world.tower);
  return r.object;
}

/** The actors of an object. */
export const actorsOf = (tower, object) => tower.actors.filter((a) => a && a.objectId === object.id);

/**
 * Give every occupant of `object` `trips` trips averaging `stress` - the condition "this room has been
 * measured at this stress", written directly because it takes a day of play to arrive at one exactly.
 */
export function measure(tower, object, stress, trips = 1) {
  for (const a of actorsOf(tower, object)) { a.tripCount = trips; a.accumulatedElapsed = stress * trips; }
}

/** Mark an office as let: the lease band and the measured flag, as a rented office carries them. */
export function let_(object) { object.unitStatus = 0x00; object.occupiedFlag = true; }
