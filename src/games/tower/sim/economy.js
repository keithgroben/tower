/**
 * Money, exactly as the reference keeps it.
 *
 * Spec: `specs/ECONOMY.md` in full, `specs/TIME.md` § Daily Checkpoints and
 * § Composite Checkpoint Order → `2533 — Ledger Rollover And Expenses`, and
 * `specs/facility/OFFICE.md` § Parity: Rent Payouts / § Parity: Activation And
 * Deactivation. Every number here is theirs.
 *
 * Four things about this are surprising enough to state up front, because each
 * one is a bug waiting to happen if you assume the obvious instead:
 *
 * 1. **Rent is not daily.** Cashflow moves only when `day_counter % 3 == 0`,
 *    at checkpoint 2533. Two days in three, the tower earns and spends nothing.
 *
 * 2. **A fresh game first pays on day 3, not day 0.** Checkpoint 2533 runs
 *    *after* checkpoint 2300 has already incremented the day counter, and a new
 *    game *starts* at tick 2533 rather than arriving there, so the first live
 *    2533 sees `day_counter == 1`. Days 1, 2, then 3 — and 3 is the first
 *    cashflow pass. `specs/TIME.md` § 2533 states this outright because it is
 *    the thing everyone gets wrong.
 *
 * 3. **Office rent tiers run backwards.** Tier 0 is the *most* expensive
 *    ($15,000) and tier 3 the cheapest ($2,000). Tier 1 is the placement
 *    default. Lower number, higher rent, higher tenant dissatisfaction — see
 *    `RENT_READINESS_MODIFIER`.
 *
 * 4. **Stairs and escalators are the same object with one bit flipped.**
 *    `mode_and_span & 1` is the stairs cost bit: clear means the Escalator
 *    branch, which costs $5,000 per scaled unit every pass; set means the
 *    Stairs branch, which costs nothing to run. The EXE build-label table
 *    prices them the other way round ("Stairs - $5000", "Escalator - $20000"),
 *    which is the *construction* cost, not the operating cost. That inversion
 *    is real; `specs/ECONOMY.md` flags it as "strange, but no longer
 *    unresolved".
 *
 * Money is integer dollars throughout. The reference stores cash units where
 * `1 unit = $100` (`specs/ECONOMY.md` § Units); every table below is already
 * multiplied out, and `CASH_UNIT` exists so the two can be reconciled. No
 * floats reach the ledger.
 *
 * ---
 *
 * ## What this module needs from the tower state
 *
 * Nothing is imported from the tower model — it all arrives as parameters, so
 * the two can be built in parallel. The shapes are:
 *
 * @typedef {Object} Ledger
 *   Made by {@link createLedger}. `cash` and `cashCycleBase` are integer
 *   dollars; `income`, `expense` and `population` are plain objects keyed by
 *   {@link INCOME_BUCKETS}, {@link EXPENSE_BUCKETS} and payout-family name.
 * @property {number} cash
 * @property {number} cashCycleBase   cash as it stood at the last rollover
 * @property {Record<string, number>} income
 * @property {Record<string, number>} expense
 * @property {Record<string, number>} population
 *
 * @typedef {Object} ChargeableItem
 *   One placed object with an operating cost. `type` is a key of
 *   {@link CONSTRUCTION_COST}. `count` defaults to 1 and lets several identical
 *   objects arrive as one entry. Parking spaces additionally need `floor`
 *   (logical: 0 is the ground lobby, −1 is B1) plus `leftTile`/`rightTile`.
 * @property {string} type
 * @property {number} [count]
 * @property {number} [floor]
 * @property {number} [leftTile]
 * @property {number} [rightTile]
 *
 * @typedef {Object} Carrier
 *   One elevator shaft. `mode` is `'express' | 'standard' | 'service'`; `cars`
 *   is the car count the pass charges for.
 * @property {string} mode
 * @property {number} cars
 *
 * @typedef {Object} SpecialLink
 *   One stairs/escalator overlay out of the 64-slot special-link table.
 *   `modeAndSpan` is the raw packed byte — bit 0 is the stairs cost bit, the
 *   rest is the unit count. Pass `kind`/`unitCount` instead if the tower model
 *   has already unpacked it.
 * @property {number} [modeAndSpan]
 * @property {string} [kind]        `'stairs' | 'escalator'`
 * @property {number} [unitCount]
 *
 * @typedef {Object} CashflowUnit
 *   One priced facility, as the 3-day activation sweep sees it. Only these
 *   fields are read or written; everything else about the object is the tower
 *   model's business.
 * @property {string} family          a key of {@link RENT_TIERS}, e.g. `'office'`
 * @property {number} rentTier        0..4, default 1
 * @property {boolean} operational    the `occupied_flag`: open and paired
 * @property {number} evalLevel       0 closes the unit; > 0 keeps it open
 * @property {number} unitStatus      band byte: `<= 0x0f` active, `0x10`/`0x18` vacant
 * @property {boolean} [everRented]   an office that never rented never pays
 * @property {boolean} [dormant]      retail only: linked venue record dormant
 * @property {number} [activationTicks]
 * @property {number} [cycleMark]     once-per-cycle guard, written by this module
 *
 * @typedef {Object} TowerCharges
 *   The whole chargeable surface of the tower, for one expense pass.
 * @property {Iterable<ChargeableItem>} [items]
 * @property {Iterable<Carrier>} [carriers]
 * @property {Iterable<SpecialLink>} [links]
 * @property {Iterable<CashflowUnit>} [units]
 * @property {number} [starCount]     1..5, gates the parking rate
 * @property {number} [lobbyHeight]   1, 2 or 3
 */

