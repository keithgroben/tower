/**
 * The build tools: what the palette holds, and what a click would do.
 *
 * Two jobs, and the split matters.
 *
 * `commandFor()` turns a tool and a place into the `{type, ...}` command that
 * `applyAction()` takes. **That is the only way anything gets built.** The
 * palette does not touch the tower; it composes a command and hands it over,
 * exactly as a headless policy would, which is the whole point of the seam.
 *
 * `preview()` answers "would that land, and what would it cost" *without*
 * building. It exists because a ghost has to be green or red before the click,
 * and `applyAction()` commits — there is no dry run.
 *
 * ## The drift hazard, and what is done about it
 *
 * A preview that re-implements the rules is the "rule written in four places"
 * mistake `CLAUDE.md` names: three copies predicting what the fourth will do.
 * So this file calls **the same exported functions `sim/actions.js` calls** —
 * `floorExists`, `spanBlocked`, `placementCost`, `chargeConstruction` — rather
 * than restating any of them. `chargeConstruction` is handed a *copy* of the
 * ledger, so the real affordability rule runs and no money moves.
 *
 * What cannot be shared is the *set* of checks and their order. That is guarded
 * instead: `test/build.test.js` runs a matrix of commands through both this and
 * `applyAction` and fails if they ever disagree, on the verdict or the wording.
 *
 * And the click path does not trust this file. It calls `applyAction` and shows
 * **its** refusal, so a disagreement surfaces as a visible sentence rather than
 * as a ghost that lied.
 */
import { BUILDABLE, SHAFT_KIND } from '../sim/actions.js';
import { chargeConstruction, placementCost, CONSTRUCTION_COST } from '../sim/economy.js';
import { GROUND_FLOOR, TILES_PER_FLOOR, floorExists, isRented, spanBlocked } from '../sim/state.js';
import { MAX_SERVED_SPAN, SHAFT_WIDTH } from '../sim/elevators.js';

/**
 * The palette, derived from `BUILDABLE` and `SHAFT_KIND` so it cannot drift
 * from what the sim can actually build. Add a buildable there and it appears
 * here; there is no second list to remember.
 *
 * `key` is the keyboard shortcut, assigned by position. The order is the sim's
 * own declaration order, not a preference of this file's — which happens to put
 * the lobby first, and that is right: in the original it is the first thing you
 * place and nothing else works without one. The two tools that change what is
 * already there come after the two that make it.
 */
export const TOOLS = [
  ...Object.entries(BUILDABLE).map(([what, spec]) => ({
    id: what,
    action: 'build',
    what,
    label: spec.label,
    width: spec.width,
  })),
  ...Object.entries(SHAFT_KIND).map(([kind, spec]) => ({
    id: 'shaft-' + kind,
    action: 'build_shaft',
    kind,
    label: spec.label,
  })),
  { id: 'add_car', action: 'add_car', label: 'Add car' },
  { id: 'demolish', action: 'demolish', label: 'Demolish' },
];

TOOLS.forEach((tool, i) => { tool.key = String(i + 1); });

export const toolById = (id) => TOOLS.find((t) => t.id === id) ?? null;

/** A room's left edge, snapped so its span always lies inside the lot. Nudging
 *  the ghost is an affordance; letting it hang off the lot and be refused is a
 *  worse way to say the same thing. */
export const snapLeft = (tile, width) =>
  Math.max(0, Math.min(TILES_PER_FLOOR - width, Math.round(tile)));

/**
 * The lowest floor anything stands on, or the ground floor for a bare lot.
 *
 * A new shaft runs from here to the floor you clicked, so it always meets the
 * lobby and the basements without the player having to say so. One click, and
 * the span is the one that is almost always wanted.
 */
export function lowestBuiltFloor(tower) {
  let lowest = GROUND_FLOOR;
  for (const o of tower.objects.values()) if (o.floor < lowest) lowest = o.floor;
  for (const c of tower.carriers) if (c.bottomFloor < lowest) lowest = c.bottomFloor;
  return lowest;
}

/**
 * The command a click with this tool would send, or `null` when the tool needs
 * something that is not under the cursor (a car needs a shaft, a demolition
 * needs an object).
 *
 * @param target `{ floor, tile, object, carrier }` — what is under the pointer
 */
export function commandFor(tower, tool, target) {
  if (!tool || !target || !Number.isInteger(target.floor)) return null;
  switch (tool.action) {
    case 'build':
      return { type: 'build', what: tool.what, floor: target.floor, left: snapLeft(target.tile, tool.width) };
    case 'build_shaft':
      return { type: 'build_shaft', kind: tool.kind, bottom: lowestBuiltFloor(tower), top: target.floor, column: target.tile };
    case 'add_car':
      return target.carrier ? { type: 'add_car', carrierId: target.carrier.id } : null;
    case 'demolish':
      return target.object ? { type: 'demolish', objectId: target.object.id } : null;
    default:
      return null;
  }
}

