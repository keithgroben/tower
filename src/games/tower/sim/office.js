/**
 * Family 7 — office workers. **This is the loop.**
 *
 * Spec: `specs/DEMAND.md` § Family 7 (gate table, dispatch table, route-result
 * writes), `specs/facility/OFFICE.md`, `specs/FACILITIES.md` § occupied_flag
 * and § Thresholds By Star Rating.
 *
 * Everything else in `sim/` exists to make this file possible. An office does
 * not rent because a score cleared a bar — it rents because **a worker got
 * there**:
 *
 *   1. Placing an office creates six workers, parked in `0x20`, unemployed.
 *   2. Each tick the stride services one sixteenth of them; a serviced worker
 *      rolls dice against its state's gate.
 *   3. A worker that passes asks the router for a lobby → office route.
 *   4. If the route **resolves**, the office rents. If it does not, nothing
 *      happens: the worker stays parked and tries again later, and the office
 *      sits "For Rent" because nobody could reach it.
 *
 * ## The bootstrap, which is not obvious
 *
 * The `0x20` gate refuses to dispatch while `occupied_flag` is clear — so at
 * first glance a vacant office can never rent, because renting is what sets
 * that flag. It resolves through the stress model, and the resolution is
 * rather beautiful:
 *
 * `occupied_flag` is set by `recompute_object_operational_status` the moment
 * `eval_level` first becomes nonzero. A brand-new office has taken **no trips**,
 * so its stress average is `0` — the *best* possible score — which maps to
 * `eval_level = 2`. The flag is set, the gate opens, and a worker may try.
 *
 * So the flag does not mean "rented". It means *"this facility's tenants are
 * being measured"*, and clearing it freezes the stress average rather than
 * letting an idle tenant look perfect.
 */
import {
  FAMILY, UNIT_STATUS, baseState, enterTransit, isRented,
} from './state.js';
import { EVENING_DAYPART } from './clock.js';
import {
  computeObjectOperationalScore, computeRuntimeTileStressAverage,
} from './stress.js';
// Imported directly rather than passed through `ctx`, deliberately: a ctx entry
// with a permissive default is a thing that can be forgotten, and forgetting
// THIS one makes the tower look better than it is. See the note in
// `officeFamilyHandler`.
import { shouldWaitForQueuedCarrier } from './routing.js';

/** The lobby. Logical floor 0 — the reference's EXE floor 10. */
export const LOBBY_FLOOR = 0;

/**
 * Worker states, `specs/DEMAND.md` § Family 7. `0x4x` is `0x0x` in transit and
 * `0x6x` is `0x2x` in transit; the dispatch handler is shared, which is why
 * these are named for the base state only.
 */
export const OFFICE_STATE = {
  /** At the lobby, wanting to commute in. */
  commuteIn: 0x00,
  /** At the office, wanting lunch. */
  lunchOut: 0x01,
  /** Continuing to a venue. */
  lunchTransit: 0x02,
  /** At the office, wanting to go home. */
  commuteOut: 0x05,
  /** Waiting to be employed. The rental path. */
  seekingWork: 0x20,
  /** Arrived at the office. */
  atWork: 0x21,
  /** Route failed while the office was already open. */
  strandedOpen: 0x25,
  /** Route failed outright. */
  strandedFailed: 0x26,
  /** Parked for the night. Terminal to the gate. */
  parked: 0x27,
};

/** `specs/FACILITIES.md` § Thresholds By Star Rating. */
export const EVAL_THRESHOLD_LOWER = 80;
export const evalUpperFor = (starCount) => (starCount >= 4 ? 200 : 150);

/**
 * Map a stress score to a readiness grade.
 * `specs/FACILITIES.md` § Score mapping. Note `< 0` is its own answer (`0xff`),
 * not clamped into a grade — a negative score means "unset", not "excellent".
 */
export function evalLevelFor(score, starCount = 1) {
  if (score < 0) return 0xff;
  if (score < EVAL_THRESHOLD_LOWER) return 2;
  return score < evalUpperFor(starCount) ? 1 : 0;
}

