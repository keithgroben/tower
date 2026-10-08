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
  COMMERCIAL_FAMILY_CODES, FAMILY, GROUND_FLOOR, OBJECT_TYPE, TILES_PER_FLOOR, floorExists, isSkyLobbyFloor, isUnitLet,
  placeObject, spanBlocked,
} from './state.js';
import {
  CARRIER_MODE, MAX_SERVED_SPAN, SHAFT_WIDTH, addCar, createCarrier, isExpressStopFloor, resizeCarrierSlots,
} from './elevators.js';
import { CONSTRUCTION_COST, carCostForMode, chargeConstruction, placementCost } from './economy.js';
import { lockReason, notePlacement } from './progression.js';
import { MAX_SEGMENTS, createSegment, segmentTopFloor } from './routing.js';
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

  /**
   * A condo is bought outright, not rented — and the money comes back out if
   * its residents cannot get about. `sim/condo.js` has the whole account.
   *
   * TODO(parity): **the spec set gives no condo tile span.** `OFFICE.md` states
   * the office's 6 outright; nothing states this one. 16 is the reference
   * *implementation*'s `TILE_WIDTHS.condo`, which is the only recovered figure,
   * and it is taken unscaled even though the same table calls an office 9 —
   * scaling it to our 6 would be a number of our own invention, which is worse
   * than a number of theirs. `spec/DEVIATIONS.md` A22.
   */
  condo: {
    family: FAMILY.condo,
    type: OBJECT_TYPE.condo,
    cost: 'condo',
    width: 16,
    label: 'Condo',
    /**
     * `specs/COMMANDS.md`: *"hotel rooms, offices, and condos must be above
     * grade (`floor > 0`) or reject with `0x0a`"*.
     *
     * TODO(parity): that line names **offices** too, and this build does not
     * enforce it for them. Turning it on for family 7 changes a shipped
     * family's placement rules and would refuse builds the seam accepts today,
     * so it belongs to that family rather than to this change. Declared as a
     * field rather than an `if` on the family code so the office is one word
     * away, not one rediscovery away.
     */
    aboveGrade: true,
  },
};

/** Elevator kinds a player can place. */
export const SHAFT_KIND = {
  standard: { mode: CARRIER_MODE.STANDARD, cost: 'elevatorStandard', label: 'Elevator' },
  // Two stars: for staff (housekeeping, from issue #9), never for tenants.
  service: { mode: CARRIER_MODE.SERVICE, cost: 'elevatorService', label: 'Service Elevator' },
  // Three stars: stops only at the ground lobby, the basements and the sky
  // lobbies (14, 29, 44, ...), so it is the zone trunk and never a local.
  express: { mode: CARRIER_MODE.EXPRESS, cost: 'elevatorExpress', label: 'Express Elevator' },
};

const refuse = (reason) => ({ ok: false, reason });

/** Where a lobby may stand. Null when the floor is legal (or the thing is not a lobby). */
export function lobbyFloorReason(family, floor) {
  if (family !== FAMILY.lobby) return null;
  if (floor === GROUND_FLOOR || isSkyLobbyFloor(floor)) return null;
  return 'lobbies go only on the ground floor and every 15th floor (14, 29, 44, ...)';
}

/**
 * The span rules every shaft command shares, in one place so the ghost and the
 * sim cannot word them differently. Null when the span is legal.
 *
 * - standard and service shafts serve at most `MAX_SERVED_SPAN` floors
 *   (`specs/COMMANDS.md`: "capped at 31 floors of span"; the original's own
 *   message says "Elevator shaft can cover only 30 floors" — DEVIATIONS A24);
 * - an **express** shaft is exempt from the cap but may only start and end at
 *   an express stop: the basements, the ground lobby and the sky lobbies
 *   (`ELEVATORS.md` § Served-Floor Mapping).
 */
