/**
 * Stars, checked against the reference rather than against a ladder that feels
 * about right.
 *
 * Every assertion cites `specs/GAME-STATE.md` or the reference's own tier
 * table. Two of these tests exist specifically to fail if someone makes the
 * ladder *passable*: most of the checklist names facilities this build does not
 * have, and the honest behaviour is to stall with a reason rather than to
 * advance because a requirement was skipped. A progression that climbs because
 * a gate was dropped is worse than one that stops and says what is missing.
 */
import { EVENING_DAYPART } from '../src/games/tower/sim/clock.js';
import { TYPE_CODES } from '../src/games/tower/sim/economy.js';
import { FAMILY, createTower, placeObject } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import {
  MAX_STAR, STAR_REQUIREMENT, STAR_THRESHOLDS, activityForStar, createStarGates,
  isUnlocked, lockReason, notePlacement, refreshStartOfDayGates, resetStarGateState,
  starCountForActivity, starGateStatus, starGatesOf, starRequirementFor,
  towerActivity, tryAdvanceStar,
} from '../src/games/tower/sim/progression.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * A tower at `star`, with `activity` on the population ledger and whatever
 * gates it needs already satisfied. `evening` puts the clock inside the window
 * the top two rungs require.
 */
function towerAt(star, { activity = 0, gates = {}, evening = true, calendarPhase = false } = {}) {
  const tower = createTower({ seed: 1 });
  tower.starCount = star;
  tower.populationLedger = { office: activity };
  tower.gates = { ...createStarGates(), ...gates };
  tower.clock.daypart = evening ? EVENING_DAYPART : 0;
  tower.clock.calendarPhase = calendarPhase;
  return tower;
}

/** Every gate a tier needs, so a test can remove exactly one and watch it fail. */
const ALL_GATES = {
  securityPlaced: true, officePlaced: true, metroPlaced: true,
  recyclingAdequate: true, officeServiceOk: true, routesViable: true,
};

