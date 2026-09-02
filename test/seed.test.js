/**
 * The opening tower — the one thing every player sees, and the only part of the
 * game no player built.
 *
 * ## Why a geometry test exists at all
 *
 * The sim has no opinion about what is *below* a room. Routing walks floors and
 * rides shafts; nothing anywhere asks whether a floor is standing on anything.
 * So a room placed in mid-air routes correctly, rents correctly, scores
 * correctly, and passes every test in this suite — and looks like a bug to the
 * first person who opens the page.
 *
 * That is exactly what happened. The lunch venue sat on F3 at columns 94..109
 * while the lobby stopped at 101 and F1/F2 were empty past 93, so sixteen tiles
 * of lit food court hung in the sky off the side of the building. 440 tests
 * were green over it. It was found by looking at a rendered frame.
 *
 * A test is the right home for this rather than a rule in `applyAction`,
 * because **a player is allowed to build a ledge** — cantilevers are a real
 * thing to want, and the reference does not forbid them. What the *seed* is not
 * allowed to do is open the game on one, because the opening tower is the
 * player's model of what a normal tower looks like.
 */
import { GROUND_FLOOR, isUnitLet } from '../src/games/tower/sim/state.js';
import { applyAction } from '../src/games/tower/sim/actions.js';
import { newTowerWorld, seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * Every column of `object` that has nothing directly beneath it.
 *
 * Floors at or below ground are exempt: a lobby stands on the earth and a
 * basement is dug into it, so "what holds this up" is not a question about the
 * floor below.
 */
function unsupportedColumns(tower, object) {
  if (object.floor <= GROUND_FLOOR) return [];
  const below = [...tower.objects.values()].filter((o) => o.floor === object.floor - 1);
  const covered = new Set();
  for (const o of below) for (let x = o.left; x <= o.right; x++) covered.add(x);
  const gaps = [];
  for (let x = object.left; x <= object.right; x++) if (!covered.has(x)) gaps.push(x);
  return gaps;
}

const describe = (o) => 'the ' + (o.familyName ?? 'family ' + o.family)
  + ' on F' + o.floor + ' at ' + o.left + '..' + o.right;

export const tests = {
  // ------------------------------------------------------- the new game

  /**
   * ⚠️ **The first ten minutes, and nothing else covered them.**
   *
   * The game opens on `newTowerWorld` — an empty lot with a ground lobby — and
   * every other test in this repo runs on `seedDemoWorld`, which arrives with
   * 48 rooms and a working lift already in place. So the entire path a real
   * player walks on their first day was untested: place a lift, place an
   * office, watch somebody move in.
   *
   * That is the exact shape this repo keeps getting caught by — the shipped
   * composition being the one thing no test exercises. `ui/main.js` calling an
   * unimported function, `seedDemoWorld` handing out a standalone ledger,
   * `restore()` flattening the ledger view: all three passed every test that
   * existed.
   *
   * Deliberately end to end and deliberately through `applyAction`, because
   * that is what a click does.
   */
  '⚠️ a player can build their first tower out of an empty lot'() {
    const world = newTowerWorld({ seed: 1 });
    const { tower } = world;
    assert(tower.objects.size === 1, 'a new game should open on a lobby and nothing else, not '
      + tower.objects.size + ' rooms');
    assert(tower.carriers.length === 0, 'and no lift — the player buys that');

    const lift = applyAction(world, { type: 'build_shaft', bottom: GROUND_FLOOR, top: 4, column: 72 });
    assert(lift.ok, 'the very first thing a player builds was refused: ' + lift.reason);

    const office = applyAction(world, { type: 'build', what: 'office', floor: 2, left: 60 });
    assert(office.ok, 'the second thing a player builds was refused: ' + office.reason);
    assert(office.object.occupants.length === 6, 'an office arrives with its six workers');

    const { scheduler } = makeDriver(world);
    for (let i = 0; i < 2600 * 4; i++) scheduler.tick(tower);

    assert(isUnitLet(office.object) && office.object.occupiedFlag,
      'four days on, nobody had moved into the only office in the tower — a new game is '
      + 'unplayable and every existing test would still pass, because they all start from '
      + 'a fixture that is already full');
    assert(tower.cash > 0, 'the player went broke building one office and one lift');
  },

  /**
   * And the negative, so the test above cannot pass on a tower that rents
   * things unconditionally: with no lift, that same office must NOT rent.
   *
   * ⚠️ Asserted on the **unit status band**, not on `occupiedFlag`. The flag is
   * the bootstrap latch, and the bootstrap is deliberately generous: an office
   * that has made no trips scores 0, which is the *best* grade, so the flag
   * opens for an office nobody can reach. Writing this the obvious way — "no
   * lift, so the flag stays down" — fails, and it fails for a reason that reads
   * like a bug in the sim rather than a bug in the test. It is neither: it is
   * `CLAUDE.md`'s "failures in the flattering direction", working as designed.
   */
  'and without a lift, that same office never rents'() {
    const world = newTowerWorld({ seed: 1 });
    const office = applyAction(world, { type: 'build', what: 'office', floor: 2, left: 60 });
    assert(office.ok, office.reason);

    const { scheduler } = makeDriver(world);
    for (let i = 0; i < 2600 * 4; i++) scheduler.tick(world.tower);

    assert(!isUnitLet(office.object),
      'an office on F2 was let with no lift and no stairs in the building');
    assert(!office.object.everRented,
      'and no worker ever resolved a route to it — `everRented` is the flag the rent hook sets');
  },

  '⚠️ nothing in the opening tower is standing on thin air'() {
    const { tower } = seedDemoWorld({ seed: 1 });
    const floating = [];
    for (const object of tower.objects.values()) {
      const gaps = unsupportedColumns(tower, object);
      if (gaps.length) floating.push(describe(object) + ' — ' + gaps.length + ' tiles over sky');
    }
    assert(floating.length === 0,
      'the opening tower has rooms hanging in the air, which is the first thing a player sees:\n  '
      + floating.join('\n  '));
  },

  /**
   * Bounded and negated. Without this, a helper that quietly returned `[]` for
   * everything would pass the test above forever and guard nothing — which is
   * the same shape as the bug it is here to catch.
   */
  'and the check can actually see a room in mid-air'() {
    const { tower } = seedDemoWorld({ seed: 1 });
    const upstairs = [...tower.objects.values()].find((o) => o.floor > GROUND_FLOOR + 1);
    assert(upstairs, 'the seed has no upper-floor room to test with');

    // The old venue position: out past the right edge of everything below it.
    const ledge = { ...upstairs, floor: upstairs.floor, left: 120, right: 135 };
    const gaps = unsupportedColumns(tower, ledge);
    assert(gaps.length === 16,
      'a room 16 tiles out over open sky reported ' + gaps.length + ' unsupported columns');
  },

  'and it does not cry wolf over the ground floor or the basements'() {
    const { tower } = seedDemoWorld({ seed: 1 });
    const underground = [...tower.objects.values()].filter((o) => o.floor <= GROUND_FLOOR);
    assert(underground.length > 0, 'the seed has nothing at or below ground to check');
    for (const o of underground) {
      assert(unsupportedColumns(tower, o).length === 0,
        describe(o) + ' was called unsupported — the earth holds it up, and a guard that '
        + 'cries wolf gets switched off');
    }
  },

  /**
   * A fixture property, pinned. The bank above the lift is what most of the
   * suite's "a stranded floor cannot rent" cases rely on; a fixture that
   * quietly stopped stranding anything would still pass every other test here
   * while silently weakening the ones built on it.
   */
  'the measurement fixture still strands exactly one bank above the lift'() {
    const { tower } = seedDemoWorld({ seed: 1 });
    const lift = tower.carriers[0];
    const stranded = [...tower.objects.values()].filter((o) => o.occupants.length && o.floor > lift.topFloor);
    assert(stranded.length > 0, 'nothing is above the lift any more — the seed stopped teaching');
    const floors = new Set(stranded.map((o) => o.floor));
    assert(floors.size === 1,
      'the seed strands ' + floors.size + ' floors. One is a lesson; several is a broken tower.');
  },
};
