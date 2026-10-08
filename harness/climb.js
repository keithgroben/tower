/**
 * The full climb (issue #19): one scripted player, a bare lot and $2,000,000, one star to the Tower.
 *
 * `node harness/playtest.js --climb [days]`   (or `npm run climb`)
 *
 * The player itself - what it reads and what it builds - is `src/games/tower/policy/climb.js`, the same
 * file the browser plays live at `?demo=climb`. This file plays it for N days through the driver's own
 * composition and writes down what happened: which star on which day, how much of the population was
 * real, whether the books added up every quarter.
 *
 * ## The stand-ins, named so nobody mistakes them for the sim
 *
 *   - **`crowd`** (optional): a population ledger bucket the script tops up, from `crowdFrom` stars, to
 *     the next rung's threshold. The honest finding of this file is that the sim cannot host 15,000
 *     people: the lifts hold about six offices a car and `MAX_CARRIERS` is 24, so an office tower tops
 *     out near 5,100 people (measured, `npm run climb`), and above ~1,000 drivers the parking demand can
 *     never be answered either. Where the real tenants fall short the crowd makes up the difference
 *     and every rise reports how much of its population was real.
 *   - **`cash`**: the capital. $2,000,000 is the game's own start; the short CI horizon grants more and
 *     says so. Nothing else is granted.
 *   - **`maxOffices`**: not a stand-in but the player's ambition: the short runs stop at 200 offices.
 *
 * Nothing in `tower.gates` is written by the script. `spec/DEVIATIONS.md` A88-A92.
 */
import { FAMILY, isUnitLet } from '../src/games/tower/sim/state.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { STARTING_CASH } from '../src/games/tower/sim/economy.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { BUILDABLE } from '../src/games/tower/sim/actions.js';
import { WEDDING_GUESTS, starGateStatus, starPopulation } from '../src/games/tower/sim/progression.js';
import { activeDemands, noticesAfter } from '../src/games/tower/sim/demands.js';
import { financeStatement } from '../src/games/tower/sim/finance.js';
import { starClause } from '../src/games/tower/ui/readout.js';
import { EVENING_TICK, MORNING_TICK, countFamily, makeClimber } from '../src/games/tower/policy/climb.js';

export const TICKS_PER_DAY = 2600;
export { EVENING_TICK, MORNING_TICK };

