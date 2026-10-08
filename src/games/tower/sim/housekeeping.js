/**
 * Family `0x0f` — **housekeeping.** The staff who turn a checked-out room back
 * into one a guest can sleep in, and the reason a hotel is a thing you manage
 * rather than a thing you build.
 *
 * Spec: `specs/facility/HOUSEKEEPING.md` in full (the state machine and the
 * search), `specs/facility/HOTEL.md` § Occupancy Flag and § Cockroach
 * Infestation (what a claim sets, what neglect costs), `specs/PEOPLE.md`
 * § Family `0x0f`, `specs/DEMAND.md` § Family 0x0f, `specs/ROUTING.md`
 * § Candidate Priority / § Housekeeping walkability / § `emit_distance_feedback`
 * Gating, `specs/ECONOMY.md` ($50,000, $10,000 a quarter, two stars).
 *
 * ## What a housekeeping facility is
 *
 * A placed object that owns **six staff**, created with it (`OCCUPANTS`), exactly
 * as an office owns its six workers. They are not population (`state.js`
 * `POPULATION_CONTRIBUTION`, `spec/DEVIATIONS.md` A33) and they have no stress
 * (`sim/stress.js`, `STAFF_NOTE`).
 *
 * ## What a housekeeper does
 *
 * Search, walk, clean, rest, search again (`HOUSEKEEPING.md` § State machine):
 *
 *   state 0  SEARCH     look for a dirty room; none → state 1, one → state 3
 *   state 1/4 HOME      walk back to the floor this housekeeper started on
 *   state 3  TARGET     walk to the room's floor; arrive → clean it → state 2
 *   state 2  REST       a 3-stride pause (4 visits: *"decrements ... from 3 to 0"*
 *                       and acts on the visit after it reaches 0), then state 0
 *
 * **Real routing, no teleporting.** Every leg goes through the same router the
 * tenants use, in *housekeeping mode* (`passengerRoute: false`): **stairs first,
 * then service elevators, and nothing else** — an escalator is rejected and a
 * passenger lift is not ridden (`ROUTING.md` § Candidate Priority; `sim/routing.js`
 * `selectBestRouteCandidate`). The stairs rule is stricter than it sounds: the
 * span must be continuous stairs and is checked over at most three floors
 * (`isSpanWalkableForServiceRoute`, *"a quirk of the original, kept"*), so a
 * housekeeper can walk up a short flight and nothing taller. Past that, the room
 * is reachable by service elevator or it is not reachable — which is what makes
 * *"housekeeping needs service elevators"* (the manual) true, and the third item
 * on a hotel's shopping list after the rooms and the lifts.
 *
 * **Who cleans which room.** Each of a facility's six staff is responsible for
 * one residue of the floor number modulo six — *"the vacant-room search is limited
 * to rentable units whose floor satisfies `floor % 6 == claimant_floor_class`;
 * this is a modulo remainder class, not `floor / 6`"*. A hotel tower is therefore
 * served floor by floor, and a floor's rooms are cleaned by exactly **one** of a
 * facility's staff. Capacity is bought a facility at a time: each one adds a
 * second, third, fourth pair of hands to every floor.
 *
 * ## When
 *
 * Only before tick 1500 (`HOUSEKEEPING.md` § state `3`: *"same-floor arrival
 * while `day_tick < 1500`"*). A room still dirty when the 1600 pass runs takes a
 * strike (`sim/hotel.js` `handleExtendedVacancyExpiry`), and three strikes make
 * it a cockroach nest. The staff and the strikes are the two halves of the same
 * rule: the workday is 1500 ticks long, and a housekeeper cleans one room in
 * about five of its sixteen-tick turns plus the walk.
 *
 * ## Ambiguities (all `spec/DEVIATIONS.md` A34)
 *
 *  - The search is gated on `day_tick < 1500` as well as the claim. The spec gates
 *    only the claim; the reference implementation gates both, and the staff would
 *    otherwise walk to a room every afternoon and be turned away at the door.
 *  - Floor numbers in `floor % 6` are the reference's EXE indices (`logical + 10`).
 *  - A cleaned room's guest actors are not touched. The reference sets the first
 *    guest to `3` at the claim and `0x24` at the end of the pause, which is its own
 *    guest-assignment machinery; this build's guests wait at the lobby and the
 *    1600 sweep re-latches the room (`spec/DEVIATIONS.md` A29).
 *  - Nothing stops two staff from the same class choosing the same room. The
 *    second is turned away at the door, loses its pause, and searches again. The
 *    reference does the same; it is why a second facility is worth less than twice
 *    the first.
 */
import {
  FAMILY, MAX_FLOOR, MIN_FLOOR, isHotelFamily,
} from './state.js';
import { cleanHotelRoom, isHotelRoomDirty } from './hotel.js';
import { shouldWaitForQueuedCarrier } from './routing.js';

/**
 * Tile span of the facility.
 *
 * TODO(parity): **not stated anywhere in `specs/`**; 15 is the reference
 * *implementation*'s `TILE_WIDTHS.housekeeping`, taken unscaled — the same
 * source and the same choice as the hotel rooms (A26), the condo and the fast
 * food. `spec/DEVIATIONS.md` A33.
 */
