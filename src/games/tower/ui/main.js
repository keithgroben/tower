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
import { DAYPART_LABELS, calendarOf, formatClock } from '../sim/clock.js';
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import { starGateStatus } from '../sim/progression.js';
import { BUILDABLE } from '../sim/actions.js';
import { isHotelInfested, isHotelRoomDirty } from '../sim/hotel.js';
import { activeDemands, demandsOf, noticesAfter } from '../sim/demands.js';
import { COMMERCIAL_FAMILY_CODES, FAMILY, isHotelFamily, isStaff, isStaffFamily } from '../sim/state.js';
import {
  demandsReadout, entertainmentReadout, evictionNotice, hotelHealthReadout, infestationNotice, noticeToSay,
  eventsReadout, serviceReadout, starClause, starGlyph, starTitle, stressReadout, venueReadout,
} from './readout.js';
import { STRESS_COLORS, makeRenderer, objectStatusTag, officeIsLet } from '../render/canvas.js';
import { DAY_SECONDS, SPEEDS, TICKS_PER_SECOND, makeTickPump } from './loop.js';
import { applyAction } from '../sim/actions.js';
import { TOOLS, preview } from './build.js';
import { discardSavedWorld, loadSavedWorld, makeAutosave } from './persist.js';
import { newTowerWorld } from './seed.js';
import { mountLiftPanel } from './lift-panel.js';
import { mountTheaterPanel } from './theater-panel.js';
import { eventDialogBlocking, mountEventDialog } from './event-dialog.js';
import { mountFinale } from './finale.js';
import { makePauseGate } from './pause.js';
import { mapBarModel, overlayHoverLine, overlayModel } from './overlays.js';
import { mountFinanceWindow } from './finance-window.js';
import { mountFacilityWindow } from './facility-window.js';
import { mountTenantWindow } from './tenant-window.js';
import { hoverReasons } from './readout.js';
import { makeDemo, parseDemo } from './demo.js';

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
//
// `?demo=climb` (issue #19, `ui/demo.js`) is the exception: a scripted player plays a tower of its own
// in this page, and the saved tower is neither read nor written.
const demo = (() => { const spec = parseDemo(location.search); return spec ? makeDemo(spec) : null; })();
const resumed = demo ? { world: null, note: null } : await loadSavedWorld();
// An empty lot with a ground lobby. `seedDemoWorld` is a measurement fixture
// now, not the opening position — the first office should be the player's own.
const world = demo ? demo.world : (resumed.world ?? newTowerWorld({ seed: 1 }));
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
const autosave = demo
  ? { save: () => {}, tick: () => {} }
  : makeAutosave(() => world, (text) => { $('saved').textContent = text; });
if (demo) {
  $('saved').textContent = 'demo · not saved';
  $('demo').textContent = demo.banner;
  $('demo').hidden = false;
}

// The way out matters more than the cadence. A player closes the tab; they do
// not finish a day first. `pagehide` fires where `beforeunload` is unreliable
// on mobile, and `visibilitychange` catches the tab being switched away from
// and never returned to.
window.addEventListener('pagehide', () => autosave.save('leaving'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') autosave.save('hidden');
});

/**
 * Who is holding the game still, and what speed comes back (issue #18). A map view or a window holds
 * the clock (`HELP.txt`: Eval, Pricing, Hotel, Finance and Facility pause the game); closing it gives
 * back the speed the player had chosen. The event dialog stops the tick pump on its own, below, and a
 * hold can neither start nor end that.
 */
const gate = makePauseGate({ initial: 1, onChange: (state) => showSpeed(state) });
/** The demo runs the ticks this many times faster than the buttons say (1 in the ordinary game). */
const boost = demo ? demo.boost : 1;
let speed = 1;
let lastFrameMs = 0;
let hudDueMs = 0;
/** Previous frame's let count, so the HUD can react to a change rather than
 *  merely display one. `-1` so the first read is never mistaken for a move. */
