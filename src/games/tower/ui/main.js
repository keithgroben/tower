/**
 * The driver. Creates a tower, runs the scheduler on a fixed timestep, draws.
 *
 * The whole of the wall-clock/tick boundary lives between two lines down in
 * `frame()`: `pump.advance()` turns real milliseconds into whole ticks, and
 * `renderer.draw()` gets the *render* dt so animation and sky run smoothly
 * whatever the speed multiplier is. The sim never sees a millisecond.
 *
 * This file owns input and the HUD and nothing else. It does not decide
 * anything about the game: the tick order is in `ui/tick.js`, the pacing in
 * `ui/loop.js`, the starting tower in `ui/seed.js`, and every rule in `sim/`.
 *
 * **No developer sidebar.** `CLAUDE.md`: the predecessor grew a 5,800-line
 * diagnostic panel and it became the way the game was read; Keith retired it.
 * The HUD below is nine numbers on one bar, and everything else that is worth
 * knowing is drawn in the world — the For Rent tag over a room, the stress dot
 * over a worker, the queue count on the shaft. Diagnosis happens in the
 * headless harness. A debugger is not an interface.
 */
import { DAYPART_LABELS, formatClock } from '../sim/clock.js';
import { population } from '../sim/state.js';
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import { STRESS_COLORS, makeRenderer, officeIsLet } from '../render/canvas.js';
import { DAY_SECONDS, SPEEDS, TICKS_PER_SECOND, makeTickPump } from './loop.js';
import { seedDemoTower } from './seed.js';
import { makeTowerScheduler } from './tick.js';

const $ = (id) => document.getElementById(id);

/**
 * Anything thrown anywhere becomes a visible banner.
 *
 * Installed before the game is built, deliberately. An exception inside a
 * listener or a frame looks exactly like nothing happening — the button that
 * does not respond, the tower that will not move — and hunting it in a console
 * nobody has open is how a dead build reads as a design problem.
 */
const failures = [];
function reportFailure(what, error) {
  const message = error && error.message ? error.message : String(error);
  failures.push(`${what}: ${message}`);
  const banner = $('failure');
  if (!banner) return;
  banner.textContent = failures.slice(-3).join('  ·  ');
  banner.hidden = false;
  // eslint-disable-next-line no-console
  console.error(what, error);
}
window.addEventListener('error', (e) => reportFailure('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportFailure('promise', e.reason));

import { FAMILY } from '../sim/state.js';
import {
  deactivateIfFailing, officeArrival, officeFamilyHandler, offices,
  recomputeOfficeOperationalStatus,
} from '../sim/office.js';
import { resolveRouteBetweenFloors } from '../sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, stampRouteStart,
  applyQueueFullDelay,
  recordNoRouteFailure,
} from '../sim/stress.js';

const canvas = $('view');
const tower = seedDemoTower({ seed: 1 });

/**
 * **The loop, wired.**
 *
 * Family 7 asks the router whether a worker can get from the lobby to its
 * office. If the route resolves the office rents; if it does not, the worker
 * waits and tries again and the office stays FOR RENT. Nothing here decides
 * occupancy — transport does.
 */
const scheduler = makeTowerScheduler(tower, {
  [FAMILY.office]: officeFamilyHandler({
    resolveRoute: (t, actor, from, to, clock, options) =>
      resolveRouteBetweenFloors(t, actor, from, to, clock, options),
    // Every delay the router reports is priced by the stress pipeline, which
    // owns those constants. The router reports events; it never prices them.
    onDelay: (delay, actor) => applyRoutingDelay(delay, actor),
    onRent: () => { rentedThisFrame++; },
  }),
}, {
  [FAMILY.office]: officeArrival,
});

let rentedThisFrame = 0;

/**
 * Route delays -> stress, the one seam that must not double-count.
 *
 * The actor arrives as the second argument because the router does not echo
 * it onto the delay. Every kind the router can emit is handled here; an
 * unhandled kind is a silently unpriced delay, which is how stress stayed at
 * zero the first time this was wired.
 */
function applyRoutingDelay(delay, actor) {
  if (!actor) return;
  switch (delay.kind) {
    case 'no-route': return void recordNoRouteFailure(actor);
    case 'local-transit': return void applyLocalSegmentDelay(actor, delay.modeAndSpan);
    case 'queue-full': return void applyQueueFullDelay(actor);
    case 'distance': return void applyDistancePenalty(actor, {
      heightMetricDelta: delay.heightMetricDelta,
      emitDistanceFeedback: true,          // the router only emits when gated in
      carrierMode: delay.carrierMode,
    });
    case 'boarding': {
      // spec/DEVIATIONS.md A9: boarding re-stamps. The accumulate measures the
      // WAIT on the floor and clears the stamp; without re-arming it the
      // arrival rebase reads `last_trip_tick == 0` and charges the entire day
      // tick, which clamps to 300. The symptom is uniformly maximal stress on
      // every rider, insensitive to how good the lifts are — it reads as "the
      // clamp is working" rather than as a bug. Omitting this line produced
      // exactly that, and the predicted symptom is how it was found.
      //
      // Service carriers are exempt: the accumulate returns early for them and
      // leaves the stamp intact, so there is nothing to re-arm. Both halves
      // move together for the same reason.
      accumulateElapsedDelayIntoCurrentSim(actor, tower.clock.dayTick, {
        sourceFloor: delay.sourceFloor,
        lobbyHeight: tower.lobbyHeight,
        carrierMode: delay.carrierMode,
      });
      if (delay.carrierMode !== CARRIER_SERVICE) stampRouteStart(actor, tower.clock.dayTick);
      return;
    }
    default: return;                        // requeue-failure and invalid-venue cost 0
  }
}

/**
 * The daily sweep. `recompute_object_operational_status` runs every day, and
 * it is what sets `occupied_flag` on a freshly placed office — the bootstrap
 * that opens the rental gate in the first place.
 */
function runDailySweep() {
  for (const { object, occupants } of offices(tower)) {
    recomputeOfficeOperationalStatus(tower, object, occupants);
    deactivateIfFailing(tower, object, occupants);
  }
}
const renderer = makeRenderer(canvas, { sprites: { onWarn: (m) => console.warn(m) } });
const pump = makeTickPump();

let speed = 1;
let lastFrameMs = 0;
let hudDueMs = 0;
/** Previous frame's let count, so the HUD can react to a change rather than
 *  merely display one. `-1` so the first read is never mistaken for a move. */
let lastLetCount = -1;

// ------------------------------------------------------------------- speed

function setSpeed(next) {
  speed = SPEEDS.includes(next) ? next : 1;
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.classList.toggle('on', Number(button.dataset.speed) === speed);
  }
  $('pace').textContent = speed === 0
    ? 'paused'
    : `${TICKS_PER_SECOND * speed} ticks/s · ${(DAY_SECONDS / speed).toFixed(0)}s a day`;
}

