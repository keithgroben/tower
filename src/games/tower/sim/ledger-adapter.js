/**
 * Where the tower meets the money.
 *
 * `sim/economy.js` was written against a described interface — a ledger, an
 * iterable of chargeable items, carriers, links, cashflow units — so that it
 * and `sim/state.js` could be built in parallel without either guessing at the
 * other. This file is the bridge that was deliberately not invented then. It is
 * the only place that knows both vocabularies, and nothing else should learn a
 * second one.
 *
 * ## The one rule this file exists to enforce
 *
 * **There is exactly one cash number, and it lives on the tower.**
 *
 * Before this, `ui/main.js` drew `tower.cash` while `sim/actions.js` charged
 * `ledger.cash`, and no code anywhere built a ledger — so a build would have
 * spent money the HUD never saw. That is the same class of defect as
 * `routeStartTick` versus `lastTripTick`: two names for one quantity, both
 * modules internally correct, and the seam between them carrying nothing.
 *
 * {@link ledgerFor} therefore returns a **view**, not a copy: `cash` and
 * `cashCycleBase` are accessors onto the tower's own fields and the three
 * bucket objects are the tower's own objects. Writing through the view writes
 * the tower. There is no synchronise step, because there is nothing to
 * synchronise — which is the only version of this that cannot drift.
 *
 * ## Field names across the seam, spelled out
 *
 * `economy.js` names things as the reference's specs do; `state.js` names them
 * as the tower does. Every translation is in {@link cashflowUnitFor}, as a
 * getter/setter pair so the economy's writes land on the real object:
 *
 * | economy.js        | state.js              |
 * |-------------------|-----------------------|
 * | `family` (name)   | `family` (code)       |
 * | `rentTier`        | `rentLevel`           |
 * | `operational`     | `isRented(unitStatus)` **and** `occupiedFlag` |
 * | `unitStatus`      | `unitStatus`          |
 * | `evalLevel`       | `evalLevel`           |
 * | `everRented`      | `everRented`          |
 * | `activationTicks` | `activationTickCount` |
 * | `cycleMark`       | `cashflowCycleMark`   |
 *
 * `everRented` is the one that is set nowhere else: `sim/office.js` writes it
 * in `seekingWorkResult` when a worker's route to the office actually resolves.
 * An office that never rents is an office no rent is ever paid for, and that is
 * the whole point of the flag.
 */
import { CARRIER_MODE } from './elevators.js';
import { FAMILY, isRented } from './state.js';
import { deactivateIfFailing, offices, recomputeOfficeOperationalStatus } from './office.js';
import { resetFacilitySimTripCounters } from './stress.js';
import {
  EXPENSE_BUCKETS, INCOME_BUCKETS, POPULATION_BY_FAMILY, TYPE_CODES,
  activateFamilyCashflowIfOperational, isCashflowDay, reverseCashflowOnDeactivation,
  runLedgerCheckpoint,
} from './economy.js';

// ------------------------------------------------------------- the ledger

const seedBuckets = (into, keys) => {
  for (const key of keys) if (!(key in into)) into[key] = 0;
  return into;
};

/**
 * A ledger view over the tower. Cheap; make one per call site if you like.
 *
 * The bucket objects are seeded on first use because `economy.js` records into
 * a bucket only when the key already exists (`bucket in ledger.income`) — a
 * deliberate guard against typo'd bucket names, and one that would otherwise
 * silently swallow every dollar of a tower whose ledgers start as `{}`.
 */
export function ledgerFor(tower) {
  tower.incomeLedger ??= {};
  tower.expenseLedger ??= {};
  tower.populationLedger ??= {};
  seedBuckets(tower.incomeLedger, INCOME_BUCKETS);
  seedBuckets(tower.expenseLedger, EXPENSE_BUCKETS);
  seedBuckets(tower.populationLedger, Object.keys(POPULATION_BY_FAMILY));

  return {
    get cash() { return tower.cash; },
    set cash(value) { tower.cash = value; },
    get cashCycleBase() { return tower.cycleBaseCash; },
    set cashCycleBase(value) { tower.cycleBaseCash = value; },
    income: tower.incomeLedger,
    expense: tower.expenseLedger,
    population: tower.populationLedger,
  };
}

