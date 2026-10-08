/**
 * The scripted player of issue #19: a bare lot, $2,000,000, and a way up the whole ladder - written
 * only against `applyAction` and `starGateStatus`, so a browser tab can run it as well as Node.
 *
 * The trial that plays it for N days and writes the numbers is `harness/climb.js`
 * (`node harness/playtest.js --climb`); the browser plays it live at `?demo=climb`
 * (`ui/demo.js`). This file is only the player: what it reads and what it builds.
 *
 * ## What it is
 *
 * A player who reads the bar (`starGateStatus` - the same thing the HUD prints) and answers it
 * through `applyAction` and nothing else: no sim field is written by the script, no gate flag is
 * set, no object is placed any other way. Each morning it does two things.
 *
 *   1. **Answers the bar.** The ladder names what is missing - a security office, two suites, a
 *      clinic, a metro station, a cathedral - and the script builds that, with the service lift
 *      the recycling centers and the housekeepers need, the garage when the tower asks for
 *      parking, and the lifts to the 100th floor when the cathedral is named.
 *   2. **Grows the tower**, spending what is left on offices and, in proportion, on lifts. This
 *      is where the repo's standing invariant lives: **knowing the bottleneck beats ignoring it**.
 *
 * ## The lift policies
 *
 * The three policies build the SAME rooms in the SAME order from the SAME seed. They differ only
 * in what they do about transport:
 *
 *   - `zoned`  - reads the sim's own limits. A standard lift serves 30 floors at most
 *                (`MAX_SERVED_SPAN`), a worker changes lift once (`ROUTING.md` § Transfer Groups),
 *                so above the first zone the tower is an **express** trunk, a **sky lobby** every
 *                15 floors (29, 44, 59, 74) and a bank of standard lifts in each zone. Cars are
 *                bought in proportion to the offices they serve, and a zone whose offices read
 *                nearly red on the Eval view gets more. A **service** lift takes the recycling out
 *                and the housekeepers up. The wedding spine (express to 89, sky lobby, standard to
 *                99) is built the day the bar names the cathedral.
 *   - `cars`   - the player who knows lifts need cars but has never met a sky lobby: standard
 *                lifts from the ground to the 30th floor, cars added as the tower grows, no
 *                express, no sky lobby, no service lift. It runs out of tower at floor 28.
 *   - `single` - the player who built one lift on day one and never looked at it again.
 *
 * ⚠️ A84: nothing in the sim sets `actor.homeColumn`, so the router's distance penalty is measured
 * from tile 0 for everyone. The plan therefore keeps every standard lift left of column 80 (a lift
 * at 80 costs its riders +30 stress, 125 +60) and the expresses, which are exempt, to the right.
 * That is a layout the quirk rewards and not one a faithful game would; recorded, not fixed.
 * `spec/DEVIATIONS.md` A88.
 */
import { FAMILY } from '../sim/state.js';
import { CONSTRUCTION_COST, CAR_COST } from '../sim/economy.js';
import { BUILDABLE, applyAction, buildCost } from '../sim/actions.js';
import { CARRIER_MODE, MAX_CARRIERS, MAX_CARS_PER_CARRIER } from '../sim/elevators.js';
import {
  HOTEL_SUITES_FOR_FOUR_STARS, STAR_THRESHOLDS, starGateStatus, starPopulation, towerActivity,
} from '../sim/progression.js';
import { isDemanded } from '../sim/demands.js';
import { facilityReading } from '../sim/facility.js';
import { CATHEDRAL_BASE_FLOOR, hasCathedral } from '../sim/cathedral.js';

// ---------------------------------------------------------------------------
// The plan of the lot. Pure: no tower in it.

/** Standard-lift columns. 12 apart because `SHAFT_SEPARATION` wants 8 clear tiles beside a 4-wide shaft. */
export const SLOTS = [12, 24, 36, 48, 60, 72];
/**
 * ⚠️ A84: nothing sets `actor.homeColumn`, so the router's distance penalty is measured from tile 0
 * for everyone: a standard lift at column 80 or beyond costs its riders +30 stress, 125 or beyond
 * +60. Express riders are exempt. The script therefore keeps every standard lift left of 80 and the
 * expresses to the right; that is a layout the quirk rewards, not one a faithful game would, and it
 * is recorded rather than fixed (`spec/DEVIATIONS.md` A88).
 */