let lastLetCount = -1;
/** Rooms the cockroaches held at the last read; `-1` until there has been one. */
let lastInfested = -1;
/**
 * The last notice the tower raised that this bar has said (issue #13). Starts at the
 * newest one already in the log, so resuming a save does not re-announce yesterday.
 */
let lastNoticeId = demandsOf(tower).nextNoticeId - 1;
/** The last real stress reading, held across the three-day counter reset. */
let lastStress = null;

/**
 * Can the palette actually make one of these?
 *
 * `BUILDABLE` is the sim's own list of what a `build` command accepts, so this
 * is the palette answering for itself rather than a second table of what exists
 * — the day fast food lands, this starts returning true for it with no edit.
 *
 * It is what stops the goal clause naming a requirement as though a player could
 * go and place one when the palette has no such button: a security office can
 * be placed since issue #12, a recycling centre since #13, a metro station since
 * #15 and the cathedral since #17: everything the ladder asks for is on the palette.
 */
const isBuildable = (kind) => Object.hasOwn(BUILDABLE, kind);

// ------------------------------------------------------------------- speed

const HOLD_WORDS = { eval: 'Eval', pricing: 'Pricing', hotel: 'Hotel', finance: 'Finance', facility: 'facility window', tenant: 'tenant window' };

/** Show the speed the pump is running at, and, if something is holding it, what. */
function showSpeed({ speed: running, wanted, held }) {
  speed = running;
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.classList.toggle('on', Number(button.dataset.speed) === wanted);
  }
  $('pace').textContent = held.length > 0
    ? 'paused · ' + held.map((k) => HOLD_WORDS[k] ?? k).join(', ')
    : speed === 0
      ? 'paused'
      : `${TICKS_PER_SECOND * speed * boost} ticks/s · ${(DAY_SECONDS / (speed * boost)).toFixed(0)}s a day`;
}

function setSpeed(next) { gate.request(next); }

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
  // No tool in hand: clicking a shaft opens its control panel, the way the
  // original's magnifier did on the elevator machinery.
  else if (!dragged) {
    const shaft = renderer.carrierAt(tower, ...point) ?? renderer.carrierColumnAt(tower, point[0]);
    // Clicking a theater opens its window (issue #11): the film, and the two
    // purchases that change it. Only one panel is ever open.
    const hit = renderer.objectAt(tower, ...point);
    // A map view is for looking: its rooms are read by hovering, and a click does nothing (issue #18).
    if (viewMode) { /* inert */ }
    else if (shaft) { closeSurfaces({ except: 'lift' }); liftPanel.open(shaft.id); }
    else if (hit?.family === FAMILY.theater) { closeSurfaces({ except: 'theater' }); theaterPanel.open(hit.id); }
    // Anything else you point the magnifier at opens its Facility window, and the game holds still.
    else if (hit) openFacility(hit.id);
    else closeSurfaces();
  }
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
  if (e.key === 'Escape') { selectTool(null); closeSurfaces(); return; }
  const tool = TOOLS.find((t) => t.key === e.key);
  if (tool) { selectTool(activeTool?.id === tool.id ? null : tool); return; }
  if (e.key === ' ') { e.preventDefault(); setSpeed(gate.wanted === 0 ? 1 : 0); return; }
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

const liftPanel = mountLiftPanel($('liftpanel'), {
  getCarrier: (id) => tower.carriers.find((c) => c.id === id) ?? null,
  apply: (command) => {
    const result = applyAction(world, command);
    if (tower.routeTablesDirty) { rebuildRouteTables(tower); tower.routeTablesDirty = false; }
    return result;
  },
  onChange: () => drawHud(),
});

const theaterPanel = mountTheaterPanel($('theaterpanel'), {
  getWorld: () => world,
  apply: (command) => applyAction(world, command),
  onChange: () => drawHud(),
});

// The question the tower asks (issue #16): a bomb's ransom, a fire's helicopter. While one is open
// `frame()` does not ask the scheduler for another tick, so the two-tick default can never be
// reached by a person who is still reading.
const eventDialog = mountEventDialog($('eventdialog'), {
  getWorld: () => world,
  apply: (command) => applyAction(world, command),
  onChange: () => drawHud(),
});

