// Build script for the thinktank browser extension (MV3).
//
// Why a hand-rolled esbuild build instead of @crxjs/vite-plugin: it is far more
// robust against tooling churn and needs zero extra config. We bundle each
// entry as a classic IIFE (MV3 content scripts are not ES modules), copy the
// static assets, and synthesize placeholder PNG icons with a tiny pure-Node
// PNG encoder (no `sharp` dependency, so the build never fails on a missing
// native module).

import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

async function clean() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'icons'), { recursive: true });
}

async function bundle() {
  await build({
    entryPoints: {
      content: join(src, 'content.ts'),
      background: join(src, 'background.ts'),
      popup: join(src, 'popup.ts'),
    },
    outdir: dist,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  });
}

async function copyStatic() {
  await copyFile(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  await copyFile(join(src, 'popup.html'), join(dist, 'popup.html'));
}

// --- minimal PNG encoder (solid color square placeholder icon) --------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function pngSquare(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function icons() {
  const teal = [20, 184, 166]; // #14b8a6
  for (const size of [16, 48, 128]) {
    await writeFile(join(dist, 'icons', `icon${size}.png`), pngSquare(size, teal));
  }
}

async function main() {
  await clean();
  await Promise.all([bundle(), copyStatic(), icons()]);
  console.log('[extension] build complete -> dist/');
}

main().catch((err) => {
  console.error('[extension] build failed:', err);
  process.exit(1);
});
