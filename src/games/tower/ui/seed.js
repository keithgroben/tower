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
import { STARTING_CASH } from '../sim/economy.js';
import { ledgerFor } from '../sim/ledger-adapter.js';
// For the venue's width only. `BUILDABLE` is the sim's own table of what a
// `build` command accepts, so the seed asks it rather than restating how wide a
// fast food is — the day that number moves, this moves with it.
import { BUILDABLE } from '../sim/actions.js';

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
  /** Offices go on these. `1..6` — every one of them served by the lift. */
  officeFloors: [1, 2, 3, 4, 5, 6],
  /**
   * **A bank of offices above where the lift stops.** They can never rent, and
   * that is the entire point of them.
   *
   * The alternative seeds were "a tower that works" and "a tower that fails",
   * and both are worse. All-working teaches nothing, and the player cannot
   * break it themselves yet because there is no build palette. All-failing
   * reads as a broken build rather than as a lesson, and leaves no baseline —
   * you have to watch the thing work once before its failure is information.
   *
   * So the opening tower does both at once, and the geometry explains itself
   * with no text. Measured over nine days, `logs` below are per floor:
   *
   *     F1  6/6 let   median stress 77   calm
   *     F2  6/6 let                 62   calm
   *     F3  6/6 let                 75   calm
   *     F4  6/6 let                 89   stressed   <- longer commute
   *     F5  6/6 let                 85   stressed
   *     F6  6/6 let                 87   stressed
   *     F7  0/6 let               huge   fed up     <- above the lift
   *
   * All three stress bands on screen at once, each one caused by something the
   * player can see: low floors are quick, high floors cost more, and above the
   * shaft you cannot get there at all. The failing bank costs the served floors
   * nothing — 36/36 still let, median 81 against a failing threshold of 150.
   */
  unreachableFloors: [7],

  /**
   * Somewhere to eat, beside the office bank on F3.
   *
   * Added when lunch trips landed. Without a venue every office worker's midday
   * trip has nowhere to go, and the whole tower runs 20-30 stress points worse
   * for it — measured over twelve days, sampled off the cashflow reset:
   *
   *              no venue    with one on F3
   *     F6         111            98
   *     F5         103            81
   *     F4         102            74
   *     F3          87            51
   *
   * That is not a tuning preference, it is the seed's job. The opening tower is
   * meant to have **one** deliberate failure in it — the bank above the lift —
   * and a tower whose workers also cannot get lunch has two, which muddies the
   * lesson the first one teaches. This restores it to one.
   *
   * It also leaves the discovery intact rather than pre-empting it: a player
   * who builds a second office bank still has to work out that it wants feeding.
   */
  fastFoodFloor: GROUND_FLOOR,
  /**
   * ⚠️ On the ground, and to the RIGHT of the lobby's own span.
   *
   * It sat on F3 at 94..109, and the first look at a rendered frame showed why
   * that was wrong: **nothing was underneath it.** The lobby stops at 101 and
   * F1/F2 are empty past 93, so sixteen tiles of lit food court hung in the sky
   * off the side of the building. It routed correctly and every test passed —
   * the sim has no opinion about what is below a room — and it read as a
   * mistake to anybody looking at it.
   *
   * The ground floor cannot float, by construction, which is why it is the fix
   * rather than "extend the lobby under it": a wider lobby would have left the
   * venue two storeys up over a void, and a rule enforced by geometry beats one
   * enforced by remembering.
   *
   * Measured, and it costs nothing — sixteen days, sampled off the cashflow
   * reset, median 84-94 against 84-93 on F3, and 36/43 let on every single day.
   * The building now has a podium: ground floor 48..117, tower 54..93 above it.
   */
  fastFoodLeft: 102,
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
 * **The new game: an empty lot with a ground lobby, and the money.**
 *
 * This is what the game opens on. `seedDemoWorld` below is no longer it.
 *
 * ## Why it changed
 *
 * The demo tower was seeded back when there was no build palette. The argument
 * then was sound: a player who cannot build cannot break a working tower
 * themselves, so the opening position had to contain its own lesson — a bank of
 * offices stranded above the lift, teaching "your lift decides who rents"
 * through geometry rather than text.
 *
 * That argument expired the day the palette landed. **The first office should
 * be the player's own**, because a tenant you placed and then watched move in
 * is the loop; a tenant that was already there is a diagram of the loop. And
 * the stranded-bank lesson is not lost by removing it — a player stacking
 * offices above their own lift rediscovers it within minutes, which teaches it
 * harder than being shown.
 *
 * ## What you get, and why exactly this
 *
 * A ground lobby and nothing else. The lobby is not a courtesy: it is the
 * origin every route is measured from, and `sim/routing.js` has nowhere to
 * start without it. SimTower opens the same way.
 *
 * `segments` and `transferFloors` are empty ARRAYS rather than absent —
 * `sim/routing.js` reads both, and `undefined` there means "rebuild the tables
 * from nothing" on every single tick.
 *
 * @param {{seed?:number, cash?:number}} options
 * @returns {{tower: object, ledger: object}}
 */
