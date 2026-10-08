/**
 * Express and service lifts, sky lobbies, and the zoning rule (issue #6).
 *
 * The thing worth proving is not that a button exists but that the *rule that
 * makes towers tall* holds: a standard lift cannot serve more than one zone, an
 * express lift reaches only the lobby levels, and a person reaches floor 40 only
 * by changing at a sky lobby. Spec: `specs/ELEVATORS.md`, `ROUTING.md`,
 * `COMMANDS.md`.
 */
import {
  LINK_KIND, SHAFT_KIND, applyAction, lobbyFloorReason, shaftSpanReason,
} from '../src/games/tower/sim/actions.js';
import { CARRIER_MODE } from '../src/games/tower/sim/elevators.js';
import { FAMILY, placeObject } from '../src/games/tower/sim/state.js';
import { ROUTE, rebuildRouteTables, resolveRouteBetweenFloors } from '../src/games/tower/sim/routing.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const clock = { dayTick: 500, daypart: 0, calendarPhase: false };

/** A world with 3 stars, plenty of cash and a wide ground lobby. */
function rich() {
  const w = newTowerWorld({ seed: 1 });
  w.tower.starCount = 3;
  w.ledger.cash = 90_000_000;
  return w;
}

const ok = (w, command) => {
  const r = applyAction(w, command);
  assert(r.ok, JSON.stringify(command) + ' refused: ' + r.reason);
  return r;
};

export const tests = {
  'the palette has all three shaft kinds, and the dearer two are locked behind stars'() {
    assert(Object.keys(SHAFT_KIND).join() === 'standard,service,express', 'standard, service, express');
    const w = newTowerWorld({ seed: 1 });
    const exp = applyAction(w, { type: 'build_shaft', kind: 'express', bottom: 0, top: 14, column: 40 });
    assert(!exp.ok && /star/i.test(exp.reason), 'express needs 3 stars: ' + exp.reason);
    const svc = applyAction(w, { type: 'build_shaft', kind: 'service', bottom: 0, top: 5, column: 40 });
    assert(!svc.ok && /star/i.test(svc.reason), 'service needs 2 stars: ' + svc.reason);
  },

  'an express shaft costs $400,000 and starts and ends only at a lobby level'() {
    const w = rich();
    const cash = w.ledger.cash;
    const r = ok(w, { type: 'build_shaft', kind: 'express', bottom: 0, top: 14, column: 40 });
    assert(cash - w.ledger.cash === 400_000, 'express is $400,000, spent ' + (cash - w.ledger.cash));
    assert(r.carrier.mode === CARRIER_MODE.EXPRESS && r.carrier.shaftWidth === 6, 'express mode, 6 tiles wide');

    const bad = shaftSpanReason(CARRIER_MODE.EXPRESS, 0, 20);
    assert(/stops only at the lobby/.test(bad ?? ''), 'floor 20 is not a stop: ' + bad);
    assert(shaftSpanReason(CARRIER_MODE.EXPRESS, -3, 89) === null, 'express has no 31-floor cap');
    assert(/at most 31/.test(shaftSpanReason(CARRIER_MODE.STANDARD, 0, 40) ?? ''), 'standard is capped');
  },

  'a service shaft costs $100,000 and an extra car costs $50,000'() {
    const w = rich();
    w.tower.starCount = 2;
    const cash = w.ledger.cash;
    const r = ok(w, { type: 'build_shaft', kind: 'service', bottom: 0, top: 8, column: 40 });
    assert(cash - w.ledger.cash === 100_000, 'service shaft is $100,000');
    const before = w.ledger.cash;
    ok(w, { type: 'add_car', carrierId: r.carrier.id });
    assert(before - w.ledger.cash === 50_000, 'a service car is $50,000, not the standard $80,000');
  },

  'lobbies go only on the ground and every 15th floor, and a sky lobby tells the router'() {
    assert(lobbyFloorReason(FAMILY.lobby, 0) === null && lobbyFloorReason(FAMILY.lobby, 29) === null, '0 and 29 are fine');
    assert(/every 15th floor/.test(lobbyFloorReason(FAMILY.lobby, 20) ?? ''), '20 is not');
    assert(lobbyFloorReason(FAMILY.office, 20) === null, 'the rule is about lobbies only');

    const w = rich();
    const bad = applyAction(w, { type: 'build', what: 'lobby', floor: 20, left: 40 });
    assert(!bad.ok, 'a lobby on floor 20 is refused');
    ok(w, { type: 'build', what: 'lobby', floor: 29, left: 40 });
    assert(w.tower.transferFloors.includes(29) && w.tower.routeTablesDirty, 'floor 29 is now a transfer floor');
    const gone = applyAction(w, { type: 'demolish', objectId: [...w.tower.objects.values()].find((o) => o.floor === 29).id });
    assert(!gone.ok && /cannot be removed/.test(gone.reason), 'lobbies cannot be bulldozed: ' + gone.reason);
  },

  '⚠️ zoning: floor 40 is reachable from the lobby only through a sky lobby, by express then local'() {
    const w = rich();
    // A wide lobby on the ground and at the sky lobby, so lifts land inside them.
    for (let left = 30; left < 70; left++) {
      ok(w, { type: 'build', what: 'lobby', floor: 29, left });
    }
    ok(w, { type: 'build_shaft', kind: 'express', bottom: 0, top: 29, column: 40 });
    ok(w, { type: 'build_shaft', kind: 'standard', bottom: 29, top: 59, column: 54 });

    // Something to ride to, on floor 40.
    const office = placeObject(w.tower, { family: FAMILY.office, floor: 40, left: 54, right: 59 }, () => createSimTripRecord());
    assert(office.ok, 'fixture: ' + office.reason);
    rebuildRouteTables(w.tower);

    const walker = { id: 'w', homeColumn: 54 };
    const up = resolveRouteBetweenFloors(w.tower, walker, 0, 40, clock);
    assert(up.code !== ROUTE.FAILED, 'floor 40 resolves by express to 29 then local: code ' + up.code);

    // The same tower with the sky lobby's transfer tag removed cannot make the change.
    w.tower.transferFloors = [];
    rebuildRouteTables(w.tower);
    const stranded = resolveRouteBetweenFloors(w.tower, walker, 0, 40, clock);
    assert(stranded.code === ROUTE.FAILED, 'with no transfer floor registered there is no way up: code ' + stranded.code);
  },

  'LINK_KIND and the shaft kinds do not collide on the palette'() {
    assert(!Object.keys(LINK_KIND).some((k) => k in SHAFT_KIND), 'distinct ids');
  },
};
