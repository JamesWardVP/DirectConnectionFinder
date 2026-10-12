// End-to-end checks against the bundled demo timetable through the HTTP API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let server, base;
before(async () => {
  const app = await createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = async (body) => {
  const res = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('meta reports the demo feed', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.demo, true);
  assert.ok(meta.stations > 100);
});

test('station autocomplete matches names and codes', async () => {
  const byName = await (await fetch(`${base}/api/stations?q=edinb`)).json();
  assert.equal(byName[0].crs, 'EDB');
  const byCode = await (await fetch(`${base}/api/stations?q=kgx`)).json();
  assert.equal(byCode[0].name, 'London Kings Cross');
});

test('nearby stations within a radius', async () => {
  const near = await (await fetch(`${base}/api/nearby?lat=55.95&lon=-3.19&radiusKm=10`)).json();
  assert.deepEqual(near.map((s) => s.crs).sort(), ['EDB', 'HYM']);
});

test('London to Edinburgh: direct trains first, with a split-ticket saving', async () => {
  const { status, body } = await post({
    from: { type: 'station', crs: 'KGX' }, to: { type: 'station', crs: 'EDB' },
    mode: 'date', date: '2026-10-14', time: '08:00', timeType: 'depart', windowMins: 120, maxChanges: 2,
  });
  assert.equal(status, 200);
  assert.ok(body.journeys.length > 0);
  assert.equal(body.journeys[0].direct, true);
  const split = body.journeys.find((j) => j.fare.split);
  assert.ok(split, 'expected a split-ticket option');
  assert.ok(split.fare.saving > 0);
  // Every journey belongs to a drawable route.
  const routeIds = new Set(body.routes.map((r) => r.id));
  for (const j of body.journeys) assert.ok(routeIds.has(j.routeId));
});

test('the Cardiff–Manchester train runs as two linked trips but is direct', async () => {
  const { body } = await post({
    from: { type: 'station', crs: 'CDF' }, to: { type: 'station', crs: 'MAN' },
    mode: 'date', date: '2026-10-14', time: '09:00', windowMins: 60, maxChanges: 1,
  });
  const j = body.journeys[0];
  assert.equal(j.direct, true);
  assert.equal(j.legs[0].joinedTrips, true);
});

test('overnight sleeper arrives the next day', async () => {
  const { body } = await post({
    from: { type: 'station', crs: 'EUS' }, to: { type: 'station', crs: 'INV' },
    mode: 'date', date: '2026-10-14', time: '21:00', windowMins: 60, maxChanges: 0,
  });
  const j = body.journeys[0];
  assert.equal(j.operators[0].name, 'Caledonian Sleeper');
  assert.equal(j.arrive.dayOffset, 1);
});

test('bad requests get a helpful error', async () => {
  const { status, body } = await post({ from: { type: 'station', crs: 'ZZZ' }, to: { type: 'station', crs: 'EDB' }, mode: 'date', date: '2026-10-14', time: '08:00' });
  assert.equal(status, 400);
  assert.match(body.error, /Unknown station/);
});