// The Tower rank's banner (issue #17). It does not stop the game; the fireworks are the renderer's.
const finale = mountFinale($('finale'), { getWorld: () => world });

// The windows and the map views (issue #18). Each one that opens holds the clock; each that closes
// lets go (`ui/pause.js`). They are exclusive: opening one closes the rest.
const rebuilt = () => { if (tower.routeTablesDirty) { rebuildRouteTables(tower); tower.routeTablesDirty = false; } };
const financeWindow = mountFinanceWindow($('financewindow'), {
  getWorld: () => world,
  onClose: () => { gate.release('finance'); refreshMapBar(); },
});
const facilityWindow = mountFacilityWindow($('facilitywindow'), {
  getWorld: () => world,
  apply: (command) => { const r = applyAction(world, command); rebuilt(); return r; },
  onChange: () => drawHud(),
  onOpenPerson: (actorId) => openTenant(actorId),
  onClose: () => gate.release('facility'),
});
const tenantWindow = mountTenantWindow($('tenantwindow'), {
  getWorld: () => world,
  apply: (command) => applyAction(world, command),
  onChange: () => drawHud(),
  onOpenFacility: (objectId) => openFacility(objectId),
  onFind: ({ floor, tile }) => renderer.goTo(floor, tile),
  onClose: () => gate.release('tenant'),
});

/** The map view that is on (`'eval'`, `'pricing'`, `'hotel'`), or `null` for the ordinary Edit view. */
let viewMode = null;
let viewKey = '';

/** Take everything down: the view, every window, the lift and theater panels. */
function closeSurfaces({ except = null } = {}) {
  if (except !== 'view' && viewMode) setView(null);
  if (except !== 'finance') financeWindow.close();
  if (except !== 'facility') facilityWindow.close();
  if (except !== 'tenant') tenantWindow.close();
  if (except !== 'lift') liftPanel.close();
  if (except !== 'theater') theaterPanel.close();
}

function openFacility(id) {
  gate.hold('facility');
  closeSurfaces({ except: 'facility' });
  facilityWindow.open(id);
}

function openTenant(actorId) {
  gate.hold('tenant');
  closeSurfaces({ except: 'tenant' });
  tenantWindow.open(actorId);
}

function openFinance() {
  gate.hold('finance');
  closeSurfaces({ except: 'finance' });
  financeWindow.open();
  refreshMapBar();
}

/** Turn a map view on, or (`null`) off. Holds the clock while it is on and gives the speed back when it is not. */
function setView(mode) {
  const previous = viewMode;
  viewMode = mode;
  viewKey = '';
  if (mode) {
    selectTool(null);
    gate.hold(mode);
    if (previous && previous !== mode) gate.release(previous);
  } else if (previous) {
    gate.release(previous);
    renderer.setOverlay(null);
  }
  refreshView();
  refreshMapBar();
}

/** Recompute the colours if the tower has moved (it has not, while the view holds the clock). */
function refreshView() {
  const key = viewMode ? viewMode + ':' + tower.clock.dayCounter + ':' + tower.clock.dayTick + ':' + tower.objects.size : '';
  if (viewMode && key !== viewKey) {
    viewKey = key;
    const model = overlayModel(tower, viewMode);
    renderer.setOverlay(model.cells);
    const keyEl = $('viewkey');
    keyEl.replaceChildren();
    const title = document.createElement('b');
    title.textContent = model.title;
    keyEl.append(title);
    for (const item of model.legend) {
      const row = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = item.color;
      row.append(dot, item.label + ' ' + item.count);
      keyEl.append(row);
    }
  }
  $('viewkey').hidden = !viewMode;
}

function pressMapButton(id) {
  const bar = mapBarModel(tower).find((b) => b.id === id);
  if (!bar) return;
  if (!bar.enabled) { say(bar.reason, false); return; }
  if (id === 'edit') { closeSurfaces(); return; }
  if (id === 'finance') { if (financeWindow.isOpen) closeSurfaces(); else openFinance(); return; }
  if (viewMode === id) { setView(null); return; }
  // A window and a view are not open together; the view takes the screen.
  closeSurfaces({ except: 'view' });
  setView(id);
}

