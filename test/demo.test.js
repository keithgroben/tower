/**
 * `?demo=climb` (issue #19): the page that lets a person watch the scripted climb.
 *
 * `ui/demo.js` is pure (an address in, a world and a player out), so everything but the pixels is
 * tested here. The pixels - that the banner reads, that the speed buttons and the bar still work
 * while a scripted player builds - were looked at in a browser; this file holds the parts that can
 * be held: the address is read the way the README says, a demo never reaches the saved tower, and the
 * player in the page is the player in the harness, tick for tick.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_QUICK, demoBanner, makeDemo, parseDemo } from '../src/games/tower/ui/demo.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { QUICK, climbTrial } from '../harness/climb.js';
import { STARTING_CASH } from '../src/games/tower/sim/economy.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

export const tests = {
  'the address: nothing asks for nothing, and every option has the default the README gives'() {
    assert(parseDemo('') === null && parseDemo('?x=4') === null && parseDemo('?demo=other') === null, 'no demo unless asked');
    const short = parseDemo('?demo=climb');
    assert(short.kind === 'climb' && !short.real && short.lifts === 'zoned' && short.seed === 1, JSON.stringify(short));
    assert(short.cash === DEMO_QUICK.cash && short.options.crowd === true && short.options.maxOffices === 200 && short.boost === 16, 'the short climb: ' + JSON.stringify(short));
    const honest = parseDemo('?demo=climb&real=1');
    assert(honest.real && honest.cash === STARTING_CASH && honest.options.crowd === false && honest.boost === 48, 'the honest climb: ' + JSON.stringify(honest));
    const odd = parseDemo('?demo=climb&lifts=single&seed=7&x=32');
    assert(odd.lifts === 'single' && odd.seed === 7 && odd.boost === 32, JSON.stringify(odd));
  },

  'the address: junk falls back to the default instead of breaking the page'() {
    const junk = parseDemo('?demo=climb&lifts=sideways&seed=banana&x=0');
    assert(junk.lifts === 'zoned' && junk.seed === 1 && junk.boost === 16, JSON.stringify(junk));
    assert(parseDemo('?demo=climb&x=9999').boost === 16 && parseDemo('?demo=climb&seed=-3').seed === 1, 'out of range');
    assert(parseDemo('?demo=climb&x=96').boost === 96, 'the ceiling is allowed');
  },

  'the banner names the stand-ins of the short climb and claims none for the honest one'() {
    const short = demoBanner(parseDemo('?demo=climb'));
    assert(/STAND-INS/.test(short) && /\$40,000,000/.test(short) && /crowd/.test(short) && /200 offices/.test(short), short);
    const honest = demoBanner(parseDemo('?demo=climb&real=1'));
    assert(/no stand-in/.test(honest) && !/STAND-INS/.test(honest) && /\$2,000,000/.test(honest), honest);
    assert(/never looked again/.test(demoBanner(parseDemo('?demo=climb&lifts=single'))), 'it says which player this is');
  },

  'the player in the page is the player in the harness: ten days, the same things built on the same days'() {
    const spec = parseDemo('?demo=climb');
    const demo = makeDemo(spec);
    const { scheduler } = makeDriver(demo.world);
    for (let t = 0; t < 10 * 2600; t++) {
      scheduler.tick(demo.world.tower);
      demo.afterTick(demo.world.tower);
    }
    const harness = climbTrial({ ...QUICK, days: 10 });
    assert(demo.climber.built.length > 100, 'the demo player built: ' + demo.climber.built.length);
    assert(JSON.stringify(demo.climber.built) === JSON.stringify(harness.built), 'the page and the harness build the same things on the same days');
    assert(demo.world.tower.starCount === harness.finalStar, 'and reach the same star: ' + demo.world.tower.starCount + ' vs ' + harness.finalStar);
    assert(demo.world.ledger.cash === harness.perDay.at(-1).cash, 'to the dollar');
  },

  'main.js: a demo is never saved, never reads the saved tower, and its restart button does not discard one'() {
    const src = read('../src/games/tower/ui/main.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    assert(/const resumed = demo \? \{ world: null, note: null \} : await loadSavedWorld\(\)/.test(src), 'a demo does not read the saved tower');
    assert(/const autosave = demo\s*\?\s*\{ save: \(\) => \{\}, tick: \(\) => \{\} \}/.test(src), 'a demo does not write one');
    const restart = src.slice(src.indexOf('function wireRestart'));
    assert(restart.indexOf('if (demo)') > 0 && restart.indexOf('if (demo)') < restart.indexOf('discardSavedWorld'),
      'the demo branch of the restart button returns before it can discard a saved tower');
    assert(/demo\.afterTick\(tower\)/.test(src) && /gate\.speed \* boost/.test(src), 'the ticks carry the player and the boost');
    assert(/id="demo"/.test(read('../src/games/tower/index.html')), 'the banner has somewhere to stand');
  },
};
