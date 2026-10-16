/**
 * **The cathedral, and the wedding that crowns the tower.** Five stars, $3,000,000, one to a
 * tower, on the 100th floor and nowhere else, never bulldozed - and forty guests who ride the
 * real lifts up to it on a weekend morning. Get all forty there before tick 800 in a tower of
 * 15,000 and the tower is given the **Tower** rank: the end of the game.
 *
 * Spec: `specs/facility/EVALUATION.md` (the whole file), `specs/COMMANDS.md` § Floor-class
 * rules (*"evaluation/cathedral anchor placement must target floor `103` or reject with
 * `0x10`"*), § Family-specific floor and stack rules (*"cathedral placement is a 5-floor
 * stack"*), § Command-dispatch limits (*"cathedral is a singleton"*), `specs/DEMAND.md` §
 * Families `0x24`-`0x28` (the gate table), `specs/PEOPLE.md` § Families `0x24`-`0x28`,
 * `specs/TIME.md` § 0 step 6 and § 1200 step 4, `specs/ECONOMY.md` ($3,000,000), and the
 * original's own help file: *"You can only place a Cathedral on top of a 100-story building.
 * Placing this will take you to the Tower level ... Your Cathedral must be accessible.
 * Cathedrals cannot be bulldozed"*, and its strings *"Cathedral is available only on 100th
 * floor"* and *"Only one Cathedral allowed"*.
 *
 * ## The building
 *
 * A **five-floor stack** of placed objects, bottom to top `0x24`..`0x28`, 28 tiles wide, all
 * five carrying family `0x24` as the metro's three floors carry `0x1f`. `floor` in every
 * command and in {@link cathedralObstruction} is the stack's LOWEST floor - the same
 * convention as the metro and the recycling center, so the ghost draws it upward from the
 * floor you point at and `gradeReason` is the one floor rule. **That floor is 99**
 * ({@link CATHEDRAL_BASE_FLOOR}): the original numbers its ground floor 1, so the *"100th
 * floor"* is logical 99, which is also where the guests are sent (`EVALUATION.md`: *"routes
 * ... to raw floor `0x6d` (109)"*, and `logical = exe - 10`). The spec's *"anchor floor
 * 103"* is the stack's top slice. `spec/DEVIATIONS.md` A74.
 *
 * ## The guests
 *
 * Each slice owns eight, so forty in all, parked at placement (`0x27`) and woken to `0x20` at
 * tick 0 of every day (`TIME.md` § 0 step 6 - *"gated on `eval_entity_index >= 0`"*; the older
 * `star_count > 2` clause in `TIME.md`/`PEOPLE.md` is dropped by `EVALUATION.md`, which is the
 * binary-verified one, and is moot here because the cathedral needs five stars to exist).
 *
 * The gate (state `0x20`, `DEMAND.md` § Gate Table): **only on a weekend**; in daypart 0 a
 * guest has a 1 in 12 chance to set out once the tick is past 80, and sets out for certain
 * once it is past 240; from daypart 1 on a guest who has not gone has missed it and is parked
 * for the day. The route is the real one: lobby to floor 99 through the same router, the same
 * lifts and the same stress as everybody else, so **a cathedral the lifts cannot reach has no
 * wedding** - a route that fails parks the guest (`0x27`) for the day, as the table says.
 *
 * At noon (`TIME.md` § 1200 step 4) the guests who made it go home: `0x03 -> 0x05`, route
 * back to the lobby, `0x45` in transit, `0x27` parked on arrival.
 *
 * ## The award
 *
 * *"Arrival processing ... runs only when `g_day_tick < 800`"*: every arrival before tick 800
 * recounts the guests standing in state `0x03`, fresh (*"recounts the cathedral sweep fresh"*),
 * and that count is `gates.weddingGuestsArrived`, which `sim/progression.js` reads. The rank
 * itself is `tryAdvanceStar`'s (it already held the activity half - 15,000 - and the
 * weekend/morning window), the first tick after the fortieth arrival; see A61.
 */
import {
  FAMILY, OBJECT_TYPE, STATE_PARKED, baseState, enterTransit, floorExists, isInTransit, placeObject, spanBlocked,
} from './state.js';
import { CARRIER_MODE, cancelRequest, carrierStopsAtFloor } from './elevators.js';
import { starGatesOf, WEDDING_DEADLINE_TICK, WEDDING_GUESTS } from './progression.js';
import { shouldWaitForQueuedCarrier } from './routing.js';
import { countSameFloorArrival, noteLocalLeg, routeVisitor } from './visitors.js';

/** `EVALUATION.md` § Building: *"The recovered slice width is 28 tiles."* */
export const CATHEDRAL_WIDTH = 28;

