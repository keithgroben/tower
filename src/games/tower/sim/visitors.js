/**
 * **How a visitor moves**: the three small things every actor that is neither a tenant nor
 * staff does the same way - ask the router for a leg, remember where a walked leg left it, and
 * count a same-floor arrival. The VIP (`sim/events.js`), the wedding guests
 * (`sim/cathedral.js`) and the inspector (`sim/inspection.js`) all ride the real router and
 * the real lifts, and a trip that was counted differently for each would be three stress
 * models in one tower.
 *
 * Split out of `sim/events.js` when the second and third visitor arrived (issue #17): the
 * cathedral and the events import each other's facts, and one function written in three
 * places is the drift `CLAUDE.md` keeps a list of.
 */
import { advanceSimTripCounters, rebaseSimElapsedFromClock } from './stress.js';
import { emitsDistanceFeedback } from './routing.js';

/**
 * Route one visitor one stride. `ctx` is `{resolveRoute, onDelay}`, supplied by the composition
 * (`ui/driver.js`) exactly as the hotel's is, so the visitor's delays are priced by the one
 * stress pipeline and nowhere else.
 *
 * @returns {{code:number, legDestination?:number, advanceTripCounters?:boolean}}
 */
export function routeVisitor(tower, actor, from, to, ctx, state) {
  const result = ctx.resolveRoute(tower, actor, from, to, tower.clock, {
    passengerRoute: true,
    emitDistanceFeedback: emitsDistanceFeedback(actor.family, state),
    onDelay: (delay) => ctx.onDelay?.(delay, actor),
  });
  return typeof result === 'object' && result !== null ? result : { code: result };
}

/** A walked leg lands the visitor on the segment's far landing; the next stride routes on from there. */
export function noteLocalLeg(actor, result) {
  if (result.code === 1 && Number.isInteger(result.legDestination)) actor.anchorFloor = result.legDestination;
}

/**
 * Result `3` is a counted trip when no lift carried it (`PEOPLE.md` § When Counters Advance:
 * *"same-floor route success (result 3)"*); a lift's arrival is counted by the carrier callback.
 * The router sets `advanceTripCounters` for exactly the former.
 */
export function countSameFloorArrival(actor, tower, result) {
  if (!result.advanceTripCounters) return;
  rebaseSimElapsedFromClock(actor, tower.clock.dayTick);
  advanceSimTripCounters(actor);
}
