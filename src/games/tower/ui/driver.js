/**
 * **The loop, wired.** One definition, used by every driver.
 *
 * Family 7 asks the router whether a worker can get from the lobby to its
 * office. If the route resolves the office rents; if it does not, the worker
 * waits and tries again and the office stays FOR RENT. Nothing here decides
 * occupancy — transport does.
 *
 * ## Why this is its own file
 *
 * It lived inside `ui/main.js`, which touches `document` at module scope and
 * therefore cannot be imported by anything — not a test, not the harness. So
 * the headless harness had to *restate* the wiring to measure the game, and a
 * harness that restates the wiring is measuring a copy: the day the two drift,
 * it reports confidently on a game nobody is playing.
 *
 * The alternative to a shared file is a test that compares two copies for
 * drift, which is a guard around a duplication instead of the removal of one.
 * `CLAUDE.md` already keeps "rules written in multiple places" on its list.
 *
 * Nothing in here touches the DOM, so it is importable from Node.
 */
import { FAMILY } from '../sim/state.js';
import { officeArrival, officeFamilyHandler } from '../sim/office.js';
import { commercialArrival, commercialFamilyHandler } from '../sim/commercial.js';
import {
  CONDO_RESET_TICK, condoArrival, condoDailyReset, condoFamilyHandler,
} from '../sim/condo.js';
import {
  HOTEL_SALE_RESET_TICK, HOTEL_SWEEP_TICK, hotelArrival, hotelDailyReset, hotelFamilyHandler,
  hotelMiddaySweep, hotelSaleCountReset,
} from '../sim/hotel.js';
import { housekeepingArrival, housekeepingFamilyHandler } from '../sim/housekeeping.js';
import { condoCashflowHooks, hotelCashflowHooks, officeCashflowHooks } from '../sim/ledger-adapter.js';
import { resolveRouteBetweenFloors } from '../sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, applyQueueFullDelay, recordNoRouteFailure, stampRouteStart,
} from '../sim/stress.js';
import { makeTowerScheduler } from './tick.js';

/**
 * Route delays → stress, the one seam that must not double-count.
 *
 * The actor arrives as the second argument because the router does not echo it
 * onto the delay. Reading `delay.actor` instead dropped one hundred per cent of
 * delays while every module involved looked correctly wired, and stress sat at
 * zero for a tower that could not move anybody.
 *
 * Every kind the router can emit is handled. An unhandled kind is a silently
 * unpriced delay, which is the same failure with a smaller blast radius.
 */
export function makeDelayPricer(tower) {
  return function applyRoutingDelay(delay, actor) {
    if (!actor) return;
    switch (delay.kind) {
      case 'no-route': return void recordNoRouteFailure(actor);
      case 'local-transit': return void applyLocalSegmentDelay(actor, delay.modeAndSpan);
      case 'queue-full': return void applyQueueFullDelay(actor);
      case 'distance': return void applyDistancePenalty(actor, {
        heightMetricDelta: delay.heightMetricDelta,
        emitDistanceFeedback: true,          // the router only emits when gated in
        carrierMode: delay.carrierMode,
      });
      case 'boarding': {
        // spec/DEVIATIONS.md A9: boarding re-stamps. The accumulate measures the
        // WAIT on the floor and clears the stamp; without re-arming it the
        // arrival rebase reads `last_trip_tick == 0` and charges the entire day
        // tick, which clamps to 300. The symptom is uniformly maximal stress on
        // every rider, insensitive to how good the lifts are — it reads as "the
        // clamp is working" rather than as a bug. Omitting this line produced
        // exactly that, and the predicted symptom is how it was found.
        //
        // Service carriers are exempt: the accumulate returns early for them and
        // leaves the stamp intact, so there is nothing to re-arm. Both halves
        // move together for the same reason.
        accumulateElapsedDelayIntoCurrentSim(actor, tower.clock.dayTick, {
          sourceFloor: delay.sourceFloor,
          lobbyHeight: tower.lobbyHeight,
          carrierMode: delay.carrierMode,
        });
        if (delay.carrierMode !== CARRIER_SERVICE) stampRouteStart(actor, tower.clock.dayTick);
        return;
      }
      default: return;                        // requeue-failure and invalid-venue cost 0
    }
  };
}

