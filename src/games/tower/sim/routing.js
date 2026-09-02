/**
 * Route resolution — the module the whole economy hangs off.
 *
 * Spec: `specs/ROUTING.md` in the reference, cross-read against its
 * `apps/worker/src/sim/route-scoring/*`, `.../reachability/*` and
 * `.../queue/resolve.ts` (which carry the Ghidra addresses cited below).
 * Every number here is theirs.
 *
 * ## Why this file decides whether the tower has tenants
 *
 * `resolve_sim_route_between_floors` is not a planner and there is no separate
 * "can this person get there?" probe. `specs/ROUTING.md` § Route Resolution
 * Results is explicit: the office-worker rental decision calls *this*
 * resolver — the one that queues rides and writes route tokens. So a worker's
 * lobby-to-office route resolving is simultaneously the movement and the
 * lease. If it returns `-1`, the office stays For Rent because nobody could
 * reach it.
 *
 * It resolves **one leg at a time**. On arrival the family asks again from the
 * new floor. Nothing here ever builds a full itinerary.
 *
 * ## The tower interface this module needs
 *
 * Pass the tower in; this file imports no state model. It reads exactly five
 * things, and nothing else:
 *
 * ```
 * tower.carriers      Array of carrier records from `elevators.js`
 *                     (`createCarrier`). Order is the carrier scan order, so
 *                     it must be stable — index 0..23, ascending.
 * tower.segments      Array of stairs/escalator records from `createSegment`
 *                     below. Up to 64 (MAX_SEGMENTS); scanned in index order.
 * tower.transferFloors  Array of logical floors carrying a sky lobby /
 *                     transit concourse (the reference's placed object type
 *                     0x18). Discovery order; the first 16 are used.
 * tower.lobbyHeight   1, 2 or 3. Read only by `makeCarrierContext`, which puts
 *                     it on the boarding event so the tall-lobby rebate can be
 *                     priced without reaching back into the tower.
 * tower.routeTables   Written by `rebuildRouteTables(tower)` — walkability,
 *                     the lobby local-access records, the transfer-group
 *                     cache, and the route-failure notice bytes. Call it at
 *                     the start-of-day checkpoint (tick 0) and after any edit
 *                     that changes a carrier's served floors, a stairs or
 *                     escalator segment, or a sky lobby.
 * ```
 *
 * That is the whole surface. `floorExists` is deliberately NOT part of it: the
 * reference derives "no floor here" from a zero walkability byte and has no
 * separate existence gate in the router, so adding one would be a deviation
 * that changes which routes fail.
 *
 * ## The actor interface
 *
 * `resolveRouteBetweenFloors` reads `actor.id` (the queue's request reference
 * — any stable value) and `actor.homeColumn` (the tile column the distance
 * penalty is measured against). It writes `actor.route`, `actor.waitingFloor`,
 * `actor.legDestination`, `actor.destinationFloor` and `actor.routeStartTick`.
 * Everything it wrote is also on the returned result, so a caller that would
 * rather own its own record can ignore the mutation entirely.
 *
 * `actor.routeStartTick` is the reference's `last_trip_tick`, and it is written
 * **last, from inside `finish()`**, after every delay has been reported. See
 * the ordering note on `DELAY`: charging a delay clears that stamp, so writing
 * it first destroys it.
 *
 * The two `onDelay` seams take different arguments on purpose. The resolver's
 * is `onDelay(event)` — it was handed the actor, so the event needs no subject.
 * The queue drain's, via `makeCarrierContext`, is `onDelay(ref, event)`: it
 * holds only request references and never sees an actor record.
 *
 * ## Delays: reported, never applied — and never priced
 *
 * `sim/stress.js` owns stress. This module returns the events it incurs on
 * `result.delays` and, when given `onDelay`, calls it once per event. It never
 * touches an elapsed counter, and it carries **no tick costs**: an event names
 * what happened and the facts needed to price it, and `sim/stress.js` supplies
 * the number. See `DELAY` below for the six kinds and the function each maps
 * to.
 *
 * ## The route-start stamp, and the gap this module had to close
 *
 * `TODO(parity):` `last_trip_tick` is stamped when a rider joins a carrier
 * queue (`ROUTING.md` lines 57 and 352). Two functions then consume it:
 * `accumulate_elapsed_delay_into_current_sim` at **assignment** (boarding) and
 * `rebase_sim_elapsed_from_clock` at **arrival**. Both clear it. Nothing in
 * `ROUTING.md`, `PEOPLE.md` or `ELEVATORS.md` re-stamps it in between, so on
 * the face of it the arrival rebase reads a cleared stamp, computes
 * `elapsed + day_tick - 0`, and charges the whole day — every elevator ride
 * scoring maximum stress, identically, no matter how good the elevator is.
 *
 * Three readings are possible; this module takes the third:
 *
 * 1. *The arrival rebase is not reached on this path.* Rejected: `PEOPLE.md`
 *    § When Counters Advance names the queued-car arrival callback explicitly.
 * 2. *The assignment-time accumulate is not reached.* Rejected: the tall-lobby
 *    rebate is applied only there, and deleting it deletes the entire point of
 *    a multi-storey lobby.
 * 3. **Boarding re-stamps.** The resolver ends by stamping (`PEOPLE.md`
 *    § Trip-Counter Functions, item 5); the boarding step, which consumes the
 *    stamp the same way, ends by re-arming it for the ride. Every event that
 *    consumes the stamp re-arms it for the next segment of the trip.
 *
 * Reading 3 is the only one that leaves both documented call sites reachable
 * and meaningful: the accumulate then measures the wait on the floor, and the
 * rebase measures the ride. It also falls out correctly for service carriers —
 * `accumulate_elapsed_delay_into_current_sim` returns early for those and
 * leaves the stamp live, so the re-stamp is skipped with it and the single
 * sample covers wait-plus-ride.
 *
 * That is why `DELAY.BOARDING` exists and why it is emitted from the queue
 * drain rather than from route resolution.
 *
 * Floors are **logical**: 0 is the ground lobby, -1 is B1. The reference
 * quotes EXE indices where `logical = exe - 10`; every translation is
 * commented where it happens.
 *
 * Pure and Node-runnable. Route selection consumes no RNG — it is a
 * deterministic scan, which is why an office's fate is reproducible.
 */
import {
  CARRIER_MODE, FLOOR_TABLE_SIZE, LOWEST_FLOOR, NO_TRANSFER_FLOOR, QUEUE_CAPACITY,
  carrierSlotIndex, carrierStopsAtFloor, enqueueRequest, floorQueueCount,
} from './elevators.js';

