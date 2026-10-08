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

  '⚠️ the clause names the number a player can move, and the number they have'() {
    // The measured complaint: the idle seed sits short of 300 at star 1 forever, and the
    // game never says by how much. Issue #14: it says the target AND where the tower is.
    const { tower } = seedDemoWorld({ seed: 1 });
    const status = starGateStatus(tower);
    assert(status.star === 1 && status.nextStar === 2, 'the seed opens on the first rung');

    const clause = starClause(status, () => true);
    assert(clause === 'Next: 2 stars - need 300 population (now ' + status.activity + ')', clause);
  },

  'the clause lists EVERYTHING missing, in plain words'() {
    const status = {
      star: 2, nextStar: 3, activity: 640, threshold: 1000, activityNeeded: 360, activityReady: false,
      blockers: ['360 more tower activity', 'a security office'],
      blockerDetails: [{ text: '360 more tower activity', kind: null }, { text: 'a security office', kind: 'security' }],
      ready: false,
    };
    assert(starClause(status, () => true) === 'Next: 3 stars - need 1,000 population (now 640), a security office',
      starClause(status, () => true));

    // And thousands are grouped, so 5,000 against 3,120 is readable at a glance.
    const big = { ...status, star: 3, nextStar: 4, activity: 3120, threshold: 5000, blockers: ['x', 'y'],
      blockerDetails: [{ text: 'x', kind: null }, { text: 'two hotel suites', kind: 'hotelSuite' }] };
    assert(starClause(big, () => true) === 'Next: 4 stars - need 5,000 population (now 3,120), two hotel suites',
      starClause(big, () => true));
  },

  'what is only a wait comes after the needs, and says wait'() {
    const status = {
      star: 3, nextStar: 4, activity: 5200, threshold: 5000, activityNeeded: 0, activityReady: true,
      blockers: ['a hotel suite', 'the evening (after 5 PM)', 'a weekday'],
      blockerDetails: [
        { text: 'a hotel suite', kind: 'hotelSuite' },
        { text: 'the evening (after 5 PM)', kind: null, window: true },
        { text: 'a weekday', kind: null, window: true },
      ],
      ready: false,
    };
    assert(starClause(status, () => true) === 'Next: 4 stars - need a hotel suite; wait for the evening (after 5 PM) and a weekday',
      starClause(status, () => true));
    // Only waiting: no "need" at all, or the bar sends a player to build a time of day.
    const waiting = { ...status, blockers: status.blockers.slice(1), blockerDetails: status.blockerDetails.slice(1) };
    assert(starClause(waiting, () => true) === 'Next: 4 stars - wait for the evening (after 5 PM) and a weekday',
      starClause(waiting, () => true));
  },

  '⚠️ a requirement nothing can build says so'() {
    // The trap: a metro station or a cathedral has no palette entry yet. A player who
    // hunts a button that does not exist stops believing the next thing the bar tells them.
    const status = {
      star: 4, nextStar: 5, activity: 11_000, threshold: 10_000, activityNeeded: 0, activityReady: true,
      blockers: ['a metro station'],
      blockerDetails: [{ text: 'a metro station', kind: 'metroStation' }], ready: false,
    };
    const honest = starClause(status, (kind) => kind === 'office');
    assert(honest.includes('a metro station'), 'it still names the thing: ' + honest);
    assert(/nothing builds one yet/.test(honest), 'and admits it cannot be built: ' + honest);

    // And when it CAN be built, no caveat - the caveat must not become wallpaper.
    const buildable = starClause(status, () => true);
    assert(!/nothing builds/.test(buildable), 'a buildable requirement gets no excuse: ' + buildable);
    assert(buildable === 'Next: 5 stars - need a metro station', buildable);
  },

  '⚠️ a requirement whose system is not in the build says why, in the sim words'() {
    const status = {
      star: 3, nextStar: 4, activity: 6000, threshold: 5000, activityNeeded: 0, activityReady: true,
      blockers: ['a favorable VIP stay'],
      blockerDetails: [{ text: 'a favorable VIP stay', kind: null, unavailable: 'VIP visits are not in this build yet' }],
      ready: false,
    };
    const clause = starClause(status, () => true);
    assert(clause === 'Next: 4 stars - need a favorable VIP stay (VIP visits are not in this build yet)', clause);
  },

  'bare-string blockers still read correctly'() {
    // The clause handles both shapes so the display is right either way.
    const status = {
      star: 1, nextStar: 2, activity: 216, activityNeeded: 84, activityReady: false,
      blockers: ['84 more tower activity'], ready: false,
    };
    assert(starClause(status, () => true) === 'Next: 2 stars - need 300 population (now 216)', starClause(status));
    assert(starClause(status, null) === 'Next: 2 stars - need 300 population (now 216)', 'and with no buildability oracle');
  },

  'a tower with nothing left to do says that instead'() {
    const ready = {
      star: 2, nextStar: 3, activity: 5000, activityNeeded: 0, activityReady: true,
      blockers: [], ready: true,
    };
    assert(starClause(ready, () => true) === 'ready for 3 stars', starClause(ready));
    assert(starClause({ ...ready, star: 5, nextStar: 6 }, () => true) === 'ready for Tower',
      starClause({ ...ready, star: 5, nextStar: 6 }));

    const top = {
      star: 6, nextStar: null, activity: 99999, activityNeeded: 0, activityReady: true,
      blockers: ['nothing'], ready: false,
    };
    assert(starClause(top, () => true) === 'Tower rank - the top of the ladder', starClause(top, () => true));
  },

  'a missing status is silence, not a crash'() {
    // The HUD draws ten times a second. A readout that throws takes the frame
    // handler with it and pauses the game.
    assert(starClause(null) === '', 'null status');
    assert(starClause(undefined) === '', 'undefined status');
  },
};
