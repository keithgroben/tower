/**
 * Family `0x1f` - **the metro station.** Four stars, $1,000,000, $100,000 a pass,
 * underground only, one to a tower, never bulldozed, nothing built beneath it, and the
 * facility the `4 -> 5` star gate is waiting for.
 *
 * Spec: `specs/facility/METRO.md` (the whole file), `specs/COMMANDS.md` § Floor-class
 * rules (*"once the metro station exists, generic families cannot be placed below
 * `metro_floor - 1` or reject with `0x0e`"*), § Family-specific floor and stack rules
 * (*"metro station placement is a 3-floor stack and is accepted only on floors
 * `-8..-1`"*), § Command-dispatch limits (*"metro station is a singleton"*, error
 * `0x11`), `specs/ECONOMY.md` ($1,000,000; $100,000 a pass), `specs/GAME-STATE.md` § Star
 * Advancement, `specs/TIME.md` § Per-Tick hooks (the train), and the original's own help
 * file, which is the ONLY source for what the station is for:
 *
 * > *"Metro Stations can only be placed underground. Nothing goes beneath them and they
 * > cannot be removed. They bring in many customers and tenants, but these people will
 * > do all their shopping and eating only at outlets on the underground level. They
 * > will work and take up residence in your above-ground facilities. You are limited to
 * > one station per tower."*
 *
 * ## What the station is
 *
 * A **three-floor stack** of placed objects (`0x1f` on the top, anchor floor; `0x20`;
 * `0x21`), 30 tiles wide. `floor` in every command and in `metroObstruction` is the
 * stack's LOWEST floor - the same convention as the recycling center and the venues, so
 * the build ghost draws it upward from the floor you point at and `gradeReason` is the
 * one grade rule. The spec's `g_metro_station_floor_index` is the TOP floor, `floor + 2`
 * ({@link metroFloor}); everything the spec says about "the metro floor" means that one.
 *
 * ## What it does, and what it does not
 *
 * The binary-derived spec gives the station five effects, all implemented:
 *
 *  1. it gates `4 -> 5` (`gates.metroPlaced`, latched at placement by `notePlacement`);
 *  2. nothing may be built under it ({@link belowMetroReason}) - generic placements, new
 *     shafts, shaft extensions and links alike;
 *  3. it can be placed once ({@link metroObstruction}) and never removed
 *     (`sim/actions.js` `demolishRefusal`);
 *  4. it costs $100,000 a pass (`sim/economy.js` already prices type `0x1f`);
 *  5. now and then a train stands at the platform ({@link metroTrainTick}) - display only.
 *
 * It says **nothing** about commuters: `TIME.md` and `EVENTS.md` both stress that no
 * routing, economy or progression gate reads the station at all. The help file's
 * sentence above is the whole of the evidence, and {@link officeWorkerCommutes} /
 * {@link venueCustomerCommutes} are this build's reading of it, through the real router
 * - see `spec/DEVIATIONS.md` A63 for what is invented and the one constant that turns it
 * off.
 *
 * ## The commuters, in one paragraph
 *
 * A metro commuter is one of the tower's own people who **arrives at the station's
 * floor instead of the street lobby**. Office workers on one residue of the same
 * `(floor + slot) % 4` rule the drivers use start (and end) the commute at
 * {@link metroFloor}, and take their lunch **only** from an outlet underground; the
 * customers of an underground shop or restaurant (every other one of its 48) walk in
 * from the platform. All of it goes through `resolveRouteBetweenFloors` - there is no
 * teleport and no new actor - so a station no lift reaches brings nobody, and the
 * worker (or customer) whose route from the platform fails simply uses the lobby that
 * day, as a driver whose garage is cut off does. They are existing people, already
 * counted where they work, so **the station adds no population** of its own.
 */
import { FAMILY, GROUND_FLOOR, OBJECT_TYPE, floorExists, placeObject, spanBlocked } from './state.js';

/** `METRO.md` § Tool / Cursor: *"The `0x1f` slot is hardcoded to 30"*. */
export const METRO_WIDTH = 30;

/** Three floors: the top (anchor), the middle and the bottom. */
export const METRO_FLOORS = 3;

/** `METRO.md` § Placement: *"If `g_metro_station_floor_index >= 0` ... error `0x11`"*. */
export const MAX_METRO_STATIONS = 1;

/** The placed type of each floor, lowest first. `METRO.md` § Identity. */
export const METRO_TYPES = [OBJECT_TYPE.metroBottom, OBJECT_TYPE.metroMiddle, OBJECT_TYPE.metroTop];

/**
 * `METRO.md` § Display Variant Flag (`+0xc`): `0` an empty platform, `2` a train at it.
 * (The same word holds the placement-time status, `0` before daypart 4 and `1` from it;
 * that value is never read by anything and is not modelled - `spec/DEVIATIONS.md` A64.)
 */
export const PLATFORM = { empty: 0, train: 2 };

