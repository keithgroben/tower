/**
 * Saving a tower, and getting it back.
 *
 * Rewritten for the `{tower, ledger}` world. The previous file came across from
 * the predecessor repo and **could not even be imported** — it began
 * `import { boot } from './index.js'`, and there is no `sim/index.js` in this
 * repo. It also read `state.log`, `state.day`, `state.floors`, `state.money`
 * and `starTier()`, none of which exist. So this is not a port; the old one was
 * a module that threw on load, which is why nothing calling it went unnoticed.
 *
 * Pure and Node-runnable like everything else under `sim/`. The browser half —
 * which store, which slot — is `ui/save-store.js`.
 *
 * ## The two things JSON silently loses
 *
 * A tower is not a plain object, and both of the ways it is not are invisible
 * failures rather than errors:
 *
 * 1. **`tower.objects` is a `Map`.** `JSON.stringify` turns a Map into `{}`.
 *    Not an error, not a warning — a save that "worked", and a tower that comes
 *    back with no rooms in it and its people pointing at nothing.
 * 2. **`tower.rng` is a closure.** It stringifies to `{}` as well, and a tower
 *    restored with a fresh generator replays a different future from the same
 *    position, which is the one thing `CLAUDE.md` says determinism must never
 *    do. Only the 32-bit cursor travels; `makeRng` rebuilds the rest.
 *
 * 3. **`carrier.liveRequests` is a `Set`.** Same failure, one level down, and
 *    found by the round-trip test rather than by reading: a restored carrier
 *    came back with `{}` and threw `liveRequests.has is not a function` on the
 *    first ride. Had it merely come back *empty* it would not have thrown at
 *    all — it would have let every rider queue twice again, which is the
 *    duplicate-boarding bug that cost a day to find the first time.
 *
 * `routeTables` is deliberately NOT saved. It is derived from the carriers and
 * segments and is rebuilt at the start-of-day checkpoint; storing it would be
 * a second copy of something already in the file, free to disagree with it.
 *
 * `test/save.test.js` walks the live tower for anything else JSON cannot
 * carry, so the fourth one fails a test instead of a playthrough.
 */
import { makeRng } from './rng.js';
import { ledgerFor } from './ledger-adapter.js';
import { createActor, createObject, isRented, population } from './state.js';

export const SAVE_SCHEMA = 'tower-save/v1';

/**
 * Bumped by hand when the sim's *rules* change in a way the key check cannot
 * see, so old saves are refused rather than resumed into the wrong game. The
 * keys surviving a change is not the same as the tower still meaning what it
 * did.
 *
 * v1 is this repo's first working save. Nothing from `lift-save/v1` can be
 * read — a different state model entirely — and it is refused by schema, not
 * by version, which is why the message can say something useful.
 */
export const SAVE_VERSION = 1;

/**
 * Tower keys that never travel as themselves. Each is rebuilt in `restore`,
 * and each would otherwise stringify to `{}` without complaint.
 */
const REBUILT = new Set(['objects', 'rng', 'routeTables']);

/**
 * A save blob: plain JSON, deep-cloned so it can never alias the running tower.
 * A snapshot that shares an array with the live game is a snapshot that keeps
 * changing after you took it.
 *
 * @param {{tower: object, ledger: object}} world
 */
export function snapshot(world, { name = '', now = Date.now() } = {}) {
  const { tower, ledger } = world;
  const plain = {};
  for (const [key, value] of Object.entries(tower)) {
    if (REBUILT.has(key)) continue;
    plain[key] = value;
  }
  return {
    schema: SAVE_SCHEMA,
    version: SAVE_VERSION,
    name,
    savedAt: now,
    /** The generator's cursor, not the seed. The seed alone only reproduces a
     *  run from tick zero; resuming needs the position. */
    rngState: tower.rng.state,
    tower: plainTower(plain),
    /** The Map, as entries. See the header — this is the one that fails silently. */
    objects: JSON.parse(JSON.stringify([...tower.objects.values()])),
    ledger: JSON.parse(JSON.stringify(ledger)),
    summary: summarise(world),
  };
}

/**
 * The tower's plain half, with the collections JSON cannot carry turned into
 * something it can. Only `carrier.liveRequests` needs it at this level; the
 * Map and the generator are handled a level up because they are the tower's
 * own keys rather than a carrier's.
 */
function plainTower(plain) {
  const out = JSON.parse(JSON.stringify(plain));
  out.carriers = (plain.carriers ?? []).map((carrier, i) => ({
    ...out.carriers[i],
    liveRequests: [...carrier.liveRequests],
  }));
  return out;
}

/**
 * What a save looks like in a list, computed once at save time so opening the
 * list never has to parse a whole tower to draw a row.
 */