/** djb2 over the JSON of a value: a fingerprint for "run it twice, get the same thing". */
export function fingerprint(value) {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------

/**
 * Play `days` days. Returns the numbers; the CLI prints them and `test/climb.test.js` asserts on
 * the same function, so the harness and the test cannot disagree about what was run.
 *
 * @param {object} [options]
 * @param {number} [options.days]
 * @param {number} [options.seed]
 * @param {number} [options.cash] the capital; the game's own start is $2,000,000
 * @param {'zoned'|'cars'|'single'} [options.lifts]
 * @param {string[]} [options.skip]
 * @param {boolean} [options.crowd]
 * @param {number|null} [options.stopAtStar] stop the first morning the tower reaches this star
 */
export function climbTrial({
  days = 40, seed = 1, cash = STARTING_CASH, lifts = 'zoned', skip = [], crowd = false, crowdFrom = 3, stopAtStar = null,
  carRatio = 7, maxOffices = Infinity, serviceLift = false, onDay = null,
} = {}) {
  const world = newTowerWorld({ seed, cash });
  const { tower } = world;
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);
  const climber = makeClimber(world, { lifts, skip, crowd, crowdFrom, carRatio, maxOffices, serviceLift });

  const perDay = [];
  const rises = [];
  const quarters = [];
  const gatesOn = {};
  let seenRise = 0;
  let weddingTick = null;
  let peakReal = 0;
  let peakStar = tower.starCount;
  let lastQuarter = null;
  let worstDiscrepancy = 0;
  let dayStopped = null;

  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      // What the tower looked like the tick BEFORE: a rise resets the office-service flag and the
      // wedding count, so the evidence that a star came through its gate has to be taken first.
      const starBefore = tower.starCount;
      const before = {
        gates: { ...tower.gates }, ledger: { ...tower.populationLedger }, dayTick: tower.clock.dayTick,
        daypart: tower.clock.daypart, calendarPhase: tower.clock.calendarPhase,
        demands: starBefore === 4 ? activeDemands(tower).length : 0,
      };
      scheduler.tick(tower);
      const { dayTick } = tower.clock;
      if (dayTick === MORNING_TICK) climber.morning();
      if (dayTick === EVENING_TICK) climber.evening();
      for (const flag of ['securityPlaced', 'suitePlaced', 'officeServiceOk', 'vipStayFavorable', 'metroPlaced', 'cathedralPlaced']) {
        if (tower.gates?.[flag] && !(flag in gatesOn)) gatesOn[flag] = tower.clock.dayCounter;
      }
      if ((tower.gates?.weddingGuestsArrived ?? 0) >= WEDDING_GUESTS && !('weddingGuestsArrived' in gatesOn)) {
        gatesOn.weddingGuestsArrived = tower.clock.dayCounter;
        weddingTick = dayTick;
      }
      for (const n of noticesAfter(tower, seenRise)) {
        seenRise = n.id;
        if (n.kind === 'starRise') {
          const real = climber.realPopulation();
          rises.push({
            star: tower.starCount, day: n.day, tick: n.tick, text: n.text,
            population: starPopulation(tower), real, crowd: tower.populationLedger.crowd ?? 0,
            // ...and the tick before it, for the test that no star came without its gate.
            // The head-count is read at the rise, by the rung's own rules (hotel guests stop counting at 3
            // stars, so it is the count FOR the star being left): it cannot fall in the tick that raises it.
            activity: starPopulation(tower, starBefore),
            before: { ...before, starBefore },
            // ...and as the rise left it: a flag the same tick wrote (recycling at 2000, the fortieth
            // guest) is on this side, and the clock the gate read is this one.
            after: {
              gates: { ...tower.gates }, dayTick: tower.clock.dayTick, daypart: tower.clock.daypart,
              calendarPhase: tower.clock.calendarPhase, demands: activeDemands(tower).length,
            },
          });
        }
      }
      if (tower.starCount > peakStar) peakStar = tower.starCount;
      if (dayTick % 130 === 0) peakReal = Math.max(peakReal, climber.realPopulation());
    }
    // The books, every day: the quarter's statement must add up to the change in cash.
    for (const which of ['current', 'previous']) {
      const s = financeStatement(tower, which);
      if (!s) continue;
      worstDiscrepancy = Math.max(worstDiscrepancy, Math.abs(s.discrepancy));
      if (which === 'previous' && (!lastQuarter || lastQuarter.startDay !== s.startDay)) {
        quarters.push({ startDay: s.startDay, year: s.year, quarter: s.quarter, opening: s.openingCash, closing: s.closingCash, net: s.net, discrepancy: s.discrepancy });
        lastQuarter = s;
      }
    }
    const status = starGateStatus(tower);
    const row = {
      day: tower.clock.dayCounter, star: tower.starCount, population: status.activity, real: climber.realPopulation(),
      cash: ledgerCash(world), offices: countFamily(tower, FAMILY.office),
      let: countLet(tower), carriers: tower.carriers.length,
      cars: tower.carriers.reduce((n, c) => n + c.cars.length, 0),
      hud: starClause(status, (kind) => Object.hasOwn(BUILDABLE, kind)),
    };
    perDay.push(row);
    if (onDay) onDay(row, world);
    if (stopAtStar !== null && tower.starCount >= stopAtStar) { dayStopped = row.day; break; }
  }

  const last = perDay[perDay.length - 1];
  const starDay = {};
  for (const r of rises) starDay[r.star] = r.day;
  return {
    days: perDay.length, seed, lifts, skip, crowd, crowdFrom, cash, maxOffices,
    finalStar: last.star, starDay, rises, perDay, quarters, worstDiscrepancy,
    built: climber.built, refused: climber.refused, gatesOn, weddingTick,
    peakReal, peakPopulation: Math.max(...perDay.map((r) => r.population)),
    world, climber, dayStopped,
    fingerprint: fingerprint({
      stars: perDay.map((r) => [r.star, r.population, r.cash, r.offices, r.cars]), rises: rises.map((r) => [r.star, r.day, r.tick]),
      built: climber.built.length, refused: climber.refused.length,
    }),
  };
}

