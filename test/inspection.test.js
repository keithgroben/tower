/**
 * The office-service evaluation (issue #17): the inspector, and the flag the `3 -> 4` rung is
 * waiting for.
 *
 * Spec: `specs/GAME-STATE.md` § Office Service Evaluation (trigger, resolution, cleanup, reset) and
 * § Gate Meanings. `spec/DEVIATIONS.md` A57 (it was written by nothing), A73 (the inspector is ours).
 *
 * The evaluation is run through `makeDriver`'s scheduler, the real router and real lifts: the flag is
 * only ever written by an inspector who has ridden to the office, which is what these tests watch.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import {
  INSPECTION_CHECK_TICK, INSPECTION_CLEANUP_TICK, INSPECTION_DAY, INSPECTION_PERIOD_DAYS, INSPECTION_STAR,
  INSPECTOR_STATE, cleanUpInspection, inspectableOffices, inspectionBlocker, inspectionVerdict, isInspectionDay,
  runDailyInspection,
} from '../src/games/tower/sim/inspection.js';
import { evalUpperFor } from '../src/games/tower/sim/office.js';
import { HOTEL_SWEEP_TICK } from '../src/games/tower/sim/hotel.js';
import { REBUILD_TICK } from '../src/games/tower/sim/commercial.js';
import { calendarPhaseFlag } from '../src/games/tower/sim/clock.js';
import { GATES_WITHOUT_A_WRITER, resetStarGateState, starGatesOf, tryAdvanceStar } from '../src/games/tower/sim/progression.js';
import { FAMILY } from '../src/games/tower/sim/state.js';
import { demandsOf } from '../src/games/tower/sim/demands.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { eventsReadout } from '../src/games/tower/ui/readout.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const same = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
const must = (r, what) => { assert(r.ok, what + ': ' + r.reason); return r; };

/** The first evaluation day, and the rest of the cycle. */
const EVAL_DAY = INSPECTION_DAY;                                     // day 3
const NEXT_EVAL_DAY = INSPECTION_DAY + INSPECTION_PERIOD_DAYS;       // day 12

function at(tower, dayCounter, dayTick) {
  tower.clock.dayCounter = dayCounter;
  tower.clock.dayTick = dayTick;
  tower.clock.daypart = Math.floor(dayTick / 400);
  tower.clock.calendarPhase = calendarPhaseFlag(dayCounter);
}

/**
 * Three stars, a lift of `top` floors and an office on each of floors 1..`floors`, every one let (the
 * rent moment is the office module's and has its own tests: here the offices simply ARE let, so the
 * evaluation has something to test), the clock a few ticks before 240 on `day`.
 */
function officeTower({ floors = 3, top = floors, day = EVAL_DAY, stars = INSPECTION_STAR } = {}) {
  const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = stars;
  const shaft = must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 20 }), 'a lift');
  for (let i = 0; i < 3; i++) must(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }), 'a car');
  const offices = [];
  for (let floor = 1; floor <= floors; floor++) {
    const r = must(applyAction(world, { type: 'build', what: 'office', floor, left: 40 }), 'an office on ' + floor);
    r.object.unitStatus = 0;
    r.object.occupiedFlag = true;
    offices.push(r.object);
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);
  at(tower, day, INSPECTION_CHECK_TICK - 3);
  return { world, tower, scheduler, offices, shaft };
}

/** Tick until the evaluation is over (or `limit` ticks). */
function ride(env, limit = 900) {
  let n = 0;
  while (env.tower.inspection && n < limit) { env.scheduler.tick(env.tower); n++; }
  return n;
}

/** Give every worker of an office `stress` for their one counted trip. */
function stress(tower, office, value) {
  for (const id of office.occupants) {
    const worker = tower.actors.find((a) => a.id === id);
    worker.tripCount = 1;
    worker.accumulatedElapsed = value;
  }
}

