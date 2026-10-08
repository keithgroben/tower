/**
 * A fortnight of the game, headless, through the driver's own composition.
 *
 * `node harness/playtest.js [days] [seed]`
 *
 * This exists because the browser cannot answer "is it worth playing?" quickly
 * and the test suite deliberately never asks. Tests pin rules; this prints what
 * a player would actually watch happen — how many offices rent, what a typical
 * worker's commute costs them, when the money turns, whether the ladder moves.
 *
 * It runs the driver's **own** wiring, `ui/driver.js` — not a restatement of it.
 * That wiring used to live inside `ui/main.js`, which touches `document` at
 * module scope and so cannot be imported from Node, and the first version of
 * this file copied those twenty lines to get around that. A harness that
 * restates the composition measures a copy, and reports confidently on a game
 * nobody is playing the day the two drift. So the composition moved instead.
 */
import { COMMERCIAL_FAMILY_CODES, FAMILY, isHotelFamily, isUnitLet, population } from '../src/games/tower/sim/state.js';
import { isCondoSold } from '../src/games/tower/sim/condo.js';
import { isHotelBooked, isHotelInfested, isHotelRoomDirty } from '../src/games/tower/sim/hotel.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import {
  CONSTRUCTION_COST, LEDGER_CHECKPOINT_TICK, RENT_TIERS, isCashflowDay,
} from '../src/games/tower/sim/economy.js';
import { newTowerWorld, seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { computeRuntimeTileStressAverage, stressBand } from '../src/games/tower/sim/stress.js';
import { BUILDABLE, applyAction } from '../src/games/tower/sim/actions.js';
import {
  HOTEL_SUITES_FOR_FOUR_STARS, STAR_THRESHOLDS, WEDDING_GUESTS, starGateStatus, starGatesOf, starPopulation,
  towerActivity,
} from '../src/games/tower/sim/progression.js';
import { SECURITY_OFFICES_FOR_THREE_STARS } from '../src/games/tower/sim/security.js';
import { metroCommuterCount, metroPlatformFloor, metroServed, officeWorkerCommutes } from '../src/games/tower/sim/metro.js';
import { starClause } from '../src/games/tower/ui/readout.js';
import { CARRIER_MODE } from '../src/games/tower/sim/elevators.js';
import {
  CLOSURE_TICK, RESTAURANT_CLOSURE_TICK, closurePayout, venueOf,
} from '../src/games/tower/sim/commercial.js';
import { ENT_STATE, LOWER_ADVANCE_TICK, PARTY_ADVANCE_TICK } from '../src/games/tower/sim/entertainment.js';
import { activeDemands, demandsOf, isDemanded, noticesAfter } from '../src/games/tower/sim/demands.js';
import { OFFICE_STATE } from '../src/games/tower/sim/office.js';
import { carsParked, usableSpaces } from '../src/games/tower/sim/parking.js';
import { medicalCenters } from '../src/games/tower/sim/medical.js';
import {
  RECYCLING_AFTERNOON_TICK, RECYCLING_FINAL_TICK, RECYCLING_MIDDAY_TICK, recyclingCenters, workingRecyclingCenters,
} from '../src/games/tower/sim/recycling.js';

const TICKS_PER_DAY = 2600;

/** What the HUD would say, computed the way `drawHud` computes it. */
export function readout(world) {
  const { tower, ledger } = world;
  let let_ = 0, leasable = 0;
  for (const o of tower.objects.values()) {
    if (o.occupants.length === 0) continue;
    // A hotel room is booked by the night, not let — the HUD leaves it out for
    // the same reason, and `hotelWatch` below reports it on its own line.
    if (isHotelFamily(o.family)) continue;
    // ...and neither is a venue: it has customers, not a lease (the HUD's cut).
    if (COMMERCIAL_FAMILY_CODES.has(o.family)) continue;
    leasable++;
    // Per family: an office is let to `0x0f`, a condo is sold to `0x17`.
    if (o.occupiedFlag && isUnitLet(o)) let_++;
  }
  // Excludes people with no trips: they score 0, the BEST value, so counting
  // them makes a tower that cannot move anybody read as a perfect one.
  const scores = [];
  for (const actor of tower.actors) {
    if (!actor || actor.tripCount === 0) continue;
    scores.push(computeRuntimeTileStressAverage(actor));
  }
  scores.sort((a, b) => a - b);
  const typical = scores.length ? scores[Math.floor(scores.length / 2)] : null;
  return {
    day: tower.clock.dayCounter,
    let: let_,
    leasable,
    stress: typical,
    band: typical === null ? '—' : stressBand(typical),
    moving: scores.length,
    cash: ledger.cash,
    population: population(tower),
    stars: tower.starCount,
    // What the LADDER counts (hotel guests drop out from 3 stars), not the raw ledger.
    activity: starPopulation(tower),
    // What the bar says, word for word - the ladder's own account of what is missing.
    hud: starClause(starGateStatus(tower), (kind) => Object.hasOwn(BUILDABLE, kind)),
  };
}

/**
 * **The condo ledger, watched rather than inferred.**
 *
 * A condo's money is two events of the same size in opposite directions, and
 * neither survives to be read afterwards: the income bucket is cleared every
 * third day by the rollover, and the cash balance has a tower's worth of rent
 * and expenses mixed into it. Sampling `tower.cash` once a day answers "is the
 * player up or down" and not "what did the condos cost them", which is the
 * question.
 *
 * So the transitions are counted as they happen. `unit_status` crossing the
 * `0x17` boundary IS the event — `finalizeCondoSale` and `revertCondoToUnsold`
 * are the only two things in the sim that cross it — so a per-tick band watch
 * cannot miss a sale that is refunded before the next daily sample, which a
 * daily one silently would.
 */
export function condoWatch(tower) {
  const seen = new Map();               // object id -> was it sold last tick
  const totals = { sales: 0, refunds: 0, earned: 0, given: 0 };

  return {
    totals,
    sample() {
      for (const object of tower.objects.values()) {
        if (object.family !== FAMILY.condo) continue;
        const sold = isCondoSold(object.unitStatus);
        const before = seen.get(object.id);
        seen.set(object.id, sold);
        if (before === undefined || before === sold) continue;
        // The price is read at the moment of the event, from the same table the
        // sim pays out of — a re-tiered condo would otherwise be counted at a
        // price it was never sold for.
        const price = RENT_TIERS.condo[object.rentLevel] ?? 0;
        if (sold) { totals.sales++; totals.earned += price; }
        else { totals.refunds++; totals.given += price; }
      }
    },
  };
}

/**
 * **The hotel ledger, watched rather than inferred** — for the same reason as
 * the condo's, and with a sharper reason still: a hotel's income is one payment
 * per stay, banked in the morning on top of a tower's worth of rent, so a daily
 * cash sample cannot see it at all.
 *
 * A check-in is `unit_status` entering the occupied band and a checkout is it
 * leaving for the dirty one; `activateHotelRoom` and `checkoutHotelRoom` are the
 * only two things that cross either edge, so a per-tick watch cannot miss a stay.
 * The price is read at the moment of the event, from the table the sim pays out
 * of.
 */
export function hotelWatch(tower) {
  const seen = new Map();               // object id -> was a guest in residence last tick
  const bands = new Map();              // object id -> 'dirty' | 'infested' | 'other', last tick
  const totals = { checkins: 0, checkouts: 0, earned: 0, cleaned: 0, infestations: 0, firstInfestedDay: null };
  const PRICE = { [FAMILY.hotelSingle]: 'hotelSingle', [FAMILY.hotelTwin]: 'hotelTwin', [FAMILY.hotelSuite]: 'hotelSuite' };

  return {
    totals,
    sample() {
      for (const object of tower.objects.values()) {
        if (!isHotelFamily(object.family)) continue;

        // The two edges housekeeping (issue #9) owns: dirty -> clean is a room
        // somebody walked to and cleaned, and anything -> infested is a room lost.
        // `cleanHotelRoom` and `infestHotelRoom` are the only writers of either, so
        // a per-tick watch cannot miss one.
        const band = isHotelInfested(object) ? 'infested' : isHotelRoomDirty(object) ? 'dirty' : 'other';
        const lastBand = bands.get(object.id);
        bands.set(object.id, band);
        if (lastBand === 'dirty' && band === 'other') totals.cleaned++;
        if (band === 'infested' && lastBand !== undefined && lastBand !== 'infested') {
          totals.infestations++;
          totals.firstInfestedDay ??= tower.clock.dayCounter;
        }

        const booked = isHotelBooked(object);
        const before = seen.get(object.id);
        seen.set(object.id, booked);
        if (before === undefined || before === booked) continue;
        if (booked) totals.checkins++;
        else { totals.checkouts++; totals.earned += RENT_TIERS[PRICE[object.family]][object.rentLevel] ?? 0; }
      }
    },
  };
}

/**
 * A player, roughly.
 *
 * Not an optimiser — an impatient person with money. They extend the lift to
 * whatever they have stranded, then keep stacking offices on the floors it
 * reaches, because that is what the palette invites you to do and what any
 * first tower looks like. If the loop is real, this eventually costs them:
 * one lift cannot carry an unbounded number of commuters, so stress climbs,
 * evaluations fail, and tenants leave.
 *
 * If it never costs them, the game has no bottom, and "build more" is a button
 * that only ever prints money.
 */
export function greedyBuilder(world, { condos = true, hotels = true, housekeeping = true, security = true } = {}) {
  const { tower } = world;

  /**
   * A hotel next to an office is a hotel with a noise problem — offices are on
   * its noise list and within 20 tiles it starts 60 points into a 150-point
   * failure budget — so a player who has learned that, or lost money finding
   * out, builds them on a floor of their own. This is the first floor with
   * nothing but hotel rooms on it; if it is above the lift, tomorrow's step 1
   * extends the lift to it, which is free.
   */
  const buildHotelRoom = () => {
    if (tower.starCount < 2) return null;            // single rooms are a two-star tool
    let top = 0;
    for (const o of tower.objects.values()) if (o.floor > top) top = o.floor;
    for (let floor = 1; floor <= top + 1; floor++) {
      const mixed = [...tower.objects.values()].some((o) => o.floor === floor && !isHotelFamily(o.family));
      if (mixed) continue;
      for (let left = 0; left + BUILDABLE.hotelSingle.width <= 150; left += BUILDABLE.hotelSingle.width) {
        const r = applyAction(world, { type: 'build', what: 'hotelSingle', floor, left });
        if (r.ok) return 'built a hotel room on F' + floor;
        if (/afford/.test(r.reason ?? '')) return null;
      }
    }
    return null;
  };
  const hotelCount = () => [...tower.objects.values()].filter((o) => isHotelFamily(o.family)).length;

  /**
   * **A player who has read the manual.** Hotels need housekeeping, housekeeping
   * needs a way to the rooms that is not the guests' lift, and one facility's six
   * staff clean about a dozen rooms a day on a floor. So: a service elevator that
   * reaches the highest hotel floor, and a facility for every dozen rooms.
   * `housekeeping: false` is the player who has not (`--no-housekeeping`), and
   * what happens to their hotel is the point of the trial below.
   */
  const buildHousekeeping = () => {
    if (tower.starCount < 2) return null;
    const rooms = hotelCount();
    if (rooms === 0) return null;
    let topHotel = 0;
    for (const o of tower.objects.values()) if (isHotelFamily(o.family) && o.floor > topHotel) topHotel = o.floor;

    let service = tower.carriers.find((c) => c.mode === CARRIER_MODE.SERVICE);
    if (!service) {
      for (let column = 0; column <= 146 && !service; column++) {
        const r = applyAction(world, { type: 'build_shaft', kind: 'service', bottom: 0, top: topHotel, column });
        if (r.ok) { service = r.carrier; return 'built a service elevator at column ' + column; }
        if (/afford/.test(r.reason ?? '')) return null;
      }
      return null;
    }
    if (service.topFloor < topHotel) {
      const r = applyAction(world, { type: 'extend_shaft', carrierId: service.id, top: topHotel });
      if (r.ok) return 'extended the service elevator to F' + topHotel;
    }
    const facilities = [...tower.objects.values()].filter((o) => o.family === FAMILY.housekeeping).length;
    if (facilities >= Math.ceil(rooms / 12)) return null;
    for (let floor = 1; floor <= service.topFloor; floor++) {
      for (let left = 0; left + BUILDABLE.housekeeping.width <= 150; left += 5) {
        const r = applyAction(world, { type: 'build', what: 'housekeeping', floor, left });
        if (r.ok) return 'built housekeeping on F' + floor;
        if (/afford/.test(r.reason ?? '')) return null;
      }
    }
    return null;
  };

  /**
   * **The security office** (issue #12): the one thing the `2 -> 3` gate asks for
   * by name. A basement, two stars. `security: false` is the player who never
   * builds one (`--no-security`), which is what the star-ladder trial measures.
   */
  const buildSecurity = () => {
    if (tower.starCount < 2) return null;
    if ([...tower.objects.values()].some((o) => o.family === FAMILY.security)) return null;
    for (const floor of [-1, -2, -3]) {
      for (let left = 0; left + BUILDABLE.security.width <= 150; left += 4) {
        const r = applyAction(world, { type: 'build', what: 'security', floor, left });
        if (r.ok) return 'built a security office on B' + -floor;
        if (/afford/.test(r.reason ?? '')) return null;
      }
    }
    return null;
  };

  return function act() {
    const lift = tower.carriers[0];
    if (!lift) return null;

    // 0. The thing the ladder is waiting for, the moment it can be bought.
    if (security) { const did = buildSecurity(); if (did) return did; }

    // 1. Anything stranded above the lift is the first thing a player notices —
    //    a room saying FOR RENT that never rents.
    let highest = lift.topFloor;
    for (const o of tower.objects.values()) if (o.occupants.length && o.floor > highest) highest = o.floor;
    if (highest > lift.topFloor) {
      const r = applyAction(world, { type: 'extend_shaft', carrierId: lift.id, top: highest });
      if (r.ok) return 'extended the lift to F' + highest;
    }

    // 1b. The moment hotels unlock, a dozen of them: they are the new toy, and
    //     they are what puts people in the lifts in the evening.
    if (hotels && hotelCount() < 12) { const did = buildHotelRoom(); if (did) return did; }

    // 1c. ...and the staff to keep them. Before anything else once hotels exist:
    //     a room left dirty three days is a room lost.
    if (hotels && housekeeping) { const did = buildHousekeeping(); if (did) return did; }

    // 2. A condo is the shiny expensive thing, so it is what an impatient
    //    person with money reaches for first. $80,000 out, $150,000 back the
    //    moment somebody moves in — which reads as free money until the lift
    //    stops coping and the sale is taken back off you.
    //
    //    Sixteen tiles, so these are the two clear runs either side of the
    //    seeded office banks: 0..47 on the left, 94..141 on the right.
    if (condos) {
      for (let floor = 1; floor <= lift.topFloor; floor++) {
        for (const left of [0, 16, 32, 94, 110, 126]) {
          const r = applyAction(world, { type: 'build', what: 'condo', floor, left });
          if (r.ok) return 'built a condo on F' + floor;
          if (/afford/.test(r.reason ?? '')) return null;
        }
      }
    }

    // 3. Otherwise stack another office on a floor the lift already serves.
    for (let floor = lift.bottomFloor + 1; floor <= lift.topFloor; floor++) {
      for (const left of [10, 16, 22, 46, 52, 58]) {
        const r = applyAction(world, { type: 'build', what: 'office', floor, left });
        if (r.ok) return 'built an office on F' + floor;
        if (/afford/.test(r.reason ?? '')) return null;   // broke; wait for rent
      }
    }

    // 4. Out of rooms to stack: a hotel, however many there are already.
    if (hotels) { const did = buildHotelRoom(); if (did) return did; }
    return null;
  };
}

/**
 * **The housekeeping trial: too few staff, and enough.** Issue #9's proof.
 *
 * One hotel floor of single rooms, a guest lift and a service elevator, and `n`
 * housekeeping facilities; then `days` of the game through the driver's own
 * composition. Nothing is scripted — no room's band is written, no member of staff
 * is moved. Guests check in each evening and out each morning, the staff walk to
 * the dirty rooms by service elevator and clean them (or do not get to), and the
 * 1600 pass gives a room still dirty its strike.
 *
 * **Why one floor.** A facility's six staff each look after one residue of the
 * floor number modulo six, so one floor is served by exactly one of a facility's
 * staff and the floor's capacity is what that one person can get through before
 * tick 1500 — about eighteen rooms. That makes "too few housekeepers for the
 * rooms" a plain count: twenty-two rooms is more than one facility can do and
 * fewer than two can.
 *
 * Returns the numbers; the CLI below prints them and `test/housekeeping.test.js`
 * asserts on the same function, so the harness and the test cannot disagree about
 * what was run.
 *
 * @returns {{facilities:number, rooms:number, days:number, checkins:number,
 *   checkouts:number, cleaned:number, infestations:number,
 *   firstInfestedDay:number|null, dirtyAtEnd:number, infestedAtEnd:number,
 *   earned:number, perDay:string[]}}
 */
export function housekeepingTrial({ facilities, rooms = 22, days = 10, seed = 1, floor = 8 } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 3;
  const must = (result, what) => {
    if (!result.ok) throw new Error('housekeeping trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top: floor + 1, column: 40 }), 'the guest lift');
  must(applyAction(world, { type: 'build_shaft', kind: 'service', bottom: 0, top: floor + 1, column: 52 }), 'the service elevator');
  const built = [];
  for (let i = 0; i < rooms; i++) {
    built.push(must(applyAction(world, { type: 'build', what: 'hotelSingle', floor, left: 60 + i * 4 }), 'room ' + i).object);
  }
  for (let k = 0; k < facilities; k++) {
    must(applyAction(world, { type: 'build', what: 'housekeeping', floor: 1, left: 70 + k * 16 }), 'housekeeping ' + k);
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);
  const watch = hotelWatch(tower);

  const perDay = [];
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) { scheduler.tick(tower); watch.sample(); }
    perDay.push('d' + tower.clock.dayCounter + ' ' + built.filter(isHotelRoomDirty).length + 'd/'
      + built.filter(isHotelInfested).length + 'i');
  }
  return {
    facilities, rooms, days,
    checkins: watch.totals.checkins,
    checkouts: watch.totals.checkouts,
    cleaned: watch.totals.cleaned,
    infestations: watch.totals.infestations,
    firstInfestedDay: watch.totals.firstInfestedDay,
    dirtyAtEnd: built.filter(isHotelRoomDirty).length,
    infestedAtEnd: built.filter(isHotelInfested).length,
    earned: watch.totals.earned,
    perDay,
  };
}

/**
 * **The star-ladder trial: the 2 -> 3 gate, with and without a security office.**
 * Issue #12's proof.
 *
 * A tower that is honestly big enough: four lifts of eight cars each, and ten
 * floors of offices (250 of them), so the tenants come from real routes through
 * real carriers - nothing is written into the population ledger. It starts on an
 * empty lot at one star, and the day the star count reaches two (300 activity, no
 * other gate) the security office becomes buildable.
 *
 *  - `security: false` is the player who never builds one. The activity is far
 *    past the 1,000 the next rung asks for, and the ladder stops at two stars
 *    with *"a security office"* as the one blocker - `specs/GAME-STATE.md`
 *    § Star Advancement.
 *  - `security: true` builds one in the first basement the morning after the
 *    second star, which is the earliest a player can (it is a two-star tool, and
 *    the trial also tries at one star and reports the refusal).
 *
 * Returns the numbers; the CLI prints them and `test/security.test.js` asserts on
 * the same function, so the harness and the test cannot disagree about what was
 * run.
 *
 * @returns {{security:boolean, days:number, offices:number, perDay:object[],
 *   twoStarDay:number|null, threeStarDay:number|null, peakActivity:number,
 *   daysPastThreshold:number, finalStar:number, finalBlockers:string[],
 *   earlyRefusal:string|null, securityCost:number|null, securityDay:number|null}}
 */
export function starLadderTrial({ security, days = 8, seed = 1, floors = 10, lifts = 4 } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  const must = (result, what) => {
    if (!result.ok) throw new Error('star ladder trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  for (const column of [20, 50, 80, 110, 125].slice(0, lifts)) {
    const shaft = must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top: floors, column }), 'a lift');
    for (let k = 0; k < 7; k++) must(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }), 'a car');
  }
  let offices = 0;
  for (let floor = 1; floor <= floors; floor++) {
    for (let left = 0; left + BUILDABLE.office.width <= 150; left += BUILDABLE.office.width) {
      if (applyAction(world, { type: 'build', what: 'office', floor, left }).ok) offices++;
    }
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);

  // A one-star tower cannot place one: it is a two-star tool.
  const early = security ? applyAction(world, { type: 'build', what: 'security', floor: -1, left: 60 }) : null;
  const earlyRefusal = early && !early.ok ? early.reason : null;

  const perDay = [];
  let securityCost = null, securityDay = null;
  let twoStarDay = null, threeStarDay = null, peakActivity = 0, daysPastThreshold = 0;
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) scheduler.tick(tower);
    if (security && securityDay === null && tower.starCount >= 2) {
      const placed = applyAction(world, { type: 'build', what: 'security', floor: -1, left: 60 });
      if (placed.ok) { securityCost = placed.cost; securityDay = tower.clock.dayCounter; }
    }
    const status = starGateStatus(tower);
    let let_ = 0;
    for (const o of tower.objects.values()) if (o.family === FAMILY.office && isUnitLet(o)) let_++;
    const row = {
      day: tower.clock.dayCounter, star: tower.starCount, activity: starPopulation(tower), let: let_,
      blockers: status.blockers,
    };
    perDay.push(row);
    if (row.star >= 2 && twoStarDay === null) twoStarDay = row.day;
    if (row.star >= 3 && threeStarDay === null) threeStarDay = row.day;
    peakActivity = Math.max(peakActivity, row.activity);
    if (row.star === 2 && row.activity >= 1000) daysPastThreshold++;
  }
  const last = perDay[perDay.length - 1];
  return {
    security, days, offices, perDay, twoStarDay, threeStarDay, peakActivity, daysPastThreshold,
    finalStar: last.star, finalBlockers: last.blockers, earlyRefusal, securityCost, securityDay,
  };
}

