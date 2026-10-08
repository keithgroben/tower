/**
 * Housekeeping, dirty rooms and cockroaches (issue #9).
 *
 * The assertions that matter run through the **composition** — `newTowerWorld`,
 * the driver's own scheduler, the real router and the real carriers — and never
 * through a handler or a ledger the test built:
 *
 *   - the staff WALK: a housekeeper cleans a room only after a service elevator
 *     (or a flight of stairs) has put it on the room's floor, never before;
 *   - without staff, or with too few, rooms go dirty, take three strikes at the
 *     1600 pass, and are infested for ever — and enough staff stop it;
 *   - the infestation spreads one room a day and is cured only by demolition.
 *
 * Everything above them is the machinery that makes those true: the search order,
 * the three bands, the three strikes, the spread, the state machine, the price,
 * the upkeep, the sign on the room. Where a rule has a plausible wrong answer the
 * test states it (`isRented`, the office's band; a population that counted the
 * staff) and asserts the right one.
 *
 * Spec: `specs/facility/HOUSEKEEPING.md`, `specs/facility/HOTEL.md` § Cockroach
 * Infestation, `specs/PEOPLE.md` § Family `0x0f`, `specs/ROUTING.md` § Candidate
 * Priority and § Housekeeping walkability, `specs/ECONOMY.md`.
 */
import {
  INFESTATION_STRIKES, cleanHotelRoom, handleExtendedVacancyExpiry, hotelMiddaySweep,
  infestHotelRoom, isHotelBooked, isHotelInfested, isHotelRoomDirty, isHotelVacant, spreadInfestation,
} from '../src/games/tower/sim/hotel.js';
import {
  HK_CLAIM_CUTOFF, HK_FLOOR_CLASSES, HK_REST, HK_STATE, HOUSEKEEPING_STAFF, HOUSEKEEPING_WIDTH,
  findDirtyRoom, floorClassOf, housekeepers, housekeepingArrival, housekeepingFamilyHandler,
  staffClassOf,
} from '../src/games/tower/sim/housekeeping.js';
import {
  EVAL_UNSET, FAMILY, HOTEL_UNIT_STATUS, OCCUPANTS, POPULATION_CONTRIBUTION, __resetIds, createTower,
  isStaff, isStaffFamily, placeObject, population,
} from '../src/games/tower/sim/state.js';
import { HOTEL_WIDTH } from '../src/games/tower/sim/hotel.js';
import { createSimTripRecord, advanceSimTripCounters, addDelayToCurrentSim } from '../src/games/tower/sim/stress.js';
import {
  CONSTRUCTION_COST, applyPeriodicOperatingExpenses, createLedger, placementCost,
} from '../src/games/tower/sim/economy.js';
import { STAR_REQUIREMENT, lockReason } from '../src/games/tower/sim/progression.js';
import { BUILDABLE, applyAction, demolishRefusal } from '../src/games/tower/sim/actions.js';
import { CARRIER_MODE } from '../src/games/tower/sim/elevators.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { chargeableItems } from '../src/games/tower/sim/ledger-adapter.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { objectOverlay, objectStatusTag } from '../src/games/tower/render/canvas.js';
import { TOOLS, preview, toolById } from '../src/games/tower/ui/build.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { housekeepingTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const hex = (n) => '0x' + n.toString(16);

// ------------------------------------------------------------- bare fixtures

function bareTower({ dayTick = 300, dayCounter = 0 } = {}) {
  __resetIds();
  const tower = createTower();
  tower.clock.dayTick = dayTick;
  tower.clock.daypart = Math.floor(dayTick / 400);
  tower.clock.dayCounter = dayCounter;
  return tower;
}

