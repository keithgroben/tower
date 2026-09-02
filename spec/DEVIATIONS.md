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
| A6 | Shaft construction price | The reference's binary-derived table says `0x01` $200,000 / `0x2a` $400,000 / `0x2b` $100,000, but the reference's own *implementation* charges a flat $200,000 for all three | **the table** | The table came from the original binary; the implementation may have simplified. Where a reference contradicts itself, prefer the half that was recovered from the thing we are actually copying. |
| A5 | Sky-lobby floors | `ELEVATORS.md` + `DATA-MODEL.md`'s worked example give logical 14/29/44; `DATA-MODEL.md` prose says 15/30/45 | **14/29/44** | The EXE-derived value comes with its own arithmetic (`(exe − 10) % 15 == 14`) and an explicit translation example (EXE 24 ⇒ logical 14). The prose reads like a human-facing round number — logical 14 is the fifteenth storey if you count the ground floor as one. One constant if it flips. |

| A9 | **What re-stamps `last_trip_tick` between carrier assignment and arrival?** Two functions consume it and each clears it; nothing in `ROUTING.md`, `PEOPLE.md` or `ELEVATORS.md` re-arms it in between | silent | **boarding re-stamps** | The other two readings are refutable. *"The arrival rebase isn't reached"* contradicts `PEOPLE.md` § When Counters Advance, which names the queued-car arrival callback explicitly. *"The assignment-time accumulate isn't reached"* deletes the tall-lobby rebate, which is applied only there — multi-storey lobbies would become pure decoration. Only this reading leaves **both** documented call sites reachable *and* meaningful: the accumulate measures the wait on the floor, the rebase measures the ride. It also generalises a rule the spec already states once — the resolver ends by stamping — into "every event that consumes the stamp re-arms it for the next segment". |

⚠️ **A9 is the highest-consequence guess in the build.** If it is wrong, the
symptom is *uniformly maximal stress on every elevator rider*, identical across
tenants and insensitive to how good the lifts are — which reads as "the clamp
is working" rather than as a bug. `stress.js` has a test named *"a cleared stamp
reads as tick zero, and charges the whole day"* pinning that arithmetic, so the
consequence is visible if we ever have to revisit it.

| A7 | Metro station construction cost | `ECONOMY.md`'s table says `$1,000,000`; `facility/METRO.md` derives `$45,000` (`3 × 30 × YEN[0]`, per-object cost zero) and the reference implementation ships `$45,000` | **⏳ open — Keith's call** | A 22× swing on a four-star purchase. `$1,000,000` is *exactly* the metro's `$100,000` operating expense × 10, which smells like a transcription slip in the table. Currently the table value, on the A6 principle — but this one is big enough to want a human. Not on the build path yet. |
| A8 | Can the tower go broke? | The specs document a cash **ceiling** and mention bankruptcy nowhere. The reference implementation clamps cash at 0 — but it also clamps the income *ledger* at 0, where clamping is plainly defensive rather than meaningful | **⏳ open — Keith's call.** Cash currently allowed to go negative | This is a game question, not a parity one: whether losing is possible is a design decision. |

**A7 and A8 need Keith.** Everything else on this page was decidable from the
reference; these two are not.

---

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
