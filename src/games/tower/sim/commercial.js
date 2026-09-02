/**
 * Families 6 / 0x0c / 10 — the commercial venues. **Fast food is the one the
 * office loop needs.**
 *
 * Spec: `specs/DEMAND.md` § Families 6/0x0c (gate table), § Family 10;
 * `specs/facility/COMMERCIAL.md` (the venue record, capacity, selection,
 * closure payouts); `specs/FACILITIES.md` § Commercial Readiness.
 *
 * ## Why this file exists
 *
 * `specs/facility/OFFICE.md` § Daily Worker Simulation lists the effects a
 * faithful office must produce, and one of them had nowhere to go:
 *
 * > *offices create midday traffic toward fast-food businesses*
 *
 * `sim/office.js` had a `TODO(parity)` where that traffic should be — a worker
 * who would go to lunch simply stayed at work. So a third of the trips the
 * lifts must carry did not exist, and the bottleneck the player plays against
 * was lighter than the real one. This module is the destination half of those
 * trips.
 *
 * ## A venue is two halves, and keeping them apart is the point
 *
 * `COMMERCIAL.md` § Venue Record: *"Retail 'is this shop rented/open?' is not
 * the same field as the venue record's occupancy/performance state."* So a
 * placed object carries a **linked venue record** — capacity, occupancy,
 * visitor counts, availability — and the two are never read for each other.
 * `state.js` owns the object; this file owns the record.
 *
 * ## The commercial loop, which turns out to be the office loop again
 *
 * 1. A venue's daily capacity comes from its **phase-A seed**, capped by the
 *    type's tuning limit and floored at `10` (§ Capacity, daily recompute).
 * 2. Each customer that completes a round trip grows that seed by `2` if its
 *    stress was under 80, by `1` under the star threshold, `0` otherwise.
 * 3. Tomorrow's capacity is what today's customers earned.
 * 4. The day's visitor count picks the closure payout band —
 *    `-$3,000 / $2,000 / $3,000 / $5,000` at 25 / 35 / 50 visitors.
 *
 * So a fast food behind a bad lift loses money for the same reason an office
 * behind one loses its tenant: the people could not get there. One quantity,
 * measured from real trips, drives the outcome. That is the loop, again.
 *
 * ## ⚠️ Fast food is type `0x0c`, not `6`
 *
 * `sim/state.js` used to map `fastFood` to family `6`, and `sim/economy.js`
 * has always priced `0x06` as the Restaurant ($200,000) and `0x0c` as Fast
 * Food ($100,000). `sim/ledger-adapter.js` spotted the clash and said it was
 * "not this file's to fix". It is this one's: `COMMERCIAL.md` § Included Types
 * is triple-checked against the construction string table, and building a
 * "fast food" that priced as a restaurant is exactly the two-vocabularies trap
 * `CLAUDE.md` keeps a list of. Both codes now exist, and they mean what the
 * reference says they mean.
 */
import {
  FAMILY, GROUND_FLOOR, placeObject, zoneBand,
} from './state.js';
import { DAY_ADVANCE_TICK } from './clock.js';
// Imported directly rather than taken through `ctx`, for the reason
// `sim/office.js` gives about the same function: a ctx entry with a permissive
// default is a thing that can be forgotten, and forgetting THIS one makes every
// queued customer re-resolve its route and throw away the wait it is accruing.
import { emitsDistanceFeedback, shouldWaitForQueuedCarrier } from './routing.js';
import { computeRuntimeTileStressAverage } from './stress.js';
// The star-rated evaluation thresholds. `specs/FACILITIES.md` § Thresholds By
// Star Rating is one rule and `sim/office.js` already owns it; a second copy
// here is how a threshold ends up right in one family and wrong in the next.
// The import is circular — office.js needs this file's venue slots — and safe,
// because neither module reads the other at module scope.
import { EVAL_THRESHOLD_LOWER, evalUpperFor } from './office.js';

/** The lobby. Logical floor 0 — the reference's EXE floor 10. */
export const LOBBY_FLOOR = GROUND_FLOOR;

/**
 * The three commercial families. `COMMERCIAL.md` § Included Types:
 * restaurant `6`, retail `10` (`0x0a`), fast food `12` (`0x0c`).
 *
 * Families 6 and 0x0c share one gate handler (`1228:466d`) that branches on the
 * **placed type**; retail has its own (`1228:3ed9`) with the same timing as
 * fast food. That is why one gate function below serves all three.
 */
