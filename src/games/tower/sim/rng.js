/**
 * The reference's random number generator, reproduced exactly.
 *
 * Spec: `specs/TIME.md` § RNG. This is not our choice of generator — it is a
 * 32-bit linear congruential generator lifted from the original binary, and it
 * has to be this one. Replay, the trace tests, and any future comparison
 * against the reference all depend on producing the same numbers in the same
 * order.
 *
 *   state = (state * 0x015a4e35 + 1) mod 2^32
 *   value = (state >> 16) & 0x7fff
 *
 * The high bits are returned because the low bits of an LCG are notoriously
 * poor — the original knew that. Range is therefore `0..32767`, NOT a float,
 * and gates are written as `rand() % N == 0`.
 *
 * Pure and Node-runnable. No `Math.random` anywhere in `sim/`, ever.
 */

/** The image-initialized seed. No reseed occurs during normal play. */
export const INITIAL_STATE = 1;

/** The generator returns 15 bits. */
export const RAND_MAX = 0x7fff;

export function makeRng(state = INITIAL_STATE) {
  // `>>> 0` keeps it an unsigned 32-bit value at every step. JavaScript's
  // bitwise operators work on signed 32-bit ints, so without this the state
  // goes negative and the sequence silently diverges from the reference.
  let s = state >>> 0;

  /** One draw: `0..32767`. Advances the state exactly once. */
  const next = () => {
    // Math.imul, not `*`: the product overflows 2^53 and plain multiplication
    // would round it away. This is the one line the whole determinism story
    // rests on.
    s = (Math.imul(s, 0x015a4e35) + 1) >>> 0;
    return (s >>> 16) & RAND_MAX;
  };

  return {
    next,

    /**
     * `rand() % n == 0` — the reference's stochastic gate, written once so no
     * call site has to remember the shape. A 1/n chance **per entity service
     * tick**, which with the 1/16 stride is not the same as per game tick.
     */
    chance: (n) => next() % n === 0,

    /** `0 .. n-1`, via the same modulo the original uses. */
    int: (n) => next() % n,

    /**
     * The 32-bit state, exposed so a save can round-trip it. Replay across
     * save/load is impossible without persisting this — the seed alone only
     * reproduces a run from tick zero.
     */
    get state() { return s; },
    set state(v) { s = v >>> 0; },
  };
}
