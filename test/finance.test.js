/**
 * The Finance window (issue #18): income and upkeep by source, per quarter, and it must ADD UP.
 *
 * A statement whose lines do not sum to the change in cash is an accounting hole, and this repo's
 * brief is full of those: the operating buckets alone leave out construction, a new film, a bomb's
 * ransom, a fire's helicopter and a basement's buried treasure (all of which move `tower.cash`
 * directly), so the window carries a line for each. The tests here run a REAL played tower - the
 * greedy builder through the driver's own composition - and check the window against the cash
 * itself, not against the ledgers it is built from.
 *
 * Spec: `specs/ECONOMY.md` § Ledgers, § Periodic Expenses; `specs/TIME.md` § 2533; the original's
 * `HELP.txt` § Finance Window and `STR 1007`.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import { CASH_CAP, EXPENSE_BUCKETS, INCOME_BUCKETS, OTHER_BUCKETS, addIncome } from '../src/games/tower/sim/economy.js';
import {
  INCOME_LINES, LEDGER_BUCKETS, OTHER_LINES, PRESENTED_BUCKETS, UPKEEP_LINES, financeStatement,
} from '../src/games/tower/sim/finance.js';
import { HELICOPTER_COST, BOMB_RANSOM, maybeFindTreasure, tryStartBomb, tryStartFire } from '../src/games/tower/sim/events.js';
import { ledgerFor } from '../src/games/tower/sim/ledger-adapter.js';
import { FAMILY, __resetIds, placeObject } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { newTowerWorld, seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { preview, toolById } from '../src/games/tower/ui/build.js';
import { financeWindowModel } from '../src/games/tower/ui/finance-window.js';
import { greedyBuilder } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const line = (statement, key) =>
  [...statement.income.lines, ...statement.upkeep.lines, ...statement.other.lines].find((l) => l.key === key);

/** Offices three to a floor, 46 tiles across: wide enough for the bomb (4) and the fire (32). */
function building(tower, floors) {
  for (let floor = 1; floor <= floors; floor++) {
    for (const left of [0, 20, 40]) {
      const placed = placeObject(tower, { family: FAMILY.office, floor, left, right: left + 5 }, () => createSimTripRecord());
      assert(placed.ok, 'fixture: ' + placed.reason);
    }
  }
}