/** Five slices. `COMMANDS.md`: *"cathedral placement is a 5-floor stack"*. */
export const CATHEDRAL_FLOORS = 5;

/**
 * The stack's lowest floor, and the only one it may stand on: the 100th floor by the original's
 * count (its ground floor is the first), logical 99 here. *"Cathedral is available only on
 * 100th floor"* (string 15 of the build-menu list); `EVALUATION.md` sends the guests to raw
 * floor `0x6d` = 109 = logical 99.
 */
export const CATHEDRAL_BASE_FLOOR = 99;

/** The stack's top floor (the spec's *"anchor"*, `COMMANDS.md`: floor `103`). */
export const CATHEDRAL_TOP_FLOOR = CATHEDRAL_BASE_FLOOR + CATHEDRAL_FLOORS - 1;

/** `COMMANDS.md` § Command-dispatch limits: *"cathedral is a singleton"*. */
export const MAX_CATHEDRALS = 1;

/** The placed type of each slice, lowest first. */
export const CATHEDRAL_TYPES = [
  OBJECT_TYPE.cathedralSlice1, OBJECT_TYPE.cathedralSlice2, OBJECT_TYPE.cathedralSlice3,
  OBJECT_TYPE.cathedralSlice4, OBJECT_TYPE.cathedralSlice5,
];

/**
 * A guest's state byte, `DEMAND.md` § Families `0x24`-`0x28`. `0x20` waits to set out, `0x60`
 * is the ride up (the in-transit flag on `0x20`), `0x03` has arrived, `0x05` is told to go
 * home, `0x45` is the ride down, `0x27` is parked.
 */
export const GUEST_STATE = {
  waiting: 0x20, outbound: 0x60, arrived: 0x03, leaving: 0x05, inbound: 0x45, parked: STATE_PARKED,
};

/** The gate's two thresholds, `DEMAND.md` § Gate Table: tick `> 80` rolls, tick `> 240` is certain. */
export const GATE_ROLL_FROM_TICK = 80;
export const GATE_CERTAIN_FROM_TICK = 240;
/** *"1 in 12"*: `rand() % 12 == 0`. */
export const GATE_ODDS = 12;

/** `TIME.md` § 1200: the guests who arrived are sent home at the hotel-sale checkpoint. */
export const MIDDAY_RETURN_TICK = 1200;

/**
 * The display byte on a slice, `EVALUATION.md` § Award Check: *"aux value `3`"* while guests
 * are arriving, `2` once the rank is awarded, `0` otherwise (cleared at the midday return).
 */
export const AUX = { idle: 0, crowned: 2, wedding: 3 };

// ------------------------------------------------------------- the stack

/** The five placed slices, lowest first, or `[]`. */
export const cathedralObjects = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.cathedral).sort((a, b) => a.floor - b.floor);

/** Does the tower have a cathedral? (The spec's `g_eval_entity_index >= 0`.) */
export const hasCathedral = (tower) => {
  for (const o of tower.objects.values()) if (o.family === FAMILY.cathedral) return true;
  return false;
};

/** The wedding guests, in table order. */
export const cathedralGuests = (tower) => tower.actors.filter((a) => a && a.family === FAMILY.cathedral);

/**
 * **The one floor.** Why a cathedral cannot stand on `floor`, or `null`: the shared grade rule
 * (`sim/actions.js` `gradeReason`), so the ghost and the seam word it once.
 */
export function cathedralFloorReason(floor) {
  return floor === CATHEDRAL_BASE_FLOOR
    ? null
    : 'a cathedral is available only on the 100th floor (floor ' + CATHEDRAL_BASE_FLOOR + ')';
}

/**
 * Why a cathedral cannot stand here, or `null`. `floor` is the stack's lowest. One to a tower
 * (*"Only one Cathedral allowed"*, `COMMANDS.md`: dispatch error), all five floors have to
 * exist, and every floor's span has to be clear.
 *
 * TODO(parity): `COMMANDS.md` also wants the floor beneath to carry a support span (*"No
 * support"*). This build asks that of nothing - a room may hang in the air - so the cathedral
 * is no stricter; the guests' route, which needs a lift to floor 99, is the real test of a
 * tower that reaches it. `spec/DEVIATIONS.md` A74.
 */
export function cathedralObstruction(tower, floor, left) {
  if (hasCathedral(tower)) return 'a tower has only one cathedral';
  const right = left + CATHEDRAL_WIDTH - 1;
  for (let f = floor; f < floor + CATHEDRAL_FLOORS; f++) {
    if (!floorExists(f)) return 'a cathedral is five floors tall - there is no floor there';
  }
  for (let f = floor; f < floor + CATHEDRAL_FLOORS; f++) {
    if (spanBlocked(tower, f, left, right)) return 'something is already built there';
  }
  return null;
}

