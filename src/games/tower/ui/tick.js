/**
 * The composition root: which `sim/` modules run, in what order.
 *
 * ⚠️ **This file is temporary and it is in the wrong place.** It belongs in
 * `src/games/tower/game.js`, the manifest `harness/load.js` looks for — the
 * headless harness and the browser must run *the same* composition or the rig
 * stops proving anything about the game you can play. `game.js` does not exist
 * yet and nothing owns family 7's gate, so the browser wires it here in the
 * meantime. Move it the day `game.js` lands; nothing below is UI-specific.
 *
 * It invents no rules. The order is `spec/TICK-MODEL.md` §3 and every step is
 * an existing exported function:
 *
 *   1-4. the clock                     `sim/clock.js`, via the scheduler
 *   5.   news / VIP hooks              — no event module yet
 *   6.   checkpoint bodies             `sim/routing.js` at tick 0
 *   7.   entity refresh stride         `families` — **empty, see below**
 *   8.   carriers                      `sim/elevators.js`
 *
 * Issue #16 adds the events to the same table, at the places the spec puts them: the daily
 * bomb/fire/VIP check rides the 240 body (`TIME.md` § 240 step 3), Santa's notice rides 2000, and
 * `events` is the per-tick hook that advances a live bomb or fire (`sim/scheduler.js` step 6b).
 *
 * ## The hole
 *
 * `families` is empty. Nothing in `sim/` implements family 7's gate and
 * dispatch, so a placed worker sits in `STATE_UNPLACED_OCCUPANT` (`0x20`)
 * forever: it never asks `resolveRouteBetweenFloors` for a lobby-to-office
 * route, so no office ever rents, so no car is ever called. The scheduler, the
 * router, the carriers and the renderer are all wired and idle, waiting on one
 * module. Supply it here and the loop runs with no other change.
 */
import { tickCarriers } from '../sim/elevators.js';
import { createScheduler } from '../sim/scheduler.js';
import { advanceSimTripCounters, rebaseSimElapsedFromClock } from '../sim/stress.js';
import { makeCarrierContext, rebuildRouteTables } from '../sim/routing.js';
import { LEDGER_CHECKPOINT_TICK } from '../sim/economy.js';
import {
  restaurantClosure, runCommercialClosure, runCommercialRebuild, runEntertainmentRebuild, runTowerLedgerCheckpoint,
} from '../sim/ledger-adapter.js';
import { refreshStartOfDayGates, tryAdvanceStar } from '../sim/progression.js';
import { CLOSURE_TICK, REBUILD_TICK, RESTAURANT_CLOSURE_TICK } from '../sim/commercial.js';
import { RECYCLING_CHECK, updateRecyclingState } from '../sim/recycling.js';
import { rebuildParkingCoverage } from '../sim/parking.js';
import { metroTrainTick } from '../sim/metro.js';
import { announceSanta, eventsTick, runDailyEvents } from '../sim/events.js';
import { activateWeddingGuests } from '../sim/cathedral.js';
import { runDailyInspection } from '../sim/inspection.js';

/**
 * @param tower    the tower this scheduler will drive
 * @param families `{ [familyCode]: (tower, actor) => void }` — the gate and
 *                 dispatch handlers. Passed in rather than imported so this
 *                 file keeps knowing nothing about any specific family.
 * @param arrivals `{ [familyCode]: (actor, floor) => void }` — what arriving
 *                 somewhere means to that family.
 * @param onDelay  `(delay, actor) => void` — prices one stress event. The SAME
 *                 signature the family handler's `onDelay` takes, deliberately:
 *                 the router and the carriers emit the same event shapes, and
 *                 one consumer must handle both or the two halves of a journey
 *                 get priced by different rules.
 * @param extraCheckpoints `{ [dayTick]: (tower) => void }` — checkpoint bodies
 *                 a family owns rather than the composition. Family 9's nightly
 *                 sweep is the first: `specs/TIME.md` § 2500 normalises condo
 *                 sim state and object bands, and only the condo module knows
 *                 what those are. Passed in for the same reason `families` is —
 *                 so this file goes on knowing nothing about any one family.
 *                 The two checkpoints below are the composition's own and
 *                 cannot be overridden from here.
 */
