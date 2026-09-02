# The tick model

Read from the reference (`specs/TIME.md`, `specs/PEOPLE.md`, `specs/DEMAND.md`)
on 2026-09-02, before writing any simulation code. See
[`REFERENCE.md`](REFERENCE.md) for provenance and the pinned commit.

This is what a faithful engine has to reproduce. Numbers here are the
reference's, not ours — changing one is a deviation and belongs in
[`DEVIATIONS.md`](DEVIATIONS.md).

---

## 1. The headline: stress is one number

Everything a player does to a tower is measured through a single scalar, per
person:

```
stress = accumulated_elapsed / trip_count        // 0 when trip_count == 0
```

**Average ticks spent in transit per trip.** That is the whole quality model.
No appeal score, no desirability, no weighted sum of room properties — one
number, and it is *time the occupant spent waiting and travelling*.

A facility's evaluation is that number averaged across its own occupants (an
office has 6), then adjusted for rent tier and a noise penalty from neighbours
within 10 tiles.

Visible bands, from the original manual:

| Stress | Colour | Meaning |
|---|---|---|
| `< 80` | black | low |
| `80–119` | pink | moderate |
| `120–300` | red | high |

Any single leg is clamped to **300 ticks**, so one catastrophe cannot dominate
a person's history.

### What adds stress

| Cause | Cost |
|---|---|
| **No route found** | **300 ticks** — the clamp, i.e. maximally bad |
| Distance penalty | 30 or 60 ticks (gated per state; see `ROUTING.md`) |
| Queue full, waiting | 5 ticks |
| **Stairs** | **35 × floors traversed** |
| **Escalator** | **16 × floors traversed** |
| Lobby boarding, lobby height 2 | **−25 ticks** |
| Lobby boarding, lobby height 3 | **−50 ticks** |

Two things fall out of that table and both are worth pausing on.

**Stairs versus escalator is *only* this.** Both traverse in a single
entity-refresh stride — the same 16 ticks of wall time. The entire mechanical
difference between them is that stairs accrue 35 stress per floor and an
escalator 16. That is the whole system. Lift modelled local routes with their
own capacity, overflow seconds, queue peaks and route-occupancy history; the
original just charges more stress per floor.

**A tall lobby is a stress discount.** The reduction only applies to trips
*departing the lobby floor* on a non-service carrier. That is what multi-storey
lobbies are *for* — not decoration, not capacity, a −25 or −50 tick rebate on
every morning commute.

Counters reset on the 3-day cashflow pass and on first reopen after a vacancy,
so evaluation is a rolling judgement, not a lifetime record.

### Why this closes the loop

A trip that cannot be routed costs 300 — the maximum. Bad transport therefore
drives stress straight to the top of the red band, which fails the evaluation,
which evicts the tenant. **Transport failure is not one input into occupancy.
It is the dominant one, by construction.**

---

## 2. The clock

- `day_tick`: `0..2599`
- `daypart_index = floor(day_tick / 400)` → `0..6`
- `day_counter`: increments at **tick 2300**, not at the wrap
- `calendar_phase_flag = ((day_counter % 12) % 3) >= 2`
- `daypart_index < 4` is the "morning" behavioural period

| Daypart | Ticks | Label | Displayed clock |
|---|---|---|---|
| 0 | 0–399 | early morning | 7:00 AM – 11:59 AM |
| 1 | 400–799 | morning | 12:00 PM – 12:29 PM |
| 2 | 800–1199 | late morning | 12:30 PM – 12:59 PM |
| 3 | 1200–1599 | midday | 1:00 PM – 4:59 PM |
| 4 | 1600–1999 | afternoon | 5:00 PM – 8:59 PM |
| 5 | 2000–2399 | evening | 9:00 PM – 12:59 AM |
| 6 | 2400–2599 | night | 1:00 AM – 6:58 AM |

The clock is **piecewise on purpose**: daypart 0 alone spans five displayed
hours, while dayparts 1 and 2 together cover 59 displayed minutes. The game
spends its ticks where the decisions are, and slows the clock through lunch.
Lift mapped ticks linearly onto 24 hours, which is why its "morning rush"
landed at 01:55.

