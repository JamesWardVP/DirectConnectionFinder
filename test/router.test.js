import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGtfs, parseCsvLine, parseTime } from '../lib/gtfs.js';
import { Timetable } from '../public/js/core/timetable.js';
import { runSearch } from '../public/js/core/search.js';
import { priceJourney, estimateFare } from '../public/js/core/fares.js';
import { nationalRailUrl } from '../public/js/core/links.js';
import { encodeBundle, decodeBundle } from '../public/js/core/bundle.js';
import { miniFeed, writeFeed } from './helpers.js';
import { applyChangeTimes, BANDS } from '../lib/interchange.js';

// Everything runs on a feed that has been through the website's bundle
// format, exactly as the browser sees it.
const raw = await loadGtfs(miniFeed());
const feed = decodeBundle(JSON.parse(JSON.stringify(encodeBundle(raw, { start: '2026-10-12', days: 14 }))));
const timetable = new Timetable(feed);
const served = feed.stations.map((s) => s.idx);
const WED = '2026-10-14';

const st = (code) => ({ type: 'station', crs: `X${code}${code}` });
const search = (extra) => runSearch(timetable, served, {
  mode: 'date', date: WED, timeType: 'depart', windowMins: 60, maxChanges: 2, ...extra,
}, { today: WED });
const names = (j) => j.legs.map((l) => (l.type === 'train' ? `${l.from.name.slice(-1)}>${l.to.name.slice(-1)}` : `~${l.mode}~`)).join(' ');

test('CSV and time parsing', () => {
  assert.deepEqual(parseCsvLine('a,"b, c","d ""q"""'), ['a', 'b, c', 'd "q"']);
  assert.equal(parseTime('25:30:00'), 25 * 60 + 30);
  assert.equal(parseTime('08:00:40'), 8 * 60 + 1);
});

test('finds a direct train', () => {
  const r = search({ from: st('A'), to: st('D'), time: '07:30' });
  const direct = r.journeys.filter((j) => j.direct);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].depart.time, '08:00');
  assert.equal(direct[0].arrive.time, '09:00');
  assert.equal(direct[0].trains, 1);
});

test('respects minimum change time', () => {
  const five = search({ from: st('A'), to: st('E'), time: '07:30', minChange: 5 });
  assert.equal(five.journeys[0].arrive.time, '09:20'); // the 08:44 is too tight
  assert.equal(names(five.journeys[0]), 'A>C C>E');
  const three = search({ from: st('A'), to: st('E'), time: '07:30', minChange: 3 });
  assert.equal(three.journeys[0].arrive.time, '09:10');
});

test('each station has its own usual change time, unless one is fixed', () => {
  const c = feed.stationIndexByCrs.get('XCC');
  feed.minChange.set(c, 3);
  try {
    const usual = search({ from: st('A'), to: st('E'), time: '07:30' });
    assert.equal(usual.journeys[0].arrive.time, '09:10'); // C is quick to change at
    const change = usual.journeys[0].legs[1].change;
    assert.deepEqual(change, { allow: 3, usual: true, wait: change.wait });
    assert.ok(change.wait >= 3);
    const fixed = search({ from: st('A'), to: st('E'), time: '07:30', minChange: 10 });
    assert.equal(fixed.journeys[0].arrive.time, '09:20');
    assert.deepEqual(fixed.journeys[0].legs[1].change.allow, 10);
  } finally {
    feed.minChange.delete(c);
  }
});

test('change times: curated for big stations, by size for the rest', () => {
  const f = {
    trips: [
      { stations: [0, 1, 2] }, { stations: [0, 1] }, { stations: [0, 3] }, { stations: [0, 1, 4] },
    ],
    minChange: new Map([[4, 2]]), // from the timetable itself: kept
    stationIndexByCrs: new Map([['BIG', 1], ['TTF', 4]]),
  };
  const counts = applyChangeTimes(f, [['BIG', 15], ['TTF', 9], ['NOPE', 7]]);
  assert.equal(f.minChange.get(1), 15);
  assert.equal(f.minChange.get(4), 2);
  assert.equal(f.minChange.get(0), BANDS[0].minutes); // busiest
  assert.equal(f.minChange.get(3), BANDS[2].minutes);
  assert.deepEqual(counts, { feed: 1, curated: 1, estimated: 3 });
});