import { NEW_GAME_TICK } from './clock.js';

// --------------------------------------------------------------------- units

/**
 * `specs/ECONOMY.md` § Units: the reference stores integer cash units of $100.
 * We store dollars, so this is only ever needed to read a raw table value back
 * — the parking formula is the one place a spec figure is quoted in units.
 */
export const CASH_UNIT = 100;

/** Income clamps here. `specs/ECONOMY.md` § Ledgers. */
export const CASH_CAP = 99_999_999;

/** `specs/TIME.md` § New Game Initialization. 20,000 cash units. */
export const STARTING_CASH = 2_000_000;

// ------------------------------------------------------------------- cadence

/**
 * The ledger/expense checkpoint. The same 2533 a new game starts on, which is
 * why the first day opens on a clean ledger — see `clock.js`.
 */
export const LEDGER_CHECKPOINT_TICK = NEW_GAME_TICK;

/** `specs/TIME.md` § 2533: every ledger action tests `day_counter % 3 == 0`. */
export const CASHFLOW_CADENCE_DAYS = 3;

/**
 * The first day a fresh game moves money. Not 0: a new game *begins* at tick
 * 2533 rather than passing through it, and every later 2533 is read after the
 * day counter has already advanced at 2300. So the first live checkpoint sees
 * day 1, and the third sees day 3.
 */
export const FIRST_CASHFLOW_DAY = 3;

/** `specs/TIME.md` § 2533. The one predicate everything on this page hangs off. */
export const isCashflowDay = (dayCounter) => dayCounter % CASHFLOW_CADENCE_DAYS === 0;

// -------------------------------------------------------- construction costs

/**
 * Placed-object type codes, `specs/ECONOMY.md` § Construction Costs. Kept
 * beside the names because the reference indexes every economy table by this
 * byte, and a spec line that says "type 0x16" has to be findable from here.
 *
 * These are object *type* codes, not floor indices — no EXE-to-logical
 * translation applies. (Floors are the ones that need it: the reference quotes
 * EXE indices where `logical = exe - 10`.)
 */
export const TYPE_CODES = {
  floorTile: 0x00,
  elevatorStandard: 0x01,
  hotelSingle: 0x03,
  hotelTwin: 0x04,
  hotelSuite: 0x05,
  restaurant: 0x06,
  office: 0x07,
  condo: 0x09,
  retail: 0x0a,
  parkingSpace: 0x0b,
  fastFood: 0x0c,
  medical: 0x0d,
  security: 0x0e,
  housekeeping: 0x0f,
  secom: 0x11,
  movieTheater: 0x12,
  recyclingCenter: 0x14,
  stairs: 0x16,
  lobby: 0x18,
  escalator: 0x1b,
  partyHall: 0x1d,
  metroStation: 0x1f,
  cathedral: 0x24,
  elevatorExpress: 0x2a,
  elevatorService: 0x2b,
  parkingRamp: 0x2c,
};

