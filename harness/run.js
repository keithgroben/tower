/**
 * One headless run -> a table on stdout and out/<game>-<policy>-<seed>.json.
 * Usage: node harness/run.js <game> [policy] [days] [seed] [--set path=value ...]
 * --set overrides any numeric config path for this run only, e.g.
 *   --set occupancy.moveInCapacityMax=6 --set elevator.capacity=16
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGame, play, table, listGames } from './load.js';

const positional = [];
const overrides = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--set') {
    const [key, raw] = String(process.argv[++i] ?? '').split('=');
    const value = Number(raw);
    if (!key || !Number.isFinite(value)) { console.error('bad --set: ' + key + '=' + raw); process.exit(1); }
    overrides.push([key, value]);
  } else positional.push(process.argv[i]);
}
const [gameName, policyName, daysArg = '40', seedArg = '1'] = positional;
if (!gameName) {
  console.error('usage: node harness/run.js <game> [policy] [days] [seed] [--set path=value ...]');
  console.error('games: ' + listGames().join(', '));
  process.exit(1);
}

const game = await loadGame(gameName);
for (const [key, value] of overrides) {
  let node = game.CONFIG;
  const parts = key.split('.');
  for (const part of parts.slice(0, -1)) {
    if (node == null || typeof node !== 'object') break;
    node = node[part];
  }
  if (node == null || typeof node[parts.at(-1)] !== 'number') {
    console.error('--set path is not a numeric config value: ' + key);
    process.exit(1);
  }
  node[parts.at(-1)] = value;
  console.log('  override ' + key + ' = ' + value);
}
const policyKey = policyName || Object.keys(game.POLICIES)[0];
const days = Number(daysArg), seed = Number(seedArg);
const state = play(game, policyKey, days, seed);

console.log('\n  ' + game.POLICIES[policyKey].name + '   seed ' + seed
  + '   ' + state.log.length + ' days   daySeconds=' + game.CONFIG.time.daySeconds + '\n');
console.log(table(state.log, game.meta.columns));

const cliff = game.meta.cliff?.(state.log, game.CONFIG) ?? null;
const win = game.meta.win?.(state.log, game.CONFIG) ?? null;
console.log('\n  ' + (state.over ? 'RUN ENDED on day ' + state.day : 'survived all ' + days + ' days'));
if (game.meta.summary) console.log('  ' + game.meta.summary(state, game.CONFIG));
if (cliff) console.log('  ' + cliff.label);
if (win) console.log('  ' + win.label);

const out = path.join(process.cwd(), 'out');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, gameName + '-' + policyKey + '-' + seed + '.json');
fs.writeFileSync(file, JSON.stringify({
  schema: 'lift-run-log/v1', game: gameName, policy: policyKey, seed, days,
  config: game.CONFIG, cliff, over: state.over, log: state.log, events: state.events,
}, null, 2));
console.log('  wrote ' + path.relative(process.cwd(), file) + '\n');
