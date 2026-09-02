/**
 * The ghost and the seam must never disagree.
 *
 * `ui/build.js`'s `preview()` decides whether the ghost is green or red before
 * the click; `sim/actions.js`'s `applyAction()` decides for real when it comes.
 * Two answers to one question, and `CLAUDE.md` names that shape exactly: *"a
 * rule written in four places drifts — three of them only predicted what the
 * fourth would do."*
 *
 * `preview` calls the sim's own predicates rather than restating them, so the
 * *rules* are shared. What cannot be shared is the set of checks and their
 * order, and that is what this file pins: the same command through both paths,
 * asserting the verdict AND the wording match. Add a check to `applyAction`
 * and forget the ghost, and these fail.
 *
 * A fresh world per case, because `applyAction` commits.
 */
import { applyAction, BUILDABLE, SHAFT_KIND } from '../src/games/tower/sim/actions.js';
import { CONSTRUCTION_COST } from '../src/games/tower/sim/economy.js';
import { MAX_SERVED_SPAN, SHAFT_WIDTH } from '../src/games/tower/sim/elevators.js';
import { GROUND_FLOOR, MAX_FLOOR, TILES_PER_FLOOR, isRented } from '../src/games/tower/sim/state.js';
import {
  TOOLS, commandFor, costOf, lowestBuiltFloor, preview, snapLeft, toolById,
} from '../src/games/tower/ui/build.js';
import { LAYOUT, seedDemoWorld } from '../src/games/tower/ui/seed.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const world = () => seedDemoWorld({ seed: 1 });

/** A pointer target, as `ui/main.js` builds it from the renderer's picks. */
const at = (floor, tile, extra = {}) => ({ floor, tile, object: null, carrier: null, ...extra });
const tool = (id) => toolById(id);

/** An empty floor high above anything the seed built. */
const EMPTY_FLOOR = 40;

