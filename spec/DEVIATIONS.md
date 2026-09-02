# Deviations from the reference

**Keith's ruling, 2026-09-02: 100% faithful to start.**

Every place this build knowingly differs from the reference goes here, with a
reason. Silent deviation is the failure mode this repo was created to escape —
the previous version diverged early, undocumented, and no one could ever settle
whether a mechanic was right.

A row here is not a defeat. It is the difference between a decision and a drift.

| # | Rule | Reference | Ours | Why | Decided |
|---|---|---|---|---|---|
| — | *(none yet)* | | | | |

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
