/**
 * The tower state model, checked against the reference.
 *
 * The assertion this file exists for is the one the whole rebuild turns on:
 * **placing an office creates its six workers, and rents nothing.** The old
 * prototype spawned people only for rooms that were already let, which made
 * occupancy an input to traffic instead of an outcome of it.
 */
import {
  FAMILY, GROUND_FLOOR, MAX_FLOOR, MIN_FLOOR, OCCUPANTS, STATE_PARKED,
  STATE_UNPLACED_OCCUPANT, TILES_PER_FLOOR, UNIT_STATUS,
  __resetIds, baseState, createTower, enterTransit, floorExists, floorLabel,
  isBasement, isInTransit, isRented, isSkyLobbyFloor, occupantsOf, placeObject,
  population, spanBlocked, zoneBand,
} from '../src/games/tower/sim/state.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const office = (floor = 1, left = 0, right = 5) =>
  ({ family: FAMILY.office, floor, left, right });

function towerWithOffice(floor = 1) {
  __resetIds();
  const tower = createTower();
  const placed = placeObject(tower, office(floor));
  assert(placed.ok, 'fixture could not place an office: ' + placed.reason);
  return { tower, object: placed.object };
}

export const tests = {
  // ------------------------------------------------------------- the world

  'the tower is 120 logical floors with the lobby at zero'() {
    // specs/DATA-MODEL.md § World Indexing.
    assert(MIN_FLOOR === -10 && MAX_FLOOR === 109, 'floor range is ' + MIN_FLOOR + '..' + MAX_FLOOR);
    assert(MAX_FLOOR - MIN_FLOOR + 1 === 120, 'there should be 120 logical floors');
    assert(GROUND_FLOOR === 0, 'the ground lobby is logical floor 0');
    assert(isBasement(-1) && !isBasement(0), 'B1 is logical -1 and the ground is not a basement');
    assert(floorExists(-10) && floorExists(109), 'the extremes are inside the tower');
    assert(!floorExists(-11) && !floorExists(110), 'the tower has no floors outside its range');
    assert(floorLabel(-1) === 'B1' && floorLabel(6) === 'F6', 'floor names read wrong');
  },

  /**
   * The EXE-to-logical translation is where quoted binary constants go wrong,
   * so the reference's own worked example is pinned here: EXE transfer-zone
   * centre 24 is logical 14 (specs/DATA-MODEL.md line 22).
   */
  'sky lobbies sit where the reference’s own translation puts them'() {
    const exeToLogical = (exe) => exe - 10;
    assert(exeToLogical(10) === GROUND_FLOOR, 'EXE 10 should be the ground lobby');
    assert(exeToLogical(24) === 14, 'EXE 24 should translate to logical 14');

    for (const floor of [14, 29, 44, 59, 74, 89]) {
      assert(isSkyLobbyFloor(floor), 'logical ' + floor + ' should be a sky lobby');
    }
    for (const floor of [0, 13, 15, 30, 45]) {
      assert(!isSkyLobbyFloor(floor), 'logical ' + floor + ' should NOT be a sky lobby');
    }
    // Zone bands: EXE (f - 9) / 15, translated. The ground is band 0.
    assert(zoneBand(0) === 0 && zoneBand(13) === 0, 'the first band should reach logical 13');
    assert(zoneBand(14) === 1, 'the first sky lobby should open band 1');
  },

  // ------------------------------------------------- the load-bearing rule

  'placing an office creates six workers and rents nothing'() {
    // specs/facility/OFFICE.md § Parity: Placement And Stored State — the
    // workers "are not created lazily at rental time".
    const { tower, object } = towerWithOffice();

    const workers = occupantsOf(tower, object);
    assert(workers.length === 6, 'an office should have 6 workers, got ' + workers.length);
    assert(OCCUPANTS[FAMILY.office] === 6, 'the office population constant moved');

    assert(!object.occupiedFlag, 'a newly placed office must not be occupied');
    assert(population(tower) === 0, 'a vacant office contributed ' + population(tower) + ' population');

    for (const [index, worker] of workers.entries()) {
      assert(worker.family === FAMILY.office, 'worker family is ' + worker.family + ', expected 7');
      assert(worker.occupantIndex === index, 'occupant indices should run 0..5 in order');
      assert(worker.state === STATE_UNPLACED_OCCUPANT && worker.state === 0x20,
        'a new worker starts in state 0x20, got 0x' + worker.state.toString(16));
      assert(worker.routeCarrier === null, 'a new worker should hold no route token');
      assert(worker.spawnFloor === null, 'a new worker should have no saved route floor');
      assert(worker.anchorFloor === object.floor, 'a worker is anchored to its office floor');
    }
  },

  /**
   * The distinction the old prototype never drew. Six people exist; none of
   * them count until transport lets one of them in.
   */
  'population counts tenants, not the people waiting to become them'() {
    const { tower, object } = towerWithOffice();
    assert(population(tower) === 0, 'vacant office should count zero');

    // `occupiedFlag` alone is NOT a lease. Since the bootstrap it means "these
    // tenants are being measured", and it is set on a vacant office before
    // anyone has reached it — counting on it reported 252 people in a tower
    // where 216 had a lease.
    object.occupiedFlag = true;
    assert(population(tower) === 0, 'a measured but unreached office must count nobody');

    object.unitStatus = 0;                  // what a successful route will do
    assert(population(tower) === 6, 'a rented office should count six');

    object.unitStatus = 0x10;               // and what an eviction undoes
    assert(population(tower) === 0, 'population did not fall when the tenant left');
    assert(occupantsOf(tower, object).length === 6, 'the workers should still exist after eviction');
  },

  'the initial stored state matches the reference field for field'() {
    // specs/facility/OFFICE.md § Parity: Placement And Stored State.
    const { object } = towerWithOffice();
    assert(object.unitStatus === 0x10, 'an office starts VACANT at 0x10, not in the open band');
    assert(!isRented(object.unitStatus), 'a freshly placed office must not read as rented');
    assert(object.rentLevel === 1, 'default placement tier is 1, got ' + object.rentLevel);
    assert(object.activationTickCount === 0, 'activation age starts at 0');
    assert(object.rebuildCountdown === 12, 'the deferred-init countdown is 12 at placement');
    assert(object.dirty === true, 'a placed object starts dirty');
    assert(object.evalLatch === true, 'the operational-evaluation latch is active from placement');

    // "operational score = unsampled / unset" — and NOT zero, because a zero
    // eval level is what closes an office. Scoring an unsampled office as 0
    // would evict a tenant it never had.
    assert(object.evalLevel === 0xff, 'a fresh office should be unsampled (0xff), not scored zero');
  },

  'rental status is a comparison against 0x0f and nothing else'() {
    // specs/facility/OFFICE.md: status above 0x0f reads "For Rent".
    assert(UNIT_STATUS.activeMax === 0x0f, 'the active band ends at 0x0f');
    assert(isRented(0x00) && isRented(0x0f), 'the open band should read as rented');
    assert(!isRented(0x10) && !isRented(0x18), '0x10 and above should read as For Rent');
  },

  // -------------------------------------------------------- state bands

  'bit 6 is the in-transit flag and the base state survives it'() {
    // specs/PEOPLE.md § Shared State-Code Convention.
    assert(enterTransit(0x00) === 0x40, '0x00 in transit is 0x40');
    assert(enterTransit(0x20) === 0x60, '0x20 in transit is 0x60');
    assert(isInTransit(0x45) && !isInTransit(0x05), 'the in-transit test reads the wrong bit');
    for (const state of [0x00, 0x05, 0x20, 0x27]) {
      assert(baseState(enterTransit(state)) === state,
        'base state was lost through transit for 0x' + state.toString(16));
    }
    assert(STATE_PARKED === 0x27, 'the parked state moved');
  },

  // --------------------------------------------------------- placement

  'a span has to be a real span, on a real floor, on the lot'() {
    __resetIds();
    const tower = createTower();
    const bad = [
      [{ ...office(), floor: 110 }, 'outside the tower'],
      [{ ...office(), floor: -11 }, 'outside the tower'],
      [{ ...office(), left: 5, right: 2 }, 'not a span'],
      [{ ...office(), left: -1 }, 'off the lot'],
      [{ ...office(), right: TILES_PER_FLOOR }, 'off the lot'],
    ];
    for (const [placement, why] of bad) {
      const result = placeObject(tower, placement);
      assert(!result.ok, 'accepted a placement that is ' + why + ': ' + JSON.stringify(placement));
      assert(typeof result.reason === 'string' && result.reason.length > 0, 'refused without a reason');
    }
    assert(tower.objects.size === 0, 'a refused placement still put something in the tower');
    assert(tower.actors.length === 0, 'a refused placement still created actors');
  },

  'two objects cannot share a tile, and neighbours can touch'() {
    __resetIds();
    const tower = createTower();
    assert(placeObject(tower, office(1, 10, 15)).ok, 'first office failed');

    for (const [left, right] of [[10, 15], [12, 13], [8, 11], [15, 20]]) {
      assert(spanBlocked(tower, 1, left, right), left + '..' + right + ' overlaps and should be blocked');
      assert(!placeObject(tower, office(1, left, right)).ok, left + '..' + right + ' was placed over an object');
    }
    // Directly abutting on either side is fine — that is a row of offices.
    assert(placeObject(tower, office(1, 16, 21)).ok, 'an abutting office to the right was refused');
    assert(placeObject(tower, office(1, 4, 9)).ok, 'an abutting office to the left was refused');
    // ...and a different floor never collides.
    assert(placeObject(tower, office(2, 10, 15)).ok, 'the floor above was treated as occupied');

    assert(tower.actors.length === 4 * 6, 'four offices should own 24 workers, got ' + tower.actors.length);
  },

  'the actor table is flat and in placement order, which the stride depends on'() {
    // specs/TIME.md § Entity Refresh Stride: the stride walks raw table order,
    // "not grouped by family or floor". So the table order IS the visitation
    // order, and RNG consumption order rides on it.
    __resetIds();
    const tower = createTower();
    placeObject(tower, office(1, 0, 5));
    placeObject(tower, office(3, 0, 5));

    assert(tower.actors.length === 12, 'expected 12 workers, got ' + tower.actors.length);
    const floors = tower.actors.map((a) => a.anchorFloor);
    assert(JSON.stringify(floors) === JSON.stringify([1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3]),
      'the actor table is not in placement order: ' + floors.join(','));
    const indices = tower.actors.slice(0, 6).map((a) => a.occupantIndex);
    assert(JSON.stringify(indices) === JSON.stringify([0, 1, 2, 3, 4, 5]),
      'occupant indices are not 0..5 in order: ' + indices.join(','));
  },

  'a tower starts with a one-storey lobby and a running clock'() {
    __resetIds();
    const tower = createTower({ seed: 7 });
    assert(tower.lobbyHeight === 1, 'lobby height starts at 1');
    assert(tower.clock.dayTick === 2533, 'a new tower should start on the reference’s opening tick');
    assert(tower.rng.state === 7, 'the tower did not take its seed');
    assert(tower.cash > 0, 'a new tower needs money to build with');
  },
};
