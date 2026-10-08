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
  hotelSingle: 3,
  hotelTwin: 4,
  hotelSuite: 5,
  office: 7,
  condo: 9,
  restaurant: 6,
  retail: 10,
  fastFood: 0x0c,
  housekeeping: 0x0f,
  /**
   * The security office, `specs/ECONOMY.md` § Construction Costs (`0x0e`,
   * $100,000) and `specs/FACILITIES.md` § Type codes (`14` / `0x0E`). Six guards
   * live in it; they are staff (`sim/security.js`).
   */
  security: 0x0e,
  /**
   * **The three things the tower demands back** (issue #13). Type codes are
   * `specs/ECONOMY.md` § Construction Costs: medical `0x0d`, parking space `0x0b`,
   * parking ramp `0x2c`, and the recycling center's two floors `0x14` (upper) and
   * `0x15` (lower, `specs/facility/RECYCLING.md` § Identity). None of them owns an
   * actor: a medical center is a clinic the office workers visit, a parking space
   * holds cars, a recycling center is a number the star ladder reads.
   */
  medical: 0x0d,
  parkingSpace: 0x0b,
  parkingRamp: 0x2c,
  recyclingUpper: 0x14,
  recyclingLower: 0x15,
  /**
   * The two entertainment venues are TWO-FLOOR facilities, and each floor is its
   * own placed object (`specs/facility/ENTERTAINMENT.md` § Placed-Object Types:
   * *"Adjacent type codes denote upper and lower halves, base type = upper,
   * base+1 = lower"*). The movie theater is `0x12` over `0x13`, the party hall
   * `0x1d` over `0x1e`. (The theater's internal stairway split, `0x22` / `0x23`,
   * is a reference artefact of its object table and is not modelled: the
   * facility is one box per floor here. `spec/DEVIATIONS.md` A41.)
   */
  theaterUpper: 0x12,
  theaterLower: 0x13,
  partyHallUpper: 0x1d,
  partyHallLower: 0x1e,
  /**
   * **The metro station is a three-floor stack** (`specs/facility/METRO.md` § Identity):
   * `0x1f` on the top (anchor) floor, `0x20` in the middle and `0x21` at the bottom,
   * each its own placed object and all three carrying family `0x1f`, as a recycling
   * center's two halves carry `0x14`. Only the top is priced (`sim/economy.js` has
   * `TYPE_CODES.metroStation = 0x1f`), so the other two are charged no upkeep and the
   * station is not paid for three times. `sim/metro.js`.
   */
  metroTop: 0x1f,
  metroMiddle: 0x20,
  metroBottom: 0x21,
};