export const COMMERCIAL_FAMILIES = new Set([FAMILY.restaurant, FAMILY.fastFood, FAMILY.retail]);

/**
 * Runtime sims a placed venue owns. `COMMERCIAL.md` § Role: *"restaurant (6):
 * 48 sim slots ... retail (10): 48 ... fast food (12): 48"*.
 *
 * TODO(parity): `specs/DEMAND.md` § Families 6/0x0c opens *"1 entity per
 * venue"*, which contradicts it. Going with 48: `COMMERCIAL.md`'s count is
 * given per family with the linked-record allocation beside it, and the
 * reference implementation allocates 48 as well. The number is load-bearing —
 * these sims are the venue's customers, and the daily capacity limit is what
 * decides how many of the 48 actually travel. With one, capacity could never
 * bind and the whole readiness model would be inert. Recorded as
 * `spec/DEVIATIONS.md` A15.
 */
export const VENUE_SIM_SLOTS = 48;

/**
 * Tile span of a placed venue.
 *
 * TODO(parity): no width for any facility appears anywhere in `specs/`. This
 * is the reference *implementation*'s `TILE_WIDTHS`, which is the only place a
 * number was recovered. (It also says an office is 9 tiles where
 * `facility/OFFICE.md` says 6 and this repo says 6 — that disagreement is
 * older than this file and is left alone.) `spec/DEVIATIONS.md` A16.
 */
export const FAST_FOOD_WIDTH = 16;

/**
 * `COMMERCIAL.md` § Availability. `-1` is the reference's "invalid or stale"
 * and is deliberately **not** modelled as a number here: our floors are
 * logical, `-1` is B1, and a sentinel that can be mistaken for real data is the
 * hazard `CLAUDE.md` names first. Absent record === invalid.
 */
export const VENUE = {
  /** available / empty */
  available: 0,
  /** partially occupied — 1..9 active */
  partial: 1,
  /** near-full — 10 or more active */
  nearFull: 2,
  /** closed by the off-hours sweep; selectors and acquire both reject it */
  closed: 3,
  /** dormant / inactive — never opened, or deactivated */
  dormant: 0xff,
};

/** Occupancy bands, § Availability: the 1st occupant partials, the 10th fills. */
export const NEAR_FULL_OCCUPANTS = 10;
/** *"venues with more than 39 active occupants return an over-capacity wait"*. */
export const MAX_ACTIVE_OCCUPANTS = 39;

/** Slot-acquisition answers. Names, not numbers — the reference's `-1` is a floor here. */
export const SLOT = { acquired: 'acquired', full: 'full', unavailable: 'unavailable' };

/**
 * `COMMERCIAL.md` § Phase A/B/Override Trigger, per-type tuning table:
 * `[phase A, phase B, override]` capacity ceilings.
 */
export const CAPACITY_CAPS = {
  [FAMILY.restaurant]: [35, 50, 25],
  [FAMILY.fastFood]: [35, 50, 25],
  [FAMILY.retail]: [25, 30, 18],
};

/** *"floor capacity at 10"*, and the seed every new venue starts all three phases at. */
export const CAPACITY_FLOOR = 10;

/**
 * *"venue release is blocked until the family-specific minimum-stay timer has
 * elapsed"* — 60 ticks for all three types in § Phase A/B/Override Trigger's
 * tuning table.
 */
export const MINIMUM_STAY = 60;

/**
 * Visitor-count bands, § Income. The same three thresholds pick the closure
 * payout and the derived performance state, which is why they are one list.
 */
export const VISITOR_BANDS = [25, 35, 50];

/** § Income, closure cash by band. Band 0 is a **real loss**, not zero income. */
export const CLOSURE_PAYOUT = {
  [FAMILY.restaurant]: [-6_000, 4_000, 6_000, 10_000],
  [FAMILY.fastFood]: [-3_000, 2_000, 3_000, 5_000],
  // *"retail always uses derived state 0"* and its income is the recurring
  // priced row instead, so closure pays nothing.
  [FAMILY.retail]: [0, 0, 0, 0],
};

/**
 * Which daily rebuild a family belongs to. § Capacity: fast food and retail
 * rebuild at daypart 0; restaurants use a separate midday pass.
 */
export const REBUILD_TICK = 240;
export const RESTAURANT_REBUILD_TICK = 1600;
/** The off-hours closure sweep, which is where the day's income is realized. */
export const CLOSURE_TICK = 2000;
export const RESTAURANT_CLOSURE_TICK = 2200;

