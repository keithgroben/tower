/**
 * Families 3 / 4 / 5 — hotel rooms.
 *
 * The assertions that matter are the five near the bottom, which run through
 * the **composition** (`newTowerWorld`, `makeDriver`'s own scheduler, and
 * `tower.cash`) and never through a ledger or a handler the test built:
 *
 *   - guests check in in the EVENING and out in the MORNING;
 *   - the stay is paid AT CHECKOUT, to the tower's own cash, exactly once;
 *   - a hotel the lifts cannot reach never fills;
 *   - a guest who cannot get to the lobby does not pay;
 *   - and a cleaned room takes a guest again, on a weekend too — cleaned, since
 *     issue #9, by real housekeeping staff that walk there.
 *
 * Everything above them is the machinery that makes those true. Two habits from
 * `CLAUDE.md`'s failure list are deliberate: the band tests state what the
 * OFFICE reading would do (the plausible wrong answer), and the money tests
 * assert exact amounts rather than "went up", because a test that only checks
 * direction passes for a payout of one dollar.
 *
 * Spec: `specs/facility/HOTEL.md`, `specs/DEMAND.md` § Families 3/4/5,
 * `specs/PEOPLE.md` § Families `3`, `4`, `5`, `specs/FACILITIES.md`,
 * `specs/TIME.md`, `specs/ECONOMY.md`.
 */
import {
  HOTEL_NOISE_FAMILIES, HOTEL_NOISE_RADIUS, HOTEL_RESET_TICK, HOTEL_SALE_RESET_TICK,
  HOTEL_STATE, HOTEL_SWEEP_TICK, HOTEL_WIDTH, activateHotelRoom, arrivalStateFor,
  checkoutHotelRoom, hotelArrival, hotelDailyReset, hotelDispatch, hotelGate,
  hotelMiddaySweep, hotelNoiseNear, hotelRoomRank, hotelRooms, hotelSaleCountReset, hotelScore,
  isHotelBooked, isHotelInfested, isHotelRoomDirty, isHotelVacant, recomputeHotelOperationalStatus,
  recordHotelSale, refreshHotelOccupiedFlag, stepStay,
} from '../src/games/tower/sim/hotel.js';
import {
  EVAL_UNSET, FAMILY, HOTEL_UNIT_STATUS, OCCUPANTS, POPULATION_CONTRIBUTION, __resetIds,
  createTower, isHotelFamily, isRented, isUnitLet, letBandMax, placeObject, population,
} from '../src/games/tower/sim/state.js';
import { CONDO_NOISE_FAMILIES, condoNoiseNear } from '../src/games/tower/sim/condo.js';
import { noiseSourceNear } from '../src/games/tower/sim/office.js';
import { createSimTripRecord, FACILITY_POPULATION } from '../src/games/tower/sim/stress.js';
import {
  CONSTRUCTION_COST, POPULATION_BY_FAMILY, RENT_TIERS,
} from '../src/games/tower/sim/economy.js';
import { STAR_REQUIREMENT, lockReason } from '../src/games/tower/sim/progression.js';
import { applyAction, BUILDABLE, ESCALATOR_UNDERLAY, hasTenant } from '../src/games/tower/sim/actions.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { placeCommercialVenue, venueOf } from '../src/games/tower/sim/commercial.js';
import { hotelCashflowHooks, ledgerFor } from '../src/games/tower/sim/ledger-adapter.js';
import { SAVE_VERSION, restore, snapshot, summarise } from '../src/games/tower/sim/save.js';
import { objectSprite, objectStatusTag, officeIsLet } from '../src/games/tower/render/canvas.js';
import { TOOLS, preview, toolById } from '../src/games/tower/ui/build.js';
import { newTowerWorld, seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const ROOMS = ['hotelSingle', 'hotelTwin', 'hotelSuite'];
const NAME_OF = { [FAMILY.hotelSingle]: 'hotelSingle', [FAMILY.hotelTwin]: 'hotelTwin', [FAMILY.hotelSuite]: 'hotelSuite' };
const GUESTS = { hotelSingle: 1, hotelTwin: 2, hotelSuite: 2 };

const hex = (n) => '0x' + n.toString(16);

// ------------------------------------------------------------- bare fixtures

/** A bare tower with the clock where the test wants it. */
function bareTower({ daypart = 0, dayTick = null, dayCounter = 0 } = {}) {
  __resetIds();
  const tower = createTower();
  tower.clock.dayTick = dayTick ?? daypart * 400;
  tower.clock.daypart = Math.floor(tower.clock.dayTick / 400);
  tower.clock.dayCounter = dayCounter;
  return tower;
}

/** One room and its guests, on a bare tower. */
function place(tower, what, { floor = 3, left = 10, rentLevel = 1 } = {}) {
  const placed = placeObject(tower,
    { family: FAMILY[what], floor, left, right: left + HOTEL_WIDTH[what] - 1, rentLevel },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture failed: ' + placed.reason);
  return placed.object;
}

const guestsOf = (tower, object) => tower.actors.filter((a) => a.objectId === object.id);

function towerWithRoom(what, { daypart = 0, ...rest } = {}) {
  const tower = bareTower({ daypart });
  const object = place(tower, what, rest);
  return { tower, object, guests: guestsOf(tower, object) };
}

const stress = (guests, average, trips = 4) => {
  for (const g of guests) { g.tripCount = trips; g.accumulatedElapsed = average * trips; }
};

const clockAt = (daypart, { dayTick = null, calendarPhase = false } = {}) =>
  ({ daypart, dayTick: dayTick ?? daypart * 400, calendarPhase });
const riggedRng = (pass) => ({ chance: () => pass, next: () => 0, int: () => 0 });

/**
 * A router that answers what it is told and remembers what it was asked.
 * `codes` is consumed in order; the last one repeats.
 */
function stubCtx(codes, extra = {}) {
  const calls = [];
  const events = { checkIns: 0, checkouts: 0, delays: [] };
  const queue = Array.isArray(codes) ? [...codes] : [codes];
  const ctx = {
    calls,
    events,
    resolveRoute(_tower, actor, from, to) {
      const code = queue.length > 1 ? queue.shift() : queue[0];
      calls.push({ from, to, code, actor: actor.id });
      return { code, legDestination: to };
    },
    onDelay: (delay) => events.delays.push(delay.kind),
    onCheckIn: () => { events.checkIns++; },
    onCheckout: () => { events.checkouts++; },
    ...extra,
  };
  return ctx;
}

// ------------------------------------------------------------ world fixtures

/** A star-3 tower with one lift to F6 and the given rooms. Nothing else. */
function hotelWorld({ rooms = [], top = 6, stars = 3, cars = 1, housekeeping = 0 } = {}) {
  const world = newTowerWorld({ seed: 1, cash: 50_000_000 });
  const { tower } = world;
  tower.starCount = stars;
  const shaft = applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 40 });
  assert(shaft.ok, 'the lift would not build: ' + shaft.reason);
  for (let i = 1; i < cars; i++) applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id });
  const built = rooms.map(([what, floor, left]) => {
    const r = applyAction(world, { type: 'build', what, floor, left });
    assert(r.ok, `${what} on F${floor} @${left} would not build: ${r.reason}`);
    return r.object;
  });
  // Housekeeping needs a way up that is not the guests' lift: a service elevator.
  // The facilities go on F1, beside the guest lift and clear of the rooms.
  const staff = [];
  if (housekeeping) {
    const service = applyAction(world, { type: 'build_shaft', kind: 'service', bottom: 0, top, column: 52 });
    assert(service.ok, 'the service lift would not build: ' + service.reason);
    for (let i = 0; i < housekeeping; i++) {
      const r = applyAction(world, { type: 'build', what: 'housekeeping', floor: 1, left: 60 + i * 16 });
      assert(r.ok, 'housekeeping would not build: ' + r.reason);
      staff.push(r.object);
    }
  }
  rebuildRouteTables(tower);
  tower.routeTablesDirty = false;
  return { world, tower, built, staff, driver: makeDriver(world) };
}

const SIX_ROOMS = [
  ['hotelSingle', 2, 10], ['hotelTwin', 2, 16], ['hotelSuite', 2, 24],
  ['hotelSingle', 3, 10], ['hotelTwin', 3, 16], ['hotelSuite', 3, 24],
];

/** Tick the composition, calling `watch(tick)` after each. */
function run(world, driver, ticks, watch = null) {
  for (let i = 0; i < ticks; i++) {
    driver.scheduler.tick(world.tower);
    watch?.(world.tower.clock.dayTick, world.tower.clock.dayCounter);
  }
}

const payoutOf = (object) => RENT_TIERS[NAME_OF[object.family]][object.rentLevel];

