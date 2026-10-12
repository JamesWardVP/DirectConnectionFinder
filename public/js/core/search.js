// Search orchestration: resolves locations to candidate stations, expands the
// requested date/time mode into one or more day searches, runs the router,
// then ranks, aggregates, prices and links the journeys for the client.
import { searchDay } from './router.js';
import { addDays, isoDate, weekday } from './timetable.js';
import { haversineKm, priceJourney } from './fares.js';
import { bookingLinks } from './links.js';

const MAX_STATIONS_PER_SIDE = 25;
const MAX_RESULTS = 250;
const DAY = 1440;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class SearchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Stations within radiusKm of a point, nearest first. */
export function stationsNear(feed, servedStations, lat, lon, radiusKm, limit = MAX_STATIONS_PER_SIDE) {
  const out = [];
  for (const idx of servedStations) {
    const s = feed.stations[idx];
    const d = haversineKm({ lat, lon }, s);
    if (d <= radiusKm) out.push({ idx, distanceKm: d });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out.slice(0, limit);
}

/**
 * Resolve a location to candidate stations.
 * loc: { type:'station', crs } | { type:'point', lat, lon, label }
 */
export function resolveLocation(feed, servedStations, loc, radiusKm) {
  if (!loc) throw new SearchError('Missing location');
  let lat, lon, label, anchor = null;
  if (loc.type === 'station') {
    const idx = feed.stationIndexByCrs.get(String(loc.crs || '').toUpperCase()) ?? feed.stationIndexByStopId.get(loc.id);
    if (idx === undefined) throw new SearchError(`Unknown station ${loc.crs || loc.id}`);
    anchor = idx;
    ({ lat, lon } = feed.stations[idx]);
    label = feed.stations[idx].name;
  } else if (loc.type === 'point') {
    lat = Number(loc.lat); lon = Number(loc.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new SearchError('Invalid coordinates');
    label = loc.label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  } else throw new SearchError('Unknown location type');

  const radius = Math.max(0, Math.min(Number(radiusKm) || 0, 80));
  let stations = radius > 0 ? stationsNear(feed, servedStations, lat, lon, radius) : [];
  if (anchor !== null && !stations.some((s) => s.idx === anchor)) {
    stations.unshift({ idx: anchor, distanceKm: 0 });
  }
  let fellBackToNearest = false;
  if (!stations.length) {
    stations = stationsNear(feed, servedStations, lat, lon, Infinity, 1);
    fellBackToNearest = true;
  }
  return { label, lat, lon, radiusKm: radius, stations, fellBackToNearest };
}

const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Work out which dates to search for the chosen mode. */
export function planDates(timetable, p, today) {
  const range = timetable.feed.dateRange;
  const clampStart = (d) => {
    if (!range) return d;
    const start = isoDate(range.start), end = isoDate(range.end);
    if (d < start) return start;
    if (d > end) return addDays(end, -6);
    return d;
  };
  if (p.mode === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new SearchError('Choose a date');
    return [p.date];
  }
  const start = clampStart(today);
  if (p.mode === 'time') {
    const n = Math.max(1, Math.min(Number(p.sampleDays) || 7, 14));
    return Array.from({ length: n }, (_, i) => addDays(start, i));
  }
  if (p.mode === 'days') {
    const days = (p.days || []).map(Number).filter((d) => d >= 0 && d <= 6);
    if (!days.length) throw new SearchError('Choose at least one day of the week');
    const weeks = Math.max(1, Math.min(Number(p.weeks) || 1, 4));
    const out = [];
    for (let i = 0; i < 7 * weeks; i++) {
      const d = addDays(start, i);
      if (days.includes(weekday(d))) out.push(d);
    }
    return out;
  }
  throw new SearchError('Unknown search mode');
}

export function runSearch(timetable, servedStations, p, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const feed = timetable.feed;
  const from = resolveLocation(feed, servedStations, p.from, p.fromRadiusKm);
  const to = resolveLocation(feed, servedStations, p.to, p.toRadiusKm);
  const originIdx = from.stations.map((s) => s.idx);
  const destIdx = to.stations.map((s) => s.idx).filter((i) => !originIdx.includes(i));
  if (!destIdx.length) throw new SearchError('The origin and destination areas cover the same stations');

  const mode = p.mode || 'date';
  const dates = planDates(timetable, { ...p, mode }, today);
  const maxChanges = p.maxChanges === undefined || p.maxChanges === '' ? 2 : Number(p.maxChanges);
  const maxTrains = Math.max(1, Math.min((Number.isFinite(maxChanges) ? maxChanges : 2) + 1, 4));
  const windowMins = Math.max(15, Math.min(Number(p.windowMins) || 120, 24 * 60));
  const arriveBy = mode !== 'days' && p.timeType === 'arrive';
  const lookback = Number(p.maxJourneyMins) || 8 * 60;

  let depFrom, depTo, arrFrom = -Infinity, arrTo = Infinity;
  if (mode === 'days') {
    depFrom = 0; depTo = DAY - 1;
  } else {
    const t = parseHHMM(p.time);
    if (t === null) throw new SearchError('Choose a time');
    if (arriveBy) {
      arrTo = t; arrFrom = t - windowMins;
      depFrom = t - windowMins - lookback; depTo = t;
    } else {
      depFrom = t; depTo = t + windowMins;
    }
  }

  const raw = [];
  const datesWithService = [];
  for (const date of dates) {
    if (!timetable.hasServiceOn(date)) continue;
    datesWithService.push(date);
    const day = timetable.day(date);
    const found = searchDay(day, feed, {
      origins: originIdx,
      destinations: destIdx,
      depFrom, depTo,
      maxTrains,
      minChange: Number(p.minChange) || 5,
      maxWait: Number(p.maxWait) || 120,
    });
    for (const r of found) {
      const j = buildJourney(feed, r, date, from, to);
      // Discard routes that loop back through a station they already passed.
      if (new Set(j.visited.map((v) => v.station)).size !== j.visited.length) continue;
      if (j.arrMin < arrFrom || j.arrMin > arrTo) continue;
      raw.push(j);
    }
  }

  markDominated(raw);
  const journeys = aggregate(raw, mode, dates.length);
  rank(journeys, p.sort || 'duration');
  const limited = journeys.slice(0, MAX_RESULTS);
  for (const j of limited) finishJourney(feed, j);
  const routes = buildRoutes(feed, limited);

  const describeSide = (side) => ({
    label: side.label,
    lat: side.lat,
    lon: side.lon,
    radiusKm: side.radiusKm,
    fellBackToNearest: side.fellBackToNearest,
    stations: side.stations.map((s) => ({ ...stationRef(feed, s.idx), distanceKm: round1(s.distanceKm) })),
  });

  return {
    query: { mode, dates, datesWithService, timeType: arriveBy ? 'arrive' : 'depart', windowMins, maxChanges: maxTrains - 1 },
    from: describeSide(from),
    to: describeSide(to),
    journeys: limited.map(stripInternal),
    routes,
    truncated: journeys.length > MAX_RESULTS,
    total: journeys.length,
  };
}

const round1 = (x) => Math.round(x * 10) / 10;

function stationRef(feed, idx) {
  const s = feed.stations[idx];
  return { idx, crs: s.crs, name: s.name, lat: s.lat, lon: s.lon };
}

function fmtTime(min) {
  const m = ((min % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function clockRef(date, min) {
  const offset = Math.floor(min / DAY);
  return { date: addDays(date, offset), time: fmtTime(min), dayOffset: offset };
}

/** Turn a router result into a journey with explicit legs. */
function buildJourney(feed, r, date, from, to) {
  const legs = [];
  const visited = [];
  for (const leg of r.legs) {
    if (leg.type === 'transfer') {
      const tr = feed.transfers[leg.transferIndex];
      legs.push({
        type: 'transfer', mode: tr.mode, minutes: tr.minutes,
        from: leg.from, to: leg.to, depMin: leg.depart, arrMin: leg.arrive,
      });
      visited.push({ station: leg.to, walkFromPrev: true });
      continue;
    }
    const { train, boardPos, alightPos } = leg;
    const segs = train.segments.filter((s) => s.to > boardPos && s.from < alightPos);
    const trips = segs.map((s) => s.trip);
    const calls = [];
    for (let q = boardPos; q <= alightPos; q++) {
      calls.push({ station: train.stations[q], arrMin: train.arr[q], depMin: train.dep[q] });
      if (q > boardPos || !visited.length) visited.push({ station: train.stations[q] });
    }
    legs.push({
      type: 'train',
      from: train.stations[boardPos], to: train.stations[alightPos],
      depMin: train.dep[boardPos], arrMin: train.arr[alightPos],
      trips, calls,
    });
  }
  const trainLegs = legs.filter((l) => l.type === 'train');
  const depMin = trainLegs[0].depMin, arrMin = trainLegs[trainLegs.length - 1].arrMin;
  const sig = legs.map((l) => (l.type === 'train'
    ? `T${l.from}-${l.to}@${((l.depMin % DAY) + DAY) % DAY}/${l.arrMin - l.depMin}:${l.trips.map((t) => t.routeId).join('+')}`
    : `W${l.from}-${l.to}`)).join('|');
  return {
    date,
    depMin, arrMin,
    duration: arrMin - depMin,
    trains: trainLegs.length,
    origin: r.origin, destination: r.destination,
    originDistanceKm: from.stations.find((s) => s.idx === r.origin)?.distanceKm ?? null,
    destinationDistanceKm: to.stations.find((s) => s.idx === r.destination)?.distanceKm ?? null,
    legs, visited, sig,
    pathKey: `${trainLegs.length}:${visited.map((v) => v.station).join('-')}`,
  };
}

/**
 * Flag journeys beaten by one with fewer trains between the same stations on
 * the same day (leaves no earlier and arrives no later).
 */
function markDominated(raw) {
  const groups = new Map();
  for (const j of raw) {
    const key = `${j.date}|${j.origin}|${j.destination}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  for (const list of groups.values()) {
    for (const j of list) {
      j.dominated = list.some((o) => o.trains < j.trains && o.depMin >= j.depMin && o.arrMin <= j.arrMin);
    }
  }
}

/** Group identical journeys that recur across several sampled dates. */
function aggregate(raw, mode, sampledDates) {
  const groups = new Map();
  for (const j of raw) {
    const key = mode === 'date' ? `${j.date}|${j.sig}` : j.sig;
    if (!groups.has(key)) groups.set(key, { ...j, dates: [], dominated: true });
    const g = groups.get(key);
    g.dates.push(j.date);
    g.dominated = g.dominated && j.dominated;
  }
  const out = [...groups.values()];
  for (const j of out) {
    j.dates.sort();
    j.weekdays = [...new Set(j.dates.map(weekday))].sort();
    j.runsOn = mode === 'date' ? null : summariseDays(j.weekdays, j.dates.length, sampledDates);
  }
  return out;
}

function summariseDays(weekdays, count, sampled) {
  const is = (arr) => weekdays.length === arr.length && arr.every((d) => weekdays.includes(d));
  if (is([0, 1, 2, 3, 4, 5, 6])) return 'Every day';
  if (is([0, 1, 2, 3, 4])) return 'Mon–Fri';
  if (is([0, 1, 2, 3, 4, 5])) return 'Mon–Sat';
  if (is([5, 6])) return 'Weekends';
  if (count === sampled) return 'Every day searched';
  return weekdays.map((d) => WEEKDAYS[d]).join(', ');
}

function rank(journeys, sort) {
  const tod = (m) => ((m % DAY) + DAY) % DAY;
  const secondary = {
    duration: (a, b) => a.duration - b.duration || tod(a.depMin) - tod(b.depMin),
    departure: (a, b) => tod(a.depMin) - tod(b.depMin) || a.duration - b.duration,
    arrival: (a, b) => (a.arrMin - a.depMin + tod(a.depMin)) - (b.arrMin - b.depMin + tod(b.depMin)) || a.duration - b.duration,
  }[sort] || ((a, b) => a.duration - b.duration);
  journeys.sort((a, b) => a.trains - b.trains || secondary(a, b) || (b.dates?.length || 0) - (a.dates?.length || 0));
  journeys.forEach((j, i) => { j.rank = i + 1; });
}

function operatorFor(feed, trip) {
  const route = feed.routes.get(trip.routeId);
  const agency = route ? feed.agencies.get(route.agencyId) : null;
  return {
    id: agency?.id || route?.agencyId || 'unknown',
    name: agency?.name || 'Unknown operator',
    url: agency?.url || null,
    color: route?.color ? `#${route.color.replace('#', '')}` : null,
  };
}

/** Prices, links and display fields for a journey that made the final list. */
function finishJourney(feed, j) {
  const firstDate = j.dates[0];
  const sref = (i) => stationRef(feed, i);
  const operators = new Map();
  j.legsOut = j.legs.map((l) => {
    if (l.type === 'transfer') {
      return {
        type: 'transfer', mode: l.mode, minutes: l.minutes,
        from: sref(l.from), to: sref(l.to),
        depart: clockRef(j.date, l.depMin), arrive: clockRef(j.date, l.arrMin),
      };
    }
    const ops = [];
    for (const t of l.trips) {
      const op = operatorFor(feed, t);
      if (!ops.some((o) => o.id === op.id)) ops.push(op);
      operators.set(op.id, op);
    }
    const route = feed.routes.get(l.trips[0].routeId);
    const lastTrip = l.trips[l.trips.length - 1];
    return {
      type: 'train',
      operator: ops[0],
      operators: ops,
      service: route?.longName || route?.shortName || '',
      headsign: lastTrip.headsign || feed.stations[lastTrip.stations[lastTrip.stations.length - 1]].name,
      tripIds: l.trips.map((t) => t.id),
      joinedTrips: l.trips.length > 1,
      headcode: l.trips[0].shortName || '',
      notes: [...new Set(l.trips.map((t) => t.note).filter(Boolean))],
      from: sref(l.from), to: sref(l.to),
      depart: clockRef(j.date, l.depMin), arrive: clockRef(j.date, l.arrMin),
      minutes: l.arrMin - l.depMin,
      calls: l.calls.map((c) => ({ ...sref(c.station), arrive: fmtTime(c.arrMin), depart: fmtTime(c.depMin) })),
    };
  });

  const fare = priceJourney(feed, j.visited);
  // Departure time from each ticket's starting station, for per-ticket links.
  const depAt = new Map();
  for (const l of j.legs) if (l.type === 'train') for (const c of l.calls) if (!depAt.has(c.station)) depAt.set(c.station, c.depMin);
  fare.tickets = fare.tickets.map((t) => ({
    ...t,
    fromCrs: feed.stations[t.from].crs, toCrs: feed.stations[t.to].crs,
    fromName: feed.stations[t.from].name, toName: feed.stations[t.to].name,
    depMinutes: depAt.get(t.from), date: clockRef(firstDate, depAt.get(t.from) ?? j.depMin).date,
  }));
  j.fare = fare;
  const origin = sref(j.origin), destination = sref(j.destination);
  j.links = bookingLinks({
    origin, destination,
    date: clockRef(firstDate, j.depMin).date,
    depMinutes: j.depMin,
    tickets: fare.tickets,
    operators: [...operators.values()],
  });
  j.out = {
    id: `j${j.rank}`,
    rank: j.rank,
    trains: j.trains,
    changes: j.trains - 1,
    direct: j.trains === 1,
    beatenByFewerChanges: j.dominated,
    origin: { ...origin, distanceKm: j.originDistanceKm == null ? null : round1(j.originDistanceKm) },
    destination: { ...destination, distanceKm: j.destinationDistanceKm == null ? null : round1(j.destinationDistanceKm) },
    depart: clockRef(j.date, j.depMin),
    arrive: clockRef(j.date, j.arrMin),
    duration: j.duration,
    legs: j.legsOut,
    operators: [...operators.values()],
    fare: {
      ...fare,
      tickets: fare.tickets.map(({ from, to, ...t }) => t),
    },
    links: j.links,
    dates: j.dates,
    runsOn: j.runsOn,
    weekdays: j.weekdays.map((d) => WEEKDAYS[d]),
    routeKey: j.pathKey,
  };
}

const stripInternal = (j) => j.out;

/**
 * Distinct map routes: journeys calling at the same stations with the same
 * number of trains share one line on the map. A route's rank is its best
 * journey's rank.
 */
function buildRoutes(feed, journeys) {
  const routes = new Map();
  for (const j of journeys) {
    if (!routes.has(j.pathKey)) {
      routes.set(j.pathKey, {
        key: j.pathKey,
        rank: j.rank,
        trains: j.trains,
        changes: j.trains - 1,
        journeyIds: [],
        segments: j.legsOut.map((l) => ({
          type: l.type,
          mode: l.mode || null,
          color: l.type === 'train' ? l.operator.color : null,
          operator: l.type === 'train' ? l.operator.name : null,
          coords: l.type === 'train' ? l.calls.map((c) => [c.lat, c.lon]) : [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]],
          stations: l.type === 'train' ? l.calls.map((c) => c.idx) : [l.from.idx, l.to.idx],
        })),
        changeStations: j.legsOut.slice(0, -1).map((l) => l.to.idx),
      });
    }
    routes.get(j.pathKey).journeyIds.push(j.out.id);
  }
  const list = [...routes.values()].sort((a, b) => a.rank - b.rank);
  list.forEach((r, i) => { r.order = i; r.id = `r${i + 1}`; });
  const byKey = new Map(list.map((r) => [r.key, r.id]));
  for (const j of journeys) j.out.routeId = byKey.get(j.pathKey);
  return list.map(({ key, ...r }) => ({ ...r, total: list.length }));
}
