/**
 * What a placed facility is to the person looking at it (issue #18): its name in the original's
 * words, whether it can be let or sold, how its tenants feel about it, and - in the original's
 * plain words - why they do not.
 *
 * Everything here is a **read** of the tower. The windows and the map overlays in `ui/` ask these
 * functions and draw the answer; none of them keeps a second copy of a rule. The numbers come from
 * the evaluation each family already runs at checkpoint 2533 (`officeScore`, `condoScore`,
 * `hotelScore`, `venueDerivedState`) and the thresholds from `evalLevelFor` - so a colour on the
 * map and a unit closing for unhappiness cannot disagree.
 *
 * Wording: `STR 710` (facility names), `STR 711` (the status lines: "Elevator is very far away",
 * "Neighbors are too noisy", "Room is too dirty"...) and `STR 712` ("Occupied", "For Rent", "For
 * Sale", "Clean", "Dirty") from `analysis/extracted/strings_STRlists.txt`, used verbatim.
 *
 * `HELP.txt` § Facility Window is the only source for the window itself; `specs/` describes none of
 * the original's UI, so what each reading means is recorded in `spec/DEVIATIONS.md` A81-A85.
 */
import {
  COMMERCIAL_FAMILY_CODES, FAMILY, GROUND_FLOOR, SERVICE_FACILITY_FAMILIES, floorLabel, isBasement, isHotelFamily,
  isStaffFamily, isUnitLet,
} from './state.js';
import { EVAL_THRESHOLD_LOWER, evalLevelFor, evalUpperFor, noiseSourceNear, officeScore } from './office.js';
import { condoNoiseNear, condoScore, isCondoSold } from './condo.js';
import {
  hotelNoiseNear, hotelScore, isHotelBooked, isHotelInfested, isHotelRoomDirty,
} from './hotel.js';
import { VENUE, venueDerivedState, venueOf } from './commercial.js';
import { CARRIER_MODE } from './elevators.js';
import { selectBestRouteCandidate, segmentIsStairs } from './routing.js';
import { FACILITY_POPULATION, distancePenalty } from './stress.js';

// ---------------------------------------------------------------- the names

/** `STR 710`, keyed by this build's family codes. */
export const FACILITY_LABEL = {
  [FAMILY.lobby]: 'Lobby',
  [FAMILY.hotelSingle]: 'Single Room',
  [FAMILY.hotelTwin]: 'Twin Room',
  [FAMILY.hotelSuite]: 'Hotel Suite',
  [FAMILY.restaurant]: 'Restaurant',
  [FAMILY.office]: 'Office',
  [FAMILY.condo]: 'Condo',
  [FAMILY.retail]: 'Retail Shop',
  [FAMILY.parkingSpace]: 'Parking Space',
  [FAMILY.fastFood]: 'Fast Food',
  [FAMILY.medical]: 'Medical Center',
  [FAMILY.security]: 'Security',
  [FAMILY.housekeeping]: 'Housekeeping',
  [FAMILY.theater]: 'Movie Theater',
  [FAMILY.recycling]: 'Recycling Center',
  [FAMILY.partyHall]: 'Party Hall',
  [FAMILY.metro]: 'Metro Station',
  [FAMILY.cathedral]: 'Cathedral',
  [FAMILY.parkingRamp]: 'Parking Ramp',
};

export const facilityLabel = (object) => FACILITY_LABEL[object?.family] ?? 'Facility';

/** `STR 712`: *", Floor "* and the basement prefix *"B"*. */
export const floorWords = (floor) => 'Floor ' + (isBasement(floor) ? 'B' + -floor : floor);

/** "Office, Floor 3" - what the original calls a facility nobody has named. */
export const defaultFacilityName = (object) => facilityLabel(object) + ', ' + floorWords(object.floor);

// ------------------------------------------------------- rentable or not

