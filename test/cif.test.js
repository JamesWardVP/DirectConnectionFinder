import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadCif } from '../lib/cif.js';
import { encodeBundle, decodeBundle } from '../public/js/core/bundle.js';
import { Timetable } from '../public/js/core/timetable.js';
import { runSearch } from '../public/js/core/search.js';

const referenceStations = JSON.parse(fs.readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8'));

/** Build an 80-column CIF record from [position, value] pairs (0-based). */
function rec(...parts) {
  const line = Array(80).fill(' ');
  for (const [pos, value] of parts) [...value].forEach((ch, i) => { line[pos + i] = ch; });
  return line.join('');
}
const pad = (s, n) => s.padEnd(n);
const TI = (tiploc, crs) => rec([0, 'TI'], [2, pad(tiploc, 7)], [53, crs]);
const BS = (uid, from, to, days, stp, { status = 'P', cat = 'XX', headcode = '1A00' } = {}) =>
  rec([0, 'BS'], [2, 'N'], [3, uid], [9, from], [15, to], [21, days], [29, status], [30, cat], [32, headcode], [79, stp]);
const BX = (atoc) => rec([0, 'BX'], [11, atoc]);
const LO = (tiploc, dep, act = 'TB') => rec([0, 'LO'], [2, pad(tiploc, 8)], [10, `${dep} `], [15, dep], [29, pad(act, 12)]);
const LI = (tiploc, arr, dep, act = 'T') => rec([0, 'LI'], [2, pad(tiploc, 8)], [10, `${arr} `], [15, `${dep} `], [25, arr], [29, dep], [42, pad(act, 12)]);
const PASS = (tiploc, t) => rec([0, 'LI'], [2, pad(tiploc, 8)], [20, `${t} `]);
const LT = (tiploc, arr, act = 'TF') => rec([0, 'LT'], [2, pad(tiploc, 8)], [10, `${arr} `], [15, arr], [25, pad(act, 12)]);
const AA = (base, assoc, from, to, days, cat, loc, stp = 'P') =>
  rec([0, 'AA'], [2, 'N'], [3, base], [9, assoc], [15, from], [21, to], [27, days], [34, cat], [36, 'S'], [37, pad(loc, 7)], [47, 'P'], [79, stp]);

const lines = [
  rec([0, 'HD'], [2, 'DFTEST.CIF'], [22, '1110261200']),
  TI('KNGX', 'KGX'), TI('PBRO', 'PBO'), TI('YORK', 'YRK'), TI('EDINBUR', 'EDB'), TI('SCARBRO', 'SCA'), TI('JUNCT', ''),
  // A00001: weekday KGX–EDB, with a Wednesday overlay and a Thursday cancellation.
  BS('A00001', '261001', '261231', '1111100', 'P', { headcode: '1S01' }), BX('GR'),
  LO('KNGX', '0800'), PASS('JUNCT', '0830'), LI('PBRO', '0845', '0847'), LI('YORK', '1000', '1002'), LT('EDINBUR', '1230'),
  BS('A00001', '261014', '261014', '0010000', 'O', { headcode: '1S01' }), BX('GR'),
  LO('KNGX', '0815'), LI('PBRO', '0900', '0902'), LI('YORK', '1015', '1017'), LT('EDINBUR', '1245'),
  rec([0, 'BS'], [2, 'N'], [3, 'A00001'], [9, '261015'], [15, '261015'], [21, '0001000'], [79, 'C']),
  // Freight: ignored.
  BS('F00001', '261001', '261231', '1111111', 'P', { status: 'F', cat: 'EE' }), BX('ZZ'),
  LO('KNGX', '0805'), LT('YORK', '1100'),
  // Late train across midnight with pick-up-only and set-down-only calls.
  BS('B00001', '261001', '261231', '1111100', 'P', { headcode: '1S99' }), BX('CS'),
  LO('KNGX', '2330'), LI('PBRO', '0010', '0012', 'U'), LI('YORK', '0130', '0132', 'D'), LT('EDINBUR', '0400'),
  // Sleeper picking up just before midnight with no public arrival time.
  BS('D00001', '261001', '261231', '1111100', 'P', { headcode: '1S25' }), BX('CS'),
  LO('KNGX', '2300'),
  rec([0, 'LI'], [2, pad('PBRO', 8)], [10, '2358 '], [15, '2359 '], [25, '0000'], [29, '2359'], [42, pad('U', 12)]),
  LT('EDINBUR', '0700'),
  // Real pattern from the Caledonian Sleeper: at a pick-up-only stop the
  // public departure (21:33) is a minute before the working arrival (21:34).
  BS('E00001', '261001', '261231', '1111100', 'P', { headcode: '1B16' }), BX('CS'),
  LO('EDINBUR', '2036'),
  rec([0, 'LI'], [2, pad('YORK', 8)], [10, '2134 '], [15, '2135H'], [25, '0000'], [29, '2133'], [42, pad('U', 12)]),
  rec([0, 'LI'], [2, pad('PBRO', 8)], [10, '0510 '], [15, '0512 '], [25, '0510'], [29, '0000'], [42, pad('D', 12)]),
  LT('KNGX', '0700'),
  // Divide at York: C00001 continues to Edinburgh, C00002 goes to Scarborough.
  BS('C00001', '261001', '261231', '1111100', 'P', { headcode: '1S02' }), BX('GR'),
  LO('KNGX', '0900'), LI('YORK', '1130', '1135'), LT('EDINBUR', '1400'),
  BS('C00002', '261001', '261231', '1111100', 'P', { headcode: '1Y02' }), BX('TP'),
  LO('YORK', '1140'), LT('SCARBRO', '1240'),
  AA('C00001', 'C00002', '261001', '261231', '1111100', 'VV', 'YORK'),
  rec([0, 'ZZ']),
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-cif-'));
const file = path.join(dir, 'test.CIF.gz');
fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));

