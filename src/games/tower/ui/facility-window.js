/**
 * The Facility window (issue #18): a reading of how one room is doing.
 *
 * `HELP.txt` § Facility Window: *"takes a reading on the current success (measured in stress levels)
 * of any shop, restaurant or office. You can also track its occupants. Get this window by clicking
 * with the Magnifying glass on any of these facilities. The game will pause when this window is open.
 * The eval line tells you if the collective personality of the facility is in a good or bad mood...
 * The bar fills from left to right, with a bigger bar indicating greater happiness. When the red hits
 * the first divider, it turns yellow, indicating neutral stress. When the yellow increases past the
 * second divider line, it changes to blue, indicating satisfaction. The Rename button lets you change
 * the name of the facility to anything you like."* The dialogs' buttons are *"OK | Rename | Rate |
 * Eval"* (hotel rooms), *"Length | Rent | Eval"* (offices), *"Patronage | Rent"*.
 *
 * Open it by clicking a room with no tool armed - the Magnifying Glass. It reads one facility and
 * sends two commands, `set_rent` (the rent tier; the window never writes the tier itself) and
 * `name_facility`. Nothing here is a rule: what a reading means is `sim/facility.js`, what a
 * rename allows is `sim/names.js`, and a button is dead exactly when the seam would refuse it
 * (`rentRefusal`, `facilityNameRefusal`).
 *
 * **A facility with nothing to rent has no rent section.** The cathedral's `unitStatus` is
 * meaningless and a security office or a clinic is not let; `rent` is `null` for them, and so is the
 * status word. (`sim/facility.js` `RENT_ROW` is the list of the six that have one.)
 *
 * `facilityWindowModel` is pure so a test can read what the player would see without a DOM;
 * `mountFacilityWindow` is the thin renderer over it.
 */
import {
  EVAL_BAR_SCALE, LEVEL_WORD, RENT_ROW, accessOf, defaultFacilityName, evalBarDividers, evalBarFill, facilityLabel,
  facilityReading, floorWords, isRentable, occupantsOf, pricePerception, rentRefusal, statusWord, unhappinessReasons,
} from '../sim/facility.js';
import { MAX_NAME_LENGTH, facilityName, namedFacilities } from '../sim/names.js';
import { VENUE, venueOf } from '../sim/commercial.js';
import { FAMILY, isHotelFamily, isStaffFamily } from '../sim/state.js';
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import { payout } from '../sim/economy.js';
import { OVERLAY_COLORS } from './overlays.js';
import { el, money } from './dom.js';

/** The words for the stress bands, the HUD legend's own. */
export const STRESS_WORD = { black: 'calm', pink: 'stressed', red: 'fed up' };

/** What the tier's money is called, in the original's dialog captions. */
const RENT_CAPTION = (object) => (isHotelFamily(object.family) ? 'Rate' : object.family === FAMILY.condo ? 'Price' : 'Rent');

/** The bar's fill when the reading carries a grade but no score: the middle of its band. */
function bandMidFill(level, starCount) {
  const { first, second } = evalBarDividers(starCount);
  if (level === 2) return (second + 1) / 2;
  if (level === 1) return (first + second) / 2;
  return first / 2;
}

/**
 * What the window shows for one facility, or `null` when it is gone.
 *
 * @param {{tower: object}} world
 * @param {number} objectId
 */
