/**
 * The elevator control panel (issue #7).
 *
 * Open it by clicking a shaft with no tool armed — the original's "click the
 * elevator machinery". It reads one carrier and sends `applyAction` commands;
 * it owns no rules. The rules (what a slot is, what is allowed) live in
 * `sim/actions.js` and `sim/elevators.js`, and every button here is a command
 * whose refusal, if there is one, is shown in the panel's own status line.
 *
 * `liftPanelModel` is pure so a test can read what the panel would show without
 * a DOM; `mountLiftPanel` is the thin renderer over it.
 */
import { CARRIER_MODE, SCHEDULE_SLOTS, carrierStopsAtFloor } from '../sim/elevators.js';
import { DAYPART_LABELS } from '../sim/clock.js';
import { floorLabel } from '../sim/state.js';

const MODE_LABEL = ['Local', 'Up', 'Down'];
const KIND_LABEL = { [CARRIER_MODE.EXPRESS]: 'Express lift', [CARRIER_MODE.STANDARD]: 'Lift', [CARRIER_MODE.SERVICE]: 'Service lift' };
/** The waits a click cycles through, in the sim's own units (30 ticks each). */
export const WAIT_STEPS = [0, 1, 2, 4, 8];

const shortDaypart = (i) => DAYPART_LABELS[i].replace('early morning', 'dawn').replace('late morning', 'late am');

/** What the panel shows for one carrier. Pure. */
export function liftPanelModel(carrier) {
  const express = carrier.mode === CARRIER_MODE.EXPRESS;
  const floors = [];
  if (!express) {
    for (let f = carrier.bottomFloor; f <= carrier.topFloor; f++) {
      floors.push({
        floor: f, label: floorLabel(f), on: carrierStopsAtFloor(carrier, f),
        locked: f === carrier.bottomFloor || f === carrier.topFloor,
      });
    }
  }
  return {
    id: carrier.id,
    title: (KIND_LABEL[carrier.mode] ?? 'Lift') + ' · ' + floorLabel(carrier.bottomFloor) + ' to ' + floorLabel(carrier.topFloor),
    express,
    dayparts: Array.from({ length: 7 }, (_, i) => shortDaypart(i)),
    schedule: Array.from({ length: SCHEDULE_SLOTS }, (_, slot) => ({
      slot, mode: carrier.expressMode[slot], label: MODE_LABEL[carrier.expressMode[slot]] ?? '?',
      wait: carrier.dwellEnable[slot],
    })),
    response: carrier.dispatchThreshold[0],
    floors,
    cars: carrier.cars.map((car, i) => ({ index: i, home: car.homeFloor, homeLabel: floorLabel(car.homeFloor) })),
  };
}

/** The next wait in the cycle after `current` (anything not in the list restarts it). */
export const nextWait = (current) => WAIT_STEPS[(WAIT_STEPS.indexOf(current) + 1) % WAIT_STEPS.length];

/**
 * Mount the panel into `root`. `getCarrier()` returns the carrier being edited
 * (or null), `apply(command)` returns the sim's `{ ok, reason }`, `onChange()`
 * lets the page redraw. Returns `{ open(id), close(), refresh() }`.
 */
export function mountLiftPanel(root, { getCarrier, apply, onChange = () => {} }) {
  let openId = null;
  let status = '';

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node[k] = v;
    }
    for (const kid of kids) node.append(kid);
    return node;
  };

  const send = (command) => {
    const result = apply(command);
    status = result.ok ? '' : result.reason;
    onChange();
    render();
  };

  function render() {
    root.replaceChildren();
    const carrier = openId === null ? null : getCarrier(openId);
    if (!carrier) { root.hidden = true; return; }
    root.hidden = false;
    const m = liftPanelModel(carrier);

    const head = el('div', { class: 'lp-head' }, el('b', { text: m.title }),
      el('button', { class: 'lp-x', text: '×', title: 'close', onclick: () => { openId = null; render(); } }));
    root.append(head);

    // Schedule: two rows (weekday, weekend) of seven dayparts. Each cell shows
    // what the lift does then and how long it waits; click cycles the mode,
    // shift-click cycles the wait.
    const grid = el('div', { class: 'lp-grid' });
    grid.append(el('span'));
    for (const d of m.dayparts) grid.append(el('span', { class: 'lp-col', text: d }));
    for (const [rowLabel, offset] of [['weekday', 0], ['weekend', 7]]) {
      grid.append(el('span', { class: 'lp-row', text: rowLabel }));
      for (let i = 0; i < 7; i++) {
        const cell = m.schedule[offset + i];
        const b = el('button', {
          class: 'lp-cell m' + cell.mode,
          title: 'click: local / up / down · shift-click: how long it waits at a stop',
          innerHTML: cell.label + (cell.wait ? '<small> ' + cell.wait + '</small>' : ''),
        });
        b.addEventListener('click', (e) => {
          if (e.shiftKey) send({ type: 'set_lift_wait', carrierId: m.id, slot: cell.slot, value: nextWait(cell.wait) });
          else send({ type: 'set_lift_schedule', carrierId: m.id, slot: cell.slot, mode: (cell.mode + 1) % 3 });
        });
        grid.append(b);
      }
    }
    root.append(grid);

    const resp = el('div', { class: 'lp-line' }, el('span', { text: 'answer calls within ' + m.response + ' floors' }),
      el('button', { text: '−', onclick: () => send({ type: 'set_lift_response', carrierId: m.id, value: m.response - 1 }) }),
      el('button', { text: '+', onclick: () => send({ type: 'set_lift_response', carrierId: m.id, value: m.response + 1 }) }));
    root.append(resp);

    if (!m.express) {
      const stops = el('div', { class: 'lp-stops' });
      for (const f of [...m.floors].reverse()) {
        stops.append(el('button', {
          class: 'lp-stop' + (f.on ? '' : ' off'), text: f.label, disabled: f.locked,
          title: f.on ? 'stops here — click to skip this floor' : 'skipped — click to stop here again',
          onclick: () => send({ type: 'set_lift_stop', carrierId: m.id, floor: f.floor, enabled: !f.on }),
        }));
      }
      root.append(el('div', { class: 'lp-label', text: 'floors it stops at' }), stops);

      const cars = el('div', { class: 'lp-cars' });
      for (const c of m.cars) {
        cars.append(el('span', { text: 'car ' + (c.index + 1) + ' waits at ' + c.homeLabel }),
          el('button', { text: '↓', onclick: () => send({ type: 'set_car_home', carrierId: m.id, car: c.index, floor: c.home - 1 }) }),
          el('button', { text: '↑', onclick: () => send({ type: 'set_car_home', carrierId: m.id, car: c.index, floor: c.home + 1 }) }));
      }
      root.append(cars);
    } else {
      root.append(el('div', { class: 'lp-label', text: 'an express lift stops at the lobbies only' }));
    }
    if (status) root.append(el('div', { class: 'lp-status', text: status }));
  }

  return {
    open(id) { openId = id; status = ''; render(); },
    close() { openId = null; render(); },
    refresh() { if (openId !== null) render(); },
    get isOpen() { return openId !== null; },
  };
}
