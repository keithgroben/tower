/**
 * The tower: what is built, who lives in it, and what it all costs.
 *
 * Spec: `specs/DATA-MODEL.md`, `specs/facility/OFFICE.md` § Parity: Placement
 * And Stored State, `specs/PEOPLE.md` § Shared State-Code Convention.
 *
 * This is the spine the other modules plug into. Routing asks it what is
 * built and which carriers serve which floors; the economy asks it what to
 * charge; the family state machines live on the actors it allocates.
 *
 * The single most important thing in this file, and the reason the whole
 * rebuild exists:
 *
 *   **Placing an office creates its six workers immediately.**
 *
 * Not at rental time — at placement. They start parked, unemployed, in state
 * `0x20`. The office rents later, when one of them succeeds in routing from
 * the lobby. Occupancy is an *outcome of transport*, not a score that transport
 * feeds into. Everything else here is bookkeeping in service of that sentence.
 */
import { makeRng } from './rng.js';
import { createClock } from './clock.js';

// ---------------------------------------------------------------- the world
//
// `specs/DATA-MODEL.md` § World Indexing. 120 logical floors, `-10..109`.
// Logical 0 is the ground lobby; the reference's EXE constants are 10 higher,
// so anything quoted from the binary needs `logical = exe - 10` applied.

export const GROUND_FLOOR = 0;
export const MIN_FLOOR = -10;
export const MAX_FLOOR = 109;
export const FLOOR_COUNT = MAX_FLOOR - MIN_FLOOR + 1;

/** Tiles across the lot. Objects occupy a horizontal span of these. */
export const TILES_PER_FLOOR = 150;

export const isBasement = (floor) => floor < GROUND_FLOOR;
export const floorExists = (floor) => Number.isInteger(floor) && floor >= MIN_FLOOR && floor <= MAX_FLOOR;

/** `F6`, or `B2` for a basement. The one place a floor index becomes a name. */
export const floorLabel = (floor) => (isBasement(floor) ? 'B' + -floor : 'F' + floor);

/**
 * Sky lobbies sit every fifteen floors.
 *
 * TODO(parity): the reference contradicts itself here and it matters for
 * express routing. `specs/ELEVATORS.md` puts them where
 * `(exe_floor - 10) % 15 == 14` — EXE 24/39/54, i.e. **logical 14/29/44** —
 * and `specs/DATA-MODEL.md` line 22 confirms that translation with a worked
 * example (EXE 24 => logical 14). But `DATA-MODEL.md` line 11 says "logical
 * floors 15, 30, 45". Going with the EXE-derived value, since it comes with
 * its own arithmetic and the other reads like a human-facing round number
 * (logical 14 is the fifteenth storey if you count the ground floor as one).
 * Raised with Keith; if it flips, only this constant moves.
 */
export const SKY_LOBBY_INTERVAL = 15;
export const isSkyLobbyFloor = (floor) => floor > GROUND_FLOOR && floor % SKY_LOBBY_INTERVAL === 14;

/** The zone band a floor belongs to. EXE `(f - 9) / 15` translated to logical. */
export const zoneBand = (floor) => Math.max(0, Math.floor((floor + 1) / SKY_LOBBY_INTERVAL));

// -------------------------------------------------------------- type codes
//
// `specs/DATA-MODEL.md` § Type Namespaces: the placed type and the behaviour
// family are separate concepts that usually — but not always — match. Kept
// apart here so the day they diverge is not a debugging session.

export const OBJECT_TYPE = {
  lobby: 0x18,
  office: 7,
  condo: 9,
  fastFood: 6,
  retail: 10,
};

export const FAMILY = {
  lobby: 0x18,
  office: 7,
  condo: 9,
  fastFood: 6,
  retail: 10,
};

/** How many runtime actors a placed object owns. `specs/DATA-MODEL.md` § occupant_index. */
export const OCCUPANTS = {
  [FAMILY.office]: 6,
  [FAMILY.condo]: 3,
};

/**
 * How many people a let unit contributes to the tower's population.
 *
 * Usually its occupant count — but **not for the commercial families**.
 * `specs/facility/COMMERCIAL.md`: retail contributes `10` while owning no
 * resident actors at all, because a shop's population is its *customers*, not
 * its staff. `specs/FACILITIES.md` § Commercial Readiness confirms the split:
 * commercial families are scored on customer count, not on occupant stress.
 *
 * So an office's population and its actor count are the same number by
 * coincidence, and reading one for the other is a trap the moment a shop
 * exists.
 *
 * ⚠️ **Not yet read by `population()`** — see the note at its call site. It is
 * here so the commercial family lands against a rule that already exists
 * rather than inventing a second one.
 */
export const POPULATION_CONTRIBUTION = {
  [FAMILY.office]: 6,
  [FAMILY.condo]: 3,
  [FAMILY.retail]: 10,
  [FAMILY.fastFood]: 0,
};