/** Night parking releases here, exactly as the office's does. */
export const NIGHT_RELEASE_TICK = DAY_ADVANCE_TICK;

/**
 * Customer states. `specs/DEMAND.md` § Families 6/0x0c: only three, and note
 * `0x20` is **not** the office's `0x20` — for a venue customer it means
 * "waiting at the lobby to come up", not "waiting to be employed".
 */
export const VENUE_STATE = {
  /** At the lobby. The gate decides when this customer comes up. */
  arriving: 0x20,
  /** At the venue. Dwells, then goes home. */
  leaving: 0x05,
  /** Done for the day. */
  parked: 0x27,
};

// ------------------------------------------------------------ the record

/**
 * The linked venue record. `COMMERCIAL.md` § Venue Record.
 *
 * Initialization is the spec's: *"every new venue starts with all three
 * capacity seed bytes set to 10; the currently active phase seed is
 * immediately cleared so the next recompute repopulates it; enabled-link
 * venues start with `active_capacity_limit = 10` and `yesterday_visit_count =
 * 10`"*.
 */
export function createVenueRecord({ activePhase = 'a' } = {}) {
  const seeds = { a: CAPACITY_FLOOR, b: CAPACITY_FLOOR, override: CAPACITY_FLOOR };
  seeds[activePhase] = 0;
  return {
    kind: 'commercial_venue',
    availability: VENUE.available,
    /** Today's ceiling on visitors. Recomputed daily from the phase-A seed. */
    activeCapacityLimit: CAPACITY_FLOOR,
    /** Ticks down as customers commit to a visit. The gate reads it. */
    remainingCapacity: CAPACITY_FLOOR,
    /** § Capacity step 5's "negative capacity marker". Derived, never set by hand. */
    eligibilityThreshold: -(CAPACITY_FLOOR + 1),
    /** How many people are inside right now. Drives the availability band. */
    currentPopulation: 0,
    /** Visitors acquired today. **This is what the closure payout is keyed on.** */
    acquireCount: 0,
    /** Visits committed today; rolls into `yesterdayVisitCount` and the population ledger. */
    todayVisitCount: 0,
    yesterdayVisitCount: CAPACITY_FLOOR,
    /** Per-phase capacity seeds. Grown by completed trips, cleared by the rebuild. */
    seeds,
    /** Performance grade 0..3 from the day's visitors. See {@link venueDerivedState}. */
    derivedState: 0,
  };
}

/**
 * The family-specific placement finalizer. `COMMERCIAL.md` § Role: *"the clone
 * should model commercial placement as creating both halves immediately: the
 * placed object and its linked venue-side record."*
 *
 * Passed to `placeObject` rather than built into it, because `sim/state.js` is
 * the spine and has no business knowing what a venue is.
 */
export function finalizeCommercialVenue(tower, object) {
  if (!COMMERCIAL_FAMILIES.has(object.family)) return object;
  object.venue = createVenueRecord({ activePhase: activePhaseOf(tower) });
  return object;
}

/** Place a commercial venue and give it both halves. */
export function placeCommercialVenue(tower, placement, makeTripFields) {
  return placeObject(tower, placement, makeTripFields, finalizeCommercialVenue);
}

/** The linked record for a placed object, or `null` when there is not one. */
export const venueOf = (object) => (object?.venue?.kind === 'commercial_venue' ? object.venue : null);

/** Every commercial object in the tower that has a record, with it. */
export function commercialVenues(tower, families = COMMERCIAL_FAMILIES) {
  const out = [];
  for (const object of tower.objects.values()) {
    if (!families.has(object.family)) continue;
    const record = venueOf(object);
    if (record) out.push({ object, record });
  }
  return out;
}

// ------------------------------------------------------------- readiness

/**
 * The performance grade, `COMMERCIAL.md` § Income: *"restaurant and fast-food
 * threshold levels are 25, 35, and 50 ... both map visitor counts into 4
 * derived-state slots"*. `0` is the loss band.
 */
export const venueDerivedState = (visitors) =>
  VISITOR_BANDS.reduce((band, threshold) => (visitors >= threshold ? band + 1 : band), 0);

