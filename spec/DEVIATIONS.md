# Deviations from the reference

**Keith's ruling, 2026-09-02: 100% faithful to start.**

Every place this build knowingly differs from the reference goes here, with a
reason. Silent deviation is the failure mode this repo was created to escape —
the previous version diverged early, undocumented, and no one could ever settle
whether a mechanic was right.

A row here is not a defeat. It is the difference between a decision and a drift.

| # | Rule | Reference | Ours | Why | Decided |
|---|---|---|---|---|---|
| D1 | Multi-floor lobby premium rate | **Not stated anywhere.** `ECONOMY.md` § Floor Construction Premium says the path multiplies "the recovered high-band base rate" by `lobby_height` without giving that rate; `facility/LOBBY.md` points back at `ECONOMY.md` "for the exact pricing". The two cite each other in a circle, and the reference *implementation* does not implement the premium at all. | `$500`/tile — the floor-tile base rate — giving `$1,000`/tile at height 2 and `$1,500` at height 3 | It is the only recovered per-tile rate in the whole spec set (`facility/METRO.md` derives a per-floor base as `span × YEN[0]`). And `rate × lobby_height` then really is a premium over the normal $500, which is what the spec says the mechanic is *for*. **This is an invented number** — one constant to change if the real one is ever recovered. | 2026-09-02 |

⚠️ **D1 is the only number in the build so far that we made up.** It matters to
the player: lobby height is the one building-shape decision that directly buys
down stress (−25 ticks at height 2, −50 at height 3), so its price sets whether
that trade is worth taking. Worth Keith's eye once the loop runs.

---

# Ambiguities resolved

Not deviations — places the reference is **silent or self-contradictory**, where
we had to choose. Recorded so the choice is a decision with a reason rather
than a thing someone finds later and assumes was arbitrary.

