/**
 * A saved tower has to come back as the same tower — and, harder, with the
 * same *future*.
 *
 * Field-by-field equality is the weak half of this. A restored tower can match
 * on every visible number and still diverge on the next tick, because the one
 * thing that decides the future is the RNG cursor, which is a closure and does
 * not appear in any comparison of fields. So the load-bearing test here runs
 * both towers forward and compares where they end up.
 *
 * `CLAUDE.md`: *"the snapshot is shape-agnostic; only `SAVE_VERSION` bumps."*
 * That was true of the predecessor's save and is emphatically not true here —
 * a `Map` and a closure both stringify to `{}` without complaint.
 */
import { SAVE_SCHEMA, SAVE_VERSION, restore, snapshot, summarise } from '../src/games/tower/sim/save.js';
import { applyAction } from '../src/games/tower/sim/actions.js';
import { FAMILY, isRented, population } from '../src/games/tower/sim/state.js';
import {
  deactivateIfFailing, officeArrival, officeFamilyHandler, offices,
  recomputeOfficeOperationalStatus,
} from '../src/games/tower/sim/office.js';
import { resolveRouteBetweenFloors } from '../src/games/tower/sim/routing.js';
import {
  CARRIER_SERVICE, accumulateElapsedDelayIntoCurrentSim, applyDistancePenalty,
  applyLocalSegmentDelay, applyQueueFullDelay, computeRuntimeTileStressAverage,
  recordNoRouteFailure, stampRouteStart,
} from '../src/games/tower/sim/stress.js';
import { seedDemoWorld } from '../src/games/tower/ui/seed.js';
import { makeTowerScheduler } from '../src/games/tower/ui/tick.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/** The composition `ui/main.js` runs, so a saved tower is exercised the way a
 *  played one is rather than through a quieter path. */
function driver(world) {
  const { tower } = world;
  const price = (delay, actor) => {
    if (!actor) return;
    switch (delay.kind) {
      case 'no-route': return void recordNoRouteFailure(actor);
      case 'local-transit': return void applyLocalSegmentDelay(actor, delay.modeAndSpan);
      case 'queue-full': return void applyQueueFullDelay(actor);
      case 'distance': return void applyDistancePenalty(actor, {
        heightMetricDelta: delay.heightMetricDelta, emitDistanceFeedback: true, carrierMode: delay.carrierMode });
      case 'boarding': {
        accumulateElapsedDelayIntoCurrentSim(actor, tower.clock.dayTick, {
          sourceFloor: delay.sourceFloor, lobbyHeight: tower.lobbyHeight, carrierMode: delay.carrierMode });
        if (delay.carrierMode !== CARRIER_SERVICE) stampRouteStart(actor, tower.clock.dayTick);
        return;
      }
      default: return;
    }
  };
  return makeTowerScheduler(tower, {
    [FAMILY.office]: officeFamilyHandler({
      resolveRoute: (t, a, f, to, c, o) => resolveRouteBetweenFloors(t, a, f, to, c, o),
      onDelay: price,
      onRent: () => {},
    }),
  }, { [FAMILY.office]: officeArrival }, price);
}

/**
 * Ticks, WITH the daily sweep `ui/main.js` runs on `dayAdvanced`.
 *
 * Without it `occupied_flag` is never set, so family 7's gate never opens and
 * not one die is ever rolled — a tower that looks like it is running and never
 * touches the generator. The rng test caught that before it could make every
 * other test here quietly meaningless.
 */
function run(world, ticks) {
  const { tower } = world;
  const scheduler = driver(world);
  const sweep = () => {
    for (const { object, occupants } of offices(tower)) {
      recomputeOfficeOperationalStatus(tower, object, occupants);
      deactivateIfFailing(tower, object, occupants);
    }
  };
  for (let i = 0; i < ticks; i++) {
    if (scheduler.tick(tower).dayAdvanced) sweep();
  }
}

/** Everything about a tower that a divergence would show up in. */
function fingerprint({ tower, ledger }) {
  return JSON.stringify({
    clock: tower.clock,
    rng: tower.rng.state,
    cash: ledger.cash,
    objects: [...tower.objects.values()].map((o) =>
      [o.id, o.floor, o.left, o.right, o.unitStatus, o.occupiedFlag, o.evalLevel, o.rentLevel]),
    actors: tower.actors.map((a) => a && [a.id, a.state, a.anchorFloor, a.waitingFloor,
      a.tripCount, a.accumulatedElapsed, a.elapsedPacked, a.lastTripTick]),
    carriers: tower.carriers.map((c) => [c.id, c.bottomFloor, c.topFloor, c.column,
      c.cars.map((car) => [car.currentFloor, car.targetFloor, car.dwell, car.settle, car.assignedCount]),
      c.queues.map((q) => [q.up.count, q.down.count])]),
  });
}

