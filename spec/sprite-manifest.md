# Lift — sprite manifest (mixel art pass)

The complete inventory of art the game needs, written so an art agent can
produce it without reading the codebase. Read `spec/lift-vision.md` first for
what the game is. **Do not start production art until Phase D** — but this
list also tells the *programmers* what the renderer must eventually support,
which is why it exists now.

Two companions, added 2026-08-31: `spec/tower-view.md` is the UI shell this
art lands on (camera, ground line, underground, build palette), and
`spec/asset-request.md` is the paste-ready cut of Tier 0 + Tier 1 for an
image-gen assistant. If a size disagrees between files, this one wins.

## Art direction constants

- **Style:** mixel (mixed-resolution pixel art) — crisp pixel sprites over
  smooth-gradient sky. Dark, warm, readable at a glance. SimTower is the
  ancestor; don't copy it.
- **Native grid:** 1 building slot = **48×32 px** at 1× zoom. Every room and
  facility is exactly 1 slot. Elevator shafts and stairs occupy a 48px-wide
  column. All sprites integer-scale (2×, 3×) — no fractional scaling ever.
- **People:** **16 px tall** at 1×, so a standing figure fits a floor interior
  with headroom for furniture.
- **Palette anchors** (the game's UI already uses these; art must harmonize):
  bg `#0e1116` · panel `#1b2430` · good `#3ddc97` · warn `#ffb703` ·
  bad `#ef476f` · info-blue `#8ecae6` · hotel-violet `#c77dff`.
  Room interiors may use richer color but must stay identifiable by hue
  family: office=blue, condo=green, shop=amber, hotel=violet.
- **Day/night:** the sky is drawn by code (gradient + sun/moon/stars —
  already shipped). Sprites need **lit-window night variants**, not baked-in
  lighting.
- **Delivery format:** PNG sprite sheets per subject, 1× native scale,
  transparent background, plus a sidecar JSON — `{frameW, frameH, animations:
  {name: {col, frames, speed, loop}}}`, all of a subject's frames in one
  left-to-right strip. `speed` **names** a constant in
  `config.feel.sprites.fps`; a raw fps number in an art file is refused by the
  loader. The exact contract, with an example, is in `spec/asset-request.md`
  ("Delivery: the sidecar JSON") and `src/games/lift/assets/README.md`. File
  names kebab-case: `office.png`, `office.json`, `person-worker.png`, …

## Tier 0 — the shell (added 2026-08-31, produce first)

The ground line, the underground, and the build palette. None of it exists in
the renderer today; all of it is required by `spec/tower-view.md`.

| Sprite | Size | States / frames | Notes |
|---|---|---|---|
| ground-street | 48×16 tile | 1f | sidewalk + curb under floor 0; the horizon line of the game |
| ground-entrance | 48×16 | day · night | apron under the lobby — steps, doormat, lit sign at night |
| earth-fill | 48×32 tile | 1f | packed dirt behind basement floors; must stay quiet, it is backdrop |
| earth-edge | 48×32 | 1f | the dug edge where earth meets a basement slot |
| basement-empty | 48×32 | 1f | bare basement slot; colder and dimmer than `empty slot` |
| basement-parking | 48×32 | empty · 1 car · 2 cars | the main reason to dig |
| basement-storage | 48×32 | 1f | crates and shelving |
| basement-utility | 48×32 | idle (2f) | boilers, pipes, slow blinking indicator |
| foundation-slab | 48×6 tile | 1f | heavier slab separating floor 0 from B1 |
| palette-icons | 32×32 each, 17 across | 1f each | build-menu tools: lobby · floor · office · condo · shop · hotel · shaft · car · express · stairs · escalator · cafeteria · parking · clinic · security · recycling · demolish |

## Tier 1 — minimum viable reskin (replaces the colored rectangles)

| Sprite | Size | States / frames | Notes |
|---|---|---|---|
| office | 48×32 | vacant · occupied-day (2f idle) · occupied-night (lit) · stressed | stressed = subtle mess/flicker, red accent — must read at 1× |
| condo | 48×32 | vacant · occupied-day (2f) · occupied-night (lit) · stressed | homier, warmer than office |
| shop | 48×32 | vacant · open (3f sign/awning anim) · closed-night | ×2 visual variants (grocery, cafe) to break repetition |
| hotel | 48×32 | vacant · booked-day · booked-night (lit) · poor-review | violet accent |
| empty slot | 48×32 | 1f | bare concrete + studs |
| under construction | 48×32 | 3f (scaffold, dust) | plays while a build lands |
| lobby | 48×32 | day · night | glass entrance; tiles horizontally with lobby-wing |
| lobby wing | 48×32 | day · night | seamless tile with lobby |
| floor slab | 48×4 | 1f | the line between floors; tiles horizontally |
| roof cap | 48×12 | 1f + antenna variant | sits on the top floor |
| ground/street | 48×16 tile | 1f | sidewalk + curb under floor 0 |
| shaft column | 48×32 tile | 1f | dark interior + guide rails, tiles vertically |
| elevator car | 40×26 | doors-closed · doors-opening (3f) · doors-open | riders shown as silhouettes in the window (code overlays count) |
| stairs segment | 48×32 tile | 1f | diagonal flight, tiles vertically |
| escalator segment | 48×32 tile | 4f loop | moving-step animation |
| person — worker | 16px | walk L/R (4f) · stand (2f fidget) · wait-annoyed (2f) | 3 palette swaps |
| person — resident | 16px | same set | 3 palette swaps |
| person — guest | 16px | same set + luggage variant | 2 palette swaps |

## Tier 2 — the living tower (people visibly doing things)

The sim tracks *headcounts*, not individual routines — so in-room life is
**decorative puppetry driven by state**: the renderer spawns little scenes
from what it already knows (heads, tod, stress, occupancy). No sim changes.
This is exactly how SimTower felt alive.

| Sprite | Size | States / frames | Driven by |
|---|---|---|---|
| office interior life | fits 48×32 | desk-work loop (4f) · meeting (2f) · night empty desks | heads > 0, tod |
| condo interior life | fits 48×32 | tv-couch loop (2f) · lights-out sleeping | tod |
| shop customers | 16px figures | browse (2f) · checkout (2f) | delivered lunch customers |
| hotel interior life | fits 48×32 | sleeping (lights out) · morning pack-up | booked guests, tod |
| facility staff | 16px | idle-work loop per facility kind (2f each) | facility exists |
| queue crowd | 16px figures | shuffle (2f) · check-watch (2f) · give-up walk-off | replaces the current dot queue; heat = posture |
| car riders | 12px silhouettes | sway loop (2f) | rider count |

## Tier 3 — delight

| Sprite | Size | States / frames | Notes |
|---|---|---|---|
| fireworks | 64×64 bursts | 3 burst types × 6f | **the 5-star crowning show** — launches from the roof |
| star plaque | ~96×32 | 5 tiers | the rating, rendered in-world on the tower |
| bankruptcy | screen overlay pieces | dimmed tower · "CLOSED" banner (2f flутter) | the game-over moment |
| construction crane | 48×48 | 2f | tops the tower while anything is building |
| clouds | 3 sizes | 1f each, drift by code | parallax layer |
| pigeons | 8px | fly-by (4f) · perch (2f) | roof/ledges, rare |
| service facilities | 48×32 each | cafeteria · parking · clinic · security · recycling — each vacant/active-day/night | Tier 1.5 honestly; needed before facilities look like anything |

## Counts and priorities

Tier 1 is ~19 subjects (~70 frames) and fully replaces the prototype look.
Tier 2 is ~7 subjects (~25 frames) and is what makes people say "oh it's
alive." Tier 3 is ~10 subjects. **Produce in tier order; within Tier 1,
rooms → people → transport.**

## What this implies for the renderer (programmer notes)

- Pan/zoom camera with integer zoom steps lands **before** any sprite work
  (see vision doc Phase D, and `spec/tower-view.md` for the full shell spec).
  Until it does, `layout()` refits the tower every frame and a slot at 60
  floors draws 22×14 px — half the native grid these sprites are drawn on.
- A sprite-sheet loader + animation clock in `render/` (renderer-only;
  `config.feel` owns fps constants). **Landed** — `render/sprites.js`. A sheet
  that has not arrived, or that does not describe itself honestly, falls back
  to the coloured rectangle without throwing, so art can land one subject at a
  time. Wiring it into `canvas.js` is the follow-up.
- The current queue-dot and crowd-bar *signals* survive the reskin: pressure
  color and count badges stay, drawn over the sprites. Legibility beats
  charm — the vision doc's pressure loop must stay readable at every zoom.
- In-room life reads existing state only (heads, tod, stress, delivered
  counts). If an animation seems to need new sim state, it's Tier-cut, not a
  sim change.
