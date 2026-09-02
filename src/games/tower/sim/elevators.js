/**
 * Carriers and cars — the transport hardware.
 *
 * Spec: `specs/ELEVATORS.md` in the reference, cross-read against its
 * `apps/worker/src/sim/carriers/*` (which carries the Ghidra addresses this
 * file cites). Every number here is theirs.
 *
 * The vocabulary matters and the reference is strict about it:
 *
 * - a **carrier** is the shaft: mode, served-floor span, schedule tables,
 *   queue rings, transfer reachability, and up to 8 cars. Queueing and
 *   reachability are carrier-level.
 * - a **car** is one cab inside it. Motion, doors, dwell and assignments are
 *   car-level.
 *
 * Three things here will look like bugs and are not:
 *
 * 1. **The free active-route slot is `0xff`, not `-1`.** `-1` is a real floor
 *    in this game (it is B1), so a `-1` sentinel would collide with the first
 *    basement the moment anybody rode down to it. `CLAUDE.md` lists that exact
 *    mistake as already paid for once.
 *
 * 2. **Only express cars can move 3 floors a step.** Standard and service
 *    carriers have a slow band express lacks, and no fast band. Symmetry is
 *    not the rule here; `compute_car_motion_mode` is.
 *
 * 3. **An express carrier's slot table is not its span.** Express serves a
 *    fixed set of floors — the basements, the ground lobby, and the sky-lobby
 *    cadence — so its per-floor tables are 16 entries wide no matter how tall
 *    the shaft is. Standard and service index linearly off the bottom floor.
 *
 * Floors here are **logical**: 0 is the ground lobby, -1 is B1. The reference
 * quotes EXE indices where `logical = exe - 10`; every translation below is
 * commented at the point it happens.
 *
 * Pure and Node-runnable. Nothing in this file reads wall time or `Math.random`.
 */

// ---------------------------------------------------------------- constants

/** `specs/ELEVATORS.md` § Carrier Types. */
export const CARRIER_MODE = { EXPRESS: 0, STANDARD: 1, SERVICE: 2 };

/** Shaft width in tiles, indexed by carrier mode. */
export const SHAFT_WIDTH = [6, 4, 4];

/**
 * Logical assignment slots per car — what the sim actually enforces.
 * `specs/ELEVATORS.md` § Carrier Record, "Assignment capacities".
 */
export const ASSIGNMENT_CAPACITY = [42, 21, 21];

/**
 * The manual's passenger figures. Display only: the reference's dispatch and
 * departure rules read `assignment_capacity`, never this. Kept so the HUD has
 * the number the original printed rather than inventing one.
 */
export const PASSENGER_CAPACITY = [36, 17, 17];

/** `specs/ELEVATORS.md` § Slot Limits. */
export const MAX_CARRIERS = 24;
export const MAX_CARS_PER_CARRIER = 8;
export const QUEUE_CAPACITY = 40;
export const ACTIVE_ROUTE_SLOTS = 42;

/**
 * A standard or service shaft may span at most 31 floors, inclusive of both
 * ends. Express is exempt: it does not serve a contiguous range at all.
 * `specs/ELEVATORS.md` § Carrier Types, "Served floors".
 */
export const MAX_SERVED_SPAN = 31;

/**
 * Free active-route slot marker. See the header note: `0xff`, never `-1`.
 * `specs/ELEVATORS.md` § Queue Drain, "Active-slot behavior".
 */
export const FREE_SLOT = 0xff;

/**
 * "This car has nowhere to go" and "no transfer floor works".
 *
 * The reference returns `-1` for both, and can afford to: its floors are
 * EXE-indexed `0..119` and never negative. Ours are logical, so `-1` is B1 —
 * a real, common, reachable floor. Returning `-1` here would send an idle car
 * to the first basement and would read an unroutable rider as bound for it.
 * `null` is the sentinel because it cannot be mistaken for a floor by any
 * comparison, including the `>=` and `?.` ones `CLAUDE.md` lists as bugs that
 * look like guards.
 */
export const NO_TARGET_FLOOR = null;
export const NO_TRANSFER_FLOOR = null;

/** 7 dayparts x 2 calendar phases. `specs/ELEVATORS.md` § Schedule Tables. */
export const SCHEDULE_SLOTS = 14;

/** Placement defaults for the 14-entry tables. */
export const DEFAULT_SERVICE_FLAG = 1;
export const DEFAULT_DISPATCH_THRESHOLD = 5;
export const DEFAULT_EXPRESS_MODE = 0;
export const DEFAULT_DWELL = 0;

/** Ticks the boarding sequence counts down from once a car arrives. */
export const DEPARTURE_SEQUENCE_TICKS = 5;

/** `settle` seeds, by motion mode. Modes 2 and 3 never animate. */
export const SETTLE_BY_MODE = [5, 2, 0, 0];

/** Dwell threshold is `dwell_slot * 30` ticks. § Departure Rules. */
export const DWELL_TICKS_PER_UNIT = 30;

/**
 * The floor table the reference keeps is 120 bytes, EXE-indexed `0..119`.
 * In logical floors that is `-10..109`: ten basements and a hundred storeys.
 */
export const FLOOR_TABLE_SIZE = 120;
export const LOWEST_FLOOR = -10;
export const HIGHEST_FLOOR = LOWEST_FLOOR + FLOOR_TABLE_SIZE - 1;

/** Express-carrier slot table width: basements+lobby (10) plus six sky lobbies. */
export const EXPRESS_SLOT_COUNT = 16;

// ------------------------------------------------------- served-floor slots

/**
 * Is this floor one an express car will stop at?
 *
 * `specs/ELEVATORS.md` § Served-Floor Mapping, in EXE terms: floors 1..10, and
 * floors where `(floor - 10) % 15 == 14`. Translated to logical floors
 * (`logical = exe - 10`) that is:
 *
 * - EXE 1..10  ->  logical -9..0   (B9 up to the ground lobby)
 * - EXE 24, 39, 54, 69, 84, 99  ->  logical 14, 29, 44, 59, 74, 89
 *
 * and `(exe - 10) % 15 == 14` becomes `logical % 15 == 14`. The `floor <= 0`
 * branch is taken first so the modulo never sees a negative operand, which in
 * JavaScript would return a negative remainder and quietly serve the wrong
 * basement.
 */
export function isExpressStopFloor(floor) {
  if (floor <= 0) return floor >= -9;
  return floor % 15 === 14;
}

