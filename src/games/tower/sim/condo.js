/**
 * Family 9 — condo residents. **The first thing in this game you can lose
 * money on.**
 *
 * Spec: `specs/facility/CONDO.md` in full, `specs/DEMAND.md` § Family 9 (gate
 * and dispatch tables, binary-verified), `specs/PEOPLE.md` § Family `9`,
 * `specs/FACILITIES.md` § Facility Evaluation Model / § Noise Search /
 * § occupied_flag, `specs/ECONOMY.md` § Ledgers, `specs/TIME.md` § 2500 and
 * § 2533.
 *
 * ## Why a condo is not an office with a different sprite
 *
 * An office **rents**: a recurring $10,000 that arrives every third day for as
 * long as the tenant stays, and stops when they leave. A condo **sells**: one
 * payment of $150,000 the moment a resident's trip out of the building
 * resolves, and — this is the part with teeth — **that payment is reversed in
 * full if the unit's evaluation ever reaches zero on a 3-day cashflow pass.**
 * The condo returns to the for-sale band and the tower is $150,000 poorer than
 * before it sold, having already spent the money.
 *
 * `specs/facility/CONDO.md` § Refund effect: the reversal goes through
 * `remove_cashflow_from_family_resource(9, rent_level)` and *"the reversed
 * amount is exactly the original sale value"*. There is no partial refund and
 * no depreciation. Build condos where your lifts cannot serve them and you do
 * not merely fail to earn — you hand back money you have already banked.
 *
 * That asymmetry is the whole point of the family, so three things in this file
 * exist to keep it from being quietly softened:
 *
 *  1. the sale is one-shot and band-guarded (`unit_status >= 0x18`), so a
 *     condo cannot be sold twice;
 *  2. the refund is band-guarded the other way (`unit_status < 0x18`), so an
 *     unsold condo cannot be refunded for money it never took;
 *  3. every `unit_status` step clamps **inside** the band it started in, so no
 *     amount of arithmetic can sell or un-sell a unit. See {@link stepUnitStatus}.
 *
 * ## The sold band is `0x00..0x17`, not `0x00..0x0f`
 *
 * The single easiest way to break this family. `sim/state.js`'s `isRented()` is
 * the **office** band and a sold condo sits at `0x10` — the sync sentinel —
 * every single night. Use {@link isCondoSold}, or `isUnitLet(object)` for code
 * that does not know which family it is holding.
 *
 * ## The bootstrap, and the guard that replaces it
 *
 * An office opens its own `0x20` gate because a brand-new office has taken no
 * trips, scores `0` — the *best* grade — and so sets `occupied_flag`. A condo
 * bootstraps identically, but it also carries `specs/FACILITIES.md`'s
 * family-9 early-exit: once the flag is set, an **unsold** condo
 * (`unit_status > 0x17`) stops being scored at all and grades `0xff`. So a
 * condo nobody can reach does not sit at grade 0 with its gate jammed shut —
 * it holds `0xff`, keeps its flag, and keeps trying. Recovery is automatic
 * rather than dependent on the 3-day counter reset.
 */
import {
  CONDO_UNIT_STATUS, EVAL_UNSET, FAMILY, baseState, enterTransit,
} from './state.js';
import { EVENING_DAYPART } from './clock.js';
import { FACILITY_POPULATION, computeObjectOperationalScore } from './stress.js';
// The shared halves of the evaluation pipeline. `specs/FACILITIES.md` states
// steps 3, 4 and 6 once for every scored family, so they are imported rather
// than restated — `office.js` is simply where they landed first. Only the
// radius and the noise-source set below are family-specific.
import {
  NOISE_PENALTY, RENT_MODIFIER, RENT_TIER_ALWAYS_PASSES, evalLevelFor, noiseSourceWithin,
} from './office.js';
import {
  LOBBY_FLOOR, emitsDistanceFeedback, shouldWaitForQueuedCarrier,
} from './routing.js';

/**
 * Resident states, `specs/DEMAND.md` § Family 9 § Gate Table. `0x4x` is `0x0x`
 * in transit and `0x6x` is `0x2x`; the handlers are shared, which is why these
 * are named for the base state only.
 */
export const CONDO_STATE = {
  /** Leaving home on the day's errand. Routes to the lobby. */
  outbound: 0x00,
  /** Heading for a commercial venue. */
  venue: 0x01,
  /** Sibling sync. No route — bookkeeping only. */
  sync: 0x04,
  /** Morning dispatch setup. No route — picks the day's path. */
  morning: 0x10,
  /** Unsold, seeking the trip that sells the unit. **The sale point.** */
  saleSeeking: 0x20,
  /** The return leg of the outbound errand. */
  returnHome: 0x21,
  /** Release the venue and go home. */
  venueRelease: 0x22,
};

/** `specs/FACILITIES.md` § Noise Search: hotel 20 tiles, office 10, **condo 30**. */
export const CONDO_NOISE_RADIUS = 30;

