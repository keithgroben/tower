/**
 * A file with the exact bug `ui/main.js` shipped: a call to a function that is
 * never imported. Not run — read, by `test/imports.test.js`, to prove that
 * check can fail. A guard nobody has watched fail is not a guard.
 */
import { offices } from '../../src/games/tower/sim/office.js';

export function runDailySweep(tower) {
  for (const { occupants } of offices(tower)) {
    resetFacilitySimTripCounters(occupants);   // never imported — this is the bug
  }
}