/**
 * The express branch of `floor_to_carrier_slot_index` (10a8:17ee), in logical
 * floors. EXE `1..10 -> 0..9` is logical `-9..0 -> 0..9`; the sky-lobby slot
 * `(exe - 10) / 15 + 10` is logical `floor / 15 + 10`. `-1` for a floor no
 * express car serves.
 */
export function expressSlotIndex(floor) {
  if (floor <= 0) return floor >= -9 ? floor + 9 : -1;
  return floor % 15 === 14 ? Math.floor(floor / 15) + 10 : -1;
}

/**
 * `floor_to_carrier_slot_index` (10a8:17ee) — the index of this floor in the
 * carrier's per-floor tables, or `-1` when the carrier does not serve it.
 *
 * Mode-dependent, per `specs/ELEVATORS.md` § Served-Floor Mapping: express
 * uses the fixed slot map above, standard and service index linearly off
 * `bottomFloor`. (The reference's own TypeScript port flattens both to the
 * linear form and notes the divergence; the spec is what we follow.)
 */
export function carrierSlotIndex(carrier, floor) {
  if (carrier.mode === CARRIER_MODE.EXPRESS) {
    if (floor < carrier.bottomFloor || floor > carrier.topFloor) return -1;
    return expressSlotIndex(floor);
  }
  if (floor < carrier.bottomFloor || floor > carrier.topFloor) return -1;
  return floor - carrier.bottomFloor;
}

/**
 * ⚠️ **Move a carrier's served range, and take its per-slot tables with it.**
 *
 * Eight arrays are indexed by `carrierSlotIndex`, which for a standard shaft is
 * `floor - bottomFloor`. `sim/actions.js`'s `extend_shaft` moved the two floor
 * bounds and left every one of them at its old length, so:
 *
 * - raising the top left the new floors with **no queue rings at all**, and a
 *   car that stopped on one read `carrier.queues[slot]` as `undefined` and
 *   threw inside `drainFloorQueue`;
 * - lowering the bottom silently **renumbered every existing slot**, so a
 *   rider queued on F3 became a rider queued three floors down.
 *
 * The first is a crash and the second is worse, because it is quiet. Found by
 * running `npm run playtest -- 24 1 --play`: the greedy builder extends the
 * seed's lift to reach the stranded F7 bank on day zero, and the run died on
 * day 5. It predates the lunch wave — a direct `extend_shaft` on the seed
 * leaves `queues.length` at 9 for a 12-floor shaft — and only surfaced because
 * every RNG draw moved and a car finally stopped up there with somebody
 * waiting.
 *
 * This lives here rather than in `extend_shaft` because *which* arrays are
 * per-slot is this module's business, and a caller that has to remember the
 * list is a caller that will forget the next one added.
 *
 * Express carriers are exempt: their slots are the fixed sky-lobby stops, not
 * floor offsets, so the range moving does not renumber anything.
 */
export function resizeCarrierSlots(carrier, bottomFloor, topFloor) {
  if (carrier.mode === CARRIER_MODE.EXPRESS) {
    carrier.bottomFloor = bottomFloor;
    carrier.topFloor = topFloor;
    return carrier;
  }
  // How far the OLD slot 0 has moved. Lowering the bottom by three pushes every
  // existing entry three places up the array; raising the top moves nothing.
  const shift = carrier.bottomFloor - bottomFloor;
  const slotCount = topFloor - bottomFloor + 1;

  const regrow = (previous, fill) => {
    const next = new Array(slotCount).fill(null).map((_, index) => {
      const old = index - shift;
      return old >= 0 && old < previous.length ? previous[old] : fill();
    });
    return next;
  };

  carrier.queues = regrow(carrier.queues, () => ({ up: createRing(), down: createRing() }));
  carrier.stopEnabled = regrow(carrier.stopEnabled, () => 1);
  carrier.upAssignedCar = regrow(carrier.upAssignedCar, () => 0);
  carrier.downAssignedCar = regrow(carrier.downAssignedCar, () => 0);
  for (const car of carrier.cars) {
    car.destinationCountBySlot = regrow(car.destinationCountBySlot, () => 0);
  }

  carrier.slotCount = slotCount;
  carrier.bottomFloor = bottomFloor;
  carrier.topFloor = topFloor;
  return carrier;
}

/**
 * Pure geometry: is the floor inside `[bottomFloor, topFloor]`? NOT a
 * substitute for `carrierStopsAtFloor` — an express shaft spans every floor
 * between its ends but stops at almost none of them.
 */
export function carrierSpansFloor(carrier, floor) {
  return floor >= carrier.bottomFloor && floor <= carrier.topFloor;
}

/**
 * The routing gate: served span, AND the player has not switched this floor
 * off in the carrier dialog, AND (for express) it is a lobby-cadence floor.
 *
 * `specs/ELEVATORS.md` § Served-Floor Mapping; the served-floor flag byte in
 * the binary is the union of those three conditions.
 */
export function carrierStopsAtFloor(carrier, floor) {
  const slot = carrierSlotIndex(carrier, floor);
  if (slot < 0) return false;
  return carrier.stopEnabled[slot] !== 0;
}

/**
 * The highest legal top floor for a shaft starting here. Express has no
 * contiguous-range limit; standard and service are capped at 31 floors.
 */
export function maxTopFloorFor(mode, bottomFloor) {
  if (mode === CARRIER_MODE.EXPRESS) return HIGHEST_FLOOR;
  return bottomFloor + MAX_SERVED_SPAN - 1;
}

// ------------------------------------------------------------ ring buffers

/**
 * A floor/direction queue: count, head, and 40 request slots.
 * `specs/ELEVATORS.md` § Queue Drain, "Queue records are ring buffers".
 */
export function createRing(capacity = QUEUE_CAPACITY) {
  return { items: new Array(capacity).fill(null), head: 0, count: 0, capacity };
}

export const ringIsFull = (ring) => ring.count >= ring.capacity;
export const ringIsEmpty = (ring) => ring.count === 0;

/** Enqueue at `(head + count) % 40`. Returns false when the ring is full. */
export function ringPush(ring, ref) {
  if (ringIsFull(ring)) return false;
  ring.items[(ring.head + ring.count) % ring.capacity] = ref;
  ring.count += 1;
  return true;
}

