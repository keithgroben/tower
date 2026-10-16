/**
 * Stars — the only thing in the game that says you are winning.
 *
 * Spec: `specs/GAME-STATE.md` § Star Advancement, § Gate Meanings, § Office
 * Service Evaluation; `specs/facility/EVALUATION.md` § Award Check (the Tower
 * rank). Thresholds from the reference's `compute_tower_tier_from_ledger`
 * (`1148:041d`).
 *
 * Two independent checks, and **both** must pass, every tick:
 *
 *   1. **Activity.** The population ledger crosses the next tier's threshold.
 *      That ledger is the one the economy maintains — `+6` when an office
 *      rents, `-6` when it is vacated, yesterday's visitors for every shop and
 *      diner, the theaters' seats — so a tower's rank is a direct consequence of
 *      how many people its lifts can actually serve. Nothing else feeds it. See
 *      {@link starPopulation} for what counts at which star.
 *   2. **A qualitative checklist.** Facilities placed, recycling adequate, an
 *      office-service evaluation passed, a favorable VIP stay, and — for the top
 *      two rungs — a time window: after 5 PM on a weekday.
 *
 * ## The whole ladder (issue #14)
 *
 *   1 -> 2   population 300
 *   2 -> 3   1,000 + a security office                       (A49: one or two?)
 *   3 -> 4   5,000 + hotel suites + recycling & medical demands met + an
 *            office-service evaluation + a favorable VIP stay + a weekday after 5 PM
 *   4 -> 5   10,000 + a metro station + every demand met + a weekday after 5 PM
 *   5 -> Tower  15,000 + the cathedral on the 100th floor + a weekend wedding with 40
 *            guests there before tick 800 (`EVALUATION.md` § Award Check)
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
 * **Every gate now has a writer** (issue #17 closed the last two). Each is a plain flag on
 * `tower.gates` that its owner sets: the metro station (issue #15, `notePlacement`), the
 * favorable VIP stay (issue #16, `sim/events.js`), the office-service evaluation (issue #17,
 * `sim/inspection.js`), and the cathedral and its wedding (issue #17, `sim/cathedral.js`).
 * {@link GATES_WITHOUT_A_WRITER} is the mechanism that kept a gate honest while its writer was
 * missing - the gate refuses by *name* and the HUD says why it cannot be satisfied yet, instead
 * of sending the player hunting a button - and stays, empty, for the next gate that is ever
 * added before its writer. Dropping a gate to make the ladder passable would be the worst
 * available option — a tower that advances because a requirement was skipped
 * teaches the player something false, and `CLAUDE.md` already keeps a list of
 * metrics that improved while the thing they measured got worse.
 * `spec/DEVIATIONS.md` A57-A62, A73-A80.
 */
import { EVENING_DAYPART, formatClock } from './clock.js';
import { activeDemands, postNotice } from './demands.js';
import { TYPE_CODES } from './economy.js';
import { SECURITY_OFFICES_FOR_THREE_STARS } from './security.js';
import { FAMILY } from './state.js';

/**
 * Activity totals that unlock each tier, from the reference's tier table
 * (binary `DS:e630..e63c`, plus a hardcoded `15000`). The comparison is `>=`.
 *
 * The last entry is the Tower rank: the activity half of the cathedral path
 * (`specs/GAME-STATE.md`: *"the Tower-grade promotion uses a separate
 * cathedral/evaluation path rather than the normal star gate"*).
 */
export const STAR_THRESHOLDS = [300, 1000, 5000, 10_000, 15_000];

/** The normal ladder stops at 5. Rank 6 is the cathedral's award. */
export const MAX_STAR = 5;

/**
 * `star_count == 6`: the Tower rank. A rank, not a sixth star - the bar shows five
 * stars and says TOWER - but it is carried in `tower.starCount` exactly as the
 * reference carries it (`award_star_rating_upgrade` writes 6), so every
 * `starCount >= n` test in the sim keeps meaning what it meant.
 */