const MAP_TITLES = {
  edit: 'the ordinary view',
  eval: 'colour the tower by how happy its tenants are - this pauses the game',
  pricing: 'colour the tower by how tenants see their rents - this pauses the game',
  hotel: 'show the hotel rooms that need cleaning - this pauses the game',
  finance: 'where the money comes from and goes to - this pauses the game',
};

function buildMapBar() {
  const bar = $('mapbar');
  for (const b of mapBarModel(tower)) {
    const button = document.createElement('button');
    button.dataset.map = b.id;
    button.textContent = b.label;
    button.addEventListener('click', () => pressMapButton(b.id));
    bar.appendChild(button);
  }
  refreshMapBar();
}

function refreshMapBar() {
  for (const b of mapBarModel(tower)) {
    const button = document.querySelector('[data-map="' + b.id + '"]');
    if (!button) continue;
    button.disabled = !b.enabled;
    button.title = b.reason ?? MAP_TITLES[b.id] ?? '';
    const on = b.id === 'edit' ? !viewMode && !financeWindow.isOpen : b.id === 'finance' ? financeWindow.isOpen : viewMode === b.id;
    button.classList.toggle('on', on);
  }
}

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
  link: renderer.linkAt(tower, px, py),
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
function say(text, ok, { hold = false, ms = null } = {}) {
  const el = $('answer');
  el.textContent = text ?? '';
  el.classList.toggle('bad', !ok);
  clearTimeout(sayTimer);
  if (text && !hold) sayTimer = setTimeout(() => { el.textContent = ''; }, ms ?? (ok ? 2200 : 4000));
}