// ---------------------------------------------------------------- constants

/** `specs/ROUTING.md` § Walkability Rules: 64 stairs/escalator segment slots. */
export const MAX_SEGMENTS = 64;

/** § Lobby Local Access Ranges: up to 8 records, 7 typically live. */
export const MAX_LOCAL_ACCESS_RECORDS = 8;

/** § Transfer Groups: the cache is a hard 16 entries. */
export const MAX_TRANSFER_GROUPS = 16;

/** The cost of an impossible candidate. Never a negative sentinel. */
export const COST_INFINITE = 0x7fff;

/** § Route Costs. Stairs pay `+640` over an escalator of the same length. */
export const STAIRS_EXTRA_COST = 640;
export const DIRECT_ROUTE_COST = 640;
export const DIRECT_ROUTE_FULL_QUEUE_COST = 1000;
export const TRANSFER_ROUTE_COST = 3000;
export const TRANSFER_ROUTE_FULL_QUEUE_COST = 6000;

/**
 * § Delays, "queued-leg timeout threshold". How long a rider parked by a full
 * queue waits before its family re-dispatches and re-runs the whole selector.
 *
 * **This 300 is not the other two 300s.** The elapsed clamp in `sim/stress.js`
 * and the no-route delay are also 300 and are three different rules that
 * happen to share a value. Merging them means a future retune of this timeout
 * silently moves the clamp, so they stay apart on purpose.
 */
export const QUEUED_LEG_TIMEOUT = 300;

/** The ground lobby. EXE floor 10; logical 0. */
export const LOBBY_FLOOR = 0;

/** § Route Resolution Results: `state & 0x3f` is the base state. */
export const STATE_BASE_MASK = 0x3f;

/**
 * Lobby local-access record centres, in logical floors. The reference lists
 * them as EXE 10, 24, 39, 54, 69, 84, 99; `logical = exe - 10` gives the
 * ground lobby plus the sky-lobby cadence `logical % 15 == 14`.
 * § Lobby Local Access Ranges, "Record set".
 */
export const LOCAL_ACCESS_CENTRES = [0, 14, 29, 44, 59, 74, 89];

/**
 * The stress events this module reports. **None of them carries a tick cost.**
 *
 * `sim/stress.js` owns every price and every exemption — the 300, the 5, the
 * 35-against-16, the 30/60 bands, the tall-lobby rebate. This module reports
 * what happened and the facts needed to price it, and nothing else. Recomputing
 * `35 x floors` here would be the stairs-column mistake from the old repo:
 * four copies of one rule, three of them only predicting what the fourth does.
 *
 * Each entry below names the `sim/stress.js` function that consumes it and the
 * payload that function needs.
 *
 * ## Two ordering rules the consumer must keep
 *
 * 1. **Apply every delay, THEN stamp the route start.** Every one of these
 *    events runs through `add_delay_to_current_sim`, which clears
 *    `last_trip_tick` on its way out (`ROUTING.md` § Stair / Escalator Transit
 *    Timing puts the charge at step 3 and the stamp at step 4). Stamping first
 *    destroys the stamp you just wrote and the leg's timing vanishes silently.
 *    `resolveRouteBetweenFloors` writes its own actor stamp inside `finish()`,
 *    after every emit, so the order cannot be got wrong here; a consumer
 *    applying the events to its own record has to keep it by hand.
 *
 * 2. **A fixed delay REPLACES pending transit time — it does not add to it.**
 *    `add_delay_to_current_sim` never folds in `day_tick - last_trip_tick`.
 *    Somebody who has queued 200 ticks and then meets a full queue is charged
 *    5, not 205; the 200 are discarded. Do not wire these as increments on top
 *    of a measured wait.
 */
export const DELAY = {
  /** No payload. -> `recordNoRouteFailure(sim)`: charges 300 and counts the trip. */
  NO_ROUTE: 'no-route',
  /** No payload. -> `applyQueueFullDelay(sim)`. */
  QUEUE_FULL: 'queue-full',
  /**
   * `{ modeAndSpan }` -> `applyLocalSegmentDelay(sim, modeAndSpan)`. Both the
   * branch (bit 0) and the floor count (`(byte >> 1) + 1`) come out of that one
   * byte, so the byte travels and the arithmetic stays in one place.
   */
  LOCAL_TRANSIT: 'local-transit',
  /**
   * `{ heightMetricDelta, carrierMode }` ->
   * `applyDistancePenalty(sim, { ...payload, emitDistanceFeedback: true })`.
   *
   * Emitted only when the caller's `emitDistanceFeedback` gate passed. The
   * **second** gate is deliberately not applied here: `carrierMode` is reported
   * and `sim/stress.js` exempts express. `null` marks a stairs/escalator
   * segment, where the penalty applies to both branches.
   */
  DISTANCE: 'distance',
  /**
   * `{ sourceFloor, carrierMode }`, emitted when a car actually loads a rider.
   * ->
   * ```
   * accumulateElapsedDelayIntoCurrentSim(sim, dayTick, { sourceFloor, lobbyHeight, carrierMode });
   * if (carrierMode !== CARRIER_SERVICE) stampRouteStart(sim, dayTick);
   * ```
   * See the "route-start stamp" note in the header for why the re-stamp is
   * here and why it is skipped for service carriers.
   */
  BOARDING: 'boarding',
  /**
   * No payload. -> `addDelayToCurrentSim(sim, REQUEUE_FAILURE_DELAY)`, which is
   * zero ticks and **not inert**: it still clears the route-start stamp. A
   * consumer that optimises the zero away loses the clearing.
   */
  REQUEUE_FAILURE: 'requeue-failure',
};

/** Route result codes. § Route Resolution Results. */
export const ROUTE = {
  FAILED: -1,
  QUEUE_FULL: 0,
  LOCAL_LEG: 1,
  QUEUED: 2,
  SAME_FLOOR: 3,
};

// -------------------------------------------------------------- segments

/**
 * A stairs or escalator segment.
 *
 * `flags` is the reference's `mode_and_span` byte: bit 0 is the stairs cost
 * bit (`0` escalator, `1` stairs) and bits 7:1 encode the span, such that the
 * walked floor delta of one leg is `(flags >> 1) + 1`.
 * § Stairs / Escalator Segment Flags.
 *
 * `column` is the tile column it stands in — the reference's `height_metric`,
 * which is horizontal despite the name. That is what the distance penalty
 * measures.
 */
