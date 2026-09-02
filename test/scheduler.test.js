/**
 * The tick loop. This file tests **order**, because order is what determinism
 * is made of — every assertion here is about which thing happened before which
 * other thing, not about what any of them did.
 *
 * Spec: `specs/TIME.md` § Top-Level Tick Order, § Entity Refresh Stride,
 * § RNG "Scheduler-level RNG order".
 */
import { STRIDE, createScheduler, strideIndices } from '../src/games/tower/sim/scheduler.js';
import { FAMILY, __resetIds, createTower, placeObject } from '../src/games/tower/sim/state.js';
import { TICKS_PER_DAY } from '../src/games/tower/sim/clock.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

/**
 * A tower with `n` offices, so the actor table has `n * 6` entries.
 *
 * `floors` may be given to control the ORDER offices are placed in. That
 * matters more than it looks: a fixture that places floors 1,2,3… in order
 * makes "raw table order" and "sorted by floor" identical, so an ordering test
 * built on it cannot tell them apart. It let a mutation through once already.
 */
function towerWith(offices, floors = null) {
  __resetIds();
  const tower = createTower();
  const order = floors ?? Array.from({ length: offices }, (_, i) => i + 1);
  for (const floor of order) {
    const placed = placeObject(tower, { family: FAMILY.office, floor, left: 0, right: 5 });
    assert(placed.ok, 'fixture placement failed on floor ' + floor + ': ' + placed.reason);
  }
  return tower;
}

/** A scheduler whose every hook appends its name to one shared log. */
function recordingScheduler(log, extra = {}) {
  return createScheduler({
    news: () => log.push('news'),
    vip: () => log.push('vip'),
    carriers: () => log.push('carriers'),
    families: { [FAMILY.office]: (_t, actor) => log.push('actor:' + actor.id) },
    ...extra,
  });
}

