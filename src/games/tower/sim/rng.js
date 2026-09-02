/** Deterministic RNG. Seeded, serializable, no Math.random anywhere in src/sim. */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Skewed toward 0; used to shape rush-hour arrivals into a peak. */
    peak: (k) => 1 - Math.pow(next(), 1 / k),
    get seed() { return s; },
    set seed(v) { s = v >>> 0 || 1; },
  };
}
