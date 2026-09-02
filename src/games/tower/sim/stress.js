/**
 * Stress — the entire quality model, in one number per person.
 *
 * Spec: `specs/PEOPLE.md` § Stress / Trip-Counter Pipeline, with the delay
 * constants from `specs/ROUTING.md` § Delays and the scoring pipeline from
 * `specs/FACILITIES.md` § Facility Evaluation Model. Every number here is
 * theirs.
 *
 *     stress = accumulated_elapsed / trip_count       // 0 when trip_count == 0
 *
 * Average ticks a person spends in transit per trip. That is the whole
 * evaluation model — no appeal score, no desirability, no weighted sum of room
 * properties. Whether a tenant stays is decided by how their journeys actually
 * went, which is why this module is the one every other judgement hangs off.
 *
 * Six things about it are surprising enough to state up front, because each is
 * a bug waiting to happen if you assume the obvious instead:
 *
 * 1. **Stairs versus escalator is *only* a stress rate.** Both teleport the
 *    actor in a single 16-tick refresh stride (`ROUTING.md` § Stair / Escalator
 *    Transit Timing). The entire mechanical difference is 35 ticks of stress
 *    per floor against 16. There is no capacity, no walk loop, no congestion.
 *
 * 2. **A fixed delay throws away the pending wall-clock accrual.**
 *    `add_delay_to_current_sim` adds its constant to the packed elapsed field
 *    and then clears `last_trip_tick` — it never folds in
 *    `day_tick - last_trip_tick` first. Time already spent waiting when a
 *    penalty lands is simply lost. See {@link addDelayToCurrentSim}.
 *
 * 3. **The tall-lobby rebate is subtracted before the 300 clamp**, so on a leg
 *    that was already catastrophic it buys nothing. The order in
 *    {@link accumulateElapsedDelayIntoCurrentSim} is load-bearing.
 *
 * 4. **`last_trip_tick == 0` means both "cleared" and "stamped at tick 0".**
 *    That collision is the reference's, and `specs/DEMAND.md` state `0x26`
 *    reads the field as a flag, so it is observable. We reproduce it rather
 *    than inventing a sentinel the original does not have.
 *
 * 5. **The 10-bit elapsed field can never overflow.** Every write path clamps
 *    to 300 before storing, and 300 < 1024, so the packing is invisible to
 *    behaviour. It is preserved anyway because the high 6 bits carry flags the
 *    reference does not name, and dropping them would lose state a save must
 *    round-trip. See {@link ELAPSED_MASK}.
 *
 * 6. **A trip that cannot be routed costs the maximum.** 300 ticks, the same
 *    value as the clamp, which is what makes bad transport dominate occupancy
 *    by construction rather than by tuning. See {@link recordNoRouteFailure}.
 *
 * Floors here are **logical**: 0 is the ground lobby, −1 is B1. The reference
 * quotes EXE indices in places, where `logical = exe - 10`
 * (`ROUTING.md` § Floor Numbering); every translation is commented at the site.
 *
 * Pure and Node-runnable, like everything else under `sim/`. Ticks come from
 * the caller; this module never sees wall time.
 */

// --------------------------------------------------------------- packing

/**
 * Low 10 bits of `elapsed_packed`: the current leg's elapsed ticks.
 * `PEOPLE.md` § Per-Sim Trip Fields, offset `+0x0c`.
 */
export const ELAPSED_MASK = 0x3ff;

/**
 * High 6 bits of `elapsed_packed`: flags. The reference records that they
 * exist and never says what any of them mean, so they are carried through
 * every write untouched and never read. Losing them would be a save-round-trip
 * bug that looks like nothing until something else starts reading them.
 */
export const ELAPSED_FLAGS_MASK = 0xfc00;

/**
 * The ceiling on any single sample, `PEOPLE.md` § Trip-Counter Functions.
 * One catastrophe cannot dominate a person's history.
 *
 * `ROUTING.md` § Delays lists a queued-leg timeout of 300 and a no-route delay
 * of 300 as well. Three rules, one value, by coincidence — kept as separate
 * constants so retuning one can never silently move the others.
 */