/** Dequeue from `head`, then `head = (head + 1) % 40`. */
export function ringShift(ring) {
  if (ringIsEmpty(ring)) return null;
  const ref = ring.items[ring.head];
  ring.items[ring.head] = null;
  ring.head = (ring.head + 1) % ring.capacity;
  ring.count -= 1;
  return ref;
}

/** Remove one reference wherever it sits. Used by route cancellation. */
export function ringRemove(ring, ref) {
  for (let i = 0; i < ring.count; i++) {
    const index = (ring.head + i) % ring.capacity;
    if (ring.items[index] !== ref) continue;
    // Compact the tail down over the hole so head/count stay meaningful.
    for (let j = i; j < ring.count - 1; j++) {
      const from = (ring.head + j + 1) % ring.capacity;
      ring.items[(ring.head + j) % ring.capacity] = ring.items[from];
    }
    ring.items[(ring.head + ring.count - 1) % ring.capacity] = null;
    ring.count -= 1;
    return true;
  }
  return false;
}

// -------------------------------------------------------------- the record

/**
 * `schedule_index = daypart_index + calendar_phase_flag * 7`, giving the 14
 * values the daypart tables are sized for. § Schedule Tables.
 */
export function scheduleIndex(clock) {
  return clock.daypart + (clock.calendarPhase ? 1 : 0) * 7;
}

/**
 * Build a carrier. Throws rather than clamps on an over-long standard or
 * service span: a 32-floor shaft is not a thing the original could produce,
 * and silently shortening one would hide a build-validation bug in whatever
 * called this.
 */
export function createCarrier({
  id, mode = CARRIER_MODE.STANDARD, bottomFloor, topFloor, column = 0, homeFloor,
}) {
  if (!(mode === 0 || mode === 1 || mode === 2)) {
    throw new RangeError(`carrier mode ${mode} is not express/standard/service`);
  }
  if (topFloor < bottomFloor) {
    throw new RangeError(`carrier ${id}: top floor ${topFloor} is below bottom ${bottomFloor}`);
  }
  if (mode !== CARRIER_MODE.EXPRESS && topFloor - bottomFloor + 1 > MAX_SERVED_SPAN) {
    // § Carrier Types: "contiguous range, max 31 floors".
    throw new RangeError(
      `carrier ${id}: ${topFloor - bottomFloor + 1} floors exceeds the ${MAX_SERVED_SPAN}-floor limit`,
    );
  }

  const slotCount = mode === CARRIER_MODE.EXPRESS
    ? EXPRESS_SLOT_COUNT
    : topFloor - bottomFloor + 1;

  return {
    id,
    mode,
    bottomFloor,
    topFloor,
    /** Tile column the shaft stands in. The distance penalty is horizontal. */
    column,
    shaftWidth: SHAFT_WIDTH[mode],
    assignmentCapacity: ASSIGNMENT_CAPACITY[mode],
    passengerCapacity: PASSENGER_CAPACITY[mode],

    // The five tables of § Schedule Tables, at their placement defaults.
    serviceFlags: new Array(SCHEDULE_SLOTS).fill(DEFAULT_SERVICE_FLAG),
    dispatchThreshold: new Array(SCHEDULE_SLOTS).fill(DEFAULT_DISPATCH_THRESHOLD),
    expressMode: new Array(SCHEDULE_SLOTS).fill(DEFAULT_EXPRESS_MODE),
    dwellEnable: new Array(SCHEDULE_SLOTS).fill(DEFAULT_DWELL),

    /** Per-floor: has the player switched this stop off? Indexed by slot. */
    stopEnabled: new Array(slotCount).fill(1),
    slotCount,

    /** Up and down rings, one pair per served slot. */
    queues: Array.from({ length: slotCount }, () => ({ up: createRing(), down: createRing() })),

    /**
     * Which car (1-based; 0 = unassigned) owns the up/down call at each slot.
     * 1-based because 0 has to mean "nobody" and car 0 is a real car.
     */
    upAssignedCar: new Array(slotCount).fill(0),
    downAssignedCar: new Array(slotCount).fill(0),

    cars: [],
    homeFloor: homeFloor ?? bottomFloor,

    /**
     * Every request reference with a live claim on this carrier — queued in a
     * ring, or aboard a car and not yet delivered.
     *
     * This is what stops one person occupying a queue forty times. A rider in
     * an in-transit state is dispatched **unconditionally every stride** until
     * its leg completes (`specs/PEOPLE.md` § Refresh handler flow), so the
     * family calls `resolve_sim_route_between_floors` again roughly every 16
     * ticks while it stands there waiting. Without this set each of those
     * calls appends another copy: measured on the seeded tower, one 40-entry
     * ring held **14 copies of the same worker**, so three people could fill a
     * queue meant for forty and everybody behind them got the queue-full
     * result instead of a ride.
     */
    liveRequests: new Set(),
  };
}


/**
 * Add a car. `specs/ELEVATORS.md` § Home Floor: the first car homes where the
 * shaft was started, later ones where the player clicked. Returns `null` when
 * the shaft already has its eight.
 */
export function addCar(carrier, homeFloor = carrier.homeFloor) {
  if (carrier.cars.length >= MAX_CARS_PER_CARRIER) return null;
  const car = {
    active: true,
    currentFloor: homeFloor,
    prevFloor: homeFloor,
    targetFloor: homeFloor,
    /** 1 = up, 0 = down. § Floor Assignment uses the same encoding. */
    directionFlag: 1,
    /** Sub-floor animation counter. Boarding cannot start while it is nonzero. */
    settle: 0,
    /** Boarding/departure countdown. 5 on arrival, then down to 0. */
    dwell: 0,
    departureFlag: 0,
    departureTick: 0,
    assignedCount: 0,
    scheduleFlag: 0,
    homeFloor,
    nearestWorkFloor: homeFloor,
    /** Riders aboard bound for each served slot. */
    destinationCountBySlot: new Array(carrier.slotCount).fill(0),
    /** 42 physical slots; only the first `assignmentCapacity` are ever used. */
    slots: Array.from({ length: ACTIVE_ROUTE_SLOTS }, () => ({ ref: null, destination: FREE_SLOT })),
    pendingAssignmentCount: 0,
    /** Has this car arrived anywhere yet? Gates the endpoint direction flip. */
    arrivalSeen: 0,
    /**
     * § Queue Drain step 5 names an "alternate-direction flag" that lets a car
     * also drain the reverse ring, but never says what it defaults to.
     * TODO(parity): enabled here, which matches the observed both-directions
     * drain; nothing in the reference settles it.
     */
    alternateDirection: true,
  };
  carrier.cars.push(car);
  return car;
}

