// "Where can I go direct?": every station reachable from a station (or the
// stations within a radius) without changing trains, for a date, a time of
// day across several dates, or whole days of the week.
//
// A "direct" link is one physical train: trips joined by block_id and the
// through portions of dividing/joining trains count, as in the planner.
import { weekday } from './timetable.js';
import { lowerBound, searchDay, KIND_TRAIN } from './router.js';
import { haversineKm } from './fares.js';
import {
  SearchError, resolveLocation, planDates, parseHHMM, stationRef, fmtTime, operatorFor, summariseDays,
} from './search.js';

const DAY = 1440;
const MAX_TIMES = 80;
// With changes, every station in the country can be in reach, so keep the
// lists shorter and search at most a week of dates.
const MAX_TIMES_WITH_CHANGES = 30;
const MAX_DATES_WITH_CHANGES = 7;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const round5 = (x) => Math.round(x * 1e5) / 1e5;
/** [lat, lon] of a station, for drawing lines. */
const latLonOf = (feed) => (i) => [round5(feed.stations[i].lat), round5(feed.stations[i].lon)];

/**
 * @param {Timetable} timetable
 * @param {number[]} servedStations
 * @param {object} p  { from, fromRadiusKm, mode, date, time, windowMins, days, weeks, reachChanges }
 */
export function directDestinations(timetable, servedStations, p, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const maxChanges = Math.max(0, Math.min(Number(p.reachChanges) || 0, 3));
  if (maxChanges > 0) return reachableDestinations(timetable, servedStations, p, { today, maxChanges });
  const feed = timetable.feed;
  const latLon = latLonOf(feed);
  const from = resolveLocation(feed, servedStations, p.from, p.fromRadiusKm);
  const origins = new Set(from.stations.map((s) => s.idx));
  const mode = p.mode || 'date';
  const dates = planDates(timetable, { ...p, mode }, today);

  let depFrom = 0, depTo = DAY - 1;
  if (mode !== 'days') {
    const t = parseHHMM(p.time);
    if (t === null) throw new SearchError('Choose a time');
    const windowMins = Math.max(15, Math.min(Number(p.windowMins) || 120, 24 * 60));
    depFrom = t;
    depTo = t + windowMins;
  }

  // dest station -> Map(key -> ride), one ride per train and day (the
  // shortest, if the train calls at several starting stations).
  const rides = new Map();
  const datesWithService = [];
  for (const date of dates) {
    if (!timetable.hasServiceOn(date)) continue;
    datesWithService.push(date);
    const day = timetable.day(date);
    for (const o of origins) {
      const deps = day.departures[o];
      for (let j = lowerBound(deps.time, depFrom); j < deps.time.length && deps.time[j] <= depTo; j++) {
        const ti = deps.train[j], train = day.trains[ti], board = deps.pos[j];
        for (let q = board + 1; q < train.stations.length; q++) {
          const s = train.stations[q];
          if (origins.has(s) || !train.dropoff[q]) continue;
          const ride = { date, origin: o, train, board, alight: q, dep: train.dep[board], arr: train.arr[q] };
          if (!rides.has(s)) rides.set(s, new Map());
          const key = `${date}|${ti}`;
          const prev = rides.get(s).get(key);
          if (!prev || ride.arr - ride.dep < prev.arr - prev.dep) rides.get(s).set(key, ride);
        }
      }
    }
  }

  const nDays = Math.max(datesWithService.length, 1);
  const centre = { lat: from.lat, lon: from.lon };
  const destinations = [];
  for (const [s, byTrain] of rides) {
    const list = [...byTrain.values()];
    let fastest = list[0];
    const ops = new Map();
    for (const r of list) {
      if (r.arr - r.dep < fastest.arr - fastest.dep) fastest = r;
      for (const seg of r.train.segments) {
        if (seg.to > r.board && seg.from < r.alight) {
          const op = operatorFor(feed, seg.trip);
          ops.set(op.id, op);
        }
      }
    }
    // Group identical departures that run on several days.
    const groups = new Map();
    for (const r of list) {
      const depT = ((r.dep % DAY) + DAY) % DAY;
      const key = `${r.origin}|${depT}|${r.arr - r.dep}`;
      if (!groups.has(key)) groups.set(key, { r, dates: [] });
      groups.get(key).dates.push(r.date);
    }
    const times = [...groups.values()]
      .sort((a, b) => ((a.r.dep % DAY) + DAY) % DAY - ((b.r.dep % DAY) + DAY) % DAY)
      .map(({ r, dates: ds }) => {
        const trip = r.train.segments.find((seg) => seg.to > r.board && seg.from <= r.board)?.trip || r.train.segments[0].trip;
        const wds = [...new Set(ds.map(weekday))].sort();
        return {
          origin: { crs: feed.stations[r.origin].crs, name: feed.stations[r.origin].name },
          depart: fmtTime(r.dep),
          arrive: fmtTime(r.arr),
          nextDay: Math.floor(r.arr / DAY) > Math.floor(r.dep / DAY),
          duration: r.arr - r.dep,
          operator: operatorFor(feed, trip),
          headsign: r.train.segments.at(-1).trip.headsign || '',
          date: ds[0],
          runsOn: mode === 'date' ? null : summariseDays(wds, ds.length, datesWithService.length),
          changes: 0,
          via: [],
        };
      });
    const path = [];
    for (let q = fastest.board; q <= fastest.alight; q++) path.push(fastest.train.stations[q]);
    const st = feed.stations[s];
    destinations.push({
      ...stationRef(feed, s),
      changes: 0,
      via: [],
      trainsPerDay: Math.round((list.length / nDays) * 10) / 10,
      trains: list.length,
      fastest: fastest.arr - fastest.dep,
      first: times[0].depart,
      last: times.at(-1).depart,
      operators: [...ops.values()],
      distanceKm: Math.round(haversineKm(centre, st)),
      path: path.map(latLon),
      times: times.slice(0, MAX_TIMES),
      moreTimes: Math.max(0, times.length - MAX_TIMES),
    });
  }
  destinations.sort((a, b) => b.trainsPerDay - a.trainsPerDay || a.fastest - b.fastest || a.name.localeCompare(b.name));

  return {
    query: { mode, dates, datesWithService, maxChanges: 0, weekdays: [...new Set(datesWithService.map((d) => WEEKDAYS[weekday(d)]))] },
    from: {
      label: from.label, lat: from.lat, lon: from.lon, radiusKm: from.radiusKm, fellBackToNearest: from.fellBackToNearest,
      stations: from.stations.map((x) => ({ ...stationRef(feed, x.idx), distanceKm: Math.round(x.distanceKm * 10) / 10 })),
    },
    destinations,
  };
}

