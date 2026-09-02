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
npm run dev      # http://localhost:5174
npm test         # zero-dep, no install needed
```

The simulation is pure and headless: `sim/` and `harness/` run under plain
Node 20 with no build step and no dependencies. Only the browser UI needs Vite.

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
