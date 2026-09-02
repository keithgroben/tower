# Loop teardown — SimTower (1994)

Source: the DOS build, played 2026-08. The loop is excellent; the pacing and
onboarding are why it is hard to get into. This teardown separates those two
things so we rebuild the first and discard the second.

---

## 1. One sentence

Place revenue-generating units in a tower, then keep the people inside them able
to *get to* those units before they give up and leave.

## 2. Currencies

| Currency | Earned by | Spent on | Capped? |
|---|---|---|---|
| Money | Daily rent, condo sales, shop trade | Construction of every kind | No |
| Population | Occupied units | Star rating thresholds | No |
| Star rating | Population gates | Unlocking new unit types | Yes — 5 + cathedral |
| Tenant patience | — (spent by waiting) | — | Yes, per tenant |

Patience is the real currency. The other three are scoreboards.

## 3. Converters

- unit + tenant → rent/day, **conditional on commute succeeding**
- worker + elevator trip → arrival (costs *time*, which is the scarce thing)
- shopper + lunch trip → shop revenue
- money + space → more units → more trips → more elevator load

The last one is the engine: **every purchase increases the load on the thing
that is already the constraint.** That is what makes it a game rather than a
spreadsheet.

## 4. THE BOTTLENECK

**Elevator throughput — car-trips per minute across the floors people need.**

- Gets worse as you grow because average trip *length* rises with height while
  car count stays flat. Throughput per car falls exactly as demand rises.
- **Spatial.** This is the crucial property. A shaft consumes a column on every
  floor it passes, so buying throughput costs the very floor area you were
  buying throughput in order to lease. You cannot solve it with money alone.

Local elevators cap out around 30 floors, which forces the express + sky-lobby
restructure rather than letting you scale one bank forever.

## 5. Reward cadence

| Reward | Interval (original) | Feels like |
|---|---|---|
| Rent | Daily | The heartbeat |
| Condo sale | One-time, on placement | A burst — funds the next expansion |
| Star rating | Rare, population-gated | A real milestone; unlocks toys |
| Watching a queue drain | Continuous | The moment-to-moment reward |

That last row is the one that matters and the one a spreadsheet cannot model.

## 6. The walls

1. **Soft wall** — ~floor 10–15. Mornings get visibly congested. You want a
   second shaft and can just about afford one.
2. **Hard wall** — ~floor 20–30. One elevator bank cannot clear the morning
   rush. Stress spikes, offices vacate, income falls while upkeep does not.
3. **Restructure** — express elevators plus a sky lobby. Not "more of the same":
   a different topology, where locals feed a transfer floor and expresses run
   between transfer floors.

## 7. The oh-shit moment

The first morning where the lobby queue is still growing when the rush should be
ending, and you realise every office you just built made it worse. **The first
meaningful upgrade belongs exactly here.**

## 8. Time constants — original vs prototype

| Thing | Original | Prototype | Why |
|---|---|---|---|
| One day | ~3–4 real minutes | **45s** (`time.daySeconds`) | The loop has to be felt in minutes, not an evening |
| Morning rush | ~90s of real time | ~8s | Long enough to watch a queue lose, short enough to retry |
| Time to first congestion | 20–40 min | ~3 min | The oh-shit moment must arrive before patience runs out |
| Time to hard wall | Hours | ~10 min | You should hit the restructure in one sitting |
| Setup before anything happens | Menus, tutorial, empty lot | 4 floors, 1 shaft, 3 offices, pre-placed | Nobody should stare at an empty lot |

## 9. What we are NOT rebuilding

Hotels and their housekeeping cycle · parking · security and terrorism events ·
fire · metro station · the cathedral win condition · save/load · five distinct
star tiers (we use four, purely as build gates) · condo mortgage detail.

None of these touch the bottleneck. They can come back once the loop is proven.

## 10. The headless question

> **At what floor count does the wait-time curve go vertical, and does managing
> the bottleneck actually buy you runway?**

**Answered.** `node harness/sweep.js 60 5`, three policies × five seeds:

| Policy | Dies around | Reaches |
|---|---|---|
| `naive` — never buys a car | day 6–11 | 5–6 floors |
| `reactive` — buys after the pain | day 6–23 | 5–8 floors |
| `balanced` — holds a cars:offices ratio | day 32–58 | 11–25 floors |

Understanding the bottleneck buys roughly **5x the runway**, reproducibly across
seeds. The elevator is not decoration. This is now locked by a test
(`invariants.test.js`, "knowing the bottleneck beats ignoring it").

**Caveat on the question as originally posed.** The wait-time cliff detector
reports **5 floors for every policy** — the first congestion spike is early and
universal, so it does not discriminate good play from bad. Survival does. The
honest answer is therefore not "the curve goes vertical at floor N" but "it
spikes almost immediately for everyone; what differs is whether you can
*recover* from the spike." Section 6's soft wall is real, but in prototype time
it lands around floor 5 — far earlier than the original's floor 10–15.

**Open:** every policy eventually goes bankrupt. There is no long-run
equilibrium yet, so the difficulty curve is a cliff rather than a slope. That is
the next tuning question and it is a good unattended job.

## 11. The feel question

> **Is watching the queue drain satisfying, or merely relieving?**

Unanswered, and unanswerable from a chart. SimTower's whole texture is the
morning rush resolving. If draining a queue is not pleasurable in itself, the
prototype needs a different moment-to-moment reward before any more systems get
added — the same question `watering-plants` asks about the haul button.
