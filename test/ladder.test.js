/**
 * The complete star ladder (issue #14): 1 -> 2 -> 3 -> 4 -> 5 -> Tower.
 *
 * Spec: `specs/GAME-STATE.md` § Star Advancement, § Office Service Evaluation;
 * `specs/facility/EVALUATION.md` § Award Check; `specs/FACILITIES.md` § Thresholds By
 * Star Rating; the original's help file § Reach for the Stars and its readme (hotel
 * guests at higher stars, the wedding). `spec/DEVIATIONS.md` A58-A62.
 *
 * ## How this file proves a rung, and what it is honest about
 *
 * Every rung is tested the same two ways, because a checklist test that only checks the
 * all-pass case passes just as happily when a gate has been quietly deleted:
 *
 *   - **each criterion alone missing blocks the star**, all the others met - and the
 *     blocker names it;
 *   - **everything met passes**, at the tick the window opens and not one before.
 *
 * And the whole ladder is walked once, in order, through `makeDriver`'s scheduler - the
 * same `progression` hook the game runs every tick - not through `tryAdvanceStar`
 * called by hand.
 *
 * Every gate has a writer in this build now, and the walk below uses the real ones: it BUILDS
 * the metro station (issue #15) and watches `4 -> 5` refuse without it; it lets an inspector ride
 * to a real office for the office-service evaluation (issue #17); and it builds the lifts to the
 * 100th floor and the cathedral through `applyAction` and lets the forty guests ride up on a
 * weekend morning (issue #17). The one flag still set by hand, in one place, is the VIP's
 * (`futureFlags()`): `test/events.test.js` and the ladder trial prove the real visitor, and a
 * walk that also waited for him would be a test of the events and not of the ladder. The rung
 * tests (`ALL`) pin the INTERFACE - each gate alone missing blocks its star - and are the one
 * place the other flags are set directly, because that is what they test.
 */
import { EVENING_DAYPART, calendarPhaseFlag } from '../src/games/tower/sim/clock.js';
import { TYPE_CODES } from '../src/games/tower/sim/economy.js';
import { DEMAND, activeDemands, clearDemand, isDemanded, noticesAfter, postNotice, raiseDemand } from '../src/games/tower/sim/demands.js';
import {
  GATES_WITHOUT_A_WRITER, HOTEL_POPULATION_BUCKETS, HOTEL_STOPS_COUNTING_AT_STAR,
  HOTEL_SUITES_FOR_FOUR_STARS, STAR_THRESHOLDS, TOWER_RANK, WEDDING_DEADLINE_TICK, WEDDING_GUESTS,
  createStarGates, notePlacement, refreshStartOfDayGates, starGateStatus, starGatesOf, starPopulation,
  starRiseNotice, towerActivity, tryAdvanceStar,
} from '../src/games/tower/sim/progression.js';
import { SECURITY_OFFICES_FOR_THREE_STARS } from '../src/games/tower/sim/security.js';
import { EVAL_THRESHOLD_LOWER, evalLevelFor, evalUpperFor, recomputeOfficeOperationalStatus } from '../src/games/tower/sim/office.js';
import { FAMILY, createTower, placeObject } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { BUILDABLE, applyAction } from '../src/games/tower/sim/actions.js';
import { runCommercialRebuild } from '../src/games/tower/sim/ledger-adapter.js';
import { VENUE, commercialVenues } from '../src/games/tower/sim/commercial.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { buildWeddingSpine, ladderTrial } from '../harness/playtest.js';
import { CATHEDRAL_BASE_FLOOR, GUEST_STATE, cathedralGuests } from '../src/games/tower/sim/cathedral.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import {
  STAR_RISE_MS, noticeToSay, starClause, starGlyph, starTitle,
} from '../src/games/tower/ui/readout.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const buildable = (kind) => Object.hasOwn(BUILDABLE, kind);

/** A tower at `star`, on a weekday evening, with `office` population and `gates` set. */
function towerAt(star, { office = 0, ledger = null, gates = {}, dayTick = 1700, dayCounter = 0 } = {}) {
  const tower = createTower({ seed: 1 });
  tower.starCount = star;
  tower.populationLedger = ledger ?? { office };
  tower.clock.dayTick = dayTick;
  tower.clock.daypart = Math.floor(dayTick / 400);
  tower.clock.dayCounter = dayCounter;
  tower.clock.calendarPhase = calendarPhaseFlag(dayCounter);
  tower.gates = { ...createStarGates(), ...gates };
  return tower;
}

/**
 * ⚠️ **THE ONE STAND-IN.** The VIP's good opinion (issue #16), which `sim/events.js` writes and
 * `test/events.test.js` and the ladder trial prove. It is the exact flag the events write.
 */
const futureFlags = (tower, which = {}) => {
  Object.assign(starGatesOf(tower), {
    vipStayFavorable: true,      // issue #16: a VIP stayed in a suite and rated the tower well
    ...which,
  });
  return tower;
};

/** Every flag a rung can need, true - the ones with writers here, then the stand-ins. */
const ALL = {
  securityPlaced: true, officePlaced: true, suitePlaced: true, recyclingAdequate: true,
  medicalServiceOk: true, routesViable: true,
  metroPlaced: true, vipStayFavorable: true, officeServiceOk: true, cathedralPlaced: true,
  weddingGuestsArrived: WEDDING_GUESTS,
};

/** Is this blocker text in the status? */
const blocks = (tower, pattern) => starGateStatus(tower).blockers.some((b) => pattern.test(b));

/** A weekday-evening and a weekend-morning dayTick/dayCounter, for the windows. */
const WEEKDAY = 0;      // (0 % 12) % 3 = 0
const WEEKEND = 2;      // (2 % 12) % 3 = 2

