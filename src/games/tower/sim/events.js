/**
 * **Events** (issue #16): the VIP, the fire, the bomb and its ransom, buried treasure,
 * and Santa.
 *
 * Spec: `specs/EVENTS.md` § Bomb Event, § Fire Event, § VIP / Special Visitor Event;
 * `specs/TIME.md` § Top-Level Tick Order (step 5), § 240 (*"`trigger_fire_event()` is
 * called before `trigger_bomb_event()`"*), § 2000; `specs/facility/HOTEL.md`;
 * `specs/GAME-STATE.md` § Star Advancement. The wording of every dialog is the original's
 * own (`DIALOG_3000`-`DIALOG_3040`, `STRlist 32518/1010`); the help file supplies the VIP's
 * rules (*"VIPs only stay in a hotel suite. This person must be happy with your hotel suite
 * and with your elevator system for you to get a favorable rating ... If you don't get a
 * favorable rating the first time, you'll be given additional chances"*) and the guards'
 * (*"They use the tower's emergency, outside stairs only ... Their closeness to these
 * events affects their ability to combat them"*). `SimTower-gameplay-analysis.md` § 5.
 *
 * ## The rule this file is written to, and the one it is NOT
 *
 * *"The events are rare, readable and tied to systems you already manage: security count,
 * elevator quality, suites. They test your build instead of adding random punishment."*
 *
 * So there is **no random draw that decides whether you are punished**. The calendar says
 * when (a bomb on day 59 of 60, a fire on day 83 of 84), the tower says how it goes: whether
 * a bomb is found is the security offices' count and distance; whether a fire is stopped is
 * the same offices' distance, and a $500,000 helicopter; whether a VIP is pleased is the
 * lifts and the suite. The generator is used only to choose WHERE (the floor, the tile, which
 * suite), as the reference does, and for the buried treasure, which is a windfall.
 *
 * ## The two flags, and the clock
 *
 * `tower.events.bombActive` / `fireActive` are the reference's `game_state_flags` bits
 * (`entertainmentPaysToday`, `metroTrainTick` and the VIP booking all read them). This file
 * is the only writer. Both events end by **forcing `day_tick` up to 1500** if it is earlier
 * (`EVENTS.md`: *"cleanup jumps simulation time forward"*), which is why they are in the sim
 * and not in the driver: the clock is sim state.
 *
 * ## Where it runs
 *
 * `runDailyEvents` is the 240 checkpoint (fire, then bomb, then the day's VIP booking);
 * `eventsTick` is the per-tick hook (`sim/scheduler.js`), which advances whatever is live;
 * `vipFamilyHandler` is the family-`0x30` handler the stride calls. Everything the player
 * can do is `answerEvent`, reached through `applyAction`'s `answer_event`.
 *
 * Deterministic from the seed and the action log: nothing here reads a wall clock or
 * `Math.random`, and every state change is plain JSON on `tower.events` (so a save carries a
 * fire in progress, and a replay reproduces it).
 */
import {
  FAMILY, MAX_FLOOR, baseState, createActor, enterTransit, floorExists, isBasement, isHotelFamily, isInTransit,
  isUnitLet,
} from './state.js';
import { daypartOf, formatClock } from './clock.js';
import { postNotice } from './demands.js';
import { emergencyStairsRoute, guardResponse, securityOffices } from './security.js';
import { cancelRequest } from './elevators.js';
import { demolishEntertainment, isEntertainmentFamily } from './entertainment.js';
import { POPULATION_BY_FAMILY, bookOther } from './economy.js';
import { condoCashflowHooks, ledgerFor } from './ledger-adapter.js';
import { venueOf } from './commercial.js';
import { hotelNoiseNear, isHotelInfested, isHotelVacant } from './hotel.js';
import { evalLevelFor } from './office.js';
import { starGatesOf } from './progression.js';
import {
  ELAPSED_CLAMP, computeRuntimeTileStressAverage, createSimTripRecord, resetSimTripCounters,
} from './stress.js';
import { shouldWaitForQueuedCarrier } from './routing.js';
import { hasCathedral } from './cathedral.js';
import { countSameFloorArrival, noteLocalLeg, routeVisitor as route } from './visitors.js';

// ---------------------------------------------------------------- the calendar

/** `specs/TIME.md` § 240: *"facility-ledger rebuild and bomb/fire trigger checks"*. */
export const EVENT_CHECK_TICK = 240;

/** `EVENTS.md` § Bomb Event: *"fires when `day_counter % 60 == 59`"*. */
export const BOMB_PERIOD_DAYS = 60;
export const BOMB_DAY = 59;
/** `EVENTS.md` § Fire Event: *"fires when `day_counter % 84 == 83`"*. */
export const FIRE_PERIOD_DAYS = 84;
export const FIRE_DAY = 83;

export const isBombDay = (dayCounter) => dayCounter % BOMB_PERIOD_DAYS === BOMB_DAY;
export const isFireDay = (dayCounter) => dayCounter % FIRE_PERIOD_DAYS === FIRE_DAY;

/**
 * *"cleanup jumps simulation time forward to `day_tick = 1500`"* (bomb) and *"forces
 * `day_tick` up to `1500` if it was still earlier in the day"* (fire).
 */
export const RESUME_TICK = 1500;

/** *"two ticks after ignition, the game resolves the rescue choice prompt"*; the bomb's too. */
export const DECISION_TICKS = 2;

// ------------------------------------------------------------------- the bomb

/**
 * `EVENTS.md`: *"computes ransom from the current star rating using startup-tuning values:
 * 2 stars: $200,000; 3 stars: $300,000; 4 stars: $1,000,000"*. The unit is the tuning
 * block's `2000 / 3000 / 10000` (`SimTower-gameplay-analysis.md` § 6) at $100 a unit.
 */
export const BOMB_RANSOM = { 2: 200_000, 3: 300_000, 4: 1_000_000 };

/**
 * The star ratings a bomb can come at. The spec gives a ransom for 2, 3 and 4 and is silent on
 * 1, 5 and the Tower rank; the reference implementation does not trigger the event there
 * (*"Stars 1 and 5 cannot trigger"*). Followed: an event with no ransom in the spec is not an
 * event this build invents one for. `spec/DEVIATIONS.md` A67.
 */
export const bombCanComeAt = (starCount) => starCount >= 2 && starCount <= 4;

/** `day_tick == 0x04b0`: 1:00 PM on the clock (`formatClock(1200)`). */
export const BOMB_DEADLINE_TICK = 0x4b0;

/**
 * *"requires the selected floor width to be at least `4` tiles"* and *"chooses the bomb
 * x-position uniformly from `[left_tile_index, right_tile_index - 4]`"*: the range is empty
 * unless `right - left >= 4`, so that is the width test. `spec/DEVIATIONS.md` A67.
 */
export const BOMB_MIN_SPAN = 4;

/** *"detonation deletes objects in a `40 x 6` rectangle centered on the planted bomb"*. */
export const BLAST_FLOORS_BELOW = 2;       // *"floors `[bomb_floor - 2, bomb_floor + 3]`"*
export const BLAST_FLOORS_ABOVE = 3;
export const BLAST_TILES_LEFT = 20;        // *"tiles `[bomb_x - 20, bomb_x + 19]`"*
export const BLAST_TILES_RIGHT = 19;