/**
 * `specs/FACILITIES.md` § Noise Source Matching, the condo row — and it is the
 * widest of the three: *"condo (9) | hotel rooms (3/4/5), restaurant (6),
 * office (7), retail (10), fast food (12), entertainment"*.
 *
 * **A condo counts offices as noise. An office does not.** Combined with the
 * 30-tile radius that is not a detail: on the seeded tower's layout every
 * office bank is inside every condo's radius, so a condo dropped into an office
 * floor starts 60 points into a 150-point failure budget before anybody has
 * taken a single trip.
 *
 * TODO(parity): hotel rooms (3/4/5) and the entertainment families have no
 * `FAMILY` code in this build, so they are absent rather than mapped to
 * something wrong. `FAMILY.fastFood` is code `6`, which `specs/ECONOMY.md`
 * § Construction Costs calls Restaurant — either way it is on this row, so
 * nothing turns on the mislabel here.
 */
export const CONDO_NOISE_FAMILIES = new Set([FAMILY.office, FAMILY.fastFood, FAMILY.retail]);

/** The countdown `0x10`'s dispatch seeds. `specs/PEOPLE.md` § Family 9 dispatch. */
export const SOLD_CYCLE_SEED = 3;

/**
 * Is this condo sold? `specs/facility/CONDO.md`: *"`unit_status <= 0x17` as
 * sold/open"*. Not `isRented()` — see the header.
 */
export const isCondoSold = (unitStatus) => unitStatus <= CONDO_UNIT_STATUS.soldMax;

// ------------------------------------------------------------- the countdown

/**
 * Step the in-cycle countdown, **clamped inside the band it started in**.
 *
 * `specs/PEOPLE.md` § Family 9 has residents `INC` and `DEC` `unit_status` on
 * almost every transition, and never says what happens at a band edge. It does
 * not have to: the reference stores an unsigned byte and the countdown is
 * seeded to `3`.
 *
 * We do have to, and the naive answer is dangerous in both directions. A
 * global clamp to `0x17` turns an unsold condo's bounce at `0x19` into `0x17`
 * — **which sells it, for nothing, by arithmetic**. A wrap at `0` turns a sold
 * condo into `0xff`, the extended-vacancy band, which contradicts
 * `CONDO.md` § End-of-day (*"sold condos do not revert to the unsold band at
 * day end"*).
 *
 * So the band is the boundary. Only {@link finalizeCondoSale} and
 * {@link revertCondoToUnsold} cross it, which is the property that makes the
 * sale one-shot and the refund honest. Recorded as `spec/DEVIATIONS.md` A19.
 */
export function stepUnitStatus(object, delta) {
  const sold = isCondoSold(object.unitStatus);
  const low = sold ? 0 : CONDO_UNIT_STATUS.unsoldEarly;
  const high = sold ? CONDO_UNIT_STATUS.soldMax : CONDO_UNIT_STATUS.expiryMin - 1;
  object.unitStatus = Math.min(high, Math.max(low, object.unitStatus + delta));
  object.dirty = true;
  return object.unitStatus;
}

// --------------------------------------------------------- the facility service

/**
 * `route_entity_to_facility_service` (`0x1238:0000`) — the selector, from the
 * resident's **zero-based `resident_index`**, not from any tile offset.
 * `specs/facility/CONDO.md` § Sale Trigger: `resident_index % 4 == 0` picks
 * selector `1`, everything else picks `2`.
 *
 * With three residents that is one selector-1 and two selector-2, which
 * `specs/PEOPLE.md` line 416 reads as *"restaurant / fast-food / fast-food
 * across the three occupants"*.
 */
export const saleSelector = (residentIndex) => (residentIndex % 4 === 0 ? 1 : 2);

/**
 * Which families satisfy each selector. Selector `1` is the restaurant bucket
 * and selector `2` the fast-food bucket (`specs/facility/OFFICE.md` § 0x01:
 * *"selector `2` maps to fast food"*).
 *
 * Both resolve to `FAMILY.fastFood` today because that is the only commercial
 * *venue* family `sim/state.js` names — retail is a shop, and
 * `specs/facility/COMMERCIAL.md` keeps it out of the venue selectors. The map
 * is written per-selector anyway so that the day restaurant and fast food are
 * separate codes, this is a one-line change and not a rediscovery.
 */
const VENUE_FAMILIES = {
  1: new Set([FAMILY.fastFood]),
  2: new Set([FAMILY.fastFood]),
};

