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
import { FAMILY, createTower, isRented } from '../src/games/tower/sim/state.js';
import { officeArrival, officeFamilyHandler, offices } from '../src/games/tower/sim/office.js';
import { ledgerFor, officeCashflowHooks } from '../src/games/tower/sim/ledger-adapter.js';
import { applyAction } from '../src/games/tower/sim/actions.js';
import {
  lockReason, starGateStatus, towerActivity,
} from '../src/games/tower/sim/progression.js';
import { resolveRouteBetweenFloors } from '../src/games/tower/sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, applyQueueFullDelay, computeRuntimeTileStressAverage,
  recordNoRouteFailure, stampRouteStart,
} from '../src/games/tower/sim/stress.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * A real seeded tower with the real family machine, running the real router.
 *
 * `onDay(day, tower, world)` fires at each day boundary so a test can break the
 * tower mid-run — or build onto it through `applyAction` — and watch what the
 * money and the stars do about it.
 */
function liveTower({ days = 2, onDay = null } = {}) {
  const world = seedDemoWorld({ seed: 1 });
  const { tower } = world;
  const seen = { delays: new Map(), codes: new Map(), cashByDay: [] };

  // ⚠️ `makeDriver`, not a restatement of it.
  //
  // This helper used to build its own scheduler so it could slip counters into
  // the route and delay callbacks. It drifted, exactly as its own comment
  // warned: when fast food and the office lunch trips landed, the family list
  // here did not grow, so every test using this fixture was running a tower
  // where nobody goes to lunch — and reporting on it confidently.
  //
  // It was caught by a test asserting its own fixture reached the state it was
  // about to check ("only 246 activity — the fixture never crossed the
  // threshold, so a star that failed to arrive would prove nothing"). Without
  // that line the suite would have stayed green over a fixture measuring a
  // different game.
  const { scheduler } = makeDriver(world, {
    observe: {
      route: (r) => seen.codes.set(r.code, (seen.codes.get(r.code) ?? 0) + 1),
      delay: (kind) => seen.delays.set(kind, (seen.delays.get(kind) ?? 0) + 1),
    },
  });

  // No daily sweep here any more. `makeTowerScheduler` wires checkpoint 2533,
  // so the operational recompute, the closures and the ledger all run inside
  // the composition the browser runs — rather than in a copy kept by this file,
  // which is how the copies drift.
  for (let day = 0; day < days; day++) {
    onDay?.(day, tower, world);
    for (let i = 0; i < 2600; i++) scheduler.tick(tower);
    seen.cashByDay.push(tower.cash);
  }
  return { tower, world, seen, workers: offices(tower).flatMap((o) => o.occupants) };
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
    // ⚠️ The ledger the SEED hands out, not one built here. This test used to
    // make its own `ledgerFor(tower)` — which proved that helper worked and
    // proved nothing about the composition. The composition then went and
    // handed out a standalone `createLedger()`: construction debited that one
    // while rent credited `tower.cash`, so the HUD's cash bar fell by
    // $1,548,000 for 36 offices and never rose again while the tower earned
    // $432,000 a cycle onto a number nothing displayed. A guard that tests the
    // helper instead of the wiring is the same mistake one level up.
    const { tower, ledger } = seedDemoWorld({ seed: 1 });
    assert(ledger.cash === tower.cash && ledgerFor(tower).cash === ledger.cash,
      'the seed handed out a ledger that is not the tower’s: $' + ledger.cash + ' vs $' + tower.cash);
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
   * The money the player builds with and the money the player earns are the
   * same money. Two balances is not a wiring detail — it is a game whose
   * reward never arrives.
   */
  'what a build spends and what rent earns land on one balance'() {
    const world = seedDemoWorld({ seed: 1 });
    const { tower, ledger } = world;
    const start = ledger.cash;

    const built = applyAction(world, { type: 'build', what: 'office', floor: 8, left: 10 });
    assert(built.ok, 'the build was refused: ' + built.reason);
    const afterBuild = ledger.cash;
    assert(afterBuild === start - built.cost, 'the build did not debit the balance the seed handed out');

    // Now earn. The rent hook and checkpoint 2533 both write through the
    // adapter, and it has to be the same balance the build just left.
    const { onRent } = officeCashflowHooks(tower);
    const office = [...tower.objects.values()].find((o) => o.family === FAMILY.office);
    office.unitStatus = 0;
    office.occupiedFlag = true;
    office.everRented = true;
    onRent(tower, office);
    assert(ledger.cash > afterBuild,
      'rent arrived and the balance the player is shown did not move: still $' + ledger.cash);
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

  // ------------------------------------------------------------- the stars

  /**
   * ⚠️ **The shipped seed cannot reach two stars, and that is a finding, not a
   * bug in this test.**
   *
   * 36 let offices is 216 activity against a threshold of 300 — the tower is 14
   * tenants short with every office it has full. Pinned here so that if the
   * ladder ever starts advancing on this seed, someone has changed a reference
   * number and has to say so.
   */
  'the shipped seed fills every office it has and is still short of two stars'() {
    const { tower } = liveTower({ days: 6 });
    const status = starGateStatus(tower);
    assert(letCount(tower) === 36, 'the seed let ' + letCount(tower) + ' offices, expected 36');
    assert(status.activity === 216, 'a full seed reports ' + status.activity + ' activity, expected 216');
    assert(tower.starCount === 1,
      'the seed reached ' + tower.starCount + ' stars on 216 activity — the 300 threshold has moved');
    assert(status.blockers.join() === '84 more tower activity',
      'the seed’s next step reads: ' + status.blockers.join(' · '));
  },

  /**
   * And the positive: build enough and the star arrives, through the real
   * command seam and a real tick sequence. Without this the test above passes
   * for a ladder that never advances at all.
   */
  'build past the threshold and the second star arrives'() {
    const built = [];
    const { tower } = liveTower({
      // Six days, not four. Lunch traffic slowed the fill: 78 offices on one
      // three-car lift reached 246 activity in four days where they used to
      // reach 432, because every worker now makes a midday round trip as well
      // as a commute. Not a capacity ceiling — by day six the tower is at 378
      // and climbing. The tower fills more slowly because it is busier, which
      // is the loop, and the fixture should take as long as the game does.
      days: 6,
      onDay: (day, t, world) => {
        if (day !== 0) return;
        // 36 more offices either side of the seeded banks, all served by the
        // existing lift. 78 offices is 468 activity if they all let.
        for (const floor of [1, 2, 3, 4, 5, 6]) {
          for (const left of [30, 36, 42, 94, 100, 106]) {
            built.push(applyAction(world, { type: 'build', what: 'office', floor, left }).ok);
          }
        }
      },
    });
    assert(built.length === 36 && built.every(Boolean), 'the fixture could not build its offices');
    assert(towerActivity(tower) >= 300,
      'only ' + towerActivity(tower) + ' activity — the fixture never crossed the threshold, so a '
      + 'star that failed to arrive would prove nothing');
    assert(tower.starCount === 2,
      'a tower with ' + towerActivity(tower) + ' activity is still at ' + tower.starCount + ' star(s)');
  },

  /**
   * Then it stops, honestly. `specs/GAME-STATE.md` § Star Advancement puts a
   * security office on the 2→3 gate, and no family implements one — so the
   * ladder stalls with the name of the thing that is missing rather than
   * advancing because a requirement was skipped.
   */
  'and then stalls on a security office, by name'() {
    const tower = createTower({ seed: 1 });
    tower.starCount = 2;
    tower.populationLedger = { office: 5000 };       // far past every threshold
    tower.clock.daypart = 5;

    const status = starGateStatus(tower);
    assert(status.activityReady, 'the fixture did not clear the activity gate');
    assert(tower.starCount === 2, 'the fixture did not start at 2 stars');
    assert(status.blockers.join() === 'a security office',
      'a tower with unlimited tenants and no security office says: ' + status.blockers.join(' · '));
  },

  /** A lock is not a price. The two refusals have to be different sentences. */
  'a locked buildable and an unaffordable one refuse differently'() {
    const world = seedDemoWorld({ seed: 1 });
    const locked = lockReason(world.tower, 'metroStation', 'Metro Station');
    assert(locked && !/\$/.test(locked), 'the lock reason quotes a price: ' + locked);

    world.ledger.cash = 100;
    const poor = applyAction(world, { type: 'build', what: 'office', floor: 9, left: 10 });
    assert(!poor.ok && /\$/.test(poor.reason), 'the broke refusal does not quote a price: ' + poor.reason);
    assert(!/star/i.test(poor.reason), 'the broke refusal blames stars: ' + poor.reason);
  },

  /**
   * And the ordering. When a thing is both locked and unaffordable the player
   * must be told about the lock, because "you cannot afford it" sends someone
   * away to earn money that will not help.
   *
   * Nothing in today's two-entry palette is locked, so the tower is dropped
   * below the office's own requirement to stand in for one. Artificial, and the
   * alternative is no test of the ordering at all until the palette grows a
   * hotel — at which point the ordering would be wrong and nothing would say so.
   */
  'when a build is both locked and unaffordable, the lock is the reason given'() {
    const world = seedDemoWorld({ seed: 1 });
    world.tower.starCount = 0;
    world.ledger.cash = 0;

    const refused = applyAction(world, { type: 'build', what: 'office', floor: 9, left: 10 });
    assert(!refused.ok, 'a locked, unaffordable office was built anyway');
    assert(/star/i.test(refused.reason) && !/\$/.test(refused.reason),
      'the refusal talks about money before the lock: ' + refused.reason);
  },

  /**
   * The two ways a star gate latches, both wired.
   *
   * `notePlacement` from the command seam is the immediate one; the start-of-day
   * sweep is the safety net for objects placed outside it. The seeded tower is
   * exactly that case — it calls `placeObject` directly — so if the sweep is not
   * wired into checkpoint 0, a tower full of offices never latches the gate its
   * own 3→4 rung needs.
   */
  'a star gate latches from a build, and from a day starting'() {
    const world = seedDemoWorld({ seed: 1 });
    assert(!world.tower.gates?.officePlaced,
      'the seed latched the office gate before any day or any command');

    const built = applyAction(world, { type: 'build', what: 'office', floor: 9, left: 10 });
    assert(built.ok && world.tower.gates.officePlaced,
      'building an office through the command seam did not latch its star gate');

    // Now the sweep, on a tower nothing has been built into.
    const { tower } = liveTower({ days: 2 });
    assert(tower.gates.officePlaced,
      'a day started on a tower of 42 offices and the office gate is still clear — the start-of-day '
      + 'gate refresh is not wired into checkpoint 0');
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
    const { tower } = seedDemoWorld({ seed: 1 });
    tower.carriers = [];
    tower.segments = [];

    // The shipped composition, on a tower with its transport removed — the
    // negative has to be the same game as the positive or it proves nothing.
    const { scheduler } = makeDriver({ tower, ledger: ledgerFor(tower) });
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