/**
 * One-time construction cost in dollars, `specs/ECONOMY.md` § Construction
 * Costs. The spec's table is in cash units; these are × $100.
 *
 * TODO(parity): `metroStation` is `10000` units = $1,000,000 in that table, but
 * `specs/facility/METRO.md` derives the metro stack's actual charge as
 * `3 x 30 x YEN[0]` = $45,000 with a per-object cost of *zero* for
 * `0x1f/0x20/0x21`, and the reference implementation ships $45,000. $1,000,000
 * is suspiciously the metro's $100,000 *operating* expense times ten. Kept as
 * the table states it; the metro stack's real charge is a placement question,
 * not this table's.
 *
 * TODO(parity): the reference implementation prices all three shaft modes at a
 * flat $200,000, contradicting its own table (0x01 $200,000 / 0x2a $400,000 /
 * 0x2b $100,000). The table is binary-derived and wins.
 */
export const CONSTRUCTION_COST = {
  floorTile: 500,
  elevatorStandard: 200_000,
  hotelSingle: 20_000,
  hotelTwin: 50_000,
  hotelSuite: 100_000,
  restaurant: 200_000,
  office: 40_000,
  condo: 80_000,
  retail: 100_000,
  parkingSpace: 3_000,
  fastFood: 100_000,
  medical: 500_000,
  security: 100_000,
  housekeeping: 50_000,
  secom: 100_000,
  movieTheater: 500_000,
  recyclingCenter: 500_000,
  stairs: 5_000,
  lobby: 5_000,
  escalator: 20_000,
  partyHall: 100_000,
  metroStation: 1_000_000,
  cathedral: 3_000_000,
  elevatorExpress: 400_000,
  elevatorService: 100_000,
  parkingRamp: 50_000,
};

/**
 * Per-tile rate charged on the upper floors of a multi-floor lobby, before the
 * `x lobby_height` multiplier.
 *
 * TODO(parity): **this number is not in the reference.** `specs/ECONOMY.md`
 * § Floor Construction Premium says the premium path "multiplies the recovered
 * high-band base rate by `lobby_height`" without ever stating that rate, and
 * `specs/facility/LOBBY.md` points back at ECONOMY.md "for the exact pricing"
 * — the two cite each other in a circle. The reference implementation does not
 * implement the premium at all; it charges flat tile costs. The floor-tile base
 * rate is used here because it is the only recovered per-tile rate in the spec
 * set (`specs/facility/METRO.md` derives the per-floor base as
 * `span x YEN[0]`, i.e. $500/tile), and because `rate x lobby_height` is then
 * $1,000 or $1,500 per tile — genuinely a premium over the normal $500, which
 * is what the spec says the mechanic is for. Change this one constant if the
 * real rate is ever recovered.
 */
export const LOBBY_PREMIUM_FLOOR_RATE = CONSTRUCTION_COST.floorTile;

/**
 * What one floor's worth of tiles costs to build, `specs/ECONOMY.md`
 * § Floor Construction Premium.
 *
 * Floors are logical: 0 is the ground lobby and negatives are basements. The
 * lobby occupies floor 0 through `lobbyHeight - 1`, so floors `1` through
 * `lobbyHeight - 1` are the *upper* lobby floors and take the premium rate;
 * floor 0 itself does not. The spec writes this range in the reference's own
 * "clone logical" floor numbering, which is already ours — no `exe - 10`
 * translation is needed here.
 *
 * A 2-floor lobby charges `premium x 2` per tile on floor 1; a 3-floor lobby
 * charges `premium x 3` per tile on floors 1 and 2.
 */
export function floorConstructionCost({ floor, tiles, lobbyHeight = 1 }) {
  const insideLobby = floor >= 1 && floor < lobbyHeight;
  const rate = insideLobby ? LOBBY_PREMIUM_FLOOR_RATE * lobbyHeight : CONSTRUCTION_COST.floorTile;
  return rate * tiles;
}

// ------------------------------------------------------------- pricing tiers

