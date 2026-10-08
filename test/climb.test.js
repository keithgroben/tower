/**
 * The full climb (issue #19): a scripted player, one star to the Tower, asserted.
 *
 * Spec: `specs/GAME-STATE.md` § Star Advancement, § Gate Meanings; `specs/facility/EVALUATION.md` §
 * Award Check; `specs/ELEVATORS.md` (the 30-floor span, express stops, sky lobbies); `specs/ROUTING.md`
 * § Transfer Groups (one change of lift). `spec/DEVIATIONS.md` A88-A92.
 *
 * ## What this file proves, and how short it is
 *
 * Every run is `harness/climb.js`'s `climbTrial` - the same function `node harness/playtest.js --climb`
 * prints - so the test and the harness cannot disagree about what was played. The short horizon
 * (`QUICK`: 24 days, 200 offices) carries three named stand-ins: the capital, the crowd (the population
 * the sim cannot host) and the player's ambition. The honest run, $2,000,000 and no stand-in, is the two
 * 45-day trials near the end; the long one (130 days to four stars) is `npm run climb`.
 *
 *   1. the zoned player climbs every rung, and each rung came through its own gate (read the tick BEFORE);
 *   2. each star is withheld when its one requirement is taken away (the player never answers it);
 *   3. knowing the lifts beats ignoring them: the service lift opens `3 -> 4`, the express to the 100th
 *      floor opens the wedding, one lift loses its tenants;
 *   4. the books add up in every quarter; the run is the same twice; the script writes no gate.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUICK, climbTrial, describeClimb, fingerprint } from '../harness/climb.js';
import { starGateStatus } from '../src/games/tower/sim/progression.js';
import {
  EXPRESS_COLUMNS, SERVICE_COLUMN, SLOTS, ZONES, ZONE_SHAFTS, plannedLiftSites, skyFloor, zoneFloors, zoneOfFloor, zoneTop,
} from '../src/games/tower/policy/climb.js';
import { SHAFT_SEPARATION } from '../src/games/tower/sim/actions.js';
import { MAX_CARRIERS } from '../src/games/tower/sim/elevators.js';
import { WEDDING_GUESTS, WEDDING_DEADLINE_TICK } from '../src/games/tower/sim/progression.js';
import { isSkyLobbyFloor } from '../src/games/tower/sim/state.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const days = (r) => Object.entries(r.starDay).map(([s, d]) => (Number(s) >= 6 ? 'Tower' : s + '*') + '@' + d).join(' ');

/** The short run, cached: several tests read the same trial and it is deterministic. */
const cache = new Map();
const quick = (key, options = {}) => {
  if (!cache.has(key)) cache.set(key, climbTrial({ ...QUICK, ...options }));
  return cache.get(key);
};

