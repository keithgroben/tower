/**
 * The command seam — `applyAction()`, the one door into the tower.
 *
 * Two things these tests exist to hold. **A refused command must change
 * nothing**, cash included: a player charged for a building that does not
 * appear would never trust the game again. And **the shaft rules live here**,
 * because the interface reported "passes through 12 rooms" as a *consequence*
 * while the sim happily allowed it — a rule the sim does not have is a rule in
 * two places waiting to disagree.
 */
import {
  SHAFT_SEPARATION, applyAction, shaftClearance, shaftObstruction,
} from '../src/games/tower/sim/actions.js';
import { createTower, isRented } from '../src/games/tower/sim/state.js';
import { CARRIER_MODE, MAX_SERVED_SPAN } from '../src/games/tower/sim/elevators.js';
import { createLedger } from '../src/games/tower/sim/economy.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const world = (cash = 5_000_000) => ({ tower: createTower(), ledger: createLedger({ cash }) });

export const tests = {
  // ------------------------------------------------------------- the seam

  'a refused command changes nothing, cash included'() {
    const w = world(100);
    const before = { cash: w.ledger.cash, objects: w.tower.objects.size, actors: w.tower.actors.length };

    const result = applyAction(w, { type: 'build', what: 'office', floor: 1, left: 20 });
    assert(!result.ok, 'an office was built with $100');
    assert(/\$100/.test(result.reason), 'the refusal should say what you have: ' + result.reason);
    assert(w.ledger.cash === before.cash, 'cash moved on a refused command');
    assert(w.tower.objects.size === before.objects, 'an object appeared on a refused command');
    assert(w.tower.actors.length === before.actors, 'actors appeared on a refused command');
  },

  'an unknown command is answered, not thrown'() {
    const result = applyAction(world(), { type: 'demolish_the_moon' });
    assert(!result.ok && typeof result.reason === 'string', 'an unknown command must answer with a reason');
  },

  'building costs money and the money leaves'() {
    const w = world();
    const before = w.ledger.cash;
    const built = applyAction(w, { type: 'build', what: 'office', floor: 1, left: 20 });
    assert(built.ok, built.reason);
    assert(built.cost > 0, 'an office should cost something');
    assert(w.ledger.cash === before - built.cost, 'the charge and the balance disagree');
    assert(w.tower.actors.length === 6, 'placing an office should create its six workers');
  },

  'a let unit cannot be demolished out from under its tenant'() {
    const w = world();
    const built = applyAction(w, { type: 'build', what: 'office', floor: 1, left: 20 });
    built.object.unitStatus = 0;                       // what a resolved route does
    assert(isRented(built.object.unitStatus), 'fixture is not let');

    const result = applyAction(w, { type: 'demolish', objectId: built.object.id });
    assert(!result.ok && /let|tenant/.test(result.reason), 'a tenant was evicted by a click');
    assert(w.tower.objects.size === 1, 'the office went anyway');

    built.object.unitStatus = 0x10;                    // vacant again
    assert(applyAction(w, { type: 'demolish', objectId: built.object.id }).ok, 'a vacant unit must clear');
    assert(w.tower.actors.length === 0, 'demolishing left its workers behind');
  },

  // ----------------------------------------------------------- shaft rules

  /**
   * `specs/COMMANDS.md` § Elevator placement rules. Nothing checked any of this
   * until a palette existed and a player could aim a lift at their own offices.
   */
  'a lift cannot be sunk through occupied rooms'() {
    const w = world();
    applyAction(w, { type: 'build', what: 'office', floor: 1, left: 20 });
    const through = applyAction(w, { type: 'build_shaft', bottom: 0, top: 3, column: 21 });
    assert(!through.ok, 'a lift was sunk straight through an office');
    assert(/not clear|room/.test(through.reason), 'the refusal should name the obstruction: ' + through.reason);
    assert(w.ledger.cash === 5_000_000 - 43_000, 'a refused shaft still charged for itself');

    assert(applyAction(w, { type: 'build_shaft', bottom: 0, top: 3, column: 40 }).ok,
      'a clear column was refused');
  },

  'lifts need eight clear tiles between them'() {
    // specs/COMMANDS.md: "Elevators must have 8 empty tiles between them."
    assert(SHAFT_SEPARATION === 8, 'the separation rule moved');
    const w = world();
    assert(applyAction(w, { type: 'build_shaft', bottom: 0, top: 3, column: 40 }).ok, 'first shaft failed');

    const tooClose = applyAction(w, { type: 'build_shaft', bottom: 0, top: 3, column: 46 });
    assert(!tooClose.ok, 'two lifts were built six tiles apart');
    assert(/8 clear tiles/.test(tooClose.reason), 'the refusal should say the rule: ' + tooClose.reason);

    assert(applyAction(w, { type: 'build_shaft', bottom: 0, top: 3, column: 52 }).ok,
      'a shaft eight clear tiles away was refused');
  },

  'a shaft claims a floor above and below the ones it serves'() {
    // "expanded vertically from bottom_floor - 1 through top_floor + 1" — the
    // machine room and the pit. Not decoration; it is what the clearance test
    // reads.
    const box = shaftClearance({ mode: CARRIER_MODE.STANDARD, bottom: 2, top: 6, column: 10 });
    assert(box.bottom === 1 && box.top === 7, 'the clearance box is ' + box.bottom + '..' + box.top);
    assert(box.right - box.left + 1 === 4, 'a standard shaft reserves 4 tiles of width');
  },

  // --------------------------------------------------------- extend_shaft

  /**
   * The move a player reaches for first when offices sit above the lift, and
   * which was impossible until now — the only fix was a second shaft at
   * $200,000.
   */
  'a lift can be made to serve more floors'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];
    const wasTop = lift.topFloor;

    const extended = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, top: wasTop + 1 });
    assert(extended.ok, 'the seed’s own lift could not be extended: ' + extended.reason);
    assert(lift.topFloor === wasTop + 1, 'the served range did not move');
  },

  /**
   * ⚠️ **And its per-slot tables move with it.**
   *
   * Eight arrays are indexed by `carrierSlotIndex`, which for a standard shaft
   * is `floor - bottomFloor`. `extend_shaft` used to write the two floor bounds
   * and leave every one of them at its old length: the new floors had no queue
   * rings at all, so the first car to stop on one read `carrier.queues[slot]`
   * as `undefined` and threw inside `drainFloorQueue`.
   *
   * Found by `npm run playtest -- 24 1 --play`, which extends the seed's lift
   * to reach the stranded F7 bank on day zero and died on day 5. It is not a
   * timing accident — a bare `extend_shaft` on the seed leaves nine rings for a
   * twelve-floor shaft — it just needed a car to stop up there with somebody
   * waiting.
   */
  'extending a lift gives the new floors somewhere to queue'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];

    const extended = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, top: lift.topFloor + 3 });
    assert(extended.ok, 'the extension was refused: ' + extended.reason);

    const span = lift.topFloor - lift.bottomFloor + 1;
    assert(lift.queues.length === span,
      'a ' + span + '-floor lift has ' + lift.queues.length + ' queue rings. The floors past the end '
      + 'have nowhere to queue, and the first car that stops on one throws.');
    assert(lift.slotCount === span, 'slotCount says ' + lift.slotCount + ' for a ' + span + '-floor lift');
    for (const name of ['stopEnabled', 'upAssignedCar', 'downAssignedCar']) {
      assert(lift[name].length === span, name + ' is ' + lift[name].length + ' long, expected ' + span);
    }
    for (const car of lift.cars) {
      assert(car.destinationCountBySlot.length === span,
        'a car still counts destinations for ' + car.destinationCountBySlot.length + ' floors');
    }
    assert(lift.queues.every((q) => q && q.up && q.down), 'a floor was given a hole instead of a ring');
  },

  /**
   * ⚠️ The quieter half of the same bug. Lowering the bottom **renumbers every
   * slot**, because the index is an offset from it — so a rider queued on F3
   * silently becomes a rider queued three floors down. That one does not throw;
   * it just moves people, which is why it gets its own row rather than being
   * assumed to ride along with the crash.
   */
  'dropping a lift’s bottom does not renumber the people already queued'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];
    const floor = 3;
    const before = lift.queues[floor - lift.bottomFloor];
    before.up.marker = 'the F3 queue';

    const extended = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, bottom: lift.bottomFloor - 3 });
    assert(extended.ok, 'the extension was refused: ' + extended.reason);

    const after = lift.queues[floor - lift.bottomFloor];
    assert(after.up.marker === 'the F3 queue',
      'the F3 queue is now at slot ' + lift.queues.findIndex((q) => q.up.marker) + ' and floor 3 reads '
      + 'somebody else’s — every waiting rider moved three floors down');
  },

  /**
   * The bug this caught on its first run: `shaftObstruction` walked every
   * carrier including the one being extended, whose own clearance box overlaps
   * the new span by definition. Extending the seed's lift reported that it
   * "overlaps an existing lift" — itself.
   */
  'a lift being extended does not collide with itself'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];
    // Only the top edge, so the OBJECT check cannot fire first and mask the
    // carrier check this test is actually about.
    const box = { mode: lift.mode, bottom: lift.topFloor, top: lift.topFloor + 1, column: lift.column };

    assert(shaftObstruction(w.tower, box) !== null,
      'fixture is not tight enough — the lift should collide with itself when not excluded');
    assert(shaftObstruction(w.tower, box, lift.id) === null,
      'a lift still collided with itself after being excluded by id');
  },

  'a shaft extends but never shortens, and never past the span limit'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];

    const shorter = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, top: lift.topFloor - 2 });
    assert(!shorter.ok && /shortened|demolish/.test(shorter.reason),
      'a shaft was shortened: ' + shorter.reason);

    const huge = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, top: lift.bottomFloor + MAX_SERVED_SPAN });
    assert(!huge.ok && /at most/.test(huge.reason), 'a shaft grew past its span limit: ' + huge.reason);

    assert(!applyAction(w, { type: 'extend_shaft', carrierId: 9999, top: 5 }).ok, 'extended a shaft that is not there');
  },

  // ------------------------------------------------------------ the game

  /**
   * End to end: the first decision the game offers. A bank of offices sits
   * above the top of the lift and cannot rent. The player extends the lift.
   * They fill.
   */
  'extending the lift to a stranded floor is what lets it rent'() {
    const w = seedDemoWorld({ seed: 1 });
    const lift = w.tower.carriers[0];
    const stranded = [...w.tower.objects.values()].filter((o) => o.floor > lift.topFloor);
    assert(stranded.length > 0, 'the seed no longer strands anything — it stops teaching');

    const target = Math.max(...stranded.map((o) => o.floor));
    const extended = applyAction(w, { type: 'extend_shaft', carrierId: lift.id, top: target });
    assert(extended.ok, 'could not reach the stranded floor: ' + extended.reason);
    assert(lift.topFloor >= target, 'the lift still does not reach them');
    assert(extended.cost === 0, 'extending is unpriced in the reference — see DEVIATIONS A12');
  },
};