export const FAMILY = {
  lobby: 0x18,
  /**
   * Hotel rooms, `specs/facility/HOTEL.md`: *"Families `3`, `4`, and `5` are
   * hotel rooms."* Three codes, one state machine (`sim/hotel.js`) — the family
   * only chooses the guest count, the payout row and the construction price.
   * `specs/FACILITIES.md` § Type codes: `3` Single Room, `4` Twin Room,
   * `5` Hotel Suite.
   */
  hotelSingle: 3,
  hotelTwin: 4,
  hotelSuite: 5,
  office: 7,
  condo: 9,
  /**
   * ⚠️ **Fast food is `0x0c`. `6` is the Restaurant.**
   *
   * `fastFood` was `6` here until commercial landed, and `sim/economy.js` has
   * always priced `0x06` at $200,000 (Restaurant) and `0x0c` at $100,000 (Fast
   * Food). `sim/ledger-adapter.js` caught the clash and said *"nothing turns on
   * it today — but it will the day commercial lands"*. It did: a fast food
   * placed as type 6 would have been charged restaurant money and run the
   * restaurant's evening gate instead of the all-day trickle.
   *
   * `specs/facility/COMMERCIAL.md` § Included Types is triple-checked against
   * the construction string table: *"type 6→'Restaurant - $200000', type
   * 10→'Retail Shop - $100000', type 12→'Fast Food - $100000'"*. Every use of
   * these names is symbolic, so the codes moving is invisible everywhere except
   * where it was wrong.
   */
  restaurant: 6,
  retail: 10,
  fastFood: 0x0c,
  /**
   * The housekeeping helper, `specs/facility/HOUSEKEEPING.md` § Family `0x0f`
   * (`FACILITIES.md` § Type codes: 15 / 0x0F). The placed facility and its six
   * staff carry the same code, as the guests of a hotel room do.
   */
  housekeeping: 0x0f,
  /**
   * The security office and its guards, `specs/FACILITIES.md` § Type codes
   * (`14` / `0x0E`), `specs/TIME.md` § 2500 (*"14/33 (0xe/0x21 - security/hotel
   * guest): -> `0x01`"*). The placed facility and its six guards carry one code.
   */
  security: 0x0e,
  /**
   * `specs/FACILITIES.md` § Type codes: `13` Medical Center, `11` Parking Space,
   * `44` Parking Ramp, `20` Recycling Center. Both halves of a recycling center
   * carry the one family, as both halves of a theater do; the half is the placed
   * `type`. (`sim/medical.js`, `sim/parking.js`, `sim/recycling.js`.)
   */
  medical: 0x0d,
  parkingSpace: 0x0b,
  parkingRamp: 0x2c,
  recycling: 0x14,
  /**
   * The audience of a movie theater (`0x12`) and the guests of a party hall
   * (`0x1d`). Both halves of a facility carry its family; the half is the
   * placed `type`. Their actors are the venue's *visitors*, exactly as a
   * restaurant's 48 are its customers - see `sim/entertainment.js`.
   */
  theater: 0x12,
  partyHall: 0x1d,
  /**
   * The metro station's three floors (`specs/facility/METRO.md`; `ECONOMY.md` type
   * `0x1f`). The family is the TOP floor's type, which is also what the star ladder's
   * `metroPlaced` latch watches (`sim/progression.js` `PLACEMENT_GATES`); the middle
   * and bottom floors are the same family with their own placed `type`. No actors:
   * the commuters it brings are the tower's own workers, re-routed (`sim/metro.js`).
   */
  metro: 0x1f,
};

/**
 * Facilities that own no actors and no tenants (issue #13): a clinic, a parking
 * space, a ramp, a recycling center. They are placed at `unit_status` `0`, which
 * reads as "let" to `isUnitLet`, so without this set `hasTenant` would refuse to
 * demolish a parking space for evicting a tenant it never had.
 */
export const SERVICE_FACILITY_FAMILIES = new Set([
  FAMILY.medical, FAMILY.parkingSpace, FAMILY.parkingRamp, FAMILY.recycling, FAMILY.metro,
]);

/** Families whose actors are **staff**: they work the tower, they do not live in it. */
export const STAFF_FAMILY_CODES = new Set([FAMILY.housekeeping, FAMILY.security]);
export const isStaffFamily = (family) => STAFF_FAMILY_CODES.has(family);
/** Is this actor a member of staff? Staff are not population and have no stress. */
export const isStaff = (actor) => isStaffFamily(actor?.family);

/**
 * How many runtime actors a placed object owns. `specs/DATA-MODEL.md`
 * § occupant_index, and `specs/facility/COMMERCIAL.md` § Role for the venues:
 * *"fast food (12): 48 sim slots plus one linked CommercialVenueRecord"*.
 *
 * A venue's 48 are its **customers**, not its staff — which is why the venue
 * contributes no fixed population of its own and why the daily capacity limit
 * matters: it decides how many of the 48 actually travel today.
 */