export const tests = {
  // ============================================================ the zoned player climbs

  'the zoned player climbs 1 star to the Tower rank, in order, inside the short horizon'() {
    const r = quick('zoned');
    assert(r.finalStar === 6, 'zoned: wanted the Tower rank in ' + QUICK.days + ' days, got ' + r.finalStar + ' stars (' + days(r) + ')');
    assert(r.rises.map((x) => x.star).join() === '2,3,4,5,6', 'each rung once and in order: ' + r.rises.map((x) => x.star));
    assert(r.starDay[6] <= 20, 'Tower rank by day 20 (measured: day 17); got ' + days(r));
    assert(r.worstDiscrepancy === 0, 'the books');
    assert(r.world.tower.finale && r.world.tower.finale.day === r.starDay[6], 'the finale was recorded the day the rank came');
    // The sim, not the script, opened every gate the checklist reads.
    for (const flag of ['securityPlaced', 'suitePlaced', 'officeServiceOk', 'vipStayFavorable', 'metroPlaced', 'cathedralPlaced', 'weddingGuestsArrived']) {
      assert(flag in r.gatesOn, flag + ' was never opened by the sim: ' + JSON.stringify(r.gatesOn));
    }
    assert(r.weddingTick < WEDDING_DEADLINE_TICK, 'the fortieth guest arrived before tick 800: ' + r.weddingTick);
  },

  'each rise came through its own gate: every requirement was true when the star came'() {
    const r = quick('zoned');
    // The checklist written out again by hand (`progression.js` § The whole ladder), deliberately: a
    // rise that the production table lets through and this table would not is the bug.
    const needs = {
      2: { pop: 300 },
      3: { pop: 1000, gates: ['securityPlaced'] },
      4: { pop: 5000, gates: ['officePlaced', 'suitePlaced', 'recyclingAdequate', 'medicalServiceOk', 'officeServiceOk', 'vipStayFavorable', 'routesViable'], evening: true, weekday: true },
      5: { pop: 10_000, gates: ['metroPlaced', 'recyclingAdequate', 'medicalServiceOk', 'routesViable'], evening: true, weekday: true, noDemands: true },
      6: { pop: 15_000, gates: ['cathedralPlaced'], wedding: true },
    };
    for (const x of r.rises) {
      const need = needs[x.star];
      const { before, after } = x;
      assert(before.starBefore === x.star - 1, x.star + ' came from ' + before.starBefore);
      assert(x.activity >= need.pop, x.star + ' stars on ' + x.activity + ' people, wanted ' + need.pop);
      // A flag the rise's own tick wrote (recycling at 2000, the fortieth guest) is on the `after` side; the
      // office-service flag is cleared BY the rise, so it can only be read from the tick before.
      for (const flag of need.gates ?? []) {
        const on = flag === 'officeServiceOk' ? before.gates[flag] : (before.gates[flag] || after.gates[flag]);
        assert(on, x.star + ' stars without ' + flag);
      }
      if (need.evening) assert(after.daypart >= 4, x.star + ' stars before 5 PM (daypart ' + after.daypart + ')');
      if (need.weekday) assert(after.calendarPhase === false, x.star + ' stars on a weekend');
      if (need.noDemands) assert(after.demands === 0, x.star + ' stars with ' + after.demands + ' demands unanswered');
      if (need.wedding) {
        assert(after.gates.weddingGuestsArrived >= WEDDING_GUESTS, 'the Tower rank with ' + after.gates.weddingGuestsArrived + ' guests at the cathedral');
        assert(after.calendarPhase === true && after.dayTick < WEDDING_DEADLINE_TICK, 'the wedding is a weekend morning before tick 800');
      }
    }
  },

  'the stand-ins are named: the report says the crowd and the capital out loud, and an honest run says it has none'() {
    const text = describeClimb(quick('zoned')).join('\n');
    assert(/STAND-IN capital/.test(text) && /STAND-IN crowd/.test(text), 'the short run names its stand-ins');
    assert(/<- stand-in/.test(text) && /<- all real tenants/.test(text), 'each star says how much of its population was real');
    const honest = describeClimb(climbTrial({ days: 12, lifts: 'zoned' })).join('\n');
    assert(/NOT a stand-in/.test(honest) && /no crowd/.test(honest) && !/STAND-IN/.test(honest), 'an honest run claims nothing: ' + honest.slice(0, 400));
  },

  // ============================================================ each star only through its gate

  'each star is withheld when the player never answers its one requirement'() {
    const reached = quick('zoned').finalStar;
    assert(reached === 6, 'the control must get there');
    // [what the player skips, the star the tower stops at, the words the bar uses for what is missing]
    const rows = [
      [{ skip: ['security'] }, 2, /security office/],
      [{ skip: ['suites'] }, 3, /hotel suites/],
      [{ skip: ['housekeeping'] }, 3, /VIP/],
      [{ skip: ['recycling'] }, 3, /recycling/],
      [{ skip: ['service'] }, 3, /recycling/],
      [{ crowd: false }, 3, /more tower activity/],
      [{ skip: ['metro'] }, 4, /metro station/],
      [{ skip: ['parking'] }, 4, /Parking/],
      [{ skip: ['medical'] }, 4, /Medical|medical/],
      [{ skip: ['cathedral'] }, 5, /cathedral/],
      [{ skip: ['spine'] }, 5, /wedding/],
    ];
    for (const [options, stops, words] of rows) {
      const label = JSON.stringify(options);
      const r = climbTrial({ ...QUICK, days: 20, ...options });
      assert(r.finalStar === stops, label + ': wanted the tower held at ' + stops + ' stars, got ' + r.finalStar + ' (' + days(r) + ')');
      const left = starGateStatus(r.world.tower).blockers.join(' | ');
      assert(words.test(left), label + ': the bar should name what is missing (' + words + '), it says: ' + left);
    }
  },

  // ============================================================ knowing the bottleneck beats ignoring it

  'knowing the lifts beats ignoring them: the service lift opens 3 -> 4, the express to the 100th floor opens the wedding'() {
    const zoned = quick('zoned');
    const cars = quick('cars', { lifts: 'cars' });
    const single = quick('single', { lifts: 'single' });
    const carsSvc = quick('carsSvc', { lifts: 'cars', serviceLift: true });
    const singleSvc = quick('singleSvc', { lifts: 'single', serviceLift: true });
    const table = 'zoned ' + days(zoned) + ' | cars ' + days(cars) + ' | single ' + days(single)
      + ' | cars+service ' + days(carsSvc) + ' | single+service ' + days(singleSvc);

    assert(zoned.finalStar === 6, 'the player who zones the lifts gets the Tower: ' + table);
    assert(cars.finalStar === 3, 'standard lifts and no service lift: held at 3 stars (recycling cannot work): ' + table);
    assert(single.finalStar === 3, 'one lift: held at 3 stars: ' + table);
    assert(/recycling/.test(starGateStatus(cars.world.tower).blockers.join('|')), 'the bar names the recycling centre');
    // Give the same players the service lift and the express is what stops them: nothing reaches floor 99.
    assert(carsSvc.finalStar === 5 && singleSvc.finalStar === 5, 'with a service lift, no express to the 100th floor means no wedding: ' + table);
    assert(/wedding|cathedral/.test(starGateStatus(carsSvc.world.tower).blockers.join('|')), 'the bar names the wedding');
    for (const r of [cars, single, carsSvc, singleSvc]) assert(!('weddingGuestsArrived' in r.gatesOn), 'nobody else saw a wedding');

    // The same players on the same offices, and what the lifts did to their tenants.
    const last = (r) => r.perDay.at(-1);
    const kept = (r) => r.perDay.slice(-9).reduce((n, row) => n + row.let, 0) / r.perDay.slice(-9).reduce((n, row) => n + row.offices, 0);
    assert(kept(zoned) > 0.85, 'zoned keeps its tenants (' + kept(zoned).toFixed(2) + '): ' + table);
    assert(kept(single) < 0.4, 'one lift loses its tenants (' + kept(single).toFixed(2) + '): ' + table);
    assert(last(zoned).offices === last(single).offices, 'the same 200 offices');
    assert(last(zoned).carriers > last(single).carriers && last(zoned).cars > 10 * last(single).cars, 'zoned buys the lifts');
  },

  'the climb works on other seeds, not only the one it was tuned on'() {
    for (const seed of [2, 3]) {
      const r = climbTrial({ ...QUICK, seed });
      assert(r.finalStar === 6, 'seed ' + seed + ': ' + days(r));
    }
  },

  // ============================================================ the honest run: $2,000,000, no stand-in

  'honest play from an empty lot: 2 stars on the second week, 3 on the fifth, every person a real tenant'() {
    const zoned = climbTrial({ days: 45, lifts: 'zoned' });
    assert(zoned.starDay[2] <= 14 && zoned.starDay[3] <= 40, 'zoned: ' + days(zoned) + ' (measured: 2* day 9, 3* day 31)');
    for (const x of zoned.rises) assert(x.crowd === 0, 'no crowd in an honest run: ' + x.star);
    assert(zoned.worstDiscrepancy === 0 && zoned.quarters.length >= 10, 'the books over ' + zoned.quarters.length + ' quarters');
    assert(zoned.refused.every((x) => /costs \$/.test(x.reason)), 'the player never walked into a refusal that was not about money: '
      + JSON.stringify(zoned.refused.filter((x) => !/costs \$/.test(x.reason)).slice(0, 2)));

    // One lift, never touched: it reaches the same number on the one tick the offices are all new,
    // and then loses almost everyone. The star is not the difference; the tenants and the cash are.
    const single = climbTrial({ days: 45, lifts: 'single' });
    const kept = (r) => r.perDay.slice(-9).reduce((n, row) => n + row.let, 0) / r.perDay.slice(-9).reduce((n, row) => n + row.offices, 0);
    assert(kept(zoned) > 0.8, 'zoned keeps its tenants: ' + kept(zoned).toFixed(2));
    assert(kept(single) < 0.5, 'one lift does not: ' + kept(single).toFixed(2));
    const money = (r) => r.perDay.slice(-9).reduce((n, row) => n + row.cash, 0) / 9;
    assert(money(zoned) > money(single) + 500_000, 'and it shows in the cash: ' + Math.round(money(zoned)) + ' against ' + Math.round(money(single)));
    assert(single.worstDiscrepancy === 0, 'the books, with a collapsing tower');
  },

  // ============================================================ the books, the seed, the script

  'the books add up in every quarter of the climb to the Tower'() {
    const r = quick('zoned');
    assert(r.quarters.length >= 6, 'quarters closed: ' + r.quarters.length);
    for (const q of r.quarters) assert(q.discrepancy === 0, 'quarter from day ' + q.startDay + ' is out by ' + q.discrepancy);
    assert(r.worstDiscrepancy === 0, 'the running quarter too');
  },

  'the same seed is the same climb, twice; another seed is another climb'() {
    const a = climbTrial({ ...QUICK, days: 14 });
    const b = climbTrial({ ...QUICK, days: 14 });
    assert(a.fingerprint === b.fingerprint, 'seed 1 twice: ' + a.fingerprint + ' vs ' + b.fingerprint);
    assert(JSON.stringify(a.rises.map((x) => [x.star, x.day, x.tick])) === JSON.stringify(b.rises.map((x) => [x.star, x.day, x.tick])), 'the same rises');
    assert(JSON.stringify(a.built) === JSON.stringify(b.built), 'the same things built, on the same days');
    const c = climbTrial({ ...QUICK, days: 14, seed: 2 });
    assert(c.fingerprint !== a.fingerprint, 'seed 2 should not be seed 1');
    assert(fingerprint({ a: 1 }) === fingerprint({ a: 1 }) && fingerprint({ a: 1 }) !== fingerprint({ a: 2 }), 'the fingerprint tells');
  },

  'the script writes no gate: its only direct write to the tower is the named crowd'() {
    for (const rel of ['../src/games/tower/policy/climb.js', '../harness/climb.js']) {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      const writes = [...code.matchAll(/\b(?:tower|world|ledger|gates)\??\.[\w.[\]'"?]*\s*(?:=(?!=)|\+=|-=|\+\+|--)/g)].map((m) => m[0].replace(/\s+/g, ' '));
      const allowed = writes.filter((w) => /populationLedger\.crowd\s*=$/.test(w));
      assert(allowed.length === writes.length, rel + ' writes into the tower: ' + writes.filter((w) => !allowed.includes(w)).join(', '));
      assert(!/\bgates\b[^\n]*=[^=]/.test(code.replace(/tower\.gates\?\.\[flag\]|\{ \.\.\.tower\.gates \}|tower\.gates\.weddingGuestsArrived|tower\.gates\?\.weddingGuestsArrived/g, '')),
        rel + ' touches a gate');
    }
    // ...and the crowd is a ledger bucket nothing in the sim reads by name but the totals.
    assert(/populationLedger\.crowd =/.test(read('../src/games/tower/policy/climb.js')), 'the crowd is where the doc says it is');
  },

  // ============================================================ the plan of the lot

  'the plan: zones, sky lobbies and shaft sites obey the sim\'s own separation rule'() {
    // Sky lobbies are the sim's: 14, 29, 44, ... and the spine's 89 is one.
    for (const z of [1, 2, 3, 4, ZONES]) assert(isSkyLobbyFloor(skyFloor(z)), 'zone ' + z + ' starts on a sky lobby: ' + skyFloor(z));
    assert(skyFloor(ZONES) === 89, 'the spine leaves from 89');
    for (let z = 0; z < ZONES; z++) {
      assert(zoneTop(z) - skyFloor(z) + 1 <= 31, 'zone ' + z + ' is a standard lift (31 floors at most)');
      assert(zoneTop(z) + 1 < skyFloor(z + 1) - 1, 'zone ' + z + ' and zone ' + (z + 1) + ' may share columns: their machine rooms do not meet');
      for (const f of zoneFloors(z)) assert(zoneOfFloor(f) === z, 'floor ' + f + ' belongs to zone ' + z);
    }
    // Every pair of planned sites that overlap in height stand 8 tiles apart (or are one site).
    const sites = plannedLiftSites('zoned');
    let pairs = 0;
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const a = sites[i], b = sites[j];
        if (a.hi < b.lo || b.hi < a.lo) continue;                    // not in the same floors
        if (a.left === b.left && a.right === b.right) continue;      // one column, used by zones one above another
        const gap = a.left > b.right ? a.left - b.right - 1 : b.left > a.right ? b.left - a.right - 1 : -1;
        assert(gap >= SHAFT_SEPARATION, 'sites ' + JSON.stringify(a) + ' and ' + JSON.stringify(b) + ' are only ' + gap + ' apart');
        pairs++;
      }
    }
    assert(pairs > 100, 'the check looked at ' + pairs + ' pairs');
    // The cap on lifts the script plans is the reference's.
    assert(ZONE_SHAFTS.reduce((a, b) => a + b, 0) + 1 + EXPRESS_COLUMNS.length + 1 <= MAX_CARRIERS, 'zone shafts + service + two expresses + the spine fit in ' + MAX_CARRIERS);
    // ...and the standard lifts stay left of column 80, where A84's distance penalty is nil.
    for (const c of SLOTS) assert(c + 3 < 80, 'column ' + c + ' is under the A84 penalty line');
    assert(SERVICE_COLUMN + 3 < SLOTS[0] - SHAFT_SEPARATION + 1, 'the service lift clears the first slot');
  },

  'the climb never walks into a refusal in the short run, and never builds past the reference\'s 24 lifts'() {
    const r = quick('zoned');
    assert(r.refused.length === 0, 'refusals in a run with money: ' + JSON.stringify(r.refused.slice(0, 3)));
    assert(r.world.tower.carriers.length <= MAX_CARRIERS, 'carriers: ' + r.world.tower.carriers.length);
  },
};
