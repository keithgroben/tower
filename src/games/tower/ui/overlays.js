/**
 * The map views (issue #18): Eval, Pricing and Hotel.
 *
 * `HELP.txt` § Map Window: *"The Eval button color codes your tower according to how happy your
 * tenants are. Blue areas have an Excellent rating. Yellow is a Good rating... Red means your tenants
 * in that area are quite unhappy, and unless you do something (lower their rent, for example), they
 * will leave. The Pricing button color codes your tower according to how your tenants perceive your
 * rents. The Hotel button will display in red any residences in your tower that have dirty rooms...
 * When this happens, you have no alternative but to destroy the room. These buttons pause the game."*
 *
 * Each view is a colour per placed object, read from the sim and nothing else:
 *
 *  - **Eval** - `sim/facility.js` `facilityReading`, i.e. the evaluation the 2533 sweep runs, mapped
 *    by `evalLevelFor`. Blue is level 2 (stress under 80), yellow is level 1 (under the star's
 *    threshold, 150 or 200), red is level 0 - the grade that closes the unit.
 *  - **Pricing** - the tier's pull on the evaluation (`pricePerception`): dear / fair / cheap / free.
 *  - **Hotel** - the room's own band: dirty, infested, clean.
 *
 * `overlayModel` is pure so a test can read what the player would see without a canvas; the renderer
 * only paints the colours it is given (`render/canvas.js` `setOverlay`).
 */
import { eventDialogBlocking } from './event-dialog.js';
import {
  LEVEL_WORD, RENT_ROW, defaultFacilityName, facilityReading, groupActors, hasFeelings, hotelMark,
  pricePerception, unhappinessReasons,
} from '../sim/facility.js';
import { facilityName } from '../sim/names.js';
import { FAMILY, isHotelFamily } from '../sim/state.js';
import { payout } from '../sim/economy.js';

/** Colours, shared with the legend. Blue is the best news, red the worst, as in the original. */
export const OVERLAY_COLORS = {
  good: '#4ea8ff',
  fair: '#ffd23f',
  poor: '#ef476f',
  none: '#6b7788',
  dear: '#ef476f',
  cheap: '#4ea8ff',
  bargain: '#2f5fe0',
  clean: '#3aa57a',
  dirty: '#ef476f',
  infested: '#c1121f',
};

export const OVERLAY_MODES = ['eval', 'pricing', 'hotel'];

const LEVEL_KEY = { 2: 'good', 1: 'fair', 0: 'poor' };

const TITLES = {
  eval: 'Eval - how happy your tenants are',
  pricing: 'Pricing - how your tenants see their rents',
  hotel: 'Hotel - rooms that need cleaning',
};

const LEGENDS = {
  eval: [
    { key: 'good', label: 'Excellent' },
    { key: 'fair', label: 'Good' },
    { key: 'poor', label: 'Unhappy - may leave' },
    { key: 'none', label: 'No reading yet' },
  ],
  pricing: [
    { key: 'dear', label: 'Dear' },
    { key: 'fair', label: 'Fair' },
    { key: 'cheap', label: 'Cheap' },
    { key: 'bargain', label: 'A bargain' },
  ],
  hotel: [
    { key: 'dirty', label: 'Dirty' },
    { key: 'infested', label: 'Infested - demolish it' },
    { key: 'clean', label: 'Clean' },
  ],
};

/** The name to show for an object: what the player called it, or the original's default. */
export const titleOf = (tower, object) => facilityName(tower, object.id) ?? defaultFacilityName(object);

const dollars = (n) => '$' + n.toLocaleString('en-US');

