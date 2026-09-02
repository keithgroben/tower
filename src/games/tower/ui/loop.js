/**
 * The fixed timestep. This is the only place in the game that knows what a
 * *second* is.
 *
 * `CLAUDE.md`: *"Fixed timestep everywhere. The sim never sees a variable
 * `dt`."* And `spec/TICK-MODEL.md` §9: *"The pacing constant does not live in
 * `sim/`. The sim never sees wall time; it takes ticks. Ticks-per-second
 * belongs to the loop that drives it."* Keeping that boundary is what lets the
 * headless harness run a thousand days in a second and a browser run 3m37s a
 * day off the same `scheduler.tick()`.
 *
 * Everything here is pure arithmetic over milliseconds, so the pacing rules can
 * be tested without a browser, a canvas or a tower.
 */
import { TICKS_PER_DAY } from '../sim/clock.js';

/**
 * **The pacing constant.** `spec/TICK-MODEL.md` §9, Keith 2026-09-02.
 *
 * The original ran ~3–4 real minutes a day (`spec/simtower.md` §8) and the
 * predecessor ran 45 s, which is the "rushed" this is a reaction to. At 12
 * ticks a second a day is 3 min 37 s — mid-band of the original — and one
 * actor's 16-tick refresh stride is 1.33 s, which is what makes a person in
 * this game appear to think before moving.
 *
 * Wall-clock pacing is presentation, so this is explicitly **not** a deviation.
 * It is also the first thing to check in the first playtest, and a one-line
 * change when it is wrong.
 */
export const TICKS_PER_SECOND = 12;

export const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

/** Real seconds in one game day at 1x. 216.67 — 3 min 37 s. */
export const DAY_SECONDS = TICKS_PER_DAY / TICKS_PER_SECOND;

/**
 * Speed multipliers, `0` being pause.
 *
 * The original had them, so they are faithful as well as merciful — nobody
 * should ever be made to wait. 4x is the ceiling because 8x puts an actor's
 * whole 16-tick beat inside a third of a second, at which point the crowd stops
 * reading as people deciding things and starts reading as noise.
 */
export const SPEEDS = [0, 1, 2, 4];

/**
 * The most ticks one frame may run.
 *
 * A backgrounded tab hands back a multi-second `dt` on return. Without a
 * ceiling the catch-up takes longer than the gap it is closing, the next frame
 * is longer still, and the page locks — the spiral of death. 240 is 20 seconds
 * of sim at 1x, comfortably more than any real frame hitch and far less than a
 * tab left open over lunch.
 */
export const MAX_TICKS_PER_FRAME = 240;

/**
 * How many whole ticks `accumulatorMs` has earned, and what is left over.
 *
 * **Overflow is dropped, not carried.** Returning the excess in `remainder`
 * would mean the very next frame owes the same debt plus its own, which is the
 * spiral this exists to prevent. `dropped` is reported rather than swallowed so
 * a caller can say so out loud instead of quietly running a slow game.
 *
 * @returns {{steps:number, remainder:number, dropped:number}}
 */
export function stepsFor(accumulatorMs, msPerTick = MS_PER_TICK, maxSteps = MAX_TICKS_PER_FRAME) {
  const acc = Number(accumulatorMs);
  if (!Number.isFinite(acc) || acc <= 0) return { steps: 0, remainder: Math.max(0, acc || 0), dropped: 0 };
  const wanted = Math.floor(acc / msPerTick);
  if (wanted <= maxSteps) return { steps: wanted, remainder: acc - wanted * msPerTick, dropped: 0 };
  return { steps: maxSteps, remainder: 0, dropped: wanted - maxSteps };
}

/**
 * The pump: real milliseconds in, whole sim ticks out.
 *
 * `speed` multiplies the *accumulation*, never the timestep — a 4x game runs
 * four times as many identical ticks, it does not run bigger ones. That is
 * what keeps a fast-forwarded tower byte-identical to a slow one.
 */
export function makeTickPump({
  msPerTick = MS_PER_TICK,
  maxSteps = MAX_TICKS_PER_FRAME,
} = {}) {
  let accumulator = 0;
  let dropped = 0;

  return {
    /**
     * @param dtMs   real milliseconds since the last frame
     * @param speed  a multiplier from {@link SPEEDS}; `0` pauses
     * @param run    called once per tick
     * @returns the number of ticks run
     */
    advance(dtMs, speed, run) {
      // A paused game does not bank time. Unpausing after a minute must not
      // fast-forward a minute — pause is a pause, not a rewind buffer.
      if (!(speed > 0)) { accumulator = 0; return 0; }
      const dt = Number(dtMs);
      if (!Number.isFinite(dt) || dt <= 0) return 0;
      accumulator += dt * speed;
      const { steps, remainder, dropped: lost } = stepsFor(accumulator, msPerTick, maxSteps);
      accumulator = remainder;
      dropped += lost;
      for (let i = 0; i < steps; i++) run();
      return steps;
    },

    reset() { accumulator = 0; },
    /** Ticks the pump has refused to run, cumulatively. Diagnostic only. */
    get droppedTicks() { return dropped; },
    get pendingMs() { return accumulator; },
  };
}