// -------------------------------------------------------------- the units

/**
 * Tower family code → the payout family `economy.js` prices.
 *
 * Only priced families appear. A lobby earns nothing and is absent, so
 * {@link cashflowUnitFor} on one yields a unit whose `family` is `undefined`,
 * which `payout()` answers with `0` — the safe direction.
 *
 * `state.js` maps `fastFood` to family 6; `specs/ECONOMY.md` § Construction
 * Costs makes 6 the Restaurant and `0x0c` Fast Food. Neither has a payout row
 * yet, so nothing turns on it today — but it will the day commercial lands, and
 * it is not this file's to fix.
 */
export const PAYOUT_FAMILY = {
  [FAMILY.office]: 'office',
  [FAMILY.condo]: 'condo',
  [FAMILY.retail]: 'retail',
};

/**
 * A live `CashflowUnit` view over a placed object. Getters and setters, not a
 * copy: `activate_family_cashflow_if_operational` writes `activationTicks` and
 * `cycleMark`, and those writes have to reach the object the tower keeps or the
 * once-per-cycle guard resets every pass and every office is paid twice.
 *
 * `occupants` rides along for the office paths, which need the worker list.
 */
export function cashflowUnitFor(object, occupants = []) {
  return {
    object,
    occupants,
    family: PAYOUT_FAMILY[object.family],
    get rentTier() { return object.rentLevel; },
    set rentTier(value) { object.rentLevel = value; },
    /**
     * ⚠️ **`operational` is the lease, and `occupiedFlag` is not the lease.**
     *
     * `sim/office.js` says so in its own header: the flag "does not mean
     * 'rented'. It means *this facility's tenants are being measured*". It is
     * set by the daily recompute the moment `eval_level` is nonzero — which is
     * the bootstrap that lets a vacant office be let at all, because an office
     * with no trips scores 0, the best grade, and opens its own rental gate.
     *
     * Reading it as "let" pays rent on empty rooms. Measured: with the tower's
     * only lift removed, all 36 offices closed correctly on the first cashflow
     * day after — and were then paid $360,000 a cycle for ever after, because
     * each vacated office had no trips, therefore a perfect score, therefore the
     * flag back on. A tower with no lift and no tenants, out-earning a working
     * one. `sim/state.js`'s `population()` carries a warning about this exact
     * flag for this exact reason.
     *
     * So the gate is the lease band — `unit_status <= 0x0f`,
     * `specs/facility/OFFICE.md` § Exact open/closed bands — and the flag on
     * top of it, which is the reference's own condition
     * (`activate_family_cashflow_if_operational` skips a stress-vacated unit
     * whose flag has been cleared).
     */
    get operational() { return isRented(object.unitStatus) && object.occupiedFlag === true; },
    set operational(value) { object.occupiedFlag = value; },
    get evalLevel() { return object.evalLevel; },
    set evalLevel(value) { object.evalLevel = value; },
    get unitStatus() { return object.unitStatus; },
    set unitStatus(value) { object.unitStatus = value; },
    get everRented() { return object.everRented === true; },
    set everRented(value) { object.everRented = value; },
    get activationTicks() { return object.activationTickCount; },
    set activationTicks(value) { object.activationTickCount = value; },
    get cycleMark() { return object.cashflowCycleMark; },
    set cycleMark(value) { object.cashflowCycleMark = value; },
  };
}

// --------------------------------------------------------- what gets charged

/** Placed-object type code → the name `economy.js`'s tables are keyed by. */
const ECONOMY_TYPE_BY_CODE = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([name, code]) => [code, name]),
);

