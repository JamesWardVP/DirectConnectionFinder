import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadGtfs } from './gtfs.js';
import { Timetable, isoDate } from './timetable.js';
import { runSearch, stationsNear, SearchError } from './search.js';
import { geocode } from './geocode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_GTFS = path.join(ROOT, 'data', 'demo-gtfs');

export async function createApp({ gtfsPath = process.env.DCF_GTFS || DEMO_GTFS } = {}) {
  const referenceStations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8'));
  const started = Date.now();
  const feed = await loadGtfs(gtfsPath, { referenceStations });
  const timetable = new Timetable(feed);
  const isDemo = path.resolve(gtfsPath) === DEMO_GTFS;

  // Only stations with at least one train are offered as candidates.
  const served = new Set();
  for (const t of feed.trips) for (const s of t.stations) served.add(s);
  const servedStations = [...served];
  console.log(`Loaded ${feed.trips.length} trips, ${servedStations.length} stations from ${gtfsPath} in ${Date.now() - started} ms`);

  const stationList = servedStations
    .map((i) => feed.stations[i])
    .map((s) => ({ idx: s.idx, crs: s.crs, id: s.id, name: s.name, lat: s.lat, lon: s.lon }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/meta', (req, res) => {
    res.json({
      demo: isDemo,
      feed: feed.info,
      dateRange: feed.dateRange && { start: isoDate(feed.dateRange.start), end: isoDate(feed.dateRange.end) },
      stations: stationList.length,
      trips: feed.trips.length,
      operators: [...feed.agencies.values()].map((a) => ({ id: a.id, name: a.name, url: a.url })),
    });
  });

  app.get('/api/stations', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json(stationList);
    const scored = [];
    for (const s of stationList) {
      const name = s.name.toLowerCase();
      let score = -1;
      if (s.crs && s.crs.toLowerCase() === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.split(/[\s(-]+/).some((w) => w.startsWith(q))) score = 2;
      else if (name.includes(q)) score = 3;
      if (score >= 0) scored.push([score, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    res.json(scored.slice(0, 12).map(([, s]) => s));
  });

  app.get('/api/nearby', (req, res) => {
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    const radiusKm = Math.min(Number(req.query.radiusKm) || 0, 80);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon are required' });
    const near = stationsNear(feed, servedStations, lat, lon, radiusKm);
    res.json(near.map(({ idx, distanceKm }) => ({ ...stationList.find((s) => s.idx === idx), distanceKm: Math.round(distanceKm * 10) / 10 })));
  });

  app.get('/api/geocode', async (req, res) => {
    try {
      res.json(await geocode(req.query.q));
    } catch (err) {
      res.status(502).json({ error: `Place search is unavailable: ${err.message}` });
    }
  });

  app.post('/api/search', (req, res) => {
    const started = Date.now();
    try {
      const result = runSearch(timetable, servedStations, req.body || {});
      result.elapsedMs = Date.now() - started;
      res.json(result);
    } catch (err) {
      if (err instanceof SearchError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
  app.use(express.static(path.join(ROOT, 'public')));

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = await createApp();
  app.listen(port, () => console.log(`Direct Connection Finder running at http://localhost:${port}`));
}