export function createSegment({ kind, column = 0, entryFloor, floorsSpanned = 1 }) {
  if (kind !== 'stairs' && kind !== 'escalator') {
    throw new RangeError(`segment kind ${kind} is neither stairs nor escalator`);
  }
  if (floorsSpanned < 1) throw new RangeError('a segment spans at least one floor');
  const stairsBit = kind === 'stairs' ? 1 : 0;
  return {
    active: true,
    kind,
    flags: ((floorsSpanned - 1) << 1) | stairsBit,
    column,
    entryFloor,
  };
}

/** The walked floor delta of one leg over this segment: `(flags >> 1) + 1`. */
export const segmentSpan = (segment) => (segment.flags >> 1) + 1;

/** The upper landing. `entry_floor + (flags >> 1) + 1`. */
export const segmentTopFloor = (segment) => segment.entryFloor + segmentSpan(segment);

export const segmentIsStairs = (segment) => (segment.flags & 1) !== 0;

const segmentCoversFloor = (segment, floor) =>
  floor >= segment.entryFloor && floor <= segmentTopFloor(segment);

/**
 * A segment is entered from a **landing**, not from anywhere along it: going
 * up you must be standing on the entry floor, going down on the top floor.
 * Applied identically to stairs and escalators.
 */
const canEnterSegmentFrom = (segment, fromFloor, toFloor) => (toFloor > fromFloor
  ? fromFloor === segment.entryFloor
  : fromFloor === segmentTopFloor(segment));

// ------------------------------------------------------------ walkability

/**
 * `floor_walkability_flags` is EXE-indexed `0..119`; in logical floors that is
 * `-10..109`. This offset is the only place the translation lives.
 */
const floorIndex = (floor) => floor - LOWEST_FLOOR;
const inFloorTable = (floor) => floor >= LOWEST_FLOOR && floorIndex(floor) < FLOOR_TABLE_SIZE;

/** Read a walkability byte. Off the table reads as 0, i.e. "no floor here". */
export function walkabilityAt(table, floor) {
  if (!inFloorTable(floor)) return 0;
  return table[floorIndex(floor)] ?? 0;
}

/**
 * Rebuild the 120-byte walkability table from the live segments.
 * § Walkability Rules: bit 0 is escalator-branch support, bit 1 is
 * stairs-branch support, and the rebuild scans all 64 slots setting the
 * appropriate bit on every floor a live segment covers.
 */
export function buildWalkability(segments) {
  const table = new Array(FLOOR_TABLE_SIZE).fill(0);
  for (let i = 0; i < Math.min(segments.length, MAX_SEGMENTS); i++) {
    const segment = segments[i];
    if (!segment?.active) continue;
    const bit = segmentIsStairs(segment) ? 2 : 1;
    for (let floor = segment.entryFloor; floor <= segmentTopFloor(segment); floor++) {
      if (inFloorTable(floor)) table[floorIndex(floor)] |= bit;
    }
  }
  return table;
}

/**
 * § Walkability Rules, "Local walkability". Six floors each way, and one gap
 * tolerated only inside the three-floor centre band.
 *
 * Two stop conditions that look alike and are not: a **zero** byte means no
 * floor exists and ends the scan outright, while a nonzero byte with bit 0
 * clear means the floor is there but not locally walkable — a gap, which is
 * survivable near the centre.
 */
export function isSpanWalkableForLocalRoute(table, fromFloor, toFloor) {
  const lower = Math.min(fromFloor, toFloor);
  const upper = Math.max(fromFloor, toFloor);
  if (upper - lower >= 7) return false;
  let seenGap = false;
  // Half-open: the destination floor's own byte is not tested here.
  for (let floor = lower; floor < upper; floor++) {
    const flags = walkabilityAt(table, floor);
    if (flags === 0) return false;
    if ((flags & 1) === 0) seenGap = true;
    if (seenGap && floor - lower > 2) return false;
  }
  return true;
}

/**
 * § Walkability Rules, "Housekeeping walkability": continuous stairs, no gap
 * tolerance. The counter fails at three, so only three intermediate floors are
 * ever checked — a quirk of the original, kept.
 */
export function isSpanWalkableForServiceRoute(table, fromFloor, toFloor) {
  if (Math.abs(toFloor - fromFloor) >= 7) return false;
  const lower = Math.min(fromFloor, toFloor);
  const upper = Math.max(fromFloor, toFloor);
  let count = 0;
  for (let floor = lower; floor < upper; floor++) {
    if ((walkabilityAt(table, floor) & 2) === 0) return false;
    if (count >= 3) return false;
    count += 1;
  }
  return true;
}

// -------------------------------------------------- lobby local access

/**
 * § Lobby Local Access Ranges, "Zone-building rule". Scan outward from a lobby
 * centre for the bound of its walkable span. `dir` 1 is up, 0 is down.
 *
 * TODO(parity): `ROUTING.md`'s prose says the downward scan starts *at* the
 * centre and completes at `center - 6`; the reference's own port (11b8:0763)
 * starts at `center - 1`, returns `floor + 1` on the no-floor exit, and
 * completes at `center - 5`. The two disagree by one floor at both ends. The
 * port is the half with the disassembly address on it, so it is what is
 * implemented here. Listed in the report.
 */
export function scanLocalAccessBound(table, centreFloor, dir) {
  let seenGap = false;
  if (dir !== 0) {
    for (let floor = centreFloor; floor < centreFloor + 6; floor++) {
      const flags = walkabilityAt(table, floor);
      if (flags === 0) return floor;
      if ((flags & 1) === 0) seenGap = true;
      if (seenGap && floor >= centreFloor + 3) return floor;
    }
    return centreFloor + 6;
  }
  for (let floor = centreFloor - 1; floor > centreFloor - 6; floor--) {
    const flags = walkabilityAt(table, floor);
    if (flags === 0) return floor + 1;
    if ((flags & 1) === 0) seenGap = true;
    if (seenGap && floor <= centreFloor - 3) return floor;
  }
  return centreFloor - 5;
}

/**
 * The eight derived local-access records, one per lobby centre. These are not
 * placed objects and they are not ridden — they justify a **one-floor** local
 * hop toward a lobby, after which the actor re-resolves from there.
 */
