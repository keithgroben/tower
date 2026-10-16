/**
 * The events (issue #16): the bomb and its ransom, the fire, the VIP's stay, buried treasure
 * and Santa.
 *
 * *"The events are rare, readable and tied to systems you already manage: security count,
 * elevator quality, suites. They test your build instead of adding random punishment."* So the
 * assertions that matter are the ones that move a result by changing the **tower**: a bomb is
 * found because an office stood close enough, a fire is out in 52 ticks instead of 950 because
 * the guards had a short climb, a VIP is pleased because the lifts took him up in 8 cars and not
 * in 4. Those run through the composition - `newTowerWorld`, `applyAction`, the driver's own
 * scheduler, the real router and carriers - and through the harness functions
 * `node harness/playtest.js --events` prints, so the numbers quoted in the PR are the numbers
 * asserted here. The geometry rules (which floor, which tiles, what is indestructible) run on
 * bare towers so each can be varied alone.
 *
 * Spec: `specs/EVENTS.md` (the whole file), `specs/TIME.md` § 240 / § Tick Order, `specs/GAME-STATE.md`
 * § Star Advancement, `specs/facility/HOTEL.md`; the original's help file, dialogs and string table
 * (`DIALOG_3000`-`3040`, `STRlist 32518/1010`). `spec/DEVIATIONS.md` A66-A72.
 */
import {
  BLAST_FLOORS_ABOVE, BLAST_FLOORS_BELOW, BLAST_TILES_LEFT, BLAST_TILES_RIGHT, BOMB_DEADLINE_TICK, BOMB_MIN_SPAN,
  BOMB_RANSOM, DECISION_TICKS, EVENT_TEXT, FIRE_END_TICK, FIRE_FLOOR_TICKS, FIRE_MIN_SPAN, FIRE_SEED_OFFSET,
  FIRE_SPREAD_TICKS, HELICOPTER_COST, INDESTRUCTIBLE_FAMILIES, RESUME_TICK, SECURITY_HEAD_START_TICKS, SANTA_END_TICK,
  SANTA_TICK, TREASURE_AMOUNTS, TREASURE_ODDS, VIP_ARRIVAL_TICK, VIP_BOOK_TICK, VIP_MIN_STARS, VIP_RETRY_DAYS,
  addScar, announceSanta, answerEvent, answerRefusal, bombCanComeAt, clearScars, destroyObject, eventIsRunning,
  eventsOf, eventsTick, floorBounds, isBombDay, isFireDay, isSantaDay, maybeFindTreasure, pendingDecision,
  pickEventFloor, runDailyEvents, santaFlight, scarsOnFloor, searchProgress, tryBookVip, tryStartBomb, tryStartFire,
  vipBlocker, vipCandidateSuites, vipVerdict,
} from '../src/games/tower/sim/events.js';
import { daypartOf } from '../src/games/tower/sim/clock.js';
import { makeRng } from '../src/games/tower/sim/rng.js';
import {
  FAMILY, __resetIds, createTower, placeObject, population,
} from '../src/games/tower/sim/state.js';
import { guardResponse, securityOffices } from '../src/games/tower/sim/security.js';
import { entertainmentPaysToday } from '../src/games/tower/sim/entertainment.js';
import { HOTEL_STATE, hotelGate } from '../src/games/tower/sim/hotel.js';
import { createSimTripRecord } from '../src/games/tower/sim/stress.js';
import { GATES_WITHOUT_A_WRITER, starGateStatus, starGatesOf } from '../src/games/tower/sim/progression.js';
import { applyAction, demolishRefusal } from '../src/games/tower/sim/actions.js';
import { ledgerFor } from '../src/games/tower/sim/ledger-adapter.js';
import { demandsOf, noticesAfter } from '../src/games/tower/sim/demands.js';
import { rebuildRouteTables } from '../src/games/tower/sim/routing.js';
import { SAVE_VERSION, restore, snapshot } from '../src/games/tower/sim/save.js';
import { eventDialogBlocking, eventDialogModel } from '../src/games/tower/ui/event-dialog.js';
import { eventsReadout, noticeToSay } from '../src/games/tower/ui/readout.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { makeDriver } from '../src/games/tower/ui/driver.js';
import {
  bombTrial, eventsTower, fireTrial, treasureTrial, vipTrial,
} from '../harness/playtest.js';

const assert = (c, m) => { if (!c) throw new Error(m); };
const same = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));

// ------------------------------------------------------------------------ fixtures

/** A bare tower on a given day and tick. No lifts, no lobby: the events' geometry and nothing else. */
function bare({ stars = 3, day = 59, tick = 240, seed = 1 } = {}) {
  __resetIds();
  const tower = createTower({ seed });
  tower.starCount = stars;
  tower.clock.dayCounter = day;
  tower.clock.dayTick = tick;
  tower.clock.daypart = daypartOf(tick);
  return tower;
}

function put(tower, family, floor, left, right) {
  const placed = placeObject(tower, { family, floor, left, right }, () => createSimTripRecord());
  assert(placed.ok, `fixture: ${family} on F${floor} ${left}..${right}: ${placed.reason}`);
  return placed.object;
}

/**
 * `floors` floors of three 6-wide offices a floor, tiles 0..45: every floor 46 tiles across, so
 * `right - left = 45`, wide enough for the fire's 32 and the bomb's 4.
 */
function building(tower, floors, from = 1) {
  const rooms = [];
  for (let floor = from; floor < from + floors; floor++) {
    for (const left of [0, 20, 40]) rooms.push(put(tower, FAMILY.office, floor, left, left + 5));
  }
  return rooms;
}

/** Advance the clock `n` ticks and run the events' per-tick hook, as the scheduler's step 6b does. */
function step(tower, n = 1) {
  for (let i = 0; i < n; i++) {
    tower.clock.dayTick += 1;
    tower.clock.daypart = daypartOf(tower.clock.dayTick);
    eventsTick(tower);
  }
}

/** Run until `done()` or `limit` ticks. Returns the ticks stepped. */
function stepUntil(tower, done, limit = 2600) {
  let n = 0;
  while (!done() && n < limit) { step(tower); n++; }
  return n;
}

/** Re-roll the generator until a start picks `floor`: the pick is the generator's, the floor is the test's. */
function startOn(tower, floor, start) {
  for (let seed = 1; seed <= 400; seed++) {
    tower.rng = makeRng(seed);
    if (start(tower)) {
      const e = tower.events;
      if ((e.bomb ?? e.fire).floor === floor) return seed;
      // wrong floor: undo and try the next stream
      e.bomb = null; e.fire = null; e.bombActive = false; e.fireActive = false; e.decision = null;
    }
  }
  throw new Error('no generator stream picks floor ' + floor);
}

const securityAt = (tower, floor, left = 100) => put(tower, FAMILY.security, floor, left, left + 15);

const dayLength = 2600;

/** Tick the real scheduler until `done()`; a stalled event is a failure with a message, not a hang. */
function tickUntil(scheduler, tower, done, what, limit = dayLength * 4) {
  for (let i = 0; i < limit; i++) {
    if (done()) return i;
    scheduler.tick(tower);
  }
  throw new Error('never reached: ' + what);
}

// ------------------------------------------------------------------------- the tests

