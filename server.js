// Local web GUI for converting macOS dynamic wallpapers (.heic) into
// WinDynamicDesktop themes (.ddw = zip of theme.json + numbered JPEGs).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { SEGMENTS, buildImageLists } from './src/metadata.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(os.tmpdir(), 'heic-to-ddw-jobs');
const PORT = Number(process.env.PORT) || 5178;
const HOST = '127.0.0.1';

await fsp.rm(JOBS_DIR, { recursive: true, force: true });
await fsp.mkdir(JOBS_DIR, { recursive: true });

/** Single-file jobs: { dir, status, done, total, error?, result? } */
const jobs = new Map();
/** Batches: { dir, outDir, quality, credits, items: [...], chain: Promise } */
const batches = new Map();

const app = express();
app.use(express.static(path.join(ROOT, 'public')));

function parseQuality(req) {
  return Math.min(100, Math.max(50, Number(req.get('x-quality')) || 95));
}

async function receiveUpload(req, dir) {
  await fsp.mkdir(dir, { recursive: true });
  const srcPath = path.join(dir, 'source.heic');
  await pipeline(req, fs.createWriteStream(srcPath));
  return srcPath;
}

// Decodes a HEIC in a worker thread, writing img_N.jpg / thumb_N.jpg into dir.
function decodeHeic(srcPath, dir, quality, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(ROOT, 'src', 'worker.js'), {
      workerData: { srcPath, outDir: dir, quality },
    });
    let result;
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress(msg.done, msg.total);
      if (msg.type === 'done') result = msg.result;
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      fsp.rm(srcPath, { force: true });
      if (result) resolve(result);
      else reject(new Error(`Decoder exited with code ${code}`));
    });
  });
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
  return clean || 'Dynamic_Theme';
}

// Turns segment assignments into a theme.json plus the list of JPEGs to pack.
// Throws (with a user-facing message) when the theme would be invalid.
function planTheme(dir, imageCount, { id, displayName, credits, assignments = [], dayHighlight, nightHighlight }) {
  const valid = assignments.filter(
    (a) => Number.isInteger(a.index) && a.index >= 0 && a.index < imageCount && SEGMENTS.includes(a.segment),
  );
  const lists = buildImageLists(valid);
  if (!lists.day.length || !lists.night.length) {
    throw new Error('A theme needs at least one day image and one night image.');
  }

  // Only ship images that a segment actually references, renumbered 1..n.
  const used = [...new Set([...lists.sunrise, ...lists.day, ...lists.sunset, ...lists.night])].sort((a, b) => a - b);
  const renumber = new Map(used.map((orig, i) => [orig, i + 1]));
  const remap = (list) => list.map((n) => renumber.get(n));
  const highlight = (idx) => (Number.isInteger(idx) && renumber.has(idx + 1) ? renumber.get(idx + 1) : undefined);

  const theme = {
    displayName: String(displayName || id).trim(),
    imageFilename: `${id}_*.jpg`,
    imageCredits: String(credits || '').trim() || undefined,
    dayHighlight: highlight(dayHighlight),
    nightHighlight: highlight(nightHighlight),
    sunriseImageList: lists.sunrise.length ? remap(lists.sunrise) : undefined,
    dayImageList: remap(lists.day),
    sunsetImageList: lists.sunset.length ? remap(lists.sunset) : undefined,
    nightImageList: remap(lists.night),
  };
  const files = used.map((orig) => ({
    path: path.join(dir, `img_${orig - 1}.jpg`),
    name: `${id}_${renumber.get(orig)}.jpg`,
  }));
  return { theme, files };
}

// JPEGs and .ddw files don't shrink further, so zips are stored uncompressed.
async function writeZip(output, entries) {
  const zip = new ZipArchive({ store: true });
  const done = new Promise((resolve, reject) => {
    zip.on('error', reject);
    output.on('error', reject);
    output.on(output instanceof fs.WriteStream ? 'close' : 'finish', resolve);
  });
  zip.pipe(output);
  for (const e of entries) {
    if (e.path) zip.file(e.path, { name: e.name });
    else zip.append(e.content, { name: e.name });
  }
  await zip.finalize();
  await done;
}

function writeDdw(output, { theme, files }) {
  return writeZip(output, [{ name: 'theme.json', content: JSON.stringify(theme, null, 2) }, ...files]);
}

// ---------- Single file: upload -> review in editor -> build ----------

app.post('/api/upload', async (req, res) => {
  const id = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, id);
  let srcPath;
  try {
    srcPath = await receiveUpload(req, dir);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }

  const job = { dir, status: 'decoding', done: 0, total: 0 };
  jobs.set(id, job);
  decodeHeic(srcPath, dir, parseQuality(req), (done, total) => Object.assign(job, { done, total })).then(
    (result) => Object.assign(job, { status: 'ready', result }),
    (err) => Object.assign(job, { status: 'error', error: err.message }),
  );
  res.json({ id });
});

function getJob(req, res) {
  const job = jobs.get(req.params.id);
  if (!job) res.status(404).json({ error: 'Unknown job' });
  return job;
}