/**
 * Build the stack, bottom to top, each slice with its eight parked guests. The top slice is
 * the anchor and carries the stack id. Nothing here is charged; `sim/actions.js` charges first.
 */
export function placeCathedral(tower, { floor, left }, makeTripFields = () => ({})) {
  const blocked = cathedralObstruction(tower, floor, left) ?? cathedralFloorReason(floor);
  if (blocked) return { ok: false, reason: blocked };
  const right = left + CATHEDRAL_WIDTH - 1;
  const placed = [];
  for (let i = 0; i < CATHEDRAL_FLOORS; i++) {
    const slice = placeObject(tower, {
      family: FAMILY.cathedral, type: CATHEDRAL_TYPES[i], floor: floor + i, left, right,
      occupantState: GUEST_STATE.parked,
    }, makeTripFields);
    if (!slice.ok) {
      for (const done of placed) {
        tower.objects.delete(done.id);
        tower.actors = tower.actors.filter((a) => !a || a.objectId !== done.id);
      }
      return slice;
    }
    slice.object.aux = AUX.idle;
    placed.push(slice.object);
  }
  const top = placed[CATHEDRAL_FLOORS - 1];
  for (const o of placed) o.stackId = top.id;
  return { ok: true, object: top, objects: placed };
}

/**
 * *"Your Cathedral must be accessible"* (help file): does a passenger lift stop at the
 * cathedral's floor? Read live from the carriers, so extending a shaft up to it changes the
 * answer on the next call. Without one, no guest can ride up and there is no wedding.
 */
export function cathedralServed(tower) {
  return (tower.carriers ?? []).some((carrier) =>
    carrier.mode !== CARRIER_MODE.SERVICE && carrierStopsAtFloor(carrier, CATHEDRAL_BASE_FLOOR));
}

// ------------------------------------------------------------ the day

/**
 * **Tick 0** - `TIME.md` § 0 step 6, `activate_cathedral_evaluation_entities`: every guest is
 * woken to `0x20`, whatever the day. A guest still queued for a lift (a wedding that ran late,
 * or a stranded one) forgets the queue first, so no lift carries a ghost.
 *
 * @returns {number} how many guests were woken
 */
export function activateWeddingGuests(tower) {
  if (!hasCathedral(tower)) return 0;
  let woken = 0;
  for (const guest of cathedralGuests(tower)) {
    for (const carrier of tower.carriers) cancelRequest(carrier, guest.id);
    guest.state = GUEST_STATE.waiting;
    guest.route = null;
    guest.waitingFloor = null;
    guest.routeCarrier = null;
    guest.anchorFloor = 0;
    woken++;
  }
  return woken;
}

/**
 * **Noon** - `TIME.md` § 1200 step 4, `dispatch_evaluation_sim_midday_return`: every slice's
 * display byte is cleared, and each guest standing in state `0x03` is told to go home (`0x05`).
 *
 * @returns {number} how many guests were sent home
 */
export function sendWeddingGuestsHome(tower) {
  if (!hasCathedral(tower)) return 0;
  // The reference clears every slice. The gilding the Tower rank gave (aux 2) is kept (A77): a rank that
  // lasted until lunch would be no finish.
  for (const o of cathedralObjects(tower)) { if (o.aux !== AUX.crowned) { o.aux = AUX.idle; o.dirty = true; } }
  let sent = 0;
  for (const guest of cathedralGuests(tower)) {
    if (guest.state !== GUEST_STATE.arrived) continue;
    guest.state = GUEST_STATE.leaving;
    sent++;
  }
  return sent;
}

// ----------------------------------------------------------- the guests

/** How many guests are standing in the cathedral right now: the spec's fresh recount. */
export const guestsAtTheCathedral = (tower) =>
  cathedralGuests(tower).filter((g) => g.state === GUEST_STATE.arrived).length;

/**
 * A guest has reached floor 99. `EVALUATION.md` § Award Check: *"Arrival processing ... runs
 * only when `g_eval_entity_index >= 0` and `g_day_tick < 800`"*, and recounts the sweep fresh.
 * The wedding is a **weekend** event (`README`: *"The wedding will only take place on the
 * weekend"*): the gate keeps the guests at home on a weekday, so a weekday arrival can only
 * be a stray one, and it is not a wedding - the count is written on a weekend only.
 *
 * Writes `gates.weddingGuestsArrived` - the count `sim/progression.js` reads - and stamps the
 * arrived guest's own slice (*"aux value `3`"*; the reference stamps one object, this build
 * lights each slice as its eight arrive).
 */