/**
 * Everywhere reachable with up to maxChanges changes. Runs the journey
 * planner from the starting stations with every station as a destination,
 * and keeps, per station, each departure that gets there sooner than any
 * later one (so 08:00 → 11:00 is kept, 07:30 → 11:00 is not).
 */
function reachableDestinations(timetable, servedStations, p, { today, maxChanges }) {
  const feed = timetable.feed;
  const latLon = latLonOf(feed);
  const from = resolveLocation(feed, servedStations, p.from, p.fromRadiusKm);
  const origins = new Set(from.stations.map((s) => s.idx));
  const mode = p.mode || 'date';
  const allDates = planDates(timetable, { ...p, mode }, today);
  const dates = allDates.slice(0, MAX_DATES_WITH_CHANGES);

  let depFrom = 0, depTo = DAY - 1;
  if (mode !== 'days') {
    const t = parseHHMM(p.time);
    if (t === null) throw new SearchError('Choose a time');
    const windowMins = Math.max(15, Math.min(Number(p.windowMins) || 120, 24 * 60));
    depFrom = t;
    depTo = t + windowMins;
  }
  const fixedChange = Number(p.minChange) > 0 ? Number(p.minChange) : undefined;
  const K = maxChanges + 1;
  const n = feed.stations.length;

  const options = new Map(); // station -> [{ date, origin, dep, arr, trains, via, op }]
  const fastest = new Map(); // station -> { duration, trains, legs }
  const datesWithService = [];
  for (const date of dates) {
    if (!timetable.hasServiceOn(date)) continue;
    datesWithService.push(date);
    const day = timetable.day(date);
    // best[k][s]: earliest arrival at s using at most k trains, from a later
    // or equal departure (reset for each starting station).
    const best = Array.from({ length: K + 1 }, () => new Int32Array(n));
    let bestFor = null;
    searchDay(day, feed, {
      origins: [...origins], destinations: null, depFrom, depTo, maxTrains: K,
      minChange: 5, fixedChange, maxWait: Number(p.maxWait) || 120,
      onIteration: ({ L, updates, origin, tau, reconstruct }) => {
        if (origin !== bestFor) { for (const b of best) b.fill(2 ** 30); bestFor = origin; }
        const seen = new Set();
        for (const [, s] of updates) {
          if (seen.has(s) || origins.has(s)) continue;
          seen.add(s);
          // Keep this departure for each number of trains it does better with
          // (e.g. 1 change arriving 11:20 and 2 changes arriving 11:05).
          let arr = 2 ** 30, trains = 0;
          for (let k = 1; k <= K; k++) {
            if (L.kind[k][s] === KIND_TRAIN && L.arr[k][s] < arr) { arr = L.arr[k][s]; trains = k; }
            if (arr >= best[k][s]) continue;
            best[k][s] = arr;
            if (trains === k) record(s, k, arr);
          }
        }
        function record(s, trains, arr) {
          const legs = reconstruct(trains, s);
          const trainLegs = legs.filter((l) => l.type === 'train');
          const via = trainLegs.slice(1).map((l) => l.train.stations[l.boardPos]);
          const first = trainLegs[0];
          const op = operatorFor(feed, first.train.segments.find((sg) => sg.to > first.boardPos && sg.from <= first.boardPos)?.trip || first.train.segments[0].trip);
          if (!options.has(s)) options.set(s, []);
          options.get(s).push({ date, origin, dep: tau, arr, trains, via, op });
          // Fastest overall, and fastest with each number of trains (the map
          // draws the route with the fewest changes).
          if (!fastest.has(s)) fastest.set(s, []);
          const byTrains = fastest.get(s);
          for (const slot of [0, trains]) {
            const f = byTrains[slot];
            if (!f || arr - tau < f.duration || (arr - tau === f.duration && trains < f.trains)) {
              byTrains[slot] = { duration: arr - tau, trains, legs: legs.map(compactLeg) };
            }
          }
        }
      },
    });
  }

  const nDays = Math.max(datesWithService.length, 1);
  const centre = { lat: from.lat, lon: from.lon };
  const destinations = [];
  for (const [s, list] of options) {
    const f = fastest.get(s)[0];
    const fewest = fastest.get(s).find((x, i) => i > 0 && x);
    const departures = new Set(list.map((o) => `${o.date}|${o.origin}|${o.dep}`)).size;
    const groups = new Map();
    for (const o of list) {
      const depT = ((o.dep % DAY) + DAY) % DAY;
      const key = `${o.origin}|${depT}|${o.arr - o.dep}|${o.via.join('-')}`;
      if (!groups.has(key)) groups.set(key, { o, dates: [] });
      groups.get(key).dates.push(o.date);
    }
    const times = [...groups.values()]
      .sort((a, b) => ((a.o.dep % DAY) + DAY) % DAY - ((b.o.dep % DAY) + DAY) % DAY)
      .map(({ o, dates: ds }) => ({
        origin: { crs: feed.stations[o.origin].crs, name: feed.stations[o.origin].name },
        depart: fmtTime(o.dep),
        arrive: fmtTime(o.arr),
        nextDay: Math.floor(o.arr / DAY) > Math.floor(o.dep / DAY),
        duration: o.arr - o.dep,
        operator: o.op,
        changes: o.trains - 1,
        via: o.via.map((v) => feed.stations[v].name),
        date: ds[0],
        runsOn: mode === 'date' ? null : summariseDays([...new Set(ds.map(weekday))].sort(), ds.length, datesWithService.length),
      }));
    const ops = new Map();
    for (const l of fewest.legs) if (l.op) ops.set(l.op.id, l.op);
    const path = [];
    for (const l of fewest.legs) for (const i of l.stations) if (path.at(-1) !== i) path.push(i);
    destinations.push({
      ...stationRef(feed, s),
      changes: fewest.trains - 1,
      fastestChanges: f.trains - 1,
      via: f.legs.filter((l) => l.op).slice(1).map((l) => feed.stations[l.stations[0]].name),
      trainsPerDay: Math.round((departures / nDays) * 10) / 10,
      trains: departures,
      fastest: f.duration,
      first: times[0].depart,
      last: times.at(-1).depart,
      operators: [...ops.values()],
      distanceKm: Math.round(haversineKm(centre, feed.stations[s])),
      path: path.map(latLon),
      times: times.slice(0, MAX_TIMES_WITH_CHANGES),
      moreTimes: Math.max(0, times.length - MAX_TIMES_WITH_CHANGES),
    });
  }
  destinations.sort((a, b) => a.changes - b.changes || b.trainsPerDay - a.trainsPerDay || a.fastest - b.fastest || a.name.localeCompare(b.name));

  // Stations along a train's route, and who runs it (null for a walk).
  function compactLeg(l) {
    if (l.type !== 'train') return { stations: [l.from, l.to], op: null };
    const stations = [];
    for (let q = l.boardPos; q <= l.alightPos; q++) stations.push(l.train.stations[q]);
    const trip = l.train.segments.find((sg) => sg.to > l.boardPos && sg.from <= l.boardPos)?.trip || l.train.segments[0].trip;
    return { stations, op: operatorFor(feed, trip) };
  }

  return {
    query: {
      mode, dates, datesWithService, maxChanges,
      shortened: allDates.length > dates.length ? allDates.length : 0,
      weekdays: [...new Set(datesWithService.map((d) => WEEKDAYS[weekday(d)]))],
    },
    from: {
      label: from.label, lat: from.lat, lon: from.lon, radiusKm: from.radiusKm, fellBackToNearest: from.fellBackToNearest,
      stations: from.stations.map((x) => ({ ...stationRef(feed, x.idx), distanceKm: Math.round(x.distanceKm * 10) / 10 })),
    },
    destinations,
  };
}