/** Each rung: what it asks for, so a criterion can be taken away alone. */
const RUNGS = [
  { star: 2, label: '2 -> 3', office: 1000, dayTick: 100, dayCounter: WEEKDAY,
    remove: [
      ['securityPlaced', /security office/],
    ] },
  { star: 3, label: '3 -> 4', office: 5000, dayTick: 1700, dayCounter: WEEKDAY,
    remove: [
      ['officePlaced', /^an office$/],
      ['suitePlaced', /hotel suite/],
      ['recyclingAdequate', /recycling/],
      ['medicalServiceOk', /medical/],
      ['officeServiceOk', /office-service evaluation/],
      ['vipStayFavorable', /VIP/],
      ['routesViable', /day to start/],
    ] },
  { star: 4, label: '4 -> 5', office: 10_000, dayTick: 1700, dayCounter: WEEKDAY,
    remove: [
      ['metroPlaced', /metro station/],
      ['recyclingAdequate', /recycling/],
      ['medicalServiceOk', /medical/],
      ['routesViable', /day to start/],
    ] },
  { star: 5, label: '5 -> Tower', office: 15_000, dayTick: 500, dayCounter: WEEKEND,
    remove: [
      ['cathedralPlaced', /cathedral/],
      ['weddingGuestsArrived', /wedding/],
    ] },
];