export const SERVICE_COLUMN = 0;
/** The service lift runs from the recycling plant's basement to the hotel floor. */
export const SERVICE_BOTTOM = -7;
export const SERVICE_TOP = 13;
/** `MAX_CARRIERS` (24), less the lifts every tower needs besides its zones: service, two expresses, the spine's standard lift. */
export const ZONE_SHAFTS = [6, 4, 4, 3, 3];
export const EXPRESS_COLUMNS = [98, 112];
const FAST_FOOD_LEFT = 118;

/**
 * The zones. A standard lift serves 30 floors, so the first zone is the ground lift's own 27 floors
 * (there is no express before three stars, and nothing yet to change lift at); above it the tower is
 * a zone to each sky lobby: 29, 44, 59, 74, and 89 for the cathedral's spine (`ELEVATORS.md` §
 * Served-Floor Mapping: lobbies on the ground and every 15th floor).
 */
export const skyFloor = (zone) => (zone === 0 ? 0 : 15 * (zone + 1) - 1);
export const ZONES = 5;
/** The zone's standard lifts stop three floors short of the next sky lobby so zone k and k+1 may share columns. */
export const zoneTop = (zone) => skyFloor(zone + 1) - 3;
/** The floors the hotel, housekeeping and clinic share, low enough to be one short ride from the lobby. */
export const SERVICE_FLOORS = [11, 12, 13];
export const SERVICE_FLOOR = SERVICE_FLOORS[0];
/** The floors a zone's offices stand on. The service floor is not one of them. */
export function zoneFloors(zone, lifts = 'zoned') {
  if (lifts !== 'zoned') return Array.from({ length: 28 }, (_, i) => i + 1).filter((f) => !SERVICE_FLOORS.includes(f));
  const floors = [];
  for (let f = zone === 0 ? 1 : skyFloor(zone); f <= zoneTop(zone); f++) if (!SERVICE_FLOORS.includes(f)) floors.push(f);
  return floors;
}
export const zoneOfFloor = (floor) => {
  for (let z = 0; z < ZONES; z++) if (floor >= (z === 0 ? 1 : skyFloor(z)) && floor <= zoneTop(z)) return z;
  return -1;
};

/** A rectangle nothing may be built in because a lift is planned there. */
const keepOut = (lo, hi, left, right) => ({ lo, hi, left, right });

/** Every lift the plan may ever build, as rectangles (a shaft claims one floor above and below). */
export function plannedLiftSites(lifts = 'zoned') {
  const sites = [keepOut(SERVICE_BOTTOM - 1, SERVICE_TOP + 1, SERVICE_COLUMN, SERVICE_COLUMN + 3)];
  if (lifts === 'zoned') {
    for (let z = 0; z < ZONES; z++) {
      for (const c of SLOTS) sites.push(keepOut(skyFloor(z) - 1, zoneTop(z) + 1, c, c + 3));
    }
    for (const c of EXPRESS_COLUMNS) sites.push(keepOut(-1, skyFloor(ZONES) + 1, c, c + 5));
    for (const c of SLOTS) sites.push(keepOut(skyFloor(ZONES) - 1, CATHEDRAL_BASE_FLOOR + 1, c, c + 3));
  } else {
    for (const c of SLOTS) sites.push(keepOut(-1, 30, c, c + 3));
  }
  return sites;
}

// ---------------------------------------------------------------------------