const carCapacity = (carrier) => carrier.assignmentCapacity;

const nonemptyDestinationCount = (car) =>
  car.destinationCountBySlot.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);

// ------------------------------------------------------------------ queues

/**
 * Push a request onto `(carrier, floor, direction)`. Returns `false` when the
 * ring is full — the caller turns that into route result `0`.
 *
 * The first entry onto a previously-empty ring is what raises a floor call, so
 * this is where `assignCarToFloorRequest` fires. § Queues, "Elevator queue
 * creation is mutating".
 */
export function enqueueRequest(carrier, ref, floor, directionFlag) {
  // § Queues, "Elevator queue creation is mutating": a sim that calls resolve
  // twice must not double-enqueue. Reported as success, because from the
  // caller's point of view the request IS on the carrier — it just did not
  // need adding twice. Returning false here would report a full queue and
  // charge the 5-tick waiting delay to somebody who is already in the queue.
  if (carrier.liveRequests.has(ref)) return true;

  const slot = carrierSlotIndex(carrier, floor);
  if (slot < 0) {
    // Binary quirk, § Queues: enqueue's body is gated on a valid slot, so an
    // express car called at an intermediate floor silently no-ops while the
    // resolver still reports success. Unreachable through our selector — it
    // will not pick an express carrier whose source floor is not a stop — but
    // kept so the behaviour is here rather than assumed away.
    return true;
  }
  const ring = directionFlag === 1 ? carrier.queues[slot].up : carrier.queues[slot].down;
  if (ringIsFull(ring)) return false;
  const wasEmpty = ringIsEmpty(ring);
  ringPush(ring, ref);
  // Claimed only once the push succeeded: a refused request has no claim, and
  // marking one would strand that rider from ever queueing again.
  carrier.liveRequests.add(ref);
  if (wasEmpty) assignCarToFloorRequest(carrier, floor, directionFlag);
  return true;
}

/**
 * Does this reference already have a live claim on this carrier — queued, or
 * aboard? The claim is released when the rider is delivered, when a transfer
 * cannot be resolved, or when the route is cancelled.
 */
export const hasLiveRequest = (carrier, ref) => carrier.liveRequests.has(ref);

/** Depth of one floor/direction ring, capped at the full sentinel. § Route Costs. */
export function floorQueueCount(carrier, floor, directionFlag) {
  const slot = carrierSlotIndex(carrier, floor);
  if (slot < 0) return 0;
  const ring = directionFlag === 1 ? carrier.queues[slot].up : carrier.queues[slot].down;
  return Math.min(ring.count, QUEUE_CAPACITY);
}

/** Is the ring for this floor and direction at its 40-entry limit? */
export function floorQueueIsFull(carrier, floor, directionFlag) {
  return floorQueueCount(carrier, floor, directionFlag) >= QUEUE_CAPACITY;
}

/** Remove a request reference from every ring and active slot on this carrier. */
export function cancelRequest(carrier, ref) {
  let removed = false;
  for (const queue of carrier.queues) {
    if (ringRemove(queue.up, ref)) removed = true;
    if (ringRemove(queue.down, ref)) removed = true;
  }
  for (const car of carrier.cars) {
    for (let i = 0; i < carrier.assignmentCapacity; i++) {
      const slot = car.slots[i];
      if (slot.ref !== ref) continue;
      const destinationSlot = carrierSlotIndex(carrier, slot.destination);
      if (destinationSlot >= 0 && car.destinationCountBySlot[destinationSlot] > 0) {
        car.destinationCountBySlot[destinationSlot] -= 1;
      }
      slot.ref = null;
      slot.destination = FREE_SLOT;
      car.assignedCount = Math.max(0, car.assignedCount - 1);
      removed = true;
    }
  }
  carrier.liveRequests.delete(ref);
  return removed;
}

// -------------------------------------------------------------- car motion

/**
 * `compute_car_motion_mode` (1098:209f). 0 = stop/decel, 1 = slow, 2 = normal,
 * 3 = fast. § Motion Profile.
 *
 * Mode 3 — three floors a step — exists **only** for express. Standard and
 * service instead have the slow band express lacks. The tables are genuinely
 * asymmetric; do not tidy them into one.
 */
export function computeCarMotionMode(carrier, car) {
  const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
  const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);

  if (carrier.mode === CARRIER_MODE.EXPRESS) {
    if (distToTarget < 2 || distFromPrev < 2) return 0;
    if (distToTarget > 4 && distFromPrev > 4) return 3;
    return 2;
  }
  if (distToTarget < 2 || distFromPrev < 2) return 0;
  if (distToTarget < 4 || distFromPrev < 4) return 1;
  return 2;
}

/** How many floors one step covers in each mode. Only express reaches 3. */
export const MOTION_STEP_BY_MODE = [1, 1, 1, 3];

/**
 * `advance_car_position_one_step` (1098:10e4). One motion step, seeding
 * `settle` for the animated modes. § Motion Profile: modes 2 and 3 leave
 * `settle` at 0, so the car can arrive the very next tick.
 *
 * **`prevFloor` is the last floor the car STOPPED at, not the last floor it
 * passed.** It is latched here only when the car is already standing on its
 * target and needs a new one, and otherwise only at dwell expiry
 * (§ Door And Boarding Counters: "the car snapshots prev_floor"). Latching it
 * on every step instead pins `dist_from_prev` at 0, which pins every car in
 * mode 0 forever — a tower that looks merely slow rather than broken, which is
 * the failure mode `CLAUDE.md` says to distrust. The whole acceleration
 * profile lives in that one distinction: slow near the last stop, fast in the
 * middle, slow again near the target.
 *
 * The step follows `directionFlag`, not the sign of the target. Under the state
 * machine the two always agree, because `updateCarDirectionFlag` derives the
 * flag from the target whenever the car is off it. The sweep is what the
 * original obeys, so the sweep is what is written.
 */
