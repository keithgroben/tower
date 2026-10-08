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
  COMMERCIAL_FAMILY_CODES, FAMILY, GROUND_FLOOR, OBJECT_TYPE, SERVICE_FACILITY_FAMILIES, TILES_PER_FLOOR,
  floorExists, isSkyLobbyFloor, isStaffFamily, isUnitLet, placeObject, spanBlocked,
} from './state.js';
import {
  CARRIER_MODE, MAX_SERVED_SPAN, SCHEDULE_SLOTS, SHAFT_WIDTH, addCar, carrierSlotIndex, createCarrier,
  isExpressStopFloor, resizeCarrierSlots,
} from './elevators.js';
import {
  CONSTRUCTION_COST, carCostForMode, chargeConstruction, floorConstructionCost, placementCost,
} from './economy.js';
import { lockReason, notePlacement } from './progression.js';
import { MAX_SEGMENTS, createSegment, segmentTopFloor } from './routing.js';
import { createSimTripRecord } from './stress.js';
import {
  FAST_FOOD_WIDTH, RESTAURANT_WIDTH, RETAIL_WIDTH, finalizeCommercialVenue, venueOf,
} from './commercial.js';
import {
  FILM_PRICE, PARTY_HALL_WIDTH, THEATER_WIDTH, changeFilm, demolishEntertainment, entertainmentObstruction,
  filmChangeReason, filmTitle, isEntertainmentFamily, placeEntertainment, primaryOf,
} from './entertainment.js';
import { HOTEL_WIDTH } from './hotel.js';
import { HOUSEKEEPING_WIDTH } from './housekeeping.js';
import { GUARD_STATE, SECURITY_WIDTH, securityObstruction } from './security.js';
import { MEDICAL_WIDTH, finalizeMedicalCenter, medicalObstruction } from './medical.js';
import { RECYCLING_WIDTH, placeRecycling, recyclingObstruction } from './recycling.js';
import {
  PARKING_RAMP_WIDTH, PARKING_SPACE_WIDTH, answerParkingDemand, finalizeParkingSpace, parkingRampObstruction,
  parkingSpaceObstruction, rebuildParkingCoverage,
} from './parking.js';
import { clearDemand } from './demands.js';
import { METRO_FLOORS, METRO_WIDTH, belowMetroReason, metroObstruction, placeMetro } from './metro.js';
import { answerEvent, clearScars, maybeFindTreasure } from './events.js';
import {
  CATHEDRAL_BASE_FLOOR, CATHEDRAL_FLOORS, CATHEDRAL_WIDTH, cathedralFloorReason, cathedralObstruction, placeCathedral,
} from './cathedral.js';

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
   * **The evening venue** (issue #10): 3 stars, $200,000 (`economy.js`, keyed by
   * type `6`). It fills at dinner — `commercialGate`'s late window — and is
   * rebuilt at 1600 and closed at 2200, a clock of its own (`TIME.md` § 1600,
   * § 2200). Its closure payout is `-$6k / $4k / $6k / $10k` by the evening's
   * diners, so **a quiet restaurant loses money**.
   *
   * Width 24 is the reference implementation's unscaled `TILE_WIDTHS` (A36).
   */
  restaurant: {
    family: FAMILY.restaurant,
    type: OBJECT_TYPE.restaurant,
    cost: 'restaurant',
    width: RESTAURANT_WIDTH,
    label: 'Restaurant',
    finalize: finalizeCommercialVenue,
  },

  /**
   * **The retail shop** (issue #10): 3 stars, $100,000. Rented by its first
   * customer, it pays the priced row ($20k / $15k / $10k / $4k a quarter by rent
   * tier) and counts `+10` population while open; it earns nothing per visit.
   * Placed unrented — see `sim/commercial.js` `openRetailShop`. Width 12: A36.
   */
  retail: {
    family: FAMILY.retail,
    type: OBJECT_TYPE.retail,
    cost: 'retail',
    width: RETAIL_WIDTH,
    label: 'Retail Shop',
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

  /**
   * The three hotel rooms, `sim/hotel.js`. A guest checks in each evening and
   * out each morning, and the room is paid at checkout.
   *
   * `aboveGrade` is `specs/COMMANDS.md` verbatim: *"hotel rooms, offices, and
   * condos must be above grade (`floor > 0`) or reject with `0x0a`"*. Star gates
   * are `sim/progression.js`'s (single 2, twin and suite 3 — `spec/DEVIATIONS.md`
   * A27) and are checked ahead of the price like every other lock.
   *
   * TODO(parity): **no spec states a hotel's tile span**; 4 / 6 / 10 are the
   * reference *implementation*'s `TILE_WIDTHS`, taken unscaled — the same
   * source and the same choice as the condo's 16 and the fast food's 16.
   * `spec/DEVIATIONS.md` A26.
   */
  hotelSingle: {
    family: FAMILY.hotelSingle,
    type: OBJECT_TYPE.hotelSingle,
    cost: 'hotelSingle',
    width: HOTEL_WIDTH.hotelSingle,
    label: 'Single Room',
    aboveGrade: true,
  },
  hotelTwin: {
    family: FAMILY.hotelTwin,
    type: OBJECT_TYPE.hotelTwin,
    cost: 'hotelTwin',
    width: HOTEL_WIDTH.hotelTwin,
    label: 'Twin Room',
    aboveGrade: true,
  },
  hotelSuite: {
    family: FAMILY.hotelSuite,
    type: OBJECT_TYPE.hotelSuite,
    cost: 'hotelSuite',
    width: HOTEL_WIDTH.hotelSuite,
    label: 'Hotel Suite',
    aboveGrade: true,
  },

  /**
   * **Housekeeping**: six staff who clean the rooms guests have left. Two stars,
   * $50,000 and $10,000 a quarter (`specs/ECONOMY.md`), and it **cannot be
   * bulldozed** — see {@link demolishRefusal}. `sim/housekeeping.js` has the
   * whole account of what the staff do; they walk by stairs and service
   * elevators, so the facility is only as useful as the route from it to the
   * rooms.
   *
   * `aboveGrade`: the reference implementation's underground list (support,
   * transport, parking, recycling, a few public facilities) does not include
   * housekeeping, so it is built above the ground floor like the rooms it
   * serves. TODO(parity): no spec file states this; `spec/DEVIATIONS.md` A33.
   * The width is the implementation's unscaled 15 for the same reason (A26).
   */
  housekeeping: {
    family: FAMILY.housekeeping,
    type: OBJECT_TYPE.housekeeping,
    cost: 'housekeeping',
    width: HOUSEKEEPING_WIDTH,
    label: 'Housekeeping',
    aboveGrade: true,
  },
};

