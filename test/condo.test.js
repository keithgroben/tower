/**
 * Family 9 — the first thing in this game with a downside.
 *
 * The assertions that matter are the four money ones near the bottom: **a
 * condo sale credits the tower's own cash, a refund takes back exactly what
 * the sale paid, a sold condo is never paid again, and a condo the lifts
 * cannot serve never sells at all.** Everything above them is the machinery
 * that makes those four true.
 *
 * Two habits from `CLAUDE.md`'s failure list are deliberate here:
 *
 *   - the money tests run through the **composition** — `seedDemoWorld`'s own
 *     ledger, `makeDriver`'s own scheduler, and `tower.cash` — never through a
 *     ledger the test built. This repo has shipped that bug three times
 *     (`routeStartTick`/`lastTripTick`, `seedDemoWorld`'s standalone
 *     `createLedger()`, and `restore()`), and each time the test went on
 *     passing about a seam that carried nothing.
 *   - the band tests state what the OFFICE reading would do, because the
 *     office reading is the plausible wrong answer and it is wrong only at
 *     `0x10..0x17` — which is where a sold condo spends every night.
 *
 * Spec: `specs/facility/CONDO.md`, `specs/DEMAND.md` § Family 9,
 * `specs/PEOPLE.md` § Family `9`, `specs/FACILITIES.md`, `specs/TIME.md`.
 */
import {
  CONDO_NOISE_RADIUS, CONDO_STATE, SOLD_CYCLE_SEED, condoArrival, condoDailyReset,
  condoFamilyHandler, condoGate, condoNoiseNear, condoScore, condos, facilityServiceFloor,
  finalizeCondoSale, isCondoSold, recomputeCondoOperationalStatus, revertCondoToUnsold,
  saleSelector, stepUnitStatus,
} from '../src/games/tower/sim/condo.js';
import {
  CONDO_UNIT_STATUS, EVAL_UNSET, FAMILY, __resetIds, createTower, isRented, isUnitLet,
  placeObject, population,
} from '../src/games/tower/sim/state.js';
import { noiseSourceNear } from '../src/games/tower/sim/office.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { RENT_TIERS, activateFamilyCashflowIfOperational, createLedger } from '../src/games/tower/sim/economy.js';
import { cashflowUnitFor, runTowerLedgerCheckpoint } from '../src/games/tower/sim/ledger-adapter.js';
import { applyAction } from '../src/games/tower/sim/actions.js';
import { carrierStopsAtFloor, floorQueueCount } from '../src/games/tower/sim/elevators.js';
import { snapshot, restore } from '../src/games/tower/sim/save.js';
import { objectStatusTag } from '../src/games/tower/render/canvas.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const SALE_PRICE = RENT_TIERS.condo[1];          // the placement default tier

