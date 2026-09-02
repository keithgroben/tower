/**
 * The clock and the RNG, checked against the reference rather than against
 * what looks reasonable.
 *
 * Every assertion here cites `specs/TIME.md`. Where a number looks wrong —
 * a day counter that moves 300 ticks before midnight, a clock that spends five
 * displayed hours in one daypart and fifty-nine displayed minutes in two — the
 * test is pinning the reference, and changing it is a deviation that belongs in
 * `spec/DEVIATIONS.md`.
 */
import {
  DAY_ADVANCE_TICK, DAYPART_LABELS, NEW_GAME_TICK, TICKS_PER_DAY,
  advanceClock, calendarPhaseFlag, clockTime, createClock, daypartOf, formatClock, isEvening,
} from '../src/games/tower/sim/clock.js';
import { INITIAL_STATE, RAND_MAX, makeRng } from '../src/games/tower/sim/rng.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** Run the clock forward `n` ticks, collecting what each tick reported. */
function run(clock, n) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(advanceClock(clock));
  return events;
}

export const tests = {
  // ------------------------------------------------------------------- rng

  'the generator is the reference LCG, not a convenient substitute'() {
    // specs/TIME.md § RNG: state = state * 0x015a4e35 + 1 mod 2^32,
    // value = (state >> 16) & 0x7fff, initial state 1.
    const rng = makeRng();
    assert(rng.state === INITIAL_STATE, 'the image-initialized seed is 1');

    // Computed independently here with BigInt, so the test does not simply
    // re-run the implementation's own arithmetic and agree with itself.
    let s = BigInt(INITIAL_STATE);
    const expected = [];
    for (let i = 0; i < 8; i++) {
      s = (s * 0x015a4e35n + 1n) & 0xffffffffn;
      expected.push(Number((s >> 16n) & 0x7fffn));
    }
    const actual = Array.from({ length: 8 }, () => rng.next());
    assert(JSON.stringify(actual) === JSON.stringify(expected),
      'the sequence diverges from the reference LCG:\n  got      ' + actual.join(',')
      + '\n  expected ' + expected.join(','));
  },

  'draws stay inside 15 bits, and the state stays unsigned'() {
    const rng = makeRng();
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      assert(Number.isInteger(v) && v >= 0 && v <= RAND_MAX, 'draw out of range: ' + v);
      assert(rng.state >= 0 && rng.state <= 0xffffffff, 'state left 32-bit unsigned: ' + rng.state);
    }
  },

  'the state round-trips, which is what replay across a save needs'() {
    const a = makeRng();
    for (let i = 0; i < 100; i++) a.next();
    const saved = a.state;

    const b = makeRng();
    b.state = saved;
    const fromA = Array.from({ length: 20 }, () => a.next());
    const fromB = Array.from({ length: 20 }, () => b.next());
    assert(JSON.stringify(fromA) === JSON.stringify(fromB), 'a restored state produced a different future');

    // And the seed alone is NOT enough — the point of persisting the state.
    const fresh = makeRng();
    assert(fresh.next() !== fromA[0] || saved === INITIAL_STATE,
      'a fresh generator matched a mid-run one, so the test proves nothing');
  },

  'a 1-in-n gate lands near 1/n, and is never keyed off the day counter'() {
    // specs/DEMAND.md § Stochastic Gating, correction 1: the binary uses
    // rand() % N == 0, and day_counter is never read in any gate handler.
    const rng = makeRng();
    let hits = 0;
    const trials = 120000;
    for (let i = 0; i < trials; i++) if (rng.chance(12)) hits++;
    const rate = hits / trials;
    assert(Math.abs(rate - 1 / 12) < 0.005, '1/12 gate fired at ' + rate.toFixed(4));
  },

  // ----------------------------------------------------------------- clock

  'a day is 2600 ticks in seven dayparts of 400'() {
    assert(TICKS_PER_DAY === 2600, 'day length changed');
    const boundaries = [[0, 0], [399, 0], [400, 1], [799, 1], [800, 2], [1199, 2],
      [1200, 3], [1599, 3], [1600, 4], [1999, 4], [2000, 5], [2399, 5], [2400, 6], [2599, 6]];
    for (const [tick, daypart] of boundaries) {
      assert(daypartOf(tick) === daypart,
        'tick ' + tick + ' is daypart ' + daypartOf(tick) + ', expected ' + daypart);
    }
    assert(DAYPART_LABELS.length === 7, 'there are seven dayparts');
  },

  'daypart 4 is where the tower goes home'() {
    // Half the family gate tables read "daypart >= 4" to mean exactly this.
    assert(!isEvening(1599) && isEvening(1600), 'the morning/evening split is not at tick 1600');
  },

  /**
   * The one that will catch a "sensible" rewrite. The day counter moves at
   * 2300; the tick wraps at 2600. They are 300 ticks apart, and the gap is an
   * overnight window already carrying the new day number.
   */
  'the day counter advances 300 ticks before the tick wraps'() {
    const clock = createClock({ dayTick: 2298, dayCounter: 4 });

    advanceClock(clock);                                   // -> 2299
    assert(clock.dayCounter === 4, 'the day advanced early');

    const advance = advanceClock(clock);                   // -> 2300
    assert(advance.dayAdvanced && clock.dayTick === DAY_ADVANCE_TICK, 'no advance at 2300');
    assert(clock.dayCounter === 5, 'the day counter did not move at 2300');

    // ...and the remaining 300 ticks carry the NEW day number.
    const events = run(clock, TICKS_PER_DAY - DAY_ADVANCE_TICK);
    assert(clock.dayCounter === 5, 'the day counter moved again before the next 2300');
    assert(events.some((e) => e.wrapped), 'the tick never wrapped');
    assert(clock.dayTick === 0, 'the tick did not land on 0 after the wrap');
  },

  'exactly one day advance and one wrap per 2600 ticks'() {
    const clock = createClock({ dayTick: 0, dayCounter: 0 });
    const events = run(clock, TICKS_PER_DAY * 3);
    assert(events.filter((e) => e.dayAdvanced).length === 3, 'wrong number of day advances');
    assert(events.filter((e) => e.wrapped).length === 3, 'wrong number of wraps');
    assert(clock.dayCounter === 3, 'day counter ended at ' + clock.dayCounter);
    assert(clock.dayTick === 0, 'tick ended at ' + clock.dayTick);
  },

  'the calendar phase flag is two days in every twelve'() {
    // ((day_counter % 12) % 3) >= 2 — a rhythm that blocks some dispatch gates.
    const set = [];
    for (let day = 0; day < 12; day++) if (calendarPhaseFlag(day)) set.push(day);
    assert(JSON.stringify(set) === JSON.stringify([2, 5, 8, 11]),
      'the calendar phase fires on days ' + set.join(',') + ', expected 2,5,8,11');
  },

  'a new game starts at night, on the expense checkpoint'() {
    const clock = createClock();
    assert(clock.dayTick === NEW_GAME_TICK && NEW_GAME_TICK === 2533, 'new games no longer start at 2533');
    assert(clock.daypart === 6, 'a new game should open in the night daypart');
    assert(clock.dayCounter === 0, 'a new game should open on day 0');
  },

  /**
   * The clock face is piecewise on purpose. A linear tick→24h mapping is what
   * put the old prototype's morning rush at 01:55, so the shape is pinned.
   */
  'the displayed clock spends its hours where the decisions are'() {
    const spans = [
      [0, 7, 0, 'AM'], [399, 11, 59, 'AM'],       // daypart 0: five hours of morning
      [400, 12, 0, 'PM'], [799, 12, 29, 'PM'],    // daypart 1: 29 displayed minutes
      [800, 12, 30, 'PM'], [1199, 12, 59, 'PM'],  // daypart 2: 29 more
      [1200, 1, 0, 'PM'], [1599, 4, 59, 'PM'],
      [1600, 5, 0, 'PM'], [1999, 8, 59, 'PM'],
      [2000, 9, 0, 'PM'], [2399, 12, 59, 'AM'],   // daypart 5 rolls through midnight
      // Daypart 6 is 200 ticks covering nearly six displayed hours — it runs
      // at three times the rate of dayparts 3-5. The endpoint is the tell.
      [2400, 1, 0, 'AM'], [2599, 6, 58, 'AM'],
    ];
    for (const [tick, hour, minute, meridiem] of spans) {
      const t = clockTime(tick);
      const got = t.hour + ':' + String(t.minute).padStart(2, '0') + ' ' + (t.pm ? 'PM' : 'AM');
      const want = hour + ':' + String(minute).padStart(2, '0') + ' ' + meridiem;
      assert(got === want, 'tick ' + tick + ' shows ' + got + ', reference says ' + want);
    }
  },

  'the morning is one daypart and lunch is two, which is the whole point'() {
    // Bounded and negated: a linear mapping would put these in proportion to
    // tick count. They are deliberately not.
    const minutesIn = (from, to) => {
      const a = clockTime(from), b = clockTime(to);
      return (b.hour24 * 60 + b.minute) - (a.hour24 * 60 + a.minute);
    };
    const morning = minutesIn(0, 399);     // 400 ticks
    const lunch = minutesIn(400, 1199);    // 800 ticks, twice as many
    assert(morning > 4 * 60, 'daypart 0 should span more than four displayed hours, got ' + morning + ' min');
    assert(lunch < 60, 'dayparts 1-2 should span under an hour, got ' + lunch + ' min');
    assert(morning > lunch * 4, 'the clock is not slowing through lunch — it looks linear');
  },

  'the clock never runs backwards across a whole day'() {
    let previous = -1;
    let wraps = 0;
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      const t = clockTime(tick);
      const minutes = t.hour24 * 60 + t.minute;
      if (minutes < previous) wraps++;
      previous = minutes;
      assert(t.minute >= 0 && t.minute < 60, 'tick ' + tick + ' produced minute ' + t.minute);
      assert(t.hour >= 1 && t.hour <= 12, 'tick ' + tick + ' produced hour ' + t.hour);
    }
    // Exactly one rollover, through midnight inside daypart 5.
    assert(wraps === 1, 'the displayed clock jumped backwards ' + wraps + ' times, expected 1 (midnight)');
  },

  /**
   * The reference prints three worked examples of its own. They are the
   * cheapest possible check that the piecewise conversion was read correctly,
   * and the 2533 one is the anchor that caught a wrong daypart-6 rate here:
   * a `r * 4` night looks perfectly plausible everywhere except its endpoint.
   */
  'the reference’s own worked examples come out right'() {
    // specs/TIME.md § GUI Clock Conversion, "Examples".
    const examples = [[2533, '4:59 AM'], [2599, '6:58 AM'], [0, '7:00 AM']];
    for (const [tick, want] of examples) {
      assert(formatClock(tick) === want,
        'tick ' + tick + ' shows ' + formatClock(tick) + ', the spec says ' + want);
    }
  },

  'formatting reads like a clock'() {
    assert(formatClock(0) === '7:00 AM', 'tick 0 formats as ' + formatClock(0));
    assert(formatClock(2400) === '1:00 AM', 'tick 2400 formats as ' + formatClock(2400));
  },
};
