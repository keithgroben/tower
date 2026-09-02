/**
 * Carriers and cars, checked against `specs/ELEVATORS.md` rather than against
 * what the implementation happens to do.
 *
 * Every assertion cites a spec section. Where a number looks asymmetric — only
 * express moves three floors a step, only standard and service have a slow
 * band, a free slot is `0xff` and never `-1` — the test is pinning the
 * reference, and changing it is a deviation for `spec/DEVIATIONS.md`.
 */
import {
  ACTIVE_ROUTE_SLOTS, ASSIGNMENT_CAPACITY, CARRIER_MODE, DEPARTURE_SEQUENCE_TICKS,
  FREE_SLOT, MAX_CARRIERS, MAX_CARS_PER_CARRIER, MAX_SERVED_SPAN, MOTION_STEP_BY_MODE,
  NO_TARGET_FLOOR, NO_TRANSFER_FLOOR,
  PASSENGER_CAPACITY, QUEUE_CAPACITY, SCHEDULE_SLOTS, SETTLE_BY_MODE, SHAFT_WIDTH,
  addCar, advanceCarOneStep, advanceCarState, assignCarToFloorRequest, carrierSlotIndex,
  carrierSpansFloor, carrierStopsAtFloor, computeCarMotionMode, createCarrier, createRing,
  dispatchCarArrivals, drainFloorQueue, enqueueRequest, expressSlotIndex, floorQueueCount,
  isExpressStopFloor, maxTopFloorFor, ringIsFull, ringPush, ringShift, scheduleIndex,
  selectNextTargetFloor, shouldCarDepart,
} from '../src/games/tower/sim/elevators.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const clockAt = (dayTick, daypart = 0, calendarPhase = false) => ({ dayTick, daypart, calendarPhase });

/** A plain standard shaft with one car, for the tests that need a car at all. */
function shaft({ mode = CARRIER_MODE.STANDARD, bottomFloor = 0, topFloor = 20, column = 0, cars = 1 } = {}) {
  const carrier = createCarrier({ id: 0, mode, bottomFloor, topFloor, column });
  for (let i = 0; i < cars; i++) addCar(carrier, bottomFloor);
  return carrier;
}

/** The family seam a drain needs, with nothing family-specific in it. */
const passthroughContext = (targets) => ({
  targetFloorOf: (ref) => targets.get(ref),
  chooseTransferFloor: (carrier, ref, currentFloor, targetFloor) => targetFloor,
  arrivals: [],
});