export function newTowerWorld({ seed = 1, cash = STARTING_CASH } = {}) {
  const tower = createTower({ seed, startingCash: cash });
  tower.segments = [];
  tower.transferFloors = [];
  place(tower, {
    family: FAMILY.lobby, floor: GROUND_FLOOR,
    left: LAYOUT.lobbyLeft, right: LAYOUT.lobbyRight,
  }, () => createSimTripRecord());
  // The same view, for the same reason as below: one balance, not two.
  return { tower, ledger: ledgerFor(tower) };
}

/**
 * ⚠️ **A measurement fixture, not the game's opening position any more.**
 *
 * `newTowerWorld` above is what a player sees. This builds the 48-room tower
 * the harness and most of the suite measure against, and it is kept precisely
 * *because* it is fixed: a benchmark that changed whenever the new-game
 * position was tuned would make every number in `harness/playtest.js`
 * incomparable with the one before it.
 *
 * Its stranded bank on F7 is therefore a **fixture property** now rather than a
 * lesson — `test/seed.test.js` still pins it, because a fixture that quietly
 * stopped stranding anything would silently weaken every test built on it.
 *
 * The original note, still true:
 *
 * **The last direct sim mutation in the UI layer lives here**, and it is
 * deliberately the only one. Everything a *player* does goes through
 * `applyAction()`; this is the position the game opens on, which is not a move
 * anyone made. `CLAUDE.md` rule 1 is otherwise unqualified, so the exception is
 * worth naming rather than leaving to be discovered.
 *
 * Returns the `world` shape `applyAction` takes — `{ tower, ledger }` — so
 * there is one object to pass around and no chance of a UI holding a tower
 * whose cash lives somewhere else.
 *
 * @param {{seed?:number, cash?:number}} options
 * @returns {{tower: object, ledger: object}}
 */
export function seedDemoWorld({ seed = 1, cash = STARTING_CASH } = {}) {
  const tower = createTower({ seed, startingCash: cash });
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

  // The served floors and the unreachable bank are placed identically. Nothing
  // marks the bank as special — it is ordinary offices that happen to sit above
  // the top of the shaft, and the sim works out the rest. Anything else would
  // be the seed teaching the lesson instead of the tower doing it.
  for (const floor of [...LAYOUT.officeFloors, ...LAYOUT.unreachableFloors]) {
    for (const left of LAYOUT.officeTiles) {
      place(tower, {
        family: FAMILY.office, floor,
        left, right: left + LAYOUT.officeWidth - 1,
      }, makeTripFields);
    }
  }

  // The lunch venue. `BUILDABLE.fastFood` owns its width, so the seed asks for
  // a left edge and never restates how wide a fast food is.
  place(tower, {
    family: FAMILY.fastFood,
    floor: LAYOUT.fastFoodFloor,
    left: LAYOUT.fastFoodLeft,
    right: LAYOUT.fastFoodLeft + BUILDABLE.fastFood.width - 1,
  }, makeTripFields);

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

  // ⚠️ `ledgerFor(tower)`, NOT `createLedger()`.
  //
  // `applyAction` is not the only thing that moves money. Rent arrives through
  // `sim/ledger-adapter.js` — the reopen hook and checkpoint 2533 — and that
  // writes the tower's own `cash`. A standalone ledger here gives the game two
  // balances: construction debits one, rent credits the other, and the HUD
  // draws whichever it happened to be handed. Measured: the cash bar fell by
  // $1,548,000 for 36 offices and then never moved again while the tower
  // collected $432,000 a cycle onto a number nothing displayed.
  //
  // `ledgerFor` returns a VIEW over `tower.cash`, so there is one balance and
  // nothing to keep in step.
  return { tower, ledger: ledgerFor(tower) };
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