// ------------------------------------------------------- state-code bands
//
// `specs/PEOPLE.md` § Shared State-Code Convention. Bit 6 is the in-transit
// flag; base state is `state & 0x3f`. Gate handlers are bypassed entirely
// once an actor is in transit, which is what makes a committed trip
// uninterruptible.

export const IN_TRANSIT_FLAG = 0x40;
/** Parked / night. In the `0x2x` band but terminal to the gate. */
export const STATE_PARKED = 0x27;
/**
 * Where a freshly placed occupant starts: waiting for the service request that
 * rents the unit. `specs/facility/OFFICE.md` § Parity: Placement And Stored
 * State — *"Each worker starts with family 7, occupant_index 0..5, state 0x20"*.
 */
export const STATE_UNPLACED_OCCUPANT = 0x20;

export const baseState = (state) => state & 0x3f;
export const isInTransit = (state) => (state & IN_TRANSIT_FLAG) !== 0;
export const enterTransit = (state) => state | IN_TRANSIT_FLAG;

/**
 * `unit_status` bands, `specs/DATA-MODEL.md` § unit_status. The one that
 * matters for offices: **above `0x0f` is vacant / "For Rent"**, at or below is
 * occupied. The status text derives from exactly this, so a rental check is a
 * comparison against `0x0f` and nothing else.
 */
export const UNIT_STATUS = { activeMax: 0x0f, syncMarker: 0x10 };
export const isRented = (unitStatus) => unitStatus <= UNIT_STATUS.activeMax;

/** `eval_level` before anything has been scored. The reference's own sentinel. */
export const EVAL_UNSET = 0xff;

/**
 * What `unit_status` a freshly placed object starts in.
 *
 * ⚠️ `specs/facility/OFFICE.md` § Parity: Placement And Stored State says
 * *"rental status = open-band value `0`"*, and that is **wrong** — it
 * contradicts the same file's "new offices start vacant", and it contradicts
 * the dispatch table, whose `0x20` rows test vacancy as `unit_status >= 0x10`
 * and would never fire "if vacant" for an office placed at 0.
 *
 * The reference's own implementation settles it, with a comment saying so:
 * *"Office starts at 0x10 (unoccupied). Others start at 0."* Hotels and condos
 * start in the unsold band, `0x18` before daypart 4 and `0x20` after.
 *
 * Caught because a test asserted a placed office is not rented and it was —
 * `isRented(0)` is true. Recorded as `spec/DEVIATIONS.md` A11.
 */
export function initialUnitStatus(family, daypart = 0) {
  if (family === FAMILY.office) return 0x10;
  if (family === FAMILY.condo) return daypart < 4 ? 0x18 : 0x20;
  return 0;
}

// ------------------------------------------------------------- the records

let nextObjectId = 1;
let nextActorId = 1;

/**
 * A placed object. `specs/DATA-MODEL.md` § Shared Object Record, and for the
 * initial values `specs/facility/OFFICE.md` § Parity: Placement And Stored
 * State.
 *
 * Note `evalLevel: null` rather than 0. The reference distinguishes
 * "unsampled" from "scored zero", and the difference is load-bearing: a zero
 * eval closes an office, so a freshly placed one that read as 0 would evict a
 * tenant it never had.
 */
export function createObject({ family, type, floor, left, right, rentLevel = 1, daypart = 0 }) {
  return {
    id: nextObjectId++,
    family,
    type: type ?? family,
    floor,
    left,
    right,
    /** Vacant for anything that can be let. See `initialUnitStatus`. */
    unitStatus: initialUnitStatus(family, daypart),
    /** Does it have active tenants? Placement does NOT set this. */
    occupiedFlag: false,
    /** Readiness grade 0/1/2, or `EVAL_UNSET` (0xff) when never sampled. */
    evalLevel: EVAL_UNSET,
    /** The operational-evaluation latch. Active from placement, and NOT the rental flag. */
    evalLatch: true,
    rentLevel,
    /** Cumulative uptime, capped at 120 by the activation sweep. Resets on deactivation. */
    activationTickCount: 0,
    /** Deferred-init countdown, 12 at placement. `specs/FACILITIES.md` § Deferred Object Rebuild. */
    rebuildCountdown: 12,
    dirty: true,
    /** Runtime actor ids this object owns, in occupant order. */
    occupants: [],
  };
}

/**
 * A runtime actor. `specs/DATA-MODEL.md` § Shared Runtime Actor Record.
 *
 * The trip-counter fields belong to the stress pipeline and are spread in from
 * `sim/stress.js`, so there is exactly one definition of them. This factory
 * owns identity, position and intent; that one owns the accounting.
 */
export function createActor({ family, anchorFloor, objectId, occupantIndex, state = STATE_PARKED, tripFields = {} }) {
  return {
    id: nextActorId++,
    family,
    anchorFloor,
    objectId,
    /** Zero-based slot within the parent object. Staggers behaviour. */
    occupantIndex,
    state,
    /** Where this actor is trying to get to, or null. */
    targetFloor: null,
    /** The carrier leg in progress, or null. */
    routeCarrier: null,
    spawnFloor: null,
    ...tripFields,
  };
}

// -------------------------------------------------------------- the tower

