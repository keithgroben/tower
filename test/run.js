/** Zero-dep test runner. `node test/run.js`. Exits non-zero on any failure. */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let pass = 0, fail = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  for (const [name, fn] of Object.entries(mod.tests ?? {})) {
    try { await fn(); console.log(`  ok   ${f.replace('.test.js', '')} · ${name}`); pass++; }
    catch (e) { console.log(`  FAIL ${f.replace('.test.js', '')} · ${name}\n       ${e.message}`); fail++; }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
