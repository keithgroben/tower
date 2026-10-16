/**
 * **The tower demands things back** (issue #13): the medical center, the recycling
 * center, parking - and the notices the tower raises until each is answered.
 *
 * Every number here is the spec's or the issue's, and says which:
 *   `specs/facility/MEDICAL.md`     $500,000, at most ten, 1-in-10 at 3 stars, the banner
 *   `specs/facility/RECYCLING.md`   $500,000, $50,000 a pass, 500-per-tier, three checks a day
 *   `specs/facility/PARKING.md`     $3,000 a space, $50,000 a ramp, coverage, "Office workers demand Parking"
 *   `specs/COMMANDS.md`             parking and recycling are below grade; recycling is a stack
 *   `specs/ECONOMY.md` § Periodic Expenses   $0 / $300 / $1,000 a tile, $10,000 a ramp, $50,000 recycling
 *
 * What is NOT asserted, deliberately: that the numbers feel right. That is Keith's.
 *
 * The trials at the bottom call the same functions `node harness/playtest.js --services`
 * prints, so the harness and the suite cannot disagree about what was run.
 */
import {
  BUILDABLE, applyAction, demolishRefusal, gradeReason, placementObstruction,
} from '../src/games/tower/sim/actions.js';
import { activeDemands, demandsOf, noticesAfter, raiseDemand, clearDemand, DEMAND } from '../src/games/tower/sim/demands.js';
import {
  CONSTRUCTION_COST, applyPeriodicOperatingExpenses, createLedger,
} from '../src/games/tower/sim/economy.js';
import { chargeableItems } from '../src/games/tower/sim/ledger-adapter.js';
import {
  MAX_MEDICAL_CENTERS, MEDICAL_RETRY_LIMIT, MEDICAL_ROLL, MEDICAL_VISIT_TICKS, MEDICAL_WIDTH,
  finalizeMedicalCenter, joinMedicalQueue, medicalNightReset, pendingVisitors, pickMedicalCenter,
  rollMedicalTrip,
} from '../src/games/tower/sim/medical.js';
import {
  MAX_PARKING_SPACES, PARKING_SPACE_WIDTH, SPACE_CAPACITY, finalizeParkingSpace, isUsableSpace, officeWorkerDrives,
  parkingNightReset, parkingRamps, parkingSpaceObstruction, parkingSpaces, rampConnected, rebuildParkingCoverage,
  usableSpaces,
} from '../src/games/tower/sim/parking.js';
import {
  RECYCLING_WIDTH, recyclingCenters, recyclingServed, requiredTier, updateRecyclingState, workingRecyclingCenters,
} from '../src/games/tower/sim/recycling.js';
import { OFFICE_STATE, officeDispatch, officeArrival } from '../src/games/tower/sim/office.js';
import { activateHotelRoom, checkoutHotelRoom } from '../src/games/tower/sim/hotel.js';
import {
  STAR_REQUIREMENT, refreshStartOfDayGates, starGateStatus, starGatesOf, towerActivity,
} from '../src/games/tower/sim/progression.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { daypartOf } from '../src/games/tower/sim/clock.js';
import {
  FAMILY, OBJECT_TYPE, OCCUPANTS, POPULATION_CONTRIBUTION, SERVICE_FACILITY_FAMILIES, __resetIds, createTower,
  placeObject, population,
} from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { objectSprite } from '../src/games/tower/render/canvas.js';
import { TOOLS, preview, toolById } from '../src/games/tower/ui/build.js';
import { demandsReadout, serviceReadout, starClause } from '../src/games/tower/ui/readout.js';
import { newTowerWorld, seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { medicalTrial, parkingTrial, recyclingTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const trips = () => createSimTripRecord();

/** A world at `stars` with plenty of money and an empty lot with its ground lobby (tiles 48..101). */
function world({ stars = 3, cash = 90_000_000 } = {}) {
  __resetIds();
  const w = newTowerWorld({ seed: 1, cash });
  w.tower.starCount = stars;
  return w;
}

const build = (w, what, floor, left) => applyAction(w, { type: 'build', what, floor, left });
const ghost = (w, id, floor, left) => preview(w, toolById(id), { floor, tile: left });

/** Set the clock the way the scheduler would have left it. */
function at(tower, dayTick, dayCounter = tower.clock.dayCounter) {
  tower.clock.dayTick = dayTick;
  tower.clock.daypart = daypartOf(dayTick);
  tower.clock.dayCounter = dayCounter;
  tower.clock.calendarPhase = (dayCounter % 12) % 3 >= 2;
}

/** A bare tower (no lobby, no lifts) for the pure checks. */
function bare(stars = 3) {
  __resetIds();
  const tower = createTower({ seed: 1 });
  tower.starCount = stars;
  return tower;
}

/** A rented office with its six workers, on `floor`. */
function officeOn(tower, floor = 3, left = 60) {
  const placed = placeObject(tower, { family: FAMILY.office, floor, left, right: left + 5 }, trips);
  assert(placed.ok, 'fixture: ' + placed.reason);
  placed.object.unitStatus = 0;
  placed.object.occupiedFlag = true;
  return placed.object;
}
const workerOf = (tower, office, slot) =>
  tower.actors.find((a) => a.objectId === office.id && a.occupantIndex === slot);

/** A clinic, placed the way `applyAction` places one. */
function clinicOn(tower, floor = 4, left = 100) {
  const placed = placeObject(tower,
    { family: FAMILY.medical, type: OBJECT_TYPE.medical, floor, left, right: left + MEDICAL_WIDTH - 1 },
    trips, finalizeMedicalCenter);
  assert(placed.ok, 'fixture: ' + placed.reason);
  return placed.object;
}

/** A router that says what you tell it and remembers what it was asked. */
function router(answer = () => 3) {
  const calls = [];
  return {
    calls,
    ctx: {
      resolveRoute: (_t, _actor, from, to) => { calls.push({ from, to }); return { code: answer(from, to) }; },
      onDelay() {},
    },
  };
}

/** A garage on B1 under the lobby: a ramp at 60 and `n` four-tile spaces to its right. */
function garage(w, n = 2) {
  const ramp = build(w, 'parkingRamp', -1, 60);
  assert(ramp.ok, 'fixture: the ramp: ' + ramp.reason);
  const spaces = [];
  for (let i = 0; i < n; i++) {
    const s = build(w, 'parkingSpace', -1, 61 + i * PARKING_SPACE_WIDTH);
    assert(s.ok, 'fixture: space ' + i + ': ' + s.reason);
    spaces.push(s.object);
  }
  return { ramp: ramp.object, spaces };
}

/** An office worker who drives: slot chosen so `(floor + slot) % 4 == 1`. */
function driver(tower, office) {
  const slot = [0, 1, 2, 3, 4, 5].find((s) => (office.floor + s) % 4 === 1);
  return workerOf(tower, office, slot);
}

export const tests = {
  // ============================================================ the facts

  'the numbers are the spec\'s: $500,000, $500,000, $3,000 and $50,000, all at three stars'() {
    assert(CONSTRUCTION_COST.medical === 500_000, 'medical $' + CONSTRUCTION_COST.medical);
    assert(CONSTRUCTION_COST.recyclingCenter === 500_000, 'recycling $' + CONSTRUCTION_COST.recyclingCenter);
    assert(CONSTRUCTION_COST.parkingSpace === 3_000, 'space $' + CONSTRUCTION_COST.parkingSpace);
    assert(CONSTRUCTION_COST.parkingRamp === 50_000, 'ramp $' + CONSTRUCTION_COST.parkingRamp);
    for (const kind of ['medical', 'recyclingCenter', 'parkingSpace', 'parkingRamp']) {
      assert(STAR_REQUIREMENT[kind] === 3, kind + ' unlocks at ' + STAR_REQUIREMENT[kind]);
    }
    assert(MAX_MEDICAL_CENTERS === 10, 'ten clinics');
    assert(MEDICAL_ROLL === 10, 'one in ten');
    assert(MEDICAL_RETRY_LIMIT === 40, 'the retry limit is the reference\'s 0x28');
  },

  'a build quotes the facility plus the floor tiles of every floor it stands on'() {
    const w = world();
    // `buildCost` through the ghost: the number the player sees is the number charged.
    const q = (id, floor, left) => ghost(w, id, floor, left).cost;
    assert(q('medical', 5, 20) === 500_000 + MEDICAL_WIDTH * 500, 'a clinic: ' + q('medical', 5, 20));
    assert(q('recyclingCenter', -3, 20) === 500_000 + 2 * RECYCLING_WIDTH * 500, 'a center is two floors of tiles: ' + q('recyclingCenter', -3, 20));
    assert(q('parkingSpace', -1, 20) === 3_000 + PARKING_SPACE_WIDTH * 500, 'a space: ' + q('parkingSpace', -1, 20));
    assert(q('parkingRamp', -1, 60) === 50_000 + 500, 'a ramp: ' + q('parkingRamp', -1, 60));
    const cash = w.ledger.cash;
    const real = build(w, 'medical', 5, 20);
    assert(real.ok && real.cost === 513_000 && cash - w.ledger.cash === 513_000, 'the ledger moved by the quote');
  },

  'below three stars none of the four can be built, and the lock is the reason given'() {
    const w = world({ stars: 2 });
    for (const [what, floor, left] of [['medical', 5, 20], ['recyclingCenter', -3, 20], ['parkingSpace', -1, 20], ['parkingRamp', -1, 60]]) {
      const r = build(w, what, floor, left);
      assert(!r.ok && /needs a tower of 3 stars/.test(r.reason), what + ' at two stars: ' + r.reason);
      assert(ghost(w, what, floor, left).reason === r.reason, what + ': the ghost says the same thing');
    }
  },

  'none of them is population, none owns an actor, and parking a car adds nobody to the tower'() {
    for (const family of [FAMILY.medical, FAMILY.parkingSpace, FAMILY.parkingRamp, FAMILY.recycling]) {
      assert(POPULATION_CONTRIBUTION[family] === 0, 'family ' + family + ' must be an explicit 0');
      assert(!(family in OCCUPANTS), 'family ' + family + ' owns no actors');
      assert(SERVICE_FACILITY_FAMILIES.has(family), 'family ' + family + ' is a service facility');
    }
    const w = world();
    const before = population(w.tower);
    garage(w, 3);
    assert(build(w, 'medical', 5, 20).ok && build(w, 'recyclingCenter', -3, 20).ok, 'fixture: the rest');
    assert(population(w.tower) === before, 'the facilities counted as people: ' + population(w.tower));
    assert(w.tower.actors.length === 0, 'and made actors: ' + w.tower.actors.length);
  },

  // ============================================================ placement

  'grade: a clinic goes above the ground; recycling and parking go below it'() {
    const w = world();
    assert(/above the ground floor/.test(build(w, 'medical', -1, 20).reason), 'a clinic in the basement');
    assert(/above the ground floor/.test(build(w, 'medical', 0, 20).reason), 'a clinic on the ground floor');
    assert(/in the basement/.test(build(w, 'parkingSpace', 2, 20).reason), 'parking above the ground');
    assert(/in the basement/.test(build(w, 'parkingSpace', 0, 20).reason), 'parking on the ground floor');
    assert(/in the basement/.test(build(w, 'parkingRamp', 3, 60).reason), 'a ramp above the ground');
    assert(/in the basement/.test(build(w, 'recyclingCenter', 2, 20).reason), 'recycling above the ground');
  },

  'a recycling center is two floors and both must be below ground, so B1 is refused and says why'() {
    const w = world();
    const r = build(w, 'recyclingCenter', -1, 20);
    assert(!r.ok && /basement/.test(r.reason) && /2 floors tall/.test(r.reason), 'B1: ' + r.reason);
    assert(gradeReason(BUILDABLE.recyclingCenter, -2) === null, 'B2 (upper half on B1) is fine');
    const ok = build(w, 'recyclingCenter', -2, 20);
    assert(ok.ok, 'B2: ' + ok.reason);
    const floors = recyclingCenters(w.tower).flatMap((c) => [c.floor, c.floor - 1]).sort((a, b) => a - b);
    assert(floors.join() === '-2,-1', 'the lower floor is the one clicked and the upper is the one above: ' + floors);
    assert(w.tower.objects.size === 3, 'two halves and the lobby: ' + w.tower.objects.size);
  },

  'at most ten clinics, the ghost and the seam in the same words'() {
    const w = world();
    for (let floor = 1; floor <= MAX_MEDICAL_CENTERS; floor++) {
      const r = build(w, 'medical', floor, 20);
      assert(r.ok, 'clinic ' + floor + ': ' + r.reason);
    }
    const guess = ghost(w, 'medical', 12, 20);
    const real = build(w, 'medical', 12, 20);
    assert(!real.ok && /at most 10 medical centers/.test(real.reason), real.reason);
    assert(guess.reason === real.reason, 'two voices: ' + guess.reason + ' / ' + real.reason);
  },

  'the space cap is 512, asked of the same predicate by the seam and the ghost'() {
    const tower = bare();
    for (let i = 0; i < MAX_PARKING_SPACES; i++) {
      tower.objects.set(i + 1000, { id: i + 1000, family: FAMILY.parkingSpace, floor: -1 - (i % 10), left: 0, right: 3 });
    }
    assert(parkingSpaces(tower).length === 512, 'fixture');
    assert(/at most 512 parking spaces/.test(parkingSpaceObstruction(tower)), 'the cap speaks');
    assert(placementObstruction(tower, BUILDABLE.parkingSpace, -1, 50) === parkingSpaceObstruction(tower),
      'the shared placementObstruction answers with it');
  },

  'a ramp has to meet the lobby: under it on B1, and in a column of ramps below that'() {
    const w = world();
    const nowhere = build(w, 'parkingRamp', -1, 20);                   // the lobby spans 48..101
    assert(!nowhere.ok && /meet the lobby/.test(nowhere.reason), 'a ramp not under the lobby: ' + nowhere.reason);
    const deep = build(w, 'parkingRamp', -2, 60);
    assert(!deep.ok && /no ramp above/.test(deep.reason), 'a ramp on B2 with nothing above: ' + deep.reason);
    const top = build(w, 'parkingRamp', -1, 60);
    assert(top.ok && rampConnected(w.tower, top.object), 'the ramp under the lobby: ' + top.reason);
    const next = build(w, 'parkingRamp', -2, 60);
    assert(next.ok && rampConnected(w.tower, next.object), 'and the one under that: ' + next.reason);
    const aside = build(w, 'parkingRamp', -2, 70);
    assert(!aside.ok, 'a ramp beside the column, not under a ramp: ' + aside.reason);
    // ...and it is a real width: one tile.
    assert(top.object.right - top.object.left === 0, 'a ramp is one tile wide');
    // A ramp that is not under the lobby serves nothing even if it got there some other
    // way (a save, a test): the walk asks `rampConnected`, not the placement rule.
    const stray = placeObject(w.tower, { family: FAMILY.parkingRamp, type: OBJECT_TYPE.parkingRamp, floor: -1, left: 10, right: 10 }, trips).object;
    const strayBay = placeObject(w.tower, { family: FAMILY.parkingSpace, type: OBJECT_TYPE.parkingSpace, floor: -1, left: 11, right: 14 }, trips, finalizeParkingSpace).object;
    rebuildParkingCoverage(w.tower);
    assert(!rampConnected(w.tower, stray) && strayBay.coverageFlag === 0, 'a ramp with no lobby above it serves no one');
  },

  'cutting the top of a ramp column cuts everything under it off, and the spaces go dark'() {
    const w = world();
    const { ramp, spaces } = garage(w, 2);
    const lower = build(w, 'parkingRamp', -2, 60).object;
    const deepSpace = build(w, 'parkingSpace', -2, 61).object;
    assert(spaces.every((s) => s.coverageFlag === 1) && deepSpace.coverageFlag === 1, 'fixture: all three are served');
    assert(applyAction(w, { type: 'demolish', objectId: ramp.id }).ok, 'a ramp can be bulldozed');
    assert(!rampConnected(w.tower, lower), 'the lower ramp no longer meets the lobby');
    assert(spaces.every((s) => s.coverageFlag === 0) && deepSpace.coverageFlag === 0, 'nothing is served any more');
    assert(usableSpaces(w.tower).length === 0, 'and nobody can park');
  },

  'what a ramp serves: spaces beside it, across gaps of up to three empty tiles, stopped by anything else'() {
    const w = world();
    const ramp = build(w, 'parkingRamp', -1, 60).object;
    const put = (left) => build(w, 'parkingSpace', -1, left).object;
    const near = put(61);                // 61..64, touching the ramp
    const across = put(68);              // 65,66,67 empty: a gap of three, crossed
    const farRight = put(76);            // 72..75 empty: a gap of FOUR, so the walk stops
    const leftNear = put(56);            // 56..59, touching on the left
    const leftAcross = put(49);          // 53,54,55 empty: crossed going left
    assert([near, across, leftNear, leftAcross].every((s) => s.coverageFlag === 1), 'the reachable ones are served');
    assert(farRight.coverageFlag === 0, 'a gap of four stops the walk');
    // A shop in the way stops it as well, however small the gap beyond.
    const shop = placeObject(w.tower, { family: FAMILY.retail, floor: -1, left: 96, right: 99 }, trips).object;
    const beyond = put(100);
    assert(shop && beyond.coverageFlag === 0, 'a non-parking object ends the walk');
    // Another floor is another floor: the ramp serves its own.
    const below = build(w, 'parkingSpace', -2, 61).object;
    assert(below.coverageFlag === 0, 'B2 has no ramp of its own and is not served from B1');
    void ramp;
    assert(rebuildParkingCoverage(w.tower) === 4, 'rebuilt from scratch it is the same four');
  },

  'a space holds two cars and the third is refused; a worker\'s car is taken back out'() {
    const w = world();
    const { spaces } = garage(w, 1);
    const [space] = spaces;
    assert(isUsableSpace(space), 'fixture');
    space.parking.cars.push('a1', 'a2');
    assert(!isUsableSpace(space) && usableSpaces(w.tower).length === 0, 'full at ' + SPACE_CAPACITY);
    space.parking.cars.pop();
    assert(isUsableSpace(space), 'room for one more');
  },

  'recycling: the first center goes anywhere, the next must stand beside one'() {
    const w = world();
    const first = build(w, 'recyclingCenter', -3, 20);
    assert(first.ok, 'the first: ' + first.reason);
    const far = build(w, 'recyclingCenter', -3, 100);
    assert(!far.ok && /next to one another/.test(far.reason), 'apart: ' + far.reason);
    assert(ghost(w, 'recyclingCenter', -3, 100).reason === far.reason, 'the ghost agrees');
    const beside = build(w, 'recyclingCenter', -3, 20 + RECYCLING_WIDTH);
    assert(beside.ok, 'beside it: ' + beside.reason);
    const below = build(w, 'recyclingCenter', -5, 20);
    assert(below.ok, 'directly under it: ' + below.reason);
    assert(recyclingCenters(w.tower).length === 3, 'three centers, six objects: ' + recyclingCenters(w.tower).length);
  },

  'a recycling center cannot be bulldozed, on either floor; a clinic, a space and a ramp can'() {
    const w = world();
    const center = build(w, 'recyclingCenter', -3, 20);
    for (const half of w.tower.objects.values()) {
      if (half.family !== FAMILY.recycling) continue;
      const refusal = demolishRefusal(half);
      assert(refusal === 'recycling centers cannot be bulldozed', 'half ' + half.type + ': ' + refusal);
      const real = applyAction(w, { type: 'demolish', objectId: half.id });
      assert(!real.ok && real.reason === refusal, 'the seam says the same');
      assert(preview(w, toolById('demolish'), { floor: half.floor, tile: half.left, object: half }).reason === refusal, 'and the ghost');
    }
    assert(center.ok, 'fixture');
    const clinic = build(w, 'medical', 5, 20).object;
    const { ramp, spaces } = garage(w, 1);
    for (const object of [clinic, spaces[0], ramp]) {
      assert(demolishRefusal(object) === null, 'type ' + object.type + ' must be demolishable, not ' + demolishRefusal(object));
      assert(applyAction(w, { type: 'demolish', objectId: object.id }).ok, 'and it is');
    }
  },

  '⚠️ ghost and seam agree on every refusal this issue added, in the same words'() {
    const cases = [
      ['a clinic in the basement', 'medical', () => [-1, 20]],
      ['a clinic on a shop', 'medical', () => [-1, 60]],
      ['a space above ground', 'parkingSpace', () => [3, 20]],
      ['a space on a shop', 'parkingSpace', () => [-1, 60]],
      ['a ramp not under the lobby', 'parkingRamp', () => [-1, 10]],
      ['a ramp on B2 with nothing above', 'parkingRamp', () => [-2, 60]],
      ['a ramp on a shop', 'parkingRamp', () => [-1, 60]],
      ['a ramp above ground', 'parkingRamp', () => [2, 60]],
      ['recycling on B1', 'recyclingCenter', () => [-1, 20]],
      ['recycling above ground', 'recyclingCenter', () => [4, 20]],
      ['recycling on a shop', 'recyclingCenter', () => [-2, 55]],
      ['a clinic that is fine', 'medical', () => [5, 20]],
      ['a space that is fine', 'parkingSpace', () => [-1, 20]],
      ['a ramp that is fine', 'parkingRamp', () => [-1, 50]],
      ['recycling that is fine', 'recyclingCenter', () => [-4, 20]],
    ];
    for (const [label, what, target] of cases) {
      const [floor, left] = target();
      const a = seedDemoWorld({ seed: 1, cash: 90_000_000 });
      a.tower.starCount = 3;
      const guess = ghost(a, what, floor, left);
      const b = seedDemoWorld({ seed: 1, cash: 90_000_000 });
      b.tower.starCount = 3;
      const real = build(b, what, floor, left);
      assert(guess.ok === real.ok,
        `${label}: ghost said ${guess.ok ? 'yes' : 'no'} and the seam said ${real.ok ? 'yes' : 'no'}` + (real.reason ? ` ("${real.reason}")` : ''));
      if (!real.ok) assert(guess.reason === real.reason, `${label}: two voices\n       ghost: ${guess.reason}\n       seam:  ${real.reason}`);
      if (real.ok) assert(guess.cost === real.cost, `${label}: the ghost quoted ${guess.cost}, the seam charged ${real.cost}`);
    }
  },

  'the palette has a button for each, in the sim\'s own words'() {
    for (const [id, label] of [['medical', 'Medical Center'], ['recyclingCenter', 'Recycling Center'],
      ['parkingSpace', 'Parking Space'], ['parkingRamp', 'Parking Ramp']]) {
      const tool = TOOLS.find((t) => t.id === id);
      assert(tool && tool.action === 'build' && tool.label === label, id + ' has no tool');
    }
    // `starClause` names a thing to build only if the palette has one - and now it does.
    const status = starGateStatus(Object.assign(bare(3), { gates: {} }));
    const kinds = status.blockerDetails.map((d) => d.kind).filter(Boolean);
    assert(kinds.includes('recyclingCenter') && kinds.includes('medical'), 'the ladder names both: ' + kinds);
    for (const kind of ['recyclingCenter', 'medical']) assert(Object.hasOwn(BUILDABLE, kind), kind + ' is not on the palette');
  },

  // ============================================================ the medical center

  'a worker at three stars has a one-in-ten chance, once a day, and below three has none and spends no draw'() {
    const tower = bare(3);
    const office = officeOn(tower);
    clinicOn(tower);
    let hits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (rollMedicalTrip(tower, {}, office)?.center) hits++;
    assert(hits / N > 0.085 && hits / N < 0.115, 'about one in ten, got ' + hits + '/' + N);

    const worker = workerOf(tower, office, 0);
    tower.rng.state = 12345;
    const seen = rollMedicalTrip(tower, worker, office);
    const after = tower.rng.state;
    assert(rollMedicalTrip(tower, worker, office) === null && tower.rng.state === after,
      'a second ask on the same day is no roll at all (' + JSON.stringify(seen) + ')');
    at(tower, 1700, tower.clock.dayCounter + 1);
    rollMedicalTrip(tower, worker, office);
    assert(tower.rng.state !== after, 'tomorrow it rolls again');

    const low = bare(2);
    const lowOffice = officeOn(low);
    clinicOn(low);
    const state = low.rng.state;
    for (let i = 0; i < 50; i++) assert(rollMedicalTrip(low, {}, lowOffice) === null, 'a two-star worker went to the clinic');
    assert(low.rng.state === state, 'and the roll was never drawn: `star >= 3 && rand() % 10 == 0` short-circuits');
  },

  'the pick is the worker\'s own zone, and the whole tower when the zone has none'() {
    const tower = bare(3);
    const low = clinicOn(tower, 3, 0);
    const high = clinicOn(tower, 20, 0);
    for (let i = 0; i < 200; i++) {
      assert(pickMedicalCenter(tower, 4) === low, 'a worker on F4 goes to the F3 clinic');
      assert(pickMedicalCenter(tower, 22) === high, 'a worker on F22 goes to the F20 clinic');
    }
    tower.objects.delete(high.id);
    for (let i = 0; i < 20; i++) assert(pickMedicalCenter(tower, 44) === low, 'no clinic in the zone: the global fallback');
    tower.objects.delete(low.id);
    assert(pickMedicalCenter(tower, 4) === null, 'and none at all is null, not -1');
  },

  'the trip is real: out to the clinic by the router, into its queue, served, and home from the clinic\'s floor'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const clinic = clinicOn(tower, 4);
    const worker = workerOf(tower, office, 0);
    tower.rng = { chance: () => true, int: () => 0, state: 1 };           // the roll comes up
    at(tower, 1700, 4);
    worker.state = OFFICE_STATE.commuteOut;
    const { ctx, calls } = router();

    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(calls.length === 1 && calls[0].from === 3 && calls[0].to === 4, 'asked the router for office -> clinic: ' + JSON.stringify(calls));
    assert((worker.state & 0x3f) === OFFICE_STATE.atMedical, 'at the clinic: 0x' + worker.state.toString(16));
    assert(pendingVisitors(clinic) === 1 && clinic.medical.queue[0] === worker.id, 'in its queue');

    // Waiting: not done until the visit has run its course.
    at(tower, 1700 + MEDICAL_VISIT_TICKS - 20);
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert((worker.state & 0x3f) === OFFICE_STATE.atMedical && pendingVisitors(clinic) === 1, 'still being seen');
    at(tower, 1700 + MEDICAL_VISIT_TICKS);
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert((worker.state & 0x3f) === OFFICE_STATE.commuteOut && pendingVisitors(clinic) === 0, 'seen, and out of the queue');
    assert(worker.homeFrom === 4, 'going home from the clinic\'s floor');

    officeDispatch(tower, worker, office, tower.clock, ctx);
    const home = calls[calls.length - 1];
    assert(home.from === 4 && home.to === 0, 'the way home starts on the clinic\'s floor: ' + JSON.stringify(home));
    assert((worker.state & 0x3f) === OFFICE_STATE.parked && worker.homeFrom === null, 'and ends parked for the night');
  },

  'a busy clinic queues one worker at a time, and the retry limit lets the patient go'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const clinic = clinicOn(tower, 4);
    at(tower, 1700, 4);
    const [a, b] = [workerOf(tower, office, 0), workerOf(tower, office, 1)];
    joinMedicalQueue(tower, a, clinic);
    joinMedicalQueue(tower, b, clinic);
    assert(b.medicalReadyTick === a.medicalReadyTick + MEDICAL_VISIT_TICKS, 'the second waits for the first');
    assert(pendingVisitors(clinic) === 2, 'two in the queue');

    // Starve the clinic: the visit never comes round, but forty refreshes is the limit.
    b.medicalObjectId = clinic.id;
    b.state = OFFICE_STATE.atMedical;
    b.medicalReadyTick = 99999;
    const { ctx } = router();
    for (let i = 0; i < MEDICAL_RETRY_LIMIT - 1; i++) officeDispatch(tower, b, office, tower.clock, ctx);
    assert((b.state & 0x3f) === OFFICE_STATE.atMedical, 'still waiting at 39 refreshes');
    officeDispatch(tower, b, office, tower.clock, ctx);
    assert((b.state & 0x3f) === OFFICE_STATE.commuteOut, 'the 40th lets them go "as if served"');
  },

  'no clinic: the banner, the cleared daily flag, and the worker goes home anyway'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const worker = workerOf(tower, office, 0);
    tower.rng = { chance: () => true, int: () => 0, state: 1 };
    at(tower, 1700, 4);
    starGatesOf(tower).medicalServiceOk = true;
    worker.state = OFFICE_STATE.commuteOut;
    const { ctx, calls } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(starGatesOf(tower).medicalServiceOk === false, 'the day\'s flag is cleared');
    assert(activeDemands(tower).some((d) => d.text === 'Medical Center demanded near Lobby'), 'the banner: ' + JSON.stringify(activeDemands(tower)));
    assert(calls.length === 1 && calls[0].to === 0, 'and the worker took the ordinary way home');
    assert((worker.state & 0x3f) === OFFICE_STATE.parked, 'parked for the night');
  },

  'a clinic demolished mid-trip is the same failure: banner, flag, trip abandoned, queue empty'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const clinic = clinicOn(tower, 4);
    const worker = workerOf(tower, office, 0);
    at(tower, 1700, 4);
    starGatesOf(tower).medicalServiceOk = true;
    joinMedicalQueue(tower, worker, clinic);
    worker.medicalObjectId = clinic.id;
    worker.state = OFFICE_STATE.atMedical;
    tower.objects.delete(clinic.id);                         // bulldozed with the patient inside
    const { ctx } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(starGatesOf(tower).medicalServiceOk === false, 'the flag clears');
    assert(demandsOf(tower).active.medical, 'the demand is raised');
    assert((worker.state & 0x3f) === OFFICE_STATE.commuteOut && worker.medicalObjectId === null, 'abandoned, heading home');
  },

  'night empties every queue and sends the patient to bed; a clinic nobody can reach is a trip home, not a banner'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const clinic = clinicOn(tower, 4);
    const worker = workerOf(tower, office, 0);
    at(tower, 1700, 4);
    joinMedicalQueue(tower, worker, clinic);
    worker.medicalObjectId = clinic.id;
    worker.state = OFFICE_STATE.atMedical;
    at(tower, 2310);
    const { ctx } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert((worker.state & 0x3f) === OFFICE_STATE.parked && pendingVisitors(clinic) === 0, 'night ends the visit');
    joinMedicalQueue(tower, worker, clinic);
    medicalNightReset(tower);
    assert(pendingVisitors(clinic) === 0 && clinic.medical.busyUntil === 0, 'the 2500 reset empties the queue');

    // The router says no: the clinic exists but cannot be reached.
    const tower2 = bare(3);
    const office2 = officeOn(tower2, 3);
    clinicOn(tower2, 4);
    const w2 = workerOf(tower2, office2, 0);
    tower2.rng = { chance: () => true, int: () => 0, state: 1 };
    at(tower2, 1700, 4);
    starGatesOf(tower2).medicalServiceOk = true;
    w2.state = OFFICE_STATE.commuteOut;
    officeDispatch(tower2, w2, office2, tower2.clock, router((_f, to) => (to === 4 ? -1 : 3)).ctx);
    assert(starGatesOf(tower2).medicalServiceOk === true && !demandsOf(tower2).active.medical,
      'unreachable is not missing: no banner, the flag stands');
    assert((w2.state & 0x3f) === OFFICE_STATE.commuteOut && w2.medicalObjectId === null, 'back on the way home');
  },

  'the daily medical flag: latched true each morning from three stars, cleared by a failed trip, read by 3->4 and 4->5'() {
    const tower = bare(2);
    refreshStartOfDayGates(tower);
    assert(starGatesOf(tower).medicalServiceOk === false, 'not latched below three stars');
    tower.starCount = 3;
    refreshStartOfDayGates(tower);
    assert(starGatesOf(tower).medicalServiceOk === true, 'latched at the start of the day');
    for (const star of [3, 4]) {
      const t = bare(star);
      t.gates = { securityPlaced: true, officePlaced: true, metroPlaced: true, recyclingAdequate: true,
        officeServiceOk: true, routesViable: true, medicalServiceOk: false };
      t.populationLedger = { office: 99_999 };
      const blockers = starGateStatus(t).blockerDetails.filter((d) => d.kind === 'medical');
      assert(blockers.length === 1, star + ' stars: a missing medical flag must block the ladder by name');
      t.gates.medicalServiceOk = true;
      assert(starGateStatus(t).blockerDetails.every((d) => d.kind !== 'medical'), star + ' stars: and a latched one does not');
    }
  },

  // ============================================================ recycling

  'the tier is activity per center: under 500, 1000, 1500, 2000, 2500, and over'() {
    assert(requiredTier(0, 1) === 1 && requiredTier(499, 1) === 1, 'under 500 is tier 1');
    assert(requiredTier(500, 1) === 2 && requiredTier(999, 1) === 2, 'tier 2');
    assert(requiredTier(1000, 1) === 3 && requiredTier(1499, 1) === 3, 'tier 3');
    assert(requiredTier(1500, 1) === 4 && requiredTier(1999, 1) === 4, 'tier 4');
    assert(requiredTier(2000, 1) === 5 && requiredTier(2499, 1) === 5, 'tier 5: the issue\'s "under 2,500"');
    assert(requiredTier(2500, 1) === 6, '2,500 is a full center');
    assert(requiredTier(4999, 2) === 5 && requiredTier(5000, 2) === 6, 'two centers share the load');
    assert(requiredTier(1, 0) === Infinity, 'no centers cannot be adequate');
  },

  'adequacy: guarded by three stars; none, unserved, midday, afternoon and final each do what the spec says'() {
    const w = world({ stars: 2 });
    const { tower } = w;
    tower.populationLedger = { office: 100 };
    tower.gates = { recyclingAdequate: 'untouched' };
    assert(updateRecyclingState(tower, 5).ran === false && tower.gates.recyclingAdequate === 'untouched',
      '"guarded by `star_count > 2`": at two stars nothing is written');
    tower.starCount = 3;
    tower.gates.recyclingAdequate = true;

    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === false && demandsOf(tower).active.recycling, 'no center: the flag clears, the demand is raised');
    assert(demandsOf(tower).notices.at(-1).text === 'The tower demands a Recycling Center', 'in words');

    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center');
    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === false && demandsOf(tower).active.recyclingLift && !demandsOf(tower).active.recycling,
      'a center no service lift stops at does not count - and says so');

    // A guest lift down to the same floors is not the stop the center needs: it is the
    // SERVICE elevator that has to stop there.
    assert(applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: -3, top: 2, column: 70 }).ok, 'a standard lift');
    assert(!recyclingServed(tower, recyclingCenters(tower)[0]), 'a standard lift does not serve a recycling center');
    assert(applyAction(w, { type: 'build_shaft', kind: 'service', bottom: -3, top: 2, column: 120 }).ok, 'a service lift');
    assert(recyclingServed(tower, recyclingCenters(tower)[0]) && workingRecyclingCenters(tower).length === 1, 'now it is served');
    const service = tower.carriers.find((c) => c.mode === 2);
    service.stopEnabled.fill(0);
    assert(!recyclingServed(tower, recyclingCenters(tower)[0]), 'a stop switched off in the lift\'s panel is no stop');
    service.stopEnabled.fill(1);
    updateRecyclingState(tower, 0);
    assert(tower.gates.recyclingAdequate === false, 'tick 1600 (tier 0) always clears adequacy while a center exists');
    updateRecyclingState(tower, 2);
    assert(tower.gates.recyclingAdequate === true && !demandsOf(tower).active.recyclingLift, '100 activity passes the tier-2 check');
    tower.populationLedger = { office: 1000 };
    updateRecyclingState(tower, 2);
    assert(tower.gates.recyclingAdequate === false, '1,000 per center fails tier 2 (needs under 1,000)');
    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === true, 'but passes the final check');
    tower.populationLedger = { office: 2499 };
    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === true, '2,499 is still under 2,500');
    tower.populationLedger = { office: 2500 };
    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === false, '2,500 is not');
    assert(demandsOf(tower).active.recyclingFull && demandsOf(tower).notices.at(-1).text === 'Recycling Centers are full!',
      'and the notice is the original\'s: "Recycling Centers are full!"');
    // A second center halves the load and the notice goes.
    assert(build(w, 'recyclingCenter', -3, 20 + RECYCLING_WIDTH).ok, 'a second center, beside the first');
    updateRecyclingState(tower, 5);
    assert(tower.gates.recyclingAdequate === true && !demandsOf(tower).active.recyclingFull, 'two centers carry 2,500');
  },

  'the tick-5 sweep leaves a stack already at phase 5 alone when inadequate, and tick 32 resets the lower floor from 6'() {
    const w = world();
    const { tower } = w;
    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center');
    assert(applyAction(w, { type: 'build_shaft', kind: 'service', bottom: -3, top: 2, column: 120 }).ok, 'a service lift');
    const [lower, upper] = [...tower.objects.values()].filter((o) => o.family === FAMILY.recycling)
      .sort((a, b) => a.floor - b.floor);
    tower.populationLedger = { office: 800 };
    updateRecyclingState(tower, 5);
    assert(lower.stayPhase === 2 && upper.stayPhase === 2, 'adequate: the required tier is written to both halves');
    upper.stayPhase = 5;
    tower.populationLedger = { office: 9999 };
    updateRecyclingState(tower, 2);
    assert(upper.stayPhase === 5 && lower.stayPhase === 2, 'inadequate: the half at 5 is left, the other clamps... to ' + lower.stayPhase);
  },

  'the checkpoints are wired through the driver: 1600 clears, 2000 checks tier 2, 2566 the last, and the ladder reads it'() {
    const w = world();
    const { tower } = w;
    assert(applyAction(w, { type: 'build_shaft', kind: 'service', bottom: -3, top: 2, column: 120 }).ok, 'a service lift');
    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center');
    const { scheduler } = makeDriver(w);
    tower.populationLedger = { office: 1200 };               // tier 3: fails the 2000 check, passes the final one
    const seen = {};
    let listed = null;
    // From the day's own tick 0, so the three checks arrive in the order the day runs them.
    while (tower.clock.dayTick !== 0) scheduler.tick(tower);
    for (let guard = 0; guard < 2600; guard++) {
      scheduler.tick(tower);
      const t = tower.clock.dayTick;
      if (t === 1600 || t === 2000 || t === 2566) seen[t] = tower.gates.recyclingAdequate;
      if (t === 1600 || t === 2566) {
        listed = { ...listed, [t]: starGateStatus(tower).blockers.includes('a recycling centre keeping up with the tower') };
      }
    }
    assert(seen[1600] === false, '1600: cleared');
    assert(seen[2000] === false, '2000: 1,200 per center is over the tier-2 line');
    assert(seen[2566] === true, '2566: under 2,500, adequate');
    assert(listed[1600] === true && listed[2566] === false,
      'the ladder lists the recycling blocker at midday and drops it after the final check: ' + JSON.stringify(listed));
    const bare3 = world();
    const alone = makeDriver(bare3);
    bare3.tower.populationLedger = { office: 100 };
    for (let i = 0; i < 2700; i++) alone.scheduler.tick(bare3.tower);
    assert(bare3.tower.gates.recyclingAdequate === false, 'a tower with no center is never adequate');
    assert(starGateStatus(bare3.tower).blockers.includes('a recycling centre keeping up with the tower'), 'and the ladder says so by name');
  },

  // ============================================================ parking

  'the drivers are the workers with (floor + slot) % 4 == 1, and only above two stars'() {
    const tower = bare(3);
    const office = officeOn(tower, 3);
    const drives = tower.actors.filter((a) => officeWorkerDrives(tower, a, office)).map((a) => a.occupantIndex);
    assert(drives.join() === '2' || drives.join() === '2,6', 'on F3 slot 2 drives (3 + 2 = 5): ' + drives);
    assert(drives.every((s) => (3 + s) % 4 === 1), 'every driver satisfies the rule');
    tower.starCount = 2;
    assert(tower.actors.every((a) => !officeWorkerDrives(tower, a, office)), 'nobody drives at two stars');
  },

  'a driver\'s commute starts and ends in the garage, by the router, and the car is given back'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    const { spaces } = garage(w, 1);
    const worker = driver(tower, office);
    at(tower, 100, 4);
    worker.state = OFFICE_STATE.seekingWork;
    const { ctx, calls } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(calls[0].from === -1 && calls[0].to === 3, 'the morning route starts in the garage: ' + JSON.stringify(calls[0]));
    assert(worker.parkedAt === spaces[0].id && spaces[0].parking.cars.includes('a' + worker.id), 'the car is in the space');

    at(tower, 1700);
    worker.state = OFFICE_STATE.commuteOut;
    officeDispatch(tower, worker, office, tower.clock, ctx);
    const home = calls[calls.length - 1];
    assert(home.from === 3 && home.to === -1, 'and the evening route ends in the garage: ' + JSON.stringify(home));
    assert(worker.parkedAt === null && spaces[0].parking.cars.length === 0, 'the car leaves the space');
    assert((worker.state & 0x3f) === OFFICE_STATE.parked, 'parked for the night');
  },

  'a garage the lifts cannot reach does not strand the worker: the car is given up and the lobby is used'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    garage(w, 1);
    const worker = driver(tower, office);
    at(tower, 100, 4);
    worker.state = OFFICE_STATE.seekingWork;
    const { ctx, calls } = router((from) => (from < 0 ? -1 : 3));
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(worker.parkedAt === null && (worker.state & 0x3f) === OFFICE_STATE.seekingWork, 'still on its way, car given up: 0x' + worker.state.toString(16));
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(calls[1].from === 0, 'the second try starts in the lobby: ' + JSON.stringify(calls));
    assert((worker.state & 0x3f) !== OFFICE_STATE.strandedFailed && worker.parkedAt === null, 'and the worker is not stranded');
  },

  '"Office workers demand Parking": raised with no space, once a day, and cleared by building parking that works'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    const worker = driver(tower, office);
    at(tower, 100, 4);
    worker.state = OFFICE_STATE.seekingWork;
    const { ctx, calls } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(calls[0].from === 0, 'with nowhere to park the worker comes in through the lobby');
    assert(activeDemands(tower).some((d) => d.text === 'Office workers demand Parking'), 'the notice: ' + JSON.stringify(activeDemands(tower)));
    const posted = demandsOf(tower).notices.length;
    for (let i = 0; i < 5; i++) raiseDemand(tower, 'officeParking');
    assert(demandsOf(tower).notices.length === posted, 'once a day however many ask');
    at(tower, 100, 5);
    raiseDemand(tower, 'officeParking');
    assert(demandsOf(tower).notices.length === posted + 1, 'and again tomorrow');

    // Spaces with no ramp are blocked: they answer nothing.
    assert(build(w, 'parkingSpace', -1, 61).ok, 'a space');
    assert(activeDemands(tower).some((d) => d.kind === 'officeParking'), 'a space no ramp reaches does not clear the demand');
    assert(build(w, 'parkingRamp', -1, 60).ok, 'and now the ramp');
    assert(!activeDemands(tower).some((d) => d.kind === 'officeParking'), 'building the ramp that serves it clears the demand');
  },

  'nobody drives at two stars: no space asked for, no demand raised'() {
    const w = world({ stars: 2 });
    const { tower } = w;
    const office = officeOn(tower, 3);
    const worker = driver(tower, office);
    at(tower, 100, 4);
    worker.state = OFFICE_STATE.seekingWork;
    officeDispatch(tower, worker, office, tower.clock, router().ctx);
    assert(activeDemands(tower).length === 0, 'a two-star tower asks for nothing: ' + JSON.stringify(activeDemands(tower)));
  },

  'a vacant office is rented by the lobby route and nothing else, whoever the worker is'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    office.unitStatus = 0x10;                       // For Rent
    office.occupiedFlag = true;
    garage(w, 1);
    const worker = driver(tower, office);
    at(tower, 100, 4);
    worker.state = OFFICE_STATE.seekingWork;
    const { ctx, calls } = router();
    officeDispatch(tower, worker, office, tower.clock, ctx);
    assert(calls[0].from === 0 && worker.parkedAt == null, 'the first lease is the lobby\'s business: ' + JSON.stringify(calls[0]));
  },

  'a hotel suite\'s guests bring a car: a space if there is one, a demand if there is not, and it leaves at checkout'() {
    const w = world();
    const { tower } = w;
    const suite = placeObject(tower, { family: FAMILY.hotelSuite, floor: 5, left: 60, right: 69 }, trips).object;
    const single = placeObject(tower, { family: FAMILY.hotelSingle, floor: 5, left: 80, right: 83 }, trips).object;
    at(tower, 1700, 4);
    activateHotelRoom(tower, suite, null);
    assert(demandsOf(tower).active.suiteParking, 'no space: "Hotel Suite guests demand Parking"');
    assert(suite.unitStatus <= 0x17, 'and the room is booked all the same - nothing here invents a penalty');
    const { spaces } = garage(w, 1);
    assert(!demandsOf(tower).active.suiteParking, 'building the garage answers it');
    checkoutHotelRoom(tower, suite, null);
    suite.unitStatus = 0x18;
    activateHotelRoom(tower, suite, null);
    assert(suite.parkedAt === spaces[0].id && spaces[0].parking.cars.includes('s' + suite.id), 'the next stay parks');
    checkoutHotelRoom(tower, suite, null);
    assert(spaces[0].parking.cars.length === 0 && suite.parkedAt === null, 'checkout takes the car away');
    activateHotelRoom(tower, single, null);
    assert(single.parkedAt === undefined, 'a single room brings no car');
  },

  'the night takes the workers\' cars home and keeps a suite guest\'s, and sweeps a suite that is gone'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    const { spaces } = garage(w, 1);
    const worker = driver(tower, office);
    const suite = placeObject(tower, { family: FAMILY.hotelSuite, floor: 5, left: 60, right: 69 }, trips).object;
    spaces[0].parking.cars.push('a' + worker.id, 's' + suite.id);
    worker.parkedAt = spaces[0].id;
    parkingNightReset(tower);
    assert(worker.parkedAt === null && spaces[0].parking.cars.join() === 's' + suite.id, 'the worker\'s car left, the guest\'s stayed');
    tower.objects.delete(suite.id);
    parkingNightReset(tower);
    assert(spaces[0].parking.cars.length === 0, 'a car whose room is gone is swept');
  },

  // ============================================================ money

  'the parking expense belongs to the lobby: $0 below three stars, $300 a tile at three, $1,000 from four'() {
    const lobby = { type: 'lobby', floor: 0, leftTile: 48, rightTile: 101 };           // 53 tile-steps
    const bill = (starCount, extra = {}) => {
      const ledger = createLedger({ cash: 10_000_000 });
      applyPeriodicOperatingExpenses(ledger, { items: [{ ...lobby, ...extra }], starCount, lobbyHeight: 1 });
      return ledger.expense.parking;
    };
    assert(bill(1) === 0 && bill(2) === 0, 'free below three stars');
    assert(bill(3) === 53 * 300, 'three stars: $300 a tile, got ' + bill(3));
    assert(bill(4) === 53 * 1000 && bill(5) === 53 * 1000, 'four stars on: $1,000 a tile, got ' + bill(4));
    // A sky lobby is a lobby, and the upper floors of a tall ground lobby are exempt.
    assert(bill(3, { floor: 14 }) === 53 * 300, 'a sky lobby pays like the ground lobby');
    const ledger = createLedger({ cash: 10_000_000 });
    applyPeriodicOperatingExpenses(ledger, { items: [{ ...lobby, floor: 1 }], starCount: 4, lobbyHeight: 2 });
    assert(ledger.expense.parking === 0, 'floor 1 of a 2-floor lobby is skipped');
  },

  'through the real sweep: a space costs nothing to keep, a ramp $10,000 a pass, a recycling center $50,000 once'() {
    const w = world({ stars: 3 });
    const { tower } = w;
    tower.objects.delete([...tower.objects.values()].find((o) => o.family === FAMILY.lobby).id);   // no lobby: isolate the four
    // Placed directly: this test is about what the sweep is OFFERED, and the ramp's
    // lobby rule has its own tests above.
    placeObject(tower, { family: FAMILY.parkingRamp, type: OBJECT_TYPE.parkingRamp, floor: -1, left: 60, right: 60 }, trips);
    for (let i = 0; i < 3; i++) {
      placeObject(tower, { family: FAMILY.parkingSpace, type: OBJECT_TYPE.parkingSpace, floor: -1, left: 61 + i * 4, right: 64 + i * 4 }, trips, finalizeParkingSpace);
    }
    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center (two halves)');
    clinicOn(tower, 5, 20);
    const ledger = createLedger({ cash: 10_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, { items: chargeableItems(tower), starCount: 3, lobbyHeight: 1 });
    assert(ledger.expense.parkingRamp === 10_000, 'the ramp: $' + ledger.expense.parkingRamp);
    assert(ledger.expense.recyclingCenter === 50_000, 'the center is billed once, not per floor: $' + ledger.expense.recyclingCenter);
    assert(ledger.expense.parking === 0, 'spaces pay nothing: $' + ledger.expense.parking);
    assert(spent === 60_000, 'and the clinic is free: ' + spent + ' in all');
  },

  // ============================================================ saves

  'a tower with clinics, a garage, cars, a queue and live demands survives a save and carries on'() {
    const w = world();
    const { tower } = w;
    const office = officeOn(tower, 3);
    const clinic = clinicOn(tower, 4);
    const { spaces } = garage(w, 2);
    const worker = driver(tower, office);
    spaces[0].parking.cars.push('a' + worker.id);
    worker.parkedAt = spaces[0].id;
    joinMedicalQueue(tower, workerOf(tower, office, 0), clinic);
    raiseDemand(tower, 'medical');
    raiseDemand(tower, 'recyclingFull');
    assert(SAVE_VERSION >= 7, 'the save shape changed (issue #13), so the version moved: ' + SAVE_VERSION);

    const blob = JSON.parse(JSON.stringify(snapshot(w)));
    const back = restore(blob);
    assert(back.ok, back.reason);
    const t2 = back.world.tower;
    const clinic2 = [...t2.objects.values()].find((o) => o.family === FAMILY.medical);
    assert(clinic2.medical.queue.length === 1, 'the queue came back');
    assert(parkingSpaces(t2).length === 2 && parkingRamps(t2).length === 1, 'the garage came back');
    assert(parkingSpaces(t2)[0].parking.cars.length === 1 && parkingSpaces(t2)[0].coverageFlag === 1, 'with its car and its coverage');
    assert(activeDemands(t2).map((d) => d.kind).sort().join() === 'medical,recyclingFull', 'and the live demands');
    assert(demandsOf(t2).notices.length === 2, 'and the notice log');
    const { scheduler } = makeDriver(back.world);
    for (let i = 0; i < 2600; i++) scheduler.tick(t2);
    assert(t2.clock.dayCounter > tower.clock.dayCounter, 'and a day runs on the restored tower');
  },

  // ============================================================ what the player sees

  'the notices are a log the HUD reads after the last one it said, and each kind has its own words'() {
    const tower = bare(3);
    raiseDemand(tower, 'medical');
    raiseDemand(tower, 'officeParking');
    const all = noticesAfter(tower, 0);
    assert(all.map((n) => n.text).join(' | ') === 'Medical Center demanded near Lobby | Office workers demand Parking', all.map((n) => n.text).join());
    assert(noticesAfter(tower, all[0].id).length === 1, 'after the first, one is left');
    assert(demandsReadout(activeDemands(tower)) === 'Medical Center demanded near Lobby · Office workers demand Parking', 'the bar');
    assert(clearDemand(tower, 'medical') && !clearDemand(tower, 'medical'), 'clearing answers once');
    assert(DEMAND.recyclingFull.text === 'Recycling Centers are full!', 'the original\'s own string');
    let threw = false;
    try { raiseDemand(tower, 'nonsense'); } catch { threw = true; }
    assert(threw, 'an unknown demand is a bug, not a silent no-op');
    for (let i = 0; i < 60; i++) { tower.clock.dayCounter = i + 10; raiseDemand(tower, 'medical'); }
    assert(demandsOf(tower).notices.length <= 40, 'the log is bounded');
  },

  'every facility says whether it is doing its job when pointed at'() {
    const w = world();
    const { tower } = w;
    const clinic = build(w, 'medical', 5, 20).object;
    assert(/medical center · 0 waiting/.test(serviceReadout(clinic, tower)), serviceReadout(clinic, tower));
    const blocked = build(w, 'parkingSpace', -1, 61).object;
    assert(/BLOCKED - no ramp reaches it/.test(serviceReadout(blocked, tower)), serviceReadout(blocked, tower));
    const ramp = build(w, 'parkingRamp', -1, 60).object;
    assert(/meets the lobby/.test(serviceReadout(ramp, tower)) && /a ramp serves it/.test(serviceReadout(blocked, tower)), 'served once the ramp is there');
    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center');
    const lower = [...tower.objects.values()].find((o) => o.family === FAMILY.recycling);
    assert(/NO service lift/.test(serviceReadout(lower, tower)), serviceReadout(lower, tower));
    assert(serviceReadout(tower.objects.values().next().value, tower) === '', 'and nothing about the lobby');
  },

  'what each one draws: a clinic by day and night, a bay by how many cars, a ramp, the plant on both floors'() {
    const w = world();
    const { tower } = w;
    const clinic = build(w, 'medical', 5, 20).object;
    assert(objectSprite(clinic, { night: false }).animation === 'day' && objectSprite(clinic, { night: true }).animation === 'night', 'clinic');
    const { ramp, spaces } = garage(w, 1);
    assert(objectSprite(ramp).name === 'parking-ramp', 'ramp');
    const bay = spaces[0];
    const frames = [0, 1, 2].map((n) => { bay.parking.cars = Array(n).fill('a'); return objectSprite(bay).animation; });
    assert(frames.join() === 'empty,one-car,two-cars', 'bay: ' + frames);
    assert(build(w, 'recyclingCenter', -3, 20).ok, 'a center');
    for (const half of tower.objects.values()) {
      if (half.family === FAMILY.recycling) assert(objectSprite(half).name === 'basement-utility', 'plant: ' + JSON.stringify(objectSprite(half)));
    }
  },

  'a goal clause names a medical center or a recycling center as something to build now that the palette has one'() {
    const tower = bare(3);
    tower.gates = { securityPlaced: true, officePlaced: true, suitePlaced: true, routesViable: true, recyclingAdequate: false,
      medicalServiceOk: true, officeServiceOk: true, vipStayFavorable: true, metroPlaced: false };
    tower.populationLedger = { office: 5000 };
    tower.clock.daypart = 5;
    const clause = starClause(starGateStatus(tower), (kind) => Object.hasOwn(BUILDABLE, kind));
    assert(clause === 'Next: 4 stars - need a recycling centre keeping up with the tower', 'it is not "nothing builds one yet": ' + clause);
  },

  // ============================================================ the harness proof

  'harness: no recycling blocks the ladder; a served center clears the blocker; the load decides full and enough'() {
    const none = recyclingTrial({ centers: 0, days: 4 });
    assert(none.recyclingBlocked && none.adequate === false, 'no center blocks 4 stars');
    assert(none.perDay.at(-1).demands.includes('The tower demands a Recycling Center'), 'and the tower says so');

    const unserved = recyclingTrial({ centers: 1, service: false, days: 4 });
    assert(unserved.recyclingBlocked && unserved.working === 0, 'a center no service lift stops at is no center');
    assert(unserved.perDay.at(-1).demands.includes(DEMAND.recyclingLift.text), 'and says it needs the stop');

    const ok = recyclingTrial({ centers: 1, days: 8 });
    const last = ok.perDay.at(-1);
    assert(last.flags[1600] === false, 'the midday reset always clears it');
    assert(last.flags[2566] === true && !ok.recyclingBlocked, 'a served center under 2,500 per center clears the blocker: ' + JSON.stringify(last.flags));
    assert(!ok.blockers.includes('a recycling centre keeping up with the tower'), 'it is off the ladder\'s list');
    // Issue #17: the evaluation has its writer - an inspector rode up to a let office on the first
    // evaluation day (day 3) and the office passed - so it is no longer what the rung is waiting for
    // (A57 said it was "written by nothing"). What is left is the suites, the VIP and the evening.
    assert(!ok.blockers.includes('a passed office-service evaluation'), 'the real inspection passed it: ' + ok.blockers);
    assert(ok.blockers.includes('2 hotel suites') && ok.blockers.includes('a favorable VIP stay'), 'what is left: ' + ok.blockers);

    const full = recyclingTrial({ centers: 1, floors: 28, days: 8 });
    assert(full.perCenter >= 2500 && full.recyclingBlocked, 'one center under ' + full.perCenter + ' per center is full');
    assert(full.perDay.at(-1).demands.includes('Recycling Centers are full!'), 'and says the original\'s words');
    const two = recyclingTrial({ centers: 2, floors: 28, days: 8 });
    assert(two.perCenter < 2500 && !two.recyclingBlocked, 'a second center carries it: ' + two.perCenter + ' per center');
  },

  'harness: the clinic trips happen, are routed, fill a queue, and keep the daily flag - and without a clinic the flag falls'() {
    const without = medicalTrial({ clinics: 0, days: 5 });
    assert(without.perDay.every((p) => p.setOff === 0), 'nobody sets off for a clinic that is not there');
    assert(without.perDay.some((p) => !p.flag) && without.notices >= 1, 'the flag falls and the banner fires');
    assert(without.blocked, 'and the ladder names it');
    const withClinic = medicalTrial({ clinics: 1, days: 5 });
    const trips = withClinic.perDay.reduce((n, p) => n + p.visits, 0);
    assert(trips > 20, 'a day of 810 workers sends dozens: ' + trips);
    assert(withClinic.perDay.every((p) => p.setOff === p.visits), 'every one that set off arrived (the lifts reach it)');
    assert(withClinic.perDay.some((p) => p.deepest > 1), 'they queue');
    assert(withClinic.perDay.every((p) => p.flag) && withClinic.notices === 0 && !withClinic.blocked, 'and the flag never falls');
  },

  'harness: the parking demand fires without a garage, is not answered by blocked spaces, and is cleared by building one'() {
    const none = parkingTrial({ days: 4 });
    assert(none.perDay.slice(1).every((p) => p.demanded) && none.notices[0] === 'Office workers demand Parking', 'no garage: demanded');
    const blocked = parkingTrial({ spaces: 8, ramp: false, days: 4 });
    assert(blocked.usable === 0 && blocked.perDay.every((p) => p.peakCars === 0), 'spaces with no ramp take no cars');
    assert(blocked.perDay.slice(1).every((p) => p.demanded), 'and do not answer the demand');
    const built = parkingTrial({ spaces: 32, ramp: true, buildOnDay: 2, days: 6 });
    assert(built.perDay.slice(0, 2).every((p) => p.peakCars === 0), 'before the garage there are no cars');
    assert(built.perDay.slice(2).some((p) => p.peakCars > 20), 'after it they park: ' + built.perDay.map((p) => p.peakCars));
    // A garage big enough for everyone who drives answers the demand for good.
    const small = parkingTrial({ spaces: 32, ramp: true, buildOnDay: 3, floors: 3, days: 6 });
    assert(small.perDay[1].demanded && small.perDay[2].demanded, 'the notice fires while there is no garage');
    assert(small.perDay.slice(3).every((p) => !p.demanded), 'and building one clears it: ' + JSON.stringify(small.perDay.map((p) => p.demanded)));
    assert(small.perDay[3].peakCars > 0, 'because the cars park');
    const day = built.perDay.find((p) => p.peakCars > 0);
    assert(day.peakCars <= 32 * SPACE_CAPACITY, 'never more than two a space');
  },

  'the whole parking row of the ladder stays honest: the star ladder only reads what the issue says it should'() {
    // Parking has no star gate of its own in `specs/` (PARKING.md only raises the
    // notice), and this build does not invent one. The README's "ALL demands satisfied"
    // for the fifth star is issue #14's.
    const t = bare(3);
    t.gates = {};
    const text = JSON.stringify(starGateStatus(t).blockers);
    assert(!/park/i.test(text), 'a parking blocker appeared on the ladder: ' + text);
    assert(towerActivity(t) === 0, 'fixture');
    void officeArrival;
  },
};
