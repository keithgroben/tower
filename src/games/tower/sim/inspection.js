/**
 * **The office-service evaluation**: the inspector who rides up to an office to test it, and
 * the flag, `gates.officeServiceOk`, that the `3 -> 4` rung is waiting for.
 *
 * Spec: `specs/GAME-STATE.md` § Office Service Evaluation (the whole section - state fields,
 * trigger, resolution, cleanup) and § Gate Meanings (`office-service-ok`: *"set by the
 * office-service evaluation system"*); `specs/facility/OFFICE.md` § Evaluation (the office's
 * grade is *"the average experience of the office's workers over time"*).
 *
 * ## What the spec says
 *
 *  - **Trigger**: *"during normal office entity refresh (family 7)"*, when `star_count == 3`,
 *    `office_service_ok == 0`, no evaluation is in progress and `day_counter % 9 == 3`; it
 *    *"scans for an office entity in state `0x01` with an active service assignment"*, stores it
 *    as the target, sets `eval_in_progress` and fires a notification.
 *  - **Resolution**: *"When the cathedral guest arrives at the target office"*: the office's
 *    runtime tile average is compared with the star-3 upper threshold (`150`); at or under is
 *    a **pass** (`office_service_ok = 1`), over is a **fail**. Either way the evaluation ends.
 *  - **Cleanup**: at tick 1600 the stale state is cleared when `day_counter % 9 != 3`; a target
 *    that stops existing before resolution *"unconditionally fails"*.
 *  - **Reset**: *"on each star advancement"* (`sim/progression.js` `resetStarGateState`).
 *
 * ## What this file does with it, and where it differs (`spec/DEVIATIONS.md` A73)
 *
 * The visitor is *"the cathedral guest"* - and the cathedral cannot exist at three stars (it
 * needs five), nor can its forty guests. So the visitor is **one inspector of our own**
 * (`FAMILY.inspector`, `0x31`, as the VIP is `0x30`): one standing actor with no object, who
 * rides the real lobby-to-office route through the real router and the real lifts, so an
 * office the lifts cannot reach is an office that fails its inspection. His arrival is the
 * resolution, exactly as the spec says; the threshold, the day rule, the cleanup and the reset
 * are the spec's. Two readings are ours: the target is a **let** office (the spec's *"state
 * `0x01` with an active service assignment"* is the office worker's at-work state and a
 * tenant's service request; our let office is the same fact, and the evaluation runs at the
 * 240 checkpoint rather than inside the office refresh - one place, once a day, and the
 * random draw is made only on a day that qualifies); and the notification strings are ours
 * (the spec's numbers `3000`/`0xBBA`/`0xBBB` are the VIP's dialogs in the original's string
 * table, not an inspector's).
 */
import {
  FAMILY, baseState, createActor, enterTransit, isInTransit, isUnitLet,
} from './state.js';
import { cancelRequest } from './elevators.js';
import { postNotice } from './demands.js';
import { evalUpperFor } from './office.js';
import { starGatesOf } from './progression.js';
import { shouldWaitForQueuedCarrier } from './routing.js';
import { computeObjectOperationalScore, createSimTripRecord, resetSimTripCounters } from './stress.js';
import { countSameFloorArrival, noteLocalLeg, routeVisitor } from './visitors.js';

/** `GAME-STATE.md`: *"`star_count == 3`"* - the only rung the evaluation gates. */
export const INSPECTION_STAR = 3;
/** `GAME-STATE.md`: *"`day_counter % 9 == 3`"*, and the cleanup's `% 9 != 3`. */
export const INSPECTION_PERIOD_DAYS = 9;
export const INSPECTION_DAY = 3;
/** The checkpoint the daily check rides: `TIME.md` § 240. */
export const INSPECTION_CHECK_TICK = 240;
/** The checkpoint that clears stale state: `GAME-STATE.md` § Cleanup, tick 1600. */
export const INSPECTION_CLEANUP_TICK = 1600;

