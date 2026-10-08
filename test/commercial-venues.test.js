/**
 * The restaurant and the retail shop (issue #10).
 *
 * Fast food was the first commercial venue and `test/commercial.test.js` holds
 * its machine level. These are the two it did not cover — types 6 and 10 — and
 * the assertions that matter run through the **composition**: `newTowerWorld`,
 * the driver's own scheduler, the real router and the real carriers. Nothing
 * below writes a visitor count or opens a shop by hand.
 *
 *   - a restaurant fills at dinner, a fast food by lunch and the afternoon, a
 *     shop through the day — read off the ticks at which customers COMMIT;
 *   - the closing sweep pays what `COMMERCIAL.md` § Income says, **and the lowest
 *     band is a loss**: a restaurant nobody can reach loses $6,000 a day, and the
 *     cash really goes down by it;
 *   - a shop is paid rent by tier (`$20k / $15k / $10k / $4k`) and adds `+10`
 *     people while it is open — and it opens only when a customer ARRIVES, so a
 *     shop with no lift to it earns nothing at all (no teleporting);
 *   - weekends lift the cap, an override day lowers it;
 *   - the restaurant is a noise source; its rebuild chains onto checkpoint 1600
 *     ahead of the hotel pass; the whole thing survives a save.
 *
 * Spec: `specs/facility/COMMERCIAL.md`, `specs/TIME.md` § 1600 / § 2200,
 * `specs/DEMAND.md` § Families 6/0x0c and § Family 10, `specs/FACILITIES.md`
 * § Noise Source Matching. Every number asserted is the spec's, quoted beside it.
 */
import {
  CAPACITY_CAPS, CLOSURE_PAYOUT, CLOSURE_TICK, RESTAURANT_CLOSURE_TICK, RESTAURANT_REBUILD_TICK,
  RESTAURANT_WIDTH, RETAIL_WIDTH, VENUE, VENUE_SIM_SLOTS, closeIdleRetailShop, closurePayout,
  commercialDispatch, commercialFamilyHandler, commercialGate, growVenueSeed, openRetailShop, placeCommercialVenue,
  rebuildCommercialVenues, venueOf,
} from '../src/games/tower/sim/commercial.js';
import {
  FAMILY, OBJECT_TYPE, OCCUPANTS, __resetIds, createTower, population,
} from '../src/games/tower/sim/state.js';
import { BUILDABLE, applyAction } from '../src/games/tower/sim/actions.js';
import {
  CONSTRUCTION_COST, RENT_TIERS, placementCost,
} from '../src/games/tower/sim/economy.js';
import { STAR_REQUIREMENT, lockReason } from '../src/games/tower/sim/progression.js';
import { hotelNoiseNear } from '../src/games/tower/sim/hotel.js';
import { OFFICE_NOISE_FAMILIES, noiseSourceNear } from '../src/games/tower/sim/office.js';
import { CONDO_NOISE_FAMILIES } from '../src/games/tower/sim/condo.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import {
  PAYOUT_FAMILY, restaurantClosure, restaurantRebuild, retailCashflowHooks,
} from '../src/games/tower/sim/ledger-adapter.js';
import { SAVE_VERSION, restore, snapshot, summarise } from '../src/games/tower/sim/save.js';
import { objectSprite, venueSignal } from '../src/games/tower/render/canvas.js';
import { TOOLS, commandFor, preview, toolById } from '../src/games/tower/ui/build.js';
import { venueReadout } from '../src/games/tower/ui/readout.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { commercialTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const clockAt = (daypart, { dayTick = null, dayCounter = 0, calendarPhase = false } = {}) =>
  ({ daypart, dayTick: dayTick ?? daypart * 400 + 300, dayCounter, calendarPhase });

/** A pointer target, as `ui/main.js` builds it. */
const at = (floor, tile) => ({ floor, tile, object: null, carrier: null });

/** A bare tower holding one venue of `what`, with its record and 48 customers. */
function bareVenue(what, { clock = clockAt(1), floor = 2, left = 20 } = {}) {
  __resetIds();
  const tower = createTower();
  tower.clock = clock;
  const spec = BUILDABLE[what];
  const placed = placeCommercialVenue(tower,
    { family: spec.family, type: spec.type, floor, left, right: left + spec.width - 1 },
    () => createSimTripRecord());
  assert(placed.ok, 'fixture: ' + placed.reason);
  return { tower, object: placed.object, record: venueOf(placed.object) };
}

/** A three-star world with a lift and one venue on F1, as the harness builds it. */
function worldWith(what, { lift = true, top = 1, left = 60 } = {}) {
  const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
  world.tower.starCount = 3;
  if (lift) {
    const r = applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 40 });
    assert(r.ok, 'fixture lift: ' + r.reason);
  }
  const built = applyAction(world, { type: 'build', what, floor: 1, left });
  assert(built.ok, 'fixture ' + what + ': ' + built.reason);
  rebuildRouteTables(world.tower);
  return { world, tower: world.tower, object: built.object, record: venueOf(built.object) };
}

/** A stub router answering one code, recording where it was asked to go. */
function stubCtx(code, seen = {}) {
  seen.routes = [];
  seen.opened = 0;
  return {
    resolveRoute: (_t, _a, from, to) => { seen.routes.push({ from, to }); return { code }; },
    onDelay: () => {},
    onOpen: () => { seen.opened++; },
    seen,
  };
}

