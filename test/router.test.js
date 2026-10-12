import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGtfs, parseCsvLine, parseTime } from '../server/gtfs.js';
import { Timetable } from '../server/timetable.js';
import { runSearch } from '../server/search.js';
import { priceJourney, estimateFare } from '../server/fares.js';
import { nationalRailUrl } from '../server/links.js';
import { miniFeed } from './helpers.js';

const feed = await loadGtfs(miniFeed());
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