/**
 * The families that pay a rent tier or sell for one: `specs/ECONOMY.md` § Pricing Tiers, *"the
 * player sets it via the facility info dialog for priced families (hotel single/twin/suite, office,
 * condo, retail)"*. The value is the `RENT_TIERS` row (`sim/economy.js`).
 *
 * Everything else - staff, services, the cathedral, venues, the lobby - has no rent or sale, and a
 * window for it must not offer one. The cathedral is the sharp case: its `unitStatus` is meaningless
 * (`sim/cathedral.js`), so "For Rent" would be a sentence with nothing behind it.
 */
export const RENT_ROW = {
  [FAMILY.office]: 'office',
  [FAMILY.condo]: 'condo',
  [FAMILY.retail]: 'retail',
  [FAMILY.hotelSingle]: 'hotelSingle',
  [FAMILY.hotelTwin]: 'hotelTwin',
  [FAMILY.hotelSuite]: 'hotelSuite',
};

/** Does this object have a rent tier at all? */
export const isRentable = (object) => Object.hasOwn(RENT_ROW, object?.family);

/**
 * Why `set_rent` cannot change this object's tier, or `null`. **The one definition**: the seam
 * asks it and so does the ghost and the facility window, so the three cannot word a refusal
 * differently. (The ghost used to check only that the row paid something, and so offered a tier
 * change on a sold condo that the seam then refused.)
 *
 * The condo clause is `specs/ECONOMY.md` § Pricing Tiers: *"Condo (family 9) guard: rent level can
 * only be changed while unsold (`unit_status >= 0x18`)"*.
 */
export function rentRefusal(object) {
  if (!object) return 'nothing there';
  if (!isRentable(object)) return 'that room does not pay rent';
  if (object.family === FAMILY.condo && isUnitLet(object)) {
    return 'that condo is sold — you can only price one that is still for sale';
  }
  return null;
}

/**
 * Is this unit let (or sold, or booked)? The renderer asks the same question
 * (`render/canvas.js` `officeIsLet`); `test/windows.test.js` pins that they agree.
 */
export function isLet(object) {
  if (!object) return false;
  if (isHotelFamily(object.family)) return isUnitLet(object);
  return Boolean(object.occupiedFlag) && isUnitLet(object);
}

/**
 * `STR 712`'s status word, or `null` for a facility that is not let, sold or booked at all (a clinic,
 * the cathedral, a security office, a restaurant). Never "For Rent" for something without a rent.
 */
export function statusWord(object) {
  if (!isRentable(object)) return null;
  if (isHotelFamily(object.family)) {
    if (isHotelInfested(object)) return 'Dirty';
    if (isHotelBooked(object)) return 'Occupied';
    return isHotelRoomDirty(object) ? 'Dirty' : 'Clean';
  }
  if (object.family === FAMILY.retail) return venueOf(object)?.availability === VENUE.dormant ? 'For Rent' : 'Occupied';
  if (object.family === FAMILY.condo) return isLet(object) || isCondoSold(object.unitStatus) ? 'Occupied' : 'For Sale';
  return isLet(object) ? 'Occupied' : 'For Rent';
}

// ------------------------------------------------------------ the readings

/** `eval_level`: `2` good, `1` fair, `0` poor (closes the unit); `null` is "no reading". */
export const LEVEL_WORD = { 2: 'good', 1: 'fair', 0: 'poor' };

/**
 * The scale the Facility window's eval bar is drawn on. A stress score is `0` (calm) to `300` (the
 * clamp, `ELAPSED_CLAMP`); the bar fills left to right with HAPPINESS, so the fill is `1 - score/300`,
 * and its two dividers sit exactly at the two grade thresholds - `HELP.txt`: *"When the red hits the
 * first divider, it turns yellow ... When the yellow increases past the second divider line, it
 * changes to blue"*.
 */
export const EVAL_BAR_SCALE = 300;