// ---------------------------------------------------------------------------
// Issue #14: the complete star ladder.

/**
 * **The ladder trial.** One tower, one scripted player, the driver's own scheduler, and
 * the whole climb from one star to the Tower rank - with every stand-in named.
 *
 * The player is `starClause`'s reader: each morning it looks at what the ladder says is
 * missing and builds what the palette can make (a security office, two suites, a service
 * lift and enough recycling centers, a clinic, a garage when the tower demands parking).
 * Everything it builds is built through `applyAction`; nothing is written into a gate that
 * a system in this build writes.
 *
 * ## The stand-ins, and why each one is honest
 *
 *  - **`crowd`**: a ledger bucket the script tops up each morning from 3 stars to the next
 *    rung's population. A real 5,000-15,000 needs 800-2,500 offices; the trial's tower has
 *    ~250 (1,500 people) and the point here is the gates, not the head-count. It is
 *    counted exactly like any other bucket - recycling sizes itself to it - so the centers
 *    the script builds are real and the trial still fails if there are too few.
 *  - **`officeServiceOk`**, **`cathedralPlaced`** and the
 *    wedding's **`weddingGuestsArrived`** (issue #17): set by the script the morning after
 *    the rung they belong to opens, on the first weekend morning for the wedding. Each is
 *    the exact flag its issue will write. (**`metroPlaced`** was one until issue #15: the
 *    script now BUILDS the station, on the bottom floor, and the sim latches the gate.)
 *
 * Returns the numbers; the CLI prints them and `test/ladder.test.js` asserts on the same
 * function, so the harness and the test cannot disagree about what was run.
 *
 * @returns {{days:number, perDay:object[], rises:{star:number, day:number, tick:number}[],
 *   finalStar:number, built:object[], refused:object[], hud:string}}
 */
