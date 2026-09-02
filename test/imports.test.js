/**
 * The files no test imports.
 *
 * `ui/main.js` called `resetFacilitySimTripCounters` without importing it. In
 * Node that is invisible — nothing loads `main.js`, because it touches
 * `document` at module scope, so no test can. In the browser it is a
 * `ReferenceError` on the first cashflow day, caught by the frame handler,
 * which pauses the game and shows a banner.
 *
 * **The build stopped itself on day 3 and the suite stayed green.** I had
 * already told Keith to go and play it.
 *
 * A static check is the honest guard. Importing `main.js` under a stubbed DOM
 * would test a shape the browser never runs, and stubbing is how you end up
 * with a passing test for a page that does not load.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Source with comments stripped, so a name in prose is not a call. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

/** Platform and language builtins a browser module may call freely. */
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'super', 'function',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'parseFloat', 'parseInt', 'isNaN', 'addEventListener',
  'removeEventListener', 'queueMicrotask', 'structuredClone', 'fetch', 'alert',
]);

/** Every bare `name(` call that is neither imported nor declared in the file. */
function unresolvedCalls(rel) {
  const src = code(rel);
  const imported = new Set(
    [...src.matchAll(/import\s*\{([^}]+)\}/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()))
      .filter(Boolean),
  );
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) imported.add(m[1]);
  const declared = new Set(
    [...src.matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]),
  );
  const called = new Set(
    [...src.matchAll(/(?<![.\w$'"`])([a-z][A-Za-z0-9_$]{2,})\s*\(/g)].map((m) => m[1]),
  );
  return [...called].filter((n) => !imported.has(n) && !declared.has(n) && !BUILTIN.has(n));
}

/** Files that touch the DOM at module scope, so no test can import them. */
const UNIMPORTABLE = [
  '../src/games/tower/ui/main.js',
];

export const tests = {
  'every name a DOM-only module calls is one it imported or declared'() {
    for (const rel of UNIMPORTABLE) {
      const missing = unresolvedCalls(rel);
      assert(missing.length === 0,
        rel + ' calls ' + missing.join(', ') + ' without importing or declaring it. '
        + 'That is a ReferenceError in the browser and invisible to every other test here.');
    }
  },

  /**
   * Bounded and negated: the check must be able to fail. Without this, a regex
   * that quietly matched nothing would pass forever and guard nothing — which
   * is the same shape as the bug it is here to catch.
   */
  'the check would actually catch a missing import'() {
    const missing = unresolvedCalls('./fixtures/missing-import.fixture.js');
    assert(missing.includes('resetFacilitySimTripCounters'),
      'the fixture calls resetFacilitySimTripCounters without importing it and the check '
      + 'did not notice — it found [' + missing.join(', ') + ']');
  },

  'and it does not cry wolf over a clean file'() {
    const missing = unresolvedCalls('./fixtures/clean-import.fixture.js');
    assert(missing.length === 0,
      'a clean file was flagged for ' + missing.join(', ') + ' — the check has false positives, '
      + 'and a guard that cries wolf gets switched off');
  },
};
