/**
 * Regenerates `placeholder.png` — the checked-in stand-in sheet that proves the
 * loader works before any real art exists. Three 48x32 frames, flat colours
 * from the game palette, transparent margin so alpha is exercised too.
 *
 *   node src/games/lift/assets/sprites/placeholder.gen.mjs
 *
 * Zero dependencies on purpose: `zlib` and a CRC table are the whole of a PNG
 * encoder at this size, and `npm install` must never become required to run a
 * test (see CLAUDE.md).
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAME_W = 48, FRAME_H = 32, MARGIN = 2;
// vacant (panel grey) · occupied-day frame 1 (good green) · frame 2 (dimmed)
const FRAMES = [[0x1b, 0x24, 0x30], [0x3d, 0xdc, 0x97], [0x2c, 0xa0, 0x6e]];

const W = FRAME_W * FRAMES.length, H = FRAME_H;

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// One filter byte (0 = none) then RGBA per pixel, per scanline.
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0;
  for (let x = 0; x < W; x++) {
    const [r, g, b] = FRAMES[Math.floor(x / FRAME_W)];
    const inFrameX = x % FRAME_W;
    const solid = inFrameX >= MARGIN && inFrameX < FRAME_W - MARGIN && y >= MARGIN && y < H - MARGIN;
    const p = row + 1 + x * 4;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = solid ? 255 : 0;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type: RGBA
// 10..12 = compression 0, filter 0, interlace 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'placeholder.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`);