export const tests = {
  'a fresh tower round-trips every field'() {
    const world = seedDemoWorld({ seed: 1 });
    run(world, 900);
    const before = fingerprint(world);

    const back = restore(snapshot(world));
    assert(back.ok, back.reason);
    assert(fingerprint(back.world) === before, 'the restored tower is not the tower that was saved');
  },

  '⚠️ the objects Map survives, which JSON alone would not manage'() {
    // `JSON.stringify(new Map())` is `{}`. Not an error, not a warning — a save
    // that "worked" and a tower with no rooms in it. This is the single most
    // likely way a save silently loses everything.
    const world = seedDemoWorld({ seed: 1 });
    assert(world.tower.objects instanceof Map && world.tower.objects.size > 40, 'precondition');

    const blob = snapshot(world);
    assert(JSON.stringify(blob.tower.objects) === undefined, 'the Map is not smuggled into the plain half');

    const back = restore(JSON.parse(JSON.stringify(blob)));   // through a real serialise
    assert(back.ok, back.reason);
    assert(back.world.tower.objects instanceof Map, 'it has to come back a Map, not an array');
    assert(back.world.tower.objects.size === world.tower.objects.size,
      'lost ' + (world.tower.objects.size - back.world.tower.objects.size) + ' rooms');
    for (const [id, o] of world.tower.objects) {
      assert(back.world.tower.objects.get(id)?.left === o.left, 'room ' + id + ' came back wrong');
    }
    assert(population(back.world.tower) === population(world.tower), 'and the population with it');
  },

  '⚠️ a restored tower has the same FUTURE, not just the same fields'() {
    // The load-bearing test. The RNG is a closure: it stringifies to `{}` and
    // appears in no field comparison, so a tower restored with a fresh
    // generator matches on every visible number and then plays a different
    // game from the same position. Only running both forward can see it.
    const original = seedDemoWorld({ seed: 1 });
    run(original, 1400);

    const back = restore(JSON.parse(JSON.stringify(snapshot(original))));
    assert(back.ok, back.reason);
    assert(fingerprint(back.world) === fingerprint(original), 'precondition: they start equal');

    run(original, 2600);
    run(back.world, 2600);
    assert(fingerprint(back.world) === fingerprint(original),
      'a restored tower diverged after a day — the rng cursor did not survive');
  },

  'the rng cursor travels, and it is the cursor and not the seed'() {
    const world = seedDemoWorld({ seed: 1 });
    // Two days, not a few hundred ticks. A new game starts at tick 2533 and the
    // day counter turns at 2300, so the first daily sweep — which is what sets
    // `occupied_flag` and opens family 7's gate — is 2,367 ticks away. Before
    // that the tower ticks along and never rolls a die, and a shorter run would
    // have "passed" this test against a generator that had not moved.
    run(world, 2600 * 2);
    const cursor = world.tower.rng.state;
    assert(cursor !== 1, 'precondition: the generator has moved off its seed');

    const back = restore(snapshot(world));
    assert(back.world.tower.rng.state === cursor, 'the cursor did not survive');
    assert(back.world.tower.rng.next() === world.tower.rng.next(), 'and the next draw must match');
  },

  '⚠️ the first thing built after a load does not overwrite a restored room'() {
    // `createObject` counts from 1 in module scope. Restore a tower whose rooms
    // are ids 1..42 into a fresh page and the next build takes id 1, replacing
    // a room while its six workers go on pointing at an id that now means
    // something else. No error; the room simply vanishes when you build.
    const world = seedDemoWorld({ seed: 1 });
    const blob = JSON.parse(JSON.stringify(snapshot(world)));

    const back = restore(blob);
    const roomsBefore = back.world.tower.objects.size;
    const ids = new Set(back.world.tower.objects.keys());

    const built = applyAction(back.world, { type: 'build', what: 'office', floor: 40, left: 20 });
    assert(built.ok, built.reason);
    assert(!ids.has(built.object.id), 'the new room reused id ' + built.object.id);
    assert(back.world.tower.objects.size === roomsBefore + 1,
      'building replaced a restored room instead of adding one');

    // Actors too: a worker id collision would attach new people to an old room.
    const actorIds = new Set(back.world.tower.actors.map((a) => a.id));
    assert(actorIds.size === back.world.tower.actors.length, 'two actors share an id');
  },

  'the ledger travels, because money is not part of the tower any more'() {
    const world = seedDemoWorld({ seed: 1 });
    applyAction(world, { type: 'build', what: 'office', floor: 40, left: 20 });
    const spent = world.ledger.cash;
    assert(spent < 2_000_000, 'precondition: something was bought');

    const back = restore(JSON.parse(JSON.stringify(snapshot(world))));
    assert(back.world.ledger.cash === spent, 'cash came back as ' + back.world.ledger.cash);
    assert(back.world.ledger !== world.ledger, 'and not as the same object');
  },

  'a snapshot does not alias the running tower'() {
    // A save that shares an array with the live game keeps changing after you
    // took it, and what lands in the store is whatever the tower looked like
    // when the write finally happened.
    const world = seedDemoWorld({ seed: 1 });
    const blob = snapshot(world);
    const dayAtSave = blob.tower.clock.dayTick;
    const roomsAtSave = blob.objects.length;

    run(world, 2000);
    applyAction(world, { type: 'build', what: 'office', floor: 40, left: 20 });

    assert(blob.tower.clock.dayTick === dayAtSave, 'the snapshot\'s clock moved with the game');
    assert(blob.objects.length === roomsAtSave, 'the snapshot grew a room after it was taken');
  },

  'route tables are rebuilt, not stored'() {
    // Derived from the carriers and segments. Storing them would be a second
    // copy of something already in the file, free to disagree with it.
    const world = seedDemoWorld({ seed: 1 });
    run(world, 2600);
    assert(world.tower.routeTables, 'precondition: the running tower has them');

    const blob = snapshot(world);
    assert(!('routeTables' in blob.tower), 'the file must not carry them');
    const back = restore(blob);
    assert(!back.world.tower.routeTables, 'and a restored tower waits for the checkpoint');
    run(back.world, 2600);
    assert(back.world.tower.routeTables, 'which rebuilds them within a day');
  },

  '⚠️ nothing else in a tower is a thing JSON cannot carry'() {
    // Three collections have now been lost this way — the objects Map, the rng
    // closure, and a carrier's liveRequests Set — and each was invisible until
    // something threw or a tower came back empty. So rather than remembering to
    // check, this walks the live tower and fails on anything JSON would drop
    // that is not already handled by name.
    //
    // `CLAUDE.md`: guard the RULE, not the instance. Add a fourth collection to
    // sim state and this names its path instead of a playthrough finding it.
    const world = seedDemoWorld({ seed: 1 });
    run(world, 2600);

    const HANDLED = new Set(['objects', 'rng', 'carriers[].liveRequests']);
    const found = [];
    const walk = (value, path, depth) => {
      if (depth > 6 || value === null || typeof value !== 'object') {
        if (typeof value === 'function') found.push(path);
        return;
      }
      if (value instanceof Map || value instanceof Set) { found.push(path); return; }
      if (Array.isArray(value)) {
        // One element stands for the array: they are homogeneous here, and
        // walking 250 actors adds nothing but time.
        if (value.length) walk(value[0], path + '[]', depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? path + '.' + key : key, depth + 1);
      }
    };
    for (const [key, value] of Object.entries(world.tower)) {
      if (typeof value === 'object' && value !== null && 'next' in value && typeof value.next === 'function') {
        found.push(key);                       // the generator, whose methods are the point
        continue;
      }
      walk(value, key, 0);
    }

    const unhandled = found.filter((p) => !HANDLED.has(p));
    assert(unhandled.length === 0,
      'a tower now holds something JSON cannot carry, and sim/save.js does not know about it: '
      + unhandled.join(', ') + ' — handle it there and add its path to HANDLED here.');
    for (const path of HANDLED) {
      assert(found.includes(path), path + ' is listed as handled but is no longer in the tower');
    }
  },

  // ------------------------------------------------------- refusing a file

  'a save from another game is refused, and named'() {
    const old = { schema: 'lift-save/v1', version: 1, tower: {}, objects: [], ledger: {} };
    const result = restore(old);
    assert(!result.ok, 'a Lift save cannot be resumed');
    assert(result.reason.includes('Lift'), 'and it says so: ' + result.reason);
    assert(result.reason.includes('cannot be converted'), 'without offering false hope');
  },

  'a save from a different version is refused rather than half-read'() {
    const world = seedDemoWorld({ seed: 1 });
    const blob = snapshot(world);
    for (const [version, word] of [[SAVE_VERSION + 1, 'a newer'], [SAVE_VERSION - 1, 'an older']]) {
      const result = restore({ ...blob, version });
      assert(!result.ok, 'v' + version + ' must be refused');
      assert(result.reason.includes(word), 'it says which way: ' + result.reason);
    }
  },

  'nonsense is refused without throwing'() {
    // Whatever is in the store, a bad read must be an answer. A save path that
    // throws on load takes the whole page with it, and the player loses a tower
    // AND the ability to start a new one.
    for (const junk of [null, undefined, 42, 'a string', [], {}, { schema: SAVE_SCHEMA }]) {
      const result = restore(junk);
      assert(result && result.ok === false, 'restore(' + JSON.stringify(junk) + ') did not refuse');
      assert(typeof result.reason === 'string' && result.reason.length > 10,
        'and it needs a sentence a player can act on');
    }
    const truncated = { schema: SAVE_SCHEMA, version: SAVE_VERSION, tower: {} };
    assert(restore(truncated).ok === false, 'a half-written save is refused');
  },

  'the summary is what a slot list needs, computed once'() {
    const world = seedDemoWorld({ seed: 1 });
    run(world, 2600 * 2);
    const s = summarise(world);
    assert(s.leasable > 0 && s.let >= 0 && s.let <= s.leasable, 'lease counts make sense: ' + JSON.stringify(s));
    assert(s.cash === world.ledger.cash, 'cash matches');
    assert(Number.isInteger(s.day), 'a day to show');
    assert(snapshot(world).summary.day === s.day, 'and the blob carries it so a list never parses a tower');
  },
};
