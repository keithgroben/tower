/**
 * Who is holding the game still (issue #18).
 *
 * `HELP.txt`: *"Eval, Pricing and Hotel buttons pause the game"*, *"The game will pause when
 * [the Facility] window is open"*, *"The game pauses when the Finance Window is active"*. A pause
 * that other things can take and give back needs a rule about WHAT is given back, and the rule is the
 * whole job of this file:
 *
 *  - Opening a map view or a window **holds** the game; closing it **releases** the hold.
 *  - What comes back is the speed the player had chosen - 4x stays 4x, and a game they had paused
 *    themselves stays paused. A hold never turns a pause into a play.
 *  - Choosing a speed while something is held (a click on 2x, the space bar) changes the speed that
 *    will come back, not the speed now: the tower stays still behind the view until it is closed.
 *  - Several holders may overlap (a window opened from a window); the game runs again only when the
 *    last has let go.
 *
 * **It does not own the event dialog.** A bomb's ransom or a fire's helicopter stops the tick pump on
 * its own (`ui/event-dialog.js` `eventDialogBlocking`, read by `main.js`'s frame), and a speed here
 * is only an input to the pump - so releasing a hold can never un-block a question the player has not
 * answered. `test/windows.test.js` runs both together.
 *
 * Pure: it knows no DOM and no clock. `onChange` is told the speed to run at and what is holding.
 */
import { SPEEDS } from './loop.js';

/**
 * @param {{ initial?: number, speeds?: number[], onChange?: (state: {speed:number, wanted:number, held:string[]}) => void }} options
 */
export function makePauseGate({ initial = 1, speeds = SPEEDS, onChange = () => {} } = {}) {
  let wanted = speeds.includes(initial) ? initial : 1;
  const holders = new Set();

  const state = () => ({ speed: holders.size > 0 ? 0 : wanted, wanted, held: [...holders] });
  const emit = () => onChange(state());

  return {
    /** The player's choice (a speed button, the space bar). Takes effect now unless something holds. */
    request(next) {
      wanted = speeds.includes(next) ? next : 1;
      emit();
      return state().speed;
    },
    /** `key` wants the game still. Idempotent. */
    hold(key) { holders.add(key); emit(); },
    /** `key` is done. Idempotent; the speed comes back only when nothing else holds. */
    release(key) { holders.delete(key); emit(); },
    /** Drop every hold at once (Escape, a new tower). */
    releaseAll() { holders.clear(); emit(); },
    /** The speed the pump should run at right now. */
    get speed() { return state().speed; },
    /** The speed the player chose, held or not. */
    get wanted() { return wanted; },
    get held() { return [...holders]; },
    isHeld(key) { return holders.has(key); },
  };
}
