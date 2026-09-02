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
import { condoCashflowHooks, officeCashflowHooks } from '../sim/ledger-adapter.js';
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

  const scheduler = makeTowerScheduler(tower, {
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
  }, applyRoutingDelay, {
    // `specs/TIME.md` § 2500. Sold condos clamp back to the sync sentinel and
    // every resident goes back to its band's starting state — which is what
    // puts a refunded condo's residents back on the sale path. Without it a
    // refunded condo runs yesterday's errands for ever and can never resell.
    [CONDO_RESET_TICK]: condoDailyReset,
  });

  return { scheduler, applyRoutingDelay, cashflow, condoCashflow };
}
