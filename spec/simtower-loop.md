# The core loop — SimTower's, and the plan to actually have one

Captured 2026-09-02 with Keith, after the fourth or fifth time he hit the same
wall while playing. His own diagnosis, and the reason this file exists:

> "I was attempting to add to the loop without having it first."

`spec/simtower.md` is the *bottleneck* teardown and it is still correct. This
file is the half that was never written: **how a tower gets tenants at all.**

---

## 1. Why we kept crossing the same bridge

It was not ignorance of SimTower. It was a decision, recorded in
`spec/lift-vision.md`:

> **SimTower's bottleneck, SimCity's appeal-shaping, none of SimTower's
> micromanagement.** *Not a clone.*

So Lift's tenant model was invented on purpose — appeal scores, desirability,
a leasing-capacity curve, first-let vs re-let bars. There was no reference that
could settle "is this right?", because by design it wasn't SimTower's.

**Keith's ruling, 2026-09-02: that identity is withdrawn.** The game he wants
is very close to SimTower. This file supersedes the identity sentence above;
`lift-vision.md` needs the same edit.

## 2. Where the rules came from

[`phulin/tower-together`](https://github.com/phulin/tower-together) — MIT,
TypeScript, updated May 2026. A reimplementation whose stated goal is that
*"given the same input sequence, the reimplementation produces byte-identical
state to the original binary on every tick"*, validated by replaying captured
gameplay from the original binary under emulation. Its `specs/` directory holds
reverse-engineered behaviour with Ghidra addresses, gate tables marked
**binary-verified**, and a correction log where the authors found their own
earlier spec wrong against the disassembly.

Cloned for reference at `C:/dev/GitHub/phulin/tower-together`. MIT means we may
read it, port from it, and credit it.

The two other open-source clones are not useful:
[OpenSkyscraper](https://github.com/fabianschuiki/OpenSkyscraper) (halted 2013,
listed unplayable) and [OpenTower](https://github.com/binarybird/OpenTower)
(a stub).

## 3. The loop, in one sentence

**Your elevator network doesn't just serve your tenants — it decides whether you
have any.**

## 4. The loop, in seven steps

1. You place an office. **Six workers exist immediately** — parked, unemployed,
   before anything is rented. They are persistent state machines, created at
   placement, not spawned per trip.
2. Each tick every worker rolls dice against its state's gate
   (`rand() % N == 0`, evaluated per entity service tick).
3. When a worker is allowed to move, the game asks the router: *can this person
   get from the lobby to that office?*
4. **If the route resolves, the office rents.** That is the move-in: population
   `+6`, recurring rent begins. If it does not resolve, nothing happens — the
   worker stays parked and tries again later, and the office sits "For Rent"
   because nobody could reach it.
5. Once rented, those same six run a daily state machine: commute in (staggered
   by occupant index — worker 0 first, the rest later), work, lunch trip to a
   fast-food venue, return, evening departure. **Every leg is a real routing
   request.**
6. Evaluation is the **average of how the workers' actual trips went**, adjusted
   by rent tier and a local noise penalty. It grades to `0`, `1`, or `2`.
7. **Grade `0` closes the office**: rent stops, population `−6`, back to "For
   Rent". A low-but-nonzero grade keeps the tenant. One bad commute never
   evicts anyone.

The thing to notice in step 6: SimTower's evaluation is not computed from
properties of the room. **It is the lived experience of the people in it.** That
is what makes the loop tight — one quantity, measured from real simulated trips,
drives occupancy, which drives traffic, which drives that quantity.

## 5. Numbers worth having

| Thing | Value |
|---|---|
| Workers per office | 6 |
| Office rent tiers | tier 0 `$15,000` · **tier 1 `$10,000` (default)** · tier 2 `$5,000` · tier 3 `$2,000` |
| Rent tradeoff | higher rent → more income **and** more dissatisfaction pressure |
| Day length | 2600 ticks, 7 dayparts of 400 |
| Daypart meaning | `0` early morning · `1` morning · `2` late morning · `3` midday · `4` afternoon · `5` evening · `6` night. `daypart < 4` is the "morning" behavioural period |
| Noise penalty | commercial/entertainment neighbour within 10 tiles, **local not tower-wide** |
| Cashflow cadence | activation/deactivation cashflow only on `day_counter % 3 == 0` |
| Eval grades | `0` closes · `1` open, lower band · `2` strong |
| Grade thresholds | **star-rating dependent** — the bar tightens as the tower grows |
| Star gates | population **and** a checklist: `2→3` security office placed; `3→4` office placed + recycling adequate + office-service evaluation passed + route viable |

### The clock is piecewise, and that is a design lesson

The original does **not** map ticks linearly onto 24 hours:

| Daypart | Ticks | Displayed |
|---|---|---|
| 0 | 0–399 | 7:00 AM – 11:59 AM |
| 1 | 400–799 | 12:00 PM – 12:29 PM |
| 2 | 800–1199 | 12:30 PM – 12:59 PM |
| 3 | 1200–1599 | 1:00 PM – 4:59 PM |
| 4 | 1600–1999 | 5:00 PM – 8:59 PM |
| 5 | 2000–2399 | 9:00 PM – 12:59 AM |
| 6 | 2400–2599 | 1:00 AM – 6:58 AM |

**The game spends its ticks where the decisions are.** The whole morning is one
daypart; lunch gets two dayparts covering 59 displayed minutes. Lift maps `tod`
linearly to 24h, which is why our "morning rush" lands at 01:55–06:14 and why
Keith read it as "everyone moved in at 6am".

## 6. Where Lift diverges today

| Rule | SimTower | Lift |
|---|---|---|
| Office = one tenant, 6 workers, all-or-nothing | yes | **same** ✅ |
| **Move-in trigger** | a worker's lobby→office route resolves | appeal ≥ 20, nightly cap `2 + population×0.2`, 1–2 day wait |
| People before lease | 6 workers exist from placement | people spawn only for occupied rooms |
| Arrival timing | per-worker dice, staggered by occupant index | all 6 pre-scheduled, skewed to the start of the rush |
| Evaluation | average of the occupants' real trip outcomes + rent + local noise | sum of room properties: view, layout, mix, services, fit, renovation, rent, noise, access |
| Closure | eval grade hits `0` | stress + desirability pressure + vacate jitter |
| Day model | 7 dayparts, piecewise clock | linear `tod` → 24h |
| Star gates | population + checklist | population only |

## 7. The plan

### Keeps — untouched
- The tower view: camera, art, sprite pipeline, build palette, minimap,
  underground. All of it is about *drawing* a tower and survives a sim change.
- Saves — the snapshot is shape-agnostic; only `SAVE_VERSION` bumps.
- The harness: `run`, `sweep`, `tune`, the lab. This is the rig that will prove
  the new loop, and it is game-agnostic by design.
- Elevator physics — shafts, cars, capacity, door time, dispatch. Worth
  reviewing against their `ELEVATORS.md`, but the shape is right.
- `applyAction`, determinism, the seeded rng.

### Cuts — the invented tenant model
- `unitEvaluation`'s property-sum appeal, and most of `sim/evaluation/`.
- `leasingForecast`: the capacity curve, `firstLetMinScore`, `relistMinScore`,
  `vacancyBufferDays`, market/mix/experience demand bonuses.
- `config.occupancy` dampers: `moveInFullFlowRate`, `moveInCapacityMax`,
  `vacateJitterRange`, `graceJitterDays`, `desirabilityRetentionRampFloors`.
- The day-close leasing batch.
- The dev-sidebar panels that exist only to explain the above.

### Builds — in this order, each provable in the harness
1. **Dayparts.** Replace linear `tod` with 7 dayparts and the piecewise clock.
   Smallest change, unblocks everything else, immediately fixes the 2am rush.
2. **Persistent people.** Six workers created at placement, each a state
   machine with an occupant index. This is the big one.
3. **Move-in by routing.** Delete the leasing batch; an office rents when a
   worker's route resolves. **After step 3 the loop exists** — everything below
   is refinement.
4. **Evaluation from lived experience.** Average the occupants' trip outcomes,
   adjust by rent tier and local noise, grade `0/1/2`, close on `0`.
5. **Star gates** as population + checklist.
6. Re-point the UI at whatever survived.

The gate on every step is the existing invariant: **knowing the bottleneck must
still beat ignoring it**, and by a wider margin than before, since transport is
now the thing that decides occupancy at all.

## 8. Open questions for Keith

1. **Branch or second game folder?** The repo is a multi-game rig
   (`src/games/<name>/` + a manifest), so a clean `tower/` beside `lift/` is
   what the architecture was built for — but the renderer and art live under
   `lift/` and are keyed to its state shape. Recommendation: **a branch**,
   rebuilding the tenant model in place, so the tower view comes along for free
   and `main` stays playable. Split into a second game only if the state shapes
   genuinely diverge.
2. **How far does "very close to SimTower" go?** Some mechanics are faithful but
   strange — offices "pairing" with a same-floor neighbour, the 3-day cashflow
   cadence, `calendar_phase_flag` blocking dispatch on certain days. Clone them,
   or keep the loop and drop the oddities?
3. **What happens to the dev sidebar?** Most of it reads the system being cut.
   It was already gated on a recorded playthrough (issue #9); this may retire it
   sooner.