export const HOUSEKEEPING_WIDTH = 15;

/** Six staff per facility. `HOUSEKEEPING.md`; the manual's "6 staff". */
export const HOUSEKEEPING_STAFF = 6;

/** `HOUSEKEEPING.md` § state `3`: a claim only lands while `day_tick < 1500`. */
export const HK_CLAIM_CUTOFF = 1500;

/** `floor % 6`, `HOUSEKEEPING.md` § Additional recovered constraints. */
export const HK_FLOOR_CLASSES = 6;

/** The pause after a claim. `HOUSEKEEPING.md` § state `2`: *"from `3` down to `0`"*. */
export const HK_REST = 3;

/** Logical floor → the reference's EXE index. `CLAUDE.md`: `logical = exe - 10`. */
const EXE_FLOOR_OFFSET = 10;

/**
 * The staff state machine's codes, `PEOPLE.md` § Family `0x0f`. Low values that
 * do not overlap the `0x20` / `0x40` bands the other families use — the
 * reference's own quirk — so none of the in-transit helpers apply here.
 */
export const HK_STATE = {
  search: 0,
  home: 1,
  rest: 2,
  target: 3,
  homeTransit: 4,
};

/**
 * Which floors one member of staff looks after: `floor % 6` of the **EXE**
 * floor. The residue only decides *which* of the six takes a floor, so which
 * numbering is used changes who works where and nothing else
 * (`spec/DEVIATIONS.md` A34).
 */
export const floorClassOf = (floor) =>
  ((((floor + EXE_FLOOR_OFFSET) % HK_FLOOR_CLASSES) + HK_FLOOR_CLASSES) % HK_FLOOR_CLASSES);

/** The floor class a member of staff services: their slot in the facility, mod 6. */
export const staffClassOf = (actor) => actor.occupantIndex % HK_FLOOR_CLASSES;

/**
 * `find_matching_vacant_unit_floor` (1158:0000), `HOUSEKEEPING.md` § Additional
 * recovered constraints. Pure: it reads the tower and returns a room.
 *
 *  - only hotel rooms (families 3 / 4 / 5);
 *  - only floors whose class matches;
 *  - a room qualifies when its `unit_status` is `0x28` or `0x30`
 *    ({@link isHotelRoomDirty} reads the whole dirty band; an infested room is
 *    above it and never qualifies);
 *  - *"scans upward first to the top of the tower, then scans downward from the
 *    floor just below the spawn floor"*, starting at the recorded spawn floor;
 *  - within a floor, rooms in ascending slot order — the first wins.
 *
 * @param {number} spawnFloor the floor the search starts from
 * @param {number} floorClass the member of staff's `floor % 6` residue
 * @returns {object|null} the room, or `null`. (`-1` is B1 here, not "none".)
 */
export function findDirtyRoom(tower, spawnFloor, floorClass) {
  let best = null;
  let bestKey = null;
  for (const room of tower.objects.values()) {
    if (!isHotelFamily(room.family) || !isHotelRoomDirty(room)) continue;
    if (floorClassOf(room.floor) !== floorClass) continue;
    if (room.floor < MIN_FLOOR || room.floor > MAX_FLOOR) continue;
    // Rank: the upward scan first (nearest floor up first), then the downward
    // one (nearest floor down first), and the leftmost room on a floor.
    const upward = room.floor >= spawnFloor;
    const key = [upward ? 0 : 1, upward ? room.floor : -room.floor, room.left];
    if (bestKey === null || compareKeys(key, bestKey) < 0) { best = room; bestKey = key; }
  }
  return best;
}

const compareKeys = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Every member of staff of every housekeeping facility, with their facility. */
export function housekeepers(tower) {
  return tower.actors.filter((a) => a && a.family === FAMILY.housekeeping);
}

/** Back to looking for work. The searching sentinel is `null`, never `-1` (B1). */
function resetToSearch(actor) {
  actor.state = HK_STATE.search;
  actor.targetRoomId = null;
  actor.targetFloor = null;
  actor.postClaimCountdown = 0;
}

/**
 * Ask the router for one leg, in **housekeeping mode**: `is_passenger_route = 0`
 * and `emit_distance_feedback = 0` (`ROUTING.md` § `emit_distance_feedback`
 * Gating), so nothing here ever touches a stress counter. A walked leg
 * (`1`) lands the staff member on the far landing; the next stride routes the
 * next leg from there.
 *
 * @returns {number} the route result code: `3` same floor, `2` queued, `1`
 *   walking, `0` queue full, `-1` no route
 */
