// Builds the static website into dist/ (what GitHub Pages serves), including
// the timetable bundle at dist/data/timetable.json.
//
// Usage:
//   node scripts/build-site.js [--source demo|gtfs|cif] [--input path] [--days 28] [--start YYYY-MM-DD] [--out dist]
//
// Environment variables DCF_SOURCE, DCF_INPUT, DCF_DAYS and DCF_START work too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGtfs } from '../lib/gtfs.js';
import { loadCif } from '../lib/cif.js';
import { applyChangeTimes, readInterchange } from '../lib/interchange.js';
import { encodeBundle } from '../public/js/core/bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args() {
  const out = {
    source: process.env.DCF_SOURCE || 'demo',
    input: process.env.DCF_INPUT || '',
    days: Number(process.env.DCF_DAYS) || 28,
    start: process.env.DCF_START || '',
    out: 'dist',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in out)) throw new Error(`Unknown option ${argv[i]}`);
    out[key] = key === 'days' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!out.start) out.start = londonToday();
  return out;
}

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function readLinks() {
  return fs.readFileSync(path.join(ROOT, 'data', 'links.csv'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('from_crs'))
    .map((l) => { const [a, b, m, mode] = l.split(','); return [a, b, Number(m), mode.trim()]; });
}

/** Add curated interchange links (e.g. across London) where the feed has none. */
function addLinks(feed, links) {
  const have = new Set(feed.transfers.map((t) => `${t.from}|${t.to}`));
  for (const [a, b, minutes, mode] of links) {
    const from = feed.stationIndexByCrs.get(a), to = feed.stationIndexByCrs.get(b);
    if (from === undefined || to === undefined) continue;
    for (const [x, y] of [[from, to], [to, from]]) {
      if (have.has(`${x}|${y}`)) continue;
      have.add(`${x}|${y}`);
      feed.transfers.push({ from: x, to: y, minutes, mode });
    }
  }
}

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (!filter(src)) continue;
    if (entry.isDirectory()) copyDir(src, dest, filter);
    else fs.copyFileSync(src, dest);
  }
}

const opts = args();
const started = Date.now();
const referenceStations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8'));
const links = readLinks();

let feed, source;
if (opts.source === 'demo') {
  feed = await loadGtfs(path.join(ROOT, 'data', 'demo-gtfs'), { referenceStations });
  source = { kind: 'demo', name: 'Demo timetable (synthetic times and fares)' };
} else if (opts.source === 'gtfs') {
  if (!opts.input) throw new Error('--input is required for a GTFS source');
  feed = await loadGtfs(opts.input, { referenceStations });
  addLinks(feed, links);
  source = { kind: 'gtfs', name: feed.info?.publisher || 'GTFS timetable' };
} else if (opts.source === 'cif') {
  if (!opts.input) throw new Error('--input is required for a CIF source');
  const operators = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'operators.json'), 'utf8'));
  feed = await loadCif(opts.input, { start: opts.start, days: opts.days, referenceStations, operators, links });
  source = { kind: 'cif', name: 'Network Rail timetable (CIF)', extracted: feed.info?.extracted || null };
} else {
  throw new Error(`Unknown source ${opts.source}`);
}
console.log(`Loaded ${opts.source}: ${feed.trips.length} trips, ${feed.stations.length} stations in ${((Date.now() - started) / 1000).toFixed(1)} s`);
const changes = applyChangeTimes(feed, readInterchange(path.join(ROOT, 'data', 'interchange.csv')));
console.log(`Change times: ${changes.feed} from the timetable, ${changes.curated} from data/interchange.csv, ${changes.estimated} estimated from station size`);

const bundle = encodeBundle(feed, { start: opts.start, days: opts.days, source });
const out = path.resolve(ROOT, opts.out);
fs.rmSync(out, { recursive: true, force: true });
copyDir(path.join(ROOT, 'public'), out);
copyDir(path.join(ROOT, 'node_modules', 'leaflet', 'dist'), path.join(out, 'vendor', 'leaflet'),
  (p) => fs.statSync(p).isDirectory() || /\.(js|css|png)$/.test(p) && !p.endsWith('-src.js') && !p.endsWith('.esm.js'));
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
const json = JSON.stringify(bundle);
fs.writeFileSync(path.join(out, 'data', 'timetable.json'), json);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Bundle: ${bundle.trips.pattern.length} trips, ${bundle.patterns.length} patterns, ${bundle.stations.length} stations, `
  + `${bundle.searchable.start} to ${bundle.searchable.end}, ${(json.length / 1e6).toFixed(2)} MB`);
console.log(`Site written to ${path.relative(ROOT, out)}/ in ${((Date.now() - started) / 1000).toFixed(1)} s`);