/**
 * Where a resident's commercial trip is aimed, or `null` for the reference's
 * `0xffff` ("no such service").
 *
 * ⚠️ **`null`, never `-1` and never `0xffff`.** `CLAUDE.md`'s sentinel section:
 * our floors are logical, so `-1` is B1 — a real, reachable floor — and `0`
 * is the lobby. A "no venue" answer has to be a value no floor comparison can
 * mistake for a floor.
 *
 * `specs/facility/COMMERCIAL.md` § venue selection: *"one venue record is
 * chosen uniformly at random from all available entries in the matching zone
 * bucket for the requested type"*. The zone bucket is `zoneBand(floor)`; when
 * the requester's own band holds no venue the search widens to the whole tower
 * rather than failing, because a failed lookup is a *bounce*, not a queue, and
 * a tower with one shop would otherwise serve only one zone.
 *
 * @returns {number|null} a logical floor, or null
 */
export function facilityServiceFloor(tower, selector, fromFloor, rng) {
  const wanted = VENUE_FAMILIES[selector];
  if (!wanted) return null;

  const all = [];
  for (const object of tower.objects.values()) if (wanted.has(object.family)) all.push(object);
  if (all.length === 0) return noVenueFallback(tower);

  const band = zoneBandOf(fromFloor);
  const bucket = all.filter((o) => zoneBandOf(o.floor) === band);
  const pool = bucket.length ? bucket : all;
  const pick = rng ? rng.int(pool.length) : 0;
  return pool[pick].floor;
}

/** `sim/state.js`'s `zoneBand`, inlined to keep this file's import list short. */
const zoneBandOf = (floor) => Math.max(0, Math.floor((floor + 1) / 15));

/**
 * ⚠️ **`spec/DEVIATIONS.md` D2 — the one invented rule in this family.**
 *
 * `specs/facility/CONDO.md` § Sale Trigger makes the sale strictly conditional
 * on a *venue* trip: the selector picks a restaurant or a fast-food bucket, and
 * *"if that helper returns `0xffff`, no sale happens"*. **Neither family exists
 * in this build.** Implemented literally, every condo ever placed would bounce
 * on the service lookup and no condo could ever sell — the family would be a
 * palette button that takes $80,000 and returns nothing, and the refund
 * mechanic it exists for would be unreachable and unmeasurable.
 *
 * So when the tower holds **no commercial venue at all**, the sale trip aims at
 * the lobby instead. This preserves the property the spec section is actually
 * about — *"a condo sale is not driven by mere structural connectivity. The
 * sale fires only when the resident sale path reaches a sale-eligible route
 * result"* — because a condo above the top of the lift still cannot route to
 * the lobby, and still does not sell.
 *
 * TODO(parity): delete this the day family `6`/`0x0c` lands. It is already
 * self-retiring: the moment one venue is placed, {@link facilityServiceFloor}
 * finds it and never reaches here.
 */
function noVenueFallback(tower) {
  for (const object of tower.objects.values()) {
    if (object.family === FAMILY.lobby) return object.floor;
  }
  return LOBBY_FLOOR;
}

// ------------------------------------------------------------- evaluation

/**
 * The condo slice of `compute_object_operational_score`, `specs/FACILITIES.md`
 * § Facility Evaluation Model, in the reference's order:
 *
 *   1-2. average per-resident stress across the family's population of **3**
 *   3.   pricing-tier modifier (tier 3 forces zero)
 *   4.   `+60` if a noise source is within 30 tiles
 *   5.   clamp to `>= 0`
 *
 * The divisor is `FACILITY_POPULATION[9]`, not `occupants.length`. Handing over
 * a short list throws rather than scoring the missing resident as calm — a
 * two-resident condo averaged over two would read *better* than over three,
 * which is a hole that reads as good news.
 */
export function condoScore(tower, object, occupants) {
  const base = computeObjectOperationalScore(occupants, FACILITY_POPULATION[FAMILY.condo]);
  const priced = object.rentLevel === RENT_TIER_ALWAYS_PASSES
    ? 0
    : base + (RENT_MODIFIER[object.rentLevel] ?? 0);
  const noised = priced + (condoNoiseNear(tower, object) ? NOISE_PENALTY : 0);
  return Math.max(0, noised);
}

/** Is a condo-qualifying noise source within 30 tiles on this condo's floor? */
export const condoNoiseNear = (tower, object) =>
  noiseSourceWithin(tower, object, CONDO_NOISE_RADIUS, CONDO_NOISE_FAMILIES);

/**
 * `recompute_object_operational_status`, the condo slice.
 *
 * The early-exit is `specs/FACILITIES.md` § Facility Evaluation Model:
 * *"9 (condo) | `unit_status > 0x17` AND `occupied_flag != 0` | returns
 * `0xffff`"*. An unsold condo that is already being measured is **not scored**.
 *
 * Both halves of that guard matter and in opposite directions. Without the
 * `occupied_flag` half a freshly placed condo would never be scored at all, so
 * the flag would never be set, so its `0x20` gate would never open and no condo
 * could ever sell. Without the `unit_status` half an unreachable condo would
 * grade `0` — and grade `0` is what {@link revertCondoToUnsold} refuses to act
 * on only because of the band check, so the guard is the belt to that
 * bracing.
 *
 * @returns {number} the `eval_level` written
 */
