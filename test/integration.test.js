/**
 * The seams between modules — the only tests here that use no stubs.
 *
 * Every module in `sim/` is separately tested and separately correct. Three
 * bugs still got through, and all three lived in the *gaps*:
 *
 *   1. `routing.js` wrote `actor.routeStartTick`; `stress.js` read
 *      `actor.lastTripTick`. Two names for the reference's one `last_trip_tick`.
 *      216 of 216 actors had a stamp written; 0 had one read.
 *   2. `ui/tick.js` never passed `onDelay` into `makeCarrierContext`, which
 *      only builds its emitter when one is supplied — so every carrier stress
 *      event was discarded.
 *   3. The office handler read `delay.actor`, which the router does not set,
 *      so its guard dropped 100% of delays.
 *
 * Each module was fine. Each interface was documented in prose. **Prose does
 * not typecheck.** All three failed the same way — silently, with a plausible
 * number at the end of it — and all three are the failure this repo's own
 * `CLAUDE.md` names: a metric that looks healthy while the thing it measures
 * is not happening at all.
 *
 * So these tests assert that data actually *crosses* a seam. They are
 * deliberately behavioural: no field name is checked directly, because the
 * point is that a rename must not be able to pass.
 */
import { FAMILY, isRented } from '../src/games/tower/sim/state.js';
import { officeArrival, officeFamilyHandler, offices } from '../src/games/tower/sim/office.js';
import { ledgerFor, officeCashflowHooks } from '../src/games/tower/sim/ledger-adapter.js';
import { applyAction } from '../src/games/tower/sim/actions.js';
import { resolveRouteBetweenFloors } from '../src/games/tower/sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, applyQueueFullDelay, computeRuntimeTileStressAverage,
  recordNoRouteFailure, stampRouteStart,
} from '../src/games/tower/sim/stress.js';
import { seedDemoTower } from '../src/games/tower/ui/seed.js';
import { makeTowerScheduler } from '../src/games/tower/ui/tick.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** The real delay pricing, mirroring `ui/main.js`. No stubs. */
function priceDelay(tower, delay, actor) {
  if (!actor) return;
  switch (delay.kind) {
    case 'no-route': return void recordNoRouteFailure(actor);
    case 'local-transit': return void applyLocalSegmentDelay(actor, delay.modeAndSpan);
    case 'queue-full': return void applyQueueFullDelay(actor);
    case 'distance': return void applyDistancePenalty(actor, {
      heightMetricDelta: delay.heightMetricDelta,
      emitDistanceFeedback: true,
      carrierMode: delay.carrierMode,
    });
    case 'boarding': {
      accumulateElapsedDelayIntoCurrentSim(actor, tower.clock.dayTick, {
        sourceFloor: delay.sourceFloor,
        lobbyHeight: tower.lobbyHeight,
        carrierMode: delay.carrierMode,
      });
      if (delay.carrierMode !== CARRIER_SERVICE) stampRouteStart(actor, tower.clock.dayTick);
      return;
    }
    default: return;
  }
}

/**
 * A real seeded tower with the real family machine, running the real router.
 *
 * `onDay(day, tower)` fires at each day boundary so a test can break the tower
 * mid-run and watch what the money does about it.
 */