export const tests = {
  // ============================================================ the shape

  'every bucket the ledger keeps has a line in the window, and none is shown twice'() {
    for (const [group, buckets] of Object.entries(LEDGER_BUCKETS)) {
      const shown = PRESENTED_BUCKETS[group];
      for (const b of buckets) assert(shown.includes(b), group + ' bucket "' + b + '" has no line - its money would vanish from the window');
      assert(new Set(shown).size === shown.length, group + ': a bucket is on two lines');
      assert(shown.length === buckets.length, group + ': the window lists a bucket the ledger does not keep');
    }
    assert(INCOME_BUCKETS.length === 10 && EXPENSE_BUCKETS.length === 11 && OTHER_BUCKETS.length === 8, 'the ledgers are the sizes this file was written against');
  },

  'the income captions are the original\'s own (STR 1007)'() {
    const labels = INCOME_LINES.map((l) => l.label);
    const original = [
      'Income from Office', 'Income from Hotel', 'Income from Condo sale', 'Income from Restaurant',
      'Income from Fast Food', 'Income from Retail Shop', 'Income from Movie Theater', 'Income from Party Hall',
    ];
    assert(JSON.stringify(labels) === JSON.stringify(original), 'captions: ' + JSON.stringify(labels));
    assert(UPKEEP_LINES.length === 11 && OTHER_LINES.length === 8, 'upkeep and other lines');
  },

  // ======================================================= it adds up

  'a played tower: the lines sum to the change in cash at every instant, across rollovers'() {
    const world = seedDemoWorld({ seed: 1 });
    const { tower } = world;
    const { scheduler } = makeDriver(world);
    const act = greedyBuilder(world);
    let checks = 0;
    let rollovers = 0;
    let lastBase = tower.cycleBaseCash;
    let sawConstruction = false, sawIncome = false, sawUpkeep = false;

    for (let day = 0; day < 20; day++) {
      for (let t = 0; t < 2600; t++) {
        scheduler.tick(tower);
        if (t % 25 !== 0 && tower.cycleBaseCash === lastBase) continue;
        if (tower.cycleBaseCash !== lastBase) { rollovers++; lastBase = tower.cycleBaseCash; }
        const s = financeStatement(tower);
        const sum = s.income.total - s.upkeep.total + s.other.total;
        // The window against the CASH ITSELF, not against the buckets it was built from.
        assert(tower.cash - tower.cycleBaseCash === sum,
          `day ${day} t${t}: cash moved ${tower.cash - tower.cycleBaseCash} since the quarter began, the window says ${sum}`);
        assert(s.discrepancy === 0, 'discrepancy ' + s.discrepancy);
        if (line(s, 'construction').amount < 0) sawConstruction = true;
        if (s.income.total !== 0) sawIncome = true;
        if (s.upkeep.total !== 0) sawUpkeep = true;
        checks++;
      }
      for (let i = 0; i < 8; i++) if (!act()) break;
    }
    assert(checks > 500 && rollovers >= 5, `the fixture must cross several quarters (checks ${checks}, rollovers ${rollovers})`);
    assert(sawConstruction && sawIncome && sawUpkeep, 'and exercise construction, income and upkeep');

    // Nothing fell into the catch-all lines: a bucket nobody declared would be a typo hidden in the sum.
    const s = financeStatement(tower);
    assert(line(s, 'unclassifiedIncome').amount === 0 && line(s, 'unclassifiedExpense').amount === 0, 'nothing unclassified');

    // The quarter that just ended is kept whole and adds up on its own.
    const prev = financeStatement(tower, 'previous');
    assert(prev && prev.discrepancy === 0, 'last quarter reconciles');
    assert(prev.closingCash === tower.cycleBaseCash, 'last quarter closed with the cash this one opened on');
    assert(prev.startDay % 3 === 0 && s.startDay === prev.startDay + 3, 'quarters are three days, back to back');
  },

  'the window\'s total for a played quarter equals what the rollover recorded as the cash delta'() {
    const world = seedDemoWorld({ seed: 2 });
    const { tower } = world;
    const { scheduler } = makeDriver(world);
    const act = greedyBuilder(world);
    let reported = 0;
    for (let day = 0; day < 9; day++) {
      for (let t = 0; t < 2600; t++) {
        const before = tower.cycleBaseCash;
        scheduler.tick(tower);
        if (tower.cycleBaseCash !== before) {
          // The tick that rolled the books: the quarter that just ended is now `previous`.
          const prev = financeStatement(tower, 'previous');
          assert(prev.closingCash - prev.openingCash === prev.net, 'quarter net ' + prev.net + ' vs cash ' + (prev.closingCash - prev.openingCash));
          reported++;
        }
      }
      for (let i = 0; i < 8; i++) if (!act()) break;
    }
    assert(reported >= 2, 'at least two quarters ended');
  },

  // ========================================== money that moves outside the buckets

  'a bomb\'s ransom has a line, and the window still adds up'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    building(tower, 6);
    tower.clock.dayCounter = 59; tower.clock.dayTick = 240; tower.clock.daypart = 0;
    assert(tryStartBomb(tower), 'the bomb is planted');
    const ransom = BOMB_RANSOM[3];
    const before = financeStatement(tower);
    assert(line(before, 'ransom').amount === 0, 'nothing paid yet');
    assert(applyAction(world, { type: 'answer_event', answer: 'pay' }).ok, 'paid');
    const after = financeStatement(tower);
    assert(line(after, 'ransom').amount === -ransom, 'the ransom is a line of -$' + ransom + ': ' + line(after, 'ransom').amount);
    assert(after.discrepancy === 0, 'and the window adds up (' + after.discrepancy + ')');
    assert(after.net === before.net - ransom, 'the net fell by exactly the ransom');
  },

  'a fire crew\'s helicopter has a line, and the window still adds up'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    building(tower, 6);
    tower.clock.dayCounter = 83; tower.clock.dayTick = 240; tower.clock.daypart = 0;
    assert(tryStartFire(tower), 'the fire starts');
    assert(applyAction(world, { type: 'answer_event', answer: 'helicopter' }).ok, 'the crew is called');
    const s = financeStatement(tower);
    assert(line(s, 'helicopter').amount === -HELICOPTER_COST, 'a line of -$500,000: ' + line(s, 'helicopter').amount);
    assert(s.discrepancy === 0, 'adds up (' + s.discrepancy + ')');
  },

  'buried treasure has a line, and the window still adds up'() {
    let found = null;
    for (let seed = 1; seed < 60 && !found; seed++) {
      __resetIds();
      const world = newTowerWorld({ seed, cash: 5_000_000 });
      const treasure = maybeFindTreasure(world.tower, -1);
      if (treasure) found = { world, treasure };
    }
    assert(found, 'some seed strikes treasure on the first basement floor');
    const s = financeStatement(found.world.tower);
    assert(line(s, 'treasure').amount === found.treasure.amount && found.treasure.amount > 0, 'a positive line of $' + found.treasure.amount);
    assert(s.discrepancy === 0, 'adds up (' + s.discrepancy + ')');
  },

  'a new film has a line (the theater window\'s purchase), and construction books through the seam'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 9_000_000 });
    const { tower } = world;
    tower.starCount = 4;
    const built = applyAction(world, { type: 'build', what: 'theater', floor: 3, left: 10 });
    assert(built.ok, 'a theater: ' + built.reason);
    let s = financeStatement(tower);
    assert(line(s, 'construction').amount === -built.cost, 'the theater is a construction line of -' + built.cost + ', saw ' + line(s, 'construction').amount);
    const film = applyAction(world, { type: 'set_theater_film', objectId: built.object.id, pool: 'classic' });
    assert(film.ok, 'a classic film: ' + film.reason);
    s = financeStatement(tower);
    assert(line(s, 'films').amount === -film.cost && film.cost > 0, 'the film is its own line: ' + line(s, 'films').amount);
    assert(line(s, 'construction').amount === -built.cost, 'and is not construction');
    assert(s.discrepancy === 0, 'adds up (' + s.discrepancy + ')');
  },

  'a build the world then refuses is refunded out of the construction line as well as the cash'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 9_000_000 });
    const { tower } = world;
    assert(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top: 6, column: 40 }).ok, 'a shaft');
    const carrier = tower.carriers[0];
    let guard = 0;
    while (applyAction(world, { type: 'add_car', carrierId: carrier.id }).ok && guard++ < 40) { /* fill it */ }
    const cash = tower.cash;
    const books = financeStatement(tower);
    const refused = applyAction(world, { type: 'add_car', carrierId: carrier.id });
    assert(!refused.ok && /full/.test(refused.reason), 'the full shaft refuses: ' + refused.reason);
    assert(tower.cash === cash, 'the cash came back');
    assert(line(financeStatement(tower), 'construction').amount === line(books, 'construction').amount,
      'and so did the line - a refund that only moved the cash would leave the window short');
    assert(financeStatement(tower).discrepancy === 0, 'adds up');
  },

  'the build ghost\'s affordability check books nothing'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 9_000_000 });
    const { tower } = world;
    const before = JSON.stringify(tower.otherLedger);
    const guess = preview(world, toolById('office'), { floor: 2, tile: 20, object: null, link: null, carrier: null, columnCarrier: null });
    assert(guess.ok, 'the ghost said yes: ' + guess.reason);
    assert(JSON.stringify(tower.otherLedger) === before, 'a ghost must not spend: ' + JSON.stringify(tower.otherLedger));
    assert(tower.cash === 9_000_000, 'nor move the cash');
  },

  'income the $99,999,999 cap refuses is a line, not a hole'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    tower.cash = CASH_CAP - 3_000;
    tower.cycleBaseCash = tower.cash;
    const ledger = ledgerFor(tower);
    addIncome(ledger, 'office', 10_000);
    const s = financeStatement(tower);
    assert(tower.cash === CASH_CAP, 'clamped');
    assert(line(s, 'capLost').amount === -7_000, 'the 7,000 the cap refused: ' + line(s, 'capLost').amount);
    assert(s.income.total === 10_000 && s.discrepancy === 0, 'income is what was earned; the sum still closes (' + s.discrepancy + ')');
  },

  'a movement into a bucket nobody declared is shown, not swallowed'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 1_000_000 });
    const { tower } = world;
    const ledger = ledgerFor(tower);
    addIncome(ledger, 'noSuchBucket', 500);
    const s = financeStatement(tower);
    assert(line(s, 'unclassifiedIncome').amount === 500 && s.discrepancy === 0, 'a visible line: ' + line(s, 'unclassifiedIncome').amount);
  },

  // ============================================================ the window

  'the window reads upkeep as money out, hides empty lines, and says when it does not add up'() {
    const world = seedDemoWorld({ seed: 1 });
    const { tower } = world;
    const { scheduler } = makeDriver(world);
    for (let t = 0; t < 2600 * 4; t++) scheduler.tick(tower);
    const model = financeWindowModel(world, 'current');
    const income = model.sections.find((s) => s.title === 'Income');
    const upkeep = model.sections.find((s) => s.title === 'Upkeep');
    assert(upkeep.rows.length > 0 && upkeep.rows.every((r) => r.amount < 0 && r.text.startsWith('-$')), 'upkeep rows are negative: ' + JSON.stringify(upkeep.rows));
    assert(income.rows.every((r) => r.amount !== 0), 'a zero line is not shown');
    assert(model.reconciles === true && model.discrepancy === 0, 'and it adds up');
    assert(model.tabs.find((t) => t.id === 'previous').enabled, 'a quarter has ended, so last quarter is there');
    const last = financeWindowModel(world, 'previous');
    assert(last.which === 'previous' && !last.title.endsWith('so far'), 'last quarter is a whole one');

    // A sabotaged book: take a dollar off a bucket without moving the cash.
    tower.incomeLedger.office += 1;
    const broken = financeWindowModel(world, 'current');
    assert(broken.reconciles === false && broken.discrepancy === -1, 'the window says so rather than looking fine: ' + broken.discrepancy);
  },

  'a fresh tower has no last quarter yet'() {
    const world = newTowerWorld({ seed: 1 });
    assert(financeStatement(world.tower, 'previous') === null, 'nothing before the first rollover');
    const model = financeWindowModel(world, 'previous');
    assert(model.which === 'current', 'asking for it falls back to this quarter');
    assert(model.tabs.find((t) => t.id === 'previous').enabled === false, 'and the tab is dead');
  },

  'the books survive a save: the window reads the same after load'() {
    const world = seedDemoWorld({ seed: 3 });
    const { tower } = world;
    const { scheduler } = makeDriver(world);
    const act = greedyBuilder(world);
    for (let day = 0; day < 8; day++) {
      for (let t = 0; t < 2600; t++) scheduler.tick(tower);
      for (let i = 0; i < 8; i++) if (!act()) break;
    }
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    assert(blob.version === SAVE_VERSION && SAVE_VERSION === 12, 'save v12');
    const back = restore(blob);
    assert(back.ok, back.reason);
    for (const which of ['current', 'previous']) {
      const a = JSON.stringify(financeStatement(tower, which));
      const b = JSON.stringify(financeStatement(back.world.tower, which));
      assert(a === b, which + ' quarter changed across a save: ' + a.slice(0, 120) + ' vs ' + b.slice(0, 120));
    }
    // ...and the restored tower goes on adding up.
    const { scheduler: again } = makeDriver(back.world);
    for (let t = 0; t < 2600 * 2; t++) {
      again.tick(back.world.tower);
      if (t % 100 === 0) assert(financeStatement(back.world.tower).discrepancy === 0, 'adds up after load');
    }
  },
};