/** Where the bar's dividers sit (0..1 of its length) when the tower has `starCount` stars. */
export function evalBarDividers(starCount = 1) {
  return {
    first: 1 - evalUpperFor(starCount) / EVAL_BAR_SCALE,
    second: 1 - EVAL_THRESHOLD_LOWER / EVAL_BAR_SCALE,
  };
}

/** How full the bar is for a stress score (0 = empty and red, 1 = full and blue). */
export const evalBarFill = (score) => Math.max(0, Math.min(1, 1 - score / EVAL_BAR_SCALE));

/** A facility's actors. Linear over the table; pass an index from {@link groupActors} to avoid that. */
export const occupantsOf = (tower, object) =>
  tower.actors.filter((actor) => actor && actor.objectId === object.id);

/** The actors of every object in one pass, by object id. For anything that asks about many objects. */
export function groupActors(tower) {
  const byObject = new Map();
  for (const actor of tower.actors) {
    if (!actor || actor.objectId == null) continue;
    const list = byObject.get(actor.objectId);
    if (list) list.push(actor); else byObject.set(actor.objectId, [actor]);
  }
  return byObject;
}

const NO_READING = Object.freeze({ level: null, score: null, live: false, basis: 'none' });

/**
 * **How a facility's tenants feel, as the evaluation the sim itself runs would grade it right now.**
 *
 * - **Office, condo, hotel room**: the same `officeScore` / `condoScore` / `hotelScore` checkpoint
 *   2533 calls (average stress of the occupants, the rent-tier modifier, the +60 noise penalty),
 *   mapped by `evalLevelFor` at the tower's star count. `live` is true.
 * - If nobody in the unit has taken a trip since the last 3-day reset (`tripCount === 0` for all of
 *   them) the live score would be `0`, **the best grade, for a unit nobody has measured** - the
 *   flattering failure `CLAUDE.md` warns about. So the reading falls back to the grade the last
 *   daily recompute stored (`object.evalLevel`), but **only for a unit that is let**, and says
 *   `live: false`; a vacant unit has no reading at all.
 * - **Venues** (restaurant, fast food, retail): `COMMERCIAL.md` and `FACILITIES.md` § Commercial
 *   Readiness grade a venue by customer count, not stress, and name no mapping onto the three
 *   grades (`A17`). Ours (`A82`): the visitor band (25 / 35 / 50) of the better of today's customers
 *   so far and yesterday's total - 0 poor, 1 and 2 fair, 3 good.
 * - Everything else (staff, services, the cathedral, the lobby, entertainment): no reading.
 *
 * @param {object} tower
 * @param {object} object
 * @param {object[]} [occupants] the object's actors, if the caller already has them
 * @returns {{level: 0|1|2|null, score: number|null, live: boolean, basis: string}}
 */
export function facilityReading(tower, object, occupants = occupantsOf(tower, object)) {
  const venue = venueOf(object);
  if (venue) {
    if (venue.availability === VENUE.dormant) return NO_READING;
    const grade = venueDerivedState(Math.max(venue.acquireCount ?? 0, venue.yesterdayVisitCount ?? 0));
    return { level: grade === 0 ? 0 : grade === 3 ? 2 : 1, score: null, live: false, basis: 'customers' };
  }

  let scorer = null;
  if (object.family === FAMILY.office) scorer = officeScore;
  else if (object.family === FAMILY.condo) scorer = condoScore;
  else if (isHotelFamily(object.family)) scorer = hotelScore;
  if (!scorer) return NO_READING;

  // The families the sim itself does not score in these states (infested rooms, an unsold condo
  // already being measured): no reading, exactly as `recompute*OperationalStatus` writes `EVAL_UNSET`.
  if (isHotelInfested(object) || isHotelRoomDirty(object)) return NO_READING;
  if (object.family === FAMILY.condo && !isCondoSold(object.unitStatus) && object.occupiedFlag) return NO_READING;

  const population = FACILITY_POPULATION[object.family];
  const measured = occupants.some((a) => a.tripCount > 0);
  if (measured && occupants.length >= population) {
    const score = scorer(tower, object, occupants);
    return { level: evalLevelFor(score, tower.starCount), score, live: true, basis: 'stress' };
  }
  if (isLet(object) && (object.evalLevel === 0 || object.evalLevel === 1 || object.evalLevel === 2)) {
    return { level: object.evalLevel, score: null, live: false, basis: 'stored' };
  }
  return NO_READING;
}