export function ladderTrial({ days = 14, seed = 1, floors = 9 } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  const must = (result, what) => {
    if (!result.ok) throw new Error('ladder trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  for (const column of [20, 50, 80, 110]) {
    const shaft = must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: -1, top: floors + 1, column }), 'a lift');
    for (let k = 0; k < 7; k++) must(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }), 'a car');
  }
  let offices = 0;
  for (let floor = 1; floor <= floors; floor++) {
    // The first twelve tiles are kept clear for the service lift the recycling centers need.
    for (let left = 12; left + BUILDABLE.office.width <= 150; left += BUILDABLE.office.width) {
      if (applyAction(world, { type: 'build', what: 'office', floor, left }).ok) offices++;
    }
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);

  const built = [];
  const refused = [];
  const tryBuild = (action, label) => {
    const result = applyAction(world, action);
    (result.ok ? built : refused).push({ day: tower.clock.dayCounter, what: label, ...(result.ok ? {} : { reason: result.reason }) });
    return result.ok;
  };
  const count = (family) => [...tower.objects.values()].filter((o) => o.family === family).length;
  let serviceLift = false;
  let spaces = 0;
  let metroPlacedDay = null;
  const flagsSetOn = {};

  /** The permanent population the buildings themselves put on the ledger (not the crowd). */
  const realPopulation = () => {
    const saved = tower.populationLedger.crowd ?? 0;
    delete tower.populationLedger.crowd;
    const real = starPopulation(tower);
    if (saved) tower.populationLedger.crowd = saved;
    return real;
  };

  /** The player's morning: read what is missing, build what can be built. */
  const morning = () => {
    const star = tower.starCount;
    const status = starGateStatus(tower);
    for (const d of status.blockerDetails) {
      if (d.kind === 'security' && count(FAMILY.security) < SECURITY_OFFICES_FOR_THREE_STARS) {
        tryBuild({ type: 'build', what: 'security', floor: -6, left: 60 }, 'security');
      }
      if (d.kind === 'hotelSuite') {
        for (let i = count(FAMILY.hotelSuite); i < HOTEL_SUITES_FOR_FOUR_STARS; i++) {
          tryBuild({ type: 'build', what: 'hotelSuite', floor: floors + 1, left: 12 + i * (BUILDABLE.hotelSuite.width + 1) }, 'hotelSuite');
        }
        // A suite is only a suite while somebody turns it round (issue #9), and the VIP (issue #16)
        // will only be given one that is clean: housekeeping beside them, reached by the service lift.
        if (count(FAMILY.housekeeping) === 0 && count(FAMILY.hotelSuite) > 0) {
          tryBuild({ type: 'build', what: 'housekeeping', floor: floors + 1, left: 40 }, 'housekeeping');
        }
      }
    }
    // The clinic: the ladder only names it on a day a worker's trip has failed, so the
    // player answers the notice as well - "Medical Center demanded near Lobby".
    if ((isDemanded(tower, 'medical') || status.blockerDetails.some((d) => d.kind === 'medical')) && count(FAMILY.medical) === 0) {
      tryBuild({ type: 'build', what: 'medical', floor: floors + 1, left: 120 }, 'medical');
    }
    // The metro station (issue #15), once the ladder names it: on the bottom floor, under
    // everything else ("nothing goes beneath"), in the tiles clear of the four lifts.
    if (status.blockerDetails.some((d) => d.kind === 'metroStation') && count(FAMILY.metro) === 0) {
      if (tryBuild({ type: 'build', what: 'metroStation', floor: -10, left: 100 }, 'metro station')) {
        metroPlacedDay ??= tower.clock.dayCounter;
      }
    }
    if (star >= 3) {
      // Recycling: a service lift to the basement, then enough centers for the activity
      // the next rung asks for (the duty tier is activity per working center, < 2,500).
      if (!serviceLift) {
        // From the recycling centers' basement to the suites' floor: the same lift takes the plants'
        // waste out and the housekeepers up.
        serviceLift = tryBuild({ type: 'build_shaft', kind: 'service', bottom: -3, top: floors + 1, column: 4 }, 'service lift');
      }
      const want = Math.min(6, Math.ceil((STAR_THRESHOLDS[star - 1] ?? 15_000) / 2400));
      for (let i = count(FAMILY.recycling) / 2; serviceLift && i < want; i++) {
        tryBuild({ type: 'build', what: 'recyclingCenter', floor: -3, left: 12 + i * 25 }, 'recycling center');
      }
      // The crowd: top up to the rung the tower is climbing, a little over.
      const target = STAR_THRESHOLDS[star - 1] ?? 15_000;
      tower.populationLedger.crowd = Math.max(0, target - realPopulation() + 60);
      // Parking: the tower asks, the script answers - a ramp, then spaces 8 at a time.
      if (isDemanded(tower, 'officeParking') || isDemanded(tower, 'suiteParking')) {
        if (spaces === 0) tryBuild({ type: 'build', what: 'parkingRamp', floor: -1, left: 70 }, 'parking ramp');
        for (let k = 0; k < 8 && spaces < 35; k++, spaces++) {
          const left = spaces < 19 ? 71 + 4 * spaces : 66 - 4 * (spaces - 19);
          tryBuild({ type: 'build', what: 'parkingSpace', floor: -1, left }, 'parking space');
        }
      }
    }
    // The stand-ins, the morning after the rung they belong to opens.
    const gates = starGatesOf(tower);
    const set = (flag, value = true) => {
      if (gates[flag] === value) return;
      gates[flag] = value;
      flagsSetOn[flag] = tower.clock.dayCounter;
    };
    // The VIP is no stand-in any more (issue #16): a real visitor books one of the two suites the
    // script built, rides the real lifts, and `sim/events.js` writes the gate when he is pleased.
    if (star === 3 && gates.suitePlaced) set('officeServiceOk');
    if (star === 5) set('cathedralPlaced');
  };

  const perDay = [];
  const rises = [];
  let seenRise = 0;
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      scheduler.tick(tower);
      const { dayTick, calendarPhase } = tower.clock;
      if (dayTick === 30) morning();
      // The wedding: 40 guests at the cathedral, a weekend morning, before tick 800.
      if (dayTick === 300 && calendarPhase && tower.starCount === 5 && tower.gates.cathedralPlaced) {
        tower.gates.weddingGuestsArrived = WEDDING_GUESTS;
        flagsSetOn.weddingGuestsArrived ??= tower.clock.dayCounter;
      }
      for (const n of noticesAfter(tower, seenRise)) {
        seenRise = n.id;
        if (n.kind === 'starRise') rises.push({ day: n.day, tick: n.tick, text: n.text });
      }
    }
    const status = starGateStatus(tower);
    perDay.push({
      day: tower.clock.dayCounter, star: tower.starCount, population: status.activity,
      real: realPopulation(), hud: starClause(status, (kind) => Object.hasOwn(BUILDABLE, kind)),
      recycling: tower.gates.recyclingAdequate, medical: tower.gates.medicalServiceOk,
      demands: activeDemands(tower).map((x) => x.text),
    });
  }
  const last = perDay[perDay.length - 1];
  return { days, offices, perDay, rises, finalStar: last.star, built, refused, flagsSetOn, metroPlacedDay, hud: last.hud, world };
}

