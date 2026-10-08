/**
 * Types `0x14` / `0x15` - **the recycling center.** The one facility the tower's
 * size obliges you to keep up with, and the gate that makes a big tower pay for it.
 *
 * Spec: `specs/facility/RECYCLING.md` (the whole file), `specs/TIME.md` § 32, § 1600
 * step 8, § 2000 step 2, § 2566 and § Recycling Center Adequacy Check, `specs/COMMANDS.md`
 * § Family-specific floor and stack rules (the overlap validator, *"matches manual:
 * 'They must be placed adjacent to one another to operate.'"*) and § Floor-class rules
 * (*"must be below grade"*), `specs/ECONOMY.md` ($500,000; $50,000 a pass),
 * `specs/GAME-STATE.md` § Star Advancement (*"recycling adequate"* gates `3 -> 4` and
 * `4 -> 5`), `SimTower-gameplay-analysis.md` (*"Large towers demand recycling;
 * recycling centers can fill up ('Recycling Centers are full!')"*, *"recycling centers
 * can't be bulldozed"*).
 *
 * ## What a center is
 *
 * A **two-floor stack**: type `0x14` on the upper floor and `0x15` on the lower, both
 * below grade, placed together (`placeRecycling`) and counted as ONE center
 * (*"`g_recycling_center_count` counts placed stacks, not individual floor halves"*).
 * Neither half can be bulldozed. The first center goes anywhere; every later one has to
 * stand next to an existing one (`recyclingObstruction`).
 *
 * ## What it is for
 *
 * Nothing happens in it. It is read by one number: **adequacy.**
 *
 *     required_tier = tier(total tower activity / centers)
 *
 * with `< 500 -> 1`, `< 1000 -> 2`, `< 1500 -> 3`, `< 2000 -> 4`, `< 2500 -> 5`, else
 * `6` - which is the issue's *"each center covers fewer than 2,500 population"*: a
 * tower is adequate at the end of the day when the activity per center is under
 * 2,500. The check runs three times a day (`specs/RECYCLING.md` § Scheduler):
 *
 *  - **1600** with tier `0`: *"a midday reset that always clears adequacy when a
 *    center exists"*;
 *  - **2000** with tier `2`: adequate only if the load is under 1,000 per center;
 *  - **2566** with tier `5`: adequate if it is under 2,500 per center - and when it
 *    is not, *"Recycling Centers are full!"*.
 *
 * The flag it writes, `gates.recyclingAdequate`, was read by `3 -> 4` and `4 -> 5`
 * from the day the ladder landed and written by nothing. It is written now, and only
 * once the tower has more than two stars (*"guarded by `star_count > 2`"*).
 *
 * ## The service elevator stop
 *
 * Issue #13: *"needs a service lift stop"*. Not in `specs/`; the garbage has to come
 * out. A center counts toward adequacy only if a **service elevator stops at one of
 * its two floors** (`recyclingServed`), and a tower whose centers none of them is
 * served says so (*"A Recycling Center needs a service elevator stop"*) rather than
 * the generic demand. `spec/DEVIATIONS.md` A53.
 */
import { FAMILY, OBJECT_TYPE, floorExists, placeObject, spanBlocked } from './state.js';
import { CARRIER_MODE, carrierStopsAtFloor } from './elevators.js';
import { clearDemand, raiseDemand } from './demands.js';
import { starGatesOf, towerActivity } from './progression.js';

/**
 * Tile span of one floor of the stack.
 *
 * TODO(parity): **not stated anywhere in `specs/`**; 25 is the reference
 * *implementation*'s `TILE_WIDTHS.recyclingCenterUpper` / `Lower`, taken unscaled -
 * the same source and choice as the security office (A47). `spec/DEVIATIONS.md` A53.
 */
export const RECYCLING_WIDTH = 25;

/** `RECYCLING.md` § Adequacy: the upper bound of tiers 1 to 5; anything over is tier 6. */
export const RECYCLING_TIER_LIMITS = [500, 1000, 1500, 2000, 2500];

/** The three daily checkpoints' tiers, `RECYCLING.md` § Scheduler. */
export const RECYCLING_CHECK = { midday: 0, afternoon: 2, final: 5 };

/** `TIME.md` § 32, § 1600, § 2000, § 2566. */
export const RECYCLING_RESET_TICK = 32;
export const RECYCLING_MIDDAY_TICK = 1600;
export const RECYCLING_AFTERNOON_TICK = 2000;
export const RECYCLING_FINAL_TICK = 2566;

/** `compute_recycling_required_tier`: activity per center, mapped. */
export function requiredTier(activity, centers) {
  if (centers <= 0) return Infinity;
  const per = Math.trunc(activity / centers);
  for (let i = 0; i < RECYCLING_TIER_LIMITS.length; i++) if (per < RECYCLING_TIER_LIMITS[i]) return i + 1;
  return RECYCLING_TIER_LIMITS.length + 1;
}

/** Every recycling center, as its **upper** half, in placement order. One per stack. */
export const recyclingCenters = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.recycling && o.type === OBJECT_TYPE.recyclingUpper);

/** Every placed half, upper and lower. */
const recyclingHalves = (tower) => [...tower.objects.values()].filter((o) => o.family === FAMILY.recycling);

