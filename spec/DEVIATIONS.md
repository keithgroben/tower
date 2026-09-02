# Deviations from the reference

**Keith's ruling, 2026-09-02: 100% faithful to start.**

Every place this build knowingly differs from the reference goes here, with a
reason. Silent deviation is the failure mode this repo was created to escape —
the previous version diverged early, undocumented, and no one could ever settle
whether a mechanic was right.

A row here is not a defeat. It is the difference between a decision and a drift.

| # | Rule | Reference | Ours | Why | Decided |
|---|---|---|---|---|---|
| D2 | **What a condo's sale trip aims at when the tower has no commercial venue** | `facility/CONDO.md` § Sale Trigger makes the sale strictly conditional on a *venue* trip: the selector picks a restaurant (`1`) or fast-food (`2`) bucket, and *"if that helper returns `0xffff`, no sale happens"*. **Neither family exists in this build.** | the **lobby**, but only while the tower holds no venue of any kind | Implemented literally, every condo ever placed bounces on the service lookup and **no condo can ever sell** — the family becomes a palette button that takes $88,000 and returns nothing, and the refund mechanic it exists for is unreachable and unmeasurable. The lobby preserves the property that spec section is actually about: *"a condo sale is not driven by mere structural connectivity. The sale fires only when the resident sale path reaches a sale-eligible route result."* A condo above the top of the lift still cannot route to the lobby, and still does not sell — measured. **Self-retiring:** the moment one venue is placed, `facilityServiceFloor` finds it and the fallback is never reached again. Delete it when family `6`/`0x0c` lands. | 2026-09-02 |
| D1 | Multi-floor lobby premium rate | **Not stated anywhere.** `ECONOMY.md` § Floor Construction Premium says the path multiplies "the recovered high-band base rate" by `lobby_height` without giving that rate; `facility/LOBBY.md` points back at `ECONOMY.md` "for the exact pricing". The two cite each other in a circle, and the reference *implementation* does not implement the premium at all. | `$500`/tile — the floor-tile base rate — giving `$1,000`/tile at height 2 and `$1,500` at height 3 | It is the only recovered per-tile rate in the whole spec set (`facility/METRO.md` derives a per-floor base as `span × YEN[0]`). And `rate × lobby_height` then really is a premium over the normal $500, which is what the spec says the mechanic is *for*. **This is an invented number** — one constant to change if the real one is ever recovered. | 2026-09-02 |

