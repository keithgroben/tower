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
 */
export function makeTowerScheduler(tower, families = {}, arrivals = {}, onDelay = null) {
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
    // § Daily Checkpoints, tick 0: "rebuild the reachability/path tables".
    // Nothing else calls it, and a stale table is a route that silently fails.
    checkpoints: { 0: (t) => rebuildRouteTables(t) },
    families,
    carriers: (t) => tickCarriers(t.carriers, t.clock, carrierContext),
  });
}
