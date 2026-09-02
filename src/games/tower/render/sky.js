/**
 * The sky: the light through the day, the clouds, and the things that fly past.
 *
 * All of it is decoration. Nothing here may read or write simulation state,
 * and nothing here may change an outcome — a tower plays identically with the
 * sky switched off. That is why it can use its own random stream freely, the
 * same licence `juice.js` takes.
 *
 * Two jobs the tower cannot do for itself:
 *
 *  - **Tell the time.** A player watching a rush needs to feel morning become
 *    evening without reading the clock. Dawn and dusk are the moments that
 *    carry it, so they get their own named phases rather than being the
 *    halfway point of a fade.
 *  - **Give the eye somewhere to rest.** A tower is a grid of rectangles. The
 *    clouds drift, a bird crosses, and once in a long while something worth
 *    pointing at goes by — that is what makes a building feel like it is
 *    standing in a world rather than on graph paper.
 *
 * The renderer draws sprites where it has them and shapes where it does not,
 * so the sky works before any art arrives and improves when it lands.
 */

/** Fractions of a day. `tod` is 0..1, so these are the four skies. */
export const SKY_PHASES = ['night', 'dawn', 'day', 'dusk'];

/**
 * Day-ness on the same curve the sun already followed: 0 through the night
 * hours, 1 at midday, smooth in between.
 */
export function daylight(tod) {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, (tod - 0.05) / 0.9)));
}

/**
 * Which of the four skies it is, and how far through it.
 *
 * Dawn and dusk are narrow on purpose. They are the two minutes an hour that
 * look like something, and stretching them would make the tower spend its day
 * in permanent golden hour.
 */
export function skyPhase(tod) {
  const t = ((tod % 1) + 1) % 1;
  if (t < 0.05) return { phase: 'night', k: t / 0.05 };
  if (t < 0.16) return { phase: 'dawn', k: (t - 0.05) / 0.11 };
  if (t < 0.72) return { phase: 'day', k: (t - 0.16) / 0.56 };
  if (t < 0.84) return { phase: 'dusk', k: (t - 0.72) / 0.12 };
  return { phase: 'night', k: (t - 0.84) / 0.16 };
}

/** Linear blend, clamped. */
const mix = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

/**
 * The sky's colours for a moment in the day, as [top, bottom] rgb triples.
 * Dawn is cooler and pinker than dusk, which runs orange — the difference is
 * what stops the two reading as the same event twice a day.
 */
export function skyColors(tod) {
  const NIGHT_TOP = [8, 10, 22], NIGHT_LOW = [14, 17, 22];
  const DAY_TOP = [66, 100, 138], DAY_LOW = [128, 160, 186];
  const DAWN_TOP = [92, 78, 132], DAWN_LOW = [232, 156, 150];
  const DUSK_TOP = [58, 46, 86], DUSK_LOW = [236, 138, 74];
  const { phase, k } = skyPhase(tod);

  const blend = (fromT, fromL, toT, toL, t) => [
    fromT.map((v, i) => Math.round(mix(v, toT[i], t))),
    fromL.map((v, i) => Math.round(mix(v, toL[i], t))),
  ];

  if (phase === 'dawn') {
    // night -> dawn colour -> day, so first light arrives before the blue does
    return k < 0.5
      ? blend(NIGHT_TOP, NIGHT_LOW, DAWN_TOP, DAWN_LOW, k * 2)
      : blend(DAWN_TOP, DAWN_LOW, DAY_TOP, DAY_LOW, (k - 0.5) * 2);
  }
  if (phase === 'dusk') {
    return k < 0.5
      ? blend(DAY_TOP, DAY_LOW, DUSK_TOP, DUSK_LOW, k * 2)
      : blend(DUSK_TOP, DUSK_LOW, NIGHT_TOP, NIGHT_LOW, (k - 0.5) * 2);
  }
  if (phase === 'day') return [DAY_TOP.slice(), DAY_LOW.slice()];
  return [NIGHT_TOP.slice(), NIGHT_LOW.slice()];
}

/**
 * What may fly past, and how often.
 *
 * `perMinute` is real minutes, not game days: a surprise you see twice a
 * session is a surprise, and one you see twice a minute is wallpaper. The
 * rarest entries here are meant to be talked about, so they are deliberately
 * scarcer than anything a playtest will reliably produce.
 */
export const FLYERS = [
  { name: 'bird', sprite: 'sky-bird', animation: 'fly', perMinute: 6, band: [0.10, 0.55], speed: [26, 44], scale: 1, flock: [2, 7], phases: ['dawn', 'day', 'dusk'] },
  { name: 'plane', sprite: 'sky-plane', animation: 'fly', perMinute: 1.2, band: [0.04, 0.22], speed: [58, 82], scale: 1, phases: ['dawn', 'day', 'dusk', 'night'] },
  { name: 'balloon', sprite: 'sky-balloon', animation: 'drift', perMinute: 0.5, band: [0.18, 0.5], speed: [10, 18], scale: 1, phases: ['dawn', 'day'] },
  { name: 'blimp', sprite: 'sky-blimp', animation: 'drift', perMinute: 0.22, band: [0.08, 0.3], speed: [16, 24], scale: 1, phases: ['day', 'dusk'] },
  // The ones worth pointing at. A hot-air balloon with someone waving out of
  // the basket, and an aerobatic plane trailing smoke.
  { name: 'explorer', sprite: 'sky-explorer', animation: 'drift', perMinute: 0.06, band: [0.14, 0.42], speed: [8, 14], scale: 1, phases: ['dawn', 'dusk'] },
  { name: 'stunt', sprite: 'sky-stunt', animation: 'fly', perMinute: 0.05, band: [0.06, 0.35], speed: [90, 120], scale: 1, phases: ['day'], trail: true },
];

