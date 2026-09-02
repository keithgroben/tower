import { lerp, mix } from './juice.js';
import { makeSpriteBook } from './sprites.js';
import { cloudScale, daylight, flyerScale, makeSky, skyColors, skyPhase } from './sky.js';
import { buildOccupiedFloorIndex, roomDesirabilityScore, shaftQueueTrend, tenantDemandQuality, tenantLoadStatus, unitEvaluation, waitingPressureSummary } from '../sim/evaluation.js';
import { localRouteOccupancy } from '../sim/demand.js';
import { firstRouteColumn, freeSlot, isUnderground, lowestFloor, slotsUsed } from '../sim/state.js';

/** Convert a floor queue into the same readable pressure scale used by the
 * canvas badge. Twelve waiting people is the critical point; deeper queues stay
 * red instead of making the indicator harder to interpret. */
export function waitingPressure(count) {
  return waitingPressureSummary(count);
}

/** The headcount that is shown in a built room's tenant badge. */
export function tenantCount(unit) {
  const heads = Number(unit?.heads);
  return Number.isFinite(heads) ? Math.max(0, Math.round(heads)) : 0;
}

/** Prefix a floor queue count with a visible, color-independent meaning. */
export function waitingBadgeText(count) {
  return 'W ' + waitingPressure(count).count;
}

/** Prefix a selected shaft queue with its route label. */
export function shaftWaitingBadgeText(shaftNumber, count) {
  const number = Number.isFinite(Number(shaftNumber)) ? Math.max(1, Math.round(Number(shaftNumber))) : '?';
  return 'S' + number + ' · ' + waitingBadgeText(count);
}

/** Keep route trend secondary to the current waiting count in a tiny badge. */
export function shaftQueueTrendMarker(history) {
  const trend = shaftQueueTrend(history);
  if (trend.entries.length < 2) return '';
  if (trend.spike) return '!';
  if (trend.direction === 'rising') return '↑';
  if (trend.direction === 'falling') return '↓';
  return '→';
}

/** Find the floor badges that belong to one shaft's current waiting queue. */
export function shaftQueueOriginFloors(state, shaftId) {
  if (!state || shaftId == null || !Array.isArray(state.people)) return [];
  return [...new Set(state.people
    .filter((person) => person.state === 'waiting' && person.shaft === shaftId)
    .map((person) => Number(person.from))
    .filter((floor) => Number.isFinite(floor)))]
    .sort((a, b) => a - b);
}

/** Find floor badges whose waiting people have no assigned elevator route. */
export function unassignedQueueOriginFloors(state) {
  if (!state || !Array.isArray(state.people)) return [];
  return [...new Set(state.people
    .filter((person) => person.state === 'waiting' && person.shaft == null && !person.localRouteKind)
    .map((person) => Number(person.from))
    .filter((floor) => Number.isFinite(floor)))]
    .sort((a, b) => a - b);
}

/** Prefix a room load count with a visible, color-independent meaning. */
export function tenantBadgeText(unit, config) {
  const load = tenantLoadStatus(unit, config);
  return 'T ' + tenantCount(unit) + '/' + load.capacity;
}

/**
 * Which of the three people sheets a waiting rider is drawn from.
 *
 * The sim tracks HEADCOUNTS, not individuals — there is no person object with
 * a job — so the figure is decorative puppetry driven by the one thing the
 * trip already knows: what it is for. A commuter is a worker, an errand is a
 * resident, a check-in is a guest. Anything the sim adds later falls back to
 * a worker rather than to nothing, because a missing figure reads as a bug and
 * a slightly wrong hat does not.
 *
 * Per `spec/sprite-manifest.md` Tier 2: if an animation seems to need new sim
 * state, it is cut, not a sim change. Nothing here asks for any.
 */
export const PERSON_SHEETS = {
  commute_in: 'person-worker',
  commute_out: 'person-worker',
  lunch_out: 'person-worker',
  lunch_back: 'person-worker',
  errand_out: 'person-resident',
  errand_in: 'person-resident',
  hotel_check_in: 'person-guest',
  hotel_check_out: 'person-guest',
};

export function personSheet(tripKind) {
  return PERSON_SHEETS[tripKind] ?? 'person-worker';
}

/**
 * Posture for a waiting figure. Heat is how close this rider is to giving up
 * (`waitT / demand.abandonAfter`), which is exactly the number the queue dots
 * were already coloured by — so the crowd carries the SAME signal the dots
 * did, in a second channel. `beat` alternates the two frames of a pose so a
 * platform of people is not a row of statues; the delivered sheets have one
 * frame per pose, so the shuffle has to come from picking between poses.
 */
export function waitingPose(heat, beat) {
  const h = Number.isFinite(Number(heat)) ? Math.max(0, Math.min(1, Number(heat))) : 0;
  const b = beat ? 1 : 0;
  if (h >= 0.66) return b ? 'wait-annoyed' : 'wait';
  if (h >= 0.33) return b ? 'fidget' : 'wait';
  return b ? 'fidget' : 'stand';
}

/**
 * The departure wick (issue #10): how far this tenant is along their own
 * countdown to walking out over room appeal, as 0..1.
 *
 * The bug it answers: Keith ran delivery at 100% and reputation at 100 and
 * lost every tenant anyway, with nothing on screen beforehand. The game only
 * ever gave post-mortems, because appeal was shown as a SCORE — "21/100" is
 * trivia a player has to interpret — while `desirabilityPressure` was already
 * a DEADLINE and a deadline is a warning.
 *
 * **Zero is silent, deliberately.** The tower already carries W badges, T
 * badges and a stress line; a fourth always-on marker drowns all of them, so
 * only a room that is actually losing its tenant gets a wick. `economy.js`
 * writes `desirabilityPressure` once a day and decays it by
 * `desirabilityRetentionRecovery` when appeal recovers, so a fixed room's
 * wick shrinks and then goes out on its own.
 *
 * Read straight off the unit: no `unitEvaluation()` call, so a wick on every
 * room costs nothing per frame. Renderer-only — nothing here writes state.
 */
export function departureWickRatio(unit, config) {
  if (!unit || !unit.occupied) return 0;
  const pressure = Number(unit.desirabilityPressure);
  if (!Number.isFinite(pressure) || pressure <= 0) return 0;
  const vacateAt = Math.max(1, Number(config?.occupancy?.desirabilityRetentionVacateAt) || 1);
  return Math.min(1, pressure / vacateAt);
}

/**
 * Where the wick sits inside a room, or `null` when the floor is too short to
 * carry it — issue #10 asks for it to disappear rather than smear.
 *
 * It owns the room's LEFT edge, top to bottom, and nothing else in the room
 * uses that edge: the tenant badge is top-right, the transport stress line is
 * along the bottom, and the room's fill is already colour-coded twice (by type
 * and by quality), which is exactly why the old "red fade = low appeal" never
 * reached anyone. Fill height is the signal; colour only reinforces it.
 *
 * The bottom stops clear of the stress line so the two causes never overlap —
 * slow lifts and a bare building are different problems with different fixes.
 */
export function departureWickBox(x, y, L) {
  const zoom = Math.max(1, Number(L?.zoom) || 1);
  const fh = Number(L?.fh);
  if (!Number.isFinite(fh)) return null;
  const top = y + 3;
  const bottom = y + fh - 9;      // above the stress line, which lives at fh-7
  const h = bottom - top;
  if (fh < 20 || h < 8) return null;
  return { x: x + Math.max(1, Math.round(zoom)), y: top, w: Math.max(4, Math.round(4 * zoom)), h };
}

/**
 * The appeal overlay's reading of one room (issue #12) — SimTower's evaluation
 * view. The wick is deliberately local: it says "this tenant is leaving". The
 * overlay answers the other question, "which HALF of my tower is rotting", so
 * it is a comparison across the whole building and therefore a gradient rather
 * than three flat buckets.
 *
 * `key` uses exactly the thresholds `unitEvaluation()` already bands on, so
 * the overlay can never disagree with the score the sidebar prints beside it.
 * `ratio` is the GOOD -> BAD mix: 0 at appeal 100, 1 at appeal 0.
 *
 * On demand only. It is never on by default — an always-on tint competes with
 * the normal read of the building, which is the whole reason it is a key.
 */
export function appealOverlayBand(score, config) {
  // `Number(null)` and `Number('')` are both 0, which would tint an unscored
  // room bright red. A missing score is a missing score, not a bad one.
  if (score === null || score === undefined || score === '') return null;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const clamped = Math.max(0, Math.min(100, s));
  const min = Math.max(1, Math.min(99, Number(config?.evaluation?.relistMinScore) || 35));
  return { score: clamped, key: clamped >= 80 ? 'good' : clamped >= min ? 'warn' : 'bad', ratio: 1 - clamped / 100 };
}

/** Floors that can fulfill a preserved investment target. */
export function placementGuideFloors(guide, state, config) {
  if (!guide || !Number.isInteger(guide.floor) || !state || !config) return [];
  if (guide.kind === 'shaft') {
    const top = Math.min(state.floors - 1, config.elevator.maxSpan - 1);
    return Array.from({ length: Math.max(0, top - guide.floor + 1) }, (_, index) => guide.floor + index);
  }
  const radius = config.services?.[guide.kind]?.coverageFloors;
  if (!Number.isFinite(radius)) return [guide.floor];
  const coverageFloor = Number.isInteger(guide.coverageFloor) ? guide.coverageFloor : guide.floor;
  const low = Math.max(config.building.lobbyFloor + 1, coverageFloor - radius);
  const high = Math.min(state.floors - 1, coverageFloor + radius);
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, index) => low + index);
}

/** Classify a guided floor with the same occupancy rules used by construction. */
export function placementGuideFloorStatus(guide, floor, state, config) {
  if (!placementGuideFloors(guide, state, config).includes(floor)) return 'outside';
  if (guide.kind === 'shaft') {
    const bottom = config.building.lobbyFloor ?? 0;
    const clear = Array.from({ length: config.building.slotsPerFloor }, (_, slot) => slot)
      .some((slot) => Array.from({ length: floor - bottom + 1 }, (_, index) => bottom + index)
        .every((candidateFloor) => !slotsUsed(state, candidateFloor).has(slot)));
    return clear ? 'open' : 'blocked';
  }
  return freeSlot(state, config, floor) >= 0 ? 'open' : 'full';
}

/** Resolve the visible endpoint and first usable column for a local route. */
export function localRouteTargetStatus(target, state, config) {
  const kind = target?.kind;
  const bottom = config?.building?.lobbyFloor ?? 0;
  const top = Number(target?.floor);
  const route = config?.[kind];
  if ((kind !== 'stairs' && kind !== 'escalator') || !Number.isInteger(top) || !route) {
    return { key: 'invalid', bottom, top: null, slot: -1, detail: 'local route target is not valid' };
  }
  if (top <= bottom) {
    return { key: 'invalid', bottom, top, slot: -1, detail: kind + ' must reach an upper floor' };
  }
  if (top - bottom + 1 > route.maxSpan) {
    return { key: 'blocked', bottom, top, slot: -1, detail: kind + ' exceeds its ' + route.maxSpan + '-floor limit' };
  }
  // Asks the sim where a route may stand rather than predicting it. The two
  // used to be separate scans, so adding the attachment rule to one would have
  // left this one pointing at columns the sim refuses.
  const slot = firstRouteColumn(state, config, bottom, top);
  if (slot >= 0) return { key: 'ready', bottom, top, slot, detail: 'clear column available' };
  return { key: 'blocked', bottom, top, slot: -1, detail: 'no clear column against the building for ' + kind };
}

/** Floors covered by a focused, already-built service. */
export function serviceFocusFloors(focus, state, config) {
  if (!focus || !Number.isInteger(focus.floor) || !state || !config) return [];
  const radius = Number.isFinite(Number(focus.coverageFloors))
    ? Math.max(0, Number(focus.coverageFloors))
    : config.services?.[focus.kind]?.coverageFloors;
  if (!Number.isFinite(radius)) return [focus.floor];
  const low = Math.max(config.building.lobbyFloor + 1, focus.floor - radius);
  const high = Math.min(state.floors - 1, focus.floor + radius);
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, index) => low + index);
}

/** Explain whether a covered-head drop came from fewer tenants or lost coverage. */
export function serviceFloorHeadcountCause(liveCoveredHeads, recordedCoveredHeads, liveRequiredHeads, recordedRequiredHeads) {
  const liveCovered = Number(liveCoveredHeads) || 0;
  const recordedCovered = Number(recordedCoveredHeads) || 0;
  const delta = liveCovered - recordedCovered;
  if (delta >= 0) return { key: 'stable', delta, requiredDelta: null };
  const liveRequired = Number(liveRequiredHeads);
  const recordedRequired = Number(recordedRequiredHeads);
  const requiredDelta = Number.isFinite(liveRequired) && Number.isFinite(recordedRequired)
    ? liveRequired - recordedRequired
    : null;
  return {
    key: requiredDelta != null && requiredDelta < 0 ? 'vacancy' : 'coverage',
    delta,
    requiredDelta,
  };
}

/** Classify the live service state of one room for daily history. */
export function serviceRoomStatus(unit, evaluation, kind, config) {
  const need = config?.units?.[unit?.kind]?.[kind + 'Need'] ?? 0;
  const liveHeads = unit?.occupied ? Math.max(0, Math.round(unit.heads ?? 0)) : 0;
  if (!need) return { key: 'not_required', liveHeads };
  if (!unit?.occupied) return { key: 'vacant', liveHeads: 0 };
  return { key: evaluation?.[kind + 'Covered'] ? 'covered' : 'uncovered', liveHeads };
}

/** Summarize the direction of a room's recorded service status. */
export function serviceRoomStatusTrend(history) {
  const entries = Array.isArray(history) ? history.filter((entry) => entry?.key) : [];
  const current = entries.at(-1);
  const previous = entries.at(-2);
  if (!current || !previous) return { key: 'stable', label: 'stable', from: previous?.key ?? null, to: current?.key ?? null };
  const rank = { uncovered: 0, vacant: 1, covered: 2, not_required: 2 };
  const currentRank = rank[current.key] ?? 1;
  const previousRank = rank[previous.key] ?? 1;
  const key = currentRank > previousRank ? 'recovering' : currentRank < previousRank ? 'worsening' : 'stable';
  return { key, label: key, from: previous.key, to: current.key };
}

