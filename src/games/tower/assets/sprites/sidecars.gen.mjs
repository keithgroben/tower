/**
 * Writes a sidecar for every delivered sheet, from `tools/sprite-catalog.json`.
 *
 * The art arrives as one left-to-right strip per subject; the loader needs to
 * know which column each named state starts at. That mapping is the only thing
 * between a folder of PNGs and a drawn tower, and doing it by hand across 28
 * sheets is how a column goes wrong silently — an off-by-one samples the
 * neighbouring state, so the room looks wrong rather than looking broken.
 *
 * The catalogue is the one source: `test/sprites.test.js` holds it level with
 * `spec/asset-request.md` and with the real PNGs, and the ingest tool builds
 * from the same file. Run after an art drop:
 *
 *   node src/games/lift/assets/sprites/sidecars.gen.mjs
 *
 * It refuses to write a sidecar whose frames do not fit the real PNG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(DIR, '..', '..', '..', '..', '..', 'tools', 'sprite-catalog.json');

/** PNG header read: width and height are big-endian u32 at bytes 16 and 20.
 *  Reading the real pixels is the point — a catalogue that disagrees with the
 *  sheet must fail here, not in the browser. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  if (head.toString('latin1', 1, 4) !== 'PNG') throw new Error(file + ' is not a PNG');
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
let written = 0, problems = 0, absent = 0;

for (const [name, entry] of Object.entries(catalog)) {
  if (name.startsWith('$')) continue;

  const png = path.join(DIR, name + '.png');
  if (!fs.existsSync(png)) { absent++; continue; }   // art lands one subject at a time

  const { w, h } = pngSize(png);
  const animations = {};
  let col = 0;
  for (const state of entry.states) {
    animations[state.name] = {
      col,
      frames: state.frames,
      ...(state.speed ? { speed: state.speed } : {}),
      ...(state.loop === false ? { loop: false } : {}),
    };
    col += state.frames;
  }

  if (h !== entry.frameH) { console.error(`MISMATCH ${name}: sheet is ${h}px tall, catalogue says ${entry.frameH}`); problems++; continue; }
  if (col * entry.frameW !== w) { console.error(`MISMATCH ${name}: ${col} frames of ${entry.frameW} = ${col * entry.frameW}px, sheet is ${w}px`); problems++; continue; }

  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify({ frameW: entry.frameW, frameH: entry.frameH, animations }, null, 2) + '\n');
  written++;
}

console.log(`${written} sidecars written, ${absent} sheets not delivered yet, ${problems} problems`);
process.exit(problems ? 1 : 0);
