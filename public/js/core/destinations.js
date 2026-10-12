// "Where can I go direct?": every station reachable from a station (or the
// stations within a radius) without changing trains, for a date, a time of
// day across several dates, or whole days of the week.
//
// A "direct" link is one physical train: trips joined by block_id and the
// through portions of dividing/joining trains count, as in the planner.
import { weekday } from './timetable.js';
import { lowerBound } from './router.js';
import { haversineKm } from './fares.js';
import {
  SearchError, resolveLocation, planDates, parseHHMM, stationRef, fmtTime, operatorFor, summariseDays,
} from './search.js';

const DAY = 1440;
const MAX_TIMES = 80;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * @param {Timetable} timetable
 * @param {number[]} servedStations
 * @param {object} p  { from, fromRadiusKm, mode, date, time, windowMins, days, weeks }
 */
export function directDestinations(timetable, servedStations, p, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const feed = timetable.feed;
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
        };
      });
    const path = [];
    for (let q = fastest.board; q <= fastest.alight; q++) path.push(fastest.train.stations[q]);
    const st = feed.stations[s];
    destinations.push({
      ...stationRef(feed, s),
      trainsPerDay: Math.round((list.length / nDays) * 10) / 10,
      trains: list.length,
      fastest: fastest.arr - fastest.dep,
      first: times[0].depart,
      last: times.at(-1).depart,
      operators: [...ops.values()],
      distanceKm: Math.round(haversineKm(centre, st)),
      path: path.map((i) => ({ idx: i, lat: feed.stations[i].lat, lon: feed.stations[i].lon, name: feed.stations[i].name })),
      times: times.slice(0, MAX_TIMES),
      moreTimes: Math.max(0, times.length - MAX_TIMES),
    });
  }
  destinations.sort((a, b) => b.trainsPerDay - a.trainsPerDay || a.fastest - b.fastest || a.name.localeCompare(b.name));

  return {
    query: { mode, dates, datesWithService, weekdays: [...new Set(datesWithService.map((d) => WEEKDAYS[weekday(d)]))] },
    from: {
      label: from.label, lat: from.lat, lon: from.lon, radiusKm: from.radiusKm, fellBackToNearest: from.fellBackToNearest,
      stations: from.stations.map((x) => ({ ...stationRef(feed, x.idx), distanceKm: Math.round(x.distanceKm * 10) / 10 })),
    },
    destinations,
  };
}
