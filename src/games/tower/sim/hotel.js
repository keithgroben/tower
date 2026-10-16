/**
 * Families 3 / 4 / 5 — hotel rooms. **The evening rhythm an office cannot give.**
 *
 * Spec: `specs/facility/HOTEL.md` in full; `specs/DEMAND.md` § Families 3/4/5
 * and `specs/PEOPLE.md` § Families `3`, `4`, `5` (gate and dispatch tables);
 * `specs/FACILITIES.md` § Facility Evaluation Model, § Noise Search, § Noise
 * Source Matching and § occupied_flag; `specs/ECONOMY.md` § Pricing Tiers;
 * `specs/TIME.md` § 0, § 1200, § 1600, § 2500.
 *
 * ## What a hotel is, next to the two families that already exist
 *
 * An office **rents** (a recurring payment while the tenant stays); a condo
 * **sells** (one payment, reversed if the unit fails). A hotel room is
 * **neither**: it is a nightly stay, and the money arrives *at checkout*
 * (`HOTEL.md`: *"Income is realized on checkout, not continuously"*). A guest
 * who checks in and cannot get out again has not paid.
 *
 * The day, as the gate tables draw it:
 *
 *   evening   (dayparts 4-5)  the guest rides lobby → room and **checks in**;
 *                             half the rooms then make an evening trip out
 *   night                     everyone waits in the room; the 2500 sweep puts
 *                             the room's guests back on the checkout path
 *   morning   (daypart 0 on)  the guest rides room → lobby and **checks out**;
 *                             the last one out pays, and the room goes **dirty**
 *
 * Both ends of the stay are real routes, so a hotel behind a lift that cannot
 * serve it is a room that never fills — and one whose lift fails overnight is a
 * guest who cannot leave and so never pays. That is the loop again: transport
 * decides who is staying.
 *
 * ## The dirty room, and who cleans it
 *
 * Checkout leaves the room in the **turnover band** (`0x28`/`0x30`) with its
 * occupancy latch cleared. `HOTEL.md` § Cockroach Infestation: such a room is
 * only returned to service by a housekeeping claim, and left alone for three
 * daily passes it is infested for good. This file owns the **bands** and the
 * 1600 pass that moves a room through them ({@link cleanHotelRoom},
 * {@link handleExtendedVacancyExpiry}, {@link spreadInfestation}); the staff who
 * walk to a dirty room and call {@link cleanHotelRoom} are `sim/housekeeping.js`
 * (issue #9). With no housekeeper a room earns exactly one stay, goes dirty, and
 * three daily passes later is infested — the reference's rule (`FACILITIES.md`
 * § occupied_flag: the latch is not set again for a room above `0x27`).
 * `spec/DEVIATIONS.md` A29, A35.
 */
import {
  EVAL_UNSET, FAMILY, HOTEL_UNIT_STATUS, baseState, enterTransit, isHotelFamily, isInTransit,
} from './state.js';
import { EVENING_DAYPART } from './clock.js';
import {
  FACILITY_POPULATION, computeObjectOperationalScore, resetFacilitySimTripCounters,
} from './stress.js';
// The shared halves of the evaluation pipeline, as `condo.js` takes them:
// `specs/FACILITIES.md` states steps 3, 4 and 6 once for every scored family.
import {
  LOBBY_FLOOR, NOISE_PENALTY, RENT_MODIFIER, RENT_TIER_ALWAYS_PASSES, evalLevelFor,
  noiseSourceWithin,
} from './office.js';
import {
  SLOT, acquireVenueSlot, minimumStayElapsed, releaseVenueSlot, selectVenue, venueOf,
} from './commercial.js';
import { emitsDistanceFeedback, shouldWaitForQueuedCarrier } from './routing.js';
import { parkSuiteGuest, unparkSuiteGuest } from './parking.js';

/**
 * Guest states, `specs/facility/HOTEL.md` § Key States and `specs/DEMAND.md`
 * § Families 3/4/5. `0x4x` is `0x0x` in transit and `0x6x` is `0x2x`; the
 * handlers are shared, which is why these are named for the base state only.
 */
export const HOTEL_STATE = {
  /** At the lobby, wanting to check in. **The booking point.** */
  seeking: 0x20,
  /** In the room, wanting an evening trip. Routes room → venue (or the lobby). */
  active: 0x01,
  /** Sibling sync. No route — bookkeeping only. */
  sync: 0x04,
  /** Checkout-ready. No route — picks the checkout countdown. */
  ready: 0x10,
  /** Heading for the lobby. **The payment point.** */
  checkout: 0x05,
  /** On the way back from the evening trip. `0x22` holds a venue slot, if any. */
  returning: 0x22,
};

/**
 * Tile span of a placed room, by its construction-cost name.
 *
 * TODO(parity): **no width for any facility appears anywhere in `specs/`.**
 * These are the reference *implementation's* `TILE_WIDTHS` (single 4, twin 6,
 * suite 10), the only place a number was recovered, taken unscaled — the same
 * source and the same choice as the condo's 16 and the fast food's 16.
 * `spec/DEVIATIONS.md` A26.
 */
export const HOTEL_WIDTH = { hotelSingle: 4, hotelTwin: 6, hotelSuite: 10 };

/** `specs/FACILITIES.md` § Noise Search: hotel rooms 20 tiles, office 10, condo 30. */
export const HOTEL_NOISE_RADIUS = 20;

/**
 * `specs/FACILITIES.md` § Noise Source Matching, the hotel row: *"restaurant (6),
 * office (7), retail (10), fast food (12), entertainment"*, with the note that
 * *"hotels do **not** count other hotels or condos as noise"*.
 *
 * **A hotel counts offices.** Combined with the 20-tile radius that is the whole
 * placement lesson of this family: a hotel built beside an office bank starts
 * 60 points into a 150-point failure budget before a single guest has taken a
 * trip. Entertainment joined with issue #11: a theater or a party hall on the same
 * floor within the radius is noise too.
 */
export const HOTEL_NOISE_FAMILIES = new Set([
  FAMILY.restaurant, FAMILY.office, FAMILY.retail, FAMILY.fastFood, FAMILY.theater, FAMILY.partyHall,
]);

// --------------------------------------------------------------- the bands

/** Is a guest checked in? `unit_status <= 0x17`, `HOTEL.md` § Placement. */
export const isHotelBooked = (object) =>
  isHotelFamily(object?.family) && object.unitStatus <= HOTEL_UNIT_STATUS.occupiedMax;

/** Vacant and ready for tonight's guest: `0x18..0x27`. */
export const isHotelVacant = (object) =>
  isHotelFamily(object?.family)
  && object.unitStatus > HOTEL_UNIT_STATUS.occupiedMax
  && object.unitStatus <= HOTEL_UNIT_STATUS.vacantMax;

