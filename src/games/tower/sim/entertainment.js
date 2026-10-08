/**
 * Entertainment: the movie theater (`0x12`) and the party hall (`0x1d`).
 *
 * Spec: `specs/facility/ENTERTAINMENT.md` (the whole file), `specs/TIME.md`
 * § 240 / § 1000 / § 1200 / § 1400 / § 1500 / § 1600 / § 1900 / § 2500,
 * `specs/EVENTS.md` (bomb and fire).
 *
 * ## What an entertainment venue is
 *
 * A two-floor facility whose halves are two placed objects, plus **one linked
 * record** the day's cycle runs on: a per-half runtime budget, an age, a phase,
 * and the attendance the payout is read from. The record lives on the
 * *primary* half - the one on the venue floor (a theater's upper, a party
 * hall's lower) - and the other half points back at it (`entertainmentId`).
 * Everything else here is the cycle that spends the budget:
 *
 *   240   rebuild  reseed both budgets from the film's age, clear the counters
 *   1000  the theater's upper half is activated (its audience may now come)
 *   1200  the party hall is activated; the theater's phase is promoted
 *   1400  the theater's lower half is activated
 *   1500  the theater's upper half ends; its audience goes to the shops
 *   1600  the party hall ends and is PAID
 *   1900  the theater's lower half ends; the theater is PAID
 *   2500  every visitor is sent home for the night
 *
 * ## The audience travels (no teleporting)
 *
 * Activation writes a visitor's state, nothing else. The visitor then rolls the
 * gate (1 in 6 per stride, mornings and early afternoons only), spends one unit
 * of its half's budget, and **routes from the lobby to the venue floor through
 * the real router** - so a theater above a lift that does not reach it fills no
 * seats and pays nothing. Attendance is the count of those that arrived, never
 * a number we wrote.
 *
 * ## Shop spillover
 *
 * *"A movie theater brings outside crowds who shop within five floors of it"*
 * (the original game's help file). The upper show's audience, leaving at 1500,
 * picks a shop, restaurant or fast food within five floors of the theater and
 * walks there through the same router; **arriving takes a slot in the venue**
 * (`acquireVenueSlot`), which is what puts them in that venue's visitor count -
 * and so in its closing payout band. `spec/DEVIATIONS.md` A43.
 *
 * ## Money
 *
 * The cash moves through `hooks.onIncome(object, bucket, dollars)` and nothing
 * here knows what a ledger is; `sim/ledger-adapter.js` wires it. On a **bomb or
 * fire day** the payout is skipped - `entertainmentPaysToday` - and the venue's
 * own state still resets, as the reference's `accrue_facility_income_by_family`
 * does. `spec/DEVIATIONS.md` A44.
 */
import {
  FAMILY, OBJECT_TYPE, floorExists, isHotelFamily, isInTransit, placeObject, spanBlocked,
} from './state.js';
import {
  COMMERCIAL_FAMILIES, LOBBY_FLOOR, SLOT, VENUE, acquireVenueSlot, minimumStayElapsed, releaseVenueSlot, venueOf,
} from './commercial.js';
import { emitsDistanceFeedback, shouldWaitForQueuedCarrier } from './routing.js';

// ------------------------------------------------------------ the two kinds

/**
 * `ENTERTAINMENT.md` § Placed-Object Types, and the tile widths of the reference
 * *implementation* (`TILE_WIDTHS`: cinema 31, party hall 27) - the only place a
 * width was recovered, taken unscaled as A16 / A22 / A26 / A36 took theirs.
 * `spec/DEVIATIONS.md` A41.
 *
 * `primary` is the half that carries the linked record and the venue floor:
 * *"Movie theater: `upper_floor_index` ... Party hall: `lower_floor_index`"*
 * (§ Venue Floor).
 */
export const ENTERTAINMENT_KINDS = {
  theater: {
    kind: 'theater',
    family: FAMILY.theater,
    upperType: OBJECT_TYPE.theaterUpper,
    lowerType: OBJECT_TYPE.theaterLower,
    width: 31,
    primary: 'upper',
    incomeBucket: 'cinema',
    costKey: 'movieTheater',
    label: 'Movie Theater',
  },
  partyHall: {
    kind: 'partyHall',
    family: FAMILY.partyHall,
    upperType: OBJECT_TYPE.partyHallUpper,
    lowerType: OBJECT_TYPE.partyHallLower,
    width: 27,
    primary: 'lower',
    incomeBucket: 'partyHall',
    costKey: 'partyHall',
    label: 'Party Hall',
  },
};

export const THEATER_WIDTH = ENTERTAINMENT_KINDS.theater.width;
export const PARTY_HALL_WIDTH = ENTERTAINMENT_KINDS.partyHall.width;

/** Both entertainment families, for the sets that ask "is this one of them?". */
export const ENTERTAINMENT_FAMILIES = new Set([FAMILY.theater, FAMILY.partyHall]);
export const isEntertainmentFamily = (family) => ENTERTAINMENT_FAMILIES.has(family);

/**
 * *"16 theaters and party halls combined"* - the sidecar table has 16 slots
 * (`ENTERTAINMENT.md` § Link Record Structure; the analysis' hard-limits list).
 */