/** A guard team sweeps one tile a tick - the reference's `walk_delay = 1` (DS:0xe640). */
export const SEARCH_TILES_PER_TICK = 1;
/** The sweep starts at `right - 2` and walks left, as the reference's cursor does. */
export const SEARCH_START_OFFSET = 2;

// ------------------------------------------------------------------- the fire

/** The tuning block `1, 7, 80, 1, 2, 80, 5` (`SimTower-gameplay-analysis.md` § 6). */
export const FIRE_SPREAD_TICKS = 7;          // per tile
export const FIRE_FLOOR_TICKS = 80;          // per floor, upward only
export const HELICOPTER_TICKS_PER_TILE = 1;
export const SECURITY_HEAD_START_TICKS = 80; // the rescue countdown a SECOM-watched tower gets
export const GUARD_WALK_TICKS = 1;
export const GUARD_EXTINGUISH_TICKS = 5;

/** *"charges `$500,000`"*; `HELICOPTER_RESCUE_COST` in the reference. */
export const HELICOPTER_COST = 500_000;
/** *"seeds the active fire core at `right_tile_index - 12`"*. */
export const HELICOPTER_START_OFFSET = 12;

/** *"requires the selected floor width to be at least `32` tiles"*. Same test as the bomb's. */
export const FIRE_MIN_SPAN = 32;
/** *"seeds the initial fire x-position at `right_tile_index - 32`"*. */
export const FIRE_SEED_OFFSET = 32;
/** The right front deletes `position + 12`: *"covered tiles ... advance inward from both sides"*. */
export const FIRE_RIGHT_REACH = 12;
/** *"... or when `day_tick == 2000`, the event finalizes"*. */
export const FIRE_END_TICK = 2000;
/** The fire needs *"`star_count > 2`"*. */
export const FIRE_MIN_STARS = 3;

// -------------------------------------------------------------------- the VIP

/**
 * **A VIP is booked at one o'clock (1200), arrives when the evening's check-in window opens
 * (1600), sleeps in the suite, and rides down after tick 400 the next day.**
 *
 * None of this is in `specs/`. `EVENTS.md` § VIP / Special Visitor Event is the metro
 * station's display toggle, says outright that it *"does not feed the star gate or route
 * logic"*, and the stay the help file and the four dialogs describe has no rule in the
 * reference at all. What the sources do give: a suite on a named floor (`DIALOG_3000`), an
 * arrival (`DIALOG_3001`), a verdict at checkout (`DIALOG_3002`/`3003`), *"happy with your
 * hotel suite and with your elevator system"*, and *"additional chances"* on failure. The
 * rest - when, how long, what counts as happy - is chosen here, in one place, and recorded as
 * `spec/DEVIATIONS.md` A66.
 */
export const VIP_BOOK_TICK = 1200;
export const VIP_ARRIVAL_TICK = 1600;
/** The next morning, after the night's resets and the hotel's own checkout rush. */
export const VIP_CHECKOUT_FROM_TICK = 400;
/** A VIP who is not in the lobby by one o'clock gave up on the tower. */
export const VIP_CHECKOUT_DEADLINE_TICK = 1200;
/** A failed visit is followed by another after a quarter - the calendar's own unit. */
export const VIP_RETRY_DAYS = 3;
/** Rated stars the visit starts at: suites unlock at 3 (A27) and the gate guards 3 -> 4. */
export const VIP_MIN_STARS = 3;

export const VIP_STATE = { away: 0x27, arriving: 0x20, staying: 0x01, leaving: 0x05 };

// ------------------------------------------------------------------ the extras

/**
 * **Buried treasure**: *"During construction, workers discovered ancient buried treasure!
 * It is worth $^000"* (`DIALOG_3040`); *"Buried treasure: found during construction. A random
 * windfall"* (`SimTower-gameplay-analysis.md` § 5). The trigger and the amount are written
 * down nowhere (§ 11: *"Treasure trigger ... None of these is documented anywhere"*).
 *
 * Chosen: the first thing built on each new basement floor has a one-in-`TREASURE_ODDS`
 * chance of striking it, and the amount is drawn from the tuning block's six unidentified
 * values `800, 1500, 500, 3000, 1500, 5000` (§ 11 names *"the treasure amount"* as the likely
 * candidate for exactly these), at $100 a unit. `spec/DEVIATIONS.md` A70.
 */
export const TREASURE_ODDS = 8;
export const TREASURE_AMOUNTS = [80_000, 150_000, 50_000, 300_000, 150_000, 500_000];

/**
 * **Santa**: *"Santa Claus is coming to your tower!"* (STRlist `32518/1010` item 6). A notice and
 * nothing else; when is undocumented. The last day of the 12-day year, announced at 2000 and
 * in the sky until the day counter turns. `spec/DEVIATIONS.md` A71.
 */
export const SANTA_DAY_OF_YEAR = 11;
export const SANTA_TICK = 2000;
export const SANTA_END_TICK = 2300;

// ----------------------------------------------------------------- the strings

const money = (n) => '$' + n.toLocaleString('en-US');
/** `1 PM`, `5 PM`: the dialog quotes the hour, not the minute. */
const hourOf = (tick) => formatClock(tick).replace(':00', '');

/**
 * Every line the events say, verbatim from the original's `DIALOG_30xx` where there is one
 * (`dialogs.txt`), and ours - marked - where the original gives a number and no string
 * (`0x271f`, the ransom receipt; the two "nobody is looking" lines).
 */
export const EVENT_TEXT = {
  vipBooked: (floor) => 'A VIP has made reservations for the Hotel Suite on floor ' + floor + '.',
  vipArrived: () => 'A VIP has arrived at your Tower.',
  vipPleased: () => 'The VIP has checked out. They seem to have had a comfortable stay!',
  vipDispleased: () => 'Sorry! The VIP seems to have had an uncomfortable stay.  They are not pleased with your tower.',
  /** Ours: the VIP never made it as far as a verdict. */
  vipCancelled: () => 'The VIP cancelled the reservation: the suite is gone.',
  fireSensed: (floor) => 'SECOM has sensed a fire on floor ' + floor + '!\nEveryone should take emergency refuge!',
  fireReported: (floor) => 'A fire has been reported on floor ' + floor + '!\nEveryone should take emergency refuge!',
  fireCrew: (cost) => 'Would you like to call an emergency fire crew?\nIt will cost ' + money(cost) + '.',
  fireStopped: () => 'The fire was stopped.\nBecause your building has emergency stairs, no one was injured, but the tower is damaged.',
  /** Ours: a fire that never got going has no damage to apologise for. */
  fireStoppedClean: () => 'The fire was stopped before it could spread. No one was injured and the tower is undamaged.',
  fireSecurity: () => 'Security is attempting to quench the fire.\n\nEveryone is taking emergency refuge.',
  /** Ours: no office, so nobody is coming. */
  fireNoSecurity: () => 'You have no Security Offices. Nobody is coming to fight the fire.',
  /** Ours: the helicopter's receipt. */
  fireHelicopter: () => 'The rescue helicopter is on its way.',
  bombDemand: (ransom, tick = BOMB_DEADLINE_TICK) =>
    'Blackmail from Terrorists!\nThey demand ' + money(ransom) + ' or a hidden bomb will explode at ' + hourOf(tick) + '.',
  bombFound: (floor) => '"Secom System Now Scanning...."\n\nA bomb has been found on floor ' + floor
    + '.\nSecurity is on its way to diffuse the bomb.',
  bombSearching: () => 'Security forces from your Security Offices are on their way to find the bomb.Good luck...',
  bombDefused: () => 'Because you have enough Security Offices in your tower, Security Forces found the bomb.  Good work!',
  bombExploded: (floor) => 'Security was not able to find the bomb in time.  The bomb has exploded on floor ' + floor + '!',
  /** Ours: `0x271f` is a notification number, not a string. */
  bombPaid: (ransom) => 'You paid the terrorists ' + money(ransom) + '. The bomb threat is over.',
  /** Ours: no office, so nobody looks. */
  bombNoSecurity: (tick = BOMB_DEADLINE_TICK) =>
    'You have no Security Offices, so nobody is looking for the bomb. It will explode at ' + hourOf(tick) + '.',
  treasure: (amount) => 'Wow!\nDuring construction, workers discovered ancient buried treasure!\nIt is worth ' + money(amount),
  santa: () => 'Santa Claus is coming to your tower!',
};

