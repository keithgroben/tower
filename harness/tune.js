/**
 * Sweep one config value and watch what it does to the SPREAD between policies.
 *
 * Score alone is the wrong thing to optimise — a change that makes every policy
 * richer has made the game easier, not better. What matters is whether playing
 * well beats playing badly. That is `spread`: (best - worst) / best. Near zero
 * means the player's decision is free and there is no game in this dimension,
 * however pretty the numbers look.
 *
 * Usage: node harness/tune.js <game> <config.path> <v1> <v2> ...
 *   node harness/tune.js bloom plant.growthCurve 1 1.5 2 3 4
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGame, play, listGames } from './load.js';

const [, , gameName, cfgPath, ...values] = process.argv;
if (!gameName || !cfgPath || !values.length) {
  console.error('usage: node harness/tune.js <game> <config.path> <v1> <v2> ...');
  console.error('games: ' + listGames().join(', '));
  process.exit(1);
}

const DAYS = Number(process.env.TUNE_DAYS || 40);
const SEEDS = Number(process.env.TUNE_SEEDS || 3);

const game = await loadGame(gameName);
if (!game.meta.score) {
  console.error(gameName + '/game.js has no meta.score, so there is nothing to tune against');
  process.exit(1);
}

const dig = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const put = (o, p, v) => {
  const k = p.split('.'); const last = k.pop();
  k.reduce((a, x) => a[x], o)[last] = v;
};

if (dig(game.CONFIG, cfgPath) === undefined) {
  console.error('no such config path: ' + cfgPath);
  process.exit(1);
}

const original = dig(game.CONFIG, cfgPath);
const policies = Object.keys(game.POLICIES);
const rows = [];

console.log('\n  ' + game.meta.title + '  ·  tuning ' + cfgPath
  + '  (was ' + JSON.stringify(original) + ')');
console.log('  ' + DAYS + ' days x ' + SEEDS + ' seeds x ' + policies.length + ' policies per value\n');

const W = 13;
console.log('  ' + 'value'.padEnd(10) + policies.map((p) => p.slice(0, W - 1).padStart(W)).join('')
  + '   BEST'.padStart(14) + 'spread'.padStart(9));
console.log('  ' + '-'.repeat(10 + policies.length * W + 23));

for (const raw of values) {
  const v = Number.isNaN(Number(raw)) ? raw : Number(raw);
  put(game.CONFIG, cfgPath, v);

  const scores = {};
  for (const key of policies) {
    let total = 0;
    for (let seed = 1; seed <= SEEDS; seed++) total += game.meta.score(play(game, key, DAYS, seed));
    scores[key] = total / SEEDS;
  }

  const vals = Object.values(scores);
  const best = Math.max(...vals), worst = Math.min(...vals);
  const bestKey = policies.find((k) => scores[k] === best);
  // Spread is the headline. It answers "does skill pay?", which is the only
  // question a tuning pass can actually settle without a human playing.
  const spread = best > 0 ? ((best - worst) / best) * 100 : 0;

  rows.push({ value: v, ...scores, best: bestKey, bestScore: +best.toFixed(1), spread: +spread.toFixed(1) });
  console.log('  ' + String(v).padEnd(10)
    + policies.map((p) => scores[p].toFixed(1).padStart(W)).join('')
    + ('  ' + bestKey).padStart(14)
    + (spread.toFixed(0) + '%').padStart(9));
}

put(game.CONFIG, cfgPath, original);

const out = path.join(process.cwd(), 'out');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, gameName + '-tune-' + cfgPath.replace(/\./g, '_') + '.json');
fs.writeFileSync(file, JSON.stringify({
  schema: 'lift-tune/v1', game: gameName, path: cfgPath, original, days: DAYS, seeds: SEEDS, rows,
}, null, 2));

const bestRow = rows.reduce((a, b) => (b.spread > a.spread ? b : a));
console.log('\n  widest spread at ' + cfgPath + ' = ' + bestRow.value
  + '  (' + bestRow.spread + '% between best and worst play, best = ' + bestRow.best + ')');
console.log('  spread near 0% means the player\'s choice in this dimension is free.');
console.log('  wrote ' + path.relative(process.cwd(), file) + '\n');
