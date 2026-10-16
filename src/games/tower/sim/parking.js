/**
 * Families `0x0b` (parking space) and `0x2c` (parking ramp) - **where the cars go.**
 *
 * Spec: `specs/facility/PARKING.md` (the whole file), `specs/COMMANDS.md` § Floor-class
 * rules (*"parking-space, recycling-center, and parking ramps must be below grade
 * (`floor < 0`)"*) and § Family-specific floor and stack rules (*"parking ramps are
 * single-tile, single-floor segments"*), `specs/ECONOMY.md` ($3,000 a space, $50,000 a
 * ramp, $10,000 a pass for the ramp), `specs/PARKING_MIGRATION_PLAN.md`,
 * `SimTower-gameplay-analysis.md` ("512 parking spaces"; a hotel suite is
 * *"2 guests + parking"*).
 *
 * ## The model, in one paragraph
 *
 * A **space** holds up to two cars (the delivered art has an empty, a one-car and a
 * two-car frame - `basement-parking`). A **ramp** is one tile wide, stands in the
 * first basement directly under the ground-floor lobby (or in the column straight
 * below another ramp, so a deep garage is a stack of them), and **serves** the
 * spaces on its floor that it can reach: left and right from the ramp across
 * parking spaces, over gaps of at most three empty tiles, stopping at anything else
 * (`PARKING.md` § Coverage Propagation). A driver parks in a space a ramp serves.
 * Office workers and hotel suite guests are the drivers; when there is no space
 * for one the tower says *"Office workers demand Parking"*.
 *
 * ## ⚠️ One place this build reads the spec the other way up (`spec/DEVIATIONS.md` A54)
 *
 * `PARKING.md` says a space a ramp **covers** is *"suppressed"* and kept out of the
 * demand log the consumers draw from, and a space no ramp reaches stays in it. Read
 * literally, building a ramp would take parking away from the tower, and a garage
 * could only be used by NOT connecting it to the lobby - which contradicts the same
 * file's *"parking ramps are coverage infrastructure"*, the issue's *"the ramp must
 * connect to the first-floor lobby"*, and the reference's own art (a space with no
 * ramp is drawn *blocked*, with a red X). So the coverage byte keeps its spec
 * meaning (`coverageFlag === 1`: a ramp serves this space) and the consumer is
 * flipped: **drivers draw from the spaces a ramp serves.** One predicate,
 * {@link isUsableSpace}.
 *
 * ## Nothing here is a person
 *
 * A car is not population. The owners of a space's cars are the workers and suite
 * guests who are already counted, and the car list is keyed by owner so that a
 * worker who leaves, a room that checks out or a night that falls takes the right
 * one back out.
 */
import { FAMILY, GROUND_FLOOR, TILES_PER_FLOOR } from './state.js';
import { clearDemand, raiseDemand } from './demands.js';

/**
 * Tile span of a space. TODO(parity): **not stated in `specs/`**. 4 is the reference
 * *implementation*'s `TILE_WIDTHS.parking`, taken unscaled (the same source and the
 * same choice as every other width here, A26); `specs/PARKING_MIGRATION_PLAN.md`
 * proposes splitting it into one-tile spaces, which is a plan and not the game.
 * Four tiles is also what lets the delivered one-car / two-car frames read.
 * `spec/DEVIATIONS.md` A54.
 */
export const PARKING_SPACE_WIDTH = 4;

/** `specs/COMMANDS.md`: *"parking ramps are single-tile, single-floor segments"*. */
export const PARKING_RAMP_WIDTH = 1;

/** Cars a space holds - the frames of the delivered sheet (A54). */
export const SPACE_CAPACITY = 2;

/** `SimTower-gameplay-analysis.md` § Hard limits: *"512 parking spaces"*; `DATA-MODEL.md`: `service_request_entries[512]`. */
export const MAX_PARKING_SPACES = 512;

/** `PARKING.md` § Coverage Propagation: *"the empty run is at most `3` tiles wide"*. */
export const MAX_EMPTY_GAP = 3;

/** The floor a ramp starts on: the first basement, directly under the lobby. */
export const RAMP_TOP_FLOOR = GROUND_FLOOR - 1;

/**
 * `PARKING.md` § Demand Families: *"Office workers (family 7) require
 * `(floor + slot) % 4 == 1`"*. A quarter of the workers drive.
 */
export const DRIVER_MODULUS = 4;
export const DRIVER_RESIDUE = 1;

/** The star a tower must pass before anyone drives. `PARKING.md`: *"Requires star level > 2"*. */
export const PARKING_MIN_STARS = 3;

/** Every parking space, in placement order. */
export const parkingSpaces = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.parkingSpace);

/** Every parking ramp, in placement order. */
export const parkingRamps = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.parkingRamp);

/** Placement finalizer for a space: it carries its (empty) car list and an unserved flag from birth. */
export function finalizeParkingSpace(_tower, object) {
  object.parking = { cars: [] };
  object.coverageFlag = 0;
}

const carsOf = (space) => (space.parking ??= { cars: [] }).cars;

