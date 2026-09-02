/**
 * Keeping a tower between visits.
 *
 * ## The interaction, and why it is this one
 *
 * **Autosave, and resume on open.** No slot list, no Save button, no dialog.
 *
 * The failure being fixed is "closing the tab loses the tower", and it bites
 * after an hour of investment — which is exactly the moment a player is least
 * inclined to have been diligent about a Save button they never noticed. A
 * manual save system asks the player to defend against a loss they cannot see
 * coming; autosave just removes the loss.
 *
 * It is also the thing this repo already refuses to build in another form: a
 * slot manager with names, dates and a delete button is a panel about the game
 * rather than the game, and `CLAUDE.md` retired the last one of those.
 *
 * Two consequences of autosaving are handled rather than ignored:
 *
 * - **Silence is not reassuring.** A save you cannot see is a save you cannot
 *   trust, so the bar carries when it last wrote, and says so out loud when the
 *   browser has nowhere to write.
 * - **A player must be able to start again.** If opening always resumes, a
 *   tower you have ruined is a tower you are stuck with. Hence `discard()`.
 *
 * The cadence is **once a game day, plus on the way out**. A day is the unit
 * this game thinks in, it is 3m37s at 1x so the writes are cheap, and it means
 * the worst case a crash can cost is one day — which is also the smallest
 * amount of progress a player would describe as "something".
 */
import { restore, snapshot } from '../sim/save.js';
import { AUTOSAVE_KEY, isStorageUnavailable, readSave, writeSave, deleteSave } from './save-store.js';

/**
 * Wire autosaving to a world.
 *
 * @param getWorld  a function returning the live `{tower, ledger}` — a
 *   function and not the world itself, because loading replaces it, and a
 *   captured reference would go on saving the tower the player abandoned.
 * @param onStatus  called with a short line for the bar
 */
export function makeAutosave(getWorld, onStatus = () => {}) {
  let lastSavedDay = null;
  let lastSavedAt = 0;
  let writing = false;

  async function save(reason) {
    if (writing) return false;                 // never queue a second write behind a slow one
    const world = getWorld();
    if (!world) return false;
    writing = true;
    try {
      await writeSave(AUTOSAVE_KEY, snapshot(world, { name: 'autosave' }));
      lastSavedDay = world.tower.clock.dayCounter;
      lastSavedAt = Date.now();
      onStatus(isStorageUnavailable() ? 'saved (this tab only)' : 'saved');
      return true;
    } catch (error) {
      // A failed save must be loud. The whole point of this module is that a
      // player can walk away, and a silent failure means they walk away from a
      // tower that is already gone.
      onStatus('COULD NOT SAVE: ' + (error?.message ?? error));
      return false;
    } finally {
      writing = false;
    }
  }

  return {
    save,

    /** Call every frame. Writes when the day counter moves, and never twice
     *  for the same day however many times it is called. */
    tick() {
      const world = getWorld();
      if (!world) return;
      const day = world.tower.clock.dayCounter;
      if (day === lastSavedDay) return;
      if (lastSavedDay === null) { lastSavedDay = day; return; }   // the day it opened on
      save('day ' + day);
    },

    /** Seconds since the last write, or null if there has not been one. */
    get age() { return lastSavedAt ? (Date.now() - lastSavedAt) / 1000 : null; },
    get savedDay() { return lastSavedDay; },
  };
}

/**
 * The tower to open on: the saved one, or nothing.
 *
 * Returns `{ world, note }`. `note` is what to tell the player — that they were
 * resumed, or **why they were not**. A save that cannot be read is the one
 * moment a person most needs a sentence: they are about to see an empty tower
 * where an hour's work was, and "this save was written by a newer version" is
 * the difference between a bug and an explanation.
 */
export async function loadSavedWorld() {
  let blob;
  try {
    blob = await readSave(AUTOSAVE_KEY);
  } catch (error) {
    return { world: null, note: 'could not reach the save store: ' + (error?.message ?? error) };
  }
  if (!blob) return { world: null, note: '' };

  const result = restore(blob);
  if (!result.ok) return { world: null, note: 'starting fresh — ' + result.reason };

  const s = result.summary ?? {};
  return { world: result.world, note: 'resumed day ' + (s.day ?? '?') + ' · ' + (s.let ?? 0) + ' let' };
}

/** Throw the saved tower away, so the next open starts clean. */
export async function discardSavedWorld() {
  try {
    await deleteSave(AUTOSAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
