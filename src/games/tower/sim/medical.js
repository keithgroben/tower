/**
 * Family `0x0d` - **the medical center.** A clinic the office workers visit, and
 * a gate on the third rung of the star ladder.
 *
 * Spec: `specs/facility/MEDICAL.md` (the whole file), `specs/ECONOMY.md` ($500,000;
 * no upkeep), `specs/COMMANDS.md` (*"medical centers"* are capped at ten:
 * `SimTower-gameplay-analysis.md` § Hard limits, *"10 medical centers"*),
 * `specs/GAME-STATE.md` § Star Advancement, `specs/TIME.md` § 0.
 *
 * ## What happens
 *
 * At the end of an office worker's day - the same transition that sends them home
 * through the lobby - a tower at **three stars or more** gives each worker a
 * **1-in-10** chance of a medical trip instead (`MEDICAL.md` § Demand Generation:
 * `star_count >= 3 && sample_lcg15() % 10 == 0`; the roll is `tower.rng.chance(10)`,
 * which is the same `rand() % 10 == 0`). The trip is real: the worker asks the
 * router for a route from the office to the clinic, rides the lifts, waits its turn,
 * and then goes home from the clinic's floor. `sim/office.js` has the state machine;
 * this module owns who a worker may pick, what a visit costs, and what failing means.
 *
 * *"Weighted toward the worker's zone"*: the pick is among the centers in the
 * worker's own fifteen-floor zone (`zoneBand`, the reference's
 * `(source_floor - 9) / 15`), and falls back to every center when the zone has none
 * (*"with a global fallback bucket if the zone's bucket is empty"*). That is the
 * whole of "it must be near them": a clinic in the right band is the one they go to.
 *
 * ## Failing is the point
 *
 * With no center to go to - or the chosen one demolished on the way - the worker
 * *"cannot find any target. Fire the 'Medical Center demanded near Lobby' banner,
 * clear the daily flag, abandon the trip"*. The **daily flag** is
 * `gates.medicalServiceOk` (`sim/progression.js`): latched true at each day start
 * once the tower has three stars, cleared by the first failed trip, and read by the
 * `3 -> 4` and `4 -> 5` gates. `spec/DEVIATIONS.md` A52 records that `GAME-STATE.md`
 * does not list it and `MEDICAL.md` does.
 *
 * ## A visit
 *
 * The clinic holds a queue of the workers who are there (`object.medical.queue`,
 * their ids - the *"pending-visitor count"* of the inspect panel). Each visit takes
 * `MEDICAL_VISIT_TICKS` and a center sees one worker at a time, so a worker arriving
 * at a busy clinic waits behind the others. *"If a worker has been waiting in a
 * medical queue for an extended period (the original game uses a fixed retry count
 * of `40`), the worker gives up waiting and proceeds as if served"* -
 * `MEDICAL_RETRY_LIMIT`, counted in the worker's own refreshes, so a clinic
 * swamped by demand lets the queue drain rather than locking the sim.
 * `spec/DEVIATIONS.md` A51 has the numbers the spec does not give.
 */
import { FAMILY, zoneBand } from './state.js';
import { clearDemand, raiseDemand } from './demands.js';
import { starGatesOf } from './progression.js';

/**
 * Tile span of the clinic.
 *
 * TODO(parity): **not stated anywhere in `specs/`**; 26 is the reference
 * *implementation*'s `TILE_WIDTHS.medical`, taken unscaled - the same source and
 * the same choice as the security office (A47), housekeeping and the hotel rooms.
 * `spec/DEVIATIONS.md` A51.
 */
export const MEDICAL_WIDTH = 26;

/** `MEDICAL.md` § Placement: *"Up to 10 concurrently-placed medical centers"*. */
export const MAX_MEDICAL_CENTERS = 10;

/** `MEDICAL.md` § Authoritative Parity: `sample_lcg15() % 10 == 0`. */
export const MEDICAL_ROLL = 10;

/** The star a worker's medical roll starts at. `MEDICAL.md`: *"`star_count >= 3`"*. */
export const MEDICAL_MIN_STARS = 3;

/** `MEDICAL.md` § Trip Resolution: *"a fixed retry count of `40`"* (`0x28`). */
export const MEDICAL_RETRY_LIMIT = 40;

/**
 * Ticks one visit takes. TODO(parity): the spec says the center "serves the worker
 * later in the day" and gives no duration; the lunch hold is 16 ticks and a venue's
 * minimum stay is 60 (`sim/office.js` A19), and a medical visit is "long-dwell,
 * low-traffic" (`MEDICAL.md` § High-Level Identity), so it sits between at 48 -
 * three of the worker's own refreshes. `spec/DEVIATIONS.md` A51.
 */
export const MEDICAL_VISIT_TICKS = 48;

/** A new clinic's own record: who is waiting, and when it is next free. */
export const createMedicalRecord = () => ({ queue: [], busyUntil: 0 });

/** Placement finalizer: every clinic carries its queue from birth. */
export function finalizeMedicalCenter(_tower, object) {
  object.medical = createMedicalRecord();
}