/**
 * **The dirty-room flag housekeeping reads.** Checked out and waiting to be
 * cleaned: `unit_status` `0x28..0x37`.
 *
 * It is derived from the band rather than stored beside it, so the housekeeping
 * claimant's own test (*"a slot qualifies only when the room `unit_status` is
 * `0x28` or `0x30`"*) and this predicate can never disagree.
 *
 * **To clean a room** use {@link cleanHotelRoom}, which is the one writer.
 */
export const isHotelRoomDirty = (object) =>
  isHotelFamily(object?.family)
  && object.unitStatus >= HOTEL_UNIT_STATUS.dirtyEarly
  && object.unitStatus <= HOTEL_UNIT_STATUS.dirtyMax;

/** Infested: `0x38` and above. Written by {@link infestHotelRoom} and nothing else. */
export const isHotelInfested = (object) =>
  isHotelFamily(object?.family) && object.unitStatus >= HOTEL_UNIT_STATUS.infestedEarly;

// ------------------------------------------------- cleaning and cockroaches

/**
 * **A housekeeper has reached the room: clean it.**
 *
 * `HOUSEKEEPING.md` § Claim-completion writes and `HOTEL.md` § Occupancy Flag:
 * the claim takes a turnover-band room (`0x28`/`0x30`) back into the vacant
 * band — the same `0x18` before daypart 4 and `0x20` after that placement would
 * have chosen (`activate_selected_vacant_unit`, 1158:02e2) — and sets the
 * occupancy latch (*"set to `1` by the housekeeping helper ... at successful
 * claim promotion"*). The activation counter is cleared with it: the three-strike
 * count is a count of passes spent *dirty*.
 *
 * Only a **dirty** room is cleaned. The reference's `activate_selected_vacant_unit`
 * bails on anything outside `0x28`/`0x30`, which is how a second housekeeper who
 * walked to a room another had just cleaned finds nothing to do — and how an
 * infested room, past the dirty band, is never touched: *"the only cure is
 * destroying the room"*.
 *
 * The 1600 sweep scores the room and keeps or drops the latch as it always does;
 * this only gets a clean room back to the starting line.
 *
 * @returns {boolean} whether this call is the one that cleaned it
 */
export function cleanHotelRoom(tower, object) {
  if (!isHotelRoomDirty(object)) return false;
  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? HOTEL_UNIT_STATUS.vacantEarly
    : HOTEL_UNIT_STATUS.vacantLate;
  object.occupiedFlag = true;
  object.activationTickCount = 0;
  object.dirty = true;
  return true;
}

/**
 * Three dirty 1600 passes and the room is lost. `HOTEL.md` § Three-Strikes
 * Expiry: *"when `activation_tick_count` reaches `3`"*.
 */
export const INFESTATION_STRIKES = 3;

/**
 * **Cockroaches.** The room goes to the infested band — `0x38` before daypart 4,
 * `0x40` after — with its grade wiped and its latch off, and nothing in the sim
 * ever writes it back. `HOTEL.md` § State Band Summary: *"infested | no — must
 * destroy room"*.
 *
 * `spec/DEVIATIONS.md` A35 records the half-day value: `HOTEL.md` § Three-Strikes
 * Expiry words it the other way round (`0x40` pre-day-4), against `TIME.md`
 * § 1600 step 6 which toggles `0x38 -> 0x40` at the very checkpoint that writes
 * it. Every consumer reads the band, so the choice is invisible; this build uses
 * the convention of the other bands — early value before daypart 4.
 */
export function infestHotelRoom(tower, object) {
  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? HOTEL_UNIT_STATUS.infestedEarly
    : HOTEL_UNIT_STATUS.infestedLate;
  object.evalLevel = EVAL_UNSET;            // operational_score = 0xff
  object.occupiedFlag = false;              // pairing_pending_flag = 0
  object.dirty = true;
  return true;
}

/**
 * `handle_extended_vacancy_expiry`, `HOTEL.md` § Three-Strikes Expiry, for one
 * room. Only a room past the vacant band is examined (`unit_status > 0x27`), and
 * one already infested has nothing left to lose.
 *
 *  - latch set — a housekeeper has claimed it: the room is safe, and the grade,
 *    the counter and the latch are cleared;
 *  - latch clear: the counter goes up one, and at {@link INFESTATION_STRIKES} the
 *    room is infested.
 *
 * ⚠️ In this build the first branch is unreachable from play: checkout clears the
 * latch, the 1600 refresh skips dirty rooms and so leaves it clear, and a
 * housekeeper's claim moves the room *out* of the band this function looks at.
 * It is here because the reference has it, and a test reaches it by setting the
 * latch by hand.
 *
 * @returns {'safe'|'strike'|'infested'|null} what happened, or null if the room
 *   was not examined
 */
export function handleExtendedVacancyExpiry(tower, object) {
  if (!isHotelFamily(object?.family)) return null;
  if (object.unitStatus <= HOTEL_UNIT_STATUS.vacantMax) return null;
  if (isHotelInfested(object)) return null;

  if (object.occupiedFlag) {
    object.evalLevel = 0;                    // "clears eval_level"
    object.activationTickCount = 0;
    object.occupiedFlag = false;
    return 'safe';
  }
  object.activationTickCount += 1;
  if (object.activationTickCount < INFESTATION_STRIKES) return 'strike';
  infestHotelRoom(tower, object);
  return 'infested';
}

/**
 * `update_hotel_pair_stay_states`, `HOTEL.md` § Spread: **the infection moves to
 * the room on either side**, once a day, before the day's expiry check.
 *
 * The neighbours are the previous and next hotel room *placed on the same floor*
 * (`left` order). An office between two rooms stops it, which is the one
 * architectural defence the reference leaves.
 *
 * Three readings the spec leaves open, all in `spec/DEVIATIONS.md` A35:
 *
 *  - **One hop a day.** The source list is taken before anything is infected, so
 *    a room infected today infects nobody until tomorrow. The reference's scan
 *    ascends the floor and infects the *next* slot, which it then visits, so read
 *    literally one pass runs along a whole row — against the same section's own
 *    *"a newly infested room does not spread to its neighbors until the following
 *    day"*.
 *  - **A guest in the bed is left alone.** Infecting a booked room would write it
 *    out of the occupied band with its guests inside it: the stay could never be
 *    paid and the population ledger would keep two people nobody can check out.
 *    It is infected after they leave.
 *  - "Adjacent" is the next room in floor order, not a touching tile.
 *
 * @returns {number} rooms newly infested
 */
