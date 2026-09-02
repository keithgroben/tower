/**
 * Families 6 / 0x0c — commercial venues, and the office lunch trips that need
 * them.
 *
 * The assertions that matter are at the bottom: **a worker goes to lunch, and
 * when there is nowhere to eat it still costs the lifts a trip.** Everything
 * above them is the machinery those two rest on.
 *
 * Spec: `specs/DEMAND.md` § Families 6/0x0c and § Family 7,
 * `specs/facility/COMMERCIAL.md`, `specs/facility/OFFICE.md` § Parity: No Fast
 * Food Available, `specs/FACILITIES.md` § Commercial Readiness.
 *
 * Every number asserted here is the spec's, quoted in the comment beside it —
 * never a value read back out of the implementation.
 */
import {
  CAPACITY_CAPS, CAPACITY_FLOOR, CLOSURE_PAYOUT, FAST_FOOD_WIDTH, MAX_ACTIVE_OCCUPANTS,
  MINIMUM_STAY, NEAR_FULL_OCCUPANTS, SLOT, VENUE, VENUE_SIM_SLOTS, VENUE_STATE,
  VISITOR_BANDS, acquireVenueSlot, closeCommercialVenues, closurePayout,
  commercialArrival, commercialFamilyHandler, commercialGate, growVenueSeed,
  placeCommercialVenue, rebuildCommercialVenues, releaseVenueSlot, selectVenue,
  venueDerivedState, venueOf,
} from '../src/games/tower/sim/commercial.js';
import {
  LUNCH_DWELL, LOBBY_FLOOR, OFFICE_STATE, deactivateIfFailing, lunchDwellFor,
  nextStateAfterArrival, nextStateAfterLunch, officeArrival, officeDispatch,
  officeFamilyHandler, officeGate, recomputeOfficeOperationalStatus,
} from '../src/games/tower/sim/office.js';
import {
  FAMILY, OBJECT_TYPE, OCCUPANTS, POPULATION_CONTRIBUTION, __resetIds, createTower,
  enterTransit, placeObject, population, zoneBand,
} from '../src/games/tower/sim/state.js';
import { BUILDABLE, applyAction } from '../src/games/tower/sim/actions.js';
import { CONSTRUCTION_COST, TYPE_CODES, createLedger } from '../src/games/tower/sim/economy.js';
import { commandFor, preview, toolById } from '../src/games/tower/ui/build.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const clockAt = (daypart, { dayTick = null, dayCounter = 0, calendarPhase = false } = {}) =>
  ({ daypart, dayTick: dayTick ?? daypart * 400 + 300, dayCounter, calendarPhase });

/** A gate verdict with the dice forced. */
const riggedRng = (alwaysPass) => ({ chance: () => alwaysPass, int: () => 0, next: () => 0 });