function guestHasArrived(tower, guest) {
  guest.state = GUEST_STATE.arrived;
  guest.anchorFloor = CATHEDRAL_BASE_FLOOR;
  guest.route = null;
  guest.waitingFloor = null;
  guest.routeCarrier = null;
  const { dayTick, calendarPhase } = tower.clock;
  if (dayTick >= WEDDING_DEADLINE_TICK || !calendarPhase) return;
  const slice = tower.objects.get(guest.objectId);
  if (slice && slice.aux !== AUX.crowned) { slice.aux = AUX.wedding; slice.dirty = true; }
  starGatesOf(tower).weddingGuestsArrived = Math.min(WEDDING_GUESTS, guestsAtTheCathedral(tower));
}

/**
 * The family-`0x24` gate and dispatch, called by the stride for every guest. `ctx` is
 * `{resolveRoute, onDelay}`, supplied by the composition (`ui/driver.js`) as every family's is.
 */
export function cathedralFamilyHandler(ctx) {
  function dispatchOutbound(tower, guest) {
    const fresh = !isInTransit(guest.state);
    if (fresh) guest.anchorFloor = 0;
    const result = routeVisitor(tower, guest, guest.anchorFloor ?? 0, CATHEDRAL_BASE_FLOOR, ctx, GUEST_STATE.waiting);
    // *"Results 0/1/2 set 0x60, result 3 sets 0x03 and runs arrival processing, and failure
    // sets 0x27."*
    if (result.code === -1) { guest.state = GUEST_STATE.parked; guest.routeCarrier = null; return; }
    noteLocalLeg(guest, result);
    if (result.code === 3) { countSameFloorArrival(guest, tower, result); guestHasArrived(tower, guest); return; }
    guest.state = enterTransit(GUEST_STATE.waiting);
  }

  function dispatchReturn(tower, guest) {
    const fresh = !isInTransit(guest.state);
    if (fresh) guest.anchorFloor = CATHEDRAL_BASE_FLOOR;
    const result = routeVisitor(tower, guest, guest.anchorFloor ?? CATHEDRAL_BASE_FLOOR, 0, ctx, GUEST_STATE.leaving);
    // *"Results 0/1/2 set 0x45; result 3 or failure parks to 0x27."*
    if (result.code === -1) { guest.state = GUEST_STATE.parked; guest.routeCarrier = null; return; }
    noteLocalLeg(guest, result);
    if (result.code === 3) { countSameFloorArrival(guest, tower, result); guestHome(guest); return; }
    guest.state = enterTransit(GUEST_STATE.leaving);
  }

  return function serviceGuest(tower, guest) {
    const { dayTick, daypart, calendarPhase } = tower.clock;
    switch (guest.state) {
      case GUEST_STATE.waiting: {
        // *"Requires `calendar_phase_flag == 1`"*: a weekday wedding is no wedding.
        if (!calendarPhase) return;
        if (daypart === 0) {
          // *"The tick > 80 random check AND the tick > 240 guaranteed check both run on the same
          // gate invocation."* One dispatch per pass: a guest the roll already sent is on his way.
          if (dayTick > GATE_ROLL_FROM_TICK && tower.rng.chance(GATE_ODDS)) dispatchOutbound(tower, guest);
          if (guest.state === GUEST_STATE.waiting && dayTick > GATE_CERTAIN_FROM_TICK) dispatchOutbound(tower, guest);
          return;
        }
        // Daypart 1 or later: the window is missed.
        guest.state = GUEST_STATE.parked;
        return;
      }
      case GUEST_STATE.outbound:
        // The route token splits the in-transit branch (`PEOPLE.md`): queued for a car, leave him be.
        if (shouldWaitForQueuedCarrier(guest, tower.clock)) return;
        dispatchOutbound(tower, guest);
        return;
      case GUEST_STATE.leaving:
        dispatchReturn(tower, guest);
        return;
      case GUEST_STATE.inbound:
        if (shouldWaitForQueuedCarrier(guest, tower.clock)) return;
        dispatchReturn(tower, guest);
        return;
      default:
        // 0x03 waits for noon; 0x27 waits for tomorrow.
    }
  };
}

/** A guest is back in the lobby: parked until the next day. */
function guestHome(guest) {
  guest.state = GUEST_STATE.parked;
  guest.anchorFloor = 0;
  guest.route = null;
  guest.waitingFloor = null;
  guest.routeCarrier = null;
}

/**
 * A lift (or a walked leg) set a guest down on `floor`. A stop that is not the leg's last (a
 * sky-lobby transfer) only moves him; the real ends are floor 99 and the lobby.
 */
export function cathedralArrival(tower, guest, floor) {
  guest.anchorFloor = floor;
  guest.routeCarrier = null;
  const state = baseState(guest.state);
  if (state === GUEST_STATE.waiting && floor === CATHEDRAL_BASE_FLOOR) guestHasArrived(tower, guest);
  else if (state === GUEST_STATE.leaving && floor === 0) guestHome(guest);
}
