/**
 * The lab: run the headless sim IN THE BROWSER and see the curves.
 *
 * The sim is pure ES modules with no Node dependencies, so the same files the
 * harness sweeps run here at full speed — hundreds of simulated days a second,
 * every policy overlaid, with any config number overridable per run. This is
 * how a human gets a feel for the tuning without trusting an agent's summary:
 * the spread between the best and worst policy IS the fun-o-meter (CLAUDE.md,
 * "tune for spread, not for score").
 *
 * Game-agnostic like the rest of harness/: everything flows through the
 * game.js manifest. The import map below is the one concession to the
 * browser — it cannot readdir src/games/, so the list is static.
 */
const GAMES = {
  lift: () => import('../src/games/lift/game.js'),
  bloom: () => import('../src/games/bloom/game.js'),
};

/** Validated categorical series palette (dark surface) — see dataviz notes.
 *  Order is fixed; colors follow the policy, never the selection. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767', '#008300'];

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(['game', 'days', 'seeds', 'run', 'status', 'policies', 'knob-filter', 'knob-list', 'knob-changes', 'progress', 'spread', 'legend', 'charts', 'final-table', 'tooltip']
  .map((id) => [id, $(id)]));

let game = null;
let gameName = 'lift';
let overrides = new Map();       // config path -> number
let selectedPolicies = new Set();
let lastResults = null;          // [{policy, color, seeds: [log, ...]}]
let charts = [];                 // per-chart draw state for crosshair redraws

// ------------------------------------------------------------------ helpers
function flattenNumbers(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? prefix + '.' + key : key;
    if (typeof value === 'number') out.push({ path, value });
    else if (value && typeof value === 'object' && !Array.isArray(value)) flattenNumbers(value, path, out);
  }
  return out;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = value;
}

const fmt = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
  : Math.abs(v) >= 1e4 ? Math.round(v / 1e3) + 'k'
  : Math.abs(v) >= 100 ? String(Math.round(v))
  : String(+v.toFixed(2));

// ------------------------------------------------------------------ setup
async function loadGame(name) {
  gameName = name;
  game = await GAMES[name]();
  overrides = new Map();
  selectedPolicies = new Set(Object.keys(game.POLICIES));
  renderPolicyToggles();
  renderKnobList();
  renderChanges();
  els.status.textContent = 'loaded ' + name + ' · ' + Object.keys(game.POLICIES).length + ' policies';
}

function renderPolicyToggles() {
  const keys = Object.keys(game.POLICIES);
  els.policies.innerHTML = '';
  keys.forEach((key, i) => {
    const label = document.createElement('label');
    label.className = 'policy-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selectedPolicies.has(key);
    const chip = document.createElement('i');
    chip.className = 'policy-chip';
    chip.style.background = SERIES[i % SERIES.length];
    const name = document.createElement('span');
    name.textContent = game.POLICIES[key].name || key;
    box.addEventListener('change', () => {
      box.checked ? selectedPolicies.add(key) : selectedPolicies.delete(key);
      name.classList.toggle('off', !box.checked);
    });
    label.append(box, chip, name);
    els.policies.append(label);
  });
}

function renderKnobList() {
  const filter = els['knob-filter'].value.trim().toLowerCase();
  const knobs = flattenNumbers(game.CONFIG);
  const shown = filter ? knobs.filter((k) => k.path.toLowerCase().includes(filter)).slice(0, 40) : [];
  els['knob-list'].innerHTML = '';
  for (const knob of shown) {
    const row = document.createElement('div');
    row.className = 'knob-row' + (overrides.has(knob.path) ? ' changed' : '');
    const code = document.createElement('code');
    code.textContent = knob.path;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = overrides.get(knob.path) ?? knob.value;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === knob.value) overrides.delete(knob.path);
      else overrides.set(knob.path, v);
      row.classList.toggle('changed', overrides.has(knob.path));
      renderChanges();
    });
    row.append(code, input);
    els['knob-list'].append(row);
  }
}

function renderChanges() {
  els['knob-changes'].innerHTML = '';
  for (const [path, value] of overrides) {
    const chip = document.createElement('button');
    chip.className = 'change-chip';
    chip.textContent = path + ' = ' + value + ' ✕';
    chip.title = 'click to reset';
    chip.addEventListener('click', () => { overrides.delete(path); renderChanges(); renderKnobList(); });
    els['knob-changes'].append(chip);
  }
}

// ------------------------------------------------------------------ running
/** Browser port of harness/load.js play(): same rhythm, chunked so the page
 *  stays alive and the progress bar moves. */
