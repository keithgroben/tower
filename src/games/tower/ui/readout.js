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
import { MAX_STAR, TOWER_RANK } from '../sim/progression.js';
import { VENUE, VISITOR_BANDS, closurePayout, venueOf } from '../sim/commercial.js';
import { RENT_TIERS } from '../sim/economy.js';
import { FAMILY, OBJECT_TYPE } from '../sim/state.js';
import { pendingVisitors } from '../sim/medical.js';
import { recyclingServed } from '../sim/recycling.js';
import { SPACE_CAPACITY, rampConnected } from '../sim/parking.js';
import {
  PARTY_HALL_MIN_HOTEL_ROOMS, PHASE, filmTitle, hotelRoomCount, payoutFor, recordOf,
} from '../sim/entertainment.js';

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

// ------------------------------------------------------------ infestations

/**
 * What to say when hotel rooms are lost to cockroaches.
 *
 * Like an eviction it is **not softened**: a room left dirty through three
 * daily passes is gone for good, and the only cure is to demolish it
 * (`specs/facility/HOTEL.md` § Cockroach Infestation). The sentence gives the
 * cause for the same reason `evictionNotice` does — a loss you can explain is a
 * lesson, and a room that turns red on its own is a bug report.
 *
 * @param gained how many more rooms are infested than a moment ago
 * @returns a sentence, or `''` when nothing was lost
 */
export function infestationNotice(gained) {
  if (!(gained > 0)) return '';
  const rooms = gained === 1 ? '1 hotel room' : gained + ' hotel rooms';
  return rooms + ' infested — left dirty for three days; only demolishing a room cures it';
}

/**
 * The hotel's health, in the few words a bar has: how many rooms are waiting to
 * be cleaned and how many are lost. Empty when both are zero, so a tower with no
 * hotel (or a clean one) says nothing at all.
 */
export function hotelHealthReadout(dirty, infested) {
  const parts = [];
  if (dirty > 0) parts.push(dirty + ' dirty');
  if (infested > 0) parts.push(infested + ' infested');
  return parts.join(' · ');
}

// ------------------------------------------------------------ service facilities

/**
 * The line over a clinic, a recycling center, a parking space or a ramp (issue #13),
 * or `''` for anything else. Each says the one thing a player cannot read off the
 * building: whether it is doing its job. A space no ramp reaches, a ramp that does
 * not meet the lobby and a center no service lift stops at all look fine from outside
 * and all do nothing, which is the failure this repo keeps a list of.
 */
export function serviceReadout(object, tower) {
  switch (object?.family) {
    case FAMILY.medical:
      return 'medical center · ' + pendingVisitors(object) + ' waiting · office workers visit from 3 stars, about 1 in 10 a day';
    case FAMILY.recycling:
      return 'recycling center · ' + (recyclingServed(tower, object.type === OBJECT_TYPE.recyclingUpper ? object : tower.objects.get(object.stackId) ?? object)
        ? 'a service lift stops here, so it counts'
        : 'NO service lift stops here, so it does not count')
        + ' · covers under 2,500 activity · cannot be bulldozed';
    case FAMILY.parkingSpace:
      return 'parking space · ' + (object.parking?.cars?.length ?? 0) + ' of ' + SPACE_CAPACITY + ' cars · '
        + (object.coverageFlag === 1 ? 'a ramp serves it' : 'BLOCKED - no ramp reaches it');
    case FAMILY.parkingRamp:
      return 'parking ramp · ' + (rampConnected(tower, object) ? 'meets the lobby' : 'CUT OFF from the lobby')
        + ' · serves the spaces beside it on this floor';
    default:
      return '';
  }
}

/** The tower's live demands as the bar says them, or `''` when it asks for nothing. */
export const demandsReadout = (demands) => demands.map((d) => d.text).join(' · ');

// ------------------------------------------------------------------- stars