export const MAX_ENTERTAINMENT_VENUES = 16;

/** Which half an object is, by its placed type. */
export function halfOf(object) {
  return object.type === OBJECT_TYPE.theaterUpper || object.type === OBJECT_TYPE.partyHallUpper
    ? 'upper' : 'lower';
}

export const kindOfFamily = (family) =>
  Object.values(ENTERTAINMENT_KINDS).find((k) => k.family === family) ?? null;

// ------------------------------------------------------------- the record

/** `ENTERTAINMENT.md` § Link Phase State. */
export const PHASE = { idle: 0, activated: 1, attending: 2, ready: 3 };

/**
 * The movie titles, `ENTERTAINMENT.md` § Movie Identity. Index = the record's
 * `selector`; 0..6 are the classics and 7..13 the new releases. (Index 14,
 * "Under the Apple Tree", is unreachable from the placement roll and from both
 * rotation formulas, and is left out.)
 */
export const FILMS = [
  'Revenge of the Big Spider', 'Northwest Romance', 'Samurai Cop', 'Big Wave',
  'Farewell to Morocco', 'Fear of Shark Teeth', 'Western Sheriff',
  'Dino Wars', 'The Making of a Star', 'Love in N.Y.', 'Waikiki Moon',
  'My Man of War', 'Christmas for Both of Us', 'Casual Friends',
];
export const CLASSIC_COUNT = 7;
export const isNewRelease = (selector) => selector >= CLASSIC_COUNT;
export const filmTitle = (selector) => FILMS[selector] ?? '';

/**
 * `ENTERTAINMENT.md` § Cinema "New Movie" Picker: the two purchases.
 *
 * Cost is the picker's own - "Show a new movie: $300,000", "Show a classic:
 * $150,000" - and the cycle is the dialog handler's, verbatim.
 */
export const FILM_PRICE = { new: 300_000, classic: 150_000 };
const FILM_CYCLE = {
  new: (selector) => ((selector + 1) % CLASSIC_COUNT) + CLASSIC_COUNT,
  classic: (selector) => (selector + 1) % CLASSIC_COUNT,
};

/**
 * The linked record. `ENTERTAINMENT.md` § Record Initialization: every cycle
 * field starts at zero and the budgets stay zero until the first 240 rebuild
 * seeds them - **a venue placed mid-day does nothing until the next morning**,
 * which is the reference's own behaviour and is kept.
 */
export function createEntertainmentRecord({ kind, upperId, lowerId, selector = null }) {
  return {
    kind: 'entertainment_venue',
    variant: kind,
    upperId,
    lowerId,
    /** The film: 0..13 for a theater, `null` for a party hall (the reference's 0xff). */
    selector,
    upperBudget: 0,
    lowerBudget: 0,
    phase: PHASE.idle,
    /** `link_age_counter`: saturates at 127, reset to 0 by buying a film. */
    age: 0,
    /** Currently-present attendees. */
    active: 0,
    /** Total arrivals this cycle - **what the payout is read from**. */
    attendance: 0,
    /** Is this half still taking its audience? Opened by activation, closed by the advance. */
    upperOpen: false,
    lowerOpen: false,
    /** What the last day's show drew and paid, for the sign over the door. */
    lastAttendance: 0,
    lastPayout: 0,
    /** The population this record put on the ledger at the last rebuild (taken back on demolition). */
    populationShare: 0,
  };
}

/** The record for a half of a venue, or `null`. */
export function recordOf(tower, object) {
  if (!object) return null;
  if (object.venue?.kind === 'entertainment_venue') return object.venue;
  if (object.entertainmentId == null) return null;
  const primary = tower.objects.get(object.entertainmentId);
  return primary?.venue?.kind === 'entertainment_venue' ? primary.venue : null;
}

/** The primary half of any half of a venue. */
export function primaryOf(tower, object) {
  if (!object) return null;
  if (object.venue?.kind === 'entertainment_venue') return object;
  return object.entertainmentId == null ? null : tower.objects.get(object.entertainmentId) ?? null;
}

/** Every venue in the tower, in placement order. */
export function entertainmentVenues(tower, family = null) {
  const out = [];
  for (const object of tower.objects.values()) {
    if (object.venue?.kind !== 'entertainment_venue') continue;
    if (family !== null && object.family !== family) continue;
    out.push({ object, record: object.venue });
  }
  return out;
}

/** Both halves' objects, by name. */
export function halvesOf(tower, record) {
  return { upper: tower.objects.get(record.upperId) ?? null, lower: tower.objects.get(record.lowerId) ?? null };
}

// -------------------------------------------------------------- placement

/**
 * Why a venue cannot stand with its lower half on `floor` at `left`, or null.
 *
 * Pure, so the ghost asks the sim rather than restating it (`ui/build.js`).
 * `ENTERTAINMENT.md` § Placement Validation: both venues are forbidden at floor
 * 0 and below - the caller's `aboveGrade` check - and the facility is two floors
 * tall, so both must be free.
 */
