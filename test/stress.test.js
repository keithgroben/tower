/**
 * The stress pipeline, checked against the reference rather than against what
 * the implementation happens to produce.
 *
 * Every assertion cites `specs/PEOPLE.md` § Stress / Trip-Counter Pipeline,
 * `specs/ROUTING.md` § Delays, or `specs/FACILITIES.md` § Facility Evaluation
 * Model. Where a number looks arbitrary — 35 against 16, a rebate applied
 * before a clamp rather than after, a failed trip costing exactly the ceiling —
 * the test is pinning the reference, and changing it is a deviation that
 * belongs in `spec/DEVIATIONS.md`.
 *
 * Three tests are marked TODO(parity). Those pin *our reading* of something the
 * reference leaves open, not the reference itself; each says which line is
 * silent and why we read it the way we did.
 */
import {
  ACCUMULATED_WRAP, CARRIER_EXPRESS, CARRIER_SERVICE, CARRIER_STANDARD,
  ELAPSED_CLAMP, ELAPSED_FLAGS_MASK, ELAPSED_MASK, ESCALATOR_PER_STOP_DELAY,
  LOBBY_FLOOR, NO_ROUTE_DELAY, OFFICE_OCCUPANTS, QUEUE_FULL_DELAY,
  STAIRS_PER_STOP_DELAY, STRESS_PINK, STRESS_RED, TRIP_COUNT_WRAP,
  accumulateElapsedDelayIntoCurrentSim, addDelayToCurrentSim, advanceSimTripCounters,
  applyDistancePenalty, applyLocalSegmentDelay, applyQueueFullDelay,
  computeObjectOperationalScore, computeRuntimeTileStressAverage, createSimTripRecord,
  distancePenalty, elapsedFlags, elapsedTicks, floorsTraversed, isStairsSegment,
  localSegmentDelay, rebaseSimElapsedFromClock, recordNoRouteFailure,
  reduceElapsedForLobbyBoarding, resetFacilitySimTripCounters, resetSimTripCounters,
  stampRouteStart, stressBand,
} from '../src/games/tower/sim/stress.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** A person who has taken `trips` trips totalling `total` ticks in transit. */
const sim = (fields = {}) => createSimTripRecord(fields);

/**
 * A `mode_and_span` byte. `ROUTING.md` § Stairs / Escalator Segment Flags:
 * bit 0 is the stairs cost bit, bits 7:1 encode the span, and the walked delta
 * is `(mode_and_span >> 1) + 1`.
 */
const segment = (floors, stairs) => ((floors - 1) << 1) | (stairs ? 1 : 0);

