/**
 * `applyAction()` — the one door into the tower.
 *
 * `CLAUDE.md` rule 1: *"Every state change goes through `applyAction()` — human
 * clicks and headless policies use the identical seam. That is what makes
 * replay work."* Until now nothing implemented it and the UI mutated the sim
 * directly, which is fine for a fixed demo and useless for a game: you cannot
 * replay a click that was never a command.
 *
 * Every command is `{ type, ...args }` and every result is
 * `{ ok, reason?, ... }`. Nothing here throws for a refused move — a refusal is
 * an answer, and the interface needs to show it.
 *
 * **Money is charged here and nowhere else.** A command that cannot be paid
 * for is refused before it touches the tower, so a half-built object can never
 * exist. `specs/COMMANDS.md` calls that
 * `check_construction_funds_available_for_floor_range`.
 */
import {
  COMMERCIAL_FAMILY_CODES, FAMILY, OBJECT_TYPE, floorExists, isRented, placeObject, spanBlocked,
} from './state.js';
import {
  CARRIER_MODE, MAX_SERVED_SPAN, SHAFT_WIDTH, addCar, createCarrier,
} from './elevators.js';
import { CONSTRUCTION_COST, chargeConstruction, placementCost } from './economy.js';
import { lockReason, notePlacement } from './progression.js';
import { createSimTripRecord } from './stress.js';
import { FAST_FOOD_WIDTH, finalizeCommercialVenue } from './commercial.js';

/**
 * What each buildable maps to. The palette is built from this, so it cannot
 * drift.
 *
 * `finalize` is the family-specific placement finalizer `specs/FACILITIES.md`
 * § Placement Finalizer describes — the step that gives a commercial venue its
 * linked record. Only the families that have one carry it.
 */
export const BUILDABLE = {
  lobby: { family: FAMILY.lobby, type: OBJECT_TYPE.lobby, cost: 'lobby', width: 1, label: 'Lobby' },
  office: { family: FAMILY.office, type: OBJECT_TYPE.office, cost: 'office', width: 6, label: 'Office' },
  /**
   * The lunch destination. `cost: 'fastFood'` is `$100,000` in
   * `economy.js`'s table, keyed by type `0x0c` — which is why `OBJECT_TYPE`
   * had to stop calling `6` fast food: at `6` this would have been charged
   * `$200,000` as a Restaurant, and priced from the wrong row for ever.
   */
  fastFood: {
    family: FAMILY.fastFood,
    type: OBJECT_TYPE.fastFood,
    cost: 'fastFood',
    width: FAST_FOOD_WIDTH,
    label: 'Fast Food',
    finalize: finalizeCommercialVenue,
  },
};

/** Elevator kinds a player can place. */
export const SHAFT_KIND = {
  standard: { mode: CARRIER_MODE.STANDARD, cost: 'elevatorStandard', label: 'Elevator' },
};

const refuse = (reason) => ({ ok: false, reason });

/**
 * A shaft's clearance rectangle. `specs/COMMANDS.md` § Elevator placement
 * rules: *"Elevators reserve width 6 for express elevators and width 4 for
 * other carrier modes, expanded vertically from `bottom_floor - 1` through
 * `top_floor + 1`."*
 *
 * The vertical overhang is not decoration — a shaft needs its machine room and
 * its pit, so it claims a floor above and below the ones it serves.
 */
export function shaftClearance({ mode, bottom, top, column }) {
  const width = SHAFT_WIDTH[mode] ?? 4;
  return { left: column, right: column + width - 1, bottom: bottom - 1, top: top + 1 };
}

/** `specs/COMMANDS.md`: *"Elevators must have 8 empty tiles between them."* */
export const SHAFT_SEPARATION = 8;

/**
 * Why this shaft cannot go here, or null.
 *
 * Nothing checked any of it before: a shaft could be sunk straight through
 * occupied rooms and straight through another lift. The UI agent found it,
 * reported the consequence on the ghost ("passes through 12 rooms") and
 * deliberately did NOT invent a refusal in the interface — a rule the sim does
 * not have is a rule in two places. It has one now.
 */
