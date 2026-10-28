// Generates the extension icons (simple timeline bars) as PNGs without
// dependencies. Run: node scripts/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const bg = [24, 28, 38, 255];
  const bars = [
    { y: 0.22, x0: 0.18, x1: 0.62, c: [16, 163, 127, 255] },
    { y: 0.47, x0: 0.38, x1: 0.84, c: [99, 132, 255, 255] },
    { y: 0.72, x0: 0.12, x1: 0.48, c: [245, 166, 35, 255] },
  ];
  const r = size * 0.2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      // rounded square background
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      let px = dx * dx + dy * dy <= r * r ? bg : [0, 0, 0, 0];
      for (const b of bars) {
        const h = Math.max(1, size * 0.12);
        if (Math.abs(y - b.y * size - h / 2) <= h / 2 && x >= b.x0 * size && x <= b.x1 * size) px = b.c;
      }
      row.push(...px);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon${s}.png`, import.meta.url), png(s));
console.log('icons written');
