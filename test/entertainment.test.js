/**
 * The movie theater and the party hall (issue #11).
 *
 * Spec: `specs/facility/ENTERTAINMENT.md` (every number below is quoted from it,
 * beside the assertion), `specs/TIME.md` § 240 / 1000 / 1200 / 1400 / 1500 / 1600 /
 * 1900 / 2500, `specs/EVENTS.md` (bomb and fire).
 *
 * The assertions that matter run through the **composition**: `newTowerWorld`,
 * the driver's own scheduler, the real router and the real carriers. Nothing
 * here writes an attendance by hand except the pure payout tables, which are
 * boundary tests of a function; whenever money moves in a day it moved because
 * somebody rode a lift to a seat.
 */
import { applyAction, BUILDABLE, ESCALATOR_UNDERLAY, demolishRefusal } from '../src/games/tower/sim/actions.js';
import {
  AGE_CAP, ENT_STATE, ENTERTAINMENT_FAMILIES, FILMS, FILM_PRICE, GATE_CHANCE, MAX_ENTERTAINMENT_VENUES, PARTY_HALL_BUDGET,
  PARTY_HALL_MIN_HOTEL_ROOMS, PARTY_HALL_WIDTH, PARTY_PAYOUT, PHASE, SPILLOVER_FLOORS, THEATER_BUDGET, THEATER_TIERS,
  THEATER_WIDTH, activateLowerHalves, activateUpperHalves, advanceLowerHalves, advancePartyHalls, advanceUpperHalves,
  ageTierOf, changeFilm, entertainmentDispatch, entertainmentGate, entertainmentNightReset, entertainmentPaysToday, entertainmentSignal,
  entertainmentVenues, eventIsLive, filmTitle, hotelRoomCount, isBombOrFireDay, isNewRelease, middayEntertainment,
  nextSelector, partyHallHasGuests, partyHallPayout, placeEntertainment, rebuildEntertainment, spilloverVenue,
  theaterBudget, theaterPayout,
} from '../src/games/tower/sim/entertainment.js';
import { CONSTRUCTION_COST, floorConstructionCost } from '../src/games/tower/sim/economy.js';
import { STAR_REQUIREMENT, towerActivity } from '../src/games/tower/sim/progression.js';
import { CONDO_NOISE_FAMILIES } from '../src/games/tower/sim/condo.js';
import { HOTEL_NOISE_FAMILIES } from '../src/games/tower/sim/hotel.js';
import { OFFICE_NOISE_FAMILIES } from '../src/games/tower/sim/office.js';
import { venueOf } from '../src/games/tower/sim/commercial.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import {
  FAMILY, OBJECT_TYPE, OCCUPANTS, POPULATION_CONTRIBUTION, __resetIds, createTower, population,
} from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { objectSprite, venueSignal } from '../src/games/tower/render/canvas.js';
import { TOOLS, commandFor, costOf, preview, toolById } from '../src/games/tower/ui/build.js';
import { entertainmentReadout } from '../src/games/tower/ui/readout.js';
import { theaterPanelModel } from '../src/games/tower/ui/theater-panel.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { entertainmentTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

const clockAt = (daypart, { dayTick = null, dayCounter = 0 } = {}) =>
  ({ daypart, dayTick: dayTick ?? daypart * 400 + 300, dayCounter, calendarPhase: false });

/** A three-star world with cash to burn and a lift reaching `top`. */
function freshWorld({ top = 3, lift = true, stars = 3 } = {}) {
  __resetIds();
  const world = newTowerWorld({ seed: 1, cash: 90_000_000 });
  world.tower.starCount = stars;
  if (lift) {
    const r = applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 40 });
    assert(r.ok, 'fixture lift: ' + r.reason);
  }
  return world;
}

/** Build one venue through the seam, as a player would. */
function build(world, what, { floor = 1, left = 60 } = {}) {
  const r = applyAction(world, { type: 'build', what, floor, left });
  assert(r.ok, 'fixture ' + what + ': ' + r.reason);
  rebuildRouteTables(world.tower);
  return r.object;
}

/** A world holding one theater (or party hall) reached by a lift. */
function worldWith(what, options = {}) {
  const world = freshWorld(options);
  const object = build(world, what, options);
  return { world, tower: world.tower, object, record: object.venue };
}

/** Tick a whole day. `at(tick)` is called after each named tick has run. */
function runDay(scheduler, tower, at = {}) {
  for (let i = 0; i < 2600; i++) {
    scheduler.tick(tower);
    at[tower.clock.dayTick]?.();
  }
}

/**
 * A day, noting the cash on either side of the two ticks a venue is paid on:
 * 1600 (the party hall) and 1900 (the theater). What moved across them is what
 * the game PAID, whatever else the tower's cash did that day.
 */
function settleDay(scheduler, tower) {
  const cash = {};
  const mark = (name) => () => { cash[name] = tower.cash; };
  runDay(scheduler, tower, { 1599: mark('a'), 1600: mark('b'), 1899: mark('c'), 1900: mark('d') });
  return { hall: cash.b - cash.a, theater: cash.d - cash.c };
}

/** A bare tower with a clock, for the pure checkpoint tests. */
function bareTower(kind = 'theater', { floor = 2, left = 20, clock = clockAt(1) } = {}) {
  __resetIds();
  const tower = createTower({ seed: 1 });
  tower.clock = clock;
  const placed = placeEntertainment(tower, { kind, floor, left }, () => createSimTripRecord());
  assert(placed.ok, 'fixture: ' + placed.reason);
  return { tower, object: placed.object, record: placed.object.venue };
}

const sumIncome = () => {
  const paid = [];
  return { paid, hooks: { onIncome: (_o, bucket, dollars) => paid.push({ bucket, dollars }) } };
};

