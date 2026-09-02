/**
 * The money model, checked against the reference rather than against what the
 * implementation happens to produce.
 *
 * Every assertion cites a section of `specs/ECONOMY.md`, `specs/TIME.md`, or a
 * `specs/facility/*.md`. Where a number looks wrong — rent tiers that get
 * cheaper as the number goes up, a stairs *branch* that costs nothing to run
 * while the stairs *tool* is the more expensive one to build, a first rent
 * cheque that lands on day 3 of a game that started on day 0 — the test is
 * pinning the reference, and changing it is a deviation that belongs in
 * `spec/DEVIATIONS.md`.
 *
 * The construction table and the payout tables are transcribed here a second
 * time, straight from the spec's own columns, so the test compares two
 * independent readings rather than agreeing with itself.
 */
import { TICKS_PER_DAY, advanceClock, createClock } from '../src/games/tower/sim/clock.js';
import {
  ACTIVATION_TICK_CAP, CASH_CAP, CASH_UNIT, CONSTRUCTION_COST, DEACTIVATED_EARLY,
  DEACTIVATED_LATE, DEFAULT_RENT_TIER, EXPENSE_BUCKETS, FIRST_CASHFLOW_DAY,
  INCOME_BUCKETS, LEDGER_CHECKPOINT_TICK, LOBBY_PREMIUM_FLOOR_RATE, RENT_TIERS,
  STARTING_CASH, TYPE_CODES,
  activateFamilyCashflowIfOperational, addExpense, addIncome,
  applyPeriodicOperatingExpenses, chargeConstruction, createLedger,
  deactivateFamilyCashflowIfUnpaired, floorConstructionCost, isCashflowDay,
  linkExpense, parkingExpense, payout, placementCost, rollLedgers,
  runLedgerCheckpoint,
} from '../src/games/tower/sim/economy.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** An office that is open, paying, and has rented before. */
const office = (over = {}) => ({
  family: 'office',
  rentTier: DEFAULT_RENT_TIER,
  operational: true,
  everRented: true,
  evalLevel: 2,
  unitStatus: 0x02,
  activationTicks: 0,
  ...over,
});

/**
 * Drive the real clock from a fresh game and report the day counter at every
 * checkpoint-2533 firing. This is the only honest way to test the cadence: the
 * interesting behaviour lives in the 300-tick gap between the day advance and
 * the checkpoint, and re-deriving it arithmetically would just restate the bug.
 */
function checkpointDays(days) {
  const clock = createClock();
  const fired = [];
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    advanceClock(clock);
    if (clock.dayTick === LEDGER_CHECKPOINT_TICK) fired.push(clock.dayCounter);
  }
  return fired;
}

