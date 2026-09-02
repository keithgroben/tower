/**
 * Stars — the only thing in the game that says you are winning.
 *
 * Spec: `specs/GAME-STATE.md` § Star Advancement, § Gate Meanings, § Office
 * Service Evaluation. Thresholds from the reference's
 * `compute_tower_tier_from_ledger` (`1148:041d`).
 *
 * Two independent checks, and **both** must pass, every tick:
 *
 *   1. **Activity.** The population ledger's running total crosses the next
 *      tier's threshold. That total is the same ledger the economy maintains —
 *      `+6` when an office rents, `-6` when it is vacated — so a tower's rank
 *      is a direct consequence of how many tenants its lifts can actually
 *      serve. Nothing else feeds it.
 *   2. **A qualitative checklist.** Facilities placed, recycling adequate, an
 *      office-service evaluation passed, and — for the top two rungs — a time
 *      window: evening, and not on a calendar-phase day.
 *
 * ## Three things worth knowing before reading the gates
 *
 * **`route_viable` is not a route test.** The name says it should measure
 * whether the tower's transport works. `specs/GAME-STATE.md` § Gate Meanings
 * says the binary is narrower than that, in the authors' own words: a new game
 * clears it, the start-of-day path sets it to `1` whenever `star_count > 2`,
 * and no other writer was found. So it is really "a day has begun since you
 * reached 3 stars". Implemented as it behaves, not as it reads.
 *
 * **The ladder is self-consistent with the unlock table, and deliberately so.**
 * A security office needs 2 stars, and 2→3 needs a security office. Recycling
 * needs 3 stars, and 3→4 needs recycling. Each rung buys the tool the next rung
 * demands, which is why the population thresholds alone never let you skip one.
 *
 * **Most of this checklist cannot be satisfied in this build**, because
 * security, recycling, medical and metro do not exist as families yet. The
 * gates are implemented anyway and refuse by *name*: `starGateStatus()` says
 * "a security office" rather than silently failing. Dropping a gate to make the
 * ladder passable would be the worst available option — a tower that advances
 * because a requirement was skipped teaches the player something false, and
 * `CLAUDE.md` already keeps a list of metrics that improved while the thing
 * they measured got worse.
 */
import { EVENING_DAYPART } from './clock.js';
import { TYPE_CODES } from './economy.js';
import { FAMILY } from './state.js';

/**
 * Activity totals that unlock each tier, from the reference's tier table
 * (binary `DS:e630..e63c`, plus a hardcoded `15000`). The comparison is `>=`.
 *
 * The last entry never gates a star: reaching tier 6 is the "Tower" rank, and
 * `specs/GAME-STATE.md` says that "uses a separate cathedral/evaluation path
 * rather than the normal star gate". It is kept because the table is the
 * reference's and a short table would be a quiet edit.
 */
export const STAR_THRESHOLDS = [300, 1000, 5000, 10_000, 15_000];

/** The normal ladder stops at 5. Rank 6 is the cathedral's, not this module's. */
export const MAX_STAR = 5;

// ------------------------------------------------------------- gate flags

/**
 * `specs/GAME-STATE.md` § Global Progression Fields, the progression subset.
 *
 * `createTower` does not build these yet, so {@link starGatesOf} installs them
 * on first use. They belong in `sim/state.js` alongside `starCount` the day
 * someone is editing it — this factory is exported so that move is a one-liner
 * and not a second definition.
 */
export function createStarGates() {
  return {
    /** Latched when a security office has ever been placed. Gates 2→3. */
    securityPlaced: false,
    /** Latched when an office has ever been placed. Gates 3→4. */
    officePlaced: false,
    /** Latched when a metro station has ever been placed. Gates 4→5. */
    metroPlaced: false,
    /** Written by the recycling system. Gates 3→4 and 4→5. */
    recyclingAdequate: false,
    /** Written by the office-service evaluation. Gates 3→4; reset on advance. */
    officeServiceOk: false,
    /** Set by the start-of-day rebuild once `star_count > 2`. See the header. */
    routesViable: false,
  };
}

export const starGatesOf = (tower) => (tower.gates ??= createStarGates());

/**
 * Placement gates, by the family that satisfies them.
 *
 * These latch and are never cleared. `specs/GAME-STATE.md` calls them flags and
 * says when they are set but never when they are unset, and the reference sets
 * them at placement; demolishing your only security office is not documented as
 * dropping you a rank. Deriving them live from the object table instead would
 * be a different game — and a demolish-to-fail loop nobody asked for.
 */
const PLACEMENT_GATES = [
  { flag: 'officePlaced', family: FAMILY.office },
  // `sim/state.js` has no name for these two, because no family implements
  // them yet. The codes are the reference's own (`specs/ECONOMY.md`
  // § Construction Costs) and `sim/economy.js` already carries them, so they
  // are read from there rather than written down a third time and left to
  // drift. `FAMILY.office === TYPE_CODES.office === 7`, so the two vocabularies
  // agree where they overlap.
  { flag: 'securityPlaced', family: TYPE_CODES.security },
  { flag: 'metroPlaced', family: TYPE_CODES.metroStation },
];

