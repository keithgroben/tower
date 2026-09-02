/**
 * What the screen SAYS about the loop.
 *
 * `spec/simtower-loop.md` §3 is the whole reason this build exists: the
 * elevator network decides whether you have tenants at all. So the four
 * readings below — is this let, how stressed is this person, who is waiting,
 * which sheet does this room draw — are the ones a wrong pixel actually costs
 * something for, and every one of them is a pure function so it can be pinned
 * here without a canvas.
 */
import {
  FAMILY, GROUND_FLOOR, UNIT_STATUS, createTower, isRented, placeObject,
} from '../src/games/tower/sim/state.js';
import { CARRIER_MODE, addCar, createCarrier, enqueueRequest } from '../src/games/tower/sim/elevators.js';
import {
  ELAPSED_CLAMP, NO_ROUTE_DELAY, STRESS_PINK, STRESS_RED,
  createSimTripRecord, recordNoRouteFailure, stressBand,
} from '../src/games/tower/sim/stress.js';
import { DEACTIVATED_EARLY } from '../src/games/tower/sim/economy.js';
import {
  LET_MOMENT, LET_MOMENT_STYLE, STRESS_COLORS, actorStress, actorStressColor,
  carrierQueueDepth, diffLetStatus, easeOutCubic, letMomentPhase, objectSprite,
  objectStatusTag, officeIsLet, queueDepthAt, queuePressure, timeOfDay,
  waitingActorsByFloor,
} from '../src/games/tower/render/canvas.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

function towerWithOffice() {
  const tower = createTower({ seed: 1 });
  tower.segments = [];
  const { object } = placeObject(tower,
    { family: FAMILY.office, floor: 3, left: 60, right: 65 },
    () => createSimTripRecord());
  return { tower, office: object };
}

const occupantsOf = (tower, object) => tower.actors.filter((a) => a.objectId === object.id);

/** Renting sets BOTH: the lease band and the measured flag. */
const letUnit = (o) => { o.occupiedFlag = true; o.unitStatus = 0; return o; };

