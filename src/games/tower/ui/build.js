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
import { BUILDABLE, SHAFT_KIND, hasTenant, shaftObstruction } from '../sim/actions.js';
import {
  chargeConstruction, payout, placementCost, CONSTRUCTION_COST, TYPE_CODES,
} from '../sim/economy.js';

/**
 * ⚠️ `payout(family, tier)` does not take a family code.
 *
 * Its first parameter is named `family`, but it looks the row up in
 * `RENT_TIERS`, which is keyed by cost NAME — `'office'`, `'condo'` — while a
 * family code is a number. `RENT_TIERS[7]` is undefined, so it silently returns
 * `0` and the rent reads as "this room does not pay rent". Reported to sim/.
 *
 * The map back is inverted from the sim's own `TYPE_CODES` rather than written
 * out, so it cannot drift. `object.type` and not `object.family`:
 * `specs/DATA-MODEL.md` § Type Namespaces keeps the two apart deliberately, and
 * `TYPE_CODES` is the type one — they happen to be equal today.
 */
const RENT_KEY = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([name, code]) => [code, name]),
);
import { GROUND_FLOOR, TILES_PER_FLOOR, floorExists, floorLabel, spanBlocked } from '../sim/state.js';
import { MAX_SERVED_SPAN, SHAFT_WIDTH } from '../sim/elevators.js';