export function entertainmentObstruction(tower, kindName, floor, left) {
  const kind = ENTERTAINMENT_KINDS[kindName];
  if (!kind) return 'there is no "' + kindName + '" to build';
  const right = left + kind.width - 1;
  if (!floorExists(floor + 1)) {
    return 'a ' + kind.label.toLowerCase() + ' is two floors tall - there is no floor above that';
  }
  if (spanBlocked(tower, floor, left, right) || spanBlocked(tower, floor + 1, left, right)) {
    return 'something is already built there';
  }
  if (entertainmentVenues(tower).length >= MAX_ENTERTAINMENT_VENUES) {
    return 'a tower can hold at most ' + MAX_ENTERTAINMENT_VENUES + ' theaters and party halls between them';
  }
  return null;
}

/**
 * Place both halves and the record. The lower half is on `floor`, the upper on
 * `floor + 1`. **Visitors start parked**, not waiting to be hired (`occupantState`):
 * they come only when a checkpoint activates their half.
 *
 * A theater rolls its film at placement - *"`rand() % 14`"* (§ Record
 * Initialization) - which draws from the tower's own generator at command time.
 *
 * @returns {{ok:boolean, reason?:string, object?:object, objects?:object[]}}
 */
export function placeEntertainment(tower, { kind: kindName, floor, left }, makeTripFields = () => ({})) {
  const kind = ENTERTAINMENT_KINDS[kindName];
  if (!kind) return { ok: false, reason: 'there is no "' + kindName + '" to build' };
  const blocked = entertainmentObstruction(tower, kindName, floor, left);
  if (blocked) return { ok: false, reason: blocked };

  const right = left + kind.width - 1;
  // Only the primary half's floor holds visitors for a party hall; a theater
  // seats an audience on both floors.
  const seats = (half) => (kindName === 'partyHall' && half === 'upper' ? 0 : undefined);
  const lower = placeObject(tower, {
    family: kind.family, type: kind.lowerType, floor, left, right,
    occupantCount: seats('lower'), occupantState: ENT_STATE.parked,
  }, makeTripFields);
  if (!lower.ok) return lower;
  const upper = placeObject(tower, {
    family: kind.family, type: kind.upperType, floor: floor + 1, left, right,
    occupantCount: seats('upper'), occupantState: ENT_STATE.parked,
  }, makeTripFields);
  if (!upper.ok) {
    removeObjectAndActors(tower, lower.object.id);
    return upper;
  }

  const primary = kind.primary === 'upper' ? upper.object : lower.object;
  const other = primary === upper.object ? lower.object : upper.object;
  primary.venue = createEntertainmentRecord({
    kind: kindName,
    upperId: upper.object.id,
    lowerId: lower.object.id,
    selector: kindName === 'theater' ? tower.rng.int(FILMS.length) : null,
  });
  primary.entertainmentId = primary.id;
  other.entertainmentId = primary.id;
  return { ok: true, object: primary, objects: [lower.object, upper.object] };
}

function removeObjectAndActors(tower, objectId) {
  tower.objects.delete(objectId);
  tower.actors = tower.actors.filter((a) => a.objectId !== objectId);
}

/**
 * Take a venue down - both halves and everyone in them. Returns the population
 * the venue had put on the ledger, so the caller can take it back out.
 */
export function demolishEntertainment(tower, object) {
  const primary = primaryOf(tower, object);
  const record = primary?.venue;
  if (!record) return null;
  removeObjectAndActors(tower, record.upperId);
  removeObjectAndActors(tower, record.lowerId);
  return { family: primary.family, populationShare: record.populationShare, objects: [record.upperId, record.lowerId] };
}

// ------------------------------------------------------------- the film

/** *"`venue_selector < 7`: the low-selector table `40, 40, 40, 20`; `>= 7`: `60, 60, 40, 20`"*. */
export const THEATER_BUDGET = { classic: [40, 40, 40, 20], new: [60, 60, 40, 20] };
/** Days of age per tier: *"the age tier from `link_age_counter / 3`"*. */
export const AGE_TIER_DAYS = 3;
export const AGE_CAP = 0x7f;
export const PARTY_HALL_BUDGET = 50;

export const ageTierOf = (age) => Math.min(3, Math.trunc(age / AGE_TIER_DAYS));

/** One half's runtime budget for a film of this selector and age. */
export const theaterBudget = (selector, age) =>
  THEATER_BUDGET[isNewRelease(selector) ? 'new' : 'classic'][ageTierOf(age)];

/** The `selector` a purchase would move to, or `null` for a pool that is not one. */
export const nextSelector = (selector, pool) => FILM_CYCLE[pool]?.(selector) ?? null;

/**
 * Why this record cannot change its film, or null. Pure; the command and the
 * panel both ask it.
 */
export function filmChangeReason(record, pool) {
  if (record?.variant !== 'theater') return 'only a movie theater shows films';
  if (!(pool in FILM_PRICE)) return 'a film is either "new" or "classic"';
  return null;
}

/**
 * Apply a film change to the record - the dialog handler's two writes: the next
 * selector in the pool, and the age back to 0 (so the next rebuild reseeds from
 * tier 0). Does not touch the budgets: *"mid-cycle changes do not refund
 * consumed budget but the new selector takes effect at the next rebuild"*.
 */