// --------------------------------------------------------------------- the state

/**
 * `tower.events`, with everything this file owns installed on first use - so a tower built
 * before this file existed (and a hand-made test tower) still has somewhere to put an event.
 *
 *  - `bombActive` / `fireActive`: the reference's flags (`createTower` has them).
 *  - `decision`: the one open question (`{kind, cost, openedTick, deadline}`) or `null`.
 *  - `bomb`: `{floor, x, ransom, phase, ...}` or `null`; `phase` is `prompt`, `armed`,
 *    `found` or `exploded`.
 *  - `fire`: `{floor, current, seed, age, hold, fronts, helicopter, guards, ...}` or `null`.
 *  - `vip`: the visit in progress (`{phase, suiteId, floor, bookedDay, ...}`) or `null`;
 *    `vipActorId` is the one standing actor that plays every visitor.
 *  - `scars`: `[{floor, left, right, cause}]` - where something burned or blew up, for the
 *    renderer; `blast` the last explosion `{floor, x, day, tick}`.
 *  - `dug`: basement floors already struck for treasure; `history`: what happened, newest last.
 */
export function eventsOf(tower) {
  const events = (tower.events ??= { bombActive: false, fireActive: false });
  events.decision ??= null;
  events.bomb ??= null;
  events.fire ??= null;
  events.vip ??= null;
  events.vipActorId ??= null;
  events.lastVip ??= null;
  events.scars ??= [];
  events.blast ??= null;
  events.dug ??= [];
  events.history ??= [];
  return events;
}

const HISTORY_LIMIT = 60;
const SCAR_LIMIT = 400;

function record(tower, entry) {
  const events = eventsOf(tower);
  events.history.push({ day: tower.clock.dayCounter, tick: tower.clock.dayTick, ...entry });
  if (events.history.length > HISTORY_LIMIT) events.history.splice(0, events.history.length - HISTORY_LIMIT);
}

/** Said in the notice log under the event's name. `tone` colours the bar: `good` or `bad`. */
const say = (tower, kind, text, tone = null) => postNotice(tower, kind, text, { tone });

/** Is an event running that suppresses the others? (`EVENTS.md`: *"suppressed while a bomb or fire event is already active"*.) */
export const eventIsRunning = (tower) => Boolean(tower.events?.bombActive || tower.events?.fireActive);

/** The question the player has to answer right now, or `null`. */
export const pendingDecision = (tower) => tower.events?.decision ?? null;

// ------------------------------------------------------------------ the geometry

/** Leftmost and rightmost tile built on a floor, or `null` when it is bare. */
export function floorBounds(tower, floor) {
  let left = Infinity, right = -Infinity;
  for (const o of tower.objects.values()) {
    if (o.floor !== floor) continue;
    if (o.left < left) left = o.left;
    if (o.right > right) right = o.right;
  }
  return left > right ? null : { left, right };
}

const floorHasObjects = (tower, floor) => floorBounds(tower, floor) !== null;

/**
 * **The floor-selection helper both events share.** `EVENTS.md` § Bomb Event: *"scan floors
 * upward from the supplied lower bound, find the first non-empty floor, then the first empty
 * floor after that contiguous occupied run; the bomb chooses uniformly from the inclusive
 * range `[lower_bound, top_live_floor]`"*, and *"the bomb starts floor selection at clone
 * logical floor `lobby_height`, so multi-floor lobby floors are excluded"*.
 *
 * So the pick can land on an empty floor between the lower bound and the first built one;
 * the caller's width test then rejects it, as the reference's does. One draw, always.
 *
 * @returns {number|null} the floor, or `null` when nothing stands at or above the bound
 */
export function pickEventFloor(tower, lowerBound = tower.lobbyHeight ?? 1) {
  let first = null;
  for (let f = lowerBound; f <= MAX_FLOOR; f++) {
    if (floorHasObjects(tower, f)) { first = f; break; }
  }
  if (first === null) return null;
  let top = first;
  while (top + 1 <= MAX_FLOOR && floorHasObjects(tower, top + 1)) top++;
  return lowerBound + tower.rng.int(top - lowerBound + 1);
}

// ------------------------------------------------------------------ destruction

/**
 * **What a fire or a bomb cannot take.** The reference's validity gate on
 * `delete_placed_object_and_release_sidecars` (`FIRE_INDESTRUCTIBLE_FAMILIES` in its
 * `events.ts`): security, housekeeping, parking and its ramp, the metro, the cathedral. Ours
 * adds the lobby, which the reference does not hold as an object (its floor tiles are cells
 * the fire does eat) but which here carries `transferFloors` - the player cannot bulldoze one
 * either. The cathedral is family `0x24` for all five of its slices (issue #17), so one entry
 * is the whole stack: a bomb's blast that reaches floor 99 leaves it standing.
 * `spec/DEVIATIONS.md` A68.
 */
export const INDESTRUCTIBLE_FAMILIES = new Set([
  FAMILY.lobby, FAMILY.security, FAMILY.housekeeping, FAMILY.parkingSpace, FAMILY.parkingRamp, FAMILY.metro,
  FAMILY.cathedral,
]);

export const isIndestructible = (object) => INDESTRUCTIBLE_FAMILIES.has(object.family);

/** Remember where something stood, so the renderer can draw the scorch. Overlaps are merged away. */
export function addScar(tower, floor, left, right, cause) {
  const events = eventsOf(tower);
  events.scars.push({ floor, left, right, cause });
  if (events.scars.length > SCAR_LIMIT) events.scars.splice(0, events.scars.length - SCAR_LIMIT);
}

/** Building over a scar clears it: the ground is whole again. */
export function clearScars(tower, floor, left, right) {
  const events = tower.events;
  if (!events?.scars?.length) return;
  events.scars = events.scars.filter((s) => !(s.floor === floor && s.left <= right && s.right >= left));
}

export const scarsOnFloor = (tower, floor) => (tower.events?.scars ?? []).filter((s) => s.floor === floor);

/**
 * Take one placed object out of the tower the way a fire or a blast does: everything that
 * hung off it goes with it, and the people it had put on the ledgers come back off.
 *
 *  - its workers, guests and customers leave the actor table, and any lift they were queued
 *    on or riding forgets them (`cancelRequest`);
 *  - a **sold condo is refunded** (the reference's one teardown refund: *"Cash refund for
 *    condo"*), a let office, an open shop and a booked hotel room take their people off the
 *    population ledger, and a theater or party hall takes both halves and its audience;
 *  - a scar is left where it stood.
 *
 * @returns {boolean} whether the object was destroyed (`false` for the indestructible)
 */