export const ELAPSED_CLAMP = 300;

/**
 * `trip_count` is a byte (`PEOPLE.md` § Sim Entity Record Layout, `+0x09`), so
 * it wraps at 256; `accumulated_elapsed` is a word, so it wraps at 65536.
 *
 * ⚠️ **The trip-count wrap IS reachable, and this comment used to say it was
 * not.** The reasoning was that counters reset every third day — true for a
 * unit that gets swept, and false for a worker whose office never rents. That
 * worker fails a route on *every* service tick it is allowed, which measured
 * **487 attempts in three days** against a byte. `trip_count` laps while
 * `accumulated_elapsed` keeps climbing, and the average comes out in the
 * thousands: a bank of unreachable offices medianed **2,177**.
 *
 * The wrap itself stays — a byte is a byte, and the storage is faithful. What
 * was wrong was the derived number: see {@link computeRuntimeTileStressAverage},
 * which now clamps its result, because an average of samples that are each
 * clamped to 300 cannot legitimately exceed 300. Behaviour is unchanged either
 * way (2,177 and 300 both grade 0), so this was a reporting bug — which is
 * exactly the kind that ends up on a HUD.
 *
 * The accumulator's own wrap remains unreachable: twenty maximum-stress legs a
 * day accumulates 18,000 over three days against a 65,535 ceiling. The wrap is reproduced because it is what a byte and a
 * word do, and because a counter that silently grows past its field is exactly
 * the kind of accounting hole that reads as good news.
 */
export const TRIP_COUNT_WRAP = 256;
export const ACCUMULATED_WRAP = 65536;

// ---------------------------------------------------------------- delays

/** No route exists. `ROUTING.md` § Delays. The worst thing that can happen. */
export const NO_ROUTE_DELAY = 300;

/** The source floor's queue is already at its 40-entry limit. */
export const QUEUE_FULL_DELAY = 5;

/** Listed in `ROUTING.md` § Delays and genuinely zero — see {@link addDelayToCurrentSim}. */
export const REQUEUE_FAILURE_DELAY = 0;
export const INVALID_VENUE_DELAY = 0;

/**
 * Per floor traversed on a direct local segment. These two numbers are the
 * whole of the stairs/escalator distinction, so they are the ones most worth
 * getting exactly right.
 */
export const STAIRS_PER_STOP_DELAY = 35;
export const ESCALATOR_PER_STOP_DELAY = 16;

/**
 * The long-distance penalty, `ROUTING.md` § Long-distance penalty. Gated by
 * `emit_distance_feedback`, and for carriers only when `carrier_mode != 0`.
 */
export const DISTANCE_PENALTY_NEAR = 30;
export const DISTANCE_PENALTY_FAR = 60;

/** `<= 79` costs nothing; `>= 125` costs the far penalty. */
export const DISTANCE_FREE_LIMIT = 79;
export const DISTANCE_FAR_LIMIT = 125;

// -------------------------------------------------------------- carriers

/** `ELEVATORS.md` § Carrier Types. Mode drives both the rebate and the penalty. */
export const CARRIER_EXPRESS = 0;
export const CARRIER_STANDARD = 1;
export const CARRIER_SERVICE = 2;

// ----------------------------------------------------------------- lobby

/**
 * The ground lobby. The reference says "EXE floor 10 / clone logical floor 0"
 * in as many words (`PEOPLE.md` § Lobby-Boarding Stress Reduction), so this is
 * the translation `logical = exe - 10` applied: `10 - 10 = 0`.
 */
export const LOBBY_FLOOR = 0;

/**
 * The rebate, keyed by `g_lobby_height`. `COMMANDS.md` locks the value to
 * {1, 2, 3} on the player's first construction click and never modifies it
 * again; `ECONOMY.md` line 66 has it defaulting to 0 before that click.
 *
 * Heights 0 and 1 are **absent on purpose** — their absence *is* the spec's
 * "`g_lobby_height <= 1`: no adjustment" branch. Stating that rule a second
 * time as a guard would be a rule written in two places, and the redundant
 * copy is invisible to a test: mutating it changes nothing, which is how it
 * would survive long enough to drift.
 *
 * This is what a multi-storey lobby is *for*. Not frontage, not capacity: a
 * −25 or −50 tick rebate on every departure from the ground floor.
 */