test('trips sharing a block are one physical train, so the journey is direct', () => {
  const r = search({ from: st('B'), to: st('E'), time: '09:55', windowMins: 30 });
  const j = r.journeys[0];
  assert.equal(j.trains, 1);
  assert.equal(j.direct, true);
  assert.equal(j.legs[0].joinedTrips, true);
  assert.deepEqual(j.legs[0].tripIds, ['T3a', 'T3b']);
});

test('cannot board where the train only sets down', () => {
  const r = search({ from: st('B'), to: st('C'), time: '09:10', windowMins: 30 });
  assert.equal(r.journeys.length, 0);
});

test('walking links between stations count as a change, not a train', () => {
  const r = search({ from: st('A'), to: st('F'), time: '07:30' });
  const j = r.journeys[0];
  assert.equal(names(j), 'A>D ~walk~ W>F');
  assert.equal(j.trains, 2);
  assert.equal(j.changes, 1);
});

test('trains from the previous service day run past midnight', () => {
  const r = search({ from: st('E'), to: st('A'), date: '2026-10-15', time: '00:00', windowMins: 60 });
  assert.equal(r.journeys.length, 1);
  assert.equal(r.journeys[0].depart.time, '00:30');
  assert.equal(r.journeys[0].depart.date, '2026-10-15');
});

test('calendar exceptions remove service', () => {
  assert.equal(timetable.hasServiceOn('2026-10-15'), true);
  assert.equal(timetable.hasServiceOn('2026-10-16'), false);
  assert.equal(timetable.hasServiceOn('2026-10-17'), false); // Saturday
});

test('arrive-by keeps only journeys arriving inside the window', () => {
  const r = search({ from: st('A'), to: st('D'), time: '09:30', timeType: 'arrive', windowMins: 60 });
  assert.ok(r.journeys.length >= 1);
  for (const j of r.journeys) assert.ok(j.arrive.time <= '09:30' && j.arrive.time >= '08:30');
});

test('radius search includes nearby stations', () => {
  const r = search({ from: { type: 'point', lat: 51.1, lon: -1.0 }, fromRadiusKm: 15, to: st('D'), time: '07:30', windowMins: 180 });
  const origins = r.from.stations.map((s) => s.name).sort();
  assert.deepEqual(origins, ['Station A', 'Station B']);
  assert.ok(r.journeys.some((j) => j.origin.name === 'Station B'));
});

test('a point with no station in range falls back to the nearest station', () => {
  const r = search({ from: { type: 'point', lat: 50.0, lon: -1.0 }, fromRadiusKm: 0, to: st('D'), time: '07:30' });
  assert.equal(r.from.fellBackToNearest, true);
  assert.equal(r.from.stations[0].name, 'Station A');
});

test('"any date" mode groups trains that run on several days', () => {
  const r = runSearch(timetable, served, {
    mode: 'time', time: '07:30', windowMins: 60, from: st('A'), to: st('D'), sampleDays: 7,
  }, { today: '2026-10-12' });
  const j = r.journeys.find((x) => x.direct);
  // Mon–Thu (the Friday has a calendar exception, weekends have no service)
  assert.deepEqual(j.weekdays, ['Mon', 'Tue', 'Wed', 'Thu']);
  assert.equal(j.dates.length, 4);
});

test('"days of week" mode searches the whole day on chosen weekdays', () => {
  const r = runSearch(timetable, served, {
    mode: 'days', days: [0, 2], weeks: 1, from: st('B'), to: st('E'),
  }, { today: '2026-10-12' });
  assert.deepEqual(r.query.dates, ['2026-10-12', '2026-10-14']);
  const block = r.journeys.find((j) => j.direct);
  assert.equal(block.runsOn, 'Every day searched');
});

test('results are ordered by number of trains, then time', () => {
  const r = search({ from: st('A'), to: st('E'), time: '07:00', windowMins: 180, minChange: 3 });
  for (let i = 1; i < r.journeys.length; i++) {
    const a = r.journeys[i - 1], b = r.journeys[i];
    assert.ok(a.trains < b.trains || (a.trains === b.trains && a.duration <= b.duration));
  }
});