/**
 * Every placed object, as a chargeable item.
 *
 * Everything is offered rather than pre-filtered to the things that currently
 * cost money: `applyPeriodicOperatingExpenses` skips a type with no rate, so
 * the day someone places a security office it starts costing $20,000 a pass
 * with no further wiring. A filter here would be a second list of "things that
 * have upkeep", and the second list is the one that goes stale.
 */
export function chargeableItems(tower) {
  const out = [];
  for (const object of tower.objects.values()) {
    const type = ECONOMY_TYPE_BY_CODE[object.type ?? object.family];
    if (!type) continue;
    out.push({ type, floor: object.floor, leftTile: object.left, rightTile: object.right });
  }
  return out;
}

const CARRIER_EXPENSE_MODE = {
  [CARRIER_MODE.EXPRESS]: 'express',
  [CARRIER_MODE.STANDARD]: 'standard',
  [CARRIER_MODE.SERVICE]: 'service',
};

/**
 * Carriers, priced per car.
 *
 * `cars.length` is the record count, which is what `specs/TIME.md` § 2533
 * step 3 charges (`unit_record_count`). The reference *implementation* counts
 * only cars flagged active; the two differ the moment a car is out of service,
 * and the spec is followed here. Marked in `economy.js` as a parity item.
 */
export const chargeableCarriers = (tower) =>
  (tower.carriers ?? []).map((carrier) => ({
    mode: CARRIER_EXPENSE_MODE[carrier.mode],
    cars: carrier.cars.length,
  }));

/**
 * Stairs and escalators. `sim/routing.js` builds these with
 * `flags = ((floorsSpanned - 1) << 1) | stairsBit`, which is the reference's
 * `mode_and_span` byte exactly — bit 0 the stairs cost bit, the rest the unit
 * count — so `linkExpense` reads it with no translation.
 */
export const chargeableLinks = (tower) =>
  (tower.segments ?? []).map((segment) => ({ modeAndSpan: segment.flags }));

// ------------------------------------------------------- the family seams

/**
 * The two moments a family moves money outside the 3-day sweep. Pass these into
 * `officeFamilyHandler`'s `ctx` and into `deactivateIfFailing`.
 *
 * **`onRent` is the reopen path**, and it is where the `+6` belongs.
 * `specs/facility/OFFICE.md` § Parity: Activation And Deactivation splits the
 * two deliberately: "fresh reopen after a close resets `unit_status` to 0, adds
 * `+6` to the population ledger", while the 3-day sweep only realizes cashflow.
 * Putting the `+6` in the sweep instead would add six people every third day for
 * the life of the tenant, and the star thresholds read that ledger.
 *
 * The payment itself goes through the same guarded
 * `activate_family_cashflow_if_operational` the sweep uses, so an office that
 * rents at nine in the morning on a cashflow day is paid once, not twice — the
 * `cycleMark` guard is what makes both paths safe to have.
 */
export function officeCashflowHooks(tower) {
  const ledger = ledgerFor(tower);
  return {
    onRent(_tower, object) {
      const unit = cashflowUnitFor(object);
      if (!unit.family) return;
      ledger.population[unit.family] += POPULATION_BY_FAMILY[unit.family] ?? 0;
      activateFamilyCashflowIfOperational(ledger, unit, tower.clock.dayCounter);
    },
    onVacate(_tower, object) {
      const unit = cashflowUnitFor(object);
      if (!unit.family) return;
      reverseCashflowOnDeactivation(ledger, unit);
    },
  };
}

// ------------------------------------------------------- checkpoint 2533