export function facilityWindowModel(world, objectId) {
  const { tower } = world;
  const object = tower.objects.get(objectId);
  if (!object) return null;

  const occupants = occupantsOf(tower, object);
  const reading = facilityReading(tower, object, occupants);
  const dividers = evalBarDividers(tower.starCount);
  const levelKey = reading.level === null ? 'none' : ['poor', 'fair', 'good'][reading.level];
  const hasEval = reading.basis !== 'none' || isRentable(object) || venueOf(object) !== null;

  let rent = null;
  if (isRentable(object)) {
    const refusal = rentRefusal(object);
    const row = RENT_ROW[object.family];
    rent = {
      caption: RENT_CAPTION(object),
      tier: object.rentLevel,
      perception: pricePerception(object),
      refusal,
      canChange: refusal === null,
      tiers: [0, 1, 2, 3].map((tier) => ({
        tier, amount: payout(row, tier), text: money(payout(row, tier)),
        perception: pricePerception({ family: object.family, rentLevel: tier }),
        current: tier === object.rentLevel,
      })),
    };
  }

  const venue = venueOf(object);
  const people = isRentable(object) && !venue
    ? occupants.slice(0, 8).map((actor) => {
      const stress = actor.tripCount > 0 ? computeRuntimeTileStressAverage(actor) : null;
      const band = stress === null ? null : stressBand(stress);
      return { actorId: actor.id, stress, band, word: band ? STRESS_WORD[band] : 'no trips yet' };
    })
    : [];

  const access = TRAVEL_ACCESS.has(object.family) ? accessOf(tower, object) : null;
  const reasons = unhappinessReasons(tower, object);
  const named = facilityName(tower, object.id);

  return {
    id: object.id,
    title: named ?? defaultFacilityName(object),
    kind: facilityLabel(object),
    floorWords: floorWords(object.floor),
    named: named !== null,
    namedCount: namedFacilities(tower).length,
    status: statusWord(object),
    eval: hasEval ? {
      level: reading.level,
      key: levelKey,
      color: OVERLAY_COLORS[levelKey],
      word: reading.level === null ? 'no reading yet' : LEVEL_WORD[reading.level],
      score: reading.score,
      live: reading.live,
      basis: reading.basis,
      fill: reading.score !== null ? evalBarFill(reading.score)
        : reading.level !== null ? bandMidFill(reading.level, tower.starCount) : 0,
      dividers,
      scale: EVAL_BAR_SCALE,
    } : null,
    reasons,
    accessGood: access?.access === 'good',
    rent,
    venue: venue && venue.availability !== VENUE.dormant ? {
      customersToday: venue.acquireCount ?? 0,
      customersYesterday: venue.yesterdayVisitCount ?? 0,
    } : null,
    people,
    staff: isStaffFamily(object.family),
    rename: { max: MAX_NAME_LENGTH, current: named ?? '' },
  };
}

/** The families whose route up the tower is worth reporting on. */
const TRAVEL_ACCESS = new Set([
  FAMILY.office, FAMILY.condo, FAMILY.hotelSingle, FAMILY.hotelTwin, FAMILY.hotelSuite,
  FAMILY.restaurant, FAMILY.fastFood, FAMILY.retail,
]);

/**
 * Mount into `root`. `getWorld()` returns `{ tower }`, `apply(command)` returns the sim's
 * `{ ok, reason }`, `onChange()` lets the page redraw, `onOpenPerson(actorId)` opens the Tenant window,
 * `onClose()` releases the pause. Returns `{ open(id), close(), refresh(), isOpen, id }`.
 */