export function advanceCarOneStep(carrier, car, carIndex = 0) {
  if (car.currentFloor === car.targetFloor) {
    car.prevFloor = car.currentFloor;
    recomputeCarTargetAndDirection(carrier, car, carIndex);
  }
  const mode = computeCarMotionMode(carrier, car);
  const step = MOTION_STEP_BY_MODE[mode];
  const direction = car.directionFlag === 0 ? -1 : 1;
  // No clamp, and none is needed: mode 3 is the only stride longer than a
  // floor, and it requires `dist_to_target > 4`, so a 3-floor step can never
  // pass the target. The test sweeps every position in a shaft to hold that
  // invariant, which is worth more than a guard no case can reach.
  car.currentFloor = car.currentFloor + direction * step;
  car.settle = SETTLE_BY_MODE[mode];
  car.departureFlag = 0;   // § Departure Rules: cleared on moving away.
  if (car.arrivalSeen !== 0) car.arrivalSeen = 0;
  return mode;
}

// ------------------------------------------------------- target and sweep

const hasQueuedRider = (carrier, car, floor) => {
  const slot = carrierSlotIndex(carrier, floor);
  return slot >= 0 && car.destinationCountBySlot[slot] > 0;
};
const hasUpCall = (carrier, car, floor, carIndex) => {
  const slot = carrierSlotIndex(carrier, floor);
  return slot >= 0 && carrier.upAssignedCar[slot] === carIndex + 1;
};
const hasDownCall = (carrier, car, floor, carIndex) => {
  const slot = carrierSlotIndex(carrier, floor);
  return slot >= 0 && carrier.downAssignedCar[slot] === carIndex + 1;
};

/**
 * `select_next_target_floor` (1098:1553). § Home Floor, "Target-floor
 * selection".
 *
 * Three regimes, chosen by the car's runtime `scheduleFlag`:
 * `1` express-up scans down and falls back to the top floor, `2` express-down
 * scans up and falls back to the bottom, anything else sweeps bidirectionally
 * and returns `-1` when there is nothing to do at all.
 */
export function selectNextTargetFloor(carrier, car, carIndex) {
  const flag = car.scheduleFlag;
  const idle = car.pendingAssignmentCount === 0 && nonemptyDestinationCount(car) === 0;

  // § Home Floor: "no pending assignments and no special flag" -> go home. An
  // idle car in an express mode does NOT go home; it parks at the endpoint its
  // mode shuttles from, which is what makes the morning and evening rushes
  // work.
  //
  // TODO(parity): the reference's own port adds a second clause sending a car
  // that has never arrived anywhere home regardless of schedule flag. That is
  // not in `specs/ELEVATORS.md` § Home Floor, so it is not here. See report.
  if (idle && flag === 0) return car.homeFloor;

  const underCapacity = car.assignedCount !== carCapacity(carrier);
  const bottom = carrier.bottomFloor;
  const top = carrier.topFloor;

  if (flag === 1) {
    // Express up: scan downward for work, else return to the top.
    for (let f = car.currentFloor; f >= bottom; f--) {
      if (hasQueuedRider(carrier, car, f)) return f;
      if (underCapacity && (hasDownCall(carrier, car, f, carIndex) || hasUpCall(carrier, car, f, carIndex))) return f;
    }
    return top;
  }

  if (flag === 2) {
    // Express down: scan upward for work, else return to the bottom.
    for (let f = car.currentFloor; f <= top; f++) {
      if (hasQueuedRider(carrier, car, f)) return f;
      if (underCapacity && (hasUpCall(carrier, car, f, carIndex) || hasDownCall(carrier, car, f, carIndex))) return f;
    }
    return bottom;
  }

  // Normal: sweep in the current direction, then wrap from the far endpoint.
  if (car.directionFlag === 0) {
    for (let f = car.currentFloor; f >= bottom; f--) {
      if (hasQueuedRider(carrier, car, f)) return f;
      if (underCapacity && hasDownCall(carrier, car, f, carIndex)) return f;
    }
    if (underCapacity) {
      for (let f = bottom; f <= car.currentFloor; f++) if (hasUpCall(carrier, car, f, carIndex)) return f;
    }
    for (let f = car.currentFloor + 1; f <= top; f++) {
      if (underCapacity && hasUpCall(carrier, car, f, carIndex)) return f;
      if (hasQueuedRider(carrier, car, f)) return f;
    }
    if (underCapacity) {
      for (let f = top; f > car.currentFloor; f--) if (hasDownCall(carrier, car, f, carIndex)) return f;
    }
  } else {
    for (let f = car.currentFloor; f <= top; f++) {
      if (hasQueuedRider(carrier, car, f)) return f;
      if (underCapacity && hasUpCall(carrier, car, f, carIndex)) return f;
    }
    if (underCapacity) {
      for (let f = top; f >= car.currentFloor; f--) if (hasDownCall(carrier, car, f, carIndex)) return f;
    }
    for (let f = car.currentFloor - 1; f >= bottom; f--) {
      if (underCapacity && hasDownCall(carrier, car, f, carIndex)) return f;
      if (hasQueuedRider(carrier, car, f)) return f;
    }
    if (underCapacity) {
      for (let f = bottom; f < car.currentFloor; f++) if (hasUpCall(carrier, car, f, carIndex)) return f;
    }
  }
  // § Home Floor: "if still nothing found, returns -1 (no target)". Ours is
  // `null` — see NO_TARGET_FLOOR. -1 is B1 in logical floors, and an idle car
  // quietly driving to the first basement is not what that line means.
  return NO_TARGET_FLOOR;
}

/**
 * `find_nearest_work_floor` (1098:1f4c). The turn floor the assignment cost
 * model uses for its wrap case; falls back to the car's home floor.
 */
export function findNearestWorkFloor(carrier, car, carIndex) {
  const hasWork = (floor) => {
    const slot = carrierSlotIndex(carrier, floor);
    if (slot < 0) return false;
    if (car.destinationCountBySlot[slot] !== 0) return true;
    if (carrier.upAssignedCar[slot] === carIndex + 1) return true;
    if (carrier.downAssignedCar[slot] === carIndex + 1) return true;
    return false;
  };
  if (car.directionFlag === 0) {
    for (let f = carrier.bottomFloor; f <= car.currentFloor; f++) if (hasWork(f)) return f;
  } else {
    for (let f = carrier.topFloor; f >= car.currentFloor; f--) if (hasWork(f)) return f;
  }
  return car.homeFloor;
}

/**
 * `update_car_direction_flag` (1098:1d2f). Off-target the direction simply
 * follows the target. At the target it flips at the served endpoints, and
 * otherwise only when the car is in normal schedule mode and the calls at this
 * floor point the other way.
 */
