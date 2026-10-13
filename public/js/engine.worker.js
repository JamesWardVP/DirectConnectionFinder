// Runs the journey planner off the main thread so the page stays responsive.
import { decodeBundle } from './core/bundle.js';
import { Timetable } from './core/timetable.js';
import { runSearch } from './core/search.js';
import { directDestinations } from './core/destinations.js';

let timetable = null;
let served = null;
// Departure lists of the last "From a station" search, sent one station at a
// time when it is picked (all of them at once can be tens of megabytes).
let lastTimes = new Map();

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === 'load') {
      const res = await fetch(payload.url);
      if (!res.ok) throw new Error(`Could not load the timetable (${res.status})`);
      const bundle = await res.json();
      const feed = decodeBundle(bundle);
      timetable = new Timetable(feed);
      // Calls per station: used to suggest busy stations first.
      const calls = new Map();
      for (const t of feed.trips) for (const s of t.stations) calls.set(s, (calls.get(s) || 0) + 1);
      served = [...calls.keys()];
      self.postMessage({
        id,
        result: {
          meta: {
            source: bundle.source,
            generated: bundle.generated,
            demo: bundle.source?.kind === 'demo',
            dateRange: bundle.searchable,
            trips: feed.trips.length,
          },
          stations: served.map((i) => {
            const s = feed.stations[i];
            return { idx: s.idx, crs: s.crs, id: s.id, name: s.name, lat: s.lat, lon: s.lon, calls: calls.get(i) };
          }),
        },
      });
    } else if (type === 'search') {
      if (!timetable) throw new Error('The timetable has not loaded yet');
      const started = performance.now();
      const result = runSearch(timetable, served, payload.body, { today: payload.today });
      result.elapsedMs = Math.round(performance.now() - started);
      self.postMessage({ id, result });
    } else if (type === 'destinations') {
      if (!timetable) throw new Error('The timetable has not loaded yet');
      const started = performance.now();
      const result = directDestinations(timetable, served, payload.body, { today: payload.today });
      lastTimes = new Map(result.destinations.map((d) => [d.idx, { times: d.times, moreTimes: d.moreTimes }]));
      for (const d of result.destinations) delete d.times;
      result.elapsedMs = Math.round(performance.now() - started);
      self.postMessage({ id, result });
    } else if (type === 'destinationTimes') {
      self.postMessage({ id, result: lastTimes.get(payload.idx) || { times: [], moreTimes: 0 } });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