export const TOWER_RANK = 6;

// ----------------------------------------------------- the three decisions

/**
 * **Hotel guests stop counting toward the star ladder from this star on.**
 *
 * The original's readme: *"On the higher star ratings SimTower only looks at your
 * permanent population. That means that your hotel tenants are no longer counted as
 * population towards the next Tower level."* Nothing in `specs/` says it - the
 * reference *implementation* counts every ledger bucket at every star - and the
 * readme does not say which ratings are "higher". **3 is a reading**: the rung
 * where hotels become a tool at all (the twin and the suite unlock there, A27) is the
 * first where the player is asked for a real population, and a threshold of 5,000
 * is the first the guests could have helped with. One constant. `spec/DEVIATIONS.md` A58.
 */
export const HOTEL_STOPS_COUNTING_AT_STAR = 3;

/** The population buckets that are hotel guests - the "temporary" tenants. */
export const HOTEL_POPULATION_BUCKETS = ['hotelSingle', 'hotelTwin', 'hotelSuite'];

/**
 * **How many hotel suites open `3 -> 4`.** The original's help file: *"plus more
 * than one Hotel Suite placed"*; its readme agrees (*"More than one suite room"*).
 * `specs/GAME-STATE.md` lists no suite gate at all, and the reference implementation
 * has none - so this one rule has exactly one source, and that source says two.
 * (Contrast A49: there the spec states a rule - one office - and the manual is the
 * looser party.) One constant. `spec/DEVIATIONS.md` A59.
 */
export const HOTEL_SUITES_FOR_FOUR_STARS = 2;

/** `EVALUATION.md` § Runtime Sims: 5 slices x 8 visitors. */
export const WEDDING_GUESTS = 40;
/** `EVALUATION.md` § Award Check: arrival processing *"runs only when `g_day_tick < 800`"*. */
export const WEDDING_DEADLINE_TICK = 800;
/**
 * The issue and the help file: *"A cathedral can only be placed on a 100-story tower"*, and the
 * build menu's *"Cathedral is available only on 100th floor"*. The original numbers its ground
 * floor 1, so its 100th floor is logical **99** (`EVALUATION.md` sends the guests to raw floor
 * 109 = logical 99). The cathedral stack's LOWEST floor; `sim/cathedral.js` enforces it, in
 * `gradeReason`, for the ghost and the seam alike. `spec/DEVIATIONS.md` A74.
 */
export const CATHEDRAL_FLOOR = 99;

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
    /** Latched when {@link HOTEL_SUITES_FOR_FOUR_STARS} suites have stood. Gates 3→4. */
    suitePlaced: false,
    /** Latched when a metro station has ever been placed (issue #15). Gates 4→5. */
    metroPlaced: false,
    /** Latched when the cathedral has been placed (issue #17, `notePlacement`). Gates 5→Tower. */
    cathedralPlaced: false,
    /**
     * Written by the recycling system (`sim/recycling.js`, issue #13): cleared at
     * 1600 and set again at 2000 / 2566 if the tower's activity per working center is
     * low enough. Gates 3→4 and 4→5.
     */
    recyclingAdequate: false,
    /**
     * `specs/facility/MEDICAL.md` § Progression Gate, *"the daily 'office medical
     * service ok' flag"*: latched true at each day start once the tower has more
     * than two stars, cleared by the first office worker whose medical trip finds no
     * clinic (`sim/medical.js`). Gates 3→4 and 4→5. `spec/DEVIATIONS.md` A52.
     */
    medicalServiceOk: false,
    /**
     * **Written by the office-service evaluation (issue #17, `sim/inspection.js`):** the
     * inspector reached the office under test and its workers' average stress was at or
     * under the star-3 threshold (150). Gates 3→4; cleared by every star advance.
     */
    officeServiceOk: false,
    /**
     * **Written by the events (issue #16, `sim/events.js` `finishVip`):** a VIP has stayed in a
     * suite and rated the tower favorably (*"This person must be happy with your hotel suite and
     * with your elevator system for you to get a favorable rating"* - the original's help file).
     * Gates 3→4. Never cleared: a favorable stay is a fact about the tower, a later bad one
     * cannot happen (once the flag is set no more VIPs are booked, so there is no later stay to
     * go wrong), and the ladder never takes a star back. `spec/DEVIATIONS.md` A66.
     */
    vipStayFavorable: false,
    /**
     * **Written by the cathedral (issue #17):** how many wedding guests have arrived at
     * the cathedral, a count out of {@link WEDDING_GUESTS}. It counts arrivals on a
     * weekend before tick {@link WEDDING_DEADLINE_TICK} only, and
     * {@link refreshStartOfDayGates} zeroes it each morning (`EVALUATION.md` recounts
     * the sweep fresh). Gates 5→Tower.
     */
    weddingGuestsArrived: 0,
    /** Set by the start-of-day rebuild once `star_count > 2`. See the header. */
    routesViable: false,
  };
}

