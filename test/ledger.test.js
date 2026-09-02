/**
 * The bridge between the tower and the money.
 *
 * `test/economy.test.js` proves the rules against the reference. This file
 * proves the *translation*: that the economy's `operational` is the tower's
 * lease, that its `cash` is the tower's own field and not a copy of it, and that
 * a write made through a unit view lands on the object the tower keeps.
 *
 * Every assertion here is behavioural. Nothing checks that a field is spelled a
 * particular way, because the whole class of bug this file exists to stop —
 * `routeStartTick` against `lastTripTick`, two names for one quantity — passes
 * any test that agrees with the same misspelling.
 */
import { CARRIER_MODE, addCar, createCarrier } from '../src/games/tower/sim/elevators.js';
import { FAMILY, createTower, placeObject } from '../src/games/tower/sim/state.js';
import {
  PAYOUT_FAMILY, cashflowUnitFor, chargeableCarriers, chargeableItems, chargeableLinks,
  ledgerFor, officeCashflowHooks, runTowerLedgerCheckpoint,
} from '../src/games/tower/sim/ledger-adapter.js';
import { EXPENSE_BUCKETS, INCOME_BUCKETS, addIncome } from '../src/games/tower/sim/economy.js';
import { createSimTripRecord, recordNoRouteFailure } from '../src/games/tower/sim/stress.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * A tower with `count` offices on floor 3, let and paying.
 *
 * `createSimTripRecord` is not optional decoration: an actor with no trip
 * record scores as having failed rather than as unmeasured, so a fixture that
 * skips it builds offices the very first sweep evicts. `sim/seed.js` and
 * `sim/actions.js` both pass it, which is why the real game never sees this.
 */
function towerWithOffices(count = 1) {
  const tower = createTower({ seed: 1 });
  tower.segments = [];
  for (let i = 0; i < count; i++) {
    const { object } = placeObject(tower, {
      family: FAMILY.office, floor: 3, left: i * 8, right: i * 8 + 5,
    }, () => createSimTripRecord());
    // What `sim/office.js` writes when a worker's route resolves.
    object.unitStatus = 0;
    object.occupiedFlag = true;
    object.everRented = true;
    object.evalLevel = 2;
  }
  return tower;
}

const officesOf = (tower) => [...tower.objects.values()].filter((o) => o.family === FAMILY.office);

