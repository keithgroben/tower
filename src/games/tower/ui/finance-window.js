/**
 * The Finance window (issue #18): where the money came from and where it went, by source, for a
 * quarter. `HELP.txt`: *"a balance sheet of your revenues and expenditures for the current quarter"*;
 * *"the game pauses when the Finance Window is active"*.
 *
 * It reads `sim/finance.js` `financeStatement` and writes nothing. The statement reconciles by
 * construction (`discrepancy` is `0`) and says so on its last line, so a window that ever stopped
 * adding up would say that instead of looking fine.
 *
 * `financeWindowModel` is pure so a test can read what the player would see; `mountFinanceWindow` is
 * the thin renderer over it.
 */
import { financeStatement } from '../sim/finance.js';
import { calendarOf } from '../sim/clock.js';
import { el, money } from './dom.js';

/**
 * What the window shows for one quarter.
 *
 * @param {{tower: object}} world
 * @param {'current'|'previous'} which
 */
export function financeWindowModel(world, which = 'current') {
  const { tower } = world;
  const hasPrevious = Boolean(tower.previousQuarter);
  const statement = financeStatement(tower, which === 'previous' && hasPrevious ? 'previous' : 'current');
  const cal = calendarOf(statement.startDay);
  const nonZero = (lines) => lines.filter((l) => l.amount !== 0);

  const section = (title, lines, total, sign) => ({
    title,
    rows: nonZero(lines).map((l) => ({ key: l.key, label: l.label, amount: sign * l.amount, text: money(sign * l.amount) })),
    total: { amount: sign * total, text: money(sign * total) },
  });

  return {
    which: statement.which,
    title: 'Y' + cal.year + ' Q' + cal.quarter + (statement.which === 'current' ? ' so far' : ''),
    tabs: [
      { id: 'current', label: 'This quarter', enabled: true },
      { id: 'previous', label: 'Last quarter', enabled: hasPrevious },
    ],
    opening: { label: 'Cash at the start', amount: statement.openingCash, text: money(statement.openingCash) },
    sections: [
      section('Income', statement.income.lines, statement.income.total, 1),
      // Upkeep is money OUT, so it reads as a negative, and the section total is the negative of the cost.
      section('Upkeep', statement.upkeep.lines, statement.upkeep.total, -1),
      // The other movements are already signed by the sim (construction is negative, treasure positive).
      section('Everything else', statement.other.lines, statement.other.total, 1),
    ],
    net: { label: 'Change in cash', amount: statement.net, text: money(statement.net) },
    closing: { label: statement.which === 'current' ? 'Cash now' : 'Cash at the end', amount: statement.closingCash, text: money(statement.closingCash) },
    reconciles: statement.discrepancy === 0,
    discrepancy: statement.discrepancy,
    statement,
  };
}

/** Mount into `root`. `getWorld()` returns `{ tower }`. Returns `{ open(), close(), refresh(), isOpen }`. */
export function mountFinanceWindow(root, { getWorld, onClose = () => {} }) {
  let isOpen = false;
  let which = 'current';
  let last = '';

  function render(model) {
    root.replaceChildren();
    root.append(
      el('div', { class: 'lp-head' }, el('b', { text: 'Finance · ' + model.title }),
        el('button', { class: 'lp-x', text: '×', title: 'close', onclick: () => close() })),
      el('div', { class: 'fw-tabs' }, ...model.tabs.map((t) => el('button', {
        class: 'fw-tab' + (t.id === model.which ? ' on' : ''), text: t.label, disabled: !t.enabled,
        onclick: () => { which = t.id; refresh(true); },
      }))),
      el('div', { class: 'fw-row fw-base' }, el('span', { text: model.opening.label }), el('span', { text: model.opening.text })),
    );
    for (const s of model.sections) {
      root.append(el('div', { class: 'lp-label', text: s.title }));
      if (s.rows.length === 0) root.append(el('div', { class: 'fw-row fw-none' }, el('span', { text: 'nothing' }), el('span', { text: '' })));
      for (const r of s.rows) {
        root.append(el('div', { class: 'fw-row' + (r.amount < 0 ? ' neg' : '') }, el('span', { text: r.label }), el('span', { text: r.text })));
      }
      root.append(el('div', { class: 'fw-row fw-total' }, el('span', { text: 'Total ' + s.title.toLowerCase() }), el('span', { text: s.total.text })));
    }
    root.append(
      el('div', { class: 'fw-row fw-net' + (model.net.amount < 0 ? ' neg' : '') }, el('span', { text: model.net.label }), el('span', { text: model.net.text })),
      el('div', { class: 'fw-row fw-base' }, el('span', { text: model.closing.label }), el('span', { text: model.closing.text })),
      el('div', { class: 'lp-status', text: model.reconciles ? '' : 'does not add up: ' + money(model.discrepancy) + ' unaccounted for' }),
    );
  }

  function refresh(force = false) {
    if (!isOpen) return;
    const model = financeWindowModel(getWorld(), which);
    const key = JSON.stringify([model.which, model.title, model.sections, model.net, model.closing, model.opening, model.reconciles]);
    if (!force && key === last) return;
    last = key;
    render(model);
  }

  function open() { isOpen = true; which = 'current'; last = ''; root.hidden = false; refresh(true); }
  function close() {
    if (!isOpen) return;
    isOpen = false; root.hidden = true; root.replaceChildren(); onClose();
  }

  return { open, close, refresh, get isOpen() { return isOpen; } };
}