/**
 * The scripted player. `morning()` is its whole behaviour; nothing else touches the tower.
 *
 * @param {{tower:object, ledger:object}} world
 * @param {object} options
 * @param {'zoned'|'cars'|'single'} [options.lifts]
 * @param {string[]} [options.skip] requirements this player never answers (for the gate tests):
 *   security, suites, housekeeping, recycling, service, medical, metro, parking, cathedral, spine, express
 * @param {boolean} [options.crowd] top the population ledger up to the next rung (the stand-in)
 * @param {number} [options.crowdFrom] the star from which the crowd is applied (3: the ladder trial's; 4: only where the sim cannot host the rest)
 * @param {number} [options.carRatio] offices one car may carry before the player buys another
 * @param {number} [options.maxOffices] the player's ambition: stop building offices at this many
 * @param {boolean} [options.serviceLift] a `cars` or `single` player who has also met the service elevator (diagnostics)
 */
export function makeClimber(world, {
  lifts = 'zoned', skip = [], crowd = false, crowdFrom = 3, carRatio = 5, expressRatio = 8, maxOffices = Infinity,
  serviceLift = false,
} = {}) {
  const { tower, ledger } = world;
  const skipped = new Set(skip);
  const built = [];
  const refused = [];
  const sites = plannedLiftSites(lifts);
  const ratios = new Map();            // zone -> offices per car, lowered by what the Eval view shows red
  const saturated = new Set();         // zones that cannot take another lift or room
  let rows = new Map();                // floor -> Uint8Array(150) of taken tiles
  let opened = 1;                      // zones open to building (zoned only)
  let spineBuilt = false;
  let recyclingTarget = 0;

  const day = () => tower.clock.dayCounter;
  const cash = () => ledger.cash;
  const objects = () => [...tower.objects.values()];
  const count = (family) => objects().filter((o) => o.family === family).length;

  // ---- the lot, as the script keeps it: what is built plus what is planned for a lift
  const indexRows = () => {
    rows = new Map();
    for (const o of tower.objects.values()) {
      let row = rows.get(o.floor);
      if (!row) rows.set(o.floor, row = new Uint8Array(150));
      for (let t = o.left; t <= o.right; t++) row[t] = 1;
    }
  };
  const take = (floor, left, width) => {
    let row = rows.get(floor);
    if (!row) rows.set(floor, row = new Uint8Array(150));
    for (let t = left; t < left + width; t++) row[t] = 1;
  };
  const free = (floor, left, width) => {
    if (left < 0 || left + width > 150) return false;
    const row = rows.get(floor);
    for (let t = left; t < left + width; t++) if (row?.[t]) return false;
    for (const s of sites) {
      if (floor < s.lo || floor > s.hi) continue;
      if (left <= s.right && left + width - 1 >= s.left) return false;
    }
    return true;
  };
  const findSlot = (floor, width, from = 0, to = 150) => {
    for (let left = from; left + width <= to; left++) if (free(floor, left, width)) return left;
    return null;
  };
  /** The first service floor with room for `width` tiles, as `{floor, left}`. */
  const findServiceSlot = (width, from = 0) => {
    for (const floor of SERVICE_FLOORS) {
      const left = findSlot(floor, width, from);
      if (left !== null) return { floor, left };
    }
    return null;
  };

  const act = (action, label) => {
    const result = applyAction(world, action);
    if (result.ok) {
      built.push({ day: day(), what: label });
      if (action.type === 'build') take(action.floor, action.left, BUILDABLE[action.what].width);
    } else {
      refused.push({ day: day(), what: label, reason: result.reason, at: action.type === 'build' ? action.floor + '@' + action.left : undefined });
    }
    return result;
  };
  const afford = (cost) => cash() >= cost;

  // ---- reading the tower
  const carriersOf = (mode) => tower.carriers.filter((c) => c.mode === mode);
  /** The standard lifts that serve a zone (the bank). */
  const bank = (zone) => carriersOf(CARRIER_MODE.STANDARD).filter((c) =>
    lifts === 'zoned' ? c.bottomFloor === skyFloor(zone) && SLOTS.includes(c.column) && c.topFloor === zoneTop(zone)
      : c.bottomFloor === 0 && SLOTS.includes(c.column));
  const carsIn = (zone) => bank(zone).reduce((n, c) => n + c.cars.length, 0);
  const officesIn = (zone) => objects().filter((o) => o.family === FAMILY.office && (lifts === 'zoned' ? zoneOfFloor(o.floor) === zone : true)).length;
  const expressCars = () => carriersOf(CARRIER_MODE.EXPRESS).reduce((n, c) => n + c.cars.length, 0);
  const ratioOf = (zone) => ratios.get(zone) ?? carRatio;

  const zoneCount = lifts === 'zoned' ? ZONES : 1;
  const floorsOf = (zone) => zoneFloors(zone, lifts);

  const nextOfficeSlot = (zone) => {
    for (const floor of floorsOf(zone)) {
      const left = findSlot(floor, BUILDABLE.office.width);
      if (left !== null) return { floor, left };
    }
    return null;
  };

  // ---- the lifts
  /** One more car for the zone, or a new lift in the next free column. Returns 'ok' | 'cash' | 'full'. */
  const buyLift = (zone) => {
    const shafts = bank(zone);
    const withRoom = shafts.find((c) => c.cars.length < MAX_CARS_PER_CARRIER);
    if (withRoom) {
      if (!afford(CAR_COST.standard)) return 'cash';
      return act({ type: 'add_car', carrierId: withRoom.id }, 'car').ok ? 'ok' : 'full';
    }
    const cap = lifts === 'zoned' ? ZONE_SHAFTS[zone] : 6;
    if (shafts.length >= cap || tower.carriers.length >= MAX_CARRIERS) return 'full';
    const column = SLOTS.find((c) => !shafts.some((s) => s.column === c)
      && !tower.carriers.some((o) => o.id && o.mode !== CARRIER_MODE.EXPRESS && o.column === c && o.bottomFloor === (lifts === 'zoned' ? skyFloor(zone) : 0)));
    if (column === undefined) return 'full';
    if (!afford(CONSTRUCTION_COST.elevatorStandard)) return 'cash';
    const bottom = lifts === 'zoned' ? skyFloor(zone) : 0;
    const top = lifts === 'zoned' ? zoneTop(zone) : 29;
    return act({ type: 'build_shaft', kind: 'standard', bottom, top, column }, 'lift').ok ? 'ok' : 'full';
  };

  /** The express trunk, as far as `zone`, with cars in proportion to the offices above the first zone. */
  const serveExpress = (zone) => {
    if (lifts !== 'zoned' || zone === 0 || skipped.has('express')) return 'ok';
    const sky = skyFloor(zone);
    const stop = carriersOf(CARRIER_MODE.EXPRESS);
    if (!objects().some((o) => o.family === FAMILY.lobby && o.floor === sky)) {
      if (!afford(CONSTRUCTION_COST.lobby)) return 'cash';
      if (!act({ type: 'build', what: 'lobby', floor: sky, left: 80 }, 'sky lobby').ok) return 'full';
    }
    if (stop.length === 0) {
      if (!afford(CONSTRUCTION_COST.elevatorExpress)) return 'cash';
      return act({ type: 'build_shaft', kind: 'express', bottom: 0, top: sky, column: EXPRESS_COLUMNS[0] }, 'express lift').ok ? 'ok' : 'full';
    }
    if (stop[0].topFloor < sky) {
      return act({ type: 'extend_shaft', carrierId: stop[0].id, top: sky }, 'express extended').ok ? 'ok' : 'full';
    }
    return 'ok';
  };
  const wantExpressCars = () => {
    let upper = 0;
    for (const o of tower.objects.values()) if (o.family === FAMILY.office && o.floor > zoneTop(0)) upper++;
    return Math.min(2 * MAX_CARS_PER_CARRIER, Math.ceil(upper / expressRatio));
  };
  const buyExpressCar = () => {
    if (!afford(CAR_COST.express)) return 'cash';
    let express = carriersOf(CARRIER_MODE.EXPRESS).find((c) => c.cars.length < MAX_CARS_PER_CARRIER);
    if (!express) {
      if (carriersOf(CARRIER_MODE.EXPRESS).length >= 2) return 'full';
      const top = carriersOf(CARRIER_MODE.EXPRESS)[0].topFloor;
      if (!afford(CONSTRUCTION_COST.elevatorExpress)) return 'cash';
      const r = act({ type: 'build_shaft', kind: 'express', bottom: 0, top, column: EXPRESS_COLUMNS[1] }, 'second express');
      return r.ok ? 'ok' : 'full';
    }
    return act({ type: 'add_car', carrierId: express.id }, 'express car').ok ? 'ok' : 'full';
  };

  // ---- what the hover shows: each zone's offices by stress, read as a player reads the Eval view
  /** An office reading this much is a floor from the red line (150): the inspector, or a bad day, takes it over. */
  const NEARLY_RED = 135;
  const stressByZone = () => {
    const sum = new Map();
    for (const o of tower.objects.values()) {
      if (o.family !== FAMILY.office) continue;
      const score = facilityReading(tower, o).score;
      if (score === null) continue;
      const z = lifts === 'zoned' ? zoneOfFloor(o.floor) : 0;
      const e = sum.get(z) ?? { n: 0, hot: 0 };
      e.n++;
      if (score >= NEARLY_RED) e.hot++;
      sum.set(z, e);
    }
    return sum;
  };

  /** The tower is asking for parking and the player can answer. */
  const garageWanted = () => (isDemanded(tower, 'officeParking') || isDemanded(tower, 'suiteParking'))
    && tower.starCount >= 3 && !skipped.has('parking');
  /** A ramp down to the second basement floor, then spaces out from it in both directions. */
  const buildGarage = (limit) => {
    if (count(FAMILY.parkingRamp) === 0) {
      attempt('parking ramp', CONSTRUCTION_COST.parkingRamp, { type: 'build', what: 'parkingRamp', floor: -1, left: 80 });
      attempt('parking ramp', CONSTRUCTION_COST.parkingRamp, { type: 'build', what: 'parkingRamp', floor: -2, left: 80 });
    }
    // A space is served while the run of them is unbroken (`PARKING.md` § Coverage Propagation).
    let placed = 0;
    for (let k = 0; k < 400 && placed < limit && count(FAMILY.parkingSpace) < 512; k++) {
      const left = k % 2 === 0 ? 81 + 4 * (k / 2) : 76 - 4 * ((k - 1) / 2);
      if (left < 4 || left + 4 > 150 || !free(-2, left, BUILDABLE.parkingSpace.width)) continue;
      if (!attempt('parking space', CONSTRUCTION_COST.parkingSpace, { type: 'build', what: 'parkingSpace', floor: -2, left })) break;
      placed++;
    }
  };

  // ---- the bar
  /** What the bar has asked for and the player cannot yet pay; growth leaves it alone. */
  let pending = 0;
  const attempt = (label, cost, action) => {
    if (!afford(cost)) { pending += cost; return false; }
    return act(action, label).ok;
  };
  const gateWork = (status) => {
    const kinds = new Set(status.blockerDetails.map((d) => d.kind).filter(Boolean));
    const star = tower.starCount;
    pending = 0;

    if (kinds.has('security') && !skipped.has('security') && count(FAMILY.security) < 1) {
      const left = findSlot(-3, BUILDABLE.security.width, 60);
      if (left !== null) attempt('security office', CONSTRUCTION_COST.security + 500 * BUILDABLE.security.width, { type: 'build', what: 'security', floor: -3, left });
    }

    if (kinds.has('hotelSuite') && !skipped.has('suites')) {
      for (let i = count(FAMILY.hotelSuite); i < HOTEL_SUITES_FOR_FOUR_STARS; i++) {
        const spot = findServiceSlot(BUILDABLE.hotelSuite.width, 76);
        if (!spot) break;
        if (!attempt('hotel suite', CONSTRUCTION_COST.hotelSuite, { type: 'build', what: 'hotelSuite', ...spot })) break;
      }
    }
    // The housekeepers: a suite is only a suite while someone turns it round (issue #9), and the
    // VIP (issue #16) is only given a clean one. They need the service lift to reach the floor.
    if (count(FAMILY.hotelSuite) > 0 && count(FAMILY.housekeeping) === 0 && !skipped.has('housekeeping')) {
      const spot = findServiceSlot(BUILDABLE.housekeeping.width, 76);
      if (spot) attempt('housekeeping', CONSTRUCTION_COST.housekeeping, { type: 'build', what: 'housekeeping', ...spot });
    }
    if ((isDemanded(tower, 'medical') || kinds.has('medical')) && count(FAMILY.medical) === 0 && !skipped.has('medical')) {
      const spot = findServiceSlot(BUILDABLE.medical.width, 76);
      if (spot) attempt('medical center', CONSTRUCTION_COST.medical, { type: 'build', what: 'medical', ...spot });
    }
    if (kinds.has('metroStation') && count(FAMILY.metro) === 0 && !skipped.has('metro')) {
      attempt('metro station', CONSTRUCTION_COST.metroStation, { type: 'build', what: 'metroStation', floor: -10, left: 100 });
    }

    if (star >= 3) {
      // Recycling: a service lift from the basement (the garbage has to come out), then centers for
      // the activity (< 2,500 each). The centers are built by every player who reads the bar; the
      // service lift only by one who knows the centers need it.
      if (!carriersOf(CARRIER_MODE.SERVICE).length && (lifts === 'zoned' || serviceLift) && !skipped.has('service')) {
        attempt('service lift', CONSTRUCTION_COST.elevatorService, { type: 'build_shaft', kind: 'service', bottom: SERVICE_BOTTOM, top: SERVICE_TOP, column: SERVICE_COLUMN });
      }
      if (!skipped.has('recycling')) {
        // A center is adequate at 2566 under 2,500 a head and, better, at 2000 under 1,000: and 2000 is the
        // hour BEFORE the 3-day pass evicts the unhappy, so a tower that clears it is adequate while its
        // head-count is still whole (the evening window of 3 -> 4 and 4 -> 5 is the one that matters).
        const want = Math.min(8, Math.ceil((Math.max(towerActivity(tower), STAR_THRESHOLDS[star - 1] ?? 15_000) + 300) / 950));
        recyclingTarget = want;
        for (let i = count(FAMILY.recycling) / 2; i < want; i++) {
          const placed = [[-7, 4], [-7, 29], [-7, 54], [-7, 79], [-7, 104], [-5, 4], [-5, 29], [-5, 54]];
          const spot = placed.find(([f, l]) => free(f, l, BUILDABLE.recyclingCenter.width) && free(f + 1, l, BUILDABLE.recyclingCenter.width));
          if (!spot) break;
          if (!attempt('recycling center', CONSTRUCTION_COST.recyclingCenter, { type: 'build', what: 'recyclingCenter', floor: spot[0], left: spot[1] })) break;
          take(spot[0] + 1, spot[1], BUILDABLE.recyclingCenter.width);
        }
      }
    }

    // The garage, when the tower asks (the 4 -> 5 rung wants every demand answered).
    if (garageWanted()) buildGarage(8);

    // The cathedral (issue #17), once the bar names it: the lifts to the 100th floor, then the building.
    if (kinds.has('cathedral') && !hasCathedral(tower) && !skipped.has('cathedral')) {
      if (!spineBuilt && !skipped.has('spine')) spineBuilt = buildSpine();
      if (spineBuilt || skipped.has('spine')) {
        attempt('cathedral', CONSTRUCTION_COST.cathedral + 5 * 28 * 500, { type: 'build', what: 'cathedral', floor: CATHEDRAL_BASE_FLOOR, left: 20 });
      } else {
        pending += 4_500_000;
      }
    }
    return pending;
  };

  /** Express to the 89th floor, a sky lobby there, a standard lift to 99: the only way a hundred floors is one change. */
  const buildSpine = () => {
    const top = skyFloor(ZONES);
    const need = CONSTRUCTION_COST.elevatorExpress + 6 * CAR_COST.express + CONSTRUCTION_COST.elevatorStandard + 6 * CAR_COST.standard + 40_000;
    if (cash() < need) return false;
    let express = carriersOf(CARRIER_MODE.EXPRESS)[0];
    if (!express) {
      const r = act({ type: 'build_shaft', kind: 'express', bottom: 0, top, column: EXPRESS_COLUMNS[0] }, 'express lift to floor 89');
      if (!r.ok) return false;
      express = r.carrier;
    } else if (express.topFloor < top) {
      if (!act({ type: 'extend_shaft', carrierId: express.id, top }, 'express extended to floor 89').ok) return false;
    }
    while (express.cars.length < 6) if (!act({ type: 'add_car', carrierId: express.id }, 'express car').ok) return false;
    if (!objects().some((o) => o.family === FAMILY.lobby && o.floor === top)) {
      if (!act({ type: 'build', what: 'lobby', floor: top, left: 80 }, 'sky lobby on floor 89').ok) return false;
    }
    const r = act({ type: 'build_shaft', kind: 'standard', bottom: top, top: CATHEDRAL_BASE_FLOOR, column: SLOTS[0] }, 'standard lift 89-99');
    if (!r.ok) return false;
    while (r.carrier.cars.length < 6) if (!act({ type: 'add_car', carrierId: r.carrier.id }, 'car').ok) return false;
    return true;
  };

  // ---- growth
  const grow = (budgetFloor) => {
    const star = tower.starCount;
    // Closed loop on the lifts: a zone with more than one office in ten reading nearly red wants more cars
    // per office; one with hardly any can do with fewer. One step a morning.
    if (lifts !== 'single') {
      for (const [z, e] of stressByZone()) {
        // Only a reading taken while most of the zone is measured: the morning after a 3-day pass has
        // evicted the unhappy, the survivors read well and the survey is lying.
        if (e.n < 8 || e.n < 0.85 * officesIn(z)) continue;
        const hot = e.hot / e.n;
        if (hot > 0.10) {
          ratios.set(z, Math.max(3, ratioOf(z) - 1));
          // ...and the car comes at once, not with the next office: the offices are already there.
          if (cash() - budgetFloor > CAR_COST.standard && !saturated.has(z)) buyLift(z);
        } else if (hot < 0.02) ratios.set(z, Math.min(8, ratioOf(z) + 1));
      }
    }
    if (lifts === 'zoned' && star >= 3) {
      // Open the next zone once the last one has no room left, or its lifts are as big as they go.
      for (let z = opened; z < ZONES; z++) {
        if (saturated.has(z - 1) || nextOfficeSlot(z - 1) === null) opened = Math.max(opened, z + 1);
      }
    }
    const horizon = lifts === 'zoned' ? Math.min(opened, ZONES) : 1;

    for (let guard = 0; guard < 600; guard++) {
      if (cash() - budgetFloor < CONSTRUCTION_COST.office + 3000) break;
      if (countFamily(tower, FAMILY.office) >= maxOffices) break;
      let zone = -1;
      for (let z = 0; z < horizon; z++) {
        if (saturated.has(z)) continue;
        if (nextOfficeSlot(z)) { zone = z; break; }
        saturated.add(z);
      }
      if (zone < 0) break;

      // A zone above the first needs its sky lobby and the express as far as it.
      const trunk = serveExpress(zone);
      if (trunk === 'cash') break;
      if (trunk === 'full') { saturated.add(zone); continue; }

      const offices = officesIn(zone);
      const cars = carsIn(zone);
      if (lifts === 'single') {
        if (cars === 0) {
          const r = buyLift(zone);
          if (r === 'cash') break;
          // The one shaft the player buys on day one gets a few cars and is never touched again.
          for (let i = 0; i < 2; i++) if (afford(CAR_COST.standard)) buyLift(zone);
          continue;
        }
      } else if (offices + 1 > cars * ratioOf(zone) || cars === 0) {
        const r = buyLift(zone);
        if (r === 'cash') break;
        if (r === 'full') saturated.add(zone);
        continue;
      }
      if (lifts === 'zoned' && zone > 0 && expressCars() < wantExpressCars()) {
        const r = buyExpressCar();
        if (r === 'cash') break;
        if (r === 'ok') continue;
      }
      const slot = nextOfficeSlot(zone);
      if (!slot) { saturated.add(zone); continue; }
      if (!afford(buildCost(tower, BUILDABLE.office, slot.floor) + budgetFloor)) break;
      if (!act({ type: 'build', what: 'office', floor: slot.floor, left: slot.left }, 'office').ok) saturated.add(zone);
    }

    // Lunch: one fast food per zone once it has a crowd to feed (the Eval view reads worse without).
    for (let z = 0; z < horizon; z++) {
      const here = objects().filter((o) => o.family === FAMILY.fastFood && (lifts === 'zoned' ? zoneOfFloor(o.floor) === z : true)).length;
      const wanted = Math.floor(officesIn(z) / 70);
      if (here < wanted && afford(CONSTRUCTION_COST.fastFood + budgetFloor)) {
        for (const floor of floorsOf(z)) {
          const left = findSlot(floor, BUILDABLE.fastFood.width, FAST_FOOD_LEFT - 20);
          if (left !== null) { act({ type: 'build', what: 'fastFood', floor, left }, 'fast food'); break; }
        }
      }
    }
  };

  // ---- the crowd (the one named stand-in for the population)
  const realPopulation = () => {
    const saved = tower.populationLedger.crowd ?? 0;
    delete tower.populationLedger.crowd;
    const real = starPopulation(tower);
    if (saved) tower.populationLedger.crowd = saved;
    return real;
  };
  let crowdStar = 0;
  let crowdSize = 0;
  const topUpCrowd = () => {
    if (!crowd || tower.starCount < crowdFrom) return;
    const target = STAR_THRESHOLDS[tower.starCount - 1] ?? 15_000;
    // The tenants come and go with the 3-day pass (the unhappy are evicted and re-let), so the real
    // head-count breathes by half. The crowd covers the worst morning seen on this rung, not the best.
    if (crowdStar !== tower.starCount) { crowdStar = tower.starCount; crowdSize = 0; }
    crowdSize = Math.max(crowdSize, target - realPopulation() + 60);
    tower.populationLedger.crowd = crowdSize;
  };

  /** What the next 3-day pass will take out: the Finance window's upkeep lines, read ahead (`economy.js`). */
  const upkeepPerPass = () => {
    let total = 0;
    for (const c of tower.carriers) total += c.cars.length * (c.mode === CARRIER_MODE.EXPRESS ? 20_000 : 10_000);
    total += 20_000 * count(FAMILY.security) + 10_000 * count(FAMILY.housekeeping) + 100_000 * count(FAMILY.metro)
      + 10_000 * count(FAMILY.parkingRamp) + 25_000 * count(FAMILY.recycling);
    return total;
  };

  /** The player's morning. */
  const morning = () => {
    indexRows();
    const status = starGateStatus(tower);
    const pending = gateWork(status);
    // Money the bar has already asked for is not spent on growth: a tower that spends the cathedral's
    // price on offices never builds a cathedral. Nor is the next pass's upkeep.
    grow(Math.min(pending, 12_000_000) + upkeepPerPass() * 1.2 + 50_000);
    topUpCrowd();
  };

  /**
   * The player's evening, after 5 PM, when the windows of `3 -> 4` and `4 -> 5` open. A demand is
   * answered by building what it asks for (`answerParkingDemand`), and the ones that matter are
   * raised by this morning's drivers and still standing: so the garage grows by one more space.
   */
  const evening = () => {
    indexRows();
    if (garageWanted() && starGateStatus(tower).blockers.some((b) => /demand/.test(b))) buildGarage(1);
  };

  return {
    morning, evening, built, refused, realPopulation,
    get recyclingTarget() { return recyclingTarget; },
    get opened() { return opened; },
    state: () => ({ opened, saturated: [...saturated], ratios: Object.fromEntries(ratios) }),
  };
}

/** How many objects of a family stand in the tower. */
export function countFamily(tower, family) {
  let n = 0;
  for (const o of tower.objects.values()) if (o.family === family) n++;
  return n;
}