/**
 * The checkpoint-2533 body, wired to a real tower.
 *
 * `specs/TIME.md` § 2533 owns the order and `economy.js`'s
 * `runLedgerCheckpoint` enforces it; this supplies the four seams that need to
 * know what an office is.
 *
 * ## The trip-counter reset: measure, act, THEN clear
 *
 * Two constraints on this reset, and they pull in opposite directions. Both are
 * load-bearing and each one was paid for with a run that looked fine.
 *
 * **It must not be gated on `occupied_flag`.** Gating it deadlocks the tower: a
 * failing office is deactivated, which clears the flag, which blocks the reset,
 * which freezes its stress, which keeps its grade at 0 forever — so the flag
 * never returns and not one of its workers ever tries again. Measured before
 * this file existed: every office dead from day 2 of a nine-day run, trips
 * frozen. `specs/FACILITIES.md` § occupied_flag says the flag is "re-set every
 * 3 days for offices/condos/retail", and that is what makes a tower
 * RECOVERABLE — clear the history, re-measure from zero, and a tower whose
 * lifts got better gets its tenants back within a cycle.
 *
 * **It must run after the measurement, not before.** It used to run before,
 * which was invisible while `deactivateIfFailing` ran every day: days 4 and 5
 * still measured a real history and caught the failures. `specs/TIME.md` § 2533
 * gates deactivation to the 3-day cadence, and the moment it is gated correctly
 * the old order becomes a deadlock of its own — the only days that can close an
 * office are the days whose history was just wiped, so the score is always 0,
 * which is the BEST grade, and no office can ever fail.
 *
 * Measured, with the reset before the recompute: removing the tower's only lift
 * on day 6 left all 36 offices let through day 16 and *raised* the cash delta
 * from $330,000 to $360,000 a cycle, because the cars stopped costing anything
 * and no tenant ever left. A tower with no lift at all, earning more than a
 * working one. That is `CLAUDE.md`'s own warning — a metric that improves while
 * the thing it measures gets worse.
 *
 * So: recompute against the real three days, act on it, and only then clear for
 * the next cycle. That is also the reference's order — it resets inside
 * `activate_family_cashflow_if_operational`, which runs after deactivation —
 * with the one difference that ours resets every office rather than only the
 * operational ones, which is the ungating the first constraint demands.
 *
 * ## Closure stays with the family
 *
 * `deactivate` is `sim/office.js`'s `deactivateIfFailing`, not the economy's
 * generic path, because the office owns state the economy has no business
 * writing — resetting its six workers to `seekingWork` so the room can be let
 * again. The money half is shared: `onVacate` calls the same
 * `reverseCashflowOnDeactivation` the generic path calls. One rule, one copy.
 *
 * @returns {{cashflow: boolean, deactivated: number, activated: number, expenses: number}}
 */
export function runTowerLedgerCheckpoint(tower) {
  const ledger = ledgerFor(tower);
  const hooks = officeCashflowHooks(tower);
  const dayCounter = tower.clock.dayCounter;
  const cashflow = isCashflowDay(dayCounter);
  const units = offices(tower).map(({ object, occupants }) => cashflowUnitFor(object, occupants));

  const report = runLedgerCheckpoint(ledger, {
    units,

    recompute(unit) {
      recomputeOfficeOperationalStatus(tower, unit.object, unit.occupants);
    },

    // The same `onVacate` the browser hands the family machine, not a second
    // copy of it — `officeCashflowHooks` is the one definition of what vacating
    // costs, and both callers reach it through this one function.
    deactivate: (_ledger, unit) =>
      deactivateIfFailing(tower, unit.object, unit.occupants, hooks),

    items: chargeableItems(tower),
    carriers: chargeableCarriers(tower),
    links: chargeableLinks(tower),
    starCount: tower.starCount,
    lobbyHeight: tower.lobbyHeight,
    daypart: tower.clock.daypart,
  }, dayCounter);

  // Last, and for every office whatever its fate: the three days just judged
  // are spent. See the note above — before the measurement this is a deadlock,
  // and gated on the occupied flag it is a different one.
  if (cashflow) for (const unit of units) resetFacilitySimTripCounters(unit.occupants);

  return report;
}
