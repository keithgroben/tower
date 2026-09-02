/**
 * Every policy x N seeds -> out/<game>-sweep.csv. This is the instrument that
 * answers "is the math interesting", so it must stay cheap enough to run often.
 * Usage: node harness/sweep.js <game> [days] [seeds]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGame, play, listGames } from './load.js';

const [, , gameName, daysArg = '60', seedsArg = '5'] = process.argv;
if (!gameName) {
  console.error('usage: node harness/sweep.js <game> [days] [seeds]');
  console.error('games: ' + listGames().join(', '));
  process.exit(1);
}

const game = await loadGame(gameName);
const days = Number(daysArg), seeds = Number(seedsArg);
const rows = [], summary = [];

console.log('\n  ' + game.meta.title + ' - bottleneck: ' + game.meta.bottleneck);
console.log('  ' + days + ' days x ' + seeds + ' seeds x ' + Object.keys(game.POLICIES).length + ' policies\n');

for (const [key, policy] of Object.entries(game.POLICIES)) {
  const lives = [], scores = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const state = play(game, key, days, seed);
    for (const d of state.log) rows.push({ policy: key, seed, ...d });
    lives.push(state.log.length);
    if (game.meta.score) scores.push(game.meta.score(state));
    summary.push({
      policy: key, seed, over: state.over, survived: state.log.length,
      cliff: game.meta.cliff?.(state.log, game.CONFIG) ?? null,
      final: state.log[state.log.length - 1] ?? null,
    });
  }
  const lo = Math.min(...lives), hi = Math.max(...lives);
  const died = summary.filter((s) => s.policy === key && s.over).length;
  let line = '  ' + policy.name.padEnd(40)
    + 'survived ' + String(lo === hi ? lo : lo + '-' + hi).padStart(6) + ' days';
  if (scores.length) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    line += '   ' + (game.meta.scoreLabel || 'score') + ' '
          + String(mean.toFixed(1)).padStart(7);
  }
  if (died) line += '   ended early ' + died + '/' + seeds;
  console.log(line);
}

const cols = ['policy', 'seed', ...game.meta.columns];
const out = path.join(process.cwd(), 'out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, gameName + '-sweep.csv'),
  [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n'));
fs.writeFileSync(path.join(out, gameName + '-sweep-summary.json'), JSON.stringify(summary, null, 2));
console.log('\n  wrote out/' + gameName + '-sweep.csv (' + rows.length + ' rows)\n');