/**
 * Latch any placement gate a standing object satisfies.
 *
 * Called at the start-of-day checkpoint rather than per tick: a sweep of every
 * object on every tick is 2,600 sweeps a day, which the headless harness would
 * feel. {@link notePlacement} covers the mid-day case, so the daily sweep is
 * only the safety net that catches objects placed outside `applyAction` — the
 * seeded tower, and a loaded save.
 */
export function refreshPlacementGates(tower) {
  const gates = starGatesOf(tower);
  const wanted = PLACEMENT_GATES.filter((g) => !gates[g.flag]);
  if (wanted.length === 0) return gates;

  for (const object of tower.objects.values()) {
    for (const gate of wanted) if (object.family === gate.family) gates[gate.flag] = true;
  }
  return gates;
}

/** Latch immediately when something is placed. `applyAction` calls this. */
export function notePlacement(tower, family) {
  const gates = starGatesOf(tower);
  for (const gate of PLACEMENT_GATES) if (gate.family === family) gates[gate.flag] = true;
  return gates;
}

/**
 * The start-of-day progression refresh, for checkpoint 0.
 *
 * `specs/GAME-STATE.md` § Gate Meanings: `rebuild_path_seed_bucket_table()`
 * "sets it to `1` whenever `star_count > 2`". That rebuild is our tick-0
 * route-table rebuild, so the latch rides with it — which is what produces the
 * documented behaviour that "after reaching 3 stars, the gate stays false until
 * the next day-start rebuild, then latches true".
 */
export function refreshStartOfDayGates(tower) {
  const gates = refreshPlacementGates(tower);
  if (tower.starCount > 2) gates.routesViable = true;
  return gates;
}

// ------------------------------------------------------------- the ladder

/**
 * Total tower activity: the population ledger's running total.
 *
 * `specs/ECONOMY.md` § Ledgers: the population ledger holds "live per-family
 * active-unit counts (drives star thresholds and recycling adequacy tier)".
 * Summed rather than kept as a second running total, because a running total
 * beside the buckets is one more thing that can disagree with them.
 */
export function towerActivity(tower) {
  let total = 0;
  for (const value of Object.values(tower.populationLedger ?? {})) total += value;
  return total;
}

/**
 * The tier this much activity earns, ignoring every qualitative gate.
 *
 * Uncapped on purpose: the reference's `compute_tower_tier_from_ledger` can
 * return 6, and the cap lives in the advance rather than here. Capping the
 * computation would work today and quietly break the cathedral path.
 */
export function starCountForActivity(total) {
  let tier = 1;
  for (let index = 0; index < STAR_THRESHOLDS.length; index++) {
    if (total >= STAR_THRESHOLDS[index]) tier = index + 2;
  }
  return tier;
}

/** Activity still needed to earn the next tier, or 0 when it is already earned. */
export const activityForStar = (star) => STAR_THRESHOLDS[star - 1] ?? Infinity;

/**
 * The qualitative checklist, `specs/GAME-STATE.md` § Star Advancement, keyed by
 * the star you are leaving. Each entry names what is missing, in the words a
 * player would use, because a refusal that does not say what to build is not a
 * refusal — it is a stall.
 *
 * TODO(parity): the reference *implementation* also requires an
 * `officeServiceOkMedical` flag on both the 3→4 and 4→5 transitions, and adds
 * office-service to 4→5 as well. `specs/GAME-STATE.md` § Star Advancement lists
 * neither: it puts "office-service evaluation passed" on 3→4 only and says
 * nothing about a medical variant anywhere in the spec set. Following the spec.
 * If the extra flags are real they make the top of the ladder strictly harder,
 * never easier, so this is the permissive reading — worth Keith's eye.
 */
const QUALITATIVE_GATES = {
  1: [],
  2: [{ flag: 'securityPlaced', missing: 'a security office' }],
  3: [
    { flag: 'officePlaced', missing: 'an office' },
    { flag: 'recyclingAdequate', missing: 'a recycling centre keeping up with the tower' },
    { flag: 'officeServiceOk', missing: 'a passed office-service evaluation' },
    { flag: 'routesViable', missing: 'a day to start since you reached 3 stars' },
  ],
  4: [
    { flag: 'metroPlaced', missing: 'a metro station' },
    { flag: 'recyclingAdequate', missing: 'a recycling centre keeping up with the tower' },
    { flag: 'routesViable', missing: 'a day to start since you reached 3 stars' },
  ],
};

/** The two rungs that also demand an evening, and a day off the calendar phase. */
const TIME_GATED_TIERS = new Set([3, 4]);