export function makeTowerScheduler(tower, families = {}, arrivals = {}, onDelay = null, extraCheckpoints = {}) {
  /** An actor by id. The carrier queues hold ids, not references. */
  const actorById = (ref) => tower.actors.find((a) => a && a.id === ref) ?? null;

  const carrierContext = makeCarrierContext(tower, {
    /**
     * Where a queued rider ultimately wants to go. `destinationFloor` is
     * written by `resolveRouteBetweenFloors` itself, so this reads the actor's
     * recorded intent rather than deciding anything — deciding is family work.
     */
    targetFloorOf: (ref) => actorById(ref)?.destinationFloor ?? null,
    /**
     * Arrival. Moving the actor and advancing its state machine is family
     * business; with no family module the best honest thing is to put the
     * rider on the floor the car reached and clear the leg, so the actor table
     * never claims someone is still waiting downstairs.
     */
    onArrive: (ref, floor) => {
      const actor = actorById(ref);
      if (!actor) return;
      actor.waitingFloor = null;
      actor.route = null;
      // The ride is over: rebase the elapsed span and count the trip. The
      // router reports arrivals as `{rebaseElapsed, advanceTripCounters}`, and
      // this is the ONE end of an accepted leg where the trip is counted —
      // counting at both ends halves the apparent stress.
      rebaseSimElapsedFromClock(actor, tower.clock.dayTick);
      advanceSimTripCounters(actor);
      // Then the family says what arriving means. Without this the worker
      // never leaves its in-transit state.
      arrivals[actor.family]?.(actor, floor);
    },
    onRequeueFailure: (ref) => {
      const actor = actorById(ref);
      if (actor) actor.route = null;
    },
    /**
     * ⚠️ **Every carrier stress event came through here and was thrown away.**
     *
     * `makeCarrierContext` only builds `ctx.emitDelay` when an `onDelay` is
     * supplied, and `drainFloorQueue` emits through `ctx.emitDelay?.(…)`. With
     * nothing passed, the optional call was a no-op and the **boarding** event
     * — the one that measures the wait on the floor and re-arms the route-start
     * stamp — never reached anybody.
     *
     * So `last_trip_tick` stayed `0`, and `rebase_sim_elapsed_from_clock` at
     * arrival read `elapsed + day_tick - 0`: it charged every rider the whole
     * day tick, which clamps to 300. Measured on a six-floor tower with three
     * working cars, the MEDIAN worker stress was 300 — the maximum a trip can
     * cost — so every office failed evaluation on day two and the tower never
     * recovered.
     *
     * Nothing errored. `?.` on an absent callback is silence by design, and the
     * result reads as "the clamp is working" rather than as a dropped event.
     * `CLAUDE.md`'s own warning, in a new place: a 4x error that presents as a
     * feel problem is worse than a crash.
     */
    onDelay: onDelay ? (ref, event) => onDelay(event, actorById(ref)) : undefined,
  });

  return createScheduler({
    checkpoints: {
      ...extraCheckpoints,
      // § Daily Checkpoints, tick 0: "rebuild the reachability/path tables".
      // Nothing else calls it, and a stale table is a route that silently fails.
      //
      // The progression refresh rides with it because that is where the
      // reference puts it: `specs/GAME-STATE.md` § Gate Meanings has
      // `rebuild_path_seed_bucket_table()` setting `route_viable` — this same
      // start-of-day rebuild — which is why that gate latches a day late.
      //
      // Issue #13: the ramps' reach is re-read at the start of the day too
      // (`specs/COMMANDS.md`: *"parking ramps force a parking coverage and demand-history
      // rebuild"*; `specs/TIME.md` § 0 step 3).
      //
      // Issue #17: the cathedral's guests are woken here (`TIME.md` § 0 step 6, after the
      // route tables they are about to ask are rebuilt and the day's wedding count is zeroed).
      0: (t) => {
        rebuildRouteTables(t); refreshStartOfDayGates(t); rebuildParkingCoverage(t); activateWeddingGuests(t);
      },
      /**
       * `specs/facility/COMMERCIAL.md` § Capacity, the daily recompute. It
       * runs at 240 rather than 0 because 240 is also the tick every venue's
       * own gate waits for — *"dayparts 0-3, tick <= 240: no dispatch"* — so
       * the day's capacity is written just before the first customer is
       * allowed to want it. Reopening the venues at tick 0 instead would leave
       * them open for 240 ticks with yesterday's capacity still on the record.
       */
      //
      // `specs/TIME.md` § 240 step 2 rides on the same tick: the entertainment
      // ledger rebuild (budgets reseeded, ages bumped, counters cleared), AFTER
      // the linked-facility rebuild of step 1.
      //
      // Step 3 of the same checkpoint is the event check - *"`fire` before `bomb`"* - and it
      // goes LAST, after the rebuilds, as the spec orders it (`sim/events.js` `runDailyEvents`).
      //
      // Issue #17: the office-service evaluation's daily check goes last, after the events
      // have drawn what they draw (`sim/inspection.js`).
      [REBUILD_TICK]: (t) => {
        runCommercialRebuild(t); runEntertainmentRebuild(t); runDailyEvents(t); runDailyInspection(t);
      },
      /**
       * The off-hours closure sweep: the day's visitors become the day's
       * money, and every venue closes to new customers. This is where a fast
       * food that nobody could reach loses its $3,000 — the commercial half of
       * "transport decides whether you have tenants".
       */
      //
      // `specs/TIME.md` § 2000 puts the recycling tier-2 check on this same tick,
      // AFTER the facility advance (step 2 to the sweep's step 1). It rides here
      // rather than in `extraCheckpoints`, because this key wins over theirs - one
      // body per tick - and a second body at 2000 would silently replace this one.
      //
      // Santa (issue #16) is announced on this tick too: `sim/events.js` `announceSanta`, a notice
      // on the last day of the year and nothing else. It rides here for the same reason the
      // recycling check does - one body per tick.
      [CLOSURE_TICK]: (t) => {
        runCommercialClosure(t); updateRecyclingState(t, RECYCLING_CHECK.afternoon); announceSanta(t);
      },
      /**
       * `specs/TIME.md` § 2200, *"type-6 facility advance"*: the same sweep for
       * the restaurant, two hundred ticks later — the evening's diners become
       * the evening's money. Its rebuild is at 1600 and rides in
       * `ui/driver.js`'s `extraCheckpoints`, chained ahead of the hotel pass
       * that owns that tick.
       */
      [RESTAURANT_CLOSURE_TICK]: (t) => restaurantClosure(t),
      // § 2533: ledger rollover, cashflow activation, periodic expenses — plus
      // the daily operational recompute that runs inside its object sweep.
      //
      // It lives here rather than on `dayAdvanced` in a driver, which is where
      // it used to be, so that every consumer of this composition gets the same
      // one: the browser, the headless harness and `test/integration.test.js`
      // were each keeping their own version of the daily sweep and only one of
      // them ran the whole of it. The tick number comes from `economy.js` so it
      // is not written down twice.
      [LEDGER_CHECKPOINT_TICK]: (t) => runTowerLedgerCheckpoint(t),
    },
    families,
    // `specs/TIME.md` step 5, the second of the two early hooks: the metro's train
    // (`sim/metro.js`, `METRO.md` § Per-Tick Special-Visitor Toggle). The scheduler
    // holds the `day_tick > 240` and `daypart < 4` guards; the rest, and the roll, are
    // the function's - and a tower with no station draws nothing.
    vip: metroTrainTick,
    // Issue #16: a live bomb or fire advances, every tick. Costs one property read when none is.
    events: eventsTick,
    carriers: (t) => tickCarriers(t.carriers, t.clock, carrierContext),
    // The only thing in the game that says you are winning. Every tick, because
    // two of its gates are time windows — see `sim/scheduler.js` step 9.
    progression: (t) => tryAdvanceStar(t),
  });
}
