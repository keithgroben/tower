/**
 * The metro station (issue #15).
 *
 * Four stars, $1,000,000, $100,000 a pass, underground only, ONE per tower, never
 * bulldozed, nothing built beneath it, and the gate for the fifth star.
 *
 * The assertions that matter run through the **composition** - `newTowerWorld`,
 * `applyAction`, the driver's own scheduler, the real router - and the harness
 * functions `node harness/playtest.js --metro` prints, so the numbers quoted in the PR
 * are the numbers asserted here. The ghost is asked the same question as the seam for
 * every refusal and must answer in the same words (`CLAUDE.md`: a test that pins one side
 * of an agreement is not a test of the agreement).
 *
 * Spec: `specs/facility/METRO.md` (the whole file), `specs/COMMANDS.md` § Floor-class rules,
 * § Command-dispatch limits, `specs/ECONOMY.md`, `specs/GAME-STATE.md` § Star Advancement,
 * `specs/TIME.md` § Per-Tick hooks, `specs/EVENTS.md` § VIP / Special Visitor Event; the
 * original's help file (the one source for the commuters) and its string table
 * (*"Cannot place items under Metro"*, *"Place Metro station on bottom floor"*, *"Only one
 * Metro Station allowed"*). `spec/DEVIATIONS.md` A63-A65.
 */
import {
  COMMUTER_MODULUS, COMMUTER_RESIDUE, CUSTOMER_MODULUS, METRO_FLOORS, METRO_TYPES, METRO_WIDTH, PLATFORM,
  TRAIN_ODDS, belowMetroReason, gatewayFloor, hasMetro, metroCommuterCount, metroFloor, metroObjects,
  metroObstruction, metroPlatformFloor, metroServed, metroStations, metroTrainTick, officeWorkerCommutes,
  placeMetro, shaftFloorLimit, trainAtPlatform, venueCustomerCommutes,
} from '../src/games/tower/sim/metro.js';
import {
  FAMILY, OBJECT_TYPE, POPULATION_CONTRIBUTION, __resetIds, createTower, floorExists, isStaffFamily, population,
} from '../src/games/tower/sim/state.js';
import {
  CONSTRUCTION_COST, TYPE_CODES, applyPeriodicOperatingExpenses, createLedger, floorConstructionCost,
} from '../src/games/tower/sim/economy.js';
import {
  GATES_WITHOUT_A_WRITER, STAR_REQUIREMENT, lockReason, notePlacement, refreshPlacementGates, starGateStatus,
  starGatesOf, tryAdvanceStar,
} from '../src/games/tower/sim/progression.js';
import {
  BUILDABLE, LINK_KIND, applyAction, buildCost, demolishRefusal, gradeReason, placementObstruction,
  shaftObstruction,
} from '../src/games/tower/sim/actions.js';
import { chargeableItems, ledgerFor } from '../src/games/tower/sim/ledger-adapter.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { commercialDispatch } from '../src/games/tower/sim/commercial.js';
import { OFFICE_STATE, officeDispatch } from '../src/games/tower/sim/office.js';
import { objectSprite } from '../src/games/tower/render/canvas.js';
import { TOOLS, commandFor, lowestBuiltFloor, preview, toolById } from '../src/games/tower/ui/build.js';
import { serviceReadout, starClause } from '../src/games/tower/ui/readout.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { metroCommuterTrial, metroGateTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** A world at `stars` with a purse and nothing built. */
function world({ stars = 4, cash = 90_000_000 } = {}) {
  __resetIds();
  const w = newTowerWorld({ seed: 1, cash });
  w.tower.starCount = stars;
  return w;
}

/** The click floor for a station whose TOP floor is `top`: the lowest of its three. */
const lowestFor = (top) => top - (METRO_FLOORS - 1);

const buildMetro = (w, floor = -6, left = 100) => applyAction(w, { type: 'build', what: 'metroStation', floor, left });
const ghostMetro = (w, floor = -6, left = 100) => preview(w, toolById('metroStation'), { floor, tile: left });
const must = (r, what) => { assert(r.ok, what + ': ' + r.reason); return r; };

/** A tower with the metro placed at lowest floor -6 (top -4), as most rule tests need. */
function withMetro(opts) {
  const w = world(opts);
  must(buildMetro(w), 'fixture: the station');
  return w;
}