/**
 * Everything standing between this tower and its next star.
 *
 * Returns the whole picture rather than a boolean, because "why not yet" is the
 * only part a player can act on. `blockers` is ordered activity-first: there is
 * no point telling someone to build a metro station when they are 4,000 tenants
 * short of even being asked.
 *
 * @returns {{star:number, activity:number, nextStar:number|null, activityNeeded:number,
 *   activityReady:boolean, blockers:string[], ready:boolean}}
 */
export function starGateStatus(tower) {
  const star = tower.starCount;
  const activity = towerActivity(tower);
  const gates = starGatesOf(tower);
  const blockers = [];


  if (star >= MAX_STAR) {
    return {
      star, activity, nextStar: null, activityNeeded: 0, activityReady: true,
      blockers: ['nothing — beyond 5 stars is the cathedral’s path, not this one'],
      ready: false,
    };
  }

  const needed = activityForStar(star);
  const activityReady = starCountForActivity(activity) > star;
  if (!activityReady) blockers.push((needed - activity) + ' more tower activity');

  for (const gate of QUALITATIVE_GATES[star] ?? []) {
    if (!gates[gate.flag]) blockers.push(gate.missing);
  }

  if (TIME_GATED_TIERS.has(star)) {
    // `daypart_index >= 4` and `calendar_phase_flag == 0`. Both are windows
    // rather than tasks, so they are phrased as waiting rather than as building.
    if (tower.clock.daypart < EVENING_DAYPART) blockers.push('the evening');
    if (tower.clock.calendarPhase) blockers.push('a day off the calendar phase');
  }

  return {
    star,
    activity,
    nextStar: star + 1,
    activityNeeded: activityReady ? 0 : needed - activity,
    activityReady,
    blockers,
    ready: blockers.length === 0,
  };
}

/**
 * `specs/GAME-STATE.md` § Office Service Evaluation: "The office-service fields
 * are reset to their initial values at new game start and on each star
 * advancement." Only that one — the placement latches and recycling adequacy
 * survive, which is what stops a tower losing a facility it still owns.
 */
export function resetStarGateState(tower) {
  starGatesOf(tower).officeServiceOk = false;
  return tower.gates;
}

/**
 * The per-tick check. Both halves must pass; one star at a time.
 *
 * The reference runs this every tick from the scheduler rather than at a
 * checkpoint, which matters because two of the gates are time windows: the
 * advance happens the moment the tower is eligible, not at the next checkpoint
 * after it.
 *
 * @returns {{advanced:boolean, star:number, from?:number, blockers:string[]}}
 */
export function tryAdvanceStar(tower) {
  const status = starGateStatus(tower);
  if (tower.starCount >= MAX_STAR || !status.ready) {
    return { advanced: false, star: tower.starCount, blockers: status.blockers };
  }

  const from = tower.starCount;
  tower.starCount = from + 1;
  resetStarGateState(tower);
  return { advanced: true, star: tower.starCount, from, blockers: [] };
}

// ------------------------------------------------------------- unlocks

/**
 * The star a buildable needs before it appears at all, keyed by the same
 * construction-cost names `sim/economy.js` uses — so a palette entry, a price
 * and a lock are three reads of one vocabulary rather than three tables that
 * can disagree. That is the `payout(7, …)` lesson: translate at the seam once.
 *
 * TODO(parity): recovered from the reference implementation's
 * `TILE_STAR_REQUIREMENTS`, which reads the binary's build menu. The spec set
 * confirms only two of them directly — `specs/facility/PARKING.md` § "Requires
 * star level > 2", and `specs/facility/MEDICAL.md`'s note about an unlockable
 * entry — so the rest is the implementation's reading of the menu, not a
 * binary-verified table.
 */
export const STAR_REQUIREMENT = {
  lobby: 1, floorTile: 1, stairs: 1, elevatorStandard: 1, office: 1, fastFood: 1, condo: 1,
  elevatorService: 2, hotelSingle: 2, hotelTwin: 2, hotelSuite: 2, housekeeping: 2, security: 2,
  escalator: 3, elevatorExpress: 3, restaurant: 3, retail: 3, partyHall: 3, movieTheater: 3,
  parkingSpace: 3, parkingRamp: 3, recyclingCenter: 3, medical: 3,
  metroStation: 4,
  cathedral: 5,
};

/** Anything not in the table is available from the first star. */
export const starRequirementFor = (kind) => STAR_REQUIREMENT[kind] ?? 1;

export const isUnlocked = (tower, kind) => tower.starCount >= starRequirementFor(kind);

/**
 * Why this cannot be built yet, or null. A lock is not a price, and a player
 * who reads "you cannot afford it" about something no amount of money will buy
 * goes and earns money for nothing.
 */
export function lockReason(tower, kind, label = kind) {
  if (isUnlocked(tower, kind)) return null;
  const stars = (n) => n + (n === 1 ? ' star' : ' stars');
  return label + ' needs a tower of ' + stars(starRequirementFor(kind))
    + ' — yours has ' + stars(tower.starCount);
}
