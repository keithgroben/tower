/**
 * The cathedral and the wedding (issue #17): five stars, $3,000,000, one to a tower, the 100th
 * floor only, never bulldozed, never burned - and the forty guests whose arrival crowns the tower.
 *
 * Spec: `specs/facility/EVALUATION.md` (the whole file), `specs/COMMANDS.md` § Floor-class rules and
 * § Command-dispatch limits, `specs/DEMAND.md` § Families `0x24`-`0x28`, `specs/TIME.md` § 0 step 6 and
 * § 1200 step 4, `specs/EVENTS.md` § Fire Event. `spec/DEVIATIONS.md` A73-A80.
 *
 * ## How this file proves it
 *
 *  - **placement** goes through `applyAction` and the ghost (`preview`) side by side, on the verdict AND
 *    the wording, because the lesson `CLAUDE.md` keeps is that a test pinning one side of an agreement
 *    is not a test of it;
 *  - **the gate and the count** are driven through the family handler with a stub router (so the
 *    odds, the weekend and the deadline are read off the rule and not off a lucky lift), and then
 *  - **the wedding is run end to end** through `makeDriver`'s scheduler, the real router and real
 *    lifts up to floor 99 (`weddingTower`), with the Tower rank watched flipping and every missing
 *    part taken away alone.
 */
import { applyAction, BUILDABLE, buildCost, demolishRefusal, gradeReason } from '../src/games/tower/sim/actions.js';
import { CONSTRUCTION_COST, TYPE_CODES, floorConstructionCost } from '../src/games/tower/sim/economy.js';
import {
  AUX, CATHEDRAL_BASE_FLOOR, CATHEDRAL_FLOORS, CATHEDRAL_TOP_FLOOR, CATHEDRAL_TYPES, CATHEDRAL_WIDTH, GATE_CERTAIN_FROM_TICK,
  GATE_ODDS, GATE_ROLL_FROM_TICK, GUEST_STATE, MAX_CATHEDRALS, MIDDAY_RETURN_TICK, activateWeddingGuests,
  cathedralArrival, cathedralFamilyHandler, cathedralFloorReason, cathedralGuests, cathedralObjects,
  cathedralServed, guestsAtTheCathedral, hasCathedral, placeCathedral, sendWeddingGuestsHome,
} from '../src/games/tower/sim/cathedral.js';
import {
  BOMB_DEADLINE_TICK, INDESTRUCTIBLE_FAMILIES, destroyObject, eventsOf, eventsTick, isIndestructible, tryStartFire,
} from '../src/games/tower/sim/events.js';
import {
  CATHEDRAL_FLOOR, STAR_REQUIREMENT, TOWER_RANK, WEDDING_DEADLINE_TICK, WEDDING_GUESTS,
  lockReason, starGateStatus, starGatesOf, tryAdvanceStar,
} from '../src/games/tower/sim/progression.js';
import { FAMILY, OBJECT_TYPE, __resetIds, createTower, placeObject, population } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { noticesAfter } from '../src/games/tower/sim/demands.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { HOTEL_SALE_RESET_TICK } from '../src/games/tower/sim/hotel.js';
import { calendarPhaseFlag } from '../src/games/tower/sim/clock.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { TOOLS, commandFor, preview, toolById } from '../src/games/tower/ui/build.js';
import { eventsReadout, serviceReadout, weddingReadout } from '../src/games/tower/ui/readout.js';
import { objectSprite, SPRITE_USES } from '../src/games/tower/render/canvas.js';
import { finaleKeyOf, finaleModel } from '../src/games/tower/ui/finale.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { buildWeddingSpine, weddingTower, weddingTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const same = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));

const WEEKEND = 2;      // (2 % 12) % 3 = 2
const WEEKDAY = 3;      // (3 % 12) % 3 = 0

/** A five-star tower on a bare lot with money. */
function world5({ stars = 5, cash = 90_000_000 } = {}) {
  const w = newTowerWorld({ seed: 1, cash });
  w.tower.starCount = stars;
  return w;
}
const buildCath = (w, floor = CATHEDRAL_BASE_FLOOR, left = 40) => applyAction(w, { type: 'build', what: 'cathedral', floor, left });
const ghost = (w, floor = CATHEDRAL_BASE_FLOOR, left = 40) => preview(w, toolById('cathedral'), { floor, tile: left });
const must = (r, what) => { assert(r.ok, what + ': ' + r.reason); return r; };

/** Set the clock the way the tests want it, with the calendar phase the day counter implies. */
function at(tower, dayCounter, dayTick) {
  tower.clock.dayCounter = dayCounter;
  tower.clock.dayTick = dayTick;
  tower.clock.daypart = Math.floor(dayTick / 400);
  tower.clock.calendarPhase = calendarPhaseFlag(dayCounter);
}

/** A stub router: every call is recorded and answers `code` (2 = queued on a car). */
function stubCtx(code = 2) {
  const calls = [];
  return {
    calls,
    resolveRoute: (tower, actor, from, to) => { calls.push({ id: actor.id, from, to }); return { code, legDestination: from }; },
    onDelay: () => {},
  };
}