export function destroyObject(tower, object, cause = 'fire') {
  if (!object || !tower.objects.has(object.id) || isIndestructible(object)) return false;
  const ledger = ledgerFor(tower);
  const population = (tower.populationLedger ??= {});
  const spans = [{ floor: object.floor, left: object.left, right: object.right }];
  const goneActors = new Set(object.occupants);

  if (isEntertainmentFamily(object.family)) {
    // A venue is two objects and one record: both halves go, and the audience with them.
    const halves = [...tower.objects.values()].filter((o) => o.entertainmentId === object.entertainmentId);
    for (const half of halves) {
      for (const id of half.occupants) goneActors.add(id);
      if (half.id !== object.id) spans.push({ floor: half.floor, left: half.left, right: half.right });
    }
    const gone = demolishEntertainment(tower, object);
    const bucket = object.family === FAMILY.theater ? 'cinema' : 'partyHall';
    if (gone && bucket in population) population[bucket] = Math.max(0, population[bucket] - gone.populationShare);
  } else {
    if (object.family === FAMILY.condo && isUnitLet(object)) {
      condoCashflowHooks(tower).onRefund(tower, object);
    } else if (object.family === FAMILY.office && isUnitLet(object)) {
      ledger.population.office = Math.max(0, (ledger.population.office ?? 0) - POPULATION_BY_FAMILY.office);
    } else if (object.family === FAMILY.retail && venueOf(object)?.availability !== 0xff) {
      population.retail = Math.max(0, (population.retail ?? 0) - POPULATION_BY_FAMILY.retail);
    } else if (isHotelFamily(object.family) && isUnitLet(object)) {
      const bucket = { [FAMILY.hotelSingle]: 'hotelSingle', [FAMILY.hotelTwin]: 'hotelTwin', [FAMILY.hotelSuite]: 'hotelSuite' }[object.family];
      population[bucket] = Math.max(0, (population[bucket] ?? 0) - POPULATION_BY_FAMILY[bucket]);
    }
    tower.objects.delete(object.id);
  }

  for (const id of goneActors) for (const carrier of tower.carriers) cancelRequest(carrier, id);
  tower.actors = tower.actors.filter((a) => !a || !goneActors.has(a.id));
  tower.routeTablesDirty = true;
  for (const span of spans) addScar(tower, span.floor, span.left, span.right, cause);
  return true;
}

/** The destructible object standing over `tile` on `floor`, or `null`. */
function objectAt(tower, floor, tile) {
  for (const o of tower.objects.values()) {
    if (o.floor === floor && o.left <= tile && o.right >= tile) return o;
  }
  return null;
}

/** `delete_object_covering_floor_tile`: whatever stands on the tile, unless it cannot burn. */
function burnTile(tower, floor, tile, cause) {
  const object = objectAt(tower, floor, tile);
  return object ? destroyObject(tower, object, cause) : false;
}

/** Jump the clock to `tick` if it is earlier. `daypart` is recomputed, as the reference does. */
function resumeClockAt(tower, tick) {
  if (tower.clock.dayTick < tick) {
    tower.clock.dayTick = tick;
    tower.clock.daypart = daypartOf(tick);
  }
}

// ------------------------------------------------------------------ the decisions

/**
 * Why `answer` cannot be given right now, or `null` - **the one definition** the seam and the
 * dialog both ask, so the dialog's buttons and `applyAction`'s refusals cannot disagree.
 */
export function answerRefusal(tower, answer) {
  const decision = pendingDecision(tower);
  if (!decision) return 'there is nothing to answer';
  const allowed = decision.kind === 'bomb' ? ['pay', 'search'] : ['helicopter', 'decline'];
  if (!allowed.includes(answer)) {
    return 'the ' + decision.kind + ' asks ' + allowed.map((a) => '"' + a + '"').join(' or ') + ', not "' + answer + '"';
  }
  const cost = answer === 'pay' || answer === 'helicopter' ? decision.cost : 0;
  if (cost > tower.cash) return 'that costs ' + money(cost) + ' and you have ' + money(tower.cash);
  return null;
}

/**
 * **The player answers the open question.** Bomb: `pay` (the ransom, and the bomb is never
 * heard of again) or `search` (the guards look). Fire: `helicopter` ($500,000) or `decline`.
 * Returns `{ok, reason?, ...}`. Money moves here and nowhere else in this file.
 */
export function answerEvent(tower, answer) {
  const refusal = answerRefusal(tower, answer);
  if (refusal) return { ok: false, reason: refusal };
  const events = eventsOf(tower);
  const decision = events.decision;
  events.decision = null;
  if (decision.kind === 'bomb') return { ok: true, ...resolveBombDecision(tower, answer) };
  return { ok: true, ...resolveFireDecision(tower, answer) };
}

/** A question nobody answered in time is answered the way the spec does: *do not pay*. */
function settleDecision(tower) {
  const events = tower.events;
  const decision = events?.decision;
  if (!decision || tower.clock.dayTick < decision.deadline) return;
  const answer = decision.kind === 'bomb' ? 'search' : 'decline';
  events.decision = null;
  if (decision.kind === 'bomb') resolveBombDecision(tower, answer, true);
  else resolveFireDecision(tower, answer, true);
}

function openDecision(tower, kind, cost) {
  const events = eventsOf(tower);
  events.decision = {
    kind, cost, openedTick: tower.clock.dayTick, deadline: tower.clock.dayTick + DECISION_TICKS,
  };
}

// --------------------------------------------------------------------- daily check

/**
 * **Checkpoint 240.** `TIME.md` § 240: the fire check first, then the bomb's - *"`fire` before
 * `bomb` at `240`"*. Called after the commercial and entertainment rebuilds the same tick runs.
 * (The VIP is booked later in the day, by `eventsTick` at `VIP_BOOK_TICK`.)
 */
export function runDailyEvents(tower) {
  const day = tower.clock.dayCounter;
  const started = [];
  if (isFireDay(day) && tryStartFire(tower)) started.push('fire');
  if (isBombDay(day) && tryStartBomb(tower)) started.push('bomb');
  return started;
}

// --------------------------------------------------------------------- the bomb

function securityCount(tower) {
  return securityOffices(tower).length;
}

/**
 * *"checked at checkpoint `0x00f0`; fires when `day_counter % 60 == 59`; suppressed while a
 * bomb or fire event is already active"*, then: a candidate floor, *"at least `4` tiles"*
 * wide, an x uniformly in `[left, right - 4]`, and the ransom prompt.
 *
 * @returns {boolean} whether a bomb was planted
 */
export function tryStartBomb(tower) {
  const events = eventsOf(tower);
  if (eventIsRunning(tower) || !bombCanComeAt(tower.starCount)) return false;
  const floor = pickEventFloor(tower);
  if (floor === null) return false;
  const bounds = floorBounds(tower, floor);
  if (!bounds || bounds.right - bounds.left < BOMB_MIN_SPAN) return false;
  const x = bounds.left + tower.rng.int(bounds.right - BOMB_MIN_SPAN - bounds.left + 1);
  const ransom = BOMB_RANSOM[tower.starCount];

  events.bombActive = true;
  events.bomb = {
    floor, x, ransom, phase: 'prompt', plantedDay: tower.clock.dayCounter,
    armedTick: null, scanFrom: bounds.right - SEARCH_START_OFFSET, scanned: 0, resolveAt: null,
  };
  openDecision(tower, 'bomb', ransom);
  say(tower, 'bombDemand', EVENT_TEXT.bombDemand(ransom), 'bad');
  record(tower, { kind: 'bomb', outcome: 'planted', floor, x, ransom });
  return true;
}