export function shaftSpanReason(mode, bottom, top) {
  if (!floorExists(bottom) || !floorExists(top)) return 'that shaft leaves the tower';
  if (top <= bottom) return 'a shaft has to serve more than one floor';
  if (mode === CARRIER_MODE.EXPRESS) {
    for (const end of [bottom, top]) {
      if (!isExpressStopFloor(end)) {
        return 'an express lift stops only at the lobby and the sky lobbies (floors 14, 29, 44, ...) — floor '
          + end + ' is not one';
      }
    }
    return null;
  }
  if (top - bottom + 1 > MAX_SERVED_SPAN) {
    return 'a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby';
  }
  return null;
}

// ------------------------------------------------------------ stairs & escalators

/**
 * Stairs and escalators are **overlays**, not rooms: `specs/COMMANDS.md` calls
 * them "multifloor special-link overlays, not shaft objects". One link joins a
 * floor to the floor above it, standing on top of what is already built.
 *
 * `cost` keys into `CONSTRUCTION_COST` and `STAR_REQUIREMENT` (stairs 1 star,
 * $5,000; escalator 3 stars, $20,000). There is no floor-tile charge, because
 * nothing new is built under a link.
 */
export const LINK_KIND = {
  stairs: { kind: 'stairs', cost: 'stairs', label: 'Stairs' },
  escalator: { kind: 'escalator', cost: 'escalator', label: 'Escalator' },
};

/** Tiles a link occupies at each landing. `specs/COMMANDS.md`: "the requested 8-tile footprint". */
export const LINK_WIDTH = 8;

/**
 * Families an **escalator** may stand on at either landing. `specs/COMMANDS.md`:
 * *"empty, restaurant, retail, fast food, party hall (upper), party hall
 * (lower), lobby, cinema (upper), cinema (lower), single hotel room"* — the
 * help file says it plainly: "only on commercial or public areas". Stairs skip
 * this check. Families that do not exist yet (party hall, cinema, hotel) join
 * this set when they land (issues #8 and #11).
 */
export const ESCALATOR_UNDERLAY = new Set([FAMILY.lobby, FAMILY.restaurant, FAMILY.retail, FAMILY.fastFood]);

/** A link's footprint: the same 8 tiles on its lower floor and the floor above. */
export const linkFootprint = ({ floor, left }) => ({
  left, right: left + LINK_WIDTH - 1, bottom: floor, top: floor + 1,
});

/**
 * Why this link cannot go here, or null. Pure, so the ghost asks the sim
 * rather than restating the rules (the shaft check works the same way).
 *
 * TODO(parity): `COMMANDS.md` says the top landing needs the footprint to fit
 * "with a 2-tile left inset" and narrow geometry is a stepped two-half shape.
 * Neither is recovered precisely enough to implement, so both landings use the
 * plain 8 tiles and overlap is tested on the bounding rectangle. Recorded in
 * `spec/DEVIATIONS.md` as A23.
 */