/**
 * Recurring/realized payout by family and `rent_level`, in dollars.
 *
 * Office: `specs/facility/OFFICE.md` § Parity: Rent Payouts.
 * Hotel: `specs/facility/HOTEL.md` § Stay Payouts (realized on checkout).
 * Condo: `specs/facility/CONDO.md` § Sale And Refund Values (one-time sale,
 *   reversed at the same value on refund).
 * Retail: `specs/facility/COMMERCIAL.md` § Priced Family Row (recurring — the
 *   spec is explicit that this is a rate, not a lump sum).
 *
 * The tiers run backwards on purpose: index 0 is the *highest* price.
 */
export const RENT_TIERS = {
  office: [15_000, 10_000, 5_000, 2_000],
  hotelSingle: [3_000, 2_000, 1_500, 500],
  hotelTwin: [4_500, 3_000, 2_000, 800],
  hotelSuite: [9_000, 6_000, 4_000, 1_500],
  condo: [200_000, 150_000, 100_000, 40_000],
  retail: [20_000, 15_000, 10_000, 4_000],
};

/** `specs/ECONOMY.md` § Pricing Tiers: set at placement for every priced family. */
export const DEFAULT_RENT_TIER = 1;

/** Tier 4: "no payout / unpriced sentinel — set for all non-priced families". */
export const UNPRICED_RENT_TIER = 4;

/**
 * `specs/ECONOMY.md` § Pricing Tiers. Charging more makes the tenant harder to
 * keep: tier 0 adds 30 to the readiness score it must clear, tier 2 discounts
 * it by 30, and tier 3 forces the score to 0 so it always passes. Evaluation
 * owns the use of this; the table lives here because ECONOMY.md owns the table.
 */
export const RENT_READINESS_MODIFIER = [30, 0, -30, null];

/**
 * Payout for one activation/realization event.
 *
 * TODO(parity): the reference implementation clamps `rent_level` into the
 * 4-wide row (`min(level, 3)`), so a priced family at tier 4 would pay tier-3
 * money. `specs/ECONOMY.md` calls tier 4 "no payout", which is the reading
 * taken here. It only matters if a priced family is ever set to 4, which the
 * spec says never happens.
 */
export function payout(family, rentTier = DEFAULT_RENT_TIER) {
  const row = RENT_TIERS[family];
  if (!row || rentTier >= UNPRICED_RENT_TIER || rentTier < 0) return 0;
  return row[rentTier];
}

/**
 * Live population contributed by one active unit, for the population ledger.
 * Office `+6` (`OFFICE.md` § Leasing And Opening), retail `+10`
 * (`COMMERCIAL.md` § Retail Income Timing), condo `+3` (`CONDO.md` § Refund
 * effect, which removes 3), hotel 1/2/3 by room type (`HOTEL.md` § header).
 */
export const POPULATION_BY_FAMILY = {
  office: 6,
  retail: 10,
  condo: 3,
  hotelSingle: 1,
  hotelTwin: 2,
  hotelSuite: 3,
};

// ------------------------------------------------------------------- ledgers

/**
 * Income buckets, `specs/ECONOMY.md` § Ledgers.
 *
 * TODO(parity): `specs/TIME.md` § 2533 step 1 says rollover clears "11 bucket
 * slots each". Only ten income families are identified anywhere in the spec
 * set (these ten, which are also the reference implementation's ten). The
 * eleventh slot is unaccounted for. Rollover clears every bucket it has, so
 * the behaviour is right either way; the count is what is unresolved.
 */
export const INCOME_BUCKETS = [
  'office', 'hotelSingle', 'hotelTwin', 'hotelSuite', 'retail',
  'fastFood', 'restaurant', 'partyHall', 'cinema', 'condo',
];

/**
 * Expense buckets — the eleven charges `specs/ECONOMY.md` § Periodic Expenses
 * lists under "Confirmed per-unit infrastructure expenses", plus parking's
 * own bucket ("the resulting expense is recorded under the parking expense
 * ledger bucket"). That they number exactly eleven is an observation, not a
 * claim about the binary's slot order.
 */
export const EXPENSE_BUCKETS = [
  'elevatorStandard', 'elevatorExpress', 'elevatorService',
  'escalator', 'stairs',
  'security', 'housekeeping', 'recyclingCenter', 'metroStation',
  'parkingRamp', 'parking',
];

const zeroed = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

export function createLedger({ cash = STARTING_CASH } = {}) {
  return {
    cash,
    cashCycleBase: cash,
    income: zeroed(INCOME_BUCKETS),
    expense: zeroed(EXPENSE_BUCKETS),
    population: zeroed(Object.keys(POPULATION_BY_FAMILY)),
  };
}