export function shaftObstruction(tower, spec, ignoreCarrierId = null) {
  const box = shaftClearance(spec);
  const columns = new Set();
  for (let c = box.left; c <= box.right; c++) columns.add(c);

  for (const object of tower.objects.values()) {
    if (object.floor < box.bottom || object.floor > box.top) continue;
    if (object.left > box.right || object.right < box.left) continue;
    // The lobby is what a lift lands IN, not something it collides with. A
    // ground-floor lobby spans most of the lot, so counting it as an
    // obstruction refuses every shaft that reaches the ground — which is every
    // useful shaft. `specs/COMMANDS.md`: "elevator families and lobby spans are
    // exempt from the dispatcher-wide floor-0 rejection precheck".
    if (object.family === FAMILY.lobby) continue;
    return 'that column is not clear — a lift would pass through '
      + describeObstruction(tower, box) + ' on the way up';
  }

  for (const carrier of tower.carriers) {
    // A shaft being extended must not collide with itself, and its own
    // clearance box overlaps the new span by definition. Caught by extending
    // the seed's own lift and being told it overlapped an existing one.
    if (carrier.id === ignoreCarrierId) continue;
    const other = shaftClearance({
      mode: carrier.mode, bottom: carrier.bottomFloor, top: carrier.topFloor, column: carrier.column,
    });
    if (other.bottom > box.top || other.top < box.bottom) continue;   // no vertical overlap
    const gap = other.left > box.right ? other.left - box.right - 1
      : box.left > other.right ? box.left - other.right - 1 : -1;
    if (gap < SHAFT_SEPARATION) {
      return gap < 0
        ? 'that overlaps an existing lift'
        : 'lifts need ' + SHAFT_SEPARATION + ' clear tiles between them — that leaves ' + gap;
    }
  }
  return null;
}

const describeObstruction = (tower, box) => {
  let n = 0;
  for (const o of tower.objects.values()) {
    if (o.family === FAMILY.lobby) continue;
    if (o.floor >= box.bottom && o.floor <= box.top && o.left <= box.right && o.right >= box.left) n++;
  }
  return n === 1 ? '1 room' : n + ' rooms';
};


const ACTIONS = {
  /**
   * Place a room. The span is `left .. left + width - 1`; the width comes from
   * the buildable, so a caller cannot invent a four-tile office.
   */
  build({ tower, ledger }, { what, floor, left }) {
    const spec = BUILDABLE[what];
    if (!spec) return refuse('there is nothing called "' + what + '" to build');
    if (!floorExists(floor)) return refuse('that floor is outside the tower');

    // A lock is not a price, and it is checked before the price so the player
    // reads the true reason. "You cannot afford it" about something no amount
    // of money will buy sends someone away to earn money for nothing.
    const locked = lockReason(tower, spec.cost, spec.label);
    if (locked) return refuse(locked);

    const right = left + spec.width - 1;
    if (spanBlocked(tower, floor, left, right)) return refuse('something is already built there');

    const cost = placementCost(spec.cost, {
      tiles: spec.width, floor, lobbyHeight: tower.lobbyHeight,
    });
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }

    const placed = placeObject(tower,
      { family: spec.family, type: spec.type, floor, left, right },
      () => createSimTripRecord(),
      spec.finalize);
    if (!placed.ok) {
      ledger.cash += paid.cost;                       // nothing was built; refund
      return placed;
    }
    // Latch any star gate this placement satisfies, now rather than at the next
    // start of day — the reference sets these at placement.
    notePlacement(tower, spec.family);
    return { ok: true, cost, object: placed.object };
  },

  /**
   * Sink a shaft. `bottom..top` inclusive, capped at the reference's
   * contiguous 31-floor limit, which `createCarrier` throws on — caught here
   * and turned into an answer rather than an exception.
   */
  build_shaft({ tower, ledger }, { kind = 'standard', bottom, top, column }) {
    const spec = SHAFT_KIND[kind];
    if (!spec) return refuse('there is no "' + kind + '" shaft');
    // Express needs 3 stars and service needs 2, so this bites the moment the
    // palette grows past the standard shaft. Before the price, as above.
    const locked = lockReason(tower, spec.cost, spec.label);
    if (locked) return refuse(locked);
    if (!floorExists(bottom) || !floorExists(top)) return refuse('that shaft leaves the tower');
    if (top <= bottom) return refuse('a shaft has to serve more than one floor');
    if (top - bottom + 1 > MAX_SERVED_SPAN) {
      return refuse('a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby');
    }

    const blocked = shaftObstruction(tower, { mode: spec.mode, bottom, top, column });
    if (blocked) return refuse(blocked);

    const cost = CONSTRUCTION_COST[spec.cost] ?? 0;
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }

    let carrier;
    try {
      carrier = createCarrier({
        id: nextCarrierId(tower), mode: spec.mode, bottomFloor: bottom, topFloor: top, column,
      });
    } catch (error) {
      ledger.cash += paid.cost;
      return refuse(error.message);
    }
    addCar(carrier);                                  // a shaft with no car is a hole
    tower.carriers.push(carrier);
    tower.routeTablesDirty = true;
    return { ok: true, cost, carrier };
  },


  /**
   * Make an existing lift serve more floors — the move a player reaches for
   * first when a bank of offices sits above the top of the shaft, and which
   * was impossible until now: the only fix was a whole second shaft at
   * $200,000. The UI agent asked for this after watching the decision play.
   *
   * The reference has an elevator **editor** (`specs/COMMANDS.md` § served-floor
   * removal, the carrier-edit confirm prompt), so editing a served range is a
   * real move rather than an invention.
   *
   * TODO(parity): the reference does not price it. A shaft costs a flat
   * $200,000 whatever its span, and no per-floor rate for editing was
   * recovered — so extending is free here. Recorded as `spec/DEVIATIONS.md`
   * A12 rather than invented at a number of our choosing. If it proves too
   * cheap in play, that is a balance finding and it belongs to Keith.
   */
  extend_shaft({ tower }, { carrierId, bottom, top }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');

    const newBottom = bottom ?? carrier.bottomFloor;
    const newTop = top ?? carrier.topFloor;
    if (!floorExists(newBottom) || !floorExists(newTop)) return refuse('that leaves the tower');
    if (newTop <= newBottom) return refuse('a shaft has to serve more than one floor');
    if (newBottom > carrier.bottomFloor || newTop < carrier.topFloor) {
      return refuse('a shaft can be extended, not shortened — demolish it to move it');
    }
    if (newTop - newBottom + 1 > MAX_SERVED_SPAN) {
      return refuse('a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby');
    }

    // Check only what is NEW, so a lift is never blocked by the rooms it
    // already legally serves.
    for (const [from, to] of [[newBottom, carrier.bottomFloor - 1], [carrier.topFloor + 1, newTop]]) {
      if (from > to) continue;
      const blocked = shaftObstruction(tower, {
        mode: carrier.mode, bottom: from, top: to, column: carrier.column,
      }, carrier.id);
      if (blocked) return refuse(blocked);
    }

    carrier.bottomFloor = newBottom;
    carrier.topFloor = newTop;
    tower.routeTablesDirty = true;
    return { ok: true, cost: 0, bottom: newBottom, top: newTop };
  },

  /** Add a car to an existing shaft. The one purchase that scales a route. */
  add_car({ tower, ledger }, { carrierId }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    const cost = CONSTRUCTION_COST.elevatorStandard ?? 0;
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('a car costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }
    const car = addCar(carrier);
    if (!car) {
      ledger.cash += paid.cost;
      return refuse('that shaft is full — ' + carrier.cars.length + ' cars is the limit');
    }
    return { ok: true, cost, cars: carrier.cars.length };
  },

  /**
   * Demolish. Refused while the unit is let, because evicting a paying tenant
   * with a click is not a thing the reference lets you do — you drop the rent
   * or you fix the lifts.
   */
  demolish({ tower }, { objectId }) {
    const object = tower.objects.get(objectId);
    if (!object) return refuse('nothing there');
    if (hasTenant(object)) return refuse('that unit is let — you cannot evict a tenant');

    tower.objects.delete(objectId);
    tower.actors = tower.actors.filter((a) => a.objectId !== objectId);
    tower.routeTablesDirty = true;
    return { ok: true, freed: object };
  },

  /** Change a unit's rent tier. 0 is dearest, 3 is the one that always passes. */
  set_rent({ tower }, { objectId, tier }) {
    const object = tower.objects.get(objectId);
    if (!object) return refuse('nothing there');
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) return refuse('rent tiers run 0 to 3');
    object.rentLevel = tier;
    object.dirty = true;
    return { ok: true, tier };
  },
};