export const tests = {
  // ------------------------------------------------------------------ the facts

  'the numbers: $1,000,000, four stars, $100,000 a pass, 30 tiles, three floors'() {
    assert(CONSTRUCTION_COST.metroStation === 1_000_000, 'the build cost is the game\'s own menu price: ' + CONSTRUCTION_COST.metroStation);
    assert(STAR_REQUIREMENT.metroStation === 4, 'unlocks at ' + STAR_REQUIREMENT.metroStation);
    assert(METRO_WIDTH === 30 && BUILDABLE.metroStation.width === 30, 'METRO.md: 30 tiles wide');
    assert(METRO_FLOORS === 3 && BUILDABLE.metroStation.floors === 3, 'a three-floor stack');
    assert(TYPE_CODES.metroStation === 0x1f && FAMILY.metro === 0x1f && OBJECT_TYPE.metroTop === 0x1f, 'type 0x1f');
    assert(METRO_TYPES.join() === [0x21, 0x20, 0x1f].join() && OBJECT_TYPE.metroMiddle === 0x20 && OBJECT_TYPE.metroBottom === 0x21,
      'types 0x1f / 0x20 / 0x21, lowest first: ' + METRO_TYPES);
    const ledger = createLedger({ cash: 1_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, { items: [{ type: 'metroStation' }] });
    assert(spent === 100_000 && ledger.expense.metroStation === 100_000, 'upkeep $' + spent);
  },

  'the price a player pays is the menu price plus the floor tiles of all three floors'() {
    const w = world();
    const cost = buildCost(w.tower, BUILDABLE.metroStation, -6);
    const tiles = [0, 1, 2].reduce((n, i) => n + floorConstructionCost({ floor: -6 + i, tiles: 30, lobbyHeight: 1 }), 0);
    assert(tiles === 3 * 30 * 500, 'three floors of thirty $500 tiles: ' + tiles);
    assert(cost === 1_000_000 + 45_000, 'the object price, plus the $45,000 METRO.md derives for the tiles: ' + cost);
    const before = w.tower.cash;
    const r = must(buildMetro(w), 'build');
    assert(r.cost === cost && before - w.tower.cash === cost, 'charged exactly that, once: ' + (before - w.tower.cash));
  },

  // ----------------------------------------------------- where, and how many

  'it is a three-floor stack of placed objects, the click floor the lowest, the top the anchor'() {
    const w = world();
    const r = must(buildMetro(w, -6, 100), 'build');
    const objects = metroObjects(w.tower);
    assert(objects.length === 3, 'three placed objects: ' + objects.length);
    assert(objects.map((o) => o.floor).join() === '-6,-5,-4', 'on B6, B5 and B4: ' + objects.map((o) => o.floor));
    assert(objects.map((o) => o.type).join() === [0x21, 0x20, 0x1f].join(), 'bottom 0x21, middle 0x20, top 0x1f');
    assert(objects.every((o) => o.family === FAMILY.metro && o.left === 100 && o.right === 129 && o.occupants.length === 0),
      'one family, thirty tiles, no actors');
    assert(r.object.type === OBJECT_TYPE.metroTop && r.object.floor === -4, 'the result is the top (anchor) floor');
    assert(metroFloor(w.tower) === -4 && metroPlatformFloor(w.tower) === -4, 'g_metro_station_floor_index is the top floor: ' + metroFloor(w.tower));
    assert(objects.every((o) => o.stackId === r.object.id), 'one stack id');
    assert(metroStations(w.tower).length === 1 && hasMetro(w.tower), 'one station');
  },

  'the metro floor index is null, never -1, with no station - B1 is a real floor'() {
    const w = world();
    assert(metroFloor(w.tower) === null && metroPlatformFloor(w.tower) === null && shaftFloorLimit(w.tower) === null,
      'no station: null');
    // The reference's sentinel is -1; ours would read as a station on B1. A tower with a
    // building on B1 must not be told it is "under the metro".
    must(applyAction(w, { type: 'build', what: 'security', floor: -1, left: 10 }), 'something on B1');
    assert(belowMetroReason(w.tower, -50) === null && belowMetroReason(w.tower, -1) === null, 'nothing is under a station that is not there');
  },

  'underground only: a station with any floor at or above the ground is refused, ghost and seam alike'() {
    assert(gradeReason(BUILDABLE.metroStation, -3) === null, 'B3-B1 below ground: ok');
    for (const floor of [-2, -1, 0, 1, 20]) {
      const seam = buildMetro(world(), floor, 100);
      assert(!seam.ok && seam.reason.includes('basement'), 'floor ' + floor + ' is not underground: ' + seam.reason);
      const g = ghostMetro(world(), floor, 100);
      assert(!g.ok && g.reason === seam.reason, 'two voices for one refusal at ' + floor + ': ' + g.reason + ' / ' + seam.reason);
    }
    assert(buildMetro(world(), -3, 100).ok && buildMetro(world(), -10, 100).ok, 'the deepest and the shallowest stack both stand');
    assert(!floorExists(-11) && !buildMetro(world(), -11, 100).ok, 'and nothing below B10');
  },

  'four stars: the lock is checked before the price, and the ghost says the same'() {
    for (const stars of [1, 2, 3]) {
      const w = world({ stars, cash: 90_000_000 });
      const r = buildMetro(w);
      assert(!r.ok && r.reason === lockReason(w.tower, 'metroStation', 'Metro Station'), 'locked at ' + stars + ': ' + r.reason);
      assert(/4 stars/.test(r.reason), 'it says four stars: ' + r.reason);
      assert(ghostMetro(w).reason === r.reason, 'ghost: ' + ghostMetro(w).reason);
      assert(w.tower.objects.size === 1 && w.tower.cash === 90_000_000, 'nothing built, nothing charged');
    }
    assert(buildMetro(world({ stars: 4 })).ok, 'four stars builds it');
  },

  'ONE per tower: the second is refused in the original\'s words, ghost and seam, and nothing is charged'() {
    const w = withMetro();
    const cash = w.tower.cash, objects = w.tower.objects.size;
    const second = buildMetro(w, -9, 10);
    assert(!second.ok && second.reason === 'a tower has only one metro station', second.reason);
    assert(ghostMetro(w, -9, 10).reason === second.reason, 'ghost: ' + ghostMetro(w, -9, 10).reason);
    assert(w.tower.cash === cash && w.tower.objects.size === objects, 'no money, no objects');
    assert(metroStations(w.tower).length === 1, 'still one');
    // placeMetro is the same rule - the seam is not the only door.
    assert(!placeMetro(w.tower, { floor: -9, left: 10 }).ok, 'placeMetro refuses a second as well');
  },

  'cannot be afforded: refused with the funds sentence and nothing is built'() {
    const w = world({ cash: 1_000_000 });             // the object price alone is not enough: the tiles come too
    const r = buildMetro(w);
    assert(!r.ok && /costs \$1,045,000 and you have \$1,000,000/.test(r.reason), r.reason);
    assert(ghostMetro(w).reason === r.reason, 'ghost: ' + ghostMetro(w).reason);
    assert(metroObjects(w.tower).length === 0 && w.tower.cash === 1_000_000, 'nothing built, nothing taken');
  },

  'the three floors must all be clear'() {
    for (const floor of [-6, -5, -4]) {
      const w = world();
      must(applyAction(w, { type: 'build', what: 'security', floor, left: 110 }), 'fixture');
      const r = buildMetro(w, -6, 100);
      assert(!r.ok && r.reason === 'something is already built there', 'floor ' + floor + ' blocks the stack: ' + r.reason);
      assert(ghostMetro(w, -6, 100).reason === r.reason, 'ghost agrees');
    }
  },

  // ---------------------------------------------------- it can never be removed

  'cannot be bulldozed - any of the three floors, ghost and seam, and the stack stands'() {
    const w = withMetro();
    for (const object of metroObjects(w.tower)) {
      const refusal = demolishRefusal(object);
      assert(refusal === 'the metro station cannot be bulldozed', 'the one definition: ' + refusal);
      const r = applyAction(w, { type: 'demolish', objectId: object.id });
      assert(!r.ok && r.reason === refusal, 'seam: ' + r.reason);
      const g = preview(w, toolById('demolish'), { floor: object.floor, tile: object.left, object });
      assert(!g.ok && g.reason === refusal, 'ghost: ' + g.reason);
    }
    assert(metroObjects(w.tower).length === 3 && hasMetro(w.tower), 'all three floors still stand');
  },

  'a placement gate that can never be undone: demolishing is impossible, so the 4 -> 5 latch is a fact'() {
    const w = withMetro();
    assert(starGatesOf(w.tower).metroPlaced === true, 'latched at placement');
    for (const o of metroObjects(w.tower)) applyAction(w, { type: 'demolish', objectId: o.id });
    refreshPlacementGates(w.tower);
    assert(starGatesOf(w.tower).metroPlaced === true && hasMetro(w.tower), 'still there, still latched');
  },

  // ----------------------------------------------------- nothing may go beneath

  'nothing beneath: every placement below metro_floor - 1 is refused, in the string table\'s words'() {
    const w = withMetro();                            // floors -6, -5, -4: the top is -4, so the line is -5
    assert(shaftFloorLimit(w.tower) === -5, 'a shaft may reach top - 1: ' + shaftFloorLimit(w.tower));
    const words = 'nothing can be built under the metro station';
    for (const floor of [-7, -8, -9, -10]) {
      const r = applyAction(w, { type: 'build', what: 'security', floor, left: 10 });
      assert(!r.ok && r.reason === words, 'B' + -floor + ': ' + r.reason);
      const g = preview(w, toolById('security'), { floor, tile: 10 });
      assert(!g.ok && g.reason === words, 'ghost B' + -floor + ': ' + g.reason);
    }
    // The boundary, both sides: top - 1 stands (METRO.md: *"target_floor < metro_floor - 1"*),
    // one lower does not. A `<=` here would be off by one and nobody would notice.
    assert(applyAction(w, { type: 'build', what: 'security', floor: -5, left: 10 }).ok, 'top - 1 is not "under"');
    assert(!applyAction(w, { type: 'build', what: 'security', floor: -6, left: 10 }).ok, 'top - 2 is');
    // And whatever the thing is: a lobby, an office, a venue of two floors, a stack.
    for (const [what, floor] of [['office', -7], ['fastFood', -8], ['parkingSpace', -7], ['recyclingCenter', -8], ['medical', -9]]) {
      const r = applyAction(w, { type: 'build', what, floor, left: 20 });
      assert(!r.ok, what + ' under the metro was allowed');
    }
    assert(applyAction(w, { type: 'build', what: 'fastFood', floor: -3, left: 20 }).ok, 'above it is fine');
    // A two-floor stack is judged by its LOWEST floor.
    assert(!applyAction(w, { type: 'build', what: 'recyclingCenter', floor: -6, left: 20 }).ok, 'a plant whose lower half is under it');
  },

  'nothing beneath: a shaft, an extension and a link obey the same line, with the same words'() {
    const w = withMetro();
    const words = 'nothing can be built under the metro station';
    const deep = applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: -7, top: 5, column: 20 });
    assert(!deep.ok && deep.reason === words, 'a shaft to B7: ' + deep.reason);
    const ghost = preview(w, toolById('shaft-standard'), { floor: 5, tile: 20 });
    // The ghost's default span stops at the line, so ask the sim's own predicate for the deep one.
    assert(shaftObstruction(w.tower, { mode: 1, bottom: -7, top: 5, column: 20 }) === words, 'the shared predicate');
    assert(ghost.ok, 'the ghost\'s default span starts at the line, not under it: ' + ghost.reason);
    assert(lowestBuiltFloor(w.tower) === -5, 'lowestBuiltFloor honours the limit: ' + lowestBuiltFloor(w.tower));
    const shaft = must(applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: -5, top: 5, column: 20 }), 'a shaft to the line');
    const ext = applyAction(w, { type: 'extend_shaft', carrierId: shaft.carrier.id, bottom: -6 });
    assert(!ext.ok && ext.reason === words, 'extending down past it: ' + ext.reason);
    const link = applyAction(w, { type: 'build_link', kind: 'stairs', floor: -7, left: 5 });
    assert(!link.ok && link.reason === words, 'stairs under it: ' + link.reason);
    assert(LINK_KIND.stairs && applyAction(w, { type: 'build_link', kind: 'stairs', floor: -3, left: 5 }).reason !== words,
      'a link above the line is judged by the usual rules, not this one');
  },

  'the station goes on the BOTTOM floor: it refuses to be dropped above something already built lower'() {
    const w = world();
    must(applyAction(w, { type: 'build', what: 'security', floor: -9, left: 10 }), 'fixture: something deep');
    const r = buildMetro(w, -6, 100);
    assert(!r.ok && r.reason === 'place the metro station on the bottom floor - something is built below it', r.reason);
    assert(ghostMetro(w, -6, 100).reason === r.reason, 'ghost: ' + ghostMetro(w, -6, 100).reason);
    // On the line it is not "under": something at top - 1 does not forbid it.
    const w2 = world();
    must(applyAction(w2, { type: 'build', what: 'security', floor: -5, left: 10 }), 'fixture: on the line');
    assert(buildMetro(w2, -6, 100).ok, 'something on top - 1 is not under it');
    // A shaft that goes deeper counts too.
    const w3 = world();
    must(applyAction(w3, { type: 'build_shaft', kind: 'standard', bottom: -9, top: 3, column: 20 }), 'fixture: a deep shaft');
    const deep = buildMetro(w3, -6, 100);
    assert(!deep.ok && /bottom floor/.test(deep.reason), 'a deep shaft blocks it: ' + deep.reason);
  },

  // ------------------------------------------------- the 4 -> 5 gate, and only then

  'the gate flips ONLY after the station is placed: the trial holds at 4 stars, then rises'() {
    const g = metroGateTrial();
    assert(g.before.star === 4 && g.ticksHeld === 120, 'held at four stars for every tick: ' + g.ticksHeld);
    assert(g.before.ready === false && g.before.flag === false, 'not ready, gate clear');
    assert(g.before.blockers.length === 1 && g.before.blockers[0] === 'a metro station',
      'and the metro is the ONLY thing missing, by name: ' + g.before.blockers);
    assert(g.placed.ok && g.placed.cost === 1_045_000, 'placed for $1,045,000: ' + g.placed.cost);
    assert(g.after.star === 5 && g.after.flag === true, 'the next tick: ' + g.after.star + ' stars');
  },

  'building anything ELSE does not latch it, and the bar sends the player to the palette'() {
    const w = world();
    const gates = starGatesOf(w.tower);
    for (const what of ['security', 'medical', 'parkingSpace']) {
      applyAction(w, { type: 'build', what, floor: what === 'medical' ? 2 : -3, left: 10 });
    }
    assert(gates.metroPlaced === false, 'nothing else is a metro');
    notePlacement(w.tower, FAMILY.security);
    assert(gates.metroPlaced === false, 'notePlacement is per family');
    const status = starGateStatus(w.tower);
    const text = starClause({ ...status, blockerDetails: [{ text: 'a metro station', kind: 'metroStation' }], blockers: ['a metro station'], ready: false, nextStar: 5 }, (k) => Object.hasOwn(BUILDABLE, k));
    assert(!text.includes('nothing builds one yet'), 'the palette builds one now: ' + text);
    assert(!('metroPlaced' in GATES_WITHOUT_A_WRITER), 'the gate has a writer: it is no longer in GATES_WITHOUT_A_WRITER');
    assert(Object.keys(GATES_WITHOUT_A_WRITER).every((flag) => flag in starGatesOf(w.tower)), 'and every line left names a real flag');
  },

  'the real writer: placing it latches `metroPlaced` through notePlacement with no other edit'() {
    const w = world();
    assert(starGatesOf(w.tower).metroPlaced === false, 'fixture');
    must(buildMetro(w), 'build');
    assert(starGatesOf(w.tower).metroPlaced === true, 'latched');
    // And the daily sweep (the safety net for towers loaded from a save) agrees: three
    // objects of the family stand, which is `>= 1`.
    const loaded = restore(JSON.parse(JSON.stringify(snapshot(w)))).world;
    loaded.tower.gates.metroPlaced = false;
    refreshPlacementGates(loaded.tower);
    assert(loaded.tower.gates.metroPlaced === true, 'the sweep re-latches from the stack');
  },

  'it is a rung: with the station and 10,000 people the real per-tick check promotes, without it the star holds'() {
    const w = world();
    const { scheduler } = makeDriver(w);
    const t = w.tower;
    Object.assign(starGatesOf(t), { officePlaced: true, securityPlaced: true, suitePlaced: true, recyclingAdequate: true,
      medicalServiceOk: true, routesViable: true });
    t.populationLedger.office = 10_000;
    t.clock.dayCounter = 0; t.clock.dayTick = 1699;
    scheduler.tick(t);
    assert(t.starCount === 4, 'no station: ' + t.starCount);
    assert(tryAdvanceStar(t) === undefined || t.starCount === 4, 'and a direct call does not move it either');
    must(buildMetro(w), 'build');
    scheduler.tick(t);
    assert(t.starCount === 5, 'with it: ' + t.starCount);
  },

  // ------------------------------------------------------------------ upkeep

  'upkeep: $100,000 a pass, once - the three floors are one station, not three'() {
    const w = withMetro();
    const items = chargeableItems(w.tower);
    assert(items.filter((i) => i.type === 'metroStation').length === 1, 'one chargeable item for the stack: ' + items.map((i) => i.type));
    assert(items.length === 1 + 1, 'the lobby and the station, nothing for the other two floors: ' + items.length);
    const ledger = createLedger({ cash: 5_000_000 });
    applyPeriodicOperatingExpenses(ledger, { items, starCount: 4 });
    assert(ledger.expense.metroStation === 100_000, 'one pass: $' + ledger.expense.metroStation);
    assert(5_000_000 - ledger.cash >= 100_000, 'and it came out of the purse');
  },

  'upkeep through the real checkpoint: the tower pays $100,000 on its cashflow day'() {
    const w = withMetro();
    const { scheduler } = makeDriver(w);
    const t = w.tower;
    // Run to the 2533 ledger checkpoint of a cashflow day and read the bucket it filled.
    let paid = 0;
    for (let i = 0; i < 2600 * 4 && !paid; i++) {
      scheduler.tick(t);
      if (t.expenseLedger.metroStation) paid = t.expenseLedger.metroStation;
    }
    assert(paid === 100_000, 'the station\'s pass: $' + paid);
  },

  // -------------------------------------------------------------- population

  'the station adds no population of its own, and is not a home'() {
    const w = world();
    const before = population(w.tower);
    must(buildMetro(w), 'build');
    assert(population(w.tower) === before, 'no people: ' + (population(w.tower) - before));
    assert(POPULATION_CONTRIBUTION[FAMILY.metro] === 0 && !isStaffFamily(FAMILY.metro), 'an explicit zero, and not staff');
    assert(w.tower.actors.length === 0, 'no actors - its commuters are the tower\'s own workers');
  },

  // ---------------------------------------------------------------- the train

  'the train: nothing is drawn from the generator without a station, or while a fire burns'() {
    const t = createTower({ seed: 7 });
    const state = t.rng.state;
    assert(metroTrainTick(t).flipped === false && t.rng.state === state, 'no station: no draw, so a tower without one replays as before');
    const w = withMetro();
    w.tower.events.fireActive = true;
    const s2 = w.tower.rng.state;
    assert(metroTrainTick(w.tower).flipped === false && w.tower.rng.state === s2, 'fire: suppressed before the roll');
    w.tower.events.fireActive = false; w.tower.events.bombActive = true;
    assert(metroTrainTick(w.tower).flipped === false && w.tower.rng.state === s2, 'bomb: suppressed too');
  },

  'the train: a 1-in-100 roll flips ALL THREE floors between 0 and 2, and back'() {
    const w = withMetro();
    const t = w.tower;
    assert(metroObjects(t).every((o) => o.platform === PLATFORM.empty && !trainAtPlatform(o)), 'placed empty');
    let flips = 0, arrivals = 0;
    for (let i = 0; i < 20_000; i++) {
      const r = metroTrainTick(t);
      if (!r.flipped) continue;
      flips++;
      if (r.arrived) arrivals++;
      const states = new Set(metroObjects(t).map((o) => o.platform));
      assert(states.size === 1, 'the stack moves as one: ' + [...states]);
      assert(metroObjects(t).every((o) => o.dirty), 'and every floor is marked dirty');
    }
    assert(TRAIN_ODDS === 100, 'one in a hundred');
    assert(flips > 120 && flips < 280, 'about 200 in 20,000 rolls: ' + flips);
    assert(arrivals === Math.ceil(flips / 2), 'a train arrives on every other flip: ' + arrivals + ' of ' + flips);
  },

  'the train, through the real scheduler: only after tick 240 and before daypart 4'() {
    const w = withMetro();
    const { scheduler } = makeDriver(w);
    const t = w.tower;
    const flips = [];
    let last = PLATFORM.empty;
    for (let day = 0; day < 6; day++) {
      for (let i = 0; i < 2600; i++) {
        scheduler.tick(t);
        const p = metroObjects(t)[0].platform;
        if (p !== last) { flips.push({ tick: t.clock.dayTick, daypart: t.clock.daypart }); last = p; }
      }
    }
    assert(flips.length > 4, 'it happens: ' + flips.length);
    for (const f of flips) assert(f.tick > 240 && f.daypart < 4, 'a flip at tick ' + f.tick + ' (daypart ' + f.daypart + ')');
  },

  // ------------------------------------------------------ the commuters: rules

  'who commutes: the train residue, never a driver, never on the ground floor, never without a station'() {
    const w = withMetro();
    const t = w.tower;
    const office = must(applyAction(w, { type: 'build', what: 'office', floor: 3, left: 10 }), 'an office').object;
    const workers = t.actors.filter((a) => a.objectId === office.id);
    const commuting = workers.filter((a) => officeWorkerCommutes(t, a, office));
    assert(commuting.length >= 1 && commuting.length <= 2, 'about a quarter of six: ' + commuting.length);
    for (const a of workers) {
      const drives = (office.floor + a.occupantIndex) % 4 === 1;
      assert(!(drives && officeWorkerCommutes(t, a, office)), 'worker ' + a.occupantIndex + ' both drives and commutes');
      assert(officeWorkerCommutes(t, a, office) === ((office.floor + a.occupantIndex) % COMMUTER_MODULUS === COMMUTER_RESIDUE), 'the rule');
    }
    assert(COMMUTER_RESIDUE !== 1, 'the drivers\' residue is 1 (PARKING.md)');
    const ground = { ...office, floor: 0 };
    assert(workers.every((a) => !officeWorkerCommutes(t, a, ground)), '"work above ground": the ground floor is not above it');
    const bare = world();
    const o2 = must(applyAction(bare, { type: 'build', what: 'office', floor: 3, left: 10 }), 'office').object;
    assert(bare.tower.actors.every((a) => !officeWorkerCommutes(bare.tower, a, o2)), 'no station, no commuters');
  },

  'who comes by train to a shop: every other customer, of an UNDERGROUND outlet only'() {
    const w = withMetro();
    const t = w.tower;
    const under = must(applyAction(w, { type: 'build', what: 'fastFood', floor: -3, left: 20 }), 'underground').object;
    const above = must(applyAction(w, { type: 'build', what: 'fastFood', floor: 2, left: 20 }), 'above').object;
    const mine = (o) => t.actors.filter((a) => a.objectId === o.id);
    assert(mine(under).length === 48 && mine(above).length === 48, '48 customers each');
    assert(mine(under).filter((a) => venueCustomerCommutes(t, a, under)).length === 48 / CUSTOMER_MODULUS, 'half of the underground outlet\'s');
    assert(mine(above).every((a) => !venueCustomerCommutes(t, a, above)), 'none of the above-ground one\'s');
    const bare = world();
    const lone = must(applyAction(bare, { type: 'build', what: 'fastFood', floor: -3, left: 20 }), 'underground').object;
    assert(bare.tower.actors.every((a) => !venueCustomerCommutes(bare.tower, a, lone)), 'no station: nobody');
  },

  'the gateway: the platform for a commuter, the lobby for everybody else and for a refused day'() {
    const w = withMetro();
    const t = w.tower;
    const actor = { metroRefusedDay: null };
    assert(gatewayFloor(t, true, actor, 3) === -4, 'a commuter starts at the platform');
    assert(gatewayFloor(t, false, actor, 3) === 0, 'anyone else at the lobby');
    actor.metroRefusedDay = 3;
    assert(gatewayFloor(t, true, actor, 3) === 0, 'a platform given up today is the lobby today');
    assert(gatewayFloor(t, true, actor, 4) === -4, 'and the platform again tomorrow');
    assert(gatewayFloor(createTower({ seed: 1 }), true, { metroRefusedDay: null }, 0) === 0, 'no station: the lobby');
  },

  // ------------------------------------------- the commuters: through the real router

  'an office worker\'s trip STARTS at the platform, and ends there - the router is asked from the metro floor'() {
    const w = withMetro({ cash: 90_000_000 });
    const t = w.tower;
    const office = must(applyAction(w, { type: 'build', what: 'office', floor: 3, left: 10 }), 'an office').object;
    office.unitStatus = 0; office.occupiedFlag = true;       // let: renting is the lobby route's business
    const worker = t.actors.find((a) => a.objectId === office.id && officeWorkerCommutes(t, a, office));
    assert(worker, 'fixture: a commuter');
    const asked = [];
    const ctx = {
      resolveRoute: (_t, _a, from, to) => { asked.push([from, to]); return { code: 1 }; },
      onDelay: () => {},
    };
    worker.state = OFFICE_STATE.commuteIn;
    officeDispatch(t, worker, office, t.clock, ctx);
    assert(asked[0][0] === -4 && asked[0][1] === 3, 'in: platform -> office: ' + asked[0]);
    worker.state = OFFICE_STATE.commuteOut; worker.homeFrom = null;
    officeDispatch(t, worker, office, t.clock, ctx);
    assert(asked[1][0] === 3 && asked[1][1] === -4, 'out: office -> platform: ' + asked[1]);
    // A walker in the same office uses the lobby.
    const walker = t.actors.find((a) => a.objectId === office.id && !officeWorkerCommutes(t, a, office)
      && (office.floor + a.occupantIndex) % 4 !== 1);
    walker.state = OFFICE_STATE.commuteIn;
    officeDispatch(t, walker, office, t.clock, ctx);
    assert(asked[2][0] === 0, 'a walker comes in at the lobby: ' + asked[2]);
    // And a VACANT office is let from the lobby - even for a commuter.
    office.unitStatus = 0x10; office.occupiedFlag = true;
    worker.state = OFFICE_STATE.seekingWork;
    officeDispatch(t, worker, office, t.clock, ctx);
    assert(asked[3][0] === 0, 'renting is the lobby route\'s business: ' + asked[3]);
  },

  'a platform no route reaches is given up for the day: the worker is NOT stranded and uses the lobby'() {
    const w = withMetro();
    const t = w.tower;
    const office = must(applyAction(w, { type: 'build', what: 'office', floor: 3, left: 10 }), 'an office').object;
    office.unitStatus = 0; office.occupiedFlag = true;
    const worker = t.actors.find((a) => a.objectId === office.id && officeWorkerCommutes(t, a, office));
    const asked = [];
    const ctx = {
      resolveRoute: (_t, _a, from) => { asked.push(from); return { code: from === -4 ? -1 : 1 }; },
      onDelay: () => {},
    };
    worker.state = OFFICE_STATE.commuteIn;
    const first = officeDispatch(t, worker, office, t.clock, ctx);
    assert(first.moved === false && worker.state === OFFICE_STATE.commuteIn && worker.metroRefusedDay === t.clock.dayCounter,
      'refused, still waiting, not "stranded": state ' + worker.state.toString(16));
    officeDispatch(t, worker, office, t.clock, ctx);
    assert(asked.join() === '-4,0', 'the next stride came from the lobby: ' + asked);
    assert(worker.state === (OFFICE_STATE.commuteIn | 0x40), 'and it is under way: ' + worker.state.toString(16));
  },

  'a customer of an underground shop walks in from the platform, and falls back to the lobby the same way'() {
    const w = withMetro();
    const t = w.tower;
    const shop = must(applyAction(w, { type: 'build', what: 'fastFood', floor: -3, left: 20 }), 'a fast food').object;
    const [commuter, other] = [0, 1].map((i) => t.actors.find((a) => a.objectId === shop.id && a.occupantIndex === i));
    assert(venueCustomerCommutes(t, commuter, shop) && !venueCustomerCommutes(t, other, shop), 'fixture');
    const calls = [];
    const ok = { resolveRoute: (_t, _a, from, to) => { calls.push([from, to]); return { code: 1 }; }, onDelay: () => {} };
    commuter.state = 0x20; commercialDispatch(t, commuter, shop, t.clock, ok);
    other.state = 0x20; commercialDispatch(t, other, shop, t.clock, ok);
    assert(calls[0][0] === -4 && calls[0][1] === -3, 'the commuter: platform -> shop: ' + calls[0]);
    assert(calls[1][0] === 0 && calls[1][1] === -3, 'the other: lobby -> shop: ' + calls[1]);
    // The platform unreachable: the SAME call falls back, once, and the visit goes ahead.
    const t2 = withMetro().tower;
    const shop2 = must(applyAction({ tower: t2, ledger: ledgerFor(t2) }, { type: 'build', what: 'fastFood', floor: -3, left: 20 }), 'fast food').object;
    const c2 = t2.actors.find((a) => a.objectId === shop2.id && a.occupantIndex === 0);
    const seen = [];
    const broken = { resolveRoute: (_t, _a, from) => { seen.push(from); return { code: from === -4 ? -1 : 1 }; }, onDelay: () => {} };
    c2.state = 0x20;
    const r = commercialDispatch(t2, c2, shop2, t2.clock, broken);
    assert(seen.join() === '-4,0' && r.moved === true && c2.venueCommitted === true && c2.anchorFloor === 0,
      'fell back to the lobby inside the one call: ' + seen + ' moved=' + r.moved);
    assert(c2.metroRefusedDay === t2.clock.dayCounter, 'and remembered it for the day');
  },

  // ---------------------------------------------------- the commuters: measured

  '⚠️ the commuter trial: with a lift to the platform they ride from it; they eat ONLY underground; without one nothing is lost'() {
    const control = metroCommuterTrial({ metro: false, days: 5 });
    const served = metroCommuterTrial({ metro: true, lift: true, days: 5 });
    const cut = metroCommuterTrial({ metro: true, lift: false, days: 5 });

    assert(control.commuters === 0 && control.boardingsAtPlatform === 0, 'no station, no commuters, no platform');
    assert(served.served === true && cut.served === false, 'the lifts reach the platform in one tower and not the other');
    assert(served.commuters > 150, 'a quarter of the workers are commuters: ' + served.commuters + ' of ' + served.offices * 6);
    assert(served.commuters === cut.commuters, 'the same people either way');

    // They ride FROM the platform: real cars picking real people up on that floor.
    assert(served.boardingsAtPlatform > 100, 'cars picked people up at the platform: ' + served.boardingsAtPlatform);
    assert(cut.boardingsAtPlatform === 0, 'and none where no lift stops: ' + cut.boardingsAtPlatform);

    // Eating: a commuter only ever eats below ground; the others eat anywhere.
    for (const r of [served, cut]) {
      assert(r.lunches.commuterAbove === 0, r.label + ': a commuter ate above ground ' + r.lunches.commuterAbove + ' times');
      assert(r.lunches.commuterUnderground > 50, r.label + ': commuters ate underground ' + r.lunches.commuterUnderground);
      assert(r.lunches.otherAbove > 50 && r.lunches.otherUnderground > 50, r.label + ': the others eat both: ' + JSON.stringify(r.lunches));
    }
    assert(control.lunches.otherUnderground > 0 && control.lunches.otherAbove > 0, 'the control eats both too');

    // Nobody is stranded by a station nobody can reach, and nobody is lost by one that works.
    assert(cut.let === cut.offices && served.let === served.offices && control.let === control.offices,
      'every office let: ' + [control.let, served.let, cut.let] + ' of ' + control.offices);
    assert(Math.abs(cut.stress - control.stress) <= 15, 'an unreachable platform costs the tower about nothing: ' + cut.stress + ' vs ' + control.stress);
    // The commuters add no people to the star ladder.
    assert(served.population === control.population && cut.population === control.population,
      'population is the tenants: ' + [control.population, served.population, cut.population]);
  },

  // ------------------------------------------------------------------ the shell

  'the palette, the ghost and the sprite: a button, a three-floor footprint, a sheet'() {
    const tool = TOOLS.find((t) => t.action === 'build' && t.what === 'metroStation');
    assert(tool && tool.label === 'Metro Station' && tool.width === 30, 'it has a palette entry');
    const w = world();
    const g = ghostMetro(w, -6, 100);
    assert(g.ok && g.cost === 1_045_000, 'the ghost prices it: ' + g.cost);
    assert(g.footprint.floors === 3 && g.footprint.floor === -6 && g.footprint.right - g.footprint.left + 1 === 30, 'three floors up from the click: ' + JSON.stringify(g.footprint));
    assert(commandFor(w.tower, tool, { floor: -6, tile: 100 }).what === 'metroStation', 'the click is a build command');
    const stack = metroObjects(must(buildMetro(w), 'build') && w.tower);
    const names = stack.map((o) => objectSprite(o).name + '/' + objectSprite(o).animation);
    assert(names.join() === 'metro/bottom,metro/middle,metro/top', names.join());
    for (const o of stack) o.platform = PLATFORM.train;
    assert(stack.map((o) => objectSprite(o).animation).join() === 'bottom-train,middle-train,top-train', 'a train swaps the slice');
  },

  'the hover says what it is for, and whether anything can come'() {
    const w = withMetro();
    const top = metroStations(w.tower)[0];
    let line = serviceReadout(top, w.tower);
    assert(/metro station/.test(line) && /NO lift reaches the platform/.test(line) && /cannot be bulldozed/.test(line), line);
    assert(metroServed(w.tower) === false, 'no lift stops at the platform');
    must(applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: -5, top: 5, column: 20 }), 'a lift to the line');
    assert(metroServed(w.tower) === true, 'one does now');
    line = serviceReadout(top, w.tower);
    assert(/a lift reaches the platform/.test(line) && !/NO lift/.test(line), line);
    assert(metroCommuterCount(w.tower) === 0, 'no offices yet, so no commuters: ' + metroCommuterCount(w.tower));
  },

  'a service lift does not count: staff ride it, people do not'() {
    const w = withMetro();
    must(applyAction(w, { type: 'build_shaft', kind: 'service', bottom: -5, top: 5, column: 20 }), 'a service lift');
    assert(metroServed(w.tower) === false, 'a service elevator does not bring the commuters');
  },

  // -------------------------------------------------------------------- save

  'save v9: the stack and its train survive a round trip, and a v8 file is refused'() {
    assert(SAVE_VERSION === 9, 'the shape changed (issue #15): ' + SAVE_VERSION);
    const w = withMetro();
    metroObjects(w.tower).forEach((o) => { o.platform = PLATFORM.train; });
    const back = restore(JSON.parse(JSON.stringify(snapshot(w))));
    assert(back.ok !== false, 'it loads: ' + back.reason);
    const t = back.world.tower;
    assert(metroObjects(t).length === 3 && metroFloor(t) === -4, 'the stack came back');
    assert(metroObjects(t).every((o) => o.platform === PLATFORM.train && o.stackId === metroStations(t)[0].id), 'the train and the stack id');
    assert(t.gates.metroPlaced === true, 'and the gate');
    const old = JSON.parse(JSON.stringify(snapshot(w)));
    old.version = 8;
    assert(restore(old).ok === false, 'a v8 save is refused');
    // A loaded tower still refuses a second station and a build under the first.
    assert(!applyAction(back.world, { type: 'build', what: 'metroStation', floor: -9, left: 10 }).ok, 'still one');
    assert(!applyAction(back.world, { type: 'build', what: 'security', floor: -8, left: 10 }).ok, 'still nothing under it');
  },

  'routing is untouched for a tower with no station: placement of a lone office does not read the metro'() {
    const w = world();
    const r = must(applyAction(w, { type: 'build', what: 'office', floor: 3, left: 10 }), 'an office');
    assert(placementObstruction(w.tower, BUILDABLE.office, 3, 40) === null && r.object.floor === 3, 'ordinary placement');
    assert(metroObstruction(w.tower, -6, 100) === null, 'and the station may go on a bare lot');
    rebuildRouteTables(w.tower);
    assert(w.tower.actors.length === 6, 'six workers, as ever');
  },
};