/**
 * **Commercial readiness is customer count, not occupant stress.**
 *
 * `specs/FACILITIES.md` § Commercial Readiness: *"Commercial families
 * (restaurant 6, retail 10, fast food 12) use a separate readiness model based
 * on customer count from the commercial-venue sidecar record."* An office is
 * graded on how its six workers' trips went; a shop is graded on how many
 * people came. Running `computeObjectOperationalScore` over a venue's 48
 * customers would be the office model wearing a shop's clothes.
 *
 * TODO(parity): the reference never says how the commercial derived state maps
 * onto the office `eval_level` grades, and nothing in this build needs it to —
 * the 2533 sweep walks offices only. So `object.evalLevel` is deliberately left
 * unset rather than given an invented mapping. `spec/DEVIATIONS.md` A17.
 */
export function recomputeCommercialReadiness(record) {
  record.derivedState = venueDerivedState(record.acquireCount);
  return record.derivedState;
}

/** Closure cash for one venue-day. § Income. Negative in the lowest band. */
export const closurePayout = (family, visitors) =>
  (CLOSURE_PAYOUT[family] ?? [0, 0, 0, 0])[venueDerivedState(visitors)];

// -------------------------------------------------------------- capacity

/**
 * `COMMERCIAL.md` § Phase A/B/Override Trigger. The override applies *"only
 * during the first half of every 5th day in each 8-day cycle, while the tower
 * is below 4-star rank"*.
 *
 * TODO(parity): the spec keeps this as a flag set at tick 0 and cleared at
 * 1600. Nothing in this build reads it outside the daily rebuild, which runs
 * at tick 240 — inside that window either way — so it is computed rather than
 * latched. If a second reader ever appears the latch has to come with it.
 */
export const facilityProgressOverride = (dayCounter, starCount) =>
  dayCounter % 8 === 4 && starCount < 4;

/** Which seed column today writes to: override, then calendar phase B, else A. */
export function activePhaseOf(tower) {
  const { dayCounter = 0, calendarPhase = false } = tower?.clock ?? {};
  if (facilityProgressOverride(dayCounter, tower?.starCount ?? 1)) return 'override';
  return calendarPhase ? 'b' : 'a';
}

/**
 * The daily capacity recompute, `COMMERCIAL.md` § Capacity. Fast food and
 * retail only; restaurants have their own midday pass.
 *
 * ⚠️ **Capacity comes from the phase-A seed whatever the active phase is**, and
 * the active phase is the one that gets cleared. It reads like a bug and it is
 * the reference's: the seed a day's customers grow is the active column, and
 * only phase A is ever spent. Under *faithful first* it stays, and it is why a
 * calendar-phase day cannot cash in the growth it earns.
 *
 * Step 7 — *"add the previous day's visit count into the population ledger"* —
 * comes back in `visitors`, keyed by family, as a **total rather than a delta**.
 * The reference clears each family's bucket and re-adds every record's count on
 * the same pass, so the bucket is always the whole of yesterday; returning a
 * running increment instead would grow it for ever and quietly inflate the star
 * thresholds that read it.
 *
 * @returns `{rebuilt, visitors}` — the caller owns the ledger; `sim/` does not
 *   know what one is.
 */
export function rebuildCommercialVenues(tower, families = null) {
  const phase = activePhaseOf(tower);
  const target = families ?? new Set([FAMILY.fastFood, FAMILY.retail]);
  const visitors = {};
  for (const family of target) visitors[family] = 0;
  let rebuilt = 0;

  for (const { object, record } of commercialVenues(tower, target)) {
    // Step 1: reopen valid venues. A dormant one stays dormant — it was never
    // opened, or it was deactivated, and reopening it here would be the
    // "measured but unreached" hole in a shop's clothes.
    if (record.availability !== VENUE.dormant) record.availability = VENUE.available;

    // Steps 2-5: seed -> cap -> floor -> write, plus the negative gate marker.
    const caps = CAPACITY_CAPS[object.family];
    let capacity = record.seeds.a;
    if (caps && capacity > caps[0]) capacity = caps[0];
    if (capacity < CAPACITY_FLOOR) capacity = CAPACITY_FLOOR;
    record.activeCapacityLimit = capacity;
    record.remainingCapacity = capacity;
    record.eligibilityThreshold = -(capacity + 1);

    // Steps 6-8: roll the visit counters, then hand yesterday's to the ledger.
    record.yesterdayVisitCount = record.todayVisitCount;
    visitors[object.family] = (visitors[object.family] ?? 0) + record.yesterdayVisitCount;
    record.todayVisitCount = 0;
    record.acquireCount = 0;
    // Whoever was still inside at midnight is not inside any more. This is
    // also what cleans up a worker whose evening gate forced it home while it
    // still held a slot — the reference leaks the same slot and sweeps it here.
    record.currentPopulation = 0;

    record.seeds[phase] = 0;
    rebuilt++;
  }
  return { rebuilt, visitors };
}