const nextCarrierId = (tower) =>
  tower.carriers.reduce((max, c) => Math.max(max, c.id), 0) + 1;

/**
 * Does demolishing this put somebody out of a home or a job?
 *
 * ⚠️ Not simply `isRented(unitStatus)` any more. `initialUnitStatus` places
 * every non-office, non-condo family in the open band — so a fast food read as
 * *let* from the instant it was built and could never be demolished, which is a
 * shop you are stuck with for the life of the tower.
 *
 * `specs/facility/COMMERCIAL.md` § Retail Income Timing draws the line: *"the
 * binary does **not** use the retail placed-object `unit_status` byte to drive
 * that visible open/closed distinction"*. A venue has customers, not tenants,
 * and there is nobody to evict — its diners simply find the venue gone, which
 * is the *"invalid or demolished ... immediate retry"* case § Venue Selection
 * already describes.
 *
 * Exported so `ui/build.js`'s ghost asks this rather than restating it. The
 * ghost and the seam agreeing is pinned by a matrix in `test/build.test.js`,
 * which is what makes one definition mandatory rather than tidy.
 */
export const hasTenant = (object) =>
  !COMMERCIAL_FAMILY_CODES.has(object.family) && isRented(object.unitStatus);

/**
 * The seam. `world` is `{ tower, ledger }` — both, because building costs
 * money and neither half is meaningful alone.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function applyAction(world, command) {
  const handler = ACTIONS[command?.type];
  if (!handler) return refuse('unknown command "' + command?.type + '"');
  return handler(world, command);
}

/** Command names, so a palette or a policy can enumerate without guessing. */
export const COMMANDS = Object.keys(ACTIONS);