export function updateCarDirectionFlag(carrier, car, carIndex) {
  const floor = car.currentFloor;
  const previous = car.directionFlag;

  if (floor !== car.targetFloor) {
    car.directionFlag = floor < car.targetFloor ? 1 : 0;
    return;
  }
  if (car.arrivalSeen === 0) return;

  if (floor === carrier.topFloor && car.directionFlag === 1) {
    car.directionFlag = 0;
  } else if (floor === carrier.bottomFloor && car.directionFlag === 0) {
    car.directionFlag = 1;
  } else if (car.scheduleFlag === 0) {
    const slot = carrierSlotIndex(carrier, floor);
    if (slot >= 0) {
      const up = carrier.upAssignedCar[slot] !== 0;
      const down = carrier.downAssignedCar[slot] !== 0;
      if (car.directionFlag === 0 && !down && up) car.directionFlag = 1;
      else if (car.directionFlag === 1 && !up && down) car.directionFlag = 0;
    }
  }
  if (car.directionFlag !== previous) clearFloorCalls(carrier, car, floor, carIndex);
}

/** `recompute_car_target_and_direction` (1098:0bcf). */
export function recomputeCarTargetAndDirection(carrier, car, carIndex) {
  const next = selectNextTargetFloor(carrier, car, carIndex);
  // `next === null` first: `null < x` is FALSE and `null > x` is FALSE, so a
  // range check alone reads "no target" as a legal floor and parks the car on
  // whatever `null` coerces to. Both halves of that read as guards and neither
  // is one.
  if (next === NO_TARGET_FLOOR || next < carrier.bottomFloor || next > carrier.topFloor) {
    // No target: park where we are rather than drive off the end of the shaft.
    car.targetFloor = car.currentFloor;
  } else {
    car.targetFloor = next;
  }
  updateCarDirectionFlag(carrier, car, carIndex);
  car.nearestWorkFloor = findNearestWorkFloor(carrier, car, carIndex);
}

/**
 * Release this car's claim on the calls at a floor it has just served. The
 * only place `pendingAssignmentCount` comes back down — `assignCarToFloorRequest`
 * is the only place it goes up. One rule, one pair of call sites, so the count
 * cannot drift away from the assignment tables it is meant to summarise.
 */
export function clearFloorCalls(carrier, car, floor, carIndex) {
  const slot = carrierSlotIndex(carrier, floor);
  if (slot < 0) return;
  if (carrier.upAssignedCar[slot] === carIndex + 1) {
    carrier.upAssignedCar[slot] = 0;
    car.pendingAssignmentCount = Math.max(0, car.pendingAssignmentCount - 1);
  }
  if (carrier.downAssignedCar[slot] === carIndex + 1) {
    carrier.downAssignedCar[slot] = 0;
    car.pendingAssignmentCount = Math.max(0, car.pendingAssignmentCount - 1);
  }
}

// --------------------------------------------------------------- departure

/**
 * `should_car_depart` (1098:23a5). § Departure Rules.
 *
 * TODO(parity): the dwell exemption reads `(current_floor - 10) % 15 == 0` in
 * EXE terms — logical floors 0, 15, 30, 45 — which is a *different* cadence
 * from the sky lobbies everything else uses (logical 14, 29, 44). The
 * reference's own port carries the same off-by-one and flags it as the
 * "perfect-parity" cadence. Implemented as written; see the report.
 */
export function shouldCarDepart(carrier, car, clock) {
  if (car.assignedCount >= carCapacity(carrier)) return true;
  const multiplier = carrier.dwellEnable[scheduleIndex(clock)] ?? DEFAULT_DWELL;
  if (multiplier === 0) return true;
  if (car.currentFloor !== car.homeFloor) {
    const atLobbyCadence = car.currentFloor === 0 || (car.currentFloor > 0 && car.currentFloor % 15 === 0);
    if (!atLobbyCadence) return true;
  }
  return Math.abs(clock.dayTick - car.departureTick) > multiplier * DWELL_TICKS_PER_UNIT;
}

// ------------------------------------------------------- floor assignment

/**
 * `assign_car_to_floor_request`. § Floor Assignment.
 *
 * The whole selector in one place, because a rule written in four places
 * drifts: an early accept for a car already standing at the floor, then a
 * three-way comparison between the best idle-at-home car, the best car already
 * sweeping toward the request, and the best car that would have to turn round.
 */
export function assignCarToFloorRequest(carrier, floor, directionFlag, clock = null) {
  const slot = carrierSlotIndex(carrier, floor);
  if (slot < 0) return -1;
  const table = directionFlag === 1 ? carrier.upAssignedCar : carrier.downAssignedCar;
  if (table[slot] !== 0) return table[slot] - 1;   // already assigned: do nothing

  let bestIdle = -1; let bestIdleCost = Infinity;
  let bestForward = -1; let bestForwardCost = Infinity;
  let bestWrap = -1; let bestWrapCost = Infinity;

  for (let index = 0; index < carrier.cars.length; index++) {
    const car = carrier.cars[index];
    if (!car.active) continue;

    // Immediate early accept: standing here with the doors shut, and either
    // running a schedule mode or already pointing the right way.
    if (car.currentFloor === floor && car.dwell === 0
      && (car.scheduleFlag !== 0 || car.directionFlag === directionFlag)) {
      table[slot] = index + 1;
      car.pendingAssignmentCount += 1;
      return index;
    }

    const idleAtHome = car.pendingAssignmentCount === 0
      && nonemptyDestinationCount(car) === 0
      && car.dwell === 0
      && car.currentFloor === car.homeFloor;
    if (idleAtHome) {
      const cost = Math.abs(floor - car.currentFloor);
      if (cost < bestIdleCost) { bestIdleCost = cost; bestIdle = index; }
      continue;
    }

    const movingWithRequest = car.directionFlag === directionFlag;
    const ahead = directionFlag === 1 ? floor >= car.currentFloor : floor <= car.currentFloor;

    if (movingWithRequest && ahead) {
      const cost = directionFlag === 1 ? floor - car.currentFloor : car.currentFloor - floor;
      if (cost < bestForwardCost) { bestForwardCost = cost; bestForward = index; }
    } else if (movingWithRequest) {
      // Behind the sweep: ride to the turn floor, then come back.
      const cost = directionFlag === 1
        ? (car.targetFloor - car.currentFloor) + (car.targetFloor - floor)
        : (car.currentFloor - car.targetFloor) + (floor - car.targetFloor);
      if (cost < bestWrapCost) { bestWrapCost = cost; bestWrap = index; }
    } else {
      // Reversal fallback, measured through the car's next turn floor.
      const turn = car.nearestWorkFloor;
      const beforeTurn = directionFlag === 1 ? floor <= turn : floor >= turn;
      const cost = beforeTurn
        ? Math.abs(floor - car.currentFloor)
        : Math.abs(turn - car.currentFloor) + Math.abs(floor - turn);
      if (cost < bestWrapCost) { bestWrapCost = cost; bestWrap = index; }
    }
  }

  const movingIndex = bestForward >= 0 ? bestForward : bestWrap;
  const movingCost = bestForward >= 0 ? bestForwardCost : bestWrapCost;

  let chosen;
  if (movingIndex < 0) {
    // § Floor Assignment, "Edge case note": with no moving candidate at all the
    // selector falls back to car 0, NOT to the best idle-home car. Deliberate
    // in the original, so it stays.
    chosen = carrier.cars.length > 0 ? 0 : -1;
  } else if (bestIdle < 0) {
    chosen = movingIndex;
  } else {
    const threshold = clock
      ? (carrier.dispatchThreshold[scheduleIndex(clock)] ?? DEFAULT_DISPATCH_THRESHOLD)
      : DEFAULT_DISPATCH_THRESHOLD;
    // Strictly less than: exact equality breaks toward the idle-home car.
    chosen = movingCost - bestIdleCost < threshold ? movingIndex : bestIdle;
  }

  if (chosen < 0) return -1;
  table[slot] = chosen + 1;
  carrier.cars[chosen].pendingAssignmentCount += 1;
  return chosen;
}

