/**
 * Stairs and escalators (issue #5).
 *
 * `sim/routing.js` has routed over segments since the start; what was missing
 * was any way to PLACE one. The tests here are about the placement rules and
 * about that placement actually changing where people can go: a link that
 * parses and is stored but never reaches the router would pass every test about
 * its rules and do nothing.
 *
 * Spec: `specs/COMMANDS.md` § Stairs/escalator placement rules, `ROUTING.md`.
 */
import { LINK_KIND, LINK_WIDTH, applyAction, linkObstruction } from '../src/games/tower/sim/actions.js';
import { CONSTRUCTION_COST } from '../src/games/tower/sim/economy.js';
import { chargeableLinks } from '../src/games/tower/sim/ledger-adapter.js';
import { FAMILY, placeObject } from '../src/games/tower/sim/state.js';
import { ROUTE, buildWalkability, rebuildRouteTables, resolveRouteBetweenFloors } from '../src/games/tower/sim/routing.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const clock = { dayTick: 500, daypart: 0, calendarPhase: false };

const put = (world, family, floor, left, right) => {
  const r = placeObject(world.tower, { family, floor, left, right }, () => createSimTripRecord());
  assert(r.ok, 'fixture: ' + r.reason);
  return r.object;
};

/** A lobby on the ground and a floor of offices above it, both covering tiles 0..15. */
function world({ stars = 1, upper = FAMILY.office } = {}) {
  const w = newTowerWorld({ seed: 1 });
  w.tower.starCount = stars;
  put(w, FAMILY.lobby, 0, 0, 15);
  if (upper === FAMILY.office) { put(w, FAMILY.office, 1, 0, 5); put(w, FAMILY.office, 1, 6, 11); put(w, FAMILY.office, 1, 12, 17); }
  else put(w, upper, 1, 0, 15);
  return w;
}

export const tests = {
  'stairs cost $5,000, need floor under both ends, and stand on whatever is there'() {
    const w = world();
    const cash = w.ledger.cash;
    const r = applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 0 });
    assert(r.ok, 'stairs refused: ' + r.reason);
    assert(r.cost === 5000 && w.ledger.cash === cash - 5000, 'stairs are $5,000, with no floor-tile charge, got ' + r.cost);
    assert(w.tower.segments[0].active && w.tower.segments[0].kind === 'stairs', 'a stairs segment is stored');
    assert(w.tower.routeTablesDirty === true, 'the route tables are marked stale so the router sees it');

    const bare = applyAction(w, { type: 'build_link', kind: 'stairs', floor: 1, left: 0 });
    assert(!bare.ok && /nothing is built there on floor 2/.test(bare.reason), 'no floor above floor 1: ' + bare.reason);
    const off = applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 10 });
    assert(!off.ok, 'the lobby ends at tile 15, so an 8-wide link from tile 10 hangs off it: ' + off.reason);
  },

  'an escalator needs 3 stars and a shop, restaurant or lobby at BOTH ends'() {
    const locked = world({ stars: 2, upper: FAMILY.fastFood });
    const a = applyAction(locked, { type: 'build_link', kind: 'escalator', floor: 0, left: 0 });
    assert(!a.ok && /star/i.test(a.reason), 'locked until 3 stars: ' + a.reason);

    const offices = world({ stars: 3 });
    const b = applyAction(offices, { type: 'build_link', kind: 'escalator', floor: 0, left: 0 });
    assert(!b.ok && /shops, restaurants and lobbies/.test(b.reason), 'offices are not allowed under an escalator: ' + b.reason);

    const shop = world({ stars: 3, upper: FAMILY.fastFood });
    const cash = shop.ledger.cash;
    const c = applyAction(shop, { type: 'build_link', kind: 'escalator', floor: 0, left: 0 });
    assert(c.ok && cash - shop.ledger.cash === 20000, 'an escalator on a lobby and a fast food is $20,000: ' + (c.reason ?? c.cost));
  },

  'links cannot overlap each other or a lift, and there are at most 64'() {
    const w = world();
    assert(applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 0 }).ok, 'first');
    const twice = applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 4 });
    assert(!twice.ok && /over other transportation/.test(twice.reason), 'overlap: ' + twice.reason);

    const lifted = world();
    lifted.tower.carriers.push({ id: 1, mode: 1, bottomFloor: 0, topFloor: 5, column: 6 });
    const l = linkObstruction(lifted.tower, { kind: 'stairs', floor: 0, left: 0 });
    assert(/over other transportation/.test(l ?? ''), 'a lift in the way: ' + l);

    const full = world();
    full.tower.segments = Array.from({ length: 64 }, (_, i) => ({ active: true, kind: 'stairs', flags: 1, entryFloor: 90, left: (i % 15) * 10, column: 0 }));
    const m = linkObstruction(full.tower, { kind: 'stairs', floor: 0, left: 0 });
    assert(/limit is 64/.test(m ?? ''), '64 is the cap: ' + m);
  },

  'a link changes where people can go, and bulldozing it takes that away'() {
    const w = world();
    rebuildRouteTables(w.tower);
    const walker = { id: 'w', homeColumn: 4 };
    const before = resolveRouteBetweenFloors(w.tower, walker, 0, 1, clock);
    assert(before.code === ROUTE.FAILED, 'with no lift and no stairs there is no way up: ' + before.code);

    assert(applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 0 }).ok, 'build');
    rebuildRouteTables(w.tower);
    const after = resolveRouteBetweenFloors(w.tower, walker, 0, 1, clock);
    assert(after.code === ROUTE.LOCAL_LEG, 'with stairs the trip resolves as a local leg: ' + after.code);

    assert(applyAction(w, { type: 'demolish_link', index: 0 }).ok, 'bulldoze');
    rebuildRouteTables(w.tower);
    assert(resolveRouteBetweenFloors(w.tower, walker, 0, 1, clock).code === ROUTE.FAILED, 'bulldozed stairs no longer route');
    assert(buildWalkability(w.tower.segments).every((b) => b === 0), 'and leave no walkability behind');
  },

  'a bulldozed slot is reused and is not charged upkeep'() {
    const w = world({ stars: 3, upper: FAMILY.fastFood });
    applyAction(w, { type: 'build_link', kind: 'escalator', floor: 0, left: 0 });
    assert(chargeableLinks(w.tower).length === 1, 'a live escalator is charged upkeep');
    applyAction(w, { type: 'demolish_link', index: 0 });
    assert(chargeableLinks(w.tower).length === 0, 'a bulldozed one is not');
    const again = applyAction(w, { type: 'build_link', kind: 'stairs', floor: 0, left: 0 });
    assert(again.index === 0 && w.tower.segments.length === 1, 'the freed slot is reused, so route tokens never shift');
  },

  'the link table is what the palette is built from'() {
    assert(Object.keys(LINK_KIND).join() === 'stairs,escalator' && LINK_WIDTH === 8, 'two kinds, 8 tiles wide');
    assert(CONSTRUCTION_COST.stairs === 5000 && CONSTRUCTION_COST.escalator === 20000, 'prices come from the one table');
  },
};