/**
 * The off-hours closure sweep, `COMMERCIAL.md` § Income: *"daily closure
 * accrues income for non-retail commercial types, then derives the
 * visible/performance state from the day's visitor count"*, and *"closure
 * moves every live venue to availability state 3"*.
 *
 * `onIncome(object, dollars)` is optional and is the only way money leaves
 * here — the amount can be **negative**, which is the spec's own wording:
 * *"the lowest restaurant and fast-food bands are true losses"*.
 */
export function closeCommercialVenues(tower, { onIncome } = {}, families = null) {
  const target = families ?? new Set([FAMILY.fastFood, FAMILY.retail]);
  let closed = 0;

  for (const { object, record } of commercialVenues(tower, target)) {
    if (record.availability === VENUE.dormant) continue;
    recomputeCommercialReadiness(record);
    const dollars = closurePayout(object.family, record.acquireCount);
    if (dollars !== 0) onIncome?.(object, dollars);
    record.availability = VENUE.closed;
    object.dirty = true;
    closed++;
  }
  return closed;
}

/**
 * A completed customer round trip grows the venue's seed for the active phase.
 *
 * The increment is the customer's own stress against the same thresholds an
 * office is graded by: `2` under 80, `1` under the star threshold, `0` above
 * it. **This is the commercial half of the loop** — a venue behind a good lift
 * earns capacity, a venue behind a bad one is floored at 10 for ever.
 *
 * The thresholds are `sim/office.js`'s, imported rather than restated: they are
 * one rule (`specs/FACILITIES.md` § Thresholds By Star Rating) and this is the
 * second reader, which is exactly when a rule starts drifting.
 */
export function growVenueSeed(tower, record, actor) {
  const caps = CAPACITY_CAPS[actor?.family] ?? CAPACITY_CAPS[FAMILY.fastFood];
  const phase = activePhaseOf(tower);
  const stress = computeRuntimeTileStressAverage(actor);
  const upper = evalUpperFor(tower?.starCount ?? 1);
  const increment = stress < EVAL_THRESHOLD_LOWER ? 2 : stress < upper ? 1 : 0;
  record.seeds[phase] = Math.min(record.seeds[phase] + increment, caps[0]);
  return record.seeds[phase];
}

// ----------------------------------------------------------- venue slots

/**
 * `acquire_commercial_venue_slot`. `COMMERCIAL.md` § Availability,
 * slot-acquisition rules, in order:
 *
 * - invalid or closed venues fail immediately
 * - more than 39 active occupants returns an over-capacity **wait**, which is
 *   not the same answer as no route and must not be priced as one
 * - the first occupant moves the venue to partial, the tenth to near-full
 *
 * `ownerFamily` suppresses the visitor count when a venue's own customer sim
 * arrives at its own venue: that visit was already counted when it committed
 * to the trip, and counting it twice inflates the payout band.
 */
export function acquireVenueSlot(record, actor, clock, ownerFamily = null) {
  if (!record || record.availability === VENUE.dormant || record.availability === VENUE.closed) {
    return SLOT.unavailable;
  }
  if (record.currentPopulation > MAX_ACTIVE_OCCUPANTS) return SLOT.full;

  record.currentPopulation += 1;
  if (actor?.family !== ownerFamily) record.acquireCount += 1;
  applyOccupancyBand(record);
  // The dwell-start latch. Read by {@link releaseVenueSlot}'s minimum stay.
  actor.venueEnteredTick = clock?.dayTick ?? 0;
  return SLOT.acquired;
}

/**
 * `release_commercial_venue_slot`.
 *
 * Two things it does that are easy to drop: *"releasing the final occupant
 * reopens the venue"*, and *"slot release resets the sim's saved floor fields
 * back to the venue owner floor on success"* — which is how the returning
 * worker knows where home is.
 *
 * @returns false while the minimum stay has not elapsed. **A refused release is
 *   not a failure** — the visitor simply has not finished eating, and the
 *   caller must hold rather than leave, or the venue keeps an occupant who is
 *   no longer there.
 */