/** `PARKING.md` placement: the cap on spaces. */
export function parkingSpaceObstruction(tower) {
  return parkingSpaces(tower).length >= MAX_PARKING_SPACES
    ? 'a tower has at most ' + MAX_PARKING_SPACES + ' parking spaces'
    : null;
}

/** The ground-floor lobby object whose span includes this tile, or `null`. */
function lobbyAbove(tower, tile) {
  for (const o of tower.objects.values()) {
    if (o.family === FAMILY.lobby && o.floor === GROUND_FLOOR && o.left <= tile && o.right >= tile) return o;
  }
  return null;
}

/** The ramp on `floor` whose column is `tile`, or `null`. */
function rampAt(tower, floor, tile) {
  for (const o of tower.objects.values()) {
    if (o.family === FAMILY.parkingRamp && o.floor === floor && o.left <= tile && o.right >= tile) return o;
  }
  return null;
}

/**
 * **Does this ramp connect to the lobby?** A ramp in the first basement needs the
 * ground-floor lobby straight above it; a deeper one needs a connected ramp straight
 * above it. Read live, so bulldozing the top of a stack disconnects everything under
 * it (and the next {@link rebuildParkingCoverage} says so).
 */
export function rampConnected(tower, ramp) {
  if (ramp.floor === RAMP_TOP_FLOOR) return Boolean(lobbyAbove(tower, ramp.left));
  const above = rampAt(tower, ramp.floor + 1, ramp.left);
  return above ? rampConnected(tower, above) : false;
}

/**
 * Why a ramp cannot stand here, or `null`. `COMMANDS.md` lists *"parking-ramp wrong
 * column"* and *"parking-ramp anchor/floor mismatch"* among the dispatch-level build
 * errors; `PARKING_MIGRATION_PLAN.md` reads the "column 9" as the first basement
 * (EXE floor id 9, logical `-1`), where the coverage rebuild begins - and *"the ramp
 * must connect to the first-floor lobby"* (issue #13) is the same rule from the
 * player's side. One definition, asked by the seam and by the ghost.
 */
export function parkingRampObstruction(tower, floor, left) {
  if (floor === RAMP_TOP_FLOOR) {
    return lobbyAbove(tower, left)
      ? null
      : 'a parking ramp has to meet the lobby - there is no ground-floor lobby above that tile';
  }
  const above = rampAt(tower, floor + 1, left);
  if (!above) return 'a parking ramp has to connect up to the lobby - there is no ramp above that tile';
  return rampConnected(tower, above) ? null : 'that ramp column is cut off from the lobby';
}

/**
 * **Which spaces does a ramp serve?** `PARKING.md` § Coverage Propagation, rebuilt
 * from scratch each time (*"if no anchor exists on a floor, propagation still runs
 * in disabled mode so previously covered spaces are reset"*): every space starts
 * unserved, then each connected ramp walks left and then right across its floor.
 * A parking space is served (`coverageFlag = 1`); an empty tile is crossed while the
 * empty run is at most three wide; anything else - another ramp, a shop - stops it.
 *
 * Called when a space or a ramp is placed or demolished, and at the start of every
 * day (`ui/tick.js` tick 0), as `COMMANDS.md` and `PARKING.md` both say.
 *
 * @returns {number} how many spaces are served
 */
export function rebuildParkingCoverage(tower) {
  for (const space of parkingSpaces(tower)) space.coverageFlag = 0;

  const byFloor = new Map();
  for (const o of tower.objects.values()) {
    // Everything on a garage floor, because anything that is not a space is a wall
    // to the walk. Collected per floor so a floor with no ramp costs nothing.
    if (o.floor >= GROUND_FLOOR) continue;
    if (!byFloor.has(o.floor)) byFloor.set(o.floor, []);
    byFloor.get(o.floor).push(o);
  }

  let served = 0;
  for (const objects of byFloor.values()) {
    const ramps = objects.filter((o) => o.family === FAMILY.parkingRamp && rampConnected(tower, o));
    if (ramps.length === 0) continue;
    const at = new Array(TILES_PER_FLOOR).fill(null);
    for (const o of objects) for (let t = o.left; t <= o.right; t++) at[t] = o;

    for (const ramp of ramps) {
      for (const direction of [-1, 1]) {
        let tile = direction < 0 ? ramp.left - 1 : ramp.right + 1;
        let gap = 0;
        while (tile >= 0 && tile < TILES_PER_FLOOR) {
          const here = at[tile];
          if (!here) {
            if (++gap > MAX_EMPTY_GAP) break;
            tile += direction;
            continue;
          }
          if (here.family !== FAMILY.parkingSpace) break;
          gap = 0;
          if (here.coverageFlag !== 1) { here.coverageFlag = 1; served++; }
          here.dirty = true;
          tile = direction < 0 ? here.left - 1 : here.right + 1;
        }
      }
    }
  }
  return served;
}

/** Can a driver park here? A ramp serves it and there is room for another car. */
export const isUsableSpace = (space) => space.coverageFlag === 1 && carsOf(space).length < SPACE_CAPACITY;