export function linkObstruction(tower, { kind, floor, left }) {
  const spec = LINK_KIND[kind];
  if (!spec) return 'there is no "' + kind + '" to build';
  if (!Number.isInteger(floor) || !Number.isInteger(left)) return 'point at a floor';
  const box = linkFootprint({ floor, left });
  if (!floorExists(box.bottom) || !floorExists(box.top)) return 'that link leaves the tower';
  if (box.left < 0 || box.right >= TILES_PER_FLOOR) return 'that link leaves the lot';

  for (const landing of [box.bottom, box.top]) {
    const covering = [];
    for (let tile = box.left; tile <= box.right; tile++) {
      const under = [...tower.objects.values()].find((o) => o.floor === landing && o.left <= tile && o.right >= tile);
      if (!under) return 'both ends of ' + (kind === 'stairs' ? 'stairs' : 'an escalator') + ' need floor under them — nothing is built there on floor ' + landing;
      covering.push(under);
    }
    if (kind === 'escalator') {
      const bad = covering.find((o) => !ESCALATOR_UNDERLAY.has(o.family));
      if (bad) return 'escalators go only in shops, restaurants and lobbies';
    }
  }

  // A link and a lift cannot share ground (help file: "Elevators and stairs
  // cannot be placed over each other").
  for (const carrier of tower.carriers) {
    const other = shaftClearance({
      mode: carrier.mode, bottom: carrier.bottomFloor, top: carrier.topFloor, column: carrier.column,
    });
    if (other.bottom > box.top || other.top < box.bottom) continue;
    if (other.left > box.right || other.right < box.left) continue;
    return 'cannot place over other transportation';
  }
  for (const segment of tower.segments ?? []) {
    if (!segment?.active) continue;
    const there = linkFootprint({ floor: segment.entryFloor, left: segment.left });
    if (there.bottom > box.top || there.top < box.bottom) continue;
    if (there.left > box.right || there.right < box.left) continue;
    return 'cannot place over other transportation';
  }
  const live = (tower.segments ?? []).filter((s) => s?.active).length;
  if (live >= MAX_SEGMENTS) return 'no more stairs or escalators available (the limit is ' + MAX_SEGMENTS + ')';
  return null;
}

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
    return 'that column is not clear — ' + describeObstruction(tower, box);
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

/**
 * Say *what* is in the way and *where*. The old wording, "a lift would pass
 * through 1 room on the way up", read as if the room sat in the middle of the
 * shaft; the usual real cause is a single tile of the room's edge inside the
 * lift's footprint (or its machine room, one floor above the top), which looks
 * like open ground beside the ghost.
 */