export const tests = {
  // ---------------------------------------------------------- the activity

  'the tier table is the reference’s, compared with >='() {
    // The reference's `compute_tower_tier_from_ledger` (1148:041d), thresholds
    // from binary DS:e630..e63c plus a hardcoded 15000.
    assert(JSON.stringify(STAR_THRESHOLDS) === JSON.stringify([300, 1000, 5000, 10_000, 15_000]),
      'the tier table reads ' + STAR_THRESHOLDS.join(','));

    // Boundaries both sides, because `>` and `>=` differ by exactly one tenant.
    const table = [[0, 1], [299, 1], [300, 2], [999, 2], [1000, 3], [4999, 3],
      [5000, 4], [9999, 4], [10_000, 5], [14_999, 5], [15_000, 6]];
    for (const [activity, tier] of table) {
      assert(starCountForActivity(activity) === tier,
        activity + ' activity earns tier ' + starCountForActivity(activity) + ', expected ' + tier);
    }
  },

  'the sixth tier is computed but never awarded by this ladder'() {
    // `specs/GAME-STATE.md`: "The Tower-grade promotion uses a separate
    // cathedral/evaluation path rather than the normal star gate." So the
    // computation reaches 6 and the advance stops at 5.
    assert(starCountForActivity(15_000) === 6, 'the tier computation was capped');
    const tower = towerAt(MAX_STAR, { activity: 99_999, gates: ALL_GATES });
    assert(!tryAdvanceStar(tower).advanced && tower.starCount === MAX_STAR,
      'a 5-star tower advanced to ' + tower.starCount + ' on activity alone');
  },

  'activity is the population ledger, which is what the lifts decide'() {
    // `specs/ECONOMY.md` § Ledgers: the population ledger holds the counts that
    // "drive star thresholds". The economy moves it by +6 when an office rents
    // and -6 when it is vacated, so a tower's rank follows its transport.
    const tower = createTower({ seed: 1 });
    tower.populationLedger = { office: 216, retail: 40, condo: 0 };
    assert(towerActivity(tower) === 256, 'activity summed to ' + towerActivity(tower));

    tower.populationLedger.office = 0;               // every office vacated
    assert(towerActivity(tower) === 40, 'a vacated tower still reports ' + towerActivity(tower));
  },

  // ------------------------------------------------------------ the ladder

  'one to two is activity alone'() {
    // `specs/GAME-STATE.md` § Star Advancement: "1 -> 2: no additional gate
    // once the activity threshold is met".
    const short = towerAt(1, { activity: 299 });
    assert(!tryAdvanceStar(short).advanced, '299 activity reached 2 stars');
    assert(starGateStatus(short).blockers.join() === '1 more tower activity',
      'a tower one tenant short says: ' + starGateStatus(short).blockers.join(' · '));

    const enough = towerAt(1, { activity: 300 });
    assert(tryAdvanceStar(enough).advanced && enough.starCount === 2,
      '300 activity did not reach 2 stars with no other gate to pass');
  },

  'two to three needs a security office, and says so'() {
    const tower = towerAt(2, { activity: 1000 });
    const before = starGateStatus(tower);
    assert(!tryAdvanceStar(tower).advanced, 'a tower with no security office reached 3 stars');
    assert(before.activityReady, 'the fixture did not clear the activity gate, so this proves nothing');
    assert(before.blockers.includes('a security office'),
      'the refusal does not name what is missing: ' + before.blockers.join(' · '));

    tower.gates.securityPlaced = true;
    assert(tryAdvanceStar(tower).advanced && tower.starCount === 3, 'a security office did not unblock 3 stars');
  },

  /**
   * Each of the four 3→4 gates, removed one at a time. Written this way because
   * a checklist test that only checks the all-pass case passes just as happily
   * when a gate has been quietly deleted.
   */
  'three to four needs every one of its four gates'() {
    // `specs/GAME-STATE.md`: "office placed, recycling adequate, office-service
    // evaluation passed, route viability true".
    const required = ['officePlaced', 'recyclingAdequate', 'officeServiceOk', 'routesViable'];
    for (const flag of required) {
      const tower = towerAt(3, { activity: 5000, gates: { ...ALL_GATES, [flag]: false } });
      assert(!tryAdvanceStar(tower).advanced,
        'a tower missing ' + flag + ' still reached 4 stars — that gate is not being checked');
    }
    const ready = towerAt(3, { activity: 5000, gates: ALL_GATES });
    assert(tryAdvanceStar(ready).advanced && ready.starCount === 4,
      'a tower with all four gates did not reach 4 stars');
  },

  'four to five needs a metro station, recycling and route viability'() {
    const required = ['metroPlaced', 'recyclingAdequate', 'routesViable'];
    for (const flag of required) {
      const tower = towerAt(4, { activity: 10_000, gates: { ...ALL_GATES, [flag]: false } });
      assert(!tryAdvanceStar(tower).advanced, 'a tower missing ' + flag + ' still reached 5 stars');
    }
    const ready = towerAt(4, { activity: 10_000, gates: ALL_GATES });
    assert(tryAdvanceStar(ready).advanced && ready.starCount === 5, 'the last rung is unreachable');
  },

  'the top two rungs are evening-only, and not on a calendar-phase day'() {
    // `specs/GAME-STATE.md`: "`daypart_index >= 4`, and `calendar_phase_flag == 0`".
    for (const star of [3, 4]) {
      const activity = star === 3 ? 5000 : 10_000;
      const morning = towerAt(star, { activity, gates: ALL_GATES, evening: false });
      assert(!tryAdvanceStar(morning).advanced, star + ' stars advanced in the morning');
      assert(starGateStatus(morning).blockers.includes('the evening'),
        'the morning refusal reads: ' + starGateStatus(morning).blockers.join(' · '));

      const phase = towerAt(star, { activity, gates: ALL_GATES, calendarPhase: true });
      assert(!tryAdvanceStar(phase).advanced, star + ' stars advanced on a calendar-phase day');
    }

    // Negated: the two lower rungs are NOT time-gated, so a morning tower with
    // the activity still climbs. Without this the test above passes for a
    // ladder that is evening-only all the way up.
    const early = towerAt(1, { activity: 300, evening: false });
    assert(tryAdvanceStar(early).advanced, '1 -> 2 was blocked by a time gate it does not have');
  },

  'one star at a time, however much activity arrives at once'() {
    // A tower that jumps from nothing to 5 stars' worth of tenants still has to
    // pass 2's gate, then 3's, then 4's. `tryAdvanceStar` increments by one.
    const tower = towerAt(1, { activity: 10_000, gates: ALL_GATES });
    assert(tryAdvanceStar(tower).advanced && tower.starCount === 2, 'the first rung failed');
    assert(tryAdvanceStar(tower).advanced && tower.starCount === 3, 'the second rung failed');
    assert(tower.starCount === 3, 'the tower skipped a rung to ' + tower.starCount);
  },

  'the office-service flag is cleared on each advance, and nothing else is'() {
    // `specs/GAME-STATE.md` § Office Service Evaluation: "The office-service
    // fields are reset to their initial values at new game start and on each
    // star advancement." Clearing the placement latches too would take away a
    // security office the tower still owns.
    const tower = towerAt(3, { activity: 5000, gates: ALL_GATES });
    tryAdvanceStar(tower);
    assert(tower.gates.officeServiceOk === false, 'the office-service flag survived the advance');
    assert(tower.gates.securityPlaced && tower.gates.officePlaced && tower.gates.metroPlaced,
      'a placement latch was cleared by an advance — the tower lost a facility it still owns');
    assert(tower.gates.recyclingAdequate, 'recycling adequacy was cleared by an advance');

    // And directly, so the reset is pinned even if no advance calls it.
    const other = towerAt(2, { gates: ALL_GATES });
    resetStarGateState(other);
    assert(!other.gates.officeServiceOk && other.gates.routesViable,
      'the reset cleared the wrong flags');
  },

  // ------------------------------------------------------------- the gates

  'a placement latches its gate, immediately and again at start of day'() {
    const tower = createTower({ seed: 1 });
    assert(!starGatesOf(tower).officePlaced, 'a fresh tower already has an office placed');

    notePlacement(tower, FAMILY.office);
    assert(tower.gates.officePlaced, 'placing an office did not latch its gate');
    assert(!tower.gates.securityPlaced, 'an office latched the security gate too');

    // The start-of-day sweep is the safety net for objects placed outside
    // `applyAction` — the seeded tower, and a loaded save.
    const seeded = createTower({ seed: 1 });
    placeObject(seeded, { family: FAMILY.office, floor: 3, left: 0, right: 5 },
      () => createSimTripRecord());
    assert(!starGatesOf(seeded).officePlaced, 'the fixture latched before the sweep ran');
    refreshStartOfDayGates(seeded);
    assert(seeded.gates.officePlaced, 'the start-of-day sweep missed a standing office');
  },

  'the security and metro gates read the reference’s own type codes'() {
    // `sim/state.js` has no name for either family yet. Asserted through
    // behaviour so the day it gains one, a mismatched code fails here.
    const tower = createTower({ seed: 1 });
    notePlacement(tower, TYPE_CODES.security);
    assert(tower.gates.securityPlaced, 'a security office did not latch the 2 -> 3 gate');

    notePlacement(tower, TYPE_CODES.metroStation);
    assert(tower.gates.metroPlaced, 'a metro station did not latch the 4 -> 5 gate');
  },

  /**
   * `specs/GAME-STATE.md` § Gate Meanings is explicit that this gate is
   * narrower than its name: nothing measures a route. The start-of-day rebuild
   * sets it whenever `star_count > 2`, and the authors record that no other
   * writer was found.
   */
  'route viability is a day-start latch above 2 stars, not a route test'() {
    const low = createTower({ seed: 1 });
    low.starCount = 2;
    refreshStartOfDayGates(low);
    assert(!low.gates.routesViable, 'the gate latched at 2 stars, where the rebuild does not set it');

    const high = createTower({ seed: 1 });
    high.starCount = 3;
    assert(!starGatesOf(high).routesViable,
      'the gate is already true before a day has started — the documented behaviour is that it '
      + 'stays false until the next day-start rebuild');
    refreshStartOfDayGates(high);
    assert(high.gates.routesViable, 'the day-start rebuild did not latch route viability');

    // It has no carriers and no route table. If this ever starts depending on
    // real transport, the reference has been left behind and it belongs in
    // spec/DEVIATIONS.md.
    assert(high.carriers.length === 0, 'the fixture accidentally has a lift, so this proves nothing');
  },

  // ------------------------------------------------------------- unlocks

  'the unlock table gates each rung on the tool the next rung needs'() {
    // The self-consistency that makes the ladder work: security needs 2 stars
    // and 2 -> 3 needs security; recycling needs 3 and 3 -> 4 needs recycling;
    // metro needs 4 and 4 -> 5 needs metro.
    assert(starRequirementFor('security') === 2, 'security unlocks at ' + starRequirementFor('security'));
    assert(starRequirementFor('recyclingCenter') === 3, 'recycling unlocks at ' + starRequirementFor('recyclingCenter'));
    assert(starRequirementFor('metroStation') === 4, 'metro unlocks at ' + starRequirementFor('metroStation'));
    assert(starRequirementFor('cathedral') === 5, 'the cathedral unlocks at ' + starRequirementFor('cathedral'));

    // The starting palette is available from the first star, or a new game has
    // nothing to build.
    for (const kind of ['lobby', 'office', 'elevatorStandard', 'stairs', 'floorTile']) {
      assert(starRequirementFor(kind) === 1, kind + ' is locked at 1 star');
    }
    // Anything absent is available, rather than accidentally locked.
    assert(starRequirementFor('somethingNobodyHasBuiltYet') === 1, 'an unknown buildable defaults to locked');
  },

  'a lock is not a price, and says which it is'() {
    const one = createTower({ seed: 1 });
    assert(!isUnlocked(one, 'metroStation'), 'a 1-star tower can build a metro station');
    const reason = lockReason(one, 'metroStation', 'Metro Station');
    assert(reason && reason.includes('4 stars') && reason.includes('1 star'),
      'the lock reason does not say what is needed and what is held: ' + reason);
    assert(!/cost|\$/i.test(reason), 'the lock reason talks about money: ' + reason);

    one.starCount = 4;
    assert(isUnlocked(one, 'metroStation') && lockReason(one, 'metroStation') === null,
      'a 4-star tower is still locked out of a metro station');
  },

  'every buildable in the unlock table is one the economy can price'() {
    // Both tables are keyed by the same construction-cost name, deliberately —
    // a palette entry, a price and a lock are three reads of one vocabulary.
    // That is the `payout(7, ...)` lesson: translate at the seam once.
    for (const kind of Object.keys(STAR_REQUIREMENT)) {
      assert(kind in TYPE_CODES,
        '"' + kind + '" is locked behind a star but is not a thing the economy has a code for');
    }
  },

  // ------------------------------------------------------------ the status

  'the status leads with activity, because the rest is not actionable yet'() {
    // Telling someone to build a metro station while they are 4,000 tenants
    // short of being asked is not advice.
    const tower = towerAt(4, { activity: 6000 });
    const status = starGateStatus(tower);
    assert(status.blockers[0] === '4000 more tower activity',
      'the first blocker is "' + status.blockers[0] + '"');
    assert(status.activityNeeded === 4000, 'the shortfall reads ' + status.activityNeeded);
    assert(!status.ready, 'a tower short of activity reports ready');
  },

  'a five-star tower is told the ladder is over, not that it is nearly there'() {
    const status = starGateStatus(towerAt(MAX_STAR, { activity: 99_999, gates: ALL_GATES }));
    assert(status.nextStar === null, 'a 5-star tower has a next star of ' + status.nextStar);
    assert(!status.ready && status.blockers.length === 1, 'the top of the ladder reports ready');
  },

  'activityForStar names the threshold each rung asks for'() {
    assert(activityForStar(1) === 300 && activityForStar(2) === 1000 && activityForStar(4) === 10_000,
      'the per-rung thresholds do not match the tier table');
  },
};