export function recomputeCondoOperationalStatus(tower, object, occupants) {
  if (!isCondoSold(object.unitStatus) && object.occupiedFlag) {
    object.evalLevel = EVAL_UNSET;
    return object.evalLevel;
  }
  const score = condoScore(tower, object, occupants);
  object.evalLevel = evalLevelFor(score, tower.starCount);
  // Set when `eval_level` first becomes nonzero, never cleared here — clearing
  // belongs to the refund. `specs/FACILITIES.md` § occupied_flag.
  if (object.evalLevel !== 0 && object.evalLevel !== EVAL_UNSET) object.occupiedFlag = true;
  return object.evalLevel;
}

// ------------------------------------------------------------- sale and refund

/**
 * **`finalize_condo_sale` (`0x1180:105d`) — the moment the money arrives.**
 *
 * `specs/facility/CONDO.md` § Sale effect: it adds the family-9 YEN `#1001`
 * value for the current `rent_level`, resets `unit_status` into the sold band,
 * marks the span dirty and adds `+3` to the primary family ledger.
 *
 * **One-shot by band, not by flag.** The guard is the reference's own — *"sale
 * is automatically one-shot because later checks see `unit_status < 0x18`"* —
 * so the other two residents of a just-sold condo route, find it sold, and
 * simply bounce. There is no second `sold` boolean to fall out of step with the
 * band.
 *
 * The `0x00`/`0x08` split is the half-day branch, `specs/TIME.md` § Tick Model:
 * *"`unit_status` initialization: morning starts at `0`, evening starts at
 * `8`"*. Note `0x00` is a perfectly legal sold value — anything reading
 * `unitStatus` as truthy has a bug.
 *
 * @returns {boolean} whether this call is the one that sold it
 */
export function finalizeCondoSale(tower, object, ctx) {
  if (isCondoSold(object.unitStatus)) return false;
  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? CONDO_UNIT_STATUS.soldEarly
    : CONDO_UNIT_STATUS.soldLate;
  object.everSold = true;
  object.dirty = true;
  // The money and the `+3` live in `sim/ledger-adapter.js`, which is the only
  // module that knows both this file's vocabulary and `sim/economy.js`'s.
  ctx?.onSale?.(tower, object);
  return true;
}

/**
 * **`revert_condo_to_unsold(floor, slot, 1)` — the money going back.**
 *
 * `specs/facility/CONDO.md` § Refund Trigger. Two conditions, both required:
 * `eval_level == 0` **and** `unit_status < 0x18` (the condo is currently sold).
 * A poor-but-nonzero grade keeps the sale, exactly as a poor-but-nonzero grade
 * keeps an office tenant — closure has to represent sustained failure, not one
 * bad afternoon.
 *
 * The `do_reverse_sale_value == 1` argument is what makes this different from
 * every other deactivation in the game: it reverses the **full original sale
 * price** out of cash. `CONDO.md` is explicit that the generic
 * `refund_income_from_cash` UI helper is *not* on this path — the reversal goes
 * through the family resource, which is `reverseCashflowOnDeactivation` here.
 *
 * Called from the shared deactivation seam on the 3-day cashflow pass, before
 * the activation sweep, so a condo that fails this pass is refunded rather than
 * aged first. `specs/TIME.md` § 2533 step 2 owns that order.
 *
 * The residents' states are deliberately **not** rewritten here.
 * `specs/TIME.md` § 2500 owns that — {@link condoDailyReset} puts an unsold
 * condo's residents back into `0x20` at the next nightly sweep, which is what
 * `CONDO.md` § Reactivation nuance describes: *"a refunded condo therefore does
 * not immediately resell on the same 3-day pass"*.
 *
 * @returns {boolean} whether the unit was refunded
 */
export function revertCondoToUnsold(tower, object, occupants, ctx) {
  if (object.evalLevel !== 0) return false;
  if (!isCondoSold(object.unitStatus)) return false;

  object.unitStatus = tower.clock.daypart < EVENING_DAYPART
    ? CONDO_UNIT_STATUS.unsoldEarly
    : CONDO_UNIT_STATUS.unsoldLate;
  object.occupiedFlag = false;
  object.activationTickCount = 0;
  object.dirty = true;
  ctx?.onRefund?.(tower, object);
  return true;
}

// ------------------------------------------------------------- the gate

/**
 * The gate. `specs/DEMAND.md` § Family 9 § Gate Table (binary-verified), which
 * `specs/PEOPLE.md` § Family `9` restates identically.
 *
 * Returns `'dispatch'`, `'hold'`, or a state byte to write directly — the
 * calendar-phase branch of `0x01` rewrites state without dispatching, which is
 * how the staggered resident is pushed into the sync without taking a trip.
 *
 * Two staggers live here and they are different axes. **`resident_index == 2`
 * syncs and returns an hour earlier than its siblings** (the `0x04` and `0x21`
 * rows), which spreads the evening return. And on a calendar-phase day
 * **`resident_index % 4 == 0` — resident 0 alone, with three residents —**
 * loses its venue trip to a 1-in-6 afternoon window.
 */
