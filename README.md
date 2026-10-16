# Tower

A faithful rebuild of **SimTower's core loop**.

> Your elevator network doesn't just serve your tenants — it decides whether you
> have any.

An office rents when a worker's lobby-to-office route actually resolves. Not
when a score clears a bar. Evaluation is the average of how the occupants' real
trips went, not a sum of room properties. That single loop — transport decides
occupancy, occupancy makes traffic, traffic tests transport — is the whole game.

## Start here

- [`spec/simtower-loop.md`](spec/simtower-loop.md) — the loop, the numbers, and
  the build order. The north star.
- [`spec/REFERENCE.md`](spec/REFERENCE.md) — where the rules come from.
- [`CLAUDE.md`](CLAUDE.md) — the architectural law.

## Running it

```bash
npm install
npm run dev      # http://localhost:5174  (redirects to the game)
npm test         # zero-dep, no install needed
```

The simulation is pure and headless: `sim/` and `harness/` run under plain
Node 20 with no build step and no dependencies. Only the browser UI needs Vite.

## Watching the whole loop work (issue #19)

A scripted player climbs from an empty lot to the Tower rank through `applyAction` and the star bar, and
you can watch it, or read what it did.

```bash
# SEE it: the game page, with the scripted player at the controls (the dev server is on :5174)
npm run dev
#   http://localhost:5174/src/games/tower/index.html?demo=climb            the short climb, ~17 game days, 16x
#   http://localhost:5174/src/games/tower/index.html?demo=climb&real=1     the honest $2M climb, no stand-in, 48x
#   ...add  &x=32  (speed: 1-96)  &lifts=single | cars  (players who ignore the lifts)  &seed=2
# The tab has to be visible for the game to advance (browsers stop animation frames in a hidden tab).
# The page never reads or writes your saved tower; "Leave the demo" takes you back to it.

# READ it
npm run climb                                    # the honest run: $2,000,000, 135 days, every person a real tenant (~1.5 min)
node harness/playtest.js --climb --quick         # the short run the test suite asserts (24 days, three named stand-ins)
node harness/playtest.js --climb --compare       # five players, one seed: zoned lifts vs ignoring them
node harness/playtest.js --climb 200 --crowd-from 4   # honest to four stars, then the crowd stands in for the rest
```

The report opens with what is **not** the sim (capital, the crowd, the ambition) and says, star by star, how much
of the population was real. The honest finding is in `spec/DEVIATIONS.md` A91: the sim cannot host 15,000 people.

## Lineage

Successor to [`keithgroben/lift`](https://github.com/keithgroben/lift), which
proved the elevator simulation, the tower view and the headless harness — all
carried over here — but invented its own tenant model and could never settle
whether it was right.

Rules reverse-engineered by
[phulin/tower-together](https://github.com/phulin/tower-together) (MIT), whose
authors validate against the original binary tick-for-tick. Their licence is
kept at [`spec/UPSTREAM-LICENSE.md`](spec/UPSTREAM-LICENSE.md).

SimTower is © Maxis / EA. This is a clean-room-adjacent study project, not a
distribution of the original game or its assets.
