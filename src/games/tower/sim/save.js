/**
 * Saving a tower, and refusing to load one that no longer fits.
 *
 * A save is a **snapshot**, not a replay. The sim is deterministic and its
 * whole state JSONs cleanly, so the honest way to resume a six-hour tower is
 * to write the state down and put it back — measured, not assumed: a 150-day
 * tower snapshotted, reparsed and stepped 60 more days produces a
 * byte-identical log (`test/save.test.js`). Replaying an action tape would
 * take as long as the session did.
 *
 * The one thing JSON cannot carry is the rng, which is a closure. Its cursor
 * is exposed as a `get seed()` / `set seed(v)` pair for exactly this reason,
 * so the snapshot stores the cursor and `restore` rebuilds the generator
 * around it. Get that wrong and the tower resumes into a *different* future
 * while looking perfectly correct — the worst class of save bug.
 *
 * ## Why this refuses rather than repairs
 *
 * The sim's state shape changed four times on 2026-09-01 alone — floor range,
 * support rule, empty rooms, `everLet`. A save written either side of one of
 * those is not a tower this build can run, and half-loading it produces a
 * plausible-looking wreck rather than an error. So `restore` compares the
 * save's keys against a **freshly booted state from the current code** and
 * names what is missing. That check maintains itself: it has nothing to
 * hand-update when the shape changes again.
 *
 * `SAVE_VERSION` covers what keys cannot see — a change in what a key *means*
 * rather than whether it exists. Bump it by hand for those.
 *
 * Pure and Node-runnable, like everything else under `sim/`. The browser half
 * (IndexedDB slots, files, the panel) lives in `ui/`.
 */
import { boot } from './index.js';
import { makeRng } from './rng.js';
import { basementDepth, population, starTier } from './state.js';

export const SAVE_SCHEMA = 'lift-save/v1';

/**
 * Bumped by hand when the sim's *rules* change in a way the key check cannot
 * see, so old saves are refused rather than resumed into the wrong game.
 * The key names surviving a change is not the same as the tower still meaning
 * what it did.
 */
export const SAVE_VERSION = 1;

/** Keys that never travel in a save, because they cannot survive JSON. */
const NOT_SERIALISABLE = new Set(['rng']);

/**
 * The state, minus what JSON would silently drop, plus the rng cursor beside
 * it. Deep-cloned through JSON so the snapshot can never alias the live
 * tower — a save that shares an array with the running game is a save that
 * keeps changing after you took it.
 */
export function snapshot(state, config, { tape = [], name = '', now = Date.now() } = {}) {
  const plain = {};
  for (const [key, value] of Object.entries(state)) {
    if (NOT_SERIALISABLE.has(key)) continue;
    plain[key] = value;
  }
  return {
    schema: SAVE_SCHEMA,
    version: SAVE_VERSION,
    name,
    savedAt: now,
    /** The rng cursor. Not the seed the tower started from — that is in the state. */
    rngSeed: state.rng?.seed ?? state.seed ?? 1,
    /** What the tower was tuned to. Restored with it, and reported when it differs. */
    config: JSON.parse(JSON.stringify(config)),
    state: JSON.parse(JSON.stringify(plain)),
    /** The snapshot resumes; the tape reproduces. Both, or neither is useful. */
    tape: JSON.parse(JSON.stringify(tape)),
    summary: summarise(state, config),
  };
}

/**
 * What a save looks like in a list, computed once at save time so opening the
 * slot list never has to parse a two-megabyte state to draw a row.
 */
export function summarise(state, config) {
  const last = state.log?.[state.log.length - 1] ?? null;
  return {
    day: state.day ?? 0,
    floors: state.floors ?? 0,
    basements: basementDepth(state),
    population: population(state),
    money: state.money ?? 0,
    star: starTier(state, config)?.name ?? '',
    seed: state.seed ?? 1,
    over: !!state.over,
    deliveryRate: last?.deliveryRate ?? null,
  };
}

/**
 * Read a save back. Returns `{ok:false, reason}` with a sentence a player can
 * act on, or `{ok:true, state, configPatch, summary}`.
 *
 * `configPatch` is *returned, not applied* — writing to the live config is the
 * caller's move, and keeping it out of here is what lets a test ask what a
 * save would change without changing anything.
 *
 * @param {object} blob   the parsed save
 * @param {object} config the config this build is running
 */
