export const KM_PER_MILE = 1.609344;

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const money = (n) => `£${Number(n).toFixed(2)}`;

export function fmtMiles(km) {
  const mi = km / KM_PER_MILE;
  return mi < 0.1 ? 'at the station' : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

export function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', opts);
}

export const changesLabel = (changes) => (changes === 0 ? 'Direct' : `${changes} change${changes > 1 ? 's' : ''}`);

/** Leaflet dash patterns per number of changes: solid, dashed, dotted, dash-dot. */
export function dashFor(changes, weight = 6) {
  const w = weight;
  switch (Math.min(changes, 3)) {
    case 0: return { dashArray: null, lineCap: 'round' };
    case 1: return { dashArray: `${w * 2.2} ${w * 1.4}`, lineCap: 'butt' };
    case 2: return { dashArray: `0.1 ${w * 1.7}`, lineCap: 'round' };
    default: return { dashArray: `${w * 2.4} ${w} 0.1 ${w}`, lineCap: 'round' };
  }
}

/** Same pattern as SVG attributes for list swatches. */
export function swatchSvg(color, changes) {
  const d = { 0: '', 1: 'stroke-dasharray="11 7"', 2: 'stroke-dasharray="0.1 8.5" stroke-linecap="round"', 3: 'stroke-dasharray="12 5 0.1 5" stroke-linecap="round"' }[Math.min(changes, 3)];
  return `<svg class="swatch" viewBox="0 0 46 12" aria-hidden="true"><line x1="4" y1="6" x2="42" y2="6" stroke="${color}" stroke-width="5" ${d}/></svg>`;
}

function hexToHsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

const hsl = (h, s, l) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;

/**
 * Colour for a route given its position in the ranking. t = 0 is the best
 * route (full saturation); t = 1 the worst (mostly grey, lighter).
 */
export function rankColor(hex, t) {
  const [h, s, l] = hexToHsl(hex || '#0019A8');
  const sat = Math.max(s, 55) * (1 - 0.88 * t);
  const light = l + (82 - l) * 0.75 * t;
  return hsl(h, sat, light);
}

/** Stable fallback colour for operators without one. */
export function colorForName(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `#${hslToHex(h, 70, 38)}`;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const opColor = (op) => op?.color || colorForName(op?.name || '?');

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
