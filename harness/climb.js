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
import { noticesAfter } from '../src/games/tower/sim/demands.js';
import { financeStatement } from '../src/games/tower/sim/finance.js';
import { starClause } from '../src/games/tower/ui/readout.js';
import { countFamily, makeClimber } from '../src/games/tower/policy/climb.js';

export const TICKS_PER_DAY = 2600;
/** The player's morning: just after the day's first checkpoints, as `ladderTrial` keeps it. */
export const MORNING_TICK = 30;
/** ...and evening, just after 5 PM (daypart 4 begins at 1600), when the windows of `3 -> 4` and `4 -> 5` open. */
export const EVENING_TICK = 1700;

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
  carRatio = 5, maxOffices = Infinity, serviceLift = false, onDay = null,
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
    days: perDay.length, seed, lifts, skip, crowd, cash,
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