// ---------------------------------------------------------------------------
// Issue #15: the metro station.

/**
 * **The metro gate trial.** The `4 -> 5` rung with every other requirement met, a weekday
 * evening, 10,000 people: first WITHOUT a metro station (the star holds, and the bar says
 * what is missing), then with one placed through `applyAction` (the star rises on the
 * next tick). Nothing is written into the metro gate - the only way it moves is the
 * placement - and the other gates (recycling, medical service, the day's route check) are
 * the ones the ladder test sets by hand for the same reason: they are not this issue's.
 *
 * @returns {{before:{star:number, blockers:string[], ready:boolean, flag:boolean},
 *   placed:{ok:boolean, cost:number, reason?:string}, after:{star:number, flag:boolean},
 *   ticksHeld:number}}
 */
export function metroGateTrial({ seed = 1, heldTicks = 120 } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  const { scheduler } = makeDriver(world);
  tower.starCount = 4;
  tower.populationLedger.office = 10_000;
  Object.assign(starGatesOf(tower), {
    officePlaced: true, securityPlaced: true, suitePlaced: true, recyclingAdequate: true,
    medicalServiceOk: true, routesViable: true,
  });
  // 5 PM on a weekday - the window the rung needs (A62) - starting the tick before 1700.
  tower.clock.dayCounter = 0;
  tower.clock.dayTick = 1699;
  const held = [];
  for (let i = 0; i < heldTicks; i++) {
    scheduler.tick(tower);
    held.push(tower.starCount);
  }
  const status = starGateStatus(tower);
  const before = {
    star: tower.starCount, blockers: status.blockers, ready: status.ready, flag: starGatesOf(tower).metroPlaced,
  };
  const cash = tower.cash;
  const placed = applyAction(world, { type: 'build', what: 'metroStation', floor: -6, left: 60 });
  const cost = cash - tower.cash;
  scheduler.tick(tower);
  return {
    before, placed: { ok: placed.ok, cost, reason: placed.reason },
    after: { star: tower.starCount, flag: starGatesOf(tower).metroPlaced },
    ticksHeld: held.filter((s) => s === 4).length,
  };
}

/**
 * **The commuter trial.** One tower, three ways: no metro station, a station with a lift
 * to its platform, and a station no lift reaches. Eight floors of offices behind four
 * lifts, two fast foods on the first two basements and two on the first floor, four stars
 * (set directly: the ladder to it is `ladderTrial`'s business), the driver's own scheduler.
 *
 * Counts what the issue promised, from the sim's own state and the router's own events:
 * commuters (the workers on the train residue), **boardings at the platform** (a car
 * picking somebody up there - the only way anyone leaves that floor), where the commuters
 * and the other workers ATE (a commuter eats only underground, so an above-ground
 * count of anything but zero is a bug), the offices let, and the median stress.
 *
 * @returns {{label:string, metro:boolean, served:boolean, commuters:number, boardingsAtPlatform:number,
 *   lunches:{commuterUnderground:number, commuterAbove:number, otherUnderground:number, otherAbove:number},
 *   let:number, offices:number, population:number, stress:number|null}}
 */
export function metroCommuterTrial({ metro = true, lift = true, days = 5, seed = 1, floors = 9 } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 4;
  const must = (result, what) => {
    if (!result.ok) throw new Error('metro trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  // The lifts stop at B4 when they are to reach the platform (the deepest a shaft may go
  // under a station whose top floor is B3), and at B2 - the deepest outlet - when they are
  // not. The control, with no station, has the shallow lifts too: it is the same tower.
  const bottom = metro && lift ? -4 : -2;
  const columns = [20, 50, 80, 140];
  for (const column of columns) {
    const shaft = must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom, top: floors + 1, column }), 'a lift');
    for (let k = 0; k < 7; k++) must(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }), 'a car');
  }
  // Fast food: two underground, two on the first floor.
  for (const [floor, left] of [[-1, 30], [-2, 55], [1, 30], [1, 55]]) {
    must(applyAction(world, { type: 'build', what: 'fastFood', floor, left }), 'a fast food');
  }
  let offices = 0;
  for (let floor = 2; floor <= floors; floor++) {
    for (let left = 0; left + BUILDABLE.office.width <= 150; left += BUILDABLE.office.width) {
      const right = left + BUILDABLE.office.width - 1;
      if (columns.some((c) => left <= c + 5 && right >= c - 2)) continue;
      if (applyAction(world, { type: 'build', what: 'office', floor, left }).ok) offices++;
    }
  }
  if (metro) must(applyAction(world, { type: 'build', what: 'metroStation', floor: -5, left: 100 }), 'the metro station');
  rebuildRouteTables(tower);

  const platform = metroPlatformFloor(tower);
  let boardingsAtPlatform = 0;
  const { scheduler } = makeDriver(world, {
    observe: {
      delay: (kind, delay) => {
        if (kind === 'boarding' && platform !== null && delay.sourceFloor === platform) boardingsAtPlatform++;
      },
    },
  });
  const lunches = { commuterUnderground: 0, commuterAbove: 0, otherUnderground: 0, otherAbove: 0 };
  const counted = new Set();
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      scheduler.tick(tower);
      if (t % 4) continue;
      for (const actor of tower.actors) {
        if (!actor || actor.family !== FAMILY.office || (actor.state & 0x3f) !== OFFICE_STATE.atLunch) continue;
        const office = tower.objects.get(actor.objectId);
        const venue = tower.objects.get(actor.venueObjectId);
        if (!office || !venue) continue;
        const key = actor.id + ':' + tower.clock.dayCounter;
        if (counted.has(key)) continue;
        counted.add(key);
        const who = metro && officeWorkerCommutes(tower, actor, office) ? 'commuter' : 'other';
        lunches[who + (venue.floor < 0 ? 'Underground' : 'Above')]++;
      }
    }
  }
  const r = readout(world);
  return {
    label: !metro ? 'no metro station' : lift ? 'station, a lift reaches its platform' : 'station, NO lift reaches it',
    metro, served: metroServed(tower), commuters: metro ? metroCommuterCount(tower) : 0,
    boardingsAtPlatform, lunches, let: r.let, offices, population: population(tower), stress: r.stress,
  };
}

// ---------------------------------------------------------------------------
// Issue #13: the tower demands things back.

/**
 * A three-star tower of offices behind real lifts, for the three service trials.
 *
 * Four standard lifts reach the first basement (so a worker can ride from a garage as
 * well as from the lobby) and a service elevator runs through the three basements
 * (so a recycling center can have its stop). Offices fill every free six tiles of the
 * floors above the ground, clear of the shafts. Three stars is set directly: the
 * ladder to it is `starLadderTrial`'s business, and what is measured here is what the
 * tower asks for once it is there.
 */
export function servicesTower({ floors = 10, seed = 1, service = true } = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 3;
  const must = (result, what) => {
    if (!result.ok) throw new Error('services trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  const columns = [20, 50, 80, 110];
  for (const column of columns) {
    const shaft = must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: -1, top: floors + 1, column }), 'a lift');
    for (let k = 0; k < 7; k++) must(applyAction(world, { type: 'add_car', carrierId: shaft.carrier.id }), 'a car');
  }
  if (service) {
    must(applyAction(world, { type: 'build_shaft', kind: 'service', bottom: -3, top: 2, column: 132 }), 'the service elevator');
  }
  let offices = 0;
  for (let floor = 1; floor <= floors; floor++) {
    for (let left = 0; left + BUILDABLE.office.width <= 150; left += BUILDABLE.office.width) {
      const right = left + BUILDABLE.office.width - 1;
      if (columns.some((c) => left <= c + 5 && right >= c - 2)) continue;
      if (service && left <= 136 && right >= 130) continue;
      if (applyAction(world, { type: 'build', what: 'office', floor, left }).ok) offices++;
    }
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);
  return { world, tower, scheduler, offices, must };
}