export function buildLocalAccessRecords(table) {
  const records = Array.from({ length: MAX_LOCAL_ACCESS_RECORDS }, () => ({
    active: false, lowerFloor: 0, upperFloor: 0, reachabilityByFloor: new Array(FLOOR_TABLE_SIZE).fill(0),
  }));
  for (let i = 0; i < LOCAL_ACCESS_CENTRES.length && i < MAX_LOCAL_ACCESS_RECORDS; i++) {
    const centre = LOCAL_ACCESS_CENTRES[i];
    const lowerFloor = scanLocalAccessBound(table, centre, 0);
    const upperFloor = scanLocalAccessBound(table, centre, 1);
    if (lowerFloor >= upperFloor) continue;   // nothing walkable here at all
    records[i] = {
      active: true,
      centre,
      lowerFloor,
      upperFloor,
      reachabilityByFloor: new Array(FLOOR_TABLE_SIZE).fill(0),
    };
  }
  return records;
}

const recordCoversFloor = (record, floor) =>
  floor >= record.lowerFloor && floor <= record.upperFloor;

// ---------------------------------------------------------- transfer groups

/** Bit `n` for carrier `n`; bit `24 + n` for local-access record `n`. */
const carrierBit = (id) => (1 << id) >>> 0;
const recordBit = (index) => (1 << (24 + index)) >>> 0;
const maskHas = (mask, bit) => (mask & bit) !== 0;

/**
 * § Transfer Groups, "Rebuild algorithm". Sky lobbies and transit concourses
 * are where shafts meet; each becomes a cache entry tagged with its floor and
 * a bitmask of everything that reaches it.
 *
 * Entries are stored in discovery order and consecutive duplicates collapse,
 * exactly as the reference describes — the cap of 16 is hard, so a tower with
 * seventeen sky lobbies simply cannot transfer through the last one.
 */
export function buildTransferGroups(carriers, transferFloors, records) {
  const entries = [];
  for (const floor of transferFloors) {
    let mask = 0;
    for (const carrier of carriers) {
      if (carrierStopsAtFloor(carrier, floor)) mask = (mask | carrierBit(carrier.id)) >>> 0;
    }
    const previous = entries[entries.length - 1];
    if (previous && previous.taggedFloor === floor && (previous.carrierMask & mask) !== 0) {
      // Step 5: collapse back into the preceding row rather than append.
      previous.carrierMask = (previous.carrierMask | mask) >>> 0;
      continue;
    }
    if (entries.length >= MAX_TRANSFER_GROUPS) break;
    entries.push({ active: true, taggedFloor: floor, carrierMask: mask });
  }

  // Step 6: the derived lobby ranges contribute their own reachability to any
  // entry they overlap, so a sky lobby you can walk to from a tagged floor
  // joins that floor's transfer group.
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.active) continue;
    for (const entry of entries) {
      if (!recordCoversFloor(record, entry.taggedFloor)) continue;
      entry.carrierMask = (entry.carrierMask | recordBit(i)) >>> 0;
    }
  }
  return entries;
}

/**
 * § Lobby Local Access Ranges, "Per-floor cache format".
 *
 * `0` unreachable; `1..16` a transfer-group index + 1, for a tagged floor
 * inside the record's own span; anything else a participant bitmask (carriers
 * in bits 0..23, peer records in 24..31).
 *
 * TODO(parity): the reference's port allocates this table and never fills it,
 * so the only description of the contents is the prose above. This builds what
 * the prose says. It is the least-pinned thing in the file.
 */
function fillRecordReachability(records, carriers, entries) {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record.active) continue;
    for (let index = 0; index < FLOOR_TABLE_SIZE; index++) {
      const floor = index + LOWEST_FLOOR;
      if (recordCoversFloor(record, floor)) {
        const group = entries.findIndex((entry) => entry.active && entry.taggedFloor === floor);
        record.reachabilityByFloor[index] = group >= 0 ? group + 1 : 0;
        continue;
      }
      let mask = 0;
      for (const carrier of carriers) {
        if (carrierStopsAtFloor(carrier, floor)) mask = (mask | carrierBit(carrier.id)) >>> 0;
      }
      for (let peer = 0; peer < records.length; peer++) {
        if (peer === i || !records[peer].active) continue;
        if (recordCoversFloor(records[peer], floor)) mask = (mask | recordBit(peer)) >>> 0;
      }
      record.reachabilityByFloor[index] = mask;
    }
  }
}

const recordReachabilityAt = (record, floor) =>
  (inFloorTable(floor) ? record.reachabilityByFloor[floorIndex(floor)] ?? 0 : 0);

/**
 * Rebuild every derived routing table and hang them on `tower.routeTables`.
 *
 * § Transfer Groups, "The cache is rebuilt": at the start-of-day checkpoint,
 * after any carrier edit that changes served floors, and after a sky lobby is
 * placed or demolished. Also after a stairs/escalator edit, which is what
 * rebuilds walkability.
 *
 * The rebuild clears the route-failure notice bytes. § Path State: successful
 * routes and the passage of time do **not** clear them; only this does.
 */
export function rebuildRouteTables(tower) {
  const walkability = buildWalkability(tower.segments ?? []);
  const localAccess = buildLocalAccessRecords(walkability);
  const transferGroups = buildTransferGroups(tower.carriers ?? [], tower.transferFloors ?? [], localAccess);
  fillRecordReachability(localAccess, tower.carriers ?? [], transferGroups);
  const tables = {
    walkability,
    localAccess,
    transferGroups,
    failureNotices: new Array(FLOOR_TABLE_SIZE).fill(0),
  };
  tower.routeTables = tables;
  return tables;
}

const tablesOf = (tower) => tower.routeTables ?? rebuildRouteTables(tower);

// ------------------------------------------------------ reachability tests

const derivedRecordReachesFloor = (record, floor) =>
  recordCoversFloor(record, floor) || recordReachabilityAt(record, floor) !== 0;

/**
 * `test_special_link_transfer_reachability` (11b8:0fe6): can any peer
 * local-access record in this entry's mask cover the floor?
 */
function entryRecordsReachFloor(tables, entry, floor) {
  for (let i = 0; i < tables.localAccess.length; i++) {
    if (!maskHas(entry.carrierMask, recordBit(i))) continue;
    const record = tables.localAccess[i];
    if (record.active && derivedRecordReachesFloor(record, floor)) return true;
  }
  return false;
}

