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
import { GROUND_FLOOR } from '../src/games/tower/sim/state.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';

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
   * The seed's own lesson, pinned. The bank above the lift is the one
   * deliberate failure in the opening tower; a seed that quietly stopped
   * stranding anything would still pass every other test here and would have
   * stopped teaching the only thing it exists to teach.
   */
  'the opening tower still strands exactly one bank above the lift'() {
    const { tower } = seedDemoWorld({ seed: 1 });
    const lift = tower.carriers[0];
    const stranded = [...tower.objects.values()].filter((o) => o.occupants.length && o.floor > lift.topFloor);
    assert(stranded.length > 0, 'nothing is above the lift any more — the seed stopped teaching');
    const floors = new Set(stranded.map((o) => o.floor));
    assert(floors.size === 1,
      'the seed strands ' + floors.size + ' floors. One is a lesson; several is a broken tower.');
  },
};