/**
 * **The recycling trial.** Issue #13's proof of the recycling gate: the flag the
 * `3 -> 4` and `4 -> 5` rungs read, written by the three daily checks and read back
 * at the tick after each, with the star ladder's own account of what is still
 * missing.
 *
 * `centers` stacks go in the basement beside one another, with or without the
 * service elevator that has to stop at them. Nothing is written into the flag or
 * the ledger: the activity is the offices' own, and the answer is the sim's.
 */
export function recyclingTrial({ centers = 0, service = true, floors = 10, days = 4, seed = 1 } = {}) {
  const { world, tower, scheduler, offices, must } = servicesTower({ floors, seed, service });
  for (let i = 0; i < centers; i++) {
    must(applyAction(world, { type: 'build', what: 'recyclingCenter', floor: -3, left: 40 + i * 25 }), 'a recycling center');
  }
  const perDay = [];
  const checks = [RECYCLING_MIDDAY_TICK, RECYCLING_AFTERNOON_TICK, RECYCLING_FINAL_TICK];
  // A new game starts at tick 2533, so a 2,600-tick step begins mid-night and puts the
  // 2566 check at the START of the row. Begin each day at its own tick 0 instead, so a
  // row reads 1600, 2000, 2566 in the order the day runs them.
  while (tower.clock.dayTick !== 0) scheduler.tick(tower);
  for (let d = 0; d < days; d++) {
    const row = { day: tower.clock.dayCounter, flags: {}, activityAt: {} };
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      scheduler.tick(tower);
      if (checks.includes(tower.clock.dayTick)) {
        row.flags[tower.clock.dayTick] = tower.gates.recyclingAdequate;
        row.activityAt[tower.clock.dayTick] = towerActivity(tower);
      }
    }
    row.demands = activeDemands(tower).map((x) => x.text);
    perDay.push(row);
  }
  const status = starGateStatus(tower);
  const working = workingRecyclingCenters(tower).length;
  return {
    centers, service, offices, perDay, working, placed: recyclingCenters(tower).length,
    // What the last day's closing check saw, which is what decided its flag.
    activity: perDay[perDay.length - 1].activityAt[RECYCLING_FINAL_TICK],
    perCenter: working ? Math.trunc(perDay[perDay.length - 1].activityAt[RECYCLING_FINAL_TICK] / working) : null,
    blockers: status.blockers, recyclingBlocked: status.blockers.includes('a recycling centre keeping up with the tower'),
    adequate: tower.gates.recyclingAdequate,
  };
}

/**
 * **The medical trial.** What the 1-in-10 does to a tower with and without a clinic:
 * workers who set out for one (counted off the state machine, not guessed), the
 * deepest queue, the daily flag the ladder reads, and the notices.
 */
export function medicalTrial({ clinics = 1, days = 5, seed = 1 } = {}) {
  const { world, tower, scheduler, offices, must } = servicesTower({ floors: 9, seed });
  for (let i = 0; i < clinics; i++) {
    must(applyAction(world, { type: 'build', what: 'medical', floor: 10, left: i ? 70 : 120 }), 'a medical center');
  }
  const workers = tower.actors.filter((a) => a.family === FAMILY.office);
  const was = new Map();
  const perDay = [];
  for (let d = 0; d < days; d++) {
    let visits = 0, deepest = 0, setOff = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      scheduler.tick(tower);
      for (const actor of workers) {
        const base = actor.state & 0x3f;
        const before = was.get(actor.id) ?? 0;
        if (base === OFFICE_STATE.medicalOut && before !== OFFICE_STATE.medicalOut) setOff++;
        if (base === OFFICE_STATE.atMedical && before !== OFFICE_STATE.atMedical) visits++;
        was.set(actor.id, base);
      }
      let queued = 0;
      for (const c of medicalCenters(tower)) queued += c.medical.queue.length;
      if (queued > deepest) deepest = queued;
    }
    perDay.push({
      day: tower.clock.dayCounter, setOff, visits, deepest,
      flag: tower.gates.medicalServiceOk, demands: activeDemands(tower).map((x) => x.text),
    });
  }
  return {
    clinics, offices, workers: workers.length, perDay,
    flag: tower.gates.medicalServiceOk,
    notices: demandsOf(tower).notices.filter((n) => n.kind === 'medical').length,
    blocked: starGateStatus(tower).blockers.includes('a medical center for the office workers'),
  };
}

/**
 * **The parking trial.** Drivers are the office workers with `(floor + slot) % 4 == 1`;
 * they take a space a ramp serves, route from the garage floor and back, and when there
 * is none the tower says *"Office workers demand Parking"*. `buildOnDay` lets the garage
 * go up part-way, which is the demand being CLEARED by building: the notice fires, then
 * the ramp and the spaces go in, and the line goes quiet.
 *
 * `ramp: false` is the control: spaces nobody can reach are drawn blocked and answer
 * nothing, so the demand stays.
 */
export function parkingTrial({ spaces = 0, ramp = true, buildOnDay = 0, days = 6, seed = 1, floors = 9 } = {}) {
  const { world, tower, scheduler, offices, must } = servicesTower({ floors, seed });
  const workers = tower.actors.filter((a) => a.family === FAMILY.office);
  const drivers = workers.filter((a) => {
    const office = tower.objects.get(a.objectId);
    return (office.floor + a.occupantIndex) % 4 === 1;
  }).length;
  const garage = () => {
    if (ramp) must(applyAction(world, { type: 'build', what: 'parkingRamp', floor: -1, left: 70 }), 'the ramp');
    for (let i = 0; i < spaces; i++) {
      // Right of the ramp first, then left of it: one unbroken row the ramp's walk can follow.
      const left = i < 19 ? 71 + 4 * i : 66 - 4 * (i - 19);
      must(applyAction(world, { type: 'build', what: 'parkingSpace', floor: -1, left }), 'space ' + i);
    }
  };
  let built = false;
  const perDay = [];
  for (let d = 0; d < days; d++) {
    if (!built && d >= buildOnDay) { garage(); built = true; }
    let peak = 0, parkedToday = 0;
    const seen = new Set();
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      scheduler.tick(tower);
      const cars = carsParked(tower);
      if (cars > peak) peak = cars;
      if (t % 40 === 0) for (const a of workers) if (a.parkedAt != null) seen.add(a.id);
    }
    parkedToday = seen.size;
    perDay.push({
      day: tower.clock.dayCounter, built, peakCars: peak, drivers: parkedToday,
      demanded: activeDemands(tower).some((x) => x.kind === 'officeParking'),
    });
  }
  return {
    spaces, ramp, buildOnDay, offices, driversInTower: drivers, perDay,
    usable: usableSpaces(tower).length,
    notices: demandsOf(tower).notices.filter((n) => n.kind === 'officeParking').map((n) => n.text),
  };
}

/**
 * **The commercial trial.** Issue #10's proof: what a restaurant or a shop does
 * to the money, measured through the driver's own composition and nothing else.
 *
 * Nothing is scripted: no visitor count is written, no shop is opened by hand.
 * A venue's own 48 customers decide when to go (the gate's dice), the router
 * decides whether they can, and the closure sweep prices the day. The numbers
 * read are the ones the sim produced:
 *
 *  - **restaurant / fastFood** - each day's visitors are read off the venue's
 *    record the tick before its closure sweep (2200 for a restaurant, 2000 for a
 *    fast food), and the payout is the CASH that tick moved, not a lookup of the
 *    payout table (`expected` is the lookup, kept beside it so a disagreement is
 *    visible);
 *  - **retail** - the rent is every positive step of the `retail` income bucket
 *    (the 3-day rollover clears it, which is a negative step and ignored), and
 *    the `+10` is read off the population ledger.
 *
 * `hotelRooms` single rooms on a floor of their own feed a restaurant (a hotel
 * guest's evening trip is to the restaurant bucket, `sim/hotel.js`); `lift:
 * false` leaves the venue's floor with no way up, which is the control.
 *
 * Returns the numbers; the CLI below prints them and `test/commercial.test.js`
 * asserts on the same function, so the harness and the test cannot disagree about
 * what was run.
 */
