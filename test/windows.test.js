/**
 * The Facility and Tenant windows, the plain-words causes, and naming (issue #18).
 *
 * `HELP.txt` § Facility Window / § Tenant Window / § Find Person, `STR 711` (the status lines),
 * `STR 712` (Occupied / For Rent / For Sale / Clean / Dirty) and `STR 1005` (the naming refusals).
 *
 * The causes ("Elevator is far away", "Neighbors are too noisy", "Room is too dirty") are claims
 * about the tower, so each is checked at its boundary against what the sim actually charges: the
 * distance reasons against the REAL ROUTER's distance penalty for a real worker, the noise reasons
 * against the family's own radius, the dirt against the hotel's strike count. A sentence that appears
 * when nothing is being charged, or is missing when something is, would be the HUD lying about a
 * tower that is behaving.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import { CARRIER_MODE } from '../src/games/tower/sim/elevators.js';
import {
  DELAY, ROUTE, rebuildRouteTables, resolveRouteBetweenFloors,
} from '../src/games/tower/sim/routing.js';
import { distancePenalty } from '../src/games/tower/sim/stress.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { FAMILY, HOTEL_UNIT_STATUS, __resetIds, placeObject } from '../src/games/tower/sim/state.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import {
  REASON, RENT_ROW, accessOf, defaultFacilityName, facilityReading, isLet, pricePerception, rentRefusal, statusWord,
  unhappinessReasons,
} from '../src/games/tower/sim/facility.js';
import { officeIsLet } from '../src/games/tower/render/canvas.js';
import {
  MAX_NAMED_FACILITIES, MAX_NAMED_PEOPLE, MAX_NAME_LENGTH, NAME_TEXT, cleanName, namedFacilities, namedPeople, personName,
} from '../src/games/tower/sim/names.js';
import { facilityWindowModel } from '../src/games/tower/ui/facility-window.js';
import { namedPeopleList, tenantWindowModel } from '../src/games/tower/ui/tenant-window.js';
import { hoverReasons } from '../src/games/tower/ui/readout.js';
import { preview, toolById } from '../src/games/tower/ui/build.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { actorsOf, assert, build, let_, liftedWorld, measure } from './_windows.js';

const clock = { dayTick: 500, daypart: 0, calendarPhase: false };

/** What the real router charges a worker for the ride from the lobby up to `floor`. */
function routerPenalty(world, floor) {
  const result = resolveRouteBetweenFloors(world.tower, { id: 'probe', homeColumn: 0 }, 0, floor, clock);
  assert(result.code === ROUTE.QUEUED || result.code === ROUTE.LOCAL_LEG, 'the probe got a route: ' + result.code);
  const d = result.delays.find((x) => x.kind === DELAY.DISTANCE);
  if (!d) return 0;
  if (d.carrierMode === CARRIER_MODE.EXPRESS) return 0;               // the router reports it; stress exempts it
  return distancePenalty(d.heightMetricDelta);
}

const put = (tower, family, floor, left, right) => {
  const r = placeObject(tower, { family, floor, left, right }, () => createSimTripRecord());
  assert(r.ok, `fixture ${family}: ${r.reason}`);
  return r.object;
};