function resolveBombDecision(tower, answer, byDefault = false) {
  const events = eventsOf(tower);
  const bomb = events.bomb;
  if (!bomb) return {};
  if (answer === 'pay') {
    tower.cash -= bomb.ransom;
    bookOther(ledgerFor(tower).other, 'ransom', bomb.ransom);     // a line of the Finance window (issue #18)
    events.bomb = null;
    events.bombActive = false;
    say(tower, 'bombPaid', EVENT_TEXT.bombPaid(bomb.ransom));
    record(tower, { kind: 'bomb', outcome: 'paid', floor: bomb.floor, ransom: bomb.ransom });
    return { cost: bomb.ransom, outcome: 'paid' };
  }
  bomb.phase = 'armed';
  bomb.armedTick = tower.clock.dayTick;
  say(tower, 'bombSearching',
    securityCount(tower) > 0 ? EVENT_TEXT.bombSearching() : EVENT_TEXT.bombNoSecurity(), 'bad');
  record(tower, { kind: 'bomb', outcome: 'search', byDefault, security: securityCount(tower) });
  return { outcome: 'search' };
}

/**
 * **How far along the search is.** Each security office sends one team by the emergency stairs
 * (`guardResponse`: 8 ticks a floor, nobody takes a lift); a team that has arrived sweeps the
 * bomb's floor from `right - 2` leftward a tile a tick. The bomb is found when the teams have
 * between them covered the tiles from the sweep's start to the bomb.
 *
 * Pure in the tower and the bomb. `spec/DEVIATIONS.md` A69.
 *
 * @returns {{teams:number, arrived:number, needed:number, scanned:number}}
 */
export function searchProgress(tower, bomb) {
  const response = guardResponse(tower, bomb.floor);
  const elapsed = bomb.armedTick == null ? 0 : tower.clock.dayTick - bomb.armedTick;
  const arrived = response.offices.filter((team) => team.ticks <= elapsed).length;
  return { teams: response.offices.length, arrived, needed: bomb.scanFrom - bomb.x + 1, scanned: bomb.scanned };
}

function tickBomb(tower) {
  const events = tower.events;
  const bomb = events.bomb;
  if (!bomb) return;
  const now = tower.clock.dayTick;

  if (bomb.phase === 'armed') {
    const progress = searchProgress(tower, bomb);
    bomb.scanned += progress.arrived * SEARCH_TILES_PER_TICK;
    if (bomb.scanned >= progress.needed) {
      bomb.phase = 'found';
      bomb.foundTick = now;
      bomb.resolveAt = now + DECISION_TICKS;
      say(tower, 'bombFound', EVENT_TEXT.bombFound(bomb.floor), 'good');
      say(tower, 'bombDefused', EVENT_TEXT.bombDefused(), 'good');
      record(tower, { kind: 'bomb', outcome: 'found', floor: bomb.floor, ticks: now - bomb.armedTick });
    } else if (now >= BOMB_DEADLINE_TICK) {
      explodeBomb(tower, bomb);
    }
    return;
  }
  if ((bomb.phase === 'found' || bomb.phase === 'exploded') && now >= bomb.resolveAt) {
    events.bomb = null;
    events.bombActive = false;
    resumeClockAt(tower, RESUME_TICK);
  }
}

/**
 * *"`resolve_bomb_search(0)`: search failed, detonates"*: every destructible object in the
 * `40 x 6` rectangle goes - floors `[bomb_floor - 2, bomb_floor + 3]`, tiles
 * `[bomb_x - 20, bomb_x + 19]` - and *"either branch then schedules a short cleanup delay of
 * `2` ticks"*.
 */
function explodeBomb(tower, bomb) {
  const events = tower.events;
  const left = bomb.x - BLAST_TILES_LEFT;
  const right = bomb.x + BLAST_TILES_RIGHT;
  let destroyed = 0;
  for (const o of [...tower.objects.values()]) {
    if (o.floor < bomb.floor - BLAST_FLOORS_BELOW || o.floor > bomb.floor + BLAST_FLOORS_ABOVE) continue;
    if (o.left > right || o.right < left) continue;
    if (destroyObject(tower, o, 'blast')) destroyed++;
  }
  bomb.phase = 'exploded';
  bomb.destroyed = destroyed;
  bomb.resolveAt = tower.clock.dayTick + DECISION_TICKS;
  events.blast = { floor: bomb.floor, x: bomb.x, day: tower.clock.dayCounter, tick: tower.clock.dayTick };
  say(tower, 'bombExploded', EVENT_TEXT.bombExploded(bomb.floor), 'bad');
  record(tower, { kind: 'bomb', outcome: 'exploded', floor: bomb.floor, x: bomb.x, destroyed });
}

// ---------------------------------------------------------------------- the fire

/**
 * *"only triggers when the tower is still in the morning-period gate ... `star_count > 2`, and
 * no cathedral evaluation site is active"*, on a floor at least `32` tiles wide, ignition at
 * `right - 32`. SECOM (a security office) senses it; without one it is merely reported.
 *
 * The cathedral's *"evaluation site"* is the cathedral itself (issue #17, `hasCathedral`): the
 * reference's own guard is `g_eval_entity_index >= 0`, which is *"a cathedral is placed"* and
 * nothing finer - the guests' wedding is a weekend morning and the fire a morning too, but the
 * guard does not look at the day. `spec/DEVIATIONS.md` A72, A74.
 *
 * @returns {boolean} whether a fire started
 */
export function tryStartFire(tower) {
  const events = eventsOf(tower);
  if (eventIsRunning(tower)) return false;
  if (tower.clock.daypart >= 4 || tower.starCount < FIRE_MIN_STARS) return false;
  if (hasCathedral(tower)) return false;
  const floor = pickEventFloor(tower);
  if (floor === null) return false;
  const bounds = floorBounds(tower, floor);
  if (!bounds || bounds.right - bounds.left < FIRE_MIN_SPAN) return false;

  const seed = bounds.right - FIRE_SEED_OFFSET;
  const offices = securityOffices(tower);
  events.fireActive = true;
  events.fire = {
    floor, current: floor, seed, startTick: tower.clock.dayTick, age: 0,
    // SECOM sensed it: the guards get the head start; nobody to sense it, no head start.
    hold: offices.length > 0 ? SECURITY_HEAD_START_TICKS : 0,
    fronts: { left: seed, right: seed },
    helicopter: null,
    guards: offices.map((office) => dispatchGuard(tower, office, floor)).filter(Boolean),
    destroyed: 0, floorsBurned: 1,
  };
  openDecision(tower, 'fire', HELICOPTER_COST);
  say(tower, 'fire',
    offices.length > 0 ? EVENT_TEXT.fireSensed(floor) : EVENT_TEXT.fireReported(floor), 'bad');
  record(tower, { kind: 'fire', outcome: 'started', floor, security: offices.length });
  return true;
}

/**
 * One guard team from one office, on its way up or down the emergency stairs to `floor`.
 * `null` when the stairs do not reach it (`emergencyStairsRoute` says so).
 */