/**
 * `recompute_object_operational_status`, the office slice.
 *
 * Runs daily. Sets `occupied_flag` the first time `eval_level` is nonzero,
 * which is the bootstrap described at the top of this file — and is why a
 * freshly placed office becomes eligible to rent without anything having
 * happened to it yet.
 *
 * @param {object} tower
 * @param {object} object the placed office
 * @param {object[]} occupants its six workers
 */
export function recomputeOfficeOperationalStatus(tower, object, occupants) {
  const score = officeScore(tower, object, occupants);
  object.evalLevel = evalLevelFor(score, tower.starCount);
  // "set to 1 when eval_level first becomes nonzero" — set, never cleared
  // here. Clearing is deactivation's job.
  if (object.evalLevel !== 0 && object.evalLevel !== 0xff) object.occupiedFlag = true;
  return object.evalLevel;
}

/**
 * The pricing-tier modifier, `specs/FACILITIES.md` § Facility Evaluation Model
 * step 3. Not a nudge — **tier 3 forces the score to zero**, in the spec's own
 * words *"(always passes)"*.
 *
 * So a tier-3 office cannot fail evaluation however bad its transport is. It
 * still earns `$2,000`, still holds six workers, still generates traffic. That
 * is a real hole in "transport failure dominates occupancy", it is the
 * reference's own design, and under *faithful first* it stays. See
 * `spec/DEVIATIONS.md` A10 and `spec/TICK-MODEL.md` §1.
 */
export const RENT_MODIFIER = { 0: 30, 1: 0, 2: -30 };
export const RENT_TIER_ALWAYS_PASSES = 3;

/** The `+60` charged when a noise source stands within the family's radius. */
export const NOISE_PENALTY = 60;
/** `specs/FACILITIES.md`: office 10 tiles, hotel 20, condo 30. */
export const OFFICE_NOISE_RADIUS = 10;

/**
 * Is a noise source within `OFFICE_NOISE_RADIUS` tiles on either side, on this
 * office's own floor?
 *
 * TODO(parity): no noise-source family exists in this build yet — commercial
 * and entertainment are unbuilt — so this is always false today. Written now
 * because a scoring step that silently does not exist is worse than one that
 * does nothing visibly, and because the radius is family-specific and belongs
 * next to the family it describes.
 */
export function noiseSourceNear(tower, object) {
  return noiseSourceWithin(tower, object, OFFICE_NOISE_RADIUS, OFFICE_NOISE_FAMILIES);
}

/** `specs/FACILITIES.md` § Noise Source Matching, the office row. */
export const OFFICE_NOISE_FAMILIES = new Set([FAMILY.fastFood, FAMILY.retail]);

/**
 * § Noise Search, the geometry — *"scans placed-object slots on the same floor
 * in both directions ... comparing tile positions against a per-family radius,
 * and returns the first qualifying noise-source family found"*.
 *
 * The **radius and the source set are per-family and the walk is not**, so the
 * walk lives here once and each family supplies its own two values. A condo's
 * radius is 30 to an office's 10, and a condo counts offices and hotels as
 * noise where an office counts neither — copying eight lines of gap arithmetic
 * per family is how `CLAUDE.md`'s "a rule written in four places drifts" starts.
 */
export function noiseSourceWithin(tower, object, radius, families) {
  for (const other of tower.objects.values()) {
    if (other.floor !== object.floor || other.id === object.id) continue;
    if (!families.has(other.family)) continue;
    // Gap between spans, on whichever side the neighbour sits.
    const gap = other.left > object.right ? other.left - object.right
      : object.left > other.right ? object.left - other.right : 0;
    if (gap <= radius) return true;
  }
  return false;
}

/**
 * The whole facility evaluation, in the reference's order — and the order
 * matters. `specs/FACILITIES.md` § Facility Evaluation Model:
 *
 *   1-2. average per-sim stress across the population
 *   3.   pricing-tier modifier (tier 3 forces zero)
 *   4.   `+60` if a noise source is in radius
 *   5.   clamp to `>= 0`
 *   6.   map to `eval_level`
 *
 * Note step 3 runs **before** step 4, so a tier-3 office's forced zero is then
 * eligible to be pushed back up to 60 by a noisy neighbour. "Always passes" is
 * therefore true only in a quiet part of the tower — 60 is still under the
 * lower threshold of 80, so it survives, but the ordering is not academic and
 * would matter the moment a second penalty is added.
 */