export const tests = {
  // =============================================================== the calendar

  'the calendar: a bomb on day 59 of 60, a fire on day 83 of 84, the fire first when both fall on one day'() {
    assert(isBombDay(59) && isBombDay(119) && isBombDay(419) && !isBombDay(58) && !isBombDay(60) && !isBombDay(0), 'bomb days');
    assert(isFireDay(83) && isFireDay(167) && isFireDay(419) && !isFireDay(82) && !isFireDay(84) && !isFireDay(0), 'fire days');
    // Every day of a long game, in a building that qualifies: which ones start an event?
    const bombs = [], fires = [];
    for (let day = 0; day <= 440; day++) {
      const t = bare({ day });
      building(t, 6);
      const started = runDailyEvents(t);
      if (started.includes('bomb')) bombs.push(day);
      if (started.includes('fire')) fires.push(day);
    }
    same(bombs, [59, 119, 179, 239, 299, 359], 'bombs on day % 60 == 59');
    same(fires, [83, 167, 251, 335, 419], 'fires on day % 84 == 83');
    // 419 is both: the fire is checked first (TIME.md § 240) and suppresses the bomb.
    const both = bare({ day: 419 });
    building(both, 6);
    same(runDailyEvents(both), ['fire'], 'day 419 starts the fire, and only the fire');
    assert(both.events.fireActive && !both.events.bombActive && both.events.bomb === null, 'the bomb was suppressed');
  },

  'suppression: nothing starts while a bomb or a fire is already live'() {
    const t = bare({ day: 59 });
    building(t, 6);
    t.events.fireActive = true;
    assert(!tryStartBomb(t) && t.events.bomb === null, 'no bomb during a fire');
    t.events.fireActive = false; t.events.bombActive = true;
    t.clock.dayCounter = 83;
    assert(!tryStartFire(t) && t.events.fire === null, 'no fire during a bomb');
    assert(eventIsRunning(t), 'and the helper agrees');
  },

  // ===================================================================== the bomb

  'the ransom is $200,000 / $300,000 / $1,000,000 at 2 / 3 / 4 stars, and there is no bomb at 1, 5 or the Tower rank'() {
    same(BOMB_RANSOM, { 2: 200_000, 3: 300_000, 4: 1_000_000 }, 'the table');
    for (const [stars, ransom] of [[2, 200_000], [3, 300_000], [4, 1_000_000]]) {
      const t = bare({ stars });
      building(t, 6);
      assert(tryStartBomb(t), stars + ' stars: a bomb');
      assert(pendingDecision(t).kind === 'bomb' && pendingDecision(t).cost === ransom, stars + ' stars asks $' + ransom);
      assert(t.events.bomb.ransom === ransom && t.events.bombActive === true, 'and the flag is set');
    }
    for (const stars of [1, 5, 6]) {
      const t = bare({ stars });
      building(t, 6);
      assert(!bombCanComeAt(stars) && !tryStartBomb(t) && t.events.bomb === null && !t.events.bombActive, stars + ' stars: no bomb');
    }
  },

  'where it goes: never the lobby floors, never past the contiguous building, x in [left, right - 4]'() {
    const t = bare();
    // F1-F3 built, a gap at F4, F5-F6 built: the contiguous run from the first built floor ends at F3.
    building(t, 3, 1);
    building(t, 2, 5);
    const floors = new Set();
    for (let seed = 1; seed <= 300; seed++) { t.rng = makeRng(seed); floors.add(pickEventFloor(t)); }
    same([...floors].sort(), [1, 2, 3], 'only floors of the first contiguous run, from the lobby height up');
    t.lobbyHeight = 2;
    floors.clear();
    for (let seed = 1; seed <= 300; seed++) { t.rng = makeRng(seed); floors.add(pickEventFloor(t)); }
    same([...floors].sort(), [2, 3], 'a two-floor lobby starts the range at F2 (EVENTS.md: multi-floor lobby floors are excluded)');
    t.lobbyHeight = 1;

    // The x: uniform over [left, right - 4] - the extremes are reachable, nothing outside is.
    const xs = new Set();
    for (let seed = 1; seed <= 600; seed++) {
      const u = bare();
      building(u, 1);
      u.rng = makeRng(seed);
      assert(tryStartBomb(u), 'a bomb');
      xs.add(u.events.bomb.x);
    }
    assert(Math.min(...xs) === 0 && Math.max(...xs) === 45 - BOMB_MIN_SPAN, 'x spans [0, ' + (45 - BOMB_MIN_SPAN) + ']: ' + [Math.min(...xs), Math.max(...xs)]);
  },

  'the floor must be wide enough: a bomb needs right - left >= 4, a fire >= 32'() {
    const narrow = bare({ day: 59 });
    put(narrow, FAMILY.office, 1, 0, 3);               // right - left = 3
    assert(!tryStartBomb(narrow), 'a 4-tile floor is too narrow for a bomb');
    const ok = bare({ day: 59 });
    put(ok, FAMILY.office, 1, 0, 4);                   // right - left = 4
    assert(tryStartBomb(ok), 'right - left = 4 is enough');

    const small = bare({ day: 83 });
    put(small, FAMILY.office, 1, 0, 31);               // right - left = 31
    assert(!tryStartFire(small), 'a 32-tile floor is too narrow for a fire');
    const wide = bare({ day: 83 });
    put(wide, FAMILY.office, 1, 0, 32);                // right - left = 32
    assert(tryStartFire(wide), 'right - left = 32 is enough');
    assert(wide.events.fire.seed === 0, 'ignition at right - 32: ' + wide.events.fire.seed);
    assert(BOMB_MIN_SPAN === 4 && FIRE_MIN_SPAN === 32 && FIRE_SEED_OFFSET === 32, 'the constants');
  },

  'paying: the ransom leaves the cash once, the bomb is never heard of again, nothing explodes at 1 PM'() {
    const t = bare({ stars: 3 });
    const rooms = building(t, 6);
    t.cash = 5_000_000;
    assert(tryStartBomb(t), 'planted');
    const before = t.cash;
    const r = answerEvent(t, 'pay');
    assert(r.ok && r.cost === 300_000 && r.outcome === 'paid', 'paid: ' + JSON.stringify(r));
    assert(before - t.cash === 300_000, 'exactly the ransom: ' + (before - t.cash));
    assert(!t.events.bombActive && t.events.bomb === null && pendingDecision(t) === null, 'the event is over');
    stepUntil(t, () => t.clock.dayTick >= 1300, 2000);
    assert(rooms.every((o) => t.objects.has(o.id)), 'nothing was destroyed');
    assert(t.cash === before - 300_000, 'and nothing else was charged');
    assert(t.clock.dayTick === 1300, 'and the clock did NOT jump: ' + t.clock.dayTick);
    assert(demandsOf(t).notices.some((n) => n.text === 'You paid the terrorists $300,000. The bomb threat is over.'), 'it said so');
  },

  'a ransom you cannot afford is refused in words, and the question stays open until it defaults'() {
    const t = bare({ stars: 4 });
    building(t, 6);
    t.cash = 999_999;
    tryStartBomb(t);
    const r = answerEvent(t, 'pay');
    assert(!r.ok && r.reason === 'that costs $1,000,000 and you have $999,999', r.reason);
    assert(t.cash === 999_999 && pendingDecision(t) !== null && t.events.bomb.phase === 'prompt', 'nothing moved');
    assert(answerRefusal(t, 'search') === null, 'searching is always allowed');
  },

  'unanswered, the bomb question is answered "search" two ticks later - and a person is never made to rush it'() {
    const t = bare();
    building(t, 6);
    tryStartBomb(t);
    step(t, DECISION_TICKS - 1);
    assert(pendingDecision(t) !== null && t.events.bomb.phase === 'prompt', 'still open after ' + (DECISION_TICKS - 1) + ' tick');
    step(t, 1);
    assert(pendingDecision(t) === null && t.events.bomb.phase === 'armed', 'answered by default on the second');
    assert(t.events.history.some((h) => h.kind === 'bomb' && h.outcome === 'search' && h.byDefault === true), 'and recorded as a default');
    assert(DECISION_TICKS === 2, 'EVENTS.md: two ticks');
    // The browser holds the clock while the dialog is open (ui/event-dialog.js), so this default is
    // for headless runs; `eventDialogBlocking` is what main.js asks.
    const u = bare();
    building(u, 6);
    tryStartBomb(u);
    assert(eventDialogBlocking(u) === true, 'blocking while open');
    answerEvent(u, 'search');
    assert(eventDialogBlocking(u) === false, 'not once answered');
  },

  'the search: one office at B1 finds it; the time is the stairs plus the sweep, and a nearer office is sooner'() {
    const results = {};
    for (const officeFloor of [-1, -9]) {
      const t = bare();
      building(t, 6);
      const office = securityAt(t, officeFloor);
      t.cash = 5_000_000;
      tryStartBomb(t);
      answerEvent(t, 'search');
      const bomb = t.events.bomb;
      const armed = bomb.armedTick;
      const travel = guardResponse(t, bomb.floor).offices[0].ticks;
      assert(travel === (bomb.floor - officeFloor) * 8, 'the emergency stairs: 8 ticks a floor: ' + travel);
      const needed = bomb.scanFrom - bomb.x + 1;
      stepUntil(t, () => t.events.bomb.phase !== 'armed', 1200);
      assert(bomb.phase === 'found', 'found, not exploded (' + bomb.phase + ')');
      // Scanning starts the tick the team has arrived and covers a tile a tick.
      assert(bomb.foundTick === armed + travel + needed - 1, `found at armed ${armed} + stairs ${travel} + sweep ${needed} - 1 = ${armed + travel + needed - 1}, got ${bomb.foundTick}`);
      assert(bomb.foundTick < BOMB_DEADLINE_TICK, 'before the deadline');
      results[officeFloor] = { travel, found: bomb.foundTick - armed, bomb, office };
    }
    // Same bomb? The generator streams differ only if the geometry did; it did not.
    assert(results[-9].found - results[-1].found === 8 * 8, 'eight floors further down is 64 ticks later: ' + (results[-9].found - results[-1].found));
  },

  'more offices find it sooner: each team that has arrived covers a tile a tick'() {
    const run = (floors) => {
      const t = bare();
      building(t, 6);
      floors.forEach((f, i) => securityAt(t, f, 60 + i * 20));
      tryStartBomb(t);
      answerEvent(t, 'search');
      const bomb = t.events.bomb;
      stepUntil(t, () => t.events.bomb.phase !== 'armed', 1200);
      return bomb.foundTick - bomb.armedTick;
    };
    const one = run([-1]);
    const two = run([-1, -1]);
    const three = run([-1, -1, -1]);
    assert(two < one && three < two, `one ${one}, two ${two}, three ${three} ticks: every office helps`);
    // searchProgress is the pure half: the teams that have arrived by now, and what is left to cover.
    const t = bare();
    building(t, 6);
    securityAt(t, -1);
    tryStartBomb(t);
    answerEvent(t, 'search');
    const p0 = searchProgress(t, t.events.bomb);
    assert(p0.teams === 1 && p0.arrived === 0 && p0.scanned === 0 && p0.needed === t.events.bomb.scanFrom - t.events.bomb.x + 1,
      'before the climb is done nobody has arrived: ' + JSON.stringify(p0));
  },

  'found: "Good work!", the flag clears two ticks later, the clock jumps to 1500, nothing is lost'() {
    const t = bare();
    const rooms = building(t, 6);
    securityAt(t, -1);
    tryStartBomb(t);
    answerEvent(t, 'search');
    const bomb = t.events.bomb;
    stepUntil(t, () => bomb.phase === 'found', 1200);
    assert(t.events.bombActive === true, 'still active while it is being diffused');
    step(t, DECISION_TICKS - 1);
    assert(t.events.bombActive === true, 'one tick before the cleanup it is still active');
    const foundAt = bomb.foundTick;
    step(t, 1);
    assert(t.events.bombActive === false && t.events.bomb === null, 'cleaned up');
    assert(RESUME_TICK === 1500 && t.clock.dayTick === 1500 && t.clock.daypart === 3, 'the clock jumped to 1500: ' + t.clock.dayTick);
    assert(foundAt < RESUME_TICK, 'from earlier in the day');
    assert(rooms.every((o) => t.objects.has(o.id)), 'no room was destroyed');
    const texts = demandsOf(t).notices.map((n) => n.text);
    assert(texts.includes(EVENT_TEXT.bombDefused()) && texts.includes(EVENT_TEXT.bombFound(bomb.floor)), 'both of the original\'s lines');
    assert(EVENT_TEXT.bombDefused() === 'Because you have enough Security Offices in your tower, Security Forces found the bomb.  Good work!', 'verbatim');
  },

  'EXPLODED: with no security office it goes off at 1 PM, taking exactly the 40 x 6 rectangle that can burn'() {
    const t = bare({ stars: 3 });
    // 12 floors, so the blast (F bomb-2 .. F bomb+3) can be centred and checked on both sides.
    const rooms = building(t, 12);
    // Things that cannot burn: housekeeping and a lobby-family object, on the bomb's floors, inside the blast.
    tryStartBomb(t);
    const bomb = t.events.bomb;
    bomb.floor = 6; bomb.x = 22;                      // pin the generator's choice: the geometry is the test
    const survivor = put(t, FAMILY.housekeeping, 6, 7, 18);
    const lobby = put(t, FAMILY.lobby, 5, 26, 34);
    answerEvent(t, 'search');
    t.cash = 1_000_000;
    const ledger = ledgerFor(t);
    ledger.population.office = 6 * rooms.length;
    for (const o of rooms) o.unitStatus = 0;           // every office let, so the ledger must move
    stepUntil(t, () => t.clock.dayTick >= BOMB_DEADLINE_TICK - 1, 2000);
    assert(t.events.bomb.phase === 'armed' && rooms.every((o) => t.objects.has(o.id)), 'nothing before one o\'clock');
    step(t);
    assert(t.clock.dayTick === BOMB_DEADLINE_TICK && t.events.bomb.phase === 'exploded', 'it goes off ON the deadline, 1 PM: ' + t.events.bomb.phase);
    const left = bomb.x - BLAST_TILES_LEFT, right = bomb.x + BLAST_TILES_RIGHT;
    assert(right - left + 1 === 40 && BLAST_FLOORS_BELOW + BLAST_FLOORS_ABOVE + 1 === 6, 'forty tiles, six floors');
    for (const o of rooms) {
      const inside = o.floor >= bomb.floor - 2 && o.floor <= bomb.floor + 3 && o.left <= right && o.right >= left;
      assert(t.objects.has(o.id) === !inside, `an office on F${o.floor} ${o.left}-${o.right} ${inside ? 'was in the blast and survived' : 'was outside it and was destroyed'}`);
    }
    assert(t.objects.has(survivor.id) && t.objects.has(lobby.id), 'housekeeping and a lobby cannot be destroyed');
    const gone = rooms.filter((o) => !t.objects.has(o.id));
    assert(gone.length > 0, 'something burned');
    assert(ledger.population.office === 6 * (rooms.length - gone.length), 'the people came off the ledger: ' + ledger.population.office);
    assert(t.actors.every((a) => !gone.some((o) => o.id === a.objectId)), 'and their actors are gone');
    assert(scarsOnFloor(t, 6).length > 0 && t.events.blast.floor === 6 && t.events.blast.x === 22, 'the scar and the blast are on record');
    assert(demandsOf(t).notices.some((n) => n.text === 'Security was not able to find the bomb in time.  The bomb has exploded on floor 6!'), 'the original\'s line');
    step(t, DECISION_TICKS);
    assert(!t.events.bombActive && t.clock.dayTick === RESUME_TICK, 'two ticks later the flag is clear and the clock is at 1500');
  },

  'an office that is too far still finds it: the stairs cost 8 a floor and the longest climb is 952 ticks - the model\'s own limit, stated'() {
    // (B10 to F109 is 119 floors = 952 ticks; the search has 960 between 240 and 1200 and a sweep of a
    // few tiles: the bomb is effectively always found by ANY reachable office. spec/DEVIATIONS.md A69.)
    const t = bare();
    for (let floor = 1; floor <= 109; floor++) put(t, FAMILY.office, floor, 0, 5 + (floor === 109 ? 0 : 0));
    securityAt(t, -10);
    t.rng = makeRng(1);
    // Force the worst case: a bomb on the top floor, at the left edge, 8 tiles to sweep.
    t.events.bombActive = true;
    t.events.bomb = { floor: 109, x: 0, ransom: 300_000, phase: 'armed', armedTick: 242, scanFrom: 3, scanned: 0, resolveAt: null };
    t.clock.dayTick = 242;
    stepUntil(t, () => t.events.bomb.phase !== 'armed', 1200);
    assert(t.events.bomb.phase === 'found' || t.events.bomb.phase === 'exploded', 'it resolved');
    const worst = guardResponse(t, 109).offices[0].ticks;
    assert(worst === 952, 'the longest climb in the tower: ' + worst);
  },

  'bomb and fire days suspend entertainment pay for as long as the event is live, and for the calendar day'() {
    const env = eventsTower({ floors: 6, security: [-1] });
    const { tower, scheduler, world } = env;
    tower.clock.dayCounter = 59; tower.clock.dayTick = 0;
    let liveTicks = 0, unpaidWhileLive = true;
    for (let i = 0; i < dayLength; i++) {
      scheduler.tick(tower);
      if (tower.events.decision) applyAction(world, { type: 'answer_event', answer: 'search' });
      if (tower.events.bombActive) { liveTicks++; if (entertainmentPaysToday(tower)) unpaidWhileLive = false; }
    }
    assert(liveTicks >= 20 && unpaidWhileLive, 'while the bomb was live (' + liveTicks + ' ticks) entertainment paid nothing');
    tower.clock.dayCounter = 59;
    assert(!tower.events.bombActive && entertainmentPaysToday(tower) === false, 'and the calendar day still pays nothing after it');
    tower.clock.dayCounter = 60;
    assert(entertainmentPaysToday(tower) === true, 'the day after pays again');
  },

  // ===================================================================== the fire

  'the fire needs more than two stars, no cathedral, and a wide floor - in the morning'() {
    for (const stars of [1, 2]) {
      const t = bare({ stars, day: 83 });
      building(t, 6);
      assert(!tryStartFire(t) && t.events.fire === null, stars + ' stars: no fire');
    }
    const cathedral = bare({ stars: 3, day: 83 });
    building(cathedral, 6);
    starGatesOf(cathedral).cathedralPlaced = true;
    assert(!tryStartFire(cathedral), 'no fire while a cathedral evaluation is on');
    const late = bare({ stars: 3, day: 83, tick: 1700 });
    building(late, 6);
    assert(!tryStartFire(late), 'and none after the morning period (daypart >= 4)');
    const ok = bare({ stars: 3, day: 83 });
    building(ok, 6);
    assert(tryStartFire(ok) && ok.events.fireActive, '3 stars, morning, wide: a fire');
  },

  'the original\'s dialogs: SECOM senses a fire when there is a security office, a fire is merely reported when there is not'() {
    const guarded = bare({ day: 83 });
    building(guarded, 4);
    securityAt(guarded, -1);
    tryStartFire(guarded);
    const f = guarded.events.fire.floor;
    assert(demandsOf(guarded).notices.at(-1).text === `SECOM has sensed a fire on floor ${f}!\nEveryone should take emergency refuge!`, demandsOf(guarded).notices.at(-1).text);
    const bare_ = bare({ day: 83 });
    building(bare_, 4);
    tryStartFire(bare_);
    assert(demandsOf(bare_).notices.at(-1).text === `A fire has been reported on floor ${bare_.events.fire.floor}!\nEveryone should take emergency refuge!`, 'reported');
    assert(EVENT_TEXT.fireCrew(500_000) === 'Would you like to call an emergency fire crew?\nIt will cost $500,000.', 'the crew question');
    assert(EVENT_TEXT.fireStopped() === 'The fire was stopped.\nBecause your building has emergency stairs, no one was injured, but the tower is damaged.', 'the ending');
    assert(EVENT_TEXT.fireSecurity() === 'Security is attempting to quench the fire.\n\nEveryone is taking emergency refuge.', 'the guards');
  },

  'the spread: a tile every 7 ticks, up a floor every 80, from the seed at right - 32 - and a SECOM tower gets 80 quiet ticks'() {
    assert(FIRE_SPREAD_TICKS === 7 && FIRE_FLOOR_TICKS === 80 && SECURITY_HEAD_START_TICKS === 80, 'the tuning block 7 / 80 / 80');
    const t = bare({ day: 83 });
    building(t, 30);
    startOn(t, 1, tryStartFire);
    t.cash = 10_000_000;
    answerEvent(t, 'decline');
    const fire = t.events.fire;
    assert(fire.seed === 45 - 32 && fire.hold === 0 && fire.fronts.left === 13 && fire.fronts.right === 13, 'seeded at right - 32 = 13 with no head start: ' + JSON.stringify(fire));
    // Left front: moves one tile on each tick where dayTick % 7 == 0.
    const lefts = [];
    for (let i = 0; i < 70; i++) { step(t); lefts.push([t.clock.dayTick, fire.fronts.left]); }
    const moved = lefts.filter(([, v], i) => i > 0 && v !== lefts[i - 1][1]).map(([tick]) => tick);
    assert(moved.length >= 9 && moved.every((tick) => tick % 7 === 0) && moved.slice(1).every((tick, i) => tick - moved[i] === 7),
      'the left front steps every 7th tick, 7 apart: ' + moved);
    // And the fire climbs one floor per 80 ticks of spread, upward only.
    const floorsAt = [];
    let lastFloor = fire.current;
    for (let i = 0; i < 400; i++) {
      step(t);
      if (fire.current !== lastFloor) { floorsAt.push([fire.age, fire.current]); lastFloor = fire.current; }
    }
    same(floorsAt.map(([age]) => age), [80, 160, 240, 320, 400].slice(0, floorsAt.length), 'a floor at every 80th tick of spread');
    same(floorsAt.map(([, floor]) => floor), [2, 3, 4, 5, 6].slice(0, floorsAt.length), 'one floor up each time, never down');

    const guarded = bare({ day: 83 });
    building(guarded, 6);
    securityAt(guarded, -1);
    startOn(guarded, 3, tryStartFire);
    assert(guarded.events.fire.hold === 80, 'a tower with a security office gets the 80-tick head start');
  },

  'WITHOUT security the fire burns upward until it runs out of building: floors burn 4 of 10, 40 offices'() {
    const r = fireTrial({ answer: 'decline', security: [] });
    assert(r.outcome === 'out' && r.floorBurned === 7 && r.floorsBurned === 4 && r.destroyed === 40,
      'F7, F8, F9, F10 burn and the next floor does not exist: ' + JSON.stringify({ o: r.outcome, f: r.floorBurned, n: r.floorsBurned, d: r.destroyed }));
    assert(r.ticks === 950, 'it ran 950 ticks, from 240 to 1190: ' + r.ticks);
    same(r.jumps, [{ from: 1189, to: RESUME_TICK }], 'and it ended on tick 1190, before 1500, so the clock jumped to it');
  },

  'a fire never runs past tick 2000: a tall tower and nobody to fight it'() {
    const t = bare({ day: 83 });
    building(t, 40);
    startOn(t, 1, tryStartFire);
    answerEvent(t, 'decline');
    stepUntil(t, () => !t.events.fireActive, 2600);
    assert(t.clock.dayTick === FIRE_END_TICK, 'finalised on tick 2000: ' + t.clock.dayTick);
    const out = t.events.history.find((h) => h.kind === 'fire' && h.outcome === 'out');
    assert(out.floorsBurned === 23, 'one floor per 80 ticks from tick 240: 23 floors burned, got ' + out.floorsBurned);
    assert(t.clock.dayTick > RESUME_TICK, 'after 1500 there is nothing to jump over');
    assert(FIRE_END_TICK === 2000, 'EVENTS.md: day_tick == 2000');
  },

  'WITH security the guards climb the OUTSIDE stairs: 52 ticks beside the lobby, 145 from ten floors down - and that distance is the damage'() {
    const near = fireTrial({ answer: 'decline', security: [-1] });
    const far = fireTrial({ answer: 'decline', security: [-10] });
    const none = fireTrial({ answer: 'decline', security: [] });
    assert(near.outcome === 'out' && near.ticks === 52 && near.destroyed === 0 && near.floorsBurned === 1,
      'B1, fire on F1: out in 52 ticks, nothing lost: ' + JSON.stringify({ t: near.ticks, d: near.destroyed }));
    assert(far.outcome === 'out' && far.ticks === 145 && far.destroyed === 4,
      'B10, the same fire: 145 ticks, 4 offices: ' + JSON.stringify({ t: far.ticks, d: far.destroyed }));
    assert(far.ticks > near.ticks && far.destroyed > near.destroyed, 'closer is better');
    assert(none.destroyed === 40 && none.destroyed > far.destroyed, 'and nobody is much worse: ' + none.destroyed);
    assert(near.jumps.length === 1 && near.jumps[0].to === RESUME_TICK && far.jumps[0].to === RESUME_TICK,
      'both ended before 1500, and the clock jumped to it');
  },

  'the guards never use a lift: they walk the building\'s edge, a tile a tick, climbing 8 ticks a floor, and follow the fire up'() {
    const t = bare({ day: 83 });
    building(t, 20);
    securityAt(t, -3);
    startOn(t, 10, tryStartFire);
    // Lifts, stairs and route tables throw if touched: the guards' movement is the events' own.
    const trap = { get() { throw new Error('a guard asked the routing tables'); } };
    Object.defineProperty(t, 'routeTables', trap);
    Object.defineProperty(t, 'segments', trap);
    const fire = t.events.fire;
    const [guard] = fire.guards;
    assert(guard.status === 'climb' && guard.travel === (10 + 3) * 8, 'thirteen floors of stairs: ' + guard.travel);
    stepUntil(t, () => guard.status !== 'climb', 400);
    assert(t.clock.dayTick === 240 + 13 * 8, 'it arrives after exactly 104 ticks: ' + t.clock.dayTick);
    assert(guard.column === 45 + 12 - 1 || guard.column <= 45 + 11, 'and appears at the building\'s right edge: ' + guard.column);
  },

  'the helicopter: $500,000, out within 25 ticks, almost nothing lost - and refused if you cannot pay'() {
    const poor = bare({ day: 83 });
    building(poor, 8);
    poor.cash = 499_999;
    startOn(poor, 3, tryStartFire);
    const refused = answerEvent(poor, 'helicopter');
    assert(!refused.ok && refused.reason === 'that costs $500,000 and you have $499,999' && poor.cash === 499_999, refused.reason);

    const t = bare({ day: 83 });
    const rooms = building(t, 8);
    t.cash = 2_000_000;
    startOn(t, 3, tryStartFire);
    const r = answerEvent(t, 'helicopter');
    assert(r.ok && r.cost === HELICOPTER_COST && t.cash === 1_500_000, 'charged $500,000: ' + t.cash);
    stepUntil(t, () => !t.events.fireActive, 400);
    const out = t.events.history.find((h) => h.kind === 'fire' && h.outcome === 'out');
    assert(out.helicopter === true && out.ticks <= 25, 'out in ' + out.ticks + ' ticks');
    assert(rooms.filter((o) => !t.objects.has(o.id)).length === out.destroyed && out.destroyed <= 2, 'at most two offices: ' + out.destroyed);

    const unanswered = bare({ day: 83 });
    building(unanswered, 8);
    startOn(unanswered, 3, tryStartFire);
    step(unanswered, DECISION_TICKS);
    assert(pendingDecision(unanswered) === null && unanswered.events.history.some((h) => h.outcome === 'decline' && h.byDefault), 'unanswered means no helicopter');
    assert(unanswered.cash === createTower({ seed: 1 }).cash, 'and nothing was charged');
  },

  'what burns: everything but security, housekeeping, parking, the metro and a lobby - and the people go off the ledgers'() {
    for (const family of INDESTRUCTIBLE_FAMILIES) assert(typeof family === 'number', 'a family code');
    for (const name of ['lobby', 'security', 'housekeeping', 'parkingSpace', 'parkingRamp', 'metro']) {
      assert(INDESTRUCTIBLE_FAMILIES.has(FAMILY[name]), name + ' is indestructible');
    }
    const t = bare();
    const office = put(t, FAMILY.office, 3, 0, 5);
    const condo = put(t, FAMILY.condo, 3, 10, 25);
    const suite = put(t, FAMILY.hotelSuite, 3, 30, 39);
    const guard = put(t, FAMILY.security, 3, 40, 55);
    const ledger = ledgerFor(t);
    office.unitStatus = 0;                                   // let
    condo.unitStatus = 0;                                    // sold
    suite.unitStatus = 0;                                    // a guest in the bed
    ledger.population.office = 6; ledger.population.condo = 3; ledger.population.hotelSuite = 2;
    t.cash = 1_000_000;
    ledger.income.condo = 150_000;
    assert(!destroyObject(t, guard) && t.objects.has(guard.id), 'security cannot burn');
    assert(destroyObject(t, office) && !t.objects.has(office.id), 'an office burns');
    assert(ledger.population.office === 0, 'and its six leave the ledger');
    assert(t.actors.every((a) => a.objectId !== office.id), 'and its workers leave the tower');
    assert(destroyObject(t, condo) && ledger.population.condo === 0, 'a condo burns and its three leave');
    assert(t.cash < 1_000_000, 'and a SOLD condo is REFUNDED, the reference\'s one teardown refund: ' + t.cash);
    assert(destroyObject(t, suite) && ledger.population.hotelSuite === 0, 'a booked suite takes its guests off the ledger');
    assert(scarsOnFloor(t, 3).length === 3, 'each left a scar: ' + scarsOnFloor(t, 3).length);
    assert(population(t) === 0, 'nobody lives here now');
  },

  'building over a scar clears it, and a scar draws only where something burned'() {
    const t = bare();
    addScar(t, 4, 10, 30, 'fire');
    addScar(t, 5, 0, 5, 'blast');
    assert(scarsOnFloor(t, 4).length === 1 && scarsOnFloor(t, 5).length === 1, 'two scars');
    clearScars(t, 4, 28, 40);
    assert(scarsOnFloor(t, 4).length === 0 && scarsOnFloor(t, 5).length === 1, 'an overlapping build clears exactly that floor\'s scar');
    // Through the seam: a real build on a scarred floor.
    const w = newTowerWorld({ seed: 1, cash: 9_000_000 });
    addScar(w.tower, 2, 20, 40, 'fire');
    const built = applyAction(w, { type: 'build', what: 'office', floor: 2, left: 20 });
    assert(built.ok && scarsOnFloor(w.tower, 2).length === 0, 'the seam clears it: ' + JSON.stringify(scarsOnFloor(w.tower, 2)));
  },

  // =================================================================== the answers

  'answer_event: what it takes, what it refuses, and the dialog says the same - for every state and every answer'() {
    const open = (kind, cash) => {
      const w = newTowerWorld({ seed: 1, cash: Math.max(cash, 1) });
      w.tower.starCount = 3;
      w.tower.cash = cash;
      w.tower.clock.dayTick = 240; w.tower.clock.daypart = 0;       // the morning check
      building(w.tower, 6);
      if (kind === 'bomb') tryStartBomb(w.tower); else { w.tower.clock.dayCounter = 83; tryStartFire(w.tower); }
      return w;
    };
    // Nothing to answer.
    const calm = newTowerWorld({ seed: 1 });
    assert(!applyAction(calm, { type: 'answer_event', answer: 'pay' }).ok, 'nothing open');
    assert(applyAction(calm, { type: 'answer_event', answer: 'pay' }).reason === 'there is nothing to answer', 'in words');
    assert(eventDialogModel(calm) === null, 'and no dialog');

    for (const kind of ['bomb', 'fire']) {
      for (const cash of [100_000, 400_000, 600_000, 1_500_000]) {
        const model = eventDialogModel(open(kind, cash));
        assert(model && model.kind === kind, kind + ': a dialog');
        for (const answer of ['pay', 'search', 'helicopter', 'decline', 'nonsense']) {
          const world = open(kind, cash);
          const refusal = answerRefusal(world.tower, answer);
          const result = applyAction(world, { type: 'answer_event', answer });
          const button = model.buttons.find((b) => b.answer === answer);
          // The seam and the refusal function agree, in the same words...
          assert(result.ok === (refusal === null) && (result.ok || result.reason === refusal),
            `${kind} $${cash} "${answer}": seam said ${JSON.stringify(result)}, refusal said ${refusal}`);
          // ...and a button is live exactly when the seam would take it.
          if (button) assert(button.enabled === result.ok && (button.enabled || button.reason === result.reason),
            `${kind} $${cash} "${answer}": the button says ${button.enabled}, the seam ${result.ok}`);
          else assert(!result.ok, `${kind} "${answer}" has no button, so the seam must refuse it`);
        }
      }
    }
  },

  'the dialogs say what the original says'() {
    const w = newTowerWorld({ seed: 1, cash: 9_000_000 });
    w.tower.starCount = 3;
    building(w.tower, 6);
    tryStartBomb(w.tower);
    const bomb = eventDialogModel(w);
    assert(bomb.title === 'Blackmail from Terrorists!', bomb.title);
    assert(bomb.body[0] === 'They demand $300,000 or a hidden bomb will explode at 1 PM.', bomb.body[0]);
    same(bomb.buttons.map((b) => b.label), ['Find the Bomb', 'Pay Them $300,000'], 'the original\'s two buttons, in its order');
    answerEvent(w.tower, 'pay');
    const f = newTowerWorld({ seed: 1, cash: 9_000_000 });
    f.tower.starCount = 3;
    f.tower.clock.dayCounter = 83; f.tower.clock.dayTick = 240; f.tower.clock.daypart = 0;
    building(f.tower, 6);
    securityAt(f.tower, -1);
    tryStartFire(f.tower);
    const fire = eventDialogModel(f);
    assert(fire.title === `SECOM has sensed a fire on floor ${f.tower.events.fire.floor}!`, fire.title);
    same(fire.body, ['Everyone should take emergency refuge!', 'Would you like to call an emergency fire crew?', 'It will cost $500,000.'], 'the body');
    same(fire.buttons.map((b) => b.label), ['Yes $500,000', 'No'], 'yes / no');
  },

  // ===================================================================== the VIP

  'who may be booked: three stars, a clean open suite on a floor, nobody approved yet, once a quarter'() {
    const t = bare({ stars: 3, day: 5, tick: VIP_BOOK_TICK });
    const suite = put(t, FAMILY.hotelSuite, 4, 0, 9);
    suite.occupiedFlag = true;
    assert(vipBlocker(t) === null && vipCandidateSuites(t).length === 1, 'a clean open suite at 3 stars: bookable');
    const blockers = [];
    t.starCount = 2; blockers.push(['2 stars', vipBlocker(t)]); t.starCount = 3;
    suite.occupiedFlag = false; blockers.push(['a closed suite', vipBlocker(t)]); suite.occupiedFlag = true;
    suite.unitStatus = 0; blockers.push(['a booked suite', vipBlocker(t)]);
    suite.unitStatus = 0x28; blockers.push(['a dirty suite', vipBlocker(t)]);
    suite.unitStatus = 0x38; blockers.push(['an infested suite', vipBlocker(t)]); suite.unitStatus = 0x18;
    starGatesOf(t).vipStayFavorable = true; blockers.push(['already approved', vipBlocker(t)]); starGatesOf(t).vipStayFavorable = false;
    t.events.fireActive = true; blockers.push(['a fire', vipBlocker(t)]); t.events.fireActive = false;
    eventsOf(t).lastVip = { endDay: 4, comfortable: false };
    blockers.push(['a failed visit yesterday', vipBlocker(t)]);
    t.clock.dayCounter = 4 + VIP_RETRY_DAYS;
    assert(vipBlocker(t) === null, 'three days after a failed visit he may call again');
    for (const [what, why] of blockers) assert(typeof why === 'string' && why.length > 8, what + ' blocks it, and says why: ' + why);
    assert(VIP_MIN_STARS === 3 && VIP_RETRY_DAYS === 3, 'the constants');
  },

  'the booking: one o\'clock, a named floor, the suite held - and a held suite takes nobody else'() {
    const t = bare({ stars: 3, day: 5, tick: VIP_BOOK_TICK - 1 });
    const suites = [put(t, FAMILY.hotelSuite, 4, 0, 9), put(t, FAMILY.hotelSuite, 6, 0, 9)];
    suites.forEach((s) => { s.occupiedFlag = true; });
    eventsTick(t);
    assert(!t.events.vip, 'not at 1199');
    step(t);
    assert(VIP_BOOK_TICK === 1200 && VIP_ARRIVAL_TICK === 1600, 'one o clock books, five o clock arrives (A66)');
    assert(t.clock.dayTick === 1200 && t.events.vip?.phase === 'booked', 'booked at 1200');
    const floor = t.events.vip.floor;
    assert([4, 6].includes(floor), 'on one of the suites\' floors: ' + floor);
    assert(demandsOf(t).notices.at(-1).text === `A VIP has made reservations for the Hotel Suite on floor ${floor}.`, demandsOf(t).notices.at(-1).text);
    const held = suites.find((s) => s.floor === floor);
    assert(held.vipHold === true && suites.filter((s) => s.vipHold).length === 1, 'exactly the booked suite is held');
    // The room's own guest, at the lobby in the evening, is told to wait while the hold is on.
    const guest = { state: HOTEL_STATE.seeking };
    const clock = { daypart: 5, dayTick: 2100 };
    assert(hotelGate(guest, held, clock, t.rng) === 'hold', 'a held suite takes no regular guest');
    held.vipHold = false;
    assert(hotelGate(guest, held, clock, t.rng) === 'dispatch', 'and takes one the moment it is released');
    held.vipHold = true;
    // The booking is once: a second pass the same afternoon books nobody.
    assert(!tryBookVip(t), 'one visitor at a time');
  },

  'the verdict is the facility evaluation: stress plus 60 for noise, poor is 150 (200 from four stars), an infested suite is never comfortable'() {
    const t = bare({ stars: 3 });
    const suite = put(t, FAMILY.hotelSuite, 4, 0, 9);
    const vip = (stress, trips = 2) => ({ tripCount: trips, accumulatedElapsed: stress * trips });
    const at = (stress) => vipVerdict(t, vip(stress), suite);
    assert(at(79).comfortable && at(79).level === 2, '79 is good');
    assert(at(149).comfortable && at(149).level === 1, '149 is average and pleases him');
    assert(!at(150).comfortable && at(150).level === 0, '150 is poor at three stars');
    t.starCount = 4;
    assert(at(150).comfortable && at(199).comfortable && !at(200).comfortable, 'poor starts at 200 from four stars');
    t.starCount = 3;
    // An office on the suite's floor within 20 tiles is a noise source: +60.
    put(t, FAMILY.office, 4, 12, 17);
    assert(at(80).noise === true && at(80).score === 140 && at(80).comfortable, '80 + 60 = 140: still average');
    assert(!at(100).comfortable && at(100).score === 160, '100 + 60 = 160: poor');
    suite.unitStatus = 0x38;
    assert(!at(0).comfortable && at(0).infested, 'an infested suite is never comfortable, however calm the lifts');
    suite.unitStatus = 0x18;
    // No trips scores 0 - the best - and must not be read as a perfect stay by anything that times out.
    assert(vipVerdict(t, vip(0, 0), suite).stress === 0, 'a visitor with no counted trips scores 0 (the sentinel the timeouts guard against)');
  },

  'the stay, end to end: good lifts, a favorable verdict, the gate opens, the suite is released, nobody comes again'() {
    const r = vipTrial({ lift: 'good', days: 12 });
    const visit = r.visits[0];
    assert(r.visits.length === 1 && visit.outcome === 'comfortable', 'one visit, pleased: ' + JSON.stringify(r.visits.map((v) => v.outcome)));
    assert(visit.stress < 80 && visit.level === 2 && visit.trips === 2 && visit.infested === false, 'two real trips, calm: ' + JSON.stringify(visit));
    assert(r.favorable && r.gateDay === 2, 'the gate opened on day 2: ' + r.gateDay);
    const t = r.world.tower;
    assert(t.gates.vipStayFavorable === true, 'written by the game, not by the harness');
    assert([...t.objects.values()].filter((o) => o.family === FAMILY.hotelSuite).every((o) => !o.vipHold), 'every suite released');
    assert(r.blocker === 'the VIP already approved of the tower', 'and no more VIPs: ' + r.blocker);
    const outcomes = r.history.map((h) => h.outcome);
    same(outcomes, ['booked', 'arrived', 'in the suite', 'comfortable'], 'the visit, in order');
    const texts = demandsOf(t).notices.map((n) => n.text);
    assert(texts.includes('A VIP has arrived at your Tower.') && texts.includes('The VIP has checked out. They seem to have had a comfortable stay!'), 'the original\'s lines');
    // The ladder no longer excuses this gate: the writer exists.
    assert(!('vipStayFavorable' in GATES_WITHOUT_A_WRITER), 'the no-writer table lost the VIP');
    const gate = starGateStatus(t).blockerDetails.find((d) => /VIP/.test(d.text));
    assert(!gate, 'and it is no longer a blocker');
  },

  'the lifts decide: eight cars a shaft please him on the first visit, four do not (and he comes again), one car never gets him upstairs'() {
    const good = vipTrial({ lift: 'good', days: 12 });
    const average = vipTrial({ lift: 'average', days: 12 });
    const thin = vipTrial({ lift: 'thin', days: 12 });
    const none = vipTrial({ lift: 'none', days: 12 });
    assert(good.visits[0].outcome === 'comfortable' && good.visits[0].stress === 75, 'good: comfortable at 75: ' + good.visits[0].stress);
    assert(average.visits[0].outcome === 'uncomfortable' && average.visits[0].stress >= 150, 'average: the first visit fails at ' + average.visits[0].stress);
    assert(average.visits[0].comfortable === false && average.visits[0].why === 'checked out', 'having ridden up and down: ' + average.visits[0].why);
    assert(average.visits.length === 2 && average.visits[1].outcome === 'comfortable', 'a second chance, and it is taken: ' + average.visits.map((v) => v.outcome));
    // ... exactly one quarter after the first ended.
    const booked = average.history.filter((h) => h.outcome === 'booked').map((h) => h.day);
    assert(booked[1] - average.visits[0].day === VIP_RETRY_DAYS, 'the retry is VIP_RETRY_DAYS later: ' + booked + ' / ' + average.visits[0].day);
    assert(average.favorable && average.gateDay === 6, 'and the gate opens then: ' + average.gateDay);
    for (const r of [thin, none]) {
      assert(r.visits[0].outcome === 'uncomfortable' && r.visits[0].why === 'never reached the suite', r.lift + ': ' + JSON.stringify(r.visits[0]));
      assert(r.visits[0].stress === 300 && r.visits[0].level === 0, r.lift + ': a visitor still waiting scores the clamp, NOT the 0 of "no trips"');
      assert(!r.favorable, r.lift + ': the gate stays shut');
    }
    // Neither left a ghost in a lift queue.
    for (const r of [thin, none]) {
      const t = r.world.tower;
      const vip = t.actors.find((a) => a && a.family === FAMILY.vip);
      assert(vip && t.carriers.every((c) => !c.liveRequests.has(vip.id)), r.lift + ': the VIP was taken out of every queue');
      assert(vip.waitingFloor === null && vip.route === null, r.lift + ': and is nowhere');
    }
  },

  'the visitor is ONE actor with no object: the tower\'s lifts carry him, and demolishing his suite cancels the stay'() {
    const env = eventsTower({ floors: 6, security: [-1], suites: 2, housekeeping: true, cars: 6 });
    const { tower, scheduler, world } = env;
    tower.clock.dayCounter = 0; tower.clock.dayTick = 0;
    let queued = false, ridden = false;
    for (let i = 0; i < dayLength * 2 && !tower.events.lastVip; i++) {
      scheduler.tick(tower);
      const vip = tower.actors.find((a) => a && a.family === FAMILY.vip);
      if (vip?.waitingFloor != null) queued = true;
      if (vip?.route?.carrierId != null) ridden = true;
    }
    assert(queued && ridden, 'he stood in a lift queue and rode a carrier - the real router: ' + JSON.stringify({ queued, ridden }));
    const actors = tower.actors.filter((a) => a && a.family === FAMILY.vip);
    assert(actors.length === 1 && actors[0].objectId === null, 'one actor, owning nothing');

    // A second world: the suite goes while he is in it.
    const e2 = eventsTower({ floors: 6, security: [-1], suites: 2, housekeeping: true, cars: 6 });
    e2.tower.clock.dayCounter = 0; e2.tower.clock.dayTick = 0;
    tickUntil(e2.scheduler, e2.tower, () => e2.tower.events.vip?.phase === 'staying', 'the VIP asleep in the suite');
    const suite = e2.tower.objects.get(e2.tower.events.vip.suiteId);
    assert(demolishRefusal(suite) === null, 'a vacant suite can be bulldozed');
    assert(applyAction(e2.world, { type: 'demolish', objectId: suite.id }).ok, 'bulldozed');
    e2.scheduler.tick(e2.tower);
    assert(e2.tower.events.vip === null && e2.tower.events.lastVip.comfortable === null, 'the stay is cancelled, with no verdict');
    assert(!e2.tower.gates.vipStayFavorable, 'and no gate');
    assert(e2.tower.actors.filter((a) => a && a.family === FAMILY.vip).length === 1, 'the visitor is still the one standing actor');
  },

  'a VIP mid-stay survives a save: the restored tower reaches the same verdict, to the number'() {
    const env = eventsTower({ floors: 6, security: [-1], suites: 2, housekeeping: true, cars: 6 });
    const { tower, scheduler, world } = env;
    tower.clock.dayCounter = 0; tower.clock.dayTick = 0;
    tickUntil(scheduler, tower, () => tower.events.vip?.phase === 'arriving' && tower.clock.dayTick > VIP_ARRIVAL_TICK + 5, 'the VIP on his way up');
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    assert(blob.version === SAVE_VERSION && SAVE_VERSION >= 10, 'the version moved to 10: ' + SAVE_VERSION);
    tickUntil(scheduler, tower, () => tower.events.lastVip, 'the original visit to end');
    const back = restore(blob);
    assert(back.ok !== false, 'it loads: ' + back.reason);
    rebuildRouteTables(back.world.tower);
    const next = makeDriver(back.world);
    tickUntil(next.scheduler, back.world.tower, () => back.world.tower.events.lastVip, 'the restored visit to end');
    const a = eventsOf(tower).history.filter((h) => h.kind === 'vip').at(-1);
    const b = eventsOf(back.world.tower).history.filter((h) => h.kind === 'vip').at(-1);
    same(b, a, 'the restored visit ends exactly as the original did');
    assert(back.world.tower.gates.vipStayFavorable === tower.gates.vipStayFavorable, 'and the gate agrees');
    // And an old save is refused rather than resumed into a tower that has no events.
    const old = JSON.parse(JSON.stringify(blob));
    old.version = 9;
    assert(restore(old).ok === false, 'a v9 save is refused');
  },

  // ================================================================ the extras

  'buried treasure: the first thing built on each new basement floor rolls once; a strike pays one of the six amounts'() {
    const t = bare();
    const seen = [];
    for (let seed = 1; seed <= 200; seed++) {
      const u = bare();
      u.rng = makeRng(seed);
      u.cash = 1_000_000;
      const r = maybeFindTreasure(u, -2);
      if (r) { seen.push(r.amount); assert(u.cash === 1_000_000 + r.amount, 'paid at once'); assert(TREASURE_AMOUNTS.includes(r.amount), 'one of the six: ' + r.amount); }
      // The second thing on the same floor never rolls: the generator does not move.
      const before = u.rng.state;
      assert(maybeFindTreasure(u, -2) === null && u.rng.state === before, 'a floor is struck once');
      // Above ground there is no buried treasure, and no draw.
      assert(maybeFindTreasure(u, 1) === null && maybeFindTreasure(u, 0) === null && u.rng.state === before, 'only below ground');
    }
    const rate = seen.length / 200;
    assert(rate > 1 / TREASURE_ODDS / 2 && rate < 2 / TREASURE_ODDS, 'about 1 in ' + TREASURE_ODDS + ': ' + rate);
    same(TREASURE_AMOUNTS, [80_000, 150_000, 50_000, 300_000, 150_000, 500_000], 'the tuning block\'s 800 / 1500 / 500 / 3000 / 1500 / 5000 at $100');
    assert(EVENT_TEXT.treasure(150_000) === 'Wow!\nDuring construction, workers discovered ancient buried treasure!\nIt is worth $150,000', 'verbatim');
  },

  'treasure through the seam: a build on a new basement floor returns the strike, costs its price, and says so'() {
    const trial = treasureTrial();
    assert(trial.digs === 360 && trial.strikes.length > 0, 'strikes happen: ' + trial.strikes.length + ' of ' + trial.digs);
    assert(trial.strikes.length / trial.digs > 0.05 && trial.strikes.length / trial.digs < 0.25, 'at roughly 1 in 8: ' + trial.strikes.length / trial.digs);
    assert(trial.strikes.every((s) => TREASURE_AMOUNTS.includes(s.amount) && s.floor < 0), 'every one a real amount, underground');
    same(treasureTrial().strikes, trial.strikes, 'and deterministic: the same seeds strike the same floors for the same sums');
    // One strike, followed through the seam to the notice.
    const hit = trial.strikes[0];
    const w = newTowerWorld({ seed: hit.seed, cash: 90_000_000 });
    w.tower.starCount = 4;
    let paid = null;
    for (let k = 1; k <= -hit.floor; k++) {
      const cash = w.tower.cash;
      const r = applyAction(w, { type: 'build', what: 'fastFood', floor: -k, left: 30 });
      if (r.treasure) paid = { r, net: w.tower.cash - cash };
    }
    assert(paid && paid.r.treasure.amount === hit.amount && paid.net === hit.amount - paid.r.cost, 'cash = windfall - cost: ' + JSON.stringify(paid?.net));
    assert(demandsOf(w.tower).notices.some((n) => n.kind === 'treasure' && n.tone === 'good'), 'a good notice');
  },

  'Santa: the last evening of the year, from the clock alone - no draw, no cash, one notice'() {
    assert(isSantaDay(11) && isSantaDay(23) && isSantaDay(35) && !isSantaDay(10) && !isSantaDay(12), 'every twelfth day');
    assert(santaFlight({ dayCounter: 11, dayTick: SANTA_TICK - 1 }) === null, 'not before 2000');
    assert(santaFlight({ dayCounter: 11, dayTick: SANTA_TICK }) === 0, 'at 2000 he is at the left edge');
    assert(santaFlight({ dayCounter: 11, dayTick: 2150 }) === 0.5, 'halfway at 2150');
    assert(santaFlight({ dayCounter: 11, dayTick: SANTA_END_TICK }) === null, 'gone at 2300');
    assert(santaFlight({ dayCounter: 12, dayTick: 2100 }) === null, 'and only on his day');
    const t = bare({ day: 11, tick: SANTA_TICK });
    const rng = t.rng.state, cash = t.cash;
    assert(announceSanta(t) && demandsOf(t).notices.at(-1).text === 'Santa Claus is coming to your tower!', 'the original\'s line');
    assert(demandsOf(t).notices.at(-1).tone === 'good', 'good news');
    assert(t.rng.state === rng && t.cash === cash, 'cosmetic: no draw, no money');
    const other = bare({ day: 12, tick: SANTA_TICK });
    assert(!announceSanta(other) && demandsOf(other).notices.length === 0, 'nothing on another day');
    // Through the scheduler: the notice appears on tick 2000 of day 11 and not a tick earlier.
    const w = newTowerWorld({ seed: 1 });
    const { scheduler } = makeDriver(w);
    w.tower.clock.dayCounter = 11; w.tower.clock.dayTick = SANTA_TICK - 2;
    scheduler.tick(w.tower);
    assert(!noticesAfter(w.tower, 0).some((n) => n.kind === 'santa'), 'not at 1999');
    scheduler.tick(w.tower);
    assert(noticesAfter(w.tower, 0).some((n) => n.kind === 'santa'), 'at 2000');
  },

  // ============================================================ determinism, saves

  'deterministic: the same seed and the same answers burn the same tower, to the number'() {
    for (const [make, label] of [[() => bombTrial({ answer: 'search', security: [] }), 'bomb'], [() => fireTrial({ answer: 'decline', security: [-10] }), 'fire']]) {
      const a = make();
      const b = make();
      same(a.history, b.history, label + ' history');
      assert(a.destroyed === b.destroyed && a.cash === b.cash, label + ' damage and cash');
    }
    // A different seed picks a different floor, so the generator really is the seed's.
    const floors = new Set([1, 2, 3, 4, 5, 6].map((seed) => fireTrial({ seed, security: [-1] }).floorBurned));
    assert(floors.size > 1, 'six seeds, more than one burning floor: ' + [...floors]);
  },

  'a fire in progress survives a save: the restored tower burns the same'() {
    const env = eventsTower({ floors: 10, security: [-10] });
    const { tower, scheduler, world } = env;
    tower.clock.dayCounter = 83; tower.clock.dayTick = 0;
    let answered = false;
    const play = (sched, tw, w) => {
      for (let i = 0; i < 700; i++) {
        sched.tick(tw);
        if (tw.events.decision && !answered) { applyAction(w, { type: 'answer_event', answer: 'decline' }); answered = true; }
      }
    };
    tickUntil(scheduler, tower, () => tower.events.fire, 'the fire to start');
    applyAction(world, { type: 'answer_event', answer: 'decline' });
    for (let i = 0; i < 60; i++) scheduler.tick(tower);
    const blob = JSON.parse(JSON.stringify(snapshot(world)));
    assert(blob.tower.events.fire && blob.tower.events.fire.guards.length === 1, 'the fire and its guard team are in the file');
    const back = restore(blob);
    rebuildRouteTables(back.world.tower);
    const next = makeDriver(back.world);
    answered = true;
    play(scheduler, tower, world);
    play(next.scheduler, back.world.tower, back.world);
    const a = eventsOf(tower).history, b = eventsOf(back.world.tower).history;
    same(b, a, 'the same history');
    assert(back.world.tower.objects.size === tower.objects.size && back.world.tower.cash === tower.cash, 'the same tower and the same money');
    assert(back.world.tower.clock.dayTick === tower.clock.dayTick, 'and the same clock');
  },

  // ======================================================================= the UI

  'the bar says an event\'s line over a complaint, in one line, held as long as a rise'() {
    const fresh = [
      { id: 1, text: 'Office workers demand Parking' },
      { id: 2, text: 'The fire was stopped.\nBecause your building has emergency stairs, no one was injured, but the tower is damaged.', tone: 'bad' },
      { id: 3, text: 'The tower demands a Recycling Center' },
    ];
    const said = noticeToSay(fresh);
    assert(said.text === 'The fire was stopped. Because your building has emergency stairs, no one was injured, but the tower is damaged.', said.text);
    assert(said.ok === false && said.rise === false && said.ms > 2200, 'a bad event: red, held, no star pulse');
    const good = noticeToSay([{ id: 1, text: 'Wow!\nDuring construction...', tone: 'good' }]);
    assert(good.ok === true && good.rise === false, 'treasure is good news and does not pulse the stars');
    const rise = noticeToSay([...fresh, { id: 4, text: 'The tower has reached 3 stars', good: true }]);
    assert(rise.rise === true && rise.text === 'The tower has reached 3 stars', 'a star rise still outranks everything');
    assert(noticeToSay([{ id: 1, text: 'plain' }]).ms === null, 'a plain notice keeps the short life');
  },

  'the bar names what is live: a hidden bomb and who is looking, a fire and its guards, the VIP and where he is'() {
    const quiet = bare();
    assert(eventsReadout(quiet) === '', 'nothing live, nothing said');
    const t = bare();
    building(t, 6);
    tryStartBomb(t);
    assert(eventsReadout(t) === 'BOMB threat - ransom or search', eventsReadout(t));
    answerEvent(t, 'search');
    assert(eventsReadout(t) === 'BOMB hidden - nobody is looking, it goes off at 1 PM', eventsReadout(t));
    securityAt(t, -1);
    assert(eventsReadout(t) === 'BOMB hidden - security is searching, it goes off at 1 PM', eventsReadout(t));
    const f = bare({ day: 83 });
    building(f, 6);
    securityAt(f, -5);
    tryStartFire(f);
    assert(/^FIRE on floor \d+ - 1 guard team \(1 on the stairs\)$/.test(eventsReadout(f)), eventsReadout(f));
    const v = bare({ day: 5, tick: VIP_BOOK_TICK });
    const suite = put(v, FAMILY.hotelSuite, 4, 0, 9);
    suite.occupiedFlag = true;
    tryBookVip(v);
    assert(eventsReadout(v) === 'VIP booked: suite on floor 4', eventsReadout(v));
  },

  'the shape: one tower field, one family, one action, one save version'() {
    assert(SAVE_VERSION === 10, 'save v10: ' + SAVE_VERSION);
    const t = bare();
    const e = eventsOf(t);
    for (const key of ['bombActive', 'fireActive', 'decision', 'bomb', 'fire', 'vip', 'vipActorId', 'lastVip', 'scars', 'blast', 'dug', 'history']) {
      assert(key in e, 'tower.events.' + key);
    }
    assert(FAMILY.vip === 0x30, 'the VIP is family 0x30');
  },
};