function dispatchGuard(tower, office, floor) {
  const route = emergencyStairsRoute(tower, office.floor, floor);
  if (!route.ok) return null;
  return {
    officeId: office.id, floor: office.floor, target: floor, travel: route.ticks,
    status: route.ticks > 0 ? 'climb' : 'walk', column: null, windup: 0, extinguished: 0,
  };
}

function resolveFireDecision(tower, answer, byDefault = false) {
  const fire = tower.events.fire;
  if (!fire) return {};
  if (answer === 'helicopter') {
    const bounds = floorBounds(tower, fire.current);
    tower.cash -= HELICOPTER_COST;
    bookOther(ledgerFor(tower).other, 'helicopter', HELICOPTER_COST);   // a line of the Finance window (issue #18)
    fire.helicopter = (bounds ? bounds.right : fire.seed + FIRE_SEED_OFFSET) - HELICOPTER_START_OFFSET;
    fire.bought = true;
    say(tower, 'fireHelicopter', EVENT_TEXT.fireHelicopter());
    record(tower, { kind: 'fire', outcome: 'helicopter', cost: HELICOPTER_COST });
    return { cost: HELICOPTER_COST, outcome: 'helicopter' };
  }
  say(tower, 'fireSecurity', fire.guards.length > 0 ? EVENT_TEXT.fireSecurity() : EVENT_TEXT.fireNoSecurity(), 'bad');
  record(tower, { kind: 'fire', outcome: 'decline', byDefault, guards: fire.guards.length });
  return { outcome: 'decline' };
}

const frontAlive = (fire) => fire.fronts.left !== null || fire.fronts.right !== null;

/**
 * `extinguish_fire_front_at_tile`: the wider window than the one a guard must stand in to start -
 * `[left, left + 12)` for the left front, `[right, right + 12)` for the right.
 */
function extinguishAt(fire, column) {
  const { left, right } = fire.fronts;
  if (left !== null && column >= left && column < left + FIRE_RIGHT_REACH) fire.fronts.left = null;
  if (right !== null && column >= right && column < right + FIRE_RIGHT_REACH) fire.fronts.right = null;
}

/**
 * A guard stands where it can fight a front: the inner half of either one
 * (`[left, left + 6)` or `[right + 6, right + 12)`), the reference's arrival predicate.
 */
function inReach(fire, column) {
  const { left, right } = fire.fronts;
  return (left !== null && column >= left && column < left + 6)
    || (right !== null && column >= right + 6 && column < right + FIRE_RIGHT_REACH);
}

/**
 * One tick of one guard team: climb the outside stairs to the burning floor, appear at the
 * building's right edge, walk left a tile a tick until a front is within reach, wind up, put
 * it out, and go on to the next. When the fire climbs, the team climbs after it.
 */
function stepGuard(tower, fire, guard) {
  if (guard.status === 'climb') {
    guard.travel -= 1;
    if (guard.travel > 0) return;
    guard.floor = guard.target;
    guard.status = 'walk';
    guard.column = null;
  }
  if (guard.floor !== fire.current) {
    const route = emergencyStairsRoute(tower, guard.floor, fire.current);
    if (!route.ok) return;
    guard.target = fire.current;
    guard.travel = Math.max(1, route.ticks);
    guard.status = 'climb';
    return;
  }
  if (!frontAlive(fire)) return;
  if (guard.column === null) {
    const bounds = floorBounds(tower, guard.floor);
    // Spawn one tile inside `right + 12` so the first step lands on it (the reference's trace).
    guard.column = bounds ? bounds.right + FIRE_RIGHT_REACH - 1 : fire.seed;
  }
  if (guard.status === 'wind') {
    guard.windup -= 1;
    if (guard.windup > 0) return;
    extinguishAt(fire, guard.column);
    guard.extinguished++;
    guard.status = 'walk';
    return;
  }
  if (inReach(fire, guard.column)) { guard.status = 'wind'; guard.windup = GUARD_EXTINGUISH_TICKS; return; }
  if (tower.clock.dayTick % GUARD_WALK_TICKS === 0 && guard.column > 0) guard.column -= 1;
}

/**
 * The spread, once every seven ticks (absolute `day_tick % 7`, as the binary): the left front
 * deletes the tile it stands on and moves left; the right front deletes `position + 12` and
 * moves right; each ends at the floor's edge. Whatever stands on a tile and can burn, burns.
 */
function stepFronts(tower, fire) {
  const bounds = floorBounds(tower, fire.current);
  if (!bounds) { fire.fronts.left = null; fire.fronts.right = null; return; }
  const before = tower.objects.size;
  if (fire.fronts.left !== null) {
    burnTile(tower, fire.current, fire.fronts.left, 'fire');
    fire.fronts.left -= 1;
    if (fire.fronts.left < bounds.left) fire.fronts.left = null;
  }
  if (fire.fronts.right !== null) {
    const reach = fire.fronts.right + FIRE_RIGHT_REACH;
    if (reach <= bounds.right) burnTile(tower, fire.current, reach, 'fire');
    fire.fronts.right += 1;
    if (fire.fronts.right + FIRE_RIGHT_REACH > bounds.right) fire.fronts.right = null;
  }
  fire.destroyed += before - tower.objects.size;
}

function tickFire(tower) {
  const events = tower.events;
  const fire = events.fire;
  if (!fire) return;
  const now = tower.clock.dayTick;

  for (const guard of fire.guards) stepGuard(tower, fire, guard);

  if (fire.hold > 0) {
    fire.hold -= 1;
  } else {
    fire.age += 1;

    // The helicopter sweeps down from `right - 12` a tile a tick; any front it passes is out.
    if (fire.helicopter !== null) {
      if (now % HELICOPTER_TICKS_PER_TILE === 0) fire.helicopter -= 1;
      if (fire.fronts.left !== null && fire.fronts.left > fire.helicopter) fire.fronts.left = null;
      if (fire.fronts.right !== null && fire.fronts.right > fire.helicopter) fire.fronts.right = null;
      if (fire.helicopter <= 0) fire.helicopter = null;
    }

    // Upward only, one floor every 80 ticks of spread, and only while there is still fire to
    // climb with; the floor below stops burning as the next catches (the reference's trace).
    if (fire.age % FIRE_FLOOR_TICKS === 0 && frontAlive(fire)
      && floorHasObjects(tower, fire.current + 1) && fire.current + 1 <= MAX_FLOOR) {
      fire.current += 1;
      fire.floorsBurned += 1;
      fire.fronts = { left: fire.seed, right: fire.seed };
    }
    if (now % FIRE_SPREAD_TICKS === 0 && frontAlive(fire)) stepFronts(tower, fire);
  }

  // *"if no fire-front cells remain, or when `day_tick == 2000`, the event finalizes"*.
  if (!frontAlive(fire) || now >= FIRE_END_TICK) endFire(tower, fire);
}

/**
 * *"final cleanup clears the fire bit, emits popup `0xBC5`, idles the helper pool, and forces
 * `day_tick` up to `1500` if it was still earlier in the day"*.
 */
function endFire(tower, fire) {
  const events = tower.events;
  events.fire = null;
  events.fireActive = false;
  events.decision = events.decision?.kind === 'fire' ? null : events.decision;
  say(tower, 'fireOut', fire.destroyed > 0 ? EVENT_TEXT.fireStopped() : EVENT_TEXT.fireStoppedClean(),
    fire.destroyed > 0 ? 'bad' : 'good');
  record(tower, {
    kind: 'fire', outcome: 'out', floor: fire.floor, destroyed: fire.destroyed, floorsBurned: fire.floorsBurned,
    helicopter: Boolean(fire.bought), guards: fire.guards.length, ticks: tower.clock.dayTick - fire.startTick,
  });
  resumeClockAt(tower, RESUME_TICK);
}

