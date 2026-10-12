// Place and postcode lookup, straight from the browser.
// postcodes.io for UK postcodes; OpenStreetMap Nominatim for everything else
// (its usage policy allows about one request a second, so lookups are cached
// and spaced out).
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const cache = new Map();
let lastNominatim = 0;

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  return res.json();
}

async function postcode(q) {
  const compact = q.replace(/\s+/g, '');
  const outcode = OUTCODE_RE.test(compact);
  const data = await getJson(`https://api.postcodes.io/${outcode ? 'outcodes' : 'postcodes'}/${encodeURIComponent(compact)}`);
  const r = data.result;
  return r ? [{ label: (r.postcode || r.outcode).toUpperCase(), lat: r.latitude, lon: r.longitude }] : [];
}

async function nominatim(q) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const params = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'gb', limit: '6' });
  const data = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
  return data.map((r) => ({
    label: r.display_name.split(',').slice(0, 3).join(',').trim(),
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}

export async function geocode(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let results = [];
  if (POSTCODE_RE.test(q) || OUTCODE_RE.test(q)) {
    try { results = await postcode(q); } catch { results = []; }
  }
  if (!results.length) results = await nominatim(q);
  cache.set(key, results);
  return results;
}
