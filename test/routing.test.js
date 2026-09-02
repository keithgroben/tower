/**
 * Route resolution, checked against `specs/ROUTING.md` rather than against
 * what the resolver happens to return.
 *
 * The failure paths get the most attention here on purpose. A route that
 * resolves is a commute; a route that does not is a tenant who never moves in,
 * or one who leaves. `-1` is the interesting case.
 *
 * Every assertion cites a spec section. Changing one of these numbers is a
 * deviation for `spec/DEVIATIONS.md`.
 */
import {
  CARRIER_MODE, NO_TRANSFER_FLOOR, addCar, createCarrier, drainFloorQueue, enqueueRequest,
  floorQueueCount, tickCarriers,
} from '../src/games/tower/sim/elevators.js';
import {
  COST_INFINITE, DELAY, DIRECT_ROUTE_COST, DIRECT_ROUTE_FULL_QUEUE_COST,
  LOCAL_ACCESS_CENTRES, MAX_TRANSFER_GROUPS, QUEUED_LEG_TIMEOUT, ROUTE,
  STAIRS_EXTRA_COST, TRANSFER_ROUTE_COST, WAITING_TOKEN,
  baseState, buildLocalAccessRecords, buildWalkability, carrierToken, chooseTransferFloor,
  QUEUED_LEG_TIMEOUT as TIMEOUT,
  createSegment, emitsDistanceFeedback, isQueuedOnCarrier, isSpanWalkableForLocalRoute,
  isSpanWalkableForServiceRoute, makeCarrierContext, rebuildRouteTables,
  resolveRouteBetweenFloors, scoreCarrier, scoreLocalSegment, selectBestRouteCandidate,
  shouldWaitForQueuedCarrier, walkabilityAt,
} from '../src/games/tower/sim/routing.js';
import * as routing from '../src/games/tower/sim/routing.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const clock = { dayTick: 500, daypart: 0, calendarPhase: false };

/** A tower with its route tables built. Everything the router reads, and no more. */
function makeTower({ carriers = [], segments = [], transferFloors = [], lobbyHeight = 1 } = {}) {
  const tower = { carriers, segments, transferFloors, lobbyHeight };
  rebuildRouteTables(tower);
  return tower;
}

/** A standard shaft with one car, so the first enqueue has something to assign. */
function shaft({ id = 0, mode = CARRIER_MODE.STANDARD, bottomFloor = 0, topFloor = 20, column = 0 } = {}) {
  const carrier = createCarrier({ id, mode, bottomFloor, topFloor, column });
  addCar(carrier, bottomFloor);
  return carrier;
}

const worker = (homeColumn = 0) => ({ id: 'w1', homeColumn });

const delayOf = (result, kind) => result.delays.find((d) => d.kind === kind);

