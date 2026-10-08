/**
 * The Tenant window (issue #18): one person - where they work and how they feel about it - and the
 * place to give them a name.
 *
 * `HELP.txt` § Tenant Window: *"lets you see where individual people work and how they feel about it.
 * It also gives you the ability to name individual people in your building. Once you've named a
 * person, you can find them by using the Find Person Window (assuming they are still in your tower)"*;
 * § Find Person: *"the Edit window will center on the location. A red arrow will help you pinpoint
 * the location. You can give names to a maximum of 20 people."* The original's person dialogs read
 * *"OK | Rename | From | Eval | Going To | Stress"* (`DIALOG_763` / `764`) and the rename dialog
 * *"Rename | Cancel | Delete | Person's name:"* (`DIALOG_730`).
 *
 * It is reached from a facility's occupants (the Facility window lists them) or from the list of
 * named people at its foot. It reads one actor and sends `name_person`; the naming rules - 20
 * people, 15 characters, an empty name is a Delete - are `sim/names.js`, and the original's refusals
 * are shown as the sim words them.
 *
 * `tenantWindowModel` is pure so a test can read what the player would see; `mountTenantWindow` is
 * the thin renderer over it.
 */
import { FAMILY, baseState, floorLabel, isStaffFamily } from '../sim/state.js';
import { OFFICE_STATE } from '../sim/office.js';
import { computeRuntimeTileStressAverage, stressBand } from '../sim/stress.js';
import { LEVEL_WORD, defaultFacilityName, facilityReading } from '../sim/facility.js';
import { MAX_NAME_LENGTH, MAX_NAMED_PEOPLE, facilityName, namedPeople, personName } from '../sim/names.js';
import { OVERLAY_COLORS } from './overlays.js';
import { el } from './dom.js';
import { STRESS_WORD } from './facility-window.js';

/** What a person is, in a word. */
const ROLE = {
  [FAMILY.office]: 'Office worker',
  [FAMILY.condo]: 'Resident',
  [FAMILY.hotelSingle]: 'Hotel guest',
  [FAMILY.hotelTwin]: 'Hotel guest',
  [FAMILY.hotelSuite]: 'Hotel guest',
  [FAMILY.restaurant]: 'Diner',
  [FAMILY.fastFood]: 'Customer',
  [FAMILY.retail]: 'Shopper',
  [FAMILY.theater]: 'Moviegoer',
  [FAMILY.partyHall]: 'Party guest',
  [FAMILY.housekeeping]: 'Housekeeper',
  [FAMILY.security]: 'Security guard',
  [FAMILY.vip]: 'VIP',
  [FAMILY.inspector]: 'Inspector',
  [FAMILY.cathedral]: 'Wedding guest',
};

/** What an office worker is up to, from the state machine's own names. */
const OFFICE_DOING = {
  [OFFICE_STATE.commuteIn]: 'on the way to work',
  [OFFICE_STATE.lunchOut]: 'going out to lunch',
  [OFFICE_STATE.lunchTransit]: 'on the way to lunch',
  [OFFICE_STATE.medicalOut]: 'on the way to the medical center',
  [OFFICE_STATE.commuteOut]: 'on the way home',
  [OFFICE_STATE.seekingWork]: 'not working here yet',
  [OFFICE_STATE.atWork]: 'at work',
  [OFFICE_STATE.lunchReturn]: 'coming back from lunch',
  [OFFICE_STATE.atLunch]: 'at lunch',
  [OFFICE_STATE.atMedical]: 'at the medical center',
  [OFFICE_STATE.strandedOpen]: 'stuck on the way',
  [OFFICE_STATE.strandedFailed]: 'cannot get there',
  [OFFICE_STATE.parked]: 'at home',
};

function doingOf(actor) {
  if (actor.waitingFloor != null) return 'waiting for a lift on ' + floorLabel(actor.waitingFloor);
  if (actor.family === FAMILY.office) return OFFICE_DOING[baseState(actor.state)] ?? 'in the tower';
  return 'in the tower';
}

const findActor = (tower, id) => tower.actors.find((a) => a && a.id === id) ?? null;

/** Where the camera should go to show a person: their floor, and the tile of the room they belong to. */
export function whereIs(tower, actor) {
  const object = tower.objects.get(actor.objectId);
  return { floor: actor.anchorFloor ?? object?.floor ?? 0, tile: object ? Math.round((object.left + object.right) / 2) : 0 };
}

/**
 * What the window shows for one person, or `null` when they are no longer in the tower.
 *
 * @param {{tower: object}} world
 * @param {number} actorId
 */
