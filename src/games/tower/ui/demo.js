/**
 * `?demo=climb` - watch the whole loop work (issue #19).
 *
 * The scripted player of `policy/climb.js` plays the game live in the page: the same player the
 * headless `node harness/playtest.js --climb` plays, through the same `applyAction`, on the same
 * scheduler. Nothing here decides anything about the game. This file reads the address, builds
 * the starting world, and says when the player has his morning and his evening; `ui/main.js` runs
 * the ticks and draws what happens.
 *
 *   /src/games/tower/index.html?demo=climb                the short climb: $40,000,000, 200 offices, the crowd.
 *                                                         One star to the Tower rank in about 17 game days.
 *   /src/games/tower/index.html?demo=climb&real=1         the honest climb: $2,000,000, no stand-in, every
 *                                                         person a real tenant. Four stars take ~117 days.
 *   ...&x=32                                              how many times faster than the speed buttons (default 16
 *                                                         short, 48 honest; the buttons still pause and slow it)
 *   ...&lifts=single | cars                               the players who ignore the lifts, to watch them lose
 *   ...&seed=2
 *
 * It never touches the saved tower: a demo is not saved, and its restart button leaves the demo
 * instead of throwing a saved game away.
 */
import { newTowerWorld } from './seed.js';
import { EVENING_TICK, MORNING_TICK, makeClimber } from '../policy/climb.js';
import { STARTING_CASH } from '../sim/economy.js';

/** The short climb's three named stand-ins (`harness/climb.js` `QUICK`, which has the one account of them). */
export const DEMO_QUICK = Object.freeze({ cash: 40_000_000, maxOffices: 200, crowd: true, crowdFrom: 3 });

const LIFTS = ['zoned', 'cars', 'single'];

const whole = (text, fallback, lo, hi) => {
  const n = Number(text);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

/**
 * What the address asks for, or `null` when it asks for nothing (the ordinary game).
 *
 * @param {string} search `location.search`
 */
export function parseDemo(search) {
  const q = new URLSearchParams(search ?? '');
  if (q.get('demo') !== 'climb') return null;
  const real = q.get('real') === '1';
  const lifts = LIFTS.includes(q.get('lifts')) ? q.get('lifts') : 'zoned';
  return {
    kind: 'climb',
    real,
    lifts,
    seed: whole(q.get('seed'), 1, 1, 1_000_000),
    // 12 ticks a second at 1x; 16x is a game day in 14 seconds, 48x in under 5.
    boost: whole(q.get('x'), real ? 48 : 16, 1, 96),
    cash: real ? STARTING_CASH : DEMO_QUICK.cash,
    options: real ? { crowd: false } : { crowd: true, crowdFrom: DEMO_QUICK.crowdFrom, maxOffices: DEMO_QUICK.maxOffices },
  };
}

/** What the page says it is doing, and what is not the sim's. */
export function demoBanner(spec) {
  const money = '$' + spec.cash.toLocaleString('en-US');
  const players = { zoned: 'zones the lifts', cars: 'adds cars but never zones', single: 'built one lift and never looked again' }[spec.lifts];
  return spec.real
    ? 'DEMO - a scripted player (' + players + ') on the honest climb: ' + money + ', no stand-in, every person a real tenant. '
      + 'Four stars take about 117 days; the bar shows what it is waiting for.'
    : 'DEMO - a scripted player (' + players + '), one star to the Tower. STAND-INS: ' + money + ' capital, up to ' + DEMO_QUICK.maxOffices
      + ' offices, and a crowd that makes up the population above the real tenants (the sim cannot host 15,000). Everything else is the sim.';
}

/**
 * The world and the player for a demo.
 *
 * @param {ReturnType<typeof parseDemo>} spec
 * @returns {{world:object, climber:object, boost:number, banner:string, afterTick:(tower:object)=>void}}
 */
export function makeDemo(spec) {
  const world = newTowerWorld({ seed: spec.seed, cash: spec.cash });
  const climber = makeClimber(world, { lifts: spec.lifts, ...spec.options });
  return {
    world,
    climber,
    boost: spec.boost,
    banner: demoBanner(spec),
    /** Called after every tick the scheduler runs: the player has a morning and an evening, as in the harness. */
    afterTick(tower) {
      const t = tower.clock.dayTick;
      if (t === MORNING_TICK) climber.morning();
      else if (t === EVENING_TICK) climber.evening();
    },
  };
}
