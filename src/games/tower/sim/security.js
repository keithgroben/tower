/**
 * Family `0x0e` - **security.** The offices whose guards fight fires and search
 * for bombs, and the facility the tower's second rung of stars is waiting for.
 *
 * Spec: `specs/ECONOMY.md` ($100,000; $20,000 a pass), `specs/COMMANDS.md`
 * (*"security office is basement-only"*, *"security offices are capped at 10
 * active placements"*), `specs/GAME-STATE.md` § Star Advancement (*"`2 -> 3`: a
 * security office must have been placed"*), `specs/TIME.md` § 2500
 * (*"14/33 (0xe/0x21 - security/hotel guest): -> `0x01`"*), `specs/PEOPLE.md`
 * (*"Bomb and fire response use transient helper entities ... part of the
 * Security Office (`0x0e`) system"*), `specs/EVENTS.md`. The original's own help
 * file supplies the rest: *"They use the tower's emergency, outside stairs only,
 * not the elevators. Security offices cannot be removed once placed."* and
 * *"Their closeness to these events affects their ability to combat them."*
 *
 * ## What a security office is, in this build
 *
 * A placed object that owns **six guards**, created with it (`OCCUPANTS`) - the
 * same shape as housekeeping, and like housekeeping's staff they are not
 * population (`state.js` `POPULATION_CONTRIBUTION`) and have no stress
 * (`sim/stress.js`, `STAFF_NOTE`). It is built **in the basement**, costs
 * $100,000 and $20,000 a pass (`sim/economy.js` already prices both, keyed by
 * type `0x0e`, so the upkeep needs no wiring), unlocks at two stars, there can be
 * ten, and it **cannot be bulldozed** (`sim/actions.js` `demolishRefusal`, the
 * one definition housekeeping shares).
 *
 * It does exactly one thing for the player today, and it is the thing the whole
 * ladder was stalled on: its placement latches the `2 -> 3` star gate
 * (`sim/progression.js` `PLACEMENT_GATES`). The guards' work - the bomb search
 * and the fire response - is the event system (issue #16); this module gives it
 * what it will need and no more: who the guards are, how many offices there are,
 * and how long a guard takes to reach a floor by the only route they have.
 *
 * ## The guards never touch a lift
 *
 * The help file is explicit, twice: *"Security and housekeeping staff use other
 * methods of transportation"* (of the standard lift) and *"not service staff or
 * security"* (of the express). Housekeeping's other method is the stairs and the
 * service elevator, and the router models it (`passengerRoute: false`). Security's
 * is neither: it is the **emergency stairs along the outside of the building**,
 * which are not in the 64-slot special-link table (they are not a stairs link
 * the player placed, and cost no upkeep) and which the router has no mode for.
 *
 * So the guards are **deliberately not routed by `sim/routing.js`** at all.
 * {@link emergencyStairsRoute} is the whole of their movement, it reads the
 * floors the building stands on and nothing else, and a test hands it a tower
 * whose lifts, stairs and route tables throw if they are touched. Adding a
 * guard mode to the router would have put the one rule that matters - *no lifts* -
 * behind a flag that a later caller could forget to pass.
 * `spec/DEVIATIONS.md` A48.
 */
import { FAMILY, floorExists } from './state.js';

/**
 * Tile span of the office.
 *
 * TODO(parity): **not stated anywhere in `specs/`**; 16 is the reference
 * *implementation*'s `TILE_WIDTHS.security`, taken unscaled - the same source and
 * the same choice as housekeeping's 15, the hotel rooms (A26) and the condo.
 * `spec/DEVIATIONS.md` A47.
 */
export const SECURITY_WIDTH = 16;

/** Six guards per office. See `OCCUPANTS` in `state.js` (A47). */
export const SECURITY_GUARDS = 6;

/**
 * `specs/COMMANDS.md` § Command-dispatch limits: *"security offices are capped at
 * 10 active placements"*; the help file's limits table agrees (*"Security 10"*).
 */
export const MAX_SECURITY_OFFICES = 10;

/**
 * How many offices the `2 -> 3` gate asks for.
 *
 * TODO(parity): **the sources disagree.** `specs/GAME-STATE.md` § Star
 * Advancement says *"a security office must have been placed"* (one), and the
 * reference implementation sets its flag when any security office exists; the
 * original's help file says *"a population of 1,000 plus more than one Security
 * Office"* and its readme *"At least two security offices"* (two). The binary-
 * derived spec is followed - it is the rule the reference actually runs - and
 * the constant is here so that, if Keith rules for the manual, it is one number.
 * `spec/DEVIATIONS.md` A49.
 */
export const SECURITY_OFFICES_FOR_THREE_STARS = 1;

/**
 * A guard on duty, standing at the office. `specs/TIME.md` § 2500 resets every
 * family-`0x0e` sim to `0x01` each night, and nothing else in `specs/` gives the
 * state a name: a guard's patrol is the event system's (issue #16).
 */
export const GUARD_STATE = { onDuty: 0x01 };

