/**
 * Generates simple orange PNG icons with letter G — no external deps.
 * Usage: node scripts/make-icons.mjs
 */
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public");

const ORANGE = [196, 92, 38, 255]; // #C45C26
const WHITE = [255, 255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, t, data, crc]);
}

function setPixel(rgba, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = color[3];
}

function fillRect(rgba, size, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPixel(rgba, size, x, y, color);
  }
}

/** Simple block letter G */
function drawG(rgba, size) {
  const s = Math.floor(size * 0.55);
  const ox = Math.floor((size - s) / 2);
  const oy = Math.floor((size - s) / 2);
  const t = Math.max(2, Math.floor(s * 0.14));
  fillRect(rgba, size, ox, oy, s, t, WHITE);
  fillRect(rgba, size, ox, oy, t, s, WHITE);
  fillRect(rgba, size, ox, oy + s - t, s, t, WHITE);
  fillRect(rgba, size, ox + s - t, oy + Math.floor(s / 2), t, Math.floor(s / 2), WHITE);
  fillRect(rgba, size, ox + Math.floor(s / 2), oy + Math.floor(s / 2) - Math.floor(t / 2), Math.floor(s / 2), t, WHITE);
}

function pngBuffer(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = ORANGE[0];
    rgba[i * 4 + 1] = ORANGE[1];
    rgba[i * 4 + 2] = ORANGE[2];
    rgba[i * 4 + 3] = ORANGE[3];
  }
  drawG(rgba, size);

  const raw = Buffer.alloc((size * (1 + size * 4)));
  let off = 0;
  for (let y = 0; y < size; y++) {
    raw[off++] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[off++] = rgba[i];
      raw[off++] = rgba[i + 1];
      raw[off++] = rgba[i + 2];
      raw[off++] = rgba[i + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePng(name, size) {
  const path = join(outDir, name);
  const buf = pngBuffer(size);
  createWriteStream(path).end(buf);
  console.log(`Wrote ${path} (${size}x${size})`);
}

writePng("icon-192.png", 192);
writePng("icon-512.png", 512);