export function condoGate(actor, object, clock, rng) {
  const state = baseState(actor.state);
  const { daypart, dayTick, calendarPhase } = clock;
  const index = actor.occupantIndex;

  switch (state) {
    case CONDO_STATE.morning:                                   // 0x10
      if (daypart < 5) return 'dispatch';
      return dayTick > 2566 ? chance(rng, 12) : 'hold';

    case CONDO_STATE.outbound:                                  // 0x00
      if (daypart === 0) return chance(rng, 12);
      if (daypart === 6) return 'hold';
      return 'dispatch';

    case CONDO_STATE.venue:                                     // 0x01
      if (calendarPhase && index % 4 === 0) {
        if (daypart < 4) return 'hold';
        if (daypart === 4) return chance(rng, 6);
        return CONDO_STATE.sync;                                // "force state -> 0x04"
      }
      if (daypart === 0) return dayTick > 240 ? chance(rng, 12) : 'hold';
      if (daypart === 6) return 'hold';
      return 'dispatch';

    case CONDO_STATE.sync:                                      // 0x04
      if (index === 2) return daypart >= 5 ? 'dispatch' : 'hold';
      if (daypart < 5) return 'hold';
      return dayTick > 2400 ? 'dispatch' : chance(rng, 12);

    case CONDO_STATE.saleSeeking:                               // 0x20
      // `pairing_pending_flag` in the gate table is this family's
      // `occupied_flag`: `specs/FACILITIES.md` § occupied_flag says outright
      // that "when clear, the family-7/9 gate blocks worker dispatch (state
      // 0x20)". Condos have no housekeeping claimant to set a separate latch.
      // Recorded as `spec/DEVIATIONS.md` A16.
      if (!object.occupiedFlag) return 'hold';
      if (daypart >= 5) return 'hold';
      return 'dispatch';

    case CONDO_STATE.returnHome:                                // 0x21
      if (index === 2) {
        if (daypart === 3) return chance(rng, 12);
        return daypart > 3 ? 'dispatch' : 'hold';
      }
      if (daypart === 4) return chance(rng, 12);
      return daypart > 4 ? 'dispatch' : 'hold';

    case CONDO_STATE.venueRelease:                              // 0x22
      return daypart >= 3 ? 'dispatch' : 'hold';

    default:
      return 'hold';
  }
}

const chance = (rng, n) => (rng.chance(n) ? 'dispatch' : 'hold');

// ------------------------------------------------------------- the dispatch

/**
 * The dispatch handler. `specs/DEMAND.md` § Family 9 § Dispatch Table and
 * `specs/PEOPLE.md` § Family `9` § Dispatch Table.
 *
 * `ctx` supplies the seams this module deliberately does not own:
 *   `resolveRoute(tower, actor, from, to, clock, options)` → routing
 *   `onSale(tower, object)`   → the ledger adapter: cash `+$150,000`, pop `+3`
 *   `onRefund(tower, object)` → the ledger adapter: the same, reversed
 *   `onDelay(delay, actor)`   → the stress pipeline
 */
export function condoDispatch(tower, actor, object, clock, ctx) {
  const state = baseState(actor.state);

  if (state === CONDO_STATE.morning) return morningDispatch(actor, object, clock);
  if (state === CONDO_STATE.sync) return syncDispatch(actor, object);
  if (state === CONDO_STATE.saleSeeking) return saleDispatch(tower, actor, object, clock, ctx);

  const leg = TRIP_LEGS[state];
  if (!leg) return { moved: false };

  // `specs/PEOPLE.md`: *"If 0x01: DEC unit_status"* — on the **base** state, so
  // it fires once when the leg starts and not again on each in-transit
  // continuation. Same idiom as family 7's presence counter, which the spec
  // spells out as "fires when base state is 0x00, not 0x40".
  if (actor.state === CONDO_STATE.venue) stepUnitStatus(object, -1);

  const to = leg.venue
    ? facilityServiceFloor(tower, saleSelector(actor.occupantIndex), homeFloorOf(actor, object), tower.rng)
    : leg.home ? object.floor : LOBBY_FLOOR;

  // The venue lookup failing is the reference's `0xffff` bounce, and it is
  // reached before any route is asked for.
  if (to === null) {
    stepUnitStatus(object, +1);
    actor.state = CONDO_STATE.sync;
    return { moved: false, venue: false };
  }

  const code = resolve(tower, actor, homeFloorOf(actor, object), to, clock, ctx, state);

  if (code === -1 || code === 3) {
    // Both the failure and the same-floor arrival take the terminal transition
    // this leg was going to take anyway — `specs/PEOPLE.md` writes the two rows
    // together as "fail or arrived".
    if (leg.stepOnEnd) stepUnitStatus(object, leg.stepOnEnd);
    actor.state = code === 3 ? leg.arrive : leg.fail;
    return { moved: code === 3, code };
  }
  actor.state = enterTransit(state);
  return { moved: true, code };
}