export const starGatesOf = (tower) => (tower.gates ??= createStarGates());

/**
 * **Gates whose writer is not in this build**, and what to tell the player.
 *
 * A flag on this list is one nothing in `sim/` sets yet - it is set by the issue
 * named, which deletes its line the day it lands. The reason is printed beside the
 * blocker (`blockerDetails[].unavailable`), so a player is not told to "get a
 * favorable VIP stay" in a game with no VIPs. It is deliberately a table and not a
 * check on whether a writer exists: the day a writer lands, deleting the line is the
 * one edit, and a test pins that every line here names a real gate.
 */
export const GATES_WITHOUT_A_WRITER = {};

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
  { flag: 'officePlaced', family: FAMILY.office, min: 1 },
  // `sim/state.js` has no name for the metro station, because no family
  // implements it yet. The code is the reference's own (`specs/ECONOMY.md`
  // § Construction Costs) and `sim/economy.js` already carries it, so it is read
  // from there rather than written down a third time and left to drift.
  // `FAMILY.office === TYPE_CODES.office === 7`, so the two vocabularies agree
  // where they overlap - and `FAMILY.security === TYPE_CODES.security === 0x0e`
  // since issue #12, which a test pins.
  //
  // `min` is how many standing objects of the family latch the flag. `1` for most,
  // as `specs/GAME-STATE.md` says (*"a security office must have been placed"*);
  // security's is `SECURITY_OFFICES_FOR_THREE_STARS` because the original's help file
  // says two (`spec/DEVIATIONS.md` A49), and the suites' is
  // `HOTEL_SUITES_FOR_FOUR_STARS` (A59).
  { flag: 'securityPlaced', family: TYPE_CODES.security, min: SECURITY_OFFICES_FOR_THREE_STARS },
  { flag: 'suitePlaced', family: FAMILY.hotelSuite, min: HOTEL_SUITES_FOR_FOUR_STARS },
  { flag: 'metroPlaced', family: TYPE_CODES.metroStation, min: 1 },
  // Issue #17 gives the cathedral its family code; `0x24` is the reference's own
  // (`EVALUATION.md` § Building) and the slices `0x25..0x28` are the same building.
  { flag: 'cathedralPlaced', family: TYPE_CODES.cathedral, min: 1 },
];

/** How many objects of a family stand in the tower. */
const standing = (tower, family) => {
  let n = 0;
  for (const object of tower.objects.values()) if (object.family === family) n++;
  return n;
};

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
  for (const gate of PLACEMENT_GATES) {
    if (!gates[gate.flag] && standing(tower, gate.family) >= gate.min) gates[gate.flag] = true;
  }
  return gates;
}

