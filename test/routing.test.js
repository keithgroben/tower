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
  CARRIER_MODE, NO_TRANSFER_FLOOR, addCar, createCarrier, floorQueueCount, tickCarriers,
} from '../src/games/tower/sim/elevators.js';
import {
  COST_INFINITE, DELAY, DIRECT_ROUTE_COST, DIRECT_ROUTE_FULL_QUEUE_COST,
  LOCAL_ACCESS_CENTRES, MAX_TRANSFER_GROUPS, NO_ROUTE_DELAY, PER_STOP_DELAY,
  QUEUE_FULL_DELAY, REQUEUE_FAILURE_DELAY, ROUTE, STAIRS_EXTRA_COST,
  TRANSFER_ROUTE_COST, WAITING_TOKEN,
  buildLocalAccessRecords, buildWalkability, carrierToken, chooseTransferFloor,
  createSegment, distancePenalty, isSpanWalkableForLocalRoute, isSpanWalkableForServiceRoute,
  lobbyBoardingRebate, makeCarrierContext, rebuildRouteTables, resolveRouteBetweenFloors,
  scoreCarrier, scoreLocalSegment, selectBestRouteCandidate, walkabilityAt,
} from '../src/games/tower/sim/routing.js';

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
  'no route costs 300 ticks, which is the clamp'() {
    // specs/ROUTING.md § Delays: "no-route delay: 300". Mutation by result:
    // "result -1 does not enqueue ... applies the 300-tick no-route delay".
    assert(NO_ROUTE_DELAY === 300, 'the no-route delay is 300 ticks');

    const tower = makeTower();                       // nothing built at all
    const result = resolveRouteBetweenFloors(tower, worker(), 0, 5, clock);
    assert(result.code === ROUTE.FAILED, 'an empty tower routed somebody, code ' + result.code);
    assert(result.delays.length === 1, 'expected exactly one delay, got ' + JSON.stringify(result.delays));
    assert(delayOf(result, DELAY.NO_ROUTE).ticks === 300,
      'the no-route delay is ' + delayOf(result, DELAY.NO_ROUTE).ticks + ', the spec says 300');
    assert(result.advanceTripCounters === true, 'route failure advances the trip counters');
    assert(result.token === null && result.waitingFloor === null,
      'a failed route must not leave a route token behind');
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
    assert(delayOf(failed, DELAY.NO_ROUTE).ticks === 300, 'the broken chain should cost 300');

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
    assert(QUEUE_FULL_DELAY === 5, 'the queue-full delay is 5 ticks');
    const carrier = shaft({ bottomFloor: 0, topFloor: 20 });
    const tower = makeTower({ carriers: [carrier] });
    for (let i = 0; i < 40; i++) {
      resolveRouteBetweenFloors(tower, { id: 'q' + i, homeColumn: 0 }, 0, 10, clock);
    }
    assert(floorQueueCount(carrier, 0, 1) === 40, 'the ring should be at its 40-entry limit');

    const result = resolveRouteBetweenFloors(tower, worker(), 0, 10, clock);
    assert(result.code === ROUTE.QUEUE_FULL, 'the 41st rider got code ' + result.code + ', expected 0');
    assert(delayOf(result, DELAY.QUEUE_FULL).ticks === 5,
      'the waiting delay is ' + delayOf(result, DELAY.QUEUE_FULL).ticks + ', the spec says 5');
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
  'stairs and escalators differ only in stress, at 35 against 16 a floor'() {
    // § Delays: "Escalator-branch per-stop delay: 16", "Stairs-branch per-stop
    // delay: 35"; § Stair / Escalator Transit Timing.
    assert(JSON.stringify(PER_STOP_DELAY) === JSON.stringify([16, 35]),
      'the per-stop delays are escalator 16, stairs 35; got ' + PER_STOP_DELAY.join(','));

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
    assert(delayOf(escalator, DELAY.LOCAL_TRANSIT).ticks === 16,
      'an escalator floor costs ' + delayOf(escalator, DELAY.LOCAL_TRANSIT).ticks + ', the spec says 16');
    assert(delayOf(stairs, DELAY.LOCAL_TRANSIT).ticks === 35,
      'a stairs floor costs ' + delayOf(stairs, DELAY.LOCAL_TRANSIT).ticks + ', the spec says 35');
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
    assert(delay.floors === 3, 'the leg covers 3 floors, reported ' + delay.floors);
    assert(delay.ticks === 35 * 3,
      'three floors of stairs cost 35 * 3 = 105, got ' + delay.ticks);
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

  'the distance penalty is 30 past 79 columns and 60 past 125'() {
    // § Delays, "Long-distance penalty": <= 79 nothing, > 79 and < 125 is 30,
    // >= 125 is 60. The boundaries are where an off-by-one hides.
    const cases = [[0, 0], [79, 0], [80, 30], [124, 30], [125, 60], [200, 60]];
    for (const [distance, expected] of cases) {
      assert(distancePenalty(distance, 0) === expected,
        distance + ' columns should cost ' + expected + ', got ' + distancePenalty(distance, 0));
    }
    // It is a distance, so it works in both directions.
    assert(distancePenalty(0, 130) === 60, 'the penalty is symmetric about the actor');
  },

  'the distance penalty fires only when the caller asks for feedback'() {
    // § `emit_distance_feedback` Gating: in-transit continuations inherit the
    // flag from the first resolution, so the penalty fires once per trip and
    // not on every stride.
    const tower = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 200 })] });
    const on = resolveRouteBetweenFloors(tower, worker(0), 0, 10, clock, { emitDistanceFeedback: true });
    assert(delayOf(on, DELAY.DISTANCE).ticks === 60,
      'a 200-column trip with feedback on should cost 60');

    const off = resolveRouteBetweenFloors(tower, worker(0), 0, 10, clock, { emitDistanceFeedback: false });
    assert(delayOf(off, DELAY.DISTANCE) === undefined,
      'with feedback off the distance penalty must not fire');
  },

  'express is exempt from the distance penalty; standard is not'() {
    // § Delays: "for carriers, this penalty applies only when carrier_mode != 0
    // (standard/service)". Express earning its keep.
    const express = makeTower({
      carriers: [shaft({ mode: CARRIER_MODE.EXPRESS, bottomFloor: -9, topFloor: 44, column: 200 })],
    });
    const expressResult = resolveRouteBetweenFloors(express, worker(0), 0, 14, clock);
    assert(expressResult.code === ROUTE.QUEUED, 'the express ride should queue, got ' + expressResult.code);
    assert(delayOf(expressResult, DELAY.DISTANCE) === undefined,
      'an express carrier must never charge the distance penalty');

    const standard = makeTower({ carriers: [shaft({ bottomFloor: 0, topFloor: 14, column: 200 })] });
    const standardResult = resolveRouteBetweenFloors(standard, worker(0), 0, 14, clock);
    assert(delayOf(standardResult, DELAY.DISTANCE).ticks === 60,
      'a standard carrier 200 columns away should charge 60');
  },

  'a segment charges the distance penalty on both branches'() {
    // § Delays: "for stairs/escalator segments, it applies to both branches" —
    // unlike carriers, where express is excused.
    for (const kind of ['stairs', 'escalator']) {
      const tower = makeTower({ segments: [createSegment({ kind, column: 200, entryFloor: 0 })] });
      const result = resolveRouteBetweenFloors(tower, worker(0), 0, 1, clock);
      assert(delayOf(result, DELAY.DISTANCE).ticks === 60,
        'a ' + kind + ' segment 200 columns away should charge 60');
    }
  },

  // -------------------------------------------------------- lobby rebate

  'a tall lobby is a rebate on every trip that departs it'() {
    // spec/TICK-MODEL.md § 1 and PEOPLE.md § Lobby-Boarding Stress Reduction:
    // lobby height 2 is -25, height 3 is -50, and only from the ground floor.
    const build = (lobbyHeight) => makeTower({
      carriers: [shaft({ bottomFloor: 0, topFloor: 20, column: 0 })], lobbyHeight,
    });
    assert(delayOf(resolveRouteBetweenFloors(build(1), worker(0), 0, 10, clock), DELAY.LOBBY_BOARDING) === undefined,
      'a single-storey lobby earns nothing');
    assert(delayOf(resolveRouteBetweenFloors(build(2), worker(0), 0, 10, clock), DELAY.LOBBY_BOARDING).ticks === -25,
      'a two-storey lobby should rebate 25 ticks');
    assert(delayOf(resolveRouteBetweenFloors(build(3), worker(0), 0, 10, clock), DELAY.LOBBY_BOARDING).ticks === -50,
      'a three-storey lobby should rebate 50 ticks');
    assert(delayOf(resolveRouteBetweenFloors(build(3), worker(0), 5, 10, clock), DELAY.LOBBY_BOARDING) === undefined,
      'the rebate is for departures from the lobby floor, not from floor 5');

    // Service carriers skip the elapsed-accumulation step entirely.
    assert(lobbyBoardingRebate(3, 0, CARRIER_MODE.SERVICE) === 0,
      'a service carrier earns no lobby rebate');
    assert(lobbyBoardingRebate(3, 0, CARRIER_MODE.EXPRESS) === -50,
      'the rebate applies to express as well as standard');
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
    assert(actor.routeStartTick === clock.dayTick, 'the route-start timestamp is the current day tick');
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
    const ctx = makeCarrierContext(tower, {
      targetFloorOf: (ref) => (ref === 'w1' ? 10 : null),
      onArrive: (ref, floor) => arrivals.push([ref, floor]),
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
      'the callback and the returned array must report the same delays');
    assert(result.totalDelay === NO_ROUTE_DELAY, 'totalDelay should sum the delays, got ' + result.totalDelay);
    assert(actor.accumulatedElapsed === 0 && actor.tripCount === 0,
      'the router wrote into the stress fields; that belongs to sim/stress.js');
    assert(REQUEUE_FAILURE_DELAY === 0, 'the requeue-failure delay is 0, so there is nothing to emit');
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
