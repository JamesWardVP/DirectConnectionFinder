// Smoke test for a built site: loads dist/data/timetable.json exactly as the
// browser does and runs well-known journeys. Fails (so nothing is deployed)
// if the timetable looks broken. Run by the GitHub Action after the build.
//
// Usage: node scripts/check-site.js [dist]
import fs from 'node:fs';
import path from 'node:path';
import { decodeBundle } from '../public/js/core/bundle.js';
import { Timetable, addDays, weekday } from '../public/js/core/timetable.js';
import { runSearch } from '../public/js/core/search.js';

const dist = process.argv[2] || 'dist';
const started = Date.now();
const bundle = JSON.parse(fs.readFileSync(path.join(dist, 'data', 'timetable.json'), 'utf8'));
const feed = decodeBundle(bundle);
const timetable = new Timetable(feed);
const served = [...new Set(feed.trips.flatMap((t) => [...t.stations]))];
console.log(`Timetable: ${bundle.source?.name}, ${feed.trips.length} trips, ${served.length} stations, `
  + `${bundle.searchable.start} to ${bundle.searchable.end} (decoded in ${Date.now() - started} ms)`);

// First Wednesday in the window.
let date = bundle.searchable.start;
while (weekday(date) !== 2) date = addDays(date, 1);

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const fmt = (j) => `${j.depart.time}→${j.arrive.time}${j.arrive.dayOffset ? '+1' : ''} ${Math.floor(j.duration / 60)}h${String(j.duration % 60).padStart(2, '0')} `
  + `${j.legs.filter((l) => l.type === 'train').map((l) => `${l.from.crs}>${l.to.crs} ${l.operator.name}`).join(', ')}`;

function run(label, body, expect) {
  const t0 = Date.now();
  let r;
  try {
    r = runSearch(timetable, served, { mode: 'date', date, timeType: 'depart', windowMins: 120, maxChanges: 2, ...body }, { today: bundle.searchable.start });
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`\n✗ ${label}: ${err.message}`);
    return;
  }
  const visible = r.journeys.filter((j) => !j.beatenByFewerChanges);
  console.log(`\n${label} (${date}, ${Date.now() - t0} ms): ${visible.length} options, ${r.journeys.filter((j) => j.direct).length} direct`);
  for (const j of visible.slice(0, 5)) console.log(`  ${fmt(j)}`);
  expect(r, visible);
}

const station = (crs) => ({ type: 'station', crs });
const directWithin = (label, min, max) => (r) => {
  const direct = r.journeys.filter((j) => j.direct);
  check(direct.length > 0, `${label}: expected a direct train`);
  check(direct.some((j) => j.duration >= min && j.duration <= max), `${label}: expected a direct train taking ${min}-${max} min`);
};

run('London Kings Cross → Edinburgh', { from: station('KGX'), to: station('EDB'), time: '09:00' }, directWithin('KGX-EDB', 240, 330));
// The demo timetable only has a few routes; the rest is for real data.
if (bundle.source?.kind !== 'demo') {
run('London Paddington → Bristol Temple Meads', { from: station('PAD'), to: station('BRI'), time: '09:00' }, directWithin('PAD-BRI', 75, 140));
run('Cardiff Central → Manchester Piccadilly', { from: station('CDF'), to: station('MAN'), time: '09:00' }, directWithin('CDF-MAN', 150, 240));
run('Manchester (2 km radius) → Leeds', { from: { type: 'point', lat: 53.4794, lon: -2.2453 }, fromRadiusKm: 2, to: station('LDS'), time: '09:00' }, directWithin('MAN-LDS', 40, 90));
run('Norwich → Penzance (changes needed)', { from: station('NRW'), to: station('PNZ'), time: '07:00', windowMins: 180 }, (r) => {
  check(r.journeys.length > 0, 'NRW-PNZ: expected at least one journey');
});
run('London Euston → Inverness, overnight', { from: station('EUS'), to: station('INV'), time: '20:00', windowMins: 180, maxChanges: 1 }, (r) => {
  check(r.journeys.some((j) => j.arrive.dayOffset === 1), 'EUS-INV: expected an overnight journey arriving the next day');
});

check(feed.trips.length > 20000, 'fewer trips than expected for a national timetable');
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nAll checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