/**
 * The tick of day on which each customer COMMITTED to a visit, read off the
 * venue record's own counter through a whole day of the real scheduler. This is
 * the "when does it fill" question asked of the game rather than of the gate.
 */
function commitTicks(what, days = 3) {
  const { world, tower, record } = worldWith(what);
  const { scheduler } = makeDriver(world);
  const ticks = [];
  let last = 0;
  for (let t = 0; t < 2600 * days; t++) {
    scheduler.tick(tower);
    const now = record.todayVisitCount;
    // The counter resets at the rebuild; a drop is a reset, not a customer.
    if (now > last) for (let i = last; i < now; i++) ticks.push(tower.clock.dayTick);
    last = now;
  }
  return ticks;
}

export const tests = {
  // ==================================================== buildable and priced

  'a restaurant ($200k) and a retail shop ($100k) are on the palette, three stars each'() {
    // `COMMERCIAL.md` § Included Types, from the construction string table:
    // "type 6 -> Restaurant - $200000, type 10 -> Retail Shop - $100000".
    assert(BUILDABLE.restaurant && BUILDABLE.retail, 'both are in BUILDABLE');
    assert(BUILDABLE.restaurant.family === FAMILY.restaurant && BUILDABLE.restaurant.family === 6, 'the restaurant is family 6');
    assert(BUILDABLE.retail.family === FAMILY.retail && BUILDABLE.retail.family === 10, 'retail is family 10');
    assert(BUILDABLE.restaurant.type === OBJECT_TYPE.restaurant && BUILDABLE.retail.type === OBJECT_TYPE.retail,
      'and they place as their own type, not as fast food (0x0c)');
    assert(CONSTRUCTION_COST.restaurant === 200_000 && CONSTRUCTION_COST.retail === 100_000, 'the prices');
    assert(STAR_REQUIREMENT.restaurant === 3 && STAR_REQUIREMENT.retail === 3, 'three stars each');
    for (const id of ['restaurant', 'retail']) {
      assert(TOOLS.some((t) => t.action === 'build' && t.what === id), id + ' has a palette button');
    }
    // The charge is the facility price plus the floor tiles under it.
    assert(placementCost('restaurant', { tiles: RESTAURANT_WIDTH, floor: 1 }) >= 200_000, 'a restaurant costs at least $200,000');
  },

  'both are refused below three stars, in the lock\'s own words, and built at three'() {
    for (const what of ['restaurant', 'retail']) {
      const w = newTowerWorld({ seed: 1, cash: 90_000_000 });
      w.tower.starCount = 2;
      const refused = applyAction(w, { type: 'build', what, floor: 1, left: 60 });
      assert(!refused.ok && /3 stars/.test(refused.reason), what + ' at two stars: ' + refused.reason);
      assert(refused.reason === lockReason(w.tower, BUILDABLE[what].cost, BUILDABLE[what].label), 'the lock says it');
      w.tower.starCount = 3;
      const cash = w.ledger.cash;
      const built = applyAction(w, { type: 'build', what, floor: 1, left: 60 });
      assert(built.ok, what + ' at three stars: ' + built.reason);
      assert(cash - w.ledger.cash === built.cost && built.cost >= CONSTRUCTION_COST[what], 'the price was charged');
      assert(built.object.family === BUILDABLE[what].family, 'and it is the right family');
      assert(venueOf(built.object), 'a venue is created with its linked record (COMMERCIAL.md § Role)');
    }
  },

  '⚠️ the ghost and the seam agree on both, verdict and wording'() {
    // CLAUDE.md: "a test that pins one side of an agreement is not a test of the
    // agreement." Both paths, on a fresh world each, compared.
    const cases = [
      ['a restaurant on empty air', 'restaurant', 3, at(40, 20)],
      ['a restaurant at two stars', 'restaurant', 2, at(40, 20)],
      ['a restaurant at the right edge', 'restaurant', 3, at(40, 149)],
      ['a shop in the basement', 'retail', 3, at(-1, 20)],
      ['a shop on empty air', 'retail', 3, at(40, 20)],
      ['a shop across the lobby', 'retail', 3, at(0, 60)],
      ['a shop at two stars', 'retail', 2, at(40, 20)],
    ];
    for (const [label, what, stars, target] of cases) {
      const make = () => { const w = newTowerWorld({ seed: 1, cash: 90_000_000 }); w.tower.starCount = stars; return w; };
      const guess = preview(make(), toolById(what), target);
      const after = make();
      const real = applyAction(after, commandFor(after.tower, toolById(what), target));
      assert(guess.ok === real.ok, `${label}: ghost said ${guess.ok ? 'yes' : 'no'}, seam said ${real.ok ? 'yes' : 'no'} (${real.reason})`);
      if (!real.ok) assert(guess.reason === real.reason, `${label}: two voices\n  ghost: ${guess.reason}\n  seam:  ${real.reason}`);
      else assert(guess.cost === real.cost, `${label}: ghost quoted ${guess.cost}, charged ${real.cost}`);
    }
  },

  'each owns 48 customers, as COMMERCIAL.md § Role says — and a restaurant is not a fast food'() {
    // "restaurant (6): 48 sim slots plus one linked CommercialVenueRecord"; same for retail.
    assert(OCCUPANTS[FAMILY.restaurant] === 48 && OCCUPANTS[FAMILY.retail] === 48 && VENUE_SIM_SLOTS === 48, '48 each');
    const { tower, object } = bareVenue('restaurant');
    assert(tower.actors.filter((a) => a.objectId === object.id).length === 48, 'a placed restaurant has its 48 customers');
    assert(object.family === 6 && object.family !== FAMILY.fastFood, 'family 6, never 0x0c');
  },

  // ======================================================== when they fill

  '⚠️ a restaurant fills at dinner, a fast food by day, a shop through the day'() {
    // Read off the ticks at which customers COMMIT, through the real scheduler
    // and the real gate dice — the gate table is the claim, the game is the test.
    const dinner = commitTicks('restaurant');
    assert(dinner.length > 30, 'a restaurant must fill, got ' + dinner.length + ' commits in three days');
    assert(dinner.every((t) => t >= 1600 && t <= 2199),
      'a restaurant\'s customers come between 1600 and 2199 (daypart 4, then early daypart 5), but one came at '
      + dinner.find((t) => t < 1600 || t > 2199));
    assert(dinner.some((t) => t < 2000), 'it fills in daypart 4 (1-in-12 a stride) and daypart 5 (always) takes the rest');

    const lunch = commitTicks('fastFood');
    assert(lunch.length > 30, 'fast food fills too');
    assert(lunch.every((t) => t > 240 && t < 2000), 'a fast food trickles from tick 241 and is done by daypart 5');
    assert(lunch.some((t) => t < 1600), 'and it is a daytime venue: customers before 1600');

    const shop = commitTicks('retail', 5);
    assert(shop.length > 30, 'a shop fills too, once it is open');
    assert(shop.every((t) => t > 240 && t < 2000), 'a shop keeps fast food\'s hours (DEMAND.md: "Retail uses the same timing as fast food")');
    assert(shop.some((t) => t < 800), 'and it opens its doors in the morning');

    // The venue saturates its day's capacity within the first dayparts, so the
    // composition above shows WHEN it fills, and the gate table says when it MAY:
    // every daypart from the first tick past 240 to the end of daypart 4.
    const { tower, object } = bareVenue('retail');
    const customer = tower.actors.find((a) => a.objectId === object.id);
    customer.state = 0x20;
    object.occupiedFlag = true;
    const always = { chance: () => true, int: () => 0, next: () => 0 };
    for (const [dayTick, want] of [[200, 'hold'], [241, 'dispatch'], [700, 'dispatch'], [1000, 'dispatch'],
      [1400, 'dispatch'], [1800, 'dispatch'], [2000, 'hold'], [2300, 'hold']]) {
      const clock = clockAt(Math.floor(dayTick / 400), { dayTick });
      assert(commercialGate(customer, object, clock, always) === want, 'a shop at tick ' + dayTick + ' should ' + want);
    }
    // The restaurant's window, by the same table: nothing before 1600, and nothing after 2199.
    const diner = bareVenue('restaurant');
    const guest = diner.tower.actors[0];
    guest.state = 0x20;
    for (const [dayTick, want] of [[900, 'hold'], [1599, 'hold'], [1600, 'dispatch'], [2000, 'dispatch'], [2199, 'dispatch'],
      [2200, 'hold'], [2450, 'hold']]) {
      const clock = clockAt(Math.floor(dayTick / 400), { dayTick });
      assert(commercialGate(guest, diner.object, clock, always) === want, 'a restaurant at tick ' + dayTick + ' should ' + want);
    }
  },

  // ====================================================== the closing payout

  'the closing payout is the spec\'s table, band by band, at both sides of every edge'() {
    // `COMMERCIAL.md` § Income. < 25 / 25..34 / 35..49 / >= 50.
    const rows = [
      [FAMILY.restaurant, [-6_000, 4_000, 6_000, 10_000]],
      [FAMILY.fastFood, [-3_000, 2_000, 3_000, 5_000]],
    ];
    for (const [family, [lose, low, mid, high]] of rows) {
      for (const [visitors, want] of [[0, lose], [24, lose], [25, low], [34, low], [35, mid], [49, mid], [50, high], [200, high]]) {
        assert(closurePayout(family, visitors) === want,
          `family ${family}, ${visitors} visitors: ${closurePayout(family, visitors)}, spec says ${want}`);
      }
    }
    assert(CLOSURE_PAYOUT[FAMILY.restaurant][0] < 0 && CLOSURE_PAYOUT[FAMILY.fastFood][0] < 0,
      'the lowest band is a LOSS, not zero income');
    assert(closurePayout(FAMILY.retail, 100) === 0, 'a shop pays no closing money: its income is rent');
  },

  '⚠️ a quiet restaurant LOSES money — the cash goes down by exactly the closing payout'() {
    // The venue is open to nobody: no lift to F1. 0 visitors is the lowest band.
    const r = commercialTrial({ kind: 'restaurant', lift: false, days: 4 });
    assert(r.perDay.length === 4, 'four closings, got ' + r.perDay.length);
    for (const day of r.perDay) {
      assert(day.visitors === 0, 'nobody can reach it, so nobody comes: ' + day.visitors);
      assert(day.closure === -6_000, 'a restaurant with no diners loses $6,000, the cash moved by ' + day.closure);
      assert(day.closure === day.expected, 'and the sim paid exactly what the table says');
    }
    assert(r.closureTotal === -24_000, 'four days, $24,000 down');
  },

  'a busy restaurant EARNS: the same venue with a lift goes from losing to $6,000 a day'() {
    const r = commercialTrial({ kind: 'restaurant', days: 12 });
    for (const day of r.perDay) {
      assert(day.closure === day.expected, 'day ' + day.day + ': paid ' + day.closure + ' for ' + day.visitors + ' visitors, table says ' + day.expected);
    }
    // The first days it is learning its capacity (10 -> 20 -> 35), and a day
    // under 25 visitors is a loss - that is the spec, and it is the point.
    assert(r.perDay[0].closure < 0, 'the first evening is a loss: ' + r.perDay[0].visitors + ' visitors');
    const paying = r.perDay.filter((d) => d.closure > 0);
    assert(paying.length >= 4, 'then it earns: ' + paying.length + ' paying days of ' + r.perDay.length);
    assert(paying.every((d) => d.visitors >= 25), 'every paying day had at least 25 visitors');
    assert(r.perDay.some((d) => d.closure === 6_000 && d.visitors >= 35 && d.visitors <= 49), 'the 35..49 band pays $6,000');
    assert(r.closureTotal > 0, 'and in twelve days it is up: $' + r.closureTotal);
    // The control: the same restaurant with no lift lost money on every one of them.
    assert(commercialTrial({ kind: 'restaurant', lift: false, days: 12 }).closureTotal < 0, 'the control loses');
  },

  'hotel guests eat there: the same restaurant with rooms above it banks more'() {
    const without = commercialTrial({ kind: 'restaurant', days: 6 });
    const withHotel = commercialTrial({ kind: 'restaurant', hotelRooms: 12, days: 6 });
    const visits = (t) => t.perDay.reduce((n, d) => n + d.visitors, 0);
    assert(visits(withHotel) > visits(without),
      'twelve hotel rooms must add diners (hotel guests pick the restaurant bucket): '
      + visits(withHotel) + ' against ' + visits(without));
    assert(withHotel.closureTotal > without.closureTotal, 'and the closing money follows');
  },

  'a fast food and a restaurant close on their own clocks: 2000 and 2200'() {
    assert(CLOSURE_TICK === 2000 && RESTAURANT_CLOSURE_TICK === 2200 && RESTAURANT_REBUILD_TICK === 1600,
      'TIME.md: 1600 type-6 rebuild, 2000 the late facility cycle, 2200 the type-6 advance');
    const { world, tower, record } = worldWith('restaurant');
    const { scheduler } = makeDriver(world);
    // 1600 rebuilds the day, so the evening's count is set once that has run — a
    // 35..49 evening, written by hand for this one check of WHEN the money moves.
    while (tower.clock.dayTick !== 2100) scheduler.tick(tower);
    record.acquireCount = 40;
    while (tower.clock.dayTick !== RESTAURANT_CLOSURE_TICK - 1) scheduler.tick(tower);
    assert(record.availability !== VENUE.closed, 'still open at 2199');
    const cash = tower.cash;
    scheduler.tick(tower);
    assert(tower.clock.dayTick === 2200 && record.availability === VENUE.closed, 'closed at 2200');
    assert(tower.cash - cash === 6_000, 'and paid $6,000 for 40 diners: ' + (tower.cash - cash));
  },

  // ===================================================== the 1600 checkpoint

  '⚠️ 1600 rebuilds the restaurants AND runs the hotel pass — one key, two bodies'() {
    // `extraCheckpoints` holds ONE body per tick. A second key for the restaurant
    // would replace the hotel's (or the reverse) and nothing would error.
    const { world, tower, record } = worldWith('restaurant');
    const { scheduler } = makeDriver(world);
    // A hotel room left dirty: the 1600 pass gives it a strike (HOTEL.md).
    const room = applyAction(world, { type: 'build', what: 'hotelSingle', floor: 1, left: 100 });
    assert(room.ok, 'fixture room: ' + room.reason);
    room.object.unitStatus = 0x28;
    room.object.occupiedFlag = false;
    const strikes = room.object.activationTickCount;

    record.availability = VENUE.closed;                  // closed since last night's 2200
    record.todayVisitCount = 37;
    tower.populationLedger.restaurant = 999;
    while (tower.clock.dayTick !== 1599) scheduler.tick(tower);
    assert(record.availability === VENUE.closed, 'closed at 1599');
    scheduler.tick(tower);
    assert(tower.clock.dayTick === 1600, 'at 1600');

    assert(record.availability === VENUE.available, 'the restaurant reopened for the evening');
    assert(record.yesterdayVisitCount === 37 && record.todayVisitCount === 0, 'its day rolled over');
    assert(tower.populationLedger.restaurant === 37,
      'the family-6 bucket was CLEARED and re-added from yesterday\'s diners (TIME.md § 1600 step 1): ' + tower.populationLedger.restaurant);
    assert(room.object.activationTickCount === strikes + 1,
      'and the hotel pass ran on the same tick - the dirty room took its strike: ' + room.object.activationTickCount);
  },

  'with no restaurant at all, 1600 still clears the family-6 bucket'() {
    const world = newTowerWorld({ seed: 1 });
    const { tower } = world;
    tower.populationLedger.restaurant = 50;
    tower.clock.dayTick = 1599;
    restaurantRebuild(tower);
    assert(tower.populationLedger.restaurant === 0, '"clear family-6 population ledger bucket": ' + tower.populationLedger.restaurant);
    // Fast food and retail are not touched by the restaurant's pass.
    tower.populationLedger.fastFood = 12;
    restaurantRebuild(tower);
    assert(tower.populationLedger.fastFood === 12, 'only family 6 is rebuilt at 1600');
    restaurantClosure(tower);                            // no venues: nothing to pay, nothing to throw
  },

  // ============================================ weekends, override and the cap

  'capacity caps are 35 / 50 / 25 for a restaurant and 25 / 30 / 18 for a shop, by active phase'() {
    assert(JSON.stringify(CAPACITY_CAPS[FAMILY.restaurant]) === '[35,50,25]', 'restaurant caps');
    assert(JSON.stringify(CAPACITY_CAPS[FAMILY.fastFood]) === '[35,50,25]', 'fast food caps');
    assert(JSON.stringify(CAPACITY_CAPS[FAMILY.retail]) === '[25,30,18]', 'shop caps');

    for (const [what, [weekday, weekend, override]] of [
      ['restaurant', [35, 50, 25]], ['fastFood', [35, 50, 25]], ['retail', [25, 30, 18]],
    ]) {
      const family = BUILDABLE[what].family;
      const limitOn = (clock, stars = 3) => {
        const { tower, record } = bareVenue(what, { clock });
        tower.starCount = stars;
        for (const k of Object.keys(record.seeds)) record.seeds[k] = 900;      // far over every cap
        rebuildCommercialVenues(tower, new Set([family]));
        return record.activeCapacityLimit;
      };
      // Day 0 is a weekday, day 2 the weekend, day 4 the override (4 % 8 == 4, under 4 stars).
      assert(limitOn(clockAt(1, { dayCounter: 0 })) === weekday, what + ' on a weekday caps at ' + weekday);
      assert(limitOn(clockAt(1, { dayCounter: 2, calendarPhase: true })) === weekend,
        what + ' on a WEEKEND caps at ' + weekend + ' - weekends bring more customers');
      assert(limitOn(clockAt(1, { dayCounter: 4 })) === override,
        what + ' on an override day caps at ' + override + ' - fewer');
      assert(limitOn(clockAt(1, { dayCounter: 4 }), 4) === weekday,
        what + ': the override only applies below four stars, so a 4-star tower is back to ' + weekday);
    }
  },

  'a weekend\'s capacity is the weekend\'s own seed — earned on weekends, not borrowed from the week'() {
    const { tower, record } = bareVenue('restaurant', { clock: clockAt(1, { dayCounter: 2, calendarPhase: true }) });
    record.seeds.a = 35;                                 // a thriving weekday trade
    record.seeds.b = 10;                                 // a weekend nobody has ever tried
    rebuildCommercialVenues(tower, new Set([FAMILY.restaurant]));
    assert(record.activeCapacityLimit === 10, 'a restaurant with a weekday trade still opens a new weekend at the floor, got '
      + record.activeCapacityLimit);
    assert(record.seeds.b === 0 && record.seeds.a === 35, 'the weekend column was spent, the weekday one left alone');
    assert(record.activePhase === 'b', 'and the day remembers which column it is growing');

    // A calm customer getting home after midnight (the day counter has moved on)
    // still grows the column the day was played under.
    tower.clock = clockAt(5, { dayCounter: 3, calendarPhase: false, dayTick: 2400 });
    const calm = { ...tower.actors[0], family: FAMILY.restaurant, tripCount: 4, accumulatedElapsed: 4 * 40 };
    growVenueSeed(tower, record, calm);
    assert(record.seeds.b === 2 && record.seeds.a === 35, 'it went to the weekend seed: b=' + record.seeds.b + ' a=' + record.seeds.a);
    record.seeds.b = 49;
    growVenueSeed(tower, record, calm);
    assert(record.seeds.b === 50, 'a weekend seed is capped at the weekend\'s 50, not the weekday\'s 35: ' + record.seeds.b);
  },

  'RAIN: the spec has none — recorded, not invented'() {
    // The issue says "rain fewer"; the Maxis manual says the same. `specs/` has no
    // weather, no rain flag and no customer modifier for either (grep: zero hits
    // outside the unrelated words "drain" / "train"), and this build has no
    // weather system. `spec/DEVIATIONS.md` A39 records it. The assertion is that
    // nothing in the commercial sim reads a weather field.
    const src = Object.keys(BUILDABLE.restaurant).concat(Object.keys(BUILDABLE.retail)).join(' ');
    assert(!/rain|weather/i.test(src), 'no weather in the buildables');
    const { tower } = bareVenue('restaurant');
    assert(!('weather' in tower) && !('raining' in tower), 'and no weather on the tower');
  },

  // ============================================================ the shop

  '⚠️ a shop is placed unrented: no rent, no people, until its first customer arrives'() {
    const { tower, object, record } = bareVenue('retail');
    assert(record.availability === VENUE.dormant, 'a placed shop is dormant (COMMERCIAL.md: "closed/unrented")');
    assert(population(tower) === 0, 'and it adds no people while dormant: ' + population(tower));
    assert(!openRetailShop(tower, { ...object, family: FAMILY.fastFood }), 'only a shop is rented this way');

    const seen = {};
    openRetailShop(tower, object, stubCtx(3, seen));
    assert(record.availability === VENUE.available, 'opened');
    assert(population(tower) === 10, 'the shop adds +10 people while open: ' + population(tower));
    assert(!openRetailShop(tower, object, stubCtx(3, seen)) && seen.opened === 0,
      'opening an open shop does nothing (and does not pay twice)');
  },

  '⚠️ a shop is rented by a customer ARRIVING, not by a route being accepted'() {
    const { tower, object, record } = bareVenue('retail', { floor: 3 });
    const customer = tower.actors.find((a) => a.objectId === object.id);
    tower.clock = clockAt(1, { dayTick: 600 });
    object.occupiedFlag = true;                          // the daily bootstrap has run

    // The first leg is accepted (code 0: a walk, a queue) — the customer is on
    // its way and the shop is still dormant.
    const seen = {};
    const accepted = commercialDispatch(tower, customer, object, tower.clock, stubCtx(0, seen));
    assert(accepted.moved && record.availability === VENUE.dormant && seen.opened === 0,
      'a customer still on its way has rented nothing');
    assert(seen.routes[0].from === 0 && seen.routes[0].to === 3, 'it left the LOBBY for the shop floor, not the shop\'s own floor');

    // A route that cannot be resolved gives the capacity and the visit back.
    const second = tower.actors.filter((a) => a.objectId === object.id)[1];
    const before = { remaining: record.remainingCapacity, today: record.todayVisitCount, cycle: record.cycleVisits };
    commercialDispatch(tower, second, object, tower.clock, stubCtx(-1));
    assert(record.remainingCapacity === before.remaining && record.todayVisitCount === before.today
      && record.cycleVisits === before.cycle, 'a failed route leaves no trace in the shop\'s books');
    assert(record.availability === VENUE.dormant, 'and does not rent it');

    // Arrival: code 3 is "standing on the shop's floor".
    const arrivedSeen = {};
    customer.state = 0x20;                               // the committed customer is routed again next stride
    const arrived = commercialDispatch(tower, customer, object, tower.clock, stubCtx(3, arrivedSeen));
    assert(arrived.moved, 'it arrived');
    assert(record.availability !== VENUE.dormant && arrivedSeen.opened === 1, 'the shop opened, once');
    assert(record.currentPopulation === 1, 'and the customer got a seat: the shop was opened BEFORE the slot was asked for');
  },

  'the seed shops with no linked record stay inert: no dice, so the benchmark does not move'() {
    __resetIds();
    const tower = createTower();
    tower.clock = clockAt(1, { dayTick: 600 });
    const placed = placeCommercialVenue(tower, { family: FAMILY.retail, floor: 2, left: 20, right: 31 },
      () => createSimTripRecord());
    const shop = placed.object;
    delete shop.venue;                                   // ui/seed.js places its shops with no linked record
    shop.occupiedFlag = true;
    let draws = 0;
    tower.rng = { chance: () => { draws++; return true; }, int: () => { draws++; return 0; }, next: () => { draws++; return 0; } };
    const handler = commercialFamilyHandler(stubCtx(3));
    for (const actor of tower.actors) { actor.state = 0x20; handler(tower, actor); }
    assert(draws === 0, 'a record-less shop drew ' + draws + ' random numbers');
    assert(tower.actors.every((a) => a.state === 0x20), 'and did nothing');
  },

  'the shop gate waits for the daily bootstrap, then trickles like fast food'() {
    const { tower, object } = bareVenue('retail');
    const customer = tower.actors.find((a) => a.objectId === object.id);
    customer.state = 0x20;
    const always = { chance: () => true, int: () => 0, next: () => 0 };
    const clock = clockAt(1, { dayTick: 600 });
    assert(commercialGate(customer, object, clock, always) === 'hold', 'an unrented shop with no bootstrap flag holds');
    object.occupiedFlag = true;
    assert(commercialGate(customer, object, clock, always) === 'dispatch', 'with the flag it rolls the same dice as fast food');
  },

  '⚠️ rent by tier: $20k / $15k / $10k / $4k a quarter, every quarter, and +10 people'() {
    // The same shop at each tier through the composition. The number of payments
    // is the same for all four (the schedule is the calendar's), so rent is
    // payments x the tier's row — read off the income bucket, not a lookup.
    const payments = new Set();
    for (const [tier, rent] of [[0, 20_000], [1, 15_000], [2, 10_000], [3, 4_000]]) {
      assert(RENT_TIERS.retail[tier] === rent, 'the table: tier ' + tier + ' is $' + rent);
      const r = commercialTrial({ kind: 'retail', rentTier: tier, days: 10 });
      assert(r.open && r.openedOnDay === 1, 'tier ' + tier + ': the shop opened on day 1 (the day after the bootstrap), got ' + r.openedOnDay);
      assert(r.retailIncome > 0 && r.retailIncome % rent === 0, 'tier ' + tier + ': $' + r.retailIncome + ' is a whole number of $' + rent + ' payments');
      payments.add(r.retailIncome / rent);
      assert(r.retailPopulation === 10 && r.peakRetailPopulation === 10, 'tier ' + tier + ': +10 people while open, never more');
      assert(r.hudPopulation === 10, 'and the HUD\'s population counts them: ' + r.hudPopulation);
      assert(r.perDay.length === 0, 'a shop has no closing payout');
    }
    assert(payments.size === 1 && [...payments][0] >= 3, 'the same number of payments at every tier (>= 3 quarters): ' + [...payments]);
  },

  '⚠️ a shop nobody can reach never opens: no rent, no people — no teleporting'() {
    const r = commercialTrial({ kind: 'retail', lift: false, days: 10 });
    assert(!r.open && r.openedOnDay === null, 'it stayed unrented');
    assert(r.retailIncome === 0, 'and earned nothing: ' + r.retailIncome);
    assert(r.peakRetailPopulation === 0 && r.hudPopulation === 0, 'and added nobody');
  },

  'a shop whose customers stop arriving is let go at the next quarterly check — rent and people reversed'() {
    const { world, tower, object, record } = worldWith('retail');
    const { scheduler } = makeDriver(world);
    for (let t = 0; t < 2600 * 3; t++) scheduler.tick(tower);
    assert(record.availability !== VENUE.dormant, 'it opened');
    assert(tower.populationLedger.retail === 10, '+10 on the ledger: ' + tower.populationLedger.retail);

    // The only lift is lost. Nobody can reach the shop any more.
    tower.carriers.length = 0;
    rebuildRouteTables(tower);
    let guard = 0;
    while (record.availability !== VENUE.dormant && guard++ < 2600 * 8) scheduler.tick(tower);
    assert(record.availability === VENUE.dormant, 'a shop with no customers in a whole quarter is closed');
    assert(tower.populationLedger.retail === 0, 'its +10 came off the ledger: ' + tower.populationLedger.retail);
    assert(population(tower) === 0, 'and out of the HUD figure too');
    // And the unit is a clean "not open", so the money sweep skips it.
    assert(!closeIdleRetailShop(tower, object), 'an already-closed shop is not closed twice');
  },

  'closing a shop is the exact reverse of opening it'() {
    const world = newTowerWorld({ seed: 1, cash: 5_000_000 });
    const { tower } = world;
    __resetIds();
    const placed = placeCommercialVenue(tower,
      { family: FAMILY.retail, type: OBJECT_TYPE.retail, floor: 2, left: 20, right: 20 + RETAIL_WIDTH - 1 },
      () => createSimTripRecord());
    const object = placed.object;
    object.occupiedFlag = true;
    const hooks = retailCashflowHooks(tower);
    const cash = tower.cash;
    openRetailShop(tower, object, hooks);
    assert(tower.cash - cash === RENT_TIERS.retail[1], 'opening pays the first rent: ' + (tower.cash - cash));
    assert(tower.populationLedger.retail === 10, '+10');
    closeIdleRetailShop(tower, object, hooks);
    assert(tower.cash === cash, 'closing takes it back: ' + (tower.cash - cash));
    assert(tower.populationLedger.retail === 0, 'and the ten people');
    assert(PAYOUT_FAMILY[FAMILY.retail] === 'retail', 'priced from the retail row');
  },

  'demolishing an open shop takes its +10 off the ledger; an unrented one has none to take'() {
    const { world, tower, object } = worldWith('retail');
    const { scheduler } = makeDriver(world);
    const unrented = applyAction(world, { type: 'build', what: 'retail', floor: 1, left: 90 });
    assert(unrented.ok, unrented.reason);
    for (let t = 0; t < 2600 * 2; t++) scheduler.tick(tower);
    assert(venueOf(object).availability !== VENUE.dormant && tower.populationLedger.retail >= 10, 'the first shop is open');
    const open = tower.populationLedger.retail;
    const r = applyAction(world, { type: 'demolish', objectId: object.id });
    assert(r.ok, 'a venue has no tenant to evict: ' + r.reason);
    assert(tower.populationLedger.retail === open - 10, 'the open one took ten with it: ' + tower.populationLedger.retail + ' from ' + open);
    const gone = applyAction(world, { type: 'demolish', objectId: unrented.object.id });
    assert(gone.ok && tower.populationLedger.retail >= 0, 'an unrented shop leaves the ledger alone');
  },

  // ========================================================== noise

  '⚠️ a restaurant is a noise source for offices, hotels and condos'() {
    // `FACILITIES.md` § Noise Source Matching: offices count "restaurant (6), retail
    // (10), fast food (12), entertainment"; hotels the same plus offices; condos
    // the same plus hotels.
    for (const [name, set] of [['office', OFFICE_NOISE_FAMILIES], ['condo', CONDO_NOISE_FAMILIES]]) {
      for (const family of [FAMILY.restaurant, FAMILY.retail, FAMILY.fastFood]) {
        assert(set.has(family), name + ' does not count family ' + family + ' as noise');
      }
    }
    __resetIds();
    const tower = createTower();
    const trips = () => createSimTripRecord();
    const office = (left) => {
      const p = placeCommercialVenue(tower, { family: FAMILY.office, floor: 4, left, right: left + 5 }, trips);
      assert(p.ok, p.reason);
      return p.object;
    };
    const near = office(30);
    const far = office(100);
    const restaurant = placeCommercialVenue(tower,
      { family: FAMILY.restaurant, type: 6, floor: 4, left: 38, right: 38 + RESTAURANT_WIDTH - 1 }, trips);
    assert(restaurant.ok, restaurant.reason);
    assert(noiseSourceNear(tower, near) === true, 'an office 2 tiles from a restaurant hears it');
    assert(noiseSourceNear(tower, far) === false, 'one 60 tiles away does not');
    const room = placeCommercialVenue(tower, { family: FAMILY.hotelSingle, floor: 4, left: 64, right: 67 }, trips);
    assert(room.ok, room.reason);
    assert(hotelNoiseNear(tower, room.object) === true, 'a hotel room within 20 tiles of it does too');
  },

  // ========================================================== the screen

  'a restaurant draws its own sheet, day and night; a shop draws shuttered until it is rented'() {
    const { object } = bareVenue('restaurant');
    assert(objectSprite(object).name === 'restaurant' && objectSprite(object).animation === 'day', 'day');
    assert(objectSprite(object, { night: true }).animation === 'night', 'night');
    const shop = bareVenue('retail').object;
    assert(objectSprite(shop).animation === 'closed-night', 'an unrented shop is a shuttered front by day');
    venueOf(shop).availability = VENUE.available;
    assert(/^open-/.test(objectSprite(shop).animation), 'a rented one trades');
    assert(objectSprite(shop, { night: true }).animation === 'closed-night', 'and shutters at night');
  },

  'the money sign over a venue says what the day is worth, from the table the sim pays out of'() {
    const { object: restaurant, record } = bareVenue('restaurant');
    record.acquireCount = 23;
    let sign = venueSignal(restaurant);
    assert(sign.tone === 'bad' && sign.text === '23 · -$6k', 'under 25 is a loss, in red: ' + JSON.stringify(sign));
    record.acquireCount = 25;
    sign = venueSignal(restaurant);
    assert(sign.tone === 'good' && sign.text === '25 · $4k', 'the 25th diner turns it green: ' + JSON.stringify(sign));
    const { object: shop, record: shopRecord } = bareVenue('retail');
    assert(venueSignal(shop).text === 'UNRENTED', 'a shop says so');
    shopRecord.availability = VENUE.available;
    assert(venueSignal(shop).text === '$15k/qtr', 'then its rent: ' + venueSignal(shop).text);
    shop.rentLevel = 0;
    assert(venueSignal(shop).text === '$20k/qtr', 'which follows the tier');
  },

  'the hover line states the day\'s money and the next band'() {
    const { object, record } = bareVenue('restaurant');
    record.acquireCount = 23;
    const line = venueReadout(object);
    assert(line.includes('23 diners today') && line.includes('closing pays -$6,000') && line.includes('25 pays $4,000'), line);
    record.acquireCount = 60;
    assert(!/ pays .* · \d+ pays/.test(venueReadout(object)) && venueReadout(object).includes('$10,000'),
      'past the top band there is no next one: ' + venueReadout(object));
    const shop = bareVenue('retail').object;
    assert(venueReadout(shop).includes('unrented'), venueReadout(shop));
    assert(venueReadout({ family: FAMILY.office }) === '', 'and nothing for anything that is not a venue');
  },

  'the lease count leaves venues out: they have customers, not tenants'() {
    const world = newTowerWorld({ seed: 1 });
    const { tower } = world;
    const trips = () => createSimTripRecord();
    for (const [what, left] of [['restaurant', 10], ['retail', 40], ['fastFood', 60]]) {
      const spec = BUILDABLE[what];
      const p = placeCommercialVenue(tower, { family: spec.family, type: spec.type, floor: 3, left, right: left + spec.width - 1 }, trips);
      assert(p.ok, p.reason);
    }
    const s = summarise(world);
    assert(s.leasable === 0, 'three venues are not three units "for rent": ' + s.leasable);
  },

  // ========================================================== save and load

  'a restaurant and a shop survive a save, record and all'() {
    assert(SAVE_VERSION >= 4, 'the save shape changed (issue #10), so the version moved to at least 4: ' + SAVE_VERSION);
    const { world, tower, object: shop, record } = worldWith('retail');
    const eat = applyAction(world, { type: 'build', what: 'restaurant', floor: 1, left: 100 });
    assert(eat.ok, eat.reason);
    const { scheduler } = makeDriver(world);
    for (let t = 0; t < 2600 * 2; t++) scheduler.tick(tower);
    const opened = record.availability;
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    const back = restore(blob);
    assert(back.ok, back.reason);
    const shop2 = back.world.tower.objects.get(shop.id);
    const rec2 = venueOf(shop2);
    assert(rec2 && rec2.availability === opened && rec2.cycleVisits === record.cycleVisits, 'the shop\'s record came back');
    assert(rec2.activePhase === record.activePhase, 'with the column the day is growing');
    assert(venueOf(back.world.tower.objects.get(eat.object.id)), 'and the restaurant\'s');
    assert(back.world.tower.populationLedger.retail === tower.populationLedger.retail, 'and the +10');
    // An old save is refused, not resumed into a different game.
    assert(!restore({ ...blob, version: 3 }).ok, 'a v3 save is refused');
  },
};