/** Choose the next room action implied by a worsening service trend. */
export function serviceRoomTrendAction(trend, currentKey, kind) {
  if (trend?.key !== 'worsening') return { key: 'none', label: '' };
  if (currentKey === 'uncovered' && kind) return { key: 'coverage', label: 'restore ' + kind + ' coverage' };
  if (currentKey === 'vacant') return { key: 'vacancy', label: 're-rent room before adding service' };
  return { key: 'monitor', label: 'monitor room conditions' };
}

/** Add one room reading while keeping the history bounded and day-stable. */
export function appendServiceRoomStatusHistory(history, reading, roomLimit = 6, totalLimit = 24) {
  if (!reading?.unitId || !reading?.kind || !reading?.key) return Array.isArray(history) ? history : [];
  const source = Array.isArray(history) ? history : [];
  const prior = source.filter((entry) => !(entry.unitId === reading.unitId &&
    entry.kind === reading.kind && entry.day === reading.day));
  const previous = prior.slice().reverse().find((entry) => entry.unitId === reading.unitId && entry.kind === reading.kind);
  const entry = {
    ...reading,
    transitionFrom: previous && previous.key !== reading.key ? previous.key : null,
  };
  const sameRoom = prior.filter((candidate) => candidate.unitId === reading.unitId && candidate.kind === reading.kind)
    .concat(entry).slice(-Math.max(1, roomLimit));
  return prior.filter((candidate) => candidate.unitId !== reading.unitId || candidate.kind !== reading.kind)
    .concat(sameRoom).slice(-Math.max(1, totalLimit));
}

/** Live occupied-room coverage inside a focused facility's area. */
export function serviceFocusCoverage(focus, state, config, floorIndex = null) {
  if (!focus || !state || !config?.services?.[focus.kind]) return null;
  const floors = new Set(serviceFocusFloors(focus, state, config));
  const required = state.units.filter((unit) =>
    unit.occupied && floors.has(unit.floor) && (config.units[unit.kind]?.[focus.kind + 'Need'] ?? 0) > 0);
  const evaluated = required.map((unit) => ({ unit, covered: Boolean(unitEvaluation(state, unit, config, floorIndex)[focus.kind + 'Covered']) }));
  const covered = evaluated.filter(({ covered: isCovered }) => isCovered).map(({ unit }) => unit);
  const uncovered = evaluated.filter(({ covered: isCovered }) => !isCovered).map(({ unit }) => unit);
  const requiredRoomsByFloor = {};
  const coveredRoomsByFloor = {};
  const requiredHeadsByFloor = {};
  const coveredHeadsByFloor = {};
  const uncoveredRoomsByFloor = {};
  const uncoveredHeadsByFloor = {};
  for (const { unit, covered: isCovered } of evaluated) {
    requiredRoomsByFloor[unit.floor] = (requiredRoomsByFloor[unit.floor] ?? 0) + 1;
    requiredHeadsByFloor[unit.floor] = (requiredHeadsByFloor[unit.floor] ?? 0) + (unit.heads ?? 0);
    if (isCovered) {
      coveredRoomsByFloor[unit.floor] = (coveredRoomsByFloor[unit.floor] ?? 0) + 1;
      coveredHeadsByFloor[unit.floor] = (coveredHeadsByFloor[unit.floor] ?? 0) + (unit.heads ?? 0);
      continue;
    }
    uncoveredRoomsByFloor[unit.floor] = (uncoveredRoomsByFloor[unit.floor] ?? 0) + 1;
    uncoveredHeadsByFloor[unit.floor] = (uncoveredHeadsByFloor[unit.floor] ?? 0) + (unit.heads ?? 0);
  }
  return {
    kind: focus.kind,
    floors: [...floors],
    requiredRooms: required.length,
    coveredRooms: covered.length,
    uncoveredRooms: uncovered.length,
    requiredHeads: required.reduce((sum, unit) => sum + (unit.heads ?? 0), 0),
    coveredHeads: covered.reduce((sum, unit) => sum + (unit.heads ?? 0), 0),
    uncoveredHeads: uncovered.reduce((sum, unit) => sum + (unit.heads ?? 0), 0),
    uncoveredFloors: Object.keys(uncoveredRoomsByFloor).map(Number).sort((a, b) => a - b),
    coveredUnitIds: covered.map((unit) => unit.id),
    uncoveredUnitIds: uncovered.map((unit) => unit.id),
    requiredRoomsByFloor,
    coveredRoomsByFloor,
    requiredHeadsByFloor,
    coveredHeadsByFloor,
    uncoveredRoomsByFloor,
    uncoveredHeadsByFloor,
  };
}

/** Name rooms currently served by a focused facility. */
export function serviceFocusCoveredRoomLabel(coverage, state, limit = 3) {
  const rooms = (coverage?.coveredUnitIds ?? [])
    .map((id) => state?.units?.find((unit) => unit.id === id && unit.occupied))
    .filter(Boolean)
    .map((unit) => 'F' + unit.floor + ' ' + unit.kind + ' (' + Math.max(0, Math.round(unit.heads ?? 0)) + ' tenants)');
  if (!rooms.length) return '';
  const shown = rooms.slice(0, Math.max(1, limit));
  return shown.join(', ') + (rooms.length > shown.length ? ' +' + (rooms.length - shown.length) + ' more' : '');
}

/** Return live desirability details for rooms served by a focused facility. */
export function serviceFocusCoveredRoomDetails(coverage, state, config) {
  return (coverage?.coveredUnitIds ?? [])
    .map((id) => state?.units?.find((unit) => unit.id === id && unit.occupied))
    .filter(Boolean)
    .map((unit) => ({
      id: unit.id,
      floor: unit.floor,
      kind: unit.kind,
      heads: Math.max(0, Math.round(unit.heads ?? 0)),
      desirability: tenantDemandQuality(state, unit, config).desirabilityScore,
      stress: Math.max(0, Math.round(Number(unit.stress) || 0)),
    }));
}

/** Summarize room appeal and transport stress without hiding either value. */
export function serviceRoomHealthSignal(room, config) {
  const desirability = Number(room?.desirability);
  const stress = Number(room?.stress);
  const vacateAt = Number(config?.units?.[room?.kind]?.vacateAt) || 0;
  if (!Number.isFinite(desirability) && !Number.isFinite(stress)) {
    return { key: 'unknown', label: 'HEALTH UNKNOWN', colorKey: 'warn', driver: 'unknown' };
  }
  const lowAppeal = Number.isFinite(desirability) && desirability < 55;
  const watchAppeal = Number.isFinite(desirability) && desirability < 80;
  const highStress = vacateAt > 0 && Number.isFinite(stress) && stress >= vacateAt * 0.7;
  const watchStress = vacateAt > 0 && Number.isFinite(stress) && stress >= vacateAt * 0.5;
  const riskDrivers = [lowAppeal ? 'appeal' : null, highStress ? 'transport' : null].filter(Boolean);
  const watchDrivers = [watchAppeal ? 'appeal' : null, watchStress ? 'transport' : null].filter(Boolean);
  if (lowAppeal || highStress) return { key: 'risk', label: 'AT RISK', colorKey: 'bad', driver: riskDrivers.join(' + ') || 'unknown' };
  if (watchAppeal || watchStress) return { key: 'watch', label: 'WATCH', colorKey: 'warn', driver: watchDrivers.join(' + ') || 'unknown' };
  return { key: 'healthy', label: 'HEALTHY', colorKey: 'good', driver: 'none' };
}

/** Name the occupied rooms that remain outside a focused facility's service. */
export function serviceFocusUncoveredRoomLabel(coverage, state, limit = 3) {
  const rooms = (coverage?.uncoveredUnitIds ?? [])
    .map((id) => state?.units?.find((unit) => unit.id === id && unit.occupied))
    .filter(Boolean)
    .map((unit) => 'F' + unit.floor + ' ' + unit.kind + ' (' + Math.max(0, Math.round(unit.heads ?? 0)) + ' tenants)');
  if (!rooms.length) return '';
  const shown = rooms.slice(0, Math.max(1, limit));
  return shown.join(', ') + (rooms.length > shown.length ? ' +' + (rooms.length - shown.length) + ' more' : '');
}

// ------------------------------------------------------------------ camera
//
// The world, in pixels at zoom 1x. These are the native art dimensions from
// spec/sprite-manifest.md, and spec/tower-view.md §8 fixes them: building
// higher makes the tower TALLER, it never makes it smaller. The old
// fit-to-viewport layout drew a slot at 22x14 px at 60 floors — half the grid
// the art is drawn on — which is why the tower got less legible the better you
// played.

/** One unit slot is 48 px wide at 1x. */
export const SLOT_W = 48;
/** One floor is 32 px tall at 1x, forever. */
export const FLOOR_H = 32;
/** Integer only: mixel art shears the moment it is scaled 1.5x. */
export const ZOOM_LEVELS = [1, 2, 3];

/**
 * World coordinates. `x` grows right from slot 0's left edge; `y` grows DOWN
 * from the ground line, which is floor 0's slab. Floor `f` therefore occupies
 * `[-(f+1)*FLOOR_H, -f*FLOOR_H)`.
 *
 * The origin is the ground line rather than the bottom of the tower on
 * purpose: everything at or below `y = 0` is earth today and becomes B1..B10
 * when the sim learns about a floor range (spec §3), without the world origin
 * moving under the player.
 */
export function floorTopWorldY(floor) { return -(floor + 1) * FLOOR_H; }
export function floorBottomWorldY(floor) { return -floor * FLOOR_H; }
export function slotLeftWorldX(slot) { return slot * SLOT_W; }
export function floorAtWorldY(worldY) { return Math.floor(-worldY / FLOOR_H); }
export function slotAtWorldX(worldX) { return Math.floor(worldX / SLOT_W); }

export function clampZoom(zoom) {
  const z = Math.round(Number(zoom) || 1);
  return Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], Math.max(ZOOM_LEVELS[0], z));
}

/** Camera state is `{ x, y, zoom }`, where x/y is the world point sitting at
 *  the CENTER of the viewport. It lives in the renderer and nowhere else. */
export function makeCamera(x = 0, y = 0, zoom = 1) {
  return { x, y, zoom: clampZoom(zoom) };
}

export function worldToScreen(camera, viewport, worldX, worldY) {
  const z = clampZoom(camera.zoom);
  return [(worldX - camera.x) * z + viewport.w / 2, (worldY - camera.y) * z + viewport.h / 2];
}

/** The inverse transform every pick goes through. */
export function screenToWorld(camera, viewport, screenX, screenY) {
  const z = clampZoom(camera.zoom);
  return [(screenX - viewport.w / 2) / z + camera.x, (screenY - viewport.h / 2) / z + camera.y];
}

export function visibleWorldRect(camera, viewport) {
  const [left, top] = screenToWorld(camera, viewport, 0, 0);
  const [right, bottom] = screenToWorld(camera, viewport, viewport.w, viewport.h);
  return { left, top, right, bottom };
}

/** Floors that touch the viewport, so a 60-floor tower only draws what it must. */
export function visibleFloorRange(camera, viewport, floors, lowest = 0) {
  const rect = visibleWorldRect(camera, viewport);
  const bottom = Math.min(0, Math.round(lowest));
  return {
    low: Math.max(bottom, floorAtWorldY(rect.bottom)),
    high: Math.min(Math.max(bottom, Math.round(floors) - 1), floorAtWorldY(rect.top)),
  };
}

/** Zoom while holding the world point under `(screenX, screenY)` still — what
 *  makes a wheel zoom land where the player was looking instead of drifting. */
export function cameraZoomedAt(camera, viewport, nextZoom, screenX, screenY) {
  const z = clampZoom(nextZoom);
  const [worldX, worldY] = screenToWorld(camera, viewport, screenX, screenY);
  return {
    x: worldX - (screenX - viewport.w / 2) / z,
    y: worldY - (screenY - viewport.h / 2) / z,
    zoom: z,
  };
}

// ----------------------------------------------------------------- minimap
//
// A narrow vertical strip, one pixel row per floor, with a box marking what
// the main view is looking at (spec §2). It is what makes a 60-floor tower
// navigable, and it is why zoom stays clean integer 1x/2x/3x.

export const MINIMAP = { width: 36, margin: 12, pad: 3, gutter: 5, minRowH: 1, maxRowH: 6 };

export function minimapMetrics(viewport, rows, cols, lowest = 0) {
  const rowCount = Math.max(1, Math.round(rows) || 1);
  const bottom = Math.min(0, Math.round(lowest) || 0);
  const colCount = Math.max(1, Math.round(cols) || 1);
  const availH = Math.max(MINIMAP.minRowH, viewport.h - MINIMAP.margin * 2 - MINIMAP.pad * 2);
  const rowH = Math.max(MINIMAP.minRowH, Math.min(MINIMAP.maxRowH, Math.floor(availH / rowCount)));
  const h = rowH * rowCount;
  const cellW = Math.max(1, Math.floor((MINIMAP.width - MINIMAP.gutter) / colCount));
  const w = MINIMAP.gutter + cellW * colCount;
  return {
    x: Math.max(MINIMAP.margin, viewport.w - MINIMAP.margin - MINIMAP.pad - w),
    // Anchored to the bottom, like the tower: floor 0 is the bottom row and
    // the strip grows upward as the building does.
    y: Math.max(MINIMAP.margin, viewport.h - MINIMAP.margin - MINIMAP.pad - h),
    w, h, rowH, cellW, rows: rowCount, cols: colCount,
    // The floor the bottom row stands for. 0 until the tower digs.
    lowest: bottom,
    gutter: MINIMAP.gutter, pad: MINIMAP.pad,
  };
}

export function minimapRowY(metrics, floor) {
  const row = floor - (metrics.lowest ?? 0);
  return metrics.y + metrics.h - (row + 1) * metrics.rowH;
}