async function playAsync(policyKey, days, seed, onProgress) {
  const cfg = structuredClone(game.CONFIG);
  for (const [path, value] of overrides) setPath(cfg, path, value);
  const state = game.boot(cfg, seed);
  const policy = game.POLICIES[policyKey];
  policy.open?.(state, cfg);
  const CHUNK = 4000;
  let steps = 0;
  const totalSteps = days * (cfg.time.daySeconds / cfg.time.dt);
  while (state.day <= days && !state.over) {
    for (let i = 0; i < CHUNK && state.day <= days && !state.over; i++) {
      if (policy.tick && !state.busy) policy.tick(state, cfg);
      const closed = game.step(state, cfg.time.dt, cfg);
      if (closed) policy.decide?.(state, cfg);
      steps++;
    }
    onProgress(Math.min(1, steps / totalSteps));
    await new Promise((r) => setTimeout(r, 0));
  }
  return state;
}

async function runAll() {
  const days = Math.max(5, Number(els.days.value) || 120);
  const seedCount = Math.max(1, Math.min(10, Number(els.seeds.value) || 2));
  const keys = Object.keys(game.POLICIES).filter((k) => selectedPolicies.has(k));
  if (!keys.length) { els.status.textContent = 'select at least one policy'; return; }

  els.run.disabled = true;
  const bar = els.progress.firstElementChild;
  const results = [];
  const jobs = keys.length * seedCount;
  let done = 0;
  const t0 = performance.now();

  for (const key of keys) {
    const colorIndex = Object.keys(game.POLICIES).indexOf(key);
    const entry = { policy: key, name: game.POLICIES[key].name || key, color: SERIES[colorIndex % SERIES.length], runs: [] };
    for (let s = 1; s <= seedCount; s++) {
      els.status.textContent = 'running ' + key + ' · seed ' + s + ' …';
      const state = await playAsync(key, days, s, (p) => {
        bar.style.width = (((done + p) / jobs) * 100).toFixed(1) + '%';
      });
      entry.runs.push({ seed: s, log: state.log, over: state.over, endDay: state.day });
      done++;
    }
    results.push(entry);
  }

  bar.style.width = '100%';
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const simDays = results.reduce((n, e) => n + e.runs.reduce((m, r) => m + r.log.length, 0), 0);
  els.status.textContent = simDays + ' simulated days in ' + secs + 's';
  lastResults = { results, days };
  render();
  els.run.disabled = false;
}

// ------------------------------------------------------------------ charts
function metricList() {
  const log0 = lastResults.results.flatMap((e) => e.runs).find((r) => r.log.length)?.log[0];
  if (!log0) return [];
  return (game.meta.columns || Object.keys(log0)).filter((c) => c !== 'day' && typeof log0[c] === 'number');
}

/** Mean across seeds for one policy, per day (days where any seed is alive). */
function meanSeries(entry, metric) {
  const byDay = new Map();
  for (const run of entry.runs) {
    for (const d of run.log) {
      if (typeof d[metric] !== 'number') continue;
      const cell = byDay.get(d.day) ?? { sum: 0, n: 0 };
      cell.sum += d[metric]; cell.n++;
      byDay.set(d.day, cell);
    }
  }
  return [...byDay.entries()].map(([day, { sum, n }]) => ({ day, v: sum / n })).sort((a, b) => a.day - b.day);
}

function render() {
  renderLegend();
  renderCharts();
  renderSpread();
  renderFinalTable();
}