export function spreadInfestation(tower) {
  // Every object on the floor, not just the hotel rooms: an office between two
  // rooms is the neighbour, and it is not a hotel, so nothing crosses it.
  const byFloor = new Map();
  for (const object of tower.objects.values()) {
    const row = byFloor.get(object.floor);
    if (row) row.push(object); else byFloor.set(object.floor, [object]);
  }
  const sources = [];
  for (const row of byFloor.values()) {
    row.sort((a, b) => a.left - b.left);
    row.forEach((room, i) => { if (isHotelInfested(room)) sources.push({ row, i }); });
  }
  let spread = 0;
  for (const { row, i } of sources) {
    for (const neighbour of [row[i - 1], row[i + 1]]) {
      if (!isHotelFamily(neighbour?.family) || isHotelInfested(neighbour) || isHotelBooked(neighbour)) continue;
      infestHotelRoom(tower, neighbour);
      spread++;
    }
  }
  return spread;
}

/**
 * Step the stay counter, **inside the occupied band only**.
 *
 * `specs/PEOPLE.md` § Families 3,4,5 has guests `INC` and `DEC` `unit_status`
 * on most transitions and never says what happens at a band edge — the
 * reference stores an unsigned byte. We have to say, and the naive answer is
 * dangerous in the same way the condo's was (`sim/condo.js` `stepUnitStatus`):
 * a `DEC` on a checked-out room at `0x28` lands on `0x27`, which is **vacant** —
 * a dirty room cleaned for free, by arithmetic, with no housekeeper. So a room
 * that is not occupied is never stepped at all, and an occupied one is clamped
 * to `0..0x17`.
 *
 * The one special case is the reference's own `increment_stay_phase_345`: an
 * `INC` on the sync sentinel `0x10` does not make `0x11`, it restarts the count
 * at `1` (morning) or `9` (evening).
 *
 * @returns {boolean} whether the counter moved
 */
export function stepStay(tower, object, delta) {
  if (!isHotelBooked(object)) return false;
  if (delta > 0 && object.unitStatus === HOTEL_UNIT_STATUS.syncMarker) {
    object.unitStatus = tower.clock.daypart < EVENING_DAYPART ? 1 : 9;
  } else {
    object.unitStatus = Math.min(
      HOTEL_UNIT_STATUS.occupiedMax, Math.max(0, object.unitStatus + delta),
    );
  }
  object.dirty = true;
  return true;
}

// ----------------------------------------------------------- the evaluation

/** Is a hotel-qualifying noise source within 20 tiles on this room's floor? */
export const hotelNoiseNear = (tower, object) =>
  noiseSourceWithin(tower, object, HOTEL_NOISE_RADIUS, HOTEL_NOISE_FAMILIES);

/**
 * The hotel slice of `compute_object_operational_score`, `specs/FACILITIES.md`
 * § Facility Evaluation Model, in the reference's order:
 *
 *   1-2. average per-guest stress across the family's population (**1 / 2 / 2**)
 *   3.   pricing-tier modifier (tier 3 forces zero)
 *   4.   `+60` if a noise source is within 20 tiles
 *   5.   clamp to `>= 0`
 *
 * The divisor is `FACILITY_POPULATION[family]`, not `occupants.length`; a short
 * list throws rather than scoring a missing guest as calm.
 */
export function hotelScore(tower, object, occupants) {
  const base = computeObjectOperationalScore(occupants, FACILITY_POPULATION[object.family]);
  const priced = object.rentLevel === RENT_TIER_ALWAYS_PASSES
    ? 0
    : base + (RENT_MODIFIER[object.rentLevel] ?? 0);
  const noised = priced + (hotelNoiseNear(tower, object) ? NOISE_PENALTY : 0);
  return Math.max(0, noised);
}

/**
 * `recompute_object_operational_status`, the hotel slice.
 *
 * Two guards, both from `specs/FACILITIES.md`:
 *
 *  - the early-exit table: *"3/4/5 (hotel) | `unit_status > 0x37` | `0xffff`"* —
 *    an infested room is not scored at all;
 *  - § occupied_flag: *"For hotel rooms (families 3/4/5), this is further guarded
 *    by `unit_status <= 0x27` — hotels past that lifecycle phase do not set it
 *    even if their score is nonzero."* **This is the line that keeps a dirty
 *    room shut.** Without it a checked-out room scores a perfect 0 (it has taken
 *    no trips since the counters were wiped), re-latches itself, and re-lets
 *    tonight with nobody having cleaned it.
 *
 * A brand-new room has taken no trips, scores `0` — the *best* grade — and so
 * sets its own latch: the same bootstrap `sim/office.js` describes, and the way
 * the first guest of a room's life is allowed to try without any housekeeper.
 *
 * @returns {number} the `eval_level` written
 */
export function recomputeHotelOperationalStatus(tower, object, occupants) {
  if (object.unitStatus > HOTEL_UNIT_STATUS.dirtyMax) {
    object.evalLevel = EVAL_UNSET;
    return object.evalLevel;
  }
  const score = hotelScore(tower, object, occupants);
  object.evalLevel = evalLevelFor(score, tower.starCount);
  if (object.evalLevel !== 0 && object.evalLevel !== EVAL_UNSET
    && object.unitStatus <= HOTEL_UNIT_STATUS.vacantMax) {
    object.occupiedFlag = true;
  }
  return object.evalLevel;
}

/**
 * `refresh_occupied_flag_and_trip_counters` (`1138:0f79`), the daily hotel
 * refresh. `specs/FACILITIES.md` § occupied_flag gives the outline — *"cleared ...
 * when `refresh_occupied_flag_and_trip_counters` finds no A-rated donor for a
 * failing unit. Re-set daily for hotels"* — and the three branches are the
 * reference implementation's reading of the binary:
 *
 *   A. `eval_level` is 1 or 2   → latch set, trip counters cleared (the next
 *                                 24 hours are measured fresh);
 *   B. `eval_level` is 0 and a same-family neighbour on the same floor is
 *      A-rated (2)              → both are pulled to 1, both latched, counters
 *                                 cleared: a failing room is carried by a good
 *                                 one beside it, once;
 *   C. `eval_level` is 0, no donor → latch **cleared**, counters kept. The room
 *                                 takes no guest tonight, and keeps the history
 *                                 that failed it.
 *
 * The hotel's only form of "closure" is branch C: there is no deactivation, no
 * refund, and a guest already in residence is never evicted — the room simply
 * stops accepting new ones. `spec/DEVIATIONS.md` A30.
 */
