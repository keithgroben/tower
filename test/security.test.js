/**
 * The security office and the 2 -> 3 star gate (issue #12).
 *
 * The assertions that matter run through the **composition** - `newTowerWorld`,
 * `applyAction`, the driver's own scheduler, the real router - and never through
 * a ledger or a gate the test built:
 *
 *   - a tower with every other 3-star requirement and no security office STAYS at
 *     two stars, and says *"a security office"*; the same tower with one reaches
 *     three (`starLadderTrial`, the same function `harness/playtest.js --stars`
 *     prints, so the harness and this file cannot disagree about what was run);
 *   - the office is basement-only, two stars, $100,000, $20,000 a pass, at most
 *     ten, six guards, and cannot be bulldozed - and the build ghost says the same
 *     words as the seam for every one of those refusals;
 *   - the guards use the outside emergency stairs and **never a lift**: the route
 *     function is handed a tower whose lifts, stairs and route tables throw if
 *     read, and the router (housekeeping mode) is shown to *prefer* the lift the
 *     guards must not touch.
 *
 * Spec: `specs/GAME-STATE.md` § Star Advancement, `specs/COMMANDS.md` (basement-
 * only, cap 10), `specs/ECONOMY.md`, `specs/TIME.md` § 2500, `specs/EVENTS.md`;
 * the original's help file for the emergency stairs and for "cannot be removed".
 */
import {
  EMERGENCY_STAIRS_TICKS_PER_FLOOR, GUARD_STATE, MAX_SECURITY_OFFICES, SECURITY_GUARDS,
  SECURITY_OFFICES_FOR_THREE_STARS, SECURITY_WIDTH, emergencyStairsExtent, emergencyStairsRoute, guardResponse,
  guards, securityNightReset, securityObstruction, securityOffices,
} from '../src/games/tower/sim/security.js';
import {
  FAMILY, OBJECT_TYPE, OCCUPANTS, POPULATION_CONTRIBUTION, __resetIds, createTower, isStaff, isStaffFamily,
  placeObject, population,
} from '../src/games/tower/sim/state.js';
import {
  CONSTRUCTION_COST, TYPE_CODES, applyPeriodicOperatingExpenses, createLedger, placementCost,
} from '../src/games/tower/sim/economy.js';
import {
  STAR_REQUIREMENT, lockReason, notePlacement, refreshPlacementGates, starGateStatus, starGatesOf, tryAdvanceStar,
} from '../src/games/tower/sim/progression.js';
import { BUILDABLE, applyAction, demolishRefusal, gradeReason, placementObstruction } from '../src/games/tower/sim/actions.js';
import { chargeableItems } from '../src/games/tower/sim/ledger-adapter.js';
import { rebuildRouteTables, selectBestRouteCandidate } from '../src/games/tower/sim/routing.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { objectSprite } from '../src/games/tower/render/canvas.js';
import { TOOLS, preview, toolById } from '../src/games/tower/ui/build.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import { greedyBuilder, starLadderTrial } from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** A world at `stars` with plenty of money, an empty lot and a lift to the 5th floor. */
function world({ stars = 2, cash = 90_000_000, lift = true } = {}) {
  __resetIds();
  const w = newTowerWorld({ seed: 1, cash: Math.max(cash, 5_000_000) });
  w.tower.starCount = stars;
  if (lift) {
    const r = applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: 0, top: 5, column: 40 });
    assert(r.ok, 'fixture: the lift: ' + r.reason);
  }
  w.tower.cash = cash;                                           // the lift is paid for; now the purse the test wants
  return w;
}

const build = (w, floor, left = 60) => applyAction(w, { type: 'build', what: 'security', floor, left });
const ghost = (w, floor, left = 60) => preview(w, toolById('security'), { floor, tile: left });