function renderLegend() {
  els.legend.innerHTML = '';
  for (const entry of lastResults.results) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const chip = document.createElement('i');
    chip.className = 'policy-chip';
    chip.style.background = entry.color;
    item.append(chip, document.createTextNode(entry.name));
    els.legend.append(item);
  }
}

function renderCharts() {
  els.charts.innerHTML = '';
  charts = [];
  for (const metric of metricList()) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    const h = document.createElement('h2');
    h.textContent = metric.toUpperCase();
    const canvas = document.createElement('canvas');
    card.append(h, canvas);
    els.charts.append(card);
    const chart = buildChart(canvas, metric);
    charts.push(chart);
    drawChart(chart);
    hookCrosshair(chart);
  }
}

function buildChart(canvas, metric) {
  const series = lastResults.results.map((entry) => ({
    name: entry.name, color: entry.color,
    mean: meanSeries(entry, metric),
    seeds: entry.runs.map((run) => run.log.map((d) => ({ day: d.day, v: d[metric] })).filter((p) => typeof p.v === 'number')),
  }));
  const all = series.flatMap((s) => s.mean);
  const days = all.map((p) => p.day);
  const values = all.map((p) => p.v);
  return {
    canvas, metric, series,
    x0: Math.min(...days, 1), x1: Math.max(...days, 2),
    y0: Math.min(...values, 0), y1: Math.max(...values, 1),
  };
}

const PAD = { l: 46, r: 10, t: 8, b: 18 };

