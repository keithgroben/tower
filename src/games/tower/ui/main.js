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
import { STRESS_COLORS, makeRenderer, objectStatusTag, officeIsLet } from '../render/canvas.js';
import { DAY_SECONDS, SPEEDS, TICKS_PER_SECOND, makeTickPump } from './loop.js';
import { applyAction } from '../sim/actions.js';
import { TOOLS, preview } from './build.js';
import { discardSavedWorld, loadSavedWorld, makeAutosave } from './persist.js';
import { seedDemoWorld } from './seed.js';

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

import { rebuildRouteTables } from '../sim/routing.js';
import { makeDriver } from './driver.js';

const canvas = $('view');

/**
 * Open on the saved tower if there is one.
 *
 * Top-level `await`, before anything else is built. The alternative — boot the
 * seed and swap the world in when the read finishes — means the scheduler, the
 * renderer and the autosave all close over a tower that is about to be thrown
 * away, and every one of them would have to be rebuilt. A module that waits is
 * simpler than four things that have to be told.
 *
 * `resumed` is shown once the bar exists; a save that could NOT be read says
 * why, because the player is about to see an empty tower where their tower was.
 */
const resumed = await loadSavedWorld();
const world = resumed.world ?? seedDemoWorld({ seed: 1 });
const { tower, ledger } = world;

/**
 * The loop, wired — the scheduler, the delay pricer, and the two moments money
 * moves outside checkpoint 2533.
 *
 * It is in `ui/driver.js` rather than here so the headless harness can run the
 * *same* wiring instead of restating it. This file touches `document` at module
 * scope and so cannot be imported by anything; a harness that has to restate
 * the composition to measure the game ends up reporting on a copy.
 */
const { scheduler } = makeDriver(world);

// The daily sweep used to live here, on `dayAdvanced`. It is now checkpoint
// 2533's object sweep, in `sim/ledger-adapter.js`, wired by `ui/tick.js` — the
// same body the headless harness and the integration tests run, rather than one
// copy per driver. It fires on the same days it always did: the day counter
// moves at 2300, so 2533 reads the same value 233 ticks later.
//
// It also no longer throws. `resetFacilitySimTripCounters` was called here and
// never imported, so the first cashflow day raised a ReferenceError, the frame
// handler caught it, and the game paused itself with a banner on day 3.

const renderer = makeRenderer(canvas, { sprites: { onWarn: (m) => console.warn(m) } });
const pump = makeTickPump();

/**
 * Autosave, once a game day and on the way out.
 *
 * `() => world` rather than `world`: a captured reference would go on saving
 * the tower the player abandoned if the world is ever replaced.
 */
const autosave = makeAutosave(() => world, (text) => { $('saved').textContent = text; });

// The way out matters more than the cadence. A player closes the tab; they do
// not finish a day first. `pagehide` fires where `beforeunload` is unreliable
// on mobile, and `visibilitychange` catches the tab being switched away from
// and never returned to.
window.addEventListener('pagehide', () => autosave.save('leaving'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') autosave.save('hidden');
});

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
  // The shaft in this column whatever floor the pointer is on — extending
  // means pointing at empty sky ABOVE a lift, where the floor-bounded pick
  // finds nothing.
  columnCarrier: renderer.carrierColumnAt(tower, px),
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

/**
 * One line under the tower. Refusals linger; confirmations fade.
 *
 * `hold` keeps a line until something replaces it. The resume note needs it:
 * "resumed day 2" appears while the first frame is still painting, and a
 * message that expires in two seconds during page load is one a lot of players
 * simply never see. It clears itself on the first thing they do, because every
 * action calls through here.
 */
let sayTimer = null;
function say(text, ok, { hold = false } = {}) {
  const el = $('answer');
  el.textContent = text ?? '';
  el.classList.toggle('bad', !ok);
  clearTimeout(sayTimer);
  if (text && !hold) sayTimer = setTimeout(() => { el.textContent = ''; }, ok ? 2200 : 4000);
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
    // `objectStatusTag` is the one place that knows a condo is sold rather than
    // let, so the panel asks it instead of keeping a second copy of the word.
    ? `${officeIsLet(object) ? 'let' : objectStatusTag(object)} · ${occupants.length} occupants · worst stress ${worst} (${stressBand(worst)})`
    : `${officeIsLet(object) ? 'let' : objectStatusTag(object)}`;
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
    // Every daily and 3-day rule now rides inside the scheduler's own
    // checkpoint table, so this is the whole of the sim step.
    pump.advance(dtMs, speed, () => scheduler.tick(tower));
    // Render dt, not sim dt: the sky and the sprite clock run at wall speed so
    // a paused tower still has weather.
    renderer.draw(tower, dtMs);
  } catch (error) {
    reportFailure('frame', error);
    setSpeed(0);
    return;
  }

  hudDueMs -= dtMs;
  if (hudDueMs <= 0) { hudDueMs = 100; drawHud(); autosave.tick(); }
}

// ------------------------------------------------------------------- boot

const resize = () => { renderer.resize(); renderer.draw(tower, 0); };
window.addEventListener('resize', resize);
renderer.resize();
renderer.frameLobby(tower);
setSpeed(1);
buildPalette();
wireRestart();
drawHud();
if (resumed.note) say(resumed.note, Boolean(resumed.world), { hold: true });
requestAnimationFrame(frame);

/**
 * Starting over, in two clicks.
 *
 * One click would let an hour go to a misclick, and a `confirm()` dialog is a
 * modal that stops the game to ask a question the button can ask itself. The
 * button becomes its own confirmation for four seconds and then forgets.
 *
 * It reloads rather than reseeding in place, deliberately: the object and actor
 * id counters live in `sim/state.js` module scope, so only a fresh page truly
 * starts from one. Reseeding without a reload would keep counting from wherever
 * the abandoned tower left off.
 */
function wireRestart() {
  const button = $('restart');
  let armed = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Really? Start over';
      button.classList.add('armed');
      armed = setTimeout(() => {
        armed = null;
        button.textContent = 'New tower';
        button.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(armed);
    button.textContent = 'starting over…';
    await discardSavedWorld();
    location.reload();
  });
}

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