function placeRoom(tower, what, floor, left, status = HOTEL_UNIT_STATUS.dirtyEarly) {
  const placed = placeObject(tower,
    { family: FAMILY[what], floor, left, right: left + HOTEL_WIDTH[what] - 1 },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture: ' + placed.reason);
  placed.object.unitStatus = status;
  return placed.object;
}

function placeStation(tower, floor = 1, left = 60) {
  const placed = placeObject(tower,
    { family: FAMILY.housekeeping, type: 0x0f, floor, left, right: left + HOUSEKEEPING_WIDTH - 1 },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture: ' + placed.reason);
  const staff = tower.actors.filter((a) => a.objectId === placed.object.id);
  return { object: placed.object, staff };
}

const staffFor = (staff, floor) => staff.find((a) => staffClassOf(a) === floorClassOf(floor));

/** A router that answers what it is told and remembers what it was asked. */
function stubCtx(codes) {
  const calls = [];
  const queue = Array.isArray(codes) ? [...codes] : [codes];
  return {
    calls,
    resolveRoute(_tower, actor, from, to, _clock, options) {
      const code = queue.length > 1 ? queue.shift() : queue[0];
      calls.push({ from, to, code, options });
      return { code, legDestination: code === 1 ? to : from };
    },
    onDelay: () => { calls.delayed = (calls.delayed ?? 0) + 1; },
  };
}

const visit = (tower, actor, ctx, times = 1) => {
  const handler = housekeepingFamilyHandler(ctx);
  for (let i = 0; i < times; i++) handler(tower, actor);
};

// ------------------------------------------------------------ world fixtures

/**
 * A star-3 tower: a guest lift and a service elevator to `top`, hotel rooms,
 * and `facilities` housekeeping facilities on F1. `service: false` leaves the
 * staff nothing to ride.
 */
function hotelWorld({ rooms = [], top = 9, facilities = 1, service = true, stairs = [] } = {}) {
  const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 3;
  const build = (command, what) => {
    const r = applyAction(world, command);
    assert(r.ok, `${what} would not build: ${r.reason}`);
    return r;
  };
  build({ type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 40 }, 'the guest lift');
  const lift = service ? build({ type: 'build_shaft', kind: 'service', bottom: 0, top, column: 52 }, 'the service lift').carrier : null;
  const built = rooms.map(([what, floor, left]) => build({ type: 'build', what, floor, left }, `${what} F${floor}@${left}`).object);
  const stations = [];
  for (let i = 0; i < facilities; i++) {
    stations.push(build({ type: 'build', what: 'housekeeping', floor: 1, left: 60 + i * 16 }, 'housekeeping').object);
  }
  for (const [floor, left] of stairs) build({ type: 'build_link', kind: 'stairs', floor, left }, `stairs F${floor}`);
  rebuildRouteTables(tower);
  tower.routeTablesDirty = false;
  return { world, tower, built, stations, lift, driver: makeDriver(world) };
}

function run(world, driver, ticks, watch = null) {
  for (let i = 0; i < ticks; i++) {
    driver.scheduler.tick(world.tower);
    watch?.(world.tower.clock.dayTick, world.tower.clock.dayCounter);
  }
}

/** The rooms of a hotel floor, `n` singles from tile 60. */
const floorOfRooms = (floor, n) => Array.from({ length: n }, (_, i) => ['hotelSingle', floor, 60 + i * 4]);

export const tests = {
  // ------------------------------------------------------------ the identity

  'housekeeping is family 0x0f: six staff, placed with the facility, in the palette'() {
    assert(FAMILY.housekeeping === 0x0f, 'the code is ' + hex(FAMILY.housekeeping));
    assert(OCCUPANTS[FAMILY.housekeeping] === HOUSEKEEPING_STAFF && HOUSEKEEPING_STAFF === 6, 'six staff');
    const tower = bareTower();
    const { staff } = placeStation(tower);
    assert(staff.length === 6, 'placement created ' + staff.length + ' staff');
    assert(staff.map((a) => a.occupantIndex).join() === '0,1,2,3,4,5', 'one per slot');
    assert(staff.every((a) => a.family === FAMILY.housekeeping), 'the staff carry the facility\'s code');
    assert(staff.every(isStaff) && isStaffFamily(FAMILY.housekeeping) && !isStaffFamily(FAMILY.office), 'isStaff');
    assert(BUILDABLE.housekeeping.family === FAMILY.housekeeping, 'it is buildable');
    assert(BUILDABLE.housekeeping.width === HOUSEKEEPING_WIDTH && HOUSEKEEPING_WIDTH === 15, 'width 15 (A33)');
    assert(TOOLS.some((t) => t.action === 'build' && t.what === 'housekeeping'), 'and it is in the palette');
    assert(toolById('housekeeping').label === 'Housekeeping', 'with its own name');
  },

  '⚠️ staff are not population — six actors, no people — and have no stress'() {
    // The plausible wrong answer: `population()` falls back to OCCUPANTS for a
    // family with no POPULATION_CONTRIBUTION entry, which would count six people
    // per facility and lift the star ladder with a mop.
    const tower = bareTower();
    const before = population(tower);
    const { object, staff } = placeStation(tower);
    assert(POPULATION_CONTRIBUTION[FAMILY.housekeeping] === 0, 'an explicit zero, not an absent key');
    assert(population(tower) === before, 'placing a facility added ' + (population(tower) - before) + ' people');
    assert(object.occupants.length === 6, 'six actors are on the books');
    for (const actor of staff) {
      advanceSimTripCounters(actor);
      addDelayToCurrentSim(actor, 300);
      assert(actor.tripCount === 0 && actor.accumulatedElapsed === 0 && (actor.elapsedPacked & 0x3ff) === 0,
        'a housekeeper\'s stress record moved: ' + JSON.stringify(actor));
    }
    // A guest's does, which is what the guard is guarding.
    const room = placeRoom(tower, 'hotelSingle', 3, 10, HOTEL_UNIT_STATUS.vacantEarly);
    const guest = tower.actors.find((a) => a.objectId === room.id);
    advanceSimTripCounters(guest);
    assert(guest.tripCount === 1, 'the guard must not stop a guest counting trips');
  },

  'the price, the stars and the upkeep are the game’s own: $50,000, two stars, $10,000 a quarter'() {
    assert(CONSTRUCTION_COST.housekeeping === 50_000, 'construction cost');
    assert(STAR_REQUIREMENT.housekeeping === 2, 'two stars');
    const tower = bareTower();
    tower.starCount = 1;
    assert(/star/i.test(lockReason(tower, 'housekeeping', 'Housekeeping') ?? ''), 'locked at one star');
    tower.starCount = 2;
    assert(lockReason(tower, 'housekeeping', 'Housekeeping') === null, 'open at two');
    assert(placementCost('housekeeping', { tiles: HOUSEKEEPING_WIDTH }) === 50_000 + HOUSEKEEPING_WIDTH * CONSTRUCTION_COST.floorTile,
      'the facility plus its tiles, as every room is priced');

    // The upkeep: $10,000 per facility, per 3-day cashflow pass, through the
    // tower's own chargeable list (no second list of "things with upkeep").
    for (const n of [1, 2, 3]) {
      const t = bareTower();
      for (let i = 0; i < n; i++) placeStation(t, 1 + i, 20);
      const ledger = createLedger({ cash: 10_000_000 });
      const spent = applyPeriodicOperatingExpenses(ledger, { items: chargeableItems(t) });
      assert(spent === 10_000 * n, `${n} facilities cost ${spent} a quarter, wanted ${10_000 * n}`);
      assert(ledger.expense.housekeeping === 10_000 * n, 'booked under its own bucket');
    }
  },

  '⚠️ the ghost and the seam agree about building housekeeping: locked, below grade, on the ground, on a room, too dear, and fine'() {
    const mk = ({ stars = 2, cash = 5_000_000 } = {}) => {
      const w = newTowerWorld({ seed: 1, cash: 90_000_000 });
      w.tower.starCount = 3;
      assert(applyAction(w, { type: 'build', what: 'hotelSingle', floor: 3, left: 60 }).ok, 'fixture: a room');
      w.tower.starCount = stars;
      w.ledger.cash = cash;
      return w;
    };
    const cases = [
      ['one star: locked', { stars: 1 }, 3, 20],
      ['below the ground', {}, -1, 20],
      ['on the ground floor', {}, 0, 20],
      ['on top of a room', {}, 3, 60],
      ['half over a room', {}, 3, 52],
      ['too dear', { cash: 20_000 }, 3, 20],
      ['a free floor', {}, 4, 20],
    ];
    const verdicts = [];
    for (const [label, opts, floor, left] of cases) {
      const target = { floor, tile: left, object: null, carrier: null };
      const ghost = preview(mk(opts), toolById('housekeeping'), target);
      const w = mk(opts);
      const real = applyAction(w, { type: 'build', what: 'housekeeping', floor, left });
      assert(ghost.ok === real.ok, `${label}: ghost said ${ghost.ok}, seam said ${real.ok} (${real.reason})`);
      if (!real.ok) assert(ghost.reason === real.reason, `${label}: two voices
       ghost: ${ghost.reason}
       seam:  ${real.reason}`);
      verdicts.push(real.ok);
    }
    assert(verdicts.join() === 'false,false,false,false,false,false,true', 'only the free floor builds: ' + verdicts);
  },

  // ----------------------------------------------------- cannot be bulldozed

  '⚠️ housekeeping cannot be bulldozed — the seam and the ghost say the same words'() {
    const { world, built, stations } = hotelWorld({ rooms: [['hotelSingle', 3, 10]] });
    const [station] = stations;
    assert(station.family === FAMILY.housekeeping, 'fixture');

    const seam = applyAction(world, { type: 'demolish', objectId: station.id });
    assert(!seam.ok && seam.reason === 'housekeeping cannot be bulldozed', 'the seam said: ' + JSON.stringify(seam));
    assert(world.tower.objects.has(station.id), 'and it is still standing');
    assert(world.tower.actors.filter((a) => a.objectId === station.id).length === 6, 'with its six staff');

    const ghost = preview(world, toolById('demolish'), { floor: station.floor, tile: station.left, object: station });
    assert(!ghost.ok && ghost.reason === seam.reason, `ghost and seam disagree: ${ghost.reason} / ${seam.reason}`);
    assert(demolishRefusal(station) === seam.reason, 'one definition');
    assert(demolishRefusal(built[0]) === null, 'an ordinary empty room is not refused');
  },

  '⚠️ an infested room CAN be demolished — the only cure — and so can a dirty one; a guest\'s room cannot'() {
    const { world, tower, built } = hotelWorld({ rooms: [['hotelSingle', 3, 10], ['hotelSingle', 3, 14], ['hotelSingle', 3, 18]] });
    const [nest, dirty, booked] = built;
    infestHotelRoom(tower, nest);
    dirty.unitStatus = HOTEL_UNIT_STATUS.dirtyEarly;
    booked.unitStatus = HOTEL_UNIT_STATUS.occupiedEarly;

    for (const [room, ok, label] of [[nest, true, 'infested'], [dirty, true, 'dirty'], [booked, false, 'booked']]) {
      const ghost = preview(world, toolById('demolish'), { floor: room.floor, tile: room.left, object: room });
      assert(ghost.ok === ok, `the ghost over a ${label} room said ${ghost.ok}: ${ghost.reason}`);
    }
    const nestActors = tower.actors.filter((a) => a.objectId === nest.id).length;
    const r = applyAction(world, { type: 'demolish', objectId: nest.id });
    assert(r.ok, 'the infested room would not come down: ' + r.reason);
    assert(!tower.objects.has(nest.id) && nestActors === 1 && tower.actors.every((a) => a.objectId !== nest.id),
      'the room and its guest are gone');
    assert(!applyAction(world, { type: 'demolish', objectId: booked.id }).ok, 'a booked room is still refused');
  },

  // ------------------------------------------------------------ who cleans what

  'a facility\'s six staff each take one residue of the EXE floor number, mod six'() {
    // The reference's `floor % 6` is over its own indices, ground = 10; ours are
    // logical, ground = 0. `logical = exe - 10`. DEVIATIONS A34.
    assert(HK_FLOOR_CLASSES === 6, 'mod six');
    assert(floorClassOf(0) === 4 && floorClassOf(2) === 0 && floorClassOf(8) === 0 && floorClassOf(9) === 1, 'F0 is EXE 10: 10 % 6 = 4');
    assert(floorClassOf(-1) === 3 && floorClassOf(-10) === 0, 'basements stay in 0..5 (EXE 9 and 0)');
    for (let f = -10; f <= 109; f++) {
      const c = floorClassOf(f);
      assert(Number.isInteger(c) && c >= 0 && c <= 5, `floor ${f} has class ${c}`);
    }
    const tower = bareTower();
    const { staff } = placeStation(tower);
    assert(new Set(staff.map(staffClassOf)).size === 6, 'six staff, six distinct classes');
    for (let f = 1; f <= 6; f++) {
      assert(staff.filter((a) => staffClassOf(a) === floorClassOf(f)).length === 1, `floor ${f} has exactly one of the six`);
    }
  },

  'the search: dirty rooms only, in this staff member\'s class, upward from the start floor first, then down'() {
    const tower = bareTower();
    const up = placeRoom(tower, 'hotelSingle', 8, 40);          // class 0, ahead of a floor-5 start
    const upRight = placeRoom(tower, 'hotelSingle', 8, 50);
    const down = placeRoom(tower, 'hotelSingle', 2, 40);        // class 0, behind it
    const wrongClass = placeRoom(tower, 'hotelSingle', 3, 40); // class 1
    const clean = placeRoom(tower, 'hotelSingle', 14, 40, HOTEL_UNIT_STATUS.vacantEarly);
    const infested = placeRoom(tower, 'hotelSingle', 20, 40, HOTEL_UNIT_STATUS.infestedEarly);
    const booked = placeRoom(tower, 'hotelSingle', 26, 40, HOTEL_UNIT_STATUS.occupiedEarly);
    const klass = floorClassOf(8);

    assert(floorClassOf(2) === klass && floorClassOf(14) === klass && floorClassOf(20) === klass && floorClassOf(26) === klass, 'fixture: all class 0');
    assert(findDirtyRoom(tower, 5, klass) === up, 'upward first: F8, and its leftmost room');
    up.unitStatus = HOTEL_UNIT_STATUS.vacantEarly; upRight.unitStatus = HOTEL_UNIT_STATUS.vacantEarly;
    assert(findDirtyRoom(tower, 5, klass) === down, 'then downward from the floor below the start: F2');
    assert(findDirtyRoom(tower, 2, klass) === down, 'a start on the floor itself still finds it (upward scan includes it)');
    down.unitStatus = HOTEL_UNIT_STATUS.vacantEarly;
    assert(findDirtyRoom(tower, 5, klass) === null, 'nothing dirty left in the class: null, not -1 (B1 is a floor)');
    assert(findDirtyRoom(tower, 5, floorClassOf(3)) === wrongClass, 'the other class finds its own');
    assert(![clean, infested, booked].includes(findDirtyRoom(tower, 0, klass)), 'a clean, infested or booked room never qualifies');

    // Ascending slot order within a floor, whichever the placement order was.
    const t2 = bareTower();
    const right = placeRoom(t2, 'hotelSingle', 8, 70);
    const left = placeRoom(t2, 'hotelSingle', 8, 20);
    assert(findDirtyRoom(t2, 1, klass) === left && right.left > left.left, 'the leftmost room on the floor wins');
  },

  // ------------------------------------------------------------------ cleaning

  'cleaning writes the vacant band for the half of the day, sets the latch and clears the strikes'() {
    for (const [dayTick, want] of [[300, HOTEL_UNIT_STATUS.vacantEarly], [1450, HOTEL_UNIT_STATUS.vacantEarly], [1700, HOTEL_UNIT_STATUS.vacantLate]]) {
      const tower = bareTower({ dayTick });
      const room = placeRoom(tower, 'hotelSingle', 3, 10, HOTEL_UNIT_STATUS.dirtyEarly);
      room.activationTickCount = 2;
      room.occupiedFlag = false;
      assert(cleanHotelRoom(tower, room) === true, 'the room was cleaned');
      assert(room.unitStatus === want, `at tick ${dayTick} the band is ${hex(room.unitStatus)}, wanted ${hex(want)}`);
      assert(isHotelVacant(room) && !isHotelRoomDirty(room), 'vacant, not dirty');
      assert(room.occupiedFlag === true, 'HOTEL.md: the claim sets the latch');
      assert(room.activationTickCount === 0, 'and the two strikes are forgotten');
    }
  },

  'only a DIRTY room is cleaned: a clean one, a booked one and an infested one are left alone'() {
    const tower = bareTower();
    const statuses = [HOTEL_UNIT_STATUS.vacantEarly, 0x05, HOTEL_UNIT_STATUS.infestedEarly, HOTEL_UNIT_STATUS.infestedLate];
    for (const [i, status] of statuses.entries()) {
      const room = placeRoom(tower, 'hotelSingle', 3, 10 + 5 * i, status);
      room.occupiedFlag = false; room.activationTickCount = 2;
      assert(cleanHotelRoom(tower, room) === false, `${hex(status)} was cleaned`);
      assert(room.unitStatus === status && room.occupiedFlag === false && room.activationTickCount === 2, `${hex(status)} was touched`);
    }
  },

  // ------------------------------------------------------- the three strikes

  '⚠️ THREE dirty 1600 passes make a room infested — the third, not the second'() {
    const tower = bareTower({ dayTick: 1600, dayCounter: 1 });
    const room = placeRoom(tower, 'hotelSingle', 3, 10);
    room.occupiedFlag = false; room.activationTickCount = 0;
    assert(INFESTATION_STRIKES === 3, 'three');

    const first = hotelMiddaySweep(tower);
    assert(room.activationTickCount === 1 && isHotelRoomDirty(room) && first.struck === 1 && first.infested === 0, 'strike one: ' + JSON.stringify(first));
    hotelMiddaySweep(tower);
    assert(room.activationTickCount === 2 && isHotelRoomDirty(room), 'strike two: still dirty, still recoverable');
    const third = hotelMiddaySweep(tower);
    assert(isHotelInfested(room) && !isHotelRoomDirty(room) && third.infested === 1, 'strike three: ' + hex(room.unitStatus));
    assert(room.unitStatus === HOTEL_UNIT_STATUS.infestedLate, 'written at 1600, daypart 4: the late value ' + hex(room.unitStatus));
    assert(room.evalLevel === EVAL_UNSET && room.occupiedFlag === false, 'grade wiped, latch off');
    for (let i = 0; i < 5; i++) hotelMiddaySweep(tower);
    assert(isHotelInfested(room), 'and nothing ever brings it back');
  },

  'a room cleaned in time loses its strikes: two dirty passes, a cleaning, and the count starts again'() {
    const tower = bareTower({ dayTick: 1600 });
    const room = placeRoom(tower, 'hotelSingle', 3, 10);
    room.occupiedFlag = false;
    hotelMiddaySweep(tower); hotelMiddaySweep(tower);
    assert(room.activationTickCount === 2, 'fixture: two strikes');
    cleanHotelRoom(tower, room);
    hotelMiddaySweep(tower);
    assert(room.activationTickCount === 0 && isHotelVacant(room), 'cleaned: a vacant room takes no strike');
    room.unitStatus = HOTEL_UNIT_STATUS.dirtyLate;               // the next guest checks out
    room.occupiedFlag = false;
    hotelMiddaySweep(tower); hotelMiddaySweep(tower);
    assert(!isHotelInfested(room) && room.activationTickCount === 2, 'two more strikes is still not three');
  },

  'the expiry looks only at rooms past the vacant band; a latched room is safe (the reference\'s other branch)'() {
    const tower = bareTower({ dayTick: 1600 });
    const vacant = placeRoom(tower, 'hotelSingle', 3, 10, HOTEL_UNIT_STATUS.vacantLate);
    const booked = placeRoom(tower, 'hotelSingle', 3, 16, 0x05);
    const latched = placeRoom(tower, 'hotelSingle', 3, 22, HOTEL_UNIT_STATUS.dirtyLate);
    const nest = placeRoom(tower, 'hotelSingle', 3, 28, HOTEL_UNIT_STATUS.infestedLate);
    for (const o of [vacant, booked, nest]) o.activationTickCount = 0;
    assert(handleExtendedVacancyExpiry(tower, vacant) === null && vacant.activationTickCount === 0, 'vacant: not examined');
    assert(handleExtendedVacancyExpiry(tower, booked) === null && booked.activationTickCount === 0, 'booked: not examined');
    assert(handleExtendedVacancyExpiry(tower, nest) === null, 'infested: nothing left to lose');
    latched.occupiedFlag = true; latched.activationTickCount = 2; latched.evalLevel = 2;
    assert(handleExtendedVacancyExpiry(tower, latched) === 'safe', 'a claimed room is safe');
    assert(latched.activationTickCount === 0 && latched.occupiedFlag === false && latched.evalLevel === 0 && isHotelRoomDirty(latched),
      'HOTEL.md: eval_level, the counter and the latch are cleared');
  },

  // ----------------------------------------------------------------- the spread

  '⚠️ the infestation spreads ONE hop a day, to the room on either side — and not along the whole row in one pass'() {
    const tower = bareTower({ dayTick: 1600 });
    const row = [0, 1, 2, 3, 4, 5, 6].map((i) => placeRoom(tower, 'hotelSingle', 3, 10 + 4 * i, HOTEL_UNIT_STATUS.vacantLate));
    infestHotelRoom(tower, row[3]);
    assert(spreadInfestation(tower) === 2, 'two rooms were infected');
    assert(row.map(isHotelInfested).join() === 'false,false,true,true,true,false,false', 'one room each way: ' + row.map((r) => hex(r.unitStatus)));
    spreadInfestation(tower);
    assert(row.map(isHotelInfested).join() === 'false,true,true,true,true,true,false', 'the next day, one more each way');
    spreadInfestation(tower); spreadInfestation(tower);
    assert(row.every(isHotelInfested), 'a floor is lost in a few days');
    const r = row[0];
    assert(r.evalLevel === EVAL_UNSET && r.occupiedFlag === false && r.dirty === true, 'the infection writes grade 0xff, latch 0, dirty 1');
  },

  'the spread does not cross a room that is not a hotel room, a floor, or a guest in the bed'() {
    const tower = bareTower({ dayTick: 1600 });
    const left = placeRoom(tower, 'hotelSingle', 3, 10, HOTEL_UNIT_STATUS.vacantLate);
    const nest = placeRoom(tower, 'hotelSingle', 3, 14, HOTEL_UNIT_STATUS.vacantLate);
    const guest = placeRoom(tower, 'hotelSingle', 3, 18, 0x05);                 // booked
    const office = placeObject(tower, { family: FAMILY.office, floor: 3, left: 22, right: 27 }, () => createSimTripRecord()).object;
    const beyond = placeRoom(tower, 'hotelSingle', 3, 28, HOTEL_UNIT_STATUS.vacantLate);
    const above = placeRoom(tower, 'hotelSingle', 4, 14, HOTEL_UNIT_STATUS.vacantLate);
    infestHotelRoom(tower, nest);
    spreadInfestation(tower);
    assert(isHotelInfested(left), 'the room on the other side is infected');
    assert(!isHotelInfested(guest) && guest.unitStatus === 0x05, 'a guest in the bed is left alone (A35)');
    assert(!isHotelInfested(above), 'not up a floor');
    // And the office is the one architectural defence: nothing crosses it.
    const t2 = bareTower({ dayTick: 1600 });
    const a = placeRoom(t2, 'hotelSingle', 3, 10, HOTEL_UNIT_STATUS.vacantLate);
    const bridge = placeObject(t2, { family: FAMILY.office, floor: 3, left: 14, right: 19 }, () => createSimTripRecord()).object;
    const b = placeRoom(t2, 'hotelSingle', 3, 20, HOTEL_UNIT_STATUS.vacantLate);
    infestHotelRoom(t2, a);
    spreadInfestation(t2);
    assert(!isHotelInfested(b) && bridge.family === FAMILY.office && office.family === FAMILY.office, 'an office between two rooms stops it');
    assert(!isHotelInfested(beyond), 'and so does the office beyond the nest');
  },

  'the spread runs BEFORE the expiry: a room infested today infects nobody until tomorrow'() {
    const tower = bareTower({ dayTick: 1600 });
    const a = placeRoom(tower, 'hotelSingle', 3, 10);
    const b = placeRoom(tower, 'hotelSingle', 3, 14, HOTEL_UNIT_STATUS.vacantLate);
    a.occupiedFlag = false; a.activationTickCount = 2;                         // its third strike is today's
    const today = hotelMiddaySweep(tower);
    assert(today.infested === 1 && isHotelInfested(a), 'a was infested by today\'s expiry');
    assert(today.spread === 0 && !isHotelInfested(b), 'and b is not, yet');
    const tomorrow = hotelMiddaySweep(tower);
    assert(tomorrow.spread === 1 && isHotelInfested(b), 'b is infected at tomorrow\'s pass');
  },

  // -------------------------------------------------------- the staff, one visit at a time

  'the state machine: a housekeeper on the room\'s floor cleans it on the same visit, rests four visits, then searches again'() {
    const tower = bareTower({ dayTick: 300 });
    const { staff } = placeStation(tower, 3, 60);
    const room = placeRoom(tower, 'hotelSingle', 3, 10);       // same floor as the station
    const other = placeRoom(tower, 'hotelSingle', 3, 14);
    const actor = staffFor(staff, 3);
    const ctx = stubCtx(3);
    // A fresh member of staff arrives in 0x20; the reference's default arm resets it.
    assert(actor.state === 0x20, 'fixture: placement state');
    visit(tower, actor, ctx);
    assert(actor.state === HK_STATE.search && actor.spawnFloor === null, 'the first visit only resets: ' + actor.state);

    visit(tower, actor, ctx);                                  // state 0: search, claim, same stride
    assert(actor.spawnFloor === 3, 'first search records the home floor');
    assert(actor.state === HK_STATE.rest && actor.postClaimCountdown === HK_REST, 'resting with a countdown of ' + HK_REST);
    assert(room.unitStatus === HOTEL_UNIT_STATUS.vacantEarly && isHotelVacant(room), 'the room is clean');
    assert(isHotelRoomDirty(other), 'and only that room');
    assert(ctx.calls.length === 0, 'it was already on the floor: the router was never asked');

    visit(tower, actor, ctx, 3);                               // 3 -> 2 -> 1 -> 0
    assert(actor.state === HK_STATE.rest && actor.postClaimCountdown === 0, 'three visits count it down: ' + actor.postClaimCountdown);
    visit(tower, actor, ctx);
    assert(actor.state === HK_STATE.search, 'the fourth visit ends the rest');
    visit(tower, actor, ctx);
    assert(!isHotelRoomDirty(other) && actor.state === HK_STATE.rest, 'and the next room is cleaned');
  },

  'a housekeeper asks the router for housekeeping mode — stairs and service lifts, no stress — and walks one leg per visit'() {
    const tower = bareTower({ dayTick: 300 });
    const { staff } = placeStation(tower, 1, 60);
    placeRoom(tower, 'hotelSingle', 3, 10);
    const actor = staffFor(staff, 3);
    actor.state = HK_STATE.search; actor.spawnFloor = 1;
    const ctx = stubCtx([1, 1, 3]);
    visit(tower, actor, ctx);
    assert(actor.state === HK_STATE.target && actor.targetFloor === 3 && actor.anchorFloor === 3,
      'a walked leg puts it on the far landing (the stub lands it on the destination): ' + actor.anchorFloor);
    const { options, from, to } = ctx.calls[0];
    assert(from === 1 && to === 3, `asked for ${from} -> ${to}`);
    assert(options.passengerRoute === false && options.emitDistanceFeedback === false,
      'housekeeping mode: passengerRoute and emitDistanceFeedback both false (ROUTING.md)');
  },

  'no route to the room, or a room gone, or the working day over: it gives up and searches again'() {
    // No route.
    let tower = bareTower({ dayTick: 300 });
    let { staff } = placeStation(tower, 1, 60);
    let room = placeRoom(tower, 'hotelSingle', 7, 10);
    let actor = staffFor(staff, 7);
    actor.state = HK_STATE.search; actor.spawnFloor = 1;
    visit(tower, actor, stubCtx(-1));
    assert(actor.state === HK_STATE.search && actor.targetRoomId === null && actor.targetFloor === null && isHotelRoomDirty(room),
      'no route (-1): back to searching, the room untouched, the sentinel is null');

    // Demolished on the way.
    tower = bareTower({ dayTick: 300 });
    ({ staff } = placeStation(tower, 1, 60));
    room = placeRoom(tower, 'hotelSingle', 7, 10);
    actor = staffFor(staff, 7);
    actor.state = HK_STATE.search; actor.spawnFloor = 1;
    visit(tower, actor, stubCtx(2));                          // queued on a lift
    assert(actor.state === HK_STATE.target && actor.targetRoomId === room.id, 'fixture: on its way');
    tower.objects.delete(room.id);
    visit(tower, actor, stubCtx(2));
    assert(actor.state === HK_STATE.search, 'the room was demolished: nothing to walk to');

    // The window closes: arrival at 1500 is turned away; the search itself is idle after 1500.
    tower = bareTower({ dayTick: 1499 });
    ({ staff } = placeStation(tower, 7, 60));
    room = placeRoom(tower, 'hotelSingle', 7, 10);
    actor = staffFor(staff, 7);
    actor.state = HK_STATE.target; actor.spawnFloor = 7; actor.anchorFloor = 7; actor.targetRoomId = room.id; actor.targetFloor = 7;
    tower.clock.dayTick = HK_CLAIM_CUTOFF;
    visit(tower, actor, stubCtx(3));
    assert(isHotelRoomDirty(room) && actor.state === HK_STATE.search, 'arriving at tick 1500 is too late');
    visit(tower, actor, stubCtx(3), 3);
    assert(isHotelRoomDirty(room) && actor.state === HK_STATE.search, 'and a search after 1500 does nothing: the staff are off duty');
    tower.clock.dayTick = 1499;
    visit(tower, actor, stubCtx(3));
    assert(!isHotelRoomDirty(room), 'at 1499 the same visit cleans it');
  },

  'two staff after one room: the second is turned away at the door, still takes its rest, and finds the next one'() {
    // Nothing in the reference stops the second choosing the first's room, which
    // is why a second facility is worth less than twice the first (A34).
    const tower = bareTower({ dayTick: 300 });
    const a = placeStation(tower, 3, 40);
    const b = placeStation(tower, 3, 60);
    const first = placeRoom(tower, 'hotelSingle', 3, 10);
    const second = placeRoom(tower, 'hotelSingle', 3, 14);
    const [one, two] = [staffFor(a.staff, 3), staffFor(b.staff, 3)];
    for (const x of [one, two]) { x.state = HK_STATE.search; x.spawnFloor = 3; }
    const ctx = stubCtx(3);
    visit(tower, one, ctx);
    assert(!isHotelRoomDirty(first), 'the first member of staff cleaned the first room');
    two.state = HK_STATE.target; two.targetRoomId = first.id; two.targetFloor = 3;   // chosen before it was cleaned
    visit(tower, two, ctx);
    assert(two.state === HK_STATE.rest && two.postClaimCountdown === HK_REST, 'turned away, but the rest is still taken');
    assert(isHotelRoomDirty(second), 'and nothing else was cleaned by it');
    visit(tower, two, ctx, 4);
    visit(tower, two, ctx);
    assert(!isHotelRoomDirty(second) || !isHotelRoomDirty(first), 'it searches again afterwards');
  },

  // ----------------------------------------------------------------- real routing

  '⚠️ the staff WALK: a housekeeper reaches a room only by service elevator, queues for it, and is on the floor before the room is clean'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: [['hotelSingle', 8, 70]], top: 9 });
    const room = built[0];
    const staff = housekeepers(tower);
    const actor = staffFor(staff, 8);
    const service = tower.carriers.find((c) => c.mode === CARRIER_MODE.SERVICE);
    const guestLift = tower.carriers.find((c) => c.mode === CARRIER_MODE.STANDARD);
    room.unitStatus = HOTEL_UNIT_STATUS.dirtyEarly;
    room.occupiedFlag = false;
    tower.clock.dayTick = 100;

    const floors = [];
    let queuedTicks = 0, aboardTicks = 0, ridOnGuestLift = 0, cleanedAt = null, lastFloor = null;
    for (let i = 0; i < 1200 && cleanedAt === null; i++) {
      driver.scheduler.tick(tower);
      if (actor.waitingFloor != null) queuedTicks++;
      if (service.cars.some((c) => c.slots.some((s) => s.ref === actor.id))) aboardTicks++;
      for (const carrier of [guestLift]) {
        if (carrier.cars.some((c) => c.slots.some((s) => s.ref === actor.id))) ridOnGuestLift++;
      }
      if (actor.anchorFloor !== lastFloor) { floors.push(actor.anchorFloor); lastFloor = actor.anchorFloor; }
      if (!isHotelRoomDirty(room)) cleanedAt = { tick: tower.clock.dayTick, floor: actor.anchorFloor };
    }
    assert(cleanedAt !== null, 'the room was never cleaned; the staff are at F' + actor.anchorFloor + ' in state ' + actor.state);
    assert(cleanedAt.floor === 8, 'it was cleaned while the housekeeper stood on F' + cleanedAt.floor + ', not F8');
    assert(cleanedAt.tick - 100 > 30, 'it took ' + (cleanedAt.tick - 100) + ' ticks to arrive: that is a ride, not a teleport');
    assert(queuedTicks > 0 && aboardTicks > 0, `it queued for ${queuedTicks} ticks and rode ${aboardTicks} in the service car`);
    assert(ridOnGuestLift === 0, 'a housekeeper never rides a passenger lift');
    assert(floors[0] === 1 && floors.at(-1) === 8, 'from F1 to F8: ' + floors.join(' → '));
    // The routing never touched a stress counter.
    assert(actor.tripCount === 0 && actor.accumulatedElapsed === 0, 'no stress: ' + actor.tripCount + '/' + actor.accumulatedElapsed);
    assert(world.ledger.cash === tower.cash, 'one balance');
  },

  '⚠️ with no service elevator and no stairs the staff cannot reach a hotel — the rooms are lost, guests or not'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: floorOfRooms(8, 4), top: 9, service: false });
    let cleaned = 0;
    const was = new Map(built.map((o) => [o.id, false]));
    run(world, driver, 6 * 2600, () => {
      for (const o of built) {
        const d = isHotelRoomDirty(o);
        if (was.get(o.id) && !d && !isHotelInfested(o)) cleaned++;
        was.set(o.id, d);
      }
    });
    assert(cleaned === 0, 'somebody cleaned ' + cleaned + ' rooms with no way up');
    assert(built.every(isHotelInfested), 'every room is infested: ' + built.map((o) => hex(o.unitStatus)));
    assert(housekeepers(tower).every((a) => a.anchorFloor === 1), 'and the staff never left F1');
  },

  'stairs work for a short climb: a flight from F1 to F2 is enough, and passengers\' stairs are not needed beyond it'() {
    // ROUTING.md § Housekeeping walkability: continuous stairs, checked over at
    // most three floors. One flight is well inside it.
    const { world, tower, built, driver } = hotelWorld({
      rooms: [['hotelSingle', 2, 60], ['hotelSingle', 2, 64]], top: 2, service: false, stairs: [[1, 60]],
    });
    let cleaned = 0;
    const was = new Map(built.map((o) => [o.id, false]));
    run(world, driver, 4 * 2600, () => {
      for (const o of built) {
        const d = isHotelRoomDirty(o);
        if (was.get(o.id) && !d && !isHotelInfested(o)) cleaned++;
        was.set(o.id, d);
      }
    });
    assert(cleaned >= 4, 'the staff walked up and cleaned ' + cleaned + ' rooms');
    assert(built.every((o) => !isHotelInfested(o)), 'nothing infested');
  },

  'six floors, one facility: each of the six staff cleans its own floor, in the same morning'() {
    const rooms = [2, 3, 4, 5, 6, 7].map((floor) => ['hotelSingle', floor, 70]);
    const { tower, built, driver, world } = hotelWorld({ rooms, top: 9 });
    const cleaner = new Map();                                    // room id -> the staff member who stood in it
    const was = new Map(built.map((o) => [o.id, false]));
    run(world, driver, 2 * 2600, () => {
      for (const o of built) {
        const d = isHotelRoomDirty(o);
        if (was.get(o.id) && !d && !isHotelInfested(o) && !cleaner.has(o.id)) {
          const who = housekeepers(tower).find((a) => a.targetRoomId === o.id && a.state === HK_STATE.rest);
          cleaner.set(o.id, who?.occupantIndex ?? null);
        }
        was.set(o.id, d);
      }
    });
    assert(cleaner.size === 6, 'every floor was cleaned: ' + [...cleaner]);
    assert(new Set(cleaner.values()).size === 6 && !cleaner.has(null) && ![...cleaner.values()].includes(null),
      'by six different people: ' + [...cleaner.values()]);
    for (const room of built) {
      assert(cleaner.get(room.id) % 6 === floorClassOf(room.floor), `F${room.floor} was cleaned by staff ${cleaner.get(room.id)}`);
    }
  },

  // -------------------------------------------------------------- the proof

  '⚠️ THE PROOF: too few housekeepers for the rooms cause an outbreak; enough prevent it'() {
    // Twenty-two rooms on one floor. One facility's six staff give that floor ONE
    // pair of hands — about eighteen rooms before tick 1500 — so four rooms go
    // dirty every day, take their three strikes, and the infection spreads along
    // the row. Two facilities give it two pairs and nothing is ever left. No
    // facility at all loses the lot on day 3. `node harness/playtest.js --housekeeping`
    // prints the same table.
    const none = housekeepingTrial({ facilities: 0, days: 10 });
    const few = housekeepingTrial({ facilities: 1, days: 10 });
    const enough = housekeepingTrial({ facilities: 2, days: 10 });

    assert(none.infestedAtEnd === 22 && none.cleaned === 0 && none.firstInfestedDay === 3,
      'no staff: every room lost on day 3 — ' + JSON.stringify({ ...none, perDay: undefined }));
    assert(few.cleaned > 100 && few.firstInfestedDay !== null && few.infestedAtEnd >= 4,
      'too few: they cleaned ' + few.cleaned + ' rooms and still lost ' + few.infestedAtEnd + ' — ' + few.perDay.join(' '));
    assert(enough.infestedAtEnd === 0 && enough.firstInfestedDay === null && enough.infestations === 0,
      'enough: nothing was ever infested — ' + enough.perDay.join(' '));
    assert(enough.dirtyAtEnd === 0 && enough.cleaned >= 22 * 8, 'and the rooms were cleaned: ' + enough.cleaned);
    assert(enough.checkouts > few.checkouts && few.checkouts > none.checkouts,
      `the income follows: ${none.checkouts} / ${few.checkouts} / ${enough.checkouts} stays paid`);
    assert(enough.earned === enough.checkouts * 2000 && none.earned === 22 * 2000,
      'at the tier-1 single-room rate of $2,000 a stay');
    // And the outbreak GROWS: it is still spreading when the run ends.
    const grown = housekeepingTrial({ facilities: 1, days: 16 });
    assert(grown.infestedAtEnd > few.infestedAtEnd, `the outbreak spreads: ${few.infestedAtEnd} at day 10, ${grown.infestedAtEnd} at day 16`);
  },

  // ------------------------------------------------------- staff and the HUD

  'the staff never accrue stress through a whole fortnight of real riding'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: floorOfRooms(8, 6), top: 9 });
    run(world, driver, 5 * 2600);
    const staff = housekeepers(tower);
    assert(staff.length === 6, 'six staff');
    assert(staff.every((a) => a.tripCount === 0 && a.accumulatedElapsed === 0 && (a.elapsedPacked & 0x3ff) === 0),
      'a housekeeper\'s record moved: ' + JSON.stringify(staff.find((a) => a.tripCount)));
    // Exactly the guests in their beds (one each in a single room) — and not one
    // of the six staff on top of them.
    const guests = built.filter(isHotelBooked).length;
    assert(population(tower) === guests, `population ${population(tower)}, but ${guests} guests are in bed: the staff were counted`);
  },

  // ------------------------------------------------------------ what you see

  'a dirty room says DIRTY, an infested one INFESTED, and each draws its own overlay'() {
    const tower = bareTower();
    const room = placeRoom(tower, 'hotelTwin', 3, 10, HOTEL_UNIT_STATUS.vacantEarly);
    assert(objectStatusTag(room) === '' && objectOverlay(room) === null, 'a clean room carries nothing');
    room.unitStatus = HOTEL_UNIT_STATUS.dirtyLate;
    assert(objectStatusTag(room) === 'DIRTY', 'dirty says DIRTY');
    assert(JSON.stringify(objectOverlay(room)) === '{"name":"room-status","animation":"dirty"}', 'and draws the mess');
    room.unitStatus = HOTEL_UNIT_STATUS.infestedLate;
    assert(objectStatusTag(room) === 'INFESTED', 'infested says INFESTED');
    assert(JSON.stringify(objectOverlay(room)) === '{"name":"room-status","animation":"infested"}', 'and draws the swarm');
    room.unitStatus = 0;
    assert(objectOverlay(room) === null, 'a booked room draws nothing over its bed');
    const office = placeObject(tower, { family: FAMILY.office, floor: 4, left: 10, right: 15 }, () => createSimTripRecord()).object;
    office.unitStatus = 0x28;
    assert(objectOverlay(office) === null, 'and the overlay is a hotel thing: an office in the same byte band draws none');
  },

  // ------------------------------------------------------------ the save

  'the save shape moved: v3, and a cleaning in progress survives a save and a load'() {
    assert(SAVE_VERSION >= 3, 'the save shape changed, so the version moved: ' + SAVE_VERSION);
    const { world, tower, driver } = hotelWorld({ rooms: floorOfRooms(8, 6), top: 9 });
    run(world, driver, 2 * 2600 + 700);                        // mid-morning of day 2
    const staff = housekeepers(tower);
    assert(staff.some((a) => a.state !== HK_STATE.search || a.spawnFloor !== null), 'fixture: the staff are mid-routine');

    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    const loaded = restore(blob);
    assert(loaded.ok, 'the save would not load: ' + loaded.reason);
    const t2 = loaded.world.tower;
    const again = housekeepers(t2);
    assert(again.length === 6 && again.every((a, i) => a.state === staff[i].state && a.spawnFloor === staff[i].spawnFloor
      && a.targetRoomId === staff[i].targetRoomId && a.anchorFloor === staff[i].anchorFloor), 'the staff came back as they were');

    // And the loaded game plays on exactly as the original does.
    const d2 = makeDriver(loaded.world);
    run(world, driver, 3 * 2600);
    run(loaded.world, d2, 3 * 2600);
    const bands = (t) => [...t.objects.values()].filter((o) => o.family === FAMILY.hotelSingle).map((o) => o.unitStatus).join();
    assert(bands(tower) === bands(t2), 'the loaded tower diverged:\n       ' + bands(tower) + '\n       ' + bands(t2));
  },

  // ------------------------------------------------------------- the 1600 chain

  'checkpoint 1600 runs the whole hotel pass through the driver: spread, strikes and refresh, in one key'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: floorOfRooms(3, 3), top: 4, facilities: 0 });
    const [a, b, c] = built;
    a.unitStatus = HOTEL_UNIT_STATUS.dirtyEarly; a.occupiedFlag = false; a.activationTickCount = 2;
    b.unitStatus = HOTEL_UNIT_STATUS.vacantEarly;
    c.unitStatus = HOTEL_UNIT_STATUS.infestedEarly;
    tower.clock.dayTick = 1598;
    driver.scheduler.tick(tower); driver.scheduler.tick(tower);
    assert(tower.clock.dayTick === 1600, 'fixture: at 1600');
    assert(isHotelInfested(a), 'the strike landed through the driver\'s own checkpoint table');
    assert(isHotelInfested(b), 'the spread landed too (b is beside c)');
  },
};
