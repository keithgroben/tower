/**
 * Feel, not logic. Nothing here may touch sim state. If a value changes the
 * outcome it belongs in src/sim; if it only changes how the player feels about
 * the outcome, it belongs here.
 */
export function makeJuice(config) {
  const floaters = [], pulses = [];
  let shake = 0, shakeT = 0;

  return {
    floaters, pulses,

    float(x, y, text, color) {
      floaters.push({ x, y, text, color, t: 0, life: config.feel.floaterMs });
    },
    pulse(x, y, color, r = 26) {
      pulses.push({ x, y, color, t: 0, life: 420, r });
    },
    kick(amount = config.feel.shakeOnVacate) {
      shake = Math.max(shake, amount); shakeT = 260;
    },

    update(ms) {
      for (let i = floaters.length - 1; i >= 0; i--) {
        floaters[i].t += ms;
        if (floaters[i].t >= floaters[i].life) floaters.splice(i, 1);
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].t += ms;
        if (pulses[i].t >= pulses[i].life) pulses.splice(i, 1);
      }
      if (shakeT > 0) { shakeT -= ms; if (shakeT <= 0) shake = 0; }
    },

    /** Decaying random offset. Uses Math.random on purpose — purely cosmetic,
     *  and it must never be able to influence a replay. */
    offset() {
      if (shake <= 0) return [0, 0];
      const k = shake * (shakeT / 260);
      return [(Math.random() - 0.5) * k, (Math.random() - 0.5) * k];
    },

    draw(ctx) {
      for (const p of pulses) {
        const k = p.t / p.life;
        ctx.globalAlpha = (1 - k) * 0.5;
        ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + k), 0, Math.PI * 2); ctx.stroke();
      }
      for (const f of floaters) {
        const k = f.t / f.life;
        ctx.globalAlpha = 1 - k * k;
        ctx.fillStyle = f.color;
        ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, f.y - 26 * easeOut(k));
      }
      ctx.globalAlpha = 1;
    },
  };
}

export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const lerp = (a, b, t) => a + (b - a) * t;

export function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  return 'rgb(' + pa.map((v, i) => Math.round(lerp(v, pb[i], t))).join(',') + ')';
}

export function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
