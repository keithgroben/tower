/**
 * **The finish** (issue #17): the banner the Tower rank earns.
 *
 * The sim records WHEN the rank was awarded - `tower.finale`, written once by
 * `sim/progression.js` `crownTower` - and the original's own words for it (`DIALOG_3034`:
 * *Congratulations! Your tower has been given a "Tower" Rating!*). This reads that record and says
 * it. It owns no rule and writes nothing back (`CLAUDE.md` rule 1); the fireworks are the
 * renderer's (`render/canvas.js` `fireworksShow`), and the game does not stop: the banner is
 * dismissed with a button, and the tower runs on at rank 6.
 *
 * It is shown for a rank the player WATCHED being earned and not for one already standing when
 * the page opened - a crowned save loaded next week should not throw a party it has already had,
 * which is the rule the renderer's blast and fireworks follow too.
 *
 * `finaleModel` is pure so a test can read what the banner would say without a DOM;
 * `mountFinale` is the thin renderer over it.
 */
import { starPopulation } from '../sim/progression.js';

/** The banner's identity: the moment the rank was earned. */
export const finaleKeyOf = (tower) => (tower.finale ? tower.finale.day + ':' + tower.finale.tick : null);

/**
 * What the banner shows, or `null` when there is nothing to say. Pure.
 *
 * @param world `{ tower, ledger }`
 * @param dismissed the key of the banner the player has already closed (or was loaded with)
 */
export function finaleModel(world, dismissed = null) {
  const { tower, ledger } = world;
  const key = finaleKeyOf(tower);
  if (key === null || key === dismissed) return null;
  // `Congratulations! Your tower ...`: the original's dialog has the greeting as its own line.
  const split = tower.finale.text.indexOf('! ');
  const title = split < 0 ? tower.finale.text : tower.finale.text.slice(0, split + 1);
  const body = split < 0 ? [] : [tower.finale.text.slice(split + 2)];
  return {
    key,
    title,
    body,
    rank: 'TOWER',
    facts: [
      'day ' + (tower.finale.day + 1) + ' of your tower',
      starPopulation(tower, 5).toLocaleString('en-US') + ' people',
      '$' + Math.round(ledger.cash).toLocaleString('en-US'),
    ],
    button: 'Keep building',
    note: 'The tower runs on - nothing ends, and nothing is taken away.',
  };
}

/**
 * Mount the banner into `root`. `getWorld()` returns `{ tower, ledger }`. Returns `{ refresh(),
 * isOpen }`.
 */
export function mountFinale(root, { getWorld }) {
  let dismissed;            // undefined until the first look: whatever is there then was already there
  let shown = null;

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node[k] = v;
    }
    for (const kid of kids) node.append(kid);
    return node;
  };

  function refresh() {
    const world = getWorld();
    if (dismissed === undefined) dismissed = finaleKeyOf(world.tower);
    const model = finaleModel(world, dismissed);
    if (!model) { shown = null; root.hidden = true; root.replaceChildren(); return; }
    if (shown === model.key) return;
    shown = model.key;
    root.replaceChildren(
      el('div', { class: 'fin-rank', text: model.rank }),
      el('div', { class: 'fin-title', text: model.title }),
      ...model.body.map((line) => el('div', { class: 'fin-line', text: line })),
      el('div', { class: 'fin-facts', text: model.facts.join(' · ') }),
      el('div', { class: 'fin-note', text: model.note }),
      el('button', {
        class: 'fin-btn', text: model.button,
        onclick: () => { dismissed = model.key; refresh(); },
      }),
    );
    root.hidden = false;
  }

  return { refresh, get isOpen() { return shown !== null; } };
}