/**
 * `specs/ECONOMY.md` § Ledgers: "add to cash, clamp so cash never exceeds
 * $99,999,999, mirror into the income ledger". The mirror is not clamped — it
 * records what was realized, not what fitted.
 */
export function addIncome(ledger, bucket, dollars) {
  ledger.cash = Math.min(CASH_CAP, ledger.cash + dollars);
  if (bucket in ledger.income) ledger.income[bucket] += dollars;
  return ledger.cash;
}

/**
 * `specs/ECONOMY.md` § Ledgers: "subtract from cash, mirror into the expense
 * ledger".
 *
 * TODO(parity): no floor. The spec documents the ceiling and says nothing about
 * a floor, and no spec in the set mentions bankruptcy; the reference
 * implementation clamps at 0, but it clamps defensively in three other places
 * where clamping is plainly not a rule (including the income *ledger*). A tower
 * with no income goes negative here, which is the honest reading and the more
 * useful failure to see.
 */
export function addExpense(ledger, bucket, dollars) {
  ledger.cash -= dollars;
  if (bucket in ledger.expense) ledger.expense[bucket] += dollars;
  return ledger.cash;
}

/**
 * The placement charge. Construction deducts cash and does **not** touch the
 * expense ledger: `specs/ECONOMY.md` § Ledgers defines that ledger as "realized
 * *operating* expenses since the last 3-day rollover", and the reference
 * implementation's build path only moves the balance.
 *
 * The funds check is the reference's: reject when `cost > cash`, so a build can
 * spend down to exactly zero but never past it. `free` is the binary's
 * `skipCost` argument to `place_object_on_floor` (`specs/facility/METRO.md`
 * notes metro passes a literal 0 for it, i.e. always charges).
 *
 * @returns {{charged: boolean, cost: number}}
 */
export function chargeConstruction(ledger, cost, { free = false } = {}) {
  if (free) return { charged: true, cost: 0 };
  if (cost > ledger.cash) return { charged: false, cost };
  ledger.cash -= cost;
  return { charged: true, cost };
}

/**
 * Cost of placing one object, including the floor tiles it sits on when a tile
 * span is given. `floor` and `lobbyHeight` only matter for that floor cost.
 */
export function placementCost(type, { tiles = 0, floor = 0, lobbyHeight = 1 } = {}) {
  const object = CONSTRUCTION_COST[type] ?? 0;
  return object + (tiles ? floorConstructionCost({ floor, tiles, lobbyHeight }) : 0);
}

/**
 * `specs/TIME.md` § 2533 step 1: "save `cash_balance` into cycle base, clear 11
 * bucket slots each".
 *
 * This runs *first*, before the pass's own rent and expenses. So the buckets
 * read after checkpoint 2533 hold this cycle's activity, and `cashCycleBase` is
 * the balance as it stood before it — that pairing is what the net-delta report
 * is built from, and it breaks if rollover is moved after the sweeps.
 */
export function rollLedgers(ledger) {
  ledger.cashCycleBase = ledger.cash;
  for (const k of Object.keys(ledger.income)) ledger.income[k] = 0;
  for (const k of Object.keys(ledger.expense)) ledger.expense[k] = 0;
  return ledger;
}

// ---------------------------------------------------------- periodic expenses

/** Per 3-day pass, per car. `specs/ECONOMY.md` § Periodic Expenses. */
export const CARRIER_EXPENSE = {
  express: 20_000,
  standard: 10_000,
  service: 10_000,
};

/**
 * Per 3-day pass, per *scaled* unit. The names are the operating cost, not the
 * build cost — see the note at the top of the file about the inversion.
 */
export const LINK_EXPENSE = {
  escalator: 5_000,
  stairs: 0,
};

/**
 * Per 3-day pass, per placed object. `specs/ECONOMY.md` § Periodic Expenses,
 * "Confirmed per-unit infrastructure expenses".
 *
 * The elevator and escalator/stairs rows of the same YEN table are deliberately
 * absent: the reference reaches them through the carrier remap and the
 * special-link sweep, both of which run separately below. Listing them here too
 * would charge every shaft twice.
 */