/** `★★☆☆☆`. One glyph, per the brief — the clause beside it does the talking. */
export function starGlyph(star, max = MAX_STAR) {
  const filled = Math.max(0, Math.min(max, Math.round(star) || 0));
  return '★'.repeat(filled) + '☆'.repeat(max - filled);
}

/** How long a star rise stays on the line under the tower: long enough to be read twice. */
export const STAR_RISE_MS = 7000;

/**
 * Which of a frame's new notices the line under the tower says, and how (issue #14).
 *
 * A frame can carry several; the line holds one. A star rise outranks a complaint -
 * *"The tower has reached 3 stars"* must not be swallowed by a parking notice posted the
 * same tick - and is drawn as good news and held longer. Otherwise the newest wins, as
 * it always did. `rise` tells the caller to pulse the stars.
 *
 * @param {{text:string, good?:boolean}[]} fresh notices posted since the last look
 * @returns {{text:string, ok:boolean, ms:number|null, rise:boolean}|null}
 */
export function noticeToSay(fresh) {
  if (!fresh || fresh.length === 0) return null;
  const rise = fresh.find((n) => n.good) ?? null;
  const shown = rise ?? fresh[fresh.length - 1];
  return { text: shown.text, ok: Boolean(rise), ms: rise ? STAR_RISE_MS : null, rise: Boolean(rise) };
}

/** The tooltip on the stars: the population the ladder counted, and what it left out. */
export function starTitle(status) {
  if (!status) return '';
  return 'population ' + grouped(status.activity)
    + (status.hotelsCounted === false ? ' (hotel guests no longer count toward stars)' : '');
}

/** `1,000`. The population the bar quotes is a figure a player compares, so it is grouped. */
const grouped = (n) => Math.round(n).toLocaleString('en-US');

/** `3 stars`, `Tower`: the rung a clause is about. */
export const rungName = (star) => (star >= TOWER_RANK ? 'Tower' : star + (star === 1 ? ' star' : ' stars'));

/**
 * The clause beside the stars: **everything** standing between this tower and its
 * next rung, in the words a player would use (issue #14):
 *
 *   `Next: 3 stars - need 1,000 population (now 640), a security office`
 *   `Next: 4 stars - need 5,000 population (now 3,120), 2 hotel suites, a favorable VIP
 *    stay (VIP visits are not in this build yet); wait for the evening (after 5 PM)`
 *
 * It lists the lot, not the first one: the bar's old "one blocker" answer left a
 * player with eight things to discover one at a time, and the issue's point is that
 * the game says exactly what is missing. Needs come first, joined by commas; what is
 * only a wait (the evening, a weekday, a morning) follows the semicolon, because a
 * player can build the one and can only sit through the other.
 *
 * ⚠️ **A named requirement this build cannot make says so**, in the same breath.
 * Higher rungs ask for a metro station, a cathedral, a VIP's good opinion: some have
 * no palette entry yet and some have no system behind them at all. A player who spends
 * an hour hunting a button that does not exist stops believing the next thing the bar
 * tells them, and that credit is much harder to win back than a feature is to ship.
 * Two caveats, and they are different:
 *
 *   - `unavailable` on a blocker (from `sim/progression.js`): the SYSTEM that would
 *     satisfy it is not in the build - the reason is printed as the sim wrote it.
 *   - a `kind` the palette cannot build: *"(nothing builds one yet)"*.
 *
 * `buildable` decides the second, and it is passed in rather than worked out here:
 * the UI knows what the palette holds, and matching a blocker's prose to a buildable
 * would be a rule inferred from a sentence.
 *
 * Pure, and the population it quotes is `status.activity`, which is what the ladder
 * itself compared - the bar cannot say 640 while the sim reads 700.
 *
 * @param status    from `starGateStatus(tower)`
 * @param buildable `(kind) => boolean`, or null when buildability cannot be known
 */