⚠️ **D2 is the only rule in the build that exists because something else does
not.** It is not a tuning choice and it is not permanent — it is a stand-in for
`route_entity_to_facility_service`'s restaurant and fast-food buckets, and it
switches itself off the instant a venue is placed. Keith should know it is
there, because until commercial lands, "can a condo sell?" is really asking
"can a resident reach the lobby?".

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
| A14 | Which offices get their trip counters reset on the 3-day pass? | The reference resets inside `activate_family_cashflow_if_operational` — so **only operational units** | **every office, operational or not** | Gating the reset on `occupied_flag` deadlocks the tower: a failing office is deactivated, which clears the flag, which blocks the reset, which freezes its stress at grade 0 forever, so the flag never returns and not one of its workers tries again. Measured: every office dead from day 2 of a nine-day run. Ungating it is what makes a tower **recoverable** — fix the lifts and tenants come back within a cycle. |
| A11 | What `unit_status` does a freshly placed unit start in? | `facility/OFFICE.md` § Parity: Placement And Stored State says *"rental status = open-band value `0`"* — which contradicts the same file's "new offices start vacant" **and** its own dispatch table, whose `0x20` rows test vacancy as `unit_status >= 0x10` and would never fire "if vacant" for an office placed at `0` | **office `0x10`; hotel and condo in the unsold band, `0x18` before daypart 4 and `0x20` after** | The reference's own implementation settles it and says so in a comment: *"Office starts at 0x10 (unoccupied). Others start at 0."* Caught because a test asserted a placed office is not rented and it was — `isRented(0)` is true. *(Recorded late: `sim/state.js` has cited this row since it was written and the row itself was never added.)* |
| A15 | **The condo countdown does not net −1 per cycle.** `facility/CONDO.md` says a full cycle is *"2 decrements + 1 increment = net −1 step of progress toward the `0x10` sync sentinel"* | `PEOPLE.md` § Family 9's per-state table gives exactly **one** `DEC` (on the `0x01` dispatch) and an `INC` on nearly every terminal transition — `0x10` calendar-odd, `0x20` bounce, `0x21` "fail or arrived", `0x22` "fail/arrived". Those compose to a net **climb** on a normal day; only the calendar-phase path (`even → 0x01`, `odd → INC → 0x04`) actually nets −1 | **the per-state table**, with the countdown clamped into its band and re-clamped to `0x10` nightly | `DEMAND.md` labels the per-state tables "binary-verified"; the "net −1" sentence is `CONDO.md` summarising them, and it hedges two lines later (*"roughly one countdown step per full morning cycle"*). Following the summary would mean deleting stated `INC`s. **The discrepancy is unobservable**: every value from `0x00` to `0x17` is equally *sold*, and the checkpoint-2500 clamp resets the counter to `0x10` every night before it can drift anywhere. |
| A16 | What is family 9's `pairing_pending_flag`, which gates the `0x20` sale dispatch? | `DEMAND.md` and `PEOPLE.md` both name it in the family-9 `0x20` gate row and neither defines it for this family. `facility/HOTEL.md` defines it for hotels as the **housekeeping claimant's latch**, and condos have no housekeeping | **`occupied_flag`** | `FACILITIES.md` § occupied_flag says it outright, in one sentence covering both families: *"When clear, the **family-7/9** gate blocks worker dispatch (state 0x20)."* Family 7's own gate row in `DEMAND.md` spells the same condition as `occupied_flag == 0`, so the two families' `0x20` rows are the same rule under two names. |
| A17 | **What enters family-9 state `0x21`?** | Nothing says. `DEMAND.md`'s ASCII lifecycle draws `0x00 → 0x01`, which leaves `0x21` with no entry point at all; `ROUTING.md` § emit_distance_feedback Gating groups *"0x21, 0x22 (return trips)"* against *"0x00, 0x01, 0x20 (outbound trips)"*, which pairs each outbound leg with a return | **`0x00` arriving hands off to `0x21`**, giving two complete daily paths: `0x10→0x00→0x21→0x04` and `0x10→0x01→0x22→0x04` | Family 7's table settles the shape: its `0x00/0x40` row reads *"`3` → write `0x21`"* — an outbound leg arriving hands off to `0x21` — and `sim/office.js` already implements exactly that. The tables are the binary-verified half; the ASCII diagram is prose. This reading reaches **every** state in the family's table and honours every stated transition, where the diagram's leaves one specified state permanently dead. |
| A18 | Family-9 state `0x00` has **no route-result row** | `PEOPLE.md`'s family-9 dispatch table gives result mappings for `0x10`, `0x01`, `0x20`, `0x21`, `0x22` and `0x04` — every state but this one. `DEMAND.md`'s row says only "condo floor → outbound" | **the shape every other family-9 row uses**: `-1` → bounce to `0x04`; `0`/`1`/`2` → `0x40`; `3` → the arrival state (`0x21`, per A17). No `unit_status` step, because no row gives it one | Four of the five stated rows share that shape exactly. Inventing a `unit_status` effect for the one row that does not state one is how a countdown drifts, so the step is `0` rather than a guess. |
| A19 | What happens when the condo countdown steps past the edge of its band? | Silent. The reference stores an unsigned byte and seeds the countdown at `3`, so it never has to say | **clamped inside whichever band the unit is currently in** — `[0, 0x17]` when sold, `[0x18, 0x27]` when not | Both naive answers are dangerous, in opposite directions. A global clamp to `0x17` turns an unsold condo's bounce at `0x19` into `0x17` — **which sells it, for $0, by arithmetic**. A byte wrap at `0` turns a sold condo into `0xff`, the extended-vacancy band, contradicting `CONDO.md` § End-of-day (*"sold condos do not revert to the unsold band at day end"*). Making the band the boundary is what keeps `finalize_condo_sale` and `revert_condo_to_unsold` the only two things that can cross it — which is what makes the sale one-shot. |
| A20 | What does the `0x04` sync's *else* branch do? | `PEOPLE.md`: *"if `unit_status & 7 == 1` → shortcut `unit_status = 0x10`; else check all 3 siblings at 0x10"*. `try_set_parent_state_in_transit_if_all_slots_transit` sets a *parent state*; no spec line says which field that is or what reads it | **nothing** — implemented as the shortcut only, with a `TODO(parity)` in `sim/condo.js` | The obvious guess ("all three siblings synced also forces `unit_status = 0x10`") is **refutable**: it would fire after one cycle every time, making the `& 7 == 1` clause dead code and contradicting `PEOPLE.md`'s own *"after ~2 cycles from 3, unit_status reaches 1 → sync shortcut"*. A branch with no observable consequence is better left visibly unimplemented than filled in with a rule that deletes a stated one. |
| A21 | `TIME.md` § 2500's object-state floor pass labels family `9` **"escalator"** | Its three rows are labelled "hotel (3/4/5)", "elevator (7)" and "escalator (9)". Those are placed-object **type** codes, where `3/4/5` is hotel, `7` is office and `9` is condo — so two of the three labels are wrong and the codes are right | **the codes** — row `9` clamps sold **condos** (`unit_status < 0x18`) to `0x10` | `facility/CONDO.md` § End-of-day reset behavior reads the same pass the same way, naming condos explicitly. Refines A7: where a summary table's label disagrees with a family file, the family file wins. Only the condo row is implemented here — the office row belongs to that family's owner. |
| A22 | **A condo's tile span** | **Not stated anywhere in the spec set.** `facility/OFFICE.md` states the office's outright (*"refreshes the 6-tile span"*); nothing states this one | **16 tiles** — the reference *implementation*'s `TILE_WIDTHS.condo`, taken unscaled | It is the only recovered figure. The same table calls an office `9` where we use `6`, because `OFFICE.md` states 6 and the spec beats the implementation (A6) — so a condo here is 2.7 offices wide against their 1.8. Scaling to fit would be a number of **our** invention, which is worse than one of theirs; this way exactly one source is being quoted. One constant to change if a real span is ever recovered. |

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