export const tests = {
  // ----------------------------------------------------------- result codes

  /**
   * The five codes, and the one that looks like a typo. Same-floor is `3`, not
   * `2`, precisely so a caller can arrive immediately without touching a queue.
   */
  'the five result codes are the reference’s, and same-floor is 3'() {
    // specs/ROUTING.md § Route Resolution Results.
    assert(ROUTE.SAME_FLOOR === 3, 'same-floor success is 3');
    assert(ROUTE.LOCAL_LEG === 1, 'a direct stairs/escalator leg is 1');
    assert(ROUTE.QUEUED === 2, 'an elevator queue assignment is 2');
    assert(ROUTE.QUEUE_FULL === 0, 'queue-full waiting is 0');
    assert(ROUTE.FAILED === -1, 'no-route failure is -1');

    const tower = makeTower({ carriers: [shaft()] });
    const result = resolveRouteBetweenFloors(tower, worker(), 7, 7, clock);
    assert(result.code === ROUTE.SAME_FLOOR, 'a same-floor request returned ' + result.code);
    assert(result.delays.length === 0, 'a same-floor arrival costs nothing');
    assert(result.advanceTripCounters === true,
      'same-floor success is one of the trip-counter advance sites');
    assert(floorQueueCount(tower.carriers[0], 7, 1) === 0, 'a same-floor request must not queue');
  },

  // -------------------------------------------------------- the failure path

  /**
   * The one the whole loop rests on. A trip that cannot be routed costs 300 —
   * the clamp, i.e. maximally bad — which is what drives an office's evaluation
   * to zero and evicts the tenant. If this returns anything else, transport
   * stops deciding occupancy.
   */
  'no route reports the failure event, and counts the trip'() {
    // specs/ROUTING.md § Delays, "Mutation by result": result -1 does not
    // enqueue, applies the no-route delay, and PEOPLE.md § When Counters
    // Advance lists route failure as an advance site. The 300 itself belongs to
    // sim/stress.js — this module reports the event, not its price.
    const tower = makeTower();                       // nothing built at all
    const result = resolveRouteBetweenFloors(tower, worker(), 0, 5, clock);
    assert(result.code === ROUTE.FAILED, 'an empty tower routed somebody, code ' + result.code);
    assert(result.delays.length === 1, 'expected exactly one event, got ' + JSON.stringify(result.delays));
    assert(delayOf(result, DELAY.NO_ROUTE) !== undefined, 'the no-route event was not reported');
    assert(delayOf(result, DELAY.NO_ROUTE).ticks === undefined,
      'routing must not price its own events; sim/stress.js owns the 300');
    assert(result.advanceTripCounters === true, 'route failure advances the trip counters');
    assert(result.token === null && result.waitingFloor === null,
      'a failed route must not leave a route token behind');
  },

  /**
   * The counting rule, across all five results in one place. Counting an
   * accepted leg here as well as at its arrival doubles `trip_count` against a
   * single elapsed sample and halves the apparent stress — a metric improving
   * while the thing it measures gets worse.
   */
  'only same-floor and failure count a trip at resolution time'() {
    // PEOPLE.md § When Counters Advance: resolve_sim_route_between_floors is an
    // advance site for same-floor success (3) and route failure (-1). An
    // accepted leg is counted later — at completion, cancellation, or the
    // queued-car arrival callback.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const withLift = makeTower({
      carriers: [carrier], segments: [createSegment({ kind: 'stairs', column: 0, entryFloor: 0 })],
    });

    const sameFloor = resolveRouteBetweenFloors(withLift, worker(), 7, 7, clock);
    assert(sameFloor.code === ROUTE.SAME_FLOOR && sameFloor.advanceTripCounters === true,
      'same-floor arrival (3) counts a trip');
    const failed = resolveRouteBetweenFloors(makeTower(), worker(), 0, 5, clock);
    assert(failed.code === ROUTE.FAILED && failed.advanceTripCounters === true,
      'route failure (-1) counts a trip');

    const segment = resolveRouteBetweenFloors(withLift, worker(), 0, 1, clock);
    assert(segment.code === ROUTE.LOCAL_LEG && segment.advanceTripCounters === false,
      'an accepted local leg (1) must NOT count a trip here');
    const queued = resolveRouteBetweenFloors(withLift, { id: 'q', homeColumn: 0 }, 0, 10, clock);
    assert(queued.code === ROUTE.QUEUED && queued.advanceTripCounters === false,
      'an accepted carrier leg (2) must NOT count a trip here — its arrival does');
    for (let i = 0; i < 40; i++) {
      resolveRouteBetweenFloors(withLift, { id: 'f' + i, homeColumn: 0 }, 0, 10, clock);
    }
    const full = resolveRouteBetweenFloors(withLift, { id: 'late', homeColumn: 0 }, 0, 10, clock);
    assert(full.code === ROUTE.QUEUE_FULL && full.advanceTripCounters === false,
      'waiting on a full queue (0) is not a completed trip');
  },

  /**
   * The ordering rule that fails silently. `add_delay_to_current_sim` clears
   * the route-start stamp on its way out, so the stamp has to be written after
   * every delay — `ROUTING.md` § Stair / Escalator Transit Timing puts the
   * charge at step 3 and the stamp at step 4. Stamp first and you destroy the
   * stamp you just wrote, and that leg's timing vanishes with no error.
   */
  'the route-start stamp is written after every delay, on every result'() {
    const tower = makeTower({
      carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 200 })],
      segments: [createSegment({ kind: 'stairs', column: 200, entryFloor: 0 })],
    });
    const later = { dayTick: 900, daypart: 0, calendarPhase: false };

    // Each case: an actor carrying an OLD stamp. At the moment any delay
    // fires, the stamp must still be the old value — never the new tick.
    const cases = [[0, 5, 'a local leg'], [0, 10, 'a carrier leg'], [7, 7, 'a same-floor arrival']];
    for (const [from, to, what] of cases) {
      const actor = { id: 'w' + from + to, homeColumn: 0, lastTripTick: 111 };
      let stampSeenDuringDelays = null;
      const result = resolveRouteBetweenFloors(tower, actor, from, to, later, {
        onDelay: () => { stampSeenDuringDelays = actor.lastTripTick; },
      });
      if (stampSeenDuringDelays !== null) {
        assert(stampSeenDuringDelays === 111,
          what + ': the stamp was already ' + stampSeenDuringDelays
          + ' while delays were still firing — it must be written last');
      }
      assert(actor.lastTripTick === later.dayTick,
        what + ': the stamp should end at the current tick, it is ' + actor.lastTripTick);
      assert(result.lastTripTick === later.dayTick, what + ': the result should report the stamp');
    }

    // ...including the two paths that only ever charge a delay. A cleared stamp
    // reads as tick zero and charges the whole day to whatever measures next.
    const failure = resolveRouteBetweenFloors(makeTower(), { id: 'x', homeColumn: 0 }, 0, 5, later);
    assert(failure.lastTripTick === later.dayTick, 'result -1 still re-arms the stamp');
  },

  'a floor the carrier does not serve is not routable'() {
    // § Route Costs: a carrier scores at all only when it serves the source,
    // and directly only when it also serves the target.
    const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 10 })] });
    const up = resolveRouteBetweenFloors(tower, worker(), 0, 20, clock);
    assert(up.code === ROUTE.FAILED, 'floor 20 is above a 0..10 shaft; got code ' + up.code);
    const down = resolveRouteBetweenFloors(tower, worker(), 0, -3, clock);
    assert(down.code === ROUTE.FAILED, 'B3 is below a 0..10 shaft; got code ' + down.code);
    // ...and the same request one floor inside the span does resolve, so the
    // test is bounding the rule rather than just observing a broken tower.
    const inside = resolveRouteBetweenFloors(tower, worker(), 0, 10, clock);
    assert(inside.code === ROUTE.QUEUED, 'floor 10 is the top served floor and should route');
  },

  'a span longer than one shaft needs a transfer, and fails without one'() {
    // § Carrier Costs, transfer branch + § Transfer Groups. A standard shaft
    // is capped at 31 floors, so floor 40 is out of reach of any single one.
    const lower = shaft({ id: 0, bottomFloor: 0, topFloor: 30 });
    const upperDisjoint = shaft({ id: 1, bottomFloor: 31, topFloor: 44 });

    // The two shafts touch nowhere, so no transfer group can join them.
    const broken = makeTower({ carriers: [lower, upperDisjoint], transferFloors: [30] });
    const failed = resolveRouteBetweenFloors(broken, worker(), 0, 40, clock);
    assert(failed.code === ROUTE.FAILED,
      'shafts 0..30 and 31..44 share no floor, so floor 40 is unreachable; got ' + failed.code);
    assert(delayOf(failed, DELAY.NO_ROUTE) !== undefined,
      'the broken chain should report a no-route failure');

    // Overlap them on floor 30 and put a sky lobby there, and the chain closes.
    const upperJoined = shaft({ id: 1, bottomFloor: 30, topFloor: 44 });
    const joined = makeTower({
      carriers: [shaft({ id: 0, bottomFloor: 0, topFloor: 30 }), upperJoined],
      transferFloors: [30],
    });
    const ok = resolveRouteBetweenFloors(joined, worker(), 0, 40, clock);
    assert(ok.code === ROUTE.QUEUED, 'with a shared sky lobby the trip should queue, got ' + ok.code);
    assert(ok.carrierId === 0, 'the first leg belongs to the lower shaft, got carrier ' + ok.carrierId);
    assert(chooseTransferFloor(joined, joined.carriers[0], 0, 40) === 30,
      'the rider should be put down on the shared floor 30');
  },

  'a transfer floor that is not in the direction of travel is refused'() {
    // § Transfer Groups, "Transfer-floor selection behavior during queue
    // drain": "upward travel accepts only tagged floors above the current
    // floor". A transfer below you is no use going up.
    //
    // The fixture is built so the WRONG-direction entry would otherwise win:
    // the sky lobby on floor 5 comes first in the cache and its peer shaft D
    // really does reach floor 35. Only the direction clause rules it out, so
    // dropping that clause sends an upward rider fifteen floors backwards.
    const b = shaft({ id: 0, bottomFloor: 0, topFloor: 30 });    // the rider's shaft
    const a = shaft({ id: 1, bottomFloor: 30, topFloor: 44 });   // reaches 35 via floor 30
    const d = shaft({ id: 2, bottomFloor: 5, topFloor: 35 });    // reaches 35 via floor 5
    const e = shaft({ id: 3, bottomFloor: -9, topFloor: 5 });    // reaches B3 via floor 5
    const tower = makeTower({ carriers: [b, a, d, e], transferFloors: [5, 30] });

    assert(tower.routeTables.transferGroups[0].taggedFloor === 5,
      'the floor-5 lobby should be first in the cache, so it is the one tried first');
    assert(chooseTransferFloor(tower, b, 20, 35) === 30,
      'an upward rider must change at 30, not double back to the lobby on 5');
    // ...and a rider heading for a basement the shaft does not serve is allowed
    // that same floor-5 transfer, because now it IS in the direction of travel.
    assert(chooseTransferFloor(tower, b, 20, -3) === 5,
      'a downward rider should be allowed the transfer below it');

    // Standing on the tagged floor itself: the scan skips it outright, and the
    // failure sentinel is not a floor.
    assert(chooseTransferFloor(tower, d, 30, 44) === NO_TRANSFER_FLOOR,
      'a transfer tagged to the floor we are standing on must be skipped');
    assert(chooseTransferFloor(tower, d, 30, 44) !== -1,
      '-1 would be the first basement, not a failure');
  },

  'passengers cannot ride a service carrier, and housekeeping rides nothing else'() {
    // § Candidate Priority: housekeeping mode is family 0x0f with
    // is_passenger_route == 0; passenger and service carriers do not mix.
    const serviceOnly = makeTower({ carriers: [shaft({ mode: CARRIER_MODE.SERVICE })] });
    const passenger = resolveRouteBetweenFloors(serviceOnly, worker(), 0, 10, clock);
    assert(passenger.code === ROUTE.FAILED,
      'a passenger boarded a service elevator; code ' + passenger.code);
    const janitor = resolveRouteBetweenFloors(serviceOnly, worker(), 0, 10, clock,
      { passengerRoute: false, emitDistanceFeedback: false });
    assert(janitor.code === ROUTE.QUEUED, 'housekeeping should ride the service car, got ' + janitor.code);
    assert(janitor.delays.length === 0,
      'housekeeping passes 0 for is_passenger_route, so it never contributes stress');

    const passengerOnly = makeTower({ carriers: [shaft({ mode: CARRIER_MODE.STANDARD })] });
    const strandedJanitor = resolveRouteBetweenFloors(passengerOnly, worker(), 0, 10, clock,
      { passengerRoute: false, emitDistanceFeedback: false });
    assert(strandedJanitor.code === ROUTE.FAILED,
      'housekeeping rode a standard passenger car; code ' + strandedJanitor.code);
  },

  'a failed route warns once per source floor, until the tables are rebuilt'() {
    // § Path State: "if the byte is clear, a route-failure notification is
    // built and shown, then that source-floor byte is set to 1"; and § Transfer
    // Groups: only a reachability rebuild clears it — not success, not time.
    const tower = makeTower();
    assert(resolveRouteBetweenFloors(tower, worker(), 0, 5, clock).emitFailureNotice === true,
      'the first failure from a floor should raise a notice');
    assert(resolveRouteBetweenFloors(tower, worker(), 0, 5, clock).emitFailureNotice === false,
      'the second failure from the same floor must be suppressed');
    assert(resolveRouteBetweenFloors(tower, worker(), 5, 9, clock).emitFailureNotice === true,
      'suppression is per source floor, so floor 5 gets its own notice');
    rebuildRouteTables(tower);
    assert(resolveRouteBetweenFloors(tower, worker(), 0, 5, clock).emitFailureNotice === true,
      'a route-topology rebuild clears the suppression bytes');
  },

  // ------------------------------------------------------------ queue full

  'a full source queue waits five ticks and does not enqueue'() {
    // § Delays: "queue-full waiting delay: 5". Mutation by result: "result 0
    // ... does not insert a queue-ring entry".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const tower = makeTower({ carriers: [carrier] });
    for (let i = 0; i < 40; i++) {
      resolveRouteBetweenFloors(tower, { id: 'q' + i, homeColumn: 0 }, 0, 10, clock);
    }
    assert(floorQueueCount(carrier, 0, 1) === 40, 'the ring should be at its 40-entry limit');

    const result = resolveRouteBetweenFloors(tower, worker(), 0, 10, clock);
    assert(result.code === ROUTE.QUEUE_FULL, 'the 41st rider got code ' + result.code + ', expected 0');
    assert(delayOf(result, DELAY.QUEUE_FULL) !== undefined, 'the queue-full event was not reported');
    assert(floorQueueCount(carrier, 0, 1) === 40, 'the queue-full path must not insert an entry');
    assert(result.waitingFloor === 0, 'the rider waits on the source floor');
    assert(result.token === WAITING_TOKEN,
      'the queue-full marker is a distinguished "waiting, not yet queued" token');
    assert(result.advanceTripCounters === false, 'waiting is not a completed trip');
  },

  'a full queue is a surcharge, not a bar — the cost function steers elsewhere'() {
    // § Carrier Costs: "full queue at source floor: use abs * 8 + 1000". The
    // surcharge is what makes the retry pick a different carrier rather than a
    // retry counter, which the reference does not have.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20, column: 0 });
    const tower = makeTower({ carriers: [carrier] });
    const worker0 = worker(0);
    const empty = scoreCarrier(tower, carrier, 0, 10, worker0.homeColumn);
    // Literals, not the module's own constants: a test that compares a value
    // against the constant it came from agrees with any change to that constant.
    assert(empty === 640, 'an empty direct ride costs abs(0) * 8 + 640 = 640, got ' + empty);
    assert(DIRECT_ROUTE_COST === 640, 'the direct-ride base cost is 640');
    for (let i = 0; i < 40; i++) resolveRouteBetweenFloors(tower, { id: 'q' + i, homeColumn: 0 }, 0, 10, clock);
    const full = scoreCarrier(tower, carrier, 0, 10, worker0.homeColumn);
    assert(full === 1000, 'a saturated direct ride costs 1000, got ' + full);
    assert(DIRECT_ROUTE_FULL_QUEUE_COST === 1000, 'the full-queue direct cost is 1000');
    assert(full > empty, 'a full queue must make the carrier dearer, not merely different');
  },

  // -------------------------------------------------- stairs and escalators

  /**
   * The whole stairs-versus-escalator system, and it really is only this:
   * identical routing, identical single-stride transit, 35 stress a floor
   * against 16.
   */
  'stairs and escalators route identically, and differ only in a byte'() {
    // § Stair / Escalator Transit Timing: both cross in one refresh stride;
    // the only difference is the per-stop stress rate, which sim/stress.js
    // applies from the span byte. What this module owns is reporting the byte.
    const forKind = (kind) => {
      const tower = makeTower({ segments: [createSegment({ kind, column: 0, entryFloor: 0 })] });
      return resolveRouteBetweenFloors(tower, worker(0), 0, 1, clock);
    };
    const escalator = forKind('escalator');
    const stairs = forKind('stairs');

    assert(escalator.code === ROUTE.LOCAL_LEG && stairs.code === ROUTE.LOCAL_LEG,
      'both branches are a direct local leg, result 1');
    assert(escalator.legDestination === 1 && stairs.legDestination === 1,
      'both put the walker on floor 1 in the same single stride');

    // § Stairs / Escalator Segment Flags: bit 0 is the stairs cost bit.
    assert((delayOf(escalator, DELAY.LOCAL_TRANSIT).modeAndSpan & 1) === 0,
      'an escalator segment reports the Escalator branch, bit 0 clear');
    assert((delayOf(stairs, DELAY.LOCAL_TRANSIT).modeAndSpan & 1) === 1,
      'a stairs segment reports the Stairs branch, bit 0 set');
    // And no price: recomputing 35 x floors here would put a second copy of
    // that rule in a file that does not own it.
    assert(delayOf(stairs, DELAY.LOCAL_TRANSIT).ticks === undefined,
      'routing must report the span byte, not a tick cost');
    assert(escalator.advanceTripCounters === false && stairs.advanceTripCounters === false,
      'a local leg is not itself a completed trip; the arrival is');
  },

  'a multi-floor segment is charged per floor traversed'() {
    // § Stair / Escalator Transit Timing: per_stop_delay x floors_traversed,
    // where floors_traversed = (mode_and_span >> 1) + 1.
    const tower = makeTower({
      segments: [createSegment({ kind: 'stairs', column: 0, entryFloor: 0, floorsSpanned: 3 })],
    });
    const result = resolveRouteBetweenFloors(tower, worker(0), 0, 3, clock);
    assert(result.code === ROUTE.LOCAL_LEG, 'a three-floor stair should be a local leg');
    const delay = delayOf(result, DELAY.LOCAL_TRANSIT);
    // floors_traversed = (mode_and_span >> 1) + 1. Both the branch and the
    // floor count come out of this one byte, which is why the byte travels
    // whole rather than being unpacked twice in two modules.
    assert((delay.modeAndSpan >> 1) + 1 === 3,
      'the span byte should decode to 3 floors, it decodes to ' + ((delay.modeAndSpan >> 1) + 1));
    assert((delay.modeAndSpan & 1) === 1, 'and to the Stairs branch');
    assert(result.legDestination === 3, 'the walker lands on the far landing, got ' + result.legDestination);
  },

  'a segment is entered from a landing, not from halfway up it'() {
    // § score_local_route_segment's terminal-landing gate: going up the source
    // must be the entry floor, going down it must be the top floor.
    const segment = createSegment({ kind: 'escalator', column: 0, entryFloor: 4, floorsSpanned: 2 });
    // Covers floors 4..6. Up from 4 is fine; up from 5 is not a landing.
    assert(scoreLocalSegment(segment, 4, 5, 0) === 0, 'entering upward at the entry floor should score 0');
    assert(scoreLocalSegment(segment, 5, 6, 0) === COST_INFINITE,
      'entering upward from the middle of a segment should be impossible');
    assert(scoreLocalSegment(segment, 6, 5, 0) === 0, 'entering downward at the top floor should score 0');
    assert(scoreLocalSegment(segment, 4, 3, 0) === COST_INFINITE,
      'entering downward from the bottom landing should be impossible');
  },

  'stairs cost 640 more than an escalator of the same length'() {
    // § Route Costs: escalator abs(delta) * 8; stairs abs(delta) * 8 + 640.
    assert(STAIRS_EXTRA_COST === 640, 'the stairs surcharge is 640');
    const escalator = createSegment({ kind: 'escalator', column: 0, entryFloor: 0 });
    const stairs = createSegment({ kind: 'stairs', column: 0, entryFloor: 0 });
    // A worker five columns away: the metric is horizontal, not vertical.
    assert(scoreLocalSegment(escalator, 0, 1, 5) === 40, 'an escalator five columns away costs 5 * 8 = 40');
    assert(scoreLocalSegment(stairs, 0, 1, 5) === 40 + 640, 'the same stairs cost 40 + 640');
  },

  /**
   * The selector's shape in one test: a cheap escalator short-circuits before
   * the lifts are even scored, while a stairs winner is only ever the threshold
   * the lifts must beat.
   */
  'an escalator wins outright; stairs only sets the bar for the lifts'() {
    // § Route-Selector Details: "local mode immediately accepts a direct
    // Escalator segment only when its cost is below 640 ... otherwise local
    // mode continues on to carrier fallback".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20, column: 0 });

    const withEscalator = makeTower({
      carriers: [carrier], segments: [createSegment({ kind: 'escalator', column: 0, entryFloor: 0 })],
    });
    assert(selectBestRouteCandidate(withEscalator, 0, 1, true, 0).kind === 'segment',
      'a free escalator should be taken before any carrier is scored');

    // Stairs beside the worker cost exactly 640, and so does the carrier. Every
    // comparison is a strict `<`, so the tie keeps the earlier candidate.
    const tie = makeTower({
      carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 0 })],
      segments: [createSegment({ kind: 'stairs', column: 0, entryFloor: 0 })],
    });
    const tied = selectBestRouteCandidate(tie, 0, 1, true, 0);
    assert(tied.cost === 640, 'both candidates should cost 640 here, got ' + tied.cost);
    assert(tied.kind === 'segment', 'an equal-cost tie keeps the first candidate in scan order');

    // Move the stairs ten columns away (cost 720) and the lift wins.
    const farStairs = makeTower({
      carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 0 })],
      segments: [createSegment({ kind: 'stairs', column: 10, entryFloor: 0 })],
    });
    const beaten = selectBestRouteCandidate(farStairs, 0, 1, true, 0);
    assert(beaten.kind === 'carrier',
      'stairs at 720 should lose to a carrier at 640, got ' + beaten.kind + ' at ' + beaten.cost);
  },

  /**
   * Why the escalator short-circuit is safe to take. It returns before the
   * carriers are scored at all, which is only correct because no carrier can
   * ever be cheaper than 640 — the escalator branch is the one route cost with
   * no floor under it. If a carrier could undercut 640, the selector would be
   * returning the wrong answer and nothing else here would notice.
   */
  'no carrier can cost less than 640, which is what makes the escalator short-circuit safe'() {
    // § Carrier Costs: every branch is `abs(delta) * 8 + 640` or larger, and
    // the express branch is `queue_count + 640`.
    for (const mode of [CARRIER_MODE.EXPRESS, CARRIER_MODE.STANDARD, CARRIER_MODE.SERVICE]) {
      // Express is exempt from the 31-floor span cap; the others are not.
      const [bottomFloor, topFloor] = mode === CARRIER_MODE.EXPRESS ? [-9, 44] : [-9, 21];
      for (const column of [0, 1, 40, 200]) {
        const carrier = shaft({ mode, bottomFloor, topFloor, column });
        const tower = makeTower({ carriers: [carrier] });
        const passengerMode = mode !== CARRIER_MODE.SERVICE;
        for (const heightMetric of [0, column, 200]) {
          const cost = scoreCarrier(tower, carrier, 0, 14, heightMetric, passengerMode);
          assert(cost >= STAIRS_EXTRA_COST || cost === COST_INFINITE,
            'mode ' + mode + ' at column ' + column + ' scored ' + cost + ', under the 640 floor');
        }
      }
    }
  },

  'equal-cost carriers keep the lower index'() {
    // § Candidate Priority: "carrier candidates are scanned last in ascending
    // carrier index order 0..23 ... equal-cost ties keep the first candidate
    // seen in scan order". Determinism depends on this.
    const tower = makeTower({
      carriers: [
        shaft({ id: 0, bottomFloor: 0, topFloor: 20, column: 3 }),
        shaft({ id: 1, bottomFloor: 0, topFloor: 20, column: 3 }),
      ],
    });
    const chosen = selectBestRouteCandidate(tower, 0, 10, true, 3);
    assert(chosen.kind === 'carrier' && chosen.id === 0,
      'identical carriers should resolve to index 0, got ' + chosen.id);
  },

  // ---------------------------------------------------------- walkability

  'walkability is one bit for escalators and another for stairs'() {
    // § Walkability Rules: "bit 0: Escalator-branch route support; bit 1:
    // Stairs-branch route support", rebuilt from all 64 segment slots.
    const table = buildWalkability([
      createSegment({ kind: 'escalator', column: 0, entryFloor: 0 }),
      createSegment({ kind: 'stairs', column: 1, entryFloor: 4 }),
    ]);
    assert(walkabilityAt(table, 0) === 1, 'floor 0 has escalator support only');
    assert(walkabilityAt(table, 1) === 1, 'the escalator covers its upper landing too');
    assert(walkabilityAt(table, 2) === 0, 'floor 2 has nothing on it');
    assert(walkabilityAt(table, 4) === 2, 'floor 4 has stairs support only');
    assert(walkabilityAt(table, 5) === 2, 'the stairs cover their upper landing too');
    // Off the 120-entry table reads as "no floor", never as undefined.
    assert(walkabilityAt(table, -50) === 0 && walkabilityAt(table, 500) === 0,
      'floors outside the table must read as 0, not undefined');
  },

  'a local walk reaches six floors, and no further'() {
    // § Walkability Rules, "maximum span checked: 6 floors in each direction".
    const segments = [];
    for (let floor = 0; floor <= 5; floor++) {
      segments.push(createSegment({ kind: 'escalator', column: 0, entryFloor: floor }));
    }
    const table = buildWalkability(segments);                   // floors 0..6 walkable
    assert(isSpanWalkableForLocalRoute(table, 0, 6), 'six floors of escalator should be walkable');
    assert(!isSpanWalkableForLocalRoute(table, 0, 7),
      'seven floors is beyond the local walk limit and must fail');
  },

  'one gap is survivable near the centre and fatal past it'() {
    // § Walkability Rules: "after the first gap, the scan continues only within
    // the 3-floor center band". A stairs-only floor is a gap for a local walk:
    // present, but not locally walkable.
    const table = buildWalkability([
      createSegment({ kind: 'escalator', column: 0, entryFloor: 0 }),   // floors 0,1 bit 0
      createSegment({ kind: 'stairs', column: 0, entryFloor: 1 }),      // floors 1,2 bit 1
      createSegment({ kind: 'escalator', column: 0, entryFloor: 3 }),   // floors 3,4 bit 0
    ]);
    assert(walkabilityAt(table, 2) === 2, 'floor 2 should exist but not be locally walkable');
    assert(isSpanWalkableForLocalRoute(table, 0, 3),
      'a gap three floors from the start is still inside the tolerated band');
    // The exact floor the tolerance runs out at: the scan fails once it is more
    // than 2 floors past the lower bound with a gap behind it, so 0..4 is the
    // first span that dies. A band widened by one survives a test that only
    // ever checks 0..5.
    assert(!isSpanWalkableForLocalRoute(table, 0, 4),
      'the band is 3 floors wide, so the gap should already have killed 0..4');
    assert(!isSpanWalkableForLocalRoute(table, 0, 5),
      'the same gap four floors out should end the walk');
  },

  'a missing floor stops a walk immediately, a stairs-only floor does not'() {
    // § Walkability Rules, the two distinct stop conditions. Confusing them
    // makes a hole in the tower behave like an escalator.
    const table = buildWalkability([
      createSegment({ kind: 'escalator', column: 0, entryFloor: 0 }),   // floors 0,1
      createSegment({ kind: 'escalator', column: 0, entryFloor: 3 }),   // floors 3,4
    ]);
    assert(walkabilityAt(table, 2) === 0, 'floor 2 has no floor at all in this fixture');
    // 0..3 is short enough that the gap tolerance would still allow it, so only
    // the immediate-stop rule can fail this span. That is the assertion that
    // tells the two stop conditions apart.
    assert(!isSpanWalkableForLocalRoute(table, 0, 3),
      'a zero walkability byte is an immediate stop, not a tolerated gap');
    assert(!isSpanWalkableForLocalRoute(table, 0, 4),
      'and the hole still stops a longer walk');
  },

  'a service walk demands continuous stairs and tolerates no gap'() {
    // § Walkability Rules, "Housekeeping walkability": bit 1 on every floor of
    // the span, no gap tolerance.
    const escalators = buildWalkability([
      createSegment({ kind: 'escalator', column: 0, entryFloor: 0 }),
      createSegment({ kind: 'escalator', column: 0, entryFloor: 1 }),
    ]);
    assert(!isSpanWalkableForServiceRoute(escalators, 0, 2),
      'housekeeping cannot use escalators at all');
    const stairs = buildWalkability([
      createSegment({ kind: 'stairs', column: 0, entryFloor: 0 }),
      createSegment({ kind: 'stairs', column: 0, entryFloor: 1 }),
    ]);
    assert(isSpanWalkableForServiceRoute(stairs, 0, 2), 'continuous stairs should carry a janitor');
    assert(!isSpanWalkableForServiceRoute(stairs, 0, 7), 'seven floors is beyond the span limit');
  },

  // -------------------------------------------------- lobby local access

  'the lobby ranges sit on the ground lobby and the sky lobbies'() {
    // § Lobby Local Access Ranges, "Record set": EXE 10, 24, 39, 54, 69, 84,
    // 99. Logical floors are exe - 10, which is the sky-lobby cadence.
    assert(JSON.stringify(LOCAL_ACCESS_CENTRES) === JSON.stringify([0, 14, 29, 44, 59, 74, 89]),
      'the centres are logical 0, 14, 29, 44, 59, 74, 89; got ' + LOCAL_ACCESS_CENTRES.join(','));
    assert(LOCAL_ACCESS_CENTRES.length === 7, 'at most 7 of the 8 records are live at once');
    for (const centre of LOCAL_ACCESS_CENTRES.slice(1)) {
      assert(centre % 15 === 14,
        'sky-lobby centre ' + centre + ' is off the (exe - 10) % 15 == 14 cadence');
    }
  },

  'a lobby range covers only what is actually walkable around it'() {
    // § Lobby Local Access Ranges, "Zone-building rule".
    const bare = buildLocalAccessRecords(buildWalkability([]));
    assert(bare.every((r) => !r.active), 'a tower with no stairs has no live lobby ranges');

    const table = buildWalkability([createSegment({ kind: 'escalator', column: 0, entryFloor: 0 })]);
    const records = buildLocalAccessRecords(table);
    assert(records[0].active, 'the ground-lobby range should come alive once floors 0-1 are walkable');
    assert(records[0].lowerFloor === 0,
      'the downward scan stops at the first floor with nothing on it, got ' + records[0].lowerFloor);
    assert(records[0].upperFloor === 2,
      'the upward scan returns the first empty floor as the bound, got ' + records[0].upperFloor);
    assert(!records[1].active, 'the sky-lobby range at floor 14 has nothing to stand on');
  },

  // ---------------------------------------------------- transfer groups

  'transfer groups are built from sky lobbies and capped at sixteen'() {
    // § Transfer Groups, "Rebuild algorithm" steps 2-4 and the 16-entry cap.
    const lower = shaft({ id: 0, bottomFloor: 0, topFloor: 14 });
    const upper = shaft({ id: 1, bottomFloor: 14, topFloor: 30 });
    const tower = makeTower({ carriers: [lower, upper], transferFloors: [14] });
    const groups = tower.routeTables.transferGroups;
    assert(groups.length === 1, 'one sky lobby should make one entry, got ' + groups.length);
    assert(groups[0].taggedFloor === 14, 'the entry is tagged with its floor');
    assert((groups[0].carrierMask & 0b11) === 0b11,
      'both shafts stop on floor 14, so both bits should be set');

    const crowded = makeTower({
      carriers: [shaft({ id: 0, bottomFloor: 0, topFloor: 30 })],
      transferFloors: Array.from({ length: 20 }, (unused, i) => i),
    });
    assert(crowded.routeTables.transferGroups.length === MAX_TRANSFER_GROUPS,
      'the cache is a hard 16 entries, got ' + crowded.routeTables.transferGroups.length);
  },

  'a transfer ride costs 3000 where a direct one costs 640'() {
    // § Carrier Costs: direct 640, transfer 3000. The gap is what keeps a
    // rider on one shaft when one shaft will do.
    assert(TRANSFER_ROUTE_COST === 3000, 'a transfer ride costs 3000');
    const lower = shaft({ id: 0, bottomFloor: 0, topFloor: 30, column: 0 });
    const upper = shaft({ id: 1, bottomFloor: 30, topFloor: 44, column: 0 });
    const tower = makeTower({ carriers: [lower, upper], transferFloors: [30] });
    assert(scoreCarrier(tower, lower, 0, 20, 0) === DIRECT_ROUTE_COST,
      'a ride the shaft serves outright costs 640');
    assert(scoreCarrier(tower, lower, 0, 40, 0) === TRANSFER_ROUTE_COST,
      'a ride that needs a change costs 3000, got ' + scoreCarrier(tower, lower, 0, 40, 0));
  },

  // ------------------------------------------------------------- distance

  /**
   * What the distance event has to carry. `sim/stress.js` prices it from
   * `height_metric_delta`, so the number this module reports is the whole
   * input to that rule — and it is a **horizontal** distance, between the
   * chosen carrier's or segment's column and the actor's own, despite the
   * reference calling it a height metric.
   */
  'the distance event carries the column delta, measured horizontally'() {
    // § Delays, "Long-distance penalty": computed from
    // abs(height_metric_delta) between the segment/carrier and the entity.
    const at = (column, homeColumn) => {
      const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 20, column })] });
      return delayOf(resolveRouteBetweenFloors(tower, worker(homeColumn), 0, 10, clock), DELAY.DISTANCE);
    };
    assert(at(200, 0).heightMetricDelta === 200, 'a shaft 200 columns away reports a delta of 200');
    assert(Math.abs(at(0, 130).heightMetricDelta) === 130,
      'and the delta is symmetric about the actor, got ' + at(0, 130).heightMetricDelta);
    assert(at(3, 3).heightMetricDelta === 0, 'a shaft in the actor\u2019s own column reports 0');
    // Reported, never priced: the 79/125 bands live in sim/stress.js.
    assert(at(200, 0).ticks === undefined, 'routing must not price the distance penalty');
  },

  'the distance penalty fires only when the caller asks for feedback'() {
    // § `emit_distance_feedback` Gating: in-transit continuations inherit the
    // flag from the first resolution, so the penalty fires once per trip and
    // not on every stride.
    const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 200 })] });
    const on = resolveRouteBetweenFloors(tower, worker(0), 0, 10, clock, { emitDistanceFeedback: true });
    assert(delayOf(on, DELAY.DISTANCE) !== undefined,
      'with feedback on the distance event should be reported');

    const off = resolveRouteBetweenFloors(tower, worker(0), 0, 10, clock, { emitDistanceFeedback: false });
    assert(delayOf(off, DELAY.DISTANCE) === undefined,
      'with feedback off the distance event must not be reported at all');
  },

  /**
   * The gate table, and the masking that makes it work. Deriving the flag from
   * the raw state byte instead of `state & 0x3f` drops every in-transit
   * continuation off the end of the table, and the penalty then fires once per
   * refresh stride instead of once per route.
   */
  'the feedback gate reads the base state, not the raw byte'() {
    // § `emit_distance_feedback` Gating, the per-family table.
    assert(baseState(0x40) === 0x00, '0x40 masks down to base state 0x00');
    assert(baseState(0x65) === 0x25, '0x65 masks down to base state 0x25');

    // Family 7, office: the two commutes enable it, nothing else does.
    assert(emitsDistanceFeedback(0x07, 0x00), 'office 0x00, the commute in, enables feedback');
    assert(emitsDistanceFeedback(0x07, 0x05), 'office 0x05, the commute home, enables feedback');
    for (const state of [0x01, 0x02, 0x20, 0x21, 0x22, 0x23]) {
      assert(!emitsDistanceFeedback(0x07, state),
        'office state 0x' + state.toString(16) + ' must not enable feedback');
    }
    // ...and the in-transit aliases inherit their base state's answer, which is
    // the entire reason the mask exists.
    assert(emitsDistanceFeedback(0x07, 0x40), 'in-transit 0x40 inherits 0x00\u2019s answer');
    assert(emitsDistanceFeedback(0x07, 0x45), 'in-transit 0x45 inherits 0x05\u2019s answer');
    assert(!emitsDistanceFeedback(0x07, 0x60), 'in-transit 0x60 inherits 0x20\u2019s answer, which is no');

    // Housekeeping never does, at any state: it passes 0 at every call site.
    for (const state of [0x00, 0x01, 0x20, 0x40]) {
      assert(!emitsDistanceFeedback(0x0f, state), 'housekeeping never contributes stress');
    }
  },

  /**
   * The trap worth naming: the two carrier exemptions run OPPOSITE ways on the
   * same two-bit field. The distance penalty exempts **express** (mode 0); the
   * tall-lobby rebate exempts **service** (mode 2) and pays express. Neither is
   * "the express one", and collapsing them into a single `isExpress` check is
   * right in one place and wrong in the other.
   *
   * This module resolves that by applying neither: it reports `carrierMode` on
   * both events and `sim/stress.js` holds one copy of each exemption. So what
   * is pinned here is that the mode is reported faithfully.
   */
  'the carrier mode is reported, not acted on, so neither exemption is copied here'() {
    // § Delays: "for carriers, this penalty applies only when carrier_mode != 0";
    // PEOPLE.md § Lobby-Boarding Stress Reduction: the rebate "applies to both
    // express and standard carriers (the only exclusion is service)".
    const express = makeTower({
      carriers: [shaft({ mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 44, column: 200 })],
    });
    const expressResult = resolveRouteBetweenFloors(express, worker(0), 0, 14, clock);
    assert(expressResult.code === ROUTE.QUEUED, 'the express ride should queue, got ' + expressResult.code);
    assert(delayOf(expressResult, DELAY.DISTANCE).carrierMode === CARRIER_MODE.EXPRESS,
      'the express mode must reach sim/stress.js, which is what applies the exemption');

    const standard = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 14, column: 200 })] });
    const standardResult = resolveRouteBetweenFloors(standard, worker(0), 0, 14, clock);
    assert(delayOf(standardResult, DELAY.DISTANCE).carrierMode === CARRIER_MODE.STANDARD,
      'a standard carrier reports mode 1');
  },

  'a segment charges the distance penalty on both branches'() {
    // § Delays: "for stairs/escalator segments, it applies to both branches" —
    // unlike carriers, where express is excused.
    for (const kind of ['stairs', 'escalator']) {
      const tower = makeTower({ segments: [createSegment({ kind, column: 200, entryFloor: 0 })] });
      const result = resolveRouteBetweenFloors(tower, worker(0), 0, 1, clock);
      const distance = delayOf(result, DELAY.DISTANCE);
      assert(distance !== undefined, 'a ' + kind + ' segment should report the distance event');
      assert(distance.heightMetricDelta === 200, 'with the segment\u2019s own column delta');
      // null, not a mode: there is no carrier exemption to apply to a segment.
      assert(distance.carrierMode === null,
        'a segment reports carrierMode null, so no carrier exemption can be applied to it');
    }
  },

  // -------------------------------------------------------- lobby rebate

  /**
   * Where the tall-lobby rebate actually happens, and it is not where a rider
   * joins the queue. `accumulate_elapsed_delay_into_current_sim` fires at
   * `assign_request_to_runtime_route` — the moment a car loads somebody — so
   * the boarding event comes out of the queue drain. Emitting it at resolution
   * would pay the rebate to riders the car never reaches.
   */
  'the tall-lobby rebate rides on boarding, not on joining the queue'() {
    // PEOPLE.md § Trip-Counter Functions item 3 and § Lobby-Boarding Stress
    // Reduction; ELEVATORS.md § Queue Drain step 6.
    const boardingRun = ({ mode = CARRIER_MODE.STANDARD, lobbyHeight = 3, from = 0 } = {}) => {
      const carrier = shaft({ mode, bottomFloor: 0, topFloor: 20, column: 0 });
      const tower = makeTower({ carriers: [carrier], lobbyHeight });
      const events = [];
      const ctx = makeCarrierContext(tower, {
        targetFloorOf: () => 15,
        onArrive: () => {},
        onDelay: (ref, event) => events.push({ ref, ...event }),
      });
      const queued = resolveRouteBetweenFloors(tower, worker(0), from, 15, clock,
        { passengerRoute: mode !== CARRIER_MODE.SERVICE });
      carrier.cars[0].currentFloor = from;
      carrier.cars[0].targetFloor = from;
      let tick = clock.dayTick;
      for (let i = 0; i < 60 && !events.some((e) => e.kind === DELAY.BOARDING); i++) {
        tick += 1;
        tickCarriers(tower.carriers, { dayTick: tick, daypart: 0, calendarPhase: false }, ctx);
      }
      return { queued, events };
    };

    const standard = boardingRun();
    assert(standard.queued.code === ROUTE.QUEUED, 'the rider should have queued first');
    assert(standard.queued.delays.every((d) => d.kind !== DELAY.BOARDING),
      'joining a queue is not boarding; the resolver must not report it');

    const boarding = standard.events.find((e) => e.kind === DELAY.BOARDING);
    assert(boarding !== undefined, 'the car loading the rider should report a boarding event');
    assert(boarding.sourceFloor === 0, 'boarding on the lobby floor, got ' + boarding.sourceFloor);
    assert(boarding.lobbyHeight === 3, 'the event carries the tower lobby height for the rebate');
    assert(boarding.carrierMode === CARRIER_MODE.STANDARD, 'and the carrier mode');
    assert(boarding.ticks === undefined, 'routing must not price the rebate');

    // The floor the rebate is keyed on is reported faithfully: the upper
    // storeys of a three-floor lobby are NOT the lobby floor.
    const upstairs = boardingRun({ from: 5 });
    const upstairsBoarding = upstairs.events.find((e) => e.kind === DELAY.BOARDING);
    assert(upstairsBoarding.sourceFloor === 5,
      'a rider boarding on floor 5 reports floor 5, not the lobby');

    // A service carrier still reports its mode; sim/stress.js is what skips it,
    // and skipping it there is also what leaves the route-start stamp live.
    const service = boardingRun({ mode: CARRIER_MODE.SERVICE });
    const serviceBoarding = service.events.find((e) => e.kind === DELAY.BOARDING);
    assert(serviceBoarding.carrierMode === CARRIER_MODE.SERVICE,
      'a service carrier reports mode 2 rather than being filtered out here');
  },

  /**
   * The guard against a re-add. `sim/stress.js` owns the tall-lobby rebate —
   * `PEOPLE.md` § Trip-Counter Functions item 3 applies it *inside*
   * `accumulate_elapsed_delay_into_current_sim`, which is that module's
   * function. Held in two places it either pays twice or depends on which half
   * got wired, which is the stairs-column bug from the old repo: a rule in four
   * places, three of them only predicting what the fourth would do.
   *
   * Bounded as well as negated, so it cannot pass by everything being absent:
   * the event that replaces the value has to exist and has to carry what
   * pricing needs.
   */
  'the tall-lobby rebate is priced in sim/stress.js and nowhere here'() {
    // Bound: routing still reports the moment the rebate applies to, with the
    // three facts accumulateElapsedDelayIntoCurrentSim asks for.
    assert(DELAY.BOARDING === 'boarding', 'the boarding event is what routing reports in its place');
    const carrier = shaft({ bottomFloor: 0, topFloor: 20, column: 0 });
    const tower = makeTower({ carriers: [carrier], lobbyHeight: 3 });
    const seen = [];
    const ctx = makeCarrierContext(tower, {
      targetFloorOf: () => 15,
      onArrive: () => {},
      onDelay: (ref, event) => seen.push(event),
    });
    const result = resolveRouteBetweenFloors(tower, worker(0), 0, 15, clock);
    let tick = clock.dayTick;
    for (let i = 0; i < 60 && !seen.some((e) => e.kind === DELAY.BOARDING); i++) {
      tick += 1;
      tickCarriers(tower.carriers, { dayTick: tick, daypart: 0, calendarPhase: false }, ctx);
    }
    const boarding = seen.find((e) => e.kind === DELAY.BOARDING);
    assert(boarding !== undefined, 'the boarding event must still be reported');
    for (const field of ['sourceFloor', 'carrierMode', 'lobbyHeight']) {
      assert(boarding[field] !== undefined,
        'the boarding event must carry ' + field + ' for sim/stress.js to price the rebate');
    }

    // Negate: no kind, no export and no payload here holds the value.
    assert(!Object.values(DELAY).includes('lobby-boarding'),
      'a lobby-boarding delay kind is back; the rebate belongs to sim/stress.js');
    for (const name of Object.keys(routing)) {
      assert(!/rebate|reduction/i.test(name),
        'routing exports ' + name + ' — the rebate value belongs to sim/stress.js');
    }
    // -25 and -50 are the rebate. No event this module produces may carry a
    // tick value at all, let alone a negative one.
    for (const event of [...result.delays, ...seen]) {
      assert(event.ticks === undefined,
        'event ' + event.kind + ' carries a tick value; pricing belongs to sim/stress.js');
    }
    assert(result.delays.every((e) => e.kind !== DELAY.BOARDING),
      'joining a queue is not boarding: no car has loaded anybody yet, so no rebate is due');
  },

  /**
   * The zero-tick delay that is not inert. `ROUTING.md` § Delays lists the
   * requeue-failure delay as `0`, but it still goes through
   * `add_delay_to_current_sim`, which still clears the route-start stamp on the
   * way out. Suppressing it because it costs nothing loses the clearing, and
   * whatever measures next reads a stamp that should have been cleared.
   */
  'a requeue failure reports its zero-tick delay rather than swallowing it'() {
    // § Queue Drain step 7 and § Delays, "requeue-failure delay: 0".
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const car = carrier.cars[0];
    car.currentFloor = 0;
    const tower = makeTower({ carriers: [carrier] });
    resolveRouteBetweenFloors(tower, worker(0), 0, 10, clock);

    const events = [];
    const returned = [];
    drainFloorQueue(carrier, car, 0, {
      targetFloorOf: () => 40,
      chooseTransferFloor: () => NO_TRANSFER_FLOOR,
      onRequeueFailure: (ref) => returned.push(ref),
      emitDelay: (ref, event) => events.push({ ref, ...event }),
    });

    assert(returned.length === 1, 'the unroutable rider should go back to its family');
    const failure = events.find((e) => e.kind === DELAY.REQUEUE_FAILURE);
    assert(failure !== undefined,
      'the zero-tick requeue-failure delay must still be reported: it clears the route stamp');
    assert(failure.ref === 'w1', 'and it names the rider it happened to');

    // ...and it survives the real seam, not just a hand-built context. A
    // "it costs nothing, why forward it" filter in makeCarrierContext is
    // exactly the optimisation this rule forbids.
    const stranded = shaft({ bottomFloor: 0, topFloor: 30 });
    const strandedTower = makeTower({ carriers: [stranded] });
    enqueueRequest(stranded, 'lost', 0, 1);
    const seamEvents = [];
    const ctx = makeCarrierContext(strandedTower, {
      targetFloorOf: () => 40,               // above the shaft, and no transfer exists
      onArrive: () => {},
      onDelay: (ref, event) => seamEvents.push({ ref, ...event }),
    });
    let tick = clock.dayTick;
    for (let i = 0; i < 40 && seamEvents.length === 0; i++) {
      tick += 1;
      tickCarriers(strandedTower.carriers, { dayTick: tick, daypart: 0, calendarPhase: false }, ctx);
    }
    assert(seamEvents.some((e) => e.kind === DELAY.REQUEUE_FAILURE),
      'makeCarrierContext must forward the zero-cost requeue failure, not filter it out');
  },

  // ------------------------------------------------------- the seam itself

  'a queued ride writes a token that says which carrier and which way'() {
    // § Route Resolution Results, resolver side effects: "stores a carrier
    // route token encoding direction and carrier id", and the source floor as
    // the waiting floor.
    const carrier = shaft({ id: 2, bottomFloor: 0, topFloor: 20 });
    const tower = makeTower({ carriers: [carrier] });
    const actor = worker(0);

    const up = resolveRouteBetweenFloors(tower, actor, 0, 10, clock);
    assert(up.code === ROUTE.QUEUED, 'expected a queued ride, got ' + up.code);
    assert(up.token === carrierToken(2, 1) && up.token === 0x40 + 2,
      'an upward token is 0x40 + carrier id, got 0x' + up.token.toString(16));
    assert(up.waitingFloor === 0, 'the rider waits on the source floor');
    assert(actor.lastTripTick === clock.dayTick, 'the route-start timestamp is the current day tick');
    assert(floorQueueCount(carrier, 0, 1) === 1, 'the request should be on the up ring at floor 0');

    const down = resolveRouteBetweenFloors(tower, { id: 'w2', homeColumn: 0 }, 10, 0, clock);
    assert(down.token === carrierToken(2, 0) && down.token === 0x58 + 2,
      'a downward token is 0x58 + carrier id, got 0x' + down.token.toString(16));
    assert(floorQueueCount(carrier, 10, 0) === 1, 'the request should be on the down ring at floor 10');
  },

  /**
   * The whole seam, once, end to end: a worker asks for a route, the router
   * queues it, a car collects it and puts it down on the right floor. Each
   * half is tested on its own above; this is the one that would notice if
   * `makeCarrierContext` handed the elevator layer the wrong thing.
   */
  'a worker queued at the lobby is actually carried to its floor'() {
    // § Path State: "queue drain assigns only the current carrier leg";
    // § Arrival Dispatch: the car writes the arrival floor and hands control
    // straight back to the family.
    const carrier = shaft({ bottomFloor: 0, topFloor: 20, column: 0 });
    const tower = makeTower({ carriers: [carrier] });
    const actor = worker(0);
    const arrivals = [];
    const effects = [];
    const ctx = makeCarrierContext(tower, {
      targetFloorOf: (ref) => (ref === 'w1' ? 10 : null),
      onArrive: (ref, floor, arrivalEffects) => {
        arrivals.push([ref, floor]);
        effects.push(arrivalEffects);
      },
    });

    const queued = resolveRouteBetweenFloors(tower, actor, 0, 10, clock);
    assert(queued.code === ROUTE.QUEUED, 'the worker should be queued, got code ' + queued.code);
    assert(floorQueueCount(carrier, 0, 1) === 1, 'the request should be on the up ring at the lobby');

    let tick = clock.dayTick;
    let ticks = 0;
    while (arrivals.length === 0 && ticks < 300) {
      tick += 1; ticks += 1;
      tickCarriers(tower.carriers, { dayTick: tick, daypart: 0, calendarPhase: false }, ctx);
    }

    assert(arrivals.length === 1, 'the worker never arrived after ' + ticks + ' ticks');
    assert(arrivals[0][0] === 'w1' && arrivals[0][1] === 10,
      'the worker was delivered to ' + JSON.stringify(arrivals[0]) + ', expected w1 on floor 10');
    assert(carrier.cars[0].currentFloor === 10, 'the car should be standing on floor 10');
    assert(floorQueueCount(carrier, 0, 1) === 0, 'the lobby queue should have drained');
    assert(carrier.cars[0].assignedCount === 0, 'the car should be empty again');

    // PEOPLE.md § When Counters Advance: the queued-car arrival callback is
    // where rebase_sim_elapsed_from_clock and advance_sim_trip_counters fire.
    // This is the ONLY place an accepted carrier leg is counted — the resolver
    // reported advanceTripCounters false when it queued the same rider.
    assert(effects[0]?.rebaseElapsed === true,
      'arrival should ask for the elapsed rebase; without it the ride is never measured');
    assert(effects[0]?.advanceTripCounters === true,
      'arrival is where a carrier leg counts its trip');
    assert(queued.advanceTripCounters === false,
      'and the resolver must not have counted the same ride at the other end');
  },

  /**
   * The stamp has to be the field the stress pipeline actually reads.
   *
   * It was `routeStartTick` here once — the same quantity under a second name,
   * with nothing bridging it to `sim/stress.js`'s `lastTripTick`. The stress
   * record's stamp therefore stayed at 0 forever, and
   * `accumulate_elapsed_delay_into_current_sim` computed
   * `elapsed + day_tick - 0` and charged the whole day tick. Measured on the
   * seeded tower: **612 of 612 boardings** charged the 300-tick clamp, every
   * office failed its evaluation, and the whole building emptied. Nothing
   * errored; the tower merely looked hopeless.
   */
  'the route-start stamp is written to lastTripTick, the field stress reads'() {
    // PEOPLE.md § Per-Sim Trip Fields, offset `+0x0a`: the field is
    // `last_trip_tick`. One field, one name, across every module that touches it.
    const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 20 })] });
    const actor = { id: 'w1', homeColumn: 0, lastTripTick: 0 };
    const later = { dayTick: 900, daypart: 0, calendarPhase: false };

    const result = resolveRouteBetweenFloors(tower, actor, 0, 10, later);
    assert(result.code === ROUTE.QUEUED, 'the fixture should queue');
    assert(actor.lastTripTick === 900,
      'the stamp must land on lastTripTick, it is ' + actor.lastTripTick);
    assert(result.lastTripTick === 900, 'and the result reports it under the same name');
    assert(actor.routeStartTick === undefined,
      'a second name for the same field is what broke this; there must be only one');
  },

  /**
   * The other half of the same failure, and it fails in the *flattering*
   * direction. A rider in an in-transit state is dispatched every stride; if
   * its family re-resolves instead of waiting, each call re-stamps the route
   * start, so the wait it was accruing is thrown away. Measured on the seeded
   * tower, that made average stress read 7 where the honest figure was 81 —
   * a metric improving while the thing it measures gets worse.
   */
  'a rider queued on a carrier waits, and is released only by the timeout'() {
    // PEOPLE.md § Refresh handler flow: a state >= 0x40 actor holding a CARRIER
    // token goes to `maybe_dispatch_queued_route_after_wait`, not to the family
    // dispatch. ELEVATORS.md § Queue-Full Retry: "there is no retry counter or
    // maximum retry limit — the timeout is the only gate."
    assert(TIMEOUT === 300, 'the queued-leg timeout is 300 ticks');
    const at = (dayTick) => ({ dayTick, daypart: 0, calendarPhase: false });

    const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 20 })] });
    const actor = { id: 'w1', homeColumn: 0, lastTripTick: 0 };
    resolveRouteBetweenFloors(tower, actor, 0, 10, at(500));

    assert(isQueuedOnCarrier(actor), 'the rider should be holding a carrier token');
    assert(shouldWaitForQueuedCarrier(actor, at(500)), 'it waits from the moment it queues');
    assert(shouldWaitForQueuedCarrier(actor, at(800)),
      'and for the full 300 ticks — 800 - 500 is exactly the timeout');
    assert(!shouldWaitForQueuedCarrier(actor, at(801)),
      'past 300 ticks the timeout releases it to re-dispatch');

    // A rider walking a local leg is NOT queued: it must re-resolve each stride
    // to advance to the next landing, which is the other half of the split.
    const walkable = makeTower({
      segments: [createSegment({ kind: 'stairs', column: 0, entryFloor: 0 })],
    });
    const walker = { id: 'w2', homeColumn: 0, lastTripTick: 0 };
    const leg = resolveRouteBetweenFloors(walkable, walker, 0, 1, at(500));
    assert(leg.code === ROUTE.LOCAL_LEG, 'the fixture should be a local leg');
    assert(!isQueuedOnCarrier(walker), 'a local leg is not a carrier queue');
    assert(!shouldWaitForQueuedCarrier(walker, at(500)),
      'a walker must keep resolving, or it never reaches the next landing');

    // And an actor with no route at all never waits.
    assert(!shouldWaitForQueuedCarrier({ id: 'w3' }, at(500)),
      'an actor holding no route has nothing to wait for');
  },

  'delays are reported and never applied'() {
    // CLAUDE.md: "Write it once." Stress lives in sim/stress.js; this module
    // only says what it cost. Nothing here may touch an elapsed counter.
    const tower = makeTower();
    const actor = { id: 'w1', homeColumn: 0, accumulatedElapsed: 0, tripCount: 0 };
    const seen = [];
    const result = resolveRouteBetweenFloors(tower, actor, 0, 5, clock, { onDelay: (d) => seen.push(d) });

    assert(result.code === ROUTE.FAILED, 'the fixture should fail to route');
    assert(seen.length === result.delays.length && seen[0] === result.delays[0],
      'the callback and the returned array must report the same events');
    assert(actor.accumulatedElapsed === 0 && actor.tripCount === 0,
      'the router wrote into the stress fields; that belongs to sim/stress.js');
    // And no event carries a price. Every one of them is a fact plus the
    // payload sim/stress.js needs to price it.
    for (const event of result.delays) {
      assert(event.ticks === undefined,
        'event ' + event.kind + ' carries a tick cost; pricing belongs to sim/stress.js');
      assert(Object.values(DELAY).includes(event.kind), 'unknown event kind ' + event.kind);
    }

    // The three 300s are three rules that happen to share a value. This module
    // holds one of them; merging it with the clamp or the no-route delay means
    // a retune of the retry gate silently moves the stress clamp.
    assert(QUEUED_LEG_TIMEOUT === 300, 'the queued-leg timeout is 300 ticks');
  },

  'the router never consumes randomness, so an office’s fate is reproducible'() {
    // CLAUDE.md rule 1: sim/** runs in Node with no Math.random. Two identical
    // towers must reach the same verdict, which is what makes the move-in
    // decision replayable.
    const build = () => makeTower({
      carriers: [
        shaft({ id: 0, bottomFloor: 0, topFloor: 20, column: 4 }),
        shaft({ id: 1, bottomFloor: 0, topFloor: 20, column: 4 }),
      ],
      segments: [createSegment({ kind: 'stairs', column: 9, entryFloor: 0 })],
    });
    const first = resolveRouteBetweenFloors(build(), worker(2), 0, 12, clock);
    const second = resolveRouteBetweenFloors(build(), worker(2), 0, 12, clock);
    assert(first.code === second.code && first.carrierId === second.carrierId,
      'the same tower resolved two different ways');
    assert(JSON.stringify(first.delays) === JSON.stringify(second.delays),
      'the same trip cost two different amounts');
  },
};