export const tests = {
  // -------------------------------------------------- construction costs

  'the construction table is the reference’s, to the dollar'() {
    // specs/ECONOMY.md § Construction Costs. Transcribed here in the spec's own
    // cash units (1 unit = $100, § Units) and multiplied out independently.
    const specUnits = {
      floorTile: 5, elevatorStandard: 2000, hotelSingle: 200, hotelTwin: 500,
      hotelSuite: 1000, restaurant: 2000, office: 400, condo: 800, retail: 1000,
      parkingSpace: 30, fastFood: 1000, medical: 5000, security: 1000,
      housekeeping: 500, secom: 1000, movieTheater: 5000, recyclingCenter: 5000,
      stairs: 50, lobby: 50, escalator: 200, partyHall: 1000, metroStation: 10000,
      cathedral: 30000, elevatorExpress: 4000, elevatorService: 1000, parkingRamp: 500,
    };
    for (const [name, units] of Object.entries(specUnits)) {
      assert(CONSTRUCTION_COST[name] === units * CASH_UNIT,
        name + ' costs $' + CONSTRUCTION_COST[name] + ', the spec says $' + units * CASH_UNIT);
    }
    // Bounded: no invented rows either.
    const extra = Object.keys(CONSTRUCTION_COST).filter((k) => !(k in specUnits));
    assert(extra.length === 0, 'construction rows not in the spec table: ' + extra.join(','));
  },

  'the type codes are the reference’s, so a spec line that says “type 0x16” is findable'() {
    // specs/ECONOMY.md § Construction Costs, first column.
    const specCodes = {
      floorTile: 0x00, elevatorStandard: 0x01, hotelSingle: 0x03, hotelTwin: 0x04,
      hotelSuite: 0x05, restaurant: 0x06, office: 0x07, condo: 0x09, retail: 0x0a,
      parkingSpace: 0x0b, fastFood: 0x0c, medical: 0x0d, security: 0x0e,
      housekeeping: 0x0f, secom: 0x11, movieTheater: 0x12, recyclingCenter: 0x14,
      stairs: 0x16, lobby: 0x18, escalator: 0x1b, partyHall: 0x1d, metroStation: 0x1f,
      cathedral: 0x24, elevatorExpress: 0x2a, elevatorService: 0x2b, parkingRamp: 0x2c,
    };
    for (const [name, code] of Object.entries(specCodes)) {
      assert(TYPE_CODES[name] === code,
        name + ' is type 0x' + TYPE_CODES[name].toString(16) + ', spec says 0x' + code.toString(16));
    }
  },

  'the placement charge deducts cash, can spend to exactly zero, and never past it'() {
    // specs/COMMANDS.md § Build: "successful build should deduct cost"; the
    // funds check rejects when cost exceeds the balance.
    const ledger = createLedger({ cash: 40_000 });
    const exact = chargeConstruction(ledger, CONSTRUCTION_COST.office);
    assert(exact.charged && ledger.cash === 0, 'an exactly-affordable office was not charged');

    const broke = chargeConstruction(ledger, CONSTRUCTION_COST.office);
    assert(!broke.charged && ledger.cash === 0, 'an unaffordable office was charged anyway');
  },

  'construction never enters the operating-expense ledger'() {
    // specs/ECONOMY.md § Ledgers defines expense_ledger as "realized OPERATING
    // expenses since the last 3-day rollover". A build is not one.
    const ledger = createLedger({ cash: STARTING_CASH });
    chargeConstruction(ledger, CONSTRUCTION_COST.movieTheater);
    const booked = Object.values(ledger.expense).reduce((a, b) => a + b, 0);
    assert(booked === 0, 'construction booked $' + booked + ' of operating expense');
    assert(ledger.cash === STARTING_CASH - 500_000, 'the balance is wrong after a build');
  },

  'a new game opens with $2,000,000'() {
    // specs/TIME.md § New Game Initialization. 20,000 cash units.
    assert(STARTING_CASH === 2_000_000, 'starting cash is $' + STARTING_CASH);
    assert(createLedger().cash === 2_000_000, 'a fresh ledger does not hold the starting cash');
  },

  // ------------------------------------------------------- lobby premium

  'the upper floors of a multi-floor lobby cost premium × lobby_height per tile'() {
    // specs/ECONOMY.md § Floor Construction Premium: "a 2-floor lobby charges
    // premium_rate * 2 per tile on floor 1 and a 3-floor lobby charges
    // premium_rate * 3 per tile on floors 1 and 2".
    const p = LOBBY_PREMIUM_FLOOR_RATE;
    const at = (floor, lobbyHeight) => floorConstructionCost({ floor, tiles: 1, lobbyHeight });

    assert(at(1, 2) === p * 2, 'floor 1 of a 2-floor lobby costs $' + at(1, 2));
    assert(at(1, 3) === p * 3, 'floor 1 of a 3-floor lobby costs $' + at(1, 3));
    assert(at(2, 3) === p * 3, 'floor 2 of a 3-floor lobby costs $' + at(2, 3));

    // Bounded, and negated. Floor 0 is the lobby itself and is NOT premium;
    // neither is the first floor above the lobby, nor any basement.
    assert(at(0, 3) === CONSTRUCTION_COST.floorTile, 'floor 0 took the premium rate');
    assert(at(2, 2) === CONSTRUCTION_COST.floorTile, 'floor 2 took a 2-floor lobby’s premium');
    assert(at(3, 3) === CONSTRUCTION_COST.floorTile, 'floor 3 took a 3-floor lobby’s premium');
    assert(at(-1, 3) === CONSTRUCTION_COST.floorTile, 'a basement took the premium rate');
    assert(at(1, 1) === CONSTRUCTION_COST.floorTile, 'a 1-floor lobby charged a premium');
  },

  'the premium scales with the tile span, and rides along with a placement'() {
    const wide = floorConstructionCost({ floor: 1, tiles: 8, lobbyHeight: 2 });
    assert(wide === LOBBY_PREMIUM_FLOOR_RATE * 2 * 8, '8 premium tiles cost $' + wide);

    const total = placementCost('office', { tiles: 9, floor: 1, lobbyHeight: 2 });
    assert(total === CONSTRUCTION_COST.office + LOBBY_PREMIUM_FLOOR_RATE * 2 * 9,
      'an office on an upper lobby floor cost $' + total);
  },

  // ---------------------------------------------------------- rent tiers

  'office rent tiers run backwards: tier 0 is the expensive one'() {
    // specs/facility/OFFICE.md § Parity: Rent Payouts.
    // | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
    // | $15,000 | $10,000 | $5,000 | $2,000 |
    const spec = [15_000, 10_000, 5_000, 2_000];
    for (let tier = 0; tier < 4; tier++) {
      assert(payout('office', tier) === spec[tier],
        'office tier ' + tier + ' pays $' + payout('office', tier) + ', spec says $' + spec[tier]);
    }
    // The direction is the whole point, so pin it independently of the values.
    assert(payout('office', 0) > payout('office', 1), 'tier 0 is not the most expensive');
    assert(payout('office', 3) < payout('office', 2), 'tier 3 is not the cheapest');
    assert(DEFAULT_RENT_TIER === 1 && payout('office', DEFAULT_RENT_TIER) === 10_000,
      'the placement default is not tier 1 at $10,000');
  },

  'the other priced families match their own facility specs'() {
    const spec = {
      // specs/facility/HOTEL.md § Stay Payouts
      hotelSingle: [3_000, 2_000, 1_500, 500],
      hotelTwin: [4_500, 3_000, 2_000, 800],
      hotelSuite: [9_000, 6_000, 4_000, 1_500],
      // specs/facility/CONDO.md § Sale And Refund Values
      condo: [200_000, 150_000, 100_000, 40_000],
      // specs/facility/COMMERCIAL.md § Priced Family Row
      retail: [20_000, 15_000, 10_000, 4_000],
    };
    for (const [family, row] of Object.entries(spec)) {
      for (let tier = 0; tier < 4; tier++) {
        assert(payout(family, tier) === row[tier],
          family + ' tier ' + tier + ' pays $' + payout(family, tier) + ', spec says $' + row[tier]);
      }
    }
    // Bounded: no priced family invented beyond the spec's six.
    const known = new Set([...Object.keys(spec), 'office']);
    const extra = Object.keys(RENT_TIERS).filter((k) => !known.has(k));
    assert(extra.length === 0, 'priced families not in the spec: ' + extra.join(','));
  },

  'tier 4 is the unpriced sentinel, and an unpriced family pays nothing'() {
    // specs/ECONOMY.md § Pricing Tiers: "4: no payout / unpriced sentinel — set
    // for all non-priced families".
    assert(payout('office', 4) === 0, 'a tier-4 office still paid $' + payout('office', 4));
    assert(payout('stairs', 1) === 0, 'an unpriced family paid rent');
  },

  // ------------------------------------------------------ the 3-day cadence

  'cashflow moves on every third day and no other'() {
    // specs/TIME.md § 2533: every ledger action tests day_counter % 3 == 0.
    const moves = [];
    for (let day = 0; day <= 20; day++) if (isCashflowDay(day)) moves.push(day);
    assert(JSON.stringify(moves) === JSON.stringify([0, 3, 6, 9, 12, 15, 18]),
      'cashflow days are ' + moves.join(',') + ', expected 0,3,6,9,12,15,18');
  },

  /**
   * The one everybody gets wrong, and the reason TIME.md § 2533 spells it out.
   * A fresh game starts *at* tick 2533, so it never runs that checkpoint on day
   * 0; and every later 2533 is read after checkpoint 2300 has already advanced
   * the counter. First cheque: day 3.
   */
  'a fresh game first pays on day 3, driven by the real clock'() {
    const fired = checkpointDays(12);

    assert(fired.length === 12, 'checkpoint 2533 fired ' + fired.length + ' times in 12 days');
    assert(fired[0] === 1,
      'the first live checkpoint 2533 saw day ' + fired[0] + ', the spec says day 1 — a new '
      + 'game starts ON 2533 and so never runs it on day 0');

    const paid = fired.filter(isCashflowDay);
    assert(JSON.stringify(paid) === JSON.stringify([3, 6, 9, 12]),
      'cashflow fired on days ' + paid.join(',') + ', expected 3,6,9,12');
    assert(paid[0] === FIRST_CASHFLOW_DAY && FIRST_CASHFLOW_DAY === 3,
      'the first cashflow pass landed on day ' + paid[0] + ', not day 3');

    // Negated: days 1 and 2 exist and pay nothing. A tower that collected rent
    // on its first or second day would still pass every other test here.
    assert(fired.includes(1) && fired.includes(2), 'days 1 and 2 never reached the checkpoint');
    assert(!paid.includes(1) && !paid.includes(2), 'rent was collected on day 1 or 2');
  },

  'the ledger checkpoint is the tick a new game opens on'() {
    // specs/TIME.md § Tick Model: "Tick 2533 is also the quarterly-expense
    // checkpoint, so the first day begins with a clean financial slate."
    assert(LEDGER_CHECKPOINT_TICK === 2533, 'the ledger checkpoint moved to ' + LEDGER_CHECKPOINT_TICK);
    assert(createClock().dayTick === LEDGER_CHECKPOINT_TICK, 'a new game no longer starts on it');
  },

  'nothing moves on a non-cashflow day, however operational the tower'() {
    const ledger = createLedger({ cash: 1_000_000 });
    const units = [office()];
    const report = runLedgerCheckpoint(ledger, {
      units,
      carriers: [{ mode: 'standard', cars: 4 }],
      links: [{ modeAndSpan: 0 }],
    }, 2);

    assert(!report.cashflow && report.activated === 0 && report.expenses === 0,
      'day 2 moved money: ' + JSON.stringify(report));
    assert(ledger.cash === 1_000_000, 'the balance changed on a non-cashflow day');
  },

  'the operational-status recompute runs every day, cashflow or not'() {
    // specs/TIME.md § 2533 step 2: "for all objects:
    // recompute_object_operational_status. IF day_counter % 3 == 0: THEN
    // deactivate..., then activate...". Only the two cashflow calls are gated.
    let recomputes = 0;
    const ledger = createLedger();
    for (const day of [1, 2, 3]) {
      runLedgerCheckpoint(ledger, { units: [office()], recompute: () => recomputes++ }, day);
    }
    assert(recomputes === 3, 'recompute ran ' + recomputes + ' times over 3 days, expected 3');
  },

  // -------------------------------------------------------------- rollover

  'rollover saves the balance into the cycle base and clears every bucket'() {
    // specs/TIME.md § 2533 step 1: "save cash_balance into cycle base, clear 11
    // bucket slots each".
    const ledger = createLedger({ cash: 750_000 });
    addIncome(ledger, 'office', 10_000);
    addExpense(ledger, 'elevatorStandard', 10_000);

    rollLedgers(ledger);
    assert(ledger.cashCycleBase === ledger.cash, 'the cycle base did not take the live balance');
    for (const bucket of INCOME_BUCKETS) {
      assert(ledger.income[bucket] === 0, 'income bucket ' + bucket + ' survived the rollover');
    }
    for (const bucket of EXPENSE_BUCKETS) {
      assert(ledger.expense[bucket] === 0, 'expense bucket ' + bucket + ' survived the rollover');
    }
  },

  'rollover happens first, so the buckets read as this cycle’s activity'() {
    // specs/TIME.md § 2533: step 1 is the rollover; steps 2 and 3 are the rent
    // and the expenses. Moving the rollover after them empties the report.
    const ledger = createLedger({ cash: 500_000 });
    addIncome(ledger, 'office', 999_999);          // stale, from the last cycle

    runLedgerCheckpoint(ledger, {
      units: [office()],                            // +$10,000 rent
      carriers: [{ mode: 'standard', cars: 1 }],    // -$10,000
    }, 3);

    assert(ledger.income.office === 10_000,
      'income.office reads $' + ledger.income.office + ' — the stale cycle was not cleared first');
    assert(ledger.expense.elevatorStandard === 10_000,
      'this cycle’s expense was rolled away: $' + ledger.expense.elevatorStandard);
    assert(ledger.cashCycleBase === 1_499_999,
      'the cycle base is $' + ledger.cashCycleBase + ', expected the pre-pass balance');
  },

  'income clamps at the cash cap; the ledger mirror records what was realized'() {
    // specs/ECONOMY.md § Ledgers: income "adds to cash, clamps so cash never
    // exceeds $99,999,999, mirrors into the income ledger". The clamp is on the
    // balance. The mirror is a record of what the tower earned this cycle, so a
    // sale that the cap swallowed still shows up in it.
    const ledger = createLedger({ cash: CASH_CAP - 1_000 });
    addIncome(ledger, 'condo', 200_000);
    assert(ledger.cash === CASH_CAP, 'cash reached $' + ledger.cash + ', cap is $' + CASH_CAP);
    assert(ledger.income.condo === 200_000,
      'the mirror recorded $' + ledger.income.condo + ', but $200,000 was realized');

    // ...and the mirror is not a balance, so the cap does not apply to it at all.
    const busy = createLedger({ cash: 0 });
    busy.income.condo = CASH_CAP;
    addIncome(busy, 'condo', 200_000);
    assert(busy.income.condo === CASH_CAP + 200_000,
      'the income ledger was clamped at the cash cap: $' + busy.income.condo);
  },

  // ------------------------------------------------------------- expenses

  'a tower with no income still pays its expenses, and goes negative doing it'() {
    // specs/ECONOMY.md § Periodic Expenses: elevators, service infrastructure
    // and support facilities are charged whether or not anything earns.
    const ledger = createLedger({ cash: 5_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, {
      carriers: [{ mode: 'express', cars: 1 }],
    });
    assert(spent === 20_000, 'the pass charged $' + spent + ', expected $20,000');
    assert(ledger.cash === -15_000,
      'the balance is $' + ledger.cash + '; the spec documents a ceiling on cash, never a floor');
  },

  'carrier costs are $20,000 express, $10,000 standard, $10,000 service, per car'() {
    // specs/ECONOMY.md § Periodic Expenses → Carrier expense values, and
    // specs/TIME.md § 2533 step 3.
    const spec = { express: 20_000, standard: 10_000, service: 10_000 };
    for (const [mode, rate] of Object.entries(spec)) {
      const ledger = createLedger({ cash: 1_000_000 });
      const spent = applyPeriodicOperatingExpenses(ledger, { carriers: [{ mode, cars: 1 }] });
      assert(spent === rate, 'a ' + mode + ' car cost $' + spent + ', spec says $' + rate);
    }
    // Express is the one that differs. Pin the relationship, not just the value.
    assert(spec.express === spec.standard * 2, 'express is no longer twice standard');
  },

  'expenses scale with car count'() {
    const bill = (cars) => {
      const ledger = createLedger({ cash: 10_000_000 });
      return applyPeriodicOperatingExpenses(ledger, { carriers: [{ mode: 'standard', cars }] });
    };
    assert(bill(1) === 10_000, 'one car cost $' + bill(1));
    assert(bill(3) === 30_000, 'three cars cost $' + bill(3));
    assert(bill(8) === 80_000, 'eight cars cost $' + bill(8));
    // Negated: a flat per-shaft charge would pass bill(1) and fail here.
    assert(bill(3) === bill(1) * 3, 'the carrier charge is not per car');
  },

  'an escalator link costs $5,000 per scaled unit; a stairs link costs nothing'() {
    // specs/ECONOMY.md § Periodic Expenses → Special-link branch mapping:
    // "Escalator-branch links charge $5,000 per scaled unit... Stairs-branch
    // links charge $0." The EXE build labels price them the other way round;
    // that is the construction cost, not the operating cost.
    const escalator = createLedger({ cash: 1_000_000 });
    applyPeriodicOperatingExpenses(escalator, { links: [{ modeAndSpan: 0b10 }] }); // unit 1, bit clear
    assert(escalator.cash === 995_000, 'an escalator link cost $' + (1_000_000 - escalator.cash));
    assert(escalator.expense.escalator === 5_000, 'the escalator bucket holds $' + escalator.expense.escalator);

    const stairs = createLedger({ cash: 1_000_000 });
    applyPeriodicOperatingExpenses(stairs, { links: [{ modeAndSpan: 0b11 }] }); // unit 1, bit set
    assert(stairs.cash === 1_000_000, 'a stairs link cost $' + (1_000_000 - stairs.cash));
  },

  'the stairs cost bit is bit 0 of mode_and_span'() {
    // specs/TIME.md § 2533 step 3: "mode_and_span & 1 is the stairs cost bit:
    // 0 means Escalator branch, 1 means Stairs branch".
    for (let unitCount = 0; unitCount < 8; unitCount++) {
      const escalator = linkExpense({ modeAndSpan: unitCount << 1 });
      const stairs = linkExpense({ modeAndSpan: (unitCount << 1) | 1 });
      assert(escalator.kind === 'escalator' && stairs.kind === 'stairs',
        'unit count ' + unitCount + ' decoded as ' + escalator.kind + '/' + stairs.kind);
      assert(escalator.unitCount === unitCount && stairs.unitCount === unitCount,
        'the unit count is not the rest of the byte at ' + unitCount);
      assert(stairs.dollars === 0, 'a stairs link billed $' + stairs.dollars);
    }
  },

  'the special-link charge scales by (unit_count >> 1) + 1'() {
    // specs/ECONOMY.md § Periodic Expenses ("scaled by (unit_count / 2 + 1)")
    // and specs/TIME.md § 2533 step 3, which says it a second time.
    const specScale = [1, 1, 2, 2, 3, 3, 4, 4, 5];  // (n >> 1) + 1 for n = 0..8
    for (let unitCount = 0; unitCount < specScale.length; unitCount++) {
      const { scaled, dollars } = linkExpense({ kind: 'escalator', unitCount });
      assert(scaled === specScale[unitCount],
        'unit count ' + unitCount + ' scaled to ' + scaled + ', spec says ' + specScale[unitCount]);
      assert(dollars === 5_000 * specScale[unitCount],
        'unit count ' + unitCount + ' billed $' + dollars);
    }
    // Negated: an unscaled charge, or a plain `unit_count` multiplier, both
    // agree with the spec at 1 and 2 and diverge everywhere else.
    assert(linkExpense({ kind: 'escalator', unitCount: 0 }).dollars === 5_000,
      'a zero-unit link is free — the "+ 1" is missing');
    assert(linkExpense({ kind: 'escalator', unitCount: 6 }).dollars === 20_000,
      'six units did not bill four scaled units');
  },

  'the confirmed per-object infrastructure expenses are charged at their spec rates'() {
    // specs/ECONOMY.md § Periodic Expenses → "Confirmed per-unit infrastructure
    // expenses".
    const spec = {
      security: 20_000,
      housekeeping: 10_000,
      recyclingCenter: 50_000,
      metroStation: 100_000,
      parkingRamp: 10_000,
    };
    for (const [type, rate] of Object.entries(spec)) {
      const ledger = createLedger({ cash: 1_000_000 });
      const spent = applyPeriodicOperatingExpenses(ledger, { items: [{ type }] });
      assert(spent === rate, type + ' cost $' + spent + ', spec says $' + rate);
      assert(ledger.expense[type] === rate, type + ' booked to the wrong bucket');
    }
  },

  'an office building is charged nothing for existing — only its infrastructure is'() {
    // specs/ECONOMY.md § Periodic Expenses: the pass charges "infrastructure
    // that contributes upkeep rather than direct income". Rentable space earns;
    // it does not cost.
    const ledger = createLedger({ cash: 1_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, {
      items: [{ type: 'office', count: 40 }, { type: 'hotelSuite', count: 10 }],
    });
    assert(spent === 0, '40 offices and 10 suites were billed $' + spent + ' in upkeep');
  },

  'parking costs $300 a tile at 3 stars and $1,000 at 4, and nothing below'() {
    // specs/ECONOMY.md § Periodic Expenses → Parking expense formula:
    // (right - left) * tier_rate / 10 cash units; "effective per-tile charges
    // are therefore $0, $300, and $1,000".
    const span = { leftTile: 0, rightTile: 4 };   // 4 by the spec's difference form
    const perTile = { 1: 0, 2: 0, 3: 300, 4: 1_000, 5: 1_000 };
    for (const [stars, rate] of Object.entries(perTile)) {
      const got = parkingExpense(span, Number(stars));
      assert(got === rate * 4, stars + ' stars billed $' + got + ' for 4 tiles, expected $' + rate * 4);
    }
  },

  'parking is exempt on the upper floors of a multi-floor lobby, and nowhere else'() {
    // specs/ECONOMY.md § Periodic Expenses: "the charge is skipped for the upper
    // floors of a multi-floor lobby: clone logical floors 1 <= floor <
    // lobby_height". Logical floors: 0 is the ground lobby, negatives are
    // basements — no exe-to-logical translation is needed, the spec is already
    // in clone-logical terms.
    const bill = (floor, lobbyHeight) => {
      const ledger = createLedger({ cash: 1_000_000 });
      return applyPeriodicOperatingExpenses(ledger, {
        items: [{ type: 'parkingSpace', floor, leftTile: 0, rightTile: 4 }],
        starCount: 4,
        lobbyHeight,
      });
    };
    assert(bill(1, 3) === 0, 'floor 1 of a 3-floor lobby was billed $' + bill(1, 3));
    assert(bill(2, 3) === 0, 'floor 2 of a 3-floor lobby was billed $' + bill(2, 3));

    // Bounded on every side: the lobby floor itself, the floor above the lobby,
    // a 1-floor lobby, and the basements where parking actually lives.
    assert(bill(0, 3) === 4_000, 'floor 0 was exempted');
    assert(bill(3, 3) === 4_000, 'floor 3 was exempted by a 3-floor lobby');
    assert(bill(1, 1) === 4_000, 'a 1-floor lobby exempted floor 1');
    assert(bill(-2, 3) === 4_000, 'a basement was exempted');
  },

  'the whole 3-day bill adds up, and stays in whole dollars'() {
    const ledger = createLedger({ cash: 5_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, {
      items: [
        { type: 'security', count: 2 },              //  2 × $20,000  =  $40,000
        { type: 'housekeeping' },                    //                 $10,000
        { type: 'recyclingCenter' },                 //                 $50,000
        { type: 'parkingSpace', floor: -3, leftTile: 0, rightTile: 4 }, // $4,000
      ],
      carriers: [
        { mode: 'express', cars: 2 },                //  2 × $20,000  =  $40,000
        { mode: 'standard', cars: 5 },               //  5 × $10,000  =  $50,000
        { mode: 'service', cars: 1 },                //                 $10,000
      ],
      links: [
        { modeAndSpan: 0b1000 },                     // escalator, 4 units → ×3 = $15,000
        { modeAndSpan: 0b1001 },                     // stairs, 4 units             $0
      ],
      starCount: 4,
    });
    assert(spent === 219_000, 'the 3-day bill came to $' + spent + ', expected $219,000');
    assert(Number.isInteger(ledger.cash), 'the balance is not an integer: ' + ledger.cash);
    for (const [k, v] of Object.entries(ledger.expense)) {
      assert(Number.isInteger(v), 'expense bucket ' + k + ' is not an integer: ' + v);
    }
  },

  // ----------------------------------------------- activation/deactivation

  'an operational office is paid its tier’s rent on the 3-day sweep'() {
    // specs/facility/OFFICE.md § Parity: Activation And Deactivation: open
    // offices "realize cashflow on the 3-day activation sweep".
    const ledger = createLedger({ cash: 0 });
    const unit = office({ rentTier: 0 });
    assert(activateFamilyCashflowIfOperational(ledger, unit, 3), 'the office was not paid');
    assert(ledger.cash === 15_000, 'a tier-0 office paid $' + ledger.cash + ', spec says $15,000');
    assert(ledger.income.office === 15_000, 'the income ledger did not mirror the rent');
  },

  'an office that never rented is never paid'() {
    // specs/facility/OFFICE.md: office rent only credits through
    // activate_office_cashflow from the per-sim state-0x20 path — an office no
    // worker can reach has never taken that path.
    const ledger = createLedger({ cash: 0 });
    const unreachable = office({ everRented: false });
    assert(!activateFamilyCashflowIfOperational(ledger, unreachable, 3),
      'an office that never rented was paid');
    assert(ledger.cash === 0, 'an unreachable office earned $' + ledger.cash);
  },

  'a closed office is not paid'() {
    const ledger = createLedger({ cash: 0 });
    assert(!activateFamilyCashflowIfOperational(ledger, office({ operational: false }), 3),
      'a non-operational office was paid');
    assert(ledger.cash === 0, 'a closed office earned $' + ledger.cash);
  },

  'the 3-day activation sweep pays rent and nothing else — population is the reopen path’s'() {
    // specs/facility/OFFICE.md § Parity: Activation And Deactivation splits the
    // two: the 3-day sweep realizes cashflow, while "fresh reopen after a close
    // resets unit_status to 0, adds +6 to the population ledger" — that +6 is
    // the worker-arrival path, which runs when a worker actually gets there.
    // Adding it here too would inflate the ledger by 6 every third day for the
    // life of the tenant, and the star thresholds read that ledger.
    const ledger = createLedger({ cash: 0 });
    ledger.population.office = 6;
    activateFamilyCashflowIfOperational(ledger, office(), 3);
    assert(ledger.population.office === 6,
      'the activation sweep moved the population ledger to ' + ledger.population.office);
    assert(ledger.cash === 10_000, 'the sweep did not pay the rent');
  },

  'retail activates on being operational alone, and a dormant venue is not paid'() {
    // specs/ECONOMY.md § Cashflow Activation: "office income activates while
    // open and deactivates when unpaired; commercial and entertainment families
    // use derived records and attendance state". The never-rented gate is the
    // office's alone — retail's recurring stream starts when the venue record
    // is available (specs/facility/COMMERCIAL.md § Retail Income Timing) and is
    // withheld while that record is dormant.
    const shop = (over = {}) => ({
      family: 'retail', rentTier: DEFAULT_RENT_TIER, operational: true,
      evalLevel: 2, unitStatus: 0x02, ...over,
    });

    const open = createLedger({ cash: 0 });
    assert(activateFamilyCashflowIfOperational(open, shop(), 3),
      'a retail shop was held back by the office-only never-rented gate');
    assert(open.cash === 15_000, 'a tier-1 shop paid $' + open.cash + ', spec says $15,000');

    const dormant = createLedger({ cash: 0 });
    assert(!activateFamilyCashflowIfOperational(dormant, shop({ dormant: true }), 3),
      'a dormant venue was paid');
    assert(dormant.cash === 0, 'a dormant venue earned $' + dormant.cash);
  },

  'the once-per-cycle guard stops a second payment on the same pass'() {
    // specs/facility/OFFICE.md: the activation guard is shared with the per-sim
    // handlers, so an office that already reopened and paid today is skipped.
    const ledger = createLedger({ cash: 0 });
    const unit = office();
    activateFamilyCashflowIfOperational(ledger, unit, 3);
    assert(!activateFamilyCashflowIfOperational(ledger, unit, 3), 'the office was paid twice');
    assert(ledger.cash === 10_000, 'a double payment landed: $' + ledger.cash);

    // ...and the guard lifts on the next cycle.
    assert(activateFamilyCashflowIfOperational(ledger, unit, 6), 'the guard never lifted');
    assert(ledger.cash === 20_000, 'the next cycle paid $' + (ledger.cash - 10_000));
  },

  'activation ages the tenant, to a cap of 120'() {
    // specs/facility/OFFICE.md: "activation increments activation_tick_count up
    // to a cap of 120; this is cumulative, not per-day".
    const ledger = createLedger({ cash: 0 });
    const unit = office();
    for (let cycle = 1; cycle <= 200; cycle++) {
      unit.cycleMark = undefined;
      activateFamilyCashflowIfOperational(ledger, unit, cycle * 3);
    }
    assert(unit.activationTicks === ACTIVATION_TICK_CAP && ACTIVATION_TICK_CAP === 120,
      'activation age reached ' + unit.activationTicks + ', the cap is 120');
  },

  'a zero evaluation closes the office and claws the rent back; a low one does not'() {
    // specs/facility/OFFICE.md § Deactivation trigger: "if eval_level == 0 and
    // the office is still in the active band, deactivation writes the office
    // back into a vacant band... subtracts the office's recurring contribution
    // from cash and removes 6 from the population ledger". A low but nonzero
    // eval_level keeps the tenant — one bad commute must not evict anyone.
    const ledger = createLedger({ cash: 100_000 });
    ledger.population.office = 6;
    const failing = office({ evalLevel: 0 });

    assert(deactivateFamilyCashflowIfUnpaired(ledger, failing), 'a zero evaluation did not close');
    assert(ledger.cash === 90_000, 'the clawback took $' + (100_000 - ledger.cash) + ', expected $10,000');
    assert(ledger.population.office === 0, 'the population ledger still holds ' + ledger.population.office);
    assert(failing.operational === false && failing.activationTicks === 0,
      'the occupied flag or the activation count survived deactivation');

    const struggling = office({ evalLevel: 1 });
    assert(!deactivateFamilyCashflowIfUnpaired(ledger, struggling),
      'a low but nonzero evaluation evicted the tenant');
    assert(struggling.operational === true, 'a struggling office was closed');
  },

  'deactivation at checkpoint 2533 writes the late-day band, 0x18'() {
    // specs/TIME.md § Morning vs evening period: the deactivation mark is 0x10
    // in the morning and 0x18 in the evening for offices. Checkpoint 2533 is
    // daypart 6, so the sweep always takes the evening branch.
    const ledger = createLedger({ cash: 100_000 });
    const evening = office({ evalLevel: 0 });
    deactivateFamilyCashflowIfUnpaired(ledger, evening);
    assert(evening.unitStatus === DEACTIVATED_LATE && DEACTIVATED_LATE === 0x18,
      'the evening band is 0x' + evening.unitStatus.toString(16) + ', expected 0x18');

    const morning = office({ evalLevel: 0 });
    deactivateFamilyCashflowIfUnpaired(ledger, morning, { daypart: 0 });
    assert(morning.unitStatus === DEACTIVATED_EARLY && DEACTIVATED_EARLY === 0x10,
      'the morning band is 0x' + morning.unitStatus.toString(16) + ', expected 0x10');
  },

  'an already-vacant office is not deactivated again'() {
    // specs/facility/OFFICE.md § Exact open/closed bands: 0x00..0x0f is the
    // active band; the deactivation path only fires from inside it. Without the
    // band check a for-rent office would be charged rent it never earned, every
    // third day, forever.
    const ledger = createLedger({ cash: 100_000 });
    const vacant = office({ evalLevel: 0, unitStatus: DEACTIVATED_LATE });
    assert(!deactivateFamilyCashflowIfUnpaired(ledger, vacant), 'a vacant office was closed twice');
    assert(ledger.cash === 100_000, 'a vacant office was clawed back $' + (100_000 - ledger.cash));
  },

  /**
   * The ordering that costs money if it is wrong. specs/TIME.md § 2533 step 2
   * puts deactivate before activate, so an office that fails its evaluation is
   * closed *before* the activation sweep can see it and loses this cycle's
   * rent. Run them the other way and every dying tenant is paid one last time.
   */
  'deactivate runs before activate, so a failing tenant is not paid on its way out'() {
    const ledger = createLedger({ cash: 100_000 });
    ledger.population.office = 6;
    const failing = office({ evalLevel: 0 });

    const report = runLedgerCheckpoint(ledger, { units: [failing] }, 3);

    assert(report.deactivated === 1 && report.activated === 0,
      'the sweep reported ' + report.deactivated + ' closed and ' + report.activated + ' paid');
    assert(ledger.cash === 90_000,
      'the balance is $' + ledger.cash + '; $100,000 would mean it was paid and then clawed back, '
      + 'which is the activate-first ordering');
    assert(ledger.income.office === -10_000,
      'the income ledger reads $' + ledger.income.office + ', expected the clawback alone');
  },

  'a healthy tower nets rent minus upkeep on the cashflow day'() {
    // The loop, end to end: six offices at the default tier against the shaft
    // that serves them.
    const ledger = createLedger({ cash: 0 });
    const units = Array.from({ length: 6 }, () => office());
    const report = runLedgerCheckpoint(ledger, {
      units,
      carriers: [{ mode: 'standard', cars: 2 }],   // -$20,000
    }, 3);

    assert(report.activated === 6, 'only ' + report.activated + ' of 6 offices were paid');
    assert(ledger.income.office === 60_000, 'six tier-1 offices earned $' + ledger.income.office);
    assert(report.expenses === 20_000, 'two standard cars cost $' + report.expenses);
    assert(ledger.cash === 40_000, 'the net for the cycle was $' + ledger.cash + ', expected $40,000');
  },

  'over twelve days, a real clock produces exactly four cashflow passes'() {
    // The cadence and the ledger, wired together and driven by clock.js — not
    // by a hand-written day loop that could carry the same off-by-one twice.
    const ledger = createLedger({ cash: 0 });
    const units = [office()];
    const clock = createClock();
    let passes = 0;

    for (let i = 0; i < TICKS_PER_DAY * 12; i++) {
      advanceClock(clock);
      if (clock.dayTick !== LEDGER_CHECKPOINT_TICK) continue;
      const report = runLedgerCheckpoint(ledger, {
        units,
        carriers: [{ mode: 'standard', cars: 1 }],
      }, clock.dayCounter);
      if (report.cashflow) passes++;
    }

    assert(passes === 4, 'twelve days produced ' + passes + ' cashflow passes, expected 4');
    // $10,000 rent against $10,000 of car, four times: a tower that exactly
    // breaks even. A daily cadence would run this twelve times and still read 0,
    // which is why the pass count is asserted above and not just the balance.
    assert(ledger.cash === 0, 'the balance drifted to $' + ledger.cash);
    assert(ledger.income.office === 10_000 && ledger.expense.elevatorStandard === 10_000,
      'the buckets should hold one cycle, not four: they read $' + ledger.income.office
      + ' / $' + ledger.expense.elevatorStandard);
  },
};
