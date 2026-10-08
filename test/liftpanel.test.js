/**
 * The elevator control panel (issue #7).
 *
 * A setting that is stored and never read is the quietest bug in this game, so
 * the tests here do not stop at "the table changed": each one runs the cars and
 * shows the behaviour move. Spec: `specs/ELEVATORS.md` § Schedule Tables,
 * § Schedule Modes, § Departure Rules.
 */
import { applyAction } from '../src/games/tower/sim/actions.js';
import {
  CARRIER_MODE, SCHEDULE_SLOTS, addCar, carrierStopsAtFloor, createCarrier, scheduleIndex, shouldCarDepart,
  tickCarriers,
} from '../src/games/tower/sim/elevators.js';
import { newTowerWorld } from '../src/games/tower/ui/seed.js';
import { WAIT_STEPS, liftPanelModel, nextWait } from '../src/games/tower/ui/lift-panel.js';

const assert = (c, m) => { if (!c) throw new Error(m); };

function worldWithLift(mode = CARRIER_MODE.STANDARD) {
  const w = newTowerWorld({ seed: 1 });
  w.tower.starCount = 3;
  const carrier = createCarrier({ id: 1, mode, bottomFloor: 0, topFloor: 10, column: 10 });
  addCar(carrier);
  w.tower.carriers.push(carrier);
  return { w, carrier };
}

/** Run an idle shaft for a stretch of one daypart and report the highest floor its car reached. */
function highestReached(carrier) {
  const clock = { dayTick: 500, daypart: 1, calendarPhase: false };
  let max = carrier.cars[0].currentFloor;
  for (let t = 0; t < 600; t++) {
    clock.dayTick = 500 + t;
    tickCarriers([carrier], clock, {});
    max = Math.max(max, carrier.cars[0].currentFloor);
  }
  return max;
}

