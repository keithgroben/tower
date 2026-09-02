/**
 * The tick loop: what happens, in what order, every tick.
 *
 * Spec: `specs/TIME.md` § Top-Level Tick Order, § Entity Refresh Stride,
 * § RNG (the "Scheduler-level RNG order" section), § Daily Checkpoints.
 *
 * This module is deliberately thin and knows nothing about offices, lifts or
 * money. It owns exactly one thing — **order** — because order is what
 * determinism is made of. Every family handler and checkpoint body is passed
 * in, so the sequencing can be tested on its own with handlers that do nothing
 * but record when they were called.
 *
 * The two rules worth stating before the code, because both look like details
 * and neither is:
 *
 * 1. **Not every actor runs every tick.** One sixteenth of the table is
 *    serviced per tick, starting at `day_tick % 16`, in raw table order. An
 *    actor therefore acts once per 16 ticks — which at our pacing is about a
 *    second and a third of felt time, and is why a person in this game appears
 *    to think before moving.
 *
 * 2. **Raw table order is load-bearing.** Every RNG draw a family handler makes
 *    happens in table order, so grouping actors by family or floor to be tidy
 *    would silently change every future outcome. Do not sort this table.
 */
import { advanceClock } from './clock.js';

/** One sixteenth of the actor table per tick. `specs/TIME.md` § Entity Refresh Stride. */
export const STRIDE = 16;

/**
 * The indices the stride visits on this tick: `start, start+16, start+32, …`
 * where `start = day_tick % 16`.
 *
 * Exported because the ordering is a rule in its own right and deserves to be
 * tested without running a whole tick.
 */
export function strideIndices(dayTick, actorCount) {
  const out = [];
  for (let i = dayTick % STRIDE; i < actorCount; i += STRIDE) out.push(i);
  return out;
}

/**
 * @typedef {object} SchedulerHooks
 * @property {Record<number, (tower:object) => void>} [checkpoints]
 *   Keyed by `day_tick`. Multi-step checkpoint bodies run in their own
 *   documented internal order — that is the body's business, not ours.
 * @property {Record<number, (tower:object, actor:object) => void>} [families]
 *   Keyed by `family_code`. Called once per serviced actor.
 * @property {(tower:object) => void} [news]  per-tick hook, runs FIRST
 * @property {(tower:object) => void} [vip]   per-tick hook, runs after news
 * @property {(tower:object) => void} [carriers] runs last, after entity refresh
 */

export function createScheduler(hooks = {}) {
  const { checkpoints = {}, families = {}, news, vip, carriers } = hooks;

  /**
   * Advance the tower exactly one tick.
   *
   * The order below is `specs/TIME.md` § Top-Level Tick Order, and the
   * comments say why each step sits where it does. Reordering any two of
   * these changes the game.
   *
   * @returns {{tick:number, daypart:number, dayAdvanced:boolean, wrapped:boolean, serviced:number}}
   */
  function tick(tower) {
    // 1-4. The clock moves first. Everything below reads the NEW tick value,
    // including the checkpoint match — a checkpoint fires on the tick it names.
    const moved = advanceClock(tower.clock);
    const { dayTick, daypart } = { dayTick: tower.clock.dayTick, daypart: tower.clock.daypart };

    // 5. Early per-tick event hooks, news BEFORE vip. Both consume RNG, so
    // their relative order is part of the replay contract, not a preference.
    // Both are gated on `day_tick > 240`; news runs while daypart < 6, vip
    // while daypart < 4.
    if (dayTick > 240) {
      if (daypart < 6 && news) news(tower);
      if (daypart < 4 && vip) vip(tower);
    }

    // 6. The checkpoint body for this exact tick.
    const checkpoint = checkpoints[dayTick];
    if (checkpoint) checkpoint(tower);

    // 7. Entity refresh. Runs AFTER the checkpoint deliberately: actors
    // serviced this tick see state a checkpoint already changed. The start-of-
    // day sweep at tick 0 resets state bytes, and the actors visited on tick 0
    // must see the reset values, not the ones from yesterday.
    let serviced = 0;
    if (!tower.paused) {
      const actors = tower.actors;
      for (let i = dayTick % STRIDE; i < actors.length; i += STRIDE) {
        const actor = actors[i];
        // A handler may remove an actor mid-sweep; skip the hole rather than
        // shifting the table, because shifting would change visitation order
        // for everyone after it.
        if (!actor) continue;
        const handler = families[actor.family];
        if (handler) { handler(tower, actor); serviced++; }
      }
    }

    // 8. Carriers move last, once everyone who wanted a ride has asked.
    // No carrier step consumes RNG, so this position is safe for replay.
    if (carriers) carriers(tower);

    return { tick: dayTick, daypart, dayAdvanced: moved.dayAdvanced, wrapped: moved.wrapped, serviced };
  }

  /** Run `n` ticks. The headless harness lives on this. */
  function advance(tower, n) {
    const results = [];
    for (let i = 0; i < n; i++) results.push(tick(tower));
    return results;
  }

  return { tick, advance };
}
