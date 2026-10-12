// Builds public/data/coastline.geojson from a Natural Earth admin-0 countries
// GeoJSON file. The output is a simplified outline of Great Britain and its
// neighbours, drawn as a faint backdrop on the white Tube-style map.
//
// Usage: node scripts/build-outline.js path/to/ne_10m_admin_0_countries.geojson
import fs from 'node:fs';

const KEEP = new Set(['GBR', 'IRL', 'IMN', 'JEY', 'GGY', 'FRA', 'BEL', 'NLD']);
const BBOX = { minLon: -11.5, maxLon: 4, minLat: 48.5, maxLat: 61.5 };
const TOLERANCE = 0.008; // degrees

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/build-outline.js <countries.geojson>');
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(src, 'utf8'));

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

const inBox = ([lon, lat]) =>
  lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;

const features = [];
for (const f of input.features) {
  const iso = f.properties.ADM0_A3 || f.properties.ISO_A3;
  if (!KEEP.has(iso)) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const out = [];
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer.some(inBox)) continue;
    const ring = simplify(outer, TOLERANCE).map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);
    if (ring.length >= 4) out.push([ring]);
  }
  if (out.length) {
    features.push({
      type: 'Feature',
      properties: { iso, home: ['GBR', 'IMN', 'JEY', 'GGY'].includes(iso) },
      geometry: { type: 'MultiPolygon', coordinates: out },
    });
  }
}

fs.writeFileSync('public/data/coastline.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Wrote ${features.length} features`);
