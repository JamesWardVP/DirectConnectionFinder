// Place / postcode lookup, proxied through the server so results can be
// cached and a proper User-Agent sent (required by Nominatim's usage policy).

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const CACHE_MAX = 500;
const cache = new Map();

const USER_AGENT = process.env.DCF_USER_AGENT
  || 'DirectConnectionFinder/0.1 (https://github.com/JamesWardVP/DirectConnectionFinder)';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  return res.json();
}

async function postcode(q) {
  const compact = q.replace(/\s+/g, '');
  const url = OUTCODE_RE.test(compact)
    ? `https://api.postcodes.io/outcodes/${encodeURIComponent(compact)}`
    : `https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`;
  const data = await fetchJson(url);
  const r = data.result;
  if (!r) return [];
  return [{ label: (r.postcode || r.outcode).toUpperCase(), lat: r.latitude, lon: r.longitude, kind: 'postcode' }];
}

async function nominatim(q) {
  const params = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'gb', limit: '6', addressdetails: '0' });
  const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`);
  return data.map((r) => ({
    label: r.display_name.split(',').slice(0, 3).join(',').trim(),
    lat: Number(r.lat),
    lon: Number(r.lon),
    kind: r.type || 'place',
  }));
}

export async function geocode(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const isPostcode = POSTCODE_RE.test(q) || OUTCODE_RE.test(q);
  let results = [];
  if (isPostcode) {
    try { results = await postcode(q); } catch { results = []; }
  }
  if (!results.length) results = await nominatim(q);
  cache.set(key, results);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return results;
}