export const tests = {
  // ------------------------------------------------------------------ the rule

  'the constants are the spec\'s: three stars, day % 9 == 3, the 240 and 1600 checkpoints'() {
    assert(INSPECTION_STAR === 3 && INSPECTION_PERIOD_DAYS === 9 && INSPECTION_DAY === 3, 'GAME-STATE.md: star_count == 3, day_counter % 9 == 3');
    assert(INSPECTION_CHECK_TICK === REBUILD_TICK, 'the daily check rides the 240 checkpoint');
    assert(INSPECTION_CLEANUP_TICK === HOTEL_SWEEP_TICK && INSPECTION_CLEANUP_TICK === 1600, 'GAME-STATE.md: the stale state is cleared at tick 1600');
    assert(evalUpperFor(3) === 150, 'the star-3 upper threshold is 150');
    assert(FAMILY.inspector === 0x31 && FAMILY.inspector !== FAMILY.vip && FAMILY.inspector !== FAMILY.cathedral, 'a family of its own');
    for (const day of [3, 12, 21, 30]) assert(isInspectionDay(day), day + ' is an evaluation day');
    for (const day of [0, 1, 2, 4, 9, 11, 13]) assert(!isInspectionDay(day), day + ' is not');
    assert(Object.keys(GATES_WITHOUT_A_WRITER).length === 0, 'the gate has its writer: nothing excuses it any more');
  },

  'who is sent, and when: only a three-star tower, on an evaluation day, with a let office, once'() {
    const env = officeTower();
    assert(inspectionBlocker(env.tower) === null, 'all four hold: ' + inspectionBlocker(env.tower));
    assert(runDailyInspection(env.tower) && env.tower.inspection.floor >= 1, 'an inspector is sent');
    assert(inspectionBlocker(env.tower) === 'an inspector is already on the way' && !runDailyInspection(env.tower), 'and not a second');
    const notice = demandsOf(env.tower).notices.at(-1);
    assert(/^An inspector is on the way to the office on floor \d$/.test(notice.text), notice.text);
    for (const [label, mutate] of [
      ['two stars', (t) => { t.starCount = 2; }],
      ['four stars', (t) => { t.starCount = 4; }],
      ['a weekday that is not an evaluation day', (t) => at(t, EVAL_DAY + 1, 240)],
      ['an evaluation that was already passed', (t) => { starGatesOf(t).officeServiceOk = true; }],
    ]) {
      const e = officeTower();
      mutate(e.tower);
      assert(inspectionBlocker(e.tower) && !runDailyInspection(e.tower) && e.tower.inspection === undefined,
        label + ': ' + inspectionBlocker(e.tower));
    }
    const bare = officeTower({ floors: 1 });
    for (const o of bare.offices) o.unitStatus = 0x10;                // For Rent
    assert(inspectableOffices(bare.tower).length === 0 && inspectionBlocker(bare.tower) === 'no office is let', 'no let office, no inspection');
  },

  'a day that sends nobody draws nothing from the generator: every seed that never reaches three stars is unchanged'() {
    for (const [label, mutate] of [['a weekday', (t) => at(t, 1, 240)], ['two stars', (t) => { t.starCount = 2; }], ['passed', (t) => { starGatesOf(t).officeServiceOk = true; }]]) {
      const env = officeTower();
      mutate(env.tower);
      const before = env.tower.rng.state;
      runDailyInspection(env.tower);
      assert(env.tower.rng.state === before, label + ': the generator was touched');
    }
  },

  // ------------------------------------------------------------------ the ride

  'END TO END: at 240 an inspector rides the real lift to a let office, and his arrival - nothing else - writes the flag'() {
    const env = officeTower({ floors: 3 });
    const { tower, scheduler } = env;
    assert(starGatesOf(tower).officeServiceOk === false, 'nobody has passed it');
    for (let i = 0; i < 3; i++) scheduler.tick(tower);             // 240
    assert(tower.clock.dayTick === 240 && tower.inspection, 'sent at 240: ' + JSON.stringify(tower.inspection));
    const target = tower.objects.get(tower.inspection.officeId);
    const inspector = tower.actors.find((a) => a.id === tower.inspectorActorId);
    assert(inspector.family === FAMILY.inspector && inspector.objectId === null, 'one actor, owning nothing');
    assert(starGatesOf(tower).officeServiceOk === false, 'the flag is not written when he is sent');
    let queued = false, rode = false;
    for (let n = 0; n < 900 && tower.inspection; n++) {
      scheduler.tick(tower);
      if (inspector.waitingFloor != null) queued = true;
      if (inspector.route?.carrierId != null) rode = true;
    }
    assert(queued && rode, 'he stood in a lift queue and rode a carrier - the real router: ' + JSON.stringify({ queued, rode }));
    assert(!tower.inspection && starGatesOf(tower).officeServiceOk === true, 'he arrived, and the gate opened');
    assert(tower.lastInspection.pass === true && tower.lastInspection.floor === target.floor && tower.lastInspection.why === 'arrived', JSON.stringify(tower.lastInspection));
    assert(inspector.state === INSPECTOR_STATE.away && tower.carriers.every((c) => !c.liveRequests.has(inspector.id)), 'and he leaves no ghost in a queue');
    const texts = demandsOf(tower).notices.map((n) => n.text);
    assert(texts.some((t) => /^The inspector approves: the office on floor \d is well served$/.test(t)), 'the verdict is said: ' + texts.at(-1));
    assert(demandsOf(tower).notices.at(-1).good === true, 'as good news');
  },

  'the verdict is the office\'s own stress: 150 passes, 151 fails (the star-3 threshold), through the real arrival'() {
    for (const [value, pass] of [[0, true], [149, true], [150, true], [151, false], [300, false]]) {
      const env = officeTower({ floors: 1 });
      stress(env.tower, env.offices[0], value);
      runDailyInspection(env.tower);
      const verdict = inspectionVerdict(env.tower, env.offices[0]);
      assert(verdict.score === value && verdict.threshold === 150 && verdict.pass === pass, 'stress ' + value + ': ' + JSON.stringify(verdict));
      ride(env);
      assert(starGatesOf(env.tower).officeServiceOk === pass && env.tower.lastInspection.pass === pass, 'stress ' + value + ' through the ride: ' + JSON.stringify(env.tower.lastInspection));
    }
  },

  'a failure says so, writes nothing, and is tried again on the next evaluation day'() {
    const env = officeTower({ floors: 1 });
    const { tower, scheduler } = env;
    stress(tower, env.offices[0], 300);
    for (let i = 0; i < 3; i++) scheduler.tick(tower);
    ride(env);
    assert(starGatesOf(tower).officeServiceOk === false && tower.lastInspection.pass === false && tower.lastInspection.score === 300, JSON.stringify(tower.lastInspection));
    const notice = demandsOf(tower).notices.at(-1);
    assert(/^The inspector is not pleased: the office on floor 1 is poorly served$/.test(notice.text) && notice.tone === 'bad', notice.text);
    assert(!tower.inspection, 'and the evaluation is over');
    // Nothing more that day or the days between...
    at(tower, EVAL_DAY + 1, 240);
    assert(!runDailyInspection(tower), 'not the next day');
    // ...and on day 12, with the office calm again, it passes.
    stress(tower, env.offices[0], 20);
    at(tower, NEXT_EVAL_DAY, INSPECTION_CHECK_TICK - 1);
    for (let i = 0; i < 2; i++) scheduler.tick(tower);
    assert(tower.inspection, 'a second inspector, nine days later');
    ride(env);
    assert(starGatesOf(tower).officeServiceOk === true, 'and the office, mended, passes');
  },

  'an office the lift does not reach fails: no route means no evaluation (and no ghost in a queue)'() {
    const env = officeTower({ floors: 3, top: 2 });                // the lift stops at 2; the third office is above it
    const high = env.offices.find((o) => o.floor === 3);
    env.tower.inspection = null;
    // Make the high office the only one let, so the draw cannot pick another.
    for (const o of env.offices) if (o !== high) o.unitStatus = 0x10;
    for (let i = 0; i < 3; i++) env.scheduler.tick(env.tower);
    assert(env.tower.inspection?.floor === 3, 'the inspector is sent to floor 3');
    ride(env);
    assert(!env.tower.inspection && starGatesOf(env.tower).officeServiceOk === false, 'but cannot get there');
    assert(env.tower.lastInspection.pass === false && env.tower.lastInspection.why === 'no lift reaches the office', JSON.stringify(env.tower.lastInspection));
    const inspector = env.tower.actors.find((a) => a.id === env.tower.inspectorActorId);
    assert(env.tower.carriers.every((c) => !c.liveRequests.has(inspector.id)), 'no ghost');
  },

  'the target vanishing before he arrives fails the evaluation unconditionally'() {
    const env = officeTower({ floors: 1 });
    runDailyInspection(env.tower);
    env.tower.objects.delete(env.tower.inspection.officeId);
    ride(env);
    assert(!env.tower.inspection && starGatesOf(env.tower).officeServiceOk === false, 'failed');
    assert(env.tower.lastInspection.why === 'the office is gone' && env.tower.lastInspection.pass === false, JSON.stringify(env.tower.lastInspection));
  },

  'the 1600 cleanup: stale state is cleared when it is not an evaluation day, and left alone when it is'() {
    const env = officeTower({ floors: 1 });
    runDailyInspection(env.tower);
    at(env.tower, EVAL_DAY, INSPECTION_CLEANUP_TICK);
    assert(!cleanUpInspection(env.tower) && env.tower.inspection, 'on an evaluation day it is left alone');
    at(env.tower, EVAL_DAY + 1, INSPECTION_CLEANUP_TICK);            // the day counter turned at 2300
    assert(cleanUpInspection(env.tower) && !env.tower.inspection, 'the next day it is cleared');
    assert(env.tower.lastInspection.pass === false && env.tower.lastInspection.why === 'the inspector never reached the office', JSON.stringify(env.tower.lastInspection));
    assert(starGatesOf(env.tower).officeServiceOk === false, 'a stale evaluation is a failed one');
    assert(!cleanUpInspection(env.tower), 'and nothing is left to clear');
  },

  'every star advance clears the flag (GAME-STATE.md: reset on each star advancement)'() {
    const env = officeTower({ floors: 1 });
    const { tower } = env;
    starGatesOf(tower).officeServiceOk = true;
    resetStarGateState(tower);
    assert(starGatesOf(tower).officeServiceOk === false, 'cleared');
    // And through the real advance: a 3 -> 4 tower that has it loses it on the rise.
    const high = officeTower({ floors: 1 });
    high.tower.populationLedger = { office: 5000 };
    Object.assign(starGatesOf(high.tower), {
      officePlaced: true, suitePlaced: true, recyclingAdequate: true, medicalServiceOk: true, routesViable: true,
      vipStayFavorable: true, officeServiceOk: true,
    });
    at(high.tower, 0, 1700);
    assert(tryAdvanceStar(high.tower).advanced && high.tower.starCount === 4, 'it rose');
    assert(starGatesOf(high.tower).officeServiceOk === false, 'and the flag went with the rung');
  },

  'the whole ladder: with an evaluation passed by a real inspector, 3 -> 4 stops waiting for it'() {
    const env = officeTower({ floors: 2 });
    const { tower, scheduler } = env;
    tower.populationLedger = { office: 5000 };
    Object.assign(starGatesOf(tower), {
      officePlaced: true, suitePlaced: true, recyclingAdequate: true, medicalServiceOk: true, routesViable: true, vipStayFavorable: true,
    });
    for (let i = 0; i < 3; i++) scheduler.tick(tower);
    assert(tower.starCount === 3, 'still three: the evaluation is outstanding');
    ride(env);
    assert(starGatesOf(tower).officeServiceOk === true, 'passed');
    // The window: a weekday evening. The rung opens on the first such tick.
    at(tower, 3, 1699);
    starGatesOf(tower).recyclingAdequate = true;
    scheduler.tick(tower);
    assert(tower.starCount === 4, 'and the star rose, with the real inspector\'s flag the last thing it needed');
  },

  'the bar says an inspector is coming, and the save carries one mid-ride'() {
    const env = officeTower({ floors: 3 });
    const { tower, world, scheduler } = env;
    runDailyInspection(tower);
    assert(/^INSPECTOR on the way to the office on floor \d$/.test(eventsReadout(tower)), eventsReadout(tower));
    for (let i = 0; i < 12; i++) scheduler.tick(tower);
    assert(SAVE_VERSION >= 11, 'the shape changed');
    const back = restore(JSON.parse(JSON.stringify(snapshot(world))));
    assert(back.ok !== false, back.reason);
    const resumed = back.world.tower;
    same(resumed.inspection, tower.inspection, 'the evaluation under way');
    assert(resumed.inspectorActorId === tower.inspectorActorId, 'and the inspector');
    const sb = makeDriver(back.world).scheduler;
    for (let n = 0; n < 900 && (tower.inspection || resumed.inspection); n++) { scheduler.tick(tower); sb.tick(resumed); }
    assert(starGatesOf(tower).officeServiceOk === true && starGatesOf(resumed).officeServiceOk === true, 'both pass');
    same(resumed.lastInspection, tower.lastInspection, 'the same verdict');
  },
};