export const tests = {
  // ====================================================== buildable and priced

  'a movie theater ($500k) and a party hall ($100k) are on the palette, three stars each'() {
    // `docs`: "Movie theater: 3 stars, $500k; Party hall: 3 stars, $100k".
    assert(BUILDABLE.theater && BUILDABLE.partyHall, 'both are in BUILDABLE');
    assert(CONSTRUCTION_COST.movieTheater === 500_000 && CONSTRUCTION_COST.partyHall === 100_000, 'the prices');
    assert(STAR_REQUIREMENT.movieTheater === 3 && STAR_REQUIREMENT.partyHall === 3, 'three stars each');
    assert(BUILDABLE.theater.family === 0x12 && BUILDABLE.partyHall.family === 0x1d, 'families 0x12 and 0x1d');
    for (const id of ['theater', 'partyHall']) {
      assert(TOOLS.some((t) => t.action === 'build' && t.what === id), id + ' has a palette button');
    }
    assert(BUILDABLE.theater.width === THEATER_WIDTH && THEATER_WIDTH === 31, 'a theater is 31 tiles');
    assert(BUILDABLE.partyHall.width === PARTY_HALL_WIDTH && PARTY_HALL_WIDTH === 27, 'a party hall is 27');
  },

  'a one- or two-star tower is told the star it needs, before the price'() {
    const world = freshWorld({ stars: 2 });
    for (const what of ['theater', 'partyHall']) {
      const r = applyAction(world, { type: 'build', what, floor: 1, left: 60 });
      assert(!r.ok && /3 stars/.test(r.reason), what + ': ' + r.reason);
    }
    world.tower.starCount = 3;
    assert(applyAction(world, { type: 'build', what: 'theater', floor: 1, left: 60 }).ok, 'at three stars it builds');
  },

  'a venue is two objects on two floors - lower on the floor clicked, upper above - and costs both floors of tiles'() {
    const world = freshWorld();
    const cash = world.ledger.cash;
    const r = applyAction(world, { type: 'build', what: 'theater', floor: 1, left: 60 });
    assert(r.ok, r.reason);
    const price = 500_000 + floorConstructionCost({ floor: 1, tiles: 31 }) + floorConstructionCost({ floor: 2, tiles: 31 });
    assert(r.cost === price, 'the facility plus the tiles of BOTH floors: ' + r.cost + ' vs ' + price);
    assert(cash - world.ledger.cash === price, 'and exactly that was taken');
    const objects = [...world.tower.objects.values()].filter((o) => o.family === FAMILY.theater);
    assert(objects.length === 2, 'two placed objects');
    const [lower, upper] = objects.sort((a, b) => a.floor - b.floor);
    assert(lower.floor === 1 && upper.floor === 2, 'on F1 and F2');
    assert(lower.type === OBJECT_TYPE.theaterLower && upper.type === OBJECT_TYPE.theaterUpper, 'types 0x13 and 0x12');
    assert(lower.left === 60 && lower.right === 90 && upper.left === 60 && upper.right === 90, 'the same 31 tiles');
    assert(r.object === upper && upper.venue?.kind === 'entertainment_venue', 'the record is on the upper half (the venue floor)');
    assert(lower.entertainmentId === upper.id && upper.entertainmentId === upper.id, 'and the lower half points at it');
    assert(upper.venue.upperId === upper.id && upper.venue.lowerId === lower.id, 'the record knows both');
  },

  'a party hall keeps its record on the LOWER half, the one that holds the party'() {
    const { tower, object } = worldWith('partyHall', { floor: 1 });
    assert(object.type === OBJECT_TYPE.partyHallLower && object.floor === 1, 'the primary is the lower half');
    const upper = tower.objects.get(object.venue.upperId);
    assert(upper.type === OBJECT_TYPE.partyHallUpper && upper.floor === 2, '0x1d above');
  },

  'visitors: a theater seats 60 on each floor, a party hall 50 on its lower floor and none above'() {
    const { tower, record } = worldWith('theater');
    const seats = (id) => tower.actors.filter((a) => a.objectId === id).length;
    assert(seats(record.upperId) === 60 && seats(record.lowerId) === 60, 'sixty a floor');
    assert(OCCUPANTS[FAMILY.theater] === 60 && OCCUPANTS[FAMILY.partyHall] === 50, 'the table');
    const hall = worldWith('partyHall');
    const hs = (id) => hall.tower.actors.filter((a) => a.objectId === id).length;
    assert(hs(hall.record.lowerId) === 50, 'fifty on the lower');
    assert(hs(hall.record.upperId) === 0, 'and the upper half is "seeded to 0, never consumed" - nobody lives there');
    // They start parked, not waiting to be hired: nobody comes before an activation says so.
    assert(tower.actors.every((a) => a.family !== FAMILY.theater || a.state === ENT_STATE.parked), 'parked at placement');
    assert(towerActivity(tower) === 0 && population(tower) === 0, 'and a venue holds no residents');
    assert(POPULATION_CONTRIBUTION[FAMILY.theater] === 0 && POPULATION_CONTRIBUTION[FAMILY.partyHall] === 0, 'explicit zero');
  },

  'placement is refused where a venue cannot stand, in words - and the ghost says the same words'() {
    const cases = [
      ['on the ground floor', (w) => ({ floor: 0, left: 60 })],
      ['in a basement', () => ({ floor: -1, left: 60 })],
      ['with no floor above it', () => ({ floor: 109, left: 60 })],
      ['over something already built (lower floor)', (w) => {
        applyAction(w, { type: 'build', what: 'office', floor: 1, left: 70 });
        return { floor: 1, left: 60 };
      }],
      ['over something already built (the floor above)', (w) => {
        applyAction(w, { type: 'build', what: 'office', floor: 2, left: 70 });
        return { floor: 1, left: 60 };
      }],
    ];
    for (const what of ['theater', 'partyHall']) {
      for (const [label, setup] of cases) {
        const sealed = freshWorld({ top: 3 });
        const where = setup(sealed);
        const target = { floor: where.floor, tile: where.left, object: null, carrier: null };
        const guess = preview(sealed, toolById(what), target);
        const real = applyAction(sealed, guess.command ?? commandFor(sealed.tower, toolById(what), target));
        assert(guess.ok === real.ok, what + ' ' + label + ': ghost ' + guess.ok + ', seam ' + real.ok + ' - ' + guess.reason + ' / ' + real.reason);
        if (!real.ok) assert(guess.reason === real.reason, what + ' ' + label + ': "' + guess.reason + '" vs "' + real.reason + '"');
      }
    }
    const w = freshWorld();
    const err = applyAction(w, { type: 'build', what: 'theater', floor: 0, left: 60 });
    assert(!err.ok && /above the ground/.test(err.reason), err.reason);
  },

  'the ghost predicts the price of a two-floor build to the dollar, and draws two floors'() {
    const world = freshWorld();
    const target = { floor: 4, tile: 50, object: null, carrier: null };
    const guess = preview(world, toolById('theater'), target);
    assert(guess.ok && guess.footprint.floors === 2, 'a green ghost two floors tall');
    const before = world.ledger.cash;
    const real = applyAction(world, guess.command);
    assert(real.ok && real.cost === guess.cost && before - world.ledger.cash === guess.cost, 'the quote is the charge');
    assert(costOf(world.tower, guess.command) === guess.cost, 'costOf agrees');
    const poor = freshWorld();
    poor.ledger.cash = 300_000;
    const no = preview(poor, toolById('theater'), target);
    const sim = applyAction(poor, commandFor(poor.tower, toolById('theater'), target));
    assert(!no.ok && !sim.ok && no.reason === sim.reason, 'too poor: both say "' + sim.reason + '"');
  },

  'a tower holds at most sixteen theaters and party halls between them'() {
    assert(MAX_ENTERTAINMENT_VENUES === 16, 'the sidecar table has 16 slots');
    const world = freshWorld({ top: 8 });
    for (let i = 0; i < 16; i++) {
      const floor = 1 + Math.floor(i / 4) * 2, left = (i % 4) * 33;
      assert(applyAction(world, { type: 'build', what: i % 2 ? 'partyHall' : 'theater', floor, left }).ok, 'venue ' + i);
    }
    const seventeenth = applyAction(world, { type: 'build', what: 'theater', floor: 9, left: 0 });
    assert(!seventeenth.ok && /at most 16/.test(seventeenth.reason), seventeenth.reason);
  },

  'demolishing either half takes both, and everyone in them, and the venue is never "let"'() {
    const { world, tower, object, record } = worldWith('theater');
    const lower = tower.objects.get(record.lowerId);
    assert(demolishRefusal(lower) === null && demolishRefusal(object) === null, 'a venue has no tenant to evict');
    tower.populationLedger = { cinema: 120 };
    record.populationShare = 120;
    const r = applyAction(world, { type: 'demolish', objectId: lower.id });
    assert(r.ok, r.reason);
    assert(!tower.objects.has(record.upperId) && !tower.objects.has(record.lowerId), 'both halves are gone');
    assert(tower.actors.every((a) => a.family !== FAMILY.theater), 'and so are their 120 visitors');
    assert(tower.populationLedger.cinema === 0, 'and the 120 it put on the ledger');
  },

  // ============================================================ the pure rules

  'the theater pays by attendance: <40 $0, 40-79 $2,000, 80-99 $10,000, 100+ $15,000 - at every boundary'() {
    // ENTERTAINMENT.md § Cash Payouts.
    const rows = [[0, 0], [1, 0], [39, 0], [40, 2_000], [41, 2_000], [79, 2_000], [80, 10_000], [99, 10_000],
      [100, 15_000], [101, 15_000], [120, 15_000]];
    for (const [attendance, pays] of rows) {
      assert(theaterPayout(attendance) === pays, attendance + ' seats pays ' + theaterPayout(attendance) + ', not ' + pays);
    }
    assert(THEATER_TIERS.length === 4, 'four tiers');
  },

  'the party hall pays $20,000 if anyone came and nothing if nobody did'() {
    assert(partyHallPayout(0) === 0 && partyHallPayout(1) === 20_000 && partyHallPayout(50) === 20_000, 'ENTERTAINMENT.md');
    assert(PARTY_PAYOUT === 20_000, 'the constant');
  },

  'a film: a classic seats 40 / 40 / 40 / 20 by age, a new release 60 / 60 / 40 / 20 - tiers of three days'() {
    // § Runtime Budget Rules.
    assert(THEATER_BUDGET.classic.join() === '40,40,40,20' && THEATER_BUDGET.new.join() === '60,60,40,20', 'the tables');
    for (const [age, tier] of [[0, 0], [2, 0], [3, 1], [5, 1], [6, 2], [8, 2], [9, 3], [127, 3]]) {
      assert(ageTierOf(age) === tier, 'age ' + age + ' is tier ' + tier);
    }
    assert(theaterBudget(0, 0) === 40 && theaterBudget(6, 6) === 40 && theaterBudget(6, 9) === 20, 'a classic');
    assert(theaterBudget(7, 0) === 60 && theaterBudget(13, 5) === 60 && theaterBudget(13, 6) === 40 && theaterBudget(13, 9) === 20, 'a new release');
    assert(!isNewRelease(6) && isNewRelease(7), 'selectors 0-6 are classics, 7-13 new');
    assert(FILMS.length === 14 && filmTitle(0) === 'Revenge of the Big Spider' && filmTitle(13) === 'Casual Friends', 'the titles');
  },

  'buying a film: a new release is the next of 7-13, a classic the next of 0-6, and the age starts over'() {
    // § Cinema "New Movie" Picker: `((s+1)%7)+7` and `(s+1)%7`.
    assert(nextSelector(3, 'new') === 11 && nextSelector(13, 'new') === 7 && nextSelector(7, 'new') === 8, 'new');
    assert(nextSelector(3, 'classic') === 4 && nextSelector(6, 'classic') === 0 && nextSelector(12, 'classic') === 6, 'classic');
    assert(nextSelector(3, 'dvd') === null, 'there is no third pool');
    const { record } = bareTower();
    record.selector = 2; record.age = 11;
    changeFilm(record, 'new');
    assert(record.selector === 10 && record.age === 0, 'a new release, and the age clock back at zero');
    assert(FILM_PRICE.new === 300_000 && FILM_PRICE.classic === 150_000, 'the prices: $300,000 and $150,000');
  },

  'bomb and fire days: day % 60 == 59 or day % 84 == 83 - and nothing else'() {
    // ENTERTAINMENT.md § Calendar-edge payout skip; TIME.md § 240 trigger days.
    for (const d of [59, 119, 179, 83, 167, 251]) assert(isBombOrFireDay(d), 'day ' + d + ' is one');
    for (const d of [0, 1, 58, 60, 82, 84, 118, 120, 166]) assert(!isBombOrFireDay(d), 'day ' + d + ' is not');
  },

  'the pay gate is a pure function: the calendar OR a live event flag stops it, and reading it changes nothing'() {
    const tower = createTower({ seed: 1 });
    assert(tower.events && tower.events.bombActive === false && tower.events.fireActive === false, 'the flags exist and start clear');
    const frozen = JSON.stringify(tower.events);
    tower.clock.dayCounter = 10;
    assert(entertainmentPaysToday(tower) === true, 'an ordinary day pays');
    tower.events.bombActive = true;
    assert(eventIsLive(tower) && entertainmentPaysToday(tower) === false, 'a bomb stops it');
    tower.events.bombActive = false; tower.events.fireActive = true;
    assert(entertainmentPaysToday(tower) === false, 'a fire stops it');
    tower.events.fireActive = false;
    assert(entertainmentPaysToday(tower) === true, 'and clearing it restores it');
    tower.clock.dayCounter = 59;
    assert(entertainmentPaysToday(tower) === false, 'the calendar stops it with no flag at all');
    assert(JSON.stringify(tower.events) === frozen, 'nothing was written');
    delete tower.events;
    tower.clock.dayCounter = 10;
    assert(entertainmentPaysToday(tower) === true, 'a tower without the field (an old test tower) simply pays');
  },

  'the gate: 0x20 waits for daypart < 4, tick > 240 and a 1-in-6 roll; the other states dispatch every stride'() {
    const rng = (hit) => { const o = { asked: null, chance: (n) => { o.asked = n; return hit; } }; return o; };
    const going = { state: ENT_STATE.going };
    assert(GATE_CHANCE === 6, '1 in 6');
    let r = rng(true);
    assert(entertainmentGate(going, { daypart: 2, dayTick: 1100 }, r) === 'dispatch' && r.asked === 6, 'a hit dispatches');
    assert(entertainmentGate(going, { daypart: 2, dayTick: 1100 }, rng(false)) === 'hold', 'a miss holds');
    r = rng(true);
    assert(entertainmentGate(going, { daypart: 0, dayTick: 240 }, r) === 'hold' && r.asked === null, 'tick 240 is not past 240, and the RNG is not even drawn');
    assert(entertainmentGate(going, { daypart: 4, dayTick: 1700 }, rng(true)) === ENT_STATE.parked, 'past daypart 3 an idle visitor is parked for the day');
    for (const state of [ENT_STATE.shopping, ENT_STATE.home, ENT_STATE.dwelling]) {
      assert(entertainmentGate({ state }, { daypart: 5, dayTick: 2100 }, rng(false)) === 'dispatch', 'state ' + state + ' always dispatches');
    }
    assert(entertainmentGate({ state: ENT_STATE.watching }, { daypart: 2, dayTick: 1100 }, rng(true)) === 'hold', 'someone watching waits');
    assert(entertainmentGate({ state: ENT_STATE.parked }, { daypart: 2, dayTick: 1100 }, rng(true)) === 'hold', 'someone parked waits');
  },

  'the party hall needs hotel rooms in the tower - the number is one constant, and is flagged as not in the spec'() {
    const { tower } = bareTower('partyHall');
    assert(hotelRoomCount(tower) === 0 && !partyHallHasGuests(tower), 'no rooms, no party');
    const w = freshWorld();
    build(w, 'hotelSingle', { floor: 2, left: 100 });
    assert(hotelRoomCount(w.tower) === 1, 'one room counted');
    assert(PARTY_HALL_MIN_HOTEL_ROOMS >= 1, 'the condition is real');
    assert(partyHallHasGuests(w.tower) === (1 >= PARTY_HALL_MIN_HOTEL_ROOMS), 'and read from the constant');
  },

  // ====================================================== the checkpoint cycle

  '240: a rebuild reseeds both budgets from the film and its age, ages the venue, clears the counters'() {
    const { tower, record } = bareTower('theater');
    record.selector = 9;                       // a new release
    record.attendance = 77; record.active = 3; record.age = 0;
    const pop = rebuildEntertainment(tower);
    assert(record.upperBudget === 60 && record.lowerBudget === 60, 'both halves 60: ' + record.upperBudget + '/' + record.lowerBudget);
    assert(record.age === 1 && record.attendance === 0 && record.active === 0, 'aged, cleared');
    assert(pop[FAMILY.theater] === 120 && record.populationShare === 120, 'population is the budgets seeded');
    record.age = 6;
    rebuildEntertainment(tower);
    assert(record.upperBudget === 40 && record.lowerBudget === 40, 'age 6 is the third tier');
    record.age = 126;
    rebuildEntertainment(tower); rebuildEntertainment(tower); rebuildEntertainment(tower);
    assert(record.age === AGE_CAP && AGE_CAP === 127, 'age saturates at 127; it does not wrap');
    const hall = bareTower('partyHall');
    const hp = rebuildEntertainment(hall.tower);
    assert(hall.record.upperBudget === 0 && hall.record.lowerBudget === PARTY_HALL_BUDGET && PARTY_HALL_BUDGET === 50, 'a hall is 0 / 50');
    assert(hp[FAMILY.partyHall] === 50, 'population 50');
  },

  'a venue placed mid-day does nothing until the next morning: its budgets start at zero'() {
    const { tower, record } = bareTower('theater');
    assert(record.upperBudget === 0 && record.lowerBudget === 0 && record.phase === PHASE.idle, 'zeroed');
    assert(record.age === 0 && record.attendance === 0, 'and age 0');
  },

  'the day: 1000 opens the upper half, 1400 the lower, 1500 closes the upper, 1900 the lower and pays'() {
    const { tower, record } = bareTower('theater');
    const { paid, hooks } = sumIncome();
    rebuildEntertainment(tower);
    const stateOf = (id) => new Set(tower.actors.filter((a) => a.objectId === id).map((a) => a.state));
    assert(activateUpperHalves(tower) === 1, 'one theater opened');
    assert(record.upperOpen && !record.lowerOpen && record.phase === PHASE.activated, 'only the upper half');
    assert([...stateOf(record.upperId)].join() === '32', 'its 60 are 0x20');
    assert([...stateOf(record.lowerId)].join() === '39', 'the lower half still parked');
    assert(activateUpperHalves(tower) === 0, 'a theater already running is not opened twice');
    record.attendance = 85; record.active = 85;
    activateLowerHalves(tower);
    assert(record.lowerOpen && [...stateOf(record.lowerId)].join() === '32', 'the lower half opens at 1400');
    // The audience is simulated by hand ONLY in this pure test: five of the upper 60 arrived.
    tower.actors.filter((a) => a.objectId === record.upperId).slice(0, 5).forEach((a) => { a.state = ENT_STATE.watching; });
    record.active = 5;
    tower.clock = clockAt(3, { dayTick: 1500 });
    advanceUpperHalves(tower);
    assert(!record.upperOpen && record.lowerOpen, 'the upper half is closed');
    assert(tower.actors.filter((a) => a.objectId === record.upperId && a.state === ENT_STATE.shopping).length === 5,
      'daypart 3: the audience heads for the shops (0x01)');
    assert(record.active === 0 && record.phase === PHASE.activated, 'drained: phase 1');
    tower.clock = clockAt(4, { dayTick: 1900, dayCounter: 3 });
    const dollars = advanceLowerHalves(tower, hooks);
    assert(dollars === 10_000 && paid.length === 1 && paid[0].bucket === 'cinema' && paid[0].dollars === 10_000, 'paid on 85 seats: ' + JSON.stringify(paid));
    assert(record.phase === PHASE.idle && record.lastAttendance === 85 && record.lastPayout === 10_000, 'idle, and remembered for the sign');
  },

  'the upper audience is sent to the shops before daypart 4; the lower audience, and a party hall, go straight home'() {
    const { tower, record } = bareTower('theater');
    const lower = tower.actors.filter((a) => a.objectId === record.lowerId);
    rebuildEntertainment(tower); activateUpperHalves(tower); activateLowerHalves(tower);
    lower.slice(0, 3).forEach((a) => { a.state = ENT_STATE.watching; });
    record.active = 3;
    tower.clock = clockAt(4, { dayTick: 1900 });
    advanceLowerHalves(tower, {});
    assert(lower.filter((a) => a.state === ENT_STATE.home).length === 3, 'daypart 4: home (0x05), not the shops');
    assert(lower.filter((a) => a.state === ENT_STATE.parked).length === 57, 'and the 57 who never came are parked');
    const hall = bareTower('partyHall', { clock: clockAt(2) });
    rebuildEntertainment(hall.tower); hall.tower.clock = clockAt(3, { dayTick: 1200 });
    hall.tower.objects.set(900, { id: 900, family: FAMILY.hotelSingle, floor: 9, left: 0, right: 3, occupants: [] });
    middayEntertainment(hall.tower);
    const guests = hall.tower.actors.filter((a) => a.objectId === hall.record.lowerId);
    guests.slice(0, 2).forEach((a) => { a.state = ENT_STATE.watching; });
    hall.record.active = 2; hall.record.attendance = 2;
    hall.tower.clock = clockAt(3, { dayTick: 1600 });
    advancePartyHalls(hall.tower, {});
    assert(guests.filter((a) => a.state === ENT_STATE.home).length === 2, 'a party hall always sends them home, never to the shops');
  },

  'midday: the party hall opens only when the tower has hotel rooms; a theater with an audience is promoted to ready'() {
    const bare = bareTower('partyHall');
    rebuildEntertainment(bare.tower);
    assert(middayEntertainment(bare.tower) === 0 && bare.record.phase === PHASE.idle && !bare.record.lowerOpen, 'no rooms: no party');
    bare.tower.objects.set(901, { id: 901, family: FAMILY.hotelTwin, floor: 9, left: 0, right: 5, occupants: [] });
    assert(middayEntertainment(bare.tower) === 1 && bare.record.lowerOpen && bare.record.phase === PHASE.activated, 'with a room: the party opens');
    assert(bare.tower.actors.filter((a) => a.objectId === bare.record.lowerId).every((a) => a.state === ENT_STATE.going), 'all 50 are 0x20');
    assert(bare.tower.actors.filter((a) => a.objectId === bare.record.upperId).length === 0, 'the upper half has nobody to activate');
    const t = bareTower('theater');
    t.record.phase = PHASE.attending;
    middayEntertainment(t.tower);
    assert(t.record.phase === PHASE.ready, '2 -> 3 at 1200');
  },

  'a visitor spends a unit of its half budget to go; a failed first route gives it back, a failed retry parks; a spent budget leaves it idle'() {
    const { tower, record } = bareTower('theater');
    const stub = (code) => ({ resolveRoute: () => ({ code }), onDelay: () => {} });
    rebuildEntertainment(tower); activateUpperHalves(tower);
    const upper = tower.objects.get(record.upperId);
    const [a, b] = tower.actors.filter((x) => x.objectId === record.upperId);
    const before = record.upperBudget;
    entertainmentDispatch(tower, a, upper, record, tower.clock, stub(-1));
    assert(record.upperBudget === before && a.state === ENT_STATE.going, 'a failed first route refunds the unit and tries again');
    entertainmentDispatch(tower, a, upper, record, tower.clock, stub(2));
    assert(record.upperBudget === before - 1 && a.state === (ENT_STATE.going | 0x40), 'a queued route has spent it and is in transit');
    entertainmentDispatch(tower, a, upper, record, tower.clock, stub(-1));
    assert(a.state === ENT_STATE.parked && record.upperBudget === before - 1, 'a failed RETRY parks, and the unit stays spent');
    record.upperBudget = 0;
    entertainmentDispatch(tower, b, upper, record, tower.clock, stub(3));
    assert(b.state === ENT_STATE.going && record.attendance === 0, 'with the budget spent the visitor stays idle - and is not counted');
  },

  'attendance is counted on ARRIVAL, once; a visitor who gets there after its half has closed is not counted and goes home'() {
    const { tower, record } = bareTower('theater');
    const stub = { resolveRoute: () => ({ code: 3 }), onDelay: () => {} };
    rebuildEntertainment(tower); activateUpperHalves(tower);
    const upper = tower.objects.get(record.upperId);
    const [a, b] = tower.actors.filter((x) => x.objectId === record.upperId);
    entertainmentDispatch(tower, a, upper, record, tower.clock, stub);
    assert(a.state === ENT_STATE.watching && record.attendance === 1 && record.active === 1, 'arrived: counted, watching');
    assert(record.phase === PHASE.attending, 'the first arrival promotes the phase 1 -> 2');
    assert(a.anchorFloor === upper.floor, 'standing on the venue floor');
    record.upperOpen = false;                       // the 1500 pass has shut the half
    entertainmentDispatch(tower, b, upper, record, tower.clock, stub);
    assert(b.state === ENT_STATE.parked, 'a visitor who has not set out yet is simply parked');
    b.state = ENT_STATE.going | 0x40;               // one already on its way, arriving late
    entertainmentDispatch(tower, b, upper, record, tower.clock, stub);
    assert(b.state === ENT_STATE.home && record.attendance === 1 && record.active === 1, 'late: not counted, sent home');
  },

  'the night (2500) sends everyone home and shuts the venue'() {
    const { tower, record } = bareTower('theater');
    rebuildEntertainment(tower); activateUpperHalves(tower);
    tower.actors[3].state = ENT_STATE.watching; tower.actors[3].venueObjectId = 77;
    entertainmentNightReset(tower);
    assert(tower.actors.every((a) => a.state === ENT_STATE.parked && a.venueObjectId === null), 'all 0x27, aux fields cleared');
    assert(!record.upperOpen && !record.lowerOpen && record.phase === PHASE.idle && record.active === 0, 'and the venue is idle');
  },

  // =================================================== the whole thing, running

  'a theater with a lift fills by riding it, and is paid what its attendance says - not a dollar more or less'() {
    for (const [selector, label] of [[9, 'a new release'], [3, 'a classic']]) {
      const { world, tower, record, object } = worldWith('theater');
      record.selector = selector;
      const { scheduler } = makeDriver(world);
      settleDay(scheduler, tower);                       // a first day, to settle in
      const seats = theaterBudget(selector, 0) * 2;
      for (let d = 0; d < 3; d++) {
        const { theater } = settleDay(scheduler, tower);
        assert(record.lastAttendance > 0 && record.lastAttendance <= seats,
          label + ': ' + record.lastAttendance + ' seats of at most ' + seats);
        assert(record.lastPayout === theaterPayout(record.lastAttendance),
          label + ': the record says ' + record.lastPayout + ' for ' + record.lastAttendance);
        assert(theater === record.lastPayout, label + ': and the cash that moved is that payout (' + theater + ')');
      }
      assert(object.venue.lastPayout > 0, label + ' paid something');
    }
  },

  'the paying tiers are each reached by real attendance: a stale classic $2,000, a fresh one $10,000, a new release $15,000'() {
    // Attendance is capped by the film budget (two halves), so each tier is a
    // film at an age: a classic gone stale seats 20 + 20, a fresh classic 40 + 40,
    // a fresh new release 60 + 60 - and `entertainmentTrial` measures the CASH.
    const paid = new Set();
    for (const [film, ceiling, tier] of [['stale', 40, 2_000], ['classic', 80, 10_000], ['new', 120, 15_000]]) {
      const trial = entertainmentTrial({ film, days: 4 });
      for (const day of trial.perDay.slice(1)) {
        assert(day.attendance <= ceiling, film + ': ' + day.attendance + ' seats, over the budget of ' + ceiling);
        assert(day.pays === theaterPayout(day.attendance), film + ': ' + day.attendance + ' seats paid ' + day.pays);
      }
      const last = trial.perDay.at(-1);
      assert(last.pays === tier, film + ' pays $' + tier + ' once it fills: it paid ' + last.pays + ' for ' + last.attendance);
      paid.add(last.pays);
    }
    assert([...paid].sort((a, b) => a - b).join() === '2000,10000,15000', 'three different tiers, from three real audiences');
  },

  'a theater nobody can reach draws under 40 and pays nothing, and the venue still resets'() {
    const { world, tower, record } = worldWith('theater');
    const { scheduler } = makeDriver(world);
    settleDay(scheduler, tower);
    assert(settleDay(scheduler, tower).theater > 0, 'with its lift it is paid');
    // Take the lift away: nobody can get to the venue floors.
    tower.carriers.length = 0; rebuildRouteTables(tower);
    const { theater } = settleDay(scheduler, tower);
    assert(record.lastAttendance < 40 && record.lastPayout === 0 && theater === 0,
      'no lift, no audience, no money: ' + record.lastAttendance + ' seats, $' + theater);
    assert(record.phase === PHASE.idle, 'and it is idle again');
  },

  'NO TELEPORTING: a theater above a lift that does not reach it seats nobody and pays nothing'() {
    const stranded = worldWith('theater', { floor: 5, top: 3 });      // the lift stops at F3; the theater is F5-F6
    const { scheduler } = makeDriver(stranded.world);
    const cash = stranded.tower.cash;
    for (let d = 0; d < 3; d++) runDay(scheduler, stranded.tower);
    assert(stranded.record.attendance === 0 && stranded.record.lastAttendance === 0, 'nobody got there');
    assert(stranded.tower.cash <= cash, 'no income at all (only upkeep can have moved the cash)');
    assert(!stranded.tower.actors.some((a) => a.family === FAMILY.theater && a.anchorFloor >= 5 && a.state !== ENT_STATE.parked),
      'and nobody is standing on the theater floors');
  },

  'the audience is carried: lift routes, queues and arrivals are seen crossing the router'() {
    const { world, tower, record } = worldWith('theater');
    const codes = new Map();
    const { scheduler } = makeDriver(world, { observe: { route: (result) => codes.set(result.code, (codes.get(result.code) ?? 0) + 1) } });
    runDay(scheduler, tower); runDay(scheduler, tower);
    assert((codes.get(2) ?? 0) > 100, 'riders queued on the lift: ' + [...codes]);
    assert((codes.get(3) ?? 0) > 100, 'and arrived: ' + [...codes]);
    assert(record.lastAttendance > 0, 'so the house was not empty');
  },

  'SHOP SPILLOVER: the upper audience, leaving at 1500, spends in shops within five floors - and only those'() {
    const world = freshWorld({ top: 12 });
    const tower = world.tower;
    const theater = build(world, 'theater', { floor: 1, left: 60 });
    const near = build(world, 'fastFood', { floor: 5, left: 100 });      // 4 floors above the upper half (F2)... F5 is 3 from F2
    const far = build(world, 'fastFood', { floor: 12, left: 100 });      // 10 floors from F2
    const retail = build(world, 'retail', { floor: 3, left: 100 });
    assert(SPILLOVER_FLOORS === 5, 'five floors');
    const { scheduler } = makeDriver(world);
    const seen = { near: new Set(), far: new Set(), retail: new Set(), held: new Set() };
    const watch = () => {
      for (const a of tower.actors) {
        if (a.family !== FAMILY.theater || (a.state & 0x3f) !== ENT_STATE.dwelling) continue;
        if (a.venueObjectId === near.id) {
          seen.near.add(a.id);
          // Arriving TAKES A SLOT (`acquireVenueSlot` stamps the dwell start): that, and
          // not merely standing on the floor, is what makes it a visit.
          if (a.venueEnteredTick != null) seen.held.add(a.id);
        }
        if (a.venueObjectId === far.id) seen.far.add(a.id);
        if (a.venueObjectId === retail.id) seen.retail.add(a.id);
      }
    };
    for (let d = 0; d < 3; d++) for (let i = 0; i < 2600; i++) { scheduler.tick(tower); if (tower.clock.dayTick > 1500 && tower.clock.dayTick < 2000) watch(); }
    assert(theater.venue.lastAttendance > 0, 'there was an audience');
    assert(seen.near.size > 0, 'the fast food 3 floors away got theater customers: ' + seen.near.size);
    assert(seen.far.size === 0, 'the one 10 floors away got none: ' + seen.far.size);
    assert(seen.held.size === seen.near.size, 'every one of them took a slot in the shop: ' + seen.held.size + ' of ' + seen.near.size);
    assert(Math.abs(near.floor - theater.floor) <= SPILLOVER_FLOORS + 1, 'in range of the upper half');
    // Taking a slot IS a visit: the venue's own counter has them in it.
    assert(venueOf(near).acquireCount > 0, 'the fast food counted visitors');
  },

  'spillover picks only an OPEN venue in range, and nothing in range means going straight home'() {
    const { tower } = bareTower('theater', { floor: 2 });
    assert(spilloverVenue(tower, 3) === null, 'no shops at all: null (never -1, which is B1)');
    const world = freshWorld({ top: 12 });
    const ff = build(world, 'fastFood', { floor: 6, left: 100 });
    assert(spilloverVenue(world.tower, 3)?.id === ff.id, 'one shop three floors away');
    assert(spilloverVenue(world.tower, 12) === null, 'six floors away is out of range');
    venueOf(ff).availability = 3;                      // closed
    assert(spilloverVenue(world.tower, 3) === null, 'a closed one is not picked');
  },

  'the party hall: with hotel rooms it holds its party and pays $20,000; without any it does nothing'() {
    for (const rooms of [0, 1]) {
      const world = freshWorld();
      const hall = build(world, 'partyHall', { floor: 1, left: 60 });
      if (rooms) build(world, 'hotelSingle', { floor: 2, left: 110 });
      const { scheduler } = makeDriver(world);
      const before = world.tower.cash;
      runDay(scheduler, world.tower);
      runDay(scheduler, world.tower);
      const record = hall.venue;
      if (rooms >= PARTY_HALL_MIN_HOTEL_ROOMS) {
        assert(record.lastAttendance > 0 && record.lastAttendance <= 50, 'guests came: ' + record.lastAttendance);
        assert(record.lastPayout === 20_000, 'a party is $20,000 however many came');
      } else {
        assert(record.lastAttendance === 0 && record.lastPayout === 0, 'no hotel rooms: no party');
        assert(world.tower.cash <= before, 'and no money');
      }
    }
  },

  'a party hall nobody can reach holds no party: attendance zero is no payout, the 20,000 is for a party that happened'() {
    const world = freshWorld({ top: 1 });
    const hall = build(world, 'partyHall', { floor: 6, left: 60 });
    build(world, 'hotelSingle', { floor: 1, left: 110 });
    const { scheduler } = makeDriver(world);
    for (let d = 0; d < 2; d++) runDay(scheduler, world.tower);
    assert(hall.venue.lastAttendance === 0 && hall.venue.lastPayout === 0, 'nobody rode up');
  },

  'BOMB/FIRE DAYS: the theater and the party hall are paid nothing on day % 60 == 59 (and a live flag does the same), and reset anyway'() {
    const scenarios = [
      ['a bomb day by the calendar', (t) => { t.clock.dayCounter = 59; }],
      ['a fire day by the calendar', (t) => { t.clock.dayCounter = 83; }],
      ['a live bomb', (t) => { t.clock.dayCounter = 10; t.events.bombActive = true; }],
      ['a live fire', (t) => { t.clock.dayCounter = 10; t.events.fireActive = true; }],
    ];
    for (const [label, arrange] of scenarios) {
      const world = freshWorld();
      const theater = build(world, 'theater', { floor: 1, left: 0 });
      const hall = build(world, 'partyHall', { floor: 1, left: 100 });
      build(world, 'hotelSingle', { floor: 2, left: 40 });
      const { scheduler } = makeDriver(world);
      settleDay(scheduler, world.tower);                         // a first day, to settle in
      const normal = settleDay(scheduler, world.tower);
      assert(normal.theater > 0 && normal.hall === 20_000, 'an ordinary day pays both: ' + JSON.stringify(normal));
      arrange(world.tower);
      world.tower.clock.dayTick = 0;
      const day = settleDay(scheduler, world.tower);
      assert(theater.venue.lastAttendance > 40 && hall.venue.lastAttendance > 0,
        label + ': there WAS an audience (' + theater.venue.lastAttendance + ', ' + hall.venue.lastAttendance + ')');
      assert(day.theater === 0 && day.hall === 0, label + ': but the cash did not move: ' + JSON.stringify(day));
      assert(theater.venue.lastPayout === 0 && hall.venue.lastPayout === 0, label + ': and the record says so');
      assert(theater.venue.phase === PHASE.idle && hall.venue.phase === PHASE.idle, label + ': both reset');
    }
    // And the day after it pays again.
    const world = freshWorld();
    const theater = build(world, 'theater', { floor: 1, left: 0 });
    const { scheduler } = makeDriver(world);
    settleDay(scheduler, world.tower);
    world.tower.clock.dayCounter = 59; world.tower.clock.dayTick = 0;
    assert(settleDay(scheduler, world.tower).theater === 0, 'day 59: nothing');
    assert(world.tower.clock.dayCounter === 60, 'and the counter has moved on');
    assert(settleDay(scheduler, world.tower).theater > 0, 'day 60: paid');
    assert(theater.venue.lastPayout > 0, 'and the record agrees');
  },

  '1200 and 1600 are still the hotel\'s: a theater in the tower does not displace the hotel sale reset or the restaurant rebuild'() {
    const { world, tower } = worldWith('theater');
    const { scheduler } = makeDriver(world);
    tower.clock.dayTick = 1190;
    tower.hotelSaleCount = 7;
    for (let i = 0; i < 20; i++) scheduler.tick(tower);
    assert(tower.hotelSaleCount === 0, 'checkpoint 1200 reset the sale count AND ran the entertainment midday');
    const restaurant = build(world, 'restaurant', { floor: 1, left: 100 });
    venueOf(restaurant).availability = 3;               // closed, as 2200 leaves it
    tower.clock.dayTick = 1590;
    for (let i = 0; i < 20; i++) scheduler.tick(tower);
    assert(venueOf(restaurant).availability !== 3, 'checkpoint 1600 still reopened the restaurant');
  },

  // =========================================================== the film, bought

  'set_theater_film: a new release is $300,000, a classic $150,000, the age starts over, either half will do'() {
    const { world, tower, record } = worldWith('theater');
    record.selector = 3; record.age = 10;
    const cash = world.ledger.cash;
    let r = applyAction(world, { type: 'set_theater_film', objectId: record.lowerId, pool: 'new' });
    assert(r.ok && r.cost === 300_000 && cash - world.ledger.cash === 300_000, 'charged $300,000: ' + JSON.stringify(r));
    assert(record.selector === 11 && r.title === filmTitle(11) && record.age === 0, 'the next new release, age 0');
    r = applyAction(world, { type: 'set_theater_film', objectId: record.upperId, pool: 'classic' });
    assert(r.ok && r.cost === 150_000 && record.selector === 5, 'a classic: ' + record.selector);
    assert(cash - world.ledger.cash === 450_000, 'both charged');
  },

  'set_theater_film refuses what it cannot do, in words, and charges nothing'() {
    const { world, record } = worldWith('theater');
    const cash = world.ledger.cash;
    const bad = [
      [{ type: 'set_theater_film', objectId: 99999, pool: 'new' }, /nothing there/],
      [{ type: 'set_theater_film', objectId: record.upperId, pool: 'dvd' }, /new.*classic/],
    ];
    for (const [command, pattern] of bad) {
      const r = applyAction(world, command);
      assert(!r.ok && pattern.test(r.reason), JSON.stringify(command) + ': ' + r.reason);
    }
    const hall = build(world, 'partyHall', { floor: 3, left: 0 });
    let r = applyAction(world, { type: 'set_theater_film', objectId: hall.id, pool: 'new' });
    assert(!r.ok && /movie theater/.test(r.reason), 'a party hall shows no films: ' + r.reason);
    r = applyAction(world, { type: 'set_theater_film', objectId: world.tower.objects.keys().next().value, pool: 'new' });
    assert(!r.ok, 'the lobby is not a theater');
    world.ledger.cash = 299_999;
    const before = record.selector;
    r = applyAction(world, { type: 'set_theater_film', objectId: record.upperId, pool: 'new' });
    assert(!r.ok && /costs \$300,000 and you have \$299,999/.test(r.reason), r.reason);
    assert(record.selector === before && world.ledger.cash === 299_999, 'nothing moved');
    r = applyAction(world, { type: 'set_theater_film', objectId: record.upperId, pool: 'classic' });
    assert(r.ok, 'but the classic ($150,000) is still affordable');
    assert(cash > world.ledger.cash, 'sanity');
  },

  'a new film takes effect at the next rebuild: today keeps the budget it has'() {
    const { tower, record } = bareTower('theater');
    record.selector = 3;
    rebuildEntertainment(tower);
    assert(record.upperBudget === 40, 'a classic day');
    changeFilm(record, 'new');
    assert(record.upperBudget === 40, 'mid-day the budget is untouched (no refund, no top-up)');
    rebuildEntertainment(tower);
    assert(record.upperBudget === 60 && record.lowerBudget === 60, 'tomorrow: a new release, age 0');
  },

  'the Theater window reads one record and offers the two purchases with their prices and affordability'() {
    const { world, record, object } = worldWith('theater');
    record.selector = 9; record.age = 4;
    const model = theaterPanelModel(world, object.id);
    assert(model && model.film === 'Love in N.Y.' && model.pool === 'new', 'the film: ' + model.film);
    assert(model.seats === 60 && model.ageTier === 1 && model.age === 4, 'seats a show at this age: ' + model.seats);
    const [buyNew, buyClassic] = model.choices;
    assert(buyNew.price === 300_000 && buyClassic.price === 150_000, 'the two prices');
    assert(buyNew.title === filmTitle(10) && buyClassic.title === filmTitle(3), 'and what each would show next');
    assert(buyNew.affordable && buyClassic.affordable, 'affordable with $90M');
    world.ledger.cash = 200_000;
    const poorer = theaterPanelModel(world, record.lowerId);
    assert(!poorer.choices[0].affordable && poorer.choices[1].affordable, 'the new release is out of reach at $200,000 - and the other half opens the same window');
    assert(theaterPanelModel(world, 424242) === null, 'no window for what is not a theater');
    const hall = build(world, 'partyHall', { floor: 3, left: 0 });
    assert(theaterPanelModel(world, hall.id) === null, 'nor for a party hall');
  },

  // =========================================================== the world says so

  'the sign over a venue reads attendance and what the day pays - from the same payout the checkpoint uses'() {
    const { tower, object, record } = bareTower('theater');
    assert(venueSignal(object, tower).text === '0 · $0k', 'idle, nothing yet: ' + venueSignal(object, tower).text);
    record.phase = PHASE.attending; record.attendance = 84;
    assert(venueSignal(object, tower).text === '84 · $10k', venueSignal(object, tower).text);
    record.attendance = 104;
    assert(venueSignal(object, tower).text === '104 · $15k' && venueSignal(object, tower).tone === 'good', 'and updates');
    const lower = tower.objects.get(record.lowerId);
    assert(venueSignal(lower, tower) === null, 'the lower half carries no sign: the record is on the upper');
    const hall = bareTower('partyHall');
    assert(entertainmentSignal(hall.object, hall.tower).text === 'NO ROOMS', 'a hall with no hotel rooms says why: ' + entertainmentSignal(hall.object, hall.tower).text);
  },

  'the sprites: each half draws its own frame, and the primary half lights while the day runs'() {
    const t = bareTower('theater');
    const lower = t.tower.objects.get(t.record.lowerId);
    assert(objectSprite(t.object).name === 'theater' && objectSprite(t.object).animation === 'upper', 'the upper floor');
    assert(objectSprite(lower).animation === 'lower', 'the lower floor');
    t.record.phase = PHASE.activated;
    assert(objectSprite(t.object).animation === 'showing', 'a show is on');
    const h = bareTower('partyHall');
    const hUpper = h.tower.objects.get(h.record.upperId);
    assert(objectSprite(h.object).name === 'party-hall' && objectSprite(h.object).animation === 'lower', 'the hall');
    assert(objectSprite(hUpper).animation === 'upper', 'its gallery');
    h.record.phase = PHASE.attending;
    assert(objectSprite(h.object).animation === 'party', 'a party is on');
  },

  'the hover line names the film and the day, and says WHY a party hall is idle'() {
    const { tower, object, record } = bareTower('theater');
    record.selector = 0; record.lastAttendance = 62; record.lastPayout = 2_000;
    const line = entertainmentReadout(object, tower);
    assert(/Revenge of the Big Spider/.test(line) && /62 seats yesterday/.test(line) && /\$2,000/.test(line), line);
    const hall = bareTower('partyHall');
    assert(/hotel rooms/.test(entertainmentReadout(hall.object, hall.tower)), entertainmentReadout(hall.object, hall.tower));
    assert(entertainmentReadout({ family: FAMILY.office }, tower) === '', 'nothing for anything else');
  },

  // ============================================================ wired through

  'both families are escalator underlays and noise sources, exactly as the spec rows say'() {
    // COMMANDS.md: "party hall (upper), party hall (lower), cinema (upper), cinema (lower)".
    for (const family of ENTERTAINMENT_FAMILIES) {
      assert(ESCALATOR_UNDERLAY.has(family), 'escalators may land on a venue');
      assert(OFFICE_NOISE_FAMILIES.has(family) && HOTEL_NOISE_FAMILIES.has(family) && CONDO_NOISE_FAMILIES.has(family),
        'FACILITIES.md § Noise Source Matching lists entertainment on the office, hotel and condo rows');
    }
  },

  'a venue survives a save with its record, its halves and its visitors, and carries on'() {
    const { world, tower, record, object } = worldWith('theater');
    const { scheduler } = makeDriver(world);
    runDay(scheduler, tower); runDay(scheduler, tower);
    assert(SAVE_VERSION >= 5, 'the save shape changed');
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    const back = restore(blob);
    assert(back.ok, back.reason);
    const again = [...back.world.tower.objects.values()].find((o) => o.venue?.kind === 'entertainment_venue');
    assert(again && again.venue.lastAttendance === record.lastAttendance && again.venue.selector === record.selector, 'the record came back');
    assert(back.world.tower.objects.get(again.venue.lowerId)?.entertainmentId === again.id, 'and the lower half still points at it');
    assert(back.world.tower.events.bombActive === false, 'with its event flags');
    const next = makeDriver(back.world);
    // What the theater was PAID, not what the tower's cash did: a day that falls on a
    // 3-day expense pass also pays the lobby's upkeep (issue #13, A55), and net cash
    // measures the two together. `settleDay` reads the cash on either side of the
    // payout tick alone.
    const paid = settleDay(next.scheduler, back.world.tower);
    assert(again.venue.lastAttendance > 0 && paid.theater > 0,
      'the restored theater fills and is paid: ' + again.venue.lastAttendance + ' seats, $' + paid.theater);
    assert(object.id === again.id, 'same object id');
  },

  'harness: the entertainment trial reproduces the tiers, the hotel condition and the bomb day it prints'() {
    const tiers = entertainmentTrial({ days: 4, film: 'stale' });
    const fresh = entertainmentTrial({ days: 4, film: 'new' });
    assert(fresh.perDay.at(-1).pays === theaterPayout(fresh.perDay.at(-1).attendance), 'the harness pays by the table');
    assert(fresh.perDay.at(-1).attendance > tiers.perDay.at(-1).attendance, 'a new release outdraws a stale classic');
    const bomb = entertainmentTrial({ days: 3, startDay: 59 });
    assert(bomb.perDay[0].attendance > 0 && bomb.perDay[0].pays === 0, 'day 59: an audience and no pay');
  },
};