| # | Question | Reference | Chosen | Why |
|---|---|---|---|---|
| A1 | Elapsed time across the `day_tick` wrap | silent | **floor at 0** | A leg stamped at 2590 and rebased at tick 10 computes `10 − 2590`. A negative sample subtracted from the running total makes stress read **better** the worse the tower gets — the exact failure class `CLAUDE.md` warns about. |
| A2 | Is the 300-tick no-route penalty charged before or after the trip counters drain? | `ROUTING.md:64` and `PEOPLE.md:128` each describe one half, neither states the order | **charge, then drain** | Draining first discards the 300, so a failed trip costs nothing and a tower with no elevator posts the *best* stress in the game. The old repo shipped exactly this bug once: stranded riders logged as zero wait. |
| A3 | Does the stress average truncate? | `PEOPLE.md:182` writes the division without saying | **integer division** | The original divides 16-bit words. And the colour bands are integer ranges (`< 80`, `80–119`, `120–300`) that only tile the number line if the score is an integer — 119.5 belongs to no band as written. |
| A4 | Family-5 (suite) score divisor: 2 or 3? | `FACILITIES.md:39` and `PEOPLE.md:190` say 2; `PEOPLE.md:280` says a suite holds 3 entities | **2** | Two sources against one, and the two agree on the question actually being asked. Not on the current build path — offices first — so cheap to revisit. |
| A5 | Sky-lobby floors | `ELEVATORS.md` + `DATA-MODEL.md`'s worked example give logical 14/29/44; `DATA-MODEL.md` prose says 15/30/45 | **14/29/44** | The EXE-derived value comes with its own arithmetic (`(exe − 10) % 15 == 14`) and an explicit translation example (EXE 24 ⇒ logical 14). The prose reads like a human-facing round number — logical 14 is the fifteenth storey if you count the ground floor as one. One constant if it flips. |
| A6 | Shaft construction price | The reference's binary-derived table says `0x01` $200,000 / `0x2a` $400,000 / `0x2b` $100,000, but the reference's own *implementation* charges a flat $200,000 for all three | **the table** | The table came from the original binary; the implementation may have simplified. Where a reference contradicts itself, prefer the half that was recovered from the thing we are actually copying. |
| A7 | Metro station construction cost | `ECONOMY.md`'s table says `$1,000,000`; `facility/METRO.md` derives `$45,000` | **$45,000 — resolved 2026-09-02** | `METRO.md` cites the binary directly: *"Per-object cost from YEN res #1000 at index `type*4` is **0** for 0x1f/0x20/0x21; only the per-floor base rate contributes."* A per-object cost of zero is not a judgement call, and `$1,000,000` is exactly the metro's `$100,000` operating expense × 10 — a transcription slip. **Refines A6**: where two binary-derived sources disagree, the more specific one wins over the summary table. |
| A8 | Can the tower go broke? | **No such rule exists.** Zero hits for bankruptcy, game-over, losing or insolvency anywhere in the specs *or* the reference implementation. `ECONOMY.md` documents only a cash **ceiling** of `$99,999,999`; the implementation floors every charge at zero (`Math.max(0, cashBalance - amount)`). | **No bankruptcy. Cash floors at $0** | Faithful, and it resolves rather than dodges the question: you cannot go broke because you cannot go below zero and nothing checks. An unaffordable expense drains you to `$0`; placement is refused for want of funds. **SimTower has no lose condition — it has a soft-lock.** |
| A10 | Is a tier-3 office really unfailable? | `FACILITIES.md` step 3, in these words: tier `0` `+30`, tier `1` `+0`, tier `2` `−30`, tier `3` **"force score to `0` (always passes)"** | **yes — keep it** | Not an inference from a formula; the reference says "always passes" outright. It is the original's own design, so under "100% faithful to start" it stays. Whether it is a mercy or an exploit is a *balance* question the first real playthrough answers, not a parity one. |
| A9 | **What re-stamps `last_trip_tick` between carrier assignment and arrival?** Two functions consume it and each clears it; nothing in `ROUTING.md`, `PEOPLE.md` or `ELEVATORS.md` re-arms it in between | silent | **boarding re-stamps** | The other two readings are refutable. *"The arrival rebase isn't reached"* contradicts `PEOPLE.md` § When Counters Advance, which names the queued-car arrival callback explicitly. *"The assignment-time accumulate isn't reached"* deletes the tall-lobby rebate, which is applied only there — multi-storey lobbies would become pure decoration. Only this reading leaves **both** documented call sites reachable *and* meaningful: the accumulate measures the wait on the floor, the rebase measures the ride. It also generalises a rule the spec already states once — the resolver ends by stamping — into "every event that consumes the stamp re-arms it for the next segment". |
| A12 | What does it cost to extend a lift's served floors? | The reference has an elevator **editor** (`COMMANDS.md` § served-floor removal, the carrier-edit confirm prompt `0x3ed`), so editing a range is a real move — but **no price for it was recovered**. A shaft costs a flat $200,000 whatever its span. | **free** | Not inventing a number. Free extension may prove too cheap — build a two-floor shaft, extend it to thirty-one — but that is a *balance* finding for Keith after playing, not a parity guess. The span cap of 31 and the 8-tile separation still bound it. |
| A13 | Does a lift collide with a lobby it passes through? | `COMMANDS.md` says "elevator families and lobby spans are exempt from the dispatcher-wide floor-0 rejection precheck", which is adjacent but not the same question | **no — the lobby is exempt** | Forced by play rather than by the text. A ground lobby spans most of the lot, so counting it as an obstruction refuses every shaft that reaches the ground — which is every useful shaft. A lift lands *in* a lobby; it does not collide with one. |
| A15 | How many runtime sims does a commercial venue own? | `DEMAND.md` § Families 6/0x0c opens *"1 entity per venue"*; `facility/COMMERCIAL.md` § Included Types says *"fast food (12): **48 sim slots** plus one linked CommercialVenueRecord"* for all three commercial types | **48** | `COMMERCIAL.md` gives the count per family beside the linked-record allocation, which is the more specific statement, and the reference implementation allocates 48 as well. The number is load-bearing rather than cosmetic: these sims are the venue's *customers*, and the daily capacity limit is what decides how many of them travel. With one entity the capacity limit could never bind, the visitor-count bands (25/35/50) could never be reached, and the whole customer-count readiness model in `FACILITIES.md` § Commercial Readiness would be inert. |
| A16 | How many tiles wide is a fast food? | **Not stated anywhere in `specs/`.** No facility's tile span appears in the spec set at all | **16** — the reference *implementation*'s `TILE_WIDTHS` | It is the only place a number was recovered. Noted rather than hidden: the same table says an office is `9` where `facility/OFFICE.md` says `6` and this build says `6`, so the table is not unimpeachable — but for fast food there is nothing to weigh it against. One constant, `FAST_FOOD_WIDTH`. |
| A17 | Does a commercial venue get an `eval_level`? | `FACILITIES.md` § Commercial Readiness says commercial families *"use a **separate** readiness model based on customer count"* with per-family threshold slots, and never maps it onto the office `0/1/2` grades | **it does not** — `evalLevel` stays `0xff` and the derived state (0..3 by 25/35/50 visitors) lives on the venue record | Inventing a mapping would put a number in the field that closes an office (`eval_level == 0`) with no rule behind it. Nothing reads it today: checkpoint 2533's sweep walks `offices(tower)` only. |
| A18 | Which way does a venue's own customer travel first? | `DEMAND.md`'s one-line dispatch table says *"0x20/0x60 \| venue floor → lobby"*; the reference implementation routes `LOBBY → floor_anchor` from the same handler address | **lobby → venue** | State `0x20` is where the venue's daily capacity is spent and where the arriving visitor **acquires a slot**, and a slot can only be acquired at the venue. The implementation's direction is the only one the rest of the machine is consistent with. The round trip is the same pair of legs either way, so the lift load is unchanged; what moves is where the dwell and the occupancy sit. |
| A19 | How long is lunch — 16 ticks or 60? | `facility/OFFICE.md` § Parity: Worker Loop says *"venue dwell uses a fixed 16-tick hold"*; `facility/COMMERCIAL.md` § Availability blocks the slot release until the family's minimum stay, which its tuning table gives as `60` for every commercial type | **both, as one `max()`** — so 60 at a real venue, 16 when there is no record to release | They are two different rules, not two values for one: the 16 is the office's own gate, the 60 is the venue's. Enforcing only the 16 lets a worker walk out still holding a seat, and the venue then counts a diner who is not there. The 16 is not dead — it binds when a venue is demolished with somebody eating in it, which is the only way to reach the dwell with no record. If the venue gate is ever found not to apply to office workers, lunch becomes 16 ticks and nothing else changes. |
| A20 | The no-fast-food fallback's fake queued-car sentinel | `facility/OFFICE.md` § Route to Lobby Fails writes `0x41` with `entity[+8] = 0xff`, returns `0x40` so the caller sees no failure, and lets the route delay expire into `0x05` | **write `0x05` immediately** | The spec's own § Net Effect for that branch is *"the worker skips the lunch cycle entirely and enters evening departure"*, and `0x05` holds at its gate until daypart 4 either way — so the sentinel buys a delay nothing can observe, at the cost of a fake carrier token in a build whose token values mean something. ⚠️ The venue index itself is `null` here and never `-1`: the reference reads `-1` back as a floor, and ours are logical floors where `-1` is B1. |
| A21 | `0x20` result 3 sends occupant != 0 to "`0x01` or `0x02`" — which? | `facility/OFFICE.md` § Dispatch Table gives both without choosing | **`0x01`** | `0x01` is the row that *picks* a venue; `0x02` is the row that continues toward one already chosen, and a worker arriving at its desk has not chosen one. (The reference implementation agrees and says why: `0x02` is a star-3 medical-trip variant, and there is no medical family in this build.) |
| A14 | Which offices get their trip counters reset on the 3-day pass? | The reference resets inside `activate_family_cashflow_if_operational` — so **only operational units** | **every office, operational or not** | Gating the reset on `occupied_flag` deadlocks the tower: a failing office is deactivated, which clears the flag, which blocks the reset, which freezes its stress at grade 0 forever, so the flag never returns and not one of its workers tries again. Measured: every office dead from day 2 of a nine-day run. Ungating it is what makes a tower **recoverable** — fix the lifts and tenants come back within a cycle. |