export const LOBBY_BOARDING_REDUCTION = { 2: 25, 3: 50 };

// ---------------------------------------------------------- colour bands

/** The manual's three visible bands, `PEOPLE.md` § Stress Color Bands. */
export const STRESS_PINK = 80;
export const STRESS_RED = 120;

// ------------------------------------------------------------ population

/**
 * How many sims a facility's score is averaged over, `FACILITIES.md`
 * § Facility Evaluation Model step 2.
 *
 * TODO(parity): the reference contradicts itself about family 5. Both scoring
 * contexts — `FACILITIES.md` line 39 and `PEOPLE.md` line 190 — say the
 * divisor is 2, while `PEOPLE.md` line 280 ("Per-room entity count") says a
 * family-5 suite holds 3 entities. Two sources against one, and the two agree
 * on the question actually being asked, so the divisor is 2 here. It matters:
 * a suite would score the sum of three people's stress over two.
 */
export const FACILITY_POPULATION = { 3: 1, 4: 2, 5: 2, 7: 6, 9: 3 };

/** Family 7. Named because it is the one this build starts from. */
export const OFFICE_OCCUPANTS = FACILITY_POPULATION[7];

// ----------------------------------------------------------------- state

/**
 * A blank trip record: the stress-pipeline slice of the reference's 16-byte
 * sim entity (`PEOPLE.md` § Sim Entity Record Layout, offsets `+0x09`
 * through `+0x0f`).
 *
 * Deliberately *only* those four fields. The family code, state byte, route
 * token and source floor belong to whoever owns the actor table; this record
 * is meant to be composed into that one, not to replace it. Naming is English
 * rather than byte offsets, which `CLAUDE.md` permits so long as behaviour
 * matches — and the behaviour that matters is the packing, which is preserved.
 */
export function createSimTripRecord({
  tripCount = 0,
  lastTripTick = 0,
  elapsedPacked = 0,
  accumulatedElapsed = 0,
} = {}) {
  return { tripCount, lastTripTick, elapsedPacked, accumulatedElapsed };
}

/** The current leg's elapsed ticks: the low 10 bits of `elapsed_packed`. */
export const elapsedTicks = (sim) => sim.elapsedPacked & ELAPSED_MASK;

/** The unnamed high-6-bit flags, isolated. Carried, never interpreted. */
export const elapsedFlags = (sim) => sim.elapsedPacked & ELAPSED_FLAGS_MASK;

/**
 * The 300-tick clamp, applied at every store.
 *
 * TODO(parity): `PEOPLE.md` lines 141-143 say "clamp to 300" and name no lower
 * bound, but the two elapsed formulas can go negative when a leg spans the
 * `day_tick` wrap — a route stamped at 2590 and rebased at tick 10 the next
 * morning computes `10 - 2590`. The reference does not address the wrap at
 * all. The binary's word arithmetic would either saturate to 300 (unsigned
 * compare) or store a truncated garbage value (signed compare); we floor at 0,
 * because a negative sample subtracted from `accumulated_elapsed` would make
 * the average read *better* the worse the tower gets, which is the one failure
 * mode this repo exists to avoid.
 */
export const clampElapsed = (value) =>
  value > ELAPSED_CLAMP ? ELAPSED_CLAMP : (value < 0 ? 0 : value);

/**
 * Clamp, then write into the low 10 bits, keeping the flags.
 *
 * Clamp *before* the mask, never after: a stairs leg across 128 floors is
 * 4,480 ticks, and 4480 & 0x3ff is 384 — a plausible-looking number that is
 * not the 300 the reference stores.
 */
function storeElapsed(sim, value) {
  sim.elapsedPacked = elapsedFlags(sim) | clampElapsed(value);
  return elapsedTicks(sim);
}

// ------------------------------------------------- the pipeline, in order

