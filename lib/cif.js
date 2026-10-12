// Network Rail / RDG CIF timetable importer.
//
// Reads the national timetable in CIF format (e.g. Network Rail's
// CIF_ALL_FULL_DAILY "toc-full.CIF.gz") and produces the same feed model as
// lib/gtfs.js, restricted to a window of dates:
//
//  - only passenger trains (train status P/1, categories O* and X*)
//  - short-term planning (STP) rules: for each train UID and date the
//    schedule with the lowest STP indicator wins (C < N < O < P); a winning
//    "C" means the train is cancelled that day
//  - only real passenger calls (activity T, U, D, R, TB, TF), with pick-up
//    and set-down only stops respected, using public times
//  - divides (VV) and joins (JJ): a passenger who stays in their seat
//    through a divide or join is on one physical train, so a through train
//    is added and the journey counts as direct
//
// Record layouts follow the Network Rail CIF End User Specification.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { addDays, compactDate, weekday } from '../public/js/core/timetable.js';

const PASSENGER_STATUS = new Set(['P', '1']);
const STP_RANK = { C: 0, N: 1, O: 2, P: 3 };

const field = (line, from, to) => line.slice(from, to).trim();

/** 'yymmdd' -> 'YYYYMMDD' ('999999' means open-ended). */
function cifDate(s) {
  if (s === '999999') return '99991231';
  return `20${s}`;
}

