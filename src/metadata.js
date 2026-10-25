// Reads the dynamic-wallpaper metadata macOS embeds in .heic files and maps it
// onto WinDynamicDesktop's four segments (sunrise / day / sunset / night).
//
// macOS stores the schedule as a base64 binary plist inside the XMP packet, under
// one of these properties:
//   apple_desktop:solar  -> { si: [{ i, a (altitude), z (azimuth) }], ap: { l, d } }
//   apple_desktop:h24    -> { ti: [{ i, t (fraction of day) }],       ap: { l, d } }
//   apple_desktop:apr    -> { l, d }  (light / dark appearance only)
import * as bplist from 'bplist-parser';

export const SEGMENTS = ['sunrise', 'day', 'sunset', 'night', 'unused'];

const KINDS = ['solar', 'h24', 'apr'];

export function extractAppleMetadata(buffer) {
  // XMP is stored uncompressed, so a byte scan is enough and avoids walking the
  // whole ISOBMFF box tree. latin1 maps bytes 1:1 so offsets stay sane.
  const text = buffer.toString('latin1');
  const found = {};
  const attr = /apple_desktop:(solar|h24|apr)\s*=\s*["']([A-Za-z0-9+/=\s]+)["']/g;
  const elem = /<apple_desktop:(solar|h24|apr)>([A-Za-z0-9+/=\s]+)<\/apple_desktop:\1>/g;
  for (const re of [attr, elem]) {
    let m;
    while ((m = re.exec(text))) {
      if (found[m[1]]) continue;
      try {
        const [plist] = bplist.parseBuffer(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
        found[m[1]] = plist;
      } catch {
        // Corrupt or non-bplist payload: ignore and fall back to other kinds.
      }
    }
  }
  const kind = KINDS.find((k) => found[k]);
  return kind ? { kind, plist: found[kind] } : null;
}

// Hours of the day used to bucket h24 (time-based) wallpapers.
function segmentForHour(h) {
  if (h >= 5 && h < 8) return 'sunrise';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'sunset';
  return 'night';
}

function segmentForSun(altitude, azimuth) {
  if (altitude >= 15) return 'day';
  if (altitude <= -10) return 'night';
  return azimuth < 180 ? 'sunrise' : 'sunset';
}

// Returns one entry per image: { index, segment, order, detail }.
// `order` is a 0-360 "time of day" key (azimuth for solar, scaled time for h24),
// used to sort images inside each segment.
export function suggestSegments(imageCount, meta) {
  const images = Array.from({ length: imageCount }, (_, index) => ({
    index,
    segment: 'unused',
    order: index,
    detail: '',
  }));

  if (!meta) {
    // No schedule: keep file order and let the user assign segments by hand.
    for (const img of images) img.segment = 'day';
    return { images, highlights: {}, note: 'No macOS dynamic-wallpaper metadata found. Assign segments manually.' };
  }

  const { kind, plist } = meta;
  const ap = kind === 'apr' ? plist : plist.ap || {};

  if (kind === 'solar') {
    for (const s of plist.si || []) {
      const img = images[s.i];
      if (!img || img.detail) continue;
      img.segment = segmentForSun(s.a, s.z);
      img.order = s.z;
      img.detail = `alt ${s.a.toFixed(1)}°, az ${s.z.toFixed(1)}°`;
    }
  } else if (kind === 'h24') {
    for (const t of plist.ti || []) {
      const img = images[t.i];
      if (!img || img.detail) continue;
      const hours = (t.t * 24) % 24;
      img.segment = segmentForHour(hours);
      img.order = hours * 15;
      const hh = Math.floor(hours);
      const mm = Math.round((hours - hh) * 60);
      img.detail = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  } else {
    if (images[ap.l]) Object.assign(images[ap.l], { segment: 'day', detail: 'light' });
    if (images[ap.d]) Object.assign(images[ap.d], { segment: 'night', detail: 'dark' });
  }

  // WinDynamicDesktop needs at least one day and one night image. Sparse
  // schedules (e.g. 4 images at 00:00/04:30/18:30/21:30) may miss one, so promote
  // the scheduled image closest to noon (order 180) or midnight (order 0/360).
  const scheduled = images.filter((img) => img.detail);
  for (const [segment, target] of [['day', 180], ['night', 0]]) {
    if (scheduled.some((img) => img.segment === segment)) continue;
    const distance = (img) => Math.min(Math.abs(img.order - target), 360 - Math.abs(img.order - target));
    const pool = scheduled.filter((img) => img.segment !== (segment === 'day' ? 'night' : 'day'));
    const best = pool.sort((a, b) => distance(a) - distance(b))[0];
    if (best) best.segment = segment;
  }

  const highlights = {};
  if (images[ap.l]) highlights.day = ap.l;
  if (images[ap.d]) highlights.night = ap.d;

  return { images, highlights, note: `Schedule read from apple_desktop:${kind} metadata.` };
}

// Sort key inside a segment. Night spans midnight, so start it from the evening
// (order ~270+) and wrap to the early morning images.
function sortKey(segment, order) {
  return segment === 'night' ? (order + 180) % 360 : order;
}

// assignments: [{ index, segment, order }] -> theme.json image lists (1-based ids).
export function buildImageLists(assignments) {
  const lists = { sunrise: [], day: [], sunset: [], night: [] };
  const sorted = [...assignments].sort(
    (a, b) => sortKey(a.segment, a.order) - sortKey(b.segment, b.order) || a.index - b.index,
  );
  for (const a of sorted) {
    if (lists[a.segment]) lists[a.segment].push(a.index + 1);
  }
  return lists;
}