/**
 * **Route-start timestamp.** `PEOPLE.md` § Trip-Counter Functions, item 5: at
 * the end of `resolve_sim_route_between_floors`, `last_trip_tick = g_day_tick`.
 * This starts the clock for the next leg.
 *
 * Called *after* any per-stop delay on the same resolution, because
 * {@link addDelayToCurrentSim} clears the field — `ROUTING.md` § Stair /
 * Escalator Transit Timing lists the delay as step 3 and the stamp as step 4.
 * Reversing them would throw the stamp away.
 */
export function stampRouteStart(sim, dayTick) {
  sim.lastTripTick = dayTick;
  return sim.lastTripTick;
}

/**
 * **`rebase_sim_elapsed_from_clock`.** `PEOPLE.md` § Trip-Counter Functions,
 * item 1. Called from the queued-car arrival callback in
 * `dispatch_sim_behavior` and from `cancel_runtime_route_request`.
 *
 *     elapsed = (elapsed_packed & 0x3ff) + g_day_tick - last_trip_tick
 *     clamp to 300, store back, clear last_trip_tick
 *
 * Note there is no lobby rebate here — this is the plain "how long did that
 * take" path. The rebate lives in {@link accumulateElapsedDelayIntoCurrentSim},
 * which is the carrier-assignment path.
 *
 * @returns {number} the stored elapsed ticks
 */
export function rebaseSimElapsedFromClock(sim, dayTick) {
  // `last_trip_tick == 0` is both "cleared" and "stamped at tick 0", so a
  // rebase with no stamp charges the whole day tick and clamps to 300. That is
  // the reference's collision, reproduced rather than papered over.
  const stored = storeElapsed(sim, elapsedTicks(sim) + dayTick - sim.lastTripTick);
  sim.lastTripTick = 0;
  return stored;
}

/**
 * **`accumulate_elapsed_delay_into_current_sim`.** `PEOPLE.md`
 * § Trip-Counter Functions, item 3. Called from
 * `assign_request_to_runtime_route` when a carrier leg is assigned.
 *
 *     elapsed = (elapsed_packed & 0x3ff) + g_day_tick - last_trip_tick
 *     apply the lobby-boarding reduction
 *     clamp to 300, store back, clear last_trip_tick
 *
 * The rebate is applied **before** the clamp. On a leg that already ran to
 * 4,000 ticks the −50 is invisible; on an ordinary morning commute it is a
 * fifth of the pink band. Swapping the two lines is undetectable in a short
 * tower and wrong in a tall one.
 *
 * Service carriers are excluded — the reference does not call this function
 * for them at all (`PEOPLE.md` line 217). The early return therefore leaves
 * `last_trip_tick` *stamped*, which is what "never called" means; clearing it
 * would be a subtly different thing.
 *
 * @param {object} sim
 * @param {number} dayTick
 * @param {{sourceFloor:number, lobbyHeight?:number, carrierMode?:number}} leg
 * @returns {number} the stored elapsed ticks
 */
export function accumulateElapsedDelayIntoCurrentSim(sim, dayTick, {
  sourceFloor,
  lobbyHeight = 1,
  carrierMode = CARRIER_STANDARD,
} = {}) {
  if (carrierMode === CARRIER_SERVICE) return elapsedTicks(sim);

  const raw = elapsedTicks(sim) + dayTick - sim.lastTripTick;
  const stored = storeElapsed(sim, reduceElapsedForLobbyBoarding(raw, sourceFloor, lobbyHeight));
  sim.lastTripTick = 0;
  return stored;
}

/**
 * **`reduce_elapsed_for_lobby_boarding`.** `PEOPLE.md` § Lobby-Boarding Stress
 * Reduction. Keyed to `g_lobby_height`, and only for a departure from the
 * lobby floor itself.
 *
 * The floor test is on logical 0 — the reference's "EXE floor 10". The upper
 * storeys of a multi-floor lobby (logical `1 .. lobby_height - 1`,
 * `ECONOMY.md` line 67) are *not* the lobby floor and get no rebate, which is
 * easy to get wrong when the lobby visibly occupies three floors.
 *
 * Pure: takes and returns an elapsed value rather than touching the record, so
 * the ordering against the clamp stays visible at the call site.
 */
