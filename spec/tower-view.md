# Lift — the tower view (UI shell spec)

Keith's ruling, 2026-08-31, after the first real look at a grown tower:

> "I need a ground, underground, an area I can click and drag around like in
> SimTower. I need a build menu where I can select things and build them."
>
> "Why am I starting with floors? Lobby first, like in SimTower."
>
> "The loop cannot be finished so long as the UI is the way it is."

That is the whole reason this document exists. The simulation is far ahead of
the interface — the balance work is stalled not because the numbers are
unknown, but because nobody can sit and *play* long enough to feel them. This
is what has to be true before a real playthrough is possible, and in what
order.

Read `spec/lift-vision.md` first for what the game is, and
`spec/sprite-manifest.md` for what it will eventually look like. This file is
the shell those two need in order to land.

---

## 1. What is actually wrong today (measured, not asserted)

**There is no camera.** `render/canvas.js` `layout()` refits the entire tower
into the viewport every single frame:

```js
const rows = Math.max(state.floors + 2, 10);
const fh   = Math.min(44, (H - pad * 2) / rows);
const cw   = Math.min(fh * 1.6, (W - pad * 2) / cols);
```

At 4 floors a slot draws about 70x44 px. At 60 floors, in a 1125x910
viewport, a slot draws **22x14 px** — smaller than the 48x32 native art grid,
too small to show a person, a door, or a queue. The tower gets *less* legible
the better you play. That is backwards, and it is why the endgame has only
ever been read from sweep tables instead of played.

**There is no ground and no below.** Floor 0 is the bottom of the world.
`canvas.js:481` and `canvas.js:520` reject `floor < 0` outright, and the sim
indexes floors `0 .. state.floors-1` in 43 places. No street, no earth, no
basement. A SimTower tower is a *section drawing*; the ground line is what
makes a building read as a building instead of as a bar chart.

**You start with floors instead of a lobby.** `config.building.startFloors`
is 4, so a new session opens on four empty storeys standing in mid-air with no
entrance — and the build palette leads with `+ floor`. The guided path says
"build a lobby entrance" while the world and the menu both say "floors first."
SimTower opens on bare ground: the lobby is the first thing you place, and
floors follow the tenants.

**Build is a text list, not a tool palette.** Choosing what to place means
reading `+ floor / + lobby / office / + shaft / + car` down a sidebar column,
then hunting the tower for a legal spot. Selecting a tool and painting with it
is the SimTower verb. Reading a list is not.

**The developer sidebar *is* the interface.** Everything that tells you what
is happening lives in a scrolling diagnostic column beside a shrinking
diagram. It has to go — but not yet (see §6).

## 2. The tower view

The play area becomes a **world you look around in**, not a diagram that
shrinks.

- **Fixed world scale.** One slot is `48x32` px at zoom 1x — the native art
  grid from `spec/sprite-manifest.md`. A floor is 32 px tall, forever.
  Building higher makes the tower *taller*; it never makes it smaller.
- **Pan by dragging.** Left-drag on empty space moves the camera, freely — no
  snapping, no rubber-band. Middle-drag pans in every mode, including while a
  build tool is armed.
- **Integer zoom steps only:** `1x / 2x / 3x`. Never fractional — mixel art
  shears the moment it is scaled 1.5x.
- **A minimap, just like SimTower** (Keith's call, 2026-08-31) — a narrow
  vertical strip showing the whole tower in miniature, one pixel row per
  floor, with a box marking what the main view is looking at. Click or drag
  the box to jump. It is drawn from the same state as the main view, colored
  by the pressure signals we already have, and it is what makes a 60-floor
  tower navigable without a blurry zoom-out.
- **Camera state lives in the renderer**, as `{ x, y, zoom }` in
  `render/canvas.js`. Nothing under `sim/**` may ever learn that a camera
  exists.
- **Every pick goes through the camera.** `floorAt()`, `slotAt()`,
  `unitAt()`, `facilityAt()`, `shaftAt()` (`canvas.js:828+`) are already the
  only seam between mouse pixels and game coordinates. They take the inverse
  camera transform, and nothing in `ui/app.js` needs to learn about panning.
- **Follow rules.** The camera stays where the player put it. It may move
  itself in exactly three cases: first load (frame the lobby), a confirmed
  placement that landed off-screen (pan to it), and an explicit "go to" from
  the HUD. Anything else that yanks the view is a bug.

## 3. Ground, street, and underground

The tower gets a horizon.

- **Ground line at floor 0's slab.** Above it, tower and sky (already drawn —
  gradient, sun, moon, stars). Below it, earth.