// ------------------------------------------------------------- queue drain

const firstFreeSlot = (carrier, car) => {
  for (let i = 0; i < carrier.assignmentCapacity; i++) {
    if (car.slots[i].destination === FREE_SLOT) return i;
  }
  return -1;
};

/**
 * `dispatch_destination_queue_entries`. § Queue Drain.
 *
 * `ctx` is the family seam. It must supply:
 * - `targetFloorOf(ref)` -> the actor's final destination floor
 * - `chooseTransferFloor(carrier, ref, currentFloor, targetFloor)` -> the floor
 *   this leg should actually put them down on, or `NO_TRANSFER_FLOOR`
 * - `onRequeueFailure(ref)` -> transfer resolution failed; the actor goes back
 *   to its family dispatcher
 * - `emitDelay(ref, event)` -> optional; the stress events below
 * - `onBoard(ref, carrier, car, boardFloor, alightFloor)` -> optional
 *
 * Two stress events come out of here, both carrying no tick cost — see
 * `routing.js` `DELAY`:
 *
 * - **`boarding`**, when a car actually loads a rider. This is
 *   `assign_request_to_runtime_route`, where the reference applies the
 *   tall-lobby rebate — NOT where the rider joined the queue. It is also where
 *   the route-start stamp is re-armed for the ride; see the route-start note in
 *   `routing.js`.
 * - **`requeue-failure`**, when no transfer floor works. Its delay is zero
 *   ticks and it is **not inert**: `add_delay_to_current_sim` still clears the
 *   route-start stamp on the way through, so the event has to be emitted even
 *   though it costs nothing.
 *
 * Returns how many requests were loaded.
 */
export function drainFloorQueue(carrier, car, carIndex, ctx) {
  const slot = carrierSlotIndex(carrier, car.currentFloor);
  if (slot < 0) return 0;
  const rings = carrier.queues[slot];
  if (ringIsEmpty(rings.up) && ringIsEmpty(rings.down)) return 0;

  let remaining = carrier.assignmentCapacity - car.assignedCount;
  if (remaining <= 0) return 0;

  // § Queue Drain step 3: an empty ring for the current direction, with the
  // car parked and nothing pending, flips it so it serves the other way rather
  // than standing there beside a full queue it has decided not to look at.
  const primaryIsEmpty = ringIsEmpty(car.directionFlag === 1 ? rings.up : rings.down);
  if (primaryIsEmpty && car.targetFloor === car.currentFloor && car.pendingAssignmentCount === 0) {
    car.directionFlag = car.directionFlag === 1 ? 0 : 1;
  }

  const primary = car.directionFlag === 1 ? rings.up : rings.down;
  const secondary = car.directionFlag === 1 ? rings.down : rings.up;
  // Step 5: the reverse ring is drained too, but only when the car takes calls
  // both ways and slots are still free.
  const rounds = car.alternateDirection ? [primary, secondary] : [primary];

  let loaded = 0;
  for (const ring of rounds) {
    while (remaining > 0 && !ringIsEmpty(ring)) {
      const ref = ringShift(ring);
      const targetFloor = ctx.targetFloorOf(ref);
      const alight = ctx.chooseTransferFloor(carrier, ref, car.currentFloor, targetFloor);
      if (alight === NO_TRANSFER_FLOOR || alight === car.currentFloor) {
        // § Queue Drain step 7. The rider leaves the carrier entirely, so its
        // claim goes with it — otherwise the dedup would bar it from ever
        // queueing here again and it would retry forever against a carrier
        // that has quietly stopped accepting it.
        carrier.liveRequests.delete(ref);
        // The delay is zero ticks and still has to be reported: it clears the
        // route-start stamp, and a consumer that optimises the zero away
        // loses that.
        ctx.emitDelay?.(ref, { kind: 'requeue-failure' });
        ctx.onRequeueFailure?.(ref);
        continue;
      }
      const free = firstFreeSlot(carrier, car);
      if (free < 0) break;
      car.slots[free] = { ref, destination: alight };
      const destinationSlot = carrierSlotIndex(carrier, alight);
      if (destinationSlot >= 0) car.destinationCountBySlot[destinationSlot] += 1;
      car.assignedCount += 1;
      remaining -= 1;
      loaded += 1;
      // The boarding event. `carrierMode` is reported, not acted on: the
      // tall-lobby rebate exempts SERVICE carriers while the distance penalty
      // exempts EXPRESS ones, and putting either exemption here would be a
      // second copy of a rule that lives in `sim/stress.js`.
      ctx.emitDelay?.(ref, {
        kind: 'boarding',
        sourceFloor: car.currentFloor,
        carrierMode: carrier.mode,
      });
      ctx.onBoard?.(ref, carrier, car, car.currentFloor, alight);
    }
  }
  if (loaded > 0) clearFloorCalls(carrier, car, car.currentFloor, carIndex);
  return loaded;
}