export const tests = {
  // ============================================================ the facility window

  'the window for an office: its name, status, eval bar with the dividers on the thresholds, tiers and occupants'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    let m = facilityWindowModel(w, office.id);
    assert(m.title === 'Office, Floor 3' && m.kind === 'Office' && m.status === 'For Rent', JSON.stringify([m.title, m.kind, m.status]));
    assert(m.eval.word === 'no reading yet' && m.eval.fill === 0 && m.eval.color === '#6b7788', 'unmeasured: an empty grey bar');

    let_(office);
    measure(w.tower, office, 100);
    m = facilityWindowModel(w, office.id);
    assert(m.status === 'Occupied', 'let');
    // The bar fills with happiness: stress 100 of 300 is two thirds full; the dividers are the thresholds.
    assert(Math.abs(m.eval.fill - (1 - 100 / 300)) < 1e-9, 'fill ' + m.eval.fill);
    assert(Math.abs(m.eval.dividers.first - 0.5) < 1e-9 && Math.abs(m.eval.dividers.second - (1 - 80 / 300)) < 1e-9,
      'dividers at the 150 and 80 thresholds: ' + JSON.stringify(m.eval.dividers));
    assert(m.eval.word === 'fair' && m.eval.key === 'fair', 'yellow');
    // The fill passes the second divider exactly when the room turns blue, and the first when it leaves red.
    for (const [stress, word] of [[79, 'good'], [80, 'fair'], [149, 'fair'], [150, 'poor']]) {
      measure(w.tower, office, stress);
      const e = facilityWindowModel(w, office.id).eval;
      assert(e.word === word, `${stress}: ${e.word}`);
      assert((e.fill > e.dividers.second) === (word === 'good'), `${stress}: the bar is past the second divider only when blue`);
      assert((e.fill > e.dividers.first) === (word !== 'poor'), `${stress}: and past the first only when not red`);
    }
    // At four stars the first divider slides to the 200 threshold.
    w.tower.starCount = 4;
    assert(Math.abs(facilityWindowModel(w, office.id).eval.dividers.first - (1 - 200 / 300)) < 1e-9, 'four stars: first divider at 200');

    assert(m.rent.tiers.map((t) => t.amount).join() === '15000,10000,5000,2000', 'the four rents');
    assert(m.rent.tiers.map((t) => t.perception).join() === 'dear,fair,cheap,bargain' && m.rent.tier === 1 && m.rent.canChange, 'tier 1 of 4');
    assert(m.people.length === 6 && m.people[0].word === 'stressed' || m.people[0].word === 'calm', 'six occupants');
  },

  'the rent tier changes through set_rent and the window follows; the seam owns the verdict'() {
    const w = liftedWorld({ stars: 5 });
    const office = build(w, 'office', 3, 44);
    for (const tier of [0, 2, 3, 1]) {
      assert(applyAction(w, { type: 'set_rent', objectId: office.id, tier }).ok, 'tier ' + tier);
      const m = facilityWindowModel(w, office.id);
      assert(m.rent.tier === tier && m.rent.tiers.filter((t) => t.current).length === 1 && m.rent.tiers[tier].current, 'the window shows tier ' + tier);
      assert(m.rent.perception === pricePerception(office), 'perception follows');
    }
    assert(!applyAction(w, { type: 'set_rent', objectId: office.id, tier: 4 }).ok, 'there is no tier 4');
  },

  'a facility with nothing to rent has no rent, no sale and no status - the cathedral above all'() {
    __resetIds();
    const w = newTowerWorld({ seed: 1, cash: 90_000_000 });
    const t = w.tower;
    const things = {
      housekeeping: put(t, FAMILY.housekeeping, 1, 0, 4),
      security: put(t, FAMILY.security, -1, 0, 3),
      medical: put(t, FAMILY.medical, 2, 0, 25),
      parkingSpace: put(t, FAMILY.parkingSpace, -2, 0, 3),
      parkingRamp: put(t, FAMILY.parkingRamp, -1, 8, 8),
      recycling: put(t, FAMILY.recycling, -3, 0, 24),
      metro: put(t, FAMILY.metro, -4, 0, 20),
      cathedral: put(t, FAMILY.cathedral, 99, 0, 27),
      theater: put(t, FAMILY.theater, 5, 0, 20),
      partyHall: put(t, FAMILY.partyHall, 6, 0, 20),
      restaurant: put(t, FAMILY.restaurant, 7, 0, 23),
      fastFood: put(t, FAMILY.fastFood, 8, 0, 15),
      lobby: put(t, FAMILY.lobby, 20, 0, 40),
    };
    // A cathedral's unitStatus is meaningless: poison it, and the window must still not talk of rent.
    things.cathedral.unitStatus = 0x10;
    for (const [name, object] of Object.entries(things)) {
      const m = facilityWindowModel(w, object.id);
      assert(m.rent === null, name + ' must not offer a rent or a sale');
      assert(m.status === null && statusWord(object) === null, name + ' has no For Rent / For Sale / Occupied');
      const seam = applyAction(w, { type: 'set_rent', objectId: object.id, tier: 0 });
      assert(!seam.ok && seam.reason === 'that room does not pay rent', name + ': the seam refuses with ' + seam.reason);
      assert(rentRefusal(object) === 'that room does not pay rent', name + ': one definition');
      const ghost = preview(w, toolById('set_rent'), { floor: object.floor, tile: object.left, object, link: null, carrier: null, columnCarrier: null });
      assert(ghost.ok === false && ghost.reason === 'that room does not pay rent', name + ': the ghost says ' + ghost.reason);
    }
    assert(Object.keys(RENT_ROW).length === 6, 'six families have a tier: hotel x3, office, condo, retail');
  },

  'the rent ghost and the seam agree, in words, for every family - including a sold condo, which the ghost used to wave through'() {
    const w = liftedWorld({ stars: 5 });
    const rows = {
      office: build(w, 'office', 2, 44), condoForSale: build(w, 'condo', 3, 44), condoSold: build(w, 'condo', 4, 44),
      retail: build(w, 'retail', 5, 44), single: build(w, 'hotelSingle', 6, 44), twin: build(w, 'hotelTwin', 7, 44),
      suite: build(w, 'hotelSuite', 8, 44), restaurant: build(w, 'restaurant', 9, 44), security: build(w, 'security', -1, 44),
    };
    rows.condoSold.unitStatus = 0x00; rows.condoSold.occupiedFlag = true;
    for (const [name, object] of Object.entries(rows)) {
      const target = { floor: object.floor, tile: object.left, object, link: null, carrier: null, columnCarrier: null };
      const ghost = preview(w, toolById('set_rent'), target);
      const seam = applyAction(w, { type: 'set_rent', objectId: object.id, tier: ghost.command?.tier ?? 2 });
      assert(ghost.ok === seam.ok, `${name}: ghost ${ghost.ok} (${ghost.reason}) but the seam ${seam.ok} (${seam.reason})`);
      if (!seam.ok) assert(ghost.reason === seam.reason, `${name}: the ghost says "${ghost.reason}", the seam "${seam.reason}"`);
    }
    assert(facilityWindowModel(w, rows.condoSold.id).rent.canChange === false, 'the window locks a sold condo\'s tier');
    assert(facilityWindowModel(w, rows.condoSold.id).rent.refusal === 'that condo is sold — you can only price one that is still for sale', 'in words');
    assert(facilityWindowModel(w, rows.condoForSale.id).status === 'For Sale' && facilityWindowModel(w, rows.condoSold.id).status === 'Occupied', 'For Sale / Occupied');
  },

  'what the window calls a room, and the original\'s status words'() {
    const w = liftedWorld({ stars: 5 });
    const single = build(w, 'hotelSingle', 2, 44);
    assert(defaultFacilityName(single) === 'Single Room, Floor 2', defaultFacilityName(single));
    assert(statusWord(single) === 'Clean', 'vacant and ready');
    single.unitStatus = HOTEL_UNIT_STATUS.occupiedEarly;
    assert(statusWord(single) === 'Occupied', 'a guest');
    single.unitStatus = HOTEL_UNIT_STATUS.dirtyEarly;
    assert(statusWord(single) === 'Dirty', 'checked out');
    const basement = build(w, 'security', -2, 44);
    assert(defaultFacilityName(basement) === 'Security, Floor B2', 'basements carry the B: ' + defaultFacilityName(basement));
  },

  'the renderer and the sim agree on what is let'() {
    const w = liftedWorld({ stars: 5 });
    const objects = [build(w, 'office', 2, 44), build(w, 'condo', 3, 44), build(w, 'hotelSingle', 4, 44), build(w, 'retail', 5, 44)];
    for (const o of objects) {
      for (const status of [0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38]) {
        for (const flag of [true, false]) {
          o.unitStatus = status; o.occupiedFlag = flag;
          assert(isLet(o) === officeIsLet(o), `family ${o.family}, 0x${status.toString(16)}, flag ${flag}: sim ${isLet(o)}, renderer ${officeIsLet(o)}`);
        }
      }
    }
  },

  // ======================================================== the plain-words causes

  'Elevator is far away / very far away: the sentence appears exactly when the real router charges the penalty'() {
    // Thresholds from ROUTING.md: <= 79 free, 80..124 -> 30 ("far"), >= 125 -> 60 ("very far").
    const table = [[40, null, 0], [79, null, 0], [80, REASON.elevatorFar, 30], [124, REASON.elevatorFar, 30], [125, REASON.elevatorVeryFar, 60], [146, REASON.elevatorVeryFar, 60]];
    for (const [column, sentence, penalty] of table) {
      const w = liftedWorld({ stars: 3, column, top: 4 });
      const office = build(w, 'office', 2, column >= 100 ? 90 : 120);
      const reasons = unhappinessReasons(w.tower, office);
      const said = reasons.filter((r) => /Elevator/.test(r));
      assert(JSON.stringify(said) === JSON.stringify(sentence ? [sentence] : []), `lift at column ${column}: said ${JSON.stringify(said)}, want ${sentence}`);
      assert(routerPenalty(w, 2) === penalty, `lift at column ${column}: the router charges ${routerPenalty(w, 2)}, want ${penalty}`);
      assert(accessOf(w.tower, office).access === (penalty === 0 ? 'good' : penalty === 30 ? 'far' : 'veryFar'), 'access');
    }
  },

  'an express lift is exempt from the distance penalty, and the sentence is not said for it'() {
    const w = liftedWorld({ stars: 5, lift: false });
    // Express lifts stop at the lobbies only; floor 14 is the first sky lobby.
    const shaft = applyAction(w, { type: 'build_shaft', kind: 'express', bottom: 0, top: 14, column: 130 });
    assert(shaft.ok, 'express: ' + shaft.reason);
    rebuildRouteTables(w.tower);
    const lobby = build(w, 'lobby', 14, 120);
    const office = build(w, 'office', 14, 100);
    assert(accessOf(w.tower, office).access === 'exempt', 'exempt: ' + JSON.stringify(accessOf(w.tower, office)));
    assert(!unhappinessReasons(w.tower, office).some((r) => /far away/.test(r)), 'no distance sentence');
    assert(lobby.floor === 14, 'fixture');
  },

  'Stairs are far away: the sentence matches the router on a stairs segment'() {
    const w = liftedWorld({ stars: 5, lift: false });
    const office = build(w, 'office', 1, 90);
    build(w, 'office', 1, 96);
    assert(applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 90 }).ok, 'stairs');
    rebuildRouteTables(w.tower);
    assert(accessOf(w.tower, office).reason === REASON.stairsFar, JSON.stringify(accessOf(w.tower, office)));
    assert(routerPenalty(w, 1) === 30, 'and the router does charge 30 for the walk');
    assert(unhappinessReasons(w.tower, office).includes('Stairs are far away'), 'said on the hover');
  },

  'Escalator is far away: the sentence matches the router on an escalator segment'() {
    const w = liftedWorld({ stars: 5, lift: false });
    const shop = build(w, 'retail', 1, 90);
    const link = applyAction(w, { type: 'build_link', kind: 'escalator', floor: 0, left: 90 });
    assert(link.ok, 'escalator: ' + link.reason);
    rebuildRouteTables(w.tower);
    assert(accessOf(w.tower, shop).reason === REASON.escalatorFar, JSON.stringify(accessOf(w.tower, shop)));
    assert(routerPenalty(w, 1) === 30, 'the router charges 30');
    assert(unhappinessReasons(w.tower, shop).includes('Escalator is far away'), 'said for the shop too');
  },

  'No transportation connected: a floor the lift does not reach, and nothing else'() {
    const w = liftedWorld({ stars: 3, top: 6 });
    const reached = build(w, 'office', 3, 44);
    const stranded = build(w, 'office', 9, 44);
    assert(!unhappinessReasons(w.tower, reached).includes(REASON.noTransport), 'a served floor');
    assert(unhappinessReasons(w.tower, stranded)[0] === 'No transportation connected', JSON.stringify(unhappinessReasons(w.tower, stranded)));
    assert(accessOf(w.tower, stranded).access === 'none', 'none');
    assert(facilityWindowModel(w, stranded.id).accessGood === false && facilityWindowModel(w, reached.id).accessGood === true, 'the window says "Transportation access is good" only for the served one');
  },

  'Neighbors are too noisy: the family\'s own radius - office 10, hotel 20, condo 30 - and its own neighbours'() {
    // [what, radius in tiles of gap, what makes noise for it]
    const cases = [
      ['office', 10, 'restaurant', 24], ['hotelSingle', 20, 'office', 6], ['condo', 30, 'office', 6],
    ];
    for (const [what, radius, noise, noiseWidth] of cases) {
      for (const gap of [radius, radius + 1]) {
        const w = liftedWorld({ stars: 5 });
        const unit = build(w, what, 2, 44);
        const left = unit.right + gap;                                   // the sim's gap is other.left - object.right
        if (left + noiseWidth > 150) throw new Error('fixture off the lot: ' + what);
        build(w, noise, 2, left);
        const noisy = unhappinessReasons(w.tower, unit).includes(REASON.noisy);
        assert(noisy === (gap <= radius), `${what} with a ${noise} ${gap} tiles away: ${noisy ? 'noisy' : 'quiet'}, the rule says radius ${radius}`);
      }
    }
    // A hotel does not count another hotel or a condo; an office does not count another office.
    const w = liftedWorld({ stars: 5 });
    const hotel = build(w, 'hotelSingle', 2, 44);
    build(w, 'hotelSingle', 2, 48); build(w, 'condo', 2, 60);
    assert(!unhappinessReasons(w.tower, hotel).includes(REASON.noisy), 'hotels are not noise to hotels, nor condos');
    const office = build(w, 'office', 3, 44); build(w, 'office', 3, 50);
    assert(!unhappinessReasons(w.tower, office).includes(REASON.noisy), 'an office is not noise to an office');
  },

  'the noise sentence agrees with the evaluation: the +60 is in the score exactly when it is said'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 2, 44);
    let_(office); measure(w.tower, office, 20);
    assert(facilityReading(w.tower, office).score === 20 && !unhappinessReasons(w.tower, office).includes(REASON.noisy), 'quiet: 20');
    build(w, 'restaurant', 2, 52);
    assert(facilityReading(w.tower, office).score === 80 && unhappinessReasons(w.tower, office).includes(REASON.noisy), 'noisy: 20 + 60');
  },

  'Housekeeping needed, then Room is too dirty after a strike, and the infested room is too dirty too'() {
    const w = liftedWorld({ stars: 5 });
    const room = build(w, 'hotelSingle', 2, 44);
    assert(unhappinessReasons(w.tower, room).length === 0, 'clean: nothing to say');
    room.unitStatus = HOTEL_UNIT_STATUS.dirtyEarly; room.activationTickCount = 0;
    assert(unhappinessReasons(w.tower, room).join() === 'Housekeeping needed', unhappinessReasons(w.tower, room).join());
    room.activationTickCount = 1;                                         // survived a 1600 pass dirty: a strike
    assert(unhappinessReasons(w.tower, room).join() === 'Room is too dirty', unhappinessReasons(w.tower, room).join());
    room.unitStatus = 0x38;
    assert(unhappinessReasons(w.tower, room).join() === 'Room is too dirty', 'infested');
    assert(hoverReasons(w.tower, room) === 'Room is too dirty', 'the hover line carries it');
    assert(facilityReading(w.tower, room).level === null, 'and the room is not scored while it is dirty (the sim\'s own rule)');
  },

  'a venue says how its business is in the original\'s words'() {
    const w = liftedWorld({ stars: 5 });
    const shop = build(w, 'restaurant', 2, 60);
    const venue = shop.venue;
    const say = (n) => { venue.acquireCount = n; venue.yesterdayVisitCount = 0; return unhappinessReasons(w.tower, shop).filter((r) => /usiness|customers/.test(r)).join(); };
    assert(say(0) === 'Very few customers' && say(24) === 'Very few customers', '0-24');
    assert(say(25) === 'Business is average' && say(34) === 'Business is average', '25-34');
    assert(say(35) === 'Business is good' && say(49) === 'Business is good', '35-49');
    assert(say(50) === 'Business is very good!', '50+');
    // ...and the Eval grade of a venue: poor, fair, fair, good.
    const level = (n) => { venue.acquireCount = n; return facilityReading(w.tower, shop).level; };
    assert(level(0) === 0 && level(25) === 1 && level(35) === 1 && level(50) === 2, 'venue grades');
  },

  // ============================================================== the tenant window

  'the Tenant window: who, where they work, how they feel, and where they are going'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    let_(office);
    const [first] = actorsOf(w.tower, office);
    first.tripCount = 2; first.accumulatedElapsed = 2 * 90;
    first.targetFloor = 3; first.anchorFloor = 0;
    let m = tenantWindowModel(w, first.id);
    assert(m.role === 'Office worker' && m.title === 'Office worker' && !m.named, 'an unnamed worker');
    assert(m.worksAt.title === 'Office, Floor 3' && m.worksAt.floorLabel === 'F3', JSON.stringify(m.worksAt));
    assert(m.feel.word === 'stressed' && m.feel.stress === 90, 'stress 90 is pink: ' + JSON.stringify(m.feel));
    assert(m.from === 'F0' && m.goingTo === 'F3', 'from the lobby to F3');
    first.tripCount = 1; first.accumulatedElapsed = 150;
    assert(tenantWindowModel(w, first.id).feel.word === 'fed up', '150 is red');
    first.tripCount = 1; first.accumulatedElapsed = 10;
    assert(tenantWindowModel(w, first.id).feel.word === 'calm', 'and 10 is calm');
    first.tripCount = 0; first.accumulatedElapsed = 0;
    m = tenantWindowModel(w, first.id);
    assert(m.feel.word === 'no trips yet' && m.feel.stress === null, 'no trips is not "calm"');
    assert(tenantWindowModel(w, 9_999) === null, 'a person who is not there');
  },

  'staff have no stress: the window says on duty, not calm'() {
    const w = liftedWorld({ stars: 3 });
    const hk = build(w, 'housekeeping', 2, 60);
    const m = tenantWindowModel(w, actorsOf(w.tower, hk)[0].id);
    assert(m.role === 'Housekeeper' && m.feel.word === 'on duty' && m.feel.stress === null, JSON.stringify(m.feel));
  },

  'a person waiting for a lift says where'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    const a = actorsOf(w.tower, office)[0];
    a.waitingFloor = 7;
    assert(tenantWindowModel(w, a.id).doing === 'waiting for a lift on F7', tenantWindowModel(w, a.id).doing);
  },

  // ===================================================================== naming

  'naming a person goes through applyAction, and the window shows it'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    const a = actorsOf(w.tower, office)[0];
    const r = applyAction(w, { type: 'name_person', actorId: a.id, name: '  Ada   Lovelace ' });
    assert(r.ok && r.name === 'Ada Lovelace', 'trimmed and folded: ' + r.name);
    assert(personName(w.tower, a.id) === 'Ada Lovelace' && tenantWindowModel(w, a.id).title === 'Ada Lovelace', 'shown');
    assert(namedPeopleList(w).length === 1 && namedPeopleList(w)[0].name === 'Ada Lovelace', 'and in the Find list');
    assert(!applyAction(w, { type: 'name_person', actorId: 99_999, name: 'Nobody' }).ok, 'nobody to name');
  },

  'a name is at most 15 characters, in the original\'s sentence; 15 is fine'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    const a = actorsOf(w.tower, office)[0];
    assert(MAX_NAME_LENGTH === 15, '15');
    assert(applyAction(w, { type: 'name_person', actorId: a.id, name: 'x'.repeat(15) }).ok, '15 characters is allowed');
    const long = applyAction(w, { type: 'name_person', actorId: a.id, name: 'x'.repeat(16) });
    assert(!long.ok && long.reason === 'That name is too long.  Names can have up to 15 characters.', long.reason);
    assert(personName(w.tower, a.id) === 'x'.repeat(15), 'and the old name stands');
    assert(NAME_TEXT.tooLong === long.reason, 'the shared sentence');
    // Padding is not length.
    assert(applyAction(w, { type: 'name_person', actorId: a.id, name: '    short    ' }).ok && personName(w.tower, a.id) === 'short', 'spaces are not characters');
    assert(cleanName('a\tb\nc') === 'a b c', 'control characters become spaces');
    assert(applyAction(w, { type: 'name_facility', objectId: office.id, name: 'y'.repeat(16) }).reason === NAME_TEXT.tooLong, 'same for a facility');
  },

  'twenty people, and the twenty-first is refused in the original\'s words; an empty name frees a slot'() {
    const w = liftedWorld({ stars: 3 });
    const people = [];
    for (let i = 0; i < 4; i++) people.push(...actorsOf(w.tower, build(w, 'office', 2 + i, 44)));
    assert(people.length === 24, 'fixture: 24 workers');
    assert(MAX_NAMED_PEOPLE === 20, '20');
    for (let i = 0; i < 20; i++) assert(applyAction(w, { type: 'name_person', actorId: people[i].id, name: 'P' + i }).ok, 'name ' + i);
    const refused = applyAction(w, { type: 'name_person', actorId: people[20].id, name: 'Too Many' });
    assert(!refused.ok && refused.reason === 'You may only name 20 people.', refused.reason);
    assert(namedPeople(w.tower).length === 20, 'still twenty');
    // Renaming someone already named is not a twenty-first.
    assert(applyAction(w, { type: 'name_person', actorId: people[3].id, name: 'Renamed' }).ok && personName(w.tower, people[3].id) === 'Renamed', 'a rename');
    // The original's Delete: an empty name takes it off and frees the slot.
    assert(applyAction(w, { type: 'name_person', actorId: people[3].id, name: '' }).ok && personName(w.tower, people[3].id) === null, 'deleted');
    assert(applyAction(w, { type: 'name_person', actorId: people[20].id, name: 'Now Fine' }).ok, 'and the freed slot is usable');
    assert(!applyAction(w, { type: 'name_person', actorId: people[21].id, name: 'Again' }).ok, 'twenty again');
  },

  'twenty facilities, and the twenty-first is refused: "You may only name 20 tenants."'() {
    const w = liftedWorld({ stars: 3, top: 12 });
    const rooms = [];
    for (let f = 1; f <= 11; f++) { rooms.push(build(w, 'office', f, 44)); rooms.push(build(w, 'office', f, 60)); }
    assert(MAX_NAMED_FACILITIES === 20, '20');
    for (let i = 0; i < 20; i++) assert(applyAction(w, { type: 'name_facility', objectId: rooms[i].id, name: 'F' + i }).ok, 'facility ' + i);
    const refused = applyAction(w, { type: 'name_facility', objectId: rooms[20].id, name: 'No' });
    assert(!refused.ok && refused.reason === 'You may only name 20 tenants.', refused.reason);
    assert(facilityWindowModel(w, rooms[0].id).title === 'F0' && facilityWindowModel(w, rooms[0].id).named, 'the window shows the name');
    assert(applyAction(w, { type: 'name_facility', objectId: rooms[0].id, name: '' }).ok && facilityWindowModel(w, rooms[0].id).title === 'Office, Floor 1', 'delete returns the default');
    assert(!applyAction(w, { type: 'name_facility', objectId: 99_999, name: 'x' }).ok, 'nothing there');
  },

  'a person who has left the tower, or a facility that was demolished, no longer holds a slot'() {
    const w = liftedWorld({ stars: 3 });
    const rooms = [];
    for (let i = 0; i < 4; i++) rooms.push(build(w, 'office', 2 + i, 44));
    const people = rooms.flatMap((r) => actorsOf(w.tower, r));
    for (let i = 0; i < 20; i++) assert(applyAction(w, { type: 'name_person', actorId: people[i].id, name: 'P' + i }).ok, 'fill');
    assert(namedFacilities(w.tower).length === 0, 'no facilities named');
    assert(applyAction(w, { type: 'name_facility', objectId: rooms[0].id, name: 'Gone Soon' }).ok, 'name a room');
    const demolished = applyAction(w, { type: 'demolish', objectId: rooms[0].id });
    assert(demolished.ok, 'the unlet office can go: ' + demolished.reason);
    assert(namedPeople(w.tower).length < 20 && namedFacilities(w.tower).length === 0, 'its people and its name went with it: ' + namedPeople(w.tower).length);
    const survivor = actorsOf(w.tower, rooms[3])[0];
    assert(applyAction(w, { type: 'name_person', actorId: survivor.id, name: 'Room For One' }).ok, 'so there is room for another');
  },

  'names persist through save and load, and v11 files are refused'() {
    const w = liftedWorld({ stars: 3 });
    const office = build(w, 'office', 3, 44);
    const a = actorsOf(w.tower, office)[0];
    applyAction(w, { type: 'name_person', actorId: a.id, name: 'Grace' });
    applyAction(w, { type: 'name_facility', objectId: office.id, name: 'Head Office' });
    assert(SAVE_VERSION === 12, 'the shape changed, so the version moved');
    const blob = JSON.parse(JSON.stringify(snapshot(w)));
    const back = restore(blob);
    assert(back.ok, back.reason);
    assert(personName(back.world.tower, a.id) === 'Grace', 'the person\'s name');
    assert(facilityWindowModel(back.world, office.id).title === 'Head Office', 'the facility\'s name');
    assert(tenantWindowModel(back.world, a.id).title === 'Grace', 'and the window');
    // The cap still applies to a loaded tower: names count.
    assert(namedPeople(back.world.tower).length === 1, 'one name');
    const old = { ...blob, version: 11 };
    const refused = restore(old);
    assert(!refused.ok && /older version/.test(refused.reason), 'a v11 save is refused: ' + refused.reason);
  },
};