// ---------------------------------------------------- the plain-words causes

/** `STR 711`, verbatim. */
export const REASON = {
  noTransport: 'No transportation connected',
  noisy: 'Neighbors are too noisy',
  housekeeping: 'Housekeeping needed',
  elevatorFar: 'Elevator is far away',
  elevatorVeryFar: 'Elevator is very far away',
  escalatorFar: 'Escalator is far away',
  escalatorVeryFar: 'Escalator is very far away',
  stairsFar: 'Stairs are far away',
  stairsVeryFar: 'Stairs are very far away',
  tooDirty: 'Room is too dirty',
  accessGood: 'Transportation access is good',
  businessVeryGood: 'Business is very good!',
  businessGood: 'Business is good',
  businessAverage: 'Business is average',
  fewCustomers: 'Very few customers',
};

const BUSINESS_WORDS = [REASON.fewCustomers, REASON.businessAverage, REASON.businessGood, REASON.businessVeryGood];

/** Families whose tenants make trips and so can find the way to them wanting. */
const TRAVELLER_FAMILIES = new Set([
  FAMILY.office, FAMILY.condo, FAMILY.hotelSingle, FAMILY.hotelTwin, FAMILY.hotelSuite,
  FAMILY.restaurant, FAMILY.fastFood, FAMILY.retail,
]);

/**
 * How the trip from the lobby up to this facility goes, in the original's words.
 *
 * The router decides: it is asked for the same candidate a worker's commute would take
 * (`selectBestRouteCandidate`, passenger mode, from the lobby floor), and the distance penalty is
 * the sim's own (`ROUTING.md` § Long-distance penalty, `distancePenalty`): more than 79 tiles from
 * the worker's home column costs 30 ticks ("far away"), 125 or more costs 60 ("very far away"), and
 * an express car is exempt. `homeColumn` is what the router measures against; nothing in the sim sets
 * it today, so it is `0` (the left edge of the lot) - the reading reports what the sim does
 * (`A84`), it does not improve on it.
 *
 * @returns {{access: 'none'|'good'|'far'|'veryFar'|'exempt'|'here', reason: string|null}}
 */
export function accessOf(tower, object, actor = null) {
  if (object.floor === GROUND_FLOOR) return { access: 'here', reason: null };
  const heightMetric = actor?.homeColumn ?? 0;
  const pick = selectBestRouteCandidate(tower, GROUND_FLOOR, object.floor, true, heightMetric);
  if (!pick) return { access: 'none', reason: REASON.noTransport };

  let column;
  let word;
  if (pick.kind === 'carrier') {
    const carrier = tower.carriers.find((c) => c.id === pick.id);
    if (!carrier) return { access: 'none', reason: REASON.noTransport };
    if (carrier.mode === CARRIER_MODE.EXPRESS) return { access: 'exempt', reason: null };
    column = carrier.column;
    word = 'elevator';
  } else {
    const segment = tower.segments?.[pick.id];
    if (!segment) return { access: 'none', reason: REASON.noTransport };
    column = segment.column;
    word = segmentIsStairs(segment) ? 'stairs' : 'escalator';
  }
  const penalty = distancePenalty(column - heightMetric);
  if (penalty === 0) return { access: 'good', reason: null };
  const very = penalty > 30;
  const reason = word === 'elevator' ? (very ? REASON.elevatorVeryFar : REASON.elevatorFar)
    : word === 'escalator' ? (very ? REASON.escalatorVeryFar : REASON.escalatorFar)
      : (very ? REASON.stairsVeryFar : REASON.stairsFar);
  return { access: very ? 'veryFar' : 'far', reason };
}