export function createTower({ seed = 1, startingCash = 2000000 } = {}) {
  return {
    clock: createClock(),
    rng: makeRng(seed),
    cash: startingCash,
    /** Live per-family active-unit counts. Drives star thresholds. */
    populationLedger: {},
    /** Realized income and expenses since the last 3-day rollover. */
    incomeLedger: {},
    expenseLedger: {},
    cycleBaseCash: startingCash,
    starCount: 1,
    /** Placed objects, by id. */
    objects: new Map(),
    /** Runtime actors, in a flat table. The refresh stride walks this in raw order. */
    actors: [],
    /** Elevator and escalator carriers. Owned by `sim/elevators.js`. */
    carriers: [],
    /**
     * How many storeys the ground lobby occupies. 1, 2 or 3.
     *
     * Not decoration: heights 2 and 3 give departing passengers a 25- or
     * 50-tick stress rebate (`specs/PEOPLE.md` § Lobby-Boarding Stress
     * Reduction). It is the only building-shape decision that directly buys
     * down stress, which makes it the one the player should feel clever about.
     */
    lobbyHeight: 1,
  };
}

// ------------------------------------------------------------- placement

/**
 * Place an object, and give it its runtime actors immediately.
 *
 * The actors are the point. `specs/facility/OFFICE.md`: *"Normal office
 * placement also creates the six worker runtime entities immediately. They are
 * not created lazily at rental time."* Each starts family `7`, `occupant_index`
 * `0..5`, state `0x20`, no route, zeroed timing.
 *
 * @param {object} tower
 * @param {{family:number, type?:number, floor:number, left:number, right:number, rentLevel?:number}} placement
 * @param {(fields:object) => object} [makeTripFields] supplied by the stress
 *   pipeline so actor records carry their accounting from birth
 * @returns {{ok:boolean, reason?:string, object?:object}}
 */
export function placeObject(tower, placement, makeTripFields = () => ({})) {
  const { family, floor, left, right } = placement;
  if (!floorExists(floor)) return { ok: false, reason: 'floor ' + floor + ' is outside the tower' };
  if (!Number.isInteger(left) || !Number.isInteger(right) || right < left) {
    return { ok: false, reason: 'that span is not a span' };
  }
  if (left < 0 || right >= TILES_PER_FLOOR) return { ok: false, reason: 'that span runs off the lot' };
  if (spanBlocked(tower, floor, left, right)) return { ok: false, reason: 'something is already built there' };

  const object = createObject({ ...placement, daypart: tower.clock?.daypart ?? 0 });
  tower.objects.set(object.id, object);

  // The six workers, at placement, before anything is rented.
  const count = OCCUPANTS[family] ?? 0;
  for (let occupantIndex = 0; occupantIndex < count; occupantIndex++) {
    const actor = createActor({
      family,
      anchorFloor: floor,
      objectId: object.id,
      occupantIndex,
      state: STATE_UNPLACED_OCCUPANT,
      tripFields: makeTripFields(),
    });
    tower.actors.push(actor);
    object.occupants.push(actor.id);
  }
  return { ok: true, object };
}

/** Every object standing on `floor`. */
export const objectsOnFloor = (tower, floor) =>
  [...tower.objects.values()].filter((o) => o.floor === floor);

/** Does anything already occupy any tile in `left..right` on this floor? */
export function spanBlocked(tower, floor, left, right) {
  for (const o of tower.objects.values()) {
    if (o.floor !== floor) continue;
    if (o.left <= right && o.right >= left) return true;
  }
  return false;
}

/** The actors belonging to one object, in occupant order. */
export const occupantsOf = (tower, object) =>
  object.occupants.map((id) => tower.actors.find((a) => a.id === id)).filter(Boolean);

/**
 * Live population: the sum of occupants across objects that are actually
 * rented. A placed-but-vacant office holds six workers and contributes none of
 * them, which is the whole distinction the old prototype never drew.
 */
export function population(tower) {
  let total = 0;
  for (const o of tower.objects.values()) {
    // The LEASE, not the measured flag. Since the bootstrap in `sim/office.js`,
    // `occupiedFlag` means "this facility's tenants are being measured" and is
    // set on a VACANT office before anyone has reached it — so counting on it
    // returned 252 people in a tower where 216 had a lease, six offices' worth
    // of staff for offices nobody could get to.
    // TODO(parity): read POPULATION_CONTRIBUTION here once a commercial family
    // machine exists. It cannot be wired yet: the seed marks shops `let` so
    // they draw as shops, and nothing simulates them renting — so counting
    // retail's 10 would report 40 residents in a tower where nobody has moved
    // in. A number that arrives before the thing it counts is exactly the
    // accounting hole this repo keeps a list of, so the rule sits unwired and
    // documented rather than wired and wrong.
    if (isRented(o.unitStatus)) total += OCCUPANTS[o.family] ?? 0;
  }
  return total;
}

/** Reset the id counters. Tests only — the sim never needs this. */
export function __resetIds() { nextObjectId = 1; nextActorId = 1; }