const operators = JSON.parse(fs.readFileSync(new URL('../data/operators.json', import.meta.url), 'utf8'));
const raw = await loadCif(file, { start: '2026-10-12', days: 7, referenceStations, operators, links: [['KGX', 'STP', 6, 'walk']] });
const feed = decodeBundle(JSON.parse(JSON.stringify(encodeBundle(raw, { start: '2026-10-12', days: 7 }))));
const timetable = new Timetable(feed);
const served = [...new Set(feed.trips.flatMap((t) => [...t.stations]))];
const search = (from, to, date, time, extra = {}) => runSearch(timetable, served, {
  from: { type: 'station', crs: from }, to: { type: 'station', crs: to },
  mode: 'date', date, time, windowMins: 120, maxChanges: 1, ...extra,
}, { today: '2026-10-12' });

test('CIF records are read with the right columns', () => {
  assert.deepEqual(feed.stations.map((s) => s.crs).sort(), ['EDB', 'KGX', 'PBO', 'SCA', 'YRK']);
  assert.equal(feed.agencies.get('GR').name, 'LNER');
  assert.ok(!feed.trips.some((t) => t.id.startsWith('F00001')), 'freight is excluded');
});

test('permanent schedule runs on a normal weekday', () => {
  const r = search('KGX', 'EDB', '2026-10-13', '07:30');
  const j = r.journeys.find((x) => x.depart.time === '08:00');
  assert.ok(j);
  assert.equal(j.arrive.time, '12:30');
  assert.equal(j.legs[0].headcode, '1S01');
  assert.equal(j.operators[0].name, 'LNER');
  // The passing point is not a call.
  assert.deepEqual(j.legs[0].calls.map((c) => c.crs), ['KGX', 'PBO', 'YRK', 'EDB']);
});

test('an STP overlay replaces the permanent schedule for its day', () => {
  const r = search('KGX', 'EDB', '2026-10-14', '07:30', { maxChanges: 0 });
  const times = r.journeys.map((j) => j.depart.time);
  assert.ok(times.includes('08:15'));
  assert.ok(!times.includes('08:00'));
});

test('an STP cancellation removes the train for its day', () => {
  const r = search('KGX', 'EDB', '2026-10-15', '07:30', { maxChanges: 0 });
  assert.ok(!r.journeys.some((j) => j.depart.time === '08:00' || j.depart.time === '08:15'));
});

test('weekend days are respected', () => {
  const r = search('KGX', 'EDB', '2026-10-17', '07:00', { maxChanges: 0, windowMins: 600 });
  assert.equal(r.journeys.length, 0);
});

test('times run on past midnight and pick-up / set-down only calls are honoured', () => {
  const r = search('KGX', 'EDB', '2026-10-13', '23:00', { maxChanges: 0 });
  const j = r.journeys.find((x) => x.depart.time === '23:30');
  assert.equal(j.arrive.time, '04:00');
  assert.equal(j.arrive.dayOffset, 1);
  // Peterborough is pick-up only, so it is not a destination...
  assert.equal(search('KGX', 'PBO', '2026-10-13', '23:00', { maxChanges: 0 }).journeys.length, 0);
  // ...and York is set-down only, so you cannot board there.
  assert.equal(search('YRK', 'EDB', '2026-10-14', '00:00', { maxChanges: 0 }).journeys.length, 0);
});

test('a stop just before midnight does not push the rest of the train a day on', () => {
  const t = feed.trips.find((x) => x.id.startsWith('D00001'));
  assert.deepEqual([...t.dep], [23 * 60, 23 * 60 + 59, 31 * 60]);
  // No public arrival at a pick-up-only stop: the public departure is used.
  assert.deepEqual([...t.arr], [23 * 60, 23 * 60 + 59, 31 * 60]);
});

test('public times a minute before working times do not add a day', () => {
  const t = feed.trips.find((x) => x.id.startsWith('E00001'));
  assert.deepEqual([...t.dep], [20 * 60 + 36, 21 * 60 + 33, 29 * 60 + 10, 31 * 60]);
  assert.deepEqual([...t.arr], [20 * 60 + 36, 21 * 60 + 33, 29 * 60 + 10, 31 * 60]);
});

test('a dividing train is direct for passengers in the portion that continues', () => {
  const r = search('KGX', 'SCA', '2026-10-13', '08:30', { maxChanges: 1 });
  const j = r.journeys[0];
  assert.equal(j.direct, true);
  assert.equal(j.depart.time, '09:00');
  assert.equal(j.arrive.time, '12:40');
  assert.match(j.legs[0].notes[0], /divides at York/);
});

test('curated interchange links are added', () => {
  assert.equal(raw.transfers.length, 0); // St Pancras has no trains in this fixture
});