export function refreshHotelOccupiedFlag(tower, object, occupants) {
  if (object.evalLevel !== EVAL_UNSET && object.evalLevel >= 1) {
    object.occupiedFlag = true;
    resetFacilitySimTripCounters(occupants);
    return 'measured';
  }
  if (object.evalLevel === 0) {
    for (const other of tower.objects.values()) {
      if (other.id === object.id || other.family !== object.family) continue;
      if (other.floor !== object.floor || other.evalLevel !== 2) continue;
      other.evalLevel = 1;
      other.occupiedFlag = true;
      object.evalLevel = 1;
      object.occupiedFlag = true;
      resetFacilitySimTripCounters(occupants);
      return 'carried';
    }
    object.occupiedFlag = false;
    return 'closed';
  }
  return 'unscored';
}

/** Every hotel room in the tower, with its guests. */
export function hotelRooms(tower) {
  const out = [];
  for (const object of tower.objects.values()) {
    if (!isHotelFamily(object.family)) continue;
    out.push({ object, occupants: tower.actors.filter((a) => a && a.objectId === object.id) });
  }
  return out;
}

/** Checkpoint 1600, and the tick the evening's check-in window opens on. */
export const HOTEL_SWEEP_TICK = 1600;

/**
 * Checkpoint 1600 — `specs/TIME.md` § 1600 steps 2 and 3, the hotel rows.
 *
 * In the order `HOTEL.md` § Execution Order At Checkpoint `0x640` gives:
 *
 *   1. **spread** existing infestations ({@link spreadInfestation}) — before the
 *      expiry check, which is why a room infested today waits a day to spread;
 *   2. for each room, **recompute** its grade and then run the **three-strikes
 *      expiry** ({@link handleExtendedVacancyExpiry}) — *"for each hotel room:
 *      `recompute_object_operational_status`; `handle_extended_vacancy_expiry`"*;
 *   3. then for each room, **refresh** the latch and the trip counters, which
 *      reads grades the second step wrote (the donor search).
 *
 * A room in the dirty band (`unit_status >= 0x28`) is skipped by the last pass
 * and **keeps the latch it has** — in `HOTEL.md`'s words the reference's own pass
 * *"keeps its current `occupied_flag`"* — so a dirty room stays shut, and the
 * strike that step 2 gave it is the only thing that happens to it today.
 *
 * 1600 is also where the evening starts: this runs on the very tick the
 * check-in window opens, so a room built during the day is eligible tonight.
 *
 * Housekeeping staff stop claiming at tick 1500 (`HOUSEKEEPING.md` § state `3`),
 * so by the time this runs a room is either clean or about to take a strike.
 *
 * @returns {{scored: number, carried: number, closed: number,
 *   spread: number, struck: number, infested: number}}
 */
export function hotelMiddaySweep(tower) {
  const report = { scored: 0, carried: 0, closed: 0, spread: 0, struck: 0, infested: 0 };
  report.spread = spreadInfestation(tower);

  const rooms = hotelRooms(tower);
  for (const { object, occupants } of rooms) {
    recomputeHotelOperationalStatus(tower, object, occupants);
    const verdict = handleExtendedVacancyExpiry(tower, object);
    if (verdict === 'strike') report.struck++;
    else if (verdict === 'infested') report.infested++;
  }

  for (const { object, occupants } of rooms) {
    if (object.unitStatus >= HOTEL_UNIT_STATUS.dirtyEarly) continue;
    const outcome = refreshHotelOccupiedFlag(tower, object, occupants);
    if (outcome === 'measured') report.scored++;
    else if (outcome === 'carried') report.carried++;
    else if (outcome === 'closed') report.closed++;
  }
  return report;
}

// ----------------------------------------------------- check-in and checkout

/**
 * `activate_family_345_unit` (`1180:0e72`) — the room becomes occupied.
 *
 * `HOTEL.md` § Occupancy Flag: *"If the room is in a vacant band ... activation
 * resets `unit_status` to occupied-band base value `0x00` or `0x08`, depending
 * on the current half-day branch; the room is marked dirty; the room
 * contributes back into the population ledger."* Only the vacant band is
 * activated, so the other guest of a twin finds the room already occupied and
 * adds nothing, and the **dirty** band is not activated at all — a checked-out
 * room cannot be re-let by a guest who happens to route to it.
 *
 * Fired when the guest **arrives** at the room's floor, not when the route is
 * merely accepted. `HOTEL.md`: *"the check-in route must actually succeed; a
 * room does not become occupied merely because it was claimed structurally"*, and
 * `PEOPLE.md`'s row books on result `3`. The reference implementation also
 * activates in the en-route branch (`1228:33ba`), and that is the one place this
 * build parts company with it, on purpose: our router will accept a **first
 * leg** of a journey it cannot finish (a stairs flight toward a floor nothing
 * else reaches), and a room booked by a guest who then fails the second leg is a
 * room full of nobody that can never check out — population on the books, no
 * payment ever. Booking on arrival leaves that guest unbooked at the lobby, where
 * the rest of the failing-route machinery already deals with them.
 * `spec/DEVIATIONS.md` A32.
 *
 * **The suite's car** (issue #13). `specs/facility/PARKING.md` § Demand Families
 * names *"hotel suites (family `0x05`)"* among the consumers of parking, and the help
 * file says an occupied suite must also have a parking space. The guests arrive with
 * a car: it takes a space a ramp serves (`sim/parking.js` `parkSuiteGuest`), and a
 * tower with none says *"Hotel Suite guests demand Parking"*. The booking is never
 * refused over it - what the original does to a suite it cannot park for is not in
 * the sources, and a penalty would be ours to invent. The car leaves at checkout.
 * `spec/DEVIATIONS.md` A54.
 *
 * @returns {boolean} whether this call is the one that booked the room
 */
export function activateHotelRoom(tower, object, ctx) {
  if (!isHotelVacant(object)) return false;
  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? HOTEL_UNIT_STATUS.occupiedEarly
    : HOTEL_UNIT_STATUS.occupiedLate;
  object.activationTickCount = 0;
  object.dirty = true;
  if (object.family === FAMILY.hotelSuite) parkSuiteGuest(tower, object);
  ctx?.onCheckIn?.(tower, object);
  return true;
}

/**
 * **`deactivate_family_hotel_unit_with_income` (`1180:0f24`) — the payment.**
 *
 * `HOTEL.md` § Checkout effects, in order: the payout is realized exactly once
 * by the room, from the family row and `rent_level`; the cumulative sale count
 * goes up; the room moves to the turnover band (`0x28` before daypart 4, `0x30`
 * after); *"the occupancy latch and activation counter are cleared so the room
 * can be reassigned on a later cycle"*; population comes back out.
 *
 * The money and the population live in `sim/ledger-adapter.js` behind
 * `ctx.onCheckout`, the same way the condo's sale does — it is the only module
 * that knows both vocabularies.
 */
