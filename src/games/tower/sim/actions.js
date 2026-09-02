/**
 * `applyAction()` — the one door into the tower.
 *
 * `CLAUDE.md` rule 1: *"Every state change goes through `applyAction()` — human
 * clicks and headless policies use the identical seam. That is what makes
 * replay work."* Until now nothing implemented it and the UI mutated the sim
 * directly, which is fine for a fixed demo and useless for a game: you cannot
 * replay a click that was never a command.
 *
 * Every command is `{ type, ...args }` and every result is
 * `{ ok, reason?, ... }`. Nothing here throws for a refused move — a refusal is
 * an answer, and the interface needs to show it.
 *
 * **Money is charged here and nowhere else.** A command that cannot be paid
 * for is refused before it touches the tower, so a half-built object can never
 * exist. `specs/COMMANDS.md` calls that
 * `check_construction_funds_available_for_floor_range`.
 */
import {
  FAMILY, OBJECT_TYPE, floorExists, isRented, placeObject, spanBlocked,
} from './state.js';
import { CARRIER_MODE, addCar, createCarrier, MAX_SERVED_SPAN } from './elevators.js';
import { CONSTRUCTION_COST, chargeConstruction, placementCost } from './economy.js';
import { createSimTripRecord } from './stress.js';

/** What each buildable maps to. The palette is built from this, so it cannot drift. */
export const BUILDABLE = {
  lobby: { family: FAMILY.lobby, type: OBJECT_TYPE.lobby, cost: 'lobby', width: 1, label: 'Lobby' },
  office: { family: FAMILY.office, type: OBJECT_TYPE.office, cost: 'office', width: 6, label: 'Office' },
};

/** Elevator kinds a player can place. */
export const SHAFT_KIND = {
  standard: { mode: CARRIER_MODE.STANDARD, cost: 'elevatorStandard', label: 'Elevator' },
};

const refuse = (reason) => ({ ok: false, reason });

const ACTIONS = {
  /**
   * Place a room. The span is `left .. left + width - 1`; the width comes from
   * the buildable, so a caller cannot invent a four-tile office.
   */
  build({ tower, ledger }, { what, floor, left }) {
    const spec = BUILDABLE[what];
    if (!spec) return refuse('there is nothing called "' + what + '" to build');
    if (!floorExists(floor)) return refuse('that floor is outside the tower');

    const right = left + spec.width - 1;
    if (spanBlocked(tower, floor, left, right)) return refuse('something is already built there');

    const cost = placementCost(spec.cost, {
      tiles: spec.width, floor, lobbyHeight: tower.lobbyHeight,
    });
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }

    const placed = placeObject(tower,
      { family: spec.family, type: spec.type, floor, left, right },
      () => createSimTripRecord());
    if (!placed.ok) {
      ledger.cash += paid.cost;                       // nothing was built; refund
      return placed;
    }
    return { ok: true, cost, object: placed.object };
  },

  /**
   * Sink a shaft. `bottom..top` inclusive, capped at the reference's
   * contiguous 31-floor limit, which `createCarrier` throws on — caught here
   * and turned into an answer rather than an exception.
   */
  build_shaft({ tower, ledger }, { kind = 'standard', bottom, top, column }) {
    const spec = SHAFT_KIND[kind];
    if (!spec) return refuse('there is no "' + kind + '" shaft');
    if (!floorExists(bottom) || !floorExists(top)) return refuse('that shaft leaves the tower');
    if (top <= bottom) return refuse('a shaft has to serve more than one floor');
    if (top - bottom + 1 > MAX_SERVED_SPAN) {
      return refuse('a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby');
    }

    const cost = CONSTRUCTION_COST[spec.cost] ?? 0;
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('that costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }

    let carrier;
    try {
      carrier = createCarrier({
        id: nextCarrierId(tower), mode: spec.mode, bottomFloor: bottom, topFloor: top, column,
      });
    } catch (error) {
      ledger.cash += paid.cost;
      return refuse(error.message);
    }
    addCar(carrier);                                  // a shaft with no car is a hole
    tower.carriers.push(carrier);
    tower.routeTablesDirty = true;
    return { ok: true, cost, carrier };
  },

  /** Add a car to an existing shaft. The one purchase that scales a route. */
  add_car({ tower, ledger }, { carrierId }) {
    const carrier = tower.carriers.find((c) => c.id === carrierId);
    if (!carrier) return refuse('no such shaft');
    const cost = CONSTRUCTION_COST.elevatorStandard ?? 0;
    const paid = chargeConstruction(ledger, cost);
    if (!paid.charged) {
      return refuse('a car costs $' + cost.toLocaleString('en-US')
        + ' and you have $' + ledger.cash.toLocaleString('en-US'));
    }
    const car = addCar(carrier);
    if (!car) {
      ledger.cash += paid.cost;
      return refuse('that shaft is full — ' + carrier.cars.length + ' cars is the limit');
    }
    return { ok: true, cost, cars: carrier.cars.length };
  },

  /**
   * Demolish. Refused while the unit is let, because evicting a paying tenant
   * with a click is not a thing the reference lets you do — you drop the rent
   * or you fix the lifts.
   */
  demolish({ tower }, { objectId }) {
    const object = tower.objects.get(objectId);
    if (!object) return refuse('nothing there');
    if (isRented(object.unitStatus)) return refuse('that unit is let — you cannot evict a tenant');

    tower.objects.delete(objectId);
    tower.actors = tower.actors.filter((a) => a.objectId !== objectId);
    tower.routeTablesDirty = true;
    return { ok: true, freed: object };
  },

  /** Change a unit's rent tier. 0 is dearest, 3 is the one that always passes. */
  set_rent({ tower }, { objectId, tier }) {
    const object = tower.objects.get(objectId);
    if (!object) return refuse('nothing there');
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) return refuse('rent tiers run 0 to 3');
    object.rentLevel = tier;
    object.dirty = true;
    return { ok: true, tier };
  },
};

const nextCarrierId = (tower) =>
  tower.carriers.reduce((max, c) => Math.max(max, c.id), 0) + 1;

/**
 * The seam. `world` is `{ tower, ledger }` — both, because building costs
 * money and neither half is meaningful alone.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function applyAction(world, command) {
  const handler = ACTIONS[command?.type];
  if (!handler) return refuse('unknown command "' + command?.type + '"');
  return handler(world, command);
}

/** Command names, so a palette or a policy can enumerate without guessing. */
export const COMMANDS = Object.keys(ACTIONS);