export const tests = {
  // ------------------------------------------------------------ the ledger

  'the ledger is a view of the tower, not a copy of it'() {
    const tower = createTower({ seed: 1 });
    const ledger = ledgerFor(tower);

    ledger.cash -= 250_000;
    assert(tower.cash === 1_750_000,
      'a write through the ledger left `tower.cash` at $' + tower.cash + ' — they are separate '
      + 'objects, and whichever one the HUD reads is the one nothing charges');

    tower.cash += 100_000;
    assert(ledger.cash === 1_850_000, 'a write to the tower did not reach the ledger view');

    // Two views must also be the same storage, so it does not matter who made one.
    const second = ledgerFor(tower);
    second.cash = 42;
    assert(ledger.cash === 42 && tower.cash === 42, 'two ledger views hold two balances');
  },

  'the cycle base is the tower’s own, so a saved game reloads mid-cycle'() {
    const tower = createTower({ seed: 1 });
    const ledger = ledgerFor(tower);
    ledger.cashCycleBase = 1_234_567;
    assert(tower.cycleBaseCash === 1_234_567,
      'the cycle base landed somewhere the tower does not persist');
  },

  /**
   * `economy.js` records into a bucket only when the key already exists — a
   * guard against a typo'd bucket name silently opening a new one. A tower
   * whose ledgers start as `{}` would therefore swallow every dollar, and cash
   * would move while the income statement stayed empty.
   */
  'the buckets are seeded, or every dollar recorded goes nowhere'() {
    const tower = createTower({ seed: 1 });
    const ledger = ledgerFor(tower);

    for (const bucket of INCOME_BUCKETS) {
      assert(ledger.income[bucket] === 0, 'income bucket ' + bucket + ' is missing');
    }
    for (const bucket of EXPENSE_BUCKETS) {
      assert(ledger.expense[bucket] === 0, 'expense bucket ' + bucket + ' is missing');
    }

    addIncome(ledger, 'office', 10_000);
    assert(tower.incomeLedger.office === 10_000,
      'income was credited to cash but recorded nowhere the tower can read');
  },

  'seeding is idempotent, so a second view does not wipe the first’s totals'() {
    const tower = createTower({ seed: 1 });
    addIncome(ledgerFor(tower), 'office', 10_000);
    const again = ledgerFor(tower);
    assert(again.income.office === 10_000, 'a second ledger view reset the income ledger to zero');
  },

  // ------------------------------------------------------------- the units

  'a write through a unit view lands on the object the tower keeps'() {
    // The once-per-cycle guard and the activation age are written BY the
    // economy THROUGH the view. If the view were a copy, the guard would reset
    // every pass and every office would be paid twice a cycle.
    const tower = towerWithOffices(1);
    const [object] = officesOf(tower);
    const unit = cashflowUnitFor(object);

    unit.cycleMark = 7;
    unit.activationTicks = 3;
    unit.rentTier = 0;
    assert(object.cashflowCycleMark === 7, 'the cycle guard was written to a temporary');
    assert(object.activationTickCount === 3, 'the activation age was written to a temporary');
    assert(object.rentLevel === 0, 'the rent tier was written to a temporary');
  },

  /**
   * The one that cost a run. `occupied_flag` means "this facility's tenants are
   * being measured", not "let" — `sim/office.js` says so in its own header —
   * and the daily recompute turns it back on for a *vacated* office, because an
   * office with no trips scores 0, which is the best grade there is.
   */
  'operational is the lease, not the measured flag'() {
    const tower = towerWithOffices(1);
    const [object] = officesOf(tower);
    const unit = cashflowUnitFor(object);
    assert(unit.operational, 'a let, measured office does not read as operational');

    // Exactly the state a vacated office is left in by the next day's recompute:
    // out of the lease band, but measured again and scoring perfectly.
    object.unitStatus = 0x18;
    object.occupiedFlag = true;
    object.evalLevel = 2;
    assert(!unit.operational,
      'a vacated office reads as operational because its flag came back on. It will be paid rent '
      + 'for an empty room every third day for the rest of the game.');

    // The other half, and it is the reference's own condition:
    // `activate_family_cashflow_if_operational` skips a unit whose measured
    // flag has been cleared, even one still inside the lease band. Nothing in
    // this build clears the flag mid-lease yet — the mid-day
    // `refresh_occupied_flag_and_trip_counters` sweep is unwritten — so this is
    // pinned before the path that needs it exists rather than after.
    object.unitStatus = 0;
    object.occupiedFlag = false;
    assert(!unit.operational,
      'a let office whose measured flag was cleared still reads as operational — the lease alone '
      + 'is not the reference\'s condition');
  },

  'an office that never rented is not a unit anything pays'() {
    const tower = createTower({ seed: 1 });
    placeObject(tower, { family: FAMILY.office, floor: 9, left: 0, right: 5 });
    const [object] = officesOf(tower);
    const unit = cashflowUnitFor(object);
    assert(!unit.everRented, 'a freshly placed office claims to have rented before');
    assert(!unit.operational, 'a freshly placed office is already operational');
  },

  'only priced families become paying units'() {
    assert(PAYOUT_FAMILY[FAMILY.office] === 'office', 'family 7 does not map to office rent');
    assert(PAYOUT_FAMILY[FAMILY.lobby] === undefined, 'the lobby has been given a rent row');
  },

  // ------------------------------------------------------- what is charged

  'carriers are offered per car, in the mode the expense table prices'() {
    const tower = createTower({ seed: 1 });
    const carrier = createCarrier({ id: 0, mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 5 });
    addCar(carrier); addCar(carrier);
    tower.carriers.push(carrier);

    const [charged] = chargeableCarriers(tower);
    assert(charged.mode === 'standard', 'carrier mode ' + CARRIER_MODE.STANDARD + ' mapped to ' + charged.mode);
    assert(charged.cars === 2, 'a two-car shaft reported ' + charged.cars + ' cars');
  },

  'the express and service modes map to their own rates, not the standard one'() {
    const tower = createTower({ seed: 1 });
    for (const mode of [CARRIER_MODE.EXPRESS, CARRIER_MODE.SERVICE]) {
      const carrier = createCarrier({ id: mode, mode, bottomFloor: 0, topFloor: 5 });
      addCar(carrier);
      tower.carriers.push(carrier);
    }
    const modes = chargeableCarriers(tower).map((c) => c.mode).sort();
    assert(JSON.stringify(modes) === JSON.stringify(['express', 'service']),
      'the carrier modes came out as ' + modes.join(',') + ' — an unmapped mode is a free lift');
  },

  /**
   * `sim/routing.js` packs `flags = ((floorsSpanned - 1) << 1) | stairsBit`,
   * which is the reference's `mode_and_span` byte. Asserted through the charge
   * rather than by reading the field, so a rename on either side fails here.
   */
  'a stairs link and an escalator link are told apart by the byte routing writes'() {
    const tower = createTower({ seed: 1 });
    tower.segments = [{ flags: (3 << 1) | 1 }, { flags: (3 << 1) | 0 }];
    const links = chargeableLinks(tower);
    assert(links.length === 2, 'the segments did not reach the expense sweep');
    assert(links[0].modeAndSpan !== links[1].modeAndSpan, 'the stairs bit was lost in translation');
  },

  'every placed object is offered, so upkeep starts the day a type gains a rate'() {
    // Not pre-filtered to "things that currently cost money": that filter would
    // be a second list of what has upkeep, and the second list goes stale.
    const tower = towerWithOffices(2);
    const types = chargeableItems(tower).map((i) => i.type);
    assert(types.length === 2 && types.every((t) => t === 'office'),
      'the item sweep offered ' + JSON.stringify(types));
  },

  // -------------------------------------------------------- the checkpoint

  'the checkpoint pays rent on a cashflow day and nothing on the others'() {
    const tower = towerWithOffices(3);
    tower.clock.dayCounter = 4;
    const quiet = runTowerLedgerCheckpoint(tower);
    assert(!quiet.cashflow && tower.cash === 2_000_000,
      'day 4 moved $' + (tower.cash - 2_000_000));

    tower.clock.dayCounter = 6;
    const pass = runTowerLedgerCheckpoint(tower);
    assert(pass.cashflow && pass.activated === 3, pass.activated + ' of 3 offices were paid');
    assert(tower.cash === 2_030_000,
      'three tier-1 offices paid $' + (tower.cash - 2_000_000) + ', expected $30,000');
  },

  'the checkpoint charges the cars whether or not anything earns'() {
    const tower = createTower({ seed: 1 });
    tower.segments = [];
    const carrier = createCarrier({ id: 0, mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 5 });
    addCar(carrier);
    tower.carriers.push(carrier);
    tower.clock.dayCounter = 3;

    runTowerLedgerCheckpoint(tower);
    assert(tower.cash === 1_990_000, 'one car cost $' + (2_000_000 - tower.cash) + ', expected $10,000');
  },

  /**
   * The rent moment. `sim/office.js` calls `onRent` the instant a route
   * resolves; the hook pays the first rent and moves the six workers onto the
   * population ledger. The `+6` belongs here and NOT in the 3-day sweep —
   * `specs/facility/OFFICE.md` splits them, and putting it in the sweep would
   * add six people every third day for the life of the tenant.
   */
  'the reopen path pays once and moves six people onto the ledger'() {
    const tower = towerWithOffices(1);
    const [object] = officesOf(tower);
    const { onRent } = officeCashflowHooks(tower);
    tower.clock.dayCounter = 4;

    onRent(tower, object);
    assert(tower.cash === 2_010_000, 'the first rent paid $' + (tower.cash - 2_000_000));
    assert(tower.populationLedger.office === 6,
      'the population ledger reads ' + tower.populationLedger.office + ', expected 6');

    // And the guard the sweep shares: an office that rents on a cashflow day is
    // paid once that cycle, not once by each path.
    tower.clock.dayCounter = 6;
    tower.cash = 2_000_000;
    onRent(tower, object);
    const afterRent = tower.cash;
    runTowerLedgerCheckpoint(tower);
    assert(tower.cash === afterRent,
      'the 3-day sweep paid an office the reopen path had already paid this cycle: $'
      + (tower.cash - afterRent) + ' twice over');
  },

  'the 3-day sweep pays rent and leaves the population ledger alone'() {
    const tower = towerWithOffices(1);
    tower.populationLedger.office = 6;
    tower.clock.dayCounter = 3;
    runTowerLedgerCheckpoint(tower);
    assert(tower.populationLedger.office === 6,
      'the sweep moved the population ledger to ' + tower.populationLedger.office
      + ' — the +6 is the reopen path’s, and adding it here compounds every third day');
  },

  'closing an office claws the rent back and takes its people off the ledger'() {
    const tower = towerWithOffices(1);
    const [object] = officesOf(tower);
    tower.populationLedger.office = 6;
    // Fail it honestly. Writing `evalLevel = 0` by hand proves nothing: the
    // checkpoint's own recompute overwrites it from the real stress history,
    // which is the point of running the recompute before the closure at all.
    // Six workers who cannot be routed anywhere score the 300-tick clamp.
    for (const worker of tower.actors) recordNoRouteFailure(worker);
    tower.clock.dayCounter = 3;

    const report = runTowerLedgerCheckpoint(tower);
    assert(report.deactivated === 1, 'a failing office was not closed');
    assert(report.activated === 0,
      'the closed office was also paid — deactivate has to run before activate, or every dying '
      + 'tenant gets one last cheque');
    assert(tower.cash === 1_990_000, 'the clawback took $' + (2_000_000 - tower.cash));
    assert(tower.populationLedger.office === 0, 'six people stayed on the ledger of an empty office');
  },

  'the daily recompute runs on every day, not only the paying ones'() {
    // It is what sets `occupied_flag` on a freshly placed office — the
    // bootstrap that opens the rental gate at all. Gate it on the cadence and
    // an office placed on day 4 waits until day 6 to become lettable.
    const tower = createTower({ seed: 1 });
    tower.segments = [];
    placeObject(tower, { family: FAMILY.office, floor: 3, left: 0, right: 5 }, () => createSimTripRecord());
    const [object] = officesOf(tower);
    assert(!object.occupiedFlag, 'a placed office is measured before any sweep has run');

    tower.clock.dayCounter = 4;              // not a cashflow day
    runTowerLedgerCheckpoint(tower);
    assert(object.occupiedFlag,
      'the operational recompute did not run on a non-cashflow day, so the office can never be let');
  },
};