export const tests = {
  // ------------------------------------------------------------ the identity

  'three families, with the codes the reference gives them'() {
    // specs/FACILITIES.md § Type codes: 3 Single Room, 4 Twin Room, 5 Hotel Suite.
    assert(FAMILY.hotelSingle === 3 && FAMILY.hotelTwin === 4 && FAMILY.hotelSuite === 5,
      'hotel codes are ' + [FAMILY.hotelSingle, FAMILY.hotelTwin, FAMILY.hotelSuite]);
    for (const code of [3, 4, 5]) assert(isHotelFamily(code), code + ' is a hotel family');
    for (const code of [FAMILY.office, FAMILY.condo, FAMILY.fastFood, FAMILY.restaurant, FAMILY.retail, FAMILY.lobby]) {
      assert(!isHotelFamily(code), code + ' is not a hotel');
    }
  },

  '⚠️ guests per room are 1 / 2 / 2 — the suite holds TWO, not the three HOTEL.md says'() {
    // HOTEL.md § Identity says "suite, population 3". PEOPLE.md (+1/+2/+2), the
    // divisor in FACILITIES.md, the help file ("accommodate two guests") and the
    // reference implementation all say 2. spec/DEVIATIONS.md A25.
    assert(OCCUPANTS[FAMILY.hotelSingle] === 1 && OCCUPANTS[FAMILY.hotelTwin] === 2 && OCCUPANTS[FAMILY.hotelSuite] === 2,
      'occupants: ' + [3, 4, 5].map((c) => OCCUPANTS[c]));
    assert(POPULATION_CONTRIBUTION[FAMILY.hotelSuite] === 2, 'a suite contributes 2 people to the population');
    assert(POPULATION_BY_FAMILY.hotelSuite === 2, 'the ledger adds 2 for a suite, got ' + POPULATION_BY_FAMILY.hotelSuite);
    assert(FACILITY_POPULATION[FAMILY.hotelSuite] === 2, 'a suite is scored across two guests');
    for (const what of ROOMS) {
      const { guests } = towerWithRoom(what);
      assert(guests.length === GUESTS[what], `${what} placed ${guests.length} guests`);
      assert(guests.every((g) => g.state === 0x20), `${what}: guests start waiting to check in (0x20)`);
      assert(guests.every((g) => g.family === FAMILY[what]), `${what}: guests carry the room's family`);
    }
  },

  'prices and payouts are the game’s own'() {
    assert(CONSTRUCTION_COST.hotelSingle === 20_000 && CONSTRUCTION_COST.hotelTwin === 50_000
      && CONSTRUCTION_COST.hotelSuite === 100_000, 'construction prices');
    assert(JSON.stringify(RENT_TIERS.hotelSingle) === '[3000,2000,1500,500]', 'single payouts');
    assert(JSON.stringify(RENT_TIERS.hotelTwin) === '[4500,3000,2000,800]', 'twin payouts');
    assert(JSON.stringify(RENT_TIERS.hotelSuite) === '[9000,6000,4000,1500]', 'suite payouts');
  },

  '⚠️ the twin and the suite are three stars, the single two — the help file, not the implementation'() {
    // The reference implementation lists all three at 2; the game's own help
    // file prints "Twin Hotel Room - Three Stars" and "Hotel Suite - Three
    // Stars". spec/DEVIATIONS.md A27.
    assert(STAR_REQUIREMENT.hotelSingle === 2, 'single: ' + STAR_REQUIREMENT.hotelSingle);
    assert(STAR_REQUIREMENT.hotelTwin === 3, 'twin: ' + STAR_REQUIREMENT.hotelTwin);
    assert(STAR_REQUIREMENT.hotelSuite === 3, 'suite: ' + STAR_REQUIREMENT.hotelSuite);
    const tower = bareTower();
    assert(lockReason(tower, 'hotelSingle', 'Single Room') !== null, 'a one-star tower cannot build a single');
    tower.starCount = 2;
    assert(lockReason(tower, 'hotelSingle', 'Single Room') === null, 'a two-star tower can');
    assert(/Twin Room needs a tower of 3 stars/.test(lockReason(tower, 'hotelTwin', 'Twin Room')), 'but not a twin');
    assert(lockReason(tower, 'hotelSuite', 'Hotel Suite') !== null, 'nor a suite');
    tower.starCount = 3;
    assert(lockReason(tower, 'hotelTwin', 'Twin Room') === null && lockReason(tower, 'hotelSuite', 'Hotel Suite') === null,
      'three stars unlocks both');
  },

  // --------------------------------------------------------------- placement

  'a new room is vacant — not dirty, not booked, not counted'() {
    // HOTEL.md § Placement: "hotel placement does not start in the checked-out
    // band" — the initial visible state is 0x18 or 0x20.
    for (const [daypart, band] of [[0, 0x18], [3, 0x18], [4, 0x20], [6, 0x20]]) {
      for (const what of ROOMS) {
        const { tower, object } = towerWithRoom(what, { daypart });
        assert(object.unitStatus === band, `${what} at daypart ${daypart}: ${hex(object.unitStatus)}, wanted ${hex(band)}`);
        assert(isHotelVacant(object) && !isHotelBooked(object) && !isHotelRoomDirty(object) && !isHotelInfested(object),
          what + ' is vacant and nothing else');
        assert(object.evalLevel === EVAL_UNSET, 'unscored until the first sweep');
        assert(object.occupiedFlag === false, 'the latch is not set at placement');
        assert(population(tower) === 0, 'nobody lives in a room nobody has checked into');
      }
    }
  },

  '⚠️ the band is what says a guest is in — and the OFFICE band is the wrong one'() {
    // isRented() is `<= 0x0f`. A hotel's occupied band runs to 0x17 and sits at
    // the sync sentinel 0x10 every night, so the office reading drops a room's
    // guests at dusk: a population that breathes once a day.
    const { tower, object } = towerWithRoom('hotelTwin');
    object.unitStatus = 0x10;
    assert(!isRented(object.unitStatus), 'the office reading says vacant at 0x10 …');
    assert(isUnitLet(object) && isHotelBooked(object), '… the hotel reading says occupied');
    assert(population(tower) === 2, 'and the twin counts its two guests overnight, got ' + population(tower));
    object.unitStatus = 0x17;
    assert(isUnitLet(object) && letBandMax(FAMILY.hotelTwin) === 0x17, '0x17 is the top of the occupied band');
    object.unitStatus = 0x18;
    assert(!isUnitLet(object) && population(tower) === 0, '0x18 is vacant');
  },

  'the four bands have exact edges: 0x17 / 0x18 / 0x27 / 0x28 / 0x37 / 0x38'() {
    const { object } = towerWithRoom('hotelSingle');
    const at = (n) => { object.unitStatus = n; return [isHotelBooked(object), isHotelVacant(object), isHotelRoomDirty(object), isHotelInfested(object)].map(Number).join(''); };
    const expect = { 0x00: '1000', 0x17: '1000', 0x18: '0100', 0x27: '0100', 0x28: '0010', 0x30: '0010', 0x37: '0010', 0x38: '0001', 0x40: '0001' };
    for (const [value, want] of Object.entries(expect)) {
      assert(at(Number(value)) === want, `${hex(Number(value))}: got ${at(Number(value))}, wanted ${want} (booked/vacant/dirty/infested)`);
    }
  },

  'rooms go above the ground floor and the sim says so in words'() {
    const { world } = hotelWorld();
    for (const what of ROOMS) {
      for (const floor of [0, -1, -5]) {
        const r = applyAction(world, { type: 'build', what, floor, left: 100 });
        assert(!r.ok && /has to go above the ground floor/.test(r.reason), `${what} on floor ${floor}: ${JSON.stringify(r)}`);
      }
    }
    assert(applyAction(world, { type: 'build', what: 'hotelSingle', floor: 1, left: 100 }).ok, 'F1 is above grade');
  },

  'widths are 4 / 6 / 10 and the price is the room plus its floor tiles'() {
    const { world, tower } = hotelWorld();
    assert(HOTEL_WIDTH.hotelSingle === 4 && HOTEL_WIDTH.hotelTwin === 6 && HOTEL_WIDTH.hotelSuite === 10, 'widths');
    let left = 60;
    for (const what of ROOMS) {
      const before = tower.cash;
      const r = applyAction(world, { type: 'build', what, floor: 2, left });
      assert(r.ok, r.reason);
      assert(r.object.right - r.object.left + 1 === HOTEL_WIDTH[what], what + ' spans ' + (r.object.right - r.object.left + 1));
      const expected = CONSTRUCTION_COST[what] + HOTEL_WIDTH[what] * CONSTRUCTION_COST.floorTile;
      assert(before - tower.cash === expected && r.cost === expected, `${what} cost ${before - tower.cash}, wanted ${expected}`);
      left += 12;
    }
  },

  'the stars lock the build, and the lock is checked before the price'() {
    const world = newTowerWorld({ seed: 1, cash: 100 });          // too poor AND too low
    const r = applyAction(world, { type: 'build', what: 'hotelSuite', floor: 2, left: 20 });
    assert(!r.ok && /Hotel Suite needs a tower of 3 stars/.test(r.reason), 'the lock is said first: ' + r.reason);
  },

  'the palette lists all three rooms, built from BUILDABLE'() {
    for (const what of ROOMS) {
      const tool = TOOLS.find((t) => t.action === 'build' && t.what === what);
      assert(tool, what + ' has no palette tool');
      assert(tool.width === HOTEL_WIDTH[what] && tool.label === BUILDABLE[what].label, what + ' tool disagrees with BUILDABLE');
    }
  },

  '⚠️ the ghost and the seam agree on every hotel placement, verdict and wording'() {
    // CLAUDE.md: a test that pins one side of an agreement is not a test of the
    // agreement. Each case builds two identical worlds, asks the ghost in one
    // and the seam in the other, and compares both.
    const cases = [
      ['a single on empty air', 'hotelSingle', 2, 90, 2],
      ['a single at one star', 'hotelSingle', 2, 90, 1],
      ['a twin at two stars', 'hotelTwin', 2, 90, 2],
      ['a suite at two stars', 'hotelSuite', 2, 90, 2],
      ['a suite on empty air', 'hotelSuite', 4, 90, 3],
      ['a single in the basement', 'hotelSingle', -1, 90, 3],
      ['a twin on the ground floor', 'hotelTwin', 0, 90, 3],
      ['a suite off the right edge', 'hotelSuite', 2, 149, 3],
    ];
    for (const [label, what, floor, left, stars] of cases) {
      const a = hotelWorld({ stars });
      const guess = preview(a.world, toolById(what), { floor, tile: left, object: null, carrier: null });
      const b = hotelWorld({ stars });
      const command = { type: 'build', what, floor, left: Math.max(0, Math.min(150 - HOTEL_WIDTH[what], left)) };
      const real = applyAction(b.world, command);
      assert(guess.ok === real.ok, `${label}: ghost said ${guess.ok ? 'yes' : 'no'} and the seam said ${real.ok ? 'yes' : 'no'}`);
      if (!real.ok) assert(guess.reason === real.reason, `${label}: ghost "${guess.reason}" vs seam "${real.reason}"`);
    }
    // And the overlap case, which needs something built to overlap.
    const a = hotelWorld({ rooms: [['hotelSingle', 2, 90]] });
    const guess = preview(a.world, toolById('hotelTwin'), { floor: 2, tile: 92, object: null, carrier: null });
    const real = applyAction(hotelWorld({ rooms: [['hotelSingle', 2, 90]] }).world, { type: 'build', what: 'hotelTwin', floor: 2, left: 92 });
    assert(!guess.ok && !real.ok && guess.reason === real.reason, `overlap: "${guess.reason}" vs "${real.reason}"`);
  },

  'only the SINGLE room may stand under an escalator landing — the list says so'() {
    // COMMANDS.md: "empty, restaurant, retail, fast food, party hall (upper),
    // party hall (lower), lobby, cinema (upper), cinema (lower), single hotel room".
    assert(ESCALATOR_UNDERLAY.has(FAMILY.hotelSingle), 'a single is on the list');
    assert(!ESCALATOR_UNDERLAY.has(FAMILY.hotelTwin) && !ESCALATOR_UNDERLAY.has(FAMILY.hotelSuite), 'the twin and the suite are not');
    // And through the real check, so the set and the rule cannot part company.
    const { world, tower } = hotelWorld({ rooms: [['hotelSingle', 1, 90]] });
    const lobby = [...tower.objects.values()].find((o) => o.family === FAMILY.lobby);
    assert(lobby, 'fixture: a lobby');
    // Both landings (floor 0 and floor 1) need floor under them: the lobby and the single.
    const wide = applyAction(world, { type: 'build', what: 'hotelSingle', floor: 1, left: 94 });
    assert(wide.ok, wide.reason);
  },

  // --------------------------------------------------------------- the bands

  '⚠️ a dirty room can never be cleaned by arithmetic: stepStay never leaves the occupied band'() {
    // A DEC on a checked-out room at 0x28 lands on 0x27 — which is VACANT. That
    // is a free housekeeper. The condo has the same trap one band up.
    const { tower, object } = towerWithRoom('hotelSingle');
    for (const dirty of [0x28, 0x30, 0x37]) {
      object.unitStatus = dirty;
      assert(stepStay(tower, object, -1) === false && object.unitStatus === dirty, `a DEC moved ${hex(dirty)} to ${hex(object.unitStatus)}`);
      assert(stepStay(tower, object, +1) === false && object.unitStatus === dirty, 'an INC moved a dirty room');
    }
    for (const vacant of [0x18, 0x20, 0x27]) {
      object.unitStatus = vacant;
      stepStay(tower, object, +1); stepStay(tower, object, -1);
      assert(object.unitStatus === vacant, 'a vacant room was stepped into the occupied band by arithmetic: ' + hex(object.unitStatus));
    }
    object.unitStatus = 0;
    stepStay(tower, object, -1);
    assert(object.unitStatus === 0, 'the count stops at 0, got ' + object.unitStatus);
    object.unitStatus = 0x17;
    stepStay(tower, object, +1);
    assert(object.unitStatus === 0x17, 'and at 0x17, got ' + hex(object.unitStatus));
  },

  'INC on the sync sentinel restarts the count at 1 (morning) or 9 (evening)'() {
    // increment_stay_phase_345: the sentinel is not a number to add one to.
    for (const [daypart, want] of [[0, 1], [3, 1], [4, 9], [6, 9]]) {
      const { tower, object } = towerWithRoom('hotelTwin', { daypart });
      object.unitStatus = HOTEL_UNIT_STATUS.syncMarker;
      stepStay(tower, object, +1);
      assert(object.unitStatus === want, `daypart ${daypart}: ${hex(object.unitStatus)}, wanted ${want}`);
    }
  },

  'only the vacant band can be activated, and activating it books the room once'() {
    const { tower, object } = towerWithRoom('hotelTwin', { daypart: 4 });
    const ctx = stubCtx(3);
    assert(activateHotelRoom(tower, object, ctx) === true, 'a vacant room activates');
    assert(object.unitStatus === HOTEL_UNIT_STATUS.occupiedLate, 'evening writes 0x08, got ' + hex(object.unitStatus));
    assert(activateHotelRoom(tower, object, ctx) === false && ctx.events.checkIns === 1, 'a second guest adds nothing');

    const morning = towerWithRoom('hotelSingle', { daypart: 1 });
    activateHotelRoom(morning.tower, morning.object, stubCtx(3));
    assert(morning.object.unitStatus === HOTEL_UNIT_STATUS.occupiedEarly, 'morning writes 0x00');
    assert(isHotelBooked(morning.object), '0x00 is a perfectly legal occupied value');

    for (const dirty of [0x28, 0x30]) {
      const d = towerWithRoom('hotelSingle');
      d.object.unitStatus = dirty;
      const c = stubCtx(3);
      assert(activateHotelRoom(d.tower, d.object, c) === false && d.object.unitStatus === dirty && c.events.checkIns === 0,
        'a dirty room was re-let by activation');
    }
  },

  // ---------------------------------------------------------------- the gate

  'check-in: the latch, then dice at daypart 4, then always until 2300'() {
    const { object, guests } = towerWithRoom('hotelSingle');
    const [g] = guests;
    const pass = riggedRng(true), fail = riggedRng(false);

    object.occupiedFlag = false;
    for (const dp of [0, 3, 4, 5]) {
      assert(hotelGate(g, object, clockAt(dp), pass) === 'hold', `daypart ${dp} without the latch must hold`);
    }
    object.occupiedFlag = true;
    for (const dp of [0, 1, 2, 3]) assert(hotelGate(g, object, clockAt(dp), pass) === 'hold', `daypart ${dp} is not the evening`);
    assert(hotelGate(g, object, clockAt(4), pass) === 'dispatch', 'daypart 4 rolls 1/12 — pass');
    assert(hotelGate(g, object, clockAt(4), fail) === 'hold', 'daypart 4 rolls 1/12 — fail');
    assert(hotelGate(g, object, clockAt(5, { dayTick: 2000 }), fail) === 'dispatch', 'daypart 5 before 2300 needs no dice');
    assert(hotelGate(g, object, clockAt(5, { dayTick: 2299 }), fail) === 'dispatch', '2299 is the last tick');
    assert(hotelGate(g, object, clockAt(5, { dayTick: 2300 }), pass) === 'hold', '2300 and after: no check-in');
    assert(hotelGate(g, object, clockAt(6), pass) === 'hold', 'night: no check-in');
  },

  'the evening trip: 1/6 at daypart 4, forced to the sync after, held before'() {
    const { object, guests } = towerWithRoom('hotelSingle');
    const g = guests[0]; g.state = HOTEL_STATE.active;
    assert(hotelGate(g, object, clockAt(4), riggedRng(true)) === 'dispatch', 'dice pass');
    assert(hotelGate(g, object, clockAt(4), riggedRng(false)) === 'hold', 'dice fail');
    for (const dp of [5, 6]) assert(hotelGate(g, object, clockAt(dp), riggedRng(false)) === HOTEL_STATE.sync, `daypart ${dp} forces 0x04`);
    for (const dp of [0, 1, 2, 3]) assert(hotelGate(g, object, clockAt(dp), riggedRng(true)) === 'hold', `daypart ${dp} holds`);
  },

  'sync, ready, checkout and return gates follow the table'() {
    const { object, guests } = towerWithRoom('hotelSingle');
    const g = guests[0];
    const gate = (state, dp, tick, pass = false) => { g.state = state; return hotelGate(g, object, clockAt(dp, { dayTick: tick }), riggedRng(pass)); };

    // 0x04: daypart < 5 hold; > 2400 dispatch; else 1/12
    assert(gate(0x04, 4, 1700, true) === 'hold', 'sync holds before daypart 5');
    assert(gate(0x04, 5, 2100, false) === 'hold' && gate(0x04, 5, 2100, true) === 'dispatch', 'sync rolls 1/12 until 2400');
    assert(gate(0x04, 6, 2401, false) === 'dispatch', 'sync is certain after 2400');
    assert(gate(0x04, 5, 2400, false) === 'hold', '2400 itself is still the dice');
    // 0x10: daypart < 5 dispatch; dp>=5: tick > 2566 → 1/12; else hold
    assert(gate(0x10, 0, 10, false) === 'dispatch' && gate(0x10, 4, 1700, false) === 'dispatch', 'ready dispatches by day');
    assert(gate(0x10, 6, 2500, true) === 'hold', 'ready holds at night until 2566');
    assert(gate(0x10, 6, 2567, true) === 'dispatch' && gate(0x10, 6, 2567, false) === 'hold', 'then 1/12');
    // 0x05: daypart 0 → 1/12; 1-5 dispatch; 6 hold
    assert(gate(0x05, 0, 10, true) === 'dispatch' && gate(0x05, 0, 10, false) === 'hold', 'checkout rolls 1/12 at dawn');
    for (const dp of [1, 2, 3, 4, 5]) assert(gate(0x05, dp, dp * 400, false) === 'dispatch', `checkout dispatches at daypart ${dp}`);
    assert(gate(0x05, 6, 2450, true) === 'hold', 'checkout is suppressed at night');
    // 0x22: daypart >= 4
    assert(gate(0x22, 3, 1500, true) === 'hold' && gate(0x22, 4, 1700, false) === 'dispatch', 'the return waits for the evening');
  },

  '⚠️ no gate in the hotel table reads the calendar phase — hotels take guests every night'() {
    // An office will not commute on a weekend; a condo's resident 0 changes its
    // venue trip. The hotel rows mention neither, so a weekend clock must give
    // the SAME answer at every state and every daypart.
    const { object, guests } = towerWithRoom('hotelTwin');
    object.occupiedFlag = true;
    const g = guests[0];
    for (const state of [0x20, 0x01, 0x22, 0x04, 0x10, 0x05]) {
      g.state = state;
      for (let dp = 0; dp < 7; dp++) {
        for (const pass of [true, false]) {
          const weekday = hotelGate(g, object, clockAt(dp, { calendarPhase: false }), riggedRng(pass));
          const weekend = hotelGate(g, object, clockAt(dp, { calendarPhase: true }), riggedRng(pass));
          assert(weekday === weekend, `state ${hex(state)} daypart ${dp}: weekday ${weekday}, weekend ${weekend}`);
        }
      }
    }
  },

  // ---------------------------------------------------------------- check-in

  'check-in: a route that fails books nothing and the guest tries again'() {
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 4 });
    object.occupiedFlag = true;
    const ctx = stubCtx(-1);
    const out = hotelDispatch(tower, guests[0], object, tower.clock, ctx);
    assert(!out.booked && object.unitStatus === HOTEL_UNIT_STATUS.vacantLate, 'the room was activated by a route that failed: ' + hex(object.unitStatus));
    assert(ctx.events.checkIns === 0 && population(tower) === 0, 'no population for a guest who never got in');
    assert(guests[0].state === HOTEL_STATE.seeking, 'back to waiting, not stranded: ' + hex(guests[0].state));
    assert(ctx.calls[0].from === 0 && ctx.calls[0].to === object.floor, 'the route was lobby → room, asked as ' + JSON.stringify(ctx.calls[0]));
  },

  '⚠️ check-in: an accepted route is a guest ON ITS WAY, not a booking — the ARRIVAL books the room'() {
    // The reference implementation books en route; this build books on arrival
    // (spec/DEVIATIONS.md A32), because our router will accept the first leg of
    // a journey it cannot finish and a room booked by that guest is population
    // on the books with nobody in the bed and no way to ever pay.
    for (const code of [0, 1, 2]) {
      const { tower, object, guests } = towerWithRoom('hotelTwin', { daypart: 5 });
      const ctx = stubCtx(code);
      hotelDispatch(tower, guests[0], object, tower.clock, ctx);
      assert(!isHotelBooked(object) && ctx.events.checkIns === 0, `code ${code} booked the room before anyone got there`);
      assert(guests[0].state === (HOTEL_STATE.seeking | 0x40), `code ${code} left the guest in ${hex(guests[0].state)}`);
      assert(population(tower) === 0, 'and nobody is counted yet');

      hotelArrival(tower, guests[0], object.floor, ctx);
      assert(isHotelBooked(object) && ctx.events.checkIns === 1, 'the arrival did not book the room');
      assert(object.unitStatus === HOTEL_UNIT_STATUS.occupiedLate + 1, 'booked at the evening base value, plus the arrival: ' + hex(object.unitStatus));
      assert(population(tower) === 2, 'the twin is two people from the moment it is booked');
    }
  },

  '⚠️ check-in: a guest who gets part of the way and then fails books NOTHING'() {
    // The zombie: a stairs flight toward a floor nothing else reaches. The first
    // leg is accepted (code 1), the second is refused (-1), and the guest is back
    // at the lobby. Booked on acceptance, that room would be full of nobody for ever.
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 5, floor: 2 });
    const [g] = guests;
    const first = stubCtx([1]);
    hotelDispatch(tower, g, object, tower.clock, first);
    assert(g.anchorFloor === 0 || g.anchorFloor === object.floor, 'sanity: the stub answered a walked leg');
    const second = stubCtx([-1]);
    hotelDispatch(tower, g, object, tower.clock, second);
    assert(!isHotelBooked(object) && first.events.checkIns + second.events.checkIns === 0, 'a room was booked by a journey that failed');
    assert(g.state === HOTEL_STATE.seeking && population(tower) === 0, 'the guest is back at the lobby, unbooked');
  },

  'check-in: a walked leg moves the guest to the far landing, so the next stride routes from there'() {
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 5, floor: 3 });
    const [g] = guests;
    const walk = { calls: [], resolveRoute(_t, _a, from, to) { this.calls.push([from, to]); return { code: 1, legDestination: from + 1 }; }, onDelay() {} };
    hotelDispatch(tower, g, object, tower.clock, walk);
    assert(g.anchorFloor === 1, 'one flight up: standing on 1, got ' + g.anchorFloor);
    hotelDispatch(tower, g, object, tower.clock, walk);
    hotelDispatch(tower, g, object, tower.clock, walk);
    assert(walk.calls.map((c) => c.join('>')).join() === '0>3,1>3,2>3', 'each stride routes on from where the last landed: ' + walk.calls.map((c) => c.join('>')));
    const arrive = stubCtx(3);
    hotelDispatch(tower, g, object, tower.clock, arrive);
    assert(isHotelBooked(object) && arrive.events.checkIns === 1, 'and the last flight books the room');
  },

  'check-in: the second guest of a twin finds the room booked and adds nothing to the ledger'() {
    const { tower, object, guests } = towerWithRoom('hotelTwin', { daypart: 5 });
    const ctx = stubCtx(3);                     // a same-floor answer is an arrival
    hotelDispatch(tower, guests[0], object, tower.clock, ctx);
    hotelDispatch(tower, guests[1], object, tower.clock, ctx);
    assert(ctx.events.checkIns === 1, 'check-ins: ' + ctx.events.checkIns);
    // Each ARRIVAL steps the count once: 8 → 9 → 10, which is how the room
    // counts the people it has to check out again.
    assert(object.unitStatus === 0x0a, 'two arrivals leave the count at 0x0a, got ' + hex(object.unitStatus));
  },

  'check-in: a guest that lands is in the room, and the room’s rank says where it goes next'() {
    // PEOPLE.md: "→ 0x01 or 0x04", unspecified. The implementation reads the
    // parity of the room's floor-local index (A28): even → the evening trip.
    const tower = bareTower({ daypart: 5 });
    const rooms = [10, 20, 30].map((left) => place(tower, 'hotelSingle', { left }));
    assert(rooms.map((r) => hotelRoomRank(tower, r)).join() === '0,1,2', 'ranks run left to right');
    const want = [HOTEL_STATE.active, HOTEL_STATE.sync, HOTEL_STATE.active];
    rooms.forEach((room, i) => {
      assert(arrivalStateFor(tower, room) === want[i], `room ${i}: ${hex(arrivalStateFor(tower, room))}`);
      const [g] = guestsOf(tower, room);
      g.state = HOTEL_STATE.seeking | 0x40;
      hotelArrival(tower, g, room.floor);
      assert(g.state === want[i], `guest ${i} landed in ${hex(g.state)}, wanted ${hex(want[i])}`);
      assert(g.anchorFloor === room.floor, 'and it is standing in its room');
    });
  },

  'check-in: a transfer stop is not the room — the guest keeps riding'() {
    // A carrier delivers at every stop of a sky-lobby transfer, not only the
    // last. "Arrived" has to mean "arrived where I was going".
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 5, floor: 20 });
    const [g] = guests;
    g.state = HOTEL_STATE.seeking | 0x40;
    hotelArrival(tower, g, 14);
    assert(g.state === (HOTEL_STATE.seeking | 0x40), 'the guest was let in at floor 14 instead of floor 20: ' + hex(g.state));
    assert(g.anchorFloor === 14, 'but it is standing on 14 now, so the next leg is routed from there');
    const ctx = stubCtx(2);
    hotelDispatch(tower, g, object, tower.clock, ctx);
    assert(ctx.calls[0].from === 14 && ctx.calls[0].to === 20, 'the next stride routes 14 → 20: ' + JSON.stringify(ctx.calls[0]));
  },

  // ---------------------------------------------------------------- checkout

  '⚠️ checkout pays exactly once, at the dispatch that is accepted — not before, not twice'() {
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 0 });
    const [g] = guests;
    object.unitStatus = 1;                    // one guest in residence
    g.state = HOTEL_STATE.checkout;
    g.anchorFloor = object.floor;
    const ctx = stubCtx(2);
    const out = hotelDispatch(tower, g, object, tower.clock, ctx);
    assert(out.paid && ctx.events.checkouts === 1, 'the accepted route paid the stay');
    assert(g.state === (HOTEL_STATE.checkout | 0x40), 'the guest is on its way down: ' + hex(g.state));
    // The 0x45 that follows is the same trip continuing; stepping it again would
    // check a twin out twice.
    hotelDispatch(tower, g, object, tower.clock, ctx);
    hotelDispatch(tower, g, object, tower.clock, ctx);
    assert(ctx.events.checkouts === 1, 'the continuation paid again: ' + ctx.events.checkouts);
  },

  '⚠️ a checkout that cannot route pays nothing, steps nothing, and tries again'() {
    // HOTEL.md: "the payout is tied to the checkout completion path, not a
    // purely logical end-of-day despawn". A guest the lifts cannot carry down is
    // a guest who has not left.
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 0 });
    const [g] = guests;
    object.unitStatus = 1;
    g.state = HOTEL_STATE.checkout;
    g.anchorFloor = object.floor;
    const ctx = stubCtx(-1);
    for (let i = 0; i < 5; i++) hotelDispatch(tower, g, object, tower.clock, ctx);
    assert(ctx.events.checkouts === 0 && object.unitStatus === 1, 'a failed route moved money or the count: ' + hex(object.unitStatus));
    assert(isHotelBooked(object) && g.state === HOTEL_STATE.checkout, 'the guest is still in the room and still trying');
    assert(ctx.calls.length === 5 && ctx.calls.every((c) => c.from === object.floor && c.to === 0), 'each attempt asks room → lobby');
  },

  'a twin pays once, for two people: the SECOND guest out is the one that reaches zero'() {
    const { tower, object, guests } = towerWithRoom('hotelTwin', { daypart: 0 });
    object.unitStatus = HOTEL_UNIT_STATUS.syncMarker;           // the overnight clamp
    const ctx = stubCtx(2);
    for (const g of guests) { g.state = HOTEL_STATE.ready; g.anchorFloor = object.floor; }

    hotelDispatch(tower, guests[0], object, tower.clock, ctx);   // 0x10 → rewrite to 2, state 0x05
    assert(object.unitStatus === 2, 'the sentinel is rewritten to the twin’s 2, got ' + hex(object.unitStatus));
    hotelDispatch(tower, guests[1], object, tower.clock, ctx);   // sees 2, must not rewrite
    assert(object.unitStatus === 2, 'the second guest rewrote the count: ' + hex(object.unitStatus));

    hotelDispatch(tower, guests[0], object, tower.clock, ctx);   // 2 → 1: no payout
    assert(ctx.events.checkouts === 0 && isHotelBooked(object), 'the first guest out paid for the room');
    hotelDispatch(tower, guests[1], object, tower.clock, ctx);   // 1 → 0: payout
    assert(ctx.events.checkouts === 1 && !isHotelBooked(object), 'the second guest out did not pay');
    assert(isHotelRoomDirty(object), 'and the room is dirty now');
  },

  'a single’s rewrite is 1, a twin’s and a suite’s are 2'() {
    for (const [what, want] of [['hotelSingle', 1], ['hotelTwin', 2], ['hotelSuite', 2]]) {
      const { tower, object, guests } = towerWithRoom(what, { daypart: 0 });
      object.unitStatus = HOTEL_UNIT_STATUS.syncMarker;
      guests[0].state = HOTEL_STATE.ready;
      hotelDispatch(tower, guests[0], object, tower.clock, stubCtx(2));
      assert(object.unitStatus === want, `${what}: ${object.unitStatus}, wanted ${want}`);
    }
  },

  'sync: the shortcut fires for a single only, and only inside the occupied band'() {
    // PEOPLE.md: "family 3 shortcut when unit_status & 7 == 1". A vacant room at
    // 0x19 satisfies `& 7 == 1` just as well — writing 0x10 there would book it.
    const single = towerWithRoom('hotelSingle', { daypart: 5 });
    single.object.unitStatus = 9;
    single.guests[0].state = HOTEL_STATE.sync;
    hotelDispatch(single.tower, single.guests[0], single.object, single.tower.clock, stubCtx(3));
    assert(single.object.unitStatus === 0x10 && single.guests[0].state === HOTEL_STATE.ready, 'a single at 9 syncs to 0x10');

    const vacant = towerWithRoom('hotelSingle', { daypart: 5 });
    vacant.object.unitStatus = 0x19;
    vacant.guests[0].state = HOTEL_STATE.sync;
    hotelDispatch(vacant.tower, vacant.guests[0], vacant.object, vacant.tower.clock, stubCtx(3));
    assert(vacant.object.unitStatus === 0x19 && !isHotelBooked(vacant.object), 'a vacant room was booked by the sync shortcut');

    const twin = towerWithRoom('hotelTwin', { daypart: 5 });
    twin.object.unitStatus = 9;
    twin.guests[0].state = HOTEL_STATE.sync;
    hotelDispatch(twin.tower, twin.guests[0], twin.object, twin.tower.clock, stubCtx(3));
    assert(twin.object.unitStatus === 9, 'a twin with ONE guest in must not be rewritten to a count of 2');
  },

  '⚠️ checkout leaves the room DIRTY: the turnover band, the latch cleared, a flag housekeeping reads'() {
    for (const [daypart, band] of [[0, 0x28], [3, 0x28], [4, 0x30], [6, 0x30]]) {
      const { tower, object } = towerWithRoom('hotelSuite', { daypart });
      object.unitStatus = 3; object.occupiedFlag = true; object.activationTickCount = 5;
      const ctx = stubCtx(3);
      assert(checkoutHotelRoom(tower, object, ctx) === true, 'a booked room checks out');
      assert(object.unitStatus === band, `daypart ${daypart}: ${hex(object.unitStatus)}, wanted ${hex(band)}`);
      assert(isHotelRoomDirty(object) && !isHotelBooked(object) && !isHotelVacant(object), 'dirty, and nothing else');
      assert(object.occupiedFlag === false && object.activationTickCount === 0, 'the latch and the counter are cleared');
      assert(ctx.events.checkouts === 1, 'one payment');
      assert(checkoutHotelRoom(tower, object, ctx) === false && ctx.events.checkouts === 1, 'and a second checkout is a no-op');
    }
  },

  // ------------------------------------------------------------ the evening trip

  'with no restaurant the evening trip is a real round trip to the lobby — and the destination is null-safe'() {
    // OFFICE.md § Route to Lobby Fails, applied to the hotel: with nothing to go
    // to the destination reads back as the lobby. Our floors are logical, so the
    // "no venue" value must not be -1 (B1).
    const { tower, object, guests } = towerWithRoom('hotelSingle', { daypart: 4, floor: 5 });
    const [g] = guests;
    object.unitStatus = 9; g.state = HOTEL_STATE.active; g.anchorFloor = 5;
    const ctx = stubCtx(2);
    hotelDispatch(tower, g, object, tower.clock, ctx);
    assert(object.unitStatus === 8, 'the leg starts with a DEC: ' + object.unitStatus);
    assert(g.venueObjectId === null && g.errandFloor === 0, 'no venue: the lobby, got venue ' + g.venueObjectId + ' floor ' + g.errandFloor);
    assert(ctx.calls[0].from === 5 && ctx.calls[0].to === 0, 'room → lobby: ' + JSON.stringify(ctx.calls[0]));
    // Landing at the lobby, then the next stride claims "nothing" and starts home.
    hotelArrival(tower, g, 0);
    assert(g.state === (HOTEL_STATE.active | 0x40) && g.anchorFloor === 0, 'still the errand until the next dispatch answers: ' + hex(g.state));
    hotelDispatch(tower, g, object, tower.clock, stubCtx(3));
    assert(g.state === HOTEL_STATE.returning, 'the lobby is where the outing ends: ' + hex(g.state));
    const home = stubCtx(2);
    hotelDispatch(tower, g, object, tower.clock, home);
    assert(home.calls[0].from === 0 && home.calls[0].to === 5, 'and the way back is lobby → room');
    hotelArrival(tower, g, 5);
    assert(g.state === HOTEL_STATE.sync && object.unitStatus === 9, 'home: INC, to the sync. Net zero, got ' + object.unitStatus);
  },

  'a restaurant is the destination when there is one — and it holds a slot until the minimum stay'() {
    const tower = bareTower({ daypart: 4 });
    const room = place(tower, 'hotelSingle', { floor: 5, left: 10 });
    const placed = placeCommercialVenue(tower, { family: FAMILY.restaurant, floor: 7, left: 40, right: 63 }, () => createSimTripRecord());
    assert(placed.ok, placed.reason);
    const restaurant = placed.object;
    const [g] = guestsOf(tower, room);
    room.unitStatus = 9; g.state = HOTEL_STATE.active; g.anchorFloor = 5;

    const ctx = stubCtx(3);                                   // the restaurant is on... another floor, but say we arrive
    hotelDispatch(tower, g, room, tower.clock, ctx);
    assert(g.venueObjectId === restaurant.id && ctx.calls[0].to === 7, 'the restaurant on F7 is the destination');
    assert(g.state === HOTEL_STATE.returning, 'the slot was claimed on arrival: ' + hex(g.state));
    assert(venueOf(restaurant).currentPopulation === 1, 'the venue counts the guest');

    // Too soon: the release is refused and the guest stays put.
    tower.clock.dayTick += 30;
    hotelDispatch(tower, g, room, tower.clock, stubCtx(2));
    assert(venueOf(restaurant).currentPopulation === 1 && g.state === HOTEL_STATE.returning, 'left before the 60-tick minimum stay');
    tower.clock.dayTick += 40;
    const back = stubCtx(2);
    hotelDispatch(tower, g, room, tower.clock, back);
    assert(venueOf(restaurant).currentPopulation === 0, 'the slot goes back before the route home is asked for');
    assert(back.calls[0].from === 7 && back.calls[0].to === 5, 'and the guest heads for its room: ' + JSON.stringify(back.calls[0]));
  },

  'a failed evening trip undoes its DEC; a failed return does not (the table writes no INC there)'() {
    const a = towerWithRoom('hotelSingle', { daypart: 4 });
    a.object.unitStatus = 9; a.guests[0].state = HOTEL_STATE.active;
    hotelDispatch(a.tower, a.guests[0], a.object, a.tower.clock, stubCtx(-1));
    assert(a.object.unitStatus === 9 && a.guests[0].state === HOTEL_STATE.sync, 'DEC then INC: net zero, to the sync: ' + a.object.unitStatus);

    const b = towerWithRoom('hotelSingle', { daypart: 4 });
    b.object.unitStatus = 8; b.guests[0].state = HOTEL_STATE.returning; b.guests[0].anchorFloor = 0;
    hotelDispatch(b.tower, b.guests[0], b.object, b.tower.clock, stubCtx(-1));
    assert(b.object.unitStatus === 8 && b.guests[0].state === HOTEL_STATE.sync, 'a failed return writes no INC (PEOPLE.md): ' + b.object.unitStatus);
  },

  // -------------------------------------------------------------- the night

  'the 2500 sweep: an occupied room is clamped to 0x10 and its guests go to checkout; an empty one waits'() {
    const tower = bareTower({ dayTick: 2500 });
    const booked = place(tower, 'hotelTwin', { left: 10 });
    const empty = place(tower, 'hotelTwin', { left: 30 });
    booked.unitStatus = 10;
    const [a, b] = guestsOf(tower, booked);
    a.state = HOTEL_STATE.sync; a.anchorFloor = 0; a.spawnFloor = 9;
    b.state = HOTEL_STATE.checkout | 0x40; b.anchorFloor = 3;               // in transit: skipped
    for (const g of guestsOf(tower, empty)) { g.state = HOTEL_STATE.seeking | 0x40; }
    const [c] = guestsOf(tower, empty); c.state = HOTEL_STATE.sync;

    hotelDailyReset(tower);
    assert(booked.unitStatus === 0x10, 'the occupied room is clamped to the sync sentinel: ' + hex(booked.unitStatus));
    assert(a.state === HOTEL_STATE.ready && a.anchorFloor === booked.floor && a.spawnFloor === null, 'its guest is checkout-ready, in its room');
    assert(b.state === (HOTEL_STATE.checkout | 0x40) && b.anchorFloor === 3, 'a guest in transit is left to finish its leg');
    assert(empty.unitStatus === HOTEL_UNIT_STATUS.vacantEarly || empty.unitStatus === HOTEL_UNIT_STATUS.vacantLate, 'a vacant room is untouched');
    assert(c.state === HOTEL_STATE.seeking, 'a guest of an empty room goes back to waiting to check in');
    assert(HOTEL_RESET_TICK === 2500, 'the checkpoint is 2500');
  },

  'the 2500 sweep gives back a venue slot it finds a guest holding'() {
    const tower = bareTower({ dayTick: 2500 });
    const room = place(tower, 'hotelSingle', { floor: 5 });
    const placed = placeCommercialVenue(tower, { family: FAMILY.restaurant, floor: 7, left: 40, right: 63 }, () => createSimTripRecord());
    const venue = placed.object;
    const [g] = guestsOf(tower, room);
    room.unitStatus = 9;
    g.state = HOTEL_STATE.returning; g.venueObjectId = venue.id; g.venueEnteredTick = 2400;
    venueOf(venue).currentPopulation = 1;
    hotelDailyReset(tower);
    assert(venueOf(venue).currentPopulation === 0, 'the diner who was still inside is not inside any more');
    assert(g.venueEnteredTick === null && g.venueObjectId === null, 'and the guest forgets it');
  },

  // ------------------------------------------------------------ the evaluation

  'the score is the average over 1 / 2 / 2 guests — a suite over TWO, not three'() {
    for (const [what, n] of [['hotelSingle', 1], ['hotelTwin', 2], ['hotelSuite', 2]]) {
      const { tower, object, guests } = towerWithRoom(what);
      stress(guests, 120);
      assert(guests.length === n, `${what} has ${guests.length} guests`);
      assert(hotelScore(tower, object, guests) === 120, `${what}: ${hotelScore(tower, object, guests)}, wanted 120`);
    }
    const { tower, object, guests } = towerWithRoom('hotelSuite');
    stress(guests, 150);
    assert(hotelScore(tower, object, guests) === 150, 'three guests’ worth of divisor would have given 100');
    assert((() => { try { hotelScore(tower, object, guests.slice(0, 1)); return false; } catch { return true; } })(),
      'scoring a suite with a missing guest is refused, not scored as calm');
  },

  'the pricing tiers: +30, 0, -30, and tier 3 forces zero — then noise is added on top'() {
    const mk = (tier, avg) => {
      const f = towerWithRoom('hotelTwin', { rentLevel: tier });
      stress(f.guests, avg);
      return hotelScore(f.tower, f.object, f.guests);
    };
    assert(mk(0, 100) === 130 && mk(1, 100) === 100 && mk(2, 100) === 70, 'tiers 0/1/2: ' + [mk(0, 100), mk(1, 100), mk(2, 100)]);
    assert(mk(2, 10) === 0, 'clamped at zero, never negative: ' + mk(2, 10));
    assert(mk(3, 300) === 0, 'tier 3 always passes, however bad the stress');
    // The reference's order: tier first, then noise. A tier-3 room beside an
    // office is pushed back up to 60.
    const f = towerWithRoom('hotelTwin', { rentLevel: 3, left: 10 });
    stress(f.guests, 300);
    place(f.tower, 'hotelSingle', { left: 40 });                                    // a hotel: not noise
    assert(hotelScore(f.tower, f.object, f.guests) === 0, 'a hotel neighbour is silent');
    placeObject(f.tower, { family: FAMILY.office, floor: 3, left: 33, right: 38 }, () => createSimTripRecord());
    assert(hotelScore(f.tower, f.object, f.guests) === 60, 'an office within 20 tiles adds 60 even to tier 3');
  },

  '⚠️ noise: 20 tiles, same floor, office / restaurant / retail / fast food — and not hotels, not condos'() {
    assert(HOTEL_NOISE_RADIUS === 20, 'radius');
    // `FACILITIES.md` § Noise Source Matching, hotel row: "restaurant, office, retail,
    // fast food, entertainment" - the last joined with issue #11 (both venues).
    const sources = [FAMILY.office, FAMILY.restaurant, FAMILY.retail, FAMILY.fastFood, FAMILY.theater, FAMILY.partyHall];
    assert([...HOTEL_NOISE_FAMILIES].sort().join() === [...sources].sort().join(), 'the source set is exactly the spec row');

    // The room spans 10..13 (a single). The distance is edge to edge, the way
    // `noiseSourceWithin` measures it for every family: a source starting at
    // tile 33 is 20 tiles from the room's last tile, 34 is 21.
    for (const family of sources) {
      const near = bareTower(); const roomA = place(near, 'hotelSingle', { left: 10 });
      placeObject(near, { family, floor: 3, left: 33, right: 40 }, () => createSimTripRecord());
      assert(hotelNoiseNear(near, roomA), `a ${family} 20 tiles away is noise`);
      const far = bareTower(); const roomB = place(far, 'hotelSingle', { left: 10 });
      placeObject(far, { family, floor: 3, left: 34, right: 41 }, () => createSimTripRecord());
      assert(!hotelNoiseNear(far, roomB), `a ${family} 21 tiles away is quiet`);
      const other = bareTower(); const roomC = place(other, 'hotelSingle', { left: 10 });
      placeObject(other, { family, floor: 4, left: 14, right: 20 }, () => createSimTripRecord());
      assert(!hotelNoiseNear(other, roomC), `a ${family} on another floor is quiet — noise is local`);
      // And it works from the left too: the source's last tile is 40, the room's
      // first is 60.
      const left = bareTower(); const roomD = place(left, 'hotelSingle', { left: 60 });
      placeObject(left, { family, floor: 3, left: 20, right: 40 }, () => createSimTripRecord());
      assert(hotelNoiseNear(left, roomD), `a ${family} 20 tiles to the LEFT is noise`);
      const leftFar = bareTower(); const roomE = place(leftFar, 'hotelSingle', { left: 62 });
      placeObject(leftFar, { family, floor: 3, left: 20, right: 40 }, () => createSimTripRecord());
      assert(!hotelNoiseNear(leftFar, roomE), `a ${family} 22 tiles to the LEFT is quiet`);
    }

    for (const family of [FAMILY.hotelSingle, FAMILY.hotelTwin, FAMILY.hotelSuite, FAMILY.condo, FAMILY.lobby]) {
      const t = bareTower(); const room = place(t, 'hotelSingle', { left: 10 });
      placeObject(t, { family, floor: 3, left: 14, right: 20 }, () => createSimTripRecord());
      assert(!hotelNoiseNear(t, room), `FACILITIES.md: a ${family} beside a hotel is not noise`);
    }
  },

  'the noise rule is asymmetric: a hotel is noise to a condo and NOT to an office'() {
    // FACILITIES.md § Noise Source Matching: "condo (9) | hotel rooms (3/4/5), ...";
    // "Offices do not count hotels or other offices as noise."
    for (const what of ROOMS) {
      assert(CONDO_NOISE_FAMILIES.has(FAMILY[what]), `a condo counts a ${what} as noise`);
      const t = bareTower();
      const condo = placeObject(t, { family: FAMILY.condo, floor: 3, left: 10, right: 25 }, () => createSimTripRecord()).object;
      place(t, what, { left: 50 });                                              // 24 tiles: inside the condo's 30
      assert(condoNoiseNear(t, condo), `a ${what} 24 tiles from a condo is noise to it`);
      const o = bareTower();
      const office = placeObject(o, { family: FAMILY.office, floor: 3, left: 10, right: 15 }, () => createSimTripRecord()).object;
      place(o, what, { left: 18 });
      assert(!noiseSourceNear(o, office), `a ${what} beside an office is not noise to it`);
    }
  },

  'thresholds: 80 / 150, widening to 200 from four stars'() {
    const f = towerWithRoom('hotelSingle');
    stress(f.guests, 149);
    recomputeHotelOperationalStatus(f.tower, f.object, f.guests);
    assert(f.object.evalLevel === 1, '149 is acceptable at 3 stars, got ' + f.object.evalLevel);
    stress(f.guests, 151);
    recomputeHotelOperationalStatus(f.tower, f.object, f.guests);
    assert(f.object.evalLevel === 0, '151 is poor at 1 star, got ' + f.object.evalLevel);
    f.tower.starCount = 4;
    recomputeHotelOperationalStatus(f.tower, f.object, f.guests);
    assert(f.object.evalLevel === 1, 'but acceptable at 4 stars, where the bar is 200, got ' + f.object.evalLevel);
    stress(f.guests, 79);
    recomputeHotelOperationalStatus(f.tower, f.object, f.guests);
    assert(f.object.evalLevel === 2, '79 is excellent');
  },

  'a brand-new room scores perfectly and latches itself — the bootstrap that lets the first guest try'() {
    const { tower, object, guests } = towerWithRoom('hotelSingle');
    assert(object.occupiedFlag === false, 'unlatched at placement');
    recomputeHotelOperationalStatus(tower, object, guests);
    assert(object.evalLevel === 2 && object.occupiedFlag === true, 'no trips scores 0, the best grade, and sets the latch');
  },

  '⚠️ a dirty room does NOT re-latch itself — the guard that keeps it shut until it is cleaned'() {
    // FACILITIES.md § occupied_flag: "For hotel rooms ... guarded by
    // unit_status <= 0x27 — hotels past that lifecycle phase do not set it even
    // if their score is nonzero." Without this a checked-out room has taken no
    // trips since the counters were wiped, scores a perfect 0, and re-lets
    // tonight with nobody having cleaned it.
    for (const dirty of [0x28, 0x30, 0x37]) {
      const { tower, object, guests } = towerWithRoom('hotelSingle');
      object.unitStatus = dirty; object.occupiedFlag = false;
      recomputeHotelOperationalStatus(tower, object, guests);
      assert(object.evalLevel === 2, 'a dirty room is still scored (' + hex(dirty) + ')');
      assert(object.occupiedFlag === false, 'but it re-latched itself at ' + hex(dirty));
    }
    const { tower, object, guests } = towerWithRoom('hotelSingle');
    object.unitStatus = 0x27;
    recomputeHotelOperationalStatus(tower, object, guests);
    assert(object.occupiedFlag === true, '0x27 is the last vacant value and does latch');
  },

  'an infested room is not scored at all (0xffff)'() {
    const { tower, object, guests } = towerWithRoom('hotelSingle');
    object.unitStatus = 0x38; object.evalLevel = 2;
    recomputeHotelOperationalStatus(tower, object, guests);
    assert(object.evalLevel === EVAL_UNSET, 'got ' + object.evalLevel);
  },

  'the daily refresh: measured, carried by a good neighbour, or closed'() {
    // Branch A — a graded room is latched and its counters cleared.
    const a = towerWithRoom('hotelTwin');
    stress(a.guests, 100);
    a.object.evalLevel = 1; a.object.occupiedFlag = false;
    assert(refreshHotelOccupiedFlag(a.tower, a.object, a.guests) === 'measured', 'branch A');
    assert(a.object.occupiedFlag === true && a.guests.every((g) => g.tripCount === 0), 'latched, and the next 24 hours are measured fresh');

    // Branch C — a failing room with no donor is closed: no guest tonight, and
    // the history that failed it is kept.
    const c = towerWithRoom('hotelTwin');
    stress(c.guests, 300);
    c.object.evalLevel = 0; c.object.occupiedFlag = true;
    assert(refreshHotelOccupiedFlag(c.tower, c.object, c.guests) === 'closed', 'branch C');
    assert(c.object.occupiedFlag === false && c.guests.every((g) => g.tripCount === 4), 'closed, with the evidence kept');

    // Branch B — beside an A-rated room of the same family on the same floor,
    // both are pulled to 1 and latched.
    const tower = bareTower();
    const bad = place(tower, 'hotelTwin', { left: 10 });
    const good = place(tower, 'hotelTwin', { left: 30 });
    const elsewhere = place(tower, 'hotelTwin', { floor: 4, left: 10 });
    const otherKind = place(tower, 'hotelSuite', { left: 50 });
    stress(guestsOf(tower, bad), 300);
    bad.evalLevel = 0; bad.occupiedFlag = true;
    good.evalLevel = 2; elsewhere.evalLevel = 2; otherKind.evalLevel = 2;
    assert(refreshHotelOccupiedFlag(tower, bad, guestsOf(tower, bad)) === 'carried', 'branch B');
    assert(bad.evalLevel === 1 && good.evalLevel === 1 && bad.occupiedFlag && good.occupiedFlag, 'both pulled to 1');
    assert(elsewhere.evalLevel === 2 && otherKind.evalLevel === 2, 'a donor must share the floor AND the family');
  },

  'the 1600 sweep scores every room, refreshes the clean ones, and leaves the dirty ones shut'() {
    const tower = bareTower({ dayTick: 1600 });
    const fresh = place(tower, 'hotelSingle', { left: 10 });
    const dirty = place(tower, 'hotelSingle', { left: 20 });
    const infested = place(tower, 'hotelSingle', { left: 30 });
    dirty.unitStatus = 0x28; infested.unitStatus = 0x38;
    stress(guestsOf(tower, dirty), 300);
    const report = hotelMiddaySweep(tower);
    assert(fresh.occupiedFlag === true && fresh.evalLevel === 2, 'the new room is open for tonight');
    assert(dirty.occupiedFlag === false, 'the dirty room stayed shut');
    assert(guestsOf(tower, dirty).every((g) => g.tripCount === 4), 'and its counters were not cleared (pass 2 skips it)');
    assert(infested.evalLevel === EVAL_UNSET, 'the infested room is unscored');
    assert(report.scored === 1, 'one room was refreshed: ' + JSON.stringify(report));
    assert(HOTEL_SWEEP_TICK === 1600, 'the checkpoint is 1600');
  },

  // ------------------------------------------------------------------- money

  'the hooks: check-in adds people, checkout banks the stay and takes them out — no double bank'() {
    const world = seedDemoWorld({ seed: 1 });
    const { tower } = world;
    const ledger = ledgerFor(tower);
    const hooks = hotelCashflowHooks(tower);
    for (const [what, tier] of [['hotelSingle', 1], ['hotelTwin', 0], ['hotelSuite', 3], ['hotelSuite', 1]]) {
      const object = { family: FAMILY[what], rentLevel: tier };
      const cash = tower.cash;
      hooks.onCheckIn(tower, object);
      assert(tower.cash === cash, 'a check-in moves no money');
      assert(ledger.population[what] === POPULATION_BY_FAMILY[what], `${what}: population ${ledger.population[what]}`);
      hooks.onCheckout(tower, object);
      assert(tower.cash - cash === RENT_TIERS[what][tier], `${what} tier ${tier}: cash moved ${tower.cash - cash}`);
      assert(ledger.income[what] >= RENT_TIERS[what][tier] && ledger.population[what] === 0, 'income recorded, people out');
    }
    // A checkout with nobody counted in must not push the bucket below zero.
    hooks.onCheckout(tower, { family: FAMILY.hotelTwin, rentLevel: 1 });
    assert(ledger.population.hotelTwin === 0, 'a population bucket went negative: ' + ledger.population.hotelTwin);
  },

  'the newspaper trigger: every 2nd checkout below 20, every 8th after; the count resets at 1200'() {
    const tower = bareTower();
    const triggers = [];
    for (let n = 1; n <= 40; n++) triggers.push(recordHotelSale(tower));
    const on = triggers.map((t, i) => (t ? i + 1 : null)).filter(Boolean);
    assert(on.join() === '2,4,6,8,10,12,14,16,18,24,32,40', 'triggers fired on checkouts ' + on.join());
    assert(tower.hotelSaleCount === 40, 'cumulative within the day');
    assert(HOTEL_SALE_RESET_TICK === 1200, 'the checkpoint is 1200');
    hotelSaleCountReset(tower);
    assert(tower.hotelSaleCount === 0, 'checkpoint 1200 resets the count');
  },

  // ------------------------------------------------------------ what you see

  'a booked room is not "let" in the lease sense, but the renderer must still call it occupied'() {
    const { object } = towerWithRoom('hotelTwin');
    object.occupiedFlag = true; object.unitStatus = 0x18;
    assert(!officeIsLet(object), 'an empty, ready room (latch SET) is not occupied');
    object.occupiedFlag = false; object.unitStatus = 0x10;
    assert(officeIsLet(object), 'a booked room with its latch cleared by the daily refresh is still occupied');
    assert(objectStatusTag(object) === '', 'a booked room says nothing');
    object.unitStatus = 0x28;
    assert(objectStatusTag(object) === 'DIRTY', 'a checked-out room says DIRTY');
    object.unitStatus = 0x20;
    assert(objectStatusTag(object) === '', 'a vacant one says nothing — a hotel is never FOR RENT');
  },

  'the art: vacant draws the empty shell, booked draws the hotel, a bad review draws poor-review'() {
    const { object } = towerWithRoom('hotelSuite');
    const sprite = (opts) => { const s = objectSprite(object, opts); return s.name + '/' + s.animation; };
    object.unitStatus = 0x20;
    assert(sprite({}) === 'room-empty/hotel', 'vacant: ' + sprite({}));
    object.unitStatus = 0x28;
    assert(sprite({}) === 'room-empty/hotel', 'dirty: ' + sprite({}));
    object.unitStatus = 0x10;
    assert(sprite({ night: false }) === 'hotel/booked-day', 'booked, day: ' + sprite({}));
    assert(sprite({ night: true }) === 'hotel/booked-night', 'booked, night');
    assert(sprite({ stressed: true }) === 'hotel/poor-review', 'a furious guest');
  },

  // -------------------------------------------------------------- demolition

  'a guest in residence cannot be evicted; a vacant, dirty or infested room can be demolished'() {
    const { world, tower, built } = hotelWorld({ rooms: [['hotelSingle', 2, 10]] });
    const [room] = built;
    room.unitStatus = 5;
    assert(hasTenant(room), 'a booked room has a tenant');
    const refused = applyAction(world, { type: 'demolish', objectId: room.id });
    assert(!refused.ok && /you cannot evict a tenant/.test(refused.reason), 'refused: ' + JSON.stringify(refused));
    for (const free of [0x18, 0x28, 0x38]) {
      room.unitStatus = free;
      assert(!hasTenant(room), `${hex(free)} has no tenant`);
    }
    const r = applyAction(world, { type: 'demolish', objectId: room.id });
    assert(r.ok && !tower.objects.has(room.id) && guestsOfWorld(tower, room).length === 0, 'demolished, with its guests');
  },

  // ------------------------------------------------------------- the save

  'a tower with hotels survives a save and plays on identically'() {
    assert(SAVE_VERSION >= 2, 'the save shape changed, so the version moved');
    const { world, driver } = hotelWorld({ rooms: SIX_ROOMS });
    run(world, driver, 1667 + 250);                            // day 0, 1850: the first evening, guests booked and some mid-trip
    assert(hotelRooms(world.tower).some(({ object }) => isHotelBooked(object)), 'fixture: somebody is booked');

    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    const back = restore(blob);
    assert(back.ok, 'restore refused: ' + back.reason);
    const twin = back.world;
    const twinDriver = makeDriver(twin);
    rebuildRouteTables(twin.tower);

    const fingerprint = (w) => JSON.stringify({
      cash: w.tower.cash,
      day: [w.tower.clock.dayCounter, w.tower.clock.dayTick],
      sales: [w.tower.hotelSaleCount, w.tower.newspaperTrigger],
      rooms: hotelRooms(w.tower).map(({ object, occupants }) => [object.id, object.unitStatus, object.occupiedFlag, object.evalLevel, occupants.map((a) => [a.state, a.anchorFloor, a.tripCount])]),
    });
    assert(fingerprint(world) === fingerprint(twin), 'the restored tower differs from the saved one');
    run(world, driver, 2600);
    run(twin, twinDriver, 2600);
    assert(fingerprint(world) === fingerprint(twin), 'the restored tower plays a different day from the original');
    const earned = ['hotelSingle', 'hotelTwin', 'hotelSuite'].reduce((n, k) => n + world.tower.incomeLedger[k], 0);
    assert(earned > 0, 'and the day it played had checkouts in it, so the comparison means something');
  },

  'the save list does not count hotel rooms as leases'() {
    const { world } = hotelWorld({ rooms: [['hotelSingle', 2, 10], ['hotelTwin', 2, 16]] });
    const s = summarise(world);
    assert(s.leasable === 0 && s.let === 0, 'a hotel is booked by the night: ' + JSON.stringify(s));
  },

  // ------------------------------------------------------- the composition

  '⚠️ THE EVENING RHYTHM: guests check in after 1600, check out in the morning, and the stay is paid to tower.cash AT CHECKOUT'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: SIX_ROOMS });
    const guestCount = built.reduce((n, o) => n + GUESTS[NAME_OF[o.family]], 0);
    assert(guestCount === 10, 'fixture: ten guests (1 + 2 + 2, on two floors)');

    const checkIns = [], checkOuts = [];
    const booked = new Map(built.map((o) => [o.id, false]));
    const log = [];
    const nightly = [];
    const watch = (dayTick, dayCounter) => {
      // The wiring of two checkpoints, observed from the outside: the tick AFTER
      // 2500 every occupied room must have been clamped to the sync sentinel
      // (TIME.md § 2500), and the tick after 1200 the day's sale count is zero.
      if (dayTick === 2501 && dayCounter === 1) nightly.push(...built.filter(isHotelBooked).map((o) => o.unitStatus));
      if (dayTick === 1201 && dayCounter === 1) nightly.push('count:' + tower.hotelSaleCount);
      for (const o of built) {
        const now = isHotelBooked(o);
        if (now && !booked.get(o.id)) checkIns.push({ room: o.id, dayTick, dayCounter });
        if (!now && booked.get(o.id)) checkOuts.push({ room: o.id, dayTick, dayCounter, dirty: isHotelRoomDirty(o) });
        booked.set(o.id, now);
      }
      log.push(tower.cash);
    };

    // Two full days from the new-game position (tick 2533, night).
    const cashAtStart = tower.cash;
    let cashBefore = tower.cash;
    const perCheckout = [];
    for (let i = 0; i < 2 * 2600 + 100; i++) {
      cashBefore = tower.cash;
      const salesBefore = tower.hotelSaleCount;
      driver.scheduler.tick(tower);
      watch(tower.clock.dayTick, tower.clock.dayCounter);
      if (tower.hotelSaleCount > salesBefore) perCheckout.push(tower.cash - cashBefore);
    }

    assert(checkIns.length === built.length, `${checkIns.length} of ${built.length} rooms were booked`);
    for (const c of checkIns) {
      assert(c.dayTick >= 1600 && c.dayTick < 2400, `a guest checked in at tick ${c.dayTick}, outside the evening window`);
    }
    assert(checkOuts.length === built.length, `${checkOuts.length} of ${built.length} rooms were checked out of`);
    for (const c of checkOuts) {
      assert(c.dayTick < 1600, `a guest checked out at tick ${c.dayTick}, which is not the morning`);
      assert(c.dirty, 'a room that was checked out of is not dirty');
    }
    const clamped = nightly.filter((n) => typeof n === 'number');
    assert(clamped.length === built.length && clamped.every((n) => n === HOTEL_UNIT_STATUS.syncMarker),
      'after the 2500 sweep every booked room should read 0x10, got ' + clamped.map(hex).join(' '));
    assert(nightly.includes('count:0'), 'the 1200 checkpoint did not reset the sale count: ' + nightly.filter((n) => typeof n === 'string'));
    // Every check-out comes after its own check-in, by a night.
    for (const out of checkOuts) {
      const inn = checkIns.find((c) => c.room === out.room);
      assert(out.dayCounter > inn.dayCounter || out.dayTick < inn.dayTick, 'a room checked out before it checked in');
    }

    // The money: one payment per room, at the checkout, exactly the family row.
    assert(perCheckout.length === built.length, 'one payment per stay, got ' + perCheckout.length);
    const expectedTotal = built.reduce((n, o) => n + payoutOf(o), 0);
    assert(expectedTotal === 2 * 2000 + 2 * 3000 + 2 * 6000, 'fixture: the arithmetic of the expected total');
    assert(perCheckout.reduce((a, b) => a + b, 0) === expectedTotal, `checkouts paid ${perCheckout.join('+')}, wanted ${expectedTotal}`);
    assert([...perCheckout].sort((a, b) => a - b).join() === built.map(payoutOf).sort((a, b) => a - b).join(),
      'each checkout paid its own room’s row: ' + perCheckout.join());
    const spentOnLift = 0;                       // the cashflow day and its upkeep fall outside these two days
    assert(tower.cash - cashAtStart === expectedTotal - spentOnLift || tower.cash - cashAtStart === expectedTotal - 10_000,
      'tower.cash moved by ' + (tower.cash - cashAtStart) + ' over two days; wanted the stays (and at most one lift charge)');
    assert(ledgerFor(tower).cash === tower.cash, 'one balance');
  },

  '⚠️ checkpoint 2500 runs BOTH families’ sweeps: the condo’s was not replaced by the hotel’s'() {
    // `extraCheckpoints` holds one body per tick. Wiring the hotel row in as a
    // second key would silently replace the condo's, and condos would run
    // yesterday's errands for ever.
    const world = seedDemoWorld({ seed: 1 });
    const { tower } = world;
    tower.starCount = 3;
    const condo = applyAction(world, { type: 'build', what: 'condo', floor: 3, left: 20 }).object;
    const room = applyAction(world, { type: 'build', what: 'hotelSingle', floor: 9, left: 20 }).object;
    const driver = makeDriver(world);
    condo.unitStatus = 5; room.unitStatus = 5;
    tower.clock.dayTick = 2498;
    for (let i = 0; i < 3; i++) driver.scheduler.tick(tower);
    assert(tower.clock.dayTick === 2501, 'fixture: the clock is just past 2500');
    assert(room.unitStatus === 0x10, 'the hotel was not clamped: ' + hex(room.unitStatus));
    assert(condo.unitStatus === 0x10, 'the condo was not clamped: ' + hex(condo.unitStatus));
  },

  'no money moves at check-in and population tracks who is actually in a bed'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: SIX_ROOMS });
    const rooms = new Set(built.map((o) => o.id));
    let peak = 0;
    run(world, driver, 67 + 2300, (dayTick) => {     // from the new-game position to day 0, tick 2300
      // Population is exactly the sum of the occupied rooms' guests.
      const want = built.filter(isHotelBooked).reduce((n, o) => n + GUESTS[NAME_OF[o.family]], 0);
      if (population(tower) !== want) throw new Error(`tick ${dayTick}: population ${population(tower)} but ${want} guests are in bed`);
      const ledgerSum = ['hotelSingle', 'hotelTwin', 'hotelSuite'].reduce((n, k) => n + tower.populationLedger[k], 0);
      if (ledgerSum !== want) throw new Error(`tick ${dayTick}: the population LEDGER says ${ledgerSum} but ${want} are in bed`);
      peak = Math.max(peak, want);
    });
    assert(rooms.size === 6 && peak === 10, 'everyone was in bed at the peak: ' + peak);
    assert(tower.incomeLedger.hotelSingle === 0 && tower.incomeLedger.hotelTwin === 0 && tower.incomeLedger.hotelSuite === 0,
      'the night before anyone has left, no hotel has earned a cent');
  },

  '⚠️ a hotel the lifts cannot reach NEVER FILLS — and a hotel on a served floor beside it does'() {
    const { world, tower, built, driver } = hotelWorld({
      rooms: [['hotelSingle', 4, 10], ['hotelSingle', 12, 10], ['hotelTwin', 12, 20]], top: 6,
    });
    const [served, strandedA, strandedB] = built;
    const everBooked = new Map(built.map((o) => [o.id, false]));
    let guestRides = 0;
    run(world, driver, 3 * 2600, () => {
      for (const o of built) if (isHotelBooked(o)) everBooked.set(o.id, true);
      for (const a of tower.actors) if (a.objectId === strandedA.id || a.objectId === strandedB.id) {
        if (a.waitingFloor != null || (a.state >= 0x40 && a.route)) guestRides++;
      }
    });
    assert(everBooked.get(served.id), 'the control room on a served floor filled — otherwise this proves nothing');
    assert(!everBooked.get(strandedA.id) && !everBooked.get(strandedB.id), 'a room above the top of the lift was booked');
    assert(strandedA.unitStatus >= 0x18 && strandedB.unitStatus >= 0x18, 'still in the vacant band');
    assert(guestRides === 0, 'nobody queued for a lift that could not take them');
    const stuck = tower.actors.filter((a) => a.objectId === strandedA.id || a.objectId === strandedB.id);
    assert(stuck.every((a) => a.tripCount > 0 && a.state === HOTEL_STATE.seeking), 'they tried, and failed, and are still waiting at the lobby');
    assert(tower.incomeLedger.hotelTwin === 0, 'and the twin up there earned nothing');
    assert(population(tower) <= 1 && tower.cash > 0, 'sanity');
    // The daily refresh then closes a room that keeps failing: no new attempts.
    assert(strandedA.evalLevel === 0 || strandedA.occupiedFlag === false || strandedA.evalLevel === 1,
      'the sweep graded the failing room');
  },

  '⚠️ guests can walk: a hotel one flight of stairs up fills and pays, one a flight further does not'() {
    // The stairs route is multi-leg and the router accepts the FIRST leg of a
    // journey toward a floor it cannot finish. Booked on acceptance, the F2 rooms
    // here would fill with nobody and never pay; booked on arrival they stay empty.
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    tower.starCount = 3;
    const rooms = [[1, 60], [1, 64], [2, 60], [2, 64]].map(([floor, left]) => {
      const r = applyAction(world, { type: 'build', what: 'hotelSingle', floor, left });
      assert(r.ok, r.reason);
      return r.object;
    });
    const stairs = applyAction(world, { type: 'build_link', kind: 'stairs', floor: 0, left: 60 });
    assert(stairs.ok, 'the stairs would not build: ' + stairs.reason);
    rebuildRouteTables(tower);
    const driver = makeDriver(world);
    const cash = tower.cash;
    const booked = new Set();
    run(world, driver, 2 * 2600, () => { for (const o of rooms) if (isHotelBooked(o)) booked.add(o.id); });
    const [f1a, f1b, f2a, f2b] = rooms;
    assert(booked.has(f1a.id) && booked.has(f1b.id), 'the guests did not walk up one flight');
    assert(!booked.has(f2a.id) && !booked.has(f2b.id), 'a room a flight beyond the stairs was booked');
    assert(tower.cash - cash === 2 * RENT_TIERS.hotelSingle[1], 'the two rooms that filled paid: ' + (tower.cash - cash));
    assert(population(tower) === 0, 'and nobody is left on the books');
  },

  '⚠️ a guest the lifts cannot carry down does not pay — and pays the moment they can'() {
    const { world, tower, built, driver } = hotelWorld({ rooms: SIX_ROOMS });
    const lift = tower.carriers.slice();
    // Day 0's evening: everyone checks in. Then, at 2400, the lift goes.
    while (!(tower.clock.dayCounter >= 1 && tower.clock.dayTick >= 2400 && tower.clock.dayTick < 2500)) {
      driver.scheduler.tick(tower);
    }
    assert(built.every(isHotelBooked), 'fixture: everyone is in bed');
    const cash = tower.cash;

    tower.carriers = []; tower.routeTablesDirty = true; rebuildRouteTables(tower);
    // Through the whole next morning and early afternoon: nobody can leave.
    while (!(tower.clock.dayTick >= 1400 && tower.clock.dayTick < 1500)) driver.scheduler.tick(tower);
    assert(tower.cash === cash, 'cash moved while nobody could leave: ' + (tower.cash - cash));
    assert(tower.hotelSaleCount === 0, 'a checkout was counted for a guest who is still upstairs');
    assert(built.every(isHotelBooked), 'every guest is still in bed — a stay that cannot end has not been paid for');
    assert(built.every((o) => !isHotelRoomDirty(o)), 'and no room is dirty');

    // The lift comes back; the guests are still trying. They pay on the way out.
    tower.carriers = lift; tower.routeTablesDirty = true; rebuildRouteTables(tower);
    const before = tower.cash;
    for (let i = 0; i < 160 && tower.hotelSaleCount < built.length; i++) driver.scheduler.tick(tower);
    assert(tower.hotelSaleCount === built.length, 'only ' + tower.hotelSaleCount + ' of ' + built.length + ' rooms checked out after the lift came back');
    const expected = built.reduce((n, o) => n + payoutOf(o), 0);
    assert(tower.cash - before === expected, `the stays paid ${tower.cash - before}, wanted ${expected}`);
  },

  '⚠️ housekeeping CLEANS: with a housekeeping facility every room takes a guest every night — weekdays AND the weekend'() {
    // Issue #8 left a contract here: checkout leaves the turnover band, writing the
    // room back to the vacant band is all it takes, and the 1600 sweep re-latches
    // it. This used to play housekeeper from outside the sim; now the sim does it.
    // Six rooms on two floors, one housekeeping facility on F1 and a service
    // elevator to carry the staff up — and nothing in this test writes a room's
    // band. Days 0 and 1 are weekdays and day 2 is the weekend (calendarPhase).
    const { world, tower, built, driver } = hotelWorld({ rooms: SIX_ROOMS, housekeeping: 1 });
    const stays = new Map();                                  // day counter -> check-ins that evening
    const wasBooked = new Map(built.map((o) => [o.id, false]));
    const wasDirty = new Map(built.map((o) => [o.id, false]));
    const dayTypes = new Map();
    let cleaned = 0;

    run(world, driver, 4 * 2600, (dayTick, dayCounter) => {
      for (const o of built) {
        const now = isHotelBooked(o);
        if (now && !wasBooked.get(o.id)) {
          stays.set(dayCounter, (stays.get(dayCounter) ?? 0) + 1);
          dayTypes.set(dayCounter, tower.clock.calendarPhase ? 'weekend' : 'weekday');
        }
        wasBooked.set(o.id, now);
        const dirty = isHotelRoomDirty(o);
        if (wasDirty.get(o.id) && !dirty && !isHotelInfested(o)) cleaned++;
        wasDirty.set(o.id, dirty);
      }
    });

    const nights = [...stays.keys()].sort((a, b) => a - b);
    assert(nights.length >= 3, 'only ' + nights.length + ' evenings had a check-in: ' + JSON.stringify([...stays]));
    for (const night of nights.slice(0, 3)) {
      assert(stays.get(night) === built.length, `day ${night} (${dayTypes.get(night)}): ${stays.get(night)} of ${built.length} rooms were booked`);
    }
    assert([...dayTypes.values()].includes('weekend') && [...dayTypes.values()].includes('weekday'),
      'the run covered both day types: ' + [...dayTypes.entries()].join(' '));
    assert(cleaned >= built.length * 2, 'the staff cleaned ' + cleaned + ' rooms');
    assert(built.every((o) => !isHotelInfested(o)), 'and nothing was infested');
  },

  '⚠️ WITHOUT housekeeping a room earns one stay, goes dirty, and three passes later is INFESTED — for good'() {
    // The reference's rule (FACILITIES.md § occupied_flag: the latch is not set
    // again above 0x27) and HOTEL.md § Cockroach Infestation. Day 0 is the night
    // before anyone has left; the checkout is the morning of day 1, so the three
    // 1600 passes that give a strike fall on days 1, 2 and 3.
    const { world, tower, built, driver } = hotelWorld({ rooms: SIX_ROOMS });
    let checkIns = 0;
    const was = new Map(built.map((o) => [o.id, false]));
    const at = {};
    run(world, driver, 7 * 2600, (dayTick, dayCounter) => {
      for (const o of built) {
        const now = isHotelBooked(o);
        if (now && !was.get(o.id)) checkIns++;
        was.set(o.id, now);
      }
      if (dayTick === 1500) {
        at[dayCounter] = built.filter(isHotelRoomDirty).length + '/' + built.filter(isHotelInfested).length;
      }
    });
    assert(checkIns === built.length, `${checkIns} check-ins over seven nights, wanted exactly one per room (${built.length})`);
    assert(at[1] === `${built.length}/0` && at[2] === `${built.length}/0` && at[3] === `${built.length}/0`,
      'dirty/infested at tick 1500 on days 1..3 (before each pass): ' + JSON.stringify(at));
    assert(at[4] === `0/${built.length}` && at[6] === `0/${built.length}`,
      'infested after the third pass, and for ever: ' + JSON.stringify(at));
    assert(built.every(isHotelInfested), 'every room is infested');
    assert(built.every((o) => o.occupiedFlag === false), 'and shut');
  },

  'one tower, three stars, seeded offices beside the rooms: the noise rule bites the hotel, not the office'() {
    // The seeded tower has offices on F1..F6 within 20 tiles of x=70. A hotel
    // dropped among them starts 60 points into a 150-point budget.
    const world = seedDemoWorld({ seed: 1 });
    const { tower } = world;
    tower.starCount = 3;
    const noisy = applyAction(world, { type: 'build', what: 'hotelSingle', floor: 2, left: 72 });
    assert(noisy.ok, noisy.reason);
    const quiet = applyAction(world, { type: 'build', what: 'hotelSingle', floor: 9, left: 72 });
    assert(quiet.ok, quiet.reason);
    assert(hotelNoiseNear(tower, noisy.object), 'F2 @72 is between two offices');
    assert(!hotelNoiseNear(tower, quiet.object), 'F9 has nothing on it');
    const g = guestsOfWorld(tower, noisy.object);
    stress(g, 100);
    assert(hotelScore(tower, noisy.object, g) === 160, 'stress 100 plus the 60 of noise is a failing 160');
    const h = guestsOfWorld(tower, quiet.object);
    stress(h, 100);
    assert(hotelScore(tower, quiet.object, h) === 100, 'the same stress in a quiet room is 100');
  },
};

const guestsOfWorld = (tower, object) => tower.actors.filter((a) => a && a.objectId === object.id);