export const tests = {
  // ------------------------------------------------------- let vs For Rent

  'a freshly placed office is FOR RENT, on both halves of the test'() {
    // Placement puts an office at `unitStatus = 0x10` — the vacant band —
    // per the reference implementation's own comment, "Office starts at 0x10
    // (unoccupied)". `specs/facility/OFFICE.md` says 0 and is wrong; see
    // spec/DEVIATIONS.md A11. This test previously asserted the buggy
    // precondition, which is why `officeIsLet` was written as a conjunction.
    const { office } = towerWithOffice();
    assert(!isRented(office.unitStatus), 'a placed office must be in the vacant band');
    assert(office.occupiedFlag === false, 'placement does not set occupiedFlag');
    assert(officeIsLet(office) === false, 'a placed, unreached office must draw as vacant');
    assert(objectStatusTag(office) === 'FOR RENT', 'and it must say so');
  },

  /**
   * The state that only exists because transport decides occupancy: an office
   * whose tenants ARE being measured, which still nobody has reached. Reading
   * either field alone would paint this one wrong.
   */
  'a measured but unreached office still says FOR RENT'() {
    const { office } = towerWithOffice();
    // ONLY the flag — deliberately not letUnit(). This test is about the state
    // between being measured and being reached, so signing the lease here
    // would erase the thing under test.
    office.occupiedFlag = true;
    assert(!isRented(office.unitStatus), 'the lease has not been signed');
    assert(officeIsLet(office) === false, 'a measured office is not a let office');
    assert(objectStatusTag(office) === 'FOR RENT', 'it must still read FOR RENT');
  },

  'the move-in flips it, and that is the whole loop'() {
    // `spec/simtower-loop.md` §4: a worker's route resolves, the office rents,
    // population +6. `occupiedFlag` IS that move-in — `population()` counts it.
    const { office } = towerWithOffice();
    letUnit(office);
    assert(officeIsLet(office), 'an occupied office in the active band is let');
    assert(objectStatusTag(office) === '', 'a let office carries no tag');
  },

  'a deactivated office reads as vacant again even while it holds its flag'() {
    // `sim/economy.js` writes `DEACTIVATED_EARLY` (0x10) into the status band on
    // deactivation. Above 0x0f, so `isRented()` says no — and the room has to
    // go back to For Rent whichever of the two fields moved.
    const { office } = towerWithOffice();
    letUnit(office);
    office.unitStatus = DEACTIVATED_EARLY;
    assert(DEACTIVATED_EARLY > UNIT_STATUS.activeMax, 'precondition: 0x10 is outside the active band');
    assert(!officeIsLet(office), 'a deactivated unit is not let');
    assert(objectStatusTag(office) === 'FOR RENT', 'and it says so again');
  },

  '⚠️ every family says the right thing on its sign, or none at all'() {
    // Three of these have been wrong in a row: the venue said FOR RENT and
    // could never stop, and a condo said FOR RENT when a condo is SOLD. Both
    // were invisible because neither was in `BUILDABLE` — nobody could place
    // one, so nobody looked.
    //
    // A sign that says the wrong thing teaches a player that the signs mean
    // nothing, and the one sign that has to be believed is FOR RENT on the
    // office bank above the lift. So every family is pinned, including the ones
    // that cannot be built yet.
    const expected = {
      office: 'FOR RENT',
      condo: 'FOR SALE',
      fastFood: '',      // open or closed, never vacant
      retail: '',
      restaurant: '',
      lobby: '',         // infrastructure
    };
    const tower = createTower({ seed: 1 });
    let left = 0;
    for (const [name, tag] of Object.entries(expected)) {
      const placed = placeObject(tower,
        { family: FAMILY[name], floor: 5, left, right: left + 5 },
        () => createSimTripRecord());
      left += 8;
      assert(placed.ok, name + ': ' + placed.reason);
      assert(objectStatusTag(placed.object) === tag,
        `an empty ${name} says ${JSON.stringify(objectStatusTag(placed.object))}, expected ${JSON.stringify(tag)}`);
      // And whatever it said, taking it must clear it. A tag no action can
      // remove is worse than no tag at all.
      placed.object.occupiedFlag = true;
      placed.object.unitStatus = 0;
      assert(objectStatusTag(placed.object) === '',
        `a taken ${name} still says ${JSON.stringify(objectStatusTag(placed.object))}`);
    }

    // And nothing in FAMILY is left unaccounted for, so the next one added has
    // to be given a sign rather than inheriting somebody else's.
    const unclassified = Object.keys(FAMILY).filter((k) => !(k in expected));
    assert(unclassified.length === 0,
      'these families have no agreed sign: ' + unclassified.join(', ')
      + ' — decide what each says empty and add it here.');
  },

  'the lobby is never For Rent'() {
    const tower = createTower({ seed: 1 });
    const { object } = placeObject(tower, { family: FAMILY.lobby, floor: GROUND_FLOOR, left: 48, right: 101 });
    assert(objectStatusTag(object) === '', 'infrastructure carries no lease tag');
  },

  'a missing object is not silently "let"'() {
    // `null?.occupiedFlag` is undefined and `undefined <= 0x0f` is false, but
    // both of those are accidents. Pinned so a refactor cannot turn a lookup
    // miss into a rented room.
    assert(officeIsLet(null) === false, 'null is not a let unit');
    assert(officeIsLet(undefined) === false, 'undefined is not a let unit');
    assert(objectStatusTag(null) === '', 'and it draws no tag');
  },

  // --------------------------------------------------------------- stress

  'the colours are the manual\'s three bands and nothing else'() {
    // `specs/PEOPLE.md` § Stress Color Bands: < 80 black, 80-119 pink,
    // 120-300 red. The mapping goes through `stressBand()`, never through a
    // threshold of the renderer's — the same number in two places drifts, and
    // this one is easy to confuse with the eval thresholds (150/200), which are
    // a completely different scale.
    assert(Object.keys(STRESS_COLORS).length === 3, 'exactly three bands');
    for (const score of [0, STRESS_PINK - 1, STRESS_PINK, STRESS_RED - 1, STRESS_RED, ELAPSED_CLAMP]) {
      const band = stressBand(score);
      assert(STRESS_COLORS[band], `no colour for band "${band}" at score ${score}`);
    }
    assert(STRESS_COLORS[stressBand(79)] === STRESS_COLORS.black, '79 is calm');
    assert(STRESS_COLORS[stressBand(80)] === STRESS_COLORS.pink, '80 is the pink edge');
    assert(STRESS_COLORS[stressBand(120)] === STRESS_COLORS.red, '120 is the red edge');
  },

  'the calm band is drawn as something you can SEE'() {
    // The band that means "this person is fine" must not read as missing art on
    // a dark tower, or every healthy worker looks like a rendering bug.
    assert(STRESS_COLORS.black !== '#000' && STRESS_COLORS.black !== '#000000',
      'literal black on a #0b0f14 tower is an absent dot');
  },

  'a worker who cannot be routed goes red, which is the point'() {
    // `sim/stress.js`: a failed route costs 300 — the clamp, the worst a trip
    // can be. One of them is already past the red boundary, so a tower that
    // cannot move somebody says so on the very first attempt.
    const { tower, office } = towerWithOffice();
    const worker = occupantsOf(tower, office)[0];
    assert(actorStress(worker) === 0, 'nobody has travelled yet');
    recordNoRouteFailure(worker);
    assert(actorStress(worker) === NO_ROUTE_DELAY, 'one failure costs the full clamp');
    assert(actorStressColor(worker) === STRESS_COLORS.red, 'and it shows red');
  },

  '⚠️ never travelling scores ZERO, which is the BEST value'() {
    // `computeRuntimeTileStressAverage` returns 0 for `trip_count == 0`, and 0
    // is calm. So an idle tower reads as a perfect one. That is the reference's
    // behaviour and it stays — but it is exactly the "metric improves while the
    // thing it measures gets worse" shape `CLAUDE.md` says to distrust, so the
    // HUD excludes untravelled people from its average rather than papering
    // over it here.
    const { tower, office } = towerWithOffice();
    const idle = occupantsOf(tower, office)[0];
    assert(idle.tripCount === 0 && actorStress(idle) === 0, 'no trips scores zero');
    assert(stressBand(actorStress(idle)) === 'black', 'and zero is the calm band');
  },

  // -------------------------------------------------------------- waiting

  'waiting people are grouped by the floor the SIM put them on'() {
    // `waitingFloor` is written by `resolveRouteBetweenFloors` on results 2 and
    // 0 and cleared on the others, so this is the sim's own answer to "who is
    // standing here" rather than a guess from position.
    const { tower, office } = towerWithOffice();
    const [a, b, c] = occupantsOf(tower, office);
    a.waitingFloor = GROUND_FLOOR;
    b.waitingFloor = GROUND_FLOOR;
    c.waitingFloor = -1;
    const byFloor = waitingActorsByFloor(tower);
    assert(byFloor.get(GROUND_FLOOR).length === 2, 'two in the lobby');
    assert(byFloor.get(-1).length === 1, 'and one in B1 — a basement is a place people wait');
    assert(!byFloor.has(3), 'nobody who is not waiting is counted');
  },

  'a hole in the actor table is skipped, not crashed on'() {
    // `sim/scheduler.js`: "A handler may remove an actor mid-sweep; skip the
    // hole rather than shifting the table." A renderer that assumed a dense
    // array would throw inside a frame — and an exception in a frame looks
    // exactly like a frozen game.
    const { tower, office } = towerWithOffice();
    occupantsOf(tower, office)[0].waitingFloor = 2;
    tower.actors[1] = null;
    const byFloor = waitingActorsByFloor(tower);
    assert(byFloor.get(2).length === 1, 'the survivor is still found');
  },

  // ------------------------------------------------------------- the queue

  'queue depth is read off the rings, both directions'() {
    const tower = createTower({ seed: 1 });
    const carrier = createCarrier({
      id: 0, mode: CARRIER_MODE.STANDARD, bottomFloor: -2, topFloor: 6, column: 72,
    });
    addCar(carrier, GROUND_FLOOR);
    tower.carriers.push(carrier);

    assert(carrierQueueDepth(carrier, GROUND_FLOOR) === 0, 'an untouched shaft has no queue');
    enqueueRequest(carrier, 101, GROUND_FLOOR, 1);
    enqueueRequest(carrier, 102, GROUND_FLOOR, 1);
    enqueueRequest(carrier, 103, GROUND_FLOOR, 0);
    assert(carrierQueueDepth(carrier, GROUND_FLOOR) === 3, 'up and down both count towards the wait');
    assert(queueDepthAt(tower, GROUND_FLOOR) === 3, 'and the floor total agrees');
  },

  '⚠️ a basement floor has a real queue slot'() {
    // The sentinel again, from the other side: `floor - bottomFloor` is the ring
    // index, and B2 on a carrier that starts at B2 is index 0. A guard written
    // as `if (floor < 0) return 0` would report an empty queue for every
    // basement and the wait would be invisible down there.
    const carrier = createCarrier({
      id: 0, mode: CARRIER_MODE.STANDARD, bottomFloor: -2, topFloor: 6, column: 72,
    });
    addCar(carrier, GROUND_FLOOR);
    enqueueRequest(carrier, 201, -2, 1);
    enqueueRequest(carrier, 202, -1, 1);
    assert(carrierQueueDepth(carrier, -2) === 1, 'B2 queues are real');
    assert(carrierQueueDepth(carrier, -1) === 1, 'so are B1 queues');
    assert(carrierQueueDepth(carrier, -3) === 0, 'a floor the shaft does not serve has none');
    assert(carrierQueueDepth(carrier, 99) === 0, 'nor one above its top');
  },

  'queue pressure saturates where a player can still act, not at the ring limit'() {
    // A 40-entry ring is a tower that has already failed. A scale that only
    // went red there would read "fine" through the whole failure.
    assert(queuePressure(0).ratio === 0, 'no queue is no pressure');
    assert(queuePressure(0).colorKey === 'good', 'and it reads good');
    assert(queuePressure(12).ratio === 1, 'twelve waiting is full pressure');
    assert(queuePressure(40).ratio === 1, 'a deeper queue stays saturated rather than overflowing');
    assert(queuePressure(11).colorKey === 'bad', 'nearly-twelve is already bad');
    assert(queuePressure(-3).count === 0, 'a nonsense count is clamped, not negative');
  },

  // ---------------------------------------------------------- which sheet

  'a vacant unit draws the empty SHELL, not the furnished sheet'() {
    // The delivered `office/vacant` frame still has desks and figures in it, so
    // a room waiting for a tenant looked exactly like one full of them. That
    // was a real complaint against the predecessor and it is the single most
    // important distinction on this screen.
    const { office } = towerWithOffice();
    const art = objectSprite(office, { night: false });
    assert(art.name === 'room-empty' && art.animation === 'office',
      `a vacant office drew ${art.name}/${art.animation}`);
  },

  'a let office changes with the time of day, and with its tenants\' stress'() {
    const { office } = towerWithOffice();
    letUnit(office);
    assert(objectSprite(office, { night: false }).animation === 'occupied-day', 'daytime');
    assert(objectSprite(office, { night: true }).animation === 'occupied-night', 'night');
    assert(objectSprite(office, { night: true, stressed: true }).animation === 'stressed',
      'a red room says so whatever the hour — stress outranks the clock');
  },

  'a family with no art falls through to a rectangle rather than a wrong sheet'() {
    const tower = createTower({ seed: 1 });
    const { object } = placeObject(tower, { family: 0x99, floor: 4, left: 10, right: 15 });
    assert(objectSprite(object, {}) === null, 'an unknown family draws no sprite');
  },

  // ------------------------------------------------------ the rent moment

  '⚠️ the moment fires on the transition, and NOT on a unit seen for the first time'() {
    // Opening the page on a tower that already has tenants must not celebrate
    // every one of them. A celebration of nothing is worse than no celebration:
    // it teaches a player to ignore the one that matters.
    const { tower, office } = towerWithOffice();
    const seen = new Map();

    letUnit(office);
    assert(diffLetStatus(seen, tower).length === 0, 'the first sighting is recorded silently');
    assert(diffLetStatus(seen, tower).length === 0, 'and a steady state stays quiet');

    // Now the thing this whole build exists to show. The closure is written as
    // the vacant band rather than by clearing the flag, because that is what
    // deactivation actually does — `occupiedFlag` stays set on a unit whose
    // tenants are still being measured.
    office.unitStatus = DEACTIVATED_EARLY;
    const closed = diffLetStatus(seen, tower);
    assert(closed.length === 1 && closed[0].direction === 'vacated', 'a closure is seen');
    letUnit(office);
    const let_ = diffLetStatus(seen, tower);
    assert(let_.length === 1 && let_[0].direction === 'let', 'and so is a move-in');
    assert(let_[0].object === office, 'and it names the unit that changed');
  },

  'the moment follows officeIsLet, so EITHER half can trigger it'() {
    // The detector must not hold a second opinion about what "let" means — it
    // asks `officeIsLet()` and nothing else. So a unit that loses its lease
    // band and a unit that stops being measured both show, and the renderer
    // cannot drift from the one definition.
    for (const close of [
      { what: 'the lease band goes vacant', apply: (o) => { o.unitStatus = DEACTIVATED_EARLY; } },
      { what: 'the unit stops being measured', apply: (o) => { o.occupiedFlag = false; } },
    ]) {
      const { tower, office } = towerWithOffice();
      const seen = new Map();
      letUnit(office);
      diffLetStatus(seen, tower);
      close.apply(office);
      const changes = diffLetStatus(seen, tower);
      assert(changes.length === 1 && changes[0].direction === 'vacated',
        'no closure seen when ' + close.what);
    }
  },

  'a demolished unit does not leave a stale answer behind'() {
    const { tower, office } = towerWithOffice();
    const seen = new Map();
    letUnit(office);
    diffLetStatus(seen, tower);
    assert(seen.has(office.id), 'precondition: it was recorded');
    tower.objects.delete(office.id);
    diffLetStatus(seen, tower);
    assert(!seen.has(office.id), 'and forgotten when it stops existing');
  },

  'the lobby never fires a moment, because it is never let'() {
    const tower = createTower({ seed: 1 });
    placeObject(tower, { family: FAMILY.lobby, floor: GROUND_FLOOR, left: 48, right: 101 });
    const seen = new Map();
    diffLetStatus(seen, tower);
    assert(seen.size === 0, 'infrastructure is not tracked at all');
  },

  'the moment is long enough to notice and short enough not to be wallpaper'() {
    // Under about a second and a half a player looking elsewhere misses it;
    // much over three and forty of them turn the tower into a light show.
    assert(LET_MOMENT.totalMs >= 1500 && LET_MOMENT.totalMs <= 3200,
      'the moment lasts ' + LET_MOMENT.totalMs + 'ms');
    // Derived, never declared: a hand-written total that disagreed with its own
    // parts would cut the word off mid-fade, and it would read as a glitch.
    assert(LET_MOMENT.totalMs === LET_MOMENT.stampInMs + LET_MOMENT.stampHoldMs + LET_MOMENT.stampOutMs,
      'the total has to be the sum of its parts');
  },

  'the timeline runs through and then stops'() {
    assert(letMomentPhase(0).flash === 1, 'it opens on a full flash');
    assert(letMomentPhase(0).stamp.scale > 1.5, 'and the word lands oversized');
    assert(letMomentPhase(LET_MOMENT.flashMs).flash === 0, 'the flash is over quickly');

    const settled = letMomentPhase(LET_MOMENT.stampInMs + 10);
    assert(settled.stamp.scale === 1 && settled.stamp.alpha === 1, 'then the word settles and holds');
    assert(settled.ring !== null, 'while the ring is still expanding');

    const late = letMomentPhase(LET_MOMENT.totalMs - 1);
    assert(late.stamp.alpha > 0 && late.stamp.alpha < 0.1, 'and fades out at the very end');
    assert(late.ring === null && late.shaft === null, 'the motion finished long before');

    assert(letMomentPhase(LET_MOMENT.totalMs) === null, 'past the end there is no moment');
    assert(letMomentPhase(-1) === null, 'nor before the start');
    assert(letMomentPhase(NaN) === null, 'nor for a broken clock');
  },

  'the ring and the shaft light both run forwards, monotonically'() {
    // A progress value that went backwards would draw the arrival light sliding
    // back DOWN the shaft — the exact opposite of the story being told.
    let previousRing = -1, previousShaft = -1;
    for (let age = 0; age < LET_MOMENT.ringMs; age += 25) {
      const p = letMomentPhase(age);
      assert(p.ring > previousRing, 'the ring went backwards at ' + age);
      previousRing = p.ring;
      if (p.shaft !== null) {
        assert(p.shaft > previousShaft, 'the shaft light went backwards at ' + age);
        previousShaft = p.shaft;
      }
    }
    assert(previousShaft > 0.9, 'the shaft light gets most of the way there: ' + previousShaft);
  },

  '⚠️ a let and a closure do not look alike'() {
    // They are opposites, and giving them the same fanfare would say they are
    // the same kind of event. The arrival gets outward motion because a journey
    // caused it; a closure gets none, because no single trip did.
    const won = LET_MOMENT_STYLE.let;
    const lost = LET_MOMENT_STYLE.vacated;
    assert(won.word !== lost.word, 'different words');
    assert(won.ink !== lost.ink, 'different colours');
    assert(won.ring && won.shaft, 'an arrival gets the ring and the shaft light');
    assert(!lost.ring && !lost.shaft, 'a closure gets neither — nothing arrived');
  },

  'the easing is an easing'() {
    assert(easeOutCubic(0) === 0 && easeOutCubic(1) === 1, 'it spans 0 to 1');
    assert(easeOutCubic(0.5) > 0.5, 'and front-loads, which is what "ease out" means');
    assert(easeOutCubic(-5) === 0 && easeOutCubic(5) === 1, 'out-of-range input is clamped');
  },

  // ----------------------------------------------------------- the clock

  '⚠️ the sky follows the DISPLAYED clock, not the raw tick'() {
    // `spec/TICK-MODEL.md` §2: the clock is piecewise. Daypart 0 alone spans
    // five displayed hours while dayparts 1 and 2 together cover 59 minutes.
    // Mapping ticks linearly onto a day is what put the predecessor's morning
    // rush at 01:55 — and would put dawn there too.
    //
    // Linear would make tick 400 (a fifth of the way through the day) read as
    // 04:48. It is actually 12:00 noon, and the sky has to agree with the hand.
    const noon = timeOfDay(400);
    assert(Math.abs(noon - 0.5) < 1e-9, `tick 400 is noon (0.5), the sky said ${noon}`);
    const linear = 400 / 2600;
    assert(Math.abs(noon - linear) > 0.3, 'and it is nowhere near the linear reading');

    // Daypart 0 opens the day at 7 AM; the overnight window sits before dawn.
    assert(Math.abs(timeOfDay(0) - 7 / 24) < 1e-9, 'tick 0 is 7:00 AM');
    assert(timeOfDay(2599) < timeOfDay(0), 'the last tick of the night is before dawn');
    for (const tick of [0, 399, 400, 1199, 1600, 2300, 2533, 2599]) {
      const tod = timeOfDay(tick);
      assert(tod >= 0 && tod < 1, `tick ${tick} produced ${tod}, outside 0..1`);
    }
  },
};