export function reduceElapsedForLobbyBoarding(elapsed, sourceFloor, lobbyHeight) {
  if (sourceFloor !== LOBBY_FLOOR) return elapsed;
  // Heights 0 and 1 are not in the table, which is the spec's "no adjustment"
  // branch — see the note on LOBBY_BOARDING_REDUCTION for why there is no
  // second guard here saying the same thing.
  const reduction = LOBBY_BOARDING_REDUCTION[lobbyHeight] ?? 0;
  return Math.max(0, elapsed - reduction);           // the spec's explicit "min 0"
}

/**
 * **`add_delay_to_current_sim`.** `PEOPLE.md` § Trip-Counter Functions, item 4.
 *
 *     elapsed = (elapsed_packed & 0x3ff) + delay_delta
 *     clamp to 300, store back, clear last_trip_tick
 *
 * Two things to notice. First, the formula does **not** fold in
 * `g_day_tick - last_trip_tick` — a person who has been queuing for 200 ticks
 * when a 5-tick queue-full penalty lands is charged 5, not 205, and the 200
 * are gone. Second, it clears the stamp unconditionally, so a zero-tick delay
 * (`ROUTING.md` lists a requeue-failure delay of 0 and an invalid-venue delay
 * of 0) still resets the clock. Both are faithful and both look like bugs.
 *
 * @returns {number} the stored elapsed ticks
 */
export function addDelayToCurrentSim(sim, delayDelta) {
  const stored = storeElapsed(sim, elapsedTicks(sim) + delayDelta);
  sim.lastTripTick = 0;
  return stored;
}

/**
 * **`advance_sim_trip_counters`.** `PEOPLE.md` § Trip-Counter Functions,
 * item 2. The drain: one completed leg moves out of the working field and into
 * the running total.
 *
 *     trip_count += 1
 *     accumulated_elapsed += (elapsed_packed & 0x3ff)
 *     clear last_trip_tick
 *     clear the low 10 bits of elapsed_packed, keep the flags
 *
 * Called at transit-completion events only, never per tick — the call-site
 * table is `PEOPLE.md` § When Counters Advance: queued-car arrival, same-floor
 * route success (result 3), route failure (result −1), route leg completion or
 * cancellation, venue slot claimed. The per-tick refresh of an in-transit
 * entity bypasses this pipeline entirely, which is why `trip_count` counts
 * legs and not ticks.
 *
 * @returns {number} the new trip count
 */
export function advanceSimTripCounters(sim) {
  sim.tripCount = (sim.tripCount + 1) % TRIP_COUNT_WRAP;
  sim.accumulatedElapsed = (sim.accumulatedElapsed + elapsedTicks(sim)) % ACCUMULATED_WRAP;
  sim.lastTripTick = 0;
  sim.elapsedPacked = elapsedFlags(sim);
  return sim.tripCount;
}

// --------------------------------------------------- route-shaped helpers

/**
 * Floors walked on a direct local segment:
 * `floors_traversed = (mode_and_span >> 1) + 1`, `ROUTING.md` § Stair /
 * Escalator Transit Timing step 3 and § Stairs / Escalator Segment Flags.
 */
export const floorsTraversed = (modeAndSpan) => (modeAndSpan >> 1) + 1;

/** Bit 0 of `mode_and_span`: set = Stairs branch, clear = Escalator branch. */
export const isStairsSegment = (modeAndSpan) => (modeAndSpan & 1) === 1;

/**
 * The per-stop delay for one direct segment. 35 a floor for stairs, 16 for an
 * escalator — and that difference is the entire system. Both branches move the
 * actor in one refresh stride either way.
 */
export const localSegmentDelay = (modeAndSpan) =>
  (isStairsSegment(modeAndSpan) ? STAIRS_PER_STOP_DELAY : ESCALATOR_PER_STOP_DELAY)
  * floorsTraversed(modeAndSpan);