/**
 * **Security** (issue #12): six guards who fight fires and search for bombs, and
 * the facility the `2 -> 3` star gate is waiting for. Two stars, $100,000 and
 * $20,000 a pass (`specs/ECONOMY.md`), at most ten, and it **cannot be
 * bulldozed** - see {@link demolishRefusal}. `sim/security.js` has the account of
 * what the guards are and how they travel (the outside emergency stairs, never a
 * lift).
 *
 * `belowGrade`: `specs/COMMANDS.md` § Family-specific floor and stack rules,
 * verbatim - *"security office is basement-only"* (the original's string table
 * has "Item unavailable above ground" among its placement refusals). The width is the reference
 * implementation's unscaled 16 (A47); `occupantState` is the guards' `0x01`
 * (`specs/TIME.md` § 2500).
 */
BUILDABLE.security = {
  family: FAMILY.security,
  type: OBJECT_TYPE.security,
  cost: 'security',
  width: SECURITY_WIDTH,
  label: 'Security Office',
  belowGrade: true,
  occupantState: GUARD_STATE.onDuty,
};

/**
 * **The movie theater and the party hall** (issue #11): 3 stars, $500,000 and
 * $100,000. Each is a two-floor facility - `floor` is the lower half, `floor + 1`
 * the upper - and `placeEntertainment` builds both halves and the record they
 * share (`sim/entertainment.js`). `floors: 2` is what the price, the footprint
 * and the ghost read; `entertainment` names the kind.
 *
 * `aboveGrade`: *"`validate_floor_class_for_placement` rejects party hall and
 * cinema when `placement_floor < 1`"* (`ENTERTAINMENT.md` § Placement
 * Validation). Widths are the reference implementation's (A41).
 */
BUILDABLE.theater = {
  family: FAMILY.theater,
  type: OBJECT_TYPE.theaterUpper,
  cost: 'movieTheater',
  width: THEATER_WIDTH,
  label: 'Movie Theater',
  aboveGrade: true,
  floors: 2,
  entertainment: 'theater',
};
BUILDABLE.partyHall = {
  family: FAMILY.partyHall,
  type: OBJECT_TYPE.partyHallUpper,
  cost: 'partyHall',
  width: PARTY_HALL_WIDTH,
  label: 'Party Hall',
  aboveGrade: true,
  floors: 2,
  entertainment: 'partyHall',
};

