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

If the reference is ambiguous, say so and cite `specs/PARITY-NOTES.md` or
`specs/GAPS.md` rather than picking quietly.

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

Kept because each is a class of mistake. All of these were paid for once already
in `keithgroben/lift`.

- **In-transit riders were deleted at midnight.** `trips` stopped equalling
  `delivered + abandoned`, and a tower failing 90% of its trips reported a
  *falling* average wait. Accounting holes read as good news.
- **Stranded riders were logged as zero wait.** A tower with no elevator posted
  the shortest queues in the sweep.
- **`null >= 0` is TRUE in JavaScript**, and so is `null?.k !== 'x'`. Both read
  as guards and are not. A sentinel that collides with a real value — `-1` for
  "no floor", when `-1` is now the first basement — is the same bug wearing a
  hat.
- **Art existed and nothing drew it, six times.** A catalogued sheet with no
  reached call site now fails a test. Preloading does not count.
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