export function checkoutHotelRoom(tower, object, ctx) {
  if (!isHotelBooked(object)) return false;
  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? HOTEL_UNIT_STATUS.dirtyEarly
    : HOTEL_UNIT_STATUS.dirtyLate;
  object.occupiedFlag = false;
  object.activationTickCount = 0;
  object.dirty = true;
  if (object.family === FAMILY.hotelSuite) unparkSuiteGuest(tower, object);
  recordHotelSale(tower);
  ctx?.onCheckout?.(tower, object);
  return true;
}

/**
 * `family345_sale_count` and `newspaper_trigger`, `HOTEL.md` § Checkout
 * effects: *"`1` on every 2nd checkout while `family345_sale_count < 20`, then on
 * every 8th checkout thereafter, else `0`"*. The popup itself is not emitted
 * here — *"the next cash-display refresh that sees both `cash_report_dirty_flag
 * != 0` and `newspaper_trigger != 0` shows popup `0x271d`"* — and this build has
 * no popup yet, so the trigger is computed and left for one to read.
 */
export function recordHotelSale(tower) {
  tower.hotelSaleCount = (tower.hotelSaleCount ?? 0) + 1;
  const n = tower.hotelSaleCount;
  tower.newspaperTrigger = (n < 20 && n % 2 === 0) || (n >= 20 && n % 8 === 0) ? 1 : 0;
  return tower.newspaperTrigger;
}

/** Checkpoint 1200 — `specs/TIME.md` § 1200 step 1: the day's sale count resets. */
export const HOTEL_SALE_RESET_TICK = 1200;
export function hotelSaleCountReset(tower) {
  tower.hotelSaleCount = 0;
}

// ------------------------------------------------------------ room rank

/**
 * The room's rank among the hotel rooms on its floor, left to right.
 *
 * `specs/PEOPLE.md` says a check-in arrival goes to *"`0x01` or `0x04`"* without
 * saying which. The reference implementation settles it from a trace: the choice
 * is the parity of the room's floor-local index, *"confirmed via emulator
 * watchpoint on the IDIV at 1228:3493 (every occupant of a given room shares the
 * same subtype ...)"* — it splits **rooms**, not guests. An even rank goes on to
 * the evening trip (`0x01`); an odd rank goes straight to the sync (`0x04`).
 *
 * TODO(parity): the reference's index is the floor-local object id, which
 * counts every object on the floor; the implementation counts hotel rooms only.
 * Ours follows the implementation. `spec/DEVIATIONS.md` A28.
 */
export function hotelRoomRank(tower, object) {
  let rank = 0;
  for (const other of tower.objects.values()) {
    if (other.floor === object.floor && isHotelFamily(other.family) && other.left < object.left) rank++;
  }
  return rank;
}

/** Where a guest goes the moment it is in the room. */
export const arrivalStateFor = (tower, object) =>
  ((hotelRoomRank(tower, object) & 1) === 0 ? HOTEL_STATE.active : HOTEL_STATE.sync);

// ------------------------------------------------------------- the gate

/**
 * The gate. `specs/PEOPLE.md` § Families 3,4,5 § Gate Table, which
 * `specs/DEMAND.md` § Families 3/4/5 § Gate Table (*"Binary-Verified"*) agrees
 * with, and `HOTEL.md` § Checkout Timing restates.
 *
 * Returns `'dispatch'`, `'hold'`, or a state byte to write directly — the `0x01`
 * row's *"daypart > 4: force state → 0x04"* is how a guest still in the room
 * when the evening gets late is pushed into the sync without taking a trip.
 *
 * ⚠️ **No calendar-phase condition anywhere in this table.** An office will not
 * commute on a weekend (`office.js`), and a condo's venue trip changes for
 * resident 0; the hotel rows mention neither. Hotels take guests every night of
 * the quarter, which is the point of a hotel.
 */
export function hotelGate(actor, object, clock, rng) {
  const state = baseState(actor.state);
  const { daypart, dayTick } = clock;

  switch (state) {
    case HOTEL_STATE.seeking:                                    // 0x20
      // *"if `room.pairing_pending_flag != 0`"* — the occupancy latch, which is
      // the same byte as `occupied_flag` (`+0x14`). Held clear on a dirty room.
      if (!object.occupiedFlag) return 'hold';
      // A suite a VIP has reserved takes nobody else (issue #16, `sim/events.js`). The hold is
      // the booking: the VIP is not a guest of this room's own, so the room's guests simply
      // wait until the visit is over.
      if (object.vipHold) return 'hold';
      if (daypart === 4) return chance(rng, 12);
      // *"daypart > 4 and tick < 2300 → dispatch; tick >= 2300 → no dispatch"*.
      return daypart > 4 && dayTick < 2300 ? 'dispatch' : 'hold';

    case HOTEL_STATE.active:                                     // 0x01
      if (daypart === 4) return chance(rng, 6);
      return daypart > 4 ? HOTEL_STATE.sync : 'hold';

    case HOTEL_STATE.returning:                                  // 0x22
      return daypart >= 4 ? 'dispatch' : 'hold';

    case HOTEL_STATE.sync:                                       // 0x04
      if (daypart < 5) return 'hold';
      return dayTick > 2400 ? 'dispatch' : chance(rng, 12);

    case HOTEL_STATE.ready:                                      // 0x10
      if (daypart < 5) return 'dispatch';
      return dayTick > 2566 ? chance(rng, 12) : 'hold';

    case HOTEL_STATE.checkout:                                   // 0x05
      if (daypart === 0) return chance(rng, 12);
      return daypart === 6 ? 'hold' : 'dispatch';

    default:
      return 'hold';
  }
}

const chance = (rng, n) => (rng.chance(n) ? 'dispatch' : 'hold');

// ------------------------------------------------------------ the dispatch

/**
 * The dispatch handler. `specs/PEOPLE.md` § Families 3,4,5 § Dispatch Table.
 *
 * `ctx` supplies the seams this module deliberately does not own:
 *   `resolveRoute(tower, actor, from, to, clock, options)` → routing
 *   `onCheckIn(tower, object)`  → the ledger adapter: population `+1` / `+2`
 *   `onCheckout(tower, object)` → the ledger adapter: the stay's payout, population back out
 *   `onDelay(delay, actor)`     → the stress pipeline
 */