const describeObstruction = (tower, box) => {
  const names = Object.fromEntries(Object.entries(FAMILY).map(([name, code]) => [code, name]));
  let first = null, n = 0;
  for (const o of tower.objects.values()) {
    if (o.family === FAMILY.lobby) continue;
    if (o.floor >= box.bottom && o.floor <= box.top && o.left <= box.right && o.right >= box.left) {
      n++;
      if (!first || o.floor < first.floor) first = o;
    }
  }
  const kind = (names[first.family] ?? 'room').replace(/([A-Z])/g, ' $1').toLowerCase();
  const floor = first.floor < 0 ? 'B' + (-first.floor) : String(first.floor);
  const more = n > 1 ? ' (and ' + (n - 1) + ' more)' : '';
  return 'the lift needs tiles ' + box.left + '–' + box.right + ' from floor ' + box.bottom
    + ' to ' + box.top + ', and ' + (/^[aeiou]/.test(kind) ? 'an ' : 'a ') + kind + ' on floor ' + floor + ' is in them' + more;
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

    if (spec.aboveGrade && floor <= GROUND_FLOOR) {
      return refuse('a ' + spec.label.toLowerCase() + ' has to go above the ground floor');
    }

    // The lobby goes on the ground and on the sky-lobby floors, nowhere else —
    // the original's own words: "Lobbys are only every 15 floors"
    // (`specs/COMMANDS.md`: the lobby-or-express-floor predicate).
    const wrongFloor = lobbyFloorReason(spec.family, floor);
    if (wrongFloor) return refuse(wrongFloor);

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
    // A sky lobby is a transfer point: the router needs to know the floor.
    if (spec.family === FAMILY.lobby && floor > GROUND_FLOOR) {
      tower.transferFloors ??= [];
      if (!tower.transferFloors.includes(floor)) tower.transferFloors.push(floor);
      tower.routeTablesDirty = true;
    }
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
    const badSpan = shaftSpanReason(spec.mode, bottom, top);
    if (badSpan) return refuse(badSpan);

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
    const badSpan = shaftSpanReason(carrier.mode, newBottom, newTop);
    if (badSpan) return refuse(badSpan);

    // Check only what is NEW, so a lift is never blocked by the rooms it
    // already legally serves.
    for (const [from, to] of [[newBottom, carrier.bottomFloor - 1], [carrier.topFloor + 1, newTop]]) {
      if (from > to) continue;
      const blocked = shaftObstruction(tower, {
        mode: carrier.mode, bottom: from, top: to, column: carrier.column,
      }, carrier.id);
      if (blocked) return refuse(blocked);
    }

    // ⚠️ Through `resizeCarrierSlots`, never by writing the two bounds. Eight
    // arrays are indexed off `bottomFloor`, and moving the bounds without them
    // gave the new floors no queue rings — a crash the moment a car stopped on
    // one — and renumbered every existing slot when the bottom dropped.
    resizeCarrierSlots(carrier, newBottom, newTop);
    tower.routeTablesDirty = true;
    return { ok: true, cost: 0, bottom: newBottom, top: newTop };
  },

  /**
   * Stairs or an escalator from `floor` to `floor + 1`. An overlay: nothing is
   * built under it and it is **free of floor charges**.
   */
  build_link({ tower, ledger }, { kind, floor, left }) {
    const spec = LINK_KIND[kind];
    if (!spec) return refuse('there is no "' + kind + '" to build');
    const locked = lockReason(tower, spec.cost, spec.label);
    if (locked) return refuse(locked);
    const stopped = linkObstruction(tower, { kind, floor, left });
    if (stopped) return refuse(stopped);

    const cost = CONSTRUCTION_COST[spec.cost];
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }
    const segment = createSegment({ kind, column: left + LINK_WIDTH / 2, entryFloor: floor, floorsSpanned: 1 });
    segment.left = left;
    tower.segments ??= [];
    // Reuse a bulldozed slot first: a route token names a segment by its index,
    // so removing from the middle of the array would re-point trips in flight.
    const free = tower.segments.findIndex((s) => !s?.active);
    const index = free >= 0 ? free : tower.segments.length;
    tower.segments[index] = segment;
    tower.routeTablesDirty = true;
    return { ok: true, cost, index, segment };
  },

  /** Bulldoze a link. Free, and the slot is kept (see `build_link`). */
  demolish_link({ tower }, { index }) {
    const segment = tower.segments?.[index];
    if (!segment?.active) return refuse('nothing there');
    segment.active = false;
    tower.routeTablesDirty = true;
    return { ok: true, freed: segment };
  },

  /** Add a car to an existing shaft. The one purchase that scales a route. */
  add_car({ tower, ledger }, { carrierId }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    const cost = carCostForMode(carrier.mode);
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
    // "Lobbies ... cannot be removed" (help file; the original's message is
    // "Cannot destroy this item"). It also keeps `transferFloors` honest.
    if (object.family === FAMILY.lobby) return refuse('lobbies cannot be removed');
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
    // `specs/ECONOMY.md` § Pricing Tiers: *"Condo (family 9) guard: rent level
    // can only be changed while unsold (`unit_status >= 0x18`)"*, restated in
    // `specs/COMMANDS.md` § price-change commands. The tier is the **sale
    // price**, and a condo's sale price is settled at the sale: without this a
    // player could sell at $40,000, re-tier to $200,000, and be refunded five
    // times what they were paid.
    if (object.family === FAMILY.condo && isUnitLet(object)) {
      return refuse('that condo is sold — you can only price one that is still for sale');
    }
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
 * ⚠️ Not simply `isRented(unitStatus)`, on two counts. `initialUnitStatus`
 * places every non-office, non-condo family in the open band — so a fast food
 * read as *let* from the instant it was built and could never be demolished,
 * which is a shop you are stuck with for the life of the tower. And a **sold
 * condo sits at the sync sentinel `0x10` overnight**, which is outside the
 * OFFICE's let band, so the office reading would let a player bulldoze a condo
 * they had been paid $150,000 for and keep the money — every night, between
 * dusk and the next morning's dispatch. {@link isUnitLet} is the per-family
 * band; it is the office's for every family that is not a condo.
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
  !COMMERCIAL_FAMILY_CODES.has(object.family) && isUnitLet(object);

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
