/**
 * The map views (issue #18): Eval, Pricing and Hotel - and the pause they hold.
 *
 * `HELP.txt` § Map Window: Eval colours the tower by how happy its tenants are (*"Blue areas have an
 * Excellent rating. Yellow is a Good rating... Red means your tenants in that area are quite
 * unhappy"*), Pricing by how tenants perceive their rents, Hotel marks in red the rooms that need
 * cleaning, and *"these buttons pause the game"*.
 *
 * What these tests will not do is read their expectations back out of the code under test. The
 * Eval boundaries are written as literals (79 blue, 80 yellow, 149/150 and 199/200 for the two
 * star bands) and then checked AGAINST THE SIM: the colour must equal the grade the 2533 sweep
 * itself writes to the room, because a map that disagreed with the thing that closes the tenant
 * would be a map of nothing.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import { recomputeOfficeOperationalStatus } from '../src/games/tower/sim/office.js';
import { HOTEL_UNIT_STATUS, FAMILY, __resetIds, placeObject } from '../src/games/tower/sim/state.js';
import { isHotelInfested, isHotelRoomDirty } from '../src/games/tower/sim/hotel.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { tryStartBomb } from '../src/games/tower/sim/events.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { eventDialogBlocking } from '../src/games/tower/ui/event-dialog.js';
import { makeTickPump, SPEEDS } from '../src/games/tower/ui/loop.js';
import { makePauseGate } from '../src/games/tower/ui/pause.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeRenderer } from '../src/games/tower/render/canvas.js';
import { diskSpriteLoaders, stubCanvas } from './_headless.js';
import {
  OVERLAY_COLORS, OVERLAY_MODES, hasHotelRooms, mapBarModel, overlayHoverLine, overlayModel,
} from '../src/games/tower/ui/overlays.js';
import { actorsOf, assert, build, let_, liftedWorld, measure } from './_windows.js';

const colourOf = (world, object, mode = 'eval') => overlayModel(world.tower, mode).cells.get(object.id)?.color;

export const tests = {
  // ================================================================== Eval

  'Eval: blue under 80, yellow to the star band\'s threshold, red at it - 150 for 1-3 stars, 200 for 4+'() {
    const table = [
      // stars, stress, colour
      [3, 0, 'good'], [3, 79, 'good'], [3, 80, 'fair'], [3, 149, 'fair'], [3, 150, 'poor'], [3, 300, 'poor'],
      [4, 80, 'fair'], [4, 149, 'fair'], [4, 150, 'fair'], [4, 199, 'fair'], [4, 200, 'poor'],
      [5, 199, 'fair'], [5, 200, 'poor'],
      [1, 149, 'fair'], [1, 150, 'poor'],
    ];
    for (const [stars, stress, want] of table) {
      const w = liftedWorld({ stars });
      const office = build(w, 'office', 2, 44);
      let_(office);
      measure(w.tower, office, stress);
      const cell = overlayModel(w.tower, 'eval').cells.get(office.id);
      assert(cell.key === want && cell.color === OVERLAY_COLORS[want],
        `${stars} stars, stress ${stress}: the map says ${cell.key}, the rule says ${want}`);
      assert(cell.live === true && cell.score === stress, 'a measured room reads live at its own stress: ' + JSON.stringify(cell));
      // The map against the sweep that actually closes tenants: same grade.
      const level = recomputeOfficeOperationalStatus(w.tower, office, actorsOf(w.tower, office));
      assert(level === cell.level, `${stars} stars, stress ${stress}: the sweep graded ${level}, the map ${cell.level}`);
    }
  },

  'Eval: the rent tier and a noisy neighbour move the colour exactly as the evaluation does'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 2, 44);
    let_(office);
    measure(w.tower, office, 120);
    assert(colourOf(w, office) === OVERLAY_COLORS.fair, '120 at the default tier is yellow');

    applyAction(w, { type: 'set_rent', objectId: office.id, tier: 0 });      // dearest: +30 -> 150
    assert(colourOf(w, office) === OVERLAY_COLORS.poor, 'the dearest tier pushes 120 to 150, which is red');
    applyAction(w, { type: 'set_rent', objectId: office.id, tier: 2 });      // -30 -> 90
    assert(colourOf(w, office) === OVERLAY_COLORS.fair, '120 at tier 2 is 90: still yellow');
    measure(w.tower, office, 100);
    assert(colourOf(w, office) === OVERLAY_COLORS.good, '100 at tier 2 is 70: blue');
    applyAction(w, { type: 'set_rent', objectId: office.id, tier: 3 });      // forced to 0
    measure(w.tower, office, 299);
    assert(colourOf(w, office) === OVERLAY_COLORS.good, 'tier 3 always passes: blue at any stress');

    applyAction(w, { type: 'set_rent', objectId: office.id, tier: 1 });
    measure(w.tower, office, 30);
    assert(colourOf(w, office) === OVERLAY_COLORS.good, '30 is blue...');
    build(w, 'restaurant', 2, 52);                                            // 2 tiles from the office: +60
    assert(colourOf(w, office) === OVERLAY_COLORS.fair, '...until a restaurant moves in next door: 30 + 60 = 90 is yellow');
  },

  'Eval: a room nobody has measured is grey, not blue - no trips scores 0, the best grade, and that is not news'() {
    const w = liftedWorld({ stars: 3 });
    const vacant = build(w, 'office', 2, 44);
    const model = overlayModel(w.tower, 'eval');
    assert(model.cells.get(vacant.id).key === 'none', 'a vacant, unmeasured office has no reading: ' + model.cells.get(vacant.id).key);
    // Even if the bootstrap daily recompute has stamped it level 2 (it does, on a room nobody has reached).
    vacant.evalLevel = 2;
    assert(overlayModel(w.tower, 'eval').cells.get(vacant.id).key === 'none', 'a stored grade on an UNLET room is the bootstrap, not a verdict');
    // A let room whose counters were just reset keeps the last grade it earned, and says it is not live.
    let_(vacant);
    vacant.evalLevel = 1;
    const cell = overlayModel(w.tower, 'eval').cells.get(vacant.id);
    assert(cell.key === 'fair' && cell.live === false && cell.score === null, 'as last measured: ' + JSON.stringify(cell));
  },

  'Eval: colours rooms with feelings and nothing else'() {
    const w = liftedWorld({ stars: 5 });
    const office = build(w, 'office', 2, 44);
    build(w, 'condo', 3, 44);
    build(w, 'hotelSingle', 4, 44);
    build(w, 'restaurant', 5, 44);
    build(w, 'housekeeping', 6, 44);
    build(w, 'security', -1, 44);
    const model = overlayModel(w.tower, 'eval');
    const families = [...model.cells.keys()].map((id) => w.tower.objects.get(id).family).sort((a, b) => a - b);
    assert(JSON.stringify(families) === JSON.stringify([FAMILY.hotelSingle, FAMILY.office, FAMILY.restaurant, FAMILY.condo].sort((a, b) => a - b)),
      'only the four with tenants or customers: ' + JSON.stringify(families));
    assert(model.legend.map((l) => l.label).join('|') === 'Excellent|Good|Unhappy - may leave|No reading yet', 'the legend');
    assert(office.id !== undefined, 'fixture');
  },

  'Eval: the legend counts what is on the map'() {
    const w = liftedWorld({ stars: 3 });
    const rooms = [build(w, 'office', 2, 44), build(w, 'office', 3, 44), build(w, 'office', 4, 44), build(w, 'office', 5, 44)];
    [20, 100, 160].forEach((s, i) => { let_(rooms[i]); measure(w.tower, rooms[i], s); });
    const counts = overlayModel(w.tower, 'eval').counts;
    assert(counts.good === 1 && counts.fair === 1 && counts.poor === 1 && counts.none === 1, JSON.stringify(counts));
  },

  // ================================================================ Pricing

  'Pricing: the colour follows the tier set through set_rent, and the hover says the money'() {
    const w = liftedWorld({ stars: 5 });
    const office = build(w, 'office', 2, 44);
    const want = [['dear', 15_000], ['fair', 10_000], ['cheap', 5_000], ['bargain', 2_000]];
    want.forEach(([word, money], tier) => {
      assert(applyAction(w, { type: 'set_rent', objectId: office.id, tier }).ok, 'tier ' + tier);
      const cell = overlayModel(w.tower, 'pricing').cells.get(office.id);
      assert(cell.key === word && cell.color === OVERLAY_COLORS[word] && cell.tier === tier, `tier ${tier}: ${JSON.stringify(cell)}`);
      const hover = overlayHoverLine(w.tower, 'pricing', office);
      assert(hover === `Office, Floor 2 · ${word} · rent $${money.toLocaleString('en-US')}`, 'hover: ' + hover);
    });
    assert(new Set(want.map(([k]) => OVERLAY_COLORS[k] ?? OVERLAY_COLORS.fair)).size === 4, 'four tiers, four colours');
  },

  'Pricing: only things with a rent are coloured, and a hotel room is priced per stay, a condo by its price'() {
    const w = liftedWorld({ stars: 5 });
    const hotel = build(w, 'hotelSuite', 2, 44);
    const condo = build(w, 'condo', 3, 44);
    build(w, 'security', -1, 44);
    build(w, 'restaurant', 4, 44);
    const retail = build(w, 'retail', 5, 44);
    const model = overlayModel(w.tower, 'pricing');
    assert(model.cells.size === 3 && model.cells.has(hotel.id) && model.cells.has(condo.id) && model.cells.has(retail.id),
      'hotel, condo and retail only: ' + model.cells.size);
    assert(overlayHoverLine(w.tower, 'pricing', hotel) === 'Hotel Suite, Floor 2 · fair · per stay $6,000', overlayHoverLine(w.tower, 'pricing', hotel));
    assert(overlayHoverLine(w.tower, 'pricing', condo) === 'Condo, Floor 3 · fair · price $150,000', overlayHoverLine(w.tower, 'pricing', condo));
  },

  'Pricing: a sold condo\'s tier cannot be changed, so its colour cannot be moved from under it'() {
    const w = liftedWorld({ stars: 5 });
    const condo = build(w, 'condo', 3, 44);
    condo.unitStatus = 0x00; condo.occupiedFlag = true;                       // sold
    const r = applyAction(w, { type: 'set_rent', objectId: condo.id, tier: 0 });
    assert(!r.ok && overlayModel(w.tower, 'pricing').cells.get(condo.id).key === 'fair', 'still fair: ' + r.reason);
  },

  // ================================================================== Hotel

  'Hotel: marks exactly the dirty and the infested rooms - clean, vacant and booked rooms are not marked'() {
    const w = liftedWorld({ stars: 5 });
    const S = HOTEL_UNIT_STATUS;
    const rooms = [
      ['booked', S.occupiedEarly, 'clean'], ['booked late', S.occupiedLate, 'clean'], ['vacant', S.vacantEarly, 'clean'],
      ['vacant late', S.vacantLate, 'clean'], ['dirty', S.dirtyEarly, 'dirty'], ['dirty late', S.dirtyLate, 'dirty'],
      ['infested', 0x38, 'infested'], ['infested late', 0x40, 'infested'],
    ].map(([label, status, mark], i) => {
      const o = build(w, 'hotelSingle', 2 + i, 44);
      o.unitStatus = status;
      return { label, o, mark };
    });
    const model = overlayModel(w.tower, 'hotel');
    for (const { label, o, mark } of rooms) {
      assert(model.cells.get(o.id).key === mark, `${label} (0x${o.unitStatus.toString(16)}) should be ${mark}, is ${model.cells.get(o.id).key}`);
    }
    // The rooms the player would see in red: independent of the sim's own predicates (0x28 and up).
    const red = [...model.cells].filter(([, c]) => c.key !== 'clean').map(([id]) => id).sort((a, b) => a - b);
    const expected = rooms.filter(({ o }) => o.unitStatus >= 0x28).map(({ o }) => o.id).sort((a, b) => a - b);
    assert(JSON.stringify(red) === JSON.stringify(expected), 'the marked rooms are exactly the rooms at 0x28 and above');
    assert(model.counts.dirty === 2 && model.counts.infested === 2 && model.counts.clean === 4, JSON.stringify(model.counts));
    assert(model.cells.get(rooms[4].o.id).color === OVERLAY_COLORS.dirty && model.cells.get(rooms[6].o.id).color === OVERLAY_COLORS.infested, 'dirty and infested differ');
  },

  'Hotel: after real days with no housekeeping the marked rooms are the rooms the sim calls dirty or infested'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    assert(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top: 9, column: 40 }).ok, 'lift');
    const rooms = [];
    for (let i = 0; i < 10; i++) rooms.push(applyAction(world, { type: 'build', what: 'hotelSingle', floor: 8, left: 60 + i * 4 }).object);
    rebuildRouteTables(tower);
    const { scheduler } = makeDriver(world);
    let sawDirty = false, sawInfested = false;
    for (let day = 0; day < 6; day++) {
      for (let t = 0; t < 2600; t++) scheduler.tick(tower);
      const model = overlayModel(tower, 'hotel');
      const marked = new Set([...model.cells].filter(([, c]) => c.key !== 'clean').map(([id]) => id));
      const sim = new Set(rooms.filter((o) => isHotelRoomDirty(o) || isHotelInfested(o)).map((o) => o.id));
      assert(marked.size === sim.size && [...marked].every((id) => sim.has(id)), `day ${day}: marked ${[...marked]} vs sim ${[...sim]}`);
      // ...and independently of the sim's predicates: the band.
      assert(rooms.filter((o) => o.unitStatus >= 0x28).length === marked.size, 'the band agrees');
      if (model.counts.dirty > 0) sawDirty = true;
      if (model.counts.infested > 0) sawInfested = true;
    }
    assert(sawDirty && sawInfested, 'the fixture must actually grow dirty rooms and lose some (dirty ' + sawDirty + ', infested ' + sawInfested + ')');
  },

  'Hotel: the button is live only when there are hotel rooms'() {
    const w = liftedWorld({ stars: 5 });
    assert(hasHotelRooms(w.tower) === false, 'none yet');
    const dead = mapBarModel(w.tower).find((b) => b.id === 'hotel');
    assert(dead.enabled === false && dead.reason === 'you have no hotel rooms', JSON.stringify(dead));
    build(w, 'hotelSingle', 2, 44);
    assert(mapBarModel(w.tower).find((b) => b.id === 'hotel').enabled === true, 'and live with one');
  },

  // =============================================================== the picture

  'the renderer paints the view\'s colours over the rooms, and dims what the view does not speak about'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 2, 44);
    let_(office); measure(w.tower, office, 20);
    const bad = build(w, 'office', 3, 44);
    let_(bad); measure(w.tower, bad, 200);
    build(w, 'security', -1, 44);
    const canvas = stubCanvas(1200, 760);
    const ctx = canvas.getContext('2d');
    const painted = new Set();
    let current = ctx.fillStyle;
    Object.defineProperty(ctx, 'fillStyle', { get: () => current, set: (v) => { current = v; painted.add(v); } });
    const renderer = makeRenderer(canvas, { sprites: diskSpriteLoaders });
    renderer.resize();
    renderer.goTo(2, 50);
    renderer.draw(w.tower, 16);
    assert(!painted.has(OVERLAY_COLORS.good) && !painted.has('rgba(8,12,18,0.62)'), 'no wash without a view');

    painted.clear();
    renderer.setOverlay(overlayModel(w.tower, 'eval').cells);
    renderer.draw(w.tower, 16);
    assert(painted.has(OVERLAY_COLORS.good), 'the happy office is painted blue');
    assert(painted.has(OVERLAY_COLORS.poor), 'the unhappy one red');
    assert(painted.has('rgba(8,12,18,0.62)'), 'and rooms the view says nothing about are dimmed (the security office, the lobby)');

    painted.clear();
    renderer.setOverlay(null);
    renderer.draw(w.tower, 16);
    assert(!painted.has('rgba(8,12,18,0.62)'), 'taking the view off takes the wash off');
  },

  // ============================================================== the hover

  'the hover under a view says what the colour means and why, in the original\'s words'() {
    const w = liftedWorld({ stars: 3, column: 120 });                   // a lift 120 tiles from the lot's edge: "far away"
    const office = build(w, 'office', 2, 124);
    let_(office);
    measure(w.tower, office, 130);
    const line = overlayHoverLine(w.tower, 'eval', office);
    assert(line === 'Office, Floor 2 · fair (stress 130) · Elevator is far away', line);
    build(w, 'restaurant', 2, 96);
    assert(overlayHoverLine(w.tower, 'eval', office).endsWith('Elevator is far away · Neighbors are too noisy'), overlayHoverLine(w.tower, 'eval', office));
  },

  // ================================================================= the bar

  'the map bar offers Edit, Eval, Pricing, Hotel and Finance, and goes dead while the tower asks a question'() {
    const w = liftedWorld({ stars: 3 });
    build(w, 'hotelSingle', 2, 44);
    const ids = (bar) => bar.map((b) => b.id).join(',');
    assert(ids(mapBarModel(w.tower)) === 'edit,eval,pricing,hotel,finance', ids(mapBarModel(w.tower)));
    assert(mapBarModel(w.tower).every((b) => b.enabled), 'all live');
    assert(JSON.stringify(OVERLAY_MODES) === '["eval","pricing","hotel"]', 'the three views');

    // A bomb is asking: nothing but Edit opens.
    __resetIds();
    const asking = newTowerWorld({ seed: 1, cash: 5_000_000 });
    asking.tower.starCount = 3;
    for (let floor = 1; floor <= 6; floor++) for (const left of [0, 20, 40]) {
      placeObject(asking.tower, { family: FAMILY.office, floor, left, right: left + 5 }, () => createSimTripRecord());
    }
    asking.tower.clock.dayCounter = 59; asking.tower.clock.dayTick = 240; asking.tower.clock.daypart = 0;
    assert(tryStartBomb(asking.tower), 'bomb');
    const bar = mapBarModel(asking.tower);
    assert(bar.find((b) => b.id === 'edit').enabled, 'Edit is always there');
    for (const id of ['eval', 'pricing', 'hotel', 'finance']) {
      const b = bar.find((x) => x.id === id);
      assert(b.enabled === false && b.reason === 'answer the question first', id + ': ' + JSON.stringify(b));
    }
  },

  // =================================================================== pause

  'the gate: a hold pauses, the release gives back the speed the player chose'() {
    const seen = [];
    const gate = makePauseGate({ initial: 4, onChange: (s) => seen.push(s.speed) });
    assert(gate.speed === 4 && gate.wanted === 4, 'running at 4x');
    gate.hold('eval');
    assert(gate.speed === 0 && gate.wanted === 4 && gate.isHeld('eval'), 'held');
    gate.release('eval');
    assert(gate.speed === 4, 'and 4x comes back, not 1x: ' + gate.speed);
    assert(JSON.stringify(seen) === '[0,4]', 'told the page twice: ' + JSON.stringify(seen));
  },

  'the gate: a game the player paused stays paused after a view closes'() {
    const gate = makePauseGate({ initial: 2 });
    gate.request(0);
    gate.hold('pricing');
    gate.release('pricing');
    assert(gate.speed === 0 && gate.wanted === 0, 'a hold never turns a pause into a play');
  },

  'the gate: choosing a speed while a view is open changes what comes back, not what runs now'() {
    const gate = makePauseGate({ initial: 1 });
    gate.hold('hotel');
    assert(gate.request(4) === 0 && gate.speed === 0 && gate.wanted === 4, 'still still');
    gate.release('hotel');
    assert(gate.speed === 4, 'and it comes back at the new choice');
    assert(gate.request(7) === 1 && gate.wanted === 1, 'a speed that is not one of ' + SPEEDS + ' falls back to 1x');
  },

  'the gate: overlapping holds run the game again only when the last has let go'() {
    const gate = makePauseGate({ initial: 2 });
    gate.hold('facility'); gate.hold('tenant');
    gate.release('facility');
    assert(gate.speed === 0, 'the tenant window still holds');
    gate.release('tenant');
    assert(gate.speed === 2, 'now it runs');
    gate.hold('eval'); gate.hold('eval');
    gate.release('eval');
    assert(gate.speed === 2, 'holding twice with one key is one hold');
    gate.hold('a'); gate.hold('b');
    gate.releaseAll();
    assert(gate.speed === 2 && gate.held.length === 0, 'Escape drops everything');
  },

  'an open view stops the real clock and the release restores the real speed - through the tick pump and the scheduler'() {
    const frames = (gate, world, scheduler, n, dt = 100) => {
      const pump = makeTickPump();
      let ticks = 0;
      for (let i = 0; i < n; i++) {
        // main.js's frame, verbatim in shape: the pump at the gate's speed, a tick unless the dialog blocks.
        pump.advance(dt, gate.speed, () => { if (!eventDialogBlocking(world.tower)) { scheduler.tick(world.tower); ticks++; } });
      }
      return ticks;
    };
    const fresh = () => {
      const world = liftedWorld({ stars: 3 });
      return { world, scheduler: makeDriver(world).scheduler };
    };
    const control = fresh();
    const controlGate = makePauseGate({ initial: 4 });
    const ran = frames(controlGate, control.world, control.scheduler, 50);
    assert(ran > 200, 'the control runs at 4x: ' + ran + ' ticks in 50 frames');

    const t = fresh();
    const gate = makePauseGate({ initial: 4 });
    gate.hold('eval');
    assert(frames(gate, t.world, t.scheduler, 50) === 0, 'with Eval open the clock does not move');
    gate.release('eval');
    assert(frames(gate, t.world, t.scheduler, 50) === ran, 'and when it closes it runs at 4x again: exactly the control\'s ' + ran);
  },

  'a view cannot un-block the event dialog: held, released, the question is still open and the clock still does not move'() {
    __resetIds();
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    for (let floor = 1; floor <= 6; floor++) for (const left of [0, 20, 40]) {
      placeObject(tower, { family: FAMILY.office, floor, left, right: left + 5 }, () => createSimTripRecord());
    }
    tower.clock.dayCounter = 59; tower.clock.dayTick = 240; tower.clock.daypart = 0;
    assert(tryStartBomb(tower) && eventDialogBlocking(tower), 'a bomb is asking');
    const { scheduler } = makeDriver(world);
    const gate = makePauseGate({ initial: 1 });
    const pump = makeTickPump();
    const run = (n) => { for (let i = 0; i < n; i++) pump.advance(100, gate.speed, () => { if (!eventDialogBlocking(tower)) scheduler.tick(tower); }); };

    run(30);
    assert(tower.clock.dayTick === 240, 'blocked by the question alone');
    gate.hold('finance'); run(30); gate.release('finance'); run(30);
    assert(tower.clock.dayTick === 240 && eventDialogBlocking(tower), 'a hold and its release left the question exactly as it was');
    gate.request(4); run(30);
    assert(tower.clock.dayTick === 240, 'even at 4x');
    assert(applyAction(world, { type: 'answer_event', answer: 'pay' }).ok, 'answered');
    run(30);
    assert(tower.clock.dayTick > 240, 'and now it runs');
  },
};