**The tick wrap and the day advance are 300 ticks apart.** `day_counter`
increments at 2300; `day_tick` wraps at 2600. Ticks 2300–2599 are an overnight
window carrying the *new* day number under a night sky.

A new game starts at `day_tick = 2533`, `day_counter = 0` — so the player sees
a brief night, then dawn. 2533 is also the quarterly-expense checkpoint, so the
first day opens on a clean ledger.

---

## 3. Tick order

Exact, every tick:

1. increment `day_tick`
2. recompute `daypart_index`
3. increment `day_counter` at the end-of-day boundary
4. wrap `day_tick` after the full daily range
5. early event hooks for the new tick — `news` **then** `VIP`, when eligible
6. checkpoint body, if `day_tick` matches a checkpoint
7. entity refresh stride (skipped when paused)
8. carrier tick for every active car

Hooks run before the checkpoint body on the same tick; checkpoints run before
entity refresh. **Entities serviced in the stride see state a checkpoint
already modified this tick.**

---

## 4. The entity refresh stride

The simulation does **not** update every actor every tick. It services one
sixteenth of the actor table per tick:

- stride start = `day_tick % 16`
- visit indices `start, start + 16, start + 32, …`
- **raw table order** — not grouped by family, floor, or subsystem

Every actor is therefore serviced once per 16-tick window. This matters for
more than performance: it fixes RNG consumption order, so replay depends on
table order, not on any tidier grouping we might be tempted to impose.

---

## 5. RNG

32-bit linear congruential generator:

```
state = (state * 0x015a4e35 + 1) mod 2^32
value = (state >> 16) & 0x7fff
```

- initial state `1`; no reseed happens during normal play
- persist the 32-bit state for replay across save/load
- gates are stochastic: `rand() % N == 0` gives a **1/N chance per entity
  service tick** — *not* per game tick, and never keyed off `day_counter`

Consumption order, which replay depends on:

1. command application (may consume before the next tick)
2. per-tick hooks: news before VIP
3. checkpoint bodies (at checkpoint 240: fire before bomb)
4. entity refresh, in raw table order

---

## 6. The actor model

Every actor is a 16-byte record with a `family_code` and a `state_code`. The
state byte is banded:

| Band | Meaning |
|---|---|
| `0x0x` | idle / waiting / ready to decide |
| `0x2x` | support cycle, venue visit, checkout |
| `0x4x` | in transit, for the matching `0x0x` state |
| `0x6x` | in transit, for the matching `0x2x` state |
| `0x27` | parked / night — in the `0x2x` band but terminal to the gate |

**Bit 6 (`0x40`) is the in-transit flag.** Base state is `state & 0x3f`.

Per serviced actor:

- `state < 0x40` → consult the family's **gate** (daypart, tick, RNG, own
  fields). Gate allows → call **dispatch**. Gate denies → return, unchanged.
  Some gates rewrite state directly without dispatching.
- `state >= 0x40` → dispatch **unconditionally** until the leg completes.

So the gate is a **one-time barrier**. Once committed to a route the actor is
serviced every stride until it arrives. That is why a person who cannot be
routed simply stays put and retries later — there is no "abandoned trip"
bookkeeping, because a person is a persistent state machine, not a scheduled
event.

Routing contract: the family owns *intent*, the routing layer owns *movement*.
Family picks a destination → requests one leg → result `0/1/2` puts it
in-transit, `3` is a same-floor arrival handled immediately, `−1` is failure and
the family decides the fallback.

`occupant_index` staggers trip timing, venue choice and activation order, so a
facility's occupants never move as one block.

---

## 7. Checkpoints that matter to us

Full list in `specs/TIME.md`; these are the ones an office-and-elevator build
needs.

| Tick | Does |
|---|---|
| `0` | start of day: normalise state bytes, rebuild the reachability/path tables |
| `2300` | increment `day_counter`, recompute `calendar_phase_flag` |
| `2500` | runtime refresh sweep — **office sims reset to `0x20`**, route fields cleared |
| `2533` | ledger rollover, cashflow activation, periodic expenses |