function drawChart(chart, crosshairDay = null) {
  const { canvas } = chart;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  const px = (day) => PAD.l + (day - chart.x0) / (chart.x1 - chart.x0 || 1) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - (v - chart.y0) / (chart.y1 - chart.y0 || 1) * (H - PAD.t - PAD.b);
  chart.px = px; chart.py = py; chart.w = W; chart.h = H;

  ctx.clearRect(0, 0, W, H);

  // Recessive grid: 4 horizontal lines + value labels, day labels at ends.
  ctx.strokeStyle = 'rgba(42,55,70,0.6)';
  ctx.fillStyle = '#52657a';
  ctx.font = '9px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = chart.y0 + (chart.y1 - chart.y0) * (i / 3);
    const y = py(v);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmt(v), PAD.l - 5, y + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText('D' + chart.x0, PAD.l, H - 5);
  ctx.textAlign = 'right';
  ctx.fillText('D' + chart.x1, W - PAD.r, H - 5);

  // Per-seed traces first (faint), then the mean on top (2px).
  for (const s of chart.series) {
    ctx.strokeStyle = s.color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    for (const run of s.seeds) tracePath(ctx, run, px, py);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    tracePath(ctx, s.mean, px, py);
    // A run that died ends early — mark the end of the mean line.
    const last = s.mean.at(-1);
    if (last && last.day < chart.x1) {
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(px(last.day), py(last.v), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  if (crosshairDay != null) {
    ctx.strokeStyle = 'rgba(219,228,238,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(crosshairDay), PAD.t);
    ctx.lineTo(px(crosshairDay), H - PAD.b);
    ctx.stroke();
    for (const s of chart.series) {
      const pt = nearestPoint(s.mean, crosshairDay);
      if (!pt) continue;
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(px(pt.day), py(pt.v), 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0e1116';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function tracePath(ctx, points, px, py) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(px(p.day), py(p.v)) : ctx.moveTo(px(p.day), py(p.v)));
  ctx.stroke();
}

function nearestPoint(points, day) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p.day - day) < Math.abs(best.day - day)) best = p;
  return best;
}

function hookCrosshair(chart) {
  chart.canvas.addEventListener('mousemove', (e) => {
    const rect = chart.canvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r);
    const day = Math.round(chart.x0 + Math.max(0, Math.min(1, frac)) * (chart.x1 - chart.x0));
    for (const c of charts) drawChart(c, day);
    const rows = chart.series
      .map((s) => ({ s, pt: nearestPoint(s.mean, day) }))
      .filter((r) => r.pt && Math.abs(r.pt.day - day) < 2)
      .sort((a, b) => b.pt.v - a.pt.v)
      .map((r) => '<div class="tt-row"><i style="background:' + r.s.color + '"></i><span>' + r.s.name + '</span><b>' + fmt(r.pt.v) + '</b></div>')
      .join('');
    els.tooltip.innerHTML = '<div class="tt-day">day ' + day + ' · ' + chart.metric + '</div>' + rows;
    els.tooltip.style.display = 'block';
    els.tooltip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + 'px';
    els.tooltip.style.top = (e.clientY + 12) + 'px';
  });
  chart.canvas.addEventListener('mouseleave', () => {
    els.tooltip.style.display = 'none';
    for (const c of charts) drawChart(c);
  });
}

// ------------------------------------------------------------------ verdicts
/** The one number that says whether the game is a game: how far apart good
 *  and bad play end up. Near-zero spread = the decisions didn't matter. */
function renderSpread() {
  const metrics = metricList();
  const key = metrics.includes('money') ? 'money' : metrics[0];
  if (!key) return;
  const finals = lastResults.results.map((entry) => {
    const mean = meanSeries(entry, key);
    return { name: entry.name, v: mean.at(-1)?.v ?? 0 };
  }).sort((a, b) => b.v - a.v);
  if (finals.length < 2) { els.spread.style.display = 'none'; return; }
  const best = finals[0], worst = finals.at(-1);
  const spread = best.v - worst.v;
  const relative = Math.abs(worst.v) > 1 ? ' (' + Math.round(spread / Math.abs(worst.v) * 100) + '% of the worst)' : '';
  els.spread.style.display = 'block';
  els.spread.innerHTML = '<b>DECISION SPREAD</b> — final ' + key + ': best <b>' + best.name + '</b> ' + fmt(best.v) +
    ' vs worst <b>' + worst.name + '</b> ' + fmt(worst.v) + ' → spread ' + fmt(spread) + relative +
    '<br>If this is near zero, the strategies don\'t matter and there is no game in this dimension. Wide spread = the decisions are real.';
}

function renderFinalTable() {
  const metrics = metricList();
  const head = '<tr><th>policy</th>' + metrics.map((m) => '<th>' + m + '</th>').join('') + '<th>outcome</th></tr>';
  const rows = lastResults.results.map((entry) => {
    const finalsPerSeed = entry.runs.map((r) => r.log.at(-1)).filter(Boolean);
    const cells = metrics.map((m) => {
      const vs = finalsPerSeed.map((d) => d[m]).filter((v) => typeof v === 'number');
      return '<td>' + (vs.length ? fmt(vs.reduce((a, b) => a + b, 0) / vs.length) : '—') + '</td>';
    }).join('');
    const dead = entry.runs.filter((r) => r.over);
    const wins = game.meta.win ? entry.runs.map((r) => game.meta.win(r.log, game.CONFIG)).filter(Boolean) : [];
    const outcome = wins.length
      ? '<span class="won">WON ' + wins.length + '/' + entry.runs.length + ' (day ' + wins.map((w) => w.day).join(', ') + ')</span>'
      : dead.length
      ? '<span class="dead">bankrupt ' + dead.length + '/' + entry.runs.length + ' (day ' + dead.map((r) => r.endDay).join(', ') + ')</span>'
      : 'survived';
    return '<tr><td><i class="policy-chip" style="display:inline-block;background:' + entry.color + ';margin-right:6px"></i>' + entry.name + '</td>' + cells + '<td>' + outcome + '</td></tr>';
  }).join('');
  els['final-table'].innerHTML = head + rows;
}

// ------------------------------------------------------------------ wire up
for (const name of Object.keys(GAMES)) {
  const opt = document.createElement('option');
  opt.value = name; opt.textContent = name;
  els.game.append(opt);
}
els.game.addEventListener('change', () => loadGame(els.game.value));
els['knob-filter'].addEventListener('input', renderKnobList);
els.run.addEventListener('click', runAll);
addEventListener('resize', () => { if (lastResults) for (const c of charts) drawChart(c); });

await loadGame('lift');