/**
 * Ticks for a guard to climb one floor of the emergency stairs.
 *
 * TODO(parity): **not stated anywhere in `specs/`.** The one figure the
 * reference has for a guard on foot is `walk_delay = 1` (a tile a tick, DS:0xe640,
 * for the fire-rescue helper), and this build's own stairs footprint is 8 tiles
 * (`LINK_WIDTH`, `specs/COMMANDS.md` *"the requested 8-tile footprint"*), so a
 * flight of one floor is eight tiles at one a tick: 8. Pure tuning - it decides
 * only how soon a guard reaches an event, and nothing but issue #16 reads it.
 * `spec/DEVIATIONS.md` A48.
 */
export const EMERGENCY_STAIRS_TICKS_PER_FLOOR = 8;

/** Every security office standing in the tower, in placement order. */
export const securityOffices = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.security);

/** Every guard of every office. */
export const guards = (tower) =>
  tower.actors.filter((a) => a && a.family === FAMILY.security);

/**
 * Why one more office cannot be placed, or `null`. The cap is
 * `MAX_SECURITY_OFFICES`; the seam and the ghost both ask this, so the two
 * cannot word the refusal differently (`CLAUDE.md`: the build ghost and
 * `applyAction` must always agree).
 */
export function securityObstruction(tower) {
  return securityOffices(tower).length >= MAX_SECURITY_OFFICES
    ? 'a tower has at most ' + MAX_SECURITY_OFFICES + ' security offices'
    : null;
}

/**
 * The floors the emergency stairs run between: the lowest and highest floor
 * anything stands on. They are *"along the side of your building"* (help file),
 * so they follow the building and stop where it does. `null` for a bare lot.
 */
export function emergencyStairsExtent(tower) {
  let bottom = null, top = null;
  for (const o of tower.objects.values()) {
    if (bottom === null || o.floor < bottom) bottom = o.floor;
    if (top === null || o.floor > top) top = o.floor;
  }
  return bottom === null ? null : { bottom, top };
}

/**
 * **A guard's journey from one floor to another, by the outside stairs.** Pure.
 *
 * Reads the floors the building stands on and nothing else - not a lift, not a
 * stairs link, not the route tables (see the header) - so a tower with no lifts
 * answers exactly as a tower with twenty. A route exists when both ends are
 * floors of the building; its cost is one {@link EMERGENCY_STAIRS_TICKS_PER_FLOOR}
 * per floor climbed or descended.
 *
 * Returns `ridesCarriers: false` as a fact the caller can assert rather than a
 * comment it must trust.
 *
 * @returns {{ok:true, floors:number, ticks:number, ridesCarriers:false}
 *          |{ok:false, reason:string}}
 */
export function emergencyStairsRoute(tower, fromFloor, toFloor) {
  if (!floorExists(fromFloor) || !floorExists(toFloor)) {
    return { ok: false, reason: 'that floor is outside the tower' };
  }
  const extent = emergencyStairsExtent(tower);
  if (!extent || fromFloor < extent.bottom || fromFloor > extent.top
    || toFloor < extent.bottom || toFloor > extent.top) {
    return { ok: false, reason: 'the emergency stairs reach only the floors the building stands on' };
  }
  const floors = Math.abs(toFloor - fromFloor);
  return { ok: true, floors, ticks: floors * EMERGENCY_STAIRS_TICKS_PER_FLOOR, ridesCarriers: false };
}

/**
 * **How fast the tower's security can get to a floor** - *"their closeness to
 * these events affects their ability to combat them"* (help file). One entry per
 * office that can reach it, nearest first (ties by placement order, which is the
 * order {@link securityOffices} returns), and the count the bomb search turns on
 * (*"whether it's found depends on how many security offices you have"*).
 *
 * This is the hook for issue #16's bomb and fire; nothing in the game reads it
 * yet, and it is tested on its own.
 *
 * @returns {{count:number, reachable:number, nearestTicks:number|null,
 *   offices:{officeId:number, floor:number, floors:number, ticks:number}[]}}
 */
export function guardResponse(tower, floor) {
  const offices = [];
  const all = securityOffices(tower);
  for (const office of all) {
    const route = emergencyStairsRoute(tower, office.floor, floor);
    if (!route.ok) continue;
    offices.push({ officeId: office.id, floor: office.floor, floors: route.floors, ticks: route.ticks });
  }
  offices.sort((a, b) => a.ticks - b.ticks);        // stable: ties keep placement order
  return {
    count: all.length,
    reachable: offices.length,
    nearestTicks: offices.length ? offices[0].ticks : null,
    offices,
  };
}

/**
 * `specs/TIME.md` § 2500: *"14/33 (0xe/0x21 - security/hotel guest): -> `0x01`"*.
 * Every guard goes back on duty at its office each night, with no errand in
 * flight. Nothing moves a guard off `0x01` in this build, so today this changes
 * nothing; it is wired anyway because it is the checkpoint issue #16's patrol
 * will start from, and a patrol that is not reset at night is a guard stranded
 * on a burned floor for ever.
 */
export function securityNightReset(tower) {
  for (const guard of guards(tower)) {
    const office = tower.objects.get(guard.objectId);
    guard.state = GUARD_STATE.onDuty;
    guard.targetFloor = null;
    guard.waitingFloor = null;
    guard.route = null;
    if (office) guard.anchorFloor = office.floor;
  }
}