export const tests = {
  'the schedule changes where an idle car goes, not just a number in a table'() {
    const local = worldWithLift(); const up = worldWithLift();
    assert(applyAction(up.w, { type: 'set_lift_schedule', carrierId: 1, slot: scheduleIndex({ daypart: 1, calendarPhase: false }), mode: 1 }).ok, 'set');
    assert(highestReached(local.carrier) === 0, 'a local lift with no calls stays home');
    assert(highestReached(up.carrier) === 10, 'express-to-top in that daypart sends the idle car to the top');
  },

  'weekday and weekend are separate slots'() {
    const { w, carrier } = worldWithLift();
    const weekday = scheduleIndex({ daypart: 2, calendarPhase: false });
    const weekend = scheduleIndex({ daypart: 2, calendarPhase: true });
    assert(weekend === weekday + 7 && SCHEDULE_SLOTS === 14, 'slot = daypart + 7 x weekend');
    applyAction(w, { type: 'set_lift_schedule', carrierId: 1, slot: weekend, mode: 2 });
    assert(carrier.expressMode[weekend] === 2 && carrier.expressMode[weekday] === 0, 'only the weekend slot moved');
  },

  'waiting time holds a car at its stop (and zero lets it go)'() {
    const { w, carrier } = worldWithLift();
    const car = carrier.cars[0];
    car.assignedCount = 1; car.departureTick = 1000;
    const clock = { dayTick: 1010, daypart: 2, calendarPhase: false };
    assert(shouldCarDepart(carrier, car, clock) === true, 'default 0: leaves at once');
    applyAction(w, { type: 'set_lift_wait', carrierId: 1, slot: scheduleIndex(clock), value: 4 });
    assert(shouldCarDepart(carrier, car, clock) === false, 'with a wait set, 10 ticks in it is still holding');
    clock.dayTick = 1000 + 4 * 30 + 5;
    assert(shouldCarDepart(carrier, car, clock) === true, 'and it leaves once the wait is up');
  },

  'switching a floor off removes it from service, and the ends cannot be switched off'() {
    const { w, carrier } = worldWithLift();
    assert(carrierStopsAtFloor(carrier, 5), 'floor 5 is served');
    assert(applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 5, enabled: false }).ok, 'off');
    assert(!carrierStopsAtFloor(carrier, 5) && w.tower.routeTablesDirty, 'floor 5 is skipped and the router is told');
    assert(applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 5, enabled: true }).ok && carrierStopsAtFloor(carrier, 5), 'and back on');
    assert(!applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 10, enabled: false }).ok, 'the top cannot go');
    assert(!applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 40, enabled: false }).ok, 'nor a floor it never served');
  },

  'response distance applies to the whole shaft; a car can be sent home elsewhere'() {
    const { w, carrier } = worldWithLift();
    assert(applyAction(w, { type: 'set_lift_response', carrierId: 1, value: 2 }).ok, 'set');
    assert(carrier.dispatchThreshold.every((v) => v === 2), 'every slot carries it');
    assert(!applyAction(w, { type: 'set_lift_response', carrierId: 1, value: 0 }).ok, '0 is not a distance');
    assert(applyAction(w, { type: 'set_car_home', carrierId: 1, car: 0, floor: 4 }).ok && carrier.cars[0].homeFloor === 4, 'home moved');
    assert(!applyAction(w, { type: 'set_car_home', carrierId: 1, car: 3, floor: 4 }).ok, 'no such car');
  },

  'an express lift has fixed stops and fixed waiting floors'() {
    const { w } = worldWithLift(CARRIER_MODE.EXPRESS);
    assert(!applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 14, enabled: false }).ok, 'stops are fixed');
    assert(!applyAction(w, { type: 'set_car_home', carrierId: 1, car: 0, floor: 14 }).ok, 'waiting floors are fixed');
    assert(applyAction(w, { type: 'set_lift_schedule', carrierId: 1, slot: 0, mode: 1 }).ok, 'but its schedule is its own');
  },

  'bad input is refused, not stored'() {
    const { w } = worldWithLift();
    for (const [c, why] of [
      [{ type: 'set_lift_schedule', carrierId: 1, slot: 14, mode: 0 }, 'slot 14'],
      [{ type: 'set_lift_schedule', carrierId: 1, slot: 0, mode: 3 }, 'mode 3'],
      [{ type: 'set_lift_wait', carrierId: 1, slot: 0, value: -1 }, 'negative wait'],
      [{ type: 'set_lift_wait', carrierId: 9, slot: 0, value: 1 }, 'no such shaft'],
    ]) assert(!applyAction(w, c).ok, why + ' should be refused');
  },

  'the panel shows what the sim holds: schedule, waits, response, stops and cars'() {
    const { w, carrier } = worldWithLift();
    applyAction(w, { type: 'set_lift_schedule', carrierId: 1, slot: 9, mode: 2 });
    applyAction(w, { type: 'set_lift_wait', carrierId: 1, slot: 9, value: 4 });
    applyAction(w, { type: 'set_lift_stop', carrierId: 1, floor: 3, enabled: false });
    const m = liftPanelModel(carrier);
    assert(m.schedule.length === 14 && m.schedule[9].label === 'Down' && m.schedule[9].wait === 4, 'slot 9 reads Down, wait 4');
    assert(m.floors.length === 11 && m.floors.find((f) => f.floor === 3).on === false, 'floor 3 shows as skipped');
    assert(m.floors[0].locked && m.floors[10].locked && !m.floors[5].locked, 'only the ends are locked');
    assert(m.cars.length === 1 && m.dayparts.length === 7 && m.response === 5, 'one car, seven dayparts, the default response');
    assert(liftPanelModel({ ...carrier, mode: CARRIER_MODE.EXPRESS }).floors.length === 0, 'an express lift lists no floors to switch');
  },

  'a click cycles the wait through the same steps, and wraps'() {
    let w = 0; const seen = [w];
    for (let i = 0; i < WAIT_STEPS.length; i++) { w = nextWait(w); seen.push(w); }
    assert(seen[seen.length - 1] === 0 && seen.join() === '0,1,2,4,8,0', 'cycle ' + seen.join());
    assert(nextWait(3) === 0, 'an off-menu value restarts the cycle');
  },
};