export function summarise({ tower, ledger }) {
  let let_ = 0, leasable = 0;
  for (const o of tower.objects.values()) {
    if (o.occupants.length === 0) continue;
    leasable++;
    if (o.occupiedFlag && isRented(o.unitStatus)) let_++;
  }
  return {
    day: tower.clock.dayCounter,
    dayTick: tower.clock.dayTick,
    population: population(tower),
    let: let_,
    leasable,
    cash: ledger.cash,
    stars: tower.starCount,
  };
}

/**
 * Read a save back. Returns `{ok:false, reason}` with a sentence a player can
 * act on, or `{ok:true, world, summary}`.
 *
 * Every refusal is written for somebody who just lost a tower, so it says what
 * the file is rather than what the parser wanted.
 */
export function restore(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { ok: false, reason: 'that is not a saved tower.' };
  }
  if (blob.schema !== SAVE_SCHEMA) {
    const found = typeof blob.schema === 'string' ? blob.schema : 'nothing';
    // A save from the predecessor repo is the file most likely to turn up here,
    // and it deserves to be told apart from a corrupt one.
    const hint = found.startsWith('lift-')
      ? ' That is a save from Lift, which modelled its tower completely differently — it cannot be converted.'
      : '';
    return { ok: false, reason: 'this file says it is "' + found + '", not a saved tower.' + hint };
  }
  if (!Number.isInteger(blob.version)) {
    return { ok: false, reason: 'this save does not say which version wrote it.' };
  }
  if (blob.version !== SAVE_VERSION) {
    const direction = blob.version > SAVE_VERSION ? 'a newer' : 'an older';
    return {
      ok: false,
      reason: 'this save was written by ' + direction + ' version (save v' + blob.version
        + ', this build reads v' + SAVE_VERSION + '). The tower\'s rules changed since, so resuming it'
        + ' would be playing a different game from the one that was saved.',
    };
  }
  if (!blob.tower || !Array.isArray(blob.objects) || !blob.ledger) {
    return { ok: false, reason: 'this save is missing part of its tower and cannot be resumed.' };
  }

  const tower = { ...blob.tower };
  tower.objects = new Map(blob.objects.map((o) => [o.id, o]));
  tower.rng = makeRng(blob.rngState ?? 1);
  // A carrier's dedup set. Empty rather than absent is the dangerous case: it
  // would not throw, it would let every rider queue twice.
  for (const carrier of tower.carriers ?? []) {
    carrier.liveRequests = new Set(Array.isArray(carrier.liveRequests) ? carrier.liveRequests : []);
  }
  // Derived, and deliberately absent from the file. `rebuildRouteTables` runs
  // at the start-of-day checkpoint; leaving it undefined until then is the same
  // state a freshly created tower is in.
  delete tower.routeTables;

  reserveIdsAbove(tower);
  // ⚠️ `ledgerFor(tower)`, not `{ ...blob.ledger }`.
  //
  // The ledger is a VIEW over `tower.cash` and the tower's own bucket objects,
  // so spreading it detaches it: the accessors flatten to the numbers they held
  // at that instant. A loaded game would then have two balances again —
  // construction debiting the copy, rent crediting the tower — which is exactly
  // the defect `ui/seed.js` was fixed for, reintroduced on the path nobody
  // walks until an hour in.
  //
  // Everything the view needs already rode over in `blob.tower`: `cash`,
  // `cycleBaseCash` and the three ledgers are plain fields. `blob.ledger` is
  // kept in the file as the readable record of what the balances were, and is
  // still what the version and completeness checks read, but it is not the
  // object the game plays with.
  return {
    ok: true,
    world: { tower, ledger: ledgerFor(tower) },
    summary: blob.summary ?? summarise({ tower, ledger: blob.ledger }),
  };
}

/**
 * Push the id allocators past everything the save brought back.
 *
 * ⚠️ Without this the first thing built after a load **overwrites a restored
 * room**. `createObject` counts from 1 in module scope; a fresh page restoring
 * a tower whose objects are ids 1..42 hands the next build id 1, and
 * `tower.objects.set(1, …)` replaces the old one while its six workers go on
 * pointing at an id that now means something else. No error, and the room only
 * disappears when you build.
 *
 * Done by allocating and discarding, because the counters are module-private
 * and `state.js` exposes only `__resetIds()`, which resets to 1. It is the
 * sim's own allocator being used for exactly what an allocator is for, and the
 * cost is one cheap object per id — but a `reserveIds(n)` seam would say what
 * this means instead of demonstrating it. Requested.
 */
function reserveIdsAbove(tower) {
  let maxObject = 0;
  for (const o of tower.objects.values()) if (o.id > maxObject) maxObject = o.id;
  let maxActor = 0;
  for (const a of tower.actors) if (a && a.id > maxActor) maxActor = a.id;

  const spare = { family: 0, floor: 0, left: 0, right: 0 };
  while (createObject(spare).id <= maxObject) { /* burn one id */ }
  while (createActor({ family: 0, anchorFloor: 0, objectId: 0, occupantIndex: 0 }).id <= maxActor) { /* burn one */ }
}