export function hotelDispatch(tower, actor, object, clock, ctx) {
  switch (baseState(actor.state)) {
    case HOTEL_STATE.seeking: return seekingDispatch(tower, actor, object, clock, ctx);
    case HOTEL_STATE.active: return errandDispatch(tower, actor, object, clock, ctx);
    case HOTEL_STATE.returning: return returningDispatch(tower, actor, object, clock, ctx);
    case HOTEL_STATE.sync: return syncDispatch(actor, object);
    case HOTEL_STATE.ready: return readyDispatch(actor, object);
    case HOTEL_STATE.checkout: return checkoutDispatch(tower, actor, object, clock, ctx);
    default: return { moved: false };
  }
}

function resolve(tower, actor, from, to, clock, ctx, state) {
  const result = ctx.resolveRoute(tower, actor, from, to, clock, {
    passengerRoute: true,
    // Asked of `sim/routing.js`, which owns the table for every family: hotels
    // charge the long-distance penalty on `0x20`, `0x01` and `0x05` and not on
    // the two returns.
    emitDistanceFeedback: emitsDistanceFeedback(actor.family, state),
    // The router takes the actor and does not echo it onto the delay. Binding
    // it here is the only place that knows whose delay this is; reading
    // `delay.actor` on the far side silently drops every one of them.
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  return typeof result === 'object' && result !== null ? result : { code: result };
}

/**
 * A walked leg (`1`) lands the guest on the segment's far landing; the next
 * stride re-resolves from there. `sim/routing.js` says so and leaves the caller
 * to move the actor — a guest left at its old anchor would ask for the same leg
 * again for ever.
 */
function noteLocalLeg(actor, result) {
  if (result.code === 1 && Number.isInteger(result.legDestination)) {
    actor.anchorFloor = result.legDestination;
  }
}

/** Where this guest stands now: its recorded floor, or the room it lives in. */
const standingOn = (actor, object) => actor.anchorFloor ?? object.floor;

/**
 * `0x20` / `0x60` — **check-in.** The route that books the room.
 *
 * | route result | effect |
 * |---|---|
 * | `-1` | the room is not activated; the guest stays at the lobby and tries again |
 * | `0` / `1` / `2` | the guest is on its way: `0x60`. The room is **not** booked yet |
 * | `3` | the guest is at the room: it is activated (if vacant), the stay counter steps, and the guest is in: `0x01` or `0x04` |
 *
 * `HOTEL.md`: *"guest check-in requires an actual route from the lobby to the
 * room floor; if no valid route exists, the guest does not activate the room and
 * the room stays outside the occupied band."* A room above the top of the lift
 * therefore never fills — measured, in `test/hotel.test.js`. The arrival that
 * books it is {@link checkIn}, reached from here on a same-floor answer and from
 * {@link hotelArrival} when a lift delivers the guest.
 */
function seekingDispatch(tower, actor, object, clock, ctx) {
  const continuing = isInTransit(actor.state);
  // The guest starts the evening in the lobby, not where its record was
  // anchored (placement anchors every occupant to its own object's floor).
  // Reading that here routed the room to itself and answered same-floor, and
  // every guest teleported into bed without touching a lift.
  if (!continuing) actor.anchorFloor = LOBBY_FLOOR;
  const from = standingOn(actor, object);

  const result = resolve(tower, actor, from, object.floor, clock, ctx, HOTEL_STATE.seeking);
  const code = result.code;

  if (code === -1) {
    actor.state = HOTEL_STATE.seeking;
    actor.routeCarrier = null;
    actor.spawnFloor = null;
    return { moved: false, code, booked: false };
  }

  noteLocalLeg(actor, result);
  if (code === 3) {
    const booked = checkIn(tower, actor, object, ctx);
    return { moved: true, code, booked };
  }
  actor.state = enterTransit(HOTEL_STATE.seeking);
  return { moved: true, code, booked: false };
}

/**
 * The guest is in the room: book it if it was vacant, step the counter, and go
 * where the room's rank says. Activation comes first, so the count reads `0` or
 * `8` and then `1` or `9` — the order the reference gives.
 *
 * @returns {boolean} whether this guest is the one that booked the room
 */
function checkIn(tower, actor, object, ctx) {
  actor.anchorFloor = object.floor;
  const booked = activateHotelRoom(tower, object, ctx);
  stepStay(tower, object, +1);
  actor.state = arrivalStateFor(tower, object);
  return booked;
}

/**
 * `0x01` / `0x41` — **the evening trip.** `PEOPLE.md`: *"Call
 * `decrement_unit_status_345`. Route to commercial venue"*, with `0/1/2 → 0x41`,
 * `3 → 0x22` and *"fail → `increment_unit_status` → 0x04"*.
 *
 * The `DEC` is on the **base** state, so it fires once when the leg starts and
 * not on every continuation stride — the same idiom as the condo's `0x01`.
 *
 * ## Where a guest goes, and the fallback
 *
 * `HOTEL.md` § Family `0x21` lists the venues hotel traffic uses; for the room
 * itself the reference implementation's `HOTEL_ROOM_SELECTOR` is the
 * **restaurant** alone. No restaurant can be built yet (issue #10), which is the
 * common case in a young tower, and the reference's answer is the same one the
 * office gets (`OFFICE.md` § Route to Lobby Fails): with nothing to go to, the
 * destination reads back as the lobby, and the guest takes the real round trip.
 *
 * ⚠️ The destination is `null`-safe: `venueObjectId` is `null`, never `-1`,
 * because our floors are logical and `-1` is B1. `CLAUDE.md`'s first entry.
 * `spec/DEVIATIONS.md` A28.
 */
function errandDispatch(tower, actor, object, clock, ctx) {
  if (actor.state === HOTEL_STATE.active) {
    stepStay(tower, object, -1);
    const venue = selectVenue(tower, FAMILY.restaurant, object.floor);
    actor.venueObjectId = venue ? venue.id : null;
    actor.errandFloor = venue ? venue.floor : LOBBY_FLOOR;
  }
  const to = actor.errandFloor ?? LOBBY_FLOOR;

  const result = resolve(tower, actor, standingOn(actor, object), to, clock, ctx, HOTEL_STATE.active);
  const code = result.code;

  if (code === -1) {
    stepStay(tower, object, +1);
    actor.venueObjectId = null;
    actor.state = HOTEL_STATE.sync;
    return { moved: false, code };
  }
  noteLocalLeg(actor, result);
  if (code === 3) return arriveAtErrand(tower, actor, clock, ctx);
  actor.state = enterTransit(HOTEL_STATE.active);
  return { moved: true, code };
}

/**
 * Standing on the errand's floor: take a slot, or wait, or write the venue off.
 * The same four answers `sim/office.js`'s `claimLunchSlot` gives, and for the
 * same reasons — **busy is not failure** (a popular venue is a wait, not a
 * 300-tick no-route penalty), and an unavailable one falls through without a
 * slot (`HOTEL.md`: *"invalid or closed venues fall through to `0x22` without
 * holding a slot"*).
 */
function arriveAtErrand(tower, actor, clock, ctx) {
  actor.anchorFloor = actor.errandFloor ?? LOBBY_FLOOR;
  const venueObject = actor.venueObjectId == null ? null : tower.objects.get(actor.venueObjectId) ?? null;
  if (!venueObject) {
    actor.venueObjectId = null;
    actor.state = HOTEL_STATE.returning;       // the lobby trip: nothing held, nothing to wait for
    return { moved: true, code: 3, claimed: false };
  }
  const outcome = acquireVenueSlot(venueOf(venueObject), actor, clock, venueObject.family);
  if (outcome === SLOT.full) {
    actor.state = enterTransit(HOTEL_STATE.active);
    return { moved: false, code: 3, claimed: false };
  }
  if (outcome === SLOT.unavailable) {
    ctx.onDelay?.({ kind: 'invalid-venue' }, actor);
    actor.venueObjectId = null;
  }
  actor.state = HOTEL_STATE.returning;
  return { moved: true, code: 3, claimed: outcome === SLOT.acquired };
}

/**
 * `0x22` / `0x62` — **the way back.** `PEOPLE.md`: *"Release venue slot, route
 * back"*, `0/1/2 → 0x62`, *"3 → `increment_unit_status` → 0x04"*, *"fail →
 * 0x04"*.
 *
 * A held slot is released only once the venue's minimum stay has elapsed
 * (`HOTEL.md` § Minimum venue stay: 60 ticks), and **before** the route is asked
 * for — a guest who is leaving must stop occupying the venue even if the trip
 * home cannot be resolved. A failure here is not undone with an `INC`: the
 * table writes none for this row, unlike the `0x01` row above it.
 */
function returningDispatch(tower, actor, object, clock, ctx) {
  const continuing = isInTransit(actor.state);
  if (!continuing) {
    if (actor.venueEnteredTick != null) {
      const venueObject = tower.objects.get(actor.venueObjectId);
      if (venueObject && !minimumStayElapsed(actor, clock)) return { moved: false };
      releaseVenueSlot(venueOf(venueObject), actor, clock, { skipDwellGate: true });
    }
    actor.venueObjectId = null;
  }

  const result = resolve(tower, actor, standingOn(actor, object), object.floor, clock, ctx, HOTEL_STATE.returning);
  const code = result.code;

  if (code === -1) {
    actor.state = HOTEL_STATE.sync;
    return { moved: false, code };
  }
  noteLocalLeg(actor, result);
  if (code === 3) {
    actor.anchorFloor = object.floor;
    stepStay(tower, object, +1);
    actor.state = HOTEL_STATE.sync;
    return { moved: true, code };
  }
  actor.state = enterTransit(HOTEL_STATE.returning);
  return { moved: true, code };
}

/**
 * `0x04` — sibling sync. No route.
 *
 * `PEOPLE.md`: *"State → 0x10. `sync_unit_status_if_all_siblings_ready_345`:
 * family 3 shortcut when `unit_status & 7 == 1`; otherwise the helper requires
 * the sibling set to be ready before writing `unit_status = 0x10`."*
 *
 * ⚠️ The shortcut is guarded on the **occupied band** and is **family 3 only**.
 * The band guard is the condo's lesson (`sim/condo.js` `syncDispatch`): a vacant
 * room at `0x19` satisfies `& 7 == 1` just as readily, and writing `0x10` there
 * would book it. The family guard follows `PEOPLE.md`; `HOTEL.md` states the
 * shortcut for every hotel, but for a twin it would fire the moment ONE guest is
 * in the room and rewrite the checkout count to 2 for a room with one person to
 * check out — a stay that could then never pay.
 *
 * TODO(parity): the *else* branch (all siblings at `0x10`) is not implemented —
 * no spec line says which field `try_set_parent_state_in_transit_if_all_slots_transit`
 * writes. It costs nothing observable: the 2500 sweep clamps every occupied room
 * to `0x10` anyway. `spec/DEVIATIONS.md` A30.
 */
function syncDispatch(actor, object) {
  actor.state = HOTEL_STATE.ready;
  if (object.family === FAMILY.hotelSingle && isHotelBooked(object) && (object.unitStatus & 7) === 1) {
    object.unitStatus = HOTEL_UNIT_STATUS.syncMarker;
    object.dirty = true;
  }
  return { moved: false };
}

/**
 * `0x10` — checkout-ready. No route. `PEOPLE.md`: *"If `unit_status == 0x10`:
 * family 3 → `unit_status = 1`; family 4/5 → `unit_status = 2`. State → 0x05."*
 *
 * Exactly `0x10`, the sentinel, and not "anything in the occupied band" — the
 * second guest of a twin finds the count already rewritten and must leave it.
 */
function readyDispatch(actor, object) {
  if (object.unitStatus === HOTEL_UNIT_STATUS.syncMarker) {
    object.unitStatus = object.family === FAMILY.hotelSingle ? 1 : 2;
    object.dirty = true;
  }
  actor.state = HOTEL_STATE.checkout;
  return { moved: false };
}

/**
 * `0x05` / `0x45` — **checkout.** The route that pays.
 *
 * `PEOPLE.md`: *"`decrement_unit_status_345`. If `unit_status & 7 == 0`:
 * checkout ... Route to lobby"*, `0/1/2 → 0x45`, `3 → 0x20`. `HOTEL.md` § Room-
 * route requirement ends on the rule that makes this a transport game:
 * *"checkout likewise requires the physical room-to-lobby route; the payout is
 * tied to the checkout completion path, not a purely logical end-of-day
 * despawn."*
 *
 * So the route is asked for **first**, and a refusal changes nothing: the count
 * is not stepped, the room is not paid, and the guest stays in `0x05` and tries
 * again. (The reference implementation orders it the same way: decrement and pay
 * only once the route is accepted.) The last guest out is the one whose
 * decrement reaches zero — which is how a twin pays once, for two people.
 *
 * Only the base `0x05` steps the count. The in-transit `0x45` that follows is
 * the same trip continuing, and stepping it again would check a twin out twice.
 */
function checkoutDispatch(tower, actor, object, clock, ctx) {
  const starting = actor.state === HOTEL_STATE.checkout;
  const result = resolve(tower, actor, standingOn(actor, object), LOBBY_FLOOR, clock, ctx, HOTEL_STATE.checkout);
  const code = result.code;

  if (code === -1) return { moved: false, code, paid: false };

  let paid = false;
  if (starting && stepStay(tower, object, -1) && (object.unitStatus & 7) === 0) {
    paid = checkoutHotelRoom(tower, object, ctx);
  }
  noteLocalLeg(actor, result);
  if (code === 3) {
    leaveForTheNight(actor);
  } else {
    actor.state = enterTransit(HOTEL_STATE.checkout);
  }
  return { moved: true, code, paid };
}

/** Out of the building: back to waiting for the next evening. */
function leaveForTheNight(actor) {
  actor.anchorFloor = LOBBY_FLOOR;
  actor.routeCarrier = null;
  actor.state = HOTEL_STATE.seeking;
}

// ------------------------------------------------------------- the handler

/**
 * The handler the scheduler calls, once per serviced guest.
 *
 * The gate is a one-time barrier: once a guest is in transit (`>= 0x40`) it is
 * dispatched every stride until the leg completes — unless it is standing in a
 * carrier queue, in which case it is left alone. `sim/office.js` carries the
 * full account of why: re-asking the router while queued re-stamps the route
 * start, so the wait being accrued is thrown away and stress reads far better
 * than it is.
 */
export function hotelFamilyHandler(ctx) {
  return function serviceHotelGuest(tower, actor) {
    const object = tower.objects.get(actor.objectId);
    if (!object || !isHotelFamily(object.family)) return;

    if (actor.state >= 0x40) {
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      return void hotelDispatch(tower, actor, object, tower.clock, ctx);
    }

    const verdict = hotelGate(actor, object, tower.clock, tower.rng);
    if (verdict === 'hold') return;
    if (verdict === 'dispatch') return void hotelDispatch(tower, actor, object, tower.clock, ctx);
    actor.state = verdict;              // a gate that rewrites state without dispatching
  };
}

/**
 * The floor a guest's current leg ends on, or `null` when it is not on a leg.
 * A carrier delivers at every stop of a transfer, not only the last one, and
 * "arrived" has to mean "arrived where I was going".
 */
function legTarget(actor, object) {
  switch (baseState(actor.state)) {
    case HOTEL_STATE.seeking:
    case HOTEL_STATE.returning: return object.floor;
    case HOTEL_STATE.active: return actor.errandFloor ?? LOBBY_FLOOR;
    case HOTEL_STATE.checkout: return LOBBY_FLOOR;
    default: return null;
  }
}

/**
 * A guest got off a lift (or finished a walked leg).
 *
 * Arriving by car and arriving on foot are the same event to the state machine —
 * only the journey differed — so these are the transitions the `3` rows give in
 * the dispatch above. Without this a guest enters `0x60`, is dispatched every
 * stride, re-resolves the route it is already on, and never gets into bed.
 *
 * A stop that is not the leg's last (a sky-lobby transfer) only moves the guest:
 * it stays in transit and the next stride routes the next leg from where it now
 * stands.
 *
 * The evening trip's own arrival is deliberately **not** resolved here. Dropping
 * to the same-floor case and letting the next stride's dispatch answer `3` runs
 * the slot-claim branch that is written once, in {@link arriveAtErrand}; claiming
 * a slot from an arrival handler with no `ctx` would be a second copy of those
 * answers, and the second copy is the one that drifts.
 */
export function hotelArrival(tower, actor, floor, ctx = null) {
  const object = tower.objects.get(actor.objectId);
  actor.anchorFloor = floor;
  actor.routeCarrier = null;
  if (!object) { actor.state = baseState(actor.state); return; }

  const target = legTarget(actor, object);
  if (target !== null && floor !== target) return;       // a transfer stop; keep going

  switch (baseState(actor.state)) {
    case HOTEL_STATE.seeking: checkIn(tower, actor, object, ctx); break;
    case HOTEL_STATE.returning:
      stepStay(tower, object, +1);
      actor.state = HOTEL_STATE.sync;
      break;
    case HOTEL_STATE.checkout: leaveForTheNight(actor); break;
    default: break;                  // the errand: the next dispatch claims the slot
  }
}

// ------------------------------------------------------------ the night

/** `specs/TIME.md` § 2500 — the nightly runtime refresh. */
export const HOTEL_RESET_TICK = 2500;

/**
 * The hotel rows of checkpoint 2500, which are two separate passes in
 * `specs/TIME.md` and both matter:
 *
 *   step 2, **reset sim state**: *"3/4/5 (hotel): state-word == 0 → `0x24`;
 *   `unit_status` ≤ 0x17 → `0x10`; else → `0x20`. Clear `spawn_floor`,
 *   `route_carrier`"* — a guest in an occupied room goes to checkout-ready, and
 *   a guest of an empty one goes back to waiting to check in. The first clause
 *   is the phantom primary slot, which this build does not model (A25).
 *
 *   step 4, **object-state floor pass**: *"hotel (3/4/5): state < 0x18 → set
 *   0x10"* — every occupied room is clamped to the sync sentinel, which is what
 *   re-seeds the checkout count (`readyDispatch`) the next morning. **This is
 *   the step that carries a guest overnight**: the evening's `INC`/`DEC`
 *   bookkeeping is thrown away at 2500 and the morning starts the count afresh.
 *
 * A guest **in transit is skipped**, as the condo's is: our carriers hold their
 * own queue of rider ids, and dropping the rider's state here would not cancel
 * the ride, it would leave a passenger the car still intends to deliver while
 * the sweep pretends they are home. Their leg finishes, {@link hotelArrival}
 * moves them on, and the next night's sweep collects them.
 *
 * A guest caught at a venue also holds a slot, which has to go back: the
 * commercial rebuild zeroes occupancy anyway, but a leak that heals overnight is
 * exactly the kind that is hard to see.
 */
export function hotelDailyReset(tower) {
  for (const { object, occupants } of hotelRooms(tower)) {
    const booked = isHotelBooked(object);

    for (const guest of occupants) {
      if (guest.state >= 0x40) continue;
      if (guest.venueEnteredTick != null) {
        const venueObject = tower.objects.get(guest.venueObjectId);
        releaseVenueSlot(venueOf(venueObject), guest, tower.clock, { skipDwellGate: true });
      }
      guest.venueObjectId = null;
      // Cleared here, not left to the release: a record that has gone leaves the
      // release returning early, and a stale stamp reads as "still holding one".
      guest.venueEnteredTick = null;
      guest.errandFloor = null;
      guest.state = booked ? HOTEL_STATE.ready : HOTEL_STATE.seeking;
      guest.spawnFloor = null;
      guest.routeCarrier = null;
      guest.anchorFloor = object.floor;
    }

    if (booked && object.unitStatus !== HOTEL_UNIT_STATUS.syncMarker) {
      object.unitStatus = HOTEL_UNIT_STATUS.syncMarker;
      object.dirty = true;
    }
  }
}