export const tests = {
  // --------------------------------------------------------------- stride

  'the stride visits one sixteenth of the table, starting at day_tick % 16'() {
    // specs/TIME.md § Entity Refresh Stride.
    assert(STRIDE === 16, 'the stride is 16');
    assert(JSON.stringify(strideIndices(0, 40)) === JSON.stringify([0, 16, 32]),
      'tick 0 should visit 0,16,32 — got ' + strideIndices(0, 40).join(','));
    assert(JSON.stringify(strideIndices(3, 40)) === JSON.stringify([3, 19, 35]),
      'tick 3 should visit 3,19,35 — got ' + strideIndices(3, 40).join(','));
    assert(JSON.stringify(strideIndices(17, 40)) === JSON.stringify([1, 17, 33]),
      'tick 17 should start at 1, not 17');
    assert(strideIndices(0, 0).length === 0, 'an empty table visits nothing');
  },

  'every actor is serviced exactly once per sixteen ticks, and no more'() {
    const tower = towerWith(5);            // 30 actors
    const log = [];
    const scheduler = recordingScheduler(log);

    for (let i = 0; i < STRIDE; i++) scheduler.tick(tower);

    const serviced = log.filter((e) => e.startsWith('actor:'));
    assert(serviced.length === tower.actors.length,
      'expected ' + tower.actors.length + ' services in 16 ticks, got ' + serviced.length);
    assert(new Set(serviced).size === serviced.length, 'some actor was serviced twice in one window');
  },

  /**
   * The rule that looks like an implementation detail and is not. Every RNG
   * draw a family handler makes happens in table order, so sorting the table
   * to be tidy would silently change every future outcome.
   */
  'the stride walks raw table order, not grouped by family or floor'() {
    // Twenty offices, so 120 actors: with a stride of 16 that services seven
    // or eight per tick, which is enough for an ordering claim to mean
    // something. Three offices would service exactly one and prove nothing.
    //
    // The floors are placed OUT of order on purpose. With 1,2,3… the table is
    // already sorted by floor, so a scheduler that sorted before sweeping
    // would look identical — which is exactly the mutation that survived the
    // first version of this test.
    const scrambled = [12, 3, 19, 7, 1, 15, 9, 20, 4, 17, 2, 11, 6, 18, 8, 13, 5, 16, 10, 14];
    const tower = towerWith(20, scrambled);
    const log = [];
    const scheduler = recordingScheduler(log);
    scheduler.tick(tower);

    const visited = strideIndices(tower.clock.dayTick, tower.actors.length);
    const ids = log.filter((e) => e.startsWith('actor:')).map((e) => Number(e.slice(6)));
    const expected = visited.map((i) => tower.actors[i].id);
    assert(JSON.stringify(ids) === JSON.stringify(expected),
      'visitation order was ' + ids.join(',') + ', expected ' + expected.join(','));
    assert(ids.length >= 5, 'the fixture serviced only ' + ids.length + ' actors — too few to prove ordering');

    // Negate it: the same actors sorted by floor must give a DIFFERENT
    // sequence, or the assertion above proves nothing about ordering.
    const byFloor = [...tower.actors].sort((a, b) => a.anchorFloor - b.anchorFloor);
    const ifSorted = visited.map((i) => byFloor[i].id);
    assert(JSON.stringify(ifSorted) !== JSON.stringify(expected),
      'raw order and floor order are the same in this fixture, so nothing is being tested');
  },

  // ---------------------------------------------------------------- order

  'news runs before vip, and both run before the checkpoint body'() {
    // specs/TIME.md § RNG: "news before VIP" is part of the replay contract
    // because both consume RNG.
    const tower = towerWith(0);
    tower.clock.dayTick = 999;             // > 240, daypart 2, so both hooks are eligible
    const log = [];
    const scheduler = recordingScheduler(log, { checkpoints: { 1000: () => log.push('checkpoint') } });

    scheduler.tick(tower);                 // -> tick 1000
    assert(log.indexOf('news') >= 0 && log.indexOf('vip') >= 0, 'a per-tick hook did not run');
    assert(log.indexOf('news') < log.indexOf('vip'), 'vip ran before news');
    assert(log.indexOf('vip') < log.indexOf('checkpoint'), 'the checkpoint body ran before the hooks');
  },

  /**
   * Checkpoints run BEFORE entity refresh, so actors serviced on a checkpoint
   * tick see state the checkpoint already changed. The start-of-day sweep at
   * tick 0 rewrites state bytes; actors visited on tick 0 must see the new
   * values, not yesterday's.
   */
  'the checkpoint body runs before the actors it affects'() {
    const tower = towerWith(2);
    tower.clock.dayTick = TICKS_PER_DAY - 1;   // next tick wraps to 0
    const log = [];
    const scheduler = createScheduler({
      checkpoints: { 0: (t) => { for (const a of t.actors) a.state = 0x20; log.push('checkpoint'); } },
      families: { [FAMILY.office]: (_t, actor) => log.push('actor-saw:' + actor.state.toString(16)) },
    });
    for (const a of tower.actors) a.state = 0x05;   // yesterday's value

    scheduler.tick(tower);
    assert(tower.clock.dayTick === 0, 'the fixture did not land on tick 0');
    assert(log[0] === 'checkpoint', 'the checkpoint did not run first');
    const saw = log.filter((e) => e.startsWith('actor-saw:'));
    assert(saw.length > 0, 'no actor was serviced on tick 0');
    assert(saw.every((e) => e === 'actor-saw:20'),
      'an actor saw a stale state byte: ' + saw.join(',') + ' — the checkpoint ran too late');
  },

  'carriers move last, after everyone who wanted a ride has asked'() {
    const tower = towerWith(2);
    const log = [];
    recordingScheduler(log).tick(tower);
    assert(log[log.length - 1] === 'carriers', 'carriers did not run last: ' + log.join(','));
  },

  'a checkpoint fires on the tick it names, and only that tick'() {
    const tower = towerWith(0);
    tower.clock.dayTick = 0;
    let fired = [];
    const scheduler = createScheduler({ checkpoints: { 2300: (t) => fired.push(t.clock.dayTick) } });

    scheduler.advance(tower, TICKS_PER_DAY * 2);
    assert(fired.length === 2, 'checkpoint 2300 fired ' + fired.length + ' times in two days');
    assert(fired.every((t) => t === 2300), 'checkpoint fired on ticks ' + fired.join(','));
  },

  'the per-tick hooks respect their daypart gates'() {
    // news while daypart < 6, vip while daypart < 4, both only past tick 240.
    const cases = [
      [100, false, false],    // <= 240: neither
      [500, true, true],      // daypart 1
      [1700, true, false],    // daypart 4: news only
      [2450, false, false],   // daypart 6: neither
    ];
    for (const [startTick, wantNews, wantVip] of cases) {
      const tower = towerWith(0);
      tower.clock.dayTick = startTick;
      const log = [];
      recordingScheduler(log).tick(tower);
      assert(log.includes('news') === wantNews,
        'at tick ' + (startTick + 1) + ' news ran=' + log.includes('news') + ', expected ' + wantNews);
      assert(log.includes('vip') === wantVip,
        'at tick ' + (startTick + 1) + ' vip ran=' + log.includes('vip') + ', expected ' + wantVip);
    }
  },

  'a paused tower stops its actors but still keeps time'() {
    // specs/TIME.md § Top-Level Tick Order step 7: "run the entity refresh
    // stride WHEN NOT PAUSED". The clock is not conditional.
    const tower = towerWith(3);
    tower.paused = true;
    const log = [];
    const before = tower.clock.dayTick;
    recordingScheduler(log).tick(tower);
    assert(tower.clock.dayTick !== before, 'a paused tower froze its clock');
    assert(!log.some((e) => e.startsWith('actor:')), 'a paused tower serviced actors');
  },

  'a day is 2600 ticks of this and the actor count stays put'() {
    const tower = towerWith(4);            // 24 actors
    const log = [];
    const scheduler = recordingScheduler(log);
    scheduler.advance(tower, TICKS_PER_DAY);

    const serviced = log.filter((e) => e.startsWith('actor:')).length;
    // 2600 ticks / 16 = 162.5 windows. Each actor is serviced once per window.
    const expected = strideCount(TICKS_PER_DAY, tower.actors.length);
    assert(serviced === expected, 'serviced ' + serviced + ' times in a day, expected ' + expected);
    assert(tower.actors.length === 24, 'the actor table changed size during a day');
  },
};

/** How many services a full run of `ticks` produces for `count` actors. */
function strideCount(ticks, count) {
  let total = 0;
  for (let t = 1; t <= ticks; t++) total += strideIndices(t % TICKS_PER_DAY, count).length;
  return total;
}