export const tests = {
  // ------------------------------------------------------- carrier records

  'the three carrier types carry the reference’s own numbers'() {
    // specs/ELEVATORS.md § Carrier Types, the property table.
    assert(JSON.stringify(SHAFT_WIDTH) === JSON.stringify([6, 4, 4]),
      'shaft widths are express 6, standard 4, service 4; got ' + SHAFT_WIDTH.join(','));
    assert(JSON.stringify(ASSIGNMENT_CAPACITY) === JSON.stringify([42, 21, 21]),
      'assignment capacities are 42/21/21; got ' + ASSIGNMENT_CAPACITY.join(','));
    assert(JSON.stringify(PASSENGER_CAPACITY) === JSON.stringify([36, 17, 17]),
      'manual passenger capacities are 36/17/17; got ' + PASSENGER_CAPACITY.join(','));
    // § Slot Limits.
    assert(MAX_CARRIERS === 24, 'the tower holds 24 carriers');
    assert(MAX_CARS_PER_CARRIER === 8, 'a carrier holds 8 cars');
    assert(QUEUE_CAPACITY === 40, 'a floor/direction queue holds 40');
    assert(ACTIVE_ROUTE_SLOTS === 42, 'a car has 42 physical route slots');
  },

  /**
   * The one that decides whether a tall tower is even buildable on one shaft.
   * A standard or service carrier spans at most 31 floors *inclusive*, so
   * floors 0..30 is legal and 0..31 is not. Express is exempt: it does not
   * serve a contiguous range at all.
   */
  'a standard shaft spans at most 31 floors, and express is exempt'() {
    // specs/ELEVATORS.md § Carrier Types, "contiguous range, max 31 floors".
    assert(MAX_SERVED_SPAN === 31, 'the contiguous span limit is 31 floors');

    const legal = createCarrier({ id: 0, mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 30 });
    assert(legal.topFloor - legal.bottomFloor + 1 === 31, '0..30 should be exactly 31 floors');

    let threw = false;
    try {
      createCarrier({ id: 1, mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 31 });
    } catch { threw = true; }
    assert(threw, '32 floors on a standard shaft was accepted; the limit is 31');

    let serviceThrew = false;
    try {
      createCarrier({ id: 2, mode: CARRIER_MODE.SERVICE, bottomFloor: -5, topFloor: 26 });
    } catch { serviceThrew = true; }
    assert(serviceThrew, 'service carriers are capped at 31 floors too (-5..26 is 32)');

    // Express serves a fixed slot set, so the contiguous cap does not apply.
    const express = createCarrier({ id: 3, mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 89 });
    assert(express.topFloor - express.bottomFloor + 1 === 99, 'an express shaft may exceed 31 floors');
    assert(maxTopFloorFor(CARRIER_MODE.STANDARD, 4) === 34, 'a standard shaft from 4 tops out at 34');
  },

  /**
   * The sky-lobby slot map, translated out of EXE indices. The reference
   * writes floors 1-10 and `(floor - 10) % 15 == 14`; logical floors are
   * `exe - 10`, so that is B9..ground and 14, 29, 44, 59, 74, 89.
   */
  'express serves the basements, the lobby and the sky lobbies, and nothing else'() {
    // specs/ELEVATORS.md § Served-Floor Mapping.
    // EXE 1..10 -> slots 0..9, i.e. logical -9..0.
    const basements = [[-9, 0], [-8, 1], [-1, 8], [0, 9]];
    for (const [floor, slot] of basements) {
      assert(expressSlotIndex(floor) === slot,
        'logical floor ' + floor + ' (EXE ' + (floor + 10) + ') should be slot ' + slot
        + ', got ' + expressSlotIndex(floor));
    }
    // EXE 24, 39, 54, 69, 84, 99 -> slot (exe - 10) / 15 + 10 -> 10..15.
    const skyLobbies = [[14, 10], [29, 11], [44, 12], [59, 13], [74, 14], [89, 15]];
    for (const [floor, slot] of skyLobbies) {
      assert(expressSlotIndex(floor) === slot,
        'sky lobby at logical ' + floor + ' (EXE ' + (floor + 10) + ') should be slot ' + slot
        + ', got ' + expressSlotIndex(floor));
      assert(isExpressStopFloor(floor), 'logical ' + floor + ' should be an express stop');
    }
    // Everything else is not served. The neighbours of each sky lobby are the
    // interesting negatives: an off-by-one in the cadence lands on 13 or 15.
    for (const floor of [-11, -10, 1, 5, 13, 15, 28, 30, 43, 45, 88, 90]) {
      assert(expressSlotIndex(floor) === -1,
        'logical floor ' + floor + ' is not an express stop but mapped to slot ' + expressSlotIndex(floor));
      assert(!isExpressStopFloor(floor), 'logical ' + floor + ' should not be an express stop');
    }
  },

  'a carrier spans floors it does not stop at'() {
    // § Served-Floor Mapping: the span and the served set are different things,
    // and conflating them is what makes an express car stop everywhere.
    const express = createCarrier({ id: 0, mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 44 });
    assert(carrierSpansFloor(express, 20), 'floor 20 is inside the express shaft');
    assert(!carrierStopsAtFloor(express, 20), 'an express car must not stop at floor 20');
    assert(carrierStopsAtFloor(express, 14), 'an express car stops at the sky lobby on 14');

    const standard = createCarrier({ id: 1, mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 20 });
    assert(carrierStopsAtFloor(standard, 20), 'a standard car stops at its top floor');
    assert(!carrierStopsAtFloor(standard, 21), 'floor 21 is outside a 0..20 shaft');
    assert(carrierSlotIndex(standard, 7) === 7, 'standard slots index linearly off the bottom floor');

    // The player's per-floor stop toggle removes a floor from the served set.
    standard.stopEnabled[7] = 0;
    assert(!carrierStopsAtFloor(standard, 7), 'a switched-off stop is not served');
    assert(carrierSpansFloor(standard, 7), '...but the shaft still spans it');
  },

  'a shaft takes eight cars and refuses the ninth'() {
    // § Slot Limits: maximum cars per carrier 8.
    const carrier = createCarrier({ id: 0, bottomFloor: 0, topFloor: 10 });
    for (let i = 0; i < MAX_CARS_PER_CARRIER; i++) {
      assert(addCar(carrier, 0) !== null, 'car ' + i + ' was refused below the limit');
    }
    assert(addCar(carrier, 0) === null, 'a ninth car was accepted');
    assert(carrier.cars.length === 8, 'the shaft ended up with ' + carrier.cars.length + ' cars');
  },

  // ---------------------------------------------------------------- queues

  'the floor queue is a 40-entry ring that wraps and refuses the 41st'() {
    // § Queue Drain: enqueue at (head + count) % 40, dequeue from head.
    const ring = createRing();
    for (let i = 0; i < QUEUE_CAPACITY; i++) {
      assert(ringPush(ring, 'r' + i), 'push ' + i + ' was refused below the 40-entry limit');
    }
    assert(ringIsFull(ring), 'a 40-entry ring should read as full');
    assert(!ringPush(ring, 'overflow'), 'the 41st entry was accepted; 40 is the queue-full condition');

    // Drain ten, refill ten: head has moved, and FIFO order must survive it.
    for (let i = 0; i < 10; i++) {
      assert(ringShift(ring) === 'r' + i, 'the ring did not dequeue in FIFO order');
    }
    assert(ring.head === 10, 'head should have advanced to 10, got ' + ring.head);
    for (let i = 0; i < 10; i++) assert(ringPush(ring, 'w' + i), 'refill ' + i + ' was refused');
    assert(ring.count === 40, 'the ring should be full again, count is ' + ring.count);
    for (let i = 10; i < 40; i++) {
      assert(ringShift(ring) === 'r' + i, 'wraparound lost the original order at ' + i);
    }
    assert(ringShift(ring) === 'w0', 'the wrapped entries came back out of order');
  },

  'a full queue refuses the request rather than overwriting one'() {
    // § Queues: "the queue-full sentinel is the literal count 40". A silently
    // overwritten head would delete a waiting person, and the old prototype's
    // worst bug class was exactly that — losing riders and reporting shorter
    // waits for it.
    const carrier = shaft();
    for (let i = 0; i < QUEUE_CAPACITY; i++) {
      assert(enqueueRequest(carrier, 'r' + i, 0, 1), 'enqueue ' + i + ' failed below the limit');
    }
    assert(floorQueueCount(carrier, 0, 1) === 40, 'the up queue at floor 0 should hold 40');
    assert(enqueueRequest(carrier, 'late', 0, 1) === false,
      'the 41st enqueue reported success; the resolver would then return 2 instead of 0');
    assert(floorQueueCount(carrier, 0, 1) === 40, 'the full queue changed size');
    // The other direction is a separate ring and is untouched.
    assert(floorQueueCount(carrier, 0, 0) === 0, 'the down queue at floor 0 should still be empty');
    assert(enqueueRequest(carrier, 'down', 0, 0), 'the down queue should still accept requests');
  },

  // ---------------------------------------------------------------- motion

  /**
   * The asymmetry is the rule. Only express reaches mode 3 (three floors a
   * step); only standard and service have the slow band, mode 1. A tidier
   * table would be wrong in both directions.
   */
  'only express moves three floors a step, and only the others go slow'() {
    // § Motion Profile, both tables.
    const express = shaft({ mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 44 });
    // 0..30 is the widest a standard shaft may be, so the distances below are
    // the largest the 31-floor limit allows a standard car to see.
    const standard = shaft({ mode: CARRIER_MODE.STANDARD, bottomFloor: 0, topFloor: 30 });
    const at = (carrier, currentFloor, prevFloor, targetFloor) => {
      const car = carrier.cars[0];
      Object.assign(car, { currentFloor, prevFloor, targetFloor });
      return computeCarMotionMode(carrier, car);
    };

    // dist_to_target < 2 OR dist_from_prev < 2 -> mode 0, both types.
    assert(at(express, 10, 0, 11) === 0, 'express within one floor of the target is mode 0');
    assert(at(standard, 10, 0, 11) === 0, 'standard within one floor of the target is mode 0');
    assert(at(express, 10, 9, 30) === 0, 'express one floor off its previous stop is mode 0');

    // Express: both distances > 4 -> mode 3. Standard: never.
    assert(at(express, 10, 0, 20) === 3, 'express with 10 floors either side should be fast (mode 3)');
    assert(at(standard, 10, 0, 20) === 2, 'standard with the same distances must be mode 2, never 3');

    // Express: exactly 4 is not "> 4", so it falls to normal.
    assert(at(express, 10, 0, 14) === 2, 'express at exactly 4 from the target is mode 2, not 3');

    // Standard: either distance < 4 -> the slow band express does not have.
    assert(at(standard, 10, 7, 20) === 1, 'standard 3 floors past its last stop is the slow band');
    assert(at(express, 10, 7, 20) === 2, 'express has no slow band; 3 floors past is mode 2');

    assert(JSON.stringify(MOTION_STEP_BY_MODE) === JSON.stringify([1, 1, 1, 3]),
      'only mode 3 covers three floors a step');
  },

  'settle animates modes 0 and 1 only, which is what sets ticks per floor'() {
    // § Motion Profile: mode 0 sets settle 5 (6 ticks/floor), mode 1 sets 2
    // (3 ticks/floor), modes 2 and 3 never animate (1 and 1/3 ticks/floor).
    assert(JSON.stringify(SETTLE_BY_MODE) === JSON.stringify([5, 2, 0, 0]),
      'settle seeds are 5, 2, 0, 0 by mode; got ' + SETTLE_BY_MODE.join(','));

    const express = shaft({ mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 44 });
    const car = express.cars[0];
    Object.assign(car, { currentFloor: 10, prevFloor: 0, targetFloor: 20 });
    advanceCarOneStep(express, car);
    assert(car.currentFloor === 13, 'a fast step covers three floors, landed on ' + car.currentFloor);
    assert(car.settle === 0, 'mode 3 must not animate, settle is ' + car.settle);

    const standard = shaft({ bottomFloor: 0, topFloor: 30 });
    const slow = standard.cars[0];
    Object.assign(slow, { currentFloor: 10, prevFloor: 7, targetFloor: 20 });
    advanceCarOneStep(standard, slow);
    assert(slow.currentFloor === 11, 'a slow step covers one floor');
    assert(slow.settle === 2, 'mode 1 seeds settle 2, got ' + slow.settle);

    Object.assign(slow, { currentFloor: 10, prevFloor: 0, targetFloor: 11, settle: 0 });
    advanceCarOneStep(standard, slow);
    assert(slow.settle === 5, 'mode 0 seeds settle 5, got ' + slow.settle);
  },

  /**
   * The bound the motion table implies rather than states: a car that sails
   * past its target oscillates forever and never opens its doors. Mode 3 is
   * the only stride longer than a floor and it needs `dist_to_target > 4`, so
   * it cannot pass a target — but that is an emergent property of two separate
   * numbers in § Motion Profile, and swapping either one breaks it silently.
   * So it is swept rather than spot-checked.
   */
  'no motion mode can step past its target, from anywhere in the shaft'() {
    // § Motion Profile, both tables, plus MOTION_STEP_BY_MODE.
    for (const mode of [CARRIER_MODE.EXPRESS, CARRIER_MODE.STANDARD, CARRIER_MODE.SERVICE]) {
      const carrier = shaft({ mode, bottomFloor: 0, topFloor: 30 });
      const car = carrier.cars[0];
      for (let current = 0; current <= 30; current++) {
        for (let target = 0; target <= 30; target++) {
          if (target === current) continue;   // re-targets rather than stepping
          for (const prev of [0, current, 15, 30]) {
            Object.assign(car, {
              currentFloor: current, prevFloor: prev, targetFloor: target, settle: 0,
              directionFlag: target > current ? 1 : 0,
            });
            advanceCarOneStep(carrier, car, 0);
            const overshot = target > current ? car.currentFloor > target : car.currentFloor < target;
            assert(!overshot,
              'mode ' + mode + ': a car on ' + current + ' bound for ' + target + ' (prev ' + prev
              + ') landed on ' + car.currentFloor);
          }
        }
      }
    }
  },

  // ------------------------------------------------------- schedule tables

  'the schedule index is seven dayparts by two calendar phases'() {
    // § Schedule Tables: schedule_index = daypart_index + calendar_phase_flag * 7.
    assert(SCHEDULE_SLOTS === 14, 'there are 14 schedule slots');
    assert(scheduleIndex(clockAt(0, 0, false)) === 0, 'daypart 0, phase off is slot 0');
    assert(scheduleIndex(clockAt(0, 6, false)) === 6, 'daypart 6, phase off is slot 6');
    assert(scheduleIndex(clockAt(0, 0, true)) === 7, 'daypart 0, phase on is slot 7');
    assert(scheduleIndex(clockAt(0, 6, true)) === 13, 'daypart 6, phase on is slot 13');
  },

  'a newly placed carrier carries the placement defaults'() {
    // § Schedule Tables, "Placement default" column.
    const carrier = createCarrier({ id: 0, bottomFloor: 0, topFloor: 10 });
    assert(carrier.serviceFlags.every((v) => v === 1), 'service/schedule flags default to enabled (1)');
    assert(carrier.dispatchThreshold.every((v) => v === 5), 'dispatch thresholds default to 5');
    assert(carrier.expressMode.every((v) => v === 0), 'express mode defaults to off (0)');
    assert(carrier.dwellEnable.every((v) => v === 0), 'dwell/enable defaults to 0');
    assert(addCar(carrier, 0).scheduleFlag === 0, "a car's runtime schedule flag starts at 0");
  },

  /**
   * The schedule flag is what makes the morning and evening rushes: express-up
   * parks at the top when it has nothing to do, express-down at the bottom.
   */
  'the schedule flag decides where an idle car waits'() {
    // § Home Floor, "Target-floor selection".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    Object.assign(car, { currentFloor: 5, homeFloor: 3, directionFlag: 1 });

    car.scheduleFlag = 1;
    assert(selectNextTargetFloor(carrier, car, 0) === 20,
      'express-up with no work returns to the top served floor');
    car.scheduleFlag = 2;
    assert(selectNextTargetFloor(carrier, car, 0) === 0,
      'express-down with no work returns to the bottom served floor');
    car.scheduleFlag = 0;
    assert(selectNextTargetFloor(carrier, car, 0) === 3,
      'a normal car with no work returns to its home floor');
  },

  'a normal car with work it cannot see returns no target at all'() {
    // § Home Floor: "if still nothing found, returns -1 (no target)". -1 here
    // is a sentinel and not a floor, which is why the caller must not treat it
    // as B1 — see the callers of selectNextTargetFloor.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    // Not idle (something is pending) but nothing is tagged to THIS car.
    Object.assign(car, { currentFloor: 5, scheduleFlag: 0, pendingAssignmentCount: 1 });
    carrier.upAssignedCar[10] = 2;      // belongs to car index 1, not this one
    const target = selectNextTargetFloor(carrier, car, 0);
    assert(target === NO_TARGET_FLOOR, 'a car with no work of its own should report no target');
    assert(target !== -1, '-1 would be B1 here, not "no target" — see NO_TARGET_FLOOR');
  },

  'the express-mode table is reloaded when a car reaches a served endpoint'() {
    // § Departure Rules: "At top and bottom served floors, the car's runtime
    // schedule_flag is reloaded from the carrier's per-daypart express-mode
    // table." This is the only path that turns the rush modes on.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    const clock = clockAt(100, 0, false);
    carrier.expressMode[scheduleIndex(clock)] = 1;

    Object.assign(car, { currentFloor: 10, targetFloor: 10, dwell: 0, settle: 0, scheduleFlag: 0 });
    advanceCarState(carrier, car, 0, clock);
    assert(car.scheduleFlag === 0, 'the flag must not reload at an intermediate floor');

    Object.assign(car, { currentFloor: 0, targetFloor: 0, dwell: 0, settle: 0, scheduleFlag: 0 });
    advanceCarState(carrier, car, 0, clock);
    assert(car.scheduleFlag === 1, 'the flag should reload to 1 at the bottom served floor');
    assert(car.dwell === DEPARTURE_SEQUENCE_TICKS, 'arrival sets dwell to 5, got ' + car.dwell);
  },

  // -------------------------------------------------------------- dwelling

  'a car leaves at once when full, or when its dwell slot is zero'() {
    // § Departure Rules, dwell-threshold rule.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    const clock = clockAt(1000, 0, false);
    const slot = scheduleIndex(clock);

    carrier.dwellEnable[slot] = 4;
    Object.assign(car, { assignedCount: carrier.assignmentCapacity, currentFloor: 0, departureTick: 1000 });
    assert(shouldCarDepart(carrier, car, clock), 'a car at assignment capacity departs immediately');

    car.assignedCount = 0;
    carrier.dwellEnable[slot] = 0;
    assert(shouldCarDepart(carrier, car, clock), 'a zero dwell slot departs immediately');

    // Otherwise: depart when abs(day_tick - departure_timestamp) > slot * 30.
    carrier.dwellEnable[slot] = 2;                       // threshold 60 ticks
    Object.assign(car, { currentFloor: 0, homeFloor: 0, departureTick: 1000 });
    assert(!shouldCarDepart(carrier, car, clockAt(1060, 0, false)),
      'at exactly 60 ticks the rule is "greater than", so the car waits');
    assert(shouldCarDepart(carrier, car, clockAt(1061, 0, false)),
      'past 60 ticks (2 * 30) the car should leave');
  },

  // ----------------------------------------------------------- assignment

  'a car already standing at the floor is taken immediately'() {
    // § Floor Assignment, "immediate early-accept".
    const carrier = createCarrier({ id: 0, bottomFloor: 0, topFloor: 20 });
    addCar(carrier, 0);                                   // car 0, far away
    const waiting = addCar(carrier, 10);                  // car 1, right here
    Object.assign(waiting, { currentFloor: 10, dwell: 0, directionFlag: 1 });
    assert(assignCarToFloorRequest(carrier, 10, 1) === 1,
      'the car standing at the requested floor should be chosen outright');
  },

  'the moving car wins only while it beats idle-at-home by less than the threshold'() {
    // § Floor Assignment: "if moving_cost - idle_home_cost < threshold, choose
    // the moving candidate ... exact equality breaks toward the idle-home
    // candidate." The default threshold is 5.
    const build = (movingFloor) => {
      const carrier = createCarrier({ id: 0, bottomFloor: 0, topFloor: 20 });
      const idle = addCar(carrier, 5);                    // car 0: idle at home 5
      const moving = addCar(carrier, 0);                  // car 1: sweeping up
      Object.assign(idle, { currentFloor: 5, homeFloor: 5, dwell: 0 });
      Object.assign(moving, {
        currentFloor: movingFloor, homeFloor: 0, targetFloor: 20, directionFlag: 1,
        pendingAssignmentCount: 1,
      });
      return carrier;
    };

    // Request floor 10 up. Idle-home cost is |10 - 5| = 5 throughout.
    // Moving at 3 -> cost 7; 7 - 5 = 2 < 5 -> the moving car.
    assert(assignCarToFloorRequest(build(3), 10, 1) === 1,
      'a moving car only 2 over the idle car should win');
    // Moving at 0 -> cost 10; 10 - 5 = 5, which is NOT < 5 -> idle at home.
    assert(assignCarToFloorRequest(build(0), 10, 1) === 0,
      'at exactly the threshold the idle-home car must win');
  },

  'with no moving car at all the selector falls back to car zero'() {
    // § Floor Assignment, "Edge case note": this is deliberate in the original
    // and looks like a bug, so it gets pinned rather than fixed. Car 1 is much
    // nearer and still loses.
    const carrier = createCarrier({ id: 0, bottomFloor: 0, topFloor: 20 });
    const far = addCar(carrier, 20);
    const near = addCar(carrier, 9);
    Object.assign(far, { currentFloor: 20, homeFloor: 20, dwell: 0 });
    Object.assign(near, { currentFloor: 9, homeFloor: 9, dwell: 0 });
    assert(assignCarToFloorRequest(carrier, 10, 1) === 0,
      'with only idle-home candidates the selector takes car 0, not the nearest');
  },

  'the first request onto an empty ring is what raises a floor call'() {
    // § Queues: "assigns a car to the floor request if this was the first
    // entry for that queue".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    assert(carrier.upAssignedCar[5] === 0, 'no call should be raised before anyone queues');
    enqueueRequest(carrier, 'a', 5, 1);
    assert(carrier.upAssignedCar[5] === 1, 'the first enqueue should assign car 0 (stored 1-based)');
    carrier.upAssignedCar[5] = 2;                         // pretend car 1 took it
    enqueueRequest(carrier, 'b', 5, 1);
    assert(carrier.upAssignedCar[5] === 2,
      'a second enqueue onto an occupied ring must not re-assign the floor');
  },

  // ------------------------------------------------------------ drain

  /**
   * The trap `CLAUDE.md` names outright: `-1` is a real floor here, so a `-1`
   * "empty" sentinel collides with B1. Two riders bound for B1 must occupy two
   * slots; with the wrong sentinel the second overwrites the first and a
   * passenger is silently deleted.
   */
  'a slot bound for B1 is not an empty slot'() {
    // § Queue Drain, "Active-slot behavior": free slot sentinel is 0xff.
    assert(FREE_SLOT === 0xff, 'the free-slot sentinel is 0xff');
    assert(FREE_SLOT !== -1, 'a -1 sentinel would collide with the first basement');

    const carrier = shaft({ bottomFloor: -5, topFloor: 10 });
    const car = carrier.cars[0];
    car.currentFloor = 0;
    enqueueRequest(carrier, 'a', 0, 0);
    enqueueRequest(carrier, 'b', 0, 0);
    const ctx = passthroughContext(new Map([['a', -1], ['b', -1]]));
    car.directionFlag = 0;
    const loaded = drainFloorQueue(carrier, car, 0, ctx);

    assert(loaded === 2, 'both riders should board, ' + loaded + ' did');
    assert(car.slots[0].ref === 'a' && car.slots[1].ref === 'b',
      'the two B1-bound riders share a slot: ' + JSON.stringify([car.slots[0], car.slots[1]]));
    assert(car.assignedCount === 2, 'the car should be carrying two');
  },

  'a car loads only as far as its assignment capacity'() {
    // § Queue Drain step 2/4: remaining_slots = assignment_capacity - assigned.
    // A standard car takes 21, not 42, even though 42 slots physically exist.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    car.currentFloor = 0;
    const targets = new Map();
    for (let i = 0; i < 25; i++) { enqueueRequest(carrier, 'r' + i, 0, 1); targets.set('r' + i, 10); }

    const loaded = drainFloorQueue(carrier, car, 0, passthroughContext(targets));
    assert(loaded === ASSIGNMENT_CAPACITY[CARRIER_MODE.STANDARD],
      'a standard car should load 21, loaded ' + loaded);
    assert(floorQueueCount(carrier, 0, 1) === 4, '4 riders should still be queued, ' + floorQueueCount(carrier, 0, 1) + ' are');
    assert(car.assignedCount === 21, 'assignedCount is ' + car.assignedCount);
  },

  'a rider whose transfer floor cannot be resolved goes back to its family'() {
    // § Queue Drain step 7: "if transfer-floor resolution fails, apply the
    // requeue-failure delay and force the actor back to its family dispatch
    // path". The requeue-failure delay is 0 ticks, so nothing is charged.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    car.currentFloor = 0;
    enqueueRequest(carrier, 'stuck', 0, 1);
    const returned = [];
    drainFloorQueue(carrier, car, 0, {
      targetFloorOf: () => 40,
      chooseTransferFloor: () => NO_TRANSFER_FLOOR,
      onRequeueFailure: (ref) => returned.push(ref),
    });
    assert(returned.length === 1 && returned[0] === 'stuck',
      'the unroutable rider was not handed back to its family');
    assert(car.assignedCount === 0, 'an unroutable rider must not board');
    assert(floorQueueCount(carrier, 0, 1) === 0, 'the rider was popped off the queue either way');
  },

  'arrival unloads exactly the riders bound for this floor'() {
    // § Arrival Dispatch, steps 1-4.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    car.currentFloor = 0;
    ['a', 'b', 'c'].forEach((ref) => enqueueRequest(carrier, ref, 0, 1));
    const targets = new Map([['a', 5], ['b', 10], ['c', 5]]);
    drainFloorQueue(carrier, car, 0, passthroughContext(targets));
    assert(car.assignedCount === 3, 'three riders should be aboard');

    const arrivals = [];
    car.currentFloor = 5;
    const unloaded = dispatchCarArrivals(carrier, car, { onArrive: (ref, floor) => arrivals.push([ref, floor]) });
    assert(unloaded === 2, 'two riders are bound for floor 5, ' + unloaded + ' got off');
    assert(JSON.stringify(arrivals) === JSON.stringify([['a', 5], ['c', 5]]),
      'the wrong riders were handed back: ' + JSON.stringify(arrivals));
    assert(car.assignedCount === 1, 'one rider should remain aboard, ' + car.assignedCount + ' do');

    car.currentFloor = 10;
    assert(dispatchCarArrivals(carrier, car, {}) === 1, 'the last rider should get off at floor 10');
    assert(car.assignedCount === 0, 'the car should be empty');
    assert(car.slots.every((s) => s.destination === FREE_SLOT || s.ref === null),
      'a slot was left holding a rider that has already got off');
  },

  // ------------------------------------------------- the car state machine

  'boarding cannot begin while the car is still animating between floors'() {
    // § Door And Boarding Counters: "Boarding is only permitted once
    // settle == 0 — the arrival trigger (Branch A) cannot fire while a
    // sub-floor animation is in progress."
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    const clock = clockAt(500, 0, false);
    Object.assign(car, { currentFloor: 10, prevFloor: 10, targetFloor: 10, settle: 3, dwell: 0 });
    advanceCarState(carrier, car, 0, clock);
    assert(car.dwell === 0, 'the car started boarding mid-animation');
    assert(car.settle === 2, 'settle should have counted down to 2, it is ' + car.settle);
  },

  'the boarding countdown reloads to one when the car may not leave yet'() {
    // § Door And Boarding Counters: "If departure conditions are not met,
    // dwell reloads to 1, creating a one-tick retry loop."
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    const clock = clockAt(1000, 0, false);
    carrier.dwellEnable[scheduleIndex(clock)] = 2;         // wait up to 60 ticks
    Object.assign(car, {
      currentFloor: 0, homeFloor: 0, targetFloor: 0, settle: 0, dwell: 1,
      departureTick: 1000, assignedCount: 0,
    });
    advanceCarState(carrier, car, 0, clock);
    assert(car.dwell === 1, 'dwell should reload to 1 while the car is still waiting, got ' + car.dwell);
  },

  /**
   * The acceleration profile, end to end, and the test that catches the
   * subtlest thing in this file: `prev_floor` is the last floor the car
   * STOPPED at. Refresh it on every step and `dist_from_prev` is always 0, so
   * every car crawls in mode 0 for its whole journey — a tower that reads as
   * merely slow, never as broken.
   */
  'a car on a long run accelerates out of the stop and decelerates into the target'() {
    // § Motion Profile: mode is chosen from distance to target AND distance
    // from the previous stop, which is what produces slow-fast-slow.
    const run = (mode) => {
      const carrier = shaft({ mode, bottomFloor: 0, topFloor: 30 });
      const car = carrier.cars[0];
      Object.assign(car, {
        currentFloor: 0, prevFloor: 0, targetFloor: 30, directionFlag: 1, dwell: 0, settle: 0,
      });
      const modes = [];
      while (car.currentFloor < 30 && modes.length < 60) modes.push(advanceCarOneStep(carrier, car, 0));
      return { modes, car };
    };

    const standard = run(CARRIER_MODE.STANDARD);
    assert(standard.car.currentFloor === 30,
      'the car should have reached floor 30, it is on ' + standard.car.currentFloor);
    assert(standard.modes[0] === 0, 'the first step out of a stop is mode 0');
    assert(standard.modes[standard.modes.length - 1] === 0, 'the last step into the target is mode 0');
    assert(standard.modes.includes(1), 'a standard car should pass through its slow band');
    assert(standard.modes.includes(2),
      'a standard car should reach full speed mid-run; it never left mode '
      + [...new Set(standard.modes)].join('/'));
    assert(!standard.modes.includes(3), 'a standard car must never reach the express stride');
    assert(standard.car.prevFloor === 0,
      'prevFloor is the last floor the car stopped at, not the last one it passed');

    const express = run(CARRIER_MODE.EXPRESS);
    assert(express.modes.includes(3), 'an express car should reach its three-floor stride mid-run');
    assert(express.modes.length < standard.modes.length,
      'express should take fewer steps over the same shaft: '
      + express.modes.length + ' against ' + standard.modes.length);
  },

  /**
   * The same acceleration rule, but driven through the real state machine
   * rather than the step helper. This is the one that catches a `prev_floor`
   * refreshed on every step: with that bug every floor costs the mode-0 rate
   * of 6 ticks and a 30-floor run takes 175 ticks instead of 41 — a tower that
   * reads as merely sluggish, never as broken.
   */
  'a long run is not spent at the mode-0 rate'() {
    // § Motion Profile, the "Ticks/floor" column: mode 0 costs 6 (1 move plus
    // 5 animation), mode 1 costs 3, and modes 2 and 3 cost 1 with no animation
    // at all.
    const run = (mode) => {
      const carrier = shaft({ mode, bottomFloor: 0, topFloor: 30 });
      const car = carrier.cars[0];
      Object.assign(car, {
        currentFloor: 0, prevFloor: 0, targetFloor: 30, directionFlag: 1,
        dwell: 0, settle: 0, arrivalSeen: 1,
      });
      const perFloor = [];
      let spent = 0;
      for (let tick = 1; tick <= 1000 && car.currentFloor < 30; tick++) {
        const before = car.currentFloor;
        advanceCarState(carrier, car, 0, clockAt(tick));
        spent += 1;
        if (car.currentFloor !== before) { perFloor.push(spent); spent = 0; }
      }
      return { perFloor, total: perFloor.reduce((a, b) => a + b, 0), car };
    };

    const standard = run(CARRIER_MODE.STANDARD);
    assert(standard.car.currentFloor === 30,
      'the car never reached floor 30, it stopped on ' + standard.car.currentFloor);
    assert(standard.total < 30 * 6,
      'a 30-floor run took ' + standard.total + ' ticks — the mode-0 rate for the whole '
      + 'journey is 180, so the car never accelerated out of its stop');
    assert(standard.perFloor.filter((t) => t === 1).length > 10,
      'most of a long run should be at the no-animation rate of 1 tick a floor; only '
      + standard.perFloor.filter((t) => t === 1).length + ' floors were');
    assert(standard.perFloor.includes(6),
      'the first floor out of a stop is mode 0 and costs 6 ticks');

    const express = run(CARRIER_MODE.EXPRESS);
    assert(express.perFloor.length < standard.perFloor.length,
      'express covers the shaft in fewer steps thanks to its 3-floor stride: '
      + express.perFloor.length + ' against ' + standard.perFloor.length);
    assert(express.total < standard.total,
      'express should reach the top sooner: ' + express.total + ' ticks against ' + standard.total);
  },

  /**
   * The narrow case `advance_car_position_one_step` exists for: a car standing
   * on its target with no room for anyone and nobody to drop here. It must
   * pick a new target before it moves, or it walks away from a floor it never
   * chose to leave and its riders are carried past their stop.
   */
  'a full car standing on its target picks a new one before it moves'() {
    // 1098:10e4: "When already at target on entry, recomputes target+direction
    // first (with prevFloor = cur latched before the recompute)."
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    Object.assign(car, {
      currentFloor: 5, prevFloor: 0, targetFloor: 5, directionFlag: 1,
      dwell: 0, settle: 0, assignedCount: carrier.assignmentCapacity,
    });
    car.destinationCountBySlot[10] = 1;          // one rider aboard, bound for 10

    advanceCarOneStep(carrier, car, 0);
    assert(car.targetFloor === 10,
      'the car should have re-targeted to its rider\u2019s floor, target is ' + car.targetFloor);
    assert(car.prevFloor === 5, 'the floor being left should be latched as prevFloor');
    assert(car.currentFloor === 6, 'and then it steps one floor toward the new target');
  },

  'a car with somewhere to be takes one step per tick'() {
    // § Car State Machine, idle-floor behaviour: "move one step toward the
    // current target".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    const clock = clockAt(500, 0, false);
    Object.assign(car, { currentFloor: 0, prevFloor: 0, targetFloor: 6, settle: 0, dwell: 0 });
    advanceCarState(carrier, car, 0, clock);
    assert(car.currentFloor === 1, 'the car should have stepped to floor 1, it is on ' + car.currentFloor);
    assert(car.prevFloor === 0, 'prevFloor should hold the floor just left');
  },
};
