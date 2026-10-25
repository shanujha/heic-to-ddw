// Decodes every image in a HEIC file off the main thread so the server stays
// responsive while libheif (WASM) chews through multi-megapixel frames.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import decode from 'heic-decode';
import { extractAppleMetadata, suggestSegments } from './metadata.js';

const { srcPath, outDir, quality } = workerData;

const buffer = await fs.readFile(srcPath);
const meta = extractAppleMetadata(buffer);
const images = await decode.all({ buffer });
parentPort.postMessage({ type: 'progress', done: 0, total: images.length });

const info = [];
for (let i = 0; i < images.length; i++) {
  const { width, height, data } = await images[i].decode();
  const raw = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  });
  await raw.clone().jpeg({ quality, mozjpeg: true }).toFile(path.join(outDir, `img_${i}.jpg`));
  await raw.clone().resize({ width: 360 }).jpeg({ quality: 80 }).toFile(path.join(outDir, `thumb_${i}.jpg`));
  info.push({ index: i, width, height });
  parentPort.postMessage({ type: 'progress', done: i + 1, total: images.length });
}
images.dispose();

const suggestion = suggestSegments(images.length, meta);
for (const img of suggestion.images) Object.assign(img, info[img.index]);

parentPort.postMessage({
  type: 'done',
  result: { metaKind: meta?.kind ?? null, ...suggestion },
});
