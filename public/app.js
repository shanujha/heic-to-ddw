const $ = (id) => document.getElementById(id);
const SEGMENT_LABELS = { sunrise: 'Sunrise', day: 'Day', sunset: 'Sunset', night: 'Night', unused: 'Unused' };

let jobId = null;
let images = [];
let highlights = {};
let pollTimer = null;

$('quality').addEventListener('input', (e) => ($('qualityOut').textContent = e.target.value));
$('file').addEventListener('change', (e) => handleFiles(e.target.files));

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFiles(e.dataTransfer.files);
});

$('cancel').addEventListener('click', reset);
$('restart').addEventListener('click', reset);
$('build').addEventListener('click', build);
$('batchRestart').addEventListener('click', reset);
$('batchDownload').addEventListener('click', downloadBatch);

function show(section) {
  for (const id of ['pick', 'progress', 'editor', 'batch']) $(id).hidden = id !== section;
}

function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(heic|heif)$/i.test(f.name));
  if (files.length === 1) start(files[0]);
  else if (files.length > 1) startBatch(files);
}

function setProgress(text, fraction) {
  $('progressText').textContent = text;
  $('progressBar').style.width = `${Math.round(fraction * 100)}%`;
}

async function start(file) {
  show('progress');
  setProgress(`Uploading ${file.name}…`, 0);
  $('name').value = file.name.replace(/\.[^.]+$/, '');
  $('credits').value = $('pickCredits').value;
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Quality': $('quality').value },
      body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    jobId = body.id;
    poll();
  } catch (err) {
    fail(err.message);
  }
}

async function poll() {
  const id = jobId;
  const res = await fetch(`/api/job/${id}`);
  if (id !== jobId) return;
  const job = await res.json();
  if (!res.ok || job.status === 'error') return fail(job.error || 'Conversion failed');
  if (job.status === 'ready') return openEditor(job.result);
  setProgress(job.total ? `Decoding image ${job.done} of ${job.total}…` : 'Reading HEIC…', job.total ? job.done / job.total : 0.02);
  pollTimer = setTimeout(poll, 400);
}

function fail(message) {
  setProgress(`Error: ${message}`, 0);
  $('progressBar').style.width = '0';
}

function openEditor(result) {
  images = result.images.map((img) => ({ ...img }));
  highlights = { ...result.highlights };
  $('note').textContent = `${images.length} image${images.length === 1 ? '' : 's'} found. ${result.note}`;
  renderGrid();
  renderSummary();
  show('editor');
}

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren();
  const tpl = $('tile');
  const ordered = [...images].sort((a, b) => a.order - b.order || a.index - b.index);
  for (const img of ordered) {
    const tile = tpl.content.firstElementChild.cloneNode(true);
    tile.querySelector('img').src = `/api/job/${jobId}/thumb/${img.index}`;
    tile.querySelector('.num').textContent = `#${img.index + 1}`;
    tile.querySelector('.detail').textContent = img.detail || `${img.width}×${img.height}`;
    const select = tile.querySelector('.segment');
    select.value = img.segment;
    select.addEventListener('change', () => {
      img.segment = select.value;
      styleTile(tile, img);
      renderSummary();
    });
    const [dayRadio, nightRadio] = tile.querySelectorAll('input[type=radio]');
    dayRadio.checked = highlights.day === img.index;
    nightRadio.checked = highlights.night === img.index;
    dayRadio.addEventListener('change', () => (highlights.day = img.index));
    nightRadio.addEventListener('change', () => (highlights.night = img.index));
    styleTile(tile, img);
    grid.append(tile);
  }
}

function styleTile(tile, img) {
  tile.style.setProperty('--seg', `var(--${img.segment})`);
  tile.classList.toggle('unused', img.segment === 'unused');
}

function renderSummary() {
  const counts = Object.fromEntries(Object.keys(SEGMENT_LABELS).map((k) => [k, 0]));
  for (const img of images) counts[img.segment]++;
  $('summary').replaceChildren(
    ...Object.entries(counts)
      .filter(([seg, n]) => n || seg !== 'unused')
      .map(([seg, n]) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = `var(--${seg})`;
        chip.textContent = `${SEGMENT_LABELS[seg]}: ${n}`;
        return chip;
      }),
  );
  const ok = counts.day > 0 && counts.night > 0;
  $('build').disabled = !ok;
  $('buildStatus').textContent = ok ? '' : 'Assign at least one Day and one Night image.';
}