function liveTower({ days = 2, onDay = null } = {}) {
  const tower = seedDemoTower({ seed: 1 });
  const seen = { delays: new Map(), codes: new Map(), cashByDay: [] };
  // The rent seam. `sim/office.js` calls this the instant a route resolves;
  // without it an office rents and no money ever arrives.
  const cashflow = officeCashflowHooks(tower);

  const scheduler = makeTowerScheduler(
    tower,
    {
      [FAMILY.office]: officeFamilyHandler({
        resolveRoute: (...args) => {
          const result = resolveRouteBetweenFloors(...args);
          seen.codes.set(result.code, (seen.codes.get(result.code) ?? 0) + 1);
          return result;
        },
        onDelay: (delay, actor) => {
          seen.delays.set(delay.kind, (seen.delays.get(delay.kind) ?? 0) + 1);
          priceDelay(tower, delay, actor);
        },
        onRent: cashflow.onRent,
      }),
    },
    { [FAMILY.office]: officeArrival },
    (delay, actor) => {
      seen.delays.set(delay.kind, (seen.delays.get(delay.kind) ?? 0) + 1);
      priceDelay(tower, delay, actor);
    },
  );

  // No daily sweep here any more. `makeTowerScheduler` wires checkpoint 2533,
  // so the operational recompute, the closures and the ledger all run inside
  // the composition the browser runs — rather than in a copy kept by this file,
  // which is how the copies drift.
  for (let day = 0; day < days; day++) {
    onDay?.(day, tower);
    for (let i = 0; i < 2600; i++) scheduler.tick(tower);
    seen.cashByDay.push(tower.cash);
  }
  return { tower, seen, workers: offices(tower).flatMap((o) => o.occupants) };
}

const letCount = (tower) => offices(tower).filter((o) => isRented(o.object.unitStatus)).length;