/** The inspector's state byte: `0x20` on his way up, `0x27` the rest of the time. */
export const INSPECTOR_STATE = { away: 0x27, arriving: 0x20 };

const OFFICE_WORKERS = 6;

/** `tower.inspection` (`{officeId, floor, day}`) or `null`; the spec's `eval_in_progress` + `eval_target_entity`. */
export const inspectionOf = (tower) => tower.inspection ?? null;

/** Is today an evaluation day? */
export const isInspectionDay = (dayCounter) => dayCounter % INSPECTION_PERIOD_DAYS === INSPECTION_DAY;

/** The offices that could be tested: let, with all six workers. */
export function inspectableOffices(tower) {
  return [...tower.objects.values()].filter((o) =>
    o.family === FAMILY.office && o.floor > 0 && isUnitLet(o) && o.occupants.length === OFFICE_WORKERS);
}

/**
 * Why no inspector is coming today, or `null`: the tower is not at three stars, the evaluation
 * has been passed, one is already under way, it is not an evaluation day, or no office is let.
 */
export function inspectionBlocker(tower) {
  if (tower.starCount !== INSPECTION_STAR) return 'the evaluation is for three-star towers';
  if (starGatesOf(tower).officeServiceOk) return 'the office-service evaluation has already been passed';
  if (tower.inspection) return 'an inspector is already on the way';
  if (!isInspectionDay(tower.clock.dayCounter)) return 'not an evaluation day';
  if (inspectableOffices(tower).length === 0) return 'no office is let';
  return null;
}

/** The standing actor that plays every inspector, made on the first one and kept. */
function inspectorActor(tower) {
  const existing = tower.actors.find((a) => a && a.id === tower.inspectorActorId);
  if (existing) return existing;
  const actor = createActor({
    family: FAMILY.inspector, anchorFloor: 0, objectId: null, occupantIndex: 0, state: INSPECTOR_STATE.away,
    tripFields: createSimTripRecord(),
  });
  tower.actors.push(actor);
  tower.inspectorActorId = actor.id;
  return actor;
}

function sendAway(tower, actor) {
  for (const carrier of tower.carriers) cancelRequest(carrier, actor.id);
  actor.state = INSPECTOR_STATE.away;
  actor.route = null;
  actor.waitingFloor = null;
  actor.routeCarrier = null;
  actor.anchorFloor = 0;
}

/**
 * **The daily check, tick 240.** On an evaluation day at three stars, pick a let office and
 * send the inspector to it.
 *
 * @returns {boolean} whether an inspector was sent
 */
export function runDailyInspection(tower) {
  if (inspectionBlocker(tower)) return false;
  const offices = inspectableOffices(tower);
  const office = offices[tower.rng.int(offices.length)];
  const actor = inspectorActor(tower);
  // A fresh visit is judged on its own trip, not on the last inspector's.
  resetSimTripCounters(actor);
  actor.elapsedPacked = 0;
  actor.lastTripTick = 0;
  actor.anchorFloor = 0;
  actor.state = INSPECTOR_STATE.arriving;
  actor.route = null;
  actor.waitingFloor = null;
  actor.routeCarrier = null;
  tower.inspection = { officeId: office.id, floor: office.floor, day: tower.clock.dayCounter };
  postNotice(tower, 'inspectionStarted', 'An inspector is on the way to the office on floor ' + office.floor);
  return true;
}

/**
 * The office's score: the average of its six workers' stress (*"`compute_runtime_tile_average()`
 * for the office"*), against the star-3 upper threshold (`150`, `evalUpperFor`).
 *
 * @returns {{score:number, threshold:number, pass:boolean}}
 */
export function inspectionVerdict(tower, office) {
  const workers = office.occupants.map((id) => tower.actors.find((a) => a && a.id === id)).filter(Boolean);
  const score = computeObjectOperationalScore(workers, workers.length);
  const threshold = evalUpperFor(tower.starCount);
  return { score, threshold, pass: score <= threshold };
}