export function mountFacilityWindow(root, { getWorld, apply, onChange = () => {}, onOpenPerson = () => {}, onClose = () => {} }) {
  let openId = null;
  let status = '';
  let last = '';

  const send = (command) => {
    const result = apply(command);
    status = result.ok ? '' : result.reason;
    onChange();
    refresh(true);
  };

  function render(model) {
    root.replaceChildren();
    root.append(
      el('div', { class: 'lp-head' },
        el('b', { text: model.title }),
        el('button', { class: 'lp-x', text: '×', title: 'close', onclick: () => close() })),
      el('div', { class: 'fw-sub', text: model.kind + ' · ' + model.floorWords + (model.status ? ' · ' + model.status : '') }),
    );

    if (model.eval) {
      const e = model.eval;
      const bar = el('div', { class: 'fw-bar', title: 'a fuller bar is a happier facility' },
        el('i', { class: 'fw-fill', style: 'width:' + Math.round(e.fill * 100) + '%;background:' + e.color }),
        el('b', { class: 'fw-div', style: 'left:' + (e.dividers.first * 100) + '%' }),
        el('b', { class: 'fw-div', style: 'left:' + (e.dividers.second * 100) + '%' }));
      const detail = e.score === null
        ? (e.basis === 'customers' ? 'by its customers' : e.basis === 'stored' ? 'as last measured' : '')
        : 'stress ' + e.score;
      root.append(
        el('div', { class: 'fw-evalrow' }, el('span', { text: 'Eval' }), bar,
          el('span', { class: 'fw-evalword', text: e.word + (detail ? ' · ' + detail : ''), style: 'color:' + e.color })),
      );
    }

    for (const reason of model.reasons) root.append(el('div', { class: 'fw-reason', text: reason }));
    if (model.accessGood && model.reasons.length === 0) root.append(el('div', { class: 'fw-good', text: 'Transportation access is good' }));
    if (model.venue) {
      root.append(el('div', { class: 'tp-line', text: 'Customers today ' + model.venue.customersToday + ' · yesterday ' + model.venue.customersYesterday }));
    }

    if (model.rent) {
      const r = model.rent;
      const row = el('div', { class: 'fw-tiers' });
      for (const t of r.tiers) {
        row.append(el('button', {
          class: 'fw-tier' + (t.current ? ' on' : ''), disabled: !r.canChange && !t.current,
          title: t.perception + (r.canChange ? '' : ' · ' + r.refusal),
          onclick: () => { if (!t.current) send({ type: 'set_rent', objectId: model.id, tier: t.tier }); },
        }, el('span', { class: 'fw-tier-money', text: t.text }), el('small', { text: t.perception })));
      }
      root.append(el('div', { class: 'lp-label', text: r.caption + ' - what tenants make of it' }), row);
      if (!r.canChange) root.append(el('div', { class: 'tp-line', text: r.refusal }));
    }

    if (model.people.length) {
      root.append(el('div', { class: 'lp-label', text: 'Occupants' }));
      const list = el('div', { class: 'fw-people' });
      model.people.forEach((p, i) => list.append(el('button', {
        class: 'fw-person', title: 'open this person',
        onclick: () => onOpenPerson(p.actorId),
      }, el('span', { text: '#' + (i + 1) }), el('span', { text: p.word }), el('span', { text: p.stress === null ? '' : String(p.stress) }))));
      root.append(list);
    }

    // Rename. The input is built with the window and the button sends `name_facility`; an empty box
    // is the original's Delete.
    const input = el('input', {
      class: 'fw-name', type: 'text', maxLength: 60, value: model.rename.current,
      placeholder: model.named ? 'name' : defaultFacilityName(getWorld().tower.objects.get(model.id)),
      onkeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); if (e.key === 'Enter') doRename(); },
    });
    const doRename = () => send({ type: 'name_facility', objectId: model.id, name: input.value });
    root.append(
      el('div', { class: 'lp-label', text: 'Rename (up to ' + model.rename.max + ' characters; leave empty to take the name off)' }),
      el('div', { class: 'lp-line' }, input,
        el('button', { text: 'Rename', onclick: doRename })),
      el('div', { class: 'tp-line', text: model.namedCount + ' of 20 facilities named' }),
    );
    if (status) root.append(el('div', { class: 'lp-status', text: status }));
  }

  function refresh(force = false) {
    if (openId === null) return;
    const model = facilityWindowModel(getWorld(), openId);
    if (!model) { close(); return; }
    const key = JSON.stringify([model, status]);
    if (!force && key === last) return;
    last = key;
    render(model);
  }

  function open(id) {
    openId = id; status = ''; last = '';
    root.hidden = false;
    refresh(true);
  }
  function close() {
    if (openId === null) return;
    openId = null; root.hidden = true; root.replaceChildren(); onClose();
  }

  return { open, close, refresh, get isOpen() { return openId !== null; }, get id() { return openId; } };
}