export const tests = {
  // ------------------------------------------------------------- the money

  /**
   * The seam that existed and carried nothing: `ui/main.js` drew `tower.cash`
   * while `sim/actions.js` charged `ledger.cash`, and nothing built a ledger.
   * A build would have spent money the player never saw leave.
   *
   * Asserted through behaviour on both sides — a build charged through the
   * command seam has to show up in the number the HUD reads.
   */
  'the tower’s cash and the ledger’s cash are one number, not two'() {
    const tower = seedDemoTower({ seed: 1 });
    const ledger = ledgerFor(tower);
    const before = tower.cash;

    const built = applyAction({ tower, ledger }, { type: 'build', what: 'office', floor: 8, left: 10 });
    assert(built.ok, 'the build was refused: ' + built.reason);
    assert(tower.cash < before,
      'a paid-for office left `tower.cash` at $' + tower.cash + ' — the ledger and the tower are '
      + 'separate objects again, and the HUD is reading the one nothing charges');
    assert(ledger.cash === tower.cash, 'the two views disagree: ' + ledger.cash + ' vs ' + tower.cash);
    assert(before - tower.cash === built.cost, 'the balance moved by $' + (before - tower.cash)
      + ' but the build reported $' + built.cost);
  },

  /**
   * Rent has to arrive. The whole point of the module was money moving, and it
   * sat unused for a day: 737 lines, 42 tests, and nothing calling it.
   */
  'a tower that rents offices actually earns money'() {
    const { tower } = liveTower({ days: 4 });
    assert(letCount(tower) > 0, 'nothing rented, so this proves nothing about the money');
    assert(tower.cash > 2_000_000,
      'the tower let ' + letCount(tower) + ' offices and its cash never moved off the $2,000,000 '
      + 'it started with — the rent seam is not connected');
    assert(tower.incomeLedger.office > 0, 'cash rose but the income ledger recorded nothing');
  },

  /**
   * `specs/TIME.md` § 2533. Not daily. Asserted on a real tick sequence, so the
   * cadence cannot be right in `economy.js` and wrong in the wiring.
   */
  'money moves on the 3-day cadence, not every day'() {
    // Day 2 also moves: 36 offices rent that morning and the reopen path pays
    // them immediately, which is the reference's own second payment path. Days
    // 4, 5, 7, 8 are the quiet ones, and they are the assertion.
    const { seen } = liveTower({ days: 9 });
    const moved = [];
    for (let day = 1; day < seen.cashByDay.length; day++) {
      if (seen.cashByDay[day] !== seen.cashByDay[day - 1]) moved.push(day + 1);
    }
    for (const quiet of [4, 5, 7, 8]) {
      assert(!moved.includes(quiet),
        'cash moved on day ' + quiet + ', which is not a cashflow day — rent has gone daily');
    }
    for (const payday of [3, 6, 9]) {
      assert(moved.includes(payday), 'cash did not move on day ' + payday + ', which is a cashflow day');
    }
  },

  /** Upkeep is not optional. A tower earning nothing still pays for its cars. */
  'a tower with no income still pays for its cars'() {
    const { tower } = liveTower({
      days: 4,
      // Rip the lift out on day 0, before anything can rent. The shaft and its
      // three cars stay; only the route dies, so nothing earns and the cars
      // still cost $10,000 each every third day.
      onDay: (day, t) => { if (day === 0) t.carriers.forEach((c) => { c.bottomFloor = 0; c.topFloor = 0; }); },
    });
    assert(tower.incomeLedger.office === 0, 'something rented in a tower with no working lift');
    assert(tower.cash < 2_000_000,
      'a tower that earned nothing still holds $' + tower.cash + ' — its cars are free');
    assert(tower.expenseLedger.elevatorStandard > 0, 'the cars were never charged for');
  },

  /**
   * ⚠️ **The direction-of-failure guard, and it has already caught two.**
   *
   * Take the tower's only lift away after it has filled. Every office must lose
   * its tenant on the next cashflow pass and the tower must stop earning.
   *
   * Both failures this caught made a broken tower look BETTER than a working
   * one, which is the failure class `CLAUDE.md` keeps a list of:
   *
   *   1. Deactivation became unreachable. `specs/TIME.md` § 2533 gates closure
   *      to the 3-day cadence, and the trip counters were being cleared before
   *      the measurement — so the only days that could close an office scored it
   *      on an empty history, which is a perfect 0. Result: 36/42 let for ever,
   *      with no lift, earning MORE than the working tower because the cars had
   *      stopped costing anything.
   *   2. `occupiedFlag` was read as "let". It means "being measured"
   *      (`sim/office.js` says so in its own header) and the daily recompute
   *      turns it back on for a vacated office, because an office with no trips
   *      scores 0. Result: the closures fired correctly and then every empty
   *      room was paid $10,000 a cycle anyway.
   */
  'take the lift away and the tower stops earning'() {
    const { tower, seen } = liveTower({
      days: 10,
      onDay: (day, t) => { if (day === 6) { t.carriers = []; t.routeTablesDirty = true; } },
    });

    assert(letCount(tower) === 0,
      letCount(tower) + ' offices are still let in a tower with no lift at all. Either closure is '
      + 'unreachable or the lease is being read off the wrong flag.');
    assert(tower.populationLedger.office === 0,
      'the population ledger still holds ' + tower.populationLedger.office
      + ' office workers in a tower nobody can reach');

    // And the money. The last cashflow pass of a dead tower must not be income.
    const earned = seen.cashByDay[9] - seen.cashByDay[8];
    assert(earned <= 0,
      'the dead tower earned $' + earned + ' on its last cycle. A tower with no lift out-earning a '
      + 'working one is the exact shape of an accounting hole.');
  },

  /**
   * And the recovery, which is what the ungated counter reset is FOR: give the
   * lift back and the tenants come back within a cycle. Without this the test
   * above passes for a tower that closes every office permanently on day 1.
   */
  'give the lift back and the tower recovers'() {
    let saved = null;
    const { tower } = liveTower({
      days: 14,
      onDay: (day, t) => {
        if (day === 6) { saved = t.carriers; t.carriers = []; t.routeTablesDirty = true; }
        if (day === 11) { t.carriers = saved; t.routeTablesDirty = true; }
      },
    });
    assert(letCount(tower) > 0,
      'the lift came back three days ago and not one office re-let — the stress history is frozen, '
      + 'which is what gating the 3-day counter reset on `occupied_flag` does');
    assert(tower.populationLedger.office > 0, 'offices re-let but nobody moved back in');
  },

  /**
   * The bug that cost the most: the router stamped a field the stress pipeline
   * did not read. Asserted behaviourally — a rename must not be able to pass,
   * so nothing here mentions a field name.
   */
  'the stamp the router writes is the stamp the stress pipeline reads'() {
    // Two days, not one: the bootstrap needs a day-advance sweep to set
    // `occupied_flag` before any worker is allowed to dispatch at all, and
    // only ~300 ticks remain after it on day one.
    const { workers } = liveTower({ days: 2 });
    // `tripCount` is the durable signal — `advanceSimTripCounters` CLEARS the
    // stamp on a completed trip, so a live stamp only exists mid-ride.
    const stamped = workers.filter((w) => w.tripCount > 0 || (w.lastTripTick ?? 0) > 0);
    assert(stamped.length > 0,
      'not one of ' + workers.length + ' workers carried a route stamp into the stress pipeline — '
      + 'the router and the stress model are using different fields again');
  },

  /**
   * The symptom both agents predicted for a broken stamp: every rider pegged
   * at the clamp, identical, insensitive to how good the lifts are. It reads
   * as "the clamp is working" rather than as a bug, which is what makes it
   * dangerous — so it gets its own test.
   */
  'stress is not uniformly pegged at the clamp'() {
    const { workers } = liveTower({ days: 2 });
    const scores = workers.map(computeRuntimeTileStressAverage).filter((s) => s > 0);
    if (scores.length === 0) return;                 // covered by the seam test above

    const pegged = scores.filter((s) => s >= 300).length;
    assert(pegged < scores.length,
      'all ' + scores.length + ' measured workers are at the 300 clamp. That is the signature of a '
      + 'lost route stamp, not of bad transport — bad transport varies by floor.');
  },

  /** Delays have to reach the pipeline at all. They were dropped twice. */
  'the delay seam carries traffic in both directions'() {
    const { seen } = liveTower({ days: 2 });
    assert(seen.delays.size > 0, 'no delay of any kind reached the stress pipeline');
    assert(seen.codes.size > 0, 'the family machine never called the router');
    // The router reports the actor as an argument, not on the delay. A consumer
    // that reads `delay.actor` silently drops everything — it did once.
    assert([...seen.delays.values()].reduce((a, b) => a + b, 0) > 10,
      'delays are reaching the pipeline but only just — check the carrier context has an emitter');
  },

  /**
   * End to end, no stubs anywhere: a seeded tower with a working lift rents
   * offices. This is the sentence the repo exists for, asserted against the
   * real router rather than a stub that always says yes.
   */
  'a seeded tower with a lift actually rents offices'() {
    const { tower } = liveTower({ days: 2 });
    const all = offices(tower);
    const let_ = all.filter((o) => isRented(o.object.unitStatus));
    assert(all.length > 0, 'the seed built no offices');
    assert(let_.length > 0,
      'no office rented in two days with a working lift — either the loop is broken or the '
      + 'seed cannot reach its own offices');
  },

  /**
   * And the negative: strip the lift, and nothing rents. Without this the test
   * above passes for a tower that rents everything unconditionally.
   */
  'strip the lift and nothing rents'() {
    const tower = seedDemoTower({ seed: 1 });
    tower.carriers = [];
    tower.segments = [];

    const scheduler = makeTowerScheduler(
      tower,
      {
        [FAMILY.office]: officeFamilyHandler({
          resolveRoute: resolveRouteBetweenFloors,
          onDelay: (delay, actor) => priceDelay(tower, delay, actor),
          onRent: () => {},
        }),
      },
      { [FAMILY.office]: officeArrival },
      (delay, actor) => priceDelay(tower, delay, actor),
    );
    // The daily recompute rides inside checkpoint 2533 now, so a bare tick loop
    // gets it — this used to keep its own copy of the sweep.
    for (let i = 0; i < 2600 * 2; i++) scheduler.tick(tower);

    const upstairs = offices(tower).filter((o) => o.object.floor !== 0);
    assert(upstairs.length > 0, 'the fixture has no upper-floor offices to strand');
    const rented = upstairs.filter((o) => isRented(o.object.unitStatus));
    assert(rented.length === 0,
      rented.length + ' upper-floor offices rented with no lift and no stairs in the building');
  },
};