export function releaseVenueSlot(record, actor, clock, { skipDwellGate = false } = {}) {
  // No record, or one that has gone dormant or closed underneath the visitor:
  // there is nothing to give back, and the visitor must not be trapped by it.
  if (!record || record.availability === VENUE.dormant || record.availability === VENUE.closed) {
    return true;
  }
  if (!skipDwellGate && !minimumStayElapsed(actor, clock)) return false;

  if (record.currentPopulation > 0) record.currentPopulation -= 1;
  applyOccupancyBand(record);
  actor.venueEnteredTick = null;
  return true;
}

/** Has this visitor been inside for the family's minimum stay? */
export function minimumStayElapsed(actor, clock) {
  const entered = actor?.venueEnteredTick;
  if (entered === null || entered === undefined) return true;
  // `spec/DEVIATIONS.md` A1's rule, again: a stay stamped before the day-tick
  // wrap and read after it computes a negative span. Floored, so the wrap lets
  // a diner leave early rather than trapping them for a whole extra day.
  return Math.max(0, (clock?.dayTick ?? 0) - entered) >= MINIMUM_STAY;
}

/** § Availability: `0` empty, `1` at 1..9 inside, `2` at 10 or more. */
function applyOccupancyBand(record) {
  if (record.availability === VENUE.dormant || record.availability === VENUE.closed) return;
  record.availability = record.currentPopulation === 0 ? VENUE.available
    : record.currentPopulation >= NEAR_FULL_OCCUPANTS ? VENUE.nearFull
      : VENUE.partial;
}

// ------------------------------------------------------- venue selection

/**
 * `select_random_commercial_venue_record_for_floor`. `COMMERCIAL.md`
 * § Venue Selection Algorithm:
 *
 * 1. the sim's current floor maps to one of seven 15-floor zones by
 *    `classify_path_bucket_index` — which is `sim/state.js`'s `zoneBand`, the
 *    same arithmetic already written once
 * 2. one venue is chosen **uniformly at random from all entries in that zone
 *    bucket**, availability unchecked
 * 3. a venue that turns out invalid or closed is an immediate retry, not a
 *    fallback to another venue
 *
 * Step 2 before step 3 is not an accident of phrasing and it is worth keeping:
 * the draw happens whenever the bucket has anything in it, so a tower full of
 * closed venues still consumes the same RNG as one full of open ones. Filtering
 * first would change every subsequent number in the run.
 *
 * ⚠️ Returns `null` for "no venue", never `-1`. The reference stores `-1` in a
 * byte and reads it back as a floor; ours are logical and `-1` is B1.
 * `CLAUDE.md`'s first entry, and the reason the lunch fallback below is keyed
 * on `null`.
 */
export function selectVenue(tower, family, fromFloor) {
  const zone = zoneBand(fromFloor);
  const bucket = [];
  for (const object of tower.objects.values()) {
    if (object.family !== family) continue;
    if (!venueOf(object)) continue;
    if (zoneBand(object.floor) !== zone) continue;
    bucket.push(object);
  }
  if (bucket.length === 0) return null;

  const picked = bucket[tower.rng.int(bucket.length)];
  const record = venueOf(picked);
  if (record.availability === VENUE.closed || record.availability === VENUE.dormant) return null;
  return picked;
}

// ---------------------------------------------------------------- gate

/**
 * The gate. `specs/DEMAND.md` § Families 6/0x0c § Gate Table (binary-verified)
 * and § Family 10.
 *
 * One handler, three families, and the split is on the **placed type**: type 6
 * is the restaurant's late window, everything else is the fast-food trickle.
 * Retail adds one guard ahead of the dice.
 *
 * Returns `'dispatch'`, `'hold'`, or a state byte to write directly.
 */