test('split tickets on one train are cheaper and still direct', () => {
  const r = search({ from: st('A'), to: st('D'), time: '07:30' });
  const j = r.journeys[0];
  assert.equal(j.direct, true);
  assert.equal(j.fare.split, true);
  assert.equal(j.fare.total, 25);
  assert.equal(j.fare.through, 50);
  assert.equal(j.fare.saving, 25);
  assert.deepEqual(j.fare.tickets.map((t) => [t.fromName, t.toName]), [['Station A', 'Station B'], ['Station B', 'Station D']]);
  assert.ok(j.links.some((l) => l.kind === 'ticket'));
});

test('fares fall back to a labelled estimate', () => {
  const r = search({ from: st('A'), to: st('E'), time: '07:30' });
  assert.equal(r.journeys[0].fare.source, 'estimate');
  assert.ok(estimateFare(100) > estimateFare(50));
});

test('fare DP does not need a ticket for a walking link', () => {
  const A = feed.stationIndexByStopId.get('A'), B = feed.stationIndexByStopId.get('B'), D = feed.stationIndexByStopId.get('D'), W = feed.stationIndexByStopId.get('W');
  const p = priceJourney(feed, [{ station: A }, { station: B }, { station: D }, { station: W, walkFromPrev: true }]);
  // The walk from D to W is free, so A→B + B→D covers the whole trip.
  assert.equal(p.source, 'published');
  assert.equal(p.total, 25);
  assert.equal(p.tickets.length, 2);
});

test('National Rail link format', () => {
  const url = nationalRailUrl('KGX', 'EDB', '2026-10-14', 9 * 60 + 5);
  assert.match(url, /origin=KGX/);
  assert.match(url, /leavingDate=141026/);
  assert.match(url, /leavingHour=09&leavingMin=05/);
});