/**
 * The long-distance penalty from `abs(height_metric_delta)`, `ROUTING.md`
 * § Long-distance penalty:
 *
 *     <= 79  -> 0        > 79 and < 125 -> 30        >= 125 -> 60
 *
 * Written as the spec's own three comparisons rather than the tidier
 * `d < 80 / d < 125`, which agree on integers and disagree on 79.5.
 */
export function distancePenalty(heightMetricDelta) {
  const distance = Math.abs(heightMetricDelta);
  if (distance <= DISTANCE_FREE_LIMIT) return 0;
  if (distance < DISTANCE_FAR_LIMIT) return DISTANCE_PENALTY_NEAR;
  return DISTANCE_PENALTY_FAR;
}

/** Charge one direct stairs/escalator segment. */
export const applyLocalSegmentDelay = (sim, modeAndSpan) =>
  addDelayToCurrentSim(sim, localSegmentDelay(modeAndSpan));

/** The 5-tick wait for a source-floor queue already holding its 40 entries. */
export const applyQueueFullDelay = (sim) => addDelayToCurrentSim(sim, QUEUE_FULL_DELAY);

/**
 * The long-distance penalty, with both of its gates.
 *
 * `emit_distance_feedback` is set by the caller from the sim's **base** state
 * (`ROUTING.md` § `emit_distance_feedback` Gating): office states `0x00` and
 * `0x05` — the commutes — enable it; the venue and service-cycle states do
 * not, and housekeeping never does. In-transit continuations inherit whatever
 * was set at first resolution, so this fires once per route, not once a tick.
 *
 * `carrierMode` gates it again for carriers only: express (mode 0) is exempt,
 * standard and service are not. Pass `null` for a stairs/escalator segment,
 * where it applies to both branches.
 *
 * A zero penalty skips the call entirely rather than charging 0, because
 * {@link addDelayToCurrentSim} would clear the route-start stamp on the way
 * through and lose the leg's timing.
 *
 * @returns {number} the stored elapsed ticks
 */
export function applyDistancePenalty(sim, {
  heightMetricDelta,
  emitDistanceFeedback,
  carrierMode = null,
} = {}) {
  if (!emitDistanceFeedback) return elapsedTicks(sim);
  if (carrierMode === CARRIER_EXPRESS) return elapsedTicks(sim);
  const penalty = distancePenalty(heightMetricDelta);
  if (penalty === 0) return elapsedTicks(sim);
  return addDelayToCurrentSim(sim, penalty);
}

/**
 * A route that could not be found: charge 300 and count the trip.
 *
 * This is the single most load-bearing behaviour in the model. `ROUTING.md`
 * line 64 says result `-1` "applies the 300-tick no-route delay"; `PEOPLE.md`
 * line 128 lists route failure as a site that calls
 * `advance_sim_trip_counters`. Together they put a full-clamp sample into the
 * running average for every trip a person could not take, which is what makes
 * transport failure dominate occupancy by construction.
 *
 * TODO(parity): neither spec states the **order** of those two calls. Draining
 * before charging would discard the 300 and leave a failed trip costing zero —
 * i.e. a tower with no elevator would post the *best* stress in the game,
 * which is a bug this codebase has already paid for once. Charging first is
 * the only reading under which `PEOPLE.md`'s own "higher = worse" holds, so
 * that is the order here.
 *
 * @returns {number} the resulting stress average
 */
export function recordNoRouteFailure(sim) {
  addDelayToCurrentSim(sim, NO_ROUTE_DELAY);
  advanceSimTripCounters(sim);
  return computeRuntimeTileStressAverage(sim);
}

// --------------------------------------------------------------- scoring

/**
 * **`compute_runtime_tile_stress_average`.** `PEOPLE.md` § Scoring.
 *
 *     if trip_count == 0: return 0
 *     return accumulated_elapsed / trip_count
 *
 * Average elapsed ticks per trip. Higher is worse.
 *
 * TODO(parity): `PEOPLE.md` line 182 writes the division without saying
 * whether it truncates. The original divides 16-bit words, which does, and the
 * colour bands are stated as integer ranges (`< 80`, `80–119`, `120–300`) that
 * only tile the number line if the score is an integer — a 119.5 belongs to no
 * band as written. So it truncates here.
 *
 * Note that no trips scores 0, the *best* possible value. That is the
 * reference's, and it is why `occupied_flag` exists: `FACILITIES.md` line 144
 * has the family-7 gate block dispatch when the flag is clear, freezing the
 * average rather than letting an idle tenant look perfect.
 */