/** Is a noise source close enough to cost this facility its +60? The family's own predicate. */
export function isNoisy(tower, object) {
  if (object.family === FAMILY.office) return noiseSourceNear(tower, object);
  if (object.family === FAMILY.condo) return condoNoiseNear(tower, object);
  if (isHotelFamily(object.family)) return hotelNoiseNear(tower, object);
  return false;
}

/**
 * **Why a facility's tenants are unhappy**, in the original's own sentences and nothing else:
 * the causes the sim actually charges them for, each worded by `STR 711`.
 *
 *  - the way up is missing (*"No transportation connected"*) or far (*"Elevator is far away"* /
 *    *"... very far away"*, and the escalator and stairs forms);
 *  - a noise source within the family's radius (*"Neighbors are too noisy"*);
 *  - a hotel room left dirty: *"Housekeeping needed"* for one that has just been vacated, *"Room is
 *    too dirty"* once it has survived a 1600 pass dirty (a strike) or is infested (`A83`).
 *
 * A venue says how its business is instead (*"Business is average"*...).
 *
 * @returns {string[]} in the order above; empty when there is nothing to say
 */
export function unhappinessReasons(tower, object) {
  if (!TRAVELLER_FAMILIES.has(object.family)) return [];
  const venue = venueOf(object);
  if (venue) {
    const out = [];
    if (venue.availability === VENUE.dormant) return out;
    const access = accessOf(tower, object);
    if (access.reason) out.push(access.reason);
    out.push(BUSINESS_WORDS[venueDerivedState(Math.max(venue.acquireCount ?? 0, venue.yesterdayVisitCount ?? 0))]);
    return out;
  }
  const out = [];
  const access = accessOf(tower, object);
  if (access.reason) out.push(access.reason);
  if (isNoisy(tower, object)) out.push(REASON.noisy);
  if (isHotelInfested(object)) out.push(REASON.tooDirty);
  else if (isHotelRoomDirty(object)) out.push((object.activationTickCount ?? 0) > 0 ? REASON.tooDirty : REASON.housekeeping);
  return out;
}

// ------------------------------------------------------------ the overlays

/**
 * **How a tenant perceives the rent** (the Pricing overlay, `HELP.txt` § Pricing button: *"color
 * codes your tower according to how your tenants perceive your rents. Tenants will pay more in rent
 * if they believe higher rents are worth it"*).
 *
 * The sim's only expression of that perception is the tier's effect on the evaluation
 * (`ECONOMY.md` § Pricing Tiers): tier 0 (dearest) adds 30 to the failure budget, tier 1 nothing,
 * tier 2 takes 30 off, tier 3 forces the score to zero. So the perception IS the modifier:
 * `'dear'`, `'fair'`, `'cheap'`, `'free'` for tiers 0..3 (`A85`). `null` for what has no rent.
 */
export const RENT_PERCEPTION = ['dear', 'fair', 'cheap', 'bargain'];

export function pricePerception(object) {
  if (!isRentable(object)) return null;
  return RENT_PERCEPTION[object.rentLevel] ?? null;
}

/** `'infested'`, `'dirty'`, `'clean'` for a hotel room; `null` for anything else. The Hotel overlay's marks. */
export function hotelMark(object) {
  if (!isHotelFamily(object?.family)) return null;
  if (isHotelInfested(object)) return 'infested';
  return isHotelRoomDirty(object) ? 'dirty' : 'clean';
}

/** A facility that has tenants (or customers) whose feelings can be read. Everything else is uncoloured by Eval. */
export const hasFeelings = (object) =>
  isRentable(object) || COMMERCIAL_FAMILY_CODES.has(object?.family);

/** Staff and service facilities and the cathedral: nothing to rent, nobody to please. */
export const isServiceFacility = (object) =>
  isStaffFamily(object?.family) || SERVICE_FACILITY_FAMILIES.has(object?.family);

export { floorLabel };