/** What a command would cost, using the sim's own pricing and nothing else. */
export function costOf(tower, command) {
  if (!command) return 0;
  if (command.type === 'build') {
    const spec = BUILDABLE[command.what];
    if (!spec) return 0;
    return placementCost(spec.cost, { tiles: spec.width, floor: command.floor, lobbyHeight: tower.lobbyHeight });
  }
  if (command.type === 'build_shaft') return CONSTRUCTION_COST[SHAFT_KIND[command.kind]?.cost] ?? 0;
  if (command.type === 'add_car') return CONSTRUCTION_COST.elevatorStandard ?? 0;
  return 0;
}

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/**
 * Would this land? Returns the same `{ok, reason}` shape `applyAction` does,
 * plus the `cost` and the `footprint` the ghost draws.
 *
 * The wording is deliberately identical to `sim/actions.js` — the lead's rule:
 * the reason is already written for a player, and a second phrasing of the same
 * refusal is two voices for one rule. `test/build.test.js` compares them.
 */
export function preview(world, tool, target) {
  const { tower, ledger } = world;
  const command = commandFor(tower, tool, target);
  if (!command) {
    if (tool?.action === 'add_car') return refuse('point at a shaft');
    if (tool?.action === 'demolish') return refuse('point at something to demolish');
    return refuse('nowhere to put that');
  }
  const cost = costOf(tower, command);
  // The real affordability rule, run against a COPY so no money moves.
  // `chargeConstruction` only touches `cash`, so a shallow copy is enough.
  const affordable = chargeConstruction({ ...ledger }, cost).charged;

  if (command.type === 'build') {
    const spec = BUILDABLE[command.what];
    const right = command.left + spec.width - 1;
    const footprint = { kind: 'room', floor: command.floor, left: command.left, right };
    if (!floorExists(command.floor)) return refuse('that floor is outside the tower', { cost, footprint });
    if (spanBlocked(tower, command.floor, command.left, right)) {
      return refuse('something is already built there', { cost, footprint });
    }
    if (!affordable) return refuse(cannotAfford(cost, ledger), { cost, footprint });
    return { ok: true, cost, footprint, command };
  }

  if (command.type === 'build_shaft') {
    const spec = SHAFT_KIND[command.kind];
    const width = shaftWidth(spec);
    const column = Math.max(0, Math.min(TILES_PER_FLOOR - width, command.column));
    const footprint = { kind: 'shaft', column, width, bottom: command.bottom, top: command.top };
    command.column = column;
    if (!floorExists(command.bottom) || !floorExists(command.top)) {
      return refuse('that shaft leaves the tower', { cost, footprint });
    }
    if (command.top <= command.bottom) return refuse('a shaft has to serve more than one floor', { cost, footprint });
    if (command.top - command.bottom + 1 > MAX_SERVED_SPAN) {
      return refuse('a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby', { cost, footprint });
    }
    if (!affordable) return refuse(cannotAfford(cost, ledger), { cost, footprint });
    // ⚠️ Not a refusal — a consequence. `sim/actions.js` does not check whether
    // a shaft passes through built rooms, so this WILL land. Reported; until it
    // is a rule, the interface says what is about to happen rather than
    // inventing a refusal the sim does not have.
    const through = roomsInColumn(tower, column, width, command.bottom, command.top);
    return { ok: true, cost, footprint, command, note: through ? 'passes through ' + through + ' rooms' : '' };
  }

  if (command.type === 'add_car') {
    const footprint = { kind: 'carrier', carrier: target.carrier };
    if (!affordable) return refuse(cannotAfford(cost, ledger, 'a car costs '), { cost, footprint });
    return { ok: true, cost, footprint, command };
  }

  if (command.type === 'demolish') {
    const o = target.object;
    const footprint = { kind: 'room', floor: o.floor, left: o.left, right: o.right };
    if (isRented(o.unitStatus)) return refuse('that unit is let — you cannot evict a tenant', { cost: 0, footprint });
    return { ok: true, cost: 0, footprint, command };
  }

  return refuse('unknown command "' + command.type + '"');
}

/** The two funds refusals in `sim/actions.js`, word for word. */
const cannotAfford = (cost, ledger, lead = 'that costs ') =>
  lead + '$' + cost.toLocaleString('en-US') + ' and you have $' + ledger.cash.toLocaleString('en-US');

/** A shaft's tile width, from the carrier model rather than a guess. */
const shaftWidth = (spec) => SHAFT_WIDTH[spec.mode];

/** How many placed rooms a shaft footprint would run through. */
function roomsInColumn(tower, column, width, bottom, top) {
  const right = column + width - 1;
  let n = 0;
  for (const o of tower.objects.values()) {
    if (o.floor < bottom || o.floor > top) continue;
    if (o.left <= right && o.right >= column) n++;
  }
  return n;
}