/** Does anything in this transfer group put the actor down on `floor`? */
function entryReachesFloor(tower, tables, entry, floor, passengerMode) {
  for (const carrier of tower.carriers) {
    if (!maskHas(entry.carrierMask, carrierBit(carrier.id))) continue;
    // Passengers cannot ride service carriers; housekeeping rides only those.
    if (passengerMode ? carrier.mode === CARRIER_MODE.SERVICE : carrier.mode !== CARRIER_MODE.SERVICE) continue;
    if (carrierStopsAtFloor(carrier, floor)) return true;
  }
  return entryRecordsReachFloor(tables, entry, floor);
}

/**
 * `test_carrier_transfer_reachability` (11b8:0f33). Is `toFloor` reachable by
 * boarding this carrier and changing somewhere? A first-match scan over the
 * 16 cache entries in ascending order — there is no weighting here.
 */
export function testCarrierTransferReachability(tower, carrier, toFloor, passengerMode = true) {
  const tables = tablesOf(tower);
  for (const entry of tables.transferGroups) {
    if (!entry.active) continue;
    if (!maskHas(entry.carrierMask, carrierBit(carrier.id))) continue;
    if (entryReachesFloor(tower, tables, entry, toFloor, passengerMode)) return true;
  }
  return false;
}

/**
 * `choose_transfer_floor_from_carrier_reachability` (11b8:0e41). Where should
 * this leg actually put the rider down? § Transfer Groups, "Transfer-floor
 * selection behavior during queue drain".
 *
 * Directly served: the target floor itself. Otherwise the first transfer-group
 * entry that this carrier belongs to, is not the floor we are standing on,
 * lies in the direction of travel, and whose *other* members reach the target.
 * `NO_TRANSFER_FLOOR` when nothing qualifies — which is the requeue failure
 * that hands the actor back to its family. The reference returns `-1` there
 * and can, because its floors are never negative; ours are, so B1 would read
 * as a failure and every failure would read as B1.
 */
export function chooseTransferFloor(tower, carrier, currentFloor, targetFloor) {
  const tables = tablesOf(tower);
  if (carrierStopsAtFloor(carrier, targetFloor)) return targetFloor;

  const goingUp = targetFloor > currentFloor;
  const ownBit = carrierBit(carrier.id);

  for (const entry of tables.transferGroups) {
    if (!entry.active) continue;
    if (!maskHas(entry.carrierMask, ownBit)) continue;
    if (entry.taggedFloor === currentFloor) continue;
    if (goingUp && entry.taggedFloor <= currentFloor) continue;
    if (!goingUp && entry.taggedFloor >= currentFloor) continue;

    // The carrier's own bit is cleared: it takes somebody *else* to finish
    // the trip, or this is not a transfer at all.
    const peers = (entry.carrierMask & ~ownBit) >>> 0;
    if (!peersReachFloor(tower, tables, peers, targetFloor)) continue;
    return entry.taggedFloor;
  }
  return NO_TRANSFER_FLOOR;
}

function peersReachFloor(tower, tables, mask, floor) {
  for (const carrier of tower.carriers) {
    if (!maskHas(mask, carrierBit(carrier.id))) continue;
    if (carrierStopsAtFloor(carrier, floor)) return true;
  }
  for (let i = 0; i < tables.localAccess.length; i++) {
    if (!maskHas(mask, recordBit(i))) continue;
    const record = tables.localAccess[i];
    if (record.active && derivedRecordReachesFloor(record, floor)) return true;
  }
  return false;
}

// ----------------------------------------------------------------- scorers

/**
 * `score_local_route_segment` (11b8:18fb). § Route Costs: an escalator costs
 * `abs(column_delta) * 8`, stairs the same plus 640.
 *
 * Only the **source** landing is validated — the reference does not range-check
 * the destination against the segment, and neither do we.
 */
export function scoreLocalSegment(segment, fromFloor, toFloor, heightMetric) {
  if (!segment?.active) return COST_INFINITE;
  if (!segmentCoversFloor(segment, fromFloor)) return COST_INFINITE;
  if (!canEnterSegmentFrom(segment, fromFloor, toFloor)) return COST_INFINITE;
  const distance = Math.abs(segment.column - heightMetric) * 8;
  return segmentIsStairs(segment) ? distance + STAIRS_EXTRA_COST : distance;
}

/** `score_housekeeping_route_segment` (11b8:19a8). Stairs only, always +640. */
export function scoreServiceSegment(segment, fromFloor, toFloor, heightMetric) {
  if (!segment?.active) return COST_INFINITE;
  if (!segmentIsStairs(segment)) return COST_INFINITE;
  if (!segmentCoversFloor(segment, fromFloor)) return COST_INFINITE;
  if (!canEnterSegmentFrom(segment, fromFloor, toFloor)) return COST_INFINITE;
  return Math.abs(segment.column - heightMetric) * 8 + STAIRS_EXTRA_COST;
}

/**
 * The carrier scan folds direct and transfer service into one number, taking
 * whichever is cheaper. § Route Costs, "Carrier Costs".
 *
 * Express is scored differently from everything else and it is not an
 * oversight: it ignores the column distance entirely and adds the raw queue
 * depth, so an express car is chosen on how busy it is, not how far away.
 */
export function scoreCarrier(tower, carrier, fromFloor, toFloor, heightMetric, passengerMode = true) {
  if (!carrierStopsAtFloor(carrier, fromFloor)) return COST_INFINITE;
  const directionFlag = toFloor > fromFloor ? 1 : 0;
  const queued = floorQueueCount(carrier, fromFloor, directionFlag);
  const distance = Math.abs(carrier.column - heightMetric) * 8;

  let best = COST_INFINITE;
  if (carrierStopsAtFloor(carrier, toFloor)) {
    best = carrier.mode === CARRIER_MODE.EXPRESS
      ? queued + DIRECT_ROUTE_COST
      : distance + (queued >= QUEUE_CAPACITY ? DIRECT_ROUTE_FULL_QUEUE_COST : DIRECT_ROUTE_COST);
  }
  if (testCarrierTransferReachability(tower, carrier, toFloor, passengerMode)) {
    const transfer = carrier.mode === CARRIER_MODE.EXPRESS
      ? queued + TRANSFER_ROUTE_COST
      : distance + (queued >= QUEUE_CAPACITY ? TRANSFER_ROUTE_FULL_QUEUE_COST : TRANSFER_ROUTE_COST);
    if (transfer < best) best = transfer;
  }
  return best;
}

/**
 * `score_special_link_route` (11b8:0be2). Viability only: `0` or infinite.
 * A local-access range is never ridden, so it has no length to price.
 */