/**
 * **The three things the tower demands back** (issue #13), all three stars:
 *
 *  - the **medical center**, $500,000, at most ten (`sim/medical.js`). Above grade:
 *    nothing in `specs/` says where it goes, and the office workers it serves are above
 *    the ground - TODO(parity), `spec/DEVIATIONS.md` A51;
 *  - the **recycling center**, $500,000 and $50,000 a pass (`specs/ECONOMY.md`), a
 *    two-floor stack below grade (`specs/COMMANDS.md`), unbulldozable
 *    (`demolishRefusal`), `sim/recycling.js`. `floor` is the LOWER floor;
 *  - **parking**: a space at $3,000 and a ramp at $50,000 (`specs/ECONOMY.md`), both
 *    below grade (`specs/COMMANDS.md`: *"parking-space, recycling-center, and parking
 *    ramps must be below grade"*), `sim/parking.js`.
 *
 * The key is the construction-cost name so `starClause` can tell whether a blocker
 * names something the palette can build (`isBuildable` in `ui/main.js`).
 */
BUILDABLE.medical = {
  family: FAMILY.medical,
  type: OBJECT_TYPE.medical,
  cost: 'medical',
  width: MEDICAL_WIDTH,
  label: 'Medical Center',
  aboveGrade: true,
  finalize: finalizeMedicalCenter,
};
BUILDABLE.recyclingCenter = {
  family: FAMILY.recycling,
  type: OBJECT_TYPE.recyclingUpper,
  cost: 'recyclingCenter',
  width: RECYCLING_WIDTH,
  label: 'Recycling Center',
  belowGrade: true,
  floors: 2,
  recycling: true,
};
BUILDABLE.parkingSpace = {
  family: FAMILY.parkingSpace,
  type: OBJECT_TYPE.parkingSpace,
  cost: 'parkingSpace',
  width: PARKING_SPACE_WIDTH,
  label: 'Parking Space',
  belowGrade: true,
  finalize: finalizeParkingSpace,
};
BUILDABLE.parkingRamp = {
  family: FAMILY.parkingRamp,
  type: OBJECT_TYPE.parkingRamp,
  cost: 'parkingRamp',
  width: PARKING_RAMP_WIDTH,
  label: 'Parking Ramp',
  belowGrade: true,
};

/**
 * **The metro station** (issue #15): four stars, $1,000,000 and $100,000 a pass
 * (`specs/ECONOMY.md`; the original's own build menu prints *"Metro Station -
 * $1000000"*, `spec/DEVIATIONS.md` A7), underground only, **one to a tower**, never
 * bulldozed, and nothing may be built under it. A three-floor stack, so `floor` is its
 * LOWEST floor and the grade rule is `gradeReason`'s: all three floors below ground.
 * `sim/metro.js` has the whole account, and what its commuters do.
 *
 * The key is the construction-cost name, which is how the star bar tells *"go and
 * build this"* from *"nothing builds one yet"* (`isBuildable` in `ui/main.js`).
 */
BUILDABLE.metroStation = {
  family: FAMILY.metro,
  type: OBJECT_TYPE.metroTop,
  cost: 'metroStation',
  width: METRO_WIDTH,
  label: 'Metro Station',
  belowGrade: true,
  floors: METRO_FLOORS,
  metro: true,
};

/**
 * **The cathedral** (issue #17): five stars, $3,000,000 (plus the floor tiles of its five
 * floors, as the metro's), **one to a tower**, **on the 100th floor and nowhere else**, never
 * bulldozed. A five-floor stack, so `floor` is its LOWEST floor and the one place it may
 * stand is `CATHEDRAL_BASE_FLOOR` - `gradeReason`'s rule, shared with the ghost.
 * `sim/cathedral.js` has the whole account, and the wedding that crowns the tower.
 *
 * The key is the construction-cost name, which is how the star bar tells *"go and build
 * this"* from *"nothing builds one yet"* (`isBuildable` in `ui/main.js`).
 */