export const OCCUPANTS = {
  // Hotel guests: 1 / 2 / 2. `specs/facility/HOTEL.md` § Placement says the
  // room allocates **2 / 3 / 3** sim slots, but the reference *implementation*
  // never services slot 0 (`processHotelSim`: "the first occupant is never
  // refreshed, so its state persists") and scores the room over the other
  // 1 / 2 / 2 — which is also what `specs/PEOPLE.md` § Scoring, `FACILITIES.md`
  // step 2 and the help file (*"They hold one tenant"* / *"two tenants"* /
  // *"They can accommodate two guests"*) all say. This build models only the
  // guests that run. `spec/DEVIATIONS.md` A25.
  [FAMILY.hotelSingle]: 1,
  [FAMILY.hotelTwin]: 2,
  [FAMILY.hotelSuite]: 2,
  [FAMILY.office]: 6,
  [FAMILY.condo]: 3,
  // All three commercial venues own 48 customer sims. `COMMERCIAL.md` § Role:
  // *"restaurant (6): 48 sim slots ... retail (10): 48 ... fast food (12): 48"*
  // (`spec/DEVIATIONS.md` A15).
  [FAMILY.restaurant]: 48,
  [FAMILY.retail]: 48,
  [FAMILY.fastFood]: 48,
  // Housekeeping: **six staff** per facility. `specs/PEOPLE.md` § Family `0x0f`
  // ("One per hotel room entity slot"), the reference implementation's
  // `processHousekeepingSim` (*"For housekeeping (pop=6) ... each of the 6 HK
  // helpers in a tile services a distinct `floor % 6` residue"*) and the original
  // game's own manual ("6 staff") agree. They are placed with the facility, not
  // hired later, exactly as an office's workers are.
  [FAMILY.housekeeping]: 6,
  // Security: **six guards** per office (issue #12: "6 staff"). Not stated in
  // `specs/`; the reference implementation's `ENTITY_POPULATION_BY_TYPE` gives
  // family `0x0e` six sims, as it gives `0x0f`, and the two staff facilities
  // share a type table. Placed with the office, never hired.
  // `spec/DEVIATIONS.md` A47.
  [FAMILY.security]: 6,
  // The audience a venue half can seat, `ENTERTAINMENT.md` § Runtime Budget
  // Rules: a theater's per-half budget runs 60 / 60 / 40 / 20 by film age, so
  // sixty sims per half is what lets the budget - not the headcount - be the
  // limit; a party hall's lower half is budgeted 50 (the analysis' "50 guests").
  // The spec's own *40-slot span* would cap a theater at 80 and a hall at 40,
  // which makes the $15,000 tier and the 50 guests unreachable.
  // `spec/DEVIATIONS.md` A41. (The party hall's UPPER half owns none: it is
  // "seeded to 0, never consumed" - placement passes `occupantCount: 0`.)
  [FAMILY.theater]: 60,
  [FAMILY.partyHall]: 50,
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
 * exists. A fast food owns **48** actors and contributes `0`: they are its
 * customers, and they are counted where customers are counted — the venue's
 * daily visitor roll into the population ledger, not here.
 *
 * Read by `population()` since the commercial family machine landed. The gate
 * on a commercial unit is its **linked venue record**, not its `unit_status` —
 * see the note there.
 */
export const POPULATION_CONTRIBUTION = {
  // While a guest is checked in, and only then. A hotel's population is its
  // stay, not its lease — see `isHotelBooked` in `sim/hotel.js`. 1 / 2 / 2:
  // `specs/PEOPLE.md` § Families 3,4,5 — *"adds to population ledger
  // (+1/+2/+2 for families 3/4/5)"*. `spec/DEVIATIONS.md` A25 (the suite).
  [FAMILY.hotelSingle]: 1,
  [FAMILY.hotelTwin]: 2,
  [FAMILY.hotelSuite]: 2,
  [FAMILY.office]: 6,
  [FAMILY.condo]: 3,
  [FAMILY.retail]: 10,
  [FAMILY.restaurant]: 0,
  [FAMILY.fastFood]: 0,
  // **Staff are not population.** Six actors, no people: `specs/PEOPLE.md` § Family
  // `0x0f` calls the helper *"not a persistent occupant"*, nothing in
  // `specs/ECONOMY.md` § Ledgers adds a housekeeper to a population bucket, and
  // the original's star ladder counts tenants. An explicit `0`, not an absent
  // key: `population()` falls back to `OCCUPANTS` for a missing entry, which would
  // count the six staff as residents. `spec/DEVIATIONS.md` A33.
  [FAMILY.housekeeping]: 0,
  // Guards are staff, not residents - the same explicit `0` and for the same
  // reason (`population()` falls back to `OCCUPANTS` for a missing key, and
  // would count six guards as six more people the star ladder never saw).
  [FAMILY.security]: 0,
  // A venue's visitors are counted where visitors are counted - the daily
  // rebuild's `cinema` / `partyHall` population buckets (`sim/entertainment.js`),
  // not as residents. An explicit 0, for the reason housekeeping's is one: a
  // missing key falls back to `OCCUPANTS` and would count 120 audience members
  // as people who live here.
  [FAMILY.theater]: 0,
  [FAMILY.partyHall]: 0,
  // The four service facilities own no actors at all, and an explicit `0` anyway,
  // for the reason every row above gives: a future occupant count must not turn
  // a clinic into residents. A parked car is not a person either - the cars
  // belong to office workers and suite guests who are already counted.
  [FAMILY.medical]: 0,
  [FAMILY.parkingSpace]: 0,
  [FAMILY.parkingRamp]: 0,
  [FAMILY.recycling]: 0,
  // The metro owns no actors and is no one's home: its commuters are office workers
  // who are already counted where they work (`sim/metro.js`). An explicit `0` for the
  // reason every row above gives - `population()` reads a missing key from `OCCUPANTS`.
  [FAMILY.metro]: 0,
};

/** Families whose population is gated on a linked venue record rather than a lease. */
export const COMMERCIAL_FAMILY_CODES = new Set([FAMILY.restaurant, FAMILY.retail, FAMILY.fastFood]);

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

/**
 * ⚠️ **A condo's "let" band is wider than an office's, and `isRented` is the
 * office's.**
 *
 * `specs/facility/CONDO.md` § Placement And Stored State, in its own words:
 * *"The selected-object status panel treats `unit_status > 0x17` as the unsold
 * / for-sale status and `unit_status <= 0x17` as sold/open."* The sold band is
 * `0x00..0x17` — the two base values `0x00`/`0x08`, **plus the in-cycle sold
 * countdown states below `0x18`, and `0x10` itself**, which is the sync
 * sentinel every sold condo is clamped to overnight.
 *
 * So `isRented(0x10)` is `false` and a sold condo sits at `0x10` every night.
 * Read the office band for a condo and the unit reads FOR SALE between dusk and
 * the next morning's dispatch: its three residents leave the population count,
 * the ledger stops treating it as operational, and `demolish` stops refusing.
 * That is `CLAUDE.md`'s "two modules name one concept twice" trap with a
 * nightly period.
 *
 * {@link isUnitLet} is the translation, and it takes the **object** rather than
 * the byte precisely so a caller cannot forget which family it is holding.
 */
export const CONDO_UNIT_STATUS = {
  /** `0x00` before daypart 4, `0x08` after. `specs/TIME.md` § Tick Model. */
  soldEarly: 0x00,
  soldLate: 0x08,
  /** The overnight clamp target, and the countdown's terminus. */
  syncMarker: 0x10,
  /** Everything at or below this is sold. */
  soldMax: 0x17,
  /** Refund lands here: `0x18` before daypart 4, `0x20` after. */
  unsoldEarly: 0x18,
  unsoldLate: 0x20,
  /** `>= 0x28` is extended vacancy / expiry, which nothing reaches yet. */
  expiryMin: 0x28,
};

/**
 * A hotel room's `unit_status`, `specs/facility/HOTEL.md` § Placement And
 * Stored State — *"preserve the three-band semantic split"*:
 *
 *   occupied / open        `0x00..0x17`   a guest is checked in
 *   vacant / available     `0x18..0x27`   ready for tonight's guest
 *   checked out / dirty    `0x28..0x37`   **needs housekeeping** (`sim/housekeeping.js`)
 *   infested               `0x38..0x40`   cockroaches; only demolition cures it
 *
 * The `0x00`/`0x08` (and `0x18`/`0x20`, `0x28`/`0x30`, `0x38`/`0x40`) pairs are
 * the reference's half-day branch — *"morning starts at 0, evening starts at 8"*
 * — and carry no meaning of their own beyond which half of the day wrote them.
 * `spec/DEVIATIONS.md` A31.
 *
 * **There is no separate "dirty" boolean on the object, on purpose.** The band
 * IS the flag (the housekeeping claimant's search is *"a slot qualifies only
 * when the room `unit_status` is `0x28` or `0x30`"*), and a second field kept in
 * step with it is exactly the drift `CLAUDE.md` warns about. Read it with
 * `isHotelRoomDirty(object)` in `sim/hotel.js`.
 */
export const HOTEL_UNIT_STATUS = {
  /** Everything at or below is a guest in residence. Same ceiling as a sold condo. */
  occupiedMax: 0x17,
  /** What activation writes: `0x00` before daypart 4, `0x08` after. */
  occupiedEarly: 0x00,
  occupiedLate: 0x08,
  /** The overnight clamp, and the value the checkout rewrite starts from. */
  syncMarker: 0x10,
  /** Placement and cleaning write `0x18` before daypart 4, `0x20` after. */
  vacantEarly: 0x18,
  vacantLate: 0x20,
  vacantMax: 0x27,
  /** Checkout writes `0x28` before daypart 4, `0x30` after. */
  dirtyEarly: 0x28,
  dirtyLate: 0x30,
  dirtyMax: 0x37,
  /** `0x38` / `0x40`. Written by `infestHotelRoom` and never written back. */
  infestedEarly: 0x38,
  infestedLate: 0x40,
};

/** The three hotel family codes. */
export const HOTEL_FAMILY_CODES = new Set([FAMILY.hotelSingle, FAMILY.hotelTwin, FAMILY.hotelSuite]);
export const isHotelFamily = (family) => HOTEL_FAMILY_CODES.has(family);

/** The highest `unit_status` that still counts as let, by family. */
export const letBandMax = (family) =>
  (family === FAMILY.condo || isHotelFamily(family)
    ? CONDO_UNIT_STATUS.soldMax
    : UNIT_STATUS.activeMax);

/** Is this placed unit let (an office rented, a condo sold)? */
export const isUnitLet = (object) =>
  Boolean(object) && object.unitStatus <= letBandMax(object.family);

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
  if (family === FAMILY.condo) {
    return daypart < 4 ? CONDO_UNIT_STATUS.unsoldEarly : CONDO_UNIT_STATUS.unsoldLate;
  }
  // `HOTEL.md`: *"hotel placement does **not** start in the checked-out band"* —
  // a new room is vacant (`0x18` / `0x20`), not dirty.
  if (isHotelFamily(family)) {
    return daypart < 4 ? HOTEL_UNIT_STATUS.vacantEarly : HOTEL_UNIT_STATUS.vacantLate;
  }
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
    /**
     * `family345_sale_count`: checkouts since checkpoint 1200 (`specs/TIME.md`
     * § 1200 resets it). `specs/facility/HOTEL.md` § Checkout effects — it drives
     * the newspaper popup, which this build counts but does not show yet.
     */
    hotelSaleCount: 0,
    /** `newspaper_trigger`, recomputed at every checkout. `0` or `1`. */
    newspaperTrigger: 0,
    /**
     * The bomb and fire bits of the reference's `game_state_flags`
     * (`specs/EVENTS.md`: *"suppressed while a bomb or fire event is already
     * active"*). Nothing sets them yet - the events themselves are issue #16 -
     * but entertainment already reads them (`entertainmentPaysToday`): *"entertainment
     * pays nothing on bomb/fire days"*. Whoever builds the events sets these two
     * booleans while an event is live and clears them when it ends.
     */
    events: { bombActive: false, fireActive: false },
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
 * @param {(tower:object, object:object) => void} [finalize] the family-specific
 *   placement finalizer. `specs/FACILITIES.md` § Placement Finalizer: most
 *   families run one after the core record is written, and it is where a
 *   commercial venue's linked record is created. Passed in rather than
 *   imported, so this file stays the spine and learns nothing about families.
 * @returns {{ok:boolean, reason?:string, object?:object}}
 *
 * `placement.occupantCount` / `placement.occupantState` override the family's
 * `OCCUPANTS` entry and the unplaced-occupant start state. A two-floor facility
 * needs both: a party hall's upper half owns nobody, and a venue's visitors
 * start parked rather than waiting to be hired.
 */
export function placeObject(tower, placement, makeTripFields = () => ({}), finalize = null) {
  const { family, floor, left, right } = placement;
  if (!floorExists(floor)) return { ok: false, reason: 'floor ' + floor + ' is outside the tower' };
  if (!Number.isInteger(left) || !Number.isInteger(right) || right < left) {
    return { ok: false, reason: 'that span is not a span' };
  }
  if (left < 0 || right >= TILES_PER_FLOOR) return { ok: false, reason: 'that span runs off the lot' };
  if (spanBlocked(tower, floor, left, right)) return { ok: false, reason: 'something is already built there' };

  const object = createObject({ ...placement, daypart: tower.clock?.daypart ?? 0 });
  tower.objects.set(object.id, object);
  // Before the actors, because a family finalizer builds the thing they act
  // on — a venue's customers must never exist without the venue's record.
  finalize?.(tower, object);

  // The six workers, at placement, before anything is rented.
  const count = placement.occupantCount ?? OCCUPANTS[family] ?? 0;
  for (let occupantIndex = 0; occupantIndex < count; occupantIndex++) {
    const actor = createActor({
      family,
      anchorFloor: floor,
      objectId: object.id,
      occupantIndex,
      state: placement.occupantState ?? STATE_UNPLACED_OCCUPANT,
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
    // ⚠️ `isUnitLet(o)`, not `isRented(o.unitStatus)`. A sold condo sits at the
    // sync sentinel `0x10` every night, which is OUTSIDE the office's let band —
    // so reading the office band here drops three people per condo between dusk
    // and dawn. A population that breathes once a day, and star thresholds that
    // read it. `isUnitLet` is the office band for every other family, so this
    // costs nothing anywhere else.
    if (!isUnitLet(o)) continue;
    if (!contributesPopulation(o)) continue;
    total += POPULATION_CONTRIBUTION[o.family] ?? OCCUPANTS[o.family] ?? 0;
  }
  return total;
}

/**
 * Is this unit actually contributing its people yet?
 *
 * For anything with a lease, the lease is the answer. For a **commercial**
 * unit it is not: `initialUnitStatus` starts a shop at `0`, which reads as let
 * the instant it is placed, so `isRented` alone would have counted retail's
 * `10` for four shops nobody had ever visited — the 40 phantom residents the
 * old `TODO(parity)` here refused to ship.
 *
 * `specs/facility/COMMERCIAL.md` § Retail Income Timing draws the line in the
 * reference's own terms: *"first open marks the linked venue record available
 * ... it adds `+10` to the primary family ledger"*, and the status panel
 * *"keys retail visibility off the linked venue record's dormant flag, not off
 * its current occupancy count"*. So a commercial unit counts once its linked
 * record exists and is not dormant, and a shop with no record — which is every
 * retail shop until family 10 gets a machine — counts nobody.
 */
function contributesPopulation(object) {
  if (!COMMERCIAL_FAMILY_CODES.has(object.family)) return true;
  const venue = object.venue;
  return !!venue && venue.availability !== 0xff;
}

/** Reset the id counters. Tests only — the sim never needs this. */
export function __resetIds() { nextObjectId = 1; nextActorId = 1; }