/** A tower holding one fast food, with its 48 customers. */
function towerWithFastFood({ floor = 2, left = 20 } = {}) {
  __resetIds();
  const tower = createTower();
  tower.clock = clockAt(1);
  const placed = placeCommercialVenue(tower,
    { family: FAMILY.fastFood, type: OBJECT_TYPE.fastFood, floor, left, right: left + FAST_FOOD_WIDTH - 1 },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture failed: ' + placed.reason);
  return { tower, object: placed.object, record: venueOf(placed.object) };
}

/** An office and a fast food, so a worker has somewhere to eat. */
function towerWithLunch({ officeFloor = 2, venueFloor = 2 } = {}) {
  const { tower, object: venue, record } = towerWithFastFood({ floor: venueFloor, left: 60 });
  const placed = placeObject(tower,
    { family: FAMILY.office, floor: officeFloor, left: 10, right: 15 },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture failed: ' + placed.reason);
  const workers = tower.actors.filter((a) => a.objectId === placed.object.id);
  return { tower, venue, record, office: placed.object, workers };
}

/** The `ctx` an office handler takes, with the router stubbed to one answer. */
function stubCtx(code, seen = {}) {
  seen.routes = seen.routes ?? [];
  seen.delays = seen.delays ?? [];
  return {
    resolveRoute: (_t, _a, from, to) => { seen.routes.push({ from, to }); return { code }; },
    onDelay: (delay) => seen.delays.push(delay),
    onRent: () => {},
    seen,
  };
}

export const tests = {
  // ============================================ the two halves of a venue

  /**
   * `specs/facility/COMMERCIAL.md` § Role: *"the clone should model commercial
   * placement as creating both halves immediately: the placed object and its
   * linked venue-side record."*
   */
  'placing a fast food creates the object and its linked record together'() {
    const { object, record } = towerWithFastFood();
    assert(record, 'a placed venue has no linked record — half of it is missing');

    // § Capacity, Initialization: "every new venue starts with all three
    // capacity seed bytes set to 10; the currently active phase seed is
    // immediately cleared", "enabled-link venues start with
    // active_capacity_limit = 10 and yesterday_visit_count = 10".
    assert(record.seeds.b === CAPACITY_FLOOR && record.seeds.override === CAPACITY_FLOOR,
      'the inactive phase seeds start at 10');
    assert(record.seeds.a === 0, 'the ACTIVE phase seed is cleared at placement, got ' + record.seeds.a);
    assert(record.activeCapacityLimit === 10, 'active_capacity_limit starts at 10');
    assert(record.yesterdayVisitCount === 10, 'yesterday_visit_count starts at 10');
    assert(record.availability === VENUE.available, 'an enabled-link venue starts available');
    assert(object.evalLevel === 0xff, 'operational score starts unsampled (0xff)');
    assert(object.rentLevel === 1, 'rent tier 1 at placement');
  },

  /**
   * ⚠️ The clash `sim/ledger-adapter.js` flagged and could not fix from where
   * it stood. § Included Types, binary-verified against the construction
   * string table: *"type 6→'Restaurant - $200000', type 12→'Fast Food -
   * $100000'"*.
   */
  'fast food is type 0x0c at $100,000 — six is the restaurant at $200,000'() {
    assert(OBJECT_TYPE.fastFood === 0x0c, 'fast food is type 12, got ' + OBJECT_TYPE.fastFood);
    assert(OBJECT_TYPE.restaurant === 6, 'the restaurant is type 6, got ' + OBJECT_TYPE.restaurant);
    assert(FAMILY.fastFood === 0x0c && FAMILY.restaurant === 6, 'the family codes must match the types');

    // And the two halves of the price agree, which is what the mix-up broke.
    assert(TYPE_CODES.fastFood === OBJECT_TYPE.fastFood,
      'economy.js and state.js disagree about what a fast food IS');
    assert(CONSTRUCTION_COST.fastFood === 100_000, 'fast food costs $100,000');
    assert(CONSTRUCTION_COST.restaurant === 200_000, 'a restaurant costs $200,000');
    assert(BUILDABLE.fastFood.cost === 'fastFood',
      'the buildable is priced from the fast-food row, not the restaurant one');
  },

  'a venue owns 48 customer sims and contributes no fixed population'() {
    // § Role: "fast food (12): 48 sim slots plus one linked
    // CommercialVenueRecord". § Commercial Readiness makes them customers, not
    // staff — so the venue's population is footfall, counted elsewhere.
    const { tower, object } = towerWithFastFood();
    assert(OCCUPANTS[FAMILY.fastFood] === VENUE_SIM_SLOTS && VENUE_SIM_SLOTS === 48,
      'a venue gets 48 sim slots, got ' + OCCUPANTS[FAMILY.fastFood]);
    assert(tower.actors.length === 48, 'placement should have created 48 customers, got ' + tower.actors.length);
    assert(tower.actors.every((a) => a.state === VENUE_STATE.arriving),
      'every customer starts in 0x20, waiting at the lobby');
    assert(POPULATION_CONTRIBUTION[FAMILY.fastFood] === 0, 'a venue contributes no fixed population');
    assert(population(tower) === 0,
      'a fast food reported ' + population(tower) + ' residents — its sims are customers, not tenants');
    assert(object.venue.kind === 'commercial_venue', 'the record is the linked half, not a loose object');
  },

  /**
   * ⚠️ The hole the old `TODO(parity)` in `population()` refused to ship: the
   * seed marks shops let, so `isRented` alone counted retail's `+10` for four
   * shops nobody had visited. § Retail Income Timing puts the `+10` at *"first
   * open"*, which is a linked-record event, not a placement one.
   */
  'a shop with no linked record still counts nobody'() {
    __resetIds();
    const tower = createTower();
    // Placed WITHOUT the finalizer — which is every retail shop until family 10
    // gets a machine of its own.
    const placed = placeObject(tower, { family: FAMILY.retail, floor: -1, left: 10, right: 21 });
    assert(placed.ok, 'fixture failed');
    assert(POPULATION_CONTRIBUTION[FAMILY.retail] === 10, 'retail contributes 10 when it is open');
    assert(placed.object.unitStatus === 0, 'precondition: a shop is placed in the let band');
    assert(population(tower) === 0,
      'an unopened shop reported ' + population(tower) + ' residents. That is the 40 phantom '
      + 'people the population TODO was written to keep out.');

    // And the rule is not simply "commercial counts zero" — give it a live
    // record and the 10 arrives.
    placed.object.venue = { kind: 'commercial_venue', availability: VENUE.available };
    assert(population(tower) === 10, 'an open shop must contribute its 10, got ' + population(tower));
    placed.object.venue.availability = VENUE.dormant;
    assert(population(tower) === 0, 'a dormant shop counts nobody again');
  },

  // ===================================================== the venue's gate

  /**
   * `specs/DEMAND.md` § Families 6/0x0c § Gate Table (binary-verified), the
   * fast-food branch: nothing before tick 240, then a 1/36 trickle through
   * dayparts 0-3, 1/6 at daypart 4, and nothing from daypart 5.
   */
  'fast food trickles all morning and pushes in the afternoon'() {
    const { tower, object } = towerWithFastFood();
    const actor = tower.actors[0];
    const pass = riggedRng(true);

    assert(commercialGate(actor, object, clockAt(0, { dayTick: 240 }), pass) === 'hold',
      'nothing dispatches at tick 240 or before');
    assert(commercialGate(actor, object, clockAt(0, { dayTick: 241 }), pass) === 'dispatch',
      'the trickle starts the tick after 240');
    for (const daypart of [0, 1, 2, 3]) {
      assert(commercialGate(actor, object, clockAt(daypart), riggedRng(false)) === 'hold',
        'daypart ' + daypart + ' is a 1/36 chance, not a certainty');
      assert(commercialGate(actor, object, clockAt(daypart), pass) === 'dispatch',
        'the trickle should be able to fire in daypart ' + daypart);
    }
    assert(commercialGate(actor, object, clockAt(4), pass) === 'dispatch', 'daypart 4 is the 1/6 push');
    assert(commercialGate(actor, object, clockAt(4), riggedRng(false)) === 'hold', 'and it is still a roll');
    for (const daypart of [5, 6]) {
      assert(commercialGate(actor, object, clockAt(daypart), pass) === 'hold',
        'fast food is shut by daypart ' + daypart);
    }
  },

  /**
   * The same handler, the other branch: *"If placed type == 6 (restaurant)"*.
   * A restaurant is an evening business — nothing before daypart 4, then the
   * first half of daypart 5 and no more.
   */
  'a restaurant runs the evening window, not the fast-food trickle'() {
    const { tower, object } = towerWithFastFood();
    // The gate splits on the PLACED TYPE, which is the whole reason the two
    // codes had to be told apart.
    object.type = OBJECT_TYPE.restaurant;
    object.family = FAMILY.restaurant;
    const actor = tower.actors[0];
    const pass = riggedRng(true);

    for (const daypart of [0, 1, 2, 3]) {
      assert(commercialGate(actor, object, clockAt(daypart), pass) === 'hold',
        'a restaurant does not open in daypart ' + daypart);
    }
    assert(commercialGate(actor, object, clockAt(4), pass) === 'dispatch', 'daypart 4 is its 1/12 roll');
    assert(commercialGate(actor, object, clockAt(4), riggedRng(false)) === 'hold', 'and it is a roll');
    assert(commercialGate(actor, object, clockAt(5, { dayTick: 2199 }), riggedRng(false)) === 'dispatch',
      'daypart 5 up to tick 2199 always dispatches — no dice at all');
    assert(commercialGate(actor, object, clockAt(5, { dayTick: 2200 }), pass) === 'hold',
      'and it stops dead at 2199, not at the end of the daypart');
    assert(commercialGate(actor, object, clockAt(6), pass) === 'hold', 'daypart 6 is shut');
  },

  'a parked customer is released overnight, and not before'() {
    // § Gate Table: "0x27 | tick >= 2301 | force state -> 0x20".
    const { tower, object } = towerWithFastFood();
    const actor = tower.actors[0];
    actor.state = VENUE_STATE.parked;
    assert(commercialGate(actor, object, clockAt(5, { dayTick: 2300 }), riggedRng(true)) === 'hold',
      'still parked at 2300');
    assert(commercialGate(actor, object, clockAt(5, { dayTick: 2301 }), riggedRng(false))
      === VENUE_STATE.arriving, 'the night release did not fire at 2301');
  },

  'the return leg always dispatches — the wait is the minimum stay, not the gate'() {
    // § Gate Table: "0x05 | always | dispatch". The reference's gate has no
    // timer in it; the dwell lives in the release.
    const { tower, object } = towerWithFastFood();
    const actor = tower.actors[0];
    actor.state = VENUE_STATE.leaving;
    for (const daypart of [0, 3, 6]) {
      assert(commercialGate(actor, object, clockAt(daypart), riggedRng(false)) === 'dispatch',
        'the way home should always dispatch, held in daypart ' + daypart);
    }
  },

  // ======================================================= the venue slot

  /**
   * `specs/facility/COMMERCIAL.md` § Availability, in its own order:
   * *"first occupant moves the venue to partial state; the 10th occupant moves
   * the venue to near-full state; releasing the final occupant reopens"*.
   */
  'occupancy walks the availability bands and comes back'() {
    const { tower, record } = towerWithFastFood();
    const clock = clockAt(2);
    const diners = tower.actors.slice(0, NEAR_FULL_OCCUPANTS);

    assert(record.availability === VENUE.available, 'an empty venue is available');
    acquireVenueSlot(record, diners[0], clock, FAMILY.office);
    assert(record.availability === VENUE.partial, 'the first occupant makes it partial');
    for (const diner of diners.slice(1)) acquireVenueSlot(record, diner, clock, FAMILY.office);
    assert(record.currentPopulation === 10, 'ten people should be inside');
    assert(record.availability === VENUE.nearFull, 'the 10th occupant makes it near-full');

    const later = { ...clock, dayTick: clock.dayTick + MINIMUM_STAY };
    for (const diner of diners) releaseVenueSlot(record, diner, later);
    assert(record.currentPopulation === 0, 'everyone left');
    assert(record.availability === VENUE.available, 'releasing the last occupant reopens the venue');
  },

  /**
   * ⚠️ *"venues with more than 39 active occupants return an over-capacity
   * **wait** result"* — and § Route and queue requirement: *"over-capacity
   * waits are distinct from no-route failures"*. Conflating them would charge
   * a diner the 300-tick no-route penalty for a popular restaurant.
   */
  'a full venue answers wait, which is not the same answer as unavailable'() {
    const { tower, record } = towerWithFastFood();
    const clock = clockAt(2);
    record.currentPopulation = MAX_ACTIVE_OCCUPANTS;              // 39
    assert(acquireVenueSlot(record, tower.actors[0], clock, FAMILY.office) === SLOT.acquired,
      'the 40th visitor still gets in — the rule is MORE than 39');
    assert(record.currentPopulation === 40, 'forty inside');
    assert(acquireVenueSlot(record, tower.actors[1], clock, FAMILY.office) === SLOT.full,
      'the 41st must be told to wait');
    assert(record.currentPopulation === 40, 'a refused visitor must not be counted as inside');
    assert(SLOT.full !== SLOT.unavailable, 'wait and unavailable have to be different answers');

    for (const state of [VENUE.closed, VENUE.dormant]) {
      record.currentPopulation = 0;
      record.availability = state;
      assert(acquireVenueSlot(record, tower.actors[2], clock, FAMILY.office) === SLOT.unavailable,
        'a venue in state ' + state + ' must refuse outright, not merely wait');
    }
  },

  /**
   * *"venue release is blocked until the family-specific minimum-stay timer has
   * elapsed"* — 60 ticks in § Phase A/B/Override Trigger's tuning table.
   */
  'a diner cannot leave before the minimum stay'() {
    const { tower, record } = towerWithFastFood();
    const diner = tower.actors[0];
    acquireVenueSlot(record, diner, clockAt(2, { dayTick: 1000 }), FAMILY.office);
    assert(MINIMUM_STAY === 60, 'the minimum stay is 60 ticks for every commercial type');

    assert(releaseVenueSlot(record, diner, clockAt(2, { dayTick: 1059 })) === false,
      'a diner walked out after 59 ticks');
    assert(record.currentPopulation === 1, 'and a refused release must not empty the seat');
    assert(releaseVenueSlot(record, diner, clockAt(2, { dayTick: 1060 })) === true,
      'sixty ticks is the whole stay, so 60 must be enough');
    assert(record.currentPopulation === 0, 'the seat is free again');
  },

  /**
   * The visitor count is what the closure payout is keyed on, so double-count
   * it and every venue reads as busier than it is. § Availability: a venue's
   * own sim already spent its visit when it committed to the trip.
   */
  'a venue does not count its own customer twice'() {
    const { tower, record } = towerWithFastFood();
    const clock = clockAt(2);
    const own = tower.actors[0];
    acquireVenueSlot(record, own, clock, FAMILY.fastFood);          // owner family
    assert(record.acquireCount === 0, 'the venue counted its own sim a second time');
    acquireVenueSlot(record, { family: FAMILY.office }, clock, FAMILY.fastFood);
    assert(record.acquireCount === 1, 'an office worker IS a visitor and must be counted');
  },

  // =================================================== venue selection

  /**
   * § Venue Selection Algorithm: *"the sim's current floor is mapped to one of
   * seven 15-floor zones by `classify_path_bucket_index` ... one venue record
   * is chosen uniformly at random from all available entries in the matching
   * zone bucket"*.
   */
  'a diner picks from its own zone, and gets nothing from another'() {
    const { tower, object } = towerWithFastFood({ floor: 2, left: 20 });
    assert(zoneBand(2) === 0 && zoneBand(30) === 2,
      'precondition: floors 2 and 30 are in different 15-floor zones');

    assert(selectVenue(tower, FAMILY.fastFood, 2) === object, 'the venue on my own floor is in my bucket');
    assert(selectVenue(tower, FAMILY.fastFood, 30) === null,
      'a worker thirty floors up reached a zone-0 venue — the bucket is not zoned');
    // And a family that has no venues at all answers the same way.
    assert(selectVenue(tower, FAMILY.restaurant, 2) === null, 'there are no restaurants in this tower');
  },

  /**
   * ⚠️ `CLAUDE.md`'s first entry, in the place it would have bitten. The
   * reference returns `-1` for "no venue" and reads it back as a floor; ours
   * are logical floors and `-1` is B1 — where the seed puts shops.
   */
  'no venue is null, never minus one'() {
    __resetIds();
    const tower = createTower();
    tower.clock = clockAt(1);
    const chosen = selectVenue(tower, FAMILY.fastFood, 0);
    assert(chosen === null, 'an empty bucket must answer null, got ' + JSON.stringify(chosen));
    assert(chosen !== -1, 'a -1 here is the basement, and every hungry worker would be sent to it');
  },

  /**
   * § Venue Selection step 2 before step 3: the draw happens over *all* entries
   * and the pick is rejected afterwards. Filtering first would consume a
   * different number of RNG draws and every subsequent number in the run would
   * change.
   */
  'the dice are rolled before the venue is checked, not after'() {
    const { tower, record } = towerWithFastFood({ floor: 2 });
    record.availability = VENUE.closed;
    const before = tower.rng.state;
    assert(selectVenue(tower, FAMILY.fastFood, 2) === null, 'a closed venue must not be selected');
    assert(tower.rng.state !== before,
      'the RNG was not advanced for a bucket with an entry in it — filtering happened before the '
      + 'draw, and every later number in the run has moved');
  },

  // ============================================ capacity, income, readiness

  /**
   * § Capacity, the daily recompute: *"choose the active capacity seed ... cap
   * the chosen seed by the venue type's tuning limit ... floor capacity at 10
   * ... roll `today_visit_count` into `yesterday_visit_count` ... reset"*.
   */
  'the daily rebuild caps the seed, floors it at ten, and rolls the counters'() {
    const { tower, record } = towerWithFastFood();
    assert(CAPACITY_CAPS[FAMILY.fastFood][0] === 35, 'fast food phase A caps at 35');
    assert(CAPACITY_CAPS[FAMILY.fastFood][1] === 50, 'phase B caps at 50');
    assert(CAPACITY_CAPS[FAMILY.fastFood][2] === 25, 'the override caps at 25');

    record.seeds.a = 3;                       // under the floor
    record.todayVisitCount = 27;
    record.acquireCount = 27;
    record.currentPopulation = 4;
    rebuildCommercialVenues(tower);
    assert(record.activeCapacityLimit === 10, 'a seed of 3 must floor at 10, got ' + record.activeCapacityLimit);
    assert(record.yesterdayVisitCount === 27, 'today rolled into yesterday');
    assert(record.todayVisitCount === 0 && record.acquireCount === 0, 'the day counters reset');
    assert(record.currentPopulation === 0,
      'occupancy must reset — this is what sweeps up a diner whose evening gate sent them home '
      + 'while they still held a seat');
    assert(record.eligibilityThreshold === -11, 'the negative gate marker is -(cap + 1)');

    record.seeds.a = 900;                     // over the cap
    rebuildCommercialVenues(tower);
    assert(record.activeCapacityLimit === 35, 'the phase-A cap is 35, got ' + record.activeCapacityLimit);
  },

  /**
   * **The commercial half of the loop.** A customer who got home well grows the
   * venue's seed, and tomorrow's capacity is what today's customers earned. The
   * thresholds are `specs/FACILITIES.md` § Thresholds By Star Rating — the same
   * 80 and 150 an office is graded by, deliberately not a second pair.
   */
  'a happy customer buys the venue capacity, an unhappy one buys nothing'() {
    const { tower, record } = towerWithFastFood();
    const calm = { ...tower.actors[0], tripCount: 4, accumulatedElapsed: 4 * 40 };    // 40 < 80
    const cross = { ...tower.actors[1], tripCount: 4, accumulatedElapsed: 4 * 100 };  // 80..149
    const furious = { ...tower.actors[2], tripCount: 4, accumulatedElapsed: 4 * 250 };// >= 150

    record.seeds.a = 0;
    growVenueSeed(tower, record, calm);
    assert(record.seeds.a === 2, 'a calm customer is worth 2, got ' + record.seeds.a);
    growVenueSeed(tower, record, cross);
    assert(record.seeds.a === 3, 'a merely-tolerable one is worth 1, got ' + record.seeds.a);
    growVenueSeed(tower, record, furious);
    assert(record.seeds.a === 3, 'a customer at 250 stress must buy nothing at all');

    record.seeds.a = 34;
    growVenueSeed(tower, record, calm);
    assert(record.seeds.a === 35, 'the seed is capped at the phase-A limit, got ' + record.seeds.a);
  },

  /**
   * § Income: *"restaurant and fast-food threshold levels are 25, 35, and 50"*,
   * and the fast-food payouts `-$3,000 / $2,000 / $3,000 / $5,000`.
   * *"The lowest restaurant and fast-food bands are true losses, not
   * zero-income states."*
   */
  'the day’s visitors pick the payout band, and the bottom one is a loss'() {
    assert(VISITOR_BANDS.join(',') === '25,35,50', 'the bands are 25, 35 and 50');
    assert(venueDerivedState(24) === 0 && venueDerivedState(25) === 1, 'the 25 boundary is wrong');
    assert(venueDerivedState(34) === 1 && venueDerivedState(35) === 2, 'the 35 boundary is wrong');
    assert(venueDerivedState(49) === 2 && venueDerivedState(50) === 3, 'the 50 boundary is wrong');

    assert(closurePayout(FAMILY.fastFood, 0) === -3_000, 'an empty fast food LOSES $3,000');
    assert(closurePayout(FAMILY.fastFood, 25) === 2_000, '25 visitors is $2,000');
    assert(closurePayout(FAMILY.fastFood, 35) === 3_000, '35 visitors is $3,000');
    assert(closurePayout(FAMILY.fastFood, 50) === 5_000, '50 visitors is $5,000');
    assert(CLOSURE_PAYOUT[FAMILY.restaurant].join(',') === '-6000,4000,6000,10000',
      'a restaurant is the bigger bet: -6/4/6/10 thousand');
    assert(CLOSURE_PAYOUT[FAMILY.retail].every((v) => v === 0),
      'retail earns from the priced row instead — its closure pays nothing');
  },

  /**
   * `specs/FACILITIES.md` § Commercial Readiness: commercial families are
   * scored on **customer count**, not on occupant stress. A venue whose 48
   * customers are all miserable but numerous is a good venue.
   */
  'commercial readiness is footfall, not how its customers felt'() {
    const { tower, object, record } = towerWithFastFood();
    // Every customer maximally stressed — which would fail an office outright.
    for (const actor of tower.actors) { actor.tripCount = 4; actor.accumulatedElapsed = 4 * 300; }
    record.acquireCount = 60;

    const paid = [];
    closeCommercialVenues(tower, { onIncome: (o, d) => paid.push([o.id, d]) });
    assert(record.derivedState === 3,
      'a venue with 60 visitors must grade at the top band whatever its customers thought of the '
      + 'lifts — got ' + record.derivedState);
    assert(paid.length === 1 && paid[0][1] === 5_000, 'and it must be paid the top band, got ' + JSON.stringify(paid));
    assert(record.availability === VENUE.closed, 'closure moves every live venue to state 3');
    assert(object.evalLevel === 0xff,
      'the office eval_level must stay unset — the reference never maps the commercial derived '
      + 'state onto those grades, and inventing the mapping is what DEVIATIONS A17 refuses');
  },

  // ================================================== THE LUNCH TRIP

  /**
   * `specs/facility/OFFICE.md` § Dispatch Table, the `0x20` row: *"same-floor
   * success (3) also activates a vacant office ... then branches on
   * occupant_index: occupant 0 -> 0x00; occupant != 0 -> 0x01 or 0x02"*.
   *
   * **This is the door into the lunch wave.** Every arriving worker used to be
   * written `0x21`, which only ever leads to `0x05` — so no worker in a
   * lift-served tower could reach `0x01` at all, and the whole midday wave was
   * unreachable however well the rest of it was written.
   */
  'the rental arrival sends worker zero to work and everyone else to lunch'() {
    const { workers } = towerWithLunch();
    assert(nextStateAfterArrival(workers[0]) === OFFICE_STATE.commuteIn,
      'occupant 0 takes the daytime path (0x00)');
    for (const worker of workers.slice(1)) {
      assert(nextStateAfterArrival(worker) === OFFICE_STATE.lunchOut,
        'occupant ' + worker.occupantIndex + ' must go to 0x01, not to 0x21');
    }
  },

  /**
   * ⚠️ **Two paths that must agree.** A worker can finish the rental leg by
   * walking (route result `3`) or by getting out of a lift (`officeArrival`).
   * Both are the same event to the state machine and both are written down
   * separately, so this runs *both* and compares rather than pinning either.
   */
  'arriving by lift and arriving on foot leave a worker in the same state'() {
    for (const index of [0, 1, 3]) {
      const a = towerWithLunch();
      const b = towerWithLunch();
      recomputeOfficeOperationalStatus(a.tower, a.office, a.workers);
      recomputeOfficeOperationalStatus(b.tower, b.office, b.workers);

      // On foot: the rental route resolves same-floor.
      const onFoot = a.workers[index];
      onFoot.state = OFFICE_STATE.seekingWork;
      officeDispatch(a.tower, onFoot, a.office, clockAt(1), stubCtx(3));

      // By lift: the same worker rides and the carrier delivers it.
      const byLift = b.workers[index];
      byLift.state = enterTransit(OFFICE_STATE.seekingWork);
      officeArrival(byLift, b.office.floor);

      assert(onFoot.state === byLift.state,
        'occupant ' + index + ' ends at 0x' + onFoot.state.toString(16) + ' on foot but 0x'
        + byLift.state.toString(16) + ' by lift. The two arrival paths have drifted.');
    }
  },

  /**
   * The same agreement one leg later: the trip home from lunch ends the same
   * way whether the last leg was walked or ridden.
   */
  'the trip home from lunch ends the same way on foot or by lift'() {
    for (const index of [1, 2]) {
      const a = towerWithLunch();
      const b = towerWithLunch();
      const onFoot = a.workers[index];
      const byLift = b.workers[index];
      onFoot.state = OFFICE_STATE.lunchReturn;
      byLift.state = enterTransit(OFFICE_STATE.lunchReturn);

      officeDispatch(a.tower, onFoot, a.office, clockAt(2), stubCtx(3));
      officeArrival(byLift, b.office.floor);

      assert(onFoot.state === byLift.state,
        'occupant ' + index + ': 0x' + onFoot.state.toString(16) + ' on foot, 0x'
        + byLift.state.toString(16) + ' by lift');
    }
    // ...and the branch itself is the spec's: "occupant_index == 1 -> 0x00,
    // else -> 0x05".
    const { workers } = towerWithLunch();
    assert(nextStateAfterLunch(workers[1]) === OFFICE_STATE.commuteIn, 'occupant 1 goes back round');
    for (const other of [0, 2, 5]) {
      assert(nextStateAfterLunch(workers[other]) === OFFICE_STATE.commuteOut,
        'occupant ' + other + ' is done for the day after lunch');
    }
  },

  /** § Dispatch Table `0x01`: route from the office to the chosen venue. */
  'a worker routes from its office to the venue it picked'() {
    const { tower, office, venue, workers } = towerWithLunch({ officeFloor: 3, venueFloor: 5 });
    const worker = workers[1];
    worker.state = OFFICE_STATE.lunchOut;
    const ctx = stubCtx(2);
    officeDispatch(tower, worker, office, clockAt(2), ctx);

    assert(ctx.seen.routes.length === 1, 'exactly one route should have been asked for');
    const { from, to } = ctx.seen.routes[0];
    assert(from === office.floor, 'lunch starts at the office, got floor ' + from);
    assert(to === venue.floor, 'and ends at the venue, got floor ' + to);
    assert(worker.venueObjectId === venue.id, 'the worker must remember which venue it chose');
    assert(worker.state === enterTransit(OFFICE_STATE.lunchOut),
      'an accepted route leaves the worker in 0x41, got 0x' + worker.state.toString(16));
  },

  /**
   * ⚠️ **The fallback, which is the common case in a young tower.**
   * `specs/facility/OFFICE.md` § Parity: No Fast Food Available:
   * *"since negative, it returns floor 10 (lobby) as the fallback
   * destination"* — EXE floor 10 is our logical 0.
   *
   * The direction of the mistake matters here. A literal port stores `-1` and
   * reads it as a floor; in a logical tower that is B1, so every hungry worker
   * in a tower with no fast food would have been sent to the basement.
   */
  'with nowhere to eat, a worker goes to the lobby — not to floor minus one'() {
    __resetIds();
    const tower = createTower();
    tower.clock = clockAt(2);
    const placed = placeObject(tower, { family: FAMILY.office, floor: 4, left: 10, right: 15 },
      () => createSimTripRecord());
    const worker = tower.actors[1];
    worker.state = OFFICE_STATE.lunchOut;

    const ctx = stubCtx(2);
    officeDispatch(tower, worker, placed.object, clockAt(2), ctx);
    assert(worker.venueObjectId === null, 'no venue was chosen, and that must be null');
    assert(ctx.seen.routes[0].to === LOBBY_FLOOR,
      'the fallback destination is the lobby (logical 0), got floor ' + ctx.seen.routes[0].to);
    assert(ctx.seen.routes[0].to !== -1, 'floor -1 is B1, a real floor with real shops on it');
    assert(worker.state === enterTransit(OFFICE_STATE.lunchOut), 'the wasted trip is still a trip');
  },

  /**
   * § Route to Lobby Fails, § Net Effect: *"the worker skips the lunch cycle
   * entirely and enters evening departure"*. It must never get stuck — that is
   * the sentence the whole fallback section is written to guarantee.
   */
  'a worker with nowhere to eat and no way down still never gets stuck'() {
    __resetIds();
    const tower = createTower();
    tower.clock = clockAt(2);
    const placed = placeObject(tower, { family: FAMILY.office, floor: 4, left: 10, right: 15 },
      () => createSimTripRecord());
    const worker = tower.actors[1];
    worker.state = OFFICE_STATE.lunchOut;

    officeDispatch(tower, worker, placed.object, clockAt(2), stubCtx(-1));
    assert(worker.state === OFFICE_STATE.commuteOut,
      'a failed fallback must land in 0x05, got 0x' + worker.state.toString(16));
    assert(worker.state !== OFFICE_STATE.lunchOut, 'and must not sit in 0x01 retrying for ever');
  },

  /**
   * § Dispatch Table `0x02`: *"3 -> try_claim ... claimed -> 0x23, busy ->
   * 0x42, none -> 0x41"*, plus the fallback's *"acquire result 3 -> writes
   * 0x22"*. All four answers, because three of them are the ones that go wrong
   * quietly.
   */
  'arriving at the venue claims a seat, waits, or writes the venue off'() {
    // Claimed.
    {
      const { tower, office, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
      const worker = workers[1];
      worker.state = OFFICE_STATE.lunchOut;
      officeDispatch(tower, worker, office, clockAt(2, { dayTick: 900 }), stubCtx(3));
      assert(worker.state === OFFICE_STATE.atLunch,
        'a claimed seat is 0x23, got 0x' + worker.state.toString(16));
      assert(record.currentPopulation === 1, 'and the venue knows somebody is in it');
      assert(record.acquireCount === 1, 'and counts the visit');
      assert(worker.venueEnteredTick === 900, 'the dwell clock starts when the seat is taken');
    }
    // Busy — a wait, not a failure.
    {
      const { tower, office, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
      record.currentPopulation = 40;                      // more than 39
      const worker = workers[1];
      worker.state = OFFICE_STATE.lunchOut;
      officeDispatch(tower, worker, office, clockAt(2), stubCtx(3));
      assert(worker.state === enterTransit(OFFICE_STATE.lunchTransit),
        'a busy venue leaves the worker in 0x42 to try again, got 0x' + worker.state.toString(16));
      assert(worker.state !== OFFICE_STATE.strandedFailed, 'busy is not a route failure');
    }
    // None — the venue closed between being chosen and being reached, which is
    // the only way this answer is seen: `selectVenue` rejects a closed venue up
    // front, so a worker only meets one by arriving at a venue that has shut
    // since it set off. State 0x02 is that worker, mid-trip with a venue saved.
    {
      const { tower, office, venue, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
      const worker = workers[1];
      worker.state = OFFICE_STATE.lunchTransit;
      worker.venueObjectId = venue.id;
      record.availability = VENUE.closed;
      const ctx = stubCtx(3);
      officeDispatch(tower, worker, office, clockAt(2), ctx);
      assert(worker.state === enterTransit(OFFICE_STATE.lunchOut),
        'an unusable venue sends the worker back to 0x41 to pick again, got 0x' + worker.state.toString(16));
      assert(worker.venueObjectId === null, 'and it must forget the venue it cannot use');
      // § Venue Selection: "an immediate retry (delay = 0)". Zero ticks and NOT
      // inert — `CLAUDE.md`'s "before suppressing a zero".
      assert(ctx.seen.delays.some((d) => d.kind === 'invalid-venue'),
        'the zero-tick invalid-venue delay was swallowed rather than reported');
    }
    // No venue at all — the fallback writes 0x22.
    {
      __resetIds();
      const tower = createTower();
      tower.clock = clockAt(2);
      const placed = placeObject(tower, { family: FAMILY.office, floor: 0, left: 10, right: 15 },
        () => createSimTripRecord());
      const worker = tower.actors[1];
      worker.state = OFFICE_STATE.lunchOut;
      officeDispatch(tower, worker, placed.object, clockAt(2), stubCtx(3));
      assert(worker.state === OFFICE_STATE.lunchReturn,
        'the fallback lands in 0x22, got 0x' + worker.state.toString(16));
    }
  },

  /**
   * § Parity: Worker Loop, *"venue dwell uses a fixed 16-tick hold"*, against
   * § Availability's 60-tick minimum stay. Both are the reference's and the
   * larger one binds — see `spec/DEVIATIONS.md` A19. The one that binds is
   * asserted here so a change to either is visible.
   */
  'lunch lasts the venue’s minimum stay, and the office’s own hold is the floor'() {
    assert(LUNCH_DWELL === 16, 'the office’s own dwell is 16 ticks');
    assert(lunchDwellFor(null) === 16, 'with no venue to release, the 16 is what is left');
    assert(lunchDwellFor({ availability: VENUE.available }) === 60,
      'at a real venue the 60-tick minimum stay is the binding one, got ' + lunchDwellFor({}));

    const { tower, office, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
    const worker = workers[1];
    worker.state = OFFICE_STATE.lunchOut;
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 900 }), stubCtx(3));
    assert(worker.state === OFFICE_STATE.atLunch, 'precondition: the worker is eating');

    const early = stubCtx(3);
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 959 }), early);
    assert(early.seen.routes.length === 0, 'a worker asked for a route home 59 ticks into lunch');
    assert(worker.state === OFFICE_STATE.atLunch, 'and it must still be sitting there');
    assert(record.currentPopulation === 1, 'still in its seat');

    const late = stubCtx(3);
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 960 }), late);
    assert(late.seen.routes.length === 1, 'at 60 ticks the worker must leave');
    assert(record.currentPopulation === 0, 'and give the seat back BEFORE the route is asked for');
    assert(worker.state === nextStateAfterLunch(worker), 'and land back at the office');
  },

  /**
   * ⚠️ **A worker on its way home must not be asked to finish eating again.**
   *
   * `0x63` is in-transit-home and re-enters the same handler as `0x23` every
   * stride. `releaseVenueSlot` has already cleared the dwell stamp by then, and
   * treating that absence as "started dwelling now" pins the worker for ever —
   * `CLAUDE.md`'s absent-value-reads-as-real, one row down from `null >= 0`.
   *
   * It was found by measuring, not by reading, and it failed in the flattering
   * direction: 57 of 252 workers stopped travelling, dropped out of the stress
   * sample, and the seeded tower's median read **76 where the honest figure was
   * 90**. A tower that looks calmer because a sixth of its people stopped
   * moving is the shape this repo keeps a list of.
   */
  'a worker already heading home does not restart its lunch dwell'() {
    const { tower, office, workers } = towerWithLunch({ officeFloor: 4, venueFloor: 6 });
    const worker = workers[1];
    // Exactly the state the run leaves them in: transit home, slot given back,
    // stamp cleared.
    worker.state = enterTransit(OFFICE_STATE.atLunch);
    worker.venueObjectId = null;
    worker.venueEnteredTick = null;
    worker.anchorFloor = 6;

    const ctx = stubCtx(2);
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 900 }), ctx);
    assert(ctx.seen.routes.length === 1,
      'a worker in 0x63 asked for no route at all — it is waiting out a meal it already left');
    assert(ctx.seen.routes[0].to === office.floor, 'and the route it asks for is the one home');
  },

  /**
   * ⚠️ § Gate Table, `0x22`/`0x23`: *"daypart >= 4 | force state -> 0x27 +
   * release service request"*. The venue slot goes with it. A worker sent home
   * mid-meal that keeps its seat leaves the venue counting a diner who is not
   * there — and the daily rebuild sweeps occupancy, so the leak would heal
   * overnight and be invisible by morning.
   */
  'the evening sends a worker home from lunch and takes the seat back'() {
    const { tower, office, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
    const worker = workers[1];
    worker.state = OFFICE_STATE.lunchOut;
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 900 }), stubCtx(3));
    assert(record.currentPopulation === 1, 'precondition: the worker is in a seat');

    assert(officeGate(worker, office, clockAt(4), riggedRng(false)) === OFFICE_STATE.parked,
      'the evening must park a lunching worker in 0x27, not send it through 0x05');

    tower.clock = clockAt(4);
    const handler = officeFamilyHandler(stubCtx(3));
    handler(tower, worker);
    assert(worker.state === OFFICE_STATE.parked, 'the worker is parked');
    assert(record.currentPopulation === 0,
      'the venue still holds ' + record.currentPopulation + ' diner(s) who have gone home');
    assert(worker.venueObjectId === null, 'and the worker no longer claims a venue');
  },

  /** The same rule, the other exit: closing the office also frees the seat. */
  'closing an office frees the seats its workers were sitting in'() {
    const { tower, office, record, workers } = towerWithLunch({ officeFloor: 2, venueFloor: 2 });
    office.unitStatus = 0;
    office.occupiedFlag = true;
    office.evalLevel = 0;
    const worker = workers[1];
    worker.state = OFFICE_STATE.lunchOut;
    officeDispatch(tower, worker, office, clockAt(2, { dayTick: 900 }), stubCtx(3));
    assert(record.currentPopulation === 1, 'precondition: the worker is in a seat');

    assert(deactivateIfFailing(tower, office, workers), 'a zero grade must close the office');
    assert(record.currentPopulation === 0,
      'the closed office left ' + record.currentPopulation + ' of its workers at lunch for ever');
  },

  /**
   * ⚠️ The gate rows for the lunch states, checked against the spec table
   * rather than against what the code happens to do. § Family 7 Gate Table:
   * *"0x22, 0x23 | dayparts 2-3 | always dispatch | dayparts 0-1 | no
   * dispatch"*.
   */
  'the lunch gate holds all morning and always fires at midday'() {
    const { office, workers } = towerWithLunch();
    const worker = workers[1];
    for (const state of [OFFICE_STATE.lunchReturn, OFFICE_STATE.atLunch]) {
      worker.state = state;
      for (const daypart of [0, 1]) {
        assert(officeGate(worker, office, clockAt(daypart), riggedRng(true)) === 'hold',
          '0x' + state.toString(16) + ' must hold in daypart ' + daypart);
      }
      for (const daypart of [2, 3]) {
        assert(officeGate(worker, office, clockAt(daypart), riggedRng(false)) === 'dispatch',
          '0x' + state.toString(16) + ' always dispatches in daypart ' + daypart + ' — no dice');
      }
    }
  },

  /**
   * ⚠️ **A shop is placed in the open band, so `isRented` says it is let from
   * the moment it exists** — and the demolish rule read exactly that, which
   * would have made a fast food permanent. `COMMERCIAL.md` § Retail Income
   * Timing: *"the binary does not use the retail placed-object `unit_status`
   * byte to drive that visible open/closed distinction."*
   *
   * Run through the command seam, because that is the only way anything is
   * built, and check what it actually costs on the way past.
   */
  'a fast food is built through the seam for $100,000 — and can be taken down again'() {
    __resetIds();
    const tower = createTower();
    tower.segments = [];
    const world = { tower, ledger: createLedger({ cash: 1_000_000 }) };

    const built = applyAction(world, { type: 'build', what: 'fastFood', floor: 3, left: 20 });
    assert(built.ok, 'the build was refused: ' + built.reason);
    // $100,000 for the venue plus its 16 floor tiles at $500.
    const expected = CONSTRUCTION_COST.fastFood + FAST_FOOD_WIDTH * CONSTRUCTION_COST.floorTile;
    assert(built.cost === expected, 'a fast food should cost $' + expected + ', charged $' + built.cost);
    assert(built.cost !== CONSTRUCTION_COST.restaurant + FAST_FOOD_WIDTH * CONSTRUCTION_COST.floorTile,
      'that is the RESTAURANT price — the type code is wrong again');
    assert(venueOf(built.object), 'the build seam must run the placement finalizer, record and all');
    assert(tower.actors.length === VENUE_SIM_SLOTS, 'and create its 48 customers');

    // Both paths, compared — the ghost is a prediction and `applyAction` is the
    // authority, and a test that pins only one of them is not a test of the
    // agreement between them.
    const target = { floor: 3, tile: 20, object: built.object, carrier: null };
    const guess = preview(world, toolById('demolish'), target);
    const gone = applyAction(world, commandFor(tower, toolById('demolish'), target));
    assert(guess.ok === gone.ok && (guess.reason ?? '') === (gone.reason ?? ''),
      'the ghost said ' + JSON.stringify(guess.reason ?? guess.ok) + ' and the seam said '
      + JSON.stringify(gone.reason ?? gone.ok));
    assert(gone.ok,
      'a fast food could not be demolished: "' + gone.reason + '". It has customers, not tenants, '
      + 'and a shop you can never remove is a shop you are stuck with for the life of the tower.');
    assert(tower.actors.length === 0, 'its customers go with it');
  },

  // ============================================== the venue's own customers

  /**
   * ⚠️ **The customer travels lobby → venue, not venue → lobby.**
   * `spec/DEVIATIONS.md` A18. State `0x20` is where capacity is spent and where
   * the arriving visitor takes a seat, which can only happen at the venue.
   */
  'a customer comes up from the lobby, eats, and goes back down'() {
    const { tower, object, record } = towerWithFastFood({ floor: 6 });
    const customer = tower.actors[0];
    const seen = {};
    const handler = commercialFamilyHandler({
      resolveRoute: (_t, _a, from, to) => { (seen.routes ??= []).push({ from, to }); return { code: 3 }; },
    });

    tower.clock = clockAt(1, { dayTick: 500 });
    tower.rng = riggedRng(true);
    handler(tower, customer);
    assert(seen.routes[0].from === LOBBY_FLOOR, 'the customer starts at the lobby, got ' + seen.routes[0].from);
    assert(seen.routes[0].to === object.floor, 'and comes up to the venue');
    assert(customer.state === VENUE_STATE.leaving, 'having arrived, it is now on its way out');
    assert(record.currentPopulation === 1, 'and it is inside');
    assert(record.todayVisitCount === 1, 'the visit was counted when it committed to the trip');
    assert(record.remainingCapacity === 9, 'and the day’s capacity was spent, 10 -> 9');

    // The way home, once the stay is up.
    tower.clock = clockAt(2, { dayTick: 500 + MINIMUM_STAY });
    handler(tower, customer);
    assert(seen.routes[1].from === object.floor && seen.routes[1].to === LOBBY_FLOOR,
      'the way home runs venue -> lobby');
    assert(customer.state === VENUE_STATE.parked, 'and then the customer is done for the day');
    assert(record.currentPopulation === 0, 'the seat is free');
  },

  /**
   * The capacity limit is the only thing that decides how many of the 48
   * actually travel. Without it every venue would send all 48 every day and the
   * visitor bands would be meaningless.
   */
  'the day’s capacity is what caps how many of the 48 come'() {
    const { tower, record } = towerWithFastFood({ floor: 6 });
    tower.clock = clockAt(1, { dayTick: 500 });
    tower.rng = riggedRng(true);
    const handler = commercialFamilyHandler({ resolveRoute: () => ({ code: 3 }) });

    for (const customer of tower.actors) handler(tower, customer);
    assert(record.todayVisitCount === 10,
      'a venue with a capacity of 10 sent ' + record.todayVisitCount + ' customers');
    assert(record.remainingCapacity === 0, 'and the day’s capacity is spent');
    const travelled = tower.actors.filter((a) => a.state !== VENUE_STATE.arriving).length;
    assert(travelled === 10, travelled + ' of the 48 travelled; the cap should have stopped 38 of them');
  },

  /**
   * A venue nobody can reach must not silently burn its whole day's capacity on
   * failed trips — the customers who could not get there did not visit, and the
   * closure band must say so.
   */
  'an unreachable venue gives its capacity back rather than spending it'() {
    const { tower, record } = towerWithFastFood({ floor: 6 });
    tower.clock = clockAt(1, { dayTick: 500 });
    tower.rng = riggedRng(true);
    const handler = commercialFamilyHandler({ resolveRoute: () => ({ code: -1 }) });

    for (const customer of tower.actors) handler(tower, customer);
    assert(record.remainingCapacity === 10,
      'a venue nobody could reach spent ' + (10 - record.remainingCapacity) + ' of its capacity');
    assert(record.todayVisitCount === 0, 'and it must record no visits at all');
    assert(closurePayout(FAMILY.fastFood, record.acquireCount) === -3_000,
      'so it takes the loss band, which is the point');
    assert(tower.actors.every((a) => a.state === VENUE_STATE.parked),
      'and its customers park rather than hammering the router all day');
  },

  /**
   * ⚠️ A carrier arrival that lands short of the venue drops the transit bit,
   * and the gate would otherwise send a customer halfway up the building back
   * to a 1/36 roll it could fail for the rest of the day.
   */
  'a customer already on its way is not asked to roll again'() {
    const { tower, object } = towerWithFastFood({ floor: 6 });
    const customer = tower.actors[0];
    customer.venueCommitted = true;
    commercialArrival(customer, 3);
    assert(customer.state === VENUE_STATE.arriving, 'the transit bit is dropped on arrival');
    assert(commercialGate(customer, object, clockAt(0, { dayTick: 300 }), riggedRng(false)) === 'dispatch',
      'a committed customer was sent back to the dice mid-journey');
  },

  // ==================================================== end to end

  /**
   * **The sentence this file exists for.** Run a real day through the
   * scheduler, with the office family and the venue family both wired, and
   * watch the lunch traffic happen.
   */
  'a day with a fast food in it produces real lunch trips'() {
    const { tower, office, record, workers } = towerWithLunch({ officeFloor: 4, venueFloor: 5 });
    recomputeOfficeOperationalStatus(tower, office, workers);
    office.unitStatus = 0;
    for (const worker of workers) worker.state = OFFICE_STATE.lunchOut;

    const seen = { legs: [] };
    const ctx = {
      resolveRoute: (_t, _a, from, to) => { seen.legs.push([from, to]); return { code: 3 }; },
      onRent: () => {},
    };
    const handler = officeFamilyHandler(ctx);

    // Midday, when the lunch gate is wide open.
    for (let tick = 800; tick < 1000; tick++) {
      tower.clock = clockAt(2, { dayTick: tick });
      for (const worker of workers) handler(tower, worker);
    }

    const toVenue = seen.legs.filter(([, to]) => to === 5).length;
    assert(toVenue > 0, 'not one worker asked for a route to the venue in two hundred ticks of midday');
    assert(record.acquireCount > 0, 'the venue recorded no visitors at all');
    assert(workers.some((w) => w.state === OFFICE_STATE.atLunch
      || w.state === nextStateAfterLunch(w)), 'nobody got as far as sitting down');
  },

  /**
   * And the direction-of-failure check the effect is claimed on: **lunch adds
   * load, it does not replace it.** If wiring lunch made the tower quieter,
   * something stopped being counted.
   */
  'lunch adds trips to the tower rather than moving them around'() {
    const count = (workers, office, tower) => {
      const seen = [];
      const handler = officeFamilyHandler({
        resolveRoute: (_t, _a, from, to) => { seen.push([from, to]); return { code: 3 }; },
        onRent: () => {},
      });
      for (let tick = 800; tick < 1200; tick++) {
        tower.clock = clockAt(Math.floor(tick / 400), { dayTick: tick });
        for (const worker of workers) handler(tower, worker);
      }
      return seen.length;
    };

    const withVenue = towerWithLunch({ officeFloor: 4, venueFloor: 5 });
    for (const worker of withVenue.workers) worker.state = OFFICE_STATE.lunchOut;
    const busy = count(withVenue.workers, withVenue.office, withVenue.tower);

    // The same six workers with the lunch states never entered: what the tower
    // looked like before this landed.
    const idle = towerWithLunch({ officeFloor: 4, venueFloor: 5 });
    for (const worker of idle.workers) worker.state = OFFICE_STATE.atWork;
    const quiet = count(idle.workers, idle.office, idle.tower);

    assert(busy > quiet,
      'the lunch wave produced ' + busy + ' route requests against ' + quiet + ' without it. If the '
      + 'busy figure is not the larger one, lunch is replacing traffic rather than adding it.');
  },
};
