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
import { FAMILY, isHotelFamily, isUnitLet, population } from '../src/games/tower/sim/state.js';
import { isCondoSold } from '../src/games/tower/sim/condo.js';
import { isHotelBooked, isHotelRoomDirty } from '../src/games/tower/sim/hotel.js';
import { CONSTRUCTION_COST, RENT_TIERS } from '../src/games/tower/sim/economy.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { computeRuntimeTileStressAverage, stressBand } from '../src/games/tower/sim/stress.js';
import { BUILDABLE, applyAction } from '../src/games/tower/sim/actions.js';
import { starGateStatus, towerActivity } from '../src/games/tower/sim/progression.js';

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
    activity: towerActivity(tower),
    blocking: starGateStatus(tower).missing ?? [],
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
  const totals = { checkins: 0, checkouts: 0, earned: 0 };
  const PRICE = { [FAMILY.hotelSingle]: 'hotelSingle', [FAMILY.hotelTwin]: 'hotelTwin', [FAMILY.hotelSuite]: 'hotelSuite' };

  return {
    totals,
    sample() {
      for (const object of tower.objects.values()) {
        if (!isHotelFamily(object.family)) continue;
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
export function greedyBuilder(world, { condos = true, hotels = true } = {}) {
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

  return function act() {
    const lift = tower.carriers[0];
    if (!lift) return null;

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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('playtest.js')) {
  const days = Number(process.argv[2] ?? 14);
  const seed = Number(process.argv[3] ?? 1);
  const plays = process.argv.includes('--play');
  // `--offices-only` reproduces the plan this harness had before condos
  // existed, so the two runs are comparable line for line.
  const condos = !process.argv.includes('--offices-only');
  // `--no-hotels` reproduces the plan this harness had before hotel rooms
  // existed, which is what makes a before/after comparison line for line.
  const hotels = !process.argv.includes('--no-hotels');
  const world = seedDemoWorld({ seed });
  const { scheduler } = makeDriver(world);
  const act = plays ? greedyBuilder(world, { condos, hotels }) : () => null;
  const condoLedger = condoWatch(world.tower);
  const hotelLedger = hotelWatch(world.tower);

  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
  const pad = (s, n) => String(s).padStart(n);

  console.log('seed ' + seed + ' · ' + days + ' days · ' + world.tower.objects.size + ' rooms, '
    + world.tower.carriers.length + ' lift(s), ' + world.tower.carriers[0].cars.length + ' car(s)\n');
  console.log('day   let    moving   stress          cash        pop  ★  activity  waiting on');
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
      + '  ' + (r.blocking.length ? r.blocking.join(', ') : '—')
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
  let booked = 0, dirty = 0, spentOnRooms = 0;
  for (const o of world.tower.objects.values()) {
    if (!isHotelFamily(o.family)) continue;
    const name = nameOf[o.family];
    rooms[name]++;
    if (isHotelBooked(o)) booked++;
    if (isHotelRoomDirty(o)) dirty++;
    spentOnRooms += CONSTRUCTION_COST[name] + BUILDABLE[name].width * CONSTRUCTION_COST.floorTile;
  }
  const total = rooms.hotelSingle + rooms.hotelTwin + rooms.hotelSuite;
  console.log('hotels  ' + total + ' room(s) (' + rooms.hotelSingle + ' single, ' + rooms.hotelTwin + ' twin, '
    + rooms.hotelSuite + ' suite) · ' + booked + ' booked, ' + dirty + ' dirty · ' + h.checkins
    + ' check-in(s), ' + h.checkouts + ' checkout(s) ' + money(h.earned) + ' · construction '
    + money(-spentOnRooms) + '  =  ' + money(h.earned - spentOnRooms));
}