/**
 * Latch immediately when something is placed. `applyAction` calls this.
 *
 * The call IS a placement, so at least one object of the family exists even when
 * the caller has not put it in the table (the unit tests do not) - `Math.max`.
 */
export function notePlacement(tower, family) {
  const gates = starGatesOf(tower);
  for (const gate of PLACEMENT_GATES) {
    if (gate.family === family && !gates[gate.flag] && Math.max(1, standing(tower, family)) >= gate.min) {
      gates[gate.flag] = true;
    }
  }
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
  if (tower.starCount > 2) {
    gates.routesViable = true;
    // `MEDICAL.md`: *"the flag is latched to `true` at the start of each simulated
    // day, provided the tower is at star >= 3"* - the day's failed trips then clear it.
    gates.medicalServiceOk = true;
  }
  // `EVALUATION.md` § Award Check recounts the cathedral's arrivals fresh, and
  // § Runtime Sims has every guest re-activated at day tick 0: yesterday's wedding
  // is not today's. (`sim/cathedral.js` writes the count as the guests arrive.)
  gates.weddingGuestsArrived = 0;
  return gates;
}

// ------------------------------------------------------------- the ladder

/**
 * The whole population ledger: every bucket, every star.
 *
 * `specs/ECONOMY.md` § Ledgers: the population ledger holds "live per-family
 * active-unit counts (drives star thresholds and recycling adequacy tier)". Summed
 * rather than kept as a second running total, because a running total beside the
 * buckets is one more thing that can disagree with them.
 *
 * ⚠️ **This is not what the star ladder reads** - {@link starPopulation} is, because the
 * ladder stops counting hotel guests at higher stars. The recycling centers' duty tier
 * reads THIS (`TIME.md` § 2000: *"total population-ledger activity"*): a hotel guest
 * still throws things away.
 */
export function towerActivity(tower) {
  let total = 0;
  for (const value of Object.values(tower.populationLedger ?? {})) total += value;
  return total;
}

/**
 * **The population the star ladder counts** (issue #14).
 *
 * What is in the ledger, per the sources:
 *   - **offices**: `+6` a rented office (`OFFICE.md`); **condos**: `+3` a sold unit;
 *   - **shops**: `+10` a shop that is open (`COMMERCIAL.md` § Retail Income Timing)
 *     *and* yesterday's customers of every shop, restaurant and fast food (§ Capacity
 *     step 7: *"add the previous day's visit count into the population ledger"*);
 *   - **theaters and party halls**: the day's seats (`TIME.md` § 240 step 2, A45);
 *   - **hotel guests**: `+1` / `+2` / `+2` while they sleep there (`PEOPLE.md`).
 *
 * The last stops counting at {@link HOTEL_STOPS_COUNTING_AT_STAR} (A58). `star` defaults
 * to the tower's own, which is the rung whose threshold is being asked about.
 */