export const INFRASTRUCTURE_EXPENSE = {
  security: 20_000,
  housekeeping: 10_000,
  recyclingCenter: 50_000,
  metroStation: 100_000,
  parkingRamp: 10_000,
};

/** Charged through the carrier or special-link sweep, never the item sweep. */
const SWEPT_ELSEWHERE = new Set([
  'elevatorStandard', 'elevatorExpress', 'elevatorService', 'stairs', 'escalator',
]);

/**
 * `specs/ECONOMY.md` § Periodic Expenses, parking formula. Cash units *before*
 * the `/ 10` step, which is why these look like 30 and 100 rather than 3 and 10.
 */
export function parkingExpenseRate(starCount) {
  if (starCount < 3) return 0;
  if (starCount === 3) return 30;
  return 100;
}

/**
 * `(right_tile_index - left_tile_index) * tier_rate / 10`, in cash units, then
 * into dollars. Effective per-tile charges are $0, $300 and $1,000.
 *
 * TODO(parity): the span is written exactly as above in the spec — a difference,
 * not an inclusive width. The reference implementation uses `right - left + 1`
 * and then scales by 1,000 instead of 100, which makes its parking bill ten
 * times the spec's stated "$300 per tile". The spec's own worked figures are
 * followed here.
 */
export function parkingExpense({ leftTile, rightTile }, starCount) {
  const rate = parkingExpenseRate(starCount);
  if (rate === 0) return 0;
  return Math.trunc(((rightTile - leftTile) * rate) / 10) * CASH_UNIT;
}

/**
 * Unpack a special link. `mode_and_span & 1` is the stairs cost bit — clear is
 * the Escalator branch, set is the Stairs branch — and the rest of the byte is
 * the unit count.
 *
 * The charge is scaled by `(unit_count >> 1) + 1`, so a link is never free of
 * the scale factor: even `unit_count == 0` charges one unit.
 *
 * TODO(parity): the scale factor is `(unit_count >> 1) + 1` in both
 * `specs/ECONOMY.md` § Periodic Expenses ("scaled by (unit_count / 2 + 1)") and
 * `specs/TIME.md` § 2533 step 3. The reference implementation instead uses
 * `max(1, unit_count)`, which agrees only at `unit_count` 1 and 2. The spec says
 * it twice, so the spec wins.
 */
export function linkExpense(link) {
  const packed = link.modeAndSpan;
  const kind = link.kind ?? ((packed & 1) === 1 ? 'stairs' : 'escalator');
  const unitCount = link.unitCount ?? (packed >> 1);
  const scaled = (unitCount >> 1) + 1;
  return { kind, unitCount, scaled, dollars: LINK_EXPENSE[kind] * scaled };
}

/**
 * `specs/TIME.md` § 2533 step 3 — `apply_periodic_operating_expenses`. Sweeps
 * floors, then carriers, then special links, in that order.
 *
 * Only called on a cashflow day; the caller ({@link runLedgerCheckpoint}) owns
 * that gate.
 *
 * @param {Ledger} ledger
 * @param {TowerCharges} tower
 * @returns {number} total dollars charged
 */
export function applyPeriodicOperatingExpenses(ledger, tower = {}) {
  const { items = [], carriers = [], links = [], starCount = 1, lobbyHeight = 1 } = tower;
  const before = ledger.cash;

  // --- floors -------------------------------------------------------------
  for (const item of items) {
    const count = item.count ?? 1;

    if (item.type === 'parkingSpace') {
      // The upper floors of a multi-floor lobby are exempt — logical floors
      // 1 through lobbyHeight-1, in the reference's own "clone logical"
      // numbering, which is ours. The skip is operating-expense only; parking
      // demand is still generated there.
      const floor = item.floor ?? 0;
      if (floor >= 1 && floor < lobbyHeight) continue;
      addExpense(ledger, 'parking', parkingExpense(item, starCount) * count);
      continue;
    }

    if (SWEPT_ELSEWHERE.has(item.type)) continue;
    const rate = INFRASTRUCTURE_EXPENSE[item.type];
    if (!rate) continue;
    addExpense(ledger, item.type, rate * count);
  }

  // --- carriers -----------------------------------------------------------
  // "Remap carrier mode to expense type, then charge the table value times
  // unit_record_count." TODO(parity): the reference implementation counts only
  // *active* cars; TIME.md says the record count. Whichever the caller passes
  // as `cars` is what gets billed.
  for (const carrier of carriers) {
    const rate = CARRIER_EXPENSE[carrier.mode];
    if (rate === undefined) continue;
    const bucket = carrier.mode === 'express' ? 'elevatorExpress'
      : carrier.mode === 'service' ? 'elevatorService' : 'elevatorStandard';
    addExpense(ledger, bucket, rate * carrier.cars);
  }

  // --- special links ------------------------------------------------------
  for (const link of links) {
    const { kind, dollars } = linkExpense(link);
    addExpense(ledger, kind, dollars);
  }

  return before - ledger.cash;
}