export function starClause(status, buildable = null) {
  if (!status) return '';
  if (status.nextStar === null) return 'Tower rank - the top of the ladder';
  const next = rungName(status.nextStar);
  if (status.ready) return 'ready for ' + next;

  const needs = [];
  const waits = [];
  // `starGateStatus` puts the population shortfall first, when there is one, and
  // says it as "N more tower activity": the bar says the same fact as a target.
  const entries = status.blockerDetails ?? status.blockers;
  entries.forEach((entry, index) => {
    if (index === 0 && !status.activityReady) {
      const target = status.threshold ?? (status.activity + status.activityNeeded);
      needs.push(grouped(target) + ' population (now ' + grouped(status.activity) + ')');
      return;
    }
    const detail = typeof entry === 'string' ? { text: entry, kind: null } : entry;
    let text = detail.text;
    if (detail.unavailable) text += ' (' + detail.unavailable + ')';
    else if (detail.kind && buildable && !buildable(detail.kind)) text += ' (nothing builds one yet)';
    (detail.window ? waits : needs).push(text);
  });

  const parts = [];
  if (needs.length) parts.push('need ' + needs.join(', '));
  if (waits.length) parts.push('wait for ' + waits.join(' and '));
  return 'Next: ' + next + ' - ' + parts.join('; ');
}

// ------------------------------------------------------------------- venues

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');

/**
 * The line under the pointer for a restaurant, a fast food or a shop, or `''`
 * for anything that is not one.
 *
 * It states the thing a venue's owner is actually asking: **what is today worth,
 * and how far off the next band am I.** A restaurant is paid once, at closing,
 * and the lowest band is a LOSS, so "23 diners" alone reads as a number and not
 * as "you are about to pay $6,000 for the privilege" - which is what it is.
 * Computed from the same `closurePayout` the closing sweep pays out of.
 */
export function venueReadout(object) {
  const record = venueOf(object);
  if (!record) return '';
  const name = object.family === FAMILY.restaurant ? 'restaurant'
    : object.family === FAMILY.retail ? 'shop' : 'fast food';

  if (object.family === FAMILY.retail) {
    if (record.availability === VENUE.dormant) {
      return name + ' · unrented - it opens when its first customer reaches it';
    }
    return name + ' · open · rent ' + money(RENT_TIERS.retail[object.rentLevel] ?? 0) + ' a quarter · +10 people';
  }

  const visitors = record.acquireCount;
  const pays = closurePayout(object.family, visitors);
  const next = VISITOR_BANDS.find((band) => visitors < band);
  const people = object.family === FAMILY.restaurant ? 'diners' : 'customers';
  return name + ' · ' + visitors + ' ' + people + ' today · closing pays ' + money(pays)
    + (next === undefined ? '' : ' · ' + next + ' pays ' + money(closurePayout(object.family, next)));
}

/**
 * One line over a theater or a party hall: the film, and what the day is worth.
 * Computed from the same payout the 1900 / 1600 checkpoint pays out of, so the
 * line cannot promise a figure the sweep will not pay. Empty for anything else.
 *
 * `tower` is optional; with it a party hall can say WHY it is idle (no hotel
 * rooms), which is the one thing a player cannot read off the building.
 */
export function entertainmentReadout(object, tower = null) {
  const record = object?.family === FAMILY.theater || object?.family === FAMILY.partyHall
    ? (tower ? recordOf(tower, object) : (object.venue ?? null)) : null;
  if (!record) return '';
  const live = record.phase >= PHASE.activated;
  const attendance = live ? record.attendance : record.lastAttendance;
  const pays = live ? payoutFor(record) : record.lastPayout;
  if (record.variant === 'theater') {
    return 'theater · showing ' + filmTitle(record.selector) + ' · '
      + attendance + ' seats ' + (live ? 'today' : 'yesterday') + ' · pays ' + money(pays);
  }
  if (!live && tower && hotelRoomCount(tower) < PARTY_HALL_MIN_HOTEL_ROOMS) {
    return 'party hall · no party without hotel rooms in the tower';
  }
  return 'party hall · ' + attendance + ' guests ' + (live ? 'today' : 'yesterday') + ' · pays ' + money(pays);
}