export function commercialGate(actor, object, clock, rng) {
  const state = actor.state & 0x3f;
  const { daypart, dayTick } = clock;

  if (state === VENUE_STATE.parked) {
    // *"tick >= 2301 → force state 0x20"*. The office's own night release is
    // `> 2300`, which is the same instant written the other way; both are the
    // reference's, in different tables.
    return dayTick > NIGHT_RELEASE_TICK ? VENUE_STATE.arriving : 'hold';
  }

  // *"0x05 | always | dispatch"*. The dwell is enforced by the minimum stay in
  // dispatch, not here — the gate has no timer in the reference either.
  if (state === VENUE_STATE.leaving) return 'dispatch';

  if (state !== VENUE_STATE.arriving) return 'hold';

  // A customer already on its way is not asked again. It cleared the gate when
  // it committed to the visit, and a carrier arrival that lands short of the
  // venue drops the transit bit — so without this a transferring diner would be
  // sent back to the 1/36 dice halfway up the building and could stall there
  // for the rest of the day.
  if (actor.venueCommitted) return 'dispatch';

  if (object.family === FAMILY.retail) {
    // § Family 10's extra guard: a dormant venue whose object has never been
    // marked occupied does not even roll.
    const record = venueOf(object);
    if (record?.availability === VENUE.dormant && !object.occupiedFlag) return 'hold';
  }

  if (object.type === FAMILY.restaurant) {
    // The restaurant's evening window: 1/12 at daypart 4, then always through
    // the first half of daypart 5.
    if (daypart === 4) return rng.chance(12) ? 'dispatch' : 'hold';
    if (daypart < 5) return 'hold';
    return daypart === 5 && dayTick <= 2199 ? 'dispatch' : 'hold';
  }

  // Fast food and retail: a trickle all morning, a push in the afternoon.
  if (daypart >= 5) return 'hold';
  // *"dayparts 0-3, tick <= 240 | no dispatch"* — the same 240 the news and VIP
  // hooks wait for. Nothing in this tower moves in the first 240 ticks.
  if (dayTick <= REBUILD_TICK) return 'hold';
  if (daypart <= 3) return rng.chance(36) ? 'dispatch' : 'hold';
  return rng.chance(6) ? 'dispatch' : 'hold';
}

// ------------------------------------------------------------- dispatch

/**
 * The dispatch handler.
 *
 * ⚠️ **The customer travels lobby → venue first, not venue → lobby.**
 * `specs/DEMAND.md`'s one-line dispatch table says the opposite — *"0x20/0x60 |
 * venue floor → lobby"* — and it cannot be right: state `0x20` is where the
 * venue's capacity is spent and where the arriving visitor **acquires a slot**,
 * which only makes sense at the venue. The reference implementation routes
 * `LOBBY → floor_anchor` here, citing the same handler address. A customer
 * arrives, eats, and leaves. Recorded as `spec/DEVIATIONS.md` A18.
 *
 * `ctx` supplies the same three seams the office family takes:
 *   `resolveRoute(tower, actor, from, to, clock, options)`
 *   `onDelay(delay, actor)`
 *   `onVenueVisit(object, record)` — optional, fires when capacity is spent
 */
export function commercialDispatch(tower, actor, object, clock, ctx) {
  const state = actor.state & 0x3f;
  const record = venueOf(object);

  if (state === VENUE_STATE.arriving) {
    // A closed venue silently parks its customers rather than sending them
    // into a route they cannot complete. The RNG has already been spent by the
    // gate, which is the reference's order.
    if (!record || record.availability === VENUE.closed) {
      actor.state = VENUE_STATE.parked;
      return { moved: false };
    }
    if (record.availability === VENUE.dormant) return { moved: false };

    // ⚠️ **The first leg starts at the lobby, not where the actor is anchored.**
    // `placeObject` anchors every occupant to its own object's floor, which for
    // a venue's customers is the venue — but a customer is not IN the shop, it
    // is a person downstairs who might come up. Reading `anchorFloor` here
    // routed the venue floor to itself, answered same-floor, and every one of
    // the 48 teleported into their seats without touching a lift: the whole
    // demand this file exists to generate, silently absent.
    const startingOut = !actor.venueCommitted;
    // Read BEFORE the commit block below writes the anchor. Computing it after
    // would make `startingOut ? LOBBY : anchor` and a bare `anchor` the same
    // expression — a guard that cannot be wrong is a guard nothing tests, and a
    // mutation run says so by leaving it alive.
    const from = startingOut ? LOBBY_FLOOR : (actor.anchorFloor ?? LOBBY_FLOOR);
    if (startingOut) {
      // `try_consume_commercial_venue_capacity`: the day's ceiling on how many
      // of the 48 actually travel. This is where the capacity limit bites, and
      // the only place it does.
      if (record.remainingCapacity <= 0) return { moved: false };
      record.remainingCapacity -= 1;
      record.todayVisitCount += 1;
      record.acquireCount += 1;
      actor.venueCommitted = true;
      actor.anchorFloor = LOBBY_FLOOR;
      ctx.onVenueVisit?.(object, record);
    }

    const result = route(tower, actor, from, object.floor, clock, ctx);
    const code = result.code ?? result;

    if (code === -1) {
      // A venue nobody can reach: give the capacity back and try again, so a
      // tower with a broken lift does not silently burn its shops' whole day
      // in failed trips. `record.availability` is live, so the visit was real.
      record.remainingCapacity += 1;
      record.todayVisitCount -= 1;
      record.acquireCount -= 1;
      actor.venueCommitted = false;
      actor.state = VENUE_STATE.parked;
      return { moved: false, code };
    }
    if (code === 3) return arriveAtVenue(actor, object, record, clock, ctx);
    actor.state = VENUE_STATE.arriving | 0x40;
    return { moved: true, code };
  }

  // 0x05 — the way home. The minimum stay is what makes a visit a visit.
  if (!minimumStayElapsed(actor, clock)) return { moved: false };
  releaseVenueSlot(record, actor, clock, { skipDwellGate: true });

  const result = route(tower, actor, actor.anchorFloor ?? object.floor, LOBBY_FLOOR, clock, ctx);
  const code = result.code ?? result;

  if (code === -1) {
    actor.state = VENUE_STATE.parked;
    actor.venueCommitted = false;
    return { moved: false, code };
  }
  if (code === 3) {
    actor.state = VENUE_STATE.parked;
    actor.venueCommitted = false;
    // **The trip that pays for tomorrow.** A customer who got home grows the
    // venue's capacity seed by how well the journey went.
    if (record) growVenueSeed(tower, record, actor);
    return { moved: true, code };
  }
  actor.state = VENUE_STATE.leaving | 0x40;
  return { moved: true, code };
}