export function changeFilm(record, pool) {
  record.selector = nextSelector(record.selector, pool);
  record.age = 0;
  return record.selector;
}

// ----------------------------------------------------------------- money

/** `ENTERTAINMENT.md` § Cash Payouts. */
export const THEATER_TIERS = [
  { min: 0, pay: 0 },
  { min: 40, pay: 2_000 },
  { min: 80, pay: 10_000 },
  { min: 100, pay: 15_000 },
];
export const PARTY_PAYOUT = 20_000;

/** The movie theater's payout for a day's attendance. */
export function theaterPayout(attendance) {
  let pay = 0;
  for (const tier of THEATER_TIERS) if (attendance >= tier.min) pay = tier.pay;
  return pay;
}

/** *"if `attendance_counter == 0`, payout is `$0`; otherwise ... `$20,000`"*. */
export const partyHallPayout = (attendance) => (attendance > 0 ? PARTY_PAYOUT : 0);

export const payoutFor = (record) =>
  record.variant === 'theater' ? theaterPayout(record.attendance) : partyHallPayout(record.attendance);

/**
 * `ENTERTAINMENT.md` § Calendar-edge payout skip: *"if `g_day_counter % 60 == 59`
 * return immediately; if `% 84 == 83` return immediately"*. These are the days
 * `TIME.md` § 240 triggers the bomb (`% 60 == 59`) and the fire (`% 84 == 83`)
 * on, so the issue's *"entertainment pays nothing on bomb/fire days"* is this
 * rule - whether or not an event actually fires.
 */
export const isBombOrFireDay = (dayCounter) => dayCounter % 60 === 59 || dayCounter % 84 === 83;

/**
 * Is a bomb or a fire live right now? Reads the two flags `createTower` puts on
 * `tower.events`; the events themselves (issue #16) set and clear them.
 */
export const eventIsLive = (tower) => Boolean(tower?.events?.bombActive || tower?.events?.fireActive);

/**
 * **The gate on every entertainment payout.** False on a bomb or fire day by the
 * calendar, and false while an event is live by the flag. Pure: it reads the
 * tower and writes nothing. `spec/DEVIATIONS.md` A44.
 */
export const entertainmentPaysToday = (tower) =>
  !isBombOrFireDay(tower?.clock?.dayCounter ?? 0) && !eventIsLive(tower);

// --------------------------------------------------------- the party hall

/**
 * **How many hotel rooms a party hall needs before it holds its party.**
 *
 * The issue says a party hall draws its 50 guests *"if the tower has the right
 * number of hotel rooms"*. Nothing in `specs/` or in the reference implementation
 * states any such condition or any number, so the condition is real here and the
 * number is the smallest that makes it one: at least this many rooms of any kind
 * must stand in the tower. TODO(parity): Keith to supply the real figure; this
 * constant is the only place it lives. `spec/DEVIATIONS.md` A42.
 */
export const PARTY_HALL_MIN_HOTEL_ROOMS = 1;

export function hotelRoomCount(tower) {
  let rooms = 0;
  for (const object of tower.objects.values()) if (isHotelFamily(object.family)) rooms++;
  return rooms;
}

/** May a party hall hold its party today? */
export const partyHallHasGuests = (tower) => hotelRoomCount(tower) >= PARTY_HALL_MIN_HOTEL_ROOMS;

// ----------------------------------------------------------- visitor states

/**
 * `ENTERTAINMENT.md` § Entity State Machine. `0x20` is *"activated, may come"*
 * (not an office's "waiting to be employed"), `0x03` *"arrived"*, `0x01` *"go
 * to a shop"*, `0x22` *"in a shop, dwelling"*, `0x05` *"go home"*, and `0x27`
 * parked. Each has an in-transit alias at `+0x40`.
 */
export const ENT_STATE = {
  shopping: 0x01,
  watching: 0x03,
  home: 0x05,
  going: 0x20,
  dwelling: 0x22,
  parked: 0x27,
};

/** *"`g_day_tick > 0xf0`"*, and the 1-in-6 roll. */
export const GATE_TICK = 0xf0;
export const GATE_CHANCE = 6;
/** *"the shops within five floors"*. */
export const SPILLOVER_FLOORS = 5;

/**
 * The gate. `ENTERTAINMENT.md` § Gate handler: `0x20` waits for `daypart < 4`,
 * `day_tick > 0xf0` and a 1-in-6 roll; the other three states dispatch every
 * stride. Past daypart 3 an idle `0x20` visitor is parked for the day.
 *
 * Returns `'dispatch'`, `'hold'`, or a state byte to write directly.
 */
export function entertainmentGate(actor, clock, rng) {
  const state = actor.state & 0x3f;
  if (state === ENT_STATE.going) {
    // The RNG is drawn only when the cheaper conditions hold - the reference's
    // `&&` short-circuit, which keeps every later number in the run the same.
    if (clock.daypart <= 3 && clock.dayTick > GATE_TICK) return rng.chance(GATE_CHANCE) ? 'dispatch' : 'hold';
    return clock.daypart > 3 ? ENT_STATE.parked : 'hold';
  }
  if (state === ENT_STATE.shopping || state === ENT_STATE.home || state === ENT_STATE.dwelling) return 'dispatch';
  return 'hold';
}

