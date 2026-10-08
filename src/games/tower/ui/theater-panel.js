/**
 * The Theater window (issue #11): which film the movie theater is showing, and
 * what buying the next one costs.
 *
 * Open it by clicking a theater with no tool armed - the original's tenant
 * dialog for a cinema, whose one control is the "New Movie" picker
 * (`specs/facility/ENTERTAINMENT.md` § Cinema "New Movie" Picker). It reads one
 * record and sends `applyAction` commands; it owns no rules. What a film is
 * worth, what it costs and whether it can be bought are `sim/entertainment.js`
 * and `sim/actions.js`, and every button here is the `set_theater_film` command
 * whose refusal, if there is one, is shown in the panel's own status line.
 *
 * `theaterPanelModel` is pure so a test can read what the panel would show
 * without a DOM; `mountTheaterPanel` is the thin renderer over it.
 */
import {
  FILM_PRICE, PHASE, ageTierOf, filmTitle, isNewRelease, nextSelector, payoutFor, primaryOf, theaterBudget,
} from '../sim/entertainment.js';
import { floorLabel } from '../sim/state.js';

const money = (n) => '$' + n.toLocaleString('en-US');

/**
 * What the panel shows for the theater that `objectId` is a half of, or `null`
 * when it is not one. Pure.
 *
 * `seats` is what ONE half will be budgeted at the next 240 rebuild - the film's
 * pool and age decide it, and a freshly bought film is back at the top of the
 * table, which is the whole reason to buy one. `live` says whether the figures
 * are today's (a show is running) or yesterday's.
 *
 * @param world `{ tower, ledger }`
 */
export function theaterPanelModel(world, objectId) {
  const { tower, ledger } = world;
  const primary = primaryOf(tower, tower.objects.get(objectId));
  const record = primary?.venue;
  if (!record || record.variant !== 'theater') return null;
  const lower = tower.objects.get(record.lowerId);

  const live = record.phase >= PHASE.activated;
  const attendance = live ? record.attendance : record.lastAttendance;
  const choices = ['new', 'classic'].map((pool) => {
    const price = FILM_PRICE[pool];
    const selector = nextSelector(record.selector, pool);
    return {
      pool,
      label: pool === 'new' ? 'Show a new movie' : 'Show a classic',
      price,
      priceLabel: money(price),
      title: filmTitle(selector),
      // Same predicate the command uses: `chargeConstruction` refuses `cost > cash`.
      affordable: price <= ledger.cash,
      // A new film restarts the age clock, so the budget it would seed.
      seats: theaterBudget(selector, 0),
    };
  });
  return {
    id: primary.id,
    title: 'Movie Theater · ' + floorLabel(lower?.floor ?? primary.floor) + '-' + floorLabel(primary.floor),
    film: filmTitle(record.selector),
    pool: isNewRelease(record.selector) ? 'new' : 'classic',
    age: record.age,
    ageTier: ageTierOf(record.age),
    seats: theaterBudget(record.selector, record.age),
    live,
    attendance,
    pays: live ? payoutFor(record) : record.lastPayout,
    choices,
  };
}

/**
 * Mount the panel into `root`. `getWorld()` returns `{ tower, ledger }`,
 * `apply(command)` returns the sim's `{ ok, reason }`, `onChange()` lets the page
 * redraw. Returns `{ open(id), close(), refresh(), isOpen }`.
 *
 * The buttons are built once per opening and `refresh()` only rewrites their
 * text, so a figure that changes under the pointer never replaces the button
 * the pointer is on.
 */
export function mountTheaterPanel(root, { getWorld, apply, onChange = () => {} }) {
  let openId = null;
  let status = '';
  let nodes = null;

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
    refresh();
  };

  function build() {
    root.replaceChildren();
    nodes = null;
    const model = openId === null ? null : theaterPanelModel(getWorld(), openId);
    if (!model) { root.hidden = true; return; }
    root.hidden = false;
    nodes = {
      title: el('b'),
      film: el('div', { class: 'tp-film' }),
      seats: el('div', { class: 'tp-line' }),
      day: el('div', { class: 'tp-line' }),
      buy: model.choices.map((choice) => el('button', {
        class: 'tp-buy',
        onclick: () => send({ type: 'set_theater_film', objectId: openId, pool: choice.pool }),
      })),
      status: el('div', { class: 'lp-status' }),
    };
    root.append(
      el('div', { class: 'lp-head' }, nodes.title,
        el('button', { class: 'lp-x', text: '×', title: 'close', onclick: () => { openId = null; build(); } })),
      nodes.film, nodes.seats, nodes.day, el('div', { class: 'tp-buys' }, ...nodes.buy), nodes.status,
    );
  }

  function refresh() {
    if (openId === null) return;
    const model = theaterPanelModel(getWorld(), openId);
    if (!model || !nodes) { build(); return; }
    nodes.title.textContent = model.title;
    nodes.film.textContent = model.film + ' · ' + (model.pool === 'new' ? 'new release' : 'classic');
    nodes.seats.textContent = model.seats + ' seats a show at this film\'s age (day ' + model.age + ')';
    nodes.day.textContent = model.attendance + ' seats ' + (model.live ? 'today' : 'yesterday') + ' · pays ' + money(model.pays);
    model.choices.forEach((choice, i) => {
      const button = nodes.buy[i];
      button.textContent = choice.label + ': ' + choice.priceLabel + ' · ' + choice.title;
      button.title = choice.seats + ' seats a show';
      button.classList.toggle('poor', !choice.affordable);
    });
    nodes.status.textContent = status;
  }

  return {
    open(id) { openId = id; status = ''; build(); refresh(); },
    close() { openId = null; build(); },
    refresh,
    get isOpen() { return openId !== null; },
  };
}