/** `METRO.md` § Per-Tick Special-Visitor Toggle: `sample_lcg15() % 100 == 0`. */
export const TRAIN_ODDS = 100;

// ------------------------------------------------------------- the stack

/** The three placed objects, lowest first, or `[]`. */
export const metroObjects = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.metro)
    .sort((a, b) => a.floor - b.floor);

/** Every station in the tower (a stack counts once). */
export const metroStations = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.metro && o.type === OBJECT_TYPE.metroTop);

/** Is there a station? */
export const hasMetro = (tower) => metroStations(tower).length > 0;

/**
 * `g_metro_station_floor_index`: the station's TOP floor, or `null` when there is none.
 * ⚠️ `null`, never `-1`: the reference's own sentinel is `-1`, and ours are logical
 * floors where `-1` is B1 (`CLAUDE.md`'s first entry). The spec's *"initialized to `-1`"*
 * is exactly the bug it warns of.
 */
export function metroFloor(tower) {
  const top = metroStations(tower)[0];
  return top ? top.floor : null;
}

/**
 * Where the trains stop and the commuters come up from. The spec does not say which of
 * the three floors holds the platform; it is the top, because that is the one floor
 * the lifts are *allowed* to reach (`extend_carrier_down` rejects below `metro_floor -
 * 1`, i.e. the middle floor is the deepest a shaft may go), and a platform nobody can
 * ride up from would bring nobody. `spec/DEVIATIONS.md` A63.
 */
export const metroPlatformFloor = (tower) => metroFloor(tower);

// ------------------------------------------------------------ the rules

/**
 * **Nothing goes beneath it.** `COMMANDS.md`: *"once the metro station exists, generic
 * families cannot be placed below `metro_floor - 1` or reject with `0x0e`"*; the string
 * table's own wording for that error is *"Cannot place items under Metro"*. `METRO.md`
 * § Placement Gates puts the same threshold on `extend_carrier_down`
 * (*"`target_floor < g_metro_station_floor_index - 1`"*).
 *
 * `floor` is the LOWEST floor the thing would stand on. Returns the sentence, or `null`.
 * The one definition: the seam, the ghost, the shaft clearance and the link rule all ask it.
 *
 * TODO(parity): read literally the threshold is `top - 1`, so the stack's own lowest
 * floor (`top - 2`) is refused and its middle floor (`top - 1`) is not - a free tile
 * beside the metro's middle floor. Followed as written (the shaft rule is the same
 * number); `spec/DEVIATIONS.md` A64.
 */
export function belowMetroReason(tower, floor) {
  const top = metroFloor(tower);
  if (top === null) return null;
  return floor < top - 1 ? 'nothing can be built under the metro station' : null;
}

/** The deepest floor a shaft may now reach, or `null` while there is no station. */
export function shaftFloorLimit(tower) {
  const top = metroFloor(tower);
  return top === null ? null : top - 1;
}

/**
 * Why a station cannot stand here, or `null`. `floor` is the stack's lowest floor.
 *
 *  - one to a tower (*"Only one Metro Station allowed"*, error `0x11`);
 *  - all three floors have to exist and be clear;
 *  - **on the bottom floor** - the original's string 14 is *"Place Metro station on
 *    bottom floor"*, an error `COMMANDS.md` does not list (its `0x0e`/`0x11` are
 *    the neighbours). With *"nothing goes beneath"* it can only mean one thing: the
 *    station may not be dropped above something already built lower down, since that
 *    thing would then be under it. Anything built, or any shaft sunk, below the
 *    station's `top - 1` refuses it. `spec/DEVIATIONS.md` A64.
 *
 * The grade rule (*"accepted only on floors `-8..-1`"*, anchor) is `gradeReason`'s -
 * `belowGrade`, three floors - and the floor range is `floorExists`.
 */
export function metroObstruction(tower, floor, left) {
  if (hasMetro(tower)) return 'a tower has only one metro station';
  const right = left + METRO_WIDTH - 1;
  for (let f = floor; f < floor + METRO_FLOORS; f++) {
    if (!floorExists(f)) return 'a metro station is three floors tall - there is no floor there';
  }
  for (let f = floor; f < floor + METRO_FLOORS; f++) {
    if (spanBlocked(tower, f, left, right)) return 'something is already built there';
  }
  const top = floor + METRO_FLOORS - 1;
  const below = (tower.carriers ?? []).some((c) => c.bottomFloor < top - 1)
    || [...tower.objects.values()].some((o) => o.floor < top - 1);
  return below ? 'place the metro station on the bottom floor - something is built below it' : null;
}

/**
 * Build the stack: bottom, middle, top, all empty platforms. The top is the anchor and
 * carries the stack id. Nothing here is charged; `sim/actions.js` charges first.
 */