// --------------------------------------------------- activation/deactivation

/**
 * `specs/facility/OFFICE.md` § Parity: Activation And Deactivation —
 * "activation increments `activation_tick_count` up to a cap of 120; this is
 * cumulative, not per-day, and resets to 0 only on deactivation".
 */
export const ACTIVATION_TICK_CAP = 120;

/**
 * `specs/DATA-MODEL.md` § state bands and `OFFICE.md` § Exact open/closed bands:
 * `0x00..0x0f` is open/active, `0x10` is deactivated in the early-day regime and
 * `0x18` in the late-day regime.
 */
export const ACTIVE_BAND_MAX = 0x0f;
export const DEACTIVATED_EARLY = 0x10;
export const DEACTIVATED_LATE = 0x18;

const isActive = (unit) => unit.unitStatus <= ACTIVE_BAND_MAX;

/**
 * Offices, alone, will not pay until they have rented at least once. A never
 * rented office — placed somewhere no worker can route to — sits at the initial
 * mark forever and is skipped here, which is what stops an unreachable tower
 * from collecting rent. `OFFICE.md`: rent only credits through
 * `activate_office_cashflow` from the per-sim state-`0x20` path.
 */
const REQUIRES_PRIOR_RENTAL = new Set(['office']);

/**
 * The money half of deactivation: subtract the unit's recurring contribution
 * back out of cash and take its people off the population ledger.
 *
 * Split out because a family that owns its own closure path — `sim/office.js`
 * resets the six workers to `seekingWork`, writes the vacant band and marks the
 * room dirty — must not also own a second copy of the money. That family calls
 * this from its `onVacate` seam; {@link deactivateFamilyCashflowIfUnpaired}
 * calls it for families that have no bespoke path. One rule, two callers.
 *
 * `specs/facility/OFFICE.md` § Deactivation trigger: deactivation "subtracts
 * the office's recurring contribution from cash and removes 6 from the
 * population ledger".
 *
 * @returns {number} dollars reversed
 */
export function reverseCashflowOnDeactivation(ledger, unit) {
  const amount = payout(unit.family, unit.rentTier ?? DEFAULT_RENT_TIER);
  ledger.cash -= amount;
  if (unit.family in ledger.income) ledger.income[unit.family] -= amount;

  const pop = POPULATION_BY_FAMILY[unit.family] ?? 0;
  if (unit.family in ledger.population) ledger.population[unit.family] -= pop;
  return amount;
}

/**
 * `deactivate_family_cashflow_if_unpaired`, `specs/TIME.md` § 2533 step 2 and
 * `specs/facility/OFFICE.md` § Deactivation trigger.
 *
 * A zero `evalLevel` — and only zero — closes an occupied unit. A low but
 * nonzero one changes the operational score and keeps the tenant: "an occupied
 * office should not vacate because of one bad commute".
 *
 * Deactivation subtracts the unit's recurring contribution back out of cash,
 * removes its population, clears the occupied flag and the activation count,
 * and writes the vacant band. Checkpoint 2533 sits in daypart 6, so `daypart`
 * defaults to the late-day regime and the band written is `0x18`.
 *
 * @returns {boolean} whether the unit was deactivated
 */
export function deactivateFamilyCashflowIfUnpaired(ledger, unit, { daypart = 6 } = {}) {
  if (unit.evalLevel !== 0) return false;
  if (!isActive(unit)) return false;

  reverseCashflowOnDeactivation(ledger, unit);

  unit.unitStatus = daypart >= 4 ? DEACTIVATED_LATE : DEACTIVATED_EARLY;
  unit.operational = false;
  unit.activationTicks = 0;
  return true;
}