### ⚠️ A11 is cited in the source and missing from the table above

`sim/state.js`'s `initialUnitStatus` says *"Recorded as `spec/DEVIATIONS.md`
A11"* and there is no A11 row. Whatever it said is lost; the reasoning survives
in the function's own comment. Flagged rather than renumbered, because
renumbering would break the other citations.

**A7 and A8 turned out to be decidable after all** — Keith's instinct, 2026-09-02:
ask the reference before asking a human. Both had answers sitting in files
nobody had grepped. A10 below is the third.

### A9 is the highest-consequence guess in the build

If it is wrong, the symptom is *uniformly maximal stress on every elevator
rider* — identical across tenants and insensitive to how good the lifts are,
which reads as "the clamp is working" rather than as a bug. `stress.js` has a
test named *"a cleared stamp reads as tick zero, and charges the whole day"*
pinning that arithmetic, so the consequence stays visible.

**It degrades correctly for service carriers, which is evidence for it.**
`accumulateElapsedDelayIntoCurrentSim` returns early for a service carrier and
leaves `last_trip_tick` **stamped** rather than clearing it. So there is nothing
to re-arm, and the ruling needs no special case — the re-stamp is skipped
alongside the accumulate it pairs with, and the arrival rebase's single sample
covers wait-plus-ride as one span instead of two. The consumer is one line, and
both halves move together for the same reason:

```js
accumulateElapsedDelayIntoCurrentSim(sim, dayTick, { sourceFloor, lobbyHeight, carrierMode });
if (carrierMode !== CARRIER_SERVICE) stampRouteStart(sim, dayTick);
```

A reading that needed a special case for the one carrier type the reference
excludes would be a worse reading.

The 10-bit `elapsed_packed` ceiling was investigated and found **not observable**:
every writer clamps to 300 first, and 300 < 1024. The packing is preserved
anyway because the high 6 bits carry flags the reference never names and a save
has to round-trip them. A test pins the case that proves it — a 128-floor stair
climb is 4,480 ticks, and `4480 & 0x3ff` is 384, a plausible-looking number that
is not what the reference stores.

---

## What does not belong here

- **Presentation.** Art, camera, sound, UI layout and the clock's typography are
  free. The reference's own `OVERVIEW.md` grants the same freedom.
- **Storage.** Save format is ours; the reference persists differently.
- **Naming.** Their `unit_status` byte bands can be semantic fields here, so
  long as the behaviour matches.

## What does belong here

Anything that changes an outcome: thresholds, timings, capacities, gate
conditions, payouts, star requirements, routing rules, the tick model.

If the reference is ambiguous rather than different, that is not a deviation —
cite `specs/PARITY-NOTES.md` or `specs/GAPS.md` and say what was assumed.
