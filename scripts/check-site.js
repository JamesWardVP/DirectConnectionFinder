// Smoke test for a built site: loads dist/data/timetable.json exactly as the
// browser does and runs well-known journeys. Fails (so nothing is deployed)
// if the timetable looks broken. Run by the GitHub Action after the build.
//
// Usage: node scripts/check-site.js [dist]
import fs from 'node:fs';
import path from 'node:path';
import { decodeBundle } from '../public/js/core/bundle.js';
import { Timetable, addDays, weekday } from '../public/js/core/timetable.js';
import { runSearch, SearchError } from '../public/js/core/search.js';
import { directDestinations } from '../public/js/core/destinations.js';

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
  check(r.journeys.every((j) => j.duration < 16 * 60), 'EUS-INV: journey times should be under 16 hours');
});

// A search a user reported crashing ("reading 'arr'"): wide radii pulling in
// stations joined by walking links.
run('Sherburn-in-Elmet (10 mi) → Beaconsfield (6 mi), any date', {
  from: station('SIE'), fromRadiusKm: 16.1, to: station('BCF'), toRadiusKm: 9.7,
  mode: 'time', time: '10:00', windowMins: 720,
}, (r) => check(r.journeys.length > 0, 'SIE-BCF: expected journeys'));

// Routes through other change stations must not be hidden by a faster one
// via London (reported: Wakefield → Oxford → Beaconsfield was missing).
// (Direct Wakefield → Oxford trains only run on some days, so search a week.)
run('Wakefield Westgate → Beaconsfield, every day of the week', { from: station('WKF'), to: station('BCF'), mode: 'days', days: [0, 1, 2, 3, 4, 5, 6], weeks: 1, maxChanges: 1 }, (r) => {
  const via = new Map();
  for (const j of r.journeys) {
    const change = j.legs.filter((l) => l.type === 'train').slice(0, -1).map((l) => l.to.crs).join('+');
    if (change) via.set(change, (via.get(change) || 0) + 1);
  }
  // The Oxford route needs a direct Wakefield → Oxford train, and those only
  // run in some weeks, so only expect it when the searched week has one.
  const [wkf, oxf] = ['WKF', 'OXF'].map((c) => feed.stationIndexByCrs.get(c));
  let wkfOxf = 0;
  for (const d of r.query.dates) {
    const day = timetable.day(d), deps = day.departures[wkf];
    for (let i = 0; i < deps.time.length; i++) {
      const t = day.trains[deps.train[i]], o = [...t.stations].indexOf(oxf);
      if (o > deps.pos[i] && t.dropoff[o]) wkfOxf++;
    }
  }
  console.log(`  changes at: ${[...via].map(([c, n]) => `${c} ×${n}`).join(', ')}; direct Wakefield → Oxford trains that week: ${wkfOxf}`);
  if (wkfOxf) check(via.has('OXF'), 'WKF-BCF: expected a route changing at Oxford');
  check(via.has('KGX'), 'WKF-BCF: expected a route via London Kings Cross');
  check(via.size >= 2, 'WKF-BCF: expected routes through more than one change station');
});

// "Direct from a station": everywhere one train goes from London Kings Cross.
{
  const t1 = Date.now();
  const r = directDestinations(timetable, served, { from: station('KGX'), mode: 'days', days: [2] }, { today: bundle.searchable.start });
  const names = r.destinations.map((d) => d.crs);
  console.log(`\nDirect from London Kings Cross on a Wednesday (${Date.now() - t1} ms): ${r.destinations.length} stations, top: `
    + r.destinations.slice(0, 6).map((d) => `${d.name} ${d.trainsPerDay}/day (fastest ${d.fastest} min)`).join(', '));
  check(['EDB', 'YRK', 'LDS', 'NCL'].every((c) => names.includes(c)), 'KGX direct destinations: expected Edinburgh, York, Leeds and Newcastle');
  check(!names.includes('MAN'), 'KGX direct destinations: Manchester Piccadilly should need a change');
}

// "From a station" with changes allowed: everywhere reachable.
for (const reachChanges of [1, 2, 3]) {
  const t1 = Date.now();
  const r = directDestinations(timetable, served, { from: station('KGX'), mode: 'days', days: [2], reachChanges }, { today: bundle.searchable.start });
  const ms = Date.now() - t1;
  const byChanges = {};
  for (const d of r.destinations) byChanges[d.changes] = (byChanges[d.changes] || 0) + 1;
  const man = r.destinations.find((d) => d.crs === 'MAN');
  console.log(`\nFrom London Kings Cross, up to ${reachChanges} change(s), a Wednesday (${ms} ms, ${(JSON.stringify({ ...r, destinations: r.destinations.map(({ times, ...d }) => d) }).length / 1e6).toFixed(1)} MB sent to the page): `
    + `${r.destinations.length} stations, by changes ${JSON.stringify(byChanges)}; Manchester Piccadilly: ${man ? `${man.changes} change(s), fastest ${man.fastest} min via ${man.via.join(', ') || '-'}, ${man.trainsPerDay}/day` : 'not reached'}`);
  check(man && man.changes === 1, `KGX up to ${reachChanges} changes: expected Manchester Piccadilly with 1 change`);
  check(byChanges[0] > 50, `KGX up to ${reachChanges} changes: direct stations should still be listed`);
}

// Random wide-radius searches must never crash.
let seed = 20261012;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const crs = feed.stations.filter((s) => s.crs && served.includes(s.idx)).map((s) => s.crs);
let crashes = 0;
const t0 = Date.now();
for (let i = 0; i < 25; i++) {
  const a = crs[Math.floor(rand() * crs.length)], b = crs[Math.floor(rand() * crs.length)];
  if (a === b) continue;
  try {
    runSearch(timetable, served, {
      from: station(a), fromRadiusKm: 16, to: station(b), toRadiusKm: 16,
      mode: 'date', date, time: '08:00', windowMins: 240, maxChanges: 3,
    }, { today: bundle.searchable.start });
  } catch (err) {
    if (err instanceof SearchError) continue;
    crashes++;
    console.log(`  ✗ ${a} → ${b}: ${err.stack.split('\n').slice(0, 3).join(' | ')}`);
  }
}
console.log(`\n25 random wide-radius searches in ${Date.now() - t0} ms, ${crashes} crashed`);
check(crashes === 0, `${crashes} random searches crashed`);

check(feed.trips.length > 20000, 'fewer trips than expected for a national timetable');
// No train should take more than a day between consecutive calls.
const broken = feed.trips.filter((t) => t.arr[t.arr.length - 1] - t.dep[0] > 24 * 60);
check(broken.length === 0, `${broken.length} trains run for more than 24 hours (e.g. ${broken.slice(0, 3).map((t) => t.id).join(', ')})`);
for (const t of broken.slice(0, 3)) {
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  console.log(`\n${t.id}: ${[...t.stations].map((s, i) => `${feed.stations[s].crs} ${hm(t.arr[i])}/${hm(t.dep[i])}`).join(', ')}`);
}
// Train UIDs for the workflow to print the raw timetable records.
fs.writeFileSync('broken-uids.txt', broken.slice(0, 3).map((t) => t.id.slice(0, 6)).join('\n'));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nAll checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
