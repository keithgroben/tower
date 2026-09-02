/**
 * The day, exactly as the reference keeps it.
 *
 * Spec: `specs/TIME.md` § Tick Model, § Daypart Boundaries, § GUI Clock
 * Conversion. Every number here is theirs.
 *
 * Three things about this are surprising enough to state up front, because
 * each one is a bug waiting to happen if you assume the obvious instead:
 *
 * 1. **The day counter does not increment at the wrap.** It increments at tick
 *    2300, three hundred ticks before `day_tick` returns to 0. Ticks 2300-2599
 *    are an overnight window that already carries the NEW day number.
 *
 * 2. **The displayed clock is piecewise, not linear.** Daypart 0 alone spans
 *    five displayed hours; dayparts 1 and 2 together cover fifty-nine displayed
 *    minutes. The game spends its ticks where the decisions are and crawls
 *    through lunch. Mapping ticks linearly onto 24 hours is what put the old
 *    prototype's morning rush at 01:55.
 *
 * 3. **A new game starts at tick 2533, not 0** — the player gets a moment of
 *    night, then dawn. 2533 is also the quarterly-expense checkpoint, so the
 *    first day opens on a clean ledger.
 */

/** Ticks in a day: `day_tick` runs `0..2599`. */
export const TICKS_PER_DAY = 2600;

/** Ticks per daypart. Seven of them, `0..6`. */
export const TICKS_PER_DAYPART = 400;

/** `day_counter` increments here, NOT at the wrap. */
export const DAY_ADVANCE_TICK = 2300;

/** Where a new game begins: a brief night, then dawn. */
export const NEW_GAME_TICK = 2533;

/** `day_counter` wraps here. */
export const DAY_COUNTER_WRAP = 11988;

/** `daypart_index < 4` is the "morning" behavioural period. */
export const EVENING_DAYPART = 4;

export const DAYPART_LABELS = [
  'early morning', 'morning', 'late morning', 'midday', 'afternoon', 'evening', 'night',
];

export const daypartOf = (dayTick) => Math.floor(dayTick / TICKS_PER_DAYPART);

/**
 * The behavioural split the family gate tables are written against. Half the
 * office rules read "daypart >= 4" to mean "go home now", so it gets a name.
 */
export const isEvening = (dayTick) => daypartOf(dayTick) >= EVENING_DAYPART;

/**
 * `((day_counter % 12) % 3) >= 2`. Recomputed whenever the day counter moves.
 *
 * A two-days-in-every-twelve flag that blocks some dispatch gates outright —
 * office state `0x20` will not dispatch while it is set. Nothing about the name
 * explains what it is for; it is a calendar rhythm in the original and we carry
 * it because it changes outcomes.
 */
export const calendarPhaseFlag = (dayCounter) => ((dayCounter % 12) % 3) >= 2;

export function createClock({ dayTick = NEW_GAME_TICK, dayCounter = 0 } = {}) {
  return {
    dayTick,
    dayCounter,
    daypart: daypartOf(dayTick),
    calendarPhase: calendarPhaseFlag(dayCounter),
  };
}

/**
 * Advance one tick. Returns what changed, so the scheduler can run the right
 * hooks without re-deriving any of it.
 *
 * Order matters and is fixed by `specs/TIME.md` § Top-Level Tick Order: the
 * tick increments, the daypart is recomputed, the day counter advances at its
 * own checkpoint, and only then does the tick wrap.
 *
 * @returns {{tick:number, daypart:number, daypartChanged:boolean, dayAdvanced:boolean, wrapped:boolean}}
 */
export function advanceClock(clock) {
  const previousDaypart = clock.daypart;
  let tick = clock.dayTick + 1;

  // The day counter moves at 2300, on the way past — not at the wrap below.
  const dayAdvanced = tick === DAY_ADVANCE_TICK;
  if (dayAdvanced) {
    clock.dayCounter = clock.dayCounter + 1 >= DAY_COUNTER_WRAP ? 0 : clock.dayCounter + 1;
    // Recomputed immediately after the write, so a wrapped counter starts a
    // fresh 12-day cycle rather than carrying a stale phase through the tick.
    clock.calendarPhase = calendarPhaseFlag(clock.dayCounter);
  }

  const wrapped = tick >= TICKS_PER_DAY;
  if (wrapped) tick = 0;

  clock.dayTick = tick;
  clock.daypart = daypartOf(tick);
  return {
    tick,
    daypart: clock.daypart,
    daypartChanged: clock.daypart !== previousDaypart,
    dayAdvanced,
    wrapped,
  };
}

/**
 * The analog clock face, `{hour, minute}` on a 12-hour dial with `pm`.
 *
 * Recovered formulas, `specs/TIME.md` § GUI Clock Conversion. `r` is the offset
 * into the current daypart. Display only — nothing in the sim reads this, and
 * it must never become an input to a rule.
 */
export function clockTime(dayTick) {
  const daypart = daypartOf(dayTick);
  const r = dayTick - daypart * TICKS_PER_DAYPART;
  let hour24;
  let minute;

  if (daypart === 0) {
    // Five displayed hours in one daypart: the whole working morning.
    const v = r * 5;
    hour24 = 7 + Math.floor(v / 400);
    minute = Math.floor((v % 400) * 60 / 400);
  } else if (daypart === 1) {
    // Lunch crawls. Two dayparts cover 12:00 to 12:59.
    hour24 = 12;
    minute = Math.floor(r * 60 / 800);
  } else if (daypart === 2) {
    hour24 = 12;
    minute = 30 + Math.floor(r * 60 / 800);
  } else if (daypart <= 5) {
    // Dayparts 3-5: four displayed minutes per tick, from 1 PM / 5 PM / 9 PM.
    // Daypart 5 rolls through midnight, which is why this works in 24-hour
    // terms and wraps at the end rather than carrying an AM/PM flag around.
    const v = r * 4;
    hour24 = [13, 17, 21][daypart - 3] + Math.floor(v / 400);
    minute = Math.floor((v % 400) * 60 / 400);
  } else {
    // Daypart 6 is NOT the same rate. It is only 200 ticks long but covers
    // 1:00 AM to 6:58 AM, so it runs at twelve — the night passes quickly,
    // which is the mirror of the morning crawling. Getting this wrong is
    // invisible except at the endpoint.
    const v = r * 12;
    hour24 = 1 + Math.floor(v / 400);
    minute = Math.floor((v % 400) * 60 / 400);
  }

  // The reference clamps here, which is what produces the observed endpoints
  // 11:59, 12:59 and 6:58 rather than exact linear ones.
  minute = Math.min(59, minute);
  hour24 %= 24;
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour, minute, pm: hour24 >= 12, hour24 };
}

/** `7:04 AM`. */
export const formatClock = (dayTick) => {
  const { hour, minute, pm } = clockTime(dayTick);
  return hour + ':' + String(minute).padStart(2, '0') + ' ' + (pm ? 'PM' : 'AM');
};
