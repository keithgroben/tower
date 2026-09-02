/**
 * The sentences on the bar, tested against the states that made the old ones
 * wrong.
 *
 * Each of these is a real observation from a playtest, not an invented edge
 * case: a tower of three hundred commuters that said "no trips yet", a tenant
 * count that halved in silence, and a tower that sat at one star forever
 * without the game ever saying what it was short of.
 *
 * They are worth tests because a wrong sentence is indistinguishable from a
 * broken game to the person reading it — and the sim was right all three times.
 */
import { MAX_STAR, STAR_THRESHOLDS, starGateStatus } from '../src/games/tower/sim/progression.js';
import { STRESS_PINK, STRESS_RED } from '../src/games/tower/sim/stress.js';
import { evictionNotice, starClause, starGlyph, stressReadout } from '../src/games/tower/ui/readout.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

export const tests = {
  // ------------------------------------------------------------------ stress

  '⚠️ the three-day counter reset does not make the bar lie'() {
    // Checkpoint 2533 clears every trip counter. Correct — it is what makes
    // evaluation a rolling judgement — but for the moment afterwards there are
    // no samples, and the readout said "no trips yet" about a full tower. It
    // caught Keith out in the harness before he worked out what he was reading.
    const running = stressReadout([70, 84, 90]);
    assert(running.value === 84, 'a normal reading is the median: ' + running.value);
    assert(!running.measuring, 'and it is not marked stale');

    const justReset = stressReadout([], running.value);
    assert(justReset.value === 84, 'the reading is held across the reset');
    assert(justReset.measuring, 'and flagged as being re-measured');
    assert(!justReset.text.includes('no trips'),
      'it must never claim a tower of commuters has taken no trips: ' + justReset.text);
    assert(justReset.text.includes('84'), 'the number a player last saw is still there');
  },

  'a tower that genuinely never moved anybody still says so'() {
    // The phrasing is not wrong, it was only wrong in the wrong place. With no
    // previous reading there is nothing to hold, and "no trips yet" is exactly
    // true.
    const cold = stressReadout([], null);
    assert(cold.text === 'no trips yet', cold.text);
    assert(cold.value === null && !cold.measuring, 'and nothing is being held');
  },

  'the reading is the median, so the stranded cannot drag it'() {
    // A worker in an unreachable office laps the byte-wide `trip_count` and
    // scores in the thousands. Three of those against six commuters must not
    // move the number a player reads.
    const healthy = [70, 72, 75, 80, 84, 88];
    const withStranded = [...healthy, 2177, 2552, 3100];
    assert(stressReadout(withStranded).value <= 88,
      'the stranded moved the reading to ' + stressReadout(withStranded).value);
  },

  'the band comes from stressBand, at both edges'() {
    assert(stressReadout([STRESS_PINK - 1]).band === 'black', 'below 80 is calm');
    assert(stressReadout([STRESS_PINK]).band === 'pink', '80 is the pink edge');
    assert(stressReadout([STRESS_RED]).band === 'red', '120 is the red edge');
    // A held reading keeps its band, or the colour would go blank while the
    // number stayed put.
    assert(stressReadout([], STRESS_RED).band === 'red', 'a held reading keeps its colour');
  },

  // --------------------------------------------------------------- eviction

  '⚠️ an eviction says what happened, and is not softened'() {
    // 78 tenants to 24 with nothing on screen. The eviction is the loop
    // working; it needed a cause, not a cushion.
    const many = evictionNotice(18);
    assert(many.includes('18 offices closed'), 'it leads with the fact: ' + many);
    assert(/scored too badly|too badly to stay/.test(many), 'and gives the cause: ' + many);
    // Nothing that reframes a loss as neutral or fine.
    assert(!/don't worry|normal|fine|just|only|temporar/i.test(many), 'not softened: ' + many);
  },

  'one office is not "1 offices"'() {
    assert(evictionNotice(1).startsWith('1 office closed'), evictionNotice(1));
  },

  'nothing lost, nothing said'() {
    for (const n of [0, -3, null, undefined, NaN]) {
      assert(evictionNotice(n) === '', 'a gain or a nothing must be silent: ' + JSON.stringify(n));
    }
  },

  // ------------------------------------------------------------------ stars

  'the glyph shows the rung and the ladder'() {
    assert(starGlyph(0) === '☆☆☆☆☆', 'no stars: ' + starGlyph(0));
    assert(starGlyph(1) === '★☆☆☆☆', 'one star: ' + starGlyph(1));
    assert(starGlyph(MAX_STAR) === '★'.repeat(MAX_STAR), 'all of them: ' + starGlyph(MAX_STAR));
    assert(starGlyph(99).length === MAX_STAR, 'it cannot overflow the ladder');
    assert(starGlyph(-4) === '☆'.repeat(MAX_STAR), 'nor underflow it');
  },

  '⚠️ the clause names the number a player can move'() {
    // The measured complaint: the idle seed sits at 216 activity against 300
    // and star 1 forever, and the game never says the player is 84 short.
    const { tower } = seedDemoWorld({ seed: 1 });
    const status = starGateStatus(tower);
    assert(status.star === 1 && status.nextStar === 2, 'the seed opens on the first rung');

    const clause = starClause(status, () => true);
    assert(/\d+ more tower activity/.test(clause), 'it has to be a number: ' + clause);
    assert(clause.includes(String(STAR_THRESHOLDS[0] - status.activity)),
      'and the right one: ' + clause + ' (activity ' + status.activity + ')');
  },

  '⚠️ a requirement nothing can build says so'() {
    // The trap: at star 2 the blocker is a security office, which has no family
    // and no palette entry. A player who hunts a button that does not exist
    // stops believing the next thing the bar tells them.
    const status = {
      star: 2, nextStar: 3, activity: 1200, activityNeeded: 0, activityReady: true,
      blockers: ['a security office'],
      blockerDetails: [{ text: 'a security office', kind: 'security' }], ready: false,
    };
    const honest = starClause(status, (kind) => kind === 'office');
    assert(honest.includes('a security office'), 'it still names the thing: ' + honest);
    assert(/nothing builds one yet/.test(honest), 'and admits it cannot be built: ' + honest);

    // And when it CAN be built, no caveat — the caveat must not become wallpaper.
    const buildable = starClause(status, () => true);
    assert(!/nothing builds/.test(buildable), 'a buildable requirement gets no excuse: ' + buildable);
    assert(buildable.includes('waiting on'), buildable);
  },

  'bare-string blockers still read correctly'() {
    // `starGateStatus` reports strings today and may report `{text, kind}`
    // later. The clause handles both so the display is right either way, and so
    // the change can land without this file moving.
    const status = {
      star: 1, nextStar: 2, activity: 216, activityNeeded: 84, activityReady: false,
      blockers: ['84 more tower activity'], ready: false,
    };
    assert(starClause(status, () => true) === '84 more tower activity', starClause(status));
    assert(starClause(status, null) === '84 more tower activity', 'and with no buildability oracle');
  },

  '⚠️ an unknown requirement is named, not promised'() {
    // While blockers are bare strings the UI cannot know whether a security
    // office is buildable — and it is not. "waiting on:" would read as *go and
    // do it* and send a player hunting a palette entry that does not exist.
    // "next:" states the same requirement without the promise.
    //
    // Substring-matching the prose is not an escape: "an office" and "a
    // security office" both contain "office", and those are exactly the two
    // cases that differ.
    const status = {
      star: 2, nextStar: 3, activity: 1200, activityNeeded: 0, activityReady: true,
      blockers: ['a security office'], ready: false,
    };
    const clause = starClause(status, () => true);
    assert(clause === 'next: a security office', clause);
    assert(!clause.includes('waiting on'),
      'a bare string must not promise the thing can be built: ' + clause);
  },

  'a tower with nothing left to do says that instead'() {
    const ready = {
      star: 2, nextStar: 3, activity: 5000, activityNeeded: 0, activityReady: true,
      blockers: [], ready: true,
    };
    assert(starClause(ready, () => true) === 'ready for 3 stars', starClause(ready));

    const top = {
      star: MAX_STAR, nextStar: null, activity: 99999, activityNeeded: 0, activityReady: true,
      blockers: ['nothing — beyond 5 stars is the cathedral’s path, not this one'], ready: false,
    };
    assert(starClause(top, () => true).includes('cathedral'), 'the top rung keeps its own words');
  },

  'a missing status is silence, not a crash'() {
    // The HUD draws ten times a second. A readout that throws takes the frame
    // handler with it and pauses the game.
    assert(starClause(null) === '', 'null status');
    assert(starClause(undefined) === '', 'undefined status');
  },
};
