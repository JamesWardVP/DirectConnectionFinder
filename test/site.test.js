// End-to-end checks of the demo timetable through the website's bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGtfs } from '../lib/gtfs.js';
import { encodeBundle, decodeBundle } from '../public/js/core/bundle.js';
import { Timetable } from '../public/js/core/timetable.js';
import { runSearch, SearchError } from '../public/js/core/search.js';

const referenceStations = JSON.parse(fs.readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8'));
const raw = await loadGtfs(new URL('../data/demo-gtfs', import.meta.url).pathname, { referenceStations });
const bundle = encodeBundle(raw, { start: '2026-10-12', days: 28, source: { kind: 'demo' } });
const feed = decodeBundle(JSON.parse(JSON.stringify(bundle)));
const timetable = new Timetable(feed);
const served = [...new Set(feed.trips.flatMap((t) => [...t.stations]))];
const search = (body) => runSearch(timetable, served, body, { today: '2026-10-12' });
const station = (crs) => ({ type: 'station', crs });

test('bundle keeps every trip and shrinks repeated patterns', () => {
  assert.equal(feed.trips.length, raw.trips.length);
  assert.ok(bundle.patterns.length < raw.trips.length / 10);
  assert.deepEqual(bundle.searchable, { start: '2026-10-12', end: '2026-11-08' });
});

test('decoded trips match the originals', () => {
  const byId = new Map(feed.trips.map((t) => [t.id, t]));
  for (const t of raw.trips.slice(0, 200)) {
    const d = byId.get(t.id);
    assert.deepEqual([...d.stations].map((i) => feed.stations[i].crs), [...t.stations].map((i) => raw.stations[i].crs));
    assert.deepEqual([...d.arr], [...t.arr]);
    assert.deepEqual([...d.dep], [...t.dep]);
    assert.deepEqual([...d.pickup], [...t.pickup]);
    assert.deepEqual([...d.dropoff], [...t.dropoff]);
    assert.equal(d.blockId, t.blockId);
  }
});

test('London to Edinburgh: direct trains first, with a split-ticket saving', () => {
  const r = search({
    from: station('KGX'), to: station('EDB'),
    mode: 'date', date: '2026-10-14', time: '08:00', timeType: 'depart', windowMins: 120, maxChanges: 2,
  });
  assert.ok(r.journeys.length > 0);
  assert.equal(r.journeys[0].direct, true);
  const split = r.journeys.find((j) => j.fare.split);
  assert.ok(split && split.fare.saving > 0);
  const routeIds = new Set(r.routes.map((x) => x.id));
  for (const j of r.journeys) assert.ok(routeIds.has(j.routeId));
});

test('the Cardiff–Manchester train runs as two linked trips but is direct', () => {
  const r = search({ from: station('CDF'), to: station('MAN'), mode: 'date', date: '2026-10-14', time: '09:00', windowMins: 60, maxChanges: 1 });
  assert.equal(r.journeys[0].direct, true);
  assert.equal(r.journeys[0].legs[0].joinedTrips, true);
});

test('overnight sleeper arrives the next day', () => {
  const r = search({ from: station('EUS'), to: station('INV'), mode: 'date', date: '2026-10-14', time: '21:00', windowMins: 60, maxChanges: 0 });
  assert.equal(r.journeys[0].operators[0].name, 'Caledonian Sleeper');
  assert.equal(r.journeys[0].arrive.dayOffset, 1);
});

test('unknown stations give a helpful error', () => {
  assert.throws(() => search({ from: station('ZZZ'), to: station('EDB'), mode: 'date', date: '2026-10-14', time: '08:00' }),
    (err) => err instanceof SearchError && /Unknown station/.test(err.message));
});