/**
 * The four routed legs, and the two complete daily paths they make.
 *
 * ⚠️ **Nothing in the spec set says what enters state `0x21`**, and the two
 * things that come closest disagree. `specs/DEMAND.md`'s ASCII lifecycle draws
 * `0x00 → 0x01`, which would leave `0x21` with no entry point at all; but
 * `specs/ROUTING.md` § emit_distance_feedback Gating groups *"0x21, 0x22
 * (return trips)"* against *"0x00, 0x01, 0x20 (outbound trips)"*, which pairs
 * each outbound leg with a return.
 *
 * The tables win over the diagram, because family 7's own table settles the
 * shape: its `0x00/0x40` row reads *"`3` | write `0x21`"* — an outbound leg
 * arriving hands off to `0x21` — and `sim/office.js` implements exactly that.
 * So:
 *
 *   path A   `0x10 → 0x00` (home → lobby) `→ 0x21` (lobby → home) `→ 0x04`
 *   path B   `0x10 → 0x01` (home → venue) `→ 0x22` (venue → home) `→ 0x04`
 *
 * Every state in the family's table is reached, every stated transition is
 * honoured, and the `0x21`/`0x22` pair reads as the two return trips
 * `ROUTING.md` calls them. Recorded as `spec/DEVIATIONS.md` A17.
 */
const TRIP_LEGS = {
  // 0x00 — out to the lobby. No `stepOnEnd`: the dispatch tables give this row
  // no `unit_status` effect, and inventing one is what makes a countdown drift.
  [CONDO_STATE.outbound]: { arrive: CONDO_STATE.returnHome, fail: CONDO_STATE.sync, stepOnEnd: 0 },
  // 0x01 — out to a venue. The DEC happened above, at dispatch.
  [CONDO_STATE.venue]: { venue: true, arrive: CONDO_STATE.venueRelease, fail: CONDO_STATE.sync, stepOnEnd: 0 },
  // 0x21 — "route to lobby / saved floor", i.e. home. "fail or arrived → INC → 0x04".
  [CONDO_STATE.returnHome]: { home: true, arrive: CONDO_STATE.sync, fail: CONDO_STATE.sync, stepOnEnd: +1 },
  // 0x22 — "release venue, route home". "fail/arrived → INC → 0x04".
  [CONDO_STATE.venueRelease]: { home: true, arrive: CONDO_STATE.sync, fail: CONDO_STATE.sync, stepOnEnd: +1 },
};

/** Where this resident is standing. Placement anchors it to the condo's floor. */
const homeFloorOf = (actor, object) => actor.anchorFloor ?? object.floor;

