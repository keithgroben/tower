/**
 * The fixed timestep — the one place the game knows what a second is.
 *
 * `spec/TICK-MODEL.md` §9 fixes the pacing (12 ticks/s, a 3m37s day) and
 * `CLAUDE.md` fixes the boundary: the sim takes ticks and never wall time. Both
 * are pinned here, because a pacing constant that drifts is the kind of bug
 * that presents as a *feel* problem and gets chased for a week.
 */
import { TICKS_PER_DAY } from '../src/games/tower/sim/clock.js';
import {
  DAY_SECONDS, MAX_TICKS_PER_FRAME, MS_PER_TICK, SPEEDS, TICKS_PER_SECOND,
  makeTickPump, stepsFor,
} from '../src/games/tower/ui/loop.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

export const tests = {
  'the pacing is the one spec/TICK-MODEL.md §9 decided'() {
    assert(TICKS_PER_SECOND === 12, 'the default is 12 ticks/s, not ' + TICKS_PER_SECOND);
    // 2600 ticks / 12 = 216.67 s = 3 min 37 s, the number the spec table quotes
    // as "mid-band of the original". Recomputed from TICKS_PER_DAY rather than
    // hardcoded, so changing the day length cannot leave this agreeing with a
    // stale figure.
    assert(Math.abs(DAY_SECONDS - TICKS_PER_DAY / TICKS_PER_SECOND) < 1e-9, 'DAY_SECONDS is derived');
    const minutes = Math.floor(DAY_SECONDS / 60), seconds = Math.round(DAY_SECONDS % 60);
    assert(minutes === 3 && seconds === 37, `a day should be 3m37s, got ${minutes}m${seconds}s`);
    // One actor's 16-tick refresh stride: 1.33 s of felt time, which is the
    // "you watch a person decide" the spec is buying.
    assert(Math.abs(16 / TICKS_PER_SECOND - 1.333) < 0.001, 'an actor beat is 1.33 s');
  },

  'pause is in the speed table, and 4x is the ceiling'() {
    assert(SPEEDS[0] === 0, 'the first speed is pause');
    assert(SPEEDS.at(-1) === 4, 'the fastest speed is 4x');
    assert(SPEEDS.every((s) => Number.isInteger(s)), 'every speed is a whole multiplier');
  },

  'a whole timestep produces exactly one tick, and the remainder carries'() {
    const a = stepsFor(MS_PER_TICK);
    assert(a.steps === 1 && a.dropped === 0, 'one timestep is one tick');
    assert(Math.abs(a.remainder) < 1e-9, 'nothing is left over: ' + a.remainder);

    // 2.5 timesteps: two ticks now, half a step owed to the next frame. The
    // carried half is what stops a 60 Hz display drifting away from 12 Hz sim.
    const b = stepsFor(MS_PER_TICK * 2.5);
    assert(b.steps === 2, 'two whole ticks, got ' + b.steps);
    assert(Math.abs(b.remainder - MS_PER_TICK * 0.5) < 1e-9, 'the half step carries');
  },

  'a backlog past the frame ceiling is DROPPED, not carried'() {
    // The spiral of death: a backgrounded tab hands back a multi-second dt. If
    // the overflow came back in `remainder` the next frame would owe the same
    // debt plus its own, and the page locks. The excess has to be forgotten.
    const huge = MS_PER_TICK * (MAX_TICKS_PER_FRAME + 500);
    const r = stepsFor(huge);
    assert(r.steps === MAX_TICKS_PER_FRAME, 'the ceiling holds: ' + r.steps);
    assert(r.remainder === 0, 'an overflowing frame leaves nothing owed, got ' + r.remainder);
    assert(r.dropped === 500, 'the loss is reported rather than swallowed: ' + r.dropped);
  },

  'a pause banks no time'() {
    // Unpausing after a minute must not fast-forward a minute. A pause is a
    // pause, not a rewind buffer.
    const pump = makeTickPump();
    let ticks = 0;
    const run = () => { ticks++; };
    pump.advance(60_000, 0, run);
    assert(ticks === 0 && pump.pendingMs === 0, 'a paused frame accumulates nothing');
    pump.advance(MS_PER_TICK, 1, run);
    assert(ticks === 1, 'the first unpaused frame runs one tick, got ' + ticks);
  },

  'speed multiplies the number of ticks, never their size'() {
    // A 4x tower must be byte-identical to a 1x one that ran four times as
    // long. If speed scaled the timestep instead, every fast-forwarded game
    // would diverge — and replay is what the whole fixed-timestep rule buys.
    const oneSecond = 1000;
    for (const speed of SPEEDS.filter((s) => s > 0)) {
      const pump = makeTickPump();
      let ticks = 0;
      // Fed as sixty separate frames, the way a browser actually delivers it.
      for (let i = 0; i < 60; i++) pump.advance(oneSecond / 60, speed, () => { ticks++; });
      assert(ticks === TICKS_PER_SECOND * speed,
        `${speed}x should run ${TICKS_PER_SECOND * speed} ticks in a second, ran ${ticks}`);
    }
  },

  'an irregular frame stream still averages the right rate'() {
    // Real frames are not 16.67 ms apart. Ten seconds of jitter must still be
    // 120 ticks, or the game runs at a rate that depends on the display.
    const pump = makeTickPump();
    let ticks = 0;
    let elapsed = 0;
    let i = 0;
    while (elapsed < 10_000) {
      const dt = [8, 16, 17, 33, 12, 41][i++ % 6];
      elapsed += dt;
      pump.advance(dt, 1, () => { ticks++; });
    }
    const expected = Math.floor(elapsed / MS_PER_TICK);
    assert(Math.abs(ticks - expected) <= 1, `expected about ${expected} ticks, ran ${ticks}`);
    assert(pump.droppedTicks === 0, 'ordinary jitter drops nothing');
  },

  'a zero or negative frame time does nothing at all'() {
    // `performance.now()` can hand back the same value twice, and a clock that
    // steps backwards must not run the sim backwards or throw.
    const pump = makeTickPump();
    let ticks = 0;
    const run = () => { ticks++; };
    for (const dt of [0, -5, NaN, undefined, Infinity]) pump.advance(dt, 1, run);
    assert(ticks === 0, 'a degenerate dt ran ' + ticks + ' ticks');
  },
};