export function scoreLocalAccessRecord(tower, recordIndex, fromFloor, toFloor) {
  const tables = tablesOf(tower);
  const record = tables.localAccess[recordIndex];
  const fail = { cost: COST_INFINITE, direction: 0 };
  if (!record?.active) return fail;
  if (!recordCoversFloor(record, fromFloor)) return fail;
  if (recordCoversFloor(record, toFloor)) {
    return { cost: 0, direction: fromFloor < toFloor ? 1 : 0 };
  }

  const destinationMask = recordReachabilityAt(record, toFloor);
  if (destinationMask !== 0) {
    const sourceValue = recordReachabilityAt(record, fromFloor);
    if (sourceValue !== 0) {
      // Inside the span the table holds a 1-based transfer-group index; that
      // group's members must be a superset of what the destination needs.
      const entry = tables.transferGroups[sourceValue - 1];
      if (entry?.active && ((entry.carrierMask & destinationMask) >>> 0) === destinationMask) {
        return { cost: 0, direction: 0 };
      }
    }
  }

  const own = recordBit(recordIndex);
  for (const entry of tables.transferGroups) {
    if (!entry.active) continue;
    if (!maskHas(entry.carrierMask, own)) continue;
    if (entryRecordsReachFloor(tables, entry, toFloor)) return { cost: 0, direction: 0 };
  }
  return fail;
}

// ---------------------------------------------------------------- selector

/**
 * `select_best_route_candidate` (11b8:1484). § Candidate Priority.
 *
 * Three stages, and the order is the rule:
 *
 * 1. the 64 stairs/escalator segments, gated on the span being walkable. An
 *    escalator under 640 wins outright and returns immediately;
 * 2. only if stage 1 found nothing at all, the 8 lobby local-access ranges —
 *    and a hit there triggers a *second* segment scan, against the adjacent
 *    floor, because a range only justifies a one-floor hop;
 * 3. the 24 carriers, scanned last, against whatever cost stage 1 preserved.
 *
 * Every comparison is a strict `<`, so a tie keeps the earlier candidate in
 * scan order. That is what makes the choice deterministic.
 *
 * Returns `{ kind: 'segment'|'carrier', id, cost }`, or `null` for no route.
 */
export function selectBestRouteCandidate(tower, fromFloor, toFloor, passengerMode = true, heightMetric = 0) {
  if (fromFloor === toFloor) return null;
  const tables = tablesOf(tower);
  const segments = tower.segments ?? [];
  const delta = Math.abs(fromFloor - toFloor);

  let bestCost = COST_INFINITE;
  let bestIndex = -1;

  const scanSegments = (source, destination, score) => {
    for (let i = 0; i < Math.min(segments.length, MAX_SEGMENTS); i++) {
      const cost = score(segments[i], source, destination, heightMetric);
      if (cost < bestCost) { bestCost = cost; bestIndex = i; }
    }
  };

  if (!passengerMode) {
    // Housekeeping: stairs only, and the first hit wins outright.
    if (delta === 1 || isSpanWalkableForServiceRoute(tables.walkability, fromFloor, toFloor)) {
      scanSegments(fromFloor, toFloor, scoreServiceSegment);
      if (bestIndex >= 0) return { kind: 'segment', id: bestIndex, cost: bestCost };
    }
  } else {
    if (delta === 1 || isSpanWalkableForLocalRoute(tables.walkability, fromFloor, toFloor)) {
      scanSegments(fromFloor, toFloor, scoreLocalSegment);
      // An escalator (no +640) beats anything a lift could offer, so it
      // returns immediately. A stairs winner is kept but does NOT return: it
      // stays as the threshold the carriers have to beat.
      if (bestIndex >= 0 && bestCost < STAIRS_EXTRA_COST) {
        return { kind: 'segment', id: bestIndex, cost: bestCost };
      }
    }

    if (bestIndex < 0) {
      let direction = 0;
      let foundRecord = false;
      for (let i = 0; i < MAX_LOCAL_ACCESS_RECORDS; i++) {
        const result = scoreLocalAccessRecord(tower, i, fromFloor, toFloor);
        if (result.cost < bestCost) {
          bestCost = result.cost; bestIndex = i; direction = result.direction; foundRecord = true;
        }
      }
      if (foundRecord) {
        // A range justifies one floor toward the lobby, and that step still has
        // to be covered by a real segment. The running minimum resets first.
        const adjacent = direction === 0 ? fromFloor - 1 : fromFloor + 1;
        bestCost = COST_INFINITE;
        bestIndex = -1;
        scanSegments(fromFloor, adjacent, scoreLocalSegment);
        if (bestIndex >= 0 && bestCost < STAIRS_EXTRA_COST) {
          return { kind: 'segment', id: bestIndex, cost: bestCost };
        }
      }
    }
  }

  let carrierIndex = -1;
  for (const carrier of tower.carriers ?? []) {
    // Passengers never ride service cars; housekeeping rides nothing else.
    if (passengerMode ? carrier.mode === CARRIER_MODE.SERVICE : carrier.mode !== CARRIER_MODE.SERVICE) continue;
    const cost = scoreCarrier(tower, carrier, fromFloor, toFloor, heightMetric, passengerMode);
    if (cost < bestCost) { bestCost = cost; carrierIndex = carrier.id; bestIndex = -1; }
  }

  if (carrierIndex >= 0) return { kind: 'carrier', id: carrierIndex, cost: bestCost };
  if (bestIndex >= 0) return { kind: 'segment', id: bestIndex, cost: bestCost };
  return null;
}

// ------------------------------------------- emit_distance_feedback gating

/**
 * § `emit_distance_feedback` Gating, the per-family table.
 *
 * **Keyed on the BASE state, `state & 0x3f`** — never on the raw byte. That
 * masking is the whole mechanism: an in-transit `0x40` inherits `0x00`'s
 * answer, which is what makes the distance penalty fire once per route instead
 * of once per refresh stride. Read the raw byte instead and every continuation
 * state falls off the end of this table with no entry at all.
 *
 * Housekeeping (`0x0f`) is absent on purpose: it passes `0` for both
 * `is_passenger_route` and `emit_distance_feedback` at every call site, so its
 * routes never contribute stress.
 */
const DISTANCE_FEEDBACK_STATES = {
  0x03: [0x20, 0x01, 0x05],          // hotel single
  0x04: [0x20, 0x01, 0x05],          // hotel twin
  0x05: [0x20, 0x01, 0x05],          // hotel suite
  0x07: [0x00, 0x05],                // office: the two commutes, and only those
  0x09: [0x00, 0x01, 0x20],          // condo: the outbound trips
  0x12: [0x20],                      // entertainment: arrival only
  0x1d: [0x20],
};