/**
 * Why a center cannot stand here, or `null`. `floor` is the **lower** floor of the
 * two; the upper is `floor + 1`. The grade rule is `gradeReason`'s (both floors have
 * to be below ground). Here: the ground is free on both floors, and a center after
 * the first has to be next to one that is there.
 *
 * TODO(parity): `COMMANDS.md` and `RECYCLING.md` say *"overlap an existing live
 * `0x14`/`0x15` recycling-center object within the floor search band from
 * `anchor - 2` through `anchor + 1`"* without saying what overlaps what, or which
 * floor the anchor is. Read as: the anchor is the **upper** floor (`0x14` is the
 * upper half, and it makes the band symmetric - a stack directly below has its top at
 * `anchor - 2`, one directly above has its bottom at `anchor + 1`, and the two
 * floors between are the neighbours on the same rows); and an existing half in that
 * band whose columns overlap **or touch** the new span counts. The issue says
 * *"adjacent centers allowed"*. `spec/DEVIATIONS.md` A53.
 */
export function recyclingObstruction(tower, floor, left) {
  const right = left + RECYCLING_WIDTH - 1;
  if (!floorExists(floor + 1)) return 'a recycling center is two floors tall - there is no floor above that';
  if (spanBlocked(tower, floor, left, right) || spanBlocked(tower, floor + 1, left, right)) {
    return 'something is already built there';
  }
  const halves = recyclingHalves(tower);
  if (halves.length === 0) return null;                  // *"the first placed center is accepted"*
  const anchor = floor + 1;
  const adjacent = halves.some((h) =>
    h.floor >= anchor - 2 && h.floor <= anchor + 1 && h.left <= right + 1 && h.right >= left - 1);
  return adjacent ? null : 'recycling centers have to be placed next to one another';
}

/**
 * Build both floors of a center as one stack. The lower half first and the upper
 * second, as `placeEntertainment` does, and the upper carries the link.
 */
export function placeRecycling(tower, { floor, left }, makeTripFields = () => ({})) {
  const blocked = recyclingObstruction(tower, floor, left);
  if (blocked) return { ok: false, reason: blocked };
  const right = left + RECYCLING_WIDTH - 1;
  const lower = placeObject(tower, {
    family: FAMILY.recycling, type: OBJECT_TYPE.recyclingLower, floor, left, right, occupantCount: 0,
  }, makeTripFields);
  if (!lower.ok) return lower;
  const upper = placeObject(tower, {
    family: FAMILY.recycling, type: OBJECT_TYPE.recyclingUpper, floor: floor + 1, left, right, occupantCount: 0,
  }, makeTripFields);
  if (!upper.ok) {
    tower.objects.delete(lower.object.id);
    return upper;
  }
  lower.object.stayPhase = 0;
  upper.object.stayPhase = 0;
  upper.object.stackId = upper.object.id;
  lower.object.stackId = upper.object.id;
  return { ok: true, object: upper.object, objects: [lower.object, upper.object] };
}

/**
 * Does a service elevator stop at either floor of this center? Read live from the
 * carriers, so a lift extended to the basement (or a stop switched off in its
 * panel) changes the answer on the next check.
 */
export function recyclingServed(tower, center) {
  const floors = [center.floor - 1, center.floor];
  return (tower.carriers ?? []).some((carrier) =>
    carrier.mode === CARRIER_MODE.SERVICE && floors.some((f) => carrierStopsAtFloor(carrier, f)));
}

/** The centers that count: the ones a service elevator reaches. */
export const workingRecyclingCenters = (tower) =>
  recyclingCenters(tower).filter((c) => recyclingServed(tower, c));

/**
 * **`update_recycling_center_state(checkpoint_tier)`** - `RECYCLING.md` § Adequacy.
 *
 * Guarded by `star_count > 2`. With no working center it raises the demand, clears
 * the flag and sweeps nothing. Otherwise `required_tier` is computed from the
 * tower's activity and the number of working centers; a checkpoint tier below it
 * clamps the applied tier to the checkpoint and clears the flag (and at tier 5
 * raises *"Recycling Centers are full!"*), a tier at or above it sets the flag and
 * applies the requirement. The sweep writes the applied tier to every half's
 * `stayPhase`, leaving a half already at `5` alone on an inadequate pass.
 *
 * @returns {{ran:boolean, adequate?:boolean, required?:number, applied?:number, centers?:number}}
 */
export function updateRecyclingState(tower, checkpointTier) {
  if (tower.starCount <= 2) return { ran: false };
  const gates = starGatesOf(tower);
  const placed = recyclingCenters(tower);
  const working = placed.filter((c) => recyclingServed(tower, c));

  if (working.length === 0) {
    gates.recyclingAdequate = false;
    // Two different complaints, and a player can only fix one of them at a time.
    if (placed.length === 0) { raiseDemand(tower, 'recycling'); clearDemand(tower, 'recyclingLift'); }
    else { raiseDemand(tower, 'recyclingLift'); clearDemand(tower, 'recycling'); }
    return { ran: true, adequate: false, centers: 0 };
  }
  clearDemand(tower, 'recycling');
  clearDemand(tower, 'recyclingLift');

  const required = requiredTier(towerActivity(tower), working.length);
  const adequate = checkpointTier >= required;
  const applied = adequate ? required : checkpointTier;
  gates.recyclingAdequate = adequate;
  if (adequate) clearDemand(tower, 'recyclingFull');
  else if (checkpointTier === RECYCLING_CHECK.final) raiseDemand(tower, 'recyclingFull');

  for (const half of recyclingHalves(tower)) {
    if (!adequate && half.stayPhase === 5) continue;
    half.stayPhase = applied;
    half.dirty = true;
  }
  return { ran: true, adequate, required, applied, centers: working.length };
}

/** `TIME.md` § 32: the lower floor's `stay_phase` goes back from `6` to `0`. */
export function recyclingDailyReset(tower) {
  for (const half of recyclingHalves(tower)) {
    if (half.type === OBJECT_TYPE.recyclingLower && half.stayPhase === 6) {
      half.stayPhase = 0;
      half.dirty = true;
    }
  }
}