function resolve(tower, actor, from, to, clock, ctx, state) {
  const result = ctx.resolveRoute(tower, actor, from, to, clock, {
    passengerRoute: true,
    // `specs/ROUTING.md`: family 9 enables feedback on 0x00, 0x01 and 0x20 and
    // disables it on the two return trips. `sim/routing.js` owns that table for
    // every family, so it is asked rather than restated.
    emitDistanceFeedback: emitsDistanceFeedback(FAMILY.condo, state),
    // The router takes the actor and does not echo it onto the delay. Binding
    // it here is the only place that knows whose delay this is; reading
    // `delay.actor` on the far side silently drops every one of them.
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  return result.code ?? result;
}

/**
 * `0x10` — morning dispatch setup. No route; it picks the day's path and seeds
 * the countdown. `specs/PEOPLE.md` § Family 9 dispatch table, the `0x10` row.
 */
function morningDispatch(actor, object, clock) {
  // "If `unit_status == 0x10`: rewrite to 3, mark dirty." Exactly `0x10` — the
  // sync sentinel — and not "anything in the sold band", or a condo sold this
  // morning at `0x00` would be bumped to 3 by its own first dispatch.
  if (object.unitStatus === CONDO_UNIT_STATUS.syncMarker) {
    object.unitStatus = SOLD_CYCLE_SEED;
    object.dirty = true;
  }

  if (clock.calendarPhase) {
    // "odd subtype → INC unit_status → 0x04; even → 0x01"
    if (actor.occupantIndex % 2 === 1) {
      stepUnitStatus(object, +1);
      actor.state = CONDO_STATE.sync;
    } else {
      actor.state = CONDO_STATE.venue;
    }
    return { moved: false };
  }
  // "Else: `resident_index == 1` → 0x01; else → 0x00"
  actor.state = actor.occupantIndex === 1 ? CONDO_STATE.venue : CONDO_STATE.outbound;
  return { moved: false };
}

/**
 * `0x04` — sibling sync. No route.
 *
 * `specs/PEOPLE.md`: *"State → 0x10. `try_set_parent_state_in_transit_if_all_slots_transit`:
 * if `unit_status & 7 == 1` → shortcut `unit_status = 0x10`; else check all 3
 * siblings at 0x10"*.
 *
 * ⚠️ The shortcut is guarded on the **sold band**, and that guard is not
 * decoration. An unsold condo bouncing at `0x19` satisfies `& 7 == 1` just as
 * readily as a sold one counting down to `1` — and writing `0x10` there would
 * move it into the sold band and hand the player a free $150,000 sale that no
 * resident ever routed for. That is `CLAUDE.md`'s sentinel collision with the
 * money attached.
 *
 * TODO(parity): the `else` branch — *"check all 3 siblings at 0x10"* — is not
 * implemented. `try_set_parent_state_in_transit_if_all_slots_transit` sets a
 * *parent state*, and no spec line says which field that is or what reads it.
 * Guessing "it also forces `unit_status = 0x10`" is refutable: it would fire
 * after one cycle every time, which makes the `& 7 == 1` clause dead code and
 * contradicts `PEOPLE.md`'s own *"after ~2 cycles from 3, unit_status reaches
 * 1 → sync shortcut"*. Recorded as `spec/DEVIATIONS.md` A20.
 */
function syncDispatch(actor, object) {
  actor.state = CONDO_STATE.morning;
  if (isCondoSold(object.unitStatus) && (object.unitStatus & 7) === 1) {
    object.unitStatus = CONDO_UNIT_STATUS.syncMarker;
    object.dirty = true;
  }
  return { moved: false };
}

/**
 * **`0x20`/`0x60` — the sale point.** `specs/facility/CONDO.md` § Sale Trigger
 * and `specs/PEOPLE.md`'s `0x20/0x60` dispatch row, which agree line for line.
 *
 * Two steps, and the first can fail on its own: find the service, then route to
 * it. A `0xffff` from the lookup bounces without ever asking the router, which
 * is why a tower with no venue at all is a different failure from a tower whose
 * lifts cannot reach one.
 *
 * The five outcomes:
 *
 * | route result | sold already? | effect |
 * |---|---|---|
 * | lookup `0xffff` | either | INC, bounce to `0x04`, **no sale** |
 * | `-1` | unsold | stay `0x60`, **no sale** — try again next stride |
 * | `-1` | sold | INC, bounce to `0x04` |
 * | `0`/`1`/`2` | unsold | **SELL**, then `0x60` |
 * | `3` | unsold | **SELL**, then INC and bounce to `0x04` |
 *
 * ⚠️ The `-1`-while-unsold row writes `0x60`, the **in-transit** band, and both
 * spec files say so. That is not the office's behaviour — family 7's failed
 * `0x20` returns to `0x20` and re-faces its gate. A condo resident that cannot
 * route retries every stride all day instead, which is why an unreachable condo
 * accumulates failed trips fast. It is contained by the evaluation guard in
 * {@link recomputeCondoOperationalStatus}: an unsold condo is not scored, so
 * that pile of 300-tick failures never becomes a grade.
 */
function saleDispatch(tower, actor, object, clock, ctx) {
  const unsold = !isCondoSold(object.unitStatus);
  const from = homeFloorOf(actor, object);
  const venueFloor = facilityServiceFloor(tower, saleSelector(actor.occupantIndex), from, tower.rng);

  if (venueFloor === null) {
    stepUnitStatus(object, +1);
    actor.state = CONDO_STATE.sync;
    return { moved: false, sold: false, venue: false };
  }

  const code = resolve(tower, actor, from, venueFloor, clock, ctx, CONDO_STATE.saleSeeking);

  if (code === -1) {
    if (unsold) {
      actor.state = enterTransit(CONDO_STATE.saleSeeking);
      return { moved: false, sold: false, code };
    }
    stepUnitStatus(object, +1);
    actor.state = CONDO_STATE.sync;
    return { moved: false, sold: false, code };
  }

  // "sell if still unsold" — the band is the one-shot guard, so this is safe to
  // call for all three residents and only the first one lands.
  const sold = finalizeCondoSale(tower, object, ctx);

  if (code === 3) {
    stepUnitStatus(object, +1);
    actor.state = CONDO_STATE.sync;
  } else {
    actor.state = enterTransit(CONDO_STATE.saleSeeking);
  }
  return { moved: true, sold, code };
}

// ------------------------------------------------------------- the handler

/**
 * The handler the scheduler calls, once per serviced resident.
 *
 * The gate is a **one-time barrier**: once a resident is in transit (`>= 0x40`)
 * it is dispatched every stride until the leg completes — unless it is standing
 * in a carrier queue, in which case it must be left alone. `sim/office.js`
 * carries the full account of why: re-asking the router while queued re-stamps
 * the route start, so the wait being accrued is thrown away and stress reads
 * far better than it is.
 */
export function condoFamilyHandler(ctx) {
  return function serviceCondoResident(tower, actor) {
    const object = tower.objects.get(actor.objectId);
    if (!object || object.family !== FAMILY.condo) return;

    if (actor.state >= 0x40) {
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      return void condoDispatch(tower, actor, object, tower.clock, ctx);
    }

    const verdict = condoGate(actor, object, tower.clock, tower.rng);
    if (verdict === 'hold') return;
    if (verdict === 'dispatch') return void condoDispatch(tower, actor, object, tower.clock, ctx);
    actor.state = verdict;              // a gate that rewrites state without dispatching
  };
}

/**
 * A resident got off a lift, or finished a walked leg.
 *
 * Arriving by car and arriving on foot are the same event to the state machine
 * — only the journey differed — so these are the same transitions the `3`
 * (same-floor) rows give in {@link TRIP_LEGS} and {@link saleDispatch},
 * including their `unit_status` steps.
 *
 * Without this a resident enters `0x6x`, is dispatched every stride,
 * re-resolves the route it is already on, and never progresses.
 */
export function condoArrival(tower, actor, floor) {
  const object = tower.objects.get(actor.objectId);
  const state = baseState(actor.state);
  actor.anchorFloor = floor;
  actor.routeCarrier = null;

  if (state === CONDO_STATE.saleSeeking) {
    // The sale itself already fired at dispatch, on the accepted route. This is
    // only the `3`-row's bookkeeping arriving late.
    if (object) stepUnitStatus(object, +1);
    actor.state = CONDO_STATE.sync;
    return;
  }

  const leg = TRIP_LEGS[state];
  if (!leg) { actor.state = state; return; }        // drop the transit bit regardless
  if (object && leg.stepOnEnd) stepUnitStatus(object, leg.stepOnEnd);
  actor.state = leg.arrive;
}

// ------------------------------------------------------------- the daily sweep

/** `specs/TIME.md` § 2500 — the nightly runtime refresh. */
export const CONDO_RESET_TICK = 2500;

/**
 * The condo rows of checkpoint 2500, which are two separate passes in
 * `specs/TIME.md` and both matter:
 *
 *   step 2, **reset sim state**: *"9 (condo): unit_status < 0x18 → `0x10`;
 *   else → `0x20`. Clear `spawn_floor`, `route_carrier`"* — the resident's
 *   state byte. This is what puts an unsold condo's residents back on the sale
 *   path every night, and it is the only thing that does; a refunded condo
 *   would otherwise keep running yesterday's sold-condo errands for ever.
 *
 *   step 4, **object-state floor pass**: the family-9 row clamps a sold condo
 *   back to the `0x10` sync sentinel, which is what re-seeds the countdown at
 *   the next morning dispatch. `specs/facility/CONDO.md` § End-of-day reset
 *   behavior reads the same pass the same way.
 *
 * ⚠️ `TIME.md` labels that step-4 row *"escalator (9)"* and its neighbours
 * *"hotel (3/4/5)"* and *"elevator (7)"*. Those are placed-object **type**
 * codes, where `3/4/5` is hotel, `7` is office and `9` is condo — so two of the
 * three labels are wrong and the codes are right. `CONDO.md` reads the same row
 * as the condo one, which settles it. Recorded as `spec/DEVIATIONS.md` A21.
 *
 * A resident **in transit is skipped**. `TIME.md` clears `route_carrier`
 * unconditionally, but our carriers hold their own queue of rider ids: dropping
 * the rider's token here would not cancel the ride, it would leave a passenger
 * the car still intends to deliver while the sweep pretends they are home.
 * Their leg finishes, {@link condoArrival} moves them on, and the next night's
 * sweep collects them.
 */
export function condoDailyReset(tower) {
  for (const { object, occupants } of condos(tower)) {
    const sold = isCondoSold(object.unitStatus);

    for (const resident of occupants) {
      if (resident.state >= 0x40) continue;
      resident.state = sold ? CONDO_STATE.morning : CONDO_STATE.saleSeeking;
      resident.spawnFloor = null;
      resident.routeCarrier = null;
      resident.anchorFloor = object.floor;
    }

    if (sold && object.unitStatus !== CONDO_UNIT_STATUS.syncMarker) {
      object.unitStatus = CONDO_UNIT_STATUS.syncMarker;
      object.dirty = true;
    }
  }
}

/** Every condo in the tower, with its three residents. Used by the daily sweep. */
export function condos(tower) {
  const out = [];
  for (const object of tower.objects.values()) {
    if (object.family !== FAMILY.condo) continue;
    out.push({ object, occupants: tower.actors.filter((a) => a.objectId === object.id) });
  }
  return out;
}