/** The stars jump when a rung is climbed; the timer (not `animationend`) puts them back, as `bumpLeases` does. */
let riseTimer = null;
function pulseStars() {
  const el = $('stars');
  clearTimeout(riseTimer);
  el.classList.remove('rise');
  void el.offsetWidth;
  el.classList.add('rise');
  riseTimer = setTimeout(() => el.classList.remove('rise'), 1600);
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

  // A map view says what its colour means for the room under the pointer, and why (issue #18).
  if (viewMode) {
    $('hover').textContent = object ? overlayHoverLine(tower, viewMode, object) : (floor === null ? '' : `floor ${floor}`);
    return;
  }

  if (activeTool) {
    renderer.setGhost(preview(world, activeTool, targetAt(px, py)));
  }

  if (!object) {
    $('hover').textContent = floor === null ? '' : `floor ${floor}`;
    return;
  }
  const occupants = tower.actors.filter((a) => a && a.objectId === object.id);
  // A venue's 48 are customers who may come, not people who live here, and the
  // line worth saying about it is what its day is worth.
  const venueLine = venueReadout(object) || entertainmentReadout(object, tower) || serviceReadout(object, tower);
  if (venueLine) { $('hover').textContent = venueLine; return; }
  // Staff have no lease and no stress; "6 occupants · worst stress 0" would read
  // as a tenant who is doing perfectly.
  if (isStaffFamily(object.family)) {
    // Guards say what they are for: they fight fires and search for bombs (issue #16), by the
    // outside stairs only, and the nearer the office the sooner they get there.
    $('hover').textContent = object.family === FAMILY.security
      ? `security · ${occupants.length} guards · fight fires, find bombs · outside stairs only · cannot be bulldozed`
      : `housekeeping · ${occupants.length} staff · cannot be bulldozed`;
    return;
  }
  const stress = occupants.map((a) => computeRuntimeTileStressAverage(a));
  const worst = stress.length ? Math.max(...stress) : 0;
  // What is wrong with it, in the original's own words (issue #18): "Elevator is very far away",
  // "Neighbors are too noisy", "Room is too dirty"...
  const why = hoverReasons(tower, object);
  $('hover').textContent = (occupants.length
    // `objectStatusTag` is the one place that knows a condo is sold rather than
    // let, so the panel asks it instead of keeping a second copy of the word.
    ? `${officeIsLet(object) ? 'let' : objectStatusTag(object)} · ${occupants.length} occupants · worst stress ${worst} (${stressBand(worst)})`
    : `${officeIsLet(object) ? 'let' : objectStatusTag(object)}`) + (why ? ' · ' + why : '');
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
  const { dayTick, dayCounter, daypart } = tower.clock;
  const cal = calendarOf(dayCounter);
  $('clock').textContent = formatClock(dayTick);
  $('day').textContent = `Y${cal.year} Q${cal.quarter} · ${cal.type}`;
  $('day').title = `day ${dayCounter} · a quarter is two weekdays and a weekend; offices rest on weekends`;
  $('daypart').textContent = DAYPART_LABELS[daypart];
  $('tick').textContent = `t${String(dayTick).padStart(4, '0')}`;

  // "Leasable" is "owns occupants": `OCCUPANTS` in sim/state.js gives six to an
  // office and three to a condo and nothing to a lobby, so the table already
  // says which units can be let and this does not need a second list.
  let let_ = 0, leasable = 0, tenants = 0, guests = 0, dirty = 0, infested = 0;
  for (const object of tower.objects.values()) {
    if (isHotelInfested(object)) infested++;
    else if (isHotelRoomDirty(object)) dirty++;
    if (object.occupants.length === 0) continue;
    // A hotel room is not let, it is booked by the night. Counted in the lease
    // figure it empties every morning, and the next block would announce that
    // fall as an eviction — "A fall in the let count is always an eviction" was
    // true until the first checkout. Its guests are counted beside it instead.
    if (isHotelFamily(object.family)) {
      if (officeIsLet(object)) guests += object.occupants.length;
      continue;
    }
    // A venue has customers, not tenants: it is never let and never for rent, so
    // counting it makes the lease figure ("36/43 let") a denominator that grows
    // with every restaurant and can never be met. `hasTenant` makes the same cut.
    if (COMMERCIAL_FAMILY_CODES.has(object.family)) continue;
    leasable++;
    if (!officeIsLet(object)) continue;
    let_++;
    tenants += object.occupants.length;
  }
  // The HUD's half of the rent moment. The world says WHICH office rented; the
  // counter says how the tower is doing overall, and a number that changes
  // without moving is a number nobody notices changing.
  const leasesEl = $('leases');
  if (lastLetCount >= 0 && let_ !== lastLetCount) {
    bumpLeases(leasesEl, let_ > lastLetCount);
    // A fall in the let count is always an eviction — `applyAction` refuses to
    // demolish a let unit — and it used to happen in silence, taking the seed
    // from 78 tenants to 24 with no explanation on screen. Not softened: the
    // eviction is the loop working. It just gets its cause said out loud.
    const notice = evictionNotice(lastLetCount - let_);
    if (notice) say(notice, false);
  }
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
  // Staff work in the tower; they do not live in it. A housekeeper is counted on
  // its own, and the people figure leaves them out — six actors a facility would
  // otherwise read as six more people the star ladder never saw.
  let staff = 0;
  for (const actor of tower.actors) if (actor && isStaff(actor)) staff++;
  $('people').textContent = `${tenants} living here${guests ? ` · ${guests} guests` : ''}`
    + `${staff ? ` · ${staff} staff` : ''} · ${tower.actors.length - staff} people`;
  // The hotel's health. Said in the world too (the room's own sign and mess); this
  // is the count, for the rooms that are off-screen.
  const hotels = hotelHealthReadout(dirty, infested);
  $('hotels').hidden = !hotels;
  $('hotels').textContent = hotels;
  $('hotels').style.color = infested > 0 ? STRESS_COLORS.red : '';
  if (lastInfested >= 0 && infested > lastInfested) {
    const notice = infestationNotice(infested - lastInfested);
    if (notice) say(notice, false);
  }
  lastInfested = infested;
  $('cash').textContent = '$' + ledger.cash.toLocaleString('en-US');

  // What the tower is asking for (issue #13), until something answers it - and each
  // new notice said once on the line under the tower, in the sim's own words.
  const live = eventsReadout(tower);
  $('events').hidden = !live;
  $('events').textContent = live;
  const demanded = demandsReadout(activeDemands(tower));
  $('demands').hidden = !demanded;
  $('demands').textContent = demanded;
  const fresh = noticesAfter(tower, lastNoticeId);
  if (fresh.length) {
    lastNoticeId = fresh[fresh.length - 1].id;
    const notice = noticeToSay(fresh);
    say(notice.text, notice.ok, { ms: notice.ms });
    if (notice.rise) pulseStars();
  }

  // The loop's own number: the stress of a TYPICAL worker.
  //
  // People with no trips are excluded — `computeRuntimeTileStressAverage`
  // scores them 0, the BEST value, so counting them makes a tower that cannot
  // move anybody read as a perfect one. The median and the phrasing both live
  // in `ui/readout.js`, with the reasons; the short version is that this used
  // to say "no trips yet" about three hundred commuters every third day.
  const scores = [];
  for (const actor of tower.actors) {
    if (!actor || actor.tripCount === 0) continue;
    scores.push(computeRuntimeTileStressAverage(actor));
  }
  const stress = stressReadout(scores, lastStress);
  if (!stress.measuring) lastStress = stress.value;
  const stressEl = $('stress');
  stressEl.textContent = stress.text;
  stressEl.style.color = stress.band ? STRESS_COLORS[stress.band] : '';
  stressEl.style.opacity = stress.measuring ? '0.6' : '';

  // The goal. One glyph and one clause, per CLAUDE.md's no-sidebar rule — and
  // the clause is the whole point: the tower sat at star 1 forever, 84 activity
  // short, and the game never said so.
  const goal = starGateStatus(tower);
  $('stars').textContent = starGlyph(goal.star);
  $('stars').title = starTitle(goal);
  $('goal').textContent = starClause(goal, isBuildable);

  let waiting = 0;
  for (const actor of tower.actors) if (actor && actor.waitingFloor != null) waiting++;
  $('waiting').textContent = `${waiting} waiting`;
  // The theater window's figures move with the day; its buttons are left alone.
  theaterPanel.refresh();
  eventDialog.refresh();
  finale.refresh();
  // The windows (issue #18). They hold the clock, so they only change when the player does something.
  facilityWindow.refresh();
  tenantWindow.refresh();
  financeWindow.refresh();
  refreshView();
  refreshMapBar();
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
    pump.advance(dtMs, gate.speed * boost, () => {
      if (eventDialogBlocking(tower)) return;
      scheduler.tick(tower);
      // The scripted player's morning and evening (`?demo=climb`); the ordinary game has none.
      if (demo) demo.afterTick(tower);
    });
    // Open (or close) the question the moment the tick that raised (or answered) it is done,
    // not up to a tenth of a second later when the HUD next refreshes.
    eventDialog.refresh();
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
buildMapBar();
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
  if (demo) {
    // A demo has nothing to throw away, and the button must never throw away the saved tower it did not play.
    button.textContent = 'Leave the demo';
    button.title = 'go back to your own tower';
    button.addEventListener('click', () => { location.href = location.pathname; });
    return;
  }
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
    button.title = tool.key ? tool.label + '  (' + tool.key + ')' : tool.label;
    // No price on the button. What a thing costs depends on the floor it lands
    // on — an office is $40,000 plus its tiles — so a number here would
    // disagree with the ghost, and a price that changes when you point at it is
    // worse than one that only appears when you do.
    button.innerHTML = '<b>' + (tool.key ?? '') + '</b> ' + tool.label;
    button.addEventListener('click', () => selectTool(activeTool?.id === tool.id ? null : tool));
    bar.appendChild(button);
  }
}

// Handy from the console, and the only thing this file exposes. Read-only in
// spirit: it is here so a playtest can say what it saw, not so the page can
// reach in and change the game.
window.world = world;
window.gate = gate;
window.tower = tower;
window.renderer = renderer;