async function build() {
  const btn = $('build');
  btn.disabled = true;
  $('buildStatus').textContent = 'Packaging theme…';
  try {
    const res = await fetch(`/api/job/${jobId}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: $('name').value,
        credits: $('credits').value,
        assignments: images.map(({ index, segment, order }) => ({ index, segment, order })),
        dayHighlight: highlights.day,
        nightHighlight: highlights.night,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition'))?.[1] || 'theme.ddw';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $('buildStatus').textContent = `Saved ${filename}. Double-click it (or use WinDynamicDesktop → Import) to install.`;
  } catch (err) {
    $('buildStatus').textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Batch mode ----------

let batchId = null;
let batchFiles = [];
let uploadingIndex = -1;

async function startBatch(files) {
  batchFiles = files;
  uploadingIndex = -1;
  show('batch');
  $('batchDownload').disabled = true;
  renderBatch([]);
  try {
    const res = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: $('pickCredits').value, quality: $('quality').value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    batchId = body.id;
  } catch (err) {
    $('batchText').textContent = `Error: ${err.message}`;
    return;
  }
  const id = batchId;
  pollBatch();
  // Upload sequentially; the server starts decoding the first file while later
  // ones are still uploading, and processes them strictly in order.
  for (let i = 0; i < files.length; i++) {
    if (id !== batchId) return;
    uploadingIndex = i;
    await fetch(`/api/batch/${id}/file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(files[i].name),
      },
      body: files[i],
    }).catch(() => {});
  }
  uploadingIndex = -1;
}

async function pollBatch() {
  const id = batchId;
  const res = await fetch(`/api/batch/${id}`).catch(() => null);
  if (id !== batchId) return;
  if (!res?.ok) {
    $('batchText').textContent = 'Error: lost connection to the converter';
    return;
  }
  const { items } = await res.json();
  renderBatch(items);
  const finished = items.filter((i) => i.status === 'done' || i.status === 'error').length;
  if (finished < batchFiles.length) pollTimer = setTimeout(pollBatch, 700);
}

const STATUS_TEXT = {
  waiting: () => 'Waiting',
  uploading: () => 'Uploading…',
  queued: () => 'Queued',
  decoding: (i) => (i.total ? `Decoding ${i.done}/${i.total}` : 'Reading…'),
  packaging: () => 'Packaging…',
  done: (i) => `✓ ${i.output} · ${i.images} images`,
  error: (i) => `✗ ${i.error}`,
};

function renderBatch(items) {
  let progress = 0;
  const rows = batchFiles.map((file, i) => {
    const item = items[i] || { status: i === uploadingIndex ? 'uploading' : 'waiting' };
    const frac = item.status === 'done' || item.status === 'error' ? 1
      : item.status === 'packaging' ? 0.95
      : item.total ? (item.done / item.total) * 0.9 : 0;
    progress += frac;
    const li = document.createElement('li');
    li.className = item.status;
    const name = document.createElement('span');
    name.textContent = file.name;
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = STATUS_TEXT[item.status](item);
    const mini = document.createElement('div');
    mini.className = 'mini';
    mini.append(Object.assign(document.createElement('div'), { style: `width:${frac * 100}%` }));
    li.append(name, status, mini);
    return li;
  });
  $('batchList').replaceChildren(...rows);
  $('batchBar').style.width = `${(progress / batchFiles.length) * 100}%`;

  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const allFinished = done + failed === batchFiles.length;
  $('batchText').textContent = allFinished
    ? `Finished: ${done} converted${failed ? `, ${failed} failed` : ''}`
    : `Converting ${Math.min(done + failed + 1, batchFiles.length)} of ${batchFiles.length}…`;
  $('batchDownload').disabled = !allFinished || !done;
}

async function downloadBatch() {
  const btn = $('batchDownload');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/batch/${batchId}/download`);
    if (!res.ok) throw new Error((await res.json()).error);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'ddw-themes.zip' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    $('batchText').textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function reset() {
  clearTimeout(pollTimer);
  if (jobId) fetch(`/api/job/${jobId}`, { method: 'DELETE' }).catch(() => {});
  if (batchId) fetch(`/api/batch/${batchId}`, { method: 'DELETE' }).catch(() => {});
  batchId = null;
  batchFiles = [];
  jobId = null;
  images = [];
  $('file').value = '';
  $('grid').replaceChildren();
  show('pick');
}