export function minimapFloorAt(metrics, screenY) {
  const bottom = metrics.lowest ?? 0;
  const row = Math.floor((metrics.y + metrics.h - screenY) / metrics.rowH);
  return Math.min(bottom + metrics.rows - 1, Math.max(bottom, bottom + row));
}

export function minimapSlotAt(metrics, screenX) {
  const slot = Math.floor((screenX - metrics.x - metrics.gutter) / metrics.cellW);
  return Math.min(metrics.cols - 1, Math.max(0, slot));
}

export function minimapContains(metrics, screenX, screenY) {
  return screenX >= metrics.x - metrics.pad && screenX <= metrics.x + metrics.w + metrics.pad &&
    screenY >= metrics.y - metrics.pad && screenY <= metrics.y + metrics.h + metrics.pad;
}

/**
 * Draws a cross-section of the tower.
 *
 * The single most important thing on this screen is the queue of waiting people.
 * If the player cannot SEE the line growing, the bottleneck is invisible and the
 * failure is unreadable — the headless sweep already proved a tower can fail 97%
 * of its trips while every number on the HUD looks calm. Everything else here is
 * secondary to making that queue legible.
 */
/**
 * @param options `{ sprites }` — forwarded to `makeSpriteBook`, so a test can
 *   supply loaders that read the real sheets off disk instead of the network.
 *   Without it the book takes its browser defaults and, in Node, reports every
 *   sheet missing — which is the fallback path, not the art path. Six visual
 *   complaints have come back as "the art exists, nothing draws it"; this is
 *   what lets `npm test` see the difference (issue #14).
 */