/** `state & 0x3f`. The in-transit bit is `0x40`; the base state is what gates. */
export const baseState = (stateCode) => stateCode & STATE_BASE_MASK;

/**
 * Should this actor's route resolution charge the long-distance penalty?
 *
 * Written once, here, because four call sites deriving it independently is how
 * the gate ends up right in one family and wrong in the next. Pass the raw
 * state byte; the masking happens inside.
 */
export function emitsDistanceFeedback(familyCode, stateCode) {
  const states = DISTANCE_FEEDBACK_STATES[familyCode];
  if (!states) return false;
  return states.includes(baseState(stateCode));
}

// ---------------------------------------------------------- route tokens

/** § Route Resolution Results: `0x40 + id` riding up, `0x58 + id` riding down. */
export const CARRIER_TOKEN_UP = 0x40;
export const CARRIER_TOKEN_DOWN = 0x58;
/** "Waiting, not yet queued" — the queue-full marker. Not a floor, not -1. */
export const WAITING_TOKEN = 0xff;

export const carrierToken = (id, directionFlag) =>
  (directionFlag === 1 ? CARRIER_TOKEN_UP : CARRIER_TOKEN_DOWN) + id;

// --------------------------------------------------------------- resolver

/**
 * `resolve_sim_route_between_floors` (1218:0000). One leg, and the answer to
 * "does this tenant exist".
 *
 * @param tower   see the interface block at the top of this file
 * @param actor   `{ id, homeColumn }`; five route fields are written back
 * @param sourceFloor       logical floor the actor stands on
 * @param destinationFloor  logical floor it ultimately wants
 * @param clock   `{ dayTick }` — the route-start timestamp. Never wall time.
 * @param options `{ passengerRoute = true, emitDistanceFeedback = true,
 *                   heightMetric, onDelay }`
 *
 * @returns `{ code, delays, routeStartTick, advanceTripCounters,
 *             legDestination, waitingFloor, token, carrierId, segmentId,
 *             emitFailureNotice }`
 *
 * `delays` carries no tick costs — see `DELAY`. `advanceTripCounters` is true
 * only for results `3` and `-1`: those are the two sites where the reference
 * calls `advance_sim_trip_counters` at resolution time. An **accepted** leg
 * (`0`, `1`, `2`) must not be counted here. Its trip is counted later, at
 * completion or cancellation or at the queued-car arrival callback, and
 * counting at both ends of one ride doubles `trip_count` against a single
 * elapsed sample and halves the apparent stress — a metric improving while the
 * thing it measures gets worse, which is the failure shape `CLAUDE.md` says to
 * distrust.
 *
 * The five result codes, per § Route Resolution Results:
 *
 * | code | meaning | queued? |
 * |---|---|---|
 * | `3`  | same floor, arrive now | no |
 * | `2`  | queued on a carrier | yes |
 * | `1`  | walking a stairs/escalator leg | no |
 * | `0`  | source queue full, waiting | no |
 * | `-1` | no route — the office does not rent | no |
 */