/** End the evaluation. `verdict` is `null` for one that could not be carried out. */
function finishInspection(tower, verdict, why) {
  const inspection = tower.inspection;
  const actor = tower.actors.find((a) => a && a.id === tower.inspectorActorId);
  if (actor) sendAway(tower, actor);
  tower.inspection = null;
  tower.lastInspection = {
    day: tower.clock.dayCounter, floor: inspection?.floor ?? null, pass: verdict ? verdict.pass : false,
    score: verdict ? verdict.score : null, why,
  };
  if (verdict?.pass) {
    starGatesOf(tower).officeServiceOk = true;
    postNotice(tower, 'inspectionPassed',
      'The inspector approves: the office on floor ' + inspection.floor + ' is well served', { good: true });
  } else if (verdict) {
    postNotice(tower, 'inspectionFailed',
      'The inspector is not pleased: the office on floor ' + inspection.floor + ' is poorly served', { tone: 'bad' });
  } else {
    postNotice(tower, 'inspectionFailed', 'The inspection was called off: ' + why, { tone: 'bad' });
  }
}

/** The inspector stands in the target office: the evaluation resolves. */
function resolve(tower, actor) {
  const inspection = tower.inspection;
  const office = tower.objects.get(inspection.officeId);
  // *"If the target entity becomes invalid before resolution, the evaluation unconditionally
  // fails and state is cleared."*
  if (!office) { finishInspection(tower, null, 'the office is gone'); return; }
  actor.anchorFloor = office.floor;
  finishInspection(tower, inspectionVerdict(tower, office), 'arrived');
}

/**
 * **Tick 1600** - `GAME-STATE.md` § Cleanup: *"the evaluation state is cleared if
 * `day_counter % 9 != 3`, preventing stale state from persisting across non-evaluation days"*.
 * An inspector still on his way by then never got there; the evaluation fails and is cleared.
 */
export function cleanUpInspection(tower) {
  if (!tower.inspection) return false;
  if (isInspectionDay(tower.clock.dayCounter)) return false;
  finishInspection(tower, null, 'the inspector never reached the office');
  return true;
}

/**
 * The family-`0x31` handler the stride calls. Only the ride up does anything. `ctx` is
 * `{resolveRoute, onDelay}`, supplied by the composition (`ui/driver.js`).
 */
export function inspectorFamilyHandler(ctx) {
  return function serviceInspector(tower, actor) {
    const inspection = tower.inspection;
    if (!inspection || actor.id !== tower.inspectorActorId) return;
    if (actor.state !== INSPECTOR_STATE.arriving && baseState(actor.state) !== INSPECTOR_STATE.arriving) return;
    const office = tower.objects.get(inspection.officeId);
    if (!office) { finishInspection(tower, null, 'the office is gone'); return; }
    if (isInTransit(actor.state) && shouldWaitForQueuedCarrier(actor, tower.clock)) return;
    if (!isInTransit(actor.state)) actor.anchorFloor = 0;
    const result = routeVisitor(tower, actor, actor.anchorFloor ?? 0, office.floor, ctx, INSPECTOR_STATE.arriving);
    // No route at all: the office cannot be reached, so it cannot be inspected - and a route
    // nobody can ride is a failed evaluation, not a pending one.
    if (result.code === -1) { finishInspection(tower, null, 'no lift reaches the office'); return; }
    noteLocalLeg(actor, result);
    if (result.code === 3) { countSameFloorArrival(actor, tower, result); resolve(tower, actor); return; }
    actor.state = enterTransit(INSPECTOR_STATE.arriving);
  };
}

/** A lift (or a walked leg) set the inspector down on `floor`. A transfer only moves him. */
export function inspectorArrival(tower, actor, floor) {
  actor.anchorFloor = floor;
  actor.routeCarrier = null;
  const inspection = tower.inspection;
  if (!inspection || actor.id !== tower.inspectorActorId) { actor.state = baseState(actor.state); return; }
  if (floor === inspection.floor) resolve(tower, actor);
}