test('walking links are never chained (crashed with "reading arr")', async () => {
  // Train T1 reaches X then Y; X–Y and Y–Z are walking links; T2 leaves Z.
  // Walking X→Y beats the train to Y, and used to be chained into Y→Z.
  const coords = { A: [51.0, -1.0], X: [51.3, -1.0], Y: [51.31, -1.0], Z: [51.32, -1.0], D: [51.6, -1.0] };
  const stops = [['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon']];
  for (const [id, [lat, lon]] of Object.entries(coords)) stops.push([id, `Q${id}${id}`, `Stop ${id}`, lat, lon]);
  const dir = writeFeed({
    'agency.txt': [['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], ['OP', 'Test Rail', 'https://example.test', 'Europe/London']],
    'routes.txt': [['route_id', 'agency_id', 'route_short_name', 'route_type'], ['R', 'OP', 'R', '2']],
    'stops.txt': stops,
    'trips.txt': [['route_id', 'service_id', 'trip_id'], ['R', 'S', 'T1'], ['R', 'S', 'T2']],
    'stop_times.txt': [
      ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
      ['T1', '08:00:00', '08:00:00', 'A', 1], ['T1', '08:30:00', '08:30:00', 'X', 2], ['T1', '09:00:00', '09:00:00', 'Y', 3],
      ['T2', '08:50:00', '08:50:00', 'Z', 1], ['T2', '09:20:00', '09:20:00', 'D', 2],
    ],
    'calendar.txt': [
      ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['S', 1, 1, 1, 1, 1, 1, 1, '20260101', '20261231'],
    ],
    'transfers.txt': [['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time'], ['X', 'Y', 2, 300], ['Y', 'Z', 2, 300]],
  });
  const f = await loadGtfs(dir);
  const tt = new Timetable(f);
  const r = runSearch(tt, f.stations.map((s) => s.idx), {
    from: { type: 'station', crs: 'QAA' }, to: { type: 'station', crs: 'QDD' },
    mode: 'date', date: WED, time: '07:30', windowMins: 60, maxChanges: 2,
  }, { today: WED });
  for (const j of r.journeys) {
    for (let i = 1; i < j.legs.length; i++) {
      assert.ok(!(j.legs[i].type === 'transfer' && j.legs[i - 1].type === 'transfer'), 'two walks in a row');
    }
  }
});

test('direct destinations list every station one train reaches', async () => {
  const { directDestinations } = await import('../public/js/core/destinations.js');
  const r = directDestinations(timetable, served, { from: st('B'), mode: 'date', date: WED, time: '08:00', windowMins: 180 }, { today: WED });
  const byName = new Map(r.destinations.map((d) => [d.name, d]));
  // T1 from B reaches C and D; the T3a+T3b block is one train, so E is direct.
  assert.ok(byName.has('Station C') && byName.has('Station D') && byName.has('Station E'));
  assert.equal(byName.get('Station E').fastest, 55);
  assert.ok(!byName.has('Station B'), 'the starting station is not a destination');
  // B is set-down only on T4, so T4 adds no departures from B.
  assert.equal(byName.get('Station C').trains, 2);
});

test('direct destinations from several nearby stations skip each other', async () => {
  const { directDestinations } = await import('../public/js/core/destinations.js');
  const r = directDestinations(timetable, served, {
    from: { type: 'point', lat: 51.1, lon: -1.0 }, fromRadiusKm: 15, mode: 'date', date: WED, time: '07:00', windowMins: 300,
  }, { today: WED });
  const names = r.destinations.map((d) => d.name);
  assert.ok(!names.includes('Station A') && !names.includes('Station B'));
  assert.ok(names.includes('Station D'));
});

test('a slower route through another change station is still listed', async () => {
  // W→K then walk to M for the train to B is fastest every hour; W→O→B is a
  // little slower but needs no walk across town. Both should be listed.
  const coords = { W: [53.68, -1.5], K: [51.53, -0.12], M: [51.52, -0.16], O: [51.75, -1.27], B: [51.61, -0.64] };
  const stops = [['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon']];
  for (const [id, [lat, lon]] of Object.entries(coords)) stops.push([id, `Q${id}${id}`, `Stop ${id}`, lat, lon]);
  const trips = { L1: [['W', '08:00'], ['K', '10:00']], L2: [['W', '09:00'], ['K', '11:00']],
    C1: [['M', '10:30'], ['B', '11:00']], C2: [['M', '11:30'], ['B', '12:00']],
    X1: [['W', '08:10'], ['O', '11:00']], O1: [['O', '11:15'], ['B', '12:10']] };
  const stopTimes = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']];
  for (const [id, calls] of Object.entries(trips)) calls.forEach(([s, t], i) => stopTimes.push([id, `${t}:00`, `${t}:00`, s, i + 1]));
  const dir = writeFeed({
    'agency.txt': [['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], ['OP', 'Test Rail', 'https://example.test', 'Europe/London']],
    'routes.txt': [['route_id', 'agency_id', 'route_short_name', 'route_type'], ['R', 'OP', 'R', '2']],
    'stops.txt': stops,
    'trips.txt': [['route_id', 'service_id', 'trip_id'], ...Object.keys(trips).map((t) => ['R', 'S', t])],
    'stop_times.txt': stopTimes,
    'calendar.txt': [
      ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['S', 1, 1, 1, 1, 1, 1, 1, '20260101', '20261231'],
    ],
    'transfers.txt': [['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time'], ['K', 'M', 2, 900]],
  });
  const f = await loadGtfs(dir);
  const r = runSearch(new Timetable(f), f.stations.map((s) => s.idx), {
    from: { type: 'station', crs: 'QWW' }, to: { type: 'station', crs: 'QBB' },
    mode: 'date', date: WED, time: '07:30', windowMins: 120, maxChanges: 1,
  }, { today: WED });
  const routes = r.journeys.map((j) => `${j.depart.time} ${j.legs.map((l) => (l.type === 'train' ? `${l.from.name.slice(-1)}>${l.to.name.slice(-1)}` : '~')).join(' ')}`);
  assert.deepEqual(routes.sort(), ['08:00 W>K ~ M>B', '08:10 W>O O>B', '09:00 W>K ~ M>B']);
});
