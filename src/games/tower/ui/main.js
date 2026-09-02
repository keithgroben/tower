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
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import { STRESS_COLORS, makeRenderer, officeIsLet } from '../render/canvas.js';
import { DAY_SECONDS, SPEEDS, TICKS_PER_SECOND, makeTickPump } from './loop.js';
import { applyAction } from '../sim/actions.js';
import { TOOLS, preview } from './build.js';
import { seedDemoWorld } from './seed.js';
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
import { rebuildRouteTables, resolveRouteBetweenFloors } from '../sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, stampRouteStart,
  applyQueueFullDelay,
  recordNoRouteFailure,
} from '../sim/stress.js';

const canvas = $('view');
const world = seedDemoWorld({ seed: 1 });
const { tower, ledger } = world;

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
}, applyRoutingDelay);

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
  // The 3-day cashflow cadence. `specs/TIME.md` checkpoint 2533 and
  // `specs/PEOPLE.md` § Reset: trip counters clear on this pass, via
  // `activate_family_cashflow_if_operational`.
  //
  // Without it stress is a LIFETIME record instead of a rolling judgement of
  // the last three days, so a tower carries its worst morning forever and can
  // never recover from a bad hour. Nothing called it for a day; every office
  // in a six-day run sat permanently at grade 0.
  //
  // TODO(parity): this belongs in a real checkpoint-2533 body alongside the
  // ledger rollover, once someone writes the adapter between the tower model
  // and `economy.js`'s `runLedgerCheckpoint`. The cadence is right here; the
  // home is not.
  const cashflowDay = tower.clock.dayCounter % 3 === 0;

  for (const { object, occupants } of offices(tower)) {
    // Counters clear BEFORE the measurement, not after, and not gated on
    // `occupied_flag`.
    //
    // Gating it on the flag deadlocks the tower: a failing office is
    // deactivated, which CLEARS the flag, which blocks the reset, which
    // freezes its stress, which keeps its grade at 0 forever — so the flag
    // never returns and not one of its workers ever tries again. Measured:
    // every office dead from day 2 of a nine-day run, trips frozen at 1218.
    //
    // `FACILITIES.md` § occupied_flag says the flag is "re-set every 3 days
    // for offices/condos/retail". That is what makes the tower RECOVERABLE:
    // clear the history, re-measure from zero, and a tower whose lifts got
    // better gets its tenants back within a cycle.
    if (cashflowDay) resetFacilitySimTripCounters(occupants);
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
  // Panning under a held tool must not leave a stale ghost behind.
  if (activeTool) updateHover(px, py);
});

const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  const point = localPoint(e);
  // A drag pans; a click builds. Without the distinction, every pan would end
  // by dropping an office wherever the pointer happened to stop.
  if (!dragged && activeTool) build(...point);
  if (!dragged) updateHover(...point);
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Right-click puts the tool down. A modal cursor with no obvious way out is
// the oldest interface trap there is, so there are three ways: the button
// again, Escape, and this.
canvas.addEventListener('contextmenu', (e) => {
  if (!activeTool) return;
  e.preventDefault();
  selectTool(null);
});
canvas.addEventListener('pointerleave', () => renderer.setGhost(null));

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [px, py] = localPoint(e);
  renderer.zoomBy(e.deltaY < 0 ? 1 : -1, px, py);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { selectTool(null); return; }
  const tool = TOOLS.find((t) => t.key === e.key);
  if (tool) { selectTool(activeTool?.id === tool.id ? null : tool); return; }
  if (e.key === ' ') { e.preventDefault(); setSpeed(speed === 0 ? 1 : 0); return; }
  // Speeds move to the function keys' neighbours because 1-5 now pick tools.
  // A player builds far more often than they change speed.
  const index = ['q', 'w', 'e', 'r'].indexOf(e.key.toLowerCase());
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

// ------------------------------------------------------------------ building
//
// Every player action in the game is these twenty lines: pick a tool, point at
// a place, and send `applyAction` a command. Nothing here touches the tower,
// and nothing here decides whether a move is legal — `preview()` guesses so the
// ghost can be green or red before the click, and `applyAction` answers for
// real when the click comes.

let activeTool = null;

function selectTool(tool) {
  activeTool = tool ?? null;
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('on', button.dataset.tool === activeTool?.id);
  }
  canvas.style.cursor = activeTool ? 'crosshair' : '';
  if (!activeTool) renderer.setGhost(null);
}

/** What is under the pointer, in the shape `preview()` wants. */
const targetAt = (px, py) => ({
  floor: renderer.floorAt(px, py),
  tile: renderer.tileAt(px),
  object: renderer.objectAt(tower, px, py),
  carrier: renderer.carrierAt(tower, px, py),
});

/**
 * Send the command and show the answer.
 *
 * The refusal shown is **`applyAction`'s**, never the ghost's. The ghost is a
 * prediction and this is the authority; when they disagree the player sees the
 * real sentence rather than a ghost that lied, and the disagreement is
 * something a person can report instead of a silent wrong colour.
 */
function build(px, py) {
  const target = targetAt(px, py);
  const guess = preview(world, activeTool, target);
  if (!guess.command) { say(guess.reason, false); return; }

  const result = applyAction(world, guess.command);
  if (!result.ok) { say(result.reason, false); return; }

  // A new shaft or a demolition changes what can be reached, and a stale
  // routing table is a route that silently fails. `sim/actions.js` raises the
  // flag; somebody has to act on it.
  if (tower.routeTablesDirty) { rebuildRouteTables(tower); tower.routeTablesDirty = false; }

  say(built(activeTool, result), true);
  drawHud();
}

