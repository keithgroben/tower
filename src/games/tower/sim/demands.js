/**
 * **The tower demands things back** (issue #13): the notices, and the one place
 * that remembers which of them are still true.
 *
 * Spec: `specs/facility/MEDICAL.md` § Notifications (*"Medical uses exactly one
 * notification string: **'Medical Center demanded near Lobby'**"* and the *"shared
 * once-per-day notification flag"*), `specs/facility/PARKING.md` § Demand Families
 * (*"On assignment failure, the status bar shows 'Office workers demand Parking'"*),
 * `specs/facility/RECYCLING.md` § Adequacy (notification `3` when there is no
 * center, notification `4` - *"Recycling Centers are full!"* - when the final
 * tier-5 check fails), `specs/OUTPUTS.md` § Notifications (*"Exact UI presentation
 * is implementation-defined. Timing relative to simulation state changes is not."*).
 *
 * ## What this is, and what it is not
 *
 * A demand is a **fact about the tower** ("an office worker wanted a parking space
 * and there was none"), raised by the sim at the moment it happens and cleared by
 * the sim when something answers it. The notice is the sentence that goes with it.
 * The sim holds both in plain JSON on `tower.demands`, so a save carries them and
 * the headless harness can read exactly what the HUD reads - *"numbers worth
 * showing go in the world or the HUD"* (`CLAUDE.md`), and a notice that only the
 * browser could see would be a notice no test could ever fail.
 *
 * The UI reads; it never writes (`CLAUDE.md` rule 1). `ui/main.js` says each new
 * notice on the status line and lists the live demands on the bar.
 *
 * ## Once a day
 *
 * `MEDICAL.md`: *"the banner re-fires (once per day, guarded by the shared
 * once-per-day notification flag)"*. Every demand kind keeps its own day stamp
 * rather than sharing one flag, so a parking notice cannot swallow a medical one
 * on the same day - `spec/DEVIATIONS.md` A56. A demand that is raised again on the
 * same day stays live and counts, but posts no second notice.
 */

/**
 * The notices, by kind. `text` is the exact string the player reads.
 *
 * The wording of the first four comes from the spec / the original; the rest is
 * ours, because the sources give a notification NUMBER and not a string
 * (`TIME.md` § 2000: *"fire popup `3` ('recycling insufficient')"*). All of it is
 * recorded in `spec/DEVIATIONS.md` A56.
 */
export const DEMAND = {
  /** `MEDICAL.md` § Notifications, verbatim. */
  medical: { text: 'Medical Center demanded near Lobby' },
  /** `PARKING.md` § Demand Families, verbatim. */
  officeParking: { text: 'Office workers demand Parking' },
  /** Not in `specs/`: the issue lists a suite demand, the sources give no string. */
  suiteParking: { text: 'Hotel Suite guests demand Parking' },
  /** Popup `3`. The sources give no string. */
  recycling: { text: 'The tower demands a Recycling Center' },
  /** Issue #13: a recycling center needs a service elevator stop. */
  recyclingLift: { text: 'A Recycling Center needs a service elevator stop' },
  /** Popup `4`, verbatim from the original (`SimTower-gameplay-analysis.md`). */
  recyclingFull: { text: 'Recycling Centers are full!' },
};

/** The notice log keeps this many lines; older ones fall off the front. */
export const NOTICE_LOG_LIMIT = 40;

/**
 * `tower.demands`, installed on first use so a tower built before this file
 * existed (and a hand-made test tower) still has somewhere to put one.
 *
 * `active[kind]` is `{ since, lastDay, noticeDay, count }`; `notices` is the log of
 * what was said, each `{ id, kind, text, day, tick }`, ids rising from 1.
 */
export function demandsOf(tower) {
  return (tower.demands ??= { active: {}, notices: [], nextNoticeId: 1 });
}

/**
 * Something the tower wanted and could not have. Returns whether this call posted
 * a **new notice** (the first of the day for this kind).
 *
 * @param {object} tower
 * @param {keyof typeof DEMAND} kind
 */
export function raiseDemand(tower, kind) {
  if (!DEMAND[kind]) throw new Error('there is no demand called "' + kind + '"');
  const demands = demandsOf(tower);
  const day = tower.clock?.dayCounter ?? 0;
  const entry = demands.active[kind] ?? { since: day, lastDay: day, noticeDay: null, count: 0 };
  entry.lastDay = day;
  entry.count++;
  demands.active[kind] = entry;

  if (entry.noticeDay === day) return false;
  entry.noticeDay = day;
  demands.notices.push({
    id: demands.nextNoticeId++,
    kind,
    text: DEMAND[kind].text,
    day,
    tick: tower.clock?.dayTick ?? 0,
  });
  if (demands.notices.length > NOTICE_LOG_LIMIT) demands.notices.splice(0, demands.notices.length - NOTICE_LOG_LIMIT);
  return true;
}

/** Something answered the demand. Returns whether it was live. */
export function clearDemand(tower, kind) {
  const demands = demandsOf(tower);
  if (!demands.active[kind]) return false;
  delete demands.active[kind];
  return true;
}

/** Is this demand live right now? */
export const isDemanded = (tower, kind) => Boolean(demandsOf(tower).active[kind]);

/** The live demands, oldest first, as `{kind, text, since, count}`. */
export function activeDemands(tower) {
  return Object.entries(demandsOf(tower).active)
    .map(([kind, entry]) => ({ kind, text: DEMAND[kind]?.text ?? kind, since: entry.since, count: entry.count }))
    .sort((a, b) => a.since - b.since);
}

/** Notices posted after `id` (`0` for all of them) - what a HUD says next. */
export const noticesAfter = (tower, id = 0) => demandsOf(tower).notices.filter((n) => n.id > id);