export function resolveRouteBetweenFloors(tower, actor, sourceFloor, destinationFloor, clock, options = {}) {
  const {
    passengerRoute = true,
    emitDistanceFeedback = true,
    heightMetric = actor?.homeColumn ?? 0,
    onDelay = null,
  } = options;

  const delays = [];
  /**
   * No zero-suppression here. `ROUTING.md` § Delays lists two delays whose
   * value IS zero — requeue-failure and invalid-venue — and they are not
   * inert: they still run through `add_delay_to_current_sim`, which still
   * clears the route-start stamp. Dropping them because they cost nothing
   * loses the clearing. Where the reference genuinely makes no call at all
   * (a distance under 79, a single-storey lobby) the guard is at the call
   * site, not in here.
   */
  const emit = (kind, payload = {}) => {
    const delay = { kind, ...payload };
    delays.push(delay);
    onDelay?.(delay);
  };

  /**
   * Every return path goes through here, and the route-start stamp is written
   * here, which is what makes the ordering structural rather than a rule
   * somebody has to remember. `ROUTING.md` § Stair / Escalator Transit Timing
   * charges the delay at step 3 and stamps at step 4, and the order matters
   * because `add_delay_to_current_sim` clears the stamp on its way out —
   * stamping first destroys the stamp and the leg's timing disappears without
   * an error. Emits happen in the branches above; the stamp cannot precede
   * them from inside the function that builds the return value.
   *
   * The stamp is written on **every** result, including `-1` and `0`.
   * `PEOPLE.md` § Trip-Counter Functions item 5 puts it at the end of
   * `resolve_sim_route_between_floors` unconditionally, and it has to be:
   * the delay those two paths just charged cleared the field, and a cleared
   * field is read as tick zero by whatever measures next.
   */
  const finish = (result) => {
    if (actor) actor.routeStartTick = clock?.dayTick ?? actor.routeStartTick;
    return { delays, routeStartTick: clock?.dayTick ?? null, ...result };
  };

  // § Route Resolution Results: same floor is 3, not 2, precisely so the
  // caller can short-circuit the arrival path without touching a queue.
  if (sourceFloor === destinationFloor) {
    if (actor) actor.legDestination = destinationFloor;
    return finish({
      code: ROUTE.SAME_FLOOR,
      advanceTripCounters: passengerRoute,
      legDestination: destinationFloor,
      waitingFloor: null,
      token: null,
      carrierId: null,
      segmentId: null,
      emitFailureNotice: false,
    });
  }

  const tables = tablesOf(tower);
  const candidate = selectBestRouteCandidate(
    tower, sourceFloor, destinationFloor, passengerRoute, heightMetric,
  );

  if (!candidate) {
    // The 300-tick no-route delay IS the clamp — one failed trip is as bad as
    // a trip can be, which is why bad transport evicts tenants rather than
    // merely annoying them.
    let notice = false;
    if (passengerRoute) {
      emit(DELAY.NO_ROUTE);
      // § Path State: one popup per source floor, until the tables rebuild.
      if (emitDistanceFeedback && inFloorTable(sourceFloor)
        && tables.failureNotices[floorIndex(sourceFloor)] === 0) {
        tables.failureNotices[floorIndex(sourceFloor)] = 1;
        notice = true;
      }
    }
    if (actor) {
      actor.route = null;
      actor.waitingFloor = null;
      actor.legDestination = sourceFloor;
    }
    return finish({
      code: ROUTE.FAILED,
      advanceTripCounters: passengerRoute,
      legDestination: sourceFloor,
      waitingFloor: null,
      token: null,
      carrierId: null,
      segmentId: null,
      emitFailureNotice: notice,
    });
  }

  if (candidate.kind === 'segment') {
    const segment = (tower.segments ?? [])[candidate.id];
    const floors = segmentSpan(segment);
    const direction = destinationFloor > sourceFloor ? 1 : -1;
    // One leg only: the actor lands on the segment's far landing and
    // re-resolves from there next stride.
    const legDestination = sourceFloor + direction * floors;

    if (emitDistanceFeedback) {
      // § Delays: for a segment the penalty applies to BOTH branches, so
      // `carrierMode` is null — there is no exemption to report here.
      emit(DELAY.DISTANCE, { heightMetricDelta: segment.column - heightMetric, carrierMode: null });
    }
    if (passengerRoute) {
      // The per-stop delay is a stress cost, not a wait — the leg completes in
      // one refresh stride either way, and stairs simply cost more. The whole
      // span byte travels so `sim/stress.js` can read both the branch (bit 0)
      // and the floor count out of it; multiplying here would be a second copy
      // of a rule that already has a home.
      emit(DELAY.LOCAL_TRANSIT, { modeAndSpan: segment.flags });
    }
    if (actor) {
      actor.route = { mode: 'segment', segmentId: candidate.id, destination: destinationFloor };
      actor.legDestination = legDestination;
      actor.destinationFloor = destinationFloor;
      actor.waitingFloor = null;
    }
    return finish({
      code: ROUTE.LOCAL_LEG,
      advanceTripCounters: false,
      legDestination,
      waitingFloor: null,
      token: candidate.id,
      carrierId: null,
      segmentId: candidate.id,
      emitFailureNotice: false,
    });
  }

  const carrier = (tower.carriers ?? []).find((c) => c.id === candidate.id);
  if (!carrier) {
    // The selector named a carrier that is no longer there. Same as no route.
    if (passengerRoute) emit(DELAY.NO_ROUTE);
    return finish({
      code: ROUTE.FAILED,
      advanceTripCounters: passengerRoute,
      legDestination: sourceFloor,
      waitingFloor: null,
      token: null,
      carrierId: null,
      segmentId: null,
      emitFailureNotice: false,
    });
  }

  const directionFlag = destinationFloor > sourceFloor ? 1 : 0;
  const queued = enqueueRequest(carrier, actor?.id ?? actor, sourceFloor, directionFlag);

  if (!queued) {
    // § Queue-Full Retry Behavior: no retry counter, no maximum. The actor
    // waits on the source floor and the 300-tick queued-leg timeout is the
    // only gate; when it fires the family re-runs the whole selector, which
    // is how the +1000/+6000 full-queue surcharges steer it somewhere else.
    if (passengerRoute) emit(DELAY.QUEUE_FULL);
    if (actor) {
      actor.route = null;
      actor.waitingFloor = sourceFloor;
      actor.legDestination = sourceFloor;
      actor.destinationFloor = destinationFloor;
    }
    return finish({
      code: ROUTE.QUEUE_FULL,
      advanceTripCounters: false,
      legDestination: sourceFloor,
      waitingFloor: sourceFloor,
      token: WAITING_TOKEN,
      carrierId: carrier.id,
      segmentId: null,
      emitFailureNotice: false,
    });
  }

  if (emitDistanceFeedback) {
    // The carrier's mode is REPORTED, not acted on. § Delays says the penalty
    // applies only when `carrier_mode != 0`, so express is exempt — but the
    // tall-lobby rebate exempts SERVICE and pays express. Two exemptions on the
    // same two-bit field, running opposite ways, and neither is "the express
    // one". Encoding either here would put a copy of one of them in a file that
    // does not own it, so both live in `sim/stress.js` and this reports the
    // mode.
    emit(DELAY.DISTANCE, {
      heightMetricDelta: carrier.column - heightMetric,
      carrierMode: carrier.mode,
    });
  }
  // No boarding event here. The tall-lobby rebate is applied by
  // `accumulate_elapsed_delay_into_current_sim`, which fires at
  // `assign_request_to_runtime_route` — the queue drain, when a car actually
  // loads the rider — not when the rider joins the queue. See DELAY.BOARDING,
  // emitted from `drainFloorQueue`.

  const token = carrierToken(carrier.id, directionFlag);
  if (actor) {
    actor.route = { mode: 'carrier', carrierId: carrier.id, direction: directionFlag, source: sourceFloor };
    // The rider stands on the source floor until a car actually collects them.
    actor.waitingFloor = sourceFloor;
    actor.legDestination = sourceFloor;
    actor.destinationFloor = destinationFloor;
  }
  return finish({
    code: ROUTE.QUEUED,
    advanceTripCounters: false,
    legDestination: sourceFloor,
    waitingFloor: sourceFloor,
    token,
    carrierId: carrier.id,
    segmentId: null,
    emitFailureNotice: false,
  });
}

/**
 * The context object `elevators.js` needs to drain a queue, wired to these
 * tables. `targetFloorOf` and `onArrive` stay the caller's — they are family
 * business, and this module deliberately knows nothing about families.
 *
 * `emitDelay(ref, event)` receives the `boarding` and `requeue-failure` events
 * from the drain, in the same shape `resolveRouteBetweenFloors` reports. The
 * boarding event is the one that carries `sourceFloor` for the tall-lobby
 * rebate; `tower.lobbyHeight` is added here so the consumer has everything
 * `accumulateElapsedDelayIntoCurrentSim` asks for without reaching back into
 * the tower.
 */
export function makeCarrierContext(tower, {
  targetFloorOf, onArrive, onRequeueFailure, onBoard, onDelay,
}) {
  return {
    targetFloorOf,
    onArrive,
    onRequeueFailure,
    onBoard,
    emitDelay: onDelay
      ? (ref, event) => onDelay(ref, event.kind === DELAY.BOARDING
        ? { ...event, lobbyHeight: tower.lobbyHeight ?? 1 }
        : event)
      : undefined,
    chooseTransferFloor: (carrier, ref, currentFloor, targetFloor) =>
      chooseTransferFloor(tower, carrier, currentFloor, targetFloor),
  };
}

/** Exported for the tower model: which slot a floor occupies on a carrier. */
export { carrierSlotIndex };