export const tests = {
  // ------------------------------------------------------------------ the facts

  'the numbers are the spec\'s: $100,000, two stars, $20,000 a pass, ten, six guards'() {
    assert(CONSTRUCTION_COST.security === 100_000, 'build cost $' + CONSTRUCTION_COST.security);
    assert(STAR_REQUIREMENT.security === 2, 'unlocks at ' + STAR_REQUIREMENT.security);
    assert(MAX_SECURITY_OFFICES === 10, 'cap ' + MAX_SECURITY_OFFICES);
    assert(SECURITY_GUARDS === 6 && OCCUPANTS[FAMILY.security] === 6, 'six guards');
    assert(BUILDABLE.security.width === SECURITY_WIDTH && SECURITY_WIDTH === 16, 'width');
    const ledger = createLedger({ cash: 1_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, { items: [{ type: 'security' }] });
    assert(spent === 20_000 && ledger.expense.security === 20_000, 'upkeep $' + spent);
  },

  '⚠️ the family, the placed type and the economy\'s type code are ONE number (0x0e)'() {
    // `CLAUDE.md`: two modules naming one concept twice. `progression.js` reads the
    // economy's code, `actions.js` places the family; if they ever differ the gate
    // silently never latches (the placement is a different thing from the one the
    // gate is looking for).
    assert(FAMILY.security === 0x0e && OBJECT_TYPE.security === 0x0e && TYPE_CODES.security === 0x0e,
      'security is ' + [FAMILY.security, OBJECT_TYPE.security, TYPE_CODES.security].join(' / '));
  },

  // ------------------------------------------------------------------ the palette

  'it is on the palette, and the goal clause can say "waiting on" (a security office is buildable)'() {
    const tool = TOOLS.find((t) => t.id === 'security');
    assert(tool && tool.action === 'build' && tool.what === 'security' && tool.width === 16, 'a build tool, 16 wide');
    assert(Object.hasOwn(BUILDABLE, 'security'), 'the HUD asks BUILDABLE.hasOwn(kind) with the blocker\'s kind');
    const w = world();
    const blocker = starGateStatus(w.tower).blockerDetails.find((b) => b.kind === 'security');
    assert(blocker, 'the 2 -> 3 blocker carries kind "security"');
    assert(Object.hasOwn(BUILDABLE, blocker.kind), 'and that kind is a key of BUILDABLE');
  },

  // ------------------------------------------------------------------ placement

  '⚠️ it is a two-star tool: a one-star tower is told the lock, before the price'() {
    const w = world({ stars: 1, cash: 100 });                    // locked AND unaffordable
    const seam = build(w, -1);
    assert(!seam.ok && seam.reason === lockReason(w.tower, 'security', 'Security Office'), 'the seam said: ' + seam.reason);
    assert(!/\$/.test(seam.reason), 'a lock quotes no price: ' + seam.reason);
    const g = ghost(w, -1);
    assert(!g.ok && g.reason === seam.reason, 'ghost: ' + g.reason);
    assert(securityOffices(w.tower).length === 0, 'nothing was built');
  },

  '⚠️ basement-only: every floor from the ground up is refused, every basement floor accepted - ghost and seam in the same words'() {
    const w = world();
    const verdicts = [];
    for (const floor of [5, 1, 0]) {
      const g = ghost(w, floor);
      const s = build(w, floor);
      assert(!s.ok, 'F' + floor + ' was built: security is basement-only');
      assert(/basement/.test(s.reason), 'the reason names the basement: ' + s.reason);
      assert(g.ok === false && g.reason === s.reason, `F${floor}: ghost said "${g.reason}", seam said "${s.reason}"`);
      assert(gradeReason(BUILDABLE.security, floor) === s.reason, 'one definition');
      verdicts.push(s.ok);
    }
    for (const floor of [-1, -5, -10]) {
      const g = ghost(w, floor, floor * -10);
      assert(g.ok === true, `B${-floor}: the ghost refused a legal basement: ${g.reason}`);
      const s = build(w, floor, floor * -10);
      assert(s.ok, `B${-floor}: the seam refused a legal basement: ${s.reason}`);
    }
    assert(securityOffices(w.tower).length === 3, 'three basement offices stand');
  },

  'it costs $100,000 plus the sixteen floor tiles it stands on, and the ghost quotes the same'() {
    const w = world();
    const g = ghost(w, -1);
    const before = w.tower.cash;
    const s = build(w, -1);
    assert(s.ok && s.cost === g.cost, `ghost quoted ${g.cost}, seam charged ${s.cost}`);
    assert(before - w.tower.cash === s.cost, 'the cash moved by the quoted amount');
    assert(s.cost === placementCost('security', { tiles: 16, floor: -1, lobbyHeight: 1 }), 'the economy\'s own price');
    assert(s.cost >= 100_000, 'at least the facility');
  },

  'a poor player is told the price; the office is not built'() {
    const w = world({ cash: 100_000, lift: false });
    const s = build(w, -1);
    assert(!s.ok && /\$/.test(s.reason), 'the refusal quotes a price: ' + s.reason);
    assert(securityOffices(w.tower).length === 0, 'nothing built');
  },

  '⚠️ at most ten offices: the eleventh is refused, ghost and seam in the same words'() {
    const w = world();
    for (let i = 0; i < MAX_SECURITY_OFFICES; i++) {
      const s = applyAction(w, { type: 'build', what: 'security', floor: -1 - (i % 5), left: (i < 5 ? 0 : 80) });
      assert(s.ok, 'office ' + (i + 1) + ': ' + s.reason);
    }
    assert(securityOffices(w.tower).length === 10, 'ten stand');
    const s = applyAction(w, { type: 'build', what: 'security', floor: -6, left: 0 });
    const g = preview(w, toolById('security'), { floor: -6, tile: 0 });
    assert(!s.ok && /at most 10/.test(s.reason), 'the eleventh: ' + JSON.stringify(s));
    assert(!g.ok && g.reason === s.reason, `ghost "${g.reason}" vs seam "${s.reason}"`);
    assert(securityObstruction(w.tower) === s.reason, 'one definition');
    assert(placementObstruction(w.tower, BUILDABLE.security, -6, 0) === s.reason, 'and the shared obstruction');
    // The cap is on security alone: an office, a hotel, anything else still builds.
    assert(applyAction(w, { type: 'build', what: 'office', floor: 1, left: 0 }).ok, 'other families are not capped by it');
  },

  // ------------------------------------------------------------------ the guards

  'six guards come with the office, at 0x01, and they are staff - not people, not stressed'() {
    const w = world();
    const s = build(w, -1);
    assert(s.ok, s.reason);
    const mine = guards(w.tower);
    assert(mine.length === 6 && mine.every((a) => a.objectId === s.object.id), 'six guards of this office');
    assert(mine.every((a) => a.family === FAMILY.security && a.state === GUARD_STATE.onDuty && a.state === 0x01),
      'every guard starts on duty (0x01), not in the unplaced-worker 0x20');
    assert(mine.every(isStaff) && isStaffFamily(FAMILY.security), 'staff');
    assert(POPULATION_CONTRIBUTION[FAMILY.security] === 0, 'an explicit 0 - a missing key falls back to OCCUPANTS');
    assert(population(w.tower) === 0, 'population ' + population(w.tower) + ': the guards were counted as residents');
    assert(mine.map((a) => a.occupantIndex).join() === '0,1,2,3,4,5', 'slots 0..5');
  },

  'upkeep is charged per office, through the real expense sweep, with no further wiring'() {
    const w = world();
    build(w, -1, 0); build(w, -1, 40);
    const items = chargeableItems(w.tower).filter((i) => i.type === 'security');
    assert(items.length === 2, 'the sweep offers both offices: ' + JSON.stringify(items));
    const ledger = createLedger({ cash: 1_000_000 });
    const spent = applyPeriodicOperatingExpenses(ledger, { items: chargeableItems(w.tower) });
    assert(spent === 40_000, 'two offices cost $' + spent + ' a pass, spec says $20,000 each');
  },

  // ---------------------------------------------------------- cannot be bulldozed

  '⚠️ it cannot be bulldozed - the seam and the ghost say the same words, and the guards stay'() {
    const w = world();
    const office = build(w, -1).object;
    const seam = applyAction(w, { type: 'demolish', objectId: office.id });
    assert(!seam.ok && seam.reason === 'security offices cannot be bulldozed', 'the seam said: ' + JSON.stringify(seam));
    assert(w.tower.objects.has(office.id), 'still standing');
    assert(guards(w.tower).length === 6, 'with its six guards');
    const g = preview(w, toolById('demolish'), { floor: office.floor, tile: office.left, object: office });
    assert(!g.ok && g.reason === seam.reason, `ghost "${g.reason}" vs seam "${seam.reason}"`);
    assert(demolishRefusal(office) === seam.reason, 'one definition');
    // The refusal is not "let": the wrong reason would be "you cannot evict a tenant".
    assert(!/tenant|let/.test(seam.reason), 'not the tenant reason');
    // And housekeeping's rule is untouched beside it.
    const hk = applyAction(w, { type: 'build', what: 'housekeeping', floor: 1, left: 60 });
    assert(hk.ok && demolishRefusal(hk.object) === 'housekeeping cannot be bulldozed', 'housekeeping still says its own words');
  },

  // ------------------------------------------------------------- the star gate

  '⚠️ 2 -> 3: with everything else in place and NO security office the tower stays at two stars, and says why'() {
    // The unit-level half: a tower whose activity is far past the threshold.
    const w = world();
    w.tower.populationLedger = { office: 5000 };
    w.tower.clock.daypart = 5;
    const status = starGateStatus(w.tower);
    assert(status.activityReady, 'fixture: the activity gate is open');
    assert(status.blockers.join() === 'a security office', 'the only blocker is: ' + status.blockers.join(' | '));
    assert(status.blockerDetails[0].kind === 'security', 'and it says what KIND of thing to build');
    for (let i = 0; i < 5; i++) assert(!tryAdvanceStar(w.tower).advanced, 'advanced without security');
    assert(w.tower.starCount === 2, 'still two stars');

    // ...and placing one opens it, through the seam, immediately.
    const placed = build(w, -1);
    assert(placed.ok, placed.reason);
    assert(starGatesOf(w.tower).securityPlaced === true, 'the gate latched at placement, not at the next start of day');
    assert(starGateStatus(w.tower).ready, 'ready: ' + starGateStatus(w.tower).blockers.join(' | '));
    assert(tryAdvanceStar(w.tower).advanced && w.tower.starCount === 3, 'three stars');
  },

  '⚠️ the whole ladder, in the real driver: stalls at 2 stars without security, reaches 3 the day after it is placed'() {
    const without = starLadderTrial({ security: false, days: 6 });
    const withIt = starLadderTrial({ security: true, days: 6 });

    // Both towers earn the activity: 250 offices let by real routes.
    assert(without.peakActivity >= 1000 && withIt.peakActivity >= 1000,
      `the fixture never crossed the threshold (${without.peakActivity} / ${withIt.peakActivity}) - a gate that held ` +
      'back a tower that could not pass anyway would prove nothing');
    assert(without.twoStarDay !== null && withIt.twoStarDay === without.twoStarDay, 'both reach two stars, the same day');

    // The stall: days at two stars with the activity in hand, one blocker.
    assert(without.finalStar === 2 && without.threeStarDay === null, 'WITHOUT security the tower reached ' + without.finalStar);
    assert(without.daysPastThreshold >= 3, 'it sat past the threshold for ' + without.daysPastThreshold + ' day(s)');
    assert(without.perDay.filter((r) => r.activity >= 1000).every((r) => r.star === 2
      && r.blockers.join() === 'a security office'), 'every one of those days the one blocker was "a security office"');

    // The pass.
    assert(withIt.threeStarDay === withIt.securityDay + 1, `three stars on day ${withIt.threeStarDay}, security placed day ${withIt.securityDay}`);
    assert(withIt.finalStar === 3, 'ended at ' + withIt.finalStar);
    assert(withIt.earlyRefusal && /2 stars/.test(withIt.earlyRefusal), 'at one star it was refused: ' + withIt.earlyRefusal);
    assert(withIt.securityCost >= 100_000 && withIt.securityCost <= 120_000, 'it cost ' + withIt.securityCost);
  },

  'the gate latches: it is "ever placed", not "standing now", and a save keeps it'() {
    const w = world();
    const placed = build(w, -1);
    assert(placed.ok, placed.reason);
    // Not reachable through the game (it cannot be bulldozed) but the latch is the
    // rule: a fire or a bomb that took the office would not drop the star count's
    // prerequisites any more than losing a metro station does.
    w.tower.objects.delete(placed.object.id);
    refreshPlacementGates(w.tower);
    assert(starGatesOf(w.tower).securityPlaced === true, 'the latch survived the object');

    const blob = JSON.parse(JSON.stringify(snapshot(w)));
    const loaded = restore(blob);
    assert(loaded.ok, loaded.reason);
    assert(starGatesOf(loaded.world.tower).securityPlaced === true, 'and the save');
  },

  'an object placed outside applyAction (a loaded tower, a fixture) still opens the gate at start of day'() {
    __resetIds();
    const tower = createTower();
    tower.starCount = 2;
    const placed = placeObject(tower, { family: FAMILY.security, floor: -2, left: 10, right: 25 }, () => createSimTripRecord());
    assert(placed.ok, placed.reason);
    assert(!starGatesOf(tower).securityPlaced, 'fixture: not yet latched');
    refreshPlacementGates(tower);
    assert(starGatesOf(tower).securityPlaced === true, 'the daily sweep latched it');
  },

  'the count the gate asks for is ONE constant, and notePlacement honours it'() {
    assert(SECURITY_OFFICES_FOR_THREE_STARS === 1, 'the spec says placed (A49)');
    const tower = createTower();
    notePlacement(tower, FAMILY.security);
    assert(starGatesOf(tower).securityPlaced, 'one placement is enough');
    const other = createTower();
    notePlacement(other, FAMILY.office);
    assert(!starGatesOf(other).securityPlaced, 'an office did not latch the security gate');
  },

  // --------------------------------------------------------- emergency stairs

  '⚠️ the guards never touch a lift: the route is the building\'s floors and nothing else'() {
    const w = world();
    // A building with floors from B2 up to F8.
    for (const [floor, left] of [[-2, 0], [3, 100], [8, 100]]) {
      const r = applyAction(w, { type: 'build', what: floor < 0 ? 'security' : 'office', floor, left });
      assert(r.ok, `fixture F${floor}: ${r.reason}`);
    }
    const open = emergencyStairsRoute(w.tower, -2, 8);
    assert(open.ok && open.floors === 10 && open.ticks === 10 * EMERGENCY_STAIRS_TICKS_PER_FLOOR, JSON.stringify(open));
    assert(open.ridesCarriers === false, 'a stated fact, not a comment');

    // The same answer from a tower whose lifts, stairs and route tables EXPLODE if
    // they are read. It cannot have consulted them.
    const guarded = Object.create(w.tower);
    for (const key of ['carriers', 'segments', 'routeTables', 'transferFloors']) {
      Object.defineProperty(guarded, key, { get() { throw new Error('the guard route read tower.' + key); } });
    }
    const same = emergencyStairsRoute(guarded, -2, 8);
    assert(JSON.stringify(same) === JSON.stringify(open), 'a tower with no readable lifts answered differently');

    // ...and a tower with NO lifts at all answers the same as one with a lift.
    const bare = world({ lift: false });
    for (const [floor, left] of [[-2, 0], [3, 100], [8, 100]]) {
      applyAction(bare, { type: 'build', what: floor < 0 ? 'security' : 'office', floor, left });
    }
    assert(bare.tower.carriers.length === 0, 'fixture: no lifts');
    assert(emergencyStairsRoute(bare.tower, -2, 8).ticks === open.ticks, 'the lift changed nothing');
  },

  '⚠️ the contrast: housekeeping mode WOULD ride a service elevator here - which is exactly what guards must not do'() {
    const w = world({ lift: false });
    const service = applyAction(w, { type: 'build_shaft', kind: 'service', bottom: -3, top: 9, column: 40 });
    assert(service.ok, service.reason);
    const office = build(w, -2, 60).object;
    applyAction(w, { type: 'build', what: 'office', floor: 9, left: 100 });
    rebuildRouteTables(w.tower);
    // The router, in the staff mode housekeeping uses, takes the service elevator.
    const staffRoute = selectBestRouteCandidate(w.tower, -2, 9, false);
    assert(staffRoute && staffRoute.kind === 'carrier', 'fixture: a service elevator is a staff route: ' + JSON.stringify(staffRoute));
    // The guards' route is not that route.
    const guardRoute = emergencyStairsRoute(w.tower, office.floor, 9);
    assert(guardRoute.ok && guardRoute.ridesCarriers === false, 'the guards climb: ' + JSON.stringify(guardRoute));
    // Nothing was queued anywhere by asking.
    for (const carrier of w.tower.carriers) {
      for (const car of carrier.cars) assert(!car.passengers?.length, 'a car carries somebody');
    }
  },

  'the route is the building: a floor nothing stands on cannot be reached, and a bare lot has no stairs'() {
    __resetIds();
    const bare = createTower();
    assert(emergencyStairsExtent(bare) === null, 'no building, no stairs');
    assert(!emergencyStairsRoute(bare, 0, 3).ok, 'nowhere to go on a bare lot');

    const w = world();
    build(w, -1);
    applyAction(w, { type: 'build', what: 'office', floor: 4, left: 100 });
    assert(emergencyStairsRoute(w.tower, -1, 4).ok, 'to the top floor');
    const above = emergencyStairsRoute(w.tower, -1, 5);
    assert(!above.ok && /building/.test(above.reason), 'above the building: ' + JSON.stringify(above));
    assert(!emergencyStairsRoute(w.tower, -1, 500).ok, 'outside the tower altogether');
    const here = emergencyStairsRoute(w.tower, 4, 4);
    assert(here.ok && here.ticks === 0 && here.floors === 0, 'same floor costs nothing');
    // B1 is a real floor: the sentinel trap. `-1` must not read as "none".
    assert(emergencyStairsRoute(w.tower, -1, -1).ok, 'B1 to B1 is a route, not a refusal');
  },

  'closeness matters: guardResponse ranks offices by how far up or down the stairs they must go'() {
    const w = world();
    const far = build(w, -5, 0).object;
    const near = build(w, -1, 40).object;
    applyAction(w, { type: 'build', what: 'office', floor: 4, left: 100 });
    const r = guardResponse(w.tower, 4);
    assert(r.count === 2 && r.reachable === 2, 'both offices count');
    assert(r.offices[0].officeId === near.id && r.offices[1].officeId === far.id, 'the nearer office answers first');
    assert(r.nearestTicks === 5 * EMERGENCY_STAIRS_TICKS_PER_FLOOR, 'nearest ' + r.nearestTicks);
    assert(r.offices[1].ticks === 9 * EMERGENCY_STAIRS_TICKS_PER_FLOOR, 'far ' + r.offices[1].ticks);
    // A fire above the building: nobody can reach it, but the count is still there.
    const none = guardResponse(w.tower, 40);
    assert(none.count === 2 && none.reachable === 0 && none.nearestTicks === null, JSON.stringify(none));
    // No offices: an honest zero, not a crash.
    const empty = guardResponse(world().tower, 3);
    assert(empty.count === 0 && empty.nearestTicks === null, JSON.stringify(empty));
  },

  // ------------------------------------------------------ the driver, the night

  'through the driver: guards stay on duty, never queue for a lift, and are paid for in upkeep'() {
    const w = world({ lift: false });
    const shaft = applyAction(w, { type: 'build_shaft', kind: 'standard', bottom: -2, top: 6, column: 40 });
    assert(shaft.ok, shaft.reason);
    for (const floor of [1, 2, 3]) applyAction(w, { type: 'build', what: 'office', floor, left: 60 });
    const office = build(w, -2, 60).object;
    rebuildRouteTables(w.tower);
    const { scheduler } = makeDriver(w);
    for (let t = 0; t < 3 * 2600; t++) scheduler.tick(w.tower);
    const mine = guards(w.tower);
    assert(mine.length === 6, 'six guards');
    for (const guard of mine) {
      assert(guard.state === 0x01, 'a guard left 0x01: ' + guard.state);
      assert(!guard.route && !guard.waitingFloor && guard.routeCarrier == null, 'a guard was routed: ' + JSON.stringify(guard.route));
    }
    for (const carrier of w.tower.carriers) {
      for (const slot of carrier.queues ?? []) {
        const text = JSON.stringify(slot ?? null);
        for (const guard of mine) assert(!text.includes('"' + guard.id + '"') , 'a guard is in a lift queue');
      }
    }
    assert(w.tower.objects.has(office.id), 'and the office stands');
    // The upkeep is offered to the same expense sweep everything else is.
    const ledger = createLedger({ cash: 1_000_000 });
    assert(applyPeriodicOperatingExpenses(ledger, { items: chargeableItems(w.tower) }) >= 20_000, 'upkeep is in the sweep');
  },

  'checkpoint 2500 puts the guards back on duty, through the driver\'s own key (one key, chained)'() {
    const w = world();
    build(w, -1);
    const mine = guards(w.tower);
    mine[0].state = 0x45; mine[0].targetFloor = 7; mine[0].waitingFloor = 3; mine[0].route = { mode: 'carrier' }; mine[0].anchorFloor = 7;
    const { scheduler } = makeDriver(w);
    w.tower.clock.dayTick = 2498;
    scheduler.tick(w.tower); scheduler.tick(w.tower);
    assert(w.tower.clock.dayTick === 2500, 'fixture: at 2500, got ' + w.tower.clock.dayTick);
    assert(mine[0].state === 0x01 && mine[0].targetFloor === null && mine[0].waitingFloor === null && mine[0].route === null,
      'the guard was not reset: ' + JSON.stringify(mine[0]));
    assert(mine[0].anchorFloor === -1, 'and is back at the office floor');
    // The other families' 2500 work still happens (the key was chained, not replaced).
    const direct = createTower();
    securityNightReset(direct);                                  // a tower with no guards: a no-op, not a crash
  },

  // ----------------------------------------------------------------- the picture

  'the office draws its own sheet, day and night, and is not a coloured rectangle'() {
    const w = world();
    const office = build(w, -1).object;
    assert(objectSprite(office, { night: false })?.name === 'security' && objectSprite(office, { night: false }).animation === 'day', 'day');
    assert(objectSprite(office, { night: true })?.animation === 'night', 'night');
  },

  // ------------------------------------------------------------------ the save

  'the save moved to v6, and an office with its guards survives a save and a load'() {
    assert(SAVE_VERSION >= 6, 'the rules changed (issue #12), so the version moved: ' + SAVE_VERSION);
    const w = world();
    const placed = build(w, -3, 20);
    assert(placed.ok, placed.reason);
    const blob = JSON.parse(JSON.stringify(snapshot(w)));
    const loaded = restore(blob);
    assert(loaded.ok, 'the save would not load: ' + loaded.reason);
    const t2 = loaded.world.tower;
    assert(securityOffices(t2).length === 1 && guards(t2).length === 6, 'office and six guards came back');
    assert(guards(t2).every((a) => a.state === 0x01 && a.family === FAMILY.security), 'on duty');
    assert(demolishRefusal(securityOffices(t2)[0]) === 'security offices cannot be bulldozed', 'still unremovable');
    // v5 saves are refused rather than resumed into a different game.
    const old = JSON.parse(JSON.stringify(blob));
    old.version = 5;
    assert(!restore(old).ok, 'a v5 save was accepted');
  },

  // ------------------------------------------------------------------- SECOM

  'SECOM is not built, on purpose (spec/DEVIATIONS.md A50): priced and coded in the economy, absent from the palette'() {
    assert(TYPE_CODES.secom === 0x11 && CONSTRUCTION_COST.secom === 100_000, 'the reference\'s code and price are kept');
    assert(!Object.hasOwn(BUILDABLE, 'secom') && !TOOLS.some((t) => /secom/i.test(t.id + t.label)),
      'a SECOM nobody specified the behaviour of is on the palette');
    assert(!('secom' in STAR_REQUIREMENT), 'and it unlocks at no star');
  },

  // ----------------------------------------------------------------- the player

  'the greedy player buys one at two stars, and --no-security is the one who never does'() {
    const withIt = newTowerWorld({ seed: 1, cash: 90_000_000 });
    const act = greedyBuilder(withIt, { condos: false, hotels: false, security: true });
    withIt.tower.starCount = 1;
    assert(!/security/.test(act() ?? ''), 'it did not try at one star');
    const lift = applyAction(withIt, { type: 'build_shaft', kind: 'standard', bottom: 0, top: 3, column: 40 });
    assert(lift.ok, lift.reason);
    withIt.tower.starCount = 2;
    const did = act();
    assert(/security office on B/.test(did ?? ''), 'it bought one: ' + did);
    assert(securityOffices(withIt.tower).length === 1, 'exactly one');
    const again = act();
    assert(!/security/.test(again ?? ''), 'and only one: ' + again);
  },
};