function routeTo(tower, actor, floor, ctx) {
  const result = ctx.resolveRoute(tower, actor, actor.anchorFloor, floor, tower.clock, {
    passengerRoute: false,
    emitDistanceFeedback: false,
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  const code = typeof result === 'object' && result !== null ? result.code : result;
  if (code === 1 && Number.isInteger(result?.legDestination)) actor.anchorFloor = result.legDestination;
  return code;
}

/**
 * State `3`: walk to the room's floor, and on arrival clean it.
 *
 * `HOUSEKEEPING.md`: *"queued or en-route results stay in `3`; same-floor arrival
 * while `day_tick < 1500` activates the selected vacant unit, moves to `2`, and
 * writes a 3-tick pending countdown; same-floor arrival outside the window, or
 * no-route failure, resets to `0`."*
 *
 * The room is remembered by id at search time, not looked up afresh on arrival —
 * the reference stashes the column for the same reason: a fresh scan lets a
 * member of staff steal a room another is already walking to. If the room has
 * been cleaned by then {@link cleanHotelRoom} returns false and the visit is
 * wasted, but the pause is still taken (*"the caller still transitions the helper
 * to state 2"*).
 */
function claimOrWalk(tower, actor, ctx) {
  const room = tower.objects.get(actor.targetRoomId);
  if (!room) return resetToSearch(actor);            // demolished on the way

  if (actor.anchorFloor !== actor.targetFloor) {
    if (routeTo(tower, actor, actor.targetFloor, ctx) === -1) resetToSearch(actor);
    return undefined;
  }
  if (tower.clock.dayTick >= HK_CLAIM_CUTOFF) return resetToSearch(actor);

  cleanHotelRoom(tower, room);
  actor.postClaimCountdown = HK_REST;
  actor.state = HK_STATE.rest;
  return undefined;
}

/**
 * One visit by the scheduler (every sixteenth tick) to one member of staff.
 * `specs/TIME.md` § Entity Refresh Stride.
 */
function step(tower, actor, ctx) {
  switch (actor.state) {
    case HK_STATE.search: {
      // *"records the current floor into `spawn_floor` on first entry"* — the
      // staff member's home, which it walks back to when there is no work.
      if (actor.spawnFloor === null || actor.spawnFloor === undefined) actor.spawnFloor = actor.anchorFloor;
      // TODO(parity): the spec gates only the claim on 1500; the reference
      // implementation gates the search too. `spec/DEVIATIONS.md` A34.
      if (tower.clock.dayTick >= HK_CLAIM_CUTOFF) return;

      const room = findDirtyRoom(tower, actor.spawnFloor, staffClassOf(actor));
      if (!room) {
        actor.targetRoomId = null;
        actor.targetFloor = null;
        actor.state = HK_STATE.home;
        return;
      }
      actor.targetRoomId = room.id;
      actor.targetFloor = room.floor;
      actor.state = HK_STATE.target;
      claimOrWalk(tower, actor, ctx);               // same stride: the search falls through
      return;
    }

    case HK_STATE.home:
    case HK_STATE.homeTransit: {
      // A staff member standing in a lift queue is left alone: re-asking the
      // router would re-queue them and restart the wait (`sim/routing.js`
      // `shouldWaitForQueuedCarrier`).
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return;
      if (actor.anchorFloor === actor.spawnFloor) {
        if (actor.targetRoomId === null || actor.targetRoomId === undefined) return resetToSearch(actor);
        actor.state = HK_STATE.target;
        return claimOrWalk(tower, actor, ctx);
      }
      const code = routeTo(tower, actor, actor.spawnFloor, ctx);
      if (code === -1) return resetToSearch(actor);
      if (code === 3) {
        actor.state = HK_STATE.target;
        return claimOrWalk(tower, actor, ctx);
      }
      if (code !== 0) actor.state = HK_STATE.homeTransit;
      return undefined;
    }

    case HK_STATE.target:
      if (shouldWaitForQueuedCarrier(actor, tower.clock)) return undefined;
      return claimOrWalk(tower, actor, ctx);

    case HK_STATE.rest:
      // *"if `last_trip_tick != 0` -> decrement, return. If 0 -> flag unavailable,
      // state 0."* Check first, so a countdown of 3 is four visits.
      if (actor.postClaimCountdown > 0) { actor.postClaimCountdown--; return undefined; }
      return resetToSearch(actor);

    default:
      // A freshly placed member of staff arrives in the band every other family
      // starts in (`0x20`). The reference's own default arm: reset and search.
      return resetToSearch(actor);
  }
}

/**
 * The handler the scheduler calls, once per serviced member of staff.
 *
 * `ctx` supplies the seams this module does not own:
 *   `resolveRoute(tower, actor, from, to, clock, options)` → routing
 *   `onDelay(delay, actor)`                                → the stress pipeline
 *                                                            (never called in
 *                                                            housekeeping mode)
 */
export function housekeepingFamilyHandler(ctx) {
  return function serviceHousekeeper(tower, actor) {
    const home = tower.objects.get(actor.objectId);
    if (!home || home.family !== FAMILY.housekeeping) return;
    step(tower, actor, ctx);
  };
}

/**
 * A member of staff got off a lift (or finished a walked leg): they are on that
 * floor now. Nothing else — the next visit routes the next leg, or cleans the
 * room if this is its floor. `HOUSEKEEPING.md`: *"queued or en-route results
 * stay in `3`"*, so there is no state to change on arrival.
 */
export function housekeepingArrival(tower, actor, floor) {
  actor.anchorFloor = floor;
  actor.routeCarrier = null;
}