const isOpen = (record, half) => (half === 'upper' ? record.upperOpen : record.lowerOpen);
const budgetKey = (half) => (half === 'upper' ? 'upperBudget' : 'lowerBudget');

/** *"`try_consume_entertainment_phase_budget`"*: false when the half's budget is spent. */
function consumeBudget(record, half) {
  const key = budgetKey(half);
  if (record[key] <= 0) return false;
  record[key] -= 1;
  return true;
}
const refundBudget = (record, half) => { record[budgetKey(half)] += 1; };

const standingOn = (actor, object) => actor.anchorFloor ?? object.floor;

function resolve(tower, actor, from, to, clock, ctx) {
  const result = ctx.resolveRoute(tower, actor, from, to, clock, {
    passengerRoute: true,
    emitDistanceFeedback: emitsDistanceFeedback(actor.family, actor.state),
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  return typeof result === 'object' && result !== null ? result : { code: result };
}

/** A walked leg lands the visitor on the segment's far landing; the next stride routes on. */
function noteLocalLeg(actor, result) {
  if (result.code === 1 && Number.isInteger(result.legDestination)) actor.anchorFloor = result.legDestination;
}

/**
 * Pick a place to spend money after the show, within {@link SPILLOVER_FLOORS} of
 * the theater: one venue, uniformly, from every open shop, restaurant and fast
 * food in range. `null` when there is none - never `-1`, which is B1 here.
 *
 * TODO(parity): the reference buckets by 15-floor zone (`select_random_commercial_
 * venue_record_for_floor`) after an `rng % 3` choice of family. The original
 * game's help file says five floors, and says nothing of zones; five floors wins,
 * and the family is not drawn separately. `spec/DEVIATIONS.md` A43.
 */
export function spilloverVenue(tower, fromFloor) {
  const candidates = [];
  for (const object of tower.objects.values()) {
    if (!COMMERCIAL_FAMILIES.has(object.family)) continue;
    const record = venueOf(object);
    if (!record || record.availability === VENUE.closed || record.availability === VENUE.dormant) continue;
    if (Math.abs(object.floor - fromFloor) > SPILLOVER_FLOORS) continue;
    candidates.push(object);
  }
  if (candidates.length === 0) return null;
  return candidates[tower.rng.int(candidates.length)];
}

// ------------------------------------------------------------- dispatch

/**
 * The dispatch handler, one stride of one visitor.
 *
 * `ctx` is the same two seams every family takes:
 *   `resolveRoute(tower, actor, from, to, clock, options)`
 *   `onDelay(delay, actor)`
 */
export function entertainmentDispatch(tower, actor, object, record, clock, ctx) {
  switch (actor.state & 0x3f) {
    case ENT_STATE.going: return dispatchGoing(tower, actor, object, record, clock, ctx);
    case ENT_STATE.shopping: return dispatchShopping(tower, actor, object, clock, ctx);
    case ENT_STATE.dwelling: return dispatchDwelling(tower, actor, object, clock, ctx);
    case ENT_STATE.home: return dispatchHome(tower, actor, object, clock, ctx);
    default: return { moved: false };
  }
}

/**
 * `0x20` / `0x60` - **to the show.** Spend a unit of the half's budget (a spent
 * budget leaves the visitor idle), route from the lobby to the half's floor. A
 * failed first route gives the unit back and tries again; a failed retry parks.
 */
function dispatchGoing(tower, actor, object, record, clock, ctx) {
  const half = halfOf(object);
  const continuing = isInTransit(actor.state);
  if (!continuing) {
    if (!isOpen(record, half)) { actor.state = ENT_STATE.parked; return { moved: false }; }
    if (!consumeBudget(record, half)) return { moved: false };
    // The visitor starts downstairs, not where its record is anchored.
    actor.anchorFloor = LOBBY_FLOOR;
  }

  const result = resolve(tower, actor, standingOn(actor, object), object.floor, clock, ctx);
  const code = result.code;

  if (code === -1) {
    if (!continuing) {
      refundBudget(record, half);
      actor.state = ENT_STATE.going;
      actor.routeCarrier = null;
      return { moved: false, code };
    }
    actor.state = ENT_STATE.parked;
    return { moved: false, code };
  }
  noteLocalLeg(actor, result);
  if (code === 3) return arriveAtShow(actor, object, record);
  actor.state = ENT_STATE.going | 0x40;
  return { moved: true, code };
}

/**
 * On the half's floor. `increment_entertainment_link_runtime_counters`: one more
 * present, one more in the day's attendance, and the first arrival promotes the
 * phase 1 -> 2. A visitor who gets there after the half has been closed is not
 * counted - the show is over - and goes home.
 */
function arriveAtShow(actor, object, record) {
  actor.anchorFloor = object.floor;
  if (!isOpen(record, halfOf(object))) {
    actor.state = ENT_STATE.home;
    return { moved: true, code: 3, counted: false };
  }
  record.active += 1;
  record.attendance += 1;
  if (record.phase === PHASE.activated) record.phase = PHASE.attending;
  actor.state = ENT_STATE.watching;
  return { moved: true, code: 3, counted: true };
}

/**
 * `0x01` / `0x41` - **to the shops.** The upper show's audience, dismissed at
 * 1500. Picks a venue within five floors; nothing in range, or a route that
 * fails, sends the visitor home instead.
 */
function dispatchShopping(tower, actor, object, clock, ctx) {
  const continuing = isInTransit(actor.state);
  if (!continuing) {
    const shop = spilloverVenue(tower, standingOn(actor, object));
    actor.venueObjectId = shop ? shop.id : null;
    actor.errandFloor = shop ? shop.floor : null;
    if (!shop) { actor.state = ENT_STATE.home; return { moved: false }; }
  }

  const result = resolve(tower, actor, standingOn(actor, object), actor.errandFloor ?? LOBBY_FLOOR, clock, ctx);
  const code = result.code;
  if (code === -1) {
    actor.venueObjectId = null;
    actor.errandFloor = null;
    actor.state = ENT_STATE.home;
    return { moved: false, code };
  }
  noteLocalLeg(actor, result);
  if (code === 3) return arriveAtShop(tower, actor, clock, ctx);
  actor.state = ENT_STATE.shopping | 0x40;
  return { moved: true, code };
}

/** In the shop's floor: take a slot (a full venue is a wait, not a failure), or write it off. */
function arriveAtShop(tower, actor, clock, ctx) {
  actor.anchorFloor = actor.errandFloor ?? LOBBY_FLOOR;
  const shop = actor.venueObjectId == null ? null : tower.objects.get(actor.venueObjectId) ?? null;
  if (!shop) {
    actor.venueObjectId = null;
    actor.state = ENT_STATE.home;
    return { moved: true, code: 3, claimed: false };
  }
  const outcome = acquireVenueSlot(venueOf(shop), actor, clock, shop.family);
  if (outcome === SLOT.full) {
    actor.state = ENT_STATE.shopping | 0x40;
    return { moved: false, code: 3, claimed: false };
  }
  if (outcome === SLOT.unavailable) {
    ctx.onDelay?.({ kind: 'invalid-venue' }, actor);
    actor.venueObjectId = null;
  }
  actor.state = ENT_STATE.dwelling;
  return { moved: true, code: 3, claimed: outcome === SLOT.acquired };
}

/**
 * `0x22` / `0x62` - **leaving the shop.** The slot is released once the venue's
 * minimum stay (60 ticks) has elapsed, then the visitor routes to the lobby.
 */
function dispatchDwelling(tower, actor, object, clock, ctx) {
  const continuing = isInTransit(actor.state);
  if (!continuing) {
    if (actor.venueEnteredTick != null) {
      const shop = tower.objects.get(actor.venueObjectId);
      if (shop && !minimumStayElapsed(actor, clock)) return { moved: false };
      releaseVenueSlot(venueOf(shop), actor, clock, { skipDwellGate: true });
    }
    actor.venueObjectId = null;
  }
  return goToLobby(tower, actor, object, clock, ctx, ENT_STATE.dwelling);
}

/** `0x05` / `0x45` - **home.** From wherever the visitor stands to the lobby. */
function dispatchHome(tower, actor, object, clock, ctx) {
  return goToLobby(tower, actor, object, clock, ctx, ENT_STATE.home);
}

function goToLobby(tower, actor, object, clock, ctx, stage) {
  const result = resolve(tower, actor, standingOn(actor, object), LOBBY_FLOOR, clock, ctx);
  const code = result.code;
  if (code === -1 || code === 3) {
    actor.state = ENT_STATE.parked;
    actor.anchorFloor = code === 3 ? LOBBY_FLOOR : actor.anchorFloor;
    actor.venueEnteredTick = null;
    return { moved: code === 3, code };
  }
  noteLocalLeg(actor, result);
  actor.state = stage | 0x40;
  return { moved: true, code };
}

/**
 * The handler the scheduler calls, once per serviced visitor. The in-transit
 * split is every other family's: a visitor holding a **carrier** token is
 * standing in a queue and must be left alone, or each re-resolution throws away
 * the wait it is accruing.
 */
export function entertainmentFamilyHandler(ctx) {
  return function serviceVisitor(tower, actor) {
    const object = tower.objects.get(actor.objectId);
    if (!object || !ENTERTAINMENT_FAMILIES.has(object.family)) return;
    const record = recordOf(tower, object);
    if (!record) return;

    if (actor.state >= 0x40) {
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      return void entertainmentDispatch(tower, actor, object, record, tower.clock, ctx);
    }
    const verdict = entertainmentGate(actor, tower.clock, tower.rng);
    if (verdict === 'hold') return;
    if (verdict === 'dispatch') return void entertainmentDispatch(tower, actor, object, record, tower.clock, ctx);
    actor.state = verdict;
  };
}

/**
 * A visitor got off a lift. The state keeps its in-transit bit - the next
 * stride re-resolves from the floor it now stands on and the same-floor answer
 * is the arrival, written once, in the dispatch above.
 */
export function entertainmentArrival(actor, floor) {
  actor.anchorFloor = floor;
  actor.routeCarrier = null;
}

// ----------------------------------------------------------- the checkpoints

export const ENTERTAINMENT_REBUILD_TICK = 240;
export const UPPER_ACTIVATION_TICK = 1000;
export const MIDDAY_TICK = 1200;
export const LOWER_ACTIVATION_TICK = 1400;
export const UPPER_ADVANCE_TICK = 1500;
export const PARTY_ADVANCE_TICK = 1600;
export const LOWER_ADVANCE_TICK = 1900;
export const NIGHT_RESET_TICK = 2500;

/** A visitor table by id, built once per pass (the actor list is linear). */
const actorTable = (tower) => new Map(tower.actors.map((a) => [a.id, a]));

function visitorsOf(table, object) {
  return (object?.occupants ?? []).map((id) => table.get(id)).filter(Boolean);
}

function clearTrip(actor) {
  actor.route = null;
  actor.routeCarrier = null;
  actor.waitingFloor = null;
  actor.venueObjectId = null;
  actor.errandFloor = null;
  actor.venueEnteredTick = null;
}

/**
 * **Checkpoint 240** - `rebuild_entertainment_family_ledger`. Reseed both
 * budgets (a theater's from the film and its age, a party hall's to 0 / 50),
 * age the venue, clear the day's counters.
 *
 * Returns the population each family puts on the ledger, as the reference's
 * implementation does: the sum of the budgets seeded. The caller owns the
 * ledger. `spec/DEVIATIONS.md` A45.
 *
 * @returns {{[family:number]: number}}
 */
export function rebuildEntertainment(tower) {
  const population = { [FAMILY.theater]: 0, [FAMILY.partyHall]: 0 };
  for (const { object, record } of entertainmentVenues(tower)) {
    if (record.variant === 'theater') {
      const budget = theaterBudget(record.selector, record.age);
      record.upperBudget = budget;
      record.lowerBudget = budget;
    } else {
      record.upperBudget = 0;
      record.lowerBudget = PARTY_HALL_BUDGET;
    }
    record.populationShare = record.upperBudget + record.lowerBudget;
    population[object.family] += record.populationShare;
    record.age = Math.min(AGE_CAP, record.age + 1);
    record.active = 0;
    record.attendance = 0;
    record.upperOpen = false;
    record.lowerOpen = false;
  }
  return population;
}

/** Open a half to its audience: its visitors become `0x20`, and the phase leaves idle. */
function activateHalf(tower, table, record, half) {
  const { upper, lower } = halvesOf(tower, record);
  for (const actor of visitorsOf(table, half === 'upper' ? upper : lower)) {
    actor.state = ENT_STATE.going;
    clearTrip(actor);
  }
  if (half === 'upper') record.upperOpen = true; else record.lowerOpen = true;
  if (record.phase === PHASE.idle) record.phase = PHASE.activated;
}

/** **Checkpoint 1000** - the theater's upper half opens. Phase must be idle. */
export function activateUpperHalves(tower) {
  const table = actorTable(tower);
  let opened = 0;
  for (const { record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase !== PHASE.idle) continue;
    activateHalf(tower, table, record, 'upper');
    opened++;
  }
  return opened;
}

/**
 * **Checkpoint 1200** - the theaters whose show has drawn somebody are promoted
 * to ready, and the party hall is activated (its lower half; the upper is never
 * activated). The hall holds its party only if the tower has hotel rooms enough
 * - {@link partyHallHasGuests}.
 */
export function middayEntertainment(tower) {
  const table = actorTable(tower);
  let hosted = 0;
  for (const { record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase >= PHASE.attending) record.phase = PHASE.ready;
  }
  const hasGuests = partyHallHasGuests(tower);
  for (const { record } of entertainmentVenues(tower, FAMILY.partyHall)) {
    if (record.phase !== PHASE.idle || !hasGuests) continue;
    activateHalf(tower, table, record, 'lower');
    hosted++;
  }
  return hosted;
}

/**
 * **Checkpoint 1400** - the theater's lower half opens.
 *
 * TODO(parity): `TIME.md` § 1400 and `ENTERTAINMENT.md` both gate this on
 * `link_phase_state == 1`, but § 1200 has by then promoted any theater whose
 * upper half drew an audience to 3 - so read literally, the lower half would run
 * only for a theater that nobody came to, and no theater could reach the $15,000
 * tier (it needs both halves' 60). Opened for every theater that was activated
 * today (`phase >= 1`). `spec/DEVIATIONS.md` A46.
 */
export function activateLowerHalves(tower) {
  const table = actorTable(tower);
  let opened = 0;
  for (const { record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase === PHASE.idle) continue;
    activateHalf(tower, table, record, 'lower');
    opened++;
  }
  return opened;
}

/**
 * End a half: close it to arrivals, send everyone watching away, park whoever
 * never came. A visitor in state `0x03` goes to the shops (`0x01`) when it is a
 * theater and still before daypart 4, and straight home (`0x05`) otherwise.
 *
 * @returns {number} how many were released
 */
function advanceHalf(tower, table, record, half, object) {
  const toShops = record.variant === 'theater' && tower.clock.daypart < 4;
  let released = 0;
  for (const actor of visitorsOf(table, object)) {
    const base = actor.state & 0x3f;
    if (actor.state === ENT_STATE.watching) {
      actor.state = toShops ? ENT_STATE.shopping : ENT_STATE.home;
      record.active = Math.max(0, record.active - 1);
      released++;
    } else if (base === ENT_STATE.going && !isInTransit(actor.state)) {
      actor.state = ENT_STATE.parked;                // activated, never came
    }
  }
  if (half === 'upper') record.upperOpen = false; else record.lowerOpen = false;
  return released;
}

/** **Checkpoint 1500** - the theater's upper show ends; its audience goes shopping. */
export function advanceUpperHalves(tower) {
  const table = actorTable(tower);
  for (const { record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase < PHASE.activated) continue;
    advanceHalf(tower, table, record, 'upper', halvesOf(tower, record).upper);
    record.phase = record.active === 0 ? PHASE.activated : PHASE.attending;
  }
}

/**
 * The venue's day is over: pay it (unless the day forbids it), remember what it
 * drew for the sign, and go idle. The reset happens either way, as the
 * reference's does.
 */
function settle(tower, object, record, hooks) {
  const wasActivated = record.phase >= PHASE.activated;
  record.phase = PHASE.idle;
  record.lastAttendance = record.attendance;
  record.lastPayout = 0;
  if (!wasActivated || !entertainmentPaysToday(tower)) return 0;
  const dollars = payoutFor(record);
  if (dollars > 0) {
    record.lastPayout = dollars;
    hooks.onIncome?.(object, ENTERTAINMENT_KINDS[record.variant].incomeBucket, dollars);
  }
  return dollars;
}

/**
 * **Checkpoint 1600** - the party hall ends and is paid; the theaters still
 * running are promoted to ready. (`TIME.md` § 1600 step 7 would also end and pay
 * the theaters here; `ENTERTAINMENT.md`'s own table pays them at 1900. The two
 * disagree - `spec/DEVIATIONS.md` A46 - and the facility file is followed.)
 *
 * @returns {number} dollars paid
 */
export function advancePartyHalls(tower, hooks = {}) {
  const table = actorTable(tower);
  let paid = 0;
  for (const { object, record } of entertainmentVenues(tower, FAMILY.partyHall)) {
    if (record.phase >= PHASE.activated) advanceHalf(tower, table, record, 'lower', halvesOf(tower, record).lower);
    paid += settle(tower, object, record, hooks);
  }
  for (const { record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase >= PHASE.attending) record.phase = PHASE.ready;
  }
  return paid;
}

/** **Checkpoint 1900** - the theater's lower show ends, and the theater is paid on the whole day. */
export function advanceLowerHalves(tower, hooks = {}) {
  const table = actorTable(tower);
  let paid = 0;
  for (const { object, record } of entertainmentVenues(tower, FAMILY.theater)) {
    if (record.phase >= PHASE.activated) advanceHalf(tower, table, record, 'lower', halvesOf(tower, record).lower);
    paid += settle(tower, object, record, hooks);
  }
  return paid;
}

/**
 * **Checkpoint 2500** - `TIME.md` § 2500: entertainment sims go to `0x27` with
 * their auxiliary fields cleared. Anyone still out is home, and the venue is
 * closed to arrivals until tomorrow's activation.
 */
export function entertainmentNightReset(tower) {
  const table = actorTable(tower);
  for (const { record } of entertainmentVenues(tower)) {
    for (const object of Object.values(halvesOf(tower, record))) {
      for (const actor of visitorsOf(table, object)) {
        actor.state = ENT_STATE.parked;
        clearTrip(actor);
      }
    }
    record.upperOpen = false;
    record.lowerOpen = false;
    record.active = 0;
    record.phase = PHASE.idle;
  }
}

// --------------------------------------------------------------- the sign

/** Money, for a sign: `$15k`. */
const money = (n) => '$' + Math.round(n / 1000) + 'k';

/**
 * What the sign over a venue says, or `null`. A theater reads attendance and
 * what that would pay if the day ended now; a party hall reads who has come.
 * Derived from the same payout functions the checkpoints pay from.
 */
export function entertainmentSignal(object, tower) {
  const record = object?.venue?.kind === 'entertainment_venue' ? object.venue : null;
  if (!record) return null;
  const live = record.phase >= PHASE.activated;
  const attendance = live ? record.attendance : record.lastAttendance;
  const pays = live ? payoutFor(record) : record.lastPayout;
  if (record.variant === 'theater') {
    return { text: attendance + ' · ' + money(pays), tone: pays > 0 ? 'good' : 'warn' };
  }
  if (!live && attendance === 0) return { text: tower && !partyHallHasGuests(tower) ? 'NO ROOMS' : 'party 1pm', tone: 'warn' };
  return { text: attendance + ' · ' + money(pays), tone: pays > 0 ? 'good' : 'warn' };
}