/** Rent tiers run 0 (dearest) to 3 (the one that always passes). */
export const RENT_TIER_COUNT = 4;
export const nextRentTier = (tier) => ((Number(tier) || 0) + 1) % RENT_TIER_COUNT;

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
  // Extending sits next to the shaft that made it necessary. It is the fix for
  // a stranded floor and it is free, so it should be the first thing a player
  // reaches for before paying $200,000 for a second lift.
  { id: 'extend_shaft', action: 'extend_shaft', label: 'Extend lift' },
  { id: 'add_car', action: 'add_car', label: 'Add car' },
  { id: 'set_rent', action: 'set_rent', label: 'Rent' },
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
    /**
     * Point above a lift to raise its top, below to drop its bottom. The floor
     * under the cursor IS the new end, so there is nothing to drag and no
     * handle to find — and pointing *inside* the span is not a command at all,
     * because "extend to a floor it already serves" is a no-op that
     * `applyAction` would answer `ok` to, and a success that changes nothing is
     * worse than being told to point somewhere else.
     */
    case 'extend_shaft': {
      const carrier = target.columnCarrier;
      if (!carrier) return null;
      if (target.floor > carrier.topFloor) return { type: 'extend_shaft', carrierId: carrier.id, top: target.floor };
      if (target.floor < carrier.bottomFloor) return { type: 'extend_shaft', carrierId: carrier.id, bottom: target.floor };
      return null;
    }
    case 'set_rent':
      return target.object ? { type: 'set_rent', objectId: target.object.id, tier: nextRentTier(target.object.rentLevel) } : null;
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
    // These say what the tool still needs, which is not a rule and cannot
    // disagree with the sim — `applyAction` is never sent a command at all.
    if (tool?.action === 'add_car') return refuse('point at a shaft');
    if (tool?.action === 'demolish') return refuse('point at something to demolish');
    if (tool?.action === 'set_rent') return refuse('point at a room');
    if (tool?.action === 'extend_shaft') {
      return refuse(target?.columnCarrier ? 'point above or below the lift to extend it' : 'point at a lift');
    }
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
    // In the seam's own order — after the floor check, before the span check —
    // and in the seam's own words. A refusal the sim has and the ghost does not
    // is the "passes through 12 rooms" bug again: a green ghost over a
    // basement, and a click that does nothing.
    if (spec.aboveGrade && command.floor <= GROUND_FLOOR) {
      return refuse('a ' + spec.label.toLowerCase() + ' has to go above the ground floor', { cost, footprint });
    }
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
    // The clearance rule, asked of the sim rather than restated. It used to be
    // a *note* — "passes through 12 rooms" — because `sim/actions.js` permitted
    // it and inventing a refusal the sim did not have would have been a rule in
    // two places. It is a rule now, so it is a refusal now, in its own words.
    const blocked = shaftObstruction(tower, { mode: spec.mode, bottom: command.bottom, top: command.top, column });
    if (blocked) return refuse(blocked, { cost, footprint });
    return { ok: true, cost, footprint, command };
  }

  /**
   * Extending is free (`spec/DEVIATIONS.md` A12 — the reference has an elevator
   * editor and never prices it), so the ghost draws the whole new span and says
   * so rather than quoting nothing.
   */
  if (command.type === 'extend_shaft') {
    const carrier = target.columnCarrier;
    const bottom = command.bottom ?? carrier.bottomFloor;
    const top = command.top ?? carrier.topFloor;
    const footprint = { kind: 'shaft', column: carrier.column, width: carrier.shaftWidth, bottom, top };
    if (!floorExists(bottom) || !floorExists(top)) return refuse('that leaves the tower', { cost: 0, footprint });
    if (top - bottom + 1 > MAX_SERVED_SPAN) {
      return refuse('a shaft serves at most ' + MAX_SERVED_SPAN + ' floors — use a sky lobby', { cost: 0, footprint });
    }
    // Only the NEW span is checked, so a lift is never blocked by the rooms it
    // already legally serves — the same two ranges `extend_shaft` walks.
    for (const [from, to] of [[bottom, carrier.bottomFloor - 1], [carrier.topFloor + 1, top]]) {
      if (from > to) continue;
      const stopped = shaftObstruction(tower,
        { mode: carrier.mode, bottom: from, top: to, column: carrier.column }, carrier.id);
      if (stopped) return refuse(stopped, { cost: 0, footprint });
    }
    return { ok: true, cost: 0, footprint, command, note: 'reaches ' + floorLabel(top === carrier.topFloor ? bottom : top) };
  }

  /**
   * Rent. One click cycles the tier, because four tiers do not deserve four
   * buttons and the ghost says what the next one is worth before you commit.
   */
  if (command.type === 'set_rent') {
    const o = target.object;
    const footprint = { kind: 'room', floor: o.floor, left: o.left, right: o.right };
    const rent = payout(RENT_KEY[o.type ?? o.family], command.tier);
    if (!rent) return refuse('that room does not pay rent', { cost: 0, footprint });
    return {
      ok: true, cost: 0, footprint, command,
      note: 'tier ' + o.rentLevel + ' → ' + command.tier + ' · $' + rent.toLocaleString('en-US'),
    };
  }

  if (command.type === 'add_car') {
    const footprint = { kind: 'carrier', carrier: target.carrier };
    if (!affordable) return refuse(cannotAfford(cost, ledger, 'a car costs '), { cost, footprint });
    return { ok: true, cost, footprint, command };
  }

  if (command.type === 'demolish') {
    const o = target.object;
    const footprint = { kind: 'room', floor: o.floor, left: o.left, right: o.right };
    // The sim's own predicate, not a second reading of `unitStatus` — a shop is
    // in the open band from the moment it is placed and has no tenant to evict.
    if (hasTenant(o)) return refuse('that unit is let — you cannot evict a tenant', { cost: 0, footprint });
    return { ok: true, cost: 0, footprint, command };
  }

  return refuse('unknown command "' + command.type + '"');
}

/** The two funds refusals in `sim/actions.js`, word for word. */
const cannotAfford = (cost, ledger, lead = 'that costs ') =>
  lead + '$' + cost.toLocaleString('en-US') + ' and you have $' + ledger.cash.toLocaleString('en-US');

/** A shaft's tile width, from the carrier model rather than a guess. */
const shaftWidth = (spec) => SHAFT_WIDTH[spec.mode];