/** The spaces a driver could park in right now. */
export const usableSpaces = (tower) => parkingSpaces(tower).filter(isUsableSpace);

/** How many cars are parked in the tower. */
export const carsParked = (tower) => parkingSpaces(tower).reduce((n, s) => n + carsOf(s).length, 0);

/**
 * Pick a space for a car and put it in, or return `null`. *"A random picker selects
 * from available entries; returns invalid when the table is empty"* - the draw is the
 * tower's own generator, one `int` over the usable spaces.
 */
function takeSpace(tower, ownerKey) {
  const open = usableSpaces(tower);
  if (open.length === 0) return null;
  const space = open[tower.rng.int(open.length)];
  carsOf(space).push(ownerKey);
  space.dirty = true;
  return space;
}

/** Take a car back out of a space. */
function releaseSpace(space, ownerKey) {
  if (!space?.parking) return false;
  const at = space.parking.cars.indexOf(ownerKey);
  if (at < 0) return false;
  space.parking.cars.splice(at, 1);
  space.dirty = true;
  return true;
}

// -------------------------------------------------------------- the drivers

/**
 * Does this office worker drive? `PARKING.md`: *"Office workers (family 7) require
 * `(floor + slot) % 4 == 1`"*, at more than two stars. The floor is the office's and
 * the slot is the worker's `occupant_index`.
 */
export const officeWorkerDrives = (tower, actor, office) =>
  tower.starCount >= PARKING_MIN_STARS
  && (office.floor + actor.occupantIndex) % DRIVER_MODULUS === DRIVER_RESIDUE;

/** The space this worker's car is in, or `null` (the space may have been demolished). */
export function spaceOfWorker(tower, actor) {
  if (actor.parkedAt == null) return null;
  const space = tower.objects.get(actor.parkedAt);
  return space && space.family === FAMILY.parkingSpace ? space : null;
}

/**
 * A worker drives in: find them a space. On failure the status bar says
 * *"Office workers demand Parking"* and the worker walks in from the lobby like
 * everyone else.
 */
export function parkWorker(tower, actor) {
  const space = takeSpace(tower, 'a' + actor.id);
  if (!space) {
    raiseDemand(tower, 'officeParking');
    return null;
  }
  actor.parkedAt = space.id;
  clearDemand(tower, 'officeParking');
  return space;
}

/** The worker's car leaves its space. Safe to call on anyone. */
export function unparkWorker(tower, actor) {
  if (actor.parkedAt == null) return false;
  releaseSpace(tower.objects.get(actor.parkedAt), 'a' + actor.id);
  actor.parkedAt = null;
  return true;
}

/**
 * A hotel suite's guests arrive with a car. `HOTEL.md` and the help file say an
 * occupied suite must have a parking space (the hook `activateHotelRoom` left); a
 * tower with none says *"Hotel Suite guests demand Parking"*. The booking itself is
 * never refused - what the original does to a suite that cannot park its guests is
 * not recorded, and inventing a penalty would be ours. `spec/DEVIATIONS.md` A54.
 */
export function parkSuiteGuest(tower, suite) {
  if (tower.starCount < PARKING_MIN_STARS) return null;
  if (suite.parkedAt != null && tower.objects.get(suite.parkedAt)) return tower.objects.get(suite.parkedAt);
  const space = takeSpace(tower, 's' + suite.id);
  if (!space) {
    raiseDemand(tower, 'suiteParking');
    return null;
  }
  suite.parkedAt = space.id;
  clearDemand(tower, 'suiteParking');
  return space;
}

/** The guests check out: the car leaves. */
export function unparkSuiteGuest(tower, suite) {
  if (suite.parkedAt == null) return false;
  releaseSpace(tower.objects.get(suite.parkedAt), 's' + suite.id);
  suite.parkedAt = null;
  return true;
}

/**
 * Something was just built or demolished: if a driver could park now, the demand
 * that was waiting for a space is answered. (A space no ramp serves answers nothing
 * - the demand stays until a ramp connects it.)
 */
export function answerParkingDemand(tower) {
  if (usableSpaces(tower).length === 0) return false;
  const office = clearDemand(tower, 'officeParking');
  const suite = clearDemand(tower, 'suiteParking');
  return office || suite;
}

/**
 * `specs/TIME.md` § 2500, chained into the night reset: the day's drivers go home.
 * Every worker's car leaves, and any car whose owner no longer exists (a suite
 * demolished while its guests were in) is swept so a space is never full of ghosts.
 * A suite guest's car stays - they are still checked in until the morning.
 */
export function parkingNightReset(tower) {
  for (const actor of tower.actors) {
    if (actor) { actor.parkedAt = null; actor.homeFrom = null; }
  }
  for (const space of parkingSpaces(tower)) {
    const keep = carsOf(space).filter((key) => key[0] === 's' && tower.objects.has(Number(key.slice(1))));
    if (keep.length !== space.parking.cars.length) { space.parking.cars = keep; space.dirty = true; }
  }
}