for (const button of document.querySelectorAll('[data-speed]')) {
  button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)));
}

// ------------------------------------------------------------------- input
//
// Every one of these drives a renderer method. The UI never touches the camera
// directly, which is what keeps all picking going through one inverse
// transform — and keeps the input layer from having a second opinion about
// where a floor is.

let dragging = false;
let dragged = false;
let lastX = 0, lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragged = false;
  lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  // The minimap is screen furniture and takes the click before the world does.
  if (renderer.minimapJump(...localPoint(e))) { dragged = true; }
});

canvas.addEventListener('pointermove', (e) => {
  const [px, py] = localPoint(e);
  if (!dragging) { updateHover(px, py); return; }
  if (renderer.minimapAt(px, py)) { renderer.minimapJump(px, py); dragged = true; return; }
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
  renderer.dragBy(dx, dy);
  lastX = e.clientX; lastY = e.clientY;
});

const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  if (!dragged) updateHover(...localPoint(e));
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [px, py] = localPoint(e);
  renderer.zoomBy(e.deltaY < 0 ? 1 : -1, px, py);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); setSpeed(speed === 0 ? 1 : 0); return; }
  const index = ['0', '1', '2', '3'].indexOf(e.key);
  if (index >= 0) { setSpeed(SPEEDS[index]); return; }
  if (e.key === '+' || e.key === '=') renderer.zoomBy(1);
  if (e.key === '-' || e.key === '_') renderer.zoomBy(-1);
  if (e.key === 'Home') renderer.frameLobby(tower);
  const pan = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[e.key];
  if (pan) { e.preventDefault(); renderer.dragBy(pan[0], pan[1]); }
});

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/**
 * What is under the pointer, in one line above the tower. Not a panel and not
 * a selection: a room's real state is already drawn on the room.
 */
function updateHover(px, py) {
  const object = renderer.objectAt(tower, px, py);
  const floor = renderer.floorAt(px, py);
  if (!object) {
    $('hover').textContent = floor === null ? '' : `floor ${floor}`;
    return;
  }
  const occupants = tower.actors.filter((a) => a && a.objectId === object.id);
  const stress = occupants.map((a) => computeRuntimeTileStressAverage(a));
  const worst = stress.length ? Math.max(...stress) : 0;
  $('hover').textContent = occupants.length
    ? `${officeIsLet(object) ? 'let' : 'FOR RENT'} · ${occupants.length} occupants · worst stress ${worst} (${stressBand(worst)})`
    : `${officeIsLet(object) ? 'let' : 'FOR RENT'}`;
}

