/**
 * The sentences on the bar.
 *
 * Pulled out of `ui/main.js` because these are the parts of the HUD that are
 * *claims about the tower*, and a claim can be wrong in a way a layout cannot.
 * Every function here is pure and every one of them is tested against the state
 * that made the old phrasing wrong.
 *
 * The rule running through all of it: **the bar must not say something false
 * while the tower is behaving correctly.** Twice now it has — "no trips yet"
 * about three hundred commuters, and a tenant count that halved with no
 * explanation — and both times the sim was right and the sentence was wrong.
 * That is worse than a missing readout, because a player cannot tell a lying
 * HUD from a broken game, and the first thing they distrust is the game.
 */
import { stressBand } from '../sim/stress.js';
import { MAX_STAR } from '../sim/progression.js';

// ------------------------------------------------------------------ stress

/**
 * What to say about the typical worker's stress.
 *
 * ⚠️ **The counters empty every third day.** Checkpoint 2533 clears
 * `trip_count` and `accumulated_elapsed` for every occupant — correct, and the
 * thing that makes evaluation a rolling judgement rather than a lifetime
 * record. But for the moment afterwards nobody in the tower has a trip on
 * record, and the readout said **"no trips yet"** about a tower carrying three
 * hundred commuters. It caught Keith out in the harness before he worked out
 * what he was reading.
 *
 * So a reading is *held* across the reset and marked as being re-measured,
 * rather than replaced by a sentence that is false. The held value is at most a
 * second or two stale — the samples come back within a refresh stride — and a
 * slightly old true number beats a fresh lie.
 *
 * "No trips yet" survives for the one case where it is *true*: a tower that has
 * genuinely never moved anybody. Once there has been a reading, that phrasing
 * never comes back.
 *
 * @param scores   this frame's per-worker stress, workers with no trips excluded
 * @param previous the last number this returned, or null if there has not been one
 * @returns {{text:string, value:number|null, band:string|null, measuring:boolean}}
 */
export function stressReadout(scores, previous = null) {
  if (scores.length > 0) {
    // The median, not the mean. A worker in an unreachable office fails a route
    // every service tick and laps the byte-wide `trip_count`, so their average
    // lands in the thousands; thirty-six of those drag a mean to 478 on a tower
    // that is almost entirely fine.
    const sorted = [...scores].sort((a, b) => a - b);
    const value = sorted[Math.floor(sorted.length / 2)];
    const band = stressBand(value);
    return { text: 'stress ' + value + ' (' + band + ')', value, band, measuring: false };
  }
  if (previous === null) return { text: 'no trips yet', value: null, band: null, measuring: false };
  const band = stressBand(previous);
  return { text: 'stress ' + previous + ' · re-measuring', value: previous, band, measuring: true };
}

// --------------------------------------------------------------- evictions

/**
 * What to say when the let count falls.
 *
 * An eviction day takes the seed from 78 tenants to 24 and the bar currently
 * says nothing at all, so the tower appears to break. **It is not softened
 * here** — the eviction is the loop working, and dressing it up would hide the
 * one moment the game most needs to be understood. It is given its cause
 * instead, because a consequence you can explain is a lesson and a number that
 * halves on its own is a bug report.
 *
 * A drop in the *let* count is always an eviction: `applyAction` refuses to
 * demolish a let unit, so nothing else can take one away.
 *
 * @returns a sentence, or `''` when nothing was lost
 */
export function evictionNotice(lost) {
  if (!(lost > 0)) return '';
  const units = lost === 1 ? '1 office' : lost + ' offices';
  return units + ' closed — the journeys their tenants made scored too badly to stay';
}

// ------------------------------------------------------------------- stars

/** `★★☆☆☆`. One glyph, per the brief — the clause beside it does the talking. */
export function starGlyph(star, max = MAX_STAR) {
  const filled = Math.max(0, Math.min(max, Math.round(star) || 0));
  return '★'.repeat(filled) + '☆'.repeat(max - filled);
}

/**
 * The clause beside the stars: the one thing standing between this tower and
 * its next one.
 *
 * **One blocker, not a list.** `starGateStatus` orders them activity-first
 * deliberately — there is no point naming a metro station to somebody four
 * thousand tenants short of being asked for one — so the first is the one worth
 * a player's attention, and a bar is not a checklist.
 *
 * ⚠️ **A named requirement this build cannot make says so.** Higher rungs ask
 * for a security office, a recycling centre, a metro station; none of those has
 * a family yet, let alone a palette entry. A player who spends an hour hunting
 * a button that does not exist stops believing the next thing the bar tells
 * them, and that credit is much harder to win back than a feature is to ship.
 *
 * `buildable` decides that, and it is passed in rather than worked out here:
 * the UI knows what the palette holds, and matching a blocker's prose to a
 * buildable would be a rule inferred from a sentence.
 *
 * @param status    from `starGateStatus(tower)`
 * @param buildable `(kind) => boolean`, or null while the sim reports blockers
 *                  as bare strings and buildability cannot be known
 */
export function starClause(status, buildable = null) {
  if (!status) return '';
  if (status.nextStar === null) return status.blockers[0] ?? 'the top of the ladder';
  if (status.ready) return 'ready for ' + (status.nextStar) + ' stars';

  const first = status.blockers[0];
  if (first === undefined) return 'ready for ' + status.nextStar + ' stars';

  // Blockers are either bare strings or `{text, kind}`. Both are handled so the
  // clause is right either way, and the caveat appears the moment the sim can
  // say which requirement a blocker names.
  const text = typeof first === 'string' ? first : first.text;
  const kind = typeof first === 'string' ? null : first.kind;

  // The activity number is always actionable — build, and it moves — so it is
  // stated bare, as a target.
  if (!status.activityReady) return text;

  if (kind && buildable) {
    return buildable(kind)
      ? 'waiting on: ' + text
      : 'waiting on: ' + text + ' — nothing builds one yet';
  }

  // ⚠️ Buildability unknown, because the blocker arrived as a bare string.
  //
  // "waiting on:" implies *go and do it*, and at star 2 the requirement is a
  // security office, which has no family and no palette entry — so that
  // phrasing would send a player hunting a button that does not exist, which is
  // precisely the credit that is hardest to win back. "next:" names the same
  // requirement without promising it is available.
  //
  // Substring-matching the prose to work out the kind is not an option: "an
  // office" and "a security office" both contain "office", and they are the two
  // cases that differ. The fix is `kind` on the blocker; this is what the bar
  // says honestly until then.
  return 'next: ' + text;
}