export function starPopulation(tower, star = tower.starCount) {
  if (star < HOTEL_STOPS_COUNTING_AT_STAR) return towerActivity(tower);
  let total = 0;
  const ledger = tower.populationLedger ?? {};
  for (const bucket of Object.keys(ledger)) {
    if (!HOTEL_POPULATION_BUCKETS.includes(bucket)) total += ledger[bucket];
  }
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

/** `a security office` / `2 security offices`: the count, said the way a player would. */
const countedThing = (n, one, many) => (n === 1 ? one : n + ' ' + many);

/**
 * The qualitative checklist, `specs/GAME-STATE.md` § Star Advancement, keyed by
 * the star you are leaving. Each entry names what is missing, in the words a
 * player would use, because a refusal that does not say what to build is not a
 * refusal — it is a stall.
 *
 * `met` is how the gate reads the flags; the default is the flag being truthy, and
 * `weddingGuestsArrived` is the one count.
 *
 * TODO(parity): **the sources disagree about medical.** `specs/GAME-STATE.md` §
 * Star Advancement lists no medical gate; `specs/facility/MEDICAL.md` § Progression
 * Gate puts the daily "office medical service ok" flag on both `3 -> 4` and `4 -> 5`
 * (*"advancement is blocked and the 'Medical Center demanded near Lobby' banner
 * re-fires"*), the reference *implementation* requires it on both, and the original's
 * own readme says the fourth star wants "recycling and medical demands met"
 * (`SimTower-gameplay-analysis.md`). Three against one: the flag is a gate here
 * (`medicalServiceOk`), written by `sim/medical.js`. The reference implementation
 * additionally asks office-service of `4 -> 5`, which the spec does not - not added.
 * `spec/DEVIATIONS.md` A52.
 *
 * TODO(parity): **the issue's `3 -> 4` list and `GAME-STATE.md`'s differ.** The issue
 * (and the help file) want suites and a favorable VIP stay, which the spec does not
 * list; the spec wants an office-service evaluation, which the help file does not
 * mention. Every item from every source is a gate - the union, because dropping one
 * silently is the failure mode this file refuses. `spec/DEVIATIONS.md` A59-A60.
 */
const QUALITATIVE_GATES = {
  1: [],
  2: [{
    flag: 'securityPlaced', kind: 'security',
    missing: countedThing(SECURITY_OFFICES_FOR_THREE_STARS, 'a security office', 'security offices'),
  }],
  3: [
    { flag: 'officePlaced', missing: 'an office', kind: 'office' },
    {
      flag: 'suitePlaced', kind: 'hotelSuite',
      missing: countedThing(HOTEL_SUITES_FOR_FOUR_STARS, 'a hotel suite', 'hotel suites'),
    },
    { flag: 'recyclingAdequate', missing: 'a recycling centre keeping up with the tower', kind: 'recyclingCenter' },
    { flag: 'medicalServiceOk', missing: 'a medical center for the office workers', kind: 'medical' },
    { flag: 'officeServiceOk', missing: 'a passed office-service evaluation', kind: null },
    { flag: 'vipStayFavorable', missing: 'a favorable VIP stay', kind: null },
    { flag: 'routesViable', missing: 'a day to start since you reached 3 stars', kind: null, window: true },
  ],
  4: [
    { flag: 'metroPlaced', missing: 'a metro station', kind: 'metroStation' },
    { flag: 'recyclingAdequate', missing: 'a recycling centre keeping up with the tower', kind: 'recyclingCenter' },
    { flag: 'medicalServiceOk', missing: 'a medical center for the office workers', kind: 'medical' },
    { flag: 'routesViable', missing: 'a day to start since you reached 3 stars', kind: null, window: true },
  ],
  5: [
    { flag: 'cathedralPlaced', missing: 'a cathedral on the 100th floor (floor ' + CATHEDRAL_FLOOR + ')', kind: 'cathedral' },
    {
      flag: 'weddingGuestsArrived', kind: null,
      missing: 'a wedding with ' + WEDDING_GUESTS + ' guests at the cathedral',
      met: (gates) => (gates.weddingGuestsArrived ?? 0) >= WEDDING_GUESTS,
    },
  ],
};

/** The two rungs that also demand 5 PM or later, on a weekday. */
const TIME_GATED_TIERS = new Set([3, 4]);

/**
 * Everything standing between this tower and its next star.
 *
 * Returns the whole picture rather than a boolean, because "why not yet" is the
 * only part a player can act on. `blockers` is ordered activity-first: there is
 * no point telling someone to build a metro station when they are 4,000 tenants
 * short of even being asked.
 *
 * ## `blockerDetails`, and why the prose is not enough
 *
 * `blockers` is prose, for printing. `blockerDetails` is the same list with more
 * beside each entry:
 *
 *   - `kind` - the `CONSTRUCTION_COST` / `BUILDABLE` key when the blocker names a
 *     *thing*, and `null` when it names a window - the evening, a weekday, an
 *     evaluation that has to pass on its own.
 *   - `window` - true for a blocker that is a wait and not a task.
 *   - `unavailable` - why this cannot be satisfied yet, when its writer is not in
 *     the build ({@link GATES_WITHOUT_A_WRITER}).
 *
 * It exists because the HUD has to tell "go and build this" apart from "this
 * cannot be built in this version yet", and most of the ladder above 2 stars is
 * currently the second. Deciding that by matching the prose would put the rule
 * in the reader — which is how `payout(7, …)` silently returned 0 for every
 * office in the tower. The translation belongs at the seam, once.
 *
 * @returns {{star:number, activity:number, threshold:number|null, nextStar:number|null,
 *   activityNeeded:number, activityReady:boolean, hotelsCounted:boolean, blockers:string[],
 *   blockerDetails:{text:string, kind:string|null, window?:boolean, unavailable?:string}[],
 *   ready:boolean}}
 */
export function starGateStatus(tower) {
  const star = tower.starCount;
  const activity = starPopulation(tower);
  const hotelsCounted = star < HOTEL_STOPS_COUNTING_AT_STAR;
  const gates = starGatesOf(tower);
  const details = [];
  const block = (text, kind = null, extra = null) => details.push({ text, kind, ...extra });

  if (star >= TOWER_RANK) {
    const text = 'nothing — this tower has the Tower rank';
    return {
      star, activity, threshold: null, nextStar: null, activityNeeded: 0, activityReady: true,
      hotelsCounted, blockers: [text], blockerDetails: [{ text, kind: null }],
      ready: false,
    };
  }

  const needed = activityForStar(star);
  const activityReady = starCountForActivity(activity) > star;
  // Activity has no `kind`: it is not a thing to build, it is every thing.
  if (!activityReady) block((needed - activity) + ' more tower activity');

  for (const gate of QUALITATIVE_GATES[star] ?? []) {
    const met = gate.met ? gate.met(gates) : Boolean(gates[gate.flag]);
    if (met) continue;
    const extra = {};
    if (gate.window) extra.window = true;
    if (GATES_WITHOUT_A_WRITER[gate.flag]) extra.unavailable = GATES_WITHOUT_A_WRITER[gate.flag];
    block(gate.missing, gate.kind, extra);
  }

  if (star === 4) {
    // The help file: *"ALL demands"*. Not only the two the gates above name - a tower
    // that is still asking for a parking space is a tower that is not satisfied.
    const demands = activeDemands(tower);
    if (demands.length) block('every demand answered (' + demands.map((d) => d.text).join('; ') + ')');
  }

  if (TIME_GATED_TIERS.has(star)) {
    // `daypart_index >= 4` and `calendar_phase_flag == 0`. Both are windows
    // rather than tasks, so they are phrased as waiting rather than as building.
    if (tower.clock.daypart < EVENING_DAYPART) block('the evening (after 5 PM)', null, { window: true });
    if (tower.clock.calendarPhase) block('a weekday', null, { window: true });
  } else if (star === MAX_STAR) {
    // `EVALUATION.md`: the wedding is a weekend event, and arrival processing
    // *"runs only when `g_day_tick < 800`"*.
    if (!tower.clock.calendarPhase) block('a weekend', null, { window: true });
    if (tower.clock.dayTick >= WEDDING_DEADLINE_TICK) {
      block('a morning (before ' + formatClock(WEDDING_DEADLINE_TICK) + ')', null, { window: true });
    }
  }

  return {
    star,
    activity,
    threshold: needed,
    nextStar: star + 1,
    activityNeeded: activityReady ? 0 : needed - activity,
    activityReady,
    hotelsCounted,
    blockers: details.map((d) => d.text),
    blockerDetails: details,
    ready: details.length === 0,
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

/** The line the bar says when a rung is climbed. */
export const starRiseNotice = (star) => (star >= TOWER_RANK
  ? 'The tower has earned the Tower rank'
  : 'The tower has reached ' + star + ' stars');

/**
 * The per-tick check. Both halves must pass; one star at a time.
 *
 * The reference runs this every tick from the scheduler rather than at a
 * checkpoint, which matters because two of the gates are time windows: the
 * advance happens the moment the tower is eligible, not at the next checkpoint
 * after it.
 *
 * The last rung is the same call: at 5 stars the checklist is the cathedral's
 * (`EVALUATION.md` § Award Check: *"first requires `compute_tower_tier_from_ledger() >
 * g_star_count`"* - the 15,000 - then the 40 guests, before tick 800) and the award is
 * `star_count = 6`. The reference reaches it from the guests' arrival rather than from a
 * tick, but both read the same flags, and an arrival is the only thing that can change
 * them mid-day, so the first tick after the 40th is the same moment.
 *
 * A star rise says so: one notice, once, in the tower's notice log.
 *
 * @returns {{advanced:boolean, star:number, from?:number, blockers:string[]}}
 */
export function tryAdvanceStar(tower) {
  if (tower.starCount >= TOWER_RANK) {
    return { advanced: false, star: tower.starCount, blockers: starGateStatus(tower).blockers };
  }
  const status = starGateStatus(tower);
  if (!status.ready) {
    return { advanced: false, star: tower.starCount, blockers: status.blockers };
  }

  const from = tower.starCount;
  tower.starCount = from + 1;
  resetStarGateState(tower);
  postNotice(tower, 'starRise', starRiseNotice(tower.starCount), { good: true });
  if (tower.starCount >= TOWER_RANK) crownTower(tower);
  return { advanced: true, star: tower.starCount, from, blockers: [] };
}

/**
 * **The finish moment** (issue #17). `EVALUATION.md` § Award Check: `award_star_rating_upgrade`
 * *"plays popup/sound `0x2718`, and marks all cathedral objects aux `2`, dirty `1`"*, and the
 * original's own dialog for it is `DIALOG_3034`: *Congratulations! Your tower has been given a
 * "Tower" Rating!* The sim records WHEN, in plain JSON on `tower.finale` (so a save carries it and
 * a replay reproduces it); the interface turns that into fireworks and a banner and never
 * writes back. The game does not end: nothing reads `finale` but the display, and the tower
 * runs on at rank 6.
 */
export const TOWER_RANK_TEXT = 'Congratulations! Your tower has been given a "Tower" Rating!';

function crownTower(tower) {
  tower.finale = { day: tower.clock.dayCounter, tick: tower.clock.dayTick, text: TOWER_RANK_TEXT };
  for (const object of tower.objects.values()) {
    if (object.family !== FAMILY.cathedral) continue;
    object.aux = 2;
    object.dirty = true;
  }
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
 *
 * ⚠️ **The twin room and the suite are corrected from 2 stars to 3** (issue #8,
 * `spec/DEVIATIONS.md` A27). The reference implementation lists all three hotel
 * rooms at 2, but the original game's own help file says otherwise, in its
 * build-menu text: *"Single Hotel Room - Two Stars, $20,000"*, *"Twin Hotel Room
 * - Three Stars, $50,000"*, *"Hotel Suite - Three Stars, $100,000"* — and again
 * in its unlock list (Two Stars: Single Hotel Room; Three Stars: Twin Hotel Room,
 * Hotel Suite). The price a player is shown and the star that unlocks it are the
 * game's own, so they win over the implementation's reading.
 */
export const STAR_REQUIREMENT = {
  lobby: 1, floorTile: 1, stairs: 1, elevatorStandard: 1, office: 1, fastFood: 1, condo: 1,
  elevatorService: 2, hotelSingle: 2, housekeeping: 2, security: 2,
  // The twin and the suite are 3 stars, not 2 — see the note above.
  hotelTwin: 3, hotelSuite: 3,
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