/** Weighted pick over whatever may fly in this phase. Pure, so it is testable. */
export function pickFlyer(phase, roll, table = FLYERS) {
  const eligible = table.filter((f) => f.phases.includes(phase));
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, f) => sum + f.perMinute, 0);
  let target = roll * total;
  for (const f of eligible) {
    target -= f.perMinute;
    if (target <= 0) return f;
  }
  return eligible[eligible.length - 1];
}

/** Chance that at least one flyer launches in `dtMs`, from the table's rate. */
export function launchChance(phase, dtMs, table = FLYERS) {
  const perMinute = table
    .filter((f) => f.phases.includes(phase))
    .reduce((sum, f) => sum + f.perMinute, 0);
  return 1 - Math.exp(-(perMinute / 60000) * Math.max(0, dtMs));
}

/**
 * A cloud's screen position. Clouds sit at a depth: the far ones barely answer
 * the camera, the near ones move with it, which is what gives the sky behind a
 * 60-floor tower any sense of distance at all.
 */
export function cloudScreenX(cloud, cameraX, viewW, drift) {
  const span = viewW + cloud.w * 2;
  const raw = cloud.x + drift * cloud.speed - cameraX * cloud.depth * 0.35;
  return ((raw % span) + span) % span - cloud.w;
}

/**
 * How big a cloud draws, and how big anything flying draws.
 *
 * Both scale with the camera zoom. They did not at first, and the tower grew
 * around them — zooming in made the building huge and left the sky the size it
 * was (Keith, 2026-09-01: "the clouds and birds are not zooming with the
 * map"). Sky sits at effectively infinite distance, so a zoom magnifies it
 * without moving it, the way a telescope does; the parallax that makes it feel
 * distant is in where a cloud sits, not in how large it is drawn.
 *
 * A cloud also takes a size from its depth: the near ones are bigger.
 */
export function cloudScale(depth, zoom) {
  return (0.6 + Math.max(0, Math.min(1, depth)) * 0.9) * Math.max(0, zoom);
}

/** Everything in flight draws at the camera's own scale. */
export function flyerScale(zoom) {
  return Math.max(0, zoom);
}

/** Deterministic sky, given a seedable rng. `rng()` returns 0..1. */
export function makeSky(config, rng = Math.random) {
  const feel = (config && config.feel && config.feel.sky) || {};
  const cloudCount = feel.cloudCount ?? 9;
  const flyerTable = feel.flyers ?? FLYERS;
  const maxFlyers = feel.maxFlyers ?? 4;

  const clouds = [];
  const flyers = [];
  let drift = 0;

  for (let i = 0; i < cloudCount; i++) {
    clouds.push({
      x: rng() * 2000,
      // Higher clouds are further away, which is also how they are drawn.
      y: 18 + rng() * 150,
      depth: 0.25 + rng() * 0.75,
      speed: 3 + rng() * 7,
      w: 48 + Math.round(rng() * 3) * 24,
      variant: ['small', 'medium', 'large'][Math.floor(rng() * 3)],
    });
  }
  clouds.sort((a, b) => a.depth - b.depth);

  function launch(phase, viewW, viewH) {
    if (flyers.length >= maxFlyers) return null;
    const kind = pickFlyer(phase, rng(), flyerTable);
    if (!kind) return null;
    const dir = rng() < 0.5 ? 1 : -1;
    const count = kind.flock ? kind.flock[0] + Math.floor(rng() * (kind.flock[1] - kind.flock[0] + 1)) : 1;
    const band = kind.band;
    const y = viewH * (band[0] + rng() * (band[1] - band[0]));
    const speed = kind.speed[0] + rng() * (kind.speed[1] - kind.speed[0]);
    const flyer = {
      kind, dir, count, speed,
      x: dir > 0 ? -80 : viewW + 80,
      y,
      // Flock members trail behind in a loose V rather than a line.
      offsets: Array.from({ length: count }, (_, i) => ({ dx: i * (14 + rng() * 10), dy: (i % 2 ? 1 : -1) * i * (3 + rng() * 4) })),
      bob: rng() * Math.PI * 2,
    };
    flyers.push(flyer);
    return flyer;
  }

  return {
    clouds, flyers,

    /** Advance drift and flyers. `dtMs` is render time, not sim time. */
    update(dtMs, tod, viewW, viewH) {
      const ms = Math.min(120, Math.max(0, dtMs || 0));
      drift += ms / 1000;
      const { phase } = skyPhase(tod);

      for (let i = flyers.length - 1; i >= 0; i--) {
        const f = flyers[i];
        f.x += f.dir * f.speed * (ms / 1000);
        f.bob += ms / 900;
        const width = 90 + (f.count - 1) * 24;
        if (f.dir > 0 ? f.x > viewW + width : f.x < -width) flyers.splice(i, 1);
      }

      if (rng() < launchChance(phase, ms, flyerTable)) launch(phase, viewW, viewH);
    },

    /** Force one, for a test or a screenshot. */
    launch,

    /** How far through the day, for anything that wants to tint with the sky. */
    phase: (tod) => skyPhase(tod),
  };
}
