/**
 * The opening tower.
 *
 * There is no build palette in this shell — `spec/simtower-loop.md` §7 puts the
 * UI last, after the loop exists — so the game opens on a small tower somebody
 * already built, and the player watches it run. That is the point of the shell:
 * see the loop, then decide what the tools should be.
 *
 * Everything here goes through `placeObject()`, `createCarrier()` and
 * `addCar()`. Nothing writes a sim field by hand.
 *
 * ⚠️ `CLAUDE.md` rule 1 says *"every state change goes through `applyAction()`
 * — human clicks and headless policies use the identical seam. That is what
 * makes replay work."* `applyAction()` is not implemented anywhere in this
 * repo yet. When it is, this file becomes a list of actions and the direct
 * calls go; until then a seeded tower cannot be replayed from a tape.
 */
import { addCar, CARRIER_MODE, createCarrier } from '../sim/elevators.js';
import { FAMILY, GROUND_FLOOR, TILES_PER_FLOOR, createTower, placeObject } from '../sim/state.js';
import { createSimTripRecord } from '../sim/stress.js';

/**
 * The lift column, and the two office banks either side of it.
 *
 * Tiles are the sim's, not the art's: an office is **six** tiles
 * (`specs/facility/OFFICE.md` line 289, "refreshes the 6-tile span") and the
 * lot is 150 across. The shaft sits at the middle so both banks are a short
 * walk from it, which is the layout a player would actually build and therefore
 * the one whose failure modes are worth watching.
 */
export const LAYOUT = {
  shaftColumn: 72,
  officeWidth: 6,
  /**
   * Left bank, then right bank. The banks butt straight against the 4-tile
   * shaft — 66..71 on one side, 76..81 on the other — because a gap beside a
   * lift reads as a mistake, and an empty tile inside the built span draws the
   * bare shell rather than sky.
   */
  officeTiles: [54, 60, 66, 76, 82, 88],
  lobbyLeft: 48,
  lobbyRight: 101,
  /** Offices go on these. `1..6` — high enough that the walk matters. */
  officeFloors: [1, 2, 3, 4, 5, 6],
  /**
   * Retail in the basement, on purpose.
   *
   * `CLAUDE.md`'s sentinel section: a rider bound for B1 could not board a lift
   * because `if (alight < 0)` matched their legitimate destination, and idle
   * cars drove to the first basement to park because they read "no target" as
   * a floor. Both bugs are invisible in a tower that has nothing below ground.
   * Seeding B1 and B2 means the shell fails loudly if either comes back.
   */
  basementFloors: [-1, -2],
  basementTiles: [60, 82],
  carrierBottom: -2,
  carrierTop: 6,
  cars: 3,
};

/**
 * Build the starting tower.
 *
 * **Every direct sim mutation in the UI layer is inside this one function**,
 * deliberately — the `placeObject` / `createCarrier` / `addCar` calls below are
 * the complete list. When `applyAction()` lands there is one place to switch
 * and nothing scattered to hunt down. "Demo" is in the name because that is
 * what this is: a tower somebody already built, so the loop can be watched
 * before there are tools to build one.
 *
 * @param {{seed?:number}} options
 * @returns the tower, ready for `makeTowerScheduler`
 */
export function seedDemoTower({ seed = 1 } = {}) {
  const tower = createTower({ seed });
  /** Stairs and escalators. Empty, but `sim/routing.js` reads it, and an
   *  undefined table there means "rebuild from nothing" every single tick. */
  tower.segments = [];
  tower.transferFloors = [];

  // Trip counters come from the stress pipeline so an actor carries its
  // accounting from birth — `placeObject` takes the factory rather than owning
  // the field list, which is what keeps one definition of it.
  const makeTripFields = () => createSimTripRecord();

  place(tower, {
    family: FAMILY.lobby, floor: GROUND_FLOOR,
    left: LAYOUT.lobbyLeft, right: LAYOUT.lobbyRight,
  }, makeTripFields);

  for (const floor of LAYOUT.officeFloors) {
    for (const left of LAYOUT.officeTiles) {
      place(tower, {
        family: FAMILY.office, floor,
        left, right: left + LAYOUT.officeWidth - 1,
      }, makeTripFields);
    }
  }

  for (const floor of LAYOUT.basementFloors) {
    for (const left of LAYOUT.basementTiles) {
      place(tower, {
        family: FAMILY.retail, floor,
        left, right: left + LAYOUT.officeWidth - 1,
      }, makeTripFields);
    }
  }

  // One standard carrier. `createCarrier` throws on an over-long standard span
  // rather than clamping, so a bad LAYOUT is a crash at boot and not a shaft
  // that quietly serves the wrong floors.
  const carrier = createCarrier({
    id: 0,
    mode: CARRIER_MODE.STANDARD,
    bottomFloor: LAYOUT.carrierBottom,
    topFloor: LAYOUT.carrierTop,
    column: LAYOUT.shaftColumn,
    homeFloor: GROUND_FLOOR,
  });
  for (let i = 0; i < LAYOUT.cars; i++) addCar(carrier, GROUND_FLOOR);
  tower.carriers.push(carrier);

  return tower;
}

/** `placeObject` reports failure rather than throwing. A seed that silently
 *  dropped half its offices would look like a sim bug for the rest of the day. */
function place(tower, placement, makeTripFields) {
  const result = placeObject(tower, placement, makeTripFields);
  if (!result.ok) {
    throw new Error(`seed: ${placement.left}..${placement.right} on floor ${placement.floor}: ${result.reason}`);
  }
  if (placement.right >= TILES_PER_FLOOR) throw new Error('seed: span runs off the lot');
  return result.object;
}