app.get('/api/job/:id', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  const { status, done, total, error, result } = job;
  res.json({ status, done, total, error, result });
});

app.get('/api/job/:id/thumb/:n', (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 0) return res.status(400).end();
  res.sendFile(path.join(job.dir, `thumb_${n}.jpg`));
});

app.post('/api/job/:id/build', express.json(), async (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  if (job.status !== 'ready') return res.status(409).json({ error: 'Job is not ready yet' });

  const id = sanitizeName(req.body.displayName);
  let plan;
  try {
    plan = planTheme(job.dir, job.result.images.length, { ...req.body, id });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.ddw"`);
  await writeDdw(res, plan).catch((err) => res.destroy(err));
});

app.delete('/api/job/:id', async (req, res) => {
  const job = getJob(req, res);
  if (!job) return;
  jobs.delete(req.params.id);
  await fsp.rm(job.dir, { recursive: true, force: true });
  res.status(204).end();
});

// ---------- Batch: many HEICs -> auto-segmented .ddw each -> one zip ----------

app.post('/api/batch', express.json(), async (req, res) => {
  const id = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, `batch-${id}`);
  const outDir = path.join(dir, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  batches.set(id, {
    dir,
    outDir,
    quality: Math.min(100, Math.max(50, Number(req.body?.quality) || 95)),
    credits: String(req.body?.credits || ''),
    items: [],
    usedIds: new Set(),
    chain: Promise.resolve(),
  });
  res.json({ id });
});

function getBatch(req, res) {
  const batch = batches.get(req.params.id);
  if (!batch) res.status(404).json({ error: 'Unknown batch' });
  return batch;
}

function uniqueId(batch, name) {
  const base = sanitizeName(name);
  let id = base;
  for (let n = 2; batch.usedIds.has(id.toLowerCase()); n++) id = `${base}_${n}`;
  batch.usedIds.add(id.toLowerCase());
  return id;
}

// Files are decoded strictly one after another: each 5-6K frame is large, and
// running several libheif instances at once would multiply memory use.
async function processBatchItem(batch, item, srcPath) {
  const dir = path.dirname(srcPath);
  try {
    if (batch.cancelled) return;
    item.status = 'decoding';
    const result = await decodeHeic(srcPath, dir, batch.quality, (done, total) => Object.assign(item, { done, total }));
    item.status = 'packaging';
    item.metaKind = result.metaKind;
    if (!result.metaKind) throw new Error('No dynamic-wallpaper schedule found; convert this file individually.');
    const id = uniqueId(batch, item.name);
    const plan = planTheme(dir, result.images.length, {
      id,
      displayName: item.name,
      credits: batch.credits,
      assignments: result.images,
      dayHighlight: result.highlights.day,
      nightHighlight: result.highlights.night,
    });
    await writeDdw(fs.createWriteStream(path.join(batch.outDir, `${id}.ddw`)), plan);
    Object.assign(item, { status: 'done', output: `${id}.ddw`, images: plan.files.length });
  } catch (err) {
    Object.assign(item, { status: 'error', error: err.message });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

app.post('/api/batch/:id/file', async (req, res) => {
  const batch = getBatch(req, res);
  if (!batch) return;
  const name = decodeURIComponent(req.get('x-filename') || 'theme.heic').replace(/\.[^.]+$/, '');
  const item = { name, status: 'queued', done: 0, total: 0 };
  const dir = path.join(batch.dir, `item-${batch.items.length}`);
  batch.items.push(item);
  let srcPath;
  try {
    srcPath = await receiveUpload(req, dir);
  } catch (err) {
    Object.assign(item, { status: 'error', error: `Upload failed: ${err.message}` });
    return res.status(400).json({ error: item.error });
  }
  batch.chain = batch.chain.then(() => processBatchItem(batch, item, srcPath));
  res.json({ index: batch.items.length - 1 });
});

app.get('/api/batch/:id', (req, res) => {
  const batch = getBatch(req, res);
  if (!batch) return;
  res.json({ items: batch.items });
});

app.get('/api/batch/:id/download', async (req, res) => {
  const batch = getBatch(req, res);
  if (!batch) return;
  if (batch.items.some((i) => !['done', 'error'].includes(i.status))) {
    return res.status(409).json({ error: 'Batch is still processing' });
  }
  const outputs = batch.items.filter((i) => i.status === 'done').map((i) => i.output);
  if (!outputs.length) return res.status(400).json({ error: 'No themes were converted successfully' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="ddw-themes.zip"');
  await writeZip(res, outputs.map((name) => ({ path: path.join(batch.outDir, name), name }))).catch((err) =>
    res.destroy(err),
  );
});

app.delete('/api/batch/:id', async (req, res) => {
  const batch = getBatch(req, res);
  if (!batch) return;
  batches.delete(req.params.id);
  batch.cancelled = true;
  // Let any in-flight item finish before deleting its folder out from under it.
  batch.chain.finally(() => fsp.rm(batch.dir, { recursive: true, force: true }));
  res.status(204).end();
});

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`HEIC → DDW converter running at ${url}`);
  if (!process.argv.includes('--no-open') && process.platform === 'win32') exec(`start "" "${url}"`);
});