/**
 * `dispatch_carrier_car_arrivals`. § Arrival Dispatch: unload every slot bound
 * for this floor, write the actor's floor, and hand it straight back to its
 * family. The elevator layer never interprets a family state.
 *
 * `onArrive(ref, floor, effects)` carries the two things `PEOPLE.md` § When
 * Counters Advance puts on the queued-car arrival callback:
 * `rebase_sim_elapsed_from_clock` and `advance_sim_trip_counters`. **This is
 * where an accepted carrier leg's trip is counted, and the only place** — the
 * resolver deliberately does not count results `0`, `1` or `2`, because
 * counting at both ends of one ride doubles `trip_count` against a single
 * elapsed sample and halves the apparent stress.
 */
export function dispatchCarArrivals(carrier, car, ctx) {
  let unloaded = 0;
  for (let i = 0; i < carrier.assignmentCapacity; i++) {
    const slot = car.slots[i];
    if (slot.destination !== car.currentFloor) continue;
    const { ref } = slot;
    const destinationSlot = carrierSlotIndex(carrier, slot.destination);
    if (destinationSlot >= 0 && car.destinationCountBySlot[destinationSlot] > 0) {
      car.destinationCountBySlot[destinationSlot] -= 1;
    }
    slot.ref = null;
    slot.destination = FREE_SLOT;
    car.assignedCount = Math.max(0, car.assignedCount - 1);
    // Delivered: the claim is spent, and this rider may call the carrier again
    // for its next leg.
    carrier.liveRequests.delete(ref);
    unloaded += 1;
    ctx.onArrive?.(ref, car.currentFloor, { rebaseElapsed: true, advanceTripCounters: true });
  }
  return unloaded;
}

// --------------------------------------------------------- the car's tick

/**
 * `advance_carrier_car_state` (1098:06fb). § Car State Machine.
 *
 * The three branches, and the order they are tested in, are the whole thing:
 *
 *   settle > 0   -> C: still animating between floors. Boarding is blocked.
 *   dwell === 0  -> A: arrive at the target, or take one motion step.
 *   otherwise    -> B: count the boarding sequence down, then decide to leave.
 */
export function advanceCarState(carrier, car, carIndex, clock, ctx = {}) {
  if (!car.active) return;

  if (car.currentFloor < carrier.bottomFloor || car.currentFloor > carrier.topFloor) {
    // The shaft was shortened under the car. Put it back on its home floor
    // rather than let it keep serving floors that no longer exist.
    for (let i = 0; i < carrier.assignmentCapacity; i++) {
      const slot = car.slots[i];
      if (slot.ref !== null) carrier.liveRequests.delete(slot.ref);
      slot.ref = null;
      slot.destination = FREE_SLOT;
    }
    car.destinationCountBySlot.fill(0);
    car.assignedCount = 0;
    car.currentFloor = car.homeFloor;
    car.prevFloor = car.homeFloor;
    car.targetFloor = car.homeFloor;
    car.settle = 0;
    car.dwell = 0;
    return;
  }

  // Branch C: the sub-floor animation. It clears early if the motion mode
  // changed out from under it, which is how a re-targeted car stops animating.
  if (car.settle > 0) {
    if (computeCarMotionMode(carrier, car) === 0) car.settle -= 1;
    else car.settle = 0;
    return;
  }

  if (car.dwell === 0) {
    const slot = carrierSlotIndex(carrier, car.currentFloor);
    const ridersForThisFloor = slot >= 0 && car.destinationCountBySlot[slot] > 0;
    const underCapacity = car.assignedCount !== carCapacity(carrier);

    if (car.targetFloor === car.currentFloor && (ridersForThisFloor || underCapacity)) {
      // A1 — arrival. At a served endpoint the runtime schedule flag is
      // reloaded from the per-daypart express-mode table: that is what makes
      // cars run express-up in the morning and express-down in the evening.
      if (car.currentFloor === carrier.topFloor || car.currentFloor === carrier.bottomFloor) {
        car.scheduleFlag = carrier.expressMode[scheduleIndex(clock)] ?? DEFAULT_EXPRESS_MODE;
      }
      if (ctx.targetFloorOf) {
        dispatchCarArrivals(carrier, car, ctx);
        drainFloorQueue(carrier, car, carIndex, ctx);
      }
      clearFloorCalls(carrier, car, car.currentFloor, carIndex);
      car.dwell = DEPARTURE_SEQUENCE_TICKS;
      if (car.departureFlag === 0) car.departureTick = clock.dayTick;
      car.departureFlag = 1;
      car.arrivalSeen = 1;
      return;
    }

    // A2 — motion. The stale-call release happens before the re-assignment
    // check, so a car leaving a floor it never served hands the call back.
    const departFloor = car.currentFloor;
    const departSlot = carrierSlotIndex(carrier, departFloor);
    clearFloorCalls(carrier, car, departFloor, carIndex);
    const rings = departSlot >= 0 ? carrier.queues[departSlot] : null;
    const pendingUp = rings != null && !ringIsEmpty(rings.up) && carrier.upAssignedCar[departSlot] === 0;
    const pendingDown = rings != null && !ringIsEmpty(rings.down) && carrier.downAssignedCar[departSlot] === 0;
    advanceCarOneStep(carrier, car, carIndex);
    if (pendingUp) assignCarToFloorRequest(carrier, departFloor, 1, clock);
    if (pendingDown) assignCarToFloorRequest(carrier, departFloor, 0, clock);
    return;
  }

  // Branch B: the boarding countdown. On reaching zero the car re-targets and
  // asks whether it may leave; a "no" pins dwell at 1 so this runs again next
  // tick rather than dropping into the motion branch.
  car.dwell -= 1;
  if (car.dwell === 0) {
    car.prevFloor = car.currentFloor;
    recomputeCarTargetAndDirection(carrier, car, carIndex);
    if (!shouldCarDepart(carrier, car, clock)) car.dwell = 1;
  }
}

/** Every car on one carrier, in index order. § Tick Order step 8. */
export function tickCarrier(carrier, clock, ctx = {}) {
  for (let i = 0; i < carrier.cars.length; i++) {
    advanceCarState(carrier, carrier.cars[i], i, clock, ctx);
  }
}

/** Every active car in the tower, carriers in index order. */
export function tickCarriers(carriers, clock, ctx = {}) {
  for (const carrier of carriers) tickCarrier(carrier, clock, ctx);
}