- **Street layer** at ground level: sidewalk, curb, and the lobby entrance
  reading as an actual entrance. This is where arriving people become
  visible, and it is the strongest "this is a building" cue a single tile can
  buy.
- **Underground floors, `B1 .. B10` (sim index `-1 .. -10`).** Keith's call,
  2026-08-31: ten, exactly as SimTower allowed against its 100 above. Deep
  enough for parking to matter, shallow enough that it never becomes a second
  tower competing with the one you are playing. They behave like floors in
  every way that matters — slots, rent, shafts spanning down into
  them, people walking out of them — with three differences that make digging
  a *decision* rather than more of the same:
  1. **Cheaper to build, worse to be in.** Underground slots cost less and
     carry an appeal penalty. Nobody wants a basement office.
  2. **Parking and services belong down there.** The facility kinds that are
     pure overhead — parking, recycling, security, storage — stop competing
     for rentable above-ground slots. That tradeoff is the whole reason to
     dig.
  3. **Transport must reach them.** A shaft has to be extended *down*, at the
     same span cost as extending up. An unserved basement is as dead as an
     unserved 40th floor.

**This is a simulation change, not a paint job.** `state.floors` is a count,
used in 43 sim call sites that all assume `0` is the bottom. The honest shape
is a floor *range* (`state.lowestFloor .. state.floors`), changed in one pass
with tests — not a `floor < 0` special case sprinkled through the renderer.
Per CLAUDE.md this is "Careful" territory: it changes the game, so it ships
with a test.

## 4. Lobby first

A new session opens on **bare ground**: street, sky, no floors.

**Yes, the lobby is a purchase in SimTower**, and checking settled two things
at once. It cost $1,250 per segment ($5,000 for four) and it is the *only*
thing that may be built on level 1 — sky lobbies then unlock on floors 15, 30,
45, 60, 75 and 90. What SimTower does **not** have is a floor purchase: there
is no "buy an empty storey" item anywhere in its build list. You place a room
and the structure comes with it.

- `config.building.startFloors` goes to `0`. The first purchase is the lobby,
  which is also the first step the guided path already asks for — the world
  stops contradicting the instruction.
- **The lobby tool is also the sky-lobby tool.** We already run zones of 20
  with a sky lobby at F20 (see `spec/lift-vision.md`, R12). Same tile, same
  button, legal only on the ground floor and at zone boundaries — which is
  exactly SimTower's rule with our own spacing.
- **`+ floor` is on notice.** A separate empty-floor purchase is our
  invention, not SimTower's, and it is the button that teaches the wrong first
  move. Recommendation: rooms carry their own structure and `+ floor`
  disappears. That touches `config.costs.floor` and the economy, so it is
  Keith's word before it happens — but the palette should stop leading with it
  either way.
- Floors are bought upward from the lobby, and the build palette is ordered
  by the actual first move: **lobby, floor, shaft, car, rooms** — not
  alphabetically, and not floor-first.
- The opening shot frames the empty lot with the lobby tool already armed.
  The first click of a new game should place the entrance.

## 5. The build menu

Selecting a thing and placing it becomes the primary verb.

- **A palette, not a list.** Icon tiles grouped by what they are: *structure*
  (lobby, floor, stairs), *rentable* (office, condo, shop, hotel),
  *transport* (shaft, car, express), *services* (cafeteria, parking, clinic,
  security, recycling). Cost sits on the tile. Unaffordable and locked tiles
  are visibly different states, never missing ones.
- **Arm, preview, confirm.** Picking a tool arms it. The world shows a live
  ghost under the cursor — green where it may land, red where it may not,
  *with the reason* ("needs a shaft", "$1,400 short", "slot taken"). Click
  places. `Esc` and right-click both disarm. This keeps the existing
  `applyAction()` seam exactly: the ghost is a dry run of the same validation
  the click will perform.
- **Repeat placement is the default.** A tool stays armed after a successful
  place — a row of eight offices is eight clicks, not eight trips back to the
  menu. `Esc` returns to `WATCHING`.
- **Demolish is a tool in the same palette**, not a mode hidden in a panel.

## 6. Retiring the developer sidebar

**Written down, deliberately not scheduled.** The diagnostic sidebar is coming
out — the game cannot be judged while its interface is a debugger. But it does
not come out until both of these are true:

1. A real, uninterrupted human playthrough has happened on the new tower view,
   **and**
2. The loop has been perfected against what that playthrough showed.

Until then the sidebar is the instrument we tune with, and pulling it early
costs the only visibility we have. When it does go, every number still worth
showing moves into the world or the HUD — over the room, over the queue, on
the shaft — not into a replacement panel. The dev view survives behind the `D`
toggle for us and for the harness; it stops being the way the game is read.