/** Arrived at the venue floor: take a slot, or wait, or give up on this one. */
function arriveAtVenue(actor, object, record, clock, ctx) {
  // Arriving at the venue means standing on its floor. Stated rather than
  // assumed: a same-floor result usually means the anchor was already right,
  // and "usually" is how a position field goes stale.
  actor.anchorFloor = object.floor;
  const outcome = acquireVenueSlot(record, actor, clock, object.family);
  if (outcome === SLOT.full) {
    // Over-capacity is a **wait**, not a failed route: stay in transit and try
    // again next stride. Pricing it as a failure would charge a 300-tick
    // no-route penalty for a queue that is merely busy.
    actor.state = VENUE_STATE.arriving | 0x40;
    return { moved: false, outcome };
  }
  if (outcome === SLOT.unavailable) ctx.onDelay?.({ kind: 'invalid-venue' }, actor);
  actor.state = VENUE_STATE.leaving;
  actor.venueEnteredTick = clock.dayTick;
  return { moved: true, outcome };
}

const route = (tower, actor, from, to, clock, ctx) => ctx.resolveRoute(tower, actor, from, to, clock, {
  passengerRoute: true,
  // `sim/routing.js`'s own gating table has no row for the commercial
  // families, which is its way of saying they never charge the distance
  // penalty. Asked rather than restated, so there is one copy of the rule.
  emitDistanceFeedback: emitsDistanceFeedback(actor.family, actor.state),
  onDelay: (delay) => ctx.onDelay?.(delay, actor),
});

/**
 * The handler the scheduler calls, once per serviced customer.
 *
 * The in-transit split is the office's, for the reason `specs/PEOPLE.md`
 * § Refresh handler flow gives: a customer holding a **carrier** token is
 * standing in a queue and must be left alone, or every re-resolution re-stamps
 * its route start and the wait it is accruing is thrown away.
 */
export function commercialFamilyHandler(ctx) {
  return function serviceVenueCustomer(tower, actor) {
    const object = tower.objects.get(actor.objectId);
    if (!object || !COMMERCIAL_FAMILIES.has(object.family)) return;

    if (actor.state >= 0x40) {
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      return void commercialDispatch(tower, actor, object, tower.clock, ctx);
    }

    const verdict = commercialGate(actor, object, tower.clock, tower.rng);
    if (verdict === 'hold') return;
    if (verdict === 'dispatch') return void commercialDispatch(tower, actor, object, tower.clock, ctx);
    actor.state = verdict;
  };
}

/**
 * A customer got off a lift.
 *
 * Dropping the transit bit and letting the next stride re-resolve is
 * deliberate: a same-floor route from where they now stand answers `3`, which
 * is the arrival branch already written above. One copy of the arrival rules,
 * reached two ways.
 */
export function commercialArrival(actor, floor) {
  actor.anchorFloor = floor;
  actor.state &= 0x3f;
  actor.routeCarrier = null;
}