/**
 * The scheduler the game runs on, for a given world.
 *
 * ## `observe`
 *
 * Two optional callbacks, `route(result)` and `delay(kind)`, invoked *beside*
 * the real handling and never in place of it. They exist because the tests want
 * to count what crossed the seam — "the delay seam carries traffic in both
 * directions" is only meaningful if something counted — and the alternative was
 * `test/integration.test.js` restating this whole composition to slip its
 * counters in.
 *
 * It had already restated it, and the copy had already drifted: the moment fast
 * food and the lunch trips landed, the fixture was running a tower where nobody
 * goes to lunch, and reporting on it confidently. It caught that itself, by
 * asserting its own fixture reached the state it was about to test — which is
 * the only reason this is a note about a seam rather than a bug hunt.
 *
 * Observers must not mutate. Nothing enforces that; it is why they are two
 * narrow callbacks rather than a general hook.
 *
 * @param {{tower: object, ledger: object}} world
 * @param {{observe?: {route?: Function, delay?: Function}}} [options]
 * @returns {{scheduler: object, applyRoutingDelay: Function, cashflow: object}}
 */
export function makeDriver(world, { observe } = {}) {
  const { tower } = world;
  // The two moments money moves outside checkpoint 2533: an office rents, or an
  // office is vacated. Both go through `sim/ledger-adapter.js` onto the tower's
  // own `cash`, which is the number the HUD draws — one balance, not two.
  const cashflow = officeCashflowHooks(tower);
  const condoCashflow = condoCashflowHooks(tower);
  const hotelCashflow = hotelCashflowHooks(tower);
  const price = makeDelayPricer(tower);

  // The observers wrap, they do not replace. A `route` that forgot to return
  // the result, or a `delay` that swallowed the pricing, would be a fixture
  // quietly changing the game it is measuring.
  const resolveRoute = (t, actor, from, to, clock, options) => {
    const result = resolveRouteBetweenFloors(t, actor, from, to, clock, options);
    observe?.route?.(result);
    return result;
  };
  const applyRoutingDelay = (delay, actor) => {
    observe?.delay?.(delay.kind, delay);
    price(delay, actor);
  };

  // One handler serves all three room families; the family only decides how many
  // guests the room holds and which payout row it is paid from.
  const hotelHandler = hotelFamilyHandler({
    resolveRoute,
    onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
    // **The check-in and the payment, and the payment is the only one that is
    // money.** `sim/hotel.js` calls `onCheckIn` the instant the first guest
    // reaches the room (population `+1` / `+2`) and `onCheckout` when the last
    // guest's route to the lobby is accepted (the stay's payout, population back
    // out). Unwired, a hotel fills and empties for nothing.
    onCheckIn: hotelCashflow.onCheckIn,
    onCheckout: hotelCashflow.onCheckout,
  });
  // The arrival that books a room needs the same hooks the dispatch does: a lift
  // delivers the guest, and the carrier's callback has no `ctx` of its own.
  const hotelArrives = (actor, floor) => hotelArrival(tower, actor, floor, hotelCashflow);

  const scheduler = makeTowerScheduler(tower, {
    [FAMILY.hotelSingle]: hotelHandler,
    [FAMILY.hotelTwin]: hotelHandler,
    [FAMILY.hotelSuite]: hotelHandler,
    /**
     * The six staff of every housekeeping facility. They route in housekeeping
     * mode (stairs, then service elevators — `sim/housekeeping.js`), clean a dirty
     * room on arrival, and never touch a ledger: no `onRent`, no `onCheckout`.
     * The cleaning is `cleanHotelRoom`, which writes the room's own band; the
     * 1600 sweep (below) is what takes the strike when nobody came.
     */
    [FAMILY.housekeeping]: housekeepingFamilyHandler({
      resolveRoute,
      onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
    }),
    [FAMILY.office]: officeFamilyHandler({
      resolveRoute,
      // Every delay the router reports is priced by the stress pipeline, which
      // owns those constants. The router reports events; it never prices them.
      onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
      // The rent moment. `sim/office.js` sets `everRented` and calls this the
      // instant a worker's route resolves; the hook pays the first rent and adds
      // the six workers to the population ledger. The payment is guarded by the
      // same once-per-cycle mark checkpoint 2533 uses, so an office that rents on
      // a cashflow day is paid once, not twice.
      onRent: cashflow.onRent,
    }),
    /**
     * The other half of the lunch trip. A fast food's 48 customers are demand
     * generators in their own right: they ride the same lifts the office
     * workers do, capped each day by the venue's capacity, and the venue is
     * paid at closing for however many of them arrived.
     *
     * No `onRent` — a venue is not let. Its money is the daily closure payout
     * in `sim/ledger-adapter.js`, keyed on the day's visitor count.
     */
    [FAMILY.fastFood]: commercialFamilyHandler({
      resolveRoute,
      onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
    }),
    // **The sale moment, and the only one.** `sim/condo.js` calls `onSale` the
    // instant a resident's trip out of the building resolves; the hook banks
    // the whole $150,000 and puts three people on the population ledger. There
    // is no recurring payment behind it — `sim/economy.js`'s activation sweep
    // deliberately withholds the money for this family — so if this seam is not
    // wired, a condo sells for nothing and the loop has no upside at all.
    [FAMILY.condo]: condoFamilyHandler({
      resolveRoute,
      onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
      onSale: condoCashflow.onSale,
    }),
  }, {
    [FAMILY.office]: officeArrival,
    [FAMILY.fastFood]: commercialArrival,
    // The arrival handlers are called `(actor, floor)`; the condo's needs its
    // object to step the countdown, and only the tower can answer that.
    [FAMILY.condo]: (actor, floor) => condoArrival(tower, actor, floor),
    [FAMILY.hotelSingle]: hotelArrives,
    [FAMILY.hotelTwin]: hotelArrives,
    [FAMILY.hotelSuite]: hotelArrives,
    [FAMILY.housekeeping]: (actor, floor) => housekeepingArrival(tower, actor, floor),
  }, applyRoutingDelay, {
    // `specs/TIME.md` § 2500. Sold condos clamp back to the sync sentinel and
    // every resident goes back to its band's starting state — which is what
    // puts a refunded condo's residents back on the sale path. Without it a
    // refunded condo runs yesterday's errands for ever and can never resell.
    //
    // The hotel rows of the same checkpoint share the tick: an occupied room is
    // clamped to `0x10` and its guests go to checkout-ready, which is what
    // carries a guest overnight. `extraCheckpoints` holds one body per tick, so
    // the two families are chained here rather than the later one silently
    // replacing the earlier.
    [CONDO_RESET_TICK]: (t) => { condoDailyReset(t); hotelDailyReset(t); },
    // `specs/TIME.md` § 1600: the hotel pass, on the tick the check-in window
    // opens — spread the cockroaches, recompute each room and give a dirty one
    // its strike, then refresh the latches (`hotelMiddaySweep` runs all three, in
    // `HOTEL.md`'s order). Issue #10 puts the restaurant rebuild on this tick
    // too: CHAIN it here, do not add a second key (`extraCheckpoints` holds one
    // body per tick). `TIME.md` § 1600 lists the type-6 rebuild as step 1 and the
    // hotel pass as steps 2-3, so the restaurant call goes BEFORE this one:
    //   [HOTEL_SWEEP_TICK]: (t) => { restaurantRebuild(t); hotelMiddaySweep(t); },
    [HOTEL_SWEEP_TICK]: hotelMiddaySweep,
    // § 1200: the day's checkout count (the newspaper trigger's input) resets.
    [HOTEL_SALE_RESET_TICK]: hotelSaleCountReset,
  });

  return { scheduler, applyRoutingDelay, cashflow, condoCashflow, hotelCashflow };
}
