# Tower — agent brief

A faithful rebuild of **SimTower's core loop**. Successor to
[`keithgroben/lift`](https://github.com/keithgroben/lift), which proved the
elevator sim and the tower view but invented its own tenant model and could
never settle whether that model was right.

This file is the only agent-instruction file in the repo. Do not create
`AGENTS.md`.

## Why this repo exists

Keith, 2026-09-02, after hitting the same wall for the fifth time while playing
Lift:

> "I was attempting to add to the loop without having it first."

Lift's north star said *"SimTower's bottleneck, SimCity's appeal-shaping — not a
clone."* So its leasing was invented: appeal scores, desirability, a capacity
curve, first-let and re-let bars. Nothing could ever settle "is this right?",
because by design it wasn't SimTower's. **That identity is withdrawn.**

Read [`spec/simtower-loop.md`](spec/simtower-loop.md) first. It is the north
star. [`spec/REFERENCE.md`](spec/REFERENCE.md) says where the rules come from.

## The loop, in one sentence

**Your elevator network doesn't just serve your tenants — it decides whether you
have any.**

An office rents when a worker's lobby-to-office route actually resolves. Not
when a score clears a bar. Evaluation is the average of how the occupants' real
trips went, not a sum of room properties. One quantity, measured from simulated
trips, drives occupancy → traffic → that same quantity.

## The two rules

### 1. The sim is pure. The renderer is disposable.

- `src/games/*/sim/**` must run in Node with no stubs, no DOM, no `Math.random`.
  A test enforces it. Break this and the headless harness dies, and the entire
  point of the repo goes with it.
- `src/games/*/render/**` and `ui/**` read state and draw. They never mutate sim
  state.
- Every state change goes through `applyAction()` — human clicks and headless
  policies use the identical seam. That is what makes replay work.

Carried over from Lift unchanged, because it is the part that worked.

### 2. Faithful first, opinions later.

**Keith's ruling, 2026-09-02: 100% faithful to start.** Where the reference
spec states a rule, implement that rule — including the odd ones (same-floor
office pairing, the 3-day cashflow cadence, `calendar_phase_flag` blocking
dispatch). We earned the right to nothing else: the last version diverged early,
and every divergence became an argument nobody could win.

A deviation is legal only when it is **recorded in `spec/DEVIATIONS.md` with a
reason**. Silent deviation is the failure mode this repo was created to escape.

If the reference is ambiguous, say so, mark it `TODO(parity):` in the source
naming the spec line, and record the choice in `spec/DEVIATIONS.md` under
"Ambiguities resolved". Never pick quietly.

⚠️ The reference has **no curated list of its own gaps**. Its `specs/README.md`
advertises `PARITY-NOTES.md` and `GAPS.md`; neither file exists. So nothing
will warn you that a number is uncertain — check whether two spec files agree
before trusting one, because several already disagree with each other and one
disagrees with the reference's own implementation.

## Where you may work, by blast radius

| Path | Freedom |
|---|---|
| `spec/` | **Free.** Teardowns and notes are research. More is better. |
| `src/games/*/render/`, `ui/` | **Open.** Feel and readability. Cannot affect outcomes. |
| `src/games/*/config.js` | **Careful.** Data only — but the numbers are the reference's, not ours. Changing one is a deviation. |
| `src/games/*/sim/` | **Careful.** Changes the game. Add a test with the change, and cite the spec section. |
| `harness/` | **Careful.** Shared. Nothing game-specific belongs here. |
| `tools/` | **Open.** Developer-side utilities (art ingest). May have dependencies the game may not. |
| `test/` | **Careful.** Never weaken an assertion to make a run pass. |

## No developer sidebar

Lift grew a 5,800-line diagnostic panel and it became the way the game was read.
Keith retired it, 2026-09-02. **Do not rebuild it.** Numbers that are worth
showing go in the world or the HUD — over the room, over the queue, on the
shaft. A debugger is not an interface.

The headless harness is where diagnosis happens now. That is what it is for.

## Commands

```bash
npm test                                 # zero-dep test runner
npm run dev                              # http://localhost:5174 — Vite, the playable game
node harness/run.js tower <policy> 40 1  # one headless run: game, policy, days, seed
node harness/sweep.js tower 60 5         # all policies x seeds -> out/<game>-sweep.csv
node harness/tune.js tower <config.path> 1 2 3 4
```

`sim/` and `harness/` stay zero-dependency, zero-build, Node 20+. `npm install`
must never become required to run a test or a headless sweep. The `ui/` layer is
the one exception (TypeScript + Vite).

## The two questions, and which one you can answer

1. **Does it match the reference?** Answered by reading `specs/` and by tests
   that cite a spec section. **You can do this alone, unattended.**
2. **Does it feel good to press?** Answered only by Keith, playing. **You cannot
   answer this. Do not claim to.**

Note the change from Lift: question 1 used to be "is the math interesting", and
tuning was open season. It is not, any more. We are matching something first.

## What the old repo caught that playing would not have

Kept because each is a class of mistake, not a war story. Most were paid for in
`keithgroben/lift` — but the sentinel one has already recurred **here**, on the
first day of this repo, which is the argument for reading the list rather than
skimming it.

- **In-transit riders were deleted at midnight.** `trips` stopped equalling
  `delivered + abandoned`, and a tower failing 90% of its trips reported a
  *falling* average wait. Accounting holes read as good news.
- **Stranded riders were logged as zero wait.** A tower with no elevator posted
  the shortest queues in the sweep.
- **`null >= 0` is TRUE in JavaScript**, and so is `null?.k !== 'x'`. Both read
  as guards and are not.
- ⚠️ **A sentinel that collides with a real value.** Three instances now, two in
  `lift` and **one here, in this repo, on day one** — so treat it as the default
  hazard rather than a war story.

  The reference returns `-1` for "there isn't one" from `select_next_target_floor`
  and `choose_transfer_floor_from_carrier_reachability`. It can afford to: its
  floors are EXE-indexed `0..119` and never negative. **Ours are logical, so
  `-1` is B1** — a real, common, reachable floor. Ported literally, it produced
  two live failures: idle cars accepted "no target" as a destination and drove
  to the first basement to park, and **a rider bound for B1 could never board a
  lift**, because `if (alight < 0)` matched their legitimate destination.

  The fix is `null`, not a different negative number. A value no comparison can
  mistake for a floor — because the next person to write `< 0` will be right
  about the arithmetic and wrong about the tower.

  **Every constant quoted from the reference is in EXE floors.** Translate with
  `logical = exe − 10`, and re-check any sentinel that comes with it.
- ⚠️ **A performance-shaped symptom deserves the same suspicion as a wrong
  number.** `compute_car_motion_mode` picks a car's speed from `dist_to_target`
  and `dist_from_prev`. `prev_floor` is the last floor a car **stopped** at, not
  the last one it **passed** — it is snapshotted only at dwell expiry, and that
  is what lets `dist_from_prev` grow. The acceleration profile is hidden in a
  variable name.

  Latching it every step reads as obviously right — you *did* just leave that
  floor — and pins `dist_from_prev` at `0`. `0 < 2` is the first clause of the
  mode-0 test, so every car crawls at the slowest rate for its whole journey: a
  30-floor standard run costs **175 ticks instead of 41**, express 175 instead
  of 22.

  Nothing errored. No counter went negative. Every car arrived. The tower simply
  read as *sluggish* — and you would tune the pacing constant forever chasing
  it. **A 4x error that presents as a feel problem is worse than a crash.**

  It survived 79 passing tests, and then survived a *second* mutation round,
  because the first acceleration test called the step helper directly. **A test
  that bypasses the state machine cannot find a bug that lives in it.**
- ⚠️ **Before suppressing a zero, ask whether zero is a legal value in that
  domain or only the absence of one.** An `if (ticks === 0) return;` in the
  delay emitter looked like an optimisation. Two delays in `ROUTING.md` § Delays
  genuinely cost zero and are **not inert** — they still clear the route-start
  stamp. Treating "costs nothing" as "did not happen" silently dropped a side
  effect. This is the sentinel bug inverted: there, a sentinel collided with
  real data; here, a real value collided with the absence of one.
- **Art existed and nothing drew it, six times.** A catalogued sheet with no
  reached call site now fails a test. Preloading does not count.
- ⚠️ **Two branches under one test is the shape that hides.**
  `specs/PEOPLE.md` § Refresh handler flow splits on the **route token**, not
  on the state: a rider holding a *carrier* token is waiting for a car and must
  be left alone; one holding a *segment* token walks and goes to family
  dispatch. Both branches sit under the same `state >= 0x40` test, so reading
  the state and stopping there looks complete.

  The cost of missing it: re-asking the router while queued does not merely
  waste a call — **every re-resolution re-stamps the route start**, so the wait
  being accrued is discarded. Measured average stress read **7 where the honest
  figure was 81**, and a rider ended up occupying two slots in the same car.

  Note the direction. It failed **flatteringly** — a tower that looks perfect
  however bad its lifts are. Most of this list fails loudly; this one hands you
  a compliment. When a change makes the numbers *better*, check what stopped
  being counted.
- ⚠️ **A test that pins one side of an agreement is not a test of the
  agreement.** The build ghost and `applyAction` must always agree on whether a
  click will land. The test written to hold that asserted `preview().ok` — *its
  own output* — so when the seam started refusing shafts through occupied
  rooms, the test went on passing while the ghost said "passes through 12
  rooms" about a build the sim now refused.

  The fix is a matrix that runs **both** paths and compares them, on the
  verdict *and* the wording. Write the row first and watch it fail with
  something like *"ghost said yes and the seam said no"*; a row that has never
  failed is a row that is pinning one side.
- ⚠️ **When two modules name one concept twice, translate at the seam.** It has
  happened three times: `routeStartTick` vs `lastTripTick` for the reference's
  one `last_trip_tick`; `occupiedFlag` meaning "measured" in one place and
  "has tenants" in another; and `payout(family, …)`, whose `family` is a
  *name* (`'office'`) while `sim/state.js`'s `FAMILY.office` is a *code* (`7`)
  — so `payout(7, 1)` silently answered `0` and every office read as a room
  that does not pay rent.

  Renaming a parameter only documents the trap. **Accept both and translate**,
  or make the two one name. Asking every caller to remember which side of a
  seam they are on is how you get a bug that reads as a working feature.
- **A rule written in four places drifts.** The stairs column rule lived in the
  sim twice, the advisor once and the renderer once; three of them only
  predicted what the fourth would do. Write it once.
- **A number tuned for a mature tower strands a small one.** Three separate
  calibration bugs in one day were all this shape.

The pattern: every one of these made the game look *fine*. Distrust metrics that
improve while the thing they measure gets worse.

## Conventions

- Plain ES modules for `sim/**` and `harness/**`: the same files run in the
  browser and in Node. No bundler, no transpile.
- Fixed timestep everywhere. The sim never sees a variable `dt`.
- Comments explain *why*, and a sim comment should cite the spec section it
  implements.
- `out/` and `node_modules/` are gitignored.