/** Every clinic standing in the tower, in placement order. */
export const medicalCenters = (tower) =>
  [...tower.objects.values()].filter((o) => o.family === FAMILY.medical);

/** `MEDICAL.md` § Placement. The seam and the ghost both ask this. */
export function medicalObstruction(tower) {
  return medicalCenters(tower).length >= MAX_MEDICAL_CENTERS
    ? 'a tower has at most ' + MAX_MEDICAL_CENTERS + ' medical centers'
    : null;
}

/** The clinic's record, tolerating one placed outside `applyAction` (a test, an old save). */
export const recordOf = (object) => (object.medical ??= createMedicalRecord());

/** How many workers are at this clinic right now - the inspect panel's figure. */
export const pendingVisitors = (object) => recordOf(object).queue.length;

/**
 * **Which clinic?** The centers in the worker's own zone if there are any, else all
 * of them; one drawn from the tower's own generator. `null` when there are none.
 */
export function pickMedicalCenter(tower, floor) {
  const all = medicalCenters(tower);
  if (all.length === 0) return null;
  const zone = zoneBand(floor);
  const near = all.filter((c) => zoneBand(c.floor) === zone);
  const pool = near.length > 0 ? near : all;
  return pool[tower.rng.int(pool.length)];
}

/** A failed trip: the banner fires and the day's flag clears (`MEDICAL.md` § Trip Resolution). */
export function medicalTripFailed(tower) {
  starGatesOf(tower).medicalServiceOk = false;
  raiseDemand(tower, 'medical');
}

/**
 * **The roll**, at the end of a worker's day. At most once a day per worker.
 *
 * @returns {null | {center: object} | {failed: true}} `null`: go home as usual;
 *   `{center}`: take the trip; `{failed}`: the roll came up and there was nowhere to
 *   go - the demand has been raised and the worker goes home as usual.
 */
export function rollMedicalTrip(tower, actor, office) {
  // *"if the tower is at star < 3, the worker always goes home"* - and no roll is
  // spent, because the reference's `&&` short-circuits before it reaches the draw.
  if (tower.starCount < MEDICAL_MIN_STARS) return null;
  const day = tower.clock.dayCounter;
  if (actor.medicalRollDay === day) return null;
  actor.medicalRollDay = day;
  if (!tower.rng.chance(MEDICAL_ROLL)) return null;

  const center = pickMedicalCenter(tower, office.floor);
  if (!center) {
    medicalTripFailed(tower);
    return { failed: true };
  }
  return { center };
}

/** The clinic a worker is heading for or sitting in, or `null` (never `-1`). */
export function clinicOf(tower, actor) {
  if (actor.medicalObjectId == null) return null;
  const object = tower.objects.get(actor.medicalObjectId);
  return object && object.family === FAMILY.medical ? object : null;
}

/** The worker is standing in the clinic: join the queue and take a place in it. */
export function joinMedicalQueue(tower, actor, center) {
  const record = recordOf(center);
  const now = tower.clock.dayTick;
  const start = Math.max(now, record.busyUntil);
  record.busyUntil = start + MEDICAL_VISIT_TICKS;
  record.queue.push(actor.id);
  actor.medicalReadyTick = record.busyUntil;
  actor.medicalRetry = 0;
}

/**
 * Has the clinic seen this worker? Either their visit has come and gone, or they
 * have waited out the retry limit (*"proceeds as if served"*).
 */
export function medicalVisitDone(tower, actor) {
  actor.medicalRetry = (actor.medicalRetry ?? 0) + 1;
  return tower.clock.dayTick >= (actor.medicalReadyTick ?? 0) || actor.medicalRetry >= MEDICAL_RETRY_LIMIT;
}

/**
 * Take a worker out of whatever clinic they are in or heading for, and forget the
 * errand. Safe to call on anyone: the evening park, a deactivated office and the
 * night all come through here, and none of them knows whether the worker was ill.
 */
export function releaseMedical(tower, actor) {
  if (actor.medicalObjectId == null) return false;
  const center = tower.objects.get(actor.medicalObjectId);
  if (center?.medical) {
    const at = center.medical.queue.indexOf(actor.id);
    if (at >= 0) center.medical.queue.splice(at, 1);
  }
  actor.medicalObjectId = null;
  actor.medicalReadyTick = null;
  actor.medicalRetry = 0;
  return true;
}

/** A trip that ended well: nobody is waiting on a clinic that is not there. */
export function medicalTripServed(tower) {
  clearDemand(tower, 'medical');
}

/**
 * `specs/TIME.md` § 2500, chained into the night reset: every worker is sent home
 * and every queue is emptied, because the office workers' own states go back to
 * `0x20` overnight and a queue that remembered them would count the dead.
 */
export function medicalNightReset(tower) {
  for (const center of medicalCenters(tower)) {
    const record = recordOf(center);
    record.queue.length = 0;
    record.busyUntil = 0;
  }
  for (const actor of tower.actors) {
    if (actor && actor.medicalObjectId != null) {
      actor.medicalObjectId = null;
      actor.medicalReadyTick = null;
      actor.medicalRetry = 0;
    }
  }
}