**Cashflow only moves on `day_counter % 3 == 0`.** Because checkpoint 2533 runs
after 2300, a fresh game first hits it at `day_counter == 3`. Rent is not daily.

Operating expenses on that 3-day pass:

| Item | Cost per pass |
|---|---|
| Express car | `$20,000` |
| Standard car | `$10,000` |
| Service car | `$10,000` |
| Escalator link | `$5,000` × `((unit_count >> 1) + 1)` |
| Stairs link | `$0` |

Office rent tiers, recurring: tier `0` = `$15,000`, tier `1` = `$10,000`
(default placement), tier `2` = `$5,000`, tier `3` = `$2,000`. **Lower tier
number means higher rent**, and higher rent raises dissatisfaction pressure.

---

## 8. What this replaces

| Lift had | The reference has |
|---|---|
| `unitEvaluation`: view + layout + mix + services + fit + renovation + rent + noise + access | average transit time per trip, then rent tier and local noise |
| Local routes with capacity, overflow seconds, queue peaks, route history | stairs 35/floor, escalator 16/floor — a stress rate, nothing else |
| Multi-storey lobby as frontage | lobby height 2 or 3 = a −25/−50 tick stress rebate on departures |
| Trips pre-scheduled per day into a sorted list | persistent state machines, gated by dice, serviced 1/16 per tick |
| Abandoned-trip accounting | no route = 300 stress and the actor tries again |
| Daily rent | cashflow every third day |
| Linear `tod` → 24h | 2600 ticks, 7 dayparts, a piecewise clock |

## 9. Decisions — Keith, 2026-09-02

### Pacing: the reference's own, and adjustable

Wall-clock pacing is presentation, so it is free — the reference's `OVERVIEW.md`
grants it explicitly. **Not a deviation.**

Keith: *"I don't know. I want it to be fun and not rushed."* That is a question
about feel, and per `CLAUDE.md` it cannot be answered from a chart. So the
default goes to the original's measured pace and the number stays live.

`spec/simtower.md` §8 recorded the original at **~3–4 real minutes per day**.
Lift ran 45 s, chosen to compress the loop for prototyping, and that is the
"rushed" Keith is reacting to.

**Default: 12 ticks per second.**

| | at 12 ticks/s |
|---|---|
| One day (2600 ticks) | **3 min 37 s** — mid-band of the original |
| One actor's beat (16-tick stride) | 1.33 s — you watch a person decide |
| The morning (daypart 0, 400 ticks) | 33 s |
| A cashflow cycle (3 days) | 10 min 50 s |
| Lift, for comparison | 45 s/day, 0.28 s actor beat |

Speed controls stay — the original had them, so they are faithful as well as
merciful. Nobody should ever be made to wait.

**The pacing constant does not live in `sim/`.** The sim never sees wall time;
it takes ticks. Ticks-per-second belongs to the loop that drives it, alongside
the speed multiplier. Keeping that boundary is what lets the harness run a
thousand days in a second.

First thing to check in the first playtest, and a one-line change when it is
wrong.

### The 1/16 stride: keep it

Faithful, and load-bearing beyond fidelity — it fixes RNG consumption order, so
replay depends on it. Also sets a person's reaction time at 16 ticks, which is
1.33 s of felt time at the pacing above. Actors step in a rota, not all at once.

### Floor indexing: theirs — which turns out to be ours

`specs/ROUTING.md` §Floor Numbering: `logical = exe_index - 10`, so **logical 0
is the ground lobby, −1 is B1, −10 is B10**. That is already exactly what Lift
does, so the camera, the renderer and every `lowestFloor` helper carry over
untouched.

The one translation to remember: formulas quoted from the binary use **EXE**
indices. The zone-band bucket is `max(0, (exe - 9) / 15)`, which in logical
floors is `max(0, (floor + 1) / 15)`. Sky lobbies sit where
`logical % 15 == 14` — logical 14, 29, 44, 59, 74, 89, or the 15th, 30th and
45th storeys as a human counts them.