export function restore(blob, config) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { ok: false, reason: 'this is not a Lift save file.' };
  }
  if (blob.schema !== SAVE_SCHEMA) {
    const found = typeof blob.schema === 'string' ? blob.schema : 'nothing';
    // The tape export is the file most likely to be dropped here by mistake,
    // and it deserves to be told apart from a corrupt save.
    const hint = found === 'lift-tape/v1'
      ? ' That is an action tape, not a save — tapes replay a session, they do not resume one.'
      : '';
    return { ok: false, reason: 'this file says it is "' + found + '", not a Lift save.' + hint };
  }
  if (!Number.isInteger(blob.version)) {
    return { ok: false, reason: 'this save does not say which version of Lift wrote it.' };
  }
  if (blob.version !== SAVE_VERSION) {
    const direction = blob.version > SAVE_VERSION ? 'a newer' : 'an older';
    return {
      ok: false,
      reason: 'this save was written by ' + direction + ' version of Lift (save v' + blob.version
        + ', this build reads v' + SAVE_VERSION + '). The tower’s rules changed since; loading it '
        + 'would produce a tower that plays by neither set.',
    };
  }
  if (!blob.state || typeof blob.state !== 'object' || Array.isArray(blob.state)) {
    return { ok: false, reason: 'this save has no tower in it.' };
  }

  const missing = missingKeys(blob.state, config);
  if (missing.length) {
    return {
      ok: false,
      reason: 'this save is missing ' + list(missing) + '. The simulation’s shape changed after '
        + 'it was written, so there is no honest way to resume it.',
    };
  }

  // Cloned again on the way in: loading the same blob twice must produce two
  // independent towers, not two views of one.
  const state = JSON.parse(JSON.stringify(blob.state));
  state.rng = makeRng(state.seed ?? 1);
  const cursor = Number(blob.rngSeed);
  if (!Number.isFinite(cursor)) {
    return { ok: false, reason: 'this save has no random-number cursor, so it cannot resume the same future.' };
  }
  state.rng.seed = cursor;

  return {
    ok: true,
    state,
    configPatch: configDiff(config, blob.config),
    summary: blob.summary ?? summarise(state, config),
  };
}

/**
 * Keys a freshly booted tower has that this save does not. Computed from the
 * running code, so it needs no maintenance when the state grows a field —
 * which is the point, given how often it has.
 *
 * Extra keys in the save are fine and deliberately unreported: a field the sim
 * stopped reading is dead weight, not a broken tower.
 */
export function missingKeys(saved, config) {
  const reference = boot(config, 1);
  const missing = [];
  for (const key of Object.keys(reference)) {
    if (NOT_SERIALISABLE.has(key)) continue;
    if (!(key in saved)) missing.push(key);
  }
  // `today` is the one nested shape the sim rebuilds wholesale every day, so a
  // save missing one of its counters crashes at the next day close rather than
  // at load. Check it here, where the message can still be useful.
  const today = saved.today;
  if (!today || typeof today !== 'object') {
    if (!missing.includes('today')) missing.push('today');
  } else {
    for (const key of Object.keys(reference.today ?? {})) {
      if (!(key in today)) missing.push('today.' + key);
    }
  }
  return missing;
}

const list = (items) => items.length === 1
  ? items[0]
  : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];

/**
 * Leaf paths where the save's tuning differs from this build's. Arrays count
 * as leaves — a config array is a table (star tiers, the palette), and half a
 * table is worse than either whole one.
 *
 * Paths the current config no longer has are dropped: a knob we deleted is not
 * a knob a save gets to resurrect. Paths the save lacks keep today's default,
 * so a tower saved before a knob existed plays with it rather than without it.
 */
export function configDiff(current, saved, prefix = '') {
  if (!saved || typeof saved !== 'object') return [];
  const out = [];
  for (const [key, currentValue] of Object.entries(current ?? {})) {
    if (!(key in saved)) continue;
    const savedValue = saved[key];
    const path = prefix ? prefix + '.' + key : key;
    const nested = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue);
    if (nested) {
      out.push(...configDiff(currentValue, savedValue, path));
    } else if (JSON.stringify(currentValue) !== JSON.stringify(savedValue)) {
      out.push({ path, from: currentValue, to: savedValue });
    }
  }
  return out;
}

/** Write a `configDiff` into a live config object, in place. */
export function applyConfigPatch(config, patch) {
  for (const { path, to } of patch ?? []) {
    const parts = path.split('.');
    const last = parts.pop();
    let node = config;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') { node = null; break; }
      node = node[part];
    }
    if (node && typeof node === 'object') node[last] = JSON.parse(JSON.stringify(to));
  }
  return config;
}

/**
 * Should the autosave fire now?
 *
 * Two gates, and both are needed. Days alone would write once every 3.75
 * seconds of wall clock at 12x — a two-megabyte write on a tower that size.
 * Wall clock alone would write repeatedly into a paused game. So: at least
 * `minDays` of tower have passed, AND at least `minMs` of the player's life.
 *
 * `lastSavedDay: null` means nothing has been autosaved yet, which always
 * qualifies — the first day close of a session is exactly when losing the tab
 * costs the most relative to what it took to get there.
 */
export function shouldAutosave({ day, now, lastSavedDay = null, lastSavedAt = 0, minDays = 1, minMs = 20000 }) {
  if (!Number.isFinite(day) || !Number.isFinite(now)) return false;
  if (lastSavedDay == null) return true;
  return (day - lastSavedDay) >= minDays && (now - lastSavedAt) >= minMs;
}