BUILDABLE.cathedral = {
  family: FAMILY.cathedral,
  type: OBJECT_TYPE.cathedralSlice1,
  cost: 'cathedral',
  width: CATHEDRAL_WIDTH,
  label: 'Cathedral',
  floors: CATHEDRAL_FLOORS,
  onlyFloor: CATHEDRAL_BASE_FLOOR,
  cathedral: true,
};

/**
 * Why this buildable cannot go on this floor, or null: the grade rule, for the
 * seam and the ghost alike. `aboveGrade` is `specs/COMMANDS.md`'s "must be above
 * grade (`floor > 0`)"; `belowGrade` is its "basement-only" (`floor < 0`). One
 * definition, because the ghost used to restate the first and the matrix in
 * `test/build.test.js` exists to catch the day they drift.
 *
 * A two-floor thing is below grade only if **both** its floors are: a recycling
 * center clicked on B1 would put its upper half on the ground floor.
 */
export function gradeReason(spec, floor) {
  // The cathedral's one floor (issue #17): *"Cathedral is available only on 100th floor"*.
  if (spec.onlyFloor !== undefined && floor !== spec.onlyFloor) return cathedralFloorReason(floor);
  if (spec.aboveGrade && floor <= GROUND_FLOOR) {
    return 'a ' + spec.label.toLowerCase() + ' has to go above the ground floor';
  }
  const top = floor + (spec.floors ?? 1) - 1;
  if (spec.belowGrade && top >= GROUND_FLOOR) {
    return 'a ' + spec.label.toLowerCase() + ' has to go in the basement, below the ground floor'
      + (top > floor && floor < GROUND_FLOOR ? ' (it is ' + (top - floor + 1) + ' floors tall - click its lower floor)' : '');
  }
  return null;
}

/**
 * Why this buildable cannot stand here, or null: the one definition of "is the
 * ground free", for the seam and the ghost alike. A single-floor room needs its
 * span clear; an entertainment venue needs both floors clear and a free slot in
 * the 16-venue table.
 */
export function placementObstruction(tower, spec, floor, left) {
  // The metro is a stack of its own: one to a tower, and on the bottom floor.
  if (spec.metro) return metroObstruction(tower, floor, left);
  // The cathedral is a stack of its own: one to a tower, five clear floors.
  if (spec.cathedral) return cathedralObstruction(tower, floor, left);
  // *"Cannot place items under Metro"* (`specs/COMMANDS.md`, error `0x0e`): every other
  // placement, whatever it is, whatever floors it stands on.
  const under = belowMetroReason(tower, floor);
  if (under) return under;
  if (spec.entertainment) return entertainmentObstruction(tower, spec.entertainment, floor, left);
  // A center is two floors, and every one after the first has to stand beside one.
  if (spec.recycling) return recyclingObstruction(tower, floor, left);
  // The cap on security offices (`specs/COMMANDS.md`: 10 active placements).
  if (spec.family === FAMILY.security) {
    const full = securityObstruction(tower);
    if (full) return full;
  }
  if (spanBlocked(tower, floor, left, left + spec.width - 1)) return 'something is already built there';
  // Issue #13: the caps, and the ramp's way up to the lobby. After the ground check,
  // so a ramp dropped on a shop says the shop is in the way and not that there is no
  // lobby above it.
  if (spec.family === FAMILY.medical) return medicalObstruction(tower);
  if (spec.family === FAMILY.parkingSpace) return parkingSpaceObstruction(tower);
  if (spec.family === FAMILY.parkingRamp) return parkingRampObstruction(tower, floor, left);
  return null;
}

/** What a build costs: the facility, plus the floor tiles of every floor it stands on. */
export function buildCost(tower, spec, floor) {
  const base = placementCost(spec.cost, { tiles: spec.width, floor, lobbyHeight: tower.lobbyHeight });
  // Every further floor of a stack pays its own floor tiles (a theater has one more,
  // the metro two; `METRO.md`: the binary's cost is `3 x 30 x YEN[0]` of tiles plus the
  // per-object price, which is the `$1,000,000` here - A7).
  let total = base;
  for (let i = 1; i < (spec.floors ?? 1); i++) {
    total += floorConstructionCost({ floor: floor + i, tiles: spec.width, lobbyHeight: tower.lobbyHeight });
  }
  return total;
}

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
 * this check. The single hotel room joined it with issue #8 — **only the
 * single**, exactly as the list says; the twin and the suite are not on it.
 * The party hall and the cinema joined with issue #11 - all four halves, upper
 * and lower, since both are the one family here.
 */