const built = (tool, result) => (result.cost
  ? `${tool.label} · $${result.cost.toLocaleString('en-US')}`
  : `${tool.label} done`);

/** One line under the tower. Refusals linger; confirmations fade. */
let sayTimer = null;
function say(text, ok) {
  const el = $('answer');
  el.textContent = text ?? '';
  el.classList.toggle('bad', !ok);
  clearTimeout(sayTimer);
  if (text) sayTimer = setTimeout(() => { el.textContent = ''; }, ok ? 2200 : 4000);
}

/**
 * What is under the pointer, in one line above the tower. Not a panel and not
 * a selection: a room's real state is already drawn on the room.
 *
 * With a tool held it also drives the ghost, because "what is under the
 * pointer" and "what would happen there" are the same question once you are
 * holding something.
 */
function updateHover(px, py) {
  const object = renderer.objectAt(tower, px, py);
  const floor = renderer.floorAt(px, py);

  if (activeTool) {
    renderer.setGhost(preview(world, activeTool, targetAt(px, py)));
  }

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
  let let_ = 0, leasable = 0, tenants = 0;
  for (const object of tower.objects.values()) {
    if (object.occupants.length === 0) continue;
    leasable++;
    if (!officeIsLet(object)) continue;
    let_++;
    tenants += object.occupants.length;
  }
  // The HUD's half of the rent moment. The world says WHICH office rented; the
  // counter says how the tower is doing overall, and a number that changes
  // without moving is a number nobody notices changing.
  const leasesEl = $('leases');
  if (lastLetCount >= 0 && let_ !== lastLetCount) bumpLeases(leasesEl, let_ > lastLetCount);
  lastLetCount = let_;
  leasesEl.textContent = `${let_}/${leasable} let`;
  // ⚠️ NOT `population(tower)`. That sums occupants over `occupiedFlag`, and
  // since the bootstrap that flag means "this facility's tenants are being
  // measured" — it is set on a VACANT office before anyone has reached it. On
  // the shipped seed `population()` returns 252 while only 216 people have a
  // lease, counting the six offices above the lift that nobody can get to.
  //
  // Reported to sim/; until it moves, the HUD must not print a number that
  // disagrees with the "36/42 let" sitting next to it on the same bar. An
  // accounting hole that reads as good news is the failure this repo keeps a
  // list of.
  $('people').textContent = `${tenants} living here · ${tower.actors.length} people`;
  $('cash').textContent = '$' + ledger.cash.toLocaleString('en-US');

  // The loop's own number: the stress of a TYPICAL worker.
  //
  // People with no trips are excluded — `computeRuntimeTileStressAverage`
  // scores them 0, the BEST value, so counting them makes a tower that cannot
  // move anybody read as a perfect one.
  //
  // The median, not the mean, and for a measured reason. A worker in an office
  // nobody can reach fails a route every service tick, and `trip_count` is a
  // byte: over three days it laps 256 while `accumulated_elapsed` keeps
  // climbing, so their average comes out in the thousands rather than at the
  // 300-tick clamp. Thirty-six of those against two hundred healthy commuters
  // drags a mean to ~350 and puts "stress 350" on the bar of a tower that is
  // almost entirely fine. The median says what a typical worker actually
  // experiences and is not moved by the stranded ones — who are already saying
  // so themselves, in red, over their own rooms.
  const scores = [];
  for (const actor of tower.actors) {
    if (!actor || actor.tripCount === 0) continue;
    scores.push(computeRuntimeTileStressAverage(actor));
  }
  scores.sort((a, b) => a - b);
  const typical = scores.length ? scores[Math.floor(scores.length / 2)] : null;
  const stressEl = $('stress');
  stressEl.textContent = typical === null ? 'no trips yet' : `stress ${typical} (${stressBand(typical)})`;
  stressEl.style.color = typical === null ? '' : STRESS_COLORS[stressBand(typical)];

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
buildPalette();
drawHud();
requestAnimationFrame(frame);

/**
 * The palette, generated from `TOOLS` — which is itself generated from the
 * sim's `BUILDABLE` and `SHAFT_KIND`. Add a buildable to the sim and a button
 * appears here; there is no list in the markup to forget to update, which is
 * the same reason the sprite preload is derived rather than written twice.
 */
function buildPalette() {
  const bar = $('palette');
  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.dataset.tool = tool.id;
    button.title = tool.label + '  (' + tool.key + ')';
    // No price on the button. What a thing costs depends on the floor it lands
    // on — an office is $40,000 plus its tiles — so a number here would
    // disagree with the ghost, and a price that changes when you point at it is
    // worse than one that only appears when you do.
    button.innerHTML = '<b>' + tool.key + '</b> ' + tool.label;
    button.addEventListener('click', () => selectTool(activeTool?.id === tool.id ? null : tool));
    bar.appendChild(button);
  }
}

// Handy from the console, and the only thing this file exposes. Read-only in
// spirit: it is here so a playtest can say what it saw, not so the page can
// reach in and change the game.
window.world = world;
window.tower = tower;
window.renderer = renderer;
