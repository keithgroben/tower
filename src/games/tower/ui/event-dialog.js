/**
 * The question the tower asks you (issue #16): a bomb's ransom, a fire's helicopter.
 *
 * Open the moment the sim raises it (`sim/events.js` `pendingDecision`), in the original's own
 * words (`DIALOG_3020`: *"Find the Bomb | Pay Them | Blackmail from Terrorists! They demand $#000
 * or a hidden bomb will explode at 3 o'clock."*; `DIALOG_3010`/`3011` and `3012`: *"SECOM has
 * sensed a fire on floor ^0! Everyone should take emergency refuge!"* and *"Would you like to call
 * an emergency fire crew? It will cost $#000."*). It reads one record and sends one command,
 * `answer_event`; it owns no rule. Whether an answer can be given is `answerRefusal`, the same
 * function the seam asks, so a button is dead exactly when the seam would refuse it
 * (`test/events.test.js` runs both).
 *
 * **While it is open the game does not run.** The sim gives an unanswered question two ticks
 * (`EVENTS.md`: *"two ticks after ignition, the game resolves the rescue choice prompt"*) and
 * then answers it for you - the right default for a headless run, the wrong one for a person
 * reading a dialog - so `main.js` stops the tick pump while `blocking()` is true. Nothing the sim
 * does changes: it simply is not asked for the next tick until the player has answered.
 *
 * `eventDialogModel` is pure so a test can read what the dialog would say without a DOM;
 * `mountEventDialog` is the thin renderer over it.
 */
import { EVENT_TEXT, answerRefusal, pendingDecision } from '../sim/events.js';
import { floorLabel } from '../sim/state.js';

/** Last 'fire' / 'bomb' notice text is rebuilt from the live event, never stored twice. */
const lines = (text) => text.split('\n').filter((l) => l !== '');

/**
 * What the dialog shows, or `null` when nothing is being asked. Pure.
 *
 * `buttons[].enabled` is `answerRefusal(tower, answer) === null`; `reason` is its sentence.
 *
 * @param world `{ tower, ledger }`
 */
export function eventDialogModel(world) {
  const { tower } = world;
  const decision = pendingDecision(tower);
  if (!decision) return null;
  const events = tower.events;

  const button = (answer, label, hint) => {
    const reason = answerRefusal(tower, answer);
    return { answer, label, hint, enabled: reason === null, reason };
  };

  if (decision.kind === 'bomb') {
    const bomb = events.bomb;
    const text = EVENT_TEXT.bombDemand(decision.cost);
    const [title, ...body] = lines(text);
    return {
      kind: 'bomb',
      title,
      body,
      // The original's two buttons, in its order: Find the Bomb | Pay Them.
      buttons: [
        button('search', 'Find the Bomb', 'Your security offices look for it. It explodes at the deadline if they do not find it.'),
        button('pay', 'Pay Them ' + '$' + decision.cost.toLocaleString('en-US'), 'The bomb is never heard of again.'),
      ],
      floor: bomb?.floor ?? null,
    };
  }

  const fire = events.fire;
  const first = fire.guards.length > 0 ? EVENT_TEXT.fireSensed(fire.floor) : EVENT_TEXT.fireReported(fire.floor);
  const [title, ...rest] = lines(first);
  return {
    kind: 'fire',
    title,
    body: [...rest, ...lines(EVENT_TEXT.fireCrew(decision.cost))],
    buttons: [
      button('helicopter', 'Yes ' + '$' + decision.cost.toLocaleString('en-US'), 'A rescue helicopter puts the fire out within seconds.'),
      button('decline', 'No', fire.guards.length > 0
        ? 'Your guards climb the emergency stairs and fight it. The nearer their office, the sooner.'
        : 'You have no security offices: nobody is coming.'),
    ],
    floor: fire.floor,
    floorName: floorLabel(fire.floor),
  };
}

/** Is a question open? `main.js` holds the clock still while it is. */
export const eventDialogBlocking = (tower) => pendingDecision(tower) !== null;

/**
 * Mount the dialog into `root`. `getWorld()` returns `{ tower, ledger }`, `apply(command)` returns
 * the sim's `{ ok, reason }`, `onChange()` lets the page redraw. Returns `{ refresh(), isOpen }`.
 */
export function mountEventDialog(root, { getWorld, apply, onChange = () => {} }) {
  let shown = null;
  let status = '';

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node[k] = v;
    }
    for (const kid of kids) node.append(kid);
    return node;
  };

  function build(model) {
    root.replaceChildren();
    root.hidden = false;
    root.dataset.kind = model.kind;
    const buttons = model.buttons.map((b) => el('button', {
      class: 'ev-btn ev-' + b.answer, text: b.label, title: b.hint,
      onclick: () => {
        const result = apply({ type: 'answer_event', answer: b.answer });
        status = result.ok ? '' : result.reason;
        onChange();
        refresh();
      },
    }));
    root.append(
      el('div', { class: 'ev-title', text: model.title }),
      ...model.body.map((line) => el('div', { class: 'ev-line', text: line })),
      el('div', { class: 'ev-buttons' }, ...buttons),
      el('div', { class: 'lp-status ev-status', text: status }),
    );
  }

  function refresh() {
    const model = eventDialogModel(getWorld());
    if (!model) { shown = null; status = ''; root.hidden = true; root.replaceChildren(); return; }
    const key = model.kind + ':' + (model.floor ?? '');
    if (shown !== key) { shown = key; status = ''; build(model); }
    // The buttons are rebuilt only when a different question opens; their enabled state follows the cash.
    const nodes = root.querySelectorAll('.ev-btn');
    model.buttons.forEach((b, i) => { if (nodes[i]) { nodes[i].disabled = !b.enabled; nodes[i].title = b.enabled ? b.hint : b.reason; } });
    const statusNode = root.querySelector('.ev-status');
    if (statusNode) statusNode.textContent = status;
  }

  return { refresh, get isOpen() { return shown !== null; } };
}