// -------------------------------------------------------------------- the per tick

/**
 * **Every tick, after the checkpoint body and before the entity refresh** (the reference
 * runs `tickBombEvent` and `tickFireEvent` after its checkpoints, `day-scheduler.ts`). A tower
 * with nothing live costs one property read.
 */
export function eventsTick(tower) {
  // The VIP is booked at one o'clock, once the morning's checkouts have been cleaned: a suite is
  // only free to give once the hotel has turned it round, and at 240 it never is.
  if (tower.clock.dayTick === VIP_BOOK_TICK) tryBookVip(tower);
  const events = tower.events;
  if (!events) return;
  if (events.decision) settleDecision(tower);
  if (events.bomb) tickBomb(tower);
  if (events.fire) tickFire(tower);
  if (events.vip) tickVip(tower);
}

// ----------------------------------------------------------------------- the VIP

/** The persistent actor that plays every visitor, made on the first booking and kept. */
function vipActor(tower) {
  const events = eventsOf(tower);
  const existing = tower.actors.find((a) => a && a.id === events.vipActorId);
  if (existing) return existing;
  const actor = createActor({
    family: FAMILY.vip, anchorFloor: 0, objectId: null, occupantIndex: 0, state: VIP_STATE.away,
    tripFields: createSimTripRecord(),
  });
  tower.actors.push(actor);
  events.vipActorId = actor.id;
  return actor;
}

/** Suites a VIP could be given: vacant and clean, open for guests, on a floor, not held. */
export function vipCandidateSuites(tower) {
  return [...tower.objects.values()].filter((o) =>
    o.family === FAMILY.hotelSuite && isHotelVacant(o) && o.occupiedFlag && !o.vipHold && o.floor > 0);
}

/**
 * Why no VIP is coming today, or `null`: a visit is already under way, an event is running, the
 * tower is not yet at the rung the stay is for or has already passed it, a failed visit is still
 * inside its quarter, or there is no suite to give.
 */
export function vipBlocker(tower) {
  const events = eventsOf(tower);
  if (events.vip) return 'a VIP is already here';
  if (eventIsRunning(tower)) return 'a bomb or fire is under way';
  if (tower.starCount < VIP_MIN_STARS) return 'suites open at ' + VIP_MIN_STARS + ' stars';
  if (starGatesOf(tower).vipStayFavorable) return 'the VIP already approved of the tower';
  if (events.lastVip && tower.clock.dayCounter - events.lastVip.endDay < VIP_RETRY_DAYS) return 'a VIP only calls once a quarter';
  if (vipCandidateSuites(tower).length === 0) return 'no suite is open for a VIP';
  return null;
}

/**
 * The afternoon's booking: a VIP reserves a suite on a named floor. The suite is held (nobody
 * else checks in) until the stay is over.
 *
 * @returns {boolean} whether a VIP was booked
 */
export function tryBookVip(tower) {
  if (vipBlocker(tower)) return false;
  const events = eventsOf(tower);
  const suites = vipCandidateSuites(tower);
  const suite = suites[tower.rng.int(suites.length)];
  const actor = vipActor(tower);
  // A fresh stay is judged on its own trips, not on the last visitor's.
  resetSimTripCounters(actor);
  actor.elapsedPacked = 0;
  actor.lastTripTick = 0;
  actor.anchorFloor = 0;
  actor.state = VIP_STATE.away;
  actor.route = null;
  actor.waitingFloor = null;
  actor.routeCarrier = null;

  suite.vipHold = true;
  events.vip = {
    phase: 'booked', suiteId: suite.id, floor: suite.floor, bookedDay: tower.clock.dayCounter,
    arrivedTick: null,
  };
  say(tower, 'vipBooked', EVENT_TEXT.vipBooked(suite.floor));
  record(tower, { kind: 'vip', outcome: 'booked', floor: suite.floor });
  return true;
}

/**
 * **The verdict.** *"This person must be happy with your hotel suite and with your elevator
 * system"* (help file): the suite is not infested, and the visitor's own two trips - lobby to
 * suite, suite to lobby, through the real router and the real lifts - plus the suite's noise
 * score a grade that is not *poor* (`FACILITIES.md` § Facility Evaluation Model: stress, `+60`
 * for a noise source within the hotel's radius, `< 80` good, `< 150` average, `200` from 4
 * stars). `spec/DEVIATIONS.md` A66.
 *
 * @returns {{comfortable:boolean, stress:number, noise:boolean, score:number, level:number, trips:number, infested:boolean}}
 */
export function vipVerdict(tower, actor, suite) {
  const stress = actor.tripCount > 0 ? computeRuntimeTileStressAverage(actor) : 0;
  const noise = suite ? hotelNoiseNear(tower, suite) : false;
  const score = stress + (noise ? 60 : 0);
  const level = evalLevelFor(score, tower.starCount);
  const infested = suite ? isHotelInfested(suite) : false;
  return { comfortable: level !== 0 && !infested, stress, noise, score, level, trips: actor.tripCount, infested };
}

/** End the visit. `verdict` is `null` for a visit that never reached one (the suite was demolished). */
function finishVip(tower, verdict, why) {
  const events = tower.events;
  const vip = events.vip;
  const actor = vipActor(tower);
  const suite = tower.objects.get(vip.suiteId);
  if (suite) suite.vipHold = false;
  for (const carrier of tower.carriers) cancelRequest(carrier, actor.id);
  actor.state = VIP_STATE.away;
  actor.route = null;
  actor.waitingFloor = null;
  actor.routeCarrier = null;
  actor.anchorFloor = 0;

  if (verdict === null) {
    say(tower, 'vipCancelled', EVENT_TEXT.vipCancelled());
  } else if (verdict.comfortable) {
    starGatesOf(tower).vipStayFavorable = true;
    say(tower, 'vipPleased', EVENT_TEXT.vipPleased(), 'good');
  } else {
    say(tower, 'vipDispleased', EVENT_TEXT.vipDispleased(), 'bad');
  }
  events.lastVip = { endDay: tower.clock.dayCounter, comfortable: verdict ? verdict.comfortable : null, why };
  record(tower, {
    kind: 'vip', outcome: verdict === null ? 'cancelled' : verdict.comfortable ? 'comfortable' : 'uncomfortable',
    why, floor: vip.floor, ...(verdict ?? {}),
  });
  events.vip = null;
}

/**
 * The verdict of a visit that ran out of time in the lifts. **A VIP still waiting has had no trip
 * counted** - `computeRuntimeTileStressAverage` scores a person with no trips 0, the *best* value, and
 * reading it here would call the longest wait in the tower a perfect stay (the shape `CLAUDE.md` keeps
 * a list of). So the stress is the clamp every trip is capped at, `ELAPSED_CLAMP` (300): he waited
 * at least that long, and the stay is poor whatever else is true of it.
 */
function failed(tower, actor, suite) {
  const verdict = vipVerdict(tower, actor, suite);
  const stress = Math.max(verdict.stress, ELAPSED_CLAMP);
  const score = stress + (verdict.noise ? 60 : 0);
  return { ...verdict, stress, score, level: evalLevelFor(score, tower.starCount), comfortable: false };
}