export function makeRenderer(canvas, config, options = {}) {
  const ctx = canvas.getContext('2d');
  const [BG, PANEL, GOOD, WARN, BAD, INFO] = config.feel.palette;
  const KIND = { office: INFO, condo: GOOD, shop: WARN, hotel: '#c77dff' };
  const indicatorColor = (key) => key === 'good' ? GOOD : key === 'bad' ? BAD : WARN;

  /** Smoothed car positions, so a 30Hz sim reads as continuous motion. */
  const smooth = new Map();

  // The art. Every draw below asks the book first and falls back to the shape
  // it always drew, so a sheet that has not arrived (or has arrived broken)
  // costs a rectangle, never a frame. See src/games/lift/assets/README.md.
  const sprites = makeSpriteBook(config, options.sprites ?? {});
  // The sky owns its own clock and its own randomness. Decoration only: a
  // tower plays identically with it switched off.
  const sky = makeSky(config);
  sprites.preload([
    'ground-street', 'earth-fill', 'earth-edge', 'foundation-slab',
    'basement-empty', 'basement-parking', 'basement-utility',
    'office', 'condo', 'shop', 'hotel', 'slot-empty', 'slot-construction', 'room-empty',
    'lobby', 'lobby-wing', 'floor-slab', 'roof-cap',
    'shaft-column', 'elevator-car', 'elevator-car-express', 'stairs-segment', 'escalator-segment',
    'sky-cloud', 'sky-bird', 'sky-plane', 'sky-balloon', 'sky-blimp', 'sky-explorer', 'sky-stunt',
  ]);

  /** Day-ness, the same curve the sky is painted from: 0 through the night
   *  hours, 1 at midday. Sprites carry lit-window night variants rather than
   *  being dimmed, so every sheet with a night frame asks this. */
  const dayness = (state) => Math.sin(Math.PI * Math.min(1, Math.max(0, (state.tod - 0.05) / 0.9)));
  const isNight = (state) => dayness(state) < 0.35;

  /** A stable per-thing number, so a shop keeps the same storefront and two
   *  neighbours do not animate in lockstep. Ids are stable for a unit's life. */
  const idPhase = (id) => ((id * 2654435761) % 1000);

  /** Which sheet and which state a room draws as. Returns null for a room the
   *  art does not cover yet, which simply keeps the old rectangle. */
  function unitSprite(u, state) {
    if (!['office', 'condo', 'shop', 'hotel'].includes(u.kind)) return null;
    const night = isNight(state);
    // The empty shell, not the furnished room's dim frame. Each type keeps its
    // identity in the architecture alone — corporate glass, a balcony, a
    // shutter, a door alcove — with a blank letting card in the window that
    // drawVacancyTag writes over.
    if (!u.occupied) return { name: 'room-empty', animation: u.kind };
    if (u.kind === 'shop') {
      if (night) return { name: 'shop', animation: 'closed-night' };
      const fronts = ['open-grocery', 'open-cafe', 'open-awning'];
      return { name: 'shop', animation: fronts[u.id % fronts.length] };
    }
    if (u.kind === 'hotel') return { name: 'hotel', animation: night ? 'booked-night' : 'booked-day' };
    const tune = config.units[u.kind];
    if (u.stress / tune.vacateAt > 0.66) return { name: u.kind, animation: 'stressed' };
    return { name: u.kind, animation: night ? 'occupied-night' : 'occupied-day' };
  }

  /** Paint a sheet across a rectangle, one frame per art tile. Used for the
   *  earth and the street, which are backdrops rather than objects. */
  function tileAcross(name, animation, x0, y0, x1, y1, tileW, tileH, skipX = null) {
    if (!sprites.has(name, animation)) return false;
    for (let y = y0; y < y1; y += tileH) {
      for (let x = x0; x < x1; x += tileW) {
        if (skipX && skipX.has(Math.round(x))) continue;
        if (!sprites.drawSprite(ctx, { name, animation, x, y, scale: tileW / SLOT_W })) return false;
      }
    }
    return true;
  }
  let W = 0, H = 0, dpr = 1;
  /** Seconds of render time, for cloud drift and smoke trails. */
  let skyDrift = 0;

  // Fixed relative positions (fraction of width, pixels from the top) so
  // stars don't re-roll every frame or every reload.
  const STARS = [
    [0.06, 10], [0.13, 26], [0.19, 8], [0.27, 34], [0.34, 14], [0.41, 28],
    [0.58, 12], [0.66, 30], [0.73, 6], [0.81, 22], [0.88, 36], [0.94, 16],
  ];

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    const maxDpr = config.feel.maxDpr ?? 1.25;
    const pixelBudget = config.feel.maxCanvasPixels ?? 2000000;
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr, Math.sqrt(pixelBudget / Math.max(1, W * H)));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The camera. Fixed world scale, integer zoom, and it stays where the player
  // put it — see followCamera() for the only three moves it makes on its own.
  const camera = makeCamera(0, 0, 1);
  let framedSeed = null;
  let knownPlacements = null;

  /**
   * How many crowd figures are left in this frame's budget.
   *
   * A full redraw is well under a millisecond against a 33ms frame, and the
   * crowd is the one thing here that could eat that: a grown tower can have a
   * queue on every visible floor at once. Past the budget the row falls back
   * to the dots it drew before, so the worst case is bounded by a number in
   * `config.feel` rather than by how badly the player is doing.
   */
  let crowdBudget = 0;

  /** Cells with a build landing on them, and when it started. Render-time
   *  only; nothing in here can change what was built or when. */
  const landing = new Map();

  // Issue #12: the appeal overlay is a question the player asks, so it starts
  // off and stays off until something calls setAppealOverlay(). The key that
  // toggles it is bound in ui/, the same way pan, zoom and goTo already are —
  // the renderer owns the tint, never the input.
  let appealOverlay = false;

  const viewport = () => ({ w: W, h: H });

  /** Keep the tower reachable without snapping: the player may pan a quarter of
   *  a viewport past its edges and no further, so the view can never be lost. */
  function clampCamera(state) {
    const z = camera.zoom;
    const cols = config.building.slotsPerFloor;
    const slackX = W / (4 * z) + SLOT_W;
    const slackY = H / (4 * z) + FLOOR_H;
    const roof = floorTopWorldY(Math.max(0, Math.round(state?.floors ?? 0)) + 2);
    // The floor of the world is whatever has been dug, plus two storeys of
    // earth to look at. An undug tower still gets a little ground under it.
    const cellar = floorBottomWorldY(Math.min(0, lowestFloor(state)) - 2);
    camera.x = Math.min(cols * SLOT_W + slackX, Math.max(-slackX, camera.x));
    camera.y = Math.min(cellar + slackY, Math.max(roof - slackY, camera.y));
  }

  /**
   * The old layout refit the whole tower into the viewport every frame. This
   * one is the camera transform, in the same shape the drawing code already
   * speaks: `x0`/`y0` are where world (0, 0) — slot 0's left edge, the ground
   * line — lands on screen, and one floor is always FLOOR_H * zoom px tall.
   */
  function layout(state) {
    const cols = config.building.slotsPerFloor;
    const cw = SLOT_W * camera.zoom;
    const fh = FLOOR_H * camera.zoom;
    const [x0, y0] = worldToScreen(camera, viewport(), 0, 0);
    return { fh, cw, x0, y0, cols, zoom: camera.zoom, floorY: (f) => y0 - (f + 1) * fh };
  }

  /** True when any part of a column from `bottom` to `top` is on screen. */
  function spanVisible(L, bottom, top, slot) {
    const x = L.x0 + slot * L.cw;
    const spanTop = L.floorY(top);
    const spanBottom = L.floorY(bottom) + L.fh;
    return x + L.cw > 0 && x < W && spanBottom > 0 && spanTop < H;
  }

  function centerOnCell(state, floor, slot) {
    camera.x = slotLeftWorldX(slot) + SLOT_W / 2;
    camera.y = floorTopWorldY(floor) + FLOOR_H / 2;
    clampCamera(state);
  }

  /** The opening shot: the lobby framed on bare ground, at the chunkiest zoom
   *  whose full slot grid still fits the window. */
  function frameLobby(state) {
    const cols = config.building.slotsPerFloor;
    const fits = ZOOM_LEVELS.filter((z) => cols * SLOT_W * z <= W - 80 && FLOOR_H * 8 * z <= H - 80);
    camera.zoom = clampZoom(Math.min(2, fits[fits.length - 1] ?? 1));
    camera.x = (cols * SLOT_W) / 2;
    // Ground line at about 78% of the viewport height: street and a little
    // earth below it, sky and room to build above it.
    camera.y = -(H * 0.28) / camera.zoom;
    clampCamera(state);
  }

  /** Every placed thing, keyed so a new one can be told from an old one, and
   *  carrying its full span: a shaft from the lobby to F20 has NOT landed
   *  off-screen just because its top is, so it must not yank the view. */
  const mark = (id, bottom, top, slot) => ({ id, bottom, top, slot, floor: Math.round((bottom + top) / 2) });

  function placementMarks(state) {
    const marks = [];
    for (const u of state.units) marks.push(mark('u' + u.id, u.floor, u.floor, u.slot));
    for (const f of state.facilities ?? []) marks.push(mark('f' + f.id, f.floor, f.floor, f.slot));
    for (const s of state.shafts) marks.push(mark('s' + s.id, s.bottom, s.top, s.slot));
    for (const s of state.stairs ?? []) marks.push(mark('w' + s.id, s.bottom, s.top, s.slot));
    for (const e of state.escalators ?? []) marks.push(mark('e' + e.id, e.bottom, e.top, e.slot));
    for (const slot of state.lobby?.slots ?? (state.lobby ? [state.lobby.slot] : [])) {
      const lobbyFloor = config.building.lobbyFloor ?? 0;
      marks.push(mark('l' + slot, lobbyFloor, lobbyFloor, slot));
    }
    return marks;
  }

  /**
   * Spec §2, follow rules: the camera stays where the player put it. It may
   * move itself in exactly three cases — first load (frame the lobby), a
   * confirmed placement that landed off-screen, and an explicit "go to" from
   * the HUD (`goTo`). Anything else that yanks the view is a bug.
   */
  function followCamera(state, L) {
    if (!W || !H) return;
    const marks = placementMarks(state);
    if (framedSeed !== state.seed) {
      framedSeed = state.seed;
      knownPlacements = new Set(marks.map((placed) => placed.id));
      frameLobby(state);
      return;
    }
    const fresh = marks.filter((placed) => !knownPlacements.has(placed.id));
    // Anything that just landed plays its scaffold-and-dust once. Recorded on
    // the RENDER clock, so it is decoration: pause the game and the dust
    // settles with it, and a tower plays identically with the sheet absent.
    for (const placed of fresh) landing.set(placed.id, { ...placed, at: sprites.elapsedMs });
    for (const placed of marks) knownPlacements.add(placed.id);
    const offscreen = fresh.find((placed) => !spanVisible(L, placed.bottom, placed.top, placed.slot));
    if (offscreen) centerOnCell(state, offscreen.floor, offscreen.slot);
  }

  function draw(state, juice, dtMs, placementGuide = null, hoverFloor = -1, routeTarget = null, serviceFocus = null, hoverFacilityId = null, selectedShaftId = null, hoverShaftId = null, shaftQueueHistory = null) {
    clampCamera(state);
    crowdBudget = Math.max(0, Number(config.feel?.sprites?.maxCrowdFigures) || 0);
    sprites.advance(dtMs);
    skyDrift += Math.min(120, Math.max(0, dtMs || 0)) / 1000;
    sky.update(dtMs, state.tod, W, H);
    followCamera(state, layout(state));
    const L = layout(state);
    const visible = visibleFloorRange(camera, viewport(), state.floors, lowestFloor(state));
    const [sx, sy] = juice.offset();
    // Built once per frame and shared across every room's evaluation below —
    // without it, each occupied room re-scans the whole tower for noise and
    // layout neighbors, 30 times a second, which is what made a grown tower
    // peg a CPU core.
    const floorIndex = buildOccupiedFloorIndex(state);

    ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
    paintSky(state);
    drawEarth(L, state);

    for (let f = visible.low; f <= visible.high; f++) {
      const y = L.floorY(f);
      // A storey is only as wide as what stands on it. Painting the full grid
      // as a slab is what let a single office on floor 6 look like a whole
      // finished floor with the rest of it merely unfurnished — Keith,
      // 2026-09-01: "you are making floors and filling in rooms wherever."
      // Now the building is exactly the cells that were built, and the sky
      // shows through the rest, which is also what the support rule says is
      // true (see isSupported in sim/state.js).
      const built = slotsUsed(state, f);
      const isGround = f === (config.building.lobbyFloor ?? 0);
      if (!built.size) continue;

      // A storey runs from its leftmost built slot to its rightmost, and the
      // gaps INSIDE that span are empty floor you can see into — bare shell
      // with its columns showing. Beyond the ends there is sky.
      //
      // This is the distinction the first attempt missed in both directions:
      // painting the full grid made one office look like a finished floor,
      // and painting only the built cells left a stairwell floating with a
      // hole between it and the building (Keith: "the stairs don't look
      // connected"). SimTower draws the building, and a building is
      // continuous between its own ends.
      let low = Infinity, high = -Infinity;
      for (const slot of built) { if (slot < low) low = slot; if (slot > high) high = slot; }

      ctx.fillStyle = isUnderground(f) ? '#171d1a' : isGround ? '#141c26' : 'rgba(27,36,48,0.55)';
      for (let slot = low; slot <= high; slot++) {
        const x = L.x0 + slot * L.cw;
        if (x + L.cw < 0 || x > W) continue;
        ctx.fillRect(x, y, L.cw, L.fh - 2);
        if (isUnderground(f)) {
          // A dug storey is bare concrete until something is built in it.
          sprites.drawSprite(ctx, { name: 'basement-empty', animation: 'tile', x, y, scale: L.zoom });
        } else if (!built.has(slot)) {
          // Unbuilt space inside the building: the shell, not the sky.
          sprites.drawSprite(ctx, { name: 'slot-empty', animation: 'empty', x, y, scale: L.zoom });
        }
      }

      // Where a dug storey ends, the earth it was cut out of begins. One tile
      // either side of the span turns a basement from a box floating in soil
      // into a hole somebody excavated.
      if (isUnderground(f)) drawEarthEdges(L, low, high, y);

      // The line between storeys. Without it a stack of rooms reads as one
      // tall column of colour; the slab is what makes them floors.
      drawFloorSlab(L, low, high, y);

      ctx.fillStyle = isUnderground(f) ? 'rgba(198,166,124,0.45)' : 'rgba(142,202,230,0.35)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(floorLabel(f), L.x0 - 12, y + L.fh * 0.68);
    }

    // The slab the whole tower stands on, at the bottom of whatever is dug.
    drawFoundation(state, L);
    // ...and a cap on the roof, so the top storey reads as finished rather
    // than cut off. Another sheet that has been sitting unused since the first
    // art drop.
    drawRoofCap(state, L);

    // The horizon and the street sit on top of floor 0's slab, so the ground
    // floor reads as a storey standing ON something instead of floating. The
    // lobby's own slots are skipped: its art carries its own ground, and a
    // pavement drawn under it left the curb line running through the doorway.
    drawStreet(L, new Set(state.lobby ? (state.lobby.slots ?? [state.lobby.slot]) : []));

    drawServiceFocus(serviceFocus, state, L, floorIndex);
    drawPlacementGuide(placementGuide, state, L, hoverFloor);

    if (state.lobby) drawLobby(state.lobby, L, state);
    for (const stair of state.stairs ?? []) drawStairs(stair, L, state);
    for (const escalator of state.escalators ?? []) drawEscalator(escalator, L, state);
    for (const u of state.units) drawUnit(u, L, state, floorIndex);
    for (const facility of state.facilities ?? []) drawFacility(facility, L, state, serviceFocus?.facilityId === facility.id, hoverFacilityId === facility.id);
    // Over whatever just landed, so a placement reads as built rather than
    // simply appearing.
    drawConstruction(L);
    // After the rooms so it recolours them, before the transport signals so
    // shafts, cars and queues stay readable underneath the question being
    // asked. Appeal and transport are different causes with different fixes.
    drawAppealOverlay(state, L, floorIndex, visible);
    for (const sh of state.shafts) drawShaft(sh, L, dtMs, state, shaftQueueHistory, selectedShaftId === sh.id, hoverShaftId === sh.id);
    drawRouteTarget(routeTarget, state, L, hoverFloor);
    drawQueues(state, L, selectedShaftId, visible);
    // LAST of the world passes, and it has to stay last: see drawDepartureWicks.
    drawDepartureWicks(state, L, visible);

    juice.draw(ctx);
    // The minimap is screen furniture, not part of the world: it is drawn
    // without the shake offset so it never jitters under the cursor.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMinimap(state, L);
  }

  function drawPlacementGuide(guide, state, L, hoverFloor) {
    const floors = placementGuideFloors(guide, state, config);
    if (!floors.length) return;
    for (const floor of floors) {
      const y = L.floorY(floor);
      const target = floor === guide.floor;
      const hovered = floor === hoverFloor;
      const status = placementGuideFloorStatus(guide, floor, state, config);
      const open = status === 'open';
      ctx.fillStyle = target
        ? (open ? 'rgba(255,183,3,0.16)' : 'rgba(239,71,111,0.15)')
        : (open ? 'rgba(142,202,230,0.08)' : 'rgba(239,71,111,0.08)');
      roundRect(ctx, L.x0 - 6, y, L.cw * L.cols + 12, L.fh - 2, 3);
      ctx.fill();
      ctx.strokeStyle = hovered ? '#ffffff' : target
        ? (open ? 'rgba(255,183,3,0.9)' : 'rgba(239,71,111,0.9)')
        : (open ? 'rgba(142,202,230,0.48)' : 'rgba(239,71,111,0.55)');
      ctx.lineWidth = hovered ? 3 : target ? 2 : 1;
      ctx.setLineDash(hovered || target ? [] : [4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = target ? (open ? '#ffcf55' : '#ff8da6') : (open ? '#a9d8ef' : '#ff9ab0');
      ctx.textAlign = 'right';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText(target ? (open ? 'TARGET' : 'TARGET FULL') : (open ? 'VALID' : 'FULL'), L.x0 + L.cw * L.cols + 2, y + L.fh * 0.68);
    }
  }

  function drawServiceFocus(focus, state, L, floorIndex = null) {
    const floors = serviceFocusFloors(focus, state, config);
    if (!floors.length) return;
    const changed = new Set(focus.changedFloors ?? []);
    const coverage = serviceFocusCoverage(focus, state, config, floorIndex);
    for (const floor of floors) {
      const y = L.floorY(floor);
      const isFacilityFloor = floor === focus.floor;
      const isChanged = changed.has(floor);
      const uncoveredRooms = coverage?.uncoveredRoomsByFloor?.[floor] ?? 0;
      const hasUncovered = uncoveredRooms > 0;
      ctx.fillStyle = hasUncovered
        ? 'rgba(239,71,111,0.14)'
        : isChanged
        ? 'rgba(255,183,3,0.12)'
        : 'rgba(142,202,230,0.07)';
      roundRect(ctx, L.x0 - 6, y, L.cw * L.cols + 12, L.fh - 2, 3);
      ctx.fill();
      ctx.strokeStyle = hasUncovered
        ? '#ef476f'
        : isChanged || isFacilityFloor
        ? '#ffb703'
        : 'rgba(142,202,230,0.58)';
      ctx.lineWidth = hasUncovered ? 2 : isFacilityFloor ? 3 : isChanged ? 2 : 1;
      ctx.setLineDash(hasUncovered || isFacilityFloor || isChanged ? [] : [5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = hasUncovered ? '#ff8da6' : isChanged || isFacilityFloor ? '#ffcf55' : '#a9d8ef';
      ctx.textAlign = 'right';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText(isFacilityFloor
        ? 'SERVICE ' + (coverage ? coverage.coveredRooms + '/' + coverage.requiredRooms : '')
        : hasUncovered ? 'UNCOVERED ' + uncoveredRooms : isChanged ? 'CHANGED' : 'COVERED', L.x0 + L.cw * L.cols + 2, y + L.fh * 0.68);
      if (isFacilityFloor && hasUncovered) {
        ctx.fillText('UNCOVERED ' + uncoveredRooms, L.x0 + L.cw * L.cols + 2, y + L.fh * 0.88);
      }
    }
  }

  function drawRouteTarget(target, state, L, hoverFloor) {
    if (!target) return;
    if (target.kind === 'car' && target.shaftId != null) {
      const shaft = state.shafts.find((candidate) => candidate.id === target.shaftId);
      if (!shaft) return;
      const x = L.x0 + shaft.slot * L.cw;
      const top = L.floorY(shaft.top);
      const bottom = L.floorY(shaft.bottom) + L.fh;
      const ready = (shaft.cars?.length ?? 0) < config.elevator.maxCarsPerShaft;
      ctx.strokeStyle = ready ? '#ffb703' : '#ef476f';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      roundRect(ctx, x, top - 1, L.cw, bottom - top, 5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ready ? '#ffcf55' : '#ff8da6';
      ctx.textAlign = 'center';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText(ready ? 'CAR READY' : 'CAR BLOCKED', x + L.cw / 2, top + 11);
      return;
    }
    if ((target.kind === 'stairs' || target.kind === 'escalator') && Number.isInteger(target.floor)) {
      if (target.floor < 0 || target.floor >= state.floors) return;
      const status = localRouteTargetStatus(target, state, config);
      const y = L.floorY(target.floor);
      const hovered = target.floor === hoverFloor;
      const ready = status.key === 'ready';
      const routeColor = target.kind === 'stairs' ? '#8ecae6' : '#f4a261';
      const fillColor = target.kind === 'stairs' ? 'rgba(142,202,230,0.14)' : 'rgba(244,162,97,0.14)';
      const accent = ready ? '#ffcf55' : '#ff8da6';

      // Show the endpoint across the whole floor, then show the first clear
      // column so the player can see both what is targeted and where it will go.
      ctx.fillStyle = ready ? fillColor : 'rgba(239,71,111,0.12)';
      roundRect(ctx, L.x0 - 6, y, L.cw * L.cols + 12, L.fh - 2, 4);
      ctx.fill();
      ctx.strokeStyle = !ready ? '#ef476f' : hovered ? '#ffffff' : routeColor;
      ctx.lineWidth = hovered ? 3 : 2;
      ctx.setLineDash([6, 4]);
      roundRect(ctx, L.x0 - 6, y, L.cw * L.cols + 12, L.fh - 2, 4);
      ctx.stroke();
      ctx.setLineDash([]);

      if (status.slot >= 0) {
        const x = L.x0 + status.slot * L.cw;
        const top = L.floorY(status.top);
        const bottom = L.floorY(status.bottom) + L.fh;
        ctx.strokeStyle = routeColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        roundRect(ctx, x + 2, top + 1, L.cw - 4, bottom - top - 2, 4);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = accent;
      ctx.textAlign = 'right';
      ctx.font = '700 8px ui-monospace, monospace';
      const label = target.kind === 'stairs' ? 'STAIRS' : 'ESCALATOR';
      ctx.fillText(label + (ready ? ' TARGET' : ' BLOCKED'), L.x0 + L.cw * L.cols + 2, y + L.fh * 0.68);
      return;
    }
    if (target.kind !== 'shaft' || !Number.isInteger(target.floor) || target.floor < 0 || target.floor >= state.floors) return;
    if (Number.isInteger(target.slot)) {
      const bottomFloor = config.building.lobbyFloor ?? 0;
      const topFloor = target.floor;
      const span = topFloor - bottomFloor + 1;
      const inBounds = target.slot >= 0 && target.slot < L.cols && topFloor > bottomFloor && span <= config.elevator.maxSpan;
      const clear = inBounds && Array.from({ length: span }, (_, index) => bottomFloor + index)
        .every((floor) => !slotsUsed(state, floor).has(target.slot));
      const x = L.x0 + target.slot * L.cw;
      const top = L.floorY(topFloor);
      const bottom = L.floorY(bottomFloor) + L.fh;
      ctx.strokeStyle = clear ? '#ffb703' : '#ef476f';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      roundRect(ctx, x + 2, top + 1, L.cw - 4, bottom - top - 2, 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = clear ? '#ffcf55' : '#ff8da6';
      ctx.textAlign = 'center';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText(clear ? 'SHAFT C' + (target.slot + 1) : 'BLOCKED', x + L.cw / 2, top + 11);
      return;
    }
    const y = L.floorY(target.floor);
    const hovered = target.floor === hoverFloor;
    const ready = target.floor > (config.building.lobbyFloor ?? 0) &&
      placementGuideFloorStatus({ kind: 'shaft', floor: target.floor }, target.floor, state, config) === 'open';
    ctx.strokeStyle = !ready ? '#ef476f' : hovered ? '#ffffff' : '#ffb703';
    ctx.lineWidth = hovered ? 3 : 2;
    ctx.setLineDash([6, 4]);
    roundRect(ctx, L.x0 - 6, y, L.cw * L.cols + 12, L.fh - 2, 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ready ? '#ffcf55' : '#ff8da6';
    ctx.textAlign = 'right';
    ctx.font = '700 8px ui-monospace, monospace';
    ctx.fillText(ready ? (target.recommended ? 'SHORTER READY' : 'ROUTE READY') : 'ROUTE BLOCKED', L.x0 + L.cw * L.cols + 2, y + L.fh * 0.68);
  }

  /** Sky shifts through the day. Cheap, and it makes a rush hour feel like one. */
  function paintSky(state) {
    // Four skies, not a single fade: dawn runs cool and pink, dusk runs
    // orange, so the two ends of the day do not read as the same event twice.
    const k = daylight(state.tod);
    const [top, low] = skyColors(state.tod);
    const g = ctx.createLinearGradient(0, -60, 0, H);
    g.addColorStop(0, 'rgb(' + top.join(',') + ')');
    g.addColorStop(0.72, 'rgb(' + low.join(',') + ')');
    g.addColorStop(1, BG);
    ctx.fillStyle = g;
    ctx.fillRect(-60, -60, W + 120, H + 120);

    if (k < 0.4) {
      const starAlpha = ((0.4 - k) / 0.4) * 0.8;
      ctx.fillStyle = 'rgba(219,228,238,' + starAlpha.toFixed(2) + ')';
      for (const [fx, sy] of STARS) {
        ctx.beginPath();
        ctx.arc(fx * W, sy, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const isDay = k > 0.5;
    const x = 40 + state.tod * (W - 80);
    const y = 26 + (1 - k) * 40;
    ctx.globalAlpha = isDay ? 0.92 : 0.8;
    ctx.fillStyle = isDay ? '#ffd76a' : '#cfd8e8';
    ctx.beginPath();
    ctx.arc(x, y, isDay ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    drawClouds(k);
    drawFlyers(k);
  }

  /** Clouds drift, and answer the camera by their depth so the sky behind a
   *  60-floor tower has some distance in it.
   *
   *  They scale with the zoom like everything else. They were drawn at a fixed
   *  size before, so zooming in grew the tower and left the sky the same —
   *  Keith, 2026-09-01: "the clouds and birds are not zooming with the map."
   *  Sky sits at effectively infinite distance, so the zoom magnifies it
   *  without moving it, the way a telescope does. */
  function drawClouds(k) {
    const lit = 0.35 + k * 0.5;
    const zoom = camera.zoom;
    for (const cloud of sky.clouds) {
      const x = cloudScreenXFor(cloud);
      if (x < -cloud.w * 2 * zoom || x > W + cloud.w * zoom) continue;
      const y = cloud.y * (0.6 + cloud.depth * 0.6);
      const scale = cloudScale(cloud.depth, zoom);
      ctx.globalAlpha = (0.25 + cloud.depth * 0.45) * (0.4 + k * 0.6);
      if (!sprites.drawSprite(ctx, { name: 'sky-cloud', animation: cloud.variant, x, y, scale: Math.max(1, Math.round(scale)) })) {
        // Placeholder: three overlapping lozenges read as a cloud at any size.
        ctx.fillStyle = 'rgb(' + [Math.round(190 * lit + 40), Math.round(200 * lit + 40), Math.round(215 * lit + 40)].join(',') + ')';
        const w = cloud.w * scale, h = w * 0.34;
        roundRect(ctx, x, y, w, h, h / 2);
        ctx.fill();
        roundRect(ctx, x + w * 0.18, y - h * 0.45, w * 0.5, h * 1.1, h * 0.55);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function cloudScreenXFor(cloud) {
    const span = W + cloud.w * 2;
    const raw = cloud.x + skyDrift * cloud.speed - camera.x * cloud.depth * 0.35;
    return ((raw % span) + span) % span - cloud.w;
  }

  /** Birds, planes, balloons — and once in a long while something worth
   *  pointing at. Sprites when they exist, shapes when they do not. */
  function drawFlyers(k) {
    const zoom = flyerScale(camera.zoom);
    for (const f of sky.flyers) {
      for (let i = 0; i < f.count; i++) {
        const o = f.offsets[i] ?? { dx: 0, dy: 0 };
        // Flock spacing and the bob scale too, or a flight of birds bunches
        // into one bird the moment you zoom in.
        const x = f.x - f.dir * o.dx * zoom;
        const y = f.y + (o.dy + Math.sin(f.bob + i) * 3) * zoom;
        if (x < -120 * zoom || x > W + 120 * zoom) continue;
        ctx.save();
        ctx.translate(x, y);
        if (f.dir < 0) ctx.scale(-1, 1);
        if (!sprites.drawSprite(ctx, { name: f.kind.sprite, animation: f.kind.animation, x: 0, y: 0, scale: zoom, phaseMs: i * 120 })) {
          ctx.scale(zoom, zoom);
          drawFlyerShape(f.kind.name, k);
        }
        ctx.restore();
      }
    }
  }

  function drawFlyerShape(name, k) {
    const ink = k > 0.4 ? 'rgba(24,32,44,0.85)' : 'rgba(190,205,225,0.8)';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1.5;
    if (name === 'bird') {
      ctx.beginPath();
      ctx.moveTo(-5, 0); ctx.quadraticCurveTo(-2, -4, 0, 0); ctx.quadraticCurveTo(2, -4, 5, 0);
      ctx.stroke();
      return;
    }
    if (name === 'stunt' || name === 'plane') {
      ctx.beginPath();
      ctx.moveTo(-10, 0); ctx.lineTo(6, 0); ctx.lineTo(10, -2); ctx.lineTo(6, -3); ctx.lineTo(-6, -3);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(-4, -8, 3, 8);
      if (name === 'stunt') {
        ctx.strokeStyle = 'rgba(236,138,74,0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(-12, -1); ctx.lineTo(-70, -1 + Math.sin(skyDrift * 2) * 4); ctx.stroke();
      }
      return;
    }
    // balloon, blimp, explorer: an envelope with something slung under it
    const r = name === 'blimp' ? 7 : 9;
    ctx.beginPath();
    if (name === 'blimp') { ctx.ellipse(0, 0, r * 2, r, 0, 0, Math.PI * 2); } else { ctx.arc(0, 0, r, 0, Math.PI * 2); }
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-3, r * 0.9); ctx.lineTo(3, r * 0.9);
    ctx.lineTo(2, r * 1.6); ctx.lineTo(-2, r * 1.6); ctx.closePath();
    ctx.fill();
  }

  // The street tile is the bottom 16 world px of the ground floor — half a
  // floor, which is exactly the 48x16 ground-street.png grid in
  // spec/asset-request.md. The rectangles below are the fallback on that same
  // grid: the geometry is the deliverable, the art lands on top of it.
  const STREET_H = 16;
  const streetHeight = (L) => STREET_H * L.zoom;

  /** Everything below the ground line. Earth today, B1..B10 once the sim
   *  carries a floor range (spec §3). */
  /** Floor names as the player says them: L, 1, 2 ... and B1, B2 below. */
  function floorLabel(f) {
    return f === 0 ? 'L' : isUnderground(f) ? 'B' + -f : String(f);
  }

  /** The parapet along the top of the tower. Slot 0 of the built span gets the
   *  antenna, because a skyline needs one thing sticking up. */
  function drawRoofCap(state, L) {
    const roof = (state?.floors ?? 0) - 1;
    if (roof < 0) return;
    const built = slotsUsed(state, roof);
    if (!built.size) return;
    const h = Math.max(2, Math.round(12 * L.zoom));
    const y = L.floorY(roof) - h;
    if (y > H || y + h < 0) return;
    let first = true;
    for (const slot of [...built].sort((a, b) => a - b)) {
      const x = L.x0 + slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;
      sprites.drawSprite(ctx, { name: 'roof-cap', animation: first ? 'antenna' : 'plain', x, y, scale: L.zoom });
      first = false;
    }
  }

  /** The foundation slab, drawn under the deepest storey so a dug tower reads
   *  as standing ON something instead of hanging in the soil. */
  function drawFoundation(state, L) {
    const bottom = Math.min(0, lowestFloor(state));
    const y = L.floorY(bottom) + L.fh;
    if (y < -20 || y > H + 20) return;
    const h = Math.max(2, Math.round(6 * L.zoom));
    for (let slot = 0; slot < L.cols; slot++) {
      const x = L.x0 + slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;
      if (sprites.drawSprite(ctx, { name: 'foundation-slab', animation: 'tile', x, y, scale: L.zoom })) continue;
      ctx.fillStyle = '#2a2520';
      ctx.fillRect(x, y, L.cw, h);
    }
  }

  /** The slab between one storey and the next, tiled across the span the
   *  building actually occupies. 48x4 art, so it scales with the zoom and
   *  simply does not draw when the sheet is absent — the 2px gap the storey
   *  rect already leaves is the fallback it always was. */
  function drawFloorSlab(L, low, high, y) {
    const h = Math.max(1, Math.round(4 * L.zoom));
    const slabY = y + L.fh - h;
    if (slabY > H || slabY + h < 0) return;
    for (let slot = low; slot <= high; slot++) {
      const x = L.x0 + slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;
      sprites.drawSprite(ctx, { name: 'floor-slab', animation: 'tile', x, y: slabY, scale: L.zoom });
    }
  }

  /**
   * Scaffold and dust over anything placed in the last half second. Three
   * frames, played from the placement rather than off the shared clock, so a
   * build that lands mid-cycle still starts at frame 0.
   *
   * The window comes from the sheet's own frame count and its speed in
   * `config.feel.sprites.fps`, so retiming construction stays a config edit.
   */
  function drawConstruction(L) {
    if (!landing.size) return;
    const anim = sprites.animation('slot-construction', 'building');
    if (!anim) { landing.clear(); return; }   // no sheet, nothing to play
    const windowMs = (anim.frames * 1000) / anim.fps;
    for (const [id, placed] of landing) {
      const age = sprites.elapsedMs - placed.at;
      if (!(age >= 0) || age >= windowMs) { landing.delete(id); continue; }
      const frame = Math.min(anim.frames - 1, Math.floor((age * anim.fps) / 1000));
      const x = L.x0 + placed.slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;
      for (let f = placed.bottom; f <= placed.top; f++) {
        const y = L.floorY(f);
        if (y + L.fh < 0 || y > H) continue;
        sprites.drawSprite(ctx, { name: 'slot-construction', animation: 'building', x, y, scale: L.zoom, frame });
      }
    }
  }

  /** The cut faces at either end of a dug storey, where the excavation stops
   *  and the soil starts. Drawn OUTSIDE the built span on purpose: the edge is
   *  earth, not a room, and putting it inside would eat a buildable slot. */
  function drawEarthEdges(L, low, high, y) {
    for (const slot of [low - 1, high + 1]) {
      if (slot < 0 || slot >= L.cols) continue;
      const x = L.x0 + slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;
      sprites.drawSprite(ctx, { name: 'earth-edge', animation: 'tile', x, y, scale: L.zoom });
    }
  }

  function drawEarth(L, state) {
    // Soil starts under the deepest dug storey; above that line the basements
    // are rooms, not dirt.
    const groundY = L.floorY(Math.min(0, lowestFloor(state))) + L.fh;
    if (groundY > H + 60) return;
    const top = Math.max(-60, groundY);

    // Tiled soil if the sheet is here. It is aligned to the world grid, not to
    // the screen, so the earth holds still while the camera moves over it.
    const tileW = SLOT_W * L.zoom, tileH = FLOOR_H * L.zoom;
    const firstX = L.x0 - Math.ceil((L.x0 + 60) / tileW) * tileW;
    const firstY = groundY + Math.floor((top - groundY) / tileH) * tileH;
    if (tileAcross('earth-fill', 'tile', firstX, firstY, W + 60, H + 60, tileW, tileH)) return;

    const soil = ctx.createLinearGradient(0, groundY, 0, groundY + H + 120);
    soil.addColorStop(0, '#3b2d21');
    soil.addColorStop(1, '#150f0b');
    ctx.fillStyle = soil;
    ctx.fillRect(-60, top, W + 120, H + 120 - top);

    // One stratum per floor height, so depth reads at any zoom and the future
    // basements already have their grid drawn under them.
    const step = FLOOR_H * L.zoom;
    if (step >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 1;
      for (let y = groundY + step; y < H + 60; y += step) {
        if (y < -60) continue;
        ctx.beginPath();
        ctx.moveTo(-60, Math.round(y) + 0.5);
        ctx.lineTo(W + 60, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }
  }

  /** Sidewalk, curb, and the ground line itself. */
  function drawStreet(L, skipSlots = null) {
    const groundY = L.y0;
    const sh = streetHeight(L);
    const streetTop = groundY - sh;
    if (streetTop < H && groundY > -sh) {
      const paveW = SLOT_W * L.zoom;
      const firstPave = L.x0 - Math.ceil((L.x0 + 60) / paveW) * paveW;
      // A slot the lobby stands in is its own ground; paving it too would run
      // the curb line straight through the entrance.
      const skipX = new Set();
      if (skipSlots) for (const slot of skipSlots) skipX.add(Math.round(L.x0 + slot * L.cw));
      if (tileAcross('ground-street', 'tile', firstPave, streetTop, W + 60, groundY, paveW, sh, skipX)) {
        drawGroundLine(groundY);
        return;
      }
      ctx.fillStyle = '#48525e';
      ctx.fillRect(-60, streetTop, W + 120, sh);
      // Paving joints on the 48 px art grid, so the placeholder tiles exactly
      // where ground-street.png will.
      const tile = SLOT_W * L.zoom;
      if (tile >= 10) {
        ctx.strokeStyle = 'rgba(18,24,32,0.55)';
        ctx.lineWidth = 1;
        const first = L.x0 - Math.ceil((L.x0 + 60) / tile) * tile;
        for (let x = first; x < W + 60; x += tile) {
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, streetTop + 1);
          ctx.lineTo(Math.round(x) + 0.5, groundY - 1);
          ctx.stroke();
        }
      }
      // Curb above, gutter below: the two edges that turn a grey band into a
      // street rather than another floor.
      ctx.fillStyle = '#69747f';
      ctx.fillRect(-60, streetTop, W + 120, Math.max(1, L.zoom));
      ctx.fillStyle = '#20262e';
      ctx.fillRect(-60, groundY - Math.max(1, L.zoom * 2), W + 120, Math.max(1, L.zoom * 2));
    }
    drawGroundLine(groundY);
  }

  /** World y = 0, drawn as a line. Whether the street above it is painted or
   *  tiled, the horizon itself is the same stroke. */
  function drawGroundLine(groundY) {
    ctx.strokeStyle = PANEL;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-60, groundY + 1);
    ctx.lineTo(W + 60, groundY + 1);
    ctx.stroke();
  }

  /** The minimap strip: one row per floor, colored by the pressure signals the
   *  main view already computes, with a box marking what it is looking at. */
  function drawMinimap(state, L) {
    if (!W || !H) return;
    // Rows span the whole tower, basements included, so a dug storey shows up
    // on the strip the moment it exists rather than only in the main view.
    const bottom = Math.min(0, lowestFloor(state));
    const rows = Math.max(1, state.floors - bottom);
    const m = minimapMetrics(viewport(), rows, L.cols, bottom);
    ctx.fillStyle = 'rgba(10,13,18,0.86)';
    roundRect(ctx, m.x - m.pad, m.y - m.pad, m.w + m.pad * 2, m.h + m.pad * 2, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(142,202,230,0.32)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const cells = new Map();
    const mark = (floor, slot, color) => {
      if (floor < bottom || floor >= state.floors || slot < 0 || slot >= m.cols) return;
      if (!cells.has(floor)) cells.set(floor, new Map());
      cells.get(floor).set(slot, color);
    };
    for (const u of state.units) mark(u.floor, u.slot, u.occupied ? KIND[u.kind] : 'rgba(140,150,165,0.55)');
    for (const facility of state.facilities ?? []) mark(facility.floor, facility.slot, '#b388ff');
    for (const route of [...(state.stairs ?? []), ...(state.escalators ?? [])]) {
      for (let f = route.bottom; f <= route.top; f++) mark(f, route.slot, 'rgba(142,202,230,0.45)');
    }
    for (const shaft of state.shafts) {
      for (let f = shaft.bottom; f <= shaft.top; f++) mark(f, shaft.slot, shaft.kind === 'express' ? '#c77dff' : '#5aa9e6');
    }
    for (const slot of state.lobby?.slots ?? (state.lobby ? [state.lobby.slot] : [])) {
      mark(config.building.lobbyFloor ?? 0, slot, '#5aa9e6');
    }

    const waiting = new Map();
    for (const person of state.people) {
      if (person.state !== 'waiting') continue;
      waiting.set(person.from, (waiting.get(person.from) ?? 0) + 1);
    }

    const gridX = m.x + m.gutter;
    for (let f = bottom; f < state.floors; f++) {
      const y = minimapRowY(m, f);
      // Below ground reads as earth on the strip too, so depth is legible at a
      // glance instead of looking like more tower.
      ctx.fillStyle = isUnderground(f) ? 'rgba(59,45,33,0.85)' : 'rgba(27,36,48,0.85)';
      ctx.fillRect(gridX, y, m.cellW * m.cols, m.rowH);
      const row = cells.get(f);
      if (row) for (const [slot, color] of row) {
        ctx.fillStyle = color;
        ctx.fillRect(gridX + slot * m.cellW, y, m.cellW, m.rowH);
      }
      // The pressure gutter. This is the whole point of the strip: a queue
      // building on F41 has to be visible while you are looking at F3.
      const pressure = waitingPressure(waiting.get(f) ?? 0);
      ctx.globalAlpha = 0.3 + pressure.ratio * 0.7;
      ctx.fillStyle = indicatorColor(pressure.colorKey);
      ctx.fillRect(m.x, y, m.gutter - 1, m.rowH);
      ctx.globalAlpha = 1;
    }

    const rect = visibleWorldRect(camera, viewport());
    const high = Math.min(rows - 1, Math.max(0, floorAtWorldY(rect.top)));
    const low = Math.min(high, Math.max(0, floorAtWorldY(rect.bottom)));
    const clampSlot = (worldX) => Math.min(m.cols, Math.max(0, worldX / SLOT_W));
    const boxX = gridX + clampSlot(rect.left) * m.cellW;
    const boxRight = gridX + clampSlot(rect.right) * m.cellW;
    const boxTop = minimapRowY(m, high);
    const boxBottom = minimapRowY(m, low) + m.rowH;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(boxX) + 0.5, Math.round(boxTop) + 0.5,
      Math.max(2, Math.round(boxRight - boxX) - 1), Math.max(2, Math.round(boxBottom - boxTop) - 1));

    // The zoom level, above the strip. A camera nobody can see the state of is
    // a camera nobody trusts.
    ctx.fillStyle = 'rgba(142,202,230,0.7)';
    ctx.textAlign = 'right';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.fillText(camera.zoom + 'x', m.x + m.w, m.y - m.pad - 5);
  }

  function drawUnit(u, L, state, floorIndex = null) {
    const x = L.x0 + u.slot * L.cw, y = L.floorY(u.floor);
    if (x + L.cw < 0 || x > W || y + L.fh < 0 || y > H) return;
    const tune = config.units[u.kind];

    // The art first. Everything below this line is the fallback the renderer
    // drew before there was any, and it stays because a sheet can always be
    // missing — an unfinished subject must cost a rectangle, not a blank room.
    const art = unitSprite(u, state);
    // An empty room has to READ as empty. The art's own "vacant" frame still
    // has desks and figures in it, so at a glance a room waiting for a tenant
    // looks exactly like one full of them — Keith, 2026-09-01: "rooms fill up
    // with 6/6 tenants, need an empty / for-lease graphic." Until the art has
    // a real empty shell, the renderer says it: the room is dimmed towards the
    // night sky and carries a FOR LEASE tag instead of a tenant count.
    if (!u.occupied) ctx.globalAlpha = 0.42;
    const drew = art && sprites.drawSprite(ctx, { ...art, x, y, scale: L.zoom, phaseMs: idPhase(u.id) });
    ctx.globalAlpha = 1;
    if (drew) {
      if (!u.occupied) {
        drawVacancyTag(x, y, L);
        return;
      }
      if (u.occupied) {
        const stressed = Math.min(1, u.stress / tune.vacateAt);
        if (stressed > 0.02) {
          ctx.fillStyle = stressed > 0.66 ? BAD : WARN;
          ctx.fillRect(x + 2, y + L.fh - 7, (L.cw - 4) * stressed, 2);
        }
      }
      drawTenantBadge(u, x, y, L);
      return;
    }

    if (!u.occupied) {
      ctx.fillStyle = 'rgba(120,130,145,0.16)';
      roundRect(ctx, x + 2, y + 3, L.cw - 4, L.fh - 8, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,130,145,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(174,189,202,0.65)';
      ctx.textAlign = 'center';
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.fillText('EMPTY', x + L.cw / 2, y + L.fh * 0.58);
      drawTenantBadge(u, x, y, L);
      return;
    }

    const evaluation = unitEvaluation(state, u, config, floorIndex);
    const quality = 1 - evaluation.score / 100;
    const stress = Math.min(1, u.stress / tune.vacateAt);
    ctx.fillStyle = quality > 0.05 ? mix(KIND[u.kind], BAD, quality) : KIND[u.kind];
    ctx.globalAlpha = 0.86;
    roundRect(ctx, x + 2, y + 3, L.cw - 4, L.fh - 8, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Tenant patience, made visible along the bottom edge.
    if (stress > 0.02) {
      ctx.fillStyle = stress > 0.66 ? BAD : WARN;
      ctx.fillRect(x + 2, y + L.fh - 7, (L.cw - 4) * stress, 2);
    }

    drawTenantBadge(u, x, y, L);
  }

  /** FOR LEASE, over an empty room. Shortened before it is squeezed: an
   *  unreadable tag is worse than a shorter word. */
  function drawVacancyTag(x, y, L) {
    if (L.fh < 14) return;
    const k = L.zoom >= 3 ? 1.25 : L.zoom >= 2 ? 1 : 0.75;
    const text = L.cw >= 84 ? 'FOR LEASE' : L.cw >= 60 ? 'LEASE' : 'TO LET';
    const w = Math.min(L.cw - 6 * k, text.length * 5.6 * k + 10 * k);
    const h = 11 * k;
    const bx = x + (L.cw - w) / 2;
    const by = y + L.fh / 2 - h / 2;
    ctx.fillStyle = 'rgba(14,17,22,0.82)';
    roundRect(ctx, bx, by, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = WARN;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = WARN;
    ctx.textAlign = 'center';
    ctx.font = '700 ' + Math.round(8 * k) + 'px ui-monospace, monospace';
    ctx.fillText(text, x + L.cw / 2, by + h * 0.78);
  }

  // The room color communicates quality; this small badge communicates how
  // many tenants occupy the room, which is a different decision signal.
  /**
   * The tenant count, over the room. It is drawn in SCREEN pixels on purpose —
   * a signal the player reads should not shrink to nothing just because they
   * zoomed out — but at 1x a floor is only 32 px tall, and a fixed 13 px badge
   * eats half the room it is annotating. So it scales down with the zoom and
   * gives up below the point where its text would be unreadable anyway: the
   * room's own colour still carries the health signal, which is the one that
   * matters at a glance.
   */
  function drawTenantBadge(u, x, y, L) {
    const k = L.zoom >= 3 ? 1.35 : L.zoom >= 2 ? 1 : 0.72;
    if (L.fh < 18) return;
    const load = tenantLoadStatus(u, config);
    const loadColor = indicatorColor(load.colorKey);
    const badgeText = tenantBadgeText(u, config);
    const font = Math.round(8 * k);
    const badgeH = Math.round(13 * k);
    const badgeW = Math.max(27 * k, badgeText.length * 6 * k + 10 * k);
    const badgeX = x + L.cw - badgeW - 5 * k;
    const badgeY = y + 5 * k;
    ctx.fillStyle = 'rgba(14,17,22,0.72)';
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3);
    ctx.fill();
    ctx.strokeStyle = loadColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = loadColor;
    ctx.textAlign = 'center';
    ctx.font = '700 ' + font + 'px ui-monospace, monospace';
    ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH * 0.73);
  }

  /**
   * Every room's departure wick, in one pass.
   *
   * It is a pass of its own rather than part of `drawUnit` because of WHERE it
   * has to land in the frame: a deep queue draws a crowd across the bottom
   * half of the floor, which is exactly where the wick's fill grows from. Drawn
   * with the room, a room one day from empty would be hidden behind the very
   * congestion that is a different problem with a different fix. The warning
   * goes over the decoration — legibility beats charm.
   */
  function drawDepartureWicks(state, L, visible) {
    for (const u of state.units) {
      if (visible && (u.floor < visible.low || u.floor > visible.high)) continue;
      const x = L.x0 + u.slot * L.cw, y = L.floorY(u.floor);
      if (x + L.cw < 0 || x > W || y + L.fh < 0 || y > H) continue;
      drawDepartureWick(u, x, y, L);
    }
  }

  /**
   * The departure wick: a countdown to this tenant walking out over room
   * appeal, burning UP the room's left edge (issue #10).
   *
   * Silent on healthy rooms — a room only grows a wick once the sim has
   * actually started charging it pressure, so the eye finds the handful of
   * rooms in trouble instead of scanning a tower of always-on markers.
   *
   * Height and position carry the signal. Colour reinforces it and nothing
   * more, because the room's own pixels are already colour-coded twice — by
   * type and by quality — which is precisely why the old red appeal fade never
   * reached anyone: it tinted the same pixels that say "this is an office".
   */
  function drawDepartureWick(u, x, y, L) {
    const ratio = departureWickRatio(u, config);
    if (ratio <= 0) return;
    const box = departureWickBox(x, y, L);
    if (!box) return;

    // The unlit track is half the signal: it is the dedicated edge, and it
    // says "a countdown is running here" before the fill is tall enough to
    // read on its own.
    ctx.fillStyle = 'rgba(10,13,18,0.86)';
    ctx.fillRect(box.x, box.y, box.w, box.h);

    const burn = mix(WARN, BAD, ratio);
    const fillH = Math.max(2, Math.round(box.h * ratio));
    ctx.fillStyle = burn;
    ctx.fillRect(box.x, box.y + box.h - fillH, box.w, fillH);

    // One notch per day of pressure, so the fill can be COUNTED and not only
    // felt: three notches lit of four is "one day left", which is the whole
    // difference between a warning and a score.
    const steps = Math.max(1, Math.round(Number(config?.occupancy?.desirabilityRetentionVacateAt) || 1));
    const stepH = box.h / steps;
    if (stepH >= 4) {
      ctx.fillStyle = 'rgba(10,13,18,0.9)';
      for (let i = 1; i < steps; i++) ctx.fillRect(box.x, Math.round(box.y + box.h - i * stepH), box.w, 1);
    }

    // The last day gets a lit edge rather than a new colour, so a tenant about
    // to go reads differently from one that merely started slipping. Alpha is
    // driven by the render clock, which is decoration: the tower plays
    // identically with it frozen.
    const critical = ratio >= 1 - 1 / steps;
    ctx.globalAlpha = critical ? 0.6 + 0.4 * Math.abs(Math.sin(sprites.elapsedMs / 420)) : 0.5;
    ctx.strokeStyle = critical ? BAD : burn;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.globalAlpha = 1;
  }

  /**
   * The appeal overlay (issue #12): every room tinted by its appeal score, on
   * a key, never always-on. It deliberately paints OVER the normal read of the
   * building — while it is up, appeal is the only question being asked.
   *
   * This is the one pass that pays for `unitEvaluation()` on every room every
   * frame. That is the cost the fallback rectangles used to carry all the
   * time; here it is only paid while the player is holding the view open, and
   * only for the rooms actually on screen.
   */
  function drawAppealOverlay(state, L, floorIndex, visible) {
    if (!appealOverlay) return;
    for (const u of state.units) {
      if (visible && (u.floor < visible.low || u.floor > visible.high)) continue;
      const x = L.x0 + u.slot * L.cw, y = L.floorY(u.floor);
      if (x + L.cw < 0 || x > W || y + L.fh < 0 || y > H) continue;
      const band = appealOverlayBand(roomDesirabilityScore(unitEvaluation(state, u, config, floorIndex), config), config);
      if (!band) continue;
      // Nearly opaque on purpose. At 0.66 the room art read through the tint
      // and two rooms twenty points apart looked the same, which is the exact
      // failure the overlay exists to fix — while it is up, appeal is the only
      // thing being asked, and the furniture can wait.
      ctx.fillStyle = mix(GOOD, BAD, band.ratio);
      ctx.globalAlpha = 0.88;
      ctx.fillRect(x + 1, y + 1, L.cw - 2, L.fh - 4);
      ctx.globalAlpha = 1;
      if (L.fh >= 22 && L.cw >= 26) {
        // The number, so the tint can be READ and not only compared. Dark on
        // the tint: every colour on the GOOD->BAD ramp is light enough to
        // carry near-black, and none of them is light enough to carry white.
        ctx.fillStyle = 'rgba(10,13,18,0.9)';
        ctx.textAlign = 'center';
        ctx.font = '700 ' + Math.round(10 * Math.min(1.4, L.zoom)) + 'px ui-monospace, monospace';
        ctx.fillText(String(band.score), x + L.cw / 2, y + L.fh * 0.62);
      }
    }
    // Screen furniture, so the mode is never a thing you are in without
    // knowing it. Drawn in the world pass because it is anchored to the tower
    // it is describing, not to the viewport.
    ctx.fillStyle = 'rgba(10,13,18,0.86)';
    roundRect(ctx, 10, H - 30, 132, 20, 3);
    ctx.fill();
    ctx.strokeStyle = INFO;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = INFO;
    ctx.textAlign = 'left';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.fillText('APPEAL VIEW · 0—100', 18, H - 16);
  }

  function drawShaft(sh, L, dtMs, state, shaftQueueHistory = null, focused = false, hovered = false) {
    const x = L.x0 + sh.slot * L.cw;
    const top = L.floorY(sh.top), bot = L.floorY(sh.bottom) + L.fh;
    if (x + L.cw < 0 || x > W || bot < 0 || top > H) return;
    const express = sh.kind === 'express';

    // The shaft column, one art tile per storey, inside the building's own
    // shell — the sheet has been in the repo since the first art drop and
    // nothing had ever asked for it.
    let drewColumn = false;
    if (!express && sprites.has('shaft-column', 'tile')) {
      drewColumn = true;
      for (let f = sh.bottom; f <= sh.top; f++) {
        const fy = L.floorY(f);
        if (fy + L.fh < 0 || fy > H) continue;
        sprites.drawSprite(ctx, { name: 'slot-empty', animation: 'empty', x, y: fy, scale: L.zoom });
        if (!sprites.drawSprite(ctx, { name: 'shaft-column', animation: 'tile', x, y: fy, scale: L.zoom })) drewColumn = false;
      }
    }
    if (!drewColumn) {
      ctx.fillStyle = express ? 'rgba(24,13,36,0.92)' : 'rgba(8,11,15,0.9)';
      roundRect(ctx, x + 3, top + 1, L.cw - 6, bot - top - 2, 4);
      ctx.fill();
    }
    ctx.strokeStyle = express ? 'rgba(199,125,255,0.55)' : 'rgba(142,202,230,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (express) {
      // Sky-lobby landings: the only two floors this shuttle serves. Everything
      // between is deliberately skipped, and the dashed spine says so.
      ctx.strokeStyle = 'rgba(199,125,255,0.45)';
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(x + L.cw / 2, top + 4);
      ctx.lineTo(x + L.cw / 2, bot - 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#c77dff';
      for (const landing of [sh.bottom, sh.top]) {
        const y = L.floorY(landing);
        ctx.fillRect(x + 4, y + L.fh - 5, L.cw - 8, 3);
      }
      ctx.textAlign = 'center';
      ctx.font = '700 7px ui-monospace, monospace';
      ctx.fillText('EXP', x + L.cw / 2, top + 9);
    }
    if (focused || hovered) {
      ctx.strokeStyle = focused ? '#ffcf55' : '#ffffff';
      ctx.lineWidth = focused ? 3 : 2;
      roundRect(ctx, x + 1, top, L.cw - 2, bot - top, 4);
      ctx.stroke();
    }

    for (const car of sh.cars) {
      const want = L.floorY(car.y) + 3;
      const cur = smooth.has(car.id) ? smooth.get(car.id) : want;
      const next = lerp(cur, want, Math.min(1, dtMs / config.feel.tweenMs));
      smooth.set(car.id, next);

      const full = car.riders.length /
        (express ? (config.elevator.express?.capacity ?? config.elevator.capacity) : config.elevator.capacity);
      // The car itself. Doors open while it is loading, shut while it moves —
      // which is the single clearest read of what a lift is doing.
      const carSheet = express ? 'elevator-car-express' : 'elevator-car';
      const doorState = car.state === 'doors' ? 'open' : 'closed';
      const drewCar = sprites.drawSprite(ctx, {
        name: carSheet, animation: doorState,
        x: x + (L.cw - 40 * L.zoom) / 2, y: next, scale: L.zoom,
      });
      if (!drewCar) {
        ctx.fillStyle = car.state === 'doors' ? GOOD : mix(INFO, WARN, full);
        roundRect(ctx, x + 5, next, L.cw - 10, L.fh - 8, 3);
        ctx.fill();
      }

      if (car.riders.length) {
        ctx.fillStyle = '#0e1116';
        ctx.textAlign = 'center';
        ctx.font = '700 10px ui-monospace, monospace';
        ctx.fillText(String(car.riders.length), x + L.cw / 2, next + L.fh * 0.52);
      }
    }

    // The inspector gives the selected shaft a detailed readout; this compact
    // badge keeps a selected or hovered shaft's queue pressure visible while
    // the player is comparing routes on the building itself. It uses the same
    // W count and color bands as the floor badges and shaft inspector.
    if (focused || hovered) {
      const waiting = state.people.filter((person) => person.state === 'waiting' && person.shaft === sh.id).length;
      const pressure = waitingPressure(waiting);
      const history = shaftQueueHistory instanceof Map ? shaftQueueHistory.get(sh.id) : null;
      const trendMarker = shaftQueueTrendMarker(history);
      const badgeText = shaftWaitingBadgeText(state.shafts.indexOf(sh) + 1, waiting) + (trendMarker ? ' ' + trendMarker : '');
      const badgeW = Math.max(30, badgeText.length * 6 + 10), badgeH = 14;
      const rightX = x + L.cw + 4;
      const badgeX = rightX + badgeW <= W ? rightX : Math.max(2, x - badgeW - 4);
      const badgeY = Math.max(2, top + 4);
      ctx.fillStyle = indicatorColor(pressure.colorKey);
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      ctx.strokeStyle = focused ? '#ffcf55' : '#ffffff';
      ctx.lineWidth = focused ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = '#0e1116';
      ctx.textAlign = 'center';
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 10);
    }
  }

  /** The queue: a line of dots on the landing, reddening and jittering as the
   *  wait grows. This is the readout the whole design depends on. */
  /**
   * One waiting rider, standing on the queue line. Returns false when there is
   * no sheet for them, which puts the dot back — the crowd is a reskin of the
   * dot row, never a replacement for the signal it carries.
   */
  function drawWaitingPerson(p, heat, centerX, feetY, L) {
    const name = personSheet(p.kind);
    const sheet = sprites.sheetFor(name);
    if (!sheet) return false;
    const w = sheet.frameW * L.zoom, h = sheet.frameH * L.zoom;
    const beat = Math.floor((sprites.elapsedMs + idPhase(p.id)) / 520) % 2;
    return sprites.drawSprite(ctx, {
      name, animation: waitingPose(heat, beat),
      x: centerX - w / 2, y: feetY - h, scale: L.zoom,
    });
  }

  function drawQueues(state, L, selectedShaftId = null, visible = null) {
    const byFloor = new Map();
    for (const p of state.people) {
      if (p.state !== 'waiting') continue;
      if (!byFloor.has(p.from)) byFloor.set(p.from, []);
      byFloor.get(p.from).push(p);
    }
    const selectedOriginFloors = new Set(shaftQueueOriginFloors(state, selectedShaftId));
    const unassignedOriginFloors = new Set(unassignedQueueOriginFloors(state));

    // Every floor gets a count badge, including a green 0. This makes the
    // amount of waiting visible before a queue is large enough to form a bar.
    const low = visible ? visible.low : 0;
    const high = visible ? visible.high : state.floors - 1;
    for (let floor = low; floor <= high; floor++) {
      const queue = byFloor.get(floor) || [];
      const pressure = waitingPressure(queue.length);
      const badgeText = waitingBadgeText(queue.length);
      const badgeW = Math.max(32, badgeText.length * 6 + 10), badgeH = 14;
      const badgeX = Math.max(2, L.x0 - badgeW - 18);
      const badgeY = L.floorY(floor) + L.fh * 0.28;
      ctx.fillStyle = indicatorColor(pressure.colorKey);
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      if (unassignedOriginFloors.has(floor)) {
        ctx.strokeStyle = BAD;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (selectedOriginFloors.has(floor)) {
        ctx.strokeStyle = '#ffcf55';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = '#0e1116';
      ctx.textAlign = 'center';
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 10);
    }

    for (const [floor, queue] of byFloor) {
      if (floor < low || floor > high) continue;
      const y = L.floorY(floor) + L.fh - 9;
      queue.sort((a, b) => b.waitT - a.waitT);

      // Crowd bar FIRST. A per-person dot row caps out and then stops growing,
      // so a 276-deep queue rendered as the same thin line as a 22-deep one and
      // the tower looked healthy at a glance. Depth has to be visible as mass.
      const pressure = waitingPressure(queue.length);
      const depth = pressure.ratio;
      if (queue.length > 4) {
        ctx.globalAlpha = 0.22 + depth * 0.5;
        ctx.fillStyle = mix(GOOD, BAD, depth);
        const barW = (L.cw * L.cols - 8) * Math.min(1, queue.length / 90);
        roundRect(ctx, L.x0 + 2, y - 5, Math.max(6, barW), 10, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // People, standing ON the crowd bar rather than over it — the bar's
      // LENGTH is the depth signal and a 276-deep queue must never read like a
      // 22-deep one again, so the figures are not allowed to hide it.
      //
      // A figure is wider than a dot, so the row is spaced for whichever is
      // being drawn. Everything beyond the row still rolls into "+N waiting".
      const crowd = crowdBudget > 0 && sprites.has('person-worker', 'stand');
      const step = crowd ? Math.max(6, 9 * L.zoom) : 5.5;
      const shown = Math.min(queue.length, 26, Math.max(1, Math.floor((L.cw * L.cols - 12) / step)));
      for (let i = 0; i < shown; i++) {
        const p = queue[i];
        const heat = Math.min(1, p.waitT / config.demand.abandonAfter);
        const cx = L.x0 + 6 + i * step;
        if (crowd && crowdBudget > 0 && drawWaitingPerson(p, heat, cx, y + 5, L)) { crowdBudget--; continue; }
        ctx.fillStyle = mix(GOOD, BAD, heat);
        const bob = Math.sin((p.waitT + i) * 3) * (heat * 1.8);
        ctx.beginPath();
        ctx.arc(cx, y + bob, 2.4 + heat * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (queue.length > shown) {
        // Dark on the crowd bar: the count was drawn in the same red as the bar
        // it sits on, which made the loudest number on screen unreadable.
        ctx.fillStyle = queue.length > 4 ? '#12161c' : BAD;
        ctx.textAlign = 'left';
        ctx.font = '700 13px ui-monospace, monospace';
        ctx.fillText('+' + (queue.length - shown) + ' waiting', L.x0 + 12 + shown * step, y + 5);
      }
    }
  }

  /** Screen position of a unit, so the UI can throw a floater at it. */
  function unitPos(state, u) {
    const L = layout(state);
    return [L.x0 + u.slot * L.cw + L.cw / 2, L.floorY(u.floor)];
  }

  /** Which floor a click landed on, for build placement. */
  /** The floor under a point, or **null** when the point is not on the tower.
   *  Not -1: that is B1 now, and a sentinel that collides with a real floor is
   *  how a click in the earth ends up digging. */
  function floorAt(state, px, py) {
    const L = layout(state);
    const f = Math.floor((L.y0 - py) / L.fh);
    return f >= lowestFloor(state) && f < state.floors ? f : null;
  }

  /** Which floor slot a click landed in, for ground-floor lobby placement. */
  function slotAt(state, px) {
    const L = layout(state);
    const slot = Math.floor((px - L.x0) / L.cw);
    return slot >= 0 && slot < L.cols ? slot : -1;
  }

  /** Which unit a player clicked, including an abandoned unit. */
  function unitAt(state, px, py) {
    const L = layout(state);
    for (const u of state.units) {
      const x = L.x0 + u.slot * L.cw, y = L.floorY(u.floor);
      if (px >= x && px <= x + L.cw && py >= y && py <= y + L.fh) return u.id;
    }
    return null;
  }

  /** Which built service facility a player clicked, for direct inspection. */
  function facilityAt(state, px, py) {
    const L = layout(state);
    for (const facility of state.facilities ?? []) {
      const x = L.x0 + facility.slot * L.cw, y = L.floorY(facility.floor);
      if (px >= x && px <= x + L.cw && py >= y && py <= y + L.fh) return facility.id;
    }
    return null;
  }

  /**
   * The underground art for a facility, or null to keep the coloured box.
   *
   * Only the two kinds the delivered sheets honestly depict. Parking is the
   * whole reason to dig, and its three frames are empty / one car / two cars.
   * Recycling is the building's plant — `config.services` calls it "a local
   * utility" in as many words — and `basement-utility` is a plant room with a
   * working indicator. A clinic or a security desk drawn as boilers would be a
   * lie, so those keep the labelled box until they have art of their own.
   */
  function facilitySprite(facility, state) {
    if (!isUnderground(facility.floor)) return null;
    if (facility.kind === 'parking') {
      // The bay fills through the working day and empties overnight. Driven by
      // tod alone: the sim counts no cars, so this cannot be wrong about them.
      const day = dayness(state);
      return { name: 'basement-parking', animation: day > 0.55 ? 'two-cars' : day > 0.15 ? 'one-car' : 'empty' };
    }
    if (facility.kind === 'recycling') return { name: 'basement-utility', animation: 'idle' };
    return null;
  }

  function drawFacility(facility, L, state, focused = false, hovered = false) {
    const x = L.x0 + facility.slot * L.cw, y = L.floorY(facility.floor);
    if (x + L.cw < 0 || x > W || y + L.fh < 0 || y > H) return;

    const art = facilitySprite(facility, state);
    if (art && sprites.drawSprite(ctx, { ...art, x, y, scale: L.zoom, phaseMs: idPhase(facility.id) })) {
      if (focused || hovered) {
        ctx.strokeStyle = focused ? '#ffcf55' : '#ffffff';
        ctx.lineWidth = focused ? 3 : 2;
        roundRect(ctx, x + 1, y + 2, L.cw - 2, L.fh - 6, 4);
        ctx.stroke();
      }
      // The label survives the reskin on a plate of its own. A drawn plant
      // room and a coloured box have to read as the same thing to the player
      // deciding what coverage they still need.
      facilityLabel(facility, x, y, L, true);
      return;
    }

    ctx.fillStyle = facility.kind === 'parking' ? '#f4a261'
      : facility.kind === 'security' ? '#e76f51'
        : facility.kind === 'recycling' ? '#2a9d8f' : '#b388ff';
    ctx.globalAlpha = 0.88;
    roundRect(ctx, x + 2, y + 3, L.cw - 4, L.fh - 8, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (focused || hovered) {
      ctx.strokeStyle = focused ? '#ffcf55' : '#ffffff';
      ctx.lineWidth = focused ? 3 : 2;
      roundRect(ctx, x + 1, y + 2, L.cw - 2, L.fh - 6, 4);
      ctx.stroke();
    }
    facilityLabel(facility, x, y, L, false);
  }

  /** What a facility is, in four letters. Over art it gets a dark plate so it
   *  stays readable; over the coloured box it is the box's own dark text. */
  function facilityLabel(facility, x, y, L, overArt) {
    const label = facility.kind === 'food' ? 'FOOD'
      : facility.kind === 'parking' ? 'PARK'
      : facility.kind === 'medical' ? 'MED'
        : facility.kind === 'security' ? 'SEC'
          : facility.kind === 'recycling' ? 'REC' : facility.kind.toUpperCase();
    ctx.textAlign = 'center';
    ctx.font = '700 8px ui-monospace, monospace';
    if (overArt) {
      const w = label.length * 6 + 10, h = 11;
      ctx.fillStyle = 'rgba(10,13,18,0.82)';
      roundRect(ctx, x + (L.cw - w) / 2, y + L.fh - h - 5, w, h, 2);
      ctx.fill();
      ctx.fillStyle = '#e6d5b8';
      ctx.fillText(label, x + L.cw / 2, y + L.fh - 7);
      return;
    }
    ctx.fillStyle = '#241b35';
    ctx.fillText(label, x + L.cw / 2, y + L.fh * 0.58);
  }

  /** The lobby sits in the upper band of the ground floor; the lower band is
   *  the street, where its entrance reads as an actual way in. */
  function drawLobby(lobby, L, state) {
    const y = L.floorY(config.building.lobbyFloor ?? 0);
    const sh = streetHeight(L);
    const roomH = Math.max(5, L.fh - sh - 4);
    const lobbySlots = lobby.slots ?? [lobby.slot];
    const night = isNight(state);
    // The doors go in the MIDDLE of the frontage, with glass either side, so a
    // widened lobby reads as one building with an entrance rather than as a
    // row of separate front doors. Keith, 2026-09-01: "the lobby should
    // connect in the middle with its own ends."
    const ordered = [...lobbySlots].sort((a, b) => a - b);
    const doorSlot = ordered[Math.floor((ordered.length - 1) / 2)];
    for (const slot of lobbySlots) {
      const x = L.x0 + slot * L.cw;
      if (x + L.cw < 0 || x > W) continue;

      // The lobby sheet carries its own ground and steps for the full 48x32
      // tile, so nothing else is drawn over it. Painting a separate apron on
      // top as well put two sets of steps in the same 16 pixels, which is what
      // made the entrance and the pavement look like they were at different
      // heights — and is why the apron sheet was withdrawn rather than wired
      // (spec/asset-request.md, "Withdrawn from Tier 0").
      const sheet = slot === doorSlot ? 'lobby' : 'lobby-wing';
      if (sprites.drawSprite(ctx, { name: sheet, animation: night ? 'night' : 'day', x, y, scale: L.zoom })) continue;

      ctx.fillStyle = '#5aa9e6';
      ctx.globalAlpha = 0.9;
      roundRect(ctx, x + 2, y + 3, L.cw - 4, roomH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#102235';
      ctx.textAlign = 'center';
      ctx.font = '700 8px ui-monospace, monospace';
      if (roomH >= 10) ctx.fillText('LOBBY', x + L.cw / 2, y + roomH * 0.5 + 6);

      // Entrance: a doorway in the street band with a canopy over it. Only
      // reached when the lobby sheet itself is missing, since that sheet
      // carries the real entrance.
      const doorTop = y + L.fh - sh;
      const doorW = Math.max(6, L.cw * 0.44);
      const doorX = x + (L.cw - doorW) / 2;
      ctx.fillStyle = '#9fd3f0';
      ctx.fillRect(x + 2, doorTop, L.cw - 4, Math.max(1, L.zoom));
      ctx.fillStyle = '#0d1a26';
      ctx.fillRect(doorX, doorTop + Math.max(1, L.zoom), doorW, Math.max(2, sh - L.zoom * 2));
      ctx.fillStyle = '#ffd76a';
      ctx.fillRect(doorX + doorW / 2 - Math.max(0.5, L.zoom / 2), doorTop + Math.max(1, L.zoom), Math.max(1, L.zoom), Math.max(2, sh - L.zoom * 2));
    }
  }

  /** One art tile per storey a route spans, so a flight of stairs looks like a
   *  stairwell instead of a translucent box with a line through it. Returns
   *  false when the sheet is not there, leaving the placeholder to draw. */
  function drawRouteColumn(name, animation, slot, bottom, top, L) {
    if (!sprites.has(name, animation)) return false;
    for (let f = bottom; f <= top; f++) {
      const x = L.x0 + slot * L.cw;
      const y = L.floorY(f);
      if (x + L.cw < 0 || x > W || y + L.fh < 0 || y > H) continue;
      // The building's own shell goes down first, so a stairwell sits INSIDE
      // the structure and shares its columns with the rooms either side.
      // Without it the route tile is a box butted against the building, which
      // is what read as detached.
      sprites.drawSprite(ctx, { name: 'slot-empty', animation: 'empty', x, y, scale: L.zoom });
      // The art is one two-storey run cut in half: frame 0 is the lower
      // flight, frame 1 the upper. Picking by the floor's own parity — not by
      // a clock — makes a stairwell of any height read as a continuous
      // switchback instead of the same tile repeated.
      const half = ((f - bottom) % 2 + 2) % 2;
      if (!sprites.drawSprite(ctx, { name, animation, x, y, scale: L.zoom, frame: half })) return false;
    }
    return true;
  }

  function drawStairs(stair, L, state) {
    const x = L.x0 + stair.slot * L.cw;
    const top = L.floorY(stair.top), bot = L.floorY(stair.bottom) + L.fh;
    const occupancy = localRouteOccupancy(state, 'stairs', stair.id);
    const capacity = Math.max(1, Math.floor(Number(config.stairs?.capacity) || 0));
    const full = occupancy >= capacity;
    if (drawRouteColumn('stairs-segment', 'tile', stair.slot, stair.bottom, stair.top, L)) {
      routeBadge('STAIRS ' + occupancy + '/' + capacity, full, x, bot, L);
      return;
    }
    ctx.fillStyle = 'rgba(90,169,230,0.22)';
    roundRect(ctx, x + 3, top + 1, L.cw - 6, bot - top - 2, 4);
    ctx.fill();
    ctx.strokeStyle = full ? '#ef476f' : 'rgba(142,202,230,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 6, bot - 6);
    ctx.lineTo(x + L.cw - 6, top + 8);
    ctx.stroke();
    ctx.fillStyle = full ? '#ff8da6' : '#8ecae6';
    ctx.textAlign = 'center';
    ctx.font = '700 8px ui-monospace, monospace';
    ctx.fillText('STAIRS ' + occupancy + '/' + capacity, x + L.cw / 2, bot - 7);
  }

  /** The occupancy count, over whichever art the route drew. */
  function routeBadge(text, full, x, bottomY, L) {
    if (L.fh < 18) return;
    const k = L.zoom >= 3 ? 1.25 : L.zoom >= 2 ? 1 : 0.75;
    ctx.fillStyle = 'rgba(14,17,22,0.72)';
    const w = Math.max(30 * k, text.length * 5.4 * k + 8 * k);
    roundRect(ctx, x + L.cw / 2 - w / 2, bottomY - 13 * k, w, 11 * k, 3);
    ctx.fill();
    ctx.fillStyle = full ? '#ff8da6' : '#8ecae6';
    ctx.textAlign = 'center';
    ctx.font = '700 ' + Math.round(8 * k) + 'px ui-monospace, monospace';
    ctx.fillText(text, x + L.cw / 2, bottomY - 4.5 * k);
  }

  function drawEscalator(escalator, L, state) {
    const x = L.x0 + escalator.slot * L.cw;
    const top = L.floorY(escalator.top), bot = L.floorY(escalator.bottom) + L.fh;
    const occupancy = localRouteOccupancy(state, 'escalator', escalator.id);
    const capacity = Math.max(1, Math.floor(Number(config.escalator?.capacity) || 0));
    const full = occupancy >= capacity;
    if (drawRouteColumn('escalator-segment', 'run', escalator.slot, escalator.bottom, escalator.top, L)) {
      routeBadge('ESC ' + occupancy + '/' + capacity, full, x, bot, L);
      return;
    }
    ctx.fillStyle = 'rgba(244,162,97,0.24)';
    roundRect(ctx, x + 3, top + 1, L.cw - 6, bot - top - 2, 4);
    ctx.fill();
    ctx.strokeStyle = full ? '#ef476f' : '#f4a261';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 6, bot - 6);
    ctx.lineTo(x + L.cw - 6, top + 8);
    ctx.stroke();
    ctx.fillStyle = full ? '#ff8da6' : '#ffd1ad';
    ctx.textAlign = 'center';
    ctx.font = '700 8px ui-monospace, monospace';
    ctx.fillText('ESC ' + occupancy + '/' + capacity, x + L.cw / 2, bot - 7);
  }

  /** Which elevator shaft a click landed on, for car placement. */
  function shaftAt(state, px, py) {
    const L = layout(state);
    for (const sh of state.shafts) {
      const x = L.x0 + sh.slot * L.cw;
      const top = L.floorY(sh.top);
      const bottom = L.floorY(sh.bottom) + L.fh;
      if (px >= x && px <= x + L.cw && py >= top && py <= bottom) return sh.id;
    }
    return null;
  }

  /**
   * The stairwell or escalator under the pointer, as `{kind, id}`. Same shape
   * as `shaftAt` because they are the same shape in the world: one slot, a
   * span of floors. Added so the demolish tool can reach them — before it,
   * they were the only built things with no way to pick them at all.
   */
  function routeAt(state, px, py) {
    const L = layout(state);
    for (const [kind, routes] of [['stairs', state.stairs ?? []], ['escalator', state.escalators ?? []]]) {
      for (const route of routes) {
        const x = L.x0 + route.slot * L.cw;
        const top = L.floorY(route.top);
        const bottom = L.floorY(route.bottom) + L.fh;
        if (px >= x && px <= x + L.cw && py >= top && py <= bottom) return { kind, id: route.id };
      }
    }
    return null;
  }

  /** The lobby SEGMENT under the pointer — the slot, since that is what a
   *  player clears one at a time. Null when the point is not on the entrance. */
  function lobbyAt(state, px, py) {
    if (!state.lobby) return null;
    const L = layout(state);
    const ground = config.building.lobbyFloor ?? 0;
    const y = L.floorY(ground);
    if (py < y || py > y + L.fh) return null;
    for (const slot of state.lobby.slots ?? [state.lobby.slot]) {
      const x = L.x0 + slot * L.cw;
      if (px >= x && px <= x + L.cw) return slot;
    }
    return null;
  }

  // ------------------------------------------------------- camera controls
  // The UI drives these; it never reads or writes the camera itself, which is
  // what keeps every pick going through the one inverse transform above.

  /** The pointer moved by (dx, dy) with a drag in progress: move the world with it. */
  function dragBy(state, dx, dy) {
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    clampCamera(state);
  }

  /** Zoom to an integer level, holding the world point under the cursor still. */
  function setZoom(state, nextZoom, anchorX = W / 2, anchorY = H / 2) {
    const next = clampZoom(nextZoom);
    if (next !== camera.zoom) {
      const moved = cameraZoomedAt(camera, viewport(), next, anchorX, anchorY);
      camera.x = moved.x;
      camera.y = moved.y;
      camera.zoom = moved.zoom;
      clampCamera(state);
    }
    return camera.zoom;
  }

  const zoomBy = (state, steps, anchorX, anchorY) => setZoom(state, camera.zoom + steps, anchorX, anchorY);

  /** The HUD's explicit "go to" — the third and last case where the camera is
   *  allowed to move itself (spec §2). */
  function goTo(state, floor, slot = null) {
    const wanted = Math.round(floor) || 0;
    const bottom = Math.min(0, lowestFloor(state));
    const top = Math.max(bottom, Math.round(state?.floors ?? 0) - 1);
    centerOnCell(state, Math.min(top, Math.max(bottom, wanted)),
      slot == null ? (config.building.slotsPerFloor - 1) / 2 : slot);
  }

  const minimapAt = (state, px, py) => {
    const m = minimapMetrics(viewport(), Math.max(1, state.floors - lowestFloor(state)),
      config.building.slotsPerFloor, lowestFloor(state));
    return minimapContains(m, px, py) ? { floor: minimapFloorAt(m, py), slot: minimapSlotAt(m, px) } : null;
  };

  /** Click or drag the strip to jump. Returns false when the point was not on it. */
  function minimapJump(state, px, py) {
    const hit = minimapAt(state, px, py);
    if (!hit) return false;
    centerOnCell(state, hit.floor, hit.slot);
    return true;
  }

  return {
    draw, resize, layout, unitPos, floorAt, slotAt, unitAt, facilityAt, shaftAt,
    routeAt, lobbyAt,
    dragBy, setZoom, zoomBy, goTo, frameLobby, minimapAt, minimapJump,
    // The appeal overlay (issue #12). Same shape as the camera controls: ui/
    // binds the key, the renderer owns what the key shows.
    setAppealOverlay(on) { appealOverlay = Boolean(on); return appealOverlay; },
    toggleAppealOverlay() { appealOverlay = !appealOverlay; return appealOverlay; },
    get appealOverlay() { return appealOverlay; },
    // The sky, so a check can put something in the air on demand rather than
    // waiting out a rate meant to make surprises rare.
    sky,
    // The sheet book, for the same reason: a test can wait for the real art to
    // load and then assert that a frame actually asked for it.
    art: sprites,
    get size() { return [W, H]; },
    get camera() { return { ...camera }; },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
