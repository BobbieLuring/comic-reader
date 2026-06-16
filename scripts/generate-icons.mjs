// Generates the PWA app icons (no external deps — hand-rolled PNG encoder).
// Run with: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const BG = [0xf0, 0x94, 0x4b];
const PAPER = [0xff, 0xf6, 0xee];
const INK = [0x5d, 0x46, 0x34];
const LINE = [0xe7, 0xc2, 0xa3];

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  // Book covering the centre, with a darker spine down the middle.
  const m = Math.round(size * 0.22);
  const x0 = m;
  const x1 = size - m;
  const y0 = m;
  const y1 = size - m;
  const spine = Math.max(2, Math.round(size * 0.018));
  const cx = Math.round(size / 2);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const onSpine = Math.abs(x - cx) <= spine;
      set(x, y, onSpine ? INK : PAPER);
    }
  }

  // Suggested text lines on each page.
  const rows = 5;
  const gap = Math.round((y1 - y0) / (rows + 1));
  const th = Math.max(1, Math.round(size * 0.012));
  const pad = Math.round(size * 0.04);
  for (let r = 1; r <= rows; r++) {
    const ly = y0 + r * gap;
    for (let t = 0; t < th; t++) {
      for (let x = x0 + pad; x < cx - spine - pad; x++) set(x, ly + t, LINE);
      for (let x = cx + spine + pad; x < x1 - pad; x++) set(x, ly + t, LINE);
    }
  }

  return buf;
}

// --- minimal PNG encoder ----------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), encodePng(size, draw(size)));
  console.log(`wrote icon-${size}.png`);
}