function tickVip(tower) {
  const events = tower.events;
  const vip = events.vip;
  const { dayCounter, dayTick } = tower.clock;
  const suite = tower.objects.get(vip.suiteId);

  if (!suite) { finishVip(tower, null, 'suite demolished'); return; }

  switch (vip.phase) {
    case 'booked':
      // The booking day's evening opens the check-in window; a VIP who never came (the clock
      // jumped past, or the save was loaded after) is simply released.
      if (dayCounter > vip.bookedDay) { finishVip(tower, null, 'no show'); return; }
      if (dayTick >= VIP_ARRIVAL_TICK) {
        const actor = vipActor(tower);
        vip.phase = 'arriving';
        actor.state = VIP_STATE.arriving;
        actor.anchorFloor = 0;
        say(tower, 'vipArrived', EVENT_TEXT.vipArrived(), 'bad');
        record(tower, { kind: 'vip', outcome: 'arrived', floor: vip.floor });
      }
      return;
    case 'arriving':
      // The day counter turns at 2300: a VIP not yet in the suite by then never got there.
      if (dayCounter > vip.bookedDay) {
        finishVip(tower, failed(tower, vipActor(tower), suite), 'never reached the suite');
      }
      return;
    case 'staying':
      if (dayCounter > vip.bookedDay && dayTick >= VIP_CHECKOUT_FROM_TICK && dayTick < 2300) {
        vip.phase = 'leaving';
        vipActor(tower).state = VIP_STATE.leaving;
      }
      return;
    case 'leaving':
      if (dayCounter > vip.bookedDay + 1
        || (dayCounter === vip.bookedDay + 1 && dayTick >= VIP_CHECKOUT_DEADLINE_TICK && dayTick < 2300)) {
        finishVip(tower, failed(tower, vipActor(tower), suite), 'could not get out');
      }
      return;
    default:
  }
}

// ---- the visitor's own movement: the same router, the same lifts, the same stress

/** The stay begins: the visitor is in the suite. */
function checkInVip(tower, actor) {
  const vip = tower.events.vip;
  vip.phase = 'staying';
  vip.arrivedTick = tower.clock.dayTick;
  actor.anchorFloor = vip.floor;
  actor.state = VIP_STATE.staying;
  actor.waitingFloor = null;
  actor.routeCarrier = null;
  record(tower, { kind: 'vip', outcome: 'in the suite', floor: vip.floor });
}

/** The visitor is in the lobby and rates the stay. */
function checkOutVip(tower, actor) {
  const vip = tower.events.vip;
  const suite = tower.objects.get(vip.suiteId);
  actor.anchorFloor = 0;
  finishVip(tower, vipVerdict(tower, actor, suite), 'checked out');
}

/**
 * The family handler the stride calls for the VIP actor. Only the two travelling phases do
 * anything; the booking and the stay are `tickVip`'s.
 */
export function vipFamilyHandler(ctx) {
  return function serviceVip(tower, actor) {
    const vip = tower.events?.vip;
    if (!vip || actor.id !== tower.events.vipActorId) return;
    const suite = tower.objects.get(vip.suiteId);
    if (!suite) return;

    if (vip.phase === 'arriving') {
      if (isInTransit(actor.state) && shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      if (!isInTransit(actor.state)) actor.anchorFloor = 0;
      const result = route(tower, actor, actor.anchorFloor ?? 0, suite.floor, ctx, VIP_STATE.arriving);
      if (result.code === -1) { actor.state = VIP_STATE.arriving; actor.routeCarrier = null; return; }
      noteLocalLeg(actor, result);
      if (result.code === 3) { countSameFloorArrival(actor, tower, result); checkInVip(tower, actor); return; }
      actor.state = enterTransit(VIP_STATE.arriving);
    } else if (vip.phase === 'leaving') {
      if (isInTransit(actor.state) && shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      if (!isInTransit(actor.state)) actor.anchorFloor = suite.floor;
      const result = route(tower, actor, actor.anchorFloor ?? suite.floor, 0, ctx, VIP_STATE.leaving);
      if (result.code === -1) { actor.state = VIP_STATE.leaving; actor.routeCarrier = null; return; }
      noteLocalLeg(actor, result);
      if (result.code === 3) { countSameFloorArrival(actor, tower, result); checkOutVip(tower, actor); return; }
      actor.state = enterTransit(VIP_STATE.leaving);
    }
  };
}

/**
 * A lift (or a walked leg) set the VIP down on `floor`. A stop that is not the leg's last
 * (a sky-lobby transfer) only moves the visitor; the real end is the suite or the lobby.
 */
export function vipArrival(tower, actor, floor) {
  actor.anchorFloor = floor;
  actor.routeCarrier = null;
  const vip = tower.events?.vip;
  if (!vip || actor.id !== tower.events.vipActorId) { actor.state = baseState(actor.state); return; }
  const suite = tower.objects.get(vip.suiteId);
  if (!suite) return;
  if (vip.phase === 'arriving' && floor === suite.floor) checkInVip(tower, actor);
  else if (vip.phase === 'leaving' && floor === 0) checkOutVip(tower, actor);
}

// -------------------------------------------------------------- the extras: treasure

/**
 * Called by `build` once something is standing on `floor`. The first object on each basement
 * floor ever dug rolls once for treasure; a hit is paid at once.
 *
 * @returns {{amount:number}|null}
 */
export function maybeFindTreasure(tower, floor) {
  if (!isBasement(floor) || !floorExists(floor)) return null;
  const events = eventsOf(tower);
  if (events.dug.includes(floor)) return null;
  events.dug.push(floor);
  if (!tower.rng.chance(TREASURE_ODDS)) return null;
  const amount = TREASURE_AMOUNTS[tower.rng.int(TREASURE_AMOUNTS.length)];
  tower.cash += amount;
  bookOther(ledgerFor(tower).other, 'treasure', amount);              // a line of the Finance window (issue #18)
  say(tower, 'treasure', EVENT_TEXT.treasure(amount), 'good');
  record(tower, { kind: 'treasure', outcome: 'found', floor, amount });
  return { amount };
}

// ---------------------------------------------------------------------- Santa

export const isSantaDay = (dayCounter) => dayCounter % 12 === SANTA_DAY_OF_YEAR;

/**
 * Santa's flight: how far across the sky (0 to 1) the sleigh is, or `null` when it is not
 * out. A pure function of the clock, so the renderer needs no state of its own and a save
 * resumes it mid-flight.
 */
export function santaFlight(clock) {
  if (!clock || !isSantaDay(clock.dayCounter)) return null;
  if (clock.dayTick < SANTA_TICK || clock.dayTick >= SANTA_END_TICK) return null;
  return (clock.dayTick - SANTA_TICK) / (SANTA_END_TICK - SANTA_TICK);
}

/** The 2000 checkpoint: on Santa's day, say so. */
export function announceSanta(tower) {
  if (!isSantaDay(tower.clock.dayCounter)) return false;
  say(tower, 'santa', EVENT_TEXT.santa(), 'good');
  record(tower, { kind: 'santa', outcome: 'announced' });
  return true;
}

// --------------------------------------------------- a suite is held for the VIP

/** Is this suite reserved for a VIP? `hotelGate` holds its guests while it is. */
export const isHeldForVip = (object) => Boolean(object?.vipHold);