/** A bare tower with a cathedral placed straight onto it, and no lifts. */
function bareCathedral(seed = 1) {
  __resetIds();
  const tower = createTower({ seed });
  tower.starCount = 5;
  const placed = placeCathedral(tower, { floor: CATHEDRAL_BASE_FLOOR, left: 20 }, () => createSimTripRecord());
  assert(placed.ok, 'fixture: ' + placed.reason);
  return tower;
}

/** Service every guest once with the handler. */
function pass(tower, handler) {
  for (const guest of cathedralGuests(tower)) handler(tower, guest);
}

export const tests = {
  // ------------------------------------------------------------------ the facts

  'the numbers: five stars, $3,000,000, 28 tiles, five floors, types 0x24-0x28, floor 99, one'() {
    assert(CONSTRUCTION_COST.cathedral === 3_000_000, 'the build cost: ' + CONSTRUCTION_COST.cathedral);
    assert(STAR_REQUIREMENT.cathedral === 5, 'unlocks at ' + STAR_REQUIREMENT.cathedral);
    assert(CATHEDRAL_WIDTH === 28 && BUILDABLE.cathedral.width === 28, 'EVALUATION.md: 28 tiles');
    assert(CATHEDRAL_FLOORS === 5 && BUILDABLE.cathedral.floors === 5, 'a five-floor stack');
    assert(TYPE_CODES.cathedral === 0x24 && FAMILY.cathedral === 0x24 && OBJECT_TYPE.cathedralSlice1 === 0x24, 'type 0x24');
    assert(CATHEDRAL_TYPES.join() === [0x24, 0x25, 0x26, 0x27, 0x28].join(), 'types 0x24..0x28, lowest first: ' + CATHEDRAL_TYPES);
    assert(MAX_CATHEDRALS === 1, 'COMMANDS.md: a singleton');
    // The 100th floor is logical 99 (the original counts its ground floor as 1; EVALUATION.md sends the
    // guests to raw floor 109 = logical 99), and the stack's top slice is the spec's "anchor floor 103".
    assert(CATHEDRAL_BASE_FLOOR === 99 && CATHEDRAL_FLOOR === 99 && BUILDABLE.cathedral.onlyFloor === 99, 'the 100th floor is 99');
    assert(CATHEDRAL_TOP_FLOOR === 103, 'COMMANDS.md: the anchor is floor 103');
    assert(WEDDING_GUESTS === 40 && WEDDING_DEADLINE_TICK === 800, 'forty guests before tick 800');
    assert(GATE_ROLL_FROM_TICK === 80 && GATE_CERTAIN_FROM_TICK === 240 && GATE_ODDS === 12, 'DEMAND.md: > 80 at 1 in 12, > 240 for certain');
    assert(MIDDAY_RETURN_TICK === HOTEL_SALE_RESET_TICK && MIDDAY_RETURN_TICK === 0x4b0, 'the guests go home at checkpoint 0x04b0 (1200)');
    assert(TOWER_RANK === 6, 'the rank is star_count 6');
  },

  'the price a player pays is the menu price plus the floor tiles of all five floors'() {
    const w = world5();
    const cost = buildCost(w.tower, BUILDABLE.cathedral, CATHEDRAL_BASE_FLOOR);
    const tiles = [0, 1, 2, 3, 4].reduce((n, i) => n + floorConstructionCost({ floor: 99 + i, tiles: 28, lobbyHeight: 1 }), 0);
    assert(tiles === 5 * 28 * 500 && cost === 3_000_000 + 70_000, 'the object price plus $70,000 of floor: ' + cost);
    const before = w.tower.cash;
    const r = must(buildCath(w), 'build');
    assert(r.cost === cost && before - w.tower.cash === cost, 'charged exactly that, once: ' + (before - w.tower.cash));
  },

  // ----------------------------------------------------- the stack

  'it is a five-floor stack on floors 99-103, the click floor the lowest, forty parked guests, no population'() {
    const w = world5();
    const r = must(buildCath(w, 99, 40), 'build');
    const stack = cathedralObjects(w.tower);
    assert(stack.length === 5 && hasCathedral(w.tower), 'five placed objects: ' + stack.length);
    assert(stack.map((o) => o.floor).join() === '99,100,101,102,103', 'floors: ' + stack.map((o) => o.floor));
    assert(stack.map((o) => o.type).join() === [0x24, 0x25, 0x26, 0x27, 0x28].join(), 'types bottom to top');
    assert(stack.every((o) => o.family === FAMILY.cathedral && o.left === 40 && o.right === 67 && o.occupants.length === 8),
      'one family, 28 tiles, eight guests a slice');
    assert(r.object.type === 0x28 && r.object.floor === 103, 'the result is the top (anchor) slice');
    assert(stack.every((o) => o.stackId === r.object.id), 'one stack id');
    const guests = cathedralGuests(w.tower);
    assert(guests.length === 40 && guests.every((g) => g.family === 0x24 && g.state === GUEST_STATE.parked),
      'forty guests, every one family 0x24, parked at placement (EVALUATION.md: initial state 0x27)');
    assert(population(w.tower) === 0, 'a wedding guest is not a resident: ' + population(w.tower));
    assert(starGatesOf(w.tower).cathedralPlaced === true, 'placing it latched the 5 -> Tower gate');
    assert(stack.every((o) => o.aux === AUX.idle), 'no display state yet');
  },

  // ----------------------------------------------------- the 100th floor only

  'the 100th floor only: every other floor is refused, ghost and seam word it alike, and nothing is taken'() {
    assert(gradeReason(BUILDABLE.cathedral, 99) === null && cathedralFloorReason(99) === null, 'floor 99 is the one');
    for (const floor of [-3, 0, 1, 14, 50, 97, 98, 100, 101, 105]) {
      const w = world5();
      const cash = w.tower.cash;
      const seam = buildCath(w, floor);
      assert(!seam.ok && /available only on the 100th floor \(floor 99\)/.test(seam.reason), 'floor ' + floor + ': ' + seam.reason);
      const g = ghost(w, floor);
      assert(!g.ok && g.reason === seam.reason, 'two voices for one refusal at ' + floor + ': ' + g.reason + ' / ' + seam.reason);
      assert(w.tower.cash === cash && !hasCathedral(w.tower) && w.tower.actors.length === 0, 'nothing built, nothing taken at ' + floor);
    }
    assert(buildCath(world5(), 99).ok, 'and floor 99 stands');
    // A direct placement cannot dodge the rule either: the placer asks the same question.
    const bare = createTower({ seed: 1 });
    assert(!placeCathedral(bare, { floor: 98, left: 0 }).ok && bare.objects.size === 0, 'placeCathedral refuses floor 98 too');
  },

  'one to a tower: a second is refused with the original\'s sentence, ghost and seam alike'() {
    const w = world5();
    must(buildCath(w, 99, 10), 'the first');
    const cash = w.tower.cash;
    const seam = buildCath(w, 99, 60);
    assert(!seam.ok && /only one cathedral/.test(seam.reason), seam.reason);
    const g = ghost(w, 99, 60);
    assert(!g.ok && g.reason === seam.reason, 'ghost: ' + g.reason);
    assert(cathedralObjects(w.tower).length === 5 && w.tower.cash === cash, 'still one stack, nothing taken');
  },

  'five stars: a four-star tower is refused with the lock before anything else, ghost and seam alike'() {
    for (const stars of [1, 3, 4]) {
      const w = world5({ stars });
      const seam = buildCath(w, 50);                 // the wrong floor too: the lock is said first
      assert(!seam.ok && seam.reason === lockReason(w.tower, 'cathedral', 'Cathedral'), stars + ' stars: ' + seam.reason);
      assert(/needs a tower of 5 stars/.test(seam.reason), seam.reason);
      const g = ghost(w, 50);
      assert(!g.ok && g.reason === seam.reason, 'ghost: ' + g.reason);
    }
    assert(buildCath(world5({ stars: 5 })).ok, 'five stars builds it');
    assert(buildCath(world5({ stars: 6 })).ok, 'and so does the rank above');
  },

  'a clear span on all five floors: anything in the way refuses it, and nothing is built or charged'() {
    for (const [floor, left] of [[99, 50], [101, 45], [103, 67]]) {
      const w = world5();
      const tile = placeObject(w.tower, { family: FAMILY.office, floor, left, right: left + 5 }, () => createSimTripRecord());
      assert(tile.ok, 'fixture');
      const cash = w.tower.cash;
      const seam = buildCath(w, 99, 40);
      assert(!seam.ok && /already built/.test(seam.reason), 'an office on floor ' + floor + ': ' + seam.reason);
      assert(ghost(w, 99, 40).reason === seam.reason, 'ghost');
      assert(w.tower.cash === cash && cathedralObjects(w.tower).length === 0, 'no half-built chapel');
    }
    const w = world5();
    placeObject(w.tower, { family: FAMILY.office, floor: 101, left: 68, right: 73 }, () => createSimTripRecord());
    assert(buildCath(w, 99, 40).ok, 'an office touching the span is not in it');
  },

  'cannot afford it: nothing is built and the sentence quotes the whole price'() {
    const w = world5({ cash: 3_000_000 });
    const seam = buildCath(w);
    assert(!seam.ok && /costs \$3,070,000 and you have \$3,000,000/.test(seam.reason), seam.reason);
    assert(ghost(w).reason === seam.reason, 'ghost');
    assert(cathedralObjects(w.tower).length === 0 && w.tower.cash === 3_000_000, 'nothing built, nothing taken');
  },

  'the palette has a button for it, and the ghost is five floors tall'() {
    assert(TOOLS.some((t) => t.action === 'build' && t.what === 'cathedral' && t.label === 'Cathedral'), 'a Cathedral tool');
    const w = world5();
    const g = ghost(w);
    assert(g.ok && g.footprint.floors === 5 && g.footprint.floor === 99 && g.footprint.right - g.footprint.left + 1 === 28, JSON.stringify(g.footprint));
    assert(g.cost === 3_070_000 && g.command.what === 'cathedral', 'the ghost prices it: ' + g.cost);
    assert(commandFor(w.tower, toolById('cathedral'), { floor: 99, tile: 40 }).left === 40, 'and sends the click through');
  },

  // ----------------------------------------------------- not bulldozable, not burnable

  'it cannot be bulldozed: any of the five slices refuses, seam and rule alike'() {
    const w = world5();
    must(buildCath(w), 'build');
    for (const slice of cathedralObjects(w.tower)) {
      assert(demolishRefusal(slice) === 'the cathedral cannot be bulldozed', 'rule: ' + demolishRefusal(slice));
      const r = applyAction(w, { type: 'demolish', objectId: slice.id });
      assert(!r.ok && r.reason === 'the cathedral cannot be bulldozed', 'seam: ' + r.reason);
    }
    assert(cathedralObjects(w.tower).length === 5 && cathedralGuests(w.tower).length === 40, 'all five and the forty stand');
  },

  'a fire or a bomb cannot destroy it: the whole stack is indestructible'() {
    assert(INDESTRUCTIBLE_FAMILIES.has(FAMILY.cathedral), 'family 0x24 is on the list');
    const tower = bareCathedral();
    for (const slice of cathedralObjects(tower)) {
      assert(isIndestructible(slice) && destroyObject(tower, slice, 'fire') === false && destroyObject(tower, slice, 'blast') === false,
        'slice ' + slice.type.toString(16));
    }
    assert(cathedralObjects(tower).length === 5 && cathedralGuests(tower).length === 40, 'nothing left the tower');
  },

  'a bomb that goes off beside it takes the office next door and leaves the cathedral standing'() {
    const tower = bareCathedral();
    tower.starCount = 3;
    // An office on floor 98, inside the blast (floors bomb - 2 .. bomb + 3 = 98..103), beside the stack.
    const office = placeObject(tower, { family: FAMILY.office, floor: 98, left: 50, right: 55 }, () => createSimTripRecord());
    assert(office.ok, 'fixture');
    const events = eventsOf(tower);
    events.bombActive = true;
    events.bomb = {
      floor: 100, x: 40, ransom: 300_000, phase: 'armed', plantedDay: 0, armedTick: 240, scanFrom: 70, scanned: 0, resolveAt: null,
    };
    tower.clock.dayTick = BOMB_DEADLINE_TICK;
    eventsTick(tower);
    assert(events.bomb.phase === 'exploded', 'the bomb went off: ' + events.bomb.phase);
    assert(!tower.objects.has(office.object.id), 'the office on floor 98 was destroyed (the control)');
    assert(cathedralObjects(tower).length === 5 && cathedralGuests(tower).length === 40, 'the cathedral stands, whole, with its guests');
  },

  'no fire while a cathedral stands: the evaluation site is the building, not the latch'() {
    const tower = bareCathedral();
    tower.starCount = 3;
    at(tower, 83, 240);
    for (let floor = 1; floor <= 5; floor++) for (const left of [0, 20, 40]) {
      placeObject(tower, { family: FAMILY.office, floor, left, right: left + 5 }, () => createSimTripRecord());
    }
    assert(!tryStartFire(tower) && !tower.events.fireActive, 'the cathedral keeps the fire away');
    for (const slice of cathedralObjects(tower)) tower.objects.delete(slice.id);
    starGatesOf(tower).cathedralPlaced = true;               // the latch alone, with the building gone
    assert(tryStartFire(tower), 'the latch is not an evaluation site');
  },

  // ----------------------------------------------------- the gate

  'the gate: a weekday sends nobody, and a guest waits (0x20) until the next morning'() {
    const tower = bareCathedral();
    const ctx = stubCtx();
    const handler = cathedralFamilyHandler(ctx);
    activateWeddingGuests(tower);
    for (let tick = 0; tick < 2300; tick += 16) { at(tower, WEEKDAY, tick); pass(tower, handler); }
    assert(ctx.calls.length === 0, 'no route was asked for on a weekday: ' + ctx.calls.length);
    assert(cathedralGuests(tower).every((g) => g.state === GUEST_STATE.waiting), 'every guest is still waiting (the weekend test is first)');
    assert(starGatesOf(tower).weddingGuestsArrived === 0, 'nobody arrived');
  },

  'the gate: on a weekend nobody stirs by tick 80, a few set out from 81 at one in twelve, everybody is out after 240'() {
    const tower = bareCathedral();
    const ctx = stubCtx();
    const handler = cathedralFamilyHandler(ctx);
    const out = () => cathedralGuests(tower).filter((g) => g.state === GUEST_STATE.outbound).length;
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 80);
    pass(tower, handler);
    assert(out() === 0 && ctx.calls.length === 0, 'tick 80 is not past 80: nobody');
    // 81..240: each pass is a 1 in 12 roll per waiting guest. Over ten stride passes with this seed, some go and not all.
    let from = 81;
    for (let pass_ = 0; pass_ < 10; pass_++, from += 16) { at(tower, WEEKEND, from); pass(tower, handler); }
    const early = out();
    assert(early > 0 && early < 40, 'a trickle from tick 81, and not the lot: ' + early);
    assert(ctx.calls.every((c) => c.from === 0 && c.to === CATHEDRAL_BASE_FLOOR), 'every ask is lobby to floor 99');
    // After 240 the first pass sends everybody who is left.
    at(tower, WEEKEND, 241);
    pass(tower, handler);
    assert(out() === 40, 'every one of the forty is on his way: ' + out());
    // And one dispatch a pass: the roll and the certainty do not both send the same guest.
    const asks = ctx.calls.filter((c) => c.id === cathedralGuests(tower)[0].id).length;
    assert(asks <= 11, 'a guest is asked for once a pass: ' + asks);
  },

  'the gate: a guest who has not gone by daypart 1 has missed the wedding and is parked for the day'() {
    const tower = bareCathedral();
    const ctx = stubCtx();
    const handler = cathedralFamilyHandler(ctx);
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 400);                               // daypart 1
    pass(tower, handler);
    assert(cathedralGuests(tower).every((g) => g.state === GUEST_STATE.parked) && ctx.calls.length === 0, 'parked, and never asked');
  },

  'the gate: no route means a parked guest and no wedding - the lifts decide'() {
    const tower = bareCathedral();
    const ctx = stubCtx(-1);                               // the router: "there is no route"
    const handler = cathedralFamilyHandler(ctx);
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 250);
    pass(tower, handler);
    assert(cathedralGuests(tower).every((g) => g.state === GUEST_STATE.parked), 'failure parks (0x27)');
    assert(starGatesOf(tower).weddingGuestsArrived === 0, 'and nothing counts');
  },

  'a same-floor result arrives at once; a queued or walking result rides (0x60)'() {
    const tower = bareCathedral();
    const handler = cathedralFamilyHandler(stubCtx(3));
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 250);
    pass(tower, handler);
    assert(cathedralGuests(tower).every((g) => g.state === GUEST_STATE.arrived), 'result 3 sets 0x03');
    assert(starGatesOf(tower).weddingGuestsArrived === 40, 'and runs the arrival count: ' + starGatesOf(tower).weddingGuestsArrived);
    const t2 = bareCathedral();
    activateWeddingGuests(t2);
    at(t2, WEEKEND, 250);
    for (const code of [0, 1, 2]) {
      const g = cathedralGuests(t2)[code];
      cathedralFamilyHandler(stubCtx(code))(t2, g);
      assert(g.state === GUEST_STATE.outbound, 'result ' + code + ' sets 0x60: ' + g.state.toString(16));
    }
  },

  // ----------------------------------------------------- the count

  'arrivals before tick 800 on a weekend are counted, one by one, as a fresh recount'() {
    const tower = bareCathedral();
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 300);
    const guests = cathedralGuests(tower);
    for (let i = 0; i < 40; i++) {
      guests[i].state = GUEST_STATE.outbound;
      cathedralArrival(tower, guests[i], CATHEDRAL_BASE_FLOOR);
      assert(starGatesOf(tower).weddingGuestsArrived === i + 1, 'after ' + (i + 1) + ': ' + starGatesOf(tower).weddingGuestsArrived);
    }
    assert(guestsAtTheCathedral(tower) === 40, 'and the recount agrees');
  },

  'tick 799 counts, tick 800 does not: EVALUATION.md arrival processing runs only when day_tick < 800'() {
    for (const [tick, expected] of [[799, 1], [800, 0], [1100, 0]]) {
      const tower = bareCathedral();
      activateWeddingGuests(tower);
      at(tower, WEEKEND, tick);
      const guest = cathedralGuests(tower)[0];
      guest.state = GUEST_STATE.outbound;
      cathedralArrival(tower, guest, CATHEDRAL_BASE_FLOOR);
      assert(guest.state === GUEST_STATE.arrived, 'he is there either way');
      assert(starGatesOf(tower).weddingGuestsArrived === expected, 'tick ' + tick + ': ' + starGatesOf(tower).weddingGuestsArrived);
    }
  },

  'a weekday wedding does not count: guests who somehow arrive on a weekday are not a wedding'() {
    const tower = bareCathedral();
    activateWeddingGuests(tower);
    at(tower, WEEKDAY, 300);
    for (const guest of cathedralGuests(tower)) {
      guest.state = GUEST_STATE.outbound;
      cathedralArrival(tower, guest, CATHEDRAL_BASE_FLOOR);
    }
    assert(guestsAtTheCathedral(tower) === 40 && starGatesOf(tower).weddingGuestsArrived === 0, 'forty there, none counted: ' + starGatesOf(tower).weddingGuestsArrived);
    assert(!starGateStatus(tower).ready, 'and the ladder is not satisfied');
  },

  'a stop that is not floor 99 only moves the guest; the lobby is the end of the ride home'() {
    const tower = bareCathedral();
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 300);
    const guest = cathedralGuests(tower)[0];
    guest.state = GUEST_STATE.outbound;
    cathedralArrival(tower, guest, 89);                    // a sky-lobby change
    assert(guest.state === GUEST_STATE.outbound && guest.anchorFloor === 89 && starGatesOf(tower).weddingGuestsArrived === 0, 'still on his way');
    cathedralArrival(tower, guest, CATHEDRAL_BASE_FLOOR);
    assert(guest.state === GUEST_STATE.arrived && starGatesOf(tower).weddingGuestsArrived === 1, 'there');
    guest.state = GUEST_STATE.inbound;
    cathedralArrival(tower, guest, 29);
    assert(guest.state === GUEST_STATE.inbound, 'a change on the way down is not home');
    cathedralArrival(tower, guest, 0);
    assert(guest.state === GUEST_STATE.parked && guest.anchorFloor === 0, 'the lobby parks him (0x27)');
  },

  'the slice lights as its guests arrive, and noon clears it; the crowned look is kept'() {
    const tower = bareCathedral();
    activateWeddingGuests(tower);
    at(tower, WEEKEND, 300);
    const [first] = cathedralGuests(tower);
    first.state = GUEST_STATE.outbound;
    cathedralArrival(tower, first, CATHEDRAL_BASE_FLOOR);
    const lit = cathedralObjects(tower).filter((o) => o.aux === AUX.wedding);
    assert(lit.length === 1 && lit[0].id === first.objectId, 'the slice he belongs to is lit (aux 3)');
    assert(objectSprite(lit[0]).animation === 's1-wedding', objectSprite(lit[0]).animation);
    sendWeddingGuestsHome(tower);
    assert(cathedralObjects(tower).every((o) => o.aux === AUX.idle), 'noon clears the display byte');
    // After the rank the gilding is permanent: noon does not take it away (the reference clears it; A77).
    for (const o of cathedralObjects(tower)) o.aux = AUX.crowned;
    sendWeddingGuestsHome(tower);
    assert(cathedralObjects(tower).every((o) => o.aux === AUX.crowned), 'the crowned look survives noon');
  },

  // ----------------------------------------------------- the day

  'tick 0 wakes every guest, forgets any queue, and noon sends the arrived home (0x03 -> 0x05)'() {
    const tower = bareCathedral();
    const [a, b, c] = cathedralGuests(tower);
    a.state = GUEST_STATE.arrived; b.state = GUEST_STATE.inbound; c.state = GUEST_STATE.outbound;
    assert(activateWeddingGuests(tower) === 40, 'forty woken');
    assert(cathedralGuests(tower).every((g) => g.state === GUEST_STATE.waiting && g.route === null && g.anchorFloor === 0),
      'all back to 0x20 at the lobby, whatever they were doing');
    a.state = GUEST_STATE.arrived; b.state = GUEST_STATE.parked; c.state = GUEST_STATE.outbound;
    assert(sendWeddingGuestsHome(tower) === 1 && a.state === GUEST_STATE.leaving && b.state === GUEST_STATE.parked && c.state === GUEST_STATE.outbound,
      'only the guest standing in the cathedral is told to go home');
    const none = createTower({ seed: 1 });
    assert(activateWeddingGuests(none) === 0 && sendWeddingGuestsHome(none) === 0, 'no cathedral, nothing to wake or send');
  },

  // ----------------------------------------------------- end to end through the real lifts

  'END TO END: a weekend morning, the real lifts to floor 99: forty guests arrive before tick 800 and the ladder counts them'() {
    const r = weddingTrial({ spine: 'lifts' });
    assert(r.served, 'a lift reaches the cathedral');
    assert(r.arrived.length === 40 && r.count === 40, 'all forty, counted: ' + r.arrived.length + '/' + r.count);
    assert(r.setOut[0] > GATE_ROLL_FROM_TICK && r.setOut.at(-1) <= GATE_CERTAIN_FROM_TICK + 16, 'they set out between 81 and the first stride past 240: ' + r.setOut[0] + '..' + r.setOut.at(-1));
    assert(r.lastArrival < WEDDING_DEADLINE_TICK, 'the last one was there by tick ' + r.lastArrival);
    assert(r.parked === 0, 'nobody missed it');
  },

  'END TO END: no lift to floor 99, no wedding: every guest is parked and says so on the building'() {
    const r = weddingTrial({ spine: 'none' });
    assert(!r.served && r.arrived.length === 0 && r.count === 0 && r.parked === 40, JSON.stringify(r));
    const tower = weddingTower({ spine: 'none' }).tower;
    const slice = cathedralObjects(tower)[0];
    assert(!cathedralServed(tower) && /NO lift reaches the 100th floor/.test(serviceReadout(slice, tower)), serviceReadout(slice, tower));
  },

  'END TO END: a weekday sends nobody, though the lifts are there'() {
    const r = weddingTrial({ weekend: false });
    assert(r.setOut.length === 0 && r.arrived.length === 0 && r.count === 0, JSON.stringify(r));
  },

  'END TO END: they go home at noon and the lobby parks them; the next morning wakes them again'() {
    const env = weddingTower();
    const { tower, scheduler } = env;
    let sentHome = 0;
    const seen = { at1200: null, parked: null };
    while (!(tower.clock.dayCounter === WEEKEND && tower.clock.dayTick >= 1700 && tower.clock.dayTick < 2300)) {
      scheduler.tick(tower);
      if (tower.clock.dayCounter === WEEKEND && tower.clock.dayTick === 1199) seen.at1200 = guestsAtTheCathedral(tower);
      if (tower.clock.dayCounter === WEEKEND && tower.clock.dayTick === 1201) sentHome = env.guests.filter((g) => g.state === GUEST_STATE.leaving || g.state === GUEST_STATE.inbound).length;
    }
    assert(seen.at1200 === 40 && sentHome === 40, 'forty were standing there at noon and forty were sent: ' + seen.at1200 + '/' + sentHome);
    assert(env.guests.every((g) => g.state === GUEST_STATE.parked && g.anchorFloor === 0), 'by tick 1700 each is back in the lobby, parked: '
      + JSON.stringify(env.guests.map((g) => g.state.toString(16)).filter((s) => s !== '27')));
    assert(cathedralObjects(tower).every((o) => o.aux === AUX.idle), 'and the building has gone dark');
    // Every guest left every queue: no car holds a request for one.
    assert(tower.carriers.every((c) => env.guests.every((g) => !c.liveRequests.has(g.id))), 'no ghost in a lift queue');
    seen.parked = starGatesOf(tower).weddingGuestsArrived;
    while (!(tower.clock.dayCounter === WEEKEND + 1 && tower.clock.dayTick === 0)) scheduler.tick(tower);
    assert(starGatesOf(tower).weddingGuestsArrived === 0, 'a new day recounts from zero (it was ' + seen.parked + ')');
  },

  'END TO END: the Tower rank flips only with ALL of 15,000 people, the cathedral and a weekend wedding of forty'() {
    const run = ({ crowd = 15_000, place = true, drop = 0, dayCounter = 1, spine = 'lifts' } = {}) => {
      const env = weddingTower({ place, spine });
      const { tower, scheduler } = env;
      tower.populationLedger.crowd = crowd;
      tower.clock.dayCounter = dayCounter;
      tower.clock.calendarPhase = calendarPhaseFlag(dayCounter);
      // Take guests away from the table to make a smaller wedding.
      let removed = 0;
      for (const g of env.guests) {
        if (removed >= drop) break;
        tower.actors.splice(tower.actors.indexOf(g), 1);
        removed++;
      }
      let riseTick = null;
      let riseDay = null;
      let maxCount = 0;
      for (let n = 0; n < 2600 * 3 && riseTick === null; n++) {
        scheduler.tick(tower);
        maxCount = Math.max(maxCount, starGatesOf(tower).weddingGuestsArrived);
        if (tower.starCount === TOWER_RANK) { riseTick = tower.clock.dayTick; riseDay = tower.clock.dayCounter; }
      }
      return { tower, riseTick, riseDay, maxCount };
    };
    const ok = run();
    assert(ok.riseTick !== null && ok.riseTick < WEDDING_DEADLINE_TICK && calendarPhaseFlag(ok.riseDay), 'all of it: the rank, on a weekend morning at tick ' + ok.riseTick);
    assert(ok.tower.starCount === 6 && ok.tower.finale.day === ok.riseDay && ok.tower.finale.tick === ok.riseTick, 'and the finale was recorded: ' + JSON.stringify(ok.tower.finale));
    assert(noticesAfter(ok.tower, 0).at(-1).text === 'The tower has earned the Tower rank', 'and said');
    assert(cathedralObjects(ok.tower).every((o) => o.aux === AUX.crowned), 'the cathedral is gilded (aux 2)');

    const short = run({ crowd: 14_000 });
    assert(short.riseTick === null && short.tower.starCount === 5, '14,000 people: the wedding happens and the rank does not');
    assert(short.maxCount === 40, 'the wedding DID happen (forty counted), so it was the 15,000 that held it: ' + short.maxCount);
    const none = run({ place: false });
    assert(none.riseTick === null && cathedralGuests(none.tower).length === 0, 'no cathedral: no guests, no rank');
    const thirtyNine = run({ drop: 1 });
    assert(thirtyNine.riseTick === null && thirtyNine.tower.starCount === 5, 'thirty-nine guests are not a wedding');
    assert(thirtyNine.maxCount === 39, 'thirty-nine were counted: ' + thirtyNine.maxCount);
    const weekdays = run({ dayCounter: 3 });
    assert(weekdays.riseDay === null || calendarPhaseFlag(weekdays.riseDay), 'a weekday never gives it (it comes on the next weekend, if at all)');
    const noLifts = run({ spine: 'none' });
    assert(noLifts.riseTick === null, 'a cathedral nobody can reach is not a wedding');
  },

  'AFTER THE RANK the game does not break: it runs on at rank 6, days later, without error, and nothing moves it'() {
    const env = weddingTower();
    const { tower, scheduler } = env;
    tower.populationLedger.crowd = 15_000;
    while (tower.starCount !== TOWER_RANK) scheduler.tick(tower);
    const finale = { ...tower.finale };
    for (let n = 0; n < 2600 * 8; n++) scheduler.tick(tower);              // three more weddings' worth of weekends
    assert(tower.starCount === TOWER_RANK, 'still the Tower rank');
    same(tower.finale, finale, 'and the finale record is the one moment, not rewritten');
    assert(noticesAfter(tower, 0).filter((n) => n.kind === 'starRise').length === 1, 'one announcement, once');
    const status = starGateStatus(tower);
    assert(status.nextStar === null && !status.ready && !tryAdvanceStar(tower).advanced, 'there is nothing above it');
    assert(Number.isFinite(tower.cash) && tower.actors.every((a) => a && Number.isFinite(a.state)), 'no NaN crept in');
    assert(cathedralObjects(tower).length === 5 && cathedralObjects(tower).every((o) => o.aux === AUX.crowned), 'the cathedral is still there, still gilded');
  },

  // ----------------------------------------------------- the ladder's own words

  'the bar asks for the cathedral by its floor, and for the wedding once it stands'() {
    const tower = createTower({ seed: 1 });
    tower.starCount = 5;
    tower.populationLedger = { office: 15_000 };
    const blockers = () => starGateStatus(tower).blockers.join(' | ');
    assert(/a cathedral on the 100th floor \(floor 99\)/.test(blockers()) && /a wedding with 40 guests at the cathedral/.test(blockers()), blockers());
    const details = starGateStatus(tower).blockerDetails;
    assert(details.find((d) => /cathedral on/.test(d.text)).kind === 'cathedral' && details.every((d) => d.unavailable === undefined),
      'a buildable thing, and no excuse: the writer exists');
    placeCathedral(tower, { floor: 99, left: 0 }, () => createSimTripRecord());
    starGatesOf(tower).cathedralPlaced = true;
    assert(!/a cathedral on/.test(blockers()) && /a wedding/.test(blockers()), blockers());
  },

  'the readouts: the building says what it is waiting for, the bar counts the wedding as it happens, the banner quotes the original'() {
    const env = weddingTower();
    const { tower, scheduler } = env;
    const slice = cathedralObjects(tower)[0];
    assert(/a lift reaches the 100th floor/.test(serviceReadout(slice, tower)) && /cannot be bulldozed/.test(serviceReadout(slice, tower)), serviceReadout(slice, tower));
    assert(weddingReadout(tower) === '' && eventsReadout(tower) === '', 'nothing on a weekday morning');
    let said = null;
    while (!(tower.clock.dayCounter === WEEKEND && tower.clock.dayTick >= 330 && tower.clock.dayTick < 2300)) {
      scheduler.tick(tower);
      if (tower.clock.dayCounter === WEEKEND && tower.clock.dayTick === 300) said = weddingReadout(tower);
    }
    assert(/^WEDDING - \d+ of 40 guests at the cathedral$/.test(said), said);
    assert(eventsReadout(tower).includes('WEDDING - '), 'the bar carries it: ' + eventsReadout(tower));
    // The banner.
    tower.populationLedger.crowd = 15_000;
    while (tower.starCount !== TOWER_RANK) scheduler.tick(tower);
    const model = finaleModel(env.world);
    assert(model && model.title === 'Congratulations!' && model.body[0] === 'Your tower has been given a "Tower" Rating!', JSON.stringify(model));
    assert(model.key === finaleKeyOf(tower) && finaleModel(env.world, model.key) === null, 'dismissed means gone');
    assert(finaleModel({ tower: createTower({ seed: 1 }), ledger: env.world.ledger }) === null, 'no rank, no banner');
  },

  'the art: five slices by three looks are declared, and the sheet answers for each'() {
    const names = SPRITE_USES.cathedral;
    assert(names.length === 15, 'five slices x idle, wedding, crowned');
    const tower = bareCathedral();
    const seen = new Set();
    for (const aux of [AUX.idle, AUX.wedding, AUX.crowned]) {
      for (const o of cathedralObjects(tower)) {
        o.aux = aux;
        const art = objectSprite(o);
        assert(art.name === 'cathedral' && names.includes(art.animation), 'declared: ' + JSON.stringify(art));
        seen.add(art.animation);
      }
    }
    assert(seen.size === 15, 'every look is selectable: ' + [...seen]);
    assert(SPRITE_USES.fireworks.length === 3, 'three colours of burst');
  },

  // ----------------------------------------------------- the save

  'the save is v11 and carries the cathedral, its guests, the count and the finale; a resumed run matches an uninterrupted one'() {
    assert(SAVE_VERSION >= 11, 'the shape changed (issue #17): ' + SAVE_VERSION);
    const make = () => {
      const env = weddingTower();
      env.tower.populationLedger.crowd = 15_000;
      while (!(env.tower.clock.dayCounter === WEEKEND && env.tower.clock.dayTick === 200)) env.scheduler.tick(env.tower);
      return env;
    };
    const a = make();
    const blob = JSON.parse(JSON.stringify(snapshot(a.world)));
    assert(blob.version === SAVE_VERSION, 'stamped');
    const back = restore(blob);
    assert(back.ok !== false, 'loads: ' + back.reason);
    const resumed = back.world.tower;
    assert(cathedralObjects(resumed).length === 5 && cathedralGuests(resumed).length === 40, 'the building and the guests came back');
    // Run both on to the rank; they must agree on everything.
    const sa = a.scheduler;
    const sb = makeDriver(back.world).scheduler;
    for (let n = 0; n < 700; n++) { sa.tick(a.tower); sb.tick(resumed); }
    assert(a.tower.starCount === TOWER_RANK && resumed.starCount === TOWER_RANK, 'both crowned: ' + a.tower.starCount + '/' + resumed.starCount);
    same(resumed.finale, a.tower.finale, 'the same moment');
    same(resumed.actors.filter((x) => x.family === 0x24).map((g) => [g.state, g.anchorFloor]),
      a.tower.actors.filter((x) => x.family === 0x24).map((g) => [g.state, g.anchorFloor]), 'and the same forty guests');
    // And a save made AFTER the rank carries the finale.
    const crowned = restore(JSON.parse(JSON.stringify(snapshot(a.world)))).world.tower;
    assert(crowned.finale?.day === a.tower.finale.day && crowned.starCount === 6, 'the finale survives a save');
    // A v10 file is refused rather than resumed into a game with no cathedral rules.
    const old = JSON.parse(JSON.stringify(snapshot(a.world)));
    old.version = 10;
    assert(restore(old).ok === false, 'a v10 save is refused');
  },

  'determinism: the same seed gives the same wedding, tick for tick'() {
    const arrivals = () => {
      const env = weddingTower({ seed: 7 });
      const log = [];
      while (!(env.tower.clock.dayCounter === WEEKEND && env.tower.clock.dayTick >= 500)) {
        env.scheduler.tick(env.tower);
        if (env.tower.clock.dayCounter === WEEKEND) log.push(guestsAtTheCathedral(env.tower));
      }
      return log.join(',');
    };
    assert(arrivals() === arrivals(), 'two runs, one wedding');
  },
};