/** 'HHMM' or 'HHMMH' -> minutes (half minutes rounded down). */
function cifTime(s) {
  if (!s || !/^\d{4}/.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
}

function activities(s) {
  const out = new Set();
  for (let i = 0; i < s.length; i += 2) {
    const a = s.slice(i, i + 2).trim();
    if (a) out.add(a);
  }
  return out;
}

/**
 * A public time, or null when there is none. In CIF "0000" in a public time
 * column usually means "not advertised", unless the train really is there
 * at midnight (its working time is within a minute of it).
 */
function publicTime(pub, wtt) {
  if (!pub || !/^\d{4}$/.test(pub)) return null;
  if (pub !== '0000') return cifTime(pub);
  const w = cifTime(wtt);
  return w !== null && (w <= 1 || w >= 1439) ? 0 : null;
}

/**
 * Times for a call. Public times are preferred and used consistently: a
 * pick-up-only stop has no public arrival, so its public departure stands in
 * (mixing in the working arrival, which can be a minute later than the
 * public departure, would look like the train going back in time).
 */
function callTimes(wttArr, wttDep, pubArr, pubDep) {
  const pa = publicTime(pubArr, wttArr), pd = publicTime(pubDep, wttDep);
  const arr = pa ?? pd ?? cifTime(wttArr) ?? cifTime(wttDep);
  const dep = pd ?? pa ?? cifTime(wttDep) ?? cifTime(wttArr);
  return [arr, dep];
}

/**
 * @param {string} file .CIF or .CIF.gz
 * @param {object} opts
 * @param {string} opts.start  first searchable date (YYYY-MM-DD)
 * @param {number} opts.days
 * @param {Array} opts.referenceStations  [{stationName, crsCode, lat, long}]
 * @param {object} [opts.operators]  ATOC code -> {name, url, color}
 * @param {Array} [opts.links]  [[fromCrs, toCrs, minutes, mode]]
 */
export async function loadCif(file, { start, days, referenceStations, operators = {}, links = [] }) {
  const windowStart = addDays(start, -1);
  const dates = Array.from({ length: days + 1 }, (_, i) => compactDate(addDays(windowStart, i)));
  const firstDate = dates[0], lastDate = dates[dates.length - 1];
  const inWindow = (from, to) => from <= lastDate && to >= firstDate;

  const tiplocCrs = new Map();
  const schedules = []; // passenger schedules and cancellations in the window
  const associations = [];
  let current = null;
  let header = null;

  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const rec = line.slice(0, 2);
    switch (rec) {
      case 'HD':
        header = { identity: field(line, 2, 22), extracted: field(line, 22, 32) };
        break;
      case 'TI':
      case 'TA': {
        const crs = field(line, 53, 56);
        if (crs) tiplocCrs.set(field(line, 2, 9), crs);
        break;
      }
      case 'AA': {
        const cat = field(line, 34, 36);
        const stp = line[79];
        if (stp !== 'C' && !(cat === 'VV' || cat === 'JJ')) break;
        if (line[36] !== 'S' && stp !== 'C') break; // only same-day associations
        const from = cifDate(field(line, 15, 21)), to = cifDate(field(line, 21, 27));
        if (!inWindow(from, to)) break;
        associations.push({
          base: field(line, 3, 9), assoc: field(line, 9, 15), from, to,
          days: field(line, 27, 34), cat, location: field(line, 37, 44), stp,
        });
        break;
      }
      case 'BS': {
        current = null;
        const stp = line[79];
        const from = cifDate(field(line, 9, 15)), to = cifDate(field(line, 15, 21));
        if (!inWindow(from, to)) break;
        const status = line[29];
        const category = field(line, 30, 32);
        const passenger = PASSENGER_STATUS.has(status) && /^[OX]/.test(category);
        if (!passenger && stp !== 'C') break;
        current = {
          uid: field(line, 3, 9), from, to, days: field(line, 21, 28), stp,
          headcode: field(line, 32, 36), atoc: '', calls: [], passenger,
        };
        schedules.push(current);
        break;
      }
      case 'BX':
        if (current) current.atoc = field(line, 11, 13);
        break;
      case 'LO':
        if (current) addCall(current, field(line, 2, 9), ...callTimes('', field(line, 10, 15), '', field(line, 15, 19)), field(line, 29, 41));
        break;
      case 'LI':
        if (current) {
          if (field(line, 20, 25)) break; // passing point
          addCall(current, field(line, 2, 9),
            ...callTimes(field(line, 10, 15), field(line, 15, 20), field(line, 25, 29), field(line, 29, 33)),
            field(line, 42, 54));
        }
        break;
      case 'LT':
        if (current) addCall(current, field(line, 2, 9), ...callTimes(field(line, 10, 15), '', field(line, 15, 19), ''), field(line, 25, 37));
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- stations
  const refByCrs = new Map(referenceStations.map((s) => [s.crsCode, s]));
  const feed = {
    source: file,
    info: header ? { publisher: 'Network Rail CIF', version: header.identity, extracted: header.extracted } : null,
    agencies: new Map(),
    routes: new Map(),
    stations: [],
    stationIndexByStopId: new Map(),
    stationIndexByCrs: new Map(),
    services: new Map(),
    trips: [],
    transfers: [],
    minChange: new Map(),
    fares: new Map(),
    zoneByStation: [],
    dateRange: { start: compactDate(start), end: compactDate(addDays(start, days - 1)) },
  };
  const stationIdx = (crs) => {
    if (feed.stationIndexByCrs.has(crs)) return feed.stationIndexByCrs.get(crs);
    const ref = refByCrs.get(crs);
    if (!ref) return -1;
    const idx = feed.stations.length;
    feed.stations.push({ idx, id: crs, crs, name: ref.stationName, lat: ref.lat, lon: ref.long });
    feed.zoneByStation.push(crs);
    feed.stationIndexByCrs.set(crs, idx);
    feed.stationIndexByStopId.set(crs, idx);
    return idx;
  };

  // ---------------------------------------------------------------- STP resolution per day
  const byUid = groupBy(schedules, (s) => s.uid);
  const assocByKey = groupBy(associations, (a) => `${a.base}|${a.assoc}|${a.location}`);
  const runsOn = (rec, date) => date >= rec.from && date <= rec.to && rec.days[weekday(date)] === '1';
  const winner = (recs, date) => {
    let best = null;
    for (const r of recs) {
      if (!runsOn(r, date)) continue;
      if (!best || STP_RANK[r.stp] < STP_RANK[best.stp]) best = r;
    }
    return best && best.stp !== 'C' ? best : null;
  };

  const tripDates = new Map(); // key -> {build(), dates:Set}
  const note = (key, build, date) => {
    if (!tripDates.has(key)) tripDates.set(key, { build, dates: new Set() });
    tripDates.get(key).dates.add(date);
  };

  for (const date of dates) {
    const running = new Map();
    for (const [uid, recs] of byUid) {
      const s = winner(recs, date);
      if (s && s.passenger) {
        running.set(uid, s);
        note(s, () => tripFromSchedule(s), date);
      }
    }
    for (const recs of assocByKey.values()) {
      const a = winner(recs, date);
      if (!a) continue;
      const base = running.get(a.base), assoc = running.get(a.assoc);
      if (!base || !assoc) continue;
      // VV: base divides, assoc continues from the location.
      // JJ: assoc joins base at the location.
      const [first, second] = a.cat === 'VV' ? [base, assoc] : [assoc, base];
      note(`${a.cat}|${first.uid}${first.stp}${first.from}|${second.uid}${second.stp}${second.from}|${a.location}`,
        () => throughTrip(first, second, a), date);
    }
  }

  // ---------------------------------------------------------------- trips
  const route = (atoc) => {
    const code = atoc || 'ZZ';
    if (!feed.routes.has(code)) {
      const op = operators[code] || { name: `Operator ${code}`, url: '', color: null };
      feed.agencies.set(code, { id: code, name: op.name, url: op.url || '' });
      feed.routes.set(code, { id: code, agencyId: code, shortName: code, longName: '', color: op.color || null });
    }
    return code;
  };

  function freeze(calls) {
    // Map to stations, merge consecutive calls at the same station.
    const out = [];
    for (const c of calls) {
      const crs = tiplocCrs.get(c.tiploc);
      const idx = crs ? stationIdx(crs) : -1;
      if (idx < 0) continue;
      const prev = out[out.length - 1];
      if (prev && prev.station === idx) {
        prev.dep = c.dep;
        prev.pickup = c.pickup;
        continue;
      }
      out.push({ ...c, station: idx });
    }
    return out.length >= 2 ? out : null;
  }

  function build(calls, { id, atoc, headcode, note: tripNote }) {
    const n = calls.length;
    return {
      id,
      routeId: route(atoc),
      headsign: feed.stations[calls[n - 1].station].name,
      shortName: headcode,
      blockId: null,
      note: tripNote || null,
      stations: Int32Array.from(calls, (c) => c.station),
      arr: Int32Array.from(calls, (c) => c.arr),
      dep: Int32Array.from(calls, (c) => c.dep),
      pickup: Uint8Array.from(calls, (c, i) => (i < n - 1 && c.pickup ? 1 : 0)),
      dropoff: Uint8Array.from(calls, (c, i) => (i > 0 && c.dropoff ? 1 : 0)),
    };
  }

  function tripFromSchedule(s) {
    const calls = freeze(s.calls);
    return calls && build(calls, { id: `${s.uid}${s.stp}${s.from.slice(2)}`, atoc: s.atoc, headcode: s.headcode });
  }

  function throughTrip(first, second, a) {
    const i = first.calls.findIndex((c) => c.tiploc === a.location);
    const j = second.calls.findIndex((c) => c.tiploc === a.location);
    if (i < 0 || j < 0 || j >= second.calls.length - 1) return null;
    const joint = { ...first.calls[i], dep: second.calls[j].dep, pickup: second.calls[j].pickup };
    const calls = [...first.calls.slice(0, i), joint, ...second.calls.slice(j + 1)];
    // Times must keep moving forward.
    for (let k = 1; k < calls.length; k++) if (calls[k].arr < calls[k - 1].dep) return null;
    const frozen = freeze(calls);
    if (!frozen) return null;
    const placeCrs = tiplocCrs.get(a.location);
    const place = placeCrs && feed.stations[stationIdx(placeCrs)]?.name;
    const what = a.cat === 'VV' ? 'divides' : 'joins another train';
    return build(frozen, {
      id: `${first.uid}+${second.uid}`,
      atoc: second.atoc || first.atoc,
      headcode: second.headcode,
      note: `Train ${what}${place ? ` at ${place}` : ''}: check you are in the right part`,
    });
  }

  const serviceIds = new Map();
  for (const { build: make, dates: ds } of tripDates.values()) {
    const trip = make();
    if (!trip) continue;
    const key = [...ds].sort().join(',');
    if (!serviceIds.has(key)) {
      const id = `S${serviceIds.size}`;
      serviceIds.set(key, id);
      feed.services.set(id, { days: null, start: null, end: null, added: new Set(ds), removed: new Set() });
    }
    trip.serviceId = serviceIds.get(key);
    feed.trips.push(trip);
  }

  for (const [a, b, minutes, mode] of links) {
    const from = feed.stationIndexByCrs.get(a), to = feed.stationIndexByCrs.get(b);
    if (from === undefined || to === undefined) continue;
    feed.transfers.push({ from, to, minutes, mode }, { from: to, to: from, minutes, mode });
  }
  return feed;
}

function addCall(s, tiploc, arr, dep, activity) {
  const acts = activities(activity);
  const pickup = acts.has('T') || acts.has('TB') || acts.has('U') || acts.has('R');
  const dropoff = acts.has('T') || acts.has('TF') || acts.has('D') || acts.has('R');
  if (!pickup && !dropoff) return;
  if (arr === null || dep === null) return;
  // Keep the clock moving forward. Only a big step back (hours) means the
  // train has passed midnight; a small one is rounding between public and
  // working times, so the time is held level instead.
  const prev = s.calls[s.calls.length - 1];
  const a = forward(arr, prev ? prev.dep : -Infinity);
  const d = forward(dep, a);
  s.calls.push({ tiploc, arr: a, dep: d, pickup, dropoff });
}

function forward(t, floor) {
  let x = t;
  while (x < floor - 360) x += 1440;
  return Math.max(x, floor);
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
