# The reference implementation

The rules in this repo come from **SimTower (1993/94, Yoot Saito / OPeNBooK,
published by Maxis)**. The original was never open-sourced, so the source of
truth here is a reimplementation whose authors reverse-engineered the binary.

## What we work from

[**phulin/tower-together**](https://github.com/phulin/tower-together) — MIT.

Pinned at commit `073c0e4e4b78f440742d1f6ff8ea1ad8e7d52ccb`. Cloned locally at
`C:/dev/GitHub/phulin/tower-together`. Re-clone with:

```bash
git clone https://github.com/phulin/tower-together.git
git -C tower-together checkout 073c0e4e4b78f440742d1f6ff8ea1ad8e7d52ccb
```

Their stated goal: *"given the same input sequence, the reimplementation
produces byte-identical state to the original binary on every tick"*, checked
by replaying captured gameplay from the original binary under emulation.

Their `specs/` directory carries Ghidra addresses, gate tables marked
**binary-verified**, and a `Corrections to Previous Spec` log recording places
where the authors found their own earlier documentation wrong against the
disassembly. That log is the reason to trust the rest: they check.

## The specs that matter to us

| File | Covers |
|---|---|
| `specs/OVERVIEW.md` | scope and parity goals |
| `specs/TIME.md` | tick model, dayparts, the piecewise GUI clock, daily checkpoints |
| `specs/DEMAND.md` | who moves, when, and the per-family gate tables |
| `specs/PEOPLE.md` | the shared runtime-actor model and state codes |
| `specs/ROUTING.md` | route selection, walkability, transfers |
| `specs/ELEVATORS.md` | carriers, car behaviour, queues, boarding |
| `specs/ECONOMY.md` | costs, payouts, ledgers |
| `specs/GAME-STATE.md` | star progression and gates |
| `specs/facility/OFFICE.md` | the office family, end to end |
| `specs/PARITY-NOTES.md` | their own known approximation boundaries |
| `specs/GAPS.md` | what is still unresolved even for them |

Read `PARITY-NOTES.md` and `GAPS.md` before treating any number as settled.

## Attribution

Keith's ruling, 2026-09-02: **100% faithful to start.** Deviations get recorded
here with a reason, not made silently.

If code is ported rather than merely learned from, their copyright notice
travels with it — see `spec/UPSTREAM-LICENSE.md`, kept in full as MIT requires.