/** A bare tower with one condo and its three residents. */
function towerWithCondo({ floor = 3, rentLevel = 1, daypart = 0 } = {}) {
  __resetIds();
  const tower = createTower();
  tower.clock.dayTick = daypart * 400;
  tower.clock.daypart = daypart;
  const placed = placeObject(tower,
    { family: FAMILY.condo, floor, left: 10, right: 25, rentLevel },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture failed: ' + placed.reason);
  return { tower, object: placed.object, residents: tower.actors.slice() };
}

/** Give every resident the same stress history. */
function stressResidents(residents, average, trips = 4) {
  for (const r of residents) { r.tripCount = trips; r.accumulatedElapsed = average * trips; }
}

const clockAt = (daypart, { calendarPhase = false, dayTick = null } = {}) =>
  ({ daypart, calendarPhase, dayTick: dayTick ?? daypart * 400 });

const riggedRng = (pass) => ({ chance: () => pass, next: () => 0, int: () => 0 });

/** A world with a condo built on a floor the seeded lift really serves. */
function worldWithBuiltCondo({ floor = 3, left = 20 } = {}) {
  const world = seedDemoWorld({ seed: 1 });
  const built = applyAction(world, { type: 'build', what: 'condo', floor, left });
  assert(built.ok, 'the condo would not build: ' + built.reason);
  return { world, driver: makeDriver(world), object: built.object };
}

/**
 * Step the composition one tick at a time until this condo's band flips, and
 * report the cash on either side of the tick that flipped it.
 *
 * Tick by tick rather than in a block because the whole question is how much
 * money moved on **that one tick** — stepping a day lumps the sale in with a
 * tower's worth of office rent, and then any number looks plausible.
 */
/** Everything in the income ledger that is not the condo's own bucket. */
const otherIncome = (tower) => Object.entries(tower.incomeLedger ?? {})
  .reduce((n, [bucket, amount]) => (bucket === 'condo' ? n : n + amount), 0);

function runUntilBandFlips(world, driver, object, limit = 2600 * 8) {
  const start = isCondoSold(object.unitStatus);
  for (let i = 0; i < limit; i++) {
    const before = world.tower.cash;
    const others = otherIncome(world.tower);
    const tick = world.tower.clock.dayTick;
    driver.scheduler.tick(world.tower);
    if (isCondoSold(object.unitStatus) !== start) {
      return {
        flipped: true, before, after: world.tower.cash, tick, ticks: i,
        // ⚠️ The sale tick is not the condo's alone. Once fast food landed, a
        // venue closure could pay on the very same tick — the raw delta came
        // out at $160,000 for a $150,000 sale. Netting the other buckets off
        // keeps the assertion EXACT instead of loosening it to `>=`, which
        // would pass for a sale that paid nothing while something else paid
        // $150,000.
        othersDelta: otherIncome(world.tower) - others,
      };
    }
  }
  return { flipped: false };
}

export const tests = {
  // --------------------------------------------------------------- the band

  /**
   * ⚠️ The single easiest way to break this family. A sold condo is clamped to
   * the sync sentinel `0x10` every night by checkpoint 2500, and `0x10` is
   * outside the OFFICE's let band.
   */
  '⚠️ a condo at the sync sentinel is SOLD, where an office at 0x10 is not'() {
    const { object } = towerWithCondo();
    object.unitStatus = CONDO_UNIT_STATUS.syncMarker;         // 0x10, every night
    assert(isUnitLet(object), 'a condo at 0x10 is sold');
    assert(!isRented(object.unitStatus), 'and the office band would say otherwise — that is the trap');

    const office = { family: FAMILY.office, unitStatus: CONDO_UNIT_STATUS.syncMarker };
    assert(!isUnitLet(office), 'an office at 0x10 is vacant, and the same helper must say so');
  },

  'the sold band runs to 0x17 and the unsold band starts at 0x18'() {
    for (const status of [0x00, 0x08, 0x0f, 0x10, 0x17]) {
      assert(isCondoSold(status), '0x' + status.toString(16) + ' is inside the sold band');
    }
    for (const status of [0x18, 0x20, 0x28]) {
      assert(!isCondoSold(status), '0x' + status.toString(16) + ' is unsold');
    }
  },

  'a placed condo is unsold, in the half-day band, with three residents seeking a sale'() {
    const morning = towerWithCondo({ daypart: 0 });
    assert(morning.object.unitStatus === CONDO_UNIT_STATUS.unsoldEarly, 'morning placement is 0x18');
    assert(morning.residents.length === 3, 'three residents, allocated at placement');
    for (const r of morning.residents) {
      assert(r.state === CONDO_STATE.saleSeeking, 'every resident starts on the sale path');
    }
    assert(!isUnitLet(morning.object), 'and nothing is sold yet');
    assert(population(morning.tower) === 0, 'an unsold condo contributes nobody');

    const evening = towerWithCondo({ daypart: 5 });
    assert(evening.object.unitStatus === CONDO_UNIT_STATUS.unsoldLate, 'evening placement is 0x20');
  },

  // ------------------------------------------------------ the countdown band

  '⚠️ a countdown step never crosses a band, in either direction'() {
    // Down out of the sold band would wrap into the expiry states; up out of it
    // would SELL the unit by arithmetic, for nothing.
    const sold = towerWithCondo().object;
    sold.unitStatus = 0;
    stepUnitStatus(sold, -1);
    assert(sold.unitStatus === 0, 'a sold condo floors at 0, it does not wrap to 0xff');
    sold.unitStatus = CONDO_UNIT_STATUS.soldMax;
    stepUnitStatus(sold, +1);
    assert(sold.unitStatus === CONDO_UNIT_STATUS.soldMax, 'and it cannot climb out into the unsold band');

    const unsold = towerWithCondo().object;
    unsold.unitStatus = CONDO_UNIT_STATUS.unsoldEarly;
    stepUnitStatus(unsold, -1);
    assert(unsold.unitStatus === CONDO_UNIT_STATUS.unsoldEarly,
      'an unsold condo bouncing DOWN must not fall into the sold band — that is a free $150,000');
    assert(!isCondoSold(unsold.unitStatus), 'still unsold');
  },

  '⚠️ the 0x04 sync shortcut cannot sell an unsold condo that happens to be at 0x19'() {
    // `unit_status & 7 == 1` is satisfied by 0x19 exactly as it is by 1, and
    // writing 0x10 there moves the unit into the sold band with no sale.
    // Resident 2 at daypart 5 is the one case the `0x04` gate lets through with
    // no dice at all, so the dispatch really runs.
    const { tower, object, residents } = towerWithCondo({ daypart: 5 });
    const handler = condoFamilyHandler({ resolveRoute: () => -1 });
    object.unitStatus = CONDO_UNIT_STATUS.unsoldEarly + 1;     // 0x19
    assert((object.unitStatus & 7) === 1, 'the fixture really does satisfy the shortcut test');
    residents[2].state = CONDO_STATE.sync;
    handler(tower, residents[2]);
    assert(residents[2].state === CONDO_STATE.morning, 'fixture: the sync really dispatched');
    assert(!isCondoSold(object.unitStatus), 'an unsold condo stays unsold through the sync');

    // And it still works where it is meant to.
    object.unitStatus = 1;
    residents[2].state = CONDO_STATE.sync;
    handler(tower, residents[2]);
    assert(object.unitStatus === CONDO_UNIT_STATUS.syncMarker, 'a sold condo at 1 snaps to the sentinel');
  },

  // ------------------------------------------------------------- evaluation

  'a brand-new condo scores its way out of the chicken-and-egg'() {
    const { tower, object, residents } = towerWithCondo();
    assert(object.occupiedFlag === false, 'a placed condo starts unmeasured');
    assert(condoScore(tower, object, residents) === 0, 'no trips scores 0');
    assert(recomputeCondoOperationalStatus(tower, object, residents) === 2, 'which grades 2');
    assert(object.occupiedFlag === true, 'and that is what opens the sale gate');
  },

  '⚠️ an unsold condo that is being measured grades 0xff, never 0'() {
    // `specs/FACILITIES.md`: family 9 early-exits on `unit_status > 0x17 AND
    // occupied_flag != 0`. Without it an unreachable condo piles up failed
    // trips, grades 0, and its `0x20` gate never reopens.
    const { tower, object, residents } = towerWithCondo();
    object.occupiedFlag = true;
    stressResidents(residents, 300);
    assert(recomputeCondoOperationalStatus(tower, object, residents) === EVAL_UNSET,
      'an unsold, measured condo is not scored at all');
    assert(object.occupiedFlag === true, 'and it keeps the flag, so it keeps trying');

    // Sold, the same stress really does grade 0.
    object.unitStatus = 0;
    assert(recomputeCondoOperationalStatus(tower, object, residents) === 0,
      'a SOLD condo with the same history grades 0 — that is what the refund acts on');
  },

  'a condo is scored over three residents, and a missing one is refused'() {
    const { tower, object, residents } = towerWithCondo();
    residents[0].tripCount = 2; residents[0].accumulatedElapsed = 200;   // 100
    residents[1].tripCount = 2; residents[1].accumulatedElapsed = 100;   // 50
    residents[2].tripCount = 0;                                          // 0
    assert(condoScore(tower, object, residents) === 50, 'floor((100+50+0)/3) = 50');

    let threw = false;
    try { condoScore(tower, object, residents.slice(0, 2)); } catch { threw = true; }
    assert(threw, 'scoring two residents over a divisor of three would read BETTER than the truth');
  },

  '⚠️ a condo counts an office as noise at 30 tiles; an office counts no office at all'() {
    // ⚠️ **The 30 is written out, not read from `CONDO_NOISE_RADIUS`.** Building
    // the fixture out of the constant makes the test move with it, so shrinking
    // the radius to the office's 10 goes on passing — which is exactly what the
    // mutation round caught this test doing. `specs/FACILITIES.md` § Noise
    // Search is where the 30 comes from, so the 30 is what the test says.
    assert(CONDO_NOISE_RADIUS === 30, 'FACILITIES.md § Noise Search: condo 30 tiles');

    const { tower, object } = towerWithCondo({ floor: 3 });
    const office = placeObject(tower,
      { family: FAMILY.office, floor: 3, left: object.right + 30, right: object.right + 35 },
      () => createSimTripRecord()).object;
    assert(condoNoiseNear(tower, object), 'an office exactly 30 tiles away is noise to a condo');
    assert(!noiseSourceNear(tower, office), 'and the condo is not noise to the office — different rows');

    // The radius is a boundary, not a vibe.
    object.right -= 1; object.left -= 1;
    assert(!condoNoiseNear(tower, object), 'one tile further and it is quiet');
  },

  'the noise penalty is +60 and lands after the tier modifier'() {
    const { tower, object, residents } = towerWithCondo({ floor: 3, rentLevel: 2 });
    // 26 tiles clear of the condo: inside the condo's radius, outside the
    // office's, so the number under test is this family's own.
    placeObject(tower, { family: FAMILY.office, floor: 3, left: object.right + 26, right: object.right + 31 },
      () => createSimTripRecord());
    stressResidents(residents, 100);
    // 100 stress, tier 2 discounts 30, noise adds 60.
    assert(condoScore(tower, object, residents) === 130, 'got ' + condoScore(tower, object, residents));
  },

  // ---------------------------------------------------------------- the gate

  'the sale gate is shut while the condo is unmeasured, and in the evening'() {
    const { object, residents } = towerWithCondo();
    const rng = riggedRng(true);
    object.occupiedFlag = false;
    assert(condoGate(residents[0], object, clockAt(1), rng) === 'hold', 'unmeasured holds');
    object.occupiedFlag = true;
    assert(condoGate(residents[0], object, clockAt(1), rng) === 'dispatch', 'measured, morning, goes');
    assert(condoGate(residents[0], object, clockAt(5), rng) === 'hold', 'daypart 5 holds');
    assert(condoGate(residents[0], object, clockAt(6), rng) === 'hold', 'and so does the night');
  },

  'resident 2 syncs and returns an hour ahead of its siblings'() {
    const { object, residents } = towerWithCondo();
    const rng = riggedRng(false);            // every die fails, so only the hard rules show
    for (const r of residents) r.state = CONDO_STATE.sync;
    assert(condoGate(residents[2], object, clockAt(5), rng) === 'dispatch', 'resident 2 syncs at daypart 5');
    assert(condoGate(residents[0], object, clockAt(5), rng) === 'hold', 'resident 0 needs the dice or tick 2400');
    assert(condoGate(residents[0], object, clockAt(6, { dayTick: 2401 }), rng) === 'dispatch',
      'past tick 2400 it goes regardless');

    for (const r of residents) r.state = CONDO_STATE.returnHome;
    assert(condoGate(residents[2], object, clockAt(4), rng) === 'dispatch', 'resident 2 returns from daypart 4');
    assert(condoGate(residents[0], object, clockAt(4), rng) === 'hold', 'the others wait for 5');
    assert(condoGate(residents[0], object, clockAt(5), rng) === 'dispatch', 'and then go');
  },

  'the calendar phase pushes resident 0 out of its venue trip and into the sync'() {
    const { object, residents } = towerWithCondo();
    const rng = riggedRng(false);
    for (const r of residents) r.state = CONDO_STATE.venue;
    const phase = { calendarPhase: true };
    assert(condoGate(residents[0], object, clockAt(2, phase), rng) === 'hold', 'blocked before daypart 4');
    assert(condoGate(residents[0], object, clockAt(5, phase), rng) === CONDO_STATE.sync,
      'and forced to 0x04 after it — a state rewritten without a dispatch');
    assert(condoGate(residents[1], object, clockAt(2, phase), rng) === 'dispatch',
      'resident 1 is not the staggered one: 1 % 4 is not 0');
  },

  // -------------------------------------------------------- the sale point

  'the outbound selector is 1 for resident 0 and 2 for the other two'() {
    assert(saleSelector(0) === 1, 'resident 0 takes the restaurant bucket');
    assert(saleSelector(1) === 2 && saleSelector(2) === 2, 'residents 1 and 2 take fast food');
  },

  '⚠️ a route result of 0 sells the condo — 0 is a legal result, not a failure'() {
    // `0` is "source queue full, waiting", and `specs/PEOPLE.md` puts it in the
    // same SALE row as 1 and 2. A truthiness test here loses a real sale.
    for (const code of [0, 1, 2, 3]) {
      const { tower, object, residents } = towerWithCondo();
      object.occupiedFlag = true;
      let sold = false;
      const handler = condoFamilyHandler({ resolveRoute: () => code, onSale: () => { sold = true; } });
      residents[0].state = CONDO_STATE.saleSeeking;
      handler(tower, residents[0]);
      assert(isCondoSold(object.unitStatus), 'route result ' + code + ' sells');
      assert(sold, 'and the money seam was called for result ' + code);
    }
  },

  'a failed route never sells, and leaves an unsold condo trying'() {
    const { tower, object, residents } = towerWithCondo();
    object.occupiedFlag = true;
    let sold = false;
    const handler = condoFamilyHandler({ resolveRoute: () => -1, onSale: () => { sold = true; } });
    residents[0].state = CONDO_STATE.saleSeeking;
    handler(tower, residents[0]);
    assert(!sold && !isCondoSold(object.unitStatus), 'no route, no sale');
    assert(residents[0].state === (CONDO_STATE.saleSeeking | 0x40),
      'and it holds 0x60, which is what `specs/PEOPLE.md` writes for an unsold failure');
  },

  '⚠️ the sale is one-shot: three residents, one payment'() {
    const { tower, object, residents } = towerWithCondo();
    object.occupiedFlag = true;
    let sales = 0;
    const handler = condoFamilyHandler({ resolveRoute: () => 1, onSale: () => { sales++; } });
    for (const r of residents) { r.state = CONDO_STATE.saleSeeking; handler(tower, r); }
    assert(sales === 1, 'expected exactly one sale, got ' + sales);
  },

  'the sale lands in the half-day band, and 0x00 is a legal sold value'() {
    const morning = towerWithCondo({ daypart: 1 });
    finalizeCondoSale(morning.tower, morning.object, {});
    assert(morning.object.unitStatus === 0, 'a morning sale writes 0x00');
    assert(isUnitLet(morning.object), 'which is sold — anything reading it as truthy is broken');

    const evening = towerWithCondo({ daypart: 5 });
    finalizeCondoSale(evening.tower, evening.object, {});
    assert(evening.object.unitStatus === 8, 'an evening sale writes 0x08');
  },

  'a condo with no venue anywhere still aims its sale trip at the lobby'() {
    // `spec/DEVIATIONS.md` D2, and the self-retiring half of it: the moment a
    // venue exists, the real lookup finds it instead.
    const { tower } = towerWithCondo();
    placeObject(tower, { family: FAMILY.lobby, floor: 0, left: 40, right: 60 }, () => createSimTripRecord());
    assert(facilityServiceFloor(tower, 2, 3, tower.rng) === 0, 'with no venue, the lobby');

    placeObject(tower, { family: FAMILY.fastFood, floor: 5, left: 40, right: 60 },
      () => createSimTripRecord());
    assert(facilityServiceFloor(tower, 2, 3, tower.rng) === 5, 'with one, the venue');
  },

  // ------------------------------------------------------------ the refund

  'a refund needs a zero grade AND a sold unit'() {
    const { tower, object } = towerWithCondo();
    object.unitStatus = 0;

    object.evalLevel = 1;
    assert(!revertCondoToUnsold(tower, object, [], {}), 'a poor but nonzero grade keeps the sale');
    object.evalLevel = EVAL_UNSET;
    assert(!revertCondoToUnsold(tower, object, [], {}), 'and an unscored one certainly does');

    object.evalLevel = 0;
    assert(revertCondoToUnsold(tower, object, [], {}), 'zero refunds it');
    assert(!isCondoSold(object.unitStatus), 'back to the for-sale band');
    assert(object.occupiedFlag === false && object.activationTickCount === 0, 'and it is reset');

    // Now unsold, a second pass must not refund it again.
    object.evalLevel = 0;
    assert(!revertCondoToUnsold(tower, object, [], {}),
      'an unsold condo cannot be refunded — that would pay back money nobody took');
  },

  'the refund writes the half-day unsold band'() {
    const morning = towerWithCondo({ daypart: 2 });
    morning.object.unitStatus = 0; morning.object.evalLevel = 0;
    revertCondoToUnsold(morning.tower, morning.object, [], {});
    assert(morning.object.unitStatus === CONDO_UNIT_STATUS.unsoldEarly, 'morning refunds to 0x18');

    const evening = towerWithCondo({ daypart: 6 });
    evening.object.unitStatus = 0; evening.object.evalLevel = 0;
    revertCondoToUnsold(evening.tower, evening.object, [], {});
    assert(evening.object.unitStatus === CONDO_UNIT_STATUS.unsoldLate, 'evening refunds to 0x20');
  },

  // ------------------------------------------------------- the daily sweep

  'the 2500 sweep sends an unsold condo back to the sale path and clamps a sold one'() {
    const { tower, object, residents } = towerWithCondo();
    object.unitStatus = SOLD_CYCLE_SEED;
    for (const r of residents) r.state = CONDO_STATE.venueRelease;
    condoDailyReset(tower);
    assert(object.unitStatus === CONDO_UNIT_STATUS.syncMarker, 'a sold condo clamps to 0x10 overnight');
    for (const r of residents) assert(r.state === CONDO_STATE.morning, 'its residents wait for morning');

    object.unitStatus = CONDO_UNIT_STATUS.unsoldEarly;
    condoDailyReset(tower);
    for (const r of residents) {
      assert(r.state === CONDO_STATE.saleSeeking,
        'a refunded condo\'s residents go back on the sale path — nothing else puts them there');
    }
  },

  'a resident mid-ride is left alone by the sweep'() {
    const { tower, residents } = towerWithCondo();
    residents[0].state = CONDO_STATE.venue | 0x40;
    condoDailyReset(tower);
    assert(residents[0].state === (CONDO_STATE.venue | 0x40),
      'a passenger a car still intends to deliver must not be told they are home');
  },

  'the morning dispatch reseeds the countdown only from the sentinel'() {
    const { tower, object, residents } = towerWithCondo();
    const handler = condoFamilyHandler({ resolveRoute: () => -1 });
    object.unitStatus = CONDO_UNIT_STATUS.syncMarker;
    residents[0].state = CONDO_STATE.morning;
    handler(tower, residents[0]);
    assert(object.unitStatus === SOLD_CYCLE_SEED, 'from 0x10 it reseeds to 3');

    object.unitStatus = 0;                          // sold this morning
    residents[1].state = CONDO_STATE.morning;
    handler(tower, residents[1]);
    assert(object.unitStatus === 0, 'a condo sold at 0x00 is not bumped to 3 by its own dispatch');
  },

  'the two daily paths reach every routed state'() {
    const { tower, object, residents } = towerWithCondo();
    const handler = condoFamilyHandler({ resolveRoute: () => 1 });
    object.unitStatus = SOLD_CYCLE_SEED;
    tower.clock.dayTick = 400; tower.clock.daypart = 1;

    // Path A: resident 0 leaves for the lobby, then comes home.
    residents[0].state = CONDO_STATE.morning;
    handler(tower, residents[0]);
    assert(residents[0].state === CONDO_STATE.outbound, 'resident 0 takes the outbound errand');
    handler(tower, residents[0]);
    condoArrival(tower, residents[0], 0);
    assert(residents[0].state === CONDO_STATE.returnHome, 'arriving hands off to the return leg');
    condoArrival(tower, residents[0], object.floor);
    assert(residents[0].state === CONDO_STATE.sync, 'and getting home ends in the sync');

    // Path B: resident 1 goes to a venue, then releases it and comes home.
    residents[1].state = CONDO_STATE.morning;
    handler(tower, residents[1]);
    assert(residents[1].state === CONDO_STATE.venue, 'resident 1 goes straight out to a venue');
    condoArrival(tower, residents[1], 5);
    assert(residents[1].state === CONDO_STATE.venueRelease, 'arriving there hands off to the release leg');
    condoArrival(tower, residents[1], object.floor);
    assert(residents[1].state === CONDO_STATE.sync, 'which also ends in the sync');
  },

  // --------------------------------------------------------- the money, wired

  /**
   * ⚠️ **Through the composition, not through a ledger this test built.**
   * `seedDemoWorld`'s ledger is a view over `tower.cash`; a test that made its
   * own would prove the helper works and nothing about the wiring, which is the
   * bug this repo has shipped three times.
   */
  '⚠️ a condo sale credits the tower\'s own cash, on the tick it sells'() {
    const { world, driver, object } = worldWithBuiltCondo();
    const flip = runUntilBandFlips(world, driver, object);
    assert(flip.flipped, 'the condo never sold in eight days on a lift that reaches it');
    assert(flip.after - flip.before - flip.othersDelta === SALE_PRICE,
      'the sale tick moved cash by ' + (flip.after - flip.before) + ', of which '
      + flip.othersDelta + ' was other families — leaving '
      + (flip.after - flip.before - flip.othersDelta) + ' for the condo, not ' + SALE_PRICE);
    assert(world.tower.incomeLedger.condo === SALE_PRICE,
      'and the condo income bucket says ' + world.tower.incomeLedger.condo + ' rather than ' + SALE_PRICE);
    assert(world.ledger.cash === world.tower.cash, 'and the ledger the seed handed out is that same number');
    assert(world.tower.populationLedger.condo === 3, 'three people joined the ledger the stars are read from');
  },

  '⚠️ the refund takes back the whole sale price, out of the tower\'s own cash'() {
    // Two identical towers, run identically, differing in **one** thing: whose
    // condo residents are stressed. Isolating it that way rather than watching
    // one balance is the point — checkpoint 2533 also pays a tower's worth of
    // office rent and charges its lifts, and against that traffic $150,000 in
    // either direction is easy to mistake for something else. The paired run
    // still asserts on `tower.cash`, which is the number the game draws.
    const failing = worldWithBuiltCondo();
    const healthy = worldWithBuiltCondo();
    for (const each of [failing, healthy]) {
      assert(runUntilBandFlips(each.world, each.driver, each.object).flipped, 'fixture: both must sell');
    }
    assert(failing.world.tower.cash === healthy.world.tower.cash, 'fixture: the two runs are identical');
    const popBefore = failing.world.tower.populationLedger.condo;

    const rig = ({ world, object }, average) => {
      for (const id of object.occupants) {
        const resident = world.tower.actors.find((a) => a.id === id);
        resident.tripCount = 4; resident.accumulatedElapsed = average * 4;
      }
      world.tower.clock.dayCounter = 9;              // 9 % 3 === 0 — a cashflow day
      runTowerLedgerCheckpoint(world.tower);
    };
    rig(failing, 300);                                // graded 0
    rig(healthy, 0);                                  // graded 2

    assert(!isCondoSold(failing.object.unitStatus), 'a zero-grade condo goes back on the market');
    assert(isCondoSold(healthy.object.unitStatus), 'and a healthy one keeps its sale');
    assert(healthy.world.tower.cash - failing.world.tower.cash === SALE_PRICE,
      'the refund cost ' + (healthy.world.tower.cash - failing.world.tower.cash)
      + ', not the ' + SALE_PRICE + ' the sale paid');

    // The income bucket says the same thing on its own: rollover clears it
    // first, so after this pass it holds exactly the condo activity of the pass.
    assert(failing.world.tower.incomeLedger.condo === -SALE_PRICE,
      'the reversal is mirrored into the income ledger, at full price');
    assert(healthy.world.tower.incomeLedger.condo === 0,
      'and a condo that keeps its sale is not paid again — see the 3-day pass test');
    assert(failing.world.tower.populationLedger.condo === popBefore - 3, 'the three people left again');
  },

  '⚠️ a sold condo is never paid again on the 3-day pass'() {
    // The failure this guards is quiet and enormous: the activation sweep reads
    // the same payout table the sale does, so an unguarded condo would be paid
    // its FULL SALE PRICE every third day for ever.
    const { object } = towerWithCondo();
    object.unitStatus = 0;
    object.occupiedFlag = true;
    const ledger = createLedger({ cash: 0 });
    const unit = cashflowUnitFor(object);

    assert(activateFamilyCashflowIfOperational(ledger, unit, 3), 'it activates');
    assert(ledger.cash === 0, 'but it is not paid: cash moved to ' + ledger.cash);
    assert(ledger.income.condo === 0, 'and nothing reached the income bucket');
    assert(object.activationTickCount === 1, 'it does still age, which is all the spec gives this pass');
  },

  '⚠️ a condo the lift cannot reach never sells, and costs the player the build'() {
    // The loop, for condos. F40 is far above the seeded shaft.
    const { world, driver, object } = worldWithBuiltCondo({ floor: 40, left: 20 });
    const spentOnIt = 2_000_000 - world.tower.cash;
    assert(spentOnIt > 0, 'fixture: building it cost something');

    for (let i = 0; i < 2600 * 6; i++) driver.scheduler.tick(world.tower);
    assert(!isCondoSold(object.unitStatus), 'six days above the lift and nobody moved in');
    assert(world.tower.populationLedger.condo === 0, 'nobody was ever counted');
    assert(object.evalLevel === EVAL_UNSET,
      'and it grades 0xff rather than 0 — an unreachable condo must not read as a failing one');
  },

  'the refund price follows the tier, and tier 3 is $40,000 rather than nothing'() {
    // `payout()` answers 0 for an unpriced tier, and 0 is also what a bug looks
    // like. Tier 3 is a real, cheap condo — it must give back real money.
    for (const tier of [0, 1, 2, 3]) {
      const { tower, object } = towerWithCondo({ rentLevel: tier });
      const ledger = createLedger({ cash: 1_000_000 });
      object.unitStatus = 0;
      object.evalLevel = 0;
      revertCondoToUnsold(tower, object, [], {
        onRefund: () => { ledger.cash -= RENT_TIERS.condo[tier]; },
      });
      assert(1_000_000 - ledger.cash === RENT_TIERS.condo[tier],
        'tier ' + tier + ' reverses ' + RENT_TIERS.condo[tier]);
      assert(RENT_TIERS.condo[tier] > 0, 'and every tier is a real price, including the cheapest');
    }
  },

  // ---------------------------------------------------- the seam to the game

  'a sold condo cannot be bulldozed or re-priced'() {
    const { world, driver, object } = worldWithBuiltCondo();
    assert(applyAction(world, { type: 'set_rent', objectId: object.id, tier: 0 }).ok,
      'while it is for sale, the price is the player\'s to set');

    assert(runUntilBandFlips(world, driver, object).flipped, 'fixture: it has to sell');
    object.unitStatus = CONDO_UNIT_STATUS.syncMarker;      // where it sits every night

    const priced = applyAction(world, { type: 'set_rent', objectId: object.id, tier: 3 });
    assert(!priced.ok, 're-pricing a sold condo would let you be refunded five times what you were paid');
    const razed = applyAction(world, { type: 'demolish', objectId: object.id });
    assert(!razed.ok, 'and bulldozing one would keep the money for a room that no longer exists');
  },

  'a condo is refused below grade'() {
    const world = seedDemoWorld({ seed: 1 });
    const below = applyAction(world, { type: 'build', what: 'condo', floor: -1, left: 0 });
    assert(!below.ok && /above the ground floor/.test(below.reason), 'got: ' + below.reason);
    assert(applyAction(world, { type: 'build', what: 'condo', floor: 3, left: 0 }).ok, 'and allowed above it');
  },

  '⚠️ extending a lift gives the new floors a queue, not just a range'() {
    // Pre-existing, and it crashes rather than drifting: `carrierStopsAtFloor`
    // read `stopEnabled[slot] !== 0`, and `undefined !== 0` is TRUE, so the
    // carrier claimed the new floor and then had no ring for anybody standing
    // on it.
    const world = seedDemoWorld({ seed: 1 });
    const lift = world.tower.carriers[0];
    const top = lift.topFloor + 3;
    assert(applyAction(world, { type: 'extend_shaft', carrierId: lift.id, top }).ok, 'extend');
    assert(carrierStopsAtFloor(lift, top), 'it says it serves the new top floor');
    assert(floorQueueCount(lift, top, 0) === 0, 'and it really has a down ring there');
    assert(lift.queues.length === lift.topFloor - lift.bottomFloor + 1, 'one ring pair per served floor');
  },

  'an unsold condo says FOR SALE, where an office says FOR RENT'() {
    // Not decoration. "For rent" over a condo tells the player somebody will
    // move in eventually; the truth is that this is $150,000 they have not been
    // paid, and the difference is what makes the refund legible when it comes.
    const { object } = towerWithCondo();
    assert(objectStatusTag(object) === 'FOR SALE', 'got: ' + objectStatusTag(object));
    object.unitStatus = CONDO_UNIT_STATUS.syncMarker;
    object.occupiedFlag = true;
    assert(objectStatusTag(object) === '', 'and a sold one carries no tag at all, at 0x10 included');

    const office = { family: FAMILY.office, unitStatus: 0x10, occupiedFlag: true };
    assert(objectStatusTag(office) === 'FOR RENT', 'an office is still rented, not sold');
  },

  'a tower with condos survives a save and a load'() {
    const { world, driver, object } = worldWithBuiltCondo();
    assert(runUntilBandFlips(world, driver, object).flipped, 'fixture: sell it first');
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    const back = restore(blob);
    assert(back.ok, 'restore refused: ' + back.reason);

    const restored = back.world.tower.objects.get(object.id);
    assert(restored && restored.unitStatus === object.unitStatus, 'the condo came back in its own band');
    assert(isCondoSold(restored.unitStatus), 'and still sold');
    assert(condos(back.world.tower).length === 1, 'with its three residents attached');
    assert(condos(back.world.tower)[0].occupants.length === 3, 'all three of them');
    assert(back.world.ledger.cash === world.tower.cash, 'and one balance, not two');
  },
};