export function commercialTrial({
  kind, days = 9, seed = 1, lift = true, hotelRooms = 0, rentTier = 1,
} = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 3;
  const must = (result, what) => {
    if (!result.ok) throw new Error('commercial trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  const VENUE_FLOOR = 1;
  const HOTEL_FLOOR = 2;
  const ROOMS_PER_FLOOR = 20;
  const topFloor = HOTEL_FLOOR + Math.ceil(hotelRooms / ROOMS_PER_FLOOR) - 1;
  if (lift) {
    must(applyAction(world, {
      type: 'build_shaft', kind: 'standard', bottom: 0, top: hotelRooms ? topFloor : VENUE_FLOOR, column: 40,
    }), 'the lift');
  }
  if (hotelRooms) {
    // A hotel left to its own devices is lost to cockroaches in three days
    // (issue #9), and a lost room has no guest to eat. So the player who builds
    // rooms to feed a restaurant has read the manual: a service elevator and a
    // facility for every dozen rooms.
    must(applyAction(world, {
      type: 'build_shaft', kind: 'service', bottom: 0, top: topFloor, column: 132,
    }), 'the service elevator');
  }
  const venue = must(applyAction(world, { type: 'build', what: kind, floor: VENUE_FLOOR, left: 60 }), kind).object;
  if (rentTier !== 1) must(applyAction(world, { type: 'set_rent', objectId: venue.id, tier: rentTier }), 'the rent tier');
  for (let i = 0; i < hotelRooms; i++) {
    must(applyAction(world, {
      type: 'build', what: 'hotelSingle',
      floor: HOTEL_FLOOR + Math.floor(i / ROOMS_PER_FLOOR), left: 46 + (i % ROOMS_PER_FLOOR) * 4,
    }), 'room ' + i);
  }
  if (hotelRooms) {
    for (let k = 0; k < Math.ceil(hotelRooms / 12); k++) {
      must(applyAction(world, { type: 'build', what: 'housekeeping', floor: 1, left: 90 + k * 15 }), 'housekeeping ' + k);
    }
  }
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);

  const closeTick = kind === 'restaurant' ? RESTAURANT_CLOSURE_TICK : CLOSURE_TICK;
  const perDay = [];
  let visitsBefore = 0, cashBefore = 0, retailIncome = 0, lastRetailBucket = 0, openedOnDay = null;
  let peakRetailPopulation = 0;
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      if (tower.clock.dayTick === closeTick - 1) {
        visitsBefore = venueOf(venue).acquireCount;
        cashBefore = tower.cash;
      }
      scheduler.tick(tower);
      if (tower.clock.dayTick === closeTick && kind !== 'retail') {
        perDay.push({
          day: tower.clock.dayCounter, visitors: visitsBefore, closure: tower.cash - cashBefore,
          expected: closurePayout(venue.family, visitsBefore), capacity: venueOf(venue).activeCapacityLimit,
        });
      }
      // The 3-day rollover clears the bucket and the same tick's activation pays
      // into it, so a bucket that ends where it started is not "no income" - and
      // is exactly what a tier-2 shop does (the same $10,000 in, the same out).
      // The rollover is a tick, not a value: checkpoint 2533 on a cashflow day.
      if (tower.clock.dayTick === LEDGER_CHECKPOINT_TICK && isCashflowDay(tower.clock.dayCounter)) {
        lastRetailBucket = 0;
      }
      const bucket = tower.incomeLedger?.retail ?? 0;
      if (bucket > lastRetailBucket) retailIncome += bucket - lastRetailBucket;
      lastRetailBucket = bucket;
      peakRetailPopulation = Math.max(peakRetailPopulation, tower.populationLedger?.retail ?? 0);
      if (kind === 'retail' && openedOnDay === null && venueOf(venue).availability !== 0xff) {
        openedOnDay = tower.clock.dayCounter;
      }
    }
  }
  return {
    kind, days, lift, hotelRooms, rentTier, perDay,
    closureTotal: perDay.reduce((sum, p) => sum + p.closure, 0),
    retailIncome, openedOnDay,
    open: kind === 'retail' ? venueOf(venue).availability !== 0xff : null,
    retailPopulation: tower.populationLedger?.retail ?? 0,
    peakRetailPopulation,
    hudPopulation: population(tower),
    world, venue,
  };
}

/**
 * **The entertainment trial** (issue #11): one theater or party hall on F1-F2, a
 * lift, nothing scripted, and what each day's show drew and was PAID.
 *
 * `film` picks what the theater is showing: `'new'` (a new release, fresh: 60 + 60
 * seats), `'classic'` (a fresh classic: 40 + 40) or `'stale'` (a classic nine days
 * old: 20 + 20). `hotelRooms` single rooms stand above it for a party hall's
 * condition; `shops` are `{ what, floor }` venues built at tile 100 to watch the
 * spillover; `startDay` puts the calendar on a chosen day (59 is a bomb day).
 * `lift: false` is the control: the venue's floors cannot be reached.
 *
 * The money is read as the CASH that moved across the settling tick (1900 for a
 * theater, 1600 for a hall), so it is what the game paid, not what the record
 * says it meant to. Returns the numbers; the CLI below prints them and
 * `test/entertainment.test.js` asserts on the same function.
 */