export const ESCALATOR_UNDERLAY = new Set([
  FAMILY.lobby, FAMILY.restaurant, FAMILY.retail, FAMILY.fastFood, FAMILY.hotelSingle,
  FAMILY.theater, FAMILY.partyHall,
]);

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
  const under = belowMetroReason(tower, box.bottom);
  if (under) return under;
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
  // `METRO.md` § Placement Gates: `extend_carrier_down` rejects *"`target_floor <
  // g_metro_station_floor_index - 1`"*. A new shaft's bottom is the same question.
  const under = belowMetroReason(tower, spec.bottom);
  if (under) return under;
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

    const wrongGrade = gradeReason(spec, floor);
    if (wrongGrade) return refuse(wrongGrade);

    // The lobby goes on the ground and on the sky-lobby floors, nowhere else —
    // the original's own words: "Lobbys are only every 15 floors"
    // (`specs/COMMANDS.md`: the lobby-or-express-floor predicate).
    const wrongFloor = lobbyFloorReason(spec.family, floor);
    if (wrongFloor) return refuse(wrongFloor);

    const right = left + spec.width - 1;
    const blocked = placementObstruction(tower, spec, floor, left);
    if (blocked) return refuse(blocked);

    const cost = buildCost(tower, spec, floor);
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }

    const placed = spec.entertainment
      ? placeEntertainment(tower, { kind: spec.entertainment, floor, left }, () => createSimTripRecord())
      : spec.recycling
        ? placeRecycling(tower, { floor, left }, () => createSimTripRecord())
        : spec.metro
          ? placeMetro(tower, { floor, left }, () => createSimTripRecord())
          : spec.cathedral
            ? placeCathedral(tower, { floor, left }, () => createSimTripRecord())
            : placeObject(tower,
        { family: spec.family, type: spec.type, floor, left, right, occupantState: spec.occupantState },
        () => createSimTripRecord(),
        spec.finalize);
    if (!placed.ok) {
      ledger.cash += paid.cost;                       // nothing was built; refund
      return placed;
    }
    // Latch any star gate this placement satisfies, now rather than at the next
    // start of day — the reference sets these at placement.
    notePlacement(tower, spec.family);
    afterServiceBuilt(tower, spec.family);
    // Ground that burned or blew up is whole again once something is built on it, and the first
    // thing built on a new basement floor may strike treasure (issue #16, `sim/events.js`).
    clearScars(tower, floor, left, right);
    const treasure = maybeFindTreasure(tower, floor);
    // A sky lobby is a transfer point: the router needs to know the floor.
    if (spec.family === FAMILY.lobby && floor > GROUND_FLOOR) {
      tower.transferFloors ??= [];
      if (!tower.transferFloors.includes(floor)) tower.transferFloors.push(floor);
      tower.routeTablesDirty = true;
    }
    return { ok: true, cost, object: placed.object, ...(treasure ? { treasure } : {}) };
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

  // ----------------------------------------------------- the control panel
  //
  // Each of these writes one of the carrier's own schedule tables
  // (`specs/ELEVATORS.md` § Schedule Tables), which `tickCarriers` already reads:
  // `expressMode` steers an idle car, `dwellEnable` holds it at a stop,
  // `dispatchThreshold` is how far away a moving car may be and still answer a
  // call, `stopEnabled` is the per-floor switch. They are free, like the
  // original's panel. A slot is `daypart + 7 x weekend` (0..13).

  /** Local (0), express to the top (1) or express to the bottom (2) in one slot. */
  set_lift_schedule({ tower }, { carrierId, slot, mode }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    if (!Number.isInteger(slot) || slot < 0 || slot >= SCHEDULE_SLOTS) return refuse('there are 14 schedule slots, 0 to 13');
    if (![0, 1, 2].includes(mode)) return refuse('a schedule is local, express to the top, or express to the bottom');
    carrier.expressMode[slot] = mode;
    return { ok: true, slot, mode };
  },

  /** How long cars wait at a stop before leaving, in one slot. `0` leaves as soon as anyone is aboard. */
  set_lift_wait({ tower }, { carrierId, slot, value }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    if (!Number.isInteger(slot) || slot < 0 || slot >= SCHEDULE_SLOTS) return refuse('there are 14 schedule slots, 0 to 13');
    if (!Number.isInteger(value) || value < 0 || value > 255) return refuse('waiting time is a whole number from 0 to 255');
    carrier.dwellEnable[slot] = value;
    return { ok: true, slot, value };
  },

  /**
   * "Floors closer than moving cars": how many floors away a moving car may be
   * and still answer a call. One setting for the whole shaft, written to every
   * slot because the reference keeps the table per daypart and offers one box.
   */
  set_lift_response({ tower }, { carrierId, value }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    if (!Number.isInteger(value) || value < 1 || value > 30) return refuse('a response distance is 1 to 30 floors');
    carrier.dispatchThreshold.fill(value);
    return { ok: true, value };
  },

  /** Switch one floor on or off for every car in the shaft ("the Finger"). */
  set_lift_stop({ tower }, { carrierId, floor, enabled }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    if (carrier.mode === CARRIER_MODE.EXPRESS) return refuse('an express lift has fixed stops');
    const slot = carrierSlotIndex(carrier, floor);
    if (slot < 0) return refuse('that lift does not serve that floor');
    if (!enabled && (floor === carrier.bottomFloor || floor === carrier.topFloor)) {
      return refuse('the first and last floor of a lift cannot be switched off');
    }
    carrier.stopEnabled[slot] = enabled ? 1 : 0;
    tower.routeTablesDirty = true;
    return { ok: true, floor, enabled: Boolean(enabled) };
  },

  /** Where one car waits when it has nothing to do. Not for express lifts. */
  set_car_home({ tower }, { carrierId, car, floor }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    if (carrier.mode === CARRIER_MODE.EXPRESS) return refuse('an express lift has fixed waiting floors');
    const unit = carrier.cars[car];
    if (!unit) return refuse('that lift has no such car');
    if (carrierSlotIndex(carrier, floor) < 0) return refuse('that lift does not serve that floor');
    unit.homeFloor = floor;
    return { ok: true, car, floor };
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
    const refusal = demolishRefusal(object);
    if (refusal) return refuse(refusal);

    // An open shop is `+10` on the population ledger, taken back out with it.
    // Nothing else would: the 3-day sweep walks the shops that still stand, so a
    // demolished one's ten people would sit in the star thresholds for ever.
    // The recurring rent just stops; nothing is refunded for a stream that ended.
    if (object.family === FAMILY.retail && venueOf(object)?.availability !== 0xff && tower.populationLedger) {
      tower.populationLedger.retail = Math.max(0, (tower.populationLedger.retail ?? 0) - 10);
    }

    // A venue is two objects and one record: both halves go together, and the
    // population the record put on the ledger goes with them (the daily rebuild
    // would only correct it tomorrow).
    if (isEntertainmentFamily(object.family)) {
      const gone = demolishEntertainment(tower, object);
      const bucket = object.family === FAMILY.theater ? 'cinema' : 'partyHall';
      if (gone && tower.populationLedger && bucket in tower.populationLedger) {
        tower.populationLedger[bucket] = Math.max(0, tower.populationLedger[bucket] - gone.populationShare);
      }
      tower.routeTablesDirty = true;
      return { ok: true, freed: object };
    }

    tower.objects.delete(objectId);
    tower.actors = tower.actors.filter((a) => a.objectId !== objectId);
    tower.routeTablesDirty = true;
    // A garage changes shape when a space or a ramp goes: the ramps' reach is read
    // from what stands, so it is rebuilt from what is left. (A clinic needs nothing:
    // a worker bound for it finds it gone and says so - `sim/office.js`.)
    if (object.family === FAMILY.parkingSpace || object.family === FAMILY.parkingRamp) {
      rebuildParkingCoverage(tower);
    }
    return { ok: true, freed: object };
  },

  /**
   * **Pick a theater's film** (issue #11; `ENTERTAINMENT.md` § Cinema "New Movie"
   * Picker). `pool` is `'new'` ($300,000, the next new release) or `'classic'`
   * ($150,000, the next classic). Either half of the theater will do. The age
   * goes back to 0, so the next 240 rebuild reseeds from the freshest tier; the
   * day already in progress keeps the budget it has.
   */
  set_theater_film({ tower, ledger }, { objectId, pool }) {
    const object = tower.objects.get(objectId);
    if (!object) return refuse('nothing there');
    const record = primaryOf(tower, object)?.venue;
    if (!record) return refuse('that is not a movie theater');
    const why = filmChangeReason(record, pool);
    if (why) return refuse(why);

    const cost = FILM_PRICE[pool];
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('a ' + (pool === 'new' ? 'new release' : 'classic') + ' costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }
    const selector = changeFilm(record, pool);
    return { ok: true, cost, selector, title: filmTitle(selector) };
  },

  /**
   * **Answer the question the tower is asking** (issue #16): a bomb's ransom (`'pay'`, or
   * `'search'` for the guards to look) or a fire's helicopter (`'helicopter'`, $500,000, or
   * `'decline'`). The money moves in `sim/events.js` `answerEvent`; whether the answer can be
   * given - and in what words it is refused - is `answerRefusal`, which the dialog asks too.
   * An unanswered question is answered `'search'` / `'decline'` two ticks after it opens
   * (`EVENTS.md`: *"two ticks after ignition, the game resolves the rescue choice prompt"*); the
   * browser holds the clock still while the dialog is open.
   */
  answer_event({ tower }, { answer }) {
    return answerEvent(tower, answer);
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

/**
 * What building a service facility answers (issue #13). A clinic answers the
 * medical demand; a ramp or a space re-reads which spaces a ramp serves, and the
 * parking demand is answered if a driver could park now; a recycling center answers
 * the "needs a center" demand - whether it keeps up is the checkpoint's to say.
 */
function afterServiceBuilt(tower, family) {
  if (family === FAMILY.medical) clearDemand(tower, 'medical');
  if (family === FAMILY.recycling) clearDemand(tower, 'recycling');
  if (family === FAMILY.parkingSpace || family === FAMILY.parkingRamp) {
    rebuildParkingCoverage(tower);
    answerParkingDemand(tower);
  }
}

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
  !COMMERCIAL_FAMILY_CODES.has(object.family) && !isStaffFamily(object.family)
  && !isEntertainmentFamily(object.family) && !SERVICE_FACILITY_FAMILIES.has(object.family)
  && isUnitLet(object);

/**
 * Why this object cannot be demolished, or `null`. **The one definition** — the
 * seam asks it and so does the ghost, so the two cannot word a refusal
 * differently or disagree about whether one applies.
 *
 *  - *"Lobbies ... cannot be removed"* (help file; the original's message is
 *    "Cannot destroy this item"). It also keeps `transferFloors` honest.
 *  - **Housekeeping cannot be bulldozed**: the help file and the readme both list
 *    *"Lobbies, housekeeping, security, recycling, the metro and the cathedral"*
 *    as unremovable (`SimTower-gameplay-analysis.md`). It is not "let" — it has no
 *    tenant — so `hasTenant` would answer no and the wrong reason would be given;
 *    its staff are not tenants either, which is why `hasTenant` excludes them.
 *  - **Security cannot be bulldozed either** - the same list, and the help file's
 *    own sentence for it: *"Security offices cannot be removed once placed."*
 *    The same shape of rule, so the same place: a placed office stays placed,
 *    which is also what lets the `2 -> 3` gate be a latch rather than a count that
 *    a demolish-to-fail loop could pull back down.
 *  - a let unit: you drop the rent or you fix the lifts, you do not evict.
 *
 * An infested hotel room is none of these, which is the point of it: *"the only
 * cure is destroying the room"*.
 */
export function demolishRefusal(object) {
  if (object.family === FAMILY.lobby) return 'lobbies cannot be removed';
  if (object.family === FAMILY.housekeeping) return 'housekeeping cannot be bulldozed';
  if (object.family === FAMILY.security) return 'security offices cannot be bulldozed';
  // Issue #13: *"Lobbies, housekeeping, security, recycling, the metro and the
  // cathedral can't be bulldozed"* (the same help-file list). A clinic, a parking space
  // and a ramp are not on it.
  if (object.family === FAMILY.recycling) return 'recycling centers cannot be bulldozed';
  // Issue #15: the same list - *"Cathedral, Metro Station, Recycling centers"* (readme),
  // *"they cannot be removed"* (help file); the original's message is "Cannot destroy
  // this item". Any of the three floors: the stack stands whole or not at all.
  if (object.family === FAMILY.metro) return 'the metro station cannot be bulldozed';
  // Issue #17: *"Cathedrals cannot be bulldozed"* (help file), the readme's list, and the
  // original's "Cannot destroy this item". Any of the five floors: the stack stands whole.
  if (object.family === FAMILY.cathedral) return 'the cathedral cannot be bulldozed';
  if (hasTenant(object)) return 'that unit is let — you cannot evict a tenant';
  return null;
}

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