/**
 * `activate_family_cashflow_if_operational`, `specs/TIME.md` § 2533 step 2.
 *
 * `cycleMark` is the once-per-cycle guard the reference shares with the per-sim
 * handlers: it is written as `day_counter + 1`, so a unit that already paid on
 * this pass — via a worker-arrival reopen earlier the same day — is not paid
 * twice. `day_counter + 1` rather than `day_counter` because 0 is the
 * never-rented value and has to stay distinguishable from day 0.
 *
 * Activation pays rent and ages the unit. It does **not** add population: the
 * `+6` belongs to the reopen path, which runs when a worker actually arrives.
 *
 * @returns {boolean} whether the unit was paid
 */
export function activateFamilyCashflowIfOperational(ledger, unit, dayCounter) {
  const guard = dayCounter + 1;
  if (unit.cycleMark === guard) return false;
  if (REQUIRES_PRIOR_RENTAL.has(unit.family) && !unit.everRented) return false;
  if (!unit.operational) return false;
  if (unit.dormant) return false;

  unit.cycleMark = guard;
  unit.activationTicks = Math.min(ACTIVATION_TICK_CAP, (unit.activationTicks ?? 0) + 1);
  addIncome(ledger, unit.family, payout(unit.family, unit.rentTier ?? DEFAULT_RENT_TIER));
  return true;
}

// ------------------------------------------------------------- checkpoint 2533

/**
 * The whole of checkpoint 2533, in the reference's order. Call it when
 * `day_tick === LEDGER_CHECKPOINT_TICK`, with the day counter as checkpoint
 * 2300 already left it earlier in the same day.
 *
 * `specs/TIME.md` § 2533:
 *
 *   1. if `day_counter % 3 == 0`: roll the ledgers **first**
 *   2. for all objects: `recompute_object_operational_status`; then, on a
 *      cashflow day, `deactivate_family_cashflow_if_unpaired`, then
 *      `activate_family_cashflow_if_operational`
 *   3. on a cashflow day: `apply_periodic_operating_expenses`
 *   4. rebuild entity tile spans   — the tower model's, not ours
 *   5. reset sim state             — the tower model's, not ours
 *
 * The order inside step 2 is load-bearing and easy to get backwards. Deactivate
 * runs first, so a unit that fails its evaluation this pass is closed *before*
 * the activation sweep can see it: it loses its rent rather than being paid and
 * then closed. Reversing the two pays every dying tenant one last time.
 *
 * Step 1 running before steps 2 and 3 is equally load-bearing — see
 * {@link rollLedgers}.
 *
 * `recompute` is the tower model's operational-status pass. It runs for every
 * unit every day, cashflow day or not; only the two cashflow calls are gated.
 *
 * `deactivate` is the closure seam. It defaults to
 * {@link deactivateFamilyCashflowIfUnpaired}; a family that owns its own
 * closure path passes its own, which must still return whether it closed the
 * unit and must reverse the money through
 * {@link reverseCashflowOnDeactivation}. The seam exists so the *order* stays
 * here — deactivate before activate — while the family keeps its state writes.
 *
 * @param {Ledger} ledger
 * @param {TowerCharges & {recompute?: (unit: CashflowUnit) => void,
 *   deactivate?: (ledger: Ledger, unit: CashflowUnit, opts: {daypart: number}) => boolean}} tower
 * @param {number} dayCounter
 * @returns {{cashflow: boolean, deactivated: number, activated: number, expenses: number}}
 */
export function runLedgerCheckpoint(ledger, tower, dayCounter) {
  const {
    units = [], recompute, daypart = 6,
    deactivate = deactivateFamilyCashflowIfUnpaired,
  } = tower;
  const cashflow = isCashflowDay(dayCounter);

  if (cashflow) rollLedgers(ledger);

  let deactivated = 0;
  let activated = 0;
  for (const unit of units) {
    if (recompute) recompute(unit);
    if (!cashflow) continue;
    if (deactivate(ledger, unit, { daypart })) deactivated++;
    if (activateFamilyCashflowIfOperational(ledger, unit, dayCounter)) activated++;
  }

  const expenses = cashflow ? applyPeriodicOperatingExpenses(ledger, tower) : 0;
  return { cashflow, deactivated, activated, expenses };
}