export function entertainmentTrial({
  kind = 'theater', days = 6, seed = 1, lift = true, film = 'new', hotelRooms = 0, startDay = null, shops = [],
} = {}) {
  const world = newTowerWorld({ seed, cash: 90_000_000 });
  const { tower } = world;
  tower.starCount = 3;
  const must = (result, what) => {
    if (!result.ok) throw new Error('entertainment trial: ' + what + ' would not build: ' + result.reason);
    return result;
  };
  const ROOM_FLOOR = 3;
  const roomTop = hotelRooms ? ROOM_FLOOR + Math.ceil(hotelRooms / 12) - 1 : 0;
  const top = Math.max(3, roomTop, ...shops.map((s) => s.floor));
  if (lift) must(applyAction(world, { type: 'build_shaft', kind: 'standard', bottom: 0, top, column: 40 }), 'the lift');
  const venue = must(applyAction(world, { type: 'build', what: kind, floor: 1, left: 60 }), kind).object;
  const record = venue.venue;
  if (kind === 'theater') {
    const preset = { new: [9, 0], classic: [3, 0], stale: [3, 20] }[film];
    if (!preset) throw new Error('entertainment trial: no film called "' + film + '"');
    [record.selector, record.age] = preset;
  }
  for (let i = 0; i < hotelRooms; i++) {
    must(applyAction(world, {
      type: 'build', what: 'hotelSingle', floor: ROOM_FLOOR + Math.floor(i / 12), left: 100 + (i % 12) * 4,
    }), 'room ' + i);
  }
  const shopObjects = shops.map((s) => must(applyAction(world, { type: 'build', what: s.what, floor: s.floor, left: 100 }), s.what).object);
  rebuildRouteTables(tower);
  const { scheduler } = makeDriver(world);
  if (startDay !== null) {
    tower.clock.dayCounter = startDay; tower.clock.dayTick = 0;
    // Since issue #16 a bomb or fire day HAS a bomb or a fire. This trial measures the payout
    // rule on those days, so the event is held off the way the spec allows (a bomb comes at 2-4
    // stars; a fire not during a cathedral evaluation) - `eventsTrial` is the one that lets it burn.
    tower.starCount = 5;
    starGatesOf(tower).cathedralPlaced = true;
  }

  const settleTick = kind === 'theater' ? LOWER_ADVANCE_TICK : PARTY_ADVANCE_TICK;
  const spill = new Map(shopObjects.map((s) => [s.id, new Set()]));
  const perDay = [];
  let before = tower.cash;
  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    if (tower.clock.dayTick === settleTick - 1) before = tower.cash;
    scheduler.tick(tower);
    if (tower.clock.dayTick >= 1500 && tower.clock.dayTick < 2100 && spill.size) {
      for (const a of tower.actors) {
        if (a.family !== venue.family || (a.state & 0x3f) !== ENT_STATE.dwelling || !spill.has(a.venueObjectId)) continue;
        spill.get(a.venueObjectId).add(a.id);
      }
    }
    if (tower.clock.dayTick === settleTick) {
      perDay.push({ day: tower.clock.dayCounter, attendance: record.lastAttendance, pays: tower.cash - before });
    }
  }
  return {
    kind, days, film, hotelRooms, lift, perDay,
    attendance: perDay.map((p) => p.attendance), total: perDay.reduce((sum, p) => sum + p.pays, 0),
    spill: shopObjects.map((s, i) => ({
      what: shops[i].what, floor: shops[i].floor, customers: spill.get(s.id).size, visits: venueOf(s).acquireCount,
    })),
    world, venue,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('playtest.js')) {
  if (process.argv.includes('--entertainment')) {
    // `node harness/playtest.js --entertainment [days]` - the issue #11 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 8);
    const dollars = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
    const row = (r) => r.perDay.map((p) => p.attendance + '=' + dollars(p.pays)).join('  ');
    console.log('entertainment trial: one venue on F1-F2, a lift, ' + trialDays + ' days, nothing scripted.'
      + " Each cell is the day's attendance = the CASH that moved when the venue was paid.\n");
    console.log('MOVIE THEATER, by film (paid on attendance: <40 $0 / 40-79 $2,000 / 80-99 $10,000 / 100+ $15,000)');
    for (const [label, options] of [
      ['new release, fresh  ', { film: 'new' }],
      ['classic, fresh      ', { film: 'classic' }],
      ['classic, 9 days old ', { film: 'stale' }],
      ['new release, NO lift', { film: 'new', lift: false }],
    ]) {
      const r = entertainmentTrial({ ...options, days: trialDays });
      console.log('  ' + label + '  net ' + dollars(r.total).padStart(9) + '   ' + row(r));
    }
    console.log('\nPARTY HALL (50 guests, $20,000 a party; needs hotel rooms in the tower)');
    for (const [label, options] of [
      ['0 hotel rooms    ', { hotelRooms: 0 }],
      ['1 hotel room     ', { hotelRooms: 1 }],
      ['12 hotel rooms   ', { hotelRooms: 12 }],
      ['12 rooms, NO lift', { hotelRooms: 12, lift: false }],
    ]) {
      const r = entertainmentTrial({ kind: 'partyHall', ...options, days: trialDays });
      console.log('  ' + label + '  net ' + dollars(r.total).padStart(9) + '   ' + row(r));
    }
    console.log('\nBOMB / FIRE DAYS (day % 60 == 59 or day % 84 == 83): the audience comes and is not paid');
    for (const startDay of [58, 59, 83]) {
      const r = entertainmentTrial({ film: 'new', days: 3, startDay });
      console.log('  starting on day ' + String(startDay).padStart(2) + '  '
        + r.perDay.map((p) => 'day ' + p.day + ': ' + p.attendance + '=' + dollars(p.pays)).join('   '));
    }
    console.log('\nSHOP SPILLOVER (shops within five floors of the theater): theater-goers = distinct audience members who shopped');
    const sp = entertainmentTrial({
      film: 'new', days: 4,
      shops: [{ what: 'fastFood', floor: 3 }, { what: 'fastFood', floor: 6 }, { what: 'fastFood', floor: 11 }],
    });
    for (const s of sp.spill) {
      console.log('  fast food on F' + String(s.floor).padStart(2) + '  theater-goers ' + String(s.customers).padStart(3)
        + '   venue visits ' + s.visits + (s.floor > 7 ? '   (out of range)' : ''));
    }
    process.exit(0);
  }
  if (process.argv.includes('--commercial')) {
    // `node harness/playtest.js --commercial [days]` - the issue #10 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 12);
    const dollars = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
    console.log('commercial trial: one venue on F1, a lift, ' + trialDays + ' days, nothing scripted.'
      + ' dN: visitors -> what the closing sweep PAID.\n');
    const cases = [
      ['restaurant, lift          ', { kind: 'restaurant' }],
      ['restaurant, NO lift       ', { kind: 'restaurant', lift: false }],
      ['restaurant + 12 hotel rms ', { kind: 'restaurant', hotelRooms: 12 }],
      ['fast food, lift           ', { kind: 'fastFood' }],
    ];
    for (const [label, options] of cases) {
      const r = commercialTrial({ ...options, days: trialDays });
      const wins = r.perDay.filter((p) => p.closure > 0).length;
      console.log(label + ' net ' + dollars(r.closureTotal).padStart(9) + '  (' + wins + ' paying day(s) of '
        + r.perDay.length + ')');
      console.log('   ' + r.perDay.map((p) => 'd' + p.day + ':' + p.visitors + 'v ' + dollars(p.closure)).join('  '));
    }
    console.log('\nretail shop: rent = every payment into the retail bucket; people = the +10 on the ledger.\n');
    for (const [label, options] of [
      ['shop, tier 0 ($20,000)', { kind: 'retail', rentTier: 0 }],
      ['shop, tier 1 ($15,000)', { kind: 'retail', rentTier: 1 }],
      ['shop, tier 2 ($10,000)', { kind: 'retail', rentTier: 2 }],
      ['shop, tier 3 ($4,000) ', { kind: 'retail', rentTier: 3 }],
      ['shop, NO lift         ', { kind: 'retail', lift: false }],
    ]) {
      const r = commercialTrial({ ...options, days: trialDays });
      console.log(label + '  rent ' + dollars(r.retailIncome).padStart(9) + '  ' + (r.open
        ? 'opened day ' + r.openedOnDay + ', +' + r.retailPopulation + ' people'
        : 'never opened, ' + r.retailPopulation + ' people'));
    }
    process.exit(0);
  }
  if (process.argv.includes('--services')) {
    // `node harness/playtest.js --services [days]` - the issue #13 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
    const yn = (v) => (v === undefined ? ' - ' : v ? 'yes' : 'NO ');
    console.log('RECYCLING. 3 stars, offices behind 4 real lifts. The gate flag the 3->4 and 4->5 rungs read, sampled the tick'
      + ' after each daily check (1600 always clears it; 2000 needs <1,000 activity per center; 2566 needs <2,500).\n');
    for (const [label, options] of [
      ['no center                     ', { centers: 0, floors: 10 }],
      ['1 center, NO service lift     ', { centers: 1, service: false, floors: 10 }],
      ['1 center + service lift       ', { centers: 1, floors: 10 }],
      ['28 floors, 1 center           ', { centers: 1, floors: 28 }],
      ['28 floors, 2 centers          ', { centers: 2, floors: 28 }],
    ]) {
      const r = recyclingTrial({ ...options, days: Math.max(trialDays, 8) });
      const last = r.perDay[r.perDay.length - 1];
      console.log(label + ' activity ' + String(r.activity).padStart(5) + ', ' + r.working + ' working -> '
        + (r.perCenter === null ? 'n/a' : String(r.perCenter).padStart(5) + ' per center')
        + '   1600:' + yn(last.flags[1600]) + ' 2000:' + yn(last.flags[2000]) + ' 2566:' + yn(last.flags[2566])
        + '   recycling still blocks 4 stars: ' + (r.recyclingBlocked ? 'YES' : 'no'));
      const said = last.demands.filter((x) => /Recycling/.test(x));
      if (said.length) console.log('    says: ' + said.join(' | '));
      console.log('    the ladder still waits on: ' + r.blockers.join(' | '));
    }
    console.log('\nMEDICAL. 3 stars, ' + trialDays + ' days. set off = workers who left the office for the clinic, visits = '
      + 'arrived in its queue, deepest = most waiting at once.\n');
    for (const clinics of [0, 1]) {
      const r = medicalTrial({ clinics, days: trialDays });
      console.log(clinics ? 'WITH a medical center' : 'WITHOUT a medical center', '(' + r.workers + ' workers):  daily flag '
        + (r.flag ? 'true' : 'FALSE') + ', ' + r.notices + ' notice(s), blocks 4 stars: ' + (r.blocked ? 'YES' : 'no'));
      for (const p of r.perDay) {
        console.log('   day ' + String(p.day).padStart(2) + '  set off ' + String(p.setOff).padStart(3) + '  visits '
          + String(p.visits).padStart(3) + '  deepest ' + String(p.deepest).padStart(3) + '  flag '
          + (p.flag ? 'true ' : 'FALSE') + '  ' + (p.demands.filter((x) => /Medical/.test(x)).join('') || '-'));
      }
    }
    console.log('\nPARKING. 3 stars, ' + trialDays + ' days. A quarter of the office workers drive.\n');
    for (const [label, options] of [
      ['no garage                       ', { spaces: 0, ramp: false }],
      ['8 spaces, NO ramp (blocked)     ', { spaces: 8, ramp: false }],
      ['ramp + 8 spaces from day 0      ', { spaces: 8, ramp: true }],
      ['ramp + 8 spaces built on day 3  ', { spaces: 8, ramp: true, buildOnDay: 3 }],
      ['ramp + 32 spaces from day 0     ', { spaces: 32, ramp: true }],
      ['3 floors, ramp + 32, on day 3   ', { spaces: 32, ramp: true, buildOnDay: 3, floors: 3 }],
    ]) {
      const r = parkingTrial({ ...options, days: trialDays + 1 });
      console.log(label + ' drivers in tower ' + r.driversInTower + ', usable spaces ' + r.usable);
      console.log('   ' + r.perDay.map((p) => 'd' + p.day + ':' + p.peakCars + 'cars' + (p.demanded ? ' DEMAND' : '')).join('  '));
    }
    process.exit(0);
  }
  if (process.argv.includes('--stars')) {
    // `node harness/playtest.js --stars [days]` - the issue #12 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 8);
    const dollars = (n) => '$' + n.toLocaleString('en-US');
    console.log('star ladder trial: 250 offices on 10 floors, 4 lifts x 8 cars, 90M cash, ' + trialDays
      + ' days. The gate for 3 stars is 1,000 activity AND a security office (GAME-STATE.md).' + String.fromCharCode(10));
    for (const security of [false, true]) {
      const r = starLadderTrial({ security, days: trialDays });
      console.log((security ? 'WITH a security office' : 'WITHOUT security      ') + '  ->  '
        + (r.threeStarDay === null
          ? 'STALLS at ' + r.finalStar + ' stars'
          : 'reaches 3 stars on day ' + r.threeStarDay) + '  (2 stars on day ' + r.twoStarDay + ', peak activity '
        + r.peakActivity + ', ' + r.daysPastThreshold + ' day(s) at 2 stars with activity >= 1,000)');
      if (r.earlyRefusal) console.log('   at one star:   "' + r.earlyRefusal + '"');
      if (r.securityDay !== null) console.log('   built on day ' + r.securityDay + ' for ' + dollars(r.securityCost) + ' ($100,000 + 16 floor tiles)');
      console.log('   blocker at the end: ' + (r.finalBlockers.length ? r.finalBlockers.join(' | ') : '-'));
      console.log('   day  star  activity  let/' + r.offices + '  blockers');
      for (const row of r.perDay) {
        console.log('   ' + String(row.day).padStart(3) + String(row.star).padStart(6) + String(row.activity).padStart(10)
          + String(row.let).padStart(9) + '  ' + (row.blockers.join(' | ') || '-'));
      }
      console.log('');
    }
    process.exit(0);
  }
  if (process.argv.includes('--metro')) {
    // `node harness/playtest.js --metro [days]` - the issue #15 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
    const g = metroGateTrial();
    console.log('metro gate trial: four stars, 10,000 people, 5 PM on a weekday, every other 4 -> 5 gate met.\n');
    console.log('  WITHOUT a metro station (' + g.ticksHeld + ' ticks held): ' + g.before.star + ' stars, ready=' + g.before.ready
      + ', gate=' + g.before.flag + ', blockers: ' + g.before.blockers.join(' | '));
    console.log('  placed through applyAction: ' + (g.placed.ok ? 'ok, $' + g.placed.cost.toLocaleString('en-US') : 'REFUSED: ' + g.placed.reason));
    console.log('  one tick later:            ' + g.after.star + ' stars, gate=' + g.after.flag + '\n');

    console.log('metro commuter trial: ' + trialDays + ' days, 8 floors of offices, 4 lifts x 8 cars, two fast foods underground'
      + ' (B1, B2) and two on F1.\n');
    console.log('variant                                  commuters  boardings@platform  commuter lunch (under/above)  others (under/above)  let        stress');
    for (const variant of [{ metro: false }, { metro: true, lift: true }, { metro: true, lift: false }]) {
      const r = metroCommuterTrial({ ...variant, days: trialDays });
      console.log(r.label.padEnd(41) + String(r.commuters).padStart(9) + String(r.boardingsAtPlatform).padStart(20)
        + (String(r.lunches.commuterUnderground) + ' / ' + r.lunches.commuterAbove).padStart(30)
        + (String(r.lunches.otherUnderground) + ' / ' + r.lunches.otherAbove).padStart(22)
        + (String(r.let) + '/' + r.offices).padStart(9) + String(r.stress ?? '-').padStart(10));
    }
    process.exit(0);
  }
  if (process.argv.includes('--ladder')) {
    // `node harness/playtest.js --ladder [days]` - the issue #14 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 14);
    const r = ladderTrial({ days: trialDays });
    console.log('star ladder trial: ' + r.offices + ' real offices, a scripted player reading the bar, ' + trialDays
      + ' days. STAND-INS: the population above the real tenants ("crowd"), and the flags of issues 15-17.\n');
    console.log('day  star  population  (real)  the bar says');
    for (const row of r.perDay) {
      console.log(String(row.day).padStart(3) + String(row.star).padStart(6) + String(row.population).padStart(12)
        + String(row.real).padStart(8) + '  ' + row.hud);
    }
    console.log('\nrises: ' + (r.rises.map((x) => x.text.replace('The tower has ', '') + ' (day ' + x.day + ', tick ' + x.tick + ')').join('; ') || 'none'));
    console.log('built: ' + [...new Set(r.built.map((b) => b.what))].join(', '));
    const firstRefusals = new Map();
    for (const b of r.refused) if (!firstRefusals.has(b.what)) firstRefusals.set(b.what, b.reason);
    console.log('refused: ' + (r.refused.length
      ? [...firstRefusals].map(([what, why]) => what + ' (first of ' + r.refused.filter((b) => b.what === what).length + '): ' + why).join(' | ')
      : 'nothing'));
    console.log('stand-in flags set on days: ' + JSON.stringify(r.flagsSetOn));
    process.exit(0);
  }
  if (process.argv.includes('--housekeeping')) {
    // `node harness/playtest.js --housekeeping [days]` - the issue #9 proof.
    const trialDays = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 10);
    const dollars = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
    console.log('housekeeping trial: 22 single rooms on one floor (F8), a guest lift, a service elevator, '
      + trialDays + ' days. NdMi = rooms dirty / infested at the end of that day.\n');
    console.log('facilities  staff  stays paid  cleaned  infested  first outbreak  income      dirty/infested by day');
    console.log('-'.repeat(118));
    for (const n of [0, 1, 2, 3]) {
      const r = housekeepingTrial({ facilities: n, days: trialDays });
      console.log(String(n).padStart(10) + String(n * 6).padStart(7) + String(r.checkouts).padStart(12)
        + String(r.cleaned).padStart(9) + String(r.infestedAtEnd + '/' + r.rooms).padStart(10)
        + String(r.firstInfestedDay === null ? '-' : 'day ' + r.firstInfestedDay).padStart(16)
        + dollars(r.earned).padStart(10) + '   ' + r.perDay.join(' '));
    }
    process.exit(0);
  }
  const days = Number(process.argv[2] ?? 14);
  const seed = Number(process.argv[3] ?? 1);
  const plays = process.argv.includes('--play');
  // `--offices-only` reproduces the plan this harness had before condos
  // existed, so the two runs are comparable line for line.
  const condos = !process.argv.includes('--offices-only');
  // `--no-hotels` reproduces the plan this harness had before hotel rooms
  // existed, which is what makes a before/after comparison line for line.
  const hotels = !process.argv.includes('--no-hotels');
  // `--no-housekeeping` is the player who built hotels and never read the manual.
  const housekeeping = !process.argv.includes('--no-housekeeping');
  // `--no-security` is the player who never built one: the tower stalls at two stars.
  const security = !process.argv.includes('--no-security');
  const world = seedDemoWorld({ seed });
  const { scheduler } = makeDriver(world);
  const act = plays ? greedyBuilder(world, { condos, hotels, housekeeping, security }) : () => null;
  const condoLedger = condoWatch(world.tower);
  const hotelLedger = hotelWatch(world.tower);

  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
  const pad = (s, n) => String(s).padStart(n);

  console.log('seed ' + seed + ' · ' + days + ' days · ' + world.tower.objects.size + ' rooms, '
    + world.tower.carriers.length + ' lift(s), ' + world.tower.carriers[0].cars.length + ' car(s)\n');
  console.log('day   let    moving   stress          cash        pop  ★  activity  the bar says');
  console.log('─'.repeat(88));

  let previous = null;
  let peakLet = 0;
  for (let d = 0; d <= days; d++) {
    // ⚠️ Sampled at MIDDAY, not at the day boundary.
    //
    // A new game starts at tick 2533, which is checkpoint 2533 — the ledger
    // rollover, the daily eviction sweep, and the 3-day trip-counter reset. So
    // stepping a whole 2,600 ticks lands the reading on that same checkpoint,
    // one instruction after the counters were emptied: every third row said
    // "no trips yet" and a stress of `—` for a tower carrying three hundred
    // commuters. That was the harness looking at the wrong instant, not the
    // game failing to move anybody, and it is exactly the shape of reading
    // that gets mistaken for a bug and then "fixed".
    const step = d === 0 ? TICKS_PER_DAY / 2 : TICKS_PER_DAY;
    for (let t = 0; t < step; t++) { scheduler.tick(world.tower); condoLedger.sample(); hotelLedger.sample(); }
    // The player acts once a day, at the start, the way somebody who checks in
    // each morning would. Several builds a day, because one office a day is a
    // pace no person keeps.
    const did = [];
    for (let i = 0; i < 8; i++) { const what = act(); if (!what) break; did.push(what); }
    const r = readout(world);
    if (r.let > peakLet) peakLet = r.let;
    const delta = previous === null ? '' : (r.cash - previous >= 0 ? ' +' : ' ') + money(r.cash - previous);
    previous = r.cash;
    console.log(
      pad(r.day, 3) + '  ' + pad(r.let + '/' + r.leasable, 6) + '  ' + pad(r.moving, 6)
      + '   ' + pad(r.stress === null ? '—' : r.stress + ' ' + r.band, 13)
      + ' ' + pad(money(r.cash), 11) + pad(delta, 12)
      + pad(r.population, 6) + pad(r.stars, 3) + pad(r.activity, 10)
      + '  ' + r.hud
      + (did.length ? '   « ' + did.length + ' built' : ''),
    );
  }

  if (plays) {
    const r = readout(world);
    console.log('\n' + '─'.repeat(88));
    console.log('ended at ' + r.let + '/' + r.leasable + ' let, peak ' + peakLet
      + ' — ' + (r.let < peakLet
        ? 'the tower LOST ' + (peakLet - r.let) + ' tenants it had won, which is the loop biting'
        : 'nothing was ever lost: building more never cost anything'));
  }

  // The condo line runs whether or not anybody was playing, because the seed
  // could grow condos later and a silent zero is a worse answer than a stated
  // one.
  const c = condoLedger.totals;
  let built = 0, sold = 0;
  for (const o of world.tower.objects.values()) {
    if (o.family !== FAMILY.condo) continue;
    built++;
    if (isCondoSold(o.unitStatus)) sold++;
  }
  const spent = built * (CONSTRUCTION_COST.condo + BUILDABLE.condo.width * CONSTRUCTION_COST.floorTile);
  const net = c.earned - c.given - spent;
  console.log('\ncondos  ' + sold + '/' + built + ' sold · ' + c.sales + ' sale(s) '
    + money(c.earned) + ' · ' + c.refunds + ' refund(s) ' + money(-c.given)
    + ' · construction ' + money(-spent) + '  =  ' + money(net));

  // Hotels, the same way: stated even when there are none. A guest checking in is
  // the evening and a checkout is the morning, so a room that shows a check-in and
  // no checkout is a guest the lifts could not get out again.
  const h = hotelLedger.totals;
  const rooms = { hotelSingle: 0, hotelTwin: 0, hotelSuite: 0 };
  const nameOf = {
    [FAMILY.hotelSingle]: 'hotelSingle', [FAMILY.hotelTwin]: 'hotelTwin', [FAMILY.hotelSuite]: 'hotelSuite',
  };
  let booked = 0, dirty = 0, infested = 0, facilities = 0, spentOnRooms = 0;
  for (const o of world.tower.objects.values()) {
    if (o.family === FAMILY.housekeeping) facilities++;
    if (!isHotelFamily(o.family)) continue;
    const name = nameOf[o.family];
    rooms[name]++;
    if (isHotelBooked(o)) booked++;
    if (isHotelRoomDirty(o)) dirty++;
    if (isHotelInfested(o)) infested++;
    spentOnRooms += CONSTRUCTION_COST[name] + BUILDABLE[name].width * CONSTRUCTION_COST.floorTile;
  }
  const total = rooms.hotelSingle + rooms.hotelTwin + rooms.hotelSuite;
  console.log('hotels  ' + total + ' room(s) (' + rooms.hotelSingle + ' single, ' + rooms.hotelTwin + ' twin, '
    + rooms.hotelSuite + ' suite) · ' + booked + ' booked, ' + dirty + ' dirty, ' + infested + ' infested · ' + h.checkins
    + ' check-in(s), ' + h.checkouts + ' checkout(s) ' + money(h.earned) + ' · construction '
    + money(-spentOnRooms) + '  =  ' + money(h.earned - spentOnRooms));
  let guards = 0, offices = 0;
  for (const o of world.tower.objects.values()) if (o.family === FAMILY.security) { offices++; guards += 6; }
  console.log('security  ' + offices + ' office(s) (' + guards + ' guards) · $' + (offices * 20_000).toLocaleString('en-US')
    + ' a pass in upkeep · ' + (world.tower.gates?.securityPlaced ? 'the 2 -> 3 gate is open' : 'the 2 -> 3 gate is SHUT'));
  console.log('housekeeping  ' + facilities + ' facilit' + (facilities === 1 ? 'y' : 'ies') + ' (' + facilities * 6
    + ' staff) · ' + h.cleaned + ' room(s) cleaned · ' + h.infestations + ' infested'
    + (h.firstInfestedDay === null ? '' : ' (first on day ' + h.firstInfestedDay + ')'));
}