export function officeScore(tower, object, occupants) {
  const base = computeObjectOperationalScore(occupants, occupants.length);
  const priced = object.rentLevel === RENT_TIER_ALWAYS_PASSES
    ? 0
    : base + (RENT_MODIFIER[object.rentLevel] ?? 0);
  const noised = priced + (noiseSourceNear(tower, object) ? NOISE_PENALTY : 0);
  return Math.max(0, noised);
}

/**
 * The gate. `specs/DEMAND.md` § Family 7 § Gate Table (binary-verified).
 *
 * Returns `'dispatch'`, `'hold'`, or a state byte to write directly — some
 * gates rewrite state without dispatching, which is how the evening forces
 * everyone home.
 *
 * The stagger lives here, and it is per-worker: **occupant 0 commutes in from
 * daypart 0, everyone else waits until daypart 3.** One early commuter per
 * office, then a burst. That is the reference's "realistic staggered morning
 * commute", and it is what the previous prototype's single scheduled arrival
 * time could not produce.
 */
export function officeGate(actor, object, clock, rng) {
  const state = baseState(actor.state);
  const { daypart, dayTick, calendarPhase } = clock;
  const evening = daypart >= EVENING_DAYPART;

  switch (state) {
    case OFFICE_STATE.commuteIn:
      if (evening) return OFFICE_STATE.commuteOut;
      if (actor.occupantIndex === 0) return daypart === 0 ? chance(rng, 12) : 'dispatch';
      // Occupants 1-5 hold until midday, then trickle.
      return daypart === 3 ? chance(rng, 12) : 'hold';

    case OFFICE_STATE.lunchOut:
    case OFFICE_STATE.lunchTransit:
      if (evening) return OFFICE_STATE.commuteOut;
      if (daypart === 0) return 'hold';
      if (daypart === 1) return chance(rng, 12);
      return 'dispatch';

    case OFFICE_STATE.commuteOut:
      if (daypart < EVENING_DAYPART) return 'hold';
      return daypart === 4 ? chance(rng, 6) : 'dispatch';

    case OFFICE_STATE.seekingWork:
      // Two hard blocks before any dice. The calendar phase is a rhythm of the
      // reference's own; `occupiedFlag` is the bootstrap gate.
      if (calendarPhase) return 'hold';
      if (!object.occupiedFlag) return 'hold';
      if (daypart === 0) return chance(rng, 12);
      return daypart <= 2 ? 'dispatch' : 'hold';

    case OFFICE_STATE.atWork:
      if (evening) return OFFICE_STATE.parked;
      return daypart === 3 ? chance(rng, 12) : 'hold';

    case OFFICE_STATE.strandedOpen:
    case OFFICE_STATE.strandedFailed:
    case OFFICE_STATE.parked:
      // Night parking releases only once the day counter has moved.
      return dayTick > 2300 ? OFFICE_STATE.seekingWork : 'hold';

    default:
      return 'hold';
  }
}

const chance = (rng, n) => (rng.chance(n) ? 'dispatch' : 'hold');

/**
 * The dispatch handler. `specs/DEMAND.md` § Family 7 § Dispatch Table and
 * § Route-result state writes.
 *
 * `ctx` supplies the seams this module deliberately does not own:
 *   `resolveRoute(tower, actor, from, to, clock, options)` → routing
 *   `onRent(tower, object)`                                → economy activation
 *   `onDelay(delay)`                                       → the stress pipeline
 */