export const tests = {
  // ------------------------------------------------------- the palette

  'the palette is generated from what the sim can actually build'() {
    // Not a hand-written list. Add a buildable to `sim/actions.js` and it
    // appears; there is no second place to remember, which is the same reason
    // the sprite preload is derived.
    for (const what of Object.keys(BUILDABLE)) {
      assert(TOOLS.some((t) => t.action === 'build' && t.what === what), what + ' has no tool');
    }
    for (const kind of Object.keys(SHAFT_KIND)) {
      assert(TOOLS.some((t) => t.action === 'build_shaft' && t.kind === kind), kind + ' shaft has no tool');
    }
    assert(TOOLS.some((t) => t.action === 'add_car'), 'a shaft you cannot add cars to is a shaft you cannot fix');
    assert(TOOLS.some((t) => t.action === 'demolish'), 'demolish is missing');
    assert(new Set(TOOLS.map((t) => t.key)).size === TOOLS.length, 'two tools share a shortcut');
    assert(new Set(TOOLS.map((t) => t.id)).size === TOOLS.length, 'two tools share an id');
  },

  'a room span is snapped into the lot rather than refused at its edge'() {
    const width = BUILDABLE.office.width;
    assert(snapLeft(-5, width) === 0, 'past the left edge snaps to 0');
    assert(snapLeft(TILES_PER_FLOOR + 5, width) === TILES_PER_FLOOR - width, 'past the right edge snaps in');
    assert(snapLeft(60, width) === 60, 'a legal tile is left alone');
    // Nudging is an affordance. Letting the span hang off the lot and be
    // refused says the same thing in a worse way, and `placeObject` only
    // catches it AFTER `applyAction` has charged and refunded.
    const { tower } = world();
    const command = commandFor(tower, tool('office'), at(EMPTY_FLOOR, TILES_PER_FLOOR - 1));
    assert(command.left + width - 1 < TILES_PER_FLOOR, 'a snapped command never runs off the lot');
  },

  // ------------------------------------- ghost and seam, the same answer

  '⚠️ preview and applyAction agree, verdict and wording, on every case'() {
    // The whole point of the file. Each case gets a fresh world because
    // `applyAction` commits.
    const cases = [
      ['an office on empty air', 'office', () => at(EMPTY_FLOOR, 20)],
      ['an office on top of another', 'office', () => at(LAYOUT.officeFloors[0], LAYOUT.officeTiles[0])],
      ['an office half-overlapping another', 'office', () => at(LAYOUT.officeFloors[0], LAYOUT.officeTiles[0] + 2)],
      ['an office below the world', 'office', () => at(-99, 20)],
      ['an office above the world', 'office', () => at(MAX_FLOOR + 5, 20)],
      ['an office at the right edge', 'office', () => at(EMPTY_FLOOR, TILES_PER_FLOOR - 2)],
      ['a lobby on empty air', 'lobby', () => at(EMPTY_FLOOR, 30)],
      ['a shaft to a high floor', 'shaft-standard', () => at(20, 110)],
      ['a shaft to the floor it starts on', 'shaft-standard', () => at(LAYOUT.carrierBottom, 110)],
      ['a shaft past the 31-floor limit', 'shaft-standard', () => at(MAX_FLOOR, 110)],
      ['a shaft off the top of the world', 'shaft-standard', () => at(MAX_FLOOR + 5, 110)],
    ];

    for (const [label, toolId, target] of cases) {
      const before = world();
      const guess = preview(before, tool(toolId), target());
      const after = world();
      const command = commandFor(after.tower, tool(toolId), target());
      const real = applyAction(after, command);

      assert(guess.ok === real.ok,
        `${label}: ghost said ${guess.ok ? 'yes' : 'no'} and the seam said ${real.ok ? 'yes' : 'no'}`
        + (real.reason ? ' ("' + real.reason + '")' : ''));
      if (!real.ok) {
        assert(guess.reason === real.reason,
          `${label}: two voices for one refusal\n       ghost: ${guess.reason}\n       seam:  ${real.reason}`);
      }
    }
  },

  'and they agree about the price, which is the number the player acts on'() {
    for (const [toolId, target] of [
      ['office', at(EMPTY_FLOOR, 20)],
      ['lobby', at(EMPTY_FLOOR, 30)],
      ['shaft-standard', at(20, 110)],
    ]) {
      const w = world();
      const cashBefore = w.ledger.cash;
      const guess = preview(w, tool(toolId), target);
      const real = applyAction(w, commandFor(w.tower, tool(toolId), target));
      assert(real.ok, toolId + ' should have been buildable');
      assert(guess.cost === real.cost, `${toolId}: ghost quoted ${guess.cost}, charged ${real.cost}`);
      assert(cashBefore - w.ledger.cash === real.cost, 'the ledger moved by exactly the quoted cost');
    }
  },

  '⚠️ previewing does not build anything, or spend anything'() {
    // A preview that committed would build a tower out of hovering. Pinned
    // because `preview` runs the sim's real `chargeConstruction` — against a
    // COPY of the ledger, and this is what says so.
    const w = world();
    const objects = w.tower.objects.size;
    const carriers = w.tower.carriers.length;
    const cash = w.ledger.cash;
    for (let i = 0; i < 40; i++) {
      preview(w, tool('office'), at(EMPTY_FLOOR, i));
      preview(w, tool('shaft-standard'), at(20, 100 + i));
      preview(w, tool('demolish'), at(1, 54));
    }
    assert(w.tower.objects.size === objects, 'hovering built ' + (w.tower.objects.size - objects) + ' rooms');
    assert(w.tower.carriers.length === carriers, 'hovering sank a shaft');
    assert(w.ledger.cash === cash, 'hovering spent $' + (cash - w.ledger.cash));
  },

  'an unaffordable build is refused in the sim\'s own words'() {
    const w = seedDemoWorld({ seed: 1, cash: 100 });
    const guess = preview(w, tool('office'), at(EMPTY_FLOOR, 20));
    assert(!guess.ok, 'an office costs more than $100');
    assert(guess.reason.includes('$100'), 'the refusal names what you have: ' + guess.reason);

    const real = applyAction(w, commandFor(w.tower, tool('office'), at(EMPTY_FLOOR, 20)));
    assert(guess.reason === real.reason, 'the two funds refusals must be one sentence');
    assert(w.ledger.cash === 100, 'a refused build costs nothing');
  },

  // --------------------------------------------------- tools with a target

  'add_car and demolish say what they need when pointed at nothing'() {
    const w = world();
    const car = preview(w, tool('add_car'), at(EMPTY_FLOOR, 20));
    assert(!car.ok && car.reason === 'point at a shaft', 'add_car: ' + car.reason);
    const dem = preview(w, tool('demolish'), at(EMPTY_FLOOR, 20));
    assert(!dem.ok && dem.reason === 'point at something to demolish', 'demolish: ' + dem.reason);
  },

  'a car can be added to the shaft under the pointer'() {
    const w = world();
    const carrier = w.tower.carriers[0];
    const before = carrier.cars.length;
    const target = at(GROUND_FLOOR, carrier.column, { carrier });
    const guess = preview(w, tool('add_car'), target);
    assert(guess.ok, 'should be affordable: ' + guess.reason);
    assert(guess.cost === CONSTRUCTION_COST.elevatorStandard, 'a car is priced as a car');
    const real = applyAction(w, commandFor(w.tower, tool('add_car'), target));
    assert(real.ok && carrier.cars.length === before + 1, 'the car was not added');
  },

  '⚠️ a let unit cannot be demolished, and the ghost says so first'() {
    const w = world();
    // Sign a lease the way the sim does: both halves.
    const office = [...w.tower.objects.values()].find((o) => o.family === BUILDABLE.office.family);
    office.occupiedFlag = true;
    office.unitStatus = 0;
    assert(isRented(office.unitStatus), 'precondition');

    const target = at(office.floor, office.left, { object: office });
    const guess = preview(w, tool('demolish'), target);
    const real = applyAction(w, commandFor(w.tower, tool('demolish'), target));
    assert(!guess.ok && !real.ok, 'a tenant cannot be evicted with a click');
    assert(guess.reason === real.reason, 'one refusal, one sentence');
    assert(w.tower.objects.has(office.id), 'and the room is still there');
  },

  'a vacant unit demolishes, and its people go with it'() {
    const w = world();
    const office = [...w.tower.objects.values()]
      .find((o) => o.family === BUILDABLE.office.family && !isRented(o.unitStatus));
    const workers = w.tower.actors.filter((a) => a.objectId === office.id).length;
    assert(workers > 0, 'precondition: it had workers');

    const target = at(office.floor, office.left, { object: office });
    assert(preview(w, tool('demolish'), target).ok, 'the ghost should allow it');
    const real = applyAction(w, commandFor(w.tower, tool('demolish'), target));
    assert(real.ok, real.reason);
    assert(!w.tower.objects.has(office.id), 'the room is gone');
    assert(w.tower.actors.every((a) => a.objectId !== office.id), 'its workers went with it');
  },

  // ------------------------------------------------------------ the shaft

  '⚠️ a new shaft reaches the lobby and the basements without being asked'() {
    // The first thing a player needs to do is make the top floor reachable, and
    // a shaft that started at the floor you clicked would serve nothing.
    const { tower } = world();
    assert(lowestBuiltFloor(tower) === LAYOUT.carrierBottom,
      'a new shaft starts at the bottom of the tower, got ' + lowestBuiltFloor(tower));
    const command = commandFor(tower, tool('shaft-standard'), at(7, 110));
    assert(command.bottom < GROUND_FLOOR, 'it passes the lobby on its way up');
    assert(command.top === 7, 'and stops where the player clicked');
  },

  'the shaft footprint is the width the carrier model gives it'() {
    const w = world();
    const guess = preview(w, tool('shaft-standard'), at(20, 110));
    assert(guess.footprint.kind === 'shaft', 'a shaft draws as a shaft');
    assert(guess.footprint.width === SHAFT_WIDTH[SHAFT_KIND.standard.mode],
      'the ghost is the width the shaft will actually be');
    assert(guess.footprint.bottom === LAYOUT.carrierBottom && guess.footprint.top === 20, 'and its full span');
  },

  '⚠️ a shaft through occupied rooms is reported, not refused'() {
    // `sim/actions.js` does not check whether a shaft passes through built
    // rooms — reported to sim/. Until it is a rule, the interface says what is
    // about to happen rather than inventing a refusal the sim does not have.
    // If the check lands, this test fails and the note becomes a refusal.
    const w = world();
    const guess = preview(w, tool('shaft-standard'), at(6, LAYOUT.officeTiles[0]));
    assert(guess.ok, 'the sim allows it today, so the ghost must not claim otherwise');
    assert(/passes through \d+ rooms/.test(guess.note ?? ''),
      'the consequence has to be on screen: ' + JSON.stringify(guess.note));

    const clear = preview(w, tool('shaft-standard'), at(6, 110));
    assert(!clear.note, 'a clear column carries no warning: ' + clear.note);
  },

  'the span limit is the reference\'s, and the ghost quotes it'() {
    const w = world();
    const guess = preview(w, tool('shaft-standard'), at(MAX_FLOOR, 110));
    assert(!guess.ok, 'a shaft cannot span the whole tower');
    assert(guess.reason.includes(String(MAX_SERVED_SPAN)), 'it names the limit: ' + guess.reason);
  },

  // ------------------------------------------------------------- costing

  'costs come from the sim\'s pricing and include the floor tiles'() {
    const { tower } = world();
    const office = costOf(tower, commandFor(tower, tool('office'), at(EMPTY_FLOOR, 20)));
    // 40,000 for the room plus six tiles of floor at 500 — the number in the
    // seam's own doc comment.
    assert(office === CONSTRUCTION_COST.office + BUILDABLE.office.width * CONSTRUCTION_COST.floorTile,
      'an office is priced with its floor, got ' + office);
    assert(office === 43000, 'and that is $43,000, got ' + office);
    const shaft = costOf(tower, commandFor(tower, tool('shaft-standard'), at(20, 110)));
    assert(shaft === CONSTRUCTION_COST.elevatorStandard, 'a shaft is priced as a shaft, got ' + shaft);
  },
};