export function computeRuntimeTileStressAverage(sim) {
  if (sim.tripCount === 0) return 0;
  // Clamped, because the module's own invariant says an average of samples
  // each clamped to 300 cannot exceed 300 — and a lapped `trip_count` breaks
  // that arithmetic without breaking the storage. See the note on
  // TRIP_COUNT_WRAP.
  return Math.min(ELAPSED_CLAMP, Math.floor(sim.accumulatedElapsed / sim.tripCount));
}

/**
 * **`compute_object_operational_score`.** `PEOPLE.md` § Scoring, and
 * `FACILITIES.md` § Facility Evaluation Model steps 1-2: the per-sim stress
 * metric averaged across the facility's population count. An office is six
 * people; a condo three; a hotel single one.
 *
 * What this deliberately does **not** do is step 3 onward — the rent-tier
 * modifier (`+30 / 0 / −30 / force 0`) and the `+60` noise penalty from a
 * qualifying neighbour within the family's radius. Those need the placed-object
 * table and the floor's neighbour list, they belong to facility evaluation, and
 * `CLAUDE.md` is explicit that a rule written in two places drifts. This module
 * owns the stress half and stops there.
 *
 * `populationCount` is a separate argument rather than `sims.length` because
 * the reference's divisor is a per-family constant that does not have to match
 * the number of live entities — see the family-5 note on
 * {@link FACILITY_POPULATION}.
 *
 * @param {object[]} sims             the facility's trip records
 * @param {number} populationCount    the family's divisor, e.g. 6 for an office
 */
export function computeObjectOperationalScore(sims, populationCount = sims.length) {
  if (populationCount <= 0) return 0;
  if (sims.length < populationCount) {
    // Scoring a missing occupant as 0 would make a half-staffed office look
    // flawless. Refuse instead: an accounting hole that reads as good news is
    // the exact failure this repo keeps a list of.
    throw new Error('scoring ' + populationCount + ' occupants but only '
      + sims.length + ' trip records were supplied');
  }
  let total = 0;
  for (let i = 0; i < populationCount; i++) total += computeRuntimeTileStressAverage(sims[i]);
  return Math.floor(total / populationCount);
}

/**
 * The manual's three visible bands, `PEOPLE.md` § Stress Color Bands.
 *
 *     < 80  black (low)      80-119  pink (moderate)      120-300  red (high)
 *
 * The band table's upper edge of 300 is not a fourth case: every sample is
 * clamped to 300, so an average of clamped samples can never exceed it.
 */
export function stressBand(score) {
  if (score < STRESS_PINK) return 'black';
  if (score < STRESS_RED) return 'pink';
  return 'red';
}

// ----------------------------------------------------------------- reset

/**
 * **`reset_sim_trip_counters`.** `PEOPLE.md` § Reset. Clears `trip_count` and
 * `accumulated_elapsed` — and nothing else. `elapsed_packed` and its flags and
 * `last_trip_tick` survive, so a person mid-leg keeps their in-flight timing
 * across the reset.
 */
export function resetSimTripCounters(sim) {
  sim.tripCount = 0;
  sim.accumulatedElapsed = 0;
  return sim;
}

/**
 * **`reset_facility_sim_trip_counters`.** The same, for every sim belonging to
 * one facility.
 *
 * Fires at the 3-day cashflow pass (`activate_family_cashflow_if_operational`,
 * checkpoint 2533) and on first reopen after a vacancy
 * (`activate_office_cashflow`). That cadence is what makes evaluation a rolling
 * judgement of the last three days rather than a lifetime record — a tower that
 * fixes its elevators recovers, instead of carrying its worst morning forever.
 */
export function resetFacilitySimTripCounters(sims) {
  for (const sim of sims) resetSimTripCounters(sim);
  return sims;
}
