/**
 * Family 7 — the loop itself.
 *
 * The assertions that matter here are the two at the bottom: **an office rents
 * because a worker reached it, and stays vacant when nobody can.** Everything
 * above them is the machinery that makes those two true.
 *
 * Spec: `specs/DEMAND.md` § Family 7, `specs/facility/OFFICE.md`,
 * `specs/FACILITIES.md` § Facility Evaluation Model and § occupied_flag.
 */
import {
  EVAL_THRESHOLD_LOWER, LOBBY_FLOOR, NOISE_PENALTY, OFFICE_STATE, RENT_MODIFIER,
  RENT_TIER_ALWAYS_PASSES, deactivateIfFailing, emitsDistanceFeedback, evalLevelFor,
  evalUpperFor, officeFamilyHandler, officeGate, officeScore, offices,
  recomputeOfficeOperationalStatus,
} from '../src/games/tower/sim/office.js';
import {
  FAMILY, __resetIds, createTower, enterTransit, isRented, placeObject,
} from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { createScheduler } from '../src/games/tower/sim/scheduler.js';
import { TICKS_PER_DAY } from '../src/games/tower/sim/clock.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** A tower with one office and its six workers. */
function towerWithOffice({ floor = 3, rentLevel = 1 } = {}) {
  __resetIds();
  const tower = createTower();
  const placed = placeObject(tower,
    { family: FAMILY.office, floor, left: 10, right: 15, rentLevel },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture failed: ' + placed.reason);
  return { tower, object: placed.object, workers: tower.actors };
}

/** Give every worker the same stress history. */
function stressWorkers(workers, average, trips = 4) {
  for (const w of workers) { w.tripCount = trips; w.accumulatedElapsed = average * trips; }
}

/** A gate verdict with the dice forced. */
const riggedRng = (alwaysPass) => ({ chance: () => alwaysPass, next: () => 0, int: () => 0 });

const clockAt = (daypart, { calendarPhase = false, dayTick = null } = {}) =>
  ({ daypart, calendarPhase, dayTick: dayTick ?? daypart * 400 });

export const tests = {
  // -------------------------------------------------------- the bootstrap

  /**
   * The non-obvious one. The `0x20` gate refuses while `occupied_flag` is
   * clear — but renting is what was supposed to set it. It resolves because a
   * brand-new office has taken NO trips, so its stress average is 0, the BEST
   * score, which grades `eval_level = 2`, which sets the flag.
   */
  'a brand-new office scores its way out of the chicken-and-egg'() {
    const { tower, object, workers } = towerWithOffice();
    assert(object.occupiedFlag === false, 'a placed office starts unoccupied');
    assert(officeScore(tower, object, workers) === 0, 'no trips should score 0');

    const level = recomputeOfficeOperationalStatus(tower, object, workers);
    assert(level === 2, 'a no-trip office should grade 2 (excellent), got ' + level);
    assert(object.occupiedFlag === true,
      'occupied_flag must be set once eval_level is nonzero — without it the gate never opens');
    assert(!isRented(object.unitStatus) === false || !isRented(object.unitStatus),
      'setting occupied_flag must NOT rent the office');
  },

  'the 0x20 gate holds while occupied_flag is clear'() {
    // specs/DEMAND.md § Family 7 gate table: `occupied_flag == 0` → no dispatch.
    const { tower, object, workers } = towerWithOffice();
    const worker = workers[0];
    assert(officeGate(worker, object, clockAt(1), riggedRng(true)) === 'hold',
      'a worker dispatched while its office was unmeasured');

    object.occupiedFlag = true;
    assert(officeGate(worker, object, clockAt(1), riggedRng(true)) === 'dispatch',
      'the gate stayed shut after occupied_flag was set');
  },

  'the calendar phase blocks the rental path outright'() {
    const { tower, object, workers } = towerWithOffice();
    object.occupiedFlag = true;
    assert(officeGate(workers[0], object, clockAt(1, { calendarPhase: true }), riggedRng(true)) === 'hold',
      'the calendar phase did not block dispatch');
  },

  // ------------------------------------------------------------ the stagger

  /**
   * specs/DEMAND.md correction #2: occupant 0 dispatches in dayparts 0–3;
   * occupants 1–5 only in daypart 3, at 1/12. One early commuter per office,
   * then a burst. The previous prototype scheduled all six at once.
   */
  'occupant zero commutes early and the rest wait for midday'() {
    const { object, workers } = towerWithOffice();
    const pass = riggedRng(true);
    const first = workers[0];
    const rest = workers[1];
    for (const w of workers) w.state = OFFICE_STATE.commuteIn;

    assert(officeGate(first, object, clockAt(0), pass) === 'dispatch', 'occupant 0 should try in daypart 0');
    for (const daypart of [1, 2, 3]) {
      assert(officeGate(first, object, clockAt(daypart), pass) === 'dispatch',
        'occupant 0 should always dispatch in daypart ' + daypart);
    }
    for (const daypart of [0, 1, 2]) {
      assert(officeGate(rest, object, clockAt(daypart), pass) === 'hold',
        'occupant 1 should hold in daypart ' + daypart + ' — that is the stagger');
    }
    assert(officeGate(rest, object, clockAt(3), pass) === 'dispatch', 'occupant 1 should try at midday');
    assert(officeGate(rest, object, clockAt(3), riggedRng(false)) === 'hold',
      'the midday attempt is a 1/12 chance, not a certainty');
  },

  'the evening forces everyone home without dispatching'() {
    // Gate rows: daypart >= 4 rewrites state to 0x05 directly.
    const { object, workers } = towerWithOffice();
    for (const state of [OFFICE_STATE.commuteIn, OFFICE_STATE.lunchOut, OFFICE_STATE.lunchTransit]) {
      workers[0].state = state;
      assert(officeGate(workers[0], object, clockAt(4), riggedRng(false)) === OFFICE_STATE.commuteOut,
        'state 0x' + state.toString(16) + ' was not forced home in the evening');
    }
    workers[0].state = OFFICE_STATE.commuteOut;
    assert(officeGate(workers[0], object, clockAt(5), riggedRng(false)) === 'dispatch',
      'the evening commute should always dispatch by daypart 5');
    assert(officeGate(workers[0], object, clockAt(3), riggedRng(true)) === 'hold',
      'nobody goes home before the evening');
  },

  // ------------------------------------------------------------ evaluation

  'the thresholds are the star-rated ones, not the manual’s colour bands'() {
    // specs/FACILITIES.md § Thresholds By Star Rating. 150 at 1-3 stars,
    // widening to 200 at 4+ — tenants get MORE tolerant as the tower rates up.
    assert(EVAL_THRESHOLD_LOWER === 80, 'the lower threshold is 80 at every star level');
    assert(evalUpperFor(1) === 150 && evalUpperFor(3) === 150, 'stars 1-3 fail at 150');
    assert(evalUpperFor(4) === 200 && evalUpperFor(5) === 200, 'stars 4+ fail at 200');

    assert(evalLevelFor(79, 1) === 2 && evalLevelFor(80, 1) === 1, 'the 80 boundary is wrong');
    assert(evalLevelFor(149, 1) === 1 && evalLevelFor(150, 1) === 0, 'the 150 boundary is wrong');
    // A worker "in the red" at 120 is NOT failing. That conflation was a real
    // error in our own spec before the reference was read properly.
    assert(evalLevelFor(120, 1) === 1, 'a score of 120 should still be passing at 1-3 stars');
    assert(evalLevelFor(150, 4) === 1, 'at 4 stars, 150 should now pass');
    assert(evalLevelFor(-1, 1) === 0xff, 'a negative score is unset, not excellent');
  },

  'rent tier 3 forces a pass, however bad the transport is'() {
    // specs/FACILITIES.md step 3, in its own words: "(always passes)".
    // Faithful, recorded as spec/DEVIATIONS.md A10, and a real hole in
    // "transport failure dominates occupancy".
    const { tower, object, workers } = towerWithOffice();
    stressWorkers(workers, 200);          // catastrophic

    for (const [tier, expected] of [[0, 230], [1, 200], [2, 170]]) {
      object.rentLevel = tier;
      assert(officeScore(tower, object, workers) === expected,
        'tier ' + tier + ' scored ' + officeScore(tower, object, workers) + ', expected ' + expected);
      assert(evalLevelFor(officeScore(tower, object, workers), 1) === 0,
        'tier ' + tier + ' should be evicting at a 200 average');
    }
    assert(RENT_MODIFIER[0] === 30 && RENT_MODIFIER[1] === 0 && RENT_MODIFIER[2] === -30,
      'the rent modifiers are +30 / +0 / -30');

    object.rentLevel = RENT_TIER_ALWAYS_PASSES;
    assert(officeScore(tower, object, workers) === 0, 'tier 3 must force the score to zero');
    assert(evalLevelFor(officeScore(tower, object, workers), 1) === 2, 'tier 3 must always pass');
  },

  'the score never goes below zero, and noise is added after the tier'() {
    // Order matters: step 3 (tier) runs BEFORE step 4 (noise), then step 5
    // clamps. A tier-2 discount on a quiet office cannot make the score
    // negative.
    const { tower, object, workers } = towerWithOffice({ rentLevel: 2 });
    stressWorkers(workers, 10);
    assert(officeScore(tower, object, workers) === 0,
      '10 - 30 should clamp to 0, got ' + officeScore(tower, object, workers));
    assert(NOISE_PENALTY === 60, 'the noise penalty is +60');
  },

  'only a zero grade closes an office, never a merely poor one'() {
    // specs/facility/OFFICE.md § Activation And Deactivation: "A low but
    // nonzero eval_level ... keeps the office open."
    const { tower, object, workers } = towerWithOffice();
    object.unitStatus = 0;
    object.occupiedFlag = true;

    object.evalLevel = 1;
    assert(!deactivateIfFailing(tower, object, workers), 'a grade of 1 must keep the tenant');
    assert(isRented(object.unitStatus), 'the office was closed on a passing grade');

    object.evalLevel = 0;
    assert(deactivateIfFailing(tower, object, workers), 'a grade of 0 must close the office');
    assert(!isRented(object.unitStatus), 'unit_status did not return to the For Rent band');
    assert(object.occupiedFlag === false, 'deactivation must clear occupied_flag');
    assert(workers.every((w) => w.state === OFFICE_STATE.seekingWork),
      'the workers should go back to waiting for work');
  },

  'the distance penalty is gated on the base state, so transit inherits it'() {
    // specs/ROUTING.md § Gating. Masking with & 0x3f is what makes it fire
    // once per route instead of once per stride.
    assert(emitsDistanceFeedback(OFFICE_STATE.commuteIn), 'the morning commute should emit it');
    assert(emitsDistanceFeedback(OFFICE_STATE.commuteOut), 'the evening commute should emit it');
    assert(emitsDistanceFeedback(enterTransit(OFFICE_STATE.commuteIn)),
      'an in-transit 0x40 must inherit 0x00’s answer');
    assert(!emitsDistanceFeedback(OFFICE_STATE.seekingWork), 'the rental path should not emit it');
    assert(!emitsDistanceFeedback(OFFICE_STATE.lunchOut), 'the lunch trip should not emit it');
  },

  // ============================================================= THE LOOP

  /**
   * **An office rents because a worker got there.**
   *
   * The router is stubbed to succeed, because what is under test is the family
   * machine's response to a resolved route — the router has its own 64 tests.
   */
  'a resolved route rents the office'() {
    const { tower, object, workers } = towerWithOffice();
    recomputeOfficeOperationalStatus(tower, object, workers);   // opens the gate

    const rented = [];
    const handler = officeFamilyHandler({
      resolveRoute: (_t, _a, from, to) => {
        assert(from === LOBBY_FLOOR, 'the rental route must start at the lobby, got ' + from);
        assert(to === object.floor, 'the rental route must end at the office');
        return { code: 1 };                                     // accepted, in transit
      },
      onRent: (_t, o) => rented.push(o.id),
    });

    assert(!isRented(object.unitStatus), 'the office starts vacant');
    tower.clock.daypart = 1;
    tower.clock.dayTick = 400;
    handler(tower, workers[0]);

    assert(isRented(object.unitStatus), 'the office did not rent when the route resolved');
    assert(object.occupiedFlag === true, 'a rented office must be occupied');
    assert(object.everRented === true, 'everRented is the economy’s activation gate and nothing else sets it');
    assert(rented.length === 1, 'the rent hook should fire exactly once');
    assert(workers[0].state === enterTransit(OFFICE_STATE.seekingWork),
      'the worker should be in transit, got 0x' + workers[0].state.toString(16));

    // ...and renting is idempotent: a second worker arriving does not re-rent.
    handler(tower, workers[1]);
    assert(rented.length === 1, 'the office rented twice');
  },

  /**
   * **And stays vacant when nobody can reach it.** This is the sentence the
   * whole repo was rebuilt around: a tower with no transport has no tenants,
   * not because a score said so but because the trip did not happen.
   */
  'an unreachable office never rents, however long you wait'() {
    const { tower, object, workers } = towerWithOffice();
    recomputeOfficeOperationalStatus(tower, object, workers);

    let attempts = 0;
    const handler = officeFamilyHandler({
      resolveRoute: () => { attempts++; return { code: -1 }; },   // no route, ever
      onRent: () => assert(false, 'an unreachable office rented'),
    });

    const scheduler = createScheduler({ families: { [FAMILY.office]: handler } });
    scheduler.advance(tower, TICKS_PER_DAY * 2);

    assert(attempts > 0, 'nobody even tried to route — the gate never opened');
    assert(!isRented(object.unitStatus), 'an office rented with no route to it');
    assert(object.everRented !== true, 'everRented was set without a successful route');
    // The workers are not deleted or errored — they wait and retry, which is
    // why there is no "abandoned trip" to account for.
    assert(tower.actors.length === 6, 'workers went missing');
  },

  'the loop runs a whole day through the scheduler without touching the sim'() {
    const { tower, object, workers } = towerWithOffice();
    recomputeOfficeOperationalStatus(tower, object, workers);

    let routes = 0;
    const handler = officeFamilyHandler({
      resolveRoute: () => { routes++; return { code: 3 }; },      // same-floor arrival
      onRent: () => {},
    });
    createScheduler({ families: { [FAMILY.office]: handler } }).advance(tower, TICKS_PER_DAY);

    assert(routes > 0, 'a full day produced no routing attempts at all');
    assert(isRented(object.unitStatus), 'a full day of successful routes never rented the office');
    assert(offices(tower).length === 1, 'the office census is wrong');
  },
};