const ledgerCash = (world) => world.ledger.cash;
const countLet = (tower) => { let n = 0; for (const o of tower.objects.values()) if (o.family === FAMILY.office && isUnitLet(o)) n++; return n; };


// ---------------------------------------------------------------------------
// The two ways to run it, and how a run is told.

/**
 * **The short run** - the CI horizon, the `?demo=climb` page, `--climb --quick`. Three things are
 * granted, and the report says each one out loud: capital ($40,000,000, because a real tower earns
 * the cost of the cathedral over months), the crowd (the population the sim cannot host), and an
 * ambition of 200 offices (so the run is a minute of play and not an hour).
 */
export const QUICK = Object.freeze({ cash: 40_000_000, maxOffices: 200, crowd: true, crowdFrom: 3, days: 24 });

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

/** What a run is standing in for, in the words the report opens with. */
export function standInsOf(r) {
  const lines = [];
  lines.push(r.cash === STARTING_CASH
    ? 'capital: the game\'s own ' + money(STARTING_CASH) + ' - NOT a stand-in'
    : 'STAND-IN capital: ' + money(r.cash) + ' instead of ' + money(STARTING_CASH));
  lines.push(r.crowd
    ? 'STAND-IN crowd: the population above the real tenants, from ' + r.crowdFrom + ' stars, up to each rung\'s threshold'
    : 'no crowd: every person counted is a real tenant');
  if (Number.isFinite(r.maxOffices)) lines.push('ambition: stops at ' + r.maxOffices + ' offices');
  return lines;
}

/**
 * The run as lines of text: the stand-ins first, a row per day (or every `every`th), then each star
 * with how much of its population was real, then the books.
 */
export function describeClimb(r, { every = 1 } = {}) {
  const out = [];
  out.push('climb: a scripted player reads the bar and builds only through applyAction. lifts policy: ' + r.lifts
    + ', seed ' + r.seed + ', ' + r.days + ' days.');
  for (const line of standInsOf(r)) out.push('  ' + line);
  out.push('  no gate flag is written by the script (the sim opened: ' + JSON.stringify(r.gatesOn) + ')');
  out.push('');
  out.push('day  star  population  (real)  offices   let  cars/lifts          cash  the bar says');
  for (const row of r.perDay) {
    if (row.day % every !== 0 && row !== r.perDay.at(-1)) continue;
    out.push(String(row.day).padStart(3) + String(row.star).padStart(6) + String(row.population).padStart(12)
      + String(row.real).padStart(8) + String(row.offices).padStart(9) + String(row.let).padStart(6)
      + (row.cars + '/' + row.carriers).padStart(10) + money(row.cash).padStart(14) + '  ' + row.hud.slice(0, 110));
  }
  out.push('');
  out.push('STARS');
  for (const x of r.rises) {
    out.push('  ' + (x.star >= 6 ? 'Tower rank' : x.star + ' stars').padEnd(11) + ' day ' + String(x.day).padStart(3) + ' tick ' + String(x.tick).padStart(4)
      + '   population ' + String(x.population).padStart(6) + ' = ' + String(x.real).padStart(6) + ' real + ' + String(x.crowd).padStart(6) + ' crowd'
      + (x.crowd > 0 ? '   <- stand-in' : '   <- all real tenants'));
  }
  out.push('  final: ' + (r.finalStar >= 6 ? 'the Tower rank' : r.finalStar + ' stars') + ' after ' + r.days + ' days; left to do: '
    + (starGateStatus(r.world.tower).blockers.join('; ') || 'nothing'));
  out.push('  peak REAL population (tenants, no crowd): ' + r.peakReal + ' of the 15,000 the Tower rank asks for');
  out.push('');
  out.push('BOOKS  ' + r.quarters.length + ' quarters closed; the largest difference between the change in cash and the statement\'s lines: '
    + money(r.worstDiscrepancy));
  const built = {};
  for (const b of r.built) built[b.what] = (built[b.what] ?? 0) + 1;
  out.push('BUILT  ' + Object.entries(built).map(([k, n]) => n + ' ' + k).join(', '));
  out.push('FINGERPRINT ' + r.fingerprint + '  (run it twice: it is the same)');
  return out;
}