## 7. Order of work

Each step is playable on its own. Nothing here is a big-bang rewrite.

| # | Step | Why it is in this position |
|---|---|---|
| 1 | Camera: fixed 48x32 world scale, drag-pan, integer zoom, picks through the inverse transform | Everything else is invisible without it. Renderer-only, zero sim risk. |
| 2 | Ground line and street tile at floor 0 | The cheapest possible "it's a building" moment, and it proves the camera's world origin. |
| 3 | Lobby-first opening: `startFloors: 0`, palette reordered, lobby tool armed on load | One config value plus menu order; makes the first click correct. |
| 4 | Build palette: arm, ghost preview, confirm, stay armed | Turns building into the verb. No new sim rules — reuses `applyAction()`. |
| 5 | Underground floors `B1..Bn`: sim floor-range change plus tests, then rendering below the ground line | The one real sim change. Needs 1 and 2 to be visible at all. |
| 6 | Real playthrough on the new shell, recorded | The gate — §6's condition 1. |
| 7 | Loop balance against what that playthrough showed | §6's condition 2. |
| 8 | Sidebar retirement; diagnostics move in-world | Only now. |
| 9 | Tier 1 sprites (`spec/sprite-manifest.md`) | Art lands on a shell that is already correct, at the scale it was drawn for. |

## 8. Decided, so nobody re-opens it

- Slot stays **48x32**. Zoom is **integer only**.
- The camera lives in the renderer. `sim/**` never learns about it.
- Underground is a **floor range in the sim**, never a renderer special case.
- Build tools **stay armed** after a placement.
- A new game starts on **bare ground with the lobby first** — the lobby is a
  purchase, as it is in SimTower, and doubles as the sky-lobby tool.
- The underground is **10 floors, B1–B10**.
- Navigation at height is a **minimap strip**, not an overview zoom level.
- The sidebar's removal is **gated on a playthrough**, not on a date.

## 9. Open — Keith's call, not the code's

Answered 2026-08-31: underground is **10 floors**; navigation is a
**minimap**; the lobby **is** a purchase (SimTower charged $1,250 a segment
for it, and allowed nothing else on level 1).

Answered 2026-09-01: **`+ floor` is gone** — a room raises its own storey and
pays for it, SimTower's rule. **The lot is free** — the lobby buys the
entrance, not the ground, so the opening move is $50,000 rather than $90,000.
**The sky lobby is dropped**, not deferred: it stays the place where two
shafts meet, and no sim object is built for it. The **icon strip is being
redone** before the playthrough. And `underground.serviceCoverageBonus` gets a
**fresh sweep** on the current baseline before its value is chosen — the old
curve was measured in a world where policies were handed free storeys.

What is left:

1. **`dig` is now asymmetric with the way up.** A room raises its own storey,
   but sinking one is still an explicit tool. That may well be right —
   excavation is a real decision and a basement has no room to carry it — but
   nobody has been asked, and the two directions now read differently.
2. ~~**What does a basement rent for?**~~ **Answered by sweep, issue #6.**
   `config.underground` now carries the numbers and the curve behind each
   one (60 days x 5 seeds, held population, digging policy against its
   identical non-digging twin). The short version:

   - **Appeal penalty: 6 per floor down, capped at 24.** 6 is where the
     curve steps — at 3 a basement office still clears `relistMinScore` and
     the basement is just cheap lettable space; at 6 it does not, and the
     basement becomes plant rather than offices, which is what §3 says it is.
   - **Build cost: 0.7x above ground.** A weak knob, and worth saying so:
     0.7/0.9/1.0 move the score ~3%, barely above noise. It only bites at the
     extremes. The discount is a rule ("cheaper to build"), not a lever.
   - **Dig cost: $30,000**, under `costs.floor` so digging is cheaper than
     raising. Flat within noise below $40k; a cliff at $60k.
   - **The reason to dig is coverage, not cost.** A facility below ground
     reaches up from the ground line, widened by
     `underground.serviceCoverageBonus` (2). Without that widening, digging
     frees an above-ground slot and loses exactly the coverage that slot was
     buying — a pure loss and no decision, and the sweep shows it: at bonus 0
     digging is a *trap* (41.6 against 95.6 for not digging).
   - **Ten floors is Keith's call and stands, but the bot saturates at
     three.** 0/1/2/3/5/10 -> 95.6 / 109.5 / 128.8 / 137.8 / 137.2 / 137.2.
     B4..B10 are headroom for a human, not yet a live decision.