export const tests = {
  // ============================================ each criterion alone blocks it

  'every rung: each criterion missing ALONE blocks the star, and names itself'() {
    let checked = 0;
    for (const rung of RUNGS) {
      const ready = towerAt(rung.star, { office: rung.office, gates: ALL, dayTick: rung.dayTick, dayCounter: rung.dayCounter });
      assert(starGateStatus(ready).ready, rung.label + ': the fixture must be ready before anything is taken away: '
        + starGateStatus(ready).blockers.join(' | '));

      for (const [flag, pattern] of rung.remove) {
        const tower = towerAt(rung.star, {
          office: rung.office, gates: { ...ALL, [flag]: flag === 'weddingGuestsArrived' ? WEDDING_GUESTS - 1 : false },
          dayTick: rung.dayTick, dayCounter: rung.dayCounter,
        });
        assert(!tryAdvanceStar(tower).advanced && tower.starCount === rung.star,
          rung.label + ' advanced without ' + flag + ' - that gate is not being checked');
        assert(blocks(tower, pattern), rung.label + ': missing ' + flag + ' but the bar says: '
          + starGateStatus(tower).blockers.join(' | '));
        checked++;
      }
    }
    assert(checked === 14, 'the table checks every gate on every rung, not a subset: ' + checked);
  },

  'every rung: population one short blocks it, exactly the threshold passes (>=)'() {
    for (const rung of RUNGS) {
      const short = towerAt(rung.star, { office: rung.office - 1, gates: ALL, dayTick: rung.dayTick, dayCounter: rung.dayCounter });
      assert(!tryAdvanceStar(short).advanced, rung.label + ' advanced one tenant short');
      assert(starGateStatus(short).blockers[0] === '1 more tower activity',
        rung.label + ' says: ' + starGateStatus(short).blockers[0]);
      const enough = towerAt(rung.star, { office: rung.office, gates: ALL, dayTick: rung.dayTick, dayCounter: rung.dayCounter });
      assert(tryAdvanceStar(enough).advanced && enough.starCount === rung.star + 1,
        rung.label + ' did not advance at exactly ' + rung.office);
    }
    assert(STAR_THRESHOLDS.join() === '300,1000,5000,10000,15000', 'the thresholds are the issue\'s: ' + STAR_THRESHOLDS);
  },

  'the issue\'s own numbers: 300, 1,000, 5,000, 10,000, 15,000'() {
    const at = (star, office) => towerAt(star, { office, gates: ALL, dayTick: star === 5 ? 500 : 1700, dayCounter: star === 5 ? WEEKEND : WEEKDAY });
    assert(tryAdvanceStar(at(1, 300)).advanced, '2 stars at 300');
    assert(!tryAdvanceStar(at(1, 299)).advanced, 'not at 299');
    assert(tryAdvanceStar(at(2, 1000)).advanced && !tryAdvanceStar(at(2, 999)).advanced, '3 stars at 1,000');
    assert(tryAdvanceStar(at(3, 5000)).advanced && !tryAdvanceStar(at(3, 4999)).advanced, '4 stars at 5,000');
    assert(tryAdvanceStar(at(4, 10_000)).advanced && !tryAdvanceStar(at(4, 9999)).advanced, '5 stars at 10,000');
    assert(tryAdvanceStar(at(5, 15_000)).advanced && !tryAdvanceStar(at(5, 14_999)).advanced, 'Tower at 15,000');
  },

  // ===================================================== the time windows

  '3 -> 4 and 4 -> 5 want a weekday at or after 5 PM - and say which of the two is missing'() {
    for (const star of [3, 4]) {
      const office = star === 3 ? 5000 : 10_000;
      const mk = (dayTick, dayCounter) => towerAt(star, { office, gates: ALL, dayTick, dayCounter });
      assert(!tryAdvanceStar(mk(1599, WEEKDAY)).advanced, star + ': 4:59 PM is not 5 PM');
      assert(tryAdvanceStar(mk(1600, WEEKDAY)).advanced, star + ': 5 PM on a weekday passes');
      assert(!tryAdvanceStar(mk(1700, WEEKEND)).advanced, star + ': a weekend evening does not');
      assert(blocks(mk(900, WEEKDAY), /^the evening \(after 5 PM\)$/), 'the morning says the evening');
      assert(blocks(mk(1700, WEEKEND), /^a weekday$/), 'a weekend says a weekday');
      assert(!blocks(mk(1700, WEEKDAY), /evening|weekday/), 'and a weekday evening says neither');
    }
  },

  'the lower rungs have no time window'() {
    assert(tryAdvanceStar(towerAt(1, { office: 300, dayTick: 100, dayCounter: WEEKEND })).advanced, '1 -> 2 on a weekend morning');
    assert(tryAdvanceStar(towerAt(2, { office: 1000, gates: ALL, dayTick: 100, dayCounter: WEEKEND })).advanced, '2 -> 3 on a weekend morning');
  },

  // ==================================================== the Tower rank

  'Tower: the wedding is 40 guests, on a weekend, before tick 800 - and the cathedral stands'() {
    const mk = (opts, gates = {}) => towerAt(5, { office: 15_000, gates: { ...ALL, ...gates }, ...opts });
    assert(tryAdvanceStar(mk({ dayTick: 799, dayCounter: WEEKEND })).advanced, 'tick 799 on a weekend with 40 guests');
    assert(!tryAdvanceStar(mk({ dayTick: 800, dayCounter: WEEKEND })).advanced, 'tick 800 is too late (EVALUATION.md: day_tick < 800)');
    assert(!tryAdvanceStar(mk({ dayTick: 500, dayCounter: WEEKDAY })).advanced, 'a weekday has no wedding');
    assert(!tryAdvanceStar(mk({ dayTick: 500, dayCounter: WEEKEND }, { weddingGuestsArrived: 39 })).advanced, '39 guests is not a wedding');
    assert(!tryAdvanceStar(mk({ dayTick: 500, dayCounter: WEEKEND }, { cathedralPlaced: false })).advanced, 'no cathedral, no wedding');
    const ok = mk({ dayTick: 500, dayCounter: WEEKEND });
    const r = tryAdvanceStar(ok);
    assert(r.advanced && ok.starCount === TOWER_RANK && r.from === 5, 'the award is star_count = 6');
    assert(!tryAdvanceStar(ok).advanced && ok.starCount === TOWER_RANK, 'and there is nothing above it');
    assert(starGateStatus(ok).nextStar === null, 'the status knows it is the top');
  },

  'Tower rank reads the same 15,000 as the other rungs - and 5 stars alone is not it'() {
    const t = towerAt(5, { office: 14_999, gates: ALL, dayTick: 500, dayCounter: WEEKEND });
    assert(!tryAdvanceStar(t).advanced, '14,999 with everything else is not Tower');
    assert(starGateStatus(t).blockers[0] === '1 more tower activity', starGateStatus(t).blockers[0]);
  },

  // ===================================== the wedding is a flag, zeroed each morning

  'the wedding count is zeroed at the start of each day (EVALUATION.md recounts fresh)'() {
    const tower = towerAt(5, { gates: { weddingGuestsArrived: 40 } });
    refreshStartOfDayGates(tower);
    assert(tower.gates.weddingGuestsArrived === 0, 'yesterday\'s wedding must not carry into today: ' + tower.gates.weddingGuestsArrived);
  },

  // ====================================================== every demand met

  '4 -> 5 wants EVERY demand answered, and lists the ones still asking'() {
    const mk = () => towerAt(4, { office: 10_000, gates: ALL });
    const tower = mk();
    raiseDemand(tower, 'officeParking');
    assert(!tryAdvanceStar(tower).advanced, 'a tower still demanding parking reached 5 stars');
    const blocker = starGateStatus(tower).blockers.find((b) => /demand/.test(b));
    assert(blocker && blocker.includes(DEMAND.officeParking.text), 'the bar names the live demand: ' + blocker);
    assert(clearDemand(tower, 'officeParking'), 'fixture: it was live');
    assert(activeDemands(tower).length === 0, 'fixture: none left');
    assert(tryAdvanceStar(tower).advanced, 'the same tower, demand answered, climbs');

    // It is the 4 -> 5 gate and no other: 3 -> 4 asks only for recycling and medical (help file).
    const three = towerAt(3, { office: 5000, gates: ALL });
    raiseDemand(three, 'officeParking');
    assert(tryAdvanceStar(three).advanced, 'a parking demand does not hold 3 -> 4');
  },

  // ========================================================= the pending gates

  'a gate with no writer in this build says why - and only while it is outstanding'() {
    const tower = towerAt(3, { office: 5000, gates: { ...ALL, officeServiceOk: false, vipStayFavorable: false } });
    const details = starGateStatus(tower).blockerDetails;
    const vip = details.find((d) => /VIP/.test(d.text));
    const evaluation = details.find((d) => /office-service/.test(d.text));
    // Issue #16 gave the VIP gate its writer (`sim/events.js`) and issue #17 the evaluation's
    // (`sim/inspection.js`) and the wedding's (`sim/cathedral.js`): the table is empty, and neither
    // gate carries an excuse.
    assert(Object.keys(GATES_WITHOUT_A_WRITER).length === 0, 'every gate has a writer now: ' + Object.keys(GATES_WITHOUT_A_WRITER));
    assert(vip.unavailable === undefined && evaluation.unavailable === undefined, 'no excuses: ' + JSON.stringify([vip, evaluation]));
    // The mechanism is for the next gate that is added before its writer, and it still works: a
    // line in the table is printed beside the blocker, for exactly as long as the line is there.
    GATES_WITHOUT_A_WRITER.officeServiceOk = 'a made-up excuse for this test';
    try {
      const excused = starGateStatus(tower).blockerDetails.find((d) => /office-service/.test(d.text));
      assert(excused.unavailable === 'a made-up excuse for this test', 'the table is still read: ' + JSON.stringify(excused));
    } finally {
      delete GATES_WITHOUT_A_WRITER.officeServiceOk;
    }
    // A gate that has a writer here carries no excuse: the caveat must not become wallpaper.
    const recycling = starGateStatus(towerAt(3, { office: 5000, gates: { ...ALL, recyclingAdequate: false } })).blockerDetails
      .find((d) => /recycling/.test(d.text));
    assert(recycling.unavailable === undefined, 'recycling has a writer and is not "unavailable"');
    // Met means gone, with no reason left behind.
    tower.gates.vipStayFavorable = true;
    assert(!starGateStatus(tower).blockerDetails.some((d) => /VIP/.test(d.text)), 'a met gate is not listed');
  },

  'every line in the no-writer table names a real gate flag - a typo there is a silent excuse'() {
    const flags = Object.keys(createStarGates());
    for (const flag of Object.keys(GATES_WITHOUT_A_WRITER)) {
      assert(flags.includes(flag), '"' + flag + '" is not a star gate flag');
    }
  },

  // ============================================================= suites

  'the suites gate latches at the constant, from standing suites (A59)'() {
    assert(HOTEL_SUITES_FOR_FOUR_STARS === 2, 'the help file says "more than one": ' + HOTEL_SUITES_FOR_FOUR_STARS);
    const tower = createTower({ seed: 1 });
    notePlacement(tower, FAMILY.hotelSuite);
    assert(!tower.gates.suitePlaced, 'one suite is not "more than one"');
    for (const left of [0, 6]) {
      placeObject(tower, { family: FAMILY.hotelSuite, floor: 4, left, right: left + 5 }, () => createSimTripRecord());
    }
    notePlacement(tower, FAMILY.hotelSuite);
    assert(tower.gates.suitePlaced, 'two suites standing latch it');
    // A latch: demolishing a suite does not take the rung away.
    tower.objects.clear();
    refreshStartOfDayGates(tower);
    assert(tower.gates.suitePlaced, 'and it stays');
    // The other hotel rooms are not suites.
    const other = createTower({ seed: 1 });
    notePlacement(other, FAMILY.hotelTwin); notePlacement(other, FAMILY.hotelTwin); notePlacement(other, FAMILY.hotelSingle);
    assert(!other.gates.suitePlaced, 'twins and singles do not count');
  },

  'security stays ONE constant, as A49 ruled - and the gate and the words follow it'() {
    assert(SECURITY_OFFICES_FOR_THREE_STARS === 1, 'the decision was not flipped silently: ' + SECURITY_OFFICES_FOR_THREE_STARS);
    const tower = towerAt(2, { office: 1000 });
    assert(starGateStatus(tower).blockers.includes('a security office'), starGateStatus(tower).blockers.join(' | '));
    notePlacement(tower, TYPE_CODES.security);
    assert(tower.gates.securityPlaced, 'one office opens it at the constant 1');
  },

  // ===================================================== population counting

  'hotel guests count toward 1 -> 2 and 2 -> 3 and stop at 3 stars (A58)'() {
    assert(HOTEL_STOPS_COUNTING_AT_STAR === 3, 'the constant');
    assert(HOTEL_POPULATION_BUCKETS.join() === 'hotelSingle,hotelTwin,hotelSuite', 'the hotel buckets');
    const ledger = { office: 100, hotelSingle: 50, hotelTwin: 40, hotelSuite: 10, condo: 3 };
    assert(starPopulation(towerAt(1, { ledger })) === 203, '1 star counts everything: ' + starPopulation(towerAt(1, { ledger })));
    assert(starPopulation(towerAt(2, { ledger })) === 203, '2 stars counts everything');
    assert(starPopulation(towerAt(3, { ledger })) === 103, '3 stars counts the permanent population only');
    assert(starPopulation(towerAt(4, { ledger })) === 103 && starPopulation(towerAt(5, { ledger })) === 103, 'and so on up');
    assert(starPopulation(towerAt(6, { ledger })) === 103, 'and at the Tower rank');
    // The recycling centers' duty tier still reads the WHOLE ledger (TIME.md § 2000).
    assert(towerActivity(towerAt(4, { ledger })) === 203, 'a hotel guest still throws things away');
  },

  'a hotel-heavy tower is held at the rung the permanent population earns'() {
    // 5,000 on the ledger, 1,000 of it hotel guests: 4,000 permanent. At 3 stars that is NOT 5,000.
    const tower = towerAt(3, { ledger: { office: 4000, hotelSingle: 600, hotelTwin: 200, hotelSuite: 200 }, gates: ALL });
    const status = starGateStatus(tower);
    assert(!tryAdvanceStar(tower).advanced, 'hotel guests carried the tower to 4 stars');
    assert(status.activity === 4000 && status.activityNeeded === 1000 && status.hotelsCounted === false, JSON.stringify(status.blockers));
    // The same ledger at 2 stars is 5,000 toward the 1,000 rung - hotels still help there.
    assert(starPopulation(towerAt(2, { ledger: tower.populationLedger })) === 5000, 'at 2 stars they count');
    assert(starTitle(status).includes('hotel guests no longer count'), 'and the stars\' tooltip says so: ' + starTitle(status));
    assert(!starTitle(starGateStatus(towerAt(2, { office: 10 }))).includes('hotel'), 'but not below 3 stars');
  },

  'yesterday\'s shop customers AND the +10 per open shop both feed the ladder (A61)'() {
    const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    const shop = applyAction(world, { type: 'build', what: 'retail', floor: 1, left: 100 });
    assert(shop.ok, 'fixture: a shop: ' + shop.reason);
    const { record } = [...commercialVenues(tower, new Set([FAMILY.retail]))][0];
    record.availability = VENUE.available;
    // What opening it does (`retailCashflowHooks.onOpen`): +10 on the lease bucket.
    tower.populationLedger.retail = 10;
    record.todayVisitCount = 37;
    runCommercialRebuild(tower);
    assert(record.yesterdayVisitCount === 37, 'fixture: the day rolled');
    assert(tower.populationLedger.retail === 10, 'the +10 survives the rebuild (not overwritten by footfall): ' + tower.populationLedger.retail);
    assert(tower.populationLedger.retailVisits === 37, 'yesterday\'s customers are on the ledger: ' + tower.populationLedger.retailVisits);
    assert(starPopulation(tower) === 47, 'and the ladder counts both: ' + starPopulation(tower));
    // Assigned, not accumulated: the next rebuild with no visits clears it.
    runCommercialRebuild(tower);
    assert(tower.populationLedger.retailVisits === 0, 'a quiet day clears the footfall: ' + tower.populationLedger.retailVisits);
    assert(starPopulation(tower) === 10, 'leaving the +10');
  },

  'theater attendance and the restaurant\'s diners are on the ladder too'() {
    const tower = towerAt(3, { ledger: { cinema: 80, partyHall: 50, restaurant: 30, fastFood: 20, retail: 10, retailVisits: 5 } });
    assert(starPopulation(tower) === 195, 'every non-hotel bucket counts: ' + starPopulation(tower));
  },

  // ===================================== evaluation thresholds widen at 4+ stars

  'evaluation: poor from 150 at 1-3 stars, from 200 at 4+ - for every family that grades (FACILITIES.md)'() {
    assert(EVAL_THRESHOLD_LOWER === 80, 'the lower threshold is constant at 80');
    for (const star of [1, 2, 3]) {
      assert(evalUpperFor(star) === 150, star + ' stars: poor from 150');
      assert(evalLevelFor(149, star) === 1 && evalLevelFor(150, star) === 0, star + ' stars: the boundary');
    }
    for (const star of [4, 5, TOWER_RANK]) {
      assert(evalUpperFor(star) === 200, star + ' stars: poor from 200');
      assert(evalLevelFor(150, star) === 1 && evalLevelFor(199, star) === 1 && evalLevelFor(200, star) === 0,
        star + ' stars: tenants are more tolerant');
    }
    assert(evalLevelFor(79, 4) === 2 && evalLevelFor(80, 4) === 1, 'the lower threshold does not move');
  },

  'the widening is read from the tower star on the day an office is graded: a 170 is poor at 3 stars and acceptable at 4'() {
    for (const [star, expected] of [[3, 0], [4, 1], [5, 1], [TOWER_RANK, 1]]) {
      const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
      world.tower.starCount = star;
      const placed = applyAction(world, { type: 'build', what: 'office', floor: 1, left: 100 });
      assert(placed.ok, placed.reason);
      const workers = world.tower.actors.filter((a) => a.objectId === placed.object.id);
      assert(workers.length === 6, 'fixture: six workers');
      for (const w of workers) { w.accumulatedElapsed = 170; w.tripCount = 1; }
      assert(recomputeOfficeOperationalStatus(world.tower, placed.object, workers) === expected,
        star + ' stars grades an average stress of 170 as ' + placed.object.evalLevel + ', expected ' + expected);
    }
  },

  // ==================================================== the star-rise notice

  'a rise posts ONE good notice, in the sim\'s log, and nothing is posted when nothing rises'() {
    const tower = towerAt(1, { office: 300 });
    assert(noticesAfter(tower, 0).length === 0, 'fixture: a clean log');
    assert(!tryAdvanceStar(towerAt(1, { office: 299 })).advanced);
    const log = (t) => noticesAfter(t, 0);
    tryAdvanceStar(tower);
    assert(log(tower).length === 1, 'one notice: ' + JSON.stringify(log(tower)));
    const n = log(tower)[0];
    assert(n.text === 'The tower has reached 2 stars' && n.kind === 'starRise' && n.good === true, JSON.stringify(n));
    tryAdvanceStar(tower);                                   // not enough for 3
    assert(log(tower).length === 1, 'a refused advance says nothing');
    assert(starRiseNotice(6) === 'The tower has earned the Tower rank' && starRiseNotice(3) === 'The tower has reached 3 stars', 'the wording');
    // A notice is not a demand: it holds nothing up and never counts as one.
    assert(activeDemands(tower).length === 0, 'a star notice is not a live demand');
  },

  'the bar says a rise as good news, held longer, and over a complaint posted the same tick'() {
    const tower = towerAt(1, { office: 300 });
    raiseDemand(tower, 'recycling');
    tryAdvanceStar(tower);                                    // the rise is posted AFTER the complaint
    postNotice(tower, 'other', 'something later');            // and a later complaint sits on top of it
    const fresh = noticesAfter(tower, 0);
    const say = noticeToSay(fresh);
    assert(say.text === 'The tower has reached 2 stars' && say.ok === true && say.rise === true && say.ms === STAR_RISE_MS,
      'the rise wins the line: ' + JSON.stringify(say));
    const only = noticeToSay([{ text: 'Medical Center demanded near Lobby' }]);
    assert(only.ok === false && only.rise === false && only.ms === null, 'a complaint is a complaint: ' + JSON.stringify(only));
    assert(noticeToSay([]) === null && noticeToSay(undefined) === null, 'nothing to say is null, not a crash');
  },

  // ======================================================= the whole ladder

  'WALK: 1 -> 2 -> 3 -> 4 -> 5 -> Tower through the real scheduler, with the HUD saying what is missing at each step'() {
    const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
    const { tower } = world;
    const { scheduler } = makeDriver(world);
    const says = () => starClause(starGateStatus(tower), buildable);
    const step = (dayTick, dayCounter) => {
      tower.clock.dayTick = dayTick - 1;                       // the tick advances it by one
      tower.clock.dayCounter = dayCounter;
      tower.clock.calendarPhase = calendarPhaseFlag(dayCounter);
      scheduler.tick(tower);
      assert(tower.clock.dayTick === dayTick, 'fixture: at tick ' + dayTick);
    };
    const log = [];
    const record = (label) => log.push(label + ' -> ' + tower.starCount + ' stars | ' + says());

    // ---- 1 star, 216 people (the seed's measured shortfall)
    tower.populationLedger.office = 216;
    step(500, WEEKDAY);
    assert(tower.starCount === 1, 'still one star');
    assert(says() === 'Next: 2 stars - need 300 population (now 216)', says());
    tower.populationLedger.office = 300;
    step(501, WEEKDAY);
    assert(tower.starCount === 2, '300 people: two stars, no other gate');
    assert(noticesAfter(tower, 0).at(-1).text === 'The tower has reached 2 stars', 'and it said so');

    // ---- 2 stars: population is there, the security office is not
    tower.populationLedger.office = 640;
    assert(says() === 'Next: 3 stars - need 1,000 population (now 640), a security office', says());
    tower.populationLedger.office = 1000;
    step(502, WEEKDAY);
    assert(tower.starCount === 2, 'a thousand people and no security office stays at two');
    assert(says() === 'Next: 3 stars - need a security office', says());
    notePlacement(tower, TYPE_CODES.security);
    step(503, WEEKDAY);
    assert(tower.starCount === 3, 'the security office opens three');
    record('3 stars');

    // ---- 3 stars, 4,000 permanent people and 1,500 hotel guests: the guests do not count
    tower.populationLedger.office = 4000;
    Object.assign(tower.populationLedger, { hotelSingle: 500, hotelTwin: 500, hotelSuite: 500 });
    tower.gates.officePlaced = true;
    step(900, WEEKDAY);
    assert(tower.starCount === 3, 'the guests do not carry a tower');
    const morning = says();
    assert(morning.startsWith('Next: 4 stars - need 5,000 population (now 4,000), '), morning);
    for (const part of ['2 hotel suites', 'recycling centre', 'medical center', 'a passed office-service evaluation',
      'a favorable VIP stay', 'the evening (after 5 PM)']) {
      assert(morning.includes(part), '"' + part + '" is missing from: ' + morning);
    }
    // The office-service evaluation (issue #17) is the sim's own: a let office with a lift to it, an
    // evaluation day (day 3, `day % 9 == 3`), and an inspector who rides up and tests it. Nothing
    // sets the flag but his arrival. (The office is let by hand - the rent moment is the office
    // module's and has its own tests - and the lift is built through the seam.)
    const shaft = applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top: 3, column: 20 });
    assert(shaft.ok, 'fixture: a lift: ' + shaft.reason);
    for (let i = 0; i < 3; i++) assert(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }).ok, 'fixture: a car');
    const office = applyAction(world, { type: 'build', what: 'office', floor: 2, left: 40 });
    assert(office.ok, 'fixture: an office: ' + office.reason);
    office.object.unitStatus = 0;
    office.object.occupiedFlag = true;
    tower.routeTablesDirty = true;
    assert(tower.gates.officeServiceOk === false, 'fixture: nothing has passed it');
    tower.clock.dayCounter = 3;
    tower.clock.calendarPhase = calendarPhaseFlag(3);
    tower.clock.dayTick = 238;
    for (let i = 0; i < 2; i++) scheduler.tick(tower);
    assert(tower.inspection?.floor === 2, 'at 240 on an evaluation day the inspector sets out for the let office: ' + JSON.stringify(tower.inspection));
    assert(tower.gates.officeServiceOk === false, 'and has not arrived yet');
    for (let i = 0; i < 900 && tower.inspection; i++) scheduler.tick(tower);
    assert(!tower.inspection && tower.lastInspection?.pass === true, 'he rode up and the office passed: ' + JSON.stringify(tower.lastInspection));
    assert(tower.gates.officeServiceOk === true, 'and his arrival wrote the gate');
    assert(!says().includes('office-service'), 'the bar no longer asks for it: ' + says());

    // Everything this build CAN make, made; then the one stand-in, the VIP's opinion (#16).
    tower.populationLedger.office = 5000;
    Object.assign(tower.gates, { suitePlaced: true, recyclingAdequate: true, medicalServiceOk: true, routesViable: true });
    step(1599, WEEKDAY);
    assert(tower.starCount === 3, 'not before 5 PM');
    futureFlags(tower);
    step(1700, WEEKEND);
    assert(tower.starCount === 3, 'not on a weekend');
    assert(says() === 'Next: 4 stars - wait for a weekday', says());
    step(1600, WEEKDAY);
    // ⚠️ Found by walking it through the real scheduler: 1600 is also the recycling midday
    // reset (`TIME.md` § 1600 step 8), which CLEARS the adequacy flag on the very tick the
    // evening opens. In the real game 3 -> 4 therefore fires from the 2000 check onward,
    // never on the stroke of 5 PM; here the flag is set again, as that check would.
    assert(tower.starCount === 3 && says().includes('recycling centre'),
      'the 1600 reset clears recycling on the tick 5 PM opens: ' + says());
    tower.gates.recyclingAdequate = true;
    step(1601, WEEKDAY);
    assert(tower.starCount === 4, '5 PM on a weekday: four stars. ' + says());
    assert(tower.gates.officeServiceOk === false, 'and the office-service flag was reset by the advance');
    record('4 stars');

    // ---- 4 stars
    // The metro station is on the palette now, so the bar sends the player to it.
    assert(says().startsWith('Next: 5 stars - need 10,000 population (now 5,000), a metro station'), says());
    assert(!says().includes('a metro station (nothing builds one yet)'), says());
    tower.populationLedger.office = 10_000;
    assert(tower.gates.metroPlaced === false, 'fixture: nothing has latched the metro gate');
    // The 1600 reset raised "The tower demands a Recycling Center" (this walk set the flag by
    // hand, with no center behind it); a real center answers it. Both stay on the bar until then.
    assert(isDemanded(tower, 'recycling'), 'fixture: the recycling demand is live, as the real 1600 check left it');
    raiseDemand(tower, 'officeParking');
    step(1700, WEEKDAY);
    assert(tower.starCount === 4 && says().includes('every demand answered')
      && says().includes('Office workers demand Parking'), 'live demands hold it: ' + says());
    clearDemand(tower, 'officeParking');
    clearDemand(tower, 'recycling');
    // Everything met EXCEPT the station: the gate holds, and says what is missing.
    step(1701, WEEKDAY);
    assert(tower.starCount === 4 && says() === 'Next: 5 stars - need a metro station', 'no metro, no five stars: ' + says());
    // The real writer (issue #15): placing a station through the seam latches the gate.
    const built = applyAction(world, { type: 'build', what: 'metroStation', floor: -10, left: 100 });
    assert(built.ok, 'the station builds: ' + built.reason);
    assert(tower.gates.metroPlaced === true, 'placing it latched the gate, with no other edit');
    step(1702, WEEKDAY);
    assert(tower.starCount === 5, 'metro + demands met + 10,000: five stars. ' + says());
    record('5 stars');

    // ---- 5 stars: the cathedral and the wedding (issue #17), every part of it the sim's own
    tower.populationLedger.office = 15_000;
    assert(says().includes('a cathedral on the 100th floor (floor 99)') && says().includes('a wedding with 40 guests'), says());
    assert(!says().includes('nothing builds one yet'), 'the cathedral is on the palette now: ' + says());
    // Refused anywhere but the 100th floor, with the original's own sentence, and nothing taken.
    const cash = tower.cash;
    const wrongFloor = applyAction(world, { type: 'build', what: 'cathedral', floor: 98, left: 60 });
    assert(!wrongFloor.ok && /available only on the 100th floor/.test(wrongFloor.reason) && tower.cash === cash, wrongFloor.reason);
    assert(tower.gates.cathedralPlaced === false, 'fixture: not latched by a refusal');
    // The lifts to the top, then the building. The seam latches the gate.
    const lifts = buildWeddingSpine(world, { column: 70 });
    assert(lifts.ok, 'the lifts to the 100th floor build: ' + lifts.reason);
    const chapel = applyAction(world, { type: 'build', what: 'cathedral', floor: CATHEDRAL_BASE_FLOOR, left: 60 });
    assert(chapel.ok, 'the cathedral builds: ' + chapel.reason);
    assert(tower.gates.cathedralPlaced === true, 'placing it latched the gate, with no other edit');
    assert(!says().includes('a cathedral on') && says().includes('a wedding with 40 guests'), 'what is left is the wedding: ' + says());
    // A weekday evening and a weekday morning: nothing happens, and the rank is not given.
    step(1800, WEEKDAY);
    assert(tower.starCount === 5, 'the cathedral alone is not the Tower rank');
    // A weekend morning (day 2, tick 0 wakes the guests), and the forty ride the real lifts up.
    step(0, WEEKEND);
    assert(cathedralGuests(tower).length === 40 && cathedralGuests(tower).every((g) => g.state === GUEST_STATE.waiting), 'the guests are woken at tick 0');
    let riseTick = null;
    for (let i = 0; i < 700 && riseTick === null; i++) {
      scheduler.tick(tower);
      if (tower.starCount === TOWER_RANK) riseTick = tower.clock.dayTick;
    }
    assert(riseTick !== null && riseTick < WEDDING_DEADLINE_TICK, 'a weekend morning, forty guests, the lifts: the Tower rank by tick ' + riseTick);
    assert(tower.gates.weddingGuestsArrived === WEDDING_GUESTS, 'the sim counted them: ' + tower.gates.weddingGuestsArrived);
    assert(tower.finale && tower.finale.day === WEEKEND, 'and recorded the moment: ' + JSON.stringify(tower.finale));
    assert(noticesAfter(tower, 0).at(-1).text === 'The tower has earned the Tower rank', 'and it said so');
    assert(says() === 'Tower rank - the top of the ladder', says());
    assert(starGlyph(tower.starCount) === '★★★★★', 'five stars drawn');
    record('Tower');

    // ---- and the whole climb was announced once per rung
    const rises = noticesAfter(tower, 0).filter((n) => n.kind === 'starRise').map((n) => n.text);
    assert(rises.join(' | ') === 'The tower has reached 2 stars | The tower has reached 3 stars | The tower has reached 4 stars | '
      + 'The tower has reached 5 stars | The tower has earned the Tower rank', rises.join(' | '));
  },

  // ============================================================ the harness proof

  'harness: a scripted player reading the bar climbs 1 -> Tower, every rung inside its window'() {
    const r = ladderTrial();
    assert(r.finalStar === TOWER_RANK, 'it reached the Tower rank, not ' + r.finalStar + ': ' + r.perDay.map((d) => d.star).join(''));
    assert(r.rises.map((x) => x.text).join('|') === [2, 3, 4, 5].map((n) => 'The tower has reached ' + n + ' stars').concat('The tower has earned the Tower rank').join('|'),
      'five announcements, in order: ' + r.rises.map((x) => x.text).join(' | '));

    const [two, three, four, five, tower] = r.rises;
    // 4 and 5 stars only inside "a weekday at or after 5 PM" (the day counter has already moved at 2300, so
    // the weekday is the NEW day's), and the Tower rank only on a weekend before tick 800.
    for (const rise of [four, five]) {
      assert(rise.tick >= 1600 && !calendarPhaseFlag(rise.day), rise.text + ' came on day ' + rise.day + ' tick ' + rise.tick + ' - not a weekday evening');
    }
    assert(calendarPhaseFlag(tower.day) && tower.tick < WEDDING_DEADLINE_TICK, 'Tower on day ' + tower.day + ' tick ' + tower.tick + ' - not a weekend morning');
    assert(two.day <= three.day && three.day < four.day && four.day < five.day && five.day < tower.day, 'and in order');

    // What was built was built, and the bar said what was missing on the way.
    const built = new Set(r.built.map((b) => b.what));
    for (const what of ['security', 'hotelSuite', 'medical', 'service lift', 'recycling center', 'parking ramp']) {
      assert(built.has(what), 'the script never built a ' + what + ' - built: ' + [...built]);
    }
    const early = r.perDay[1];
    assert(early.star === 3 && early.hud.includes('2 hotel suites') && early.hud.includes('a favorable VIP stay'),
      'at three stars the bar names the lot: ' + early.hud);
    assert(r.perDay.some((d) => d.star === 4 && d.hud.includes('every demand answered (Office workers demand Parking)')),
      'at four stars the bar says the tower still wants parking');
    assert(r.perDay.some((d) => d.star === 5 && d.hud.startsWith('Next: Tower - ')), 'and at five it asks for the Tower rank');
    // **No gate flag was written by the script** (issue #17): its one stand-in is the population ledger's
    // "crowd". The sim opened every gate itself, and the report says on which day.
    assert(Object.keys(r.flagsSetOn).length === 0, 'the script wrote flags: ' + Object.keys(r.flagsSetOn));
    assert(['officeServiceOk', 'vipStayFavorable', 'cathedralPlaced', 'weddingGuestsArrived'].every((k) => k in r.realOn),
      'the sim opened all four of the issue-14 pending gates: ' + JSON.stringify(r.realOn));
    assert(r.inspections?.pass === true && r.inspections.floor > 0, 'a real inspector passed a real office: ' + JSON.stringify(r.inspections));
    assert(built.has('lifts to the 100th floor') && built.has('cathedral'), 'the script built the lifts and the cathedral through the seam: ' + [...built]);
    assert(r.cathedralPlacedDay !== null && r.cathedralPlacedDay < tower.day, 'the cathedral stood before the wedding');
    assert(r.weddingTick !== null && r.weddingTick < WEDDING_DEADLINE_TICK, 'the fortieth guest arrived at tick ' + r.weddingTick);
    // ...and the VIP is not one of them (issue #16): a real visitor booked a real suite, rode the
    // real lifts and was pleased, which is what opened 3 -> 4.
    const vip = r.world.tower.events.history.filter((h) => h.kind === 'vip').map((h) => h.outcome);
    assert(vip.includes('booked') && vip.includes('arrived') && vip.at(-1) === 'comfortable',
      'the VIP earned the gate himself: ' + vip);
    // ...and the metro station was BUILT, by the script, through the seam, not flagged.
    assert(built.has('metro station') && r.metroPlacedDay !== null && r.metroPlacedDay < five.day,
      'the script built the station before the fifth star: ' + r.metroPlacedDay);
  },

  // =================================================== the save, and the version

  'the save carries the Tower rank and the new gates, and the version moved to 8'() {
    // (Issue #15 moved it on to 9; the check is a floor, and test/metro.test.js pins the 9.)
    assert(SAVE_VERSION >= 8, 'the shape and the rules changed: ' + SAVE_VERSION);
    const world = newTowerWorld({ seed: 1 });
    world.tower.starCount = TOWER_RANK;
    Object.assign(starGatesOf(world.tower), { suitePlaced: true, vipStayFavorable: true, cathedralPlaced: true, weddingGuestsArrived: 40 });
    world.tower.populationLedger.retailVisits = 12;
    const back = restore(JSON.parse(JSON.stringify(snapshot(world))));
    assert(back.ok !== false, 'it loads: ' + back.reason);
    const t = back.world.tower;
    assert(t.starCount === TOWER_RANK && t.gates.suitePlaced && t.gates.vipStayFavorable && t.gates.cathedralPlaced
      && t.gates.weddingGuestsArrived === 40 && t.populationLedger.retailVisits === 12, 'all of it came back');
    // A v7 file is refused rather than resumed into a different ladder.
    const old = JSON.parse(JSON.stringify(snapshot(world)));
    old.version = 7;
    assert(restore(old).ok === false, 'a v7 save is refused');
  },

  'the glyph never overflows at the Tower rank'() {
    assert(starGlyph(TOWER_RANK) === '★★★★★', starGlyph(TOWER_RANK));
  },

  'the HUD must be able to name every EXPERT blocker: every kind a blocker carries is a real buildable name'() {
    // The blocker `kind`s are the HUD's promise that a thing exists. Over the whole ladder:
    const kinds = new Set();
    for (const rung of RUNGS) {
      const tower = towerAt(rung.star, { office: rung.office, dayTick: 100, dayCounter: WEEKDAY });
      for (const d of starGateStatus(tower).blockerDetails) if (d.kind) kinds.add(d.kind);
    }
    for (const kind of ['security', 'office', 'hotelSuite', 'recyclingCenter', 'medical', 'metroStation', 'cathedral']) {
      assert(kinds.has(kind), 'the ladder never asks for a ' + kind);
    }
    const unbuildable = [...kinds].filter((k) => !buildable(k));
    assert(unbuildable.length === 0, 'the cathedral (issue #17) was the last; nothing the ladder asks for is missing from the palette: ' + unbuildable);
  },
};