// --------------------------------------------------------------------- HUD

/**
 * Jump the lease counter and colour it by direction, then put it back.
 *
 * The reset is a timer rather than an `animationend` listener because a
 * viewer with `prefers-reduced-motion` gets `animation: none`, and then
 * `animationend` never fires and the colour sticks for the rest of the session
 * — the accessible path would be the one that breaks.
 */
let bumpTimer = null;
function bumpLeases(el, up) {
  clearTimeout(bumpTimer);
  el.classList.remove('bump', 'up', 'down');
  void el.offsetWidth;                // restart the animation rather than queue it
  el.classList.add('bump', up ? 'up' : 'down');
  bumpTimer = setTimeout(() => el.classList.remove('bump', 'up', 'down'), 640);
}

/**
 * Nine numbers, refreshed ten times a second rather than every frame. The DOM
 * is the slowest thing on this page and none of these changes faster than the
 * eye can read.
 */
function drawHud() {
  const { dayTick, dayCounter, daypart, calendarPhase } = tower.clock;
  $('clock').textContent = formatClock(dayTick);
  $('day').textContent = `day ${dayCounter}`;
  $('daypart').textContent = `${DAYPART_LABELS[daypart]}${calendarPhase ? ' · calendar phase' : ''}`;
  $('tick').textContent = `t${String(dayTick).padStart(4, '0')}`;

  // "Leasable" is "owns occupants": `OCCUPANTS` in sim/state.js gives six to an
  // office and three to a condo and nothing to a lobby, so the table already
  // says which units can be let and this does not need a second list.
  let let_ = 0, leasable = 0;
  for (const object of tower.objects.values()) {
    if (object.occupants.length === 0) continue;
    leasable++;
    if (officeIsLet(object)) let_++;
  }
  // The HUD's half of the rent moment. The world says WHICH office rented; the
  // counter says how the tower is doing overall, and a number that changes
  // without moving is a number nobody notices changing.
  const leasesEl = $('leases');
  if (lastLetCount >= 0 && let_ !== lastLetCount) bumpLeases(leasesEl, let_ > lastLetCount);
  lastLetCount = let_;
  leasesEl.textContent = `${let_}/${leasable} let`;
  $('people').textContent = `${population(tower)} living here · ${tower.actors.length} people`;
  $('cash').textContent = '$' + tower.cash.toLocaleString('en-US');

  // The loop's own number: mean stress across everyone who has taken a trip.
  // People with no trips are excluded — `computeRuntimeTileStressAverage`
  // scores them 0, the BEST value, so averaging them in makes a tower that
  // cannot move anybody read as a perfect one.
  let total = 0, counted = 0;
  for (const actor of tower.actors) {
    if (!actor || actor.tripCount === 0) continue;
    total += computeRuntimeTileStressAverage(actor);
    counted++;
  }
  const mean = counted ? Math.floor(total / counted) : null;
  const stressEl = $('stress');
  stressEl.textContent = mean === null ? 'no trips yet' : `stress ${mean} (${stressBand(mean)})`;
  stressEl.style.color = mean === null ? '' : STRESS_COLORS[stressBand(mean)];

  let waiting = 0;
  for (const actor of tower.actors) if (actor && actor.waitingFloor != null) waiting++;
  $('waiting').textContent = `${waiting} waiting`;
}

// -------------------------------------------------------------- the frame

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dtMs = lastFrameMs ? Math.min(250, nowMs - lastFrameMs) : 0;
  lastFrameMs = nowMs;

  try {
    // Real milliseconds in, whole ticks out. This is the entire boundary.
    pump.advance(dtMs, speed, () => {
      const moved = scheduler.tick(tower);
      // The daily sweep. Without it `occupied_flag` is never set and no office
      // can ever rent — the bootstrap in sim/office.js lives here.
      if (moved.dayAdvanced) runDailySweep();
    });
    // Render dt, not sim dt: the sky and the sprite clock run at wall speed so
    // a paused tower still has weather.
    renderer.draw(tower, dtMs);
  } catch (error) {
    reportFailure('frame', error);
    setSpeed(0);
    return;
  }

  hudDueMs -= dtMs;
  if (hudDueMs <= 0) { hudDueMs = 100; drawHud(); }
}

// ------------------------------------------------------------------- boot

const resize = () => { renderer.resize(); renderer.draw(tower, 0); };
window.addEventListener('resize', resize);
renderer.resize();
renderer.frameLobby(tower);
setSpeed(1);
drawHud();
requestAnimationFrame(frame);

// Handy from the console, and the only thing this file exposes. Read-only in
// spirit: it is here so a playtest can say what it saw, not so the page can
// reach in and change the game.
window.tower = tower;
window.renderer = renderer;