export function tenantWindowModel(world, actorId) {
  const { tower } = world;
  const actor = findActor(tower, actorId);
  if (!actor) return null;
  const object = tower.objects.get(actor.objectId) ?? null;

  const staff = isStaffFamily(actor.family);
  const stress = !staff && actor.tripCount > 0 ? computeRuntimeTileStressAverage(actor) : null;
  const band = stress === null ? null : stressBand(stress);
  const reading = object ? facilityReading(tower, object) : null;
  const name = personName(tower, actor.id);

  return {
    id: actor.id,
    name,
    named: name !== null,
    title: name ?? (ROLE[actor.family] ?? 'Person'),
    role: ROLE[actor.family] ?? 'Person',
    worksAt: object ? {
      objectId: object.id,
      title: facilityName(tower, object.id) ?? defaultFacilityName(object),
      floor: object.floor,
      floorLabel: floorLabel(object.floor),
    } : null,
    // A member of staff has no stress; "calm" would read as a worker doing perfectly.
    feel: staff ? { band: null, word: 'on duty', stress: null }
      : { band, word: band ? STRESS_WORD[band] : 'no trips yet', stress },
    facilityFeel: reading && reading.level !== null
      ? { word: LEVEL_WORD[reading.level], color: OVERLAY_COLORS[['poor', 'fair', 'good'][reading.level]] } : null,
    from: actor.anchorFloor != null ? floorLabel(actor.anchorFloor) : null,
    goingTo: actor.targetFloor != null ? floorLabel(actor.targetFloor) : null,
    doing: doingOf(actor),
    where: whereIs(tower, actor),
    max: MAX_NAME_LENGTH,
    namedCount: namedPeople(tower).length,
    namedLimit: MAX_NAMED_PEOPLE,
  };
}

/** The list at the foot of the window: everyone the player has named who is still in the tower. */
export function namedPeopleList(world) {
  const { tower } = world;
  return namedPeople(tower).map(({ actorId, name }) => {
    const actor = findActor(tower, actorId);
    const object = tower.objects.get(actor.objectId);
    return {
      actorId, name,
      at: object ? floorLabel(object.floor) : '',
      where: whereIs(tower, actor),
    };
  });
}

/**
 * Mount into `root`. `getWorld()` returns `{ tower }`, `apply(command)` returns the sim's
 * `{ ok, reason }`, `onChange()` lets the page redraw, `onOpenFacility(objectId)` opens the Facility
 * window, `onFind({floor, tile})` centres the view, `onClose()` releases the pause.
 */
export function mountTenantWindow(root, { getWorld, apply, onChange = () => {}, onOpenFacility = () => {}, onFind = () => {}, onClose = () => {} }) {
  let openId = null;
  let status = '';
  let last = '';

  const send = (command) => {
    const result = apply(command);
    status = result.ok ? '' : result.reason;
    onChange();
    refresh(true);
  };

  function render(model, list) {
    root.replaceChildren();
    root.append(
      el('div', { class: 'lp-head' }, el('b', { text: model.title }),
        el('button', { class: 'lp-x', text: '×', title: 'close', onclick: () => close() })),
      el('div', { class: 'fw-sub', text: model.role + ' · ' + model.doing }),
    );
    if (model.worksAt) {
      root.append(el('div', { class: 'lp-line' },
        el('span', { text: 'Works at' }),
        el('button', { text: model.worksAt.title, title: 'open this facility', onclick: () => onOpenFacility(model.worksAt.objectId) })));
    }
    root.append(el('div', { class: 'tp-line', text: 'Feels ' + model.feel.word + (model.feel.stress === null ? '' : ' (stress ' + model.feel.stress + ')') }));
    if (model.facilityFeel) {
      root.append(el('div', { class: 'tp-line' }, 'Their facility is ', el('b', { text: model.facilityFeel.word, style: 'color:' + model.facilityFeel.color })));
    }
    if (model.from || model.goingTo) {
      root.append(el('div', { class: 'tp-line', text: (model.from ? 'From ' + model.from : '') + (model.goingTo ? ' · going to ' + model.goingTo : '') }));
    }

    const input = el('input', {
      class: 'fw-name', type: 'text', maxLength: 60, value: model.name ?? '', placeholder: 'name this person',
      onkeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); if (e.key === 'Enter') doRename(); },
    });
    const doRename = () => send({ type: 'name_person', actorId: model.id, name: input.value });
    root.append(
      el('div', { class: 'lp-label', text: 'Name (up to ' + model.max + ' characters; empty takes the name off)' }),
      el('div', { class: 'lp-line' }, input, el('button', { text: 'Rename', onclick: doRename })),
      el('div', { class: 'tp-line', text: model.namedCount + ' of ' + model.namedLimit + ' people named' }),
    );
    if (status) root.append(el('div', { class: 'lp-status', text: status }));

    if (list.length) {
      root.append(el('div', { class: 'lp-label', text: 'Find a person' }));
      const rows = el('div', { class: 'fw-people' });
      for (const p of list) {
        rows.append(el('div', { class: 'fw-found' },
          el('button', { text: p.name, title: 'open', onclick: () => open(p.actorId) }),
          el('span', { text: p.at }),
          el('button', { text: 'Find', title: 'centre the view on them', onclick: () => onFind(p.where) })));
      }
      root.append(rows);
    }
  }

  function refresh(force = false) {
    if (openId === null) return;
    const world = getWorld();
    const model = tenantWindowModel(world, openId);
    if (!model) { close(); return; }
    const list = namedPeopleList(world);
    const key = JSON.stringify([model, list, status]);
    if (!force && key === last) return;
    last = key;
    render(model, list);
  }

  function open(id) { openId = id; status = ''; last = ''; root.hidden = false; refresh(true); }
  function close() {
    if (openId === null) return;
    openId = null; root.hidden = true; root.replaceChildren(); onClose();
  }

  return { open, close, refresh, get isOpen() { return openId !== null; }, get id() { return openId; } };
}