/** One object's cell in a view, or `null` when the view says nothing about it. */
function cellFor(mode, tower, object, occupants) {
  if (mode === 'eval') {
    if (!hasFeelings(object)) return null;
    const reading = facilityReading(tower, object, occupants);
    const key = reading.level === null ? 'none' : LEVEL_KEY[reading.level];
    return { key, color: OVERLAY_COLORS[key], level: reading.level, score: reading.score, live: reading.live };
  }
  if (mode === 'pricing') {
    const perceived = pricePerception(object);
    if (!perceived) return null;
    const key = perceived === 'fair' ? 'fair' : perceived;
    return { key, color: OVERLAY_COLORS[key], tier: object.rentLevel };
  }
  if (mode === 'hotel') {
    const mark = hotelMark(object);
    if (!mark) return null;
    return { key: mark, color: OVERLAY_COLORS[mark] };
  }
  return null;
}

/**
 * What a map view shows: a colour for each placed object it speaks about.
 *
 * @param {object} tower
 * @param {'eval'|'pricing'|'hotel'} mode
 * @returns {{mode, title, legend, cells: Map<number, {key:string, color:string}>, counts: Record<string, number>}}
 */
export function overlayModel(tower, mode) {
  const byObject = groupActors(tower);
  const cells = new Map();
  const counts = Object.fromEntries((LEGENDS[mode] ?? []).map((l) => [l.key, 0]));
  for (const object of tower.objects.values()) {
    const cell = cellFor(mode, tower, object, byObject.get(object.id) ?? []);
    if (!cell) continue;
    cells.set(object.id, cell);
    counts[cell.key] = (counts[cell.key] ?? 0) + 1;
  }
  return {
    mode,
    title: TITLES[mode] ?? mode,
    legend: (LEGENDS[mode] ?? []).map((l) => ({ ...l, color: OVERLAY_COLORS[l.key], count: counts[l.key] ?? 0 })),
    cells,
    counts,
  };
}

/** The hover line while a view is on: what the colour means for the room under the pointer, and why. */
export function overlayHoverLine(tower, mode, object) {
  if (!object) return '';
  const title = titleOf(tower, object);
  if (mode === 'eval') {
    if (!hasFeelings(object)) return title;
    const reading = facilityReading(tower, object);
    const word = reading.level === null ? 'no reading yet' : LEVEL_WORD[reading.level];
    const stress = reading.score === null ? '' : ' (stress ' + reading.score + ')';
    return [title + ' · ' + word + stress, ...unhappinessReasons(tower, object)].join(' · ');
  }
  if (mode === 'pricing') {
    const perceived = pricePerception(object);
    if (!perceived) return title;
    const amount = payout(RENT_ROW[object.family], object.rentLevel);
    return title + ' · ' + perceived + ' · ' + (isHotelFamily(object.family) ? 'per stay ' : object.family === FAMILY.condo ? 'price ' : 'rent ') + dollars(amount);
  }
  if (mode === 'hotel') {
    const mark = hotelMark(object);
    if (!mark) return title;
    return [title + ' · ' + mark, ...unhappinessReasons(tower, object)].join(' · ');
  }
  return title;
}

/** Does the tower hold any hotel rooms? The Hotel button is *"active only if you have hotel rooms"*. */
export const hasHotelRooms = (tower) => {
  for (const object of tower.objects.values()) if (isHotelFamily(object.family)) return true;
  return false;
};

/**
 * The buttons of the map bar and whether each can be pressed right now.
 *
 * Nothing opens while the tower is asking a question (`eventDialogBlocking`): the question is modal,
 * and a view that held the game and then released it must never be what decides whether the
 * question is still open. `reason` is what the button says when it is dead.
 */
export function mapBarModel(tower) {
  const asking = eventDialogBlocking(tower);
  const wait = asking ? 'answer the question first' : null;
  return [
    { id: 'edit', label: 'Edit', enabled: true, reason: null },
    { id: 'eval', label: 'Eval', enabled: !asking, reason: wait },
    { id: 'pricing', label: 'Pricing', enabled: !asking, reason: wait },
    { id: 'hotel', label: 'Hotel', enabled: !asking && hasHotelRooms(tower), reason: wait ?? (hasHotelRooms(tower) ? null : 'you have no hotel rooms') },
    { id: 'finance', label: 'Finance', enabled: !asking, reason: wait },
  ];
}