export function officeDispatch(tower, actor, object, clock, ctx) {
  const state = baseState(actor.state);

  // Lunch needs commercial venues, which this build does not have yet. A
  // worker that would go to lunch simply stays at work until the evening gate
  // sends it home — the commute loop is complete without it.
  // TODO(parity): states 0x01/0x02/0x22/0x23 once fast food exists.
  if (state === OFFICE_STATE.lunchOut || state === OFFICE_STATE.lunchTransit) {
    actor.state = OFFICE_STATE.atWork;
    return { moved: false };
  }

  const inbound = state === OFFICE_STATE.commuteIn || state === OFFICE_STATE.seekingWork;
  const from = inbound ? LOBBY_FLOOR : object.floor;
  const to = inbound ? object.floor : LOBBY_FLOOR;

  const result = ctx.resolveRoute(tower, actor, from, to, clock, {
    passengerRoute: true,
    emitDistanceFeedback: emitsDistanceFeedback(state),
    // The router reports delays but does not know whose they are — it takes
    // the actor as a parameter and does not echo it. Binding it here is the
    // only place that knows. Reading `delay.actor` on the consuming side
    // silently drops every delay, which is exactly what it did once.
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  const code = result.code ?? result;

  if (state === OFFICE_STATE.seekingWork) return seekingWorkResult(tower, object, actor, code, ctx);

  if (state === OFFICE_STATE.commuteIn) {
    actor.state = code === -1 ? OFFICE_STATE.strandedFailed
      : code === 3 ? OFFICE_STATE.atWork
        : enterTransit(OFFICE_STATE.commuteIn);
    return { moved: code !== -1, code };
  }

  if (state === OFFICE_STATE.atWork) {
    actor.state = code === -1 ? OFFICE_STATE.strandedFailed
      : code === 3 ? OFFICE_STATE.commuteOut
        : enterTransit(OFFICE_STATE.atWork);
    return { moved: code !== -1, code };
  }

  // commuteOut — the evening trip home. A same-floor arrival parks for the night.
  actor.state = code === -1 ? OFFICE_STATE.strandedFailed
    : code === 3 ? OFFICE_STATE.parked
      : enterTransit(OFFICE_STATE.commuteOut);
  return { moved: code !== -1, code };
}

/**
 * **The moment the whole rebuild exists for.**
 *
 * `specs/DEMAND.md` § Route-result state writes, the `0x20/0x60` rows. A route
 * that resolves — by any of the three accepted codes, or by same-floor arrival
 * — rents the office. A route that fails leaves it vacant, and which parked
 * state the worker takes depends on whether the office was already open.
 */
function seekingWorkResult(tower, object, actor, code, ctx) {
  const wasVacant = !isRented(object.unitStatus);

  if (code === -1) {
    // Vacant and unreachable: back to waiting, and try again tomorrow.
    // Already open: a different parked state, because the office does not
    // un-rent just because one worker could not get in today.
    actor.state = wasVacant ? OFFICE_STATE.seekingWork : OFFICE_STATE.strandedOpen;
    actor.routeCarrier = null;
    actor.spawnFloor = null;
    return { moved: false, code, rented: false };
  }

  if (wasVacant) {
    object.unitStatus = 0;          // the open band; isRented() now true
    object.occupiedFlag = true;
    object.everRented = true;       // economy's activation gate — nothing else sets it
    ctx.onRent?.(tower, object);
    object.dirty = true;
  }

  actor.state = code === 3 ? OFFICE_STATE.atWork : enterTransit(OFFICE_STATE.seekingWork);
  return { moved: true, code, rented: wasVacant };
}

/**
 * `emit_distance_feedback` is read from the **base** state, which is what makes
 * an in-transit `0x40` inherit `0x00`'s answer and fire the penalty once per
 * route rather than once per stride. `specs/ROUTING.md` § Gating: for family 7
 * only the two commutes enable it.
 */
export const emitsDistanceFeedback = (state) =>
  baseState(state) === OFFICE_STATE.commuteIn || baseState(state) === OFFICE_STATE.commuteOut;

/**
 * The handler the scheduler calls, once per serviced worker.
 *
 * The gate is a **one-time barrier**: once a worker is in transit (`>= 0x40`)
 * it is dispatched unconditionally every stride until the leg completes. That
 * is `specs/PEOPLE.md` § Refresh handler flow, and it is why a worker who
 * cannot be routed simply waits and retries rather than generating an
 * "abandoned trip" that the accounting would have to explain.
 */
export function officeFamilyHandler(ctx) {
  return function serviceOfficeWorker(tower, actor) {
    const object = tower.objects.get(actor.objectId);
    if (!object || object.family !== FAMILY.office) return;

    if (actor.state >= 0x40) {
      // `specs/PEOPLE.md` § Refresh handler flow splits on the ROUTE TOKEN, not
      // just the state: a rider holding a **carrier** token is waiting for a
      // car and goes to `maybe_dispatch_queued_route_after_wait`; one holding a
      // **segment** token walks and goes to family dispatch. Both branches sit
      // under the same `state >= 0x40` test, which is what makes this easy to
      // miss — and it was missed.
      //
      // Re-asking the router while queued does not just waste a call: every
      // re-resolution RE-STAMPS the route start, so the wait being accrued is
      // thrown away. Measured average stress read **7 where the honest figure
      // was 81**. It fails in the flattering direction — a tower that looks
      // perfect however bad its lifts are, which is the failure this repo
      // keeps a list of.
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      return void officeDispatch(tower, actor, object, tower.clock, ctx);
    }

    const verdict = officeGate(actor, object, tower.clock, tower.rng);
    if (verdict === 'hold') return;
    if (verdict === 'dispatch') return void officeDispatch(tower, actor, object, tower.clock, ctx);
    actor.state = verdict;          // a gate that rewrites state without dispatching
  };
}

/**
 * A worker got off a lift.
 *
 * The carrier delivers; the family decides what that *means*. These are the
 * same transitions `specs/DEMAND.md` § Route-result state writes gives for a
 * same-floor arrival (result `3`), because arriving by car and arriving by
 * walking are the same event to the state machine — only the journey differed.
 *
 * Without this a worker enters `0x60`, is dispatched unconditionally every
 * stride, re-resolves the route it is already on, and never progresses. The
 * tower rents its offices and then nobody ever moves again, which is exactly
 * what it did before this existed.
 */
export function officeArrival(actor, floor) {
  const state = baseState(actor.state);
  actor.anchorFloor = floor;
  switch (state) {
    case OFFICE_STATE.seekingWork:            // 0x60 -> arrived at work
    case OFFICE_STATE.commuteIn:              // 0x40 -> arrived at work
      actor.state = OFFICE_STATE.atWork; break;
    case OFFICE_STATE.atWork:                 // 0x61 -> heading home next
      actor.state = OFFICE_STATE.commuteOut; break;
    case OFFICE_STATE.commuteOut:             // 0x45 -> home, park for the night
      actor.state = OFFICE_STATE.parked; break;
    default:
      actor.state = state; break;             // drop the transit bit regardless
  }
  actor.routeCarrier = null;
}

/** Every office in the tower, with its workers. Used by the daily sweep. */
export function offices(tower) {
  const out = [];
  for (const object of tower.objects.values()) {
    if (object.family !== FAMILY.office) continue;
    out.push({ object, occupants: tower.actors.filter((a) => a.objectId === object.id) });
  }
  return out;
}

/**
 * Deactivation. `specs/facility/OFFICE.md` § Parity: Activation And
 * Deactivation — **only a zero `eval_level` closes an office.** A low but
 * nonzero grade keeps the tenant, which is what makes closure represent
 * sustained dissatisfaction rather than one bad commute.
 */
export function deactivateIfFailing(tower, object, occupants, ctx) {
  if (object.evalLevel !== 0 || !isRented(object.unitStatus)) return false;
  object.unitStatus = UNIT_STATUS.syncMarker;   // 0x10 — reads as "For Rent"
  object.occupiedFlag = false;
  object.activationTickCount = 0;
  object.dirty = true;
  for (const worker of occupants) worker.state = OFFICE_STATE.seekingWork;
  ctx?.onVacate?.(tower, object);
  return true;
}

/** The per-worker stress average, for the renderer and the daily sweep. */
export const workerStress = (actor) => computeRuntimeTileStressAverage(actor);
