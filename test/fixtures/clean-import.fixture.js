/**
 * The same shape, correct. Read by `test/imports.test.js` to prove the check
 * does not cry wolf — a guard with false positives gets switched off, which
 * costs more than not having one.
 */
import { offices } from '../../src/games/tower/sim/office.js';
import { resetFacilitySimTripCounters } from '../../src/games/tower/sim/stress.js';

const localHelper = (n) => n * 2;

export function runDailySweep(tower) {
  for (const { occupants } of offices(tower)) {
    resetFacilitySimTripCounters(occupants);
    localHelper(occupants.length);
    setTimeout(() => {}, 0);
  }
}