export const tests = {
  // ------------------------------------------------------------- the record

  'a blank trip record starts every counter at zero'() {
    // specs/PEOPLE.md § Sim Entity Record Layout, offsets +0x09..+0x0f.
    const s = sim();
    assert(s.tripCount === 0 && s.lastTripTick === 0
      && s.elapsedPacked === 0 && s.accumulatedElapsed === 0,
      'a blank record came out as ' + JSON.stringify(s) + ', expected all four fields at 0');
  },

  // -------------------------------------------------------------- the score

  'stress is average ticks in transit per trip, and no trips scores zero'() {
    // specs/PEOPLE.md § Scoring: if trip_count == 0 return 0, else
    // accumulated_elapsed / trip_count. specs/FACILITIES.md line 30 gives the
    // reference's own worked pair: "A sim that spends 200 ticks per trip
    // scores 200; one that spends 50 scores 50."
    const busy = sim({ tripCount: 4, accumulatedElapsed: 800 });
    assert(computeRuntimeTileStressAverage(busy) === 200,
      'four trips totalling 800 ticks scored ' + computeRuntimeTileStressAverage(busy)
      + ', the spec says 200');

    const calm = sim({ tripCount: 4, accumulatedElapsed: 200 });
    assert(computeRuntimeTileStressAverage(calm) === 50,
      'four trips totalling 200 ticks scored ' + computeRuntimeTileStressAverage(calm)
      + ', the spec says 50');

    // Divided by the trip count, not by anything else that happens to be near.
    const idle = sim({ accumulatedElapsed: 999 });
    assert(computeRuntimeTileStressAverage(idle) === 0,
      'a sim with no trips scored ' + computeRuntimeTileStressAverage(idle)
      + ', the spec says 0 when trip_count == 0');
  },

  'the divisor is the trip count and nothing else'() {
    // specs/PEOPLE.md § Scoring. Bounded and negated: three records that share
    // an accumulated total but differ in trips must produce three scores.
    const scores = [1, 2, 5].map((tripCount) =>
      computeRuntimeTileStressAverage(sim({ tripCount, accumulatedElapsed: 600 })));
    assert(JSON.stringify(scores) === JSON.stringify([600, 300, 120]),
      '600 ticks over 1, 2 and 5 trips scored ' + scores.join(', ') + ', expected 600, 300, 120');
  },

  'the colour bands are the manual’s three, at their exact edges'() {
    // specs/PEOPLE.md § Stress Color Bands: < 80 black, 80-119 pink,
    // 120-300 red. Every boundary and both sides of it.
    const edges = [
      [0, 'black'], [1, 'black'], [79, 'black'],
      [80, 'pink'], [81, 'pink'], [119, 'pink'],
      [120, 'red'], [121, 'red'], [300, 'red'],
    ];
    for (const [score, want] of edges) {
      assert(stressBand(score) === want,
        'a stress of ' + score + ' reads as ' + stressBand(score) + ', the manual says ' + want);
    }
    assert(STRESS_PINK === 80 && STRESS_RED === 120,
      'the band thresholds are ' + STRESS_PINK + '/' + STRESS_RED + ', the manual says 80/120');
  },

  'a per-sim average can never leave the red band’s stated range'() {
    // specs/PEOPLE.md § Stress Color Bands: the table stops at 300 because
    // every sample is clamped to 300, so the mean of samples cannot exceed it.
    // Charge the worst thing that exists, a hundred times over.
    const s = sim();
    for (let i = 0; i < 100; i++) recordNoRouteFailure(s);
    const score = computeRuntimeTileStressAverage(s);
    assert(score === ELAPSED_CLAMP,
      'a hundred failed routes scored ' + score + ', the clamp says the worst possible is 300');
  },

  // -------------------------------------------------------------- the clamp

  'no single leg can cost more than 300, whichever path charges it'() {
    // specs/PEOPLE.md § Trip-Counter Functions: all three writers clamp to 300.
    const viaDelay = sim();
    addDelayToCurrentSim(viaDelay, 5000);
    assert(elapsedTicks(viaDelay) === 300,
      'a 5000-tick delay stored ' + elapsedTicks(viaDelay) + ' ticks, the clamp says 300');

    const viaRebase = sim({ lastTripTick: 10 });
    rebaseSimElapsedFromClock(viaRebase, 2500);       // 2490 ticks of wall clock
    assert(elapsedTicks(viaRebase) === 300,
      'a 2490-tick leg rebased to ' + elapsedTicks(viaRebase) + ' ticks, the clamp says 300');

    const viaCarrier = sim({ lastTripTick: 10 });
    accumulateElapsedDelayIntoCurrentSim(viaCarrier, 2500, { sourceFloor: 8 });
    assert(elapsedTicks(viaCarrier) === 300,
      'a 2490-tick carrier wait stored ' + elapsedTicks(viaCarrier) + ' ticks, the clamp says 300');
  },

  'the clamp lands before the value is packed, not after'() {
    // specs/PEOPLE.md line 143: "clamp to 300, store back". specs/ROUTING.md
    // line 143: stairs charge 35 x floors_traversed, and the span byte allows
    // 128 floors — 4480 ticks. Masking without clamping would store
    // 4480 & 0x3ff = 384: a plausible number that is not the reference's.
    const s = sim();
    applyLocalSegmentDelay(s, segment(128, true));
    assert(elapsedTicks(s) === 300,
      'a 128-floor stair climb stored ' + elapsedTicks(s) + ' ticks; 300 is the clamp and '
      + '384 is what masking a 4480 without clamping first would leave behind');
  },

  'the tenth bit of the elapsed field is never needed'() {
    // specs/PEOPLE.md § Per-Sim Trip Fields: low 10 bits hold the elapsed
    // ticks, so the field tops out at 1023. Because every writer clamps to 300
    // first, the packing is not observable — this test is the proof, run over
    // every delay the reference names, applied to an already-full field.
    const deltas = [NO_ROUTE_DELAY, QUEUE_FULL_DELAY, 30, 60,
      STAIRS_PER_STOP_DELAY * 128, ESCALATOR_PER_STOP_DELAY * 128];
    for (const delta of deltas) {
      const s = sim({ elapsedPacked: ELAPSED_CLAMP });
      addDelayToCurrentSim(s, delta);
      assert(elapsedTicks(s) <= ELAPSED_CLAMP,
        'a delay of ' + delta + ' on a full field stored ' + elapsedTicks(s)
        + ' ticks, above the 300 clamp');
      assert(s.elapsedPacked <= ELAPSED_MASK,
        'a delay of ' + delta + ' packed to ' + s.elapsedPacked + ', which needs more than 10 bits');
    }
  },

  'the six flag bits survive every write'() {
    // specs/PEOPLE.md § Per-Sim Trip Fields: high 6 bits of elapsed_packed are
    // flags. The spec never says what they are, so they must be carried
    // untouched — losing them is a save-round-trip bug that looks like nothing.
    const s = sim({ elapsedPacked: ELAPSED_FLAGS_MASK | 50, lastTripTick: 0 });

    addDelayToCurrentSim(s, 10);
    assert(elapsedFlags(s) === ELAPSED_FLAGS_MASK && elapsedTicks(s) === 60,
      'after a delay the record packed to ' + s.elapsedPacked + ', expected all six flags set '
      + 'with 60 ticks (' + (ELAPSED_FLAGS_MASK | 60) + ')');

    rebaseSimElapsedFromClock(s, 5);                  // 60 + 5 - 0
    assert(elapsedFlags(s) === ELAPSED_FLAGS_MASK,
      'a rebase dropped the flags: packed is now ' + s.elapsedPacked);

    advanceSimTripCounters(s);
    assert(s.elapsedPacked === ELAPSED_FLAGS_MASK,
      'draining the leg left ' + s.elapsedPacked + ', expected the flags alone ('
      + ELAPSED_FLAGS_MASK + ') with the low ten bits cleared');
  },

  // ------------------------------------------------------- stairs vs lifts

  'stairs cost 35 a floor and an escalator 16 — that is the whole difference'() {
    // specs/ROUTING.md § Delays: Stairs-branch per-stop delay 35,
    // Escalator-branch per-stop delay 16. specs/ROUTING.md § Stair / Escalator
    // Transit Timing: both traverse in one refresh stride regardless, so this
    // stress rate is the entire mechanical distinction between them.
    assert(STAIRS_PER_STOP_DELAY === 35 && ESCALATOR_PER_STOP_DELAY === 16,
      'the per-stop delays are ' + STAIRS_PER_STOP_DELAY + '/' + ESCALATOR_PER_STOP_DELAY
      + ', the spec says 35 for stairs and 16 for an escalator');

    const cases = [
      [1, true, 35], [1, false, 16],
      [4, true, 140], [4, false, 64],
      [6, true, 210], [6, false, 96],
    ];
    for (const [floors, stairs, want] of cases) {
      const got = localSegmentDelay(segment(floors, stairs));
      assert(got === want, floors + ' floors by ' + (stairs ? 'stairs' : 'escalator')
        + ' cost ' + got + ' ticks, the spec says ' + want);
    }
  },

  'the span byte says how many floors were walked, and which branch walked them'() {
    // specs/ROUTING.md § Stairs / Escalator Segment Flags: bit 0 is the stairs
    // cost bit; the walked delta is ((mode_and_span >> 1) + 1).
    const spans = [[0, 1, false], [1, 1, true], [6, 4, false], [7, 4, true], [255, 128, true]];
    for (const [byte, floors, stairs] of spans) {
      assert(floorsTraversed(byte) === floors,
        'mode_and_span ' + byte + ' walks ' + floorsTraversed(byte) + ' floors, expected ' + floors);
      assert(isStairsSegment(byte) === stairs,
        'mode_and_span ' + byte + ' reads as ' + (isStairsSegment(byte) ? 'stairs' : 'escalator')
        + ', expected ' + (stairs ? 'stairs' : 'escalator'));
    }
  },

  'four floors of stairs put a worker in the red; the same climb by escalator stays black'() {
    // The mechanical consequence of the two constants above, run end to end
    // through the call order in specs/ROUTING.md § Stair / Escalator Transit
    // Timing (step 3 charges the delay, step 4 stamps the route start) and
    // drained by advance_sim_trip_counters on leg completion
    // (specs/PEOPLE.md § When Counters Advance).
    const byStairs = sim();
    applyLocalSegmentDelay(byStairs, segment(4, true));
    stampRouteStart(byStairs, 200);
    advanceSimTripCounters(byStairs);
    const stairScore = computeRuntimeTileStressAverage(byStairs);
    assert(stairScore === 140 && stressBand(stairScore) === 'red',
      'four floors of stairs scored ' + stairScore + ' (' + stressBand(stairScore)
      + '), expected 140 and red');

    const byEscalator = sim();
    applyLocalSegmentDelay(byEscalator, segment(4, false));
    stampRouteStart(byEscalator, 200);
    advanceSimTripCounters(byEscalator);
    const escalatorScore = computeRuntimeTileStressAverage(byEscalator);
    assert(escalatorScore === 64 && stressBand(escalatorScore) === 'black',
      'four floors by escalator scored ' + escalatorScore + ' (' + stressBand(escalatorScore)
      + '), expected 64 and black');
  },

  // ------------------------------------------------------- the fixed delays

  'a failed route costs the maximum, which is what closes the loop'() {
    // specs/ROUTING.md line 64: result -1 "applies the 300-tick no-route
    // delay". specs/PEOPLE.md line 128: route failure calls
    // advance_sim_trip_counters. One unroutable trip is therefore a
    // full-clamp sample, at the top of the red band.
    //
    // TODO(parity): neither file states which of the two runs first. Draining
    // before charging would make a failed trip cost nothing, so a tower with
    // no elevator would post the best stress in the game. Charging first is
    // the only order under which the spec's own "higher = worse" holds.
    assert(NO_ROUTE_DELAY === 300,
      'the no-route delay is ' + NO_ROUTE_DELAY + ', specs/ROUTING.md § Delays says 300');

    const s = sim();
    const score = recordNoRouteFailure(s);
    assert(s.tripCount === 1,
      'a failed route counted ' + s.tripCount + ' trips, expected 1');
    assert(score === 300 && stressBand(score) === 'red',
      'a failed route scored ' + score + ' (' + stressBand(score) + '), expected 300 and red');
  },

  'a full queue costs five ticks of waiting'() {
    // specs/ROUTING.md § Delays: queue-full waiting delay 5. specs/ROUTING.md
    // line 67: result 0 applies it and does not insert a queue-ring entry.
    const s = sim();
    applyQueueFullDelay(s);
    assert(QUEUE_FULL_DELAY === 5 && elapsedTicks(s) === 5,
      'a full queue charged ' + elapsedTicks(s) + ' ticks, the spec says 5');
  },

  'the long-distance penalty is nothing, thirty or sixty, at the spec’s own edges'() {
    // specs/ROUTING.md § Long-distance penalty: <= 79 no penalty,
    // > 79 and < 125 add 30, >= 125 add 60.
    const edges = [[0, 0], [79, 0], [80, 30], [124, 30], [125, 60], [400, 60], [-125, 60]];
    for (const [delta, want] of edges) {
      assert(distancePenalty(delta) === want,
        'a height delta of ' + delta + ' charged ' + distancePenalty(delta)
        + ' ticks, the spec says ' + want);
    }
  },

  'the distance penalty fires only with feedback on, and never on an express car'() {
    // specs/ROUTING.md § emit_distance_feedback Gating, and line 165: "for
    // carriers, this penalty applies only when carrier_mode != 0".
    const silent = sim();
    applyDistancePenalty(silent, { heightMetricDelta: 200, emitDistanceFeedback: false });
    assert(elapsedTicks(silent) === 0,
      'a 200-floor trip with feedback off charged ' + elapsedTicks(silent) + ' ticks, expected 0');

    const express = sim();
    applyDistancePenalty(express, {
      heightMetricDelta: 200, emitDistanceFeedback: true, carrierMode: CARRIER_EXPRESS,
    });
    assert(elapsedTicks(express) === 0,
      'an express car charged ' + elapsedTicks(express) + ' ticks of distance penalty, expected 0');

    const standard = sim();
    applyDistancePenalty(standard, {
      heightMetricDelta: 200, emitDistanceFeedback: true, carrierMode: CARRIER_STANDARD,
    });
    assert(elapsedTicks(standard) === 60,
      'a standard car charged ' + elapsedTicks(standard) + ' ticks, the spec says 60');

    // Stairs and escalators pass no carrier mode and it applies to both.
    const walked = sim();
    applyDistancePenalty(walked, { heightMetricDelta: 100, emitDistanceFeedback: true });
    assert(elapsedTicks(walked) === 30,
      'a walked segment charged ' + elapsedTicks(walked) + ' ticks, the spec says 30');
  },

  'a zero-distance penalty does not touch the route-start stamp'() {
    // specs/PEOPLE.md line 162: add_delay_to_current_sim clears last_trip_tick.
    // Calling it with nothing to add would therefore silently throw the leg's
    // timing away, so the <= 79 branch must not call it at all.
    const s = sim({ lastTripTick: 120 });
    applyDistancePenalty(s, { heightMetricDelta: 10, emitDistanceFeedback: true });
    assert(s.lastTripTick === 120,
      'a free trip cleared the route-start stamp to ' + s.lastTripTick + ', expected it left at 120');
  },

  'a fixed delay charges its constant and throws the wall clock away'() {
    // specs/PEOPLE.md § Trip-Counter Functions item 4: the formula is
    // (elapsed_packed & 0x3ff) + delay_delta. It does NOT fold in
    // g_day_tick - last_trip_tick, and it clears last_trip_tick afterwards.
    // Someone who has queued 200 ticks and then hits a full queue is charged
    // 5, not 205, and the 200 are gone.
    const s = sim({ lastTripTick: 100 });
    addDelayToCurrentSim(s, QUEUE_FULL_DELAY);
    assert(elapsedTicks(s) === 5,
      'a queue-full penalty on a sim stamped 200 ticks ago charged ' + elapsedTicks(s)
      + ' ticks, the spec\'s formula says 5');
    assert(s.lastTripTick === 0,
      'a fixed delay left the route-start stamp at ' + s.lastTripTick + ', the spec says clear it');
  },

  // ---------------------------------------------------------- the clock leg

  'the elapsed formulas measure from the route-start stamp'() {
    // specs/PEOPLE.md § Trip-Counter Functions items 1 and 5:
    // last_trip_tick = g_day_tick at route start; elapsed then accrues as
    // (elapsed_packed & 0x3ff) + g_day_tick - last_trip_tick.
    const s = sim();
    stampRouteStart(s, 100);
    assert(s.lastTripTick === 100,
      'the route start stamped ' + s.lastTripTick + ', expected the day tick 100');

    rebaseSimElapsedFromClock(s, 250);
    assert(elapsedTicks(s) === 150,
      'a leg from tick 100 to tick 250 measured ' + elapsedTicks(s) + ' ticks, expected 150');
    assert(s.lastTripTick === 0,
      'the rebase left the stamp at ' + s.lastTripTick + ', the spec says clear it');
  },

  'elapsed accumulates across legs until something drains it'() {
    // specs/PEOPLE.md item 1: the formula starts from the field's current
    // value, so a second leg adds to the first rather than replacing it.
    const s = sim();
    stampRouteStart(s, 100);
    rebaseSimElapsedFromClock(s, 140);                // +40
    stampRouteStart(s, 200);
    rebaseSimElapsedFromClock(s, 230);                // +30
    assert(elapsedTicks(s) === 70,
      'two legs of 40 and 30 ticks left ' + elapsedTicks(s) + ' ticks in the field, expected 70');
  },

  'a cleared stamp reads as tick zero, and charges the whole day'() {
    // specs/PEOPLE.md § Per-Sim Trip Fields: last_trip_tick is "zeroed after
    // rebase", and specs/DEMAND.md line 232 reads the same field as a flag
    // (state 0x26 branches on last_trip_tick == 0). Tick 0 is a real tick, so
    // the sentinel collides with it. Rebasing twice therefore charges the
    // second call the entire day_tick, which clamps to 300. That is the
    // reference's collision, reproduced rather than papered over.
    const s = sim();
    stampRouteStart(s, 100);
    rebaseSimElapsedFromClock(s, 150);                // 50 ticks, stamp cleared
    rebaseSimElapsedFromClock(s, 400);                // 50 + 400 - 0 = 450 -> 300
    assert(elapsedTicks(s) === 300,
      'a second rebase with no stamp left ' + elapsedTicks(s) + ' ticks; the formula gives '
      + '50 + 400 - 0 = 450, clamped to 300');
  },

  'a leg that spans the day wrap costs nothing rather than going negative'() {
    // TODO(parity): specs/PEOPLE.md lines 141-143 name only an upper clamp,
    // and never address a leg crossing the day_tick wrap at 2600 — where
    // g_day_tick - last_trip_tick is negative. A negative sample subtracted
    // from accumulated_elapsed would make the average improve as the tower got
    // worse, so we floor at 0. This pins our reading, not the spec's text.
    const s = sim();
    stampRouteStart(s, 2590);
    rebaseSimElapsedFromClock(s, 10);                 // -2580 raw
    assert(elapsedTicks(s) === 0,
      'a leg across the day wrap stored ' + elapsedTicks(s) + ' ticks, expected 0 — a negative '
      + 'sample would make stress fall as service got worse');
  },

  // ------------------------------------------------------------- the drain

  'draining a leg counts one trip and empties the working field'() {
    // specs/PEOPLE.md § Trip-Counter Functions item 2: trip_count += 1,
    // accumulated_elapsed += (elapsed_packed & 0x3ff), clear last_trip_tick,
    // clear the low ten bits.
    const s = sim({ elapsedPacked: 120, lastTripTick: 400, tripCount: 2, accumulatedElapsed: 200 });
    advanceSimTripCounters(s);
    assert(s.tripCount === 3, 'the trip count reads ' + s.tripCount + ', expected 3');
    assert(s.accumulatedElapsed === 320,
      'the running total reads ' + s.accumulatedElapsed + ', expected 200 + 120 = 320');
    assert(elapsedTicks(s) === 0,
      'the working field still holds ' + elapsedTicks(s) + ' ticks after the drain, expected 0');
    assert(s.lastTripTick === 0,
      'the drain left the stamp at ' + s.lastTripTick + ', the spec says clear it');
  },

  'trips are counted per completed leg, not per tick'() {
    // specs/PEOPLE.md § When Counters Advance: advance_sim_trip_counters is
    // called at transit-completion events only. The per-tick refresh of an
    // in-transit entity bypasses the pipeline entirely, which is why three
    // legs read as three trips no matter how many ticks they took.
    const s = sim();
    for (const [start, end] of [[0, 100], [200, 260], [400, 440]]) {
      stampRouteStart(s, start);
      rebaseSimElapsedFromClock(s, end);
      advanceSimTripCounters(s);
    }
    assert(s.tripCount === 3, 'three legs counted ' + s.tripCount + ' trips, expected 3');
    assert(s.accumulatedElapsed === 200,
      'three legs of 100, 60 and 40 ticks totalled ' + s.accumulatedElapsed + ', expected 200');
    assert(computeRuntimeTileStressAverage(s) === 66,
      'the average came out at ' + computeRuntimeTileStressAverage(s) + ', expected 200 / 3 = 66');
  },

  // -------------------------------------------------------- the tall lobby

  'a tall lobby rebates 25 or 50 ticks, and a short one nothing'() {
    // specs/PEOPLE.md § Lobby-Boarding Stress Reduction: lobby_height <= 1 no
    // adjustment, == 2 subtract 25, == 3 subtract 50, floored at 0.
    //
    // Height 0 is in here because specs/ECONOMY.md line 66 has lobby_height
    // defaulting to 0 until the player's first construction click — a tower
    // that has not been built yet must not be rebating anything.
    const cases = [[0, 100, 100], [1, 100, 100], [2, 100, 75], [3, 100, 50],
      [2, 10, 0], [3, 20, 0]];
    for (const [height, elapsed, want] of cases) {
      const got = reduceElapsedForLobbyBoarding(elapsed, LOBBY_FLOOR, height);
      assert(got === want, 'a height-' + height + ' lobby turned ' + elapsed + ' ticks into '
        + got + ', the spec says ' + want);
    }
  },

  'the rebate applies to the lobby floor only, not the storeys above it'() {
    // specs/PEOPLE.md line 209: "boards ... at the lobby floor (EXE floor 10 /
    // clone logical floor 0)". specs/ECONOMY.md line 67: floors
    // 0 < floor < lobby_height are the UPPER floors of a multi-floor lobby.
    // They look like the lobby and are not the lobby floor.
    assert(LOBBY_FLOOR === 0,
      'the lobby is logical floor ' + LOBBY_FLOOR + '; EXE 10 translates to 10 - 10 = 0');
    for (const floor of [1, 2, 5, -1, -10]) {
      const got = reduceElapsedForLobbyBoarding(100, floor, 3);
      assert(got === 100, 'departing floor ' + floor + ' of a height-3 lobby was rebated to '
        + got + ' ticks, expected the full 100 — only floor 0 earns the rebate');
    }
  },

  'the rebate is subtracted before the clamp, not after'() {
    // specs/PEOPLE.md § Trip-Counter Functions item 3 orders it: compute
    // elapsed, call the reduction, THEN clamp to 300. Clamping first would
    // give 250 on both cases below instead of 270 and 300 — undetectable in a
    // short tower and wrong in a tall one.
    const short = sim({ lastTripTick: 0 });
    accumulateElapsedDelayIntoCurrentSim(short, 320, {
      sourceFloor: LOBBY_FLOOR, lobbyHeight: 3, carrierMode: CARRIER_STANDARD,
    });
    assert(elapsedTicks(short) === 270,
      'a 320-tick wait with a height-3 lobby stored ' + elapsedTicks(short)
      + ' ticks; reducing then clamping gives 270, clamping then reducing gives 250');

    const catastrophe = sim({ lastTripTick: 0 });
    accumulateElapsedDelayIntoCurrentSim(catastrophe, 2000, {
      sourceFloor: LOBBY_FLOOR, lobbyHeight: 3, carrierMode: CARRIER_STANDARD,
    });
    assert(elapsedTicks(catastrophe) === 300,
      'a 2000-tick wait with a height-3 lobby stored ' + elapsedTicks(catastrophe)
      + ' ticks; the rebate is invisible past the clamp, so 300 — clamping first would give 250');
  },

  'the rebate reaches both express and standard cars'() {
    // specs/PEOPLE.md line 217: "The bonus applies to both express and
    // standard carriers".
    for (const carrierMode of [CARRIER_EXPRESS, CARRIER_STANDARD]) {
      const s = sim({ lastTripTick: 0 });
      accumulateElapsedDelayIntoCurrentSim(s, 100, {
        sourceFloor: LOBBY_FLOOR, lobbyHeight: 2, carrierMode,
      });
      assert(elapsedTicks(s) === 75,
        'carrier mode ' + carrierMode + ' stored ' + elapsedTicks(s)
        + ' ticks on a 100-tick wait from a height-2 lobby, expected 75');
    }
  },

  'a service car never touches the counters at all, stamp included'() {
    // specs/PEOPLE.md lines 154 and 217-218: the carrier path runs for
    // non-service carriers only; service carriers "skip
    // accumulate_elapsed_delay_into_current_sim entirely". Skipping the call
    // is not the same as calling it and adding nothing — the stamp survives.
    const s = sim({ elapsedPacked: 40, lastTripTick: 100 });
    accumulateElapsedDelayIntoCurrentSim(s, 300, {
      sourceFloor: LOBBY_FLOOR, lobbyHeight: 3, carrierMode: CARRIER_SERVICE,
    });
    assert(elapsedTicks(s) === 40,
      'a service car changed the elapsed field to ' + elapsedTicks(s) + ' ticks, expected 40');
    assert(s.lastTripTick === 100,
      'a service car cleared the route-start stamp to ' + s.lastTripTick
      + ', expected it untouched at 100');
  },

  // ------------------------------------------------------ facility scoring

  'an office is scored across six occupants'() {
    // specs/FACILITIES.md § Facility Evaluation Model step 2: family 7 is 6
    // sims. specs/PEOPLE.md line 189 agrees.
    assert(OFFICE_OCCUPANTS === 6,
      'an office scores over ' + OFFICE_OCCUPANTS + ' workers, the spec says 6');

    // Six workers who each averaged 120 ticks a trip: the office scores 120.
    const staff = Array.from({ length: 6 },
      () => sim({ tripCount: 4, accumulatedElapsed: 480 }));
    const score = computeObjectOperationalScore(staff, OFFICE_OCCUPANTS);
    assert(score === 120 && stressBand(score) === 'red',
      'six workers at 120 ticks a trip scored ' + score + ' (' + stressBand(score)
      + '), expected 120 and red');

    // And one badly-served worker drags the whole office: five calm at 60,
    // one stranded at the 300 clamp -> (60*5 + 300) / 6 = 100.
    const mixed = Array.from({ length: 5 }, () => sim({ tripCount: 5, accumulatedElapsed: 300 }));
    mixed.push(sim({ tripCount: 5, accumulatedElapsed: 1500 }));
    const dragged = computeObjectOperationalScore(mixed, OFFICE_OCCUPANTS);
    assert(dragged === 100 && stressBand(dragged) === 'pink',
      'five calm workers and one stranded one scored ' + dragged + ' ('
      + stressBand(dragged) + '), expected 100 and pink');
  },

  'the divisor is the family’s population, not the records handed over'() {
    // specs/PEOPLE.md line 189 gives the divisor per family, and it is a
    // constant of the family rather than a count of live entities.
    const two = [sim({ tripCount: 1, accumulatedElapsed: 100 }),
      sim({ tripCount: 1, accumulatedElapsed: 200 }),
      sim({ tripCount: 1, accumulatedElapsed: 300 })];
    assert(computeObjectOperationalScore(two, 2) === 150,
      'three records scored over a population of 2 came to ' + computeObjectOperationalScore(two, 2)
      + ', expected (100 + 200) / 2 = 150');
  },

  'scoring an office with a missing worker is refused, not scored as calm'() {
    // Not a spec rule — a guard. A missing occupant scored as 0 would make a
    // half-staffed office look flawless, which is the accounting hole listed
    // in CLAUDE.md "What the old repo caught".
    let threw = '';
    try { computeObjectOperationalScore([sim(), sim()], OFFICE_OCCUPANTS); }
    catch (e) { threw = e.message; }
    assert(threw.includes('6') && threw.includes('2'),
      'scoring 6 occupants from 2 records did not complain usefully; it said "' + threw + '"');
  },

  'the office average truncates, twice'() {
    // TODO(parity): specs/PEOPLE.md line 182 and specs/FACILITIES.md line 28
    // write the division without saying whether it truncates. The original
    // divides 16-bit words, which does, and the manual's bands (< 80, 80-119,
    // 120-300) only tile the number line for integers — 119.5 belongs to no
    // band as written. So both stages truncate here. This pins our reading.
    //
    // The case is chosen to separate the two readings: per-sim floors give
    // (79 + 80 + 80 + 80 + 80 + 80) / 6 = 79 (black); one division at the end
    // gives 480 / 6 = 80 (pink). A whole band hangs on it.
    const staff = [sim({ tripCount: 10, accumulatedElapsed: 799 })];        // 79.9
    staff.push(sim({ tripCount: 10, accumulatedElapsed: 801 }));            // 80.1
    for (let i = 0; i < 4; i++) staff.push(sim({ tripCount: 10, accumulatedElapsed: 800 }));
    const score = computeObjectOperationalScore(staff, OFFICE_OCCUPANTS);
    assert(score === 79 && stressBand(score) === 'black',
      'the office scored ' + score + ' (' + stressBand(score) + '); truncating each worker '
      + 'first gives 79 and black, dividing once at the end gives 80 and pink');
  },

  // -------------------------------------------------------------- the reset

  'a reset clears the totals and leaves the leg in flight alone'() {
    // specs/PEOPLE.md § Reset: reset_sim_trip_counters "clears trip_count and
    // accumulated_elapsed to 0" — those two, and no others. Someone halfway
    // through a lift ride keeps their timing across the cashflow pass.
    const s = sim({ tripCount: 9, accumulatedElapsed: 1800, elapsedPacked: 77, lastTripTick: 500 });
    resetSimTripCounters(s);
    assert(s.tripCount === 0 && s.accumulatedElapsed === 0,
      'the reset left ' + s.tripCount + ' trips and ' + s.accumulatedElapsed
      + ' accumulated ticks, expected 0 and 0');
    assert(s.elapsedPacked === 77 && s.lastTripTick === 500,
      'the reset also wiped the in-flight leg (' + s.elapsedPacked + ', ' + s.lastTripTick
      + '), expected it left at 77 and 500');
    assert(computeRuntimeTileStressAverage(s) === 0,
      'a freshly reset sim scores ' + computeRuntimeTileStressAverage(s) + ', expected 0');
  },

  'a facility reset clears every one of its occupants'() {
    // specs/PEOPLE.md § Reset: reset_facility_sim_trip_counters loops over all
    // sims belonging to the facility. Fires at the 3-day cashflow pass and on
    // first reopen after a vacancy.
    const staff = Array.from({ length: 6 },
      () => sim({ tripCount: 4, accumulatedElapsed: 1200 }));
    resetFacilitySimTripCounters(staff);
    const remaining = staff.filter((s) => s.tripCount !== 0 || s.accumulatedElapsed !== 0).length;
    assert(remaining === 0,
      remaining + ' of 6 workers survived the facility reset with counters intact, expected 0');
    assert(computeObjectOperationalScore(staff, OFFICE_OCCUPANTS) === 0,
      'the office scored ' + computeObjectOperationalScore(staff, OFFICE_OCCUPANTS)
      + ' straight after a reset, expected 0');
  },

  // ------------------------------------------------------------ field width

  'the counters are a byte and a word, as the record says'() {
    // specs/PEOPLE.md § Sim Entity Record Layout: trip_count is one byte,
    // accumulated_elapsed two. Both wrap. Neither is reachable in play — the
    // 3-day reset caps a worker far below 255 trips — but a counter that
    // silently outgrows its field is the shape of bug this repo keeps a list
    // of, so the width is pinned rather than assumed away.
    const trips = sim({ tripCount: TRIP_COUNT_WRAP - 1 });
    advanceSimTripCounters(trips);
    assert(trips.tripCount === 0,
      'the 256th trip left the count at ' + trips.tripCount + ', expected a byte to wrap to 0');

    const total = sim({ elapsedPacked: 300, accumulatedElapsed: ACCUMULATED_WRAP - 100 });
    advanceSimTripCounters(total);
    assert(total.accumulatedElapsed === 200,
      'the running total wrapped to ' + total.accumulatedElapsed + ', expected a word to wrap '
      + 'to 200');
  },
};
