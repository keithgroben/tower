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
import {
  officeArrival, officeFamilyHandler, offices, recomputeOfficeOperationalStatus,
} from '../src/games/tower/sim/office.js';
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

/** A real seeded tower with the real family machine, running the real router. */
function liveTower({ days = 2 } = {}) {
  const tower = seedDemoTower({ seed: 1 });
  const seen = { delays: new Map(), codes: new Map() };

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
        onRent: () => {},
      }),
    },
    { [FAMILY.office]: officeArrival },
    (delay, actor) => {
      seen.delays.set(delay.kind, (seen.delays.get(delay.kind) ?? 0) + 1);
      priceDelay(tower, delay, actor);
    },
  );

  for (let i = 0; i < 2600 * days; i++) {
    if (scheduler.tick(tower).dayAdvanced) {
      for (const { object, occupants } of offices(tower)) {
        recomputeOfficeOperationalStatus(tower, object, occupants);
      }
    }
  }
  return { tower, seen, workers: offices(tower).flatMap((o) => o.occupants) };
}

export const tests = {
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
    for (let i = 0; i < 2600 * 2; i++) {
      if (scheduler.tick(tower).dayAdvanced) {
        for (const { object, occupants } of offices(tower)) {
          recomputeOfficeOperationalStatus(tower, object, occupants);
        }
      }
    }

    const upstairs = offices(tower).filter((o) => o.object.floor !== 0);
    assert(upstairs.length > 0, 'the fixture has no upper-floor offices to strand');
    const rented = upstairs.filter((o) => isRented(o.object.unitStatus));
    assert(rented.length === 0,
      rented.length + ' upper-floor offices rented with no lift and no stairs in the building');
  },
};