export function placeMetro(tower, { floor, left }, makeTripFields = () => ({})) {
  const blocked = metroObstruction(tower, floor, left);
  if (blocked) return { ok: false, reason: blocked };
  const right = left + METRO_WIDTH - 1;
  const placed = [];
  for (let i = 0; i < METRO_FLOORS; i++) {
    const half = placeObject(tower, {
      family: FAMILY.metro, type: METRO_TYPES[i], floor: floor + i, left, right, occupantCount: 0,
    }, makeTripFields);
    if (!half.ok) {
      for (const done of placed) tower.objects.delete(done.id);
      return half;
    }
    half.object.platform = PLATFORM.empty;
    placed.push(half.object);
  }
  const top = placed[METRO_FLOORS - 1];
  for (const o of placed) o.stackId = top.id;
  return { ok: true, object: top, objects: placed };
}

// ------------------------------------------------------------- the train

/**
 * **`trigger_vip_special_visitor`** - `METRO.md` § Per-Tick Special-Visitor Toggle.
 *
 * The scheduler calls this from its `vip` slot, which already holds the spec's first two
 * guards (*"`day_tick > 0xf0`"*, *"`daypart_index < 4`"*). Here: a station exists, no fire
 * or bomb is on (*"`(g_game_state_flags & 9) == 0`"*), and a 1-in-100 roll. On a hit,
 * every floor of the stack flips between an empty platform and a train at it; the draw is
 * made only when a station stands, so a tower without one consumes exactly the random
 * numbers it did before.
 *
 * It is a display flag and nothing reads it (*"This event is cosmetic / display-state
 * only. It does not feed the star gate or route logic"*, `EVENTS.md`). The audio cue
 * (`0x271a`) is not played: this build has no sound.
 *
 * @returns {{flipped:boolean, arrived?:boolean}}
 */
export function metroTrainTick(tower) {
  if (!hasMetro(tower)) return { flipped: false };
  if (tower.events?.fireActive || tower.events?.bombActive) return { flipped: false };
  if (!tower.rng.chance(TRAIN_ODDS)) return { flipped: false };
  let arrived = false;
  for (const o of metroObjects(tower)) {
    if (o.platform === PLATFORM.empty) { o.platform = PLATFORM.train; arrived = true; }
    else o.platform = PLATFORM.empty;
    o.dirty = true;
  }
  return { flipped: true, arrived };
}

/** Is a train standing at the platform right now? Read by the renderer. */
export const trainAtPlatform = (object) => object?.platform === PLATFORM.train;

// ---------------------------------------------------------- the commuters

/**
 * Which office workers come by train. The drivers are `(floor + slot) % 4 == 1`
 * (`PARKING.md`, `sim/parking.js`); commuters take residue `3`, so one worker is never
 * both, and a quarter of a tower's workers arrive by metro once there is one.
 *
 * TODO(parity): **the share is ours** - the help file says "many" and nothing else.
 * `spec/DEVIATIONS.md` A63. Set `COMMUTER_MODULUS` to `0` to switch the commute off.
 */
export const COMMUTER_MODULUS = 4;
export const COMMUTER_RESIDUE = 3;

/**
 * Does this office worker arrive at the metro platform and eat only underground?
 * *"They will work ... in your above-ground facilities"*: the office has to be above the
 * ground floor. A pure function of the tower and the worker, so a worker is a commuter
 * every day or never, and the lunch choice and the commute agree.
 */
export function officeWorkerCommutes(tower, actor, office) {
  if (!COMMUTER_MODULUS) return false;
  if (!hasMetro(tower)) return false;
  if (office.floor <= GROUND_FLOOR) return false;
  return (office.floor + actor.occupantIndex) % COMMUTER_MODULUS === COMMUTER_RESIDUE;
}

/**
 * Does this customer of a venue walk in from the platform? Only underground outlets
 * (*"all their shopping and eating only at outlets on the underground level"*), and every
 * other one of the venue's 48 customers.
 *
 * TODO(parity): the half is ours (`spec/DEVIATIONS.md` A63).
 */
export const CUSTOMER_MODULUS = 2;
export function venueCustomerCommutes(tower, actor, venue) {
  if (!CUSTOMER_MODULUS) return false;
  if (!hasMetro(tower)) return false;
  if (venue.floor >= GROUND_FLOOR) return false;
  return actor.occupantIndex % CUSTOMER_MODULUS === 0;
}

/**
 * The floor a person's day starts and ends on: the platform for a commuter whose route
 * from it has not failed today, the street lobby for everybody else. `refusedToday` is
 * the actor's own `metroRefusedDay` against the day counter - a route from the platform
 * that the lifts cannot make is given up for the day and the lobby is used instead, as
 * a driver whose garage is cut off walks in (`sim/office.js`).
 */
export function gatewayFloor(tower, commutes, actor, dayCounter) {
  if (!commutes || actor.metroRefusedDay === dayCounter) return GROUND_FLOOR;
  return metroPlatformFloor(tower) ?? GROUND_FLOOR;
}
