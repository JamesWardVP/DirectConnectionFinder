// GTFS loader. Reads a feed from a directory of .txt files or a .zip and
// builds a compact in-memory model used by the router.
//
// Platforms (stops with a parent_station) are collapsed into their parent
// station, so routing works station-to-station like a National Rail planner.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import AdmZip from 'adm-zip';

const CRS_RE = /^[A-Z]{3}$/;
const MAX_ZIP_ENTRY_BYTES = 2 * 1024 ** 3;

/** Split one CSV line into fields (RFC 4180 quoting). */
export function parseCsvLine(line) {
  const out = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Abstracts over a directory or a zip so callers can stream rows by file name. */
class FeedSource {
  constructor(location) {
    this.location = location;
    this.isZip = fs.statSync(location).isFile();
    if (this.isZip) {
      this.zip = new AdmZip(location);
      this.entries = new Map();
      for (const e of this.zip.getEntries()) {
        if (!e.isDirectory) this.entries.set(path.basename(e.entryName), e);
      }
    }
  }

  has(name) {
    return this.isZip ? this.entries.has(name) : fs.existsSync(path.join(this.location, name));
  }

  async *lines(name) {
    if (this.isZip) {
      const entry = this.entries.get(name);
      if (entry.header.size > MAX_ZIP_ENTRY_BYTES) throw new Error(`${name} is too large to load`);
      const text = entry.getData().toString('utf8');
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        yield text.slice(start, end);
        start = end + 1;
      }
    } else {
      const rl = readline.createInterface({
        input: fs.createReadStream(path.join(this.location, name), 'utf8'),
        crlfDelay: Infinity,
      });
      for await (const line of rl) yield line;
    }
  }

  /** Calls fn(row, col) for every data row, where col(name) gives a column index. */
  async eachRow(name, fn) {
    if (!this.has(name)) return false;
    let header = null;
    for await (let line of this.lines(name)) {
      line = line.replace(/\r$/, '');
      if (!header) {
        header = parseCsvLine(line.replace(/^﻿/, '')).map((h) => h.trim());
        continue;
      }
      if (!line.trim()) continue;
      fn(line.includes('"') ? parseCsvLine(line) : line.split(','), header);
    }
    return true;
  }
}

const colIndex = (header) => {
  const map = new Map(header.map((h, i) => [h, i]));
  return (name) => (map.has(name) ? map.get(name) : -1);
};
const get = (row, i) => (i >= 0 && i < row.length ? row[i].trim() : '');

/** "HH:MM:SS" (hours may exceed 24) -> minutes after service-day midnight. */
export function parseTime(s) {
  if (!s) return null;
  const [h, m, sec = '0'] = s.split(':');
  return Number(h) * 60 + Number(m) + Math.round(Number(sec) / 60);
}

function normaliseName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(rail|railway|station)\b/g, '').trim();
}

/**
 * Load a GTFS feed.
 * @param {string} location directory or .zip path
 * @param {{ referenceStations?: Array<{stationName:string, crsCode:string, lat:number, long:number}> }} [opts]
 */
export async function loadGtfs(location, opts = {}) {
  const src = new FeedSource(location);
  const refByName = new Map((opts.referenceStations || []).map((s) => [normaliseName(s.stationName), s]));

  const feed = {
    source: location,
    info: null,
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
    dateRange: null,
  };

  await src.eachRow('feed_info.txt', (r, h) => {
    const c = colIndex(h);
    feed.info = {
      publisher: get(r, c('feed_publisher_name')),
      url: get(r, c('feed_publisher_url')),
      start: get(r, c('feed_start_date')) || null,
      end: get(r, c('feed_end_date')) || null,
      version: get(r, c('feed_version')) || null,
    };
  });

  await src.eachRow('agency.txt', (r, h) => {
    const c = colIndex(h);
    const id = get(r, c('agency_id')) || '_default';
    feed.agencies.set(id, { id, name: get(r, c('agency_name')), url: get(r, c('agency_url')) });
  });

  await src.eachRow('routes.txt', (r, h) => {
    const c = colIndex(h);
    const id = get(r, c('route_id'));
    feed.routes.set(id, {
      id,
      agencyId: get(r, c('agency_id')) || [...feed.agencies.keys()][0] || '_default',
      shortName: get(r, c('route_short_name')),
      longName: get(r, c('route_long_name')),
      color: get(r, c('route_color')) || null,
    });
  });

  // Stops: first pass collects everything, then platforms collapse onto parents.
  const rawStops = new Map();
  await src.eachRow('stops.txt', (r, h) => {
    const c = colIndex(h);
    const id = get(r, c('stop_id'));
    rawStops.set(id, {
      id,
      code: get(r, c('stop_code')),
      name: get(r, c('stop_name')),
      lat: Number(get(r, c('stop_lat'))),
      lon: Number(get(r, c('stop_lon'))),
      parent: get(r, c('parent_station')),
      zone: get(r, c('zone_id')),
    });
  });
  const stationFor = (stopId) => {
    let s = rawStops.get(stopId);
    const seen = new Set();
    while (s && s.parent && rawStops.has(s.parent) && !seen.has(s.id)) {
      seen.add(s.id);
      s = rawStops.get(s.parent);
    }
    return s;
  };
  const ensureStation = (stopId) => {
    if (feed.stationIndexByStopId.has(stopId)) return feed.stationIndexByStopId.get(stopId);
    const s = stationFor(stopId);
    if (!s) return -1;
    let idx = feed.stationIndexByStopId.get(s.id);
    if (idx === undefined) {
      let crs = CRS_RE.test(s.code) ? s.code : CRS_RE.test(s.id) ? s.id : null;
      if (!crs) crs = refByName.get(normaliseName(s.name))?.crsCode || null;
      idx = feed.stations.length;
      feed.stations.push({ idx, id: s.id, crs, name: s.name, lat: s.lat, lon: s.lon });
      feed.zoneByStation.push(s.zone || rawStops.get(stopId)?.zone || null);
      feed.stationIndexByStopId.set(s.id, idx);
      if (crs && !feed.stationIndexByCrs.has(crs)) feed.stationIndexByCrs.set(crs, idx);
    }
    feed.stationIndexByStopId.set(stopId, idx);
    return idx;
  };

  // Calendars.
  let minDate = null, maxDate = null;
  const widen = (d) => {
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  };
  const service = (id) => {
    if (!feed.services.has(id)) feed.services.set(id, { days: null, start: null, end: null, added: new Set(), removed: new Set() });
    return feed.services.get(id);
  };
  await src.eachRow('calendar.txt', (r, h) => {
    const c = colIndex(h);
    const s = service(get(r, c('service_id')));
    s.days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => get(r, c(d)) === '1');
    s.start = get(r, c('start_date'));
    s.end = get(r, c('end_date'));
    widen(s.start); widen(s.end);
  });
  await src.eachRow('calendar_dates.txt', (r, h) => {
    const c = colIndex(h);
    const s = service(get(r, c('service_id')));
    const date = get(r, c('date'));
    if (get(r, c('exception_type')) === '1') { s.added.add(date); widen(date); } else s.removed.add(date);
  });
  feed.dateRange = minDate ? { start: minDate, end: maxDate } : null;

  // Trips.
  const tripIndex = new Map();
  await src.eachRow('trips.txt', (r, h) => {
    const c = colIndex(h);
    const id = get(r, c('trip_id'));
    tripIndex.set(id, feed.trips.length);
    feed.trips.push({
      id,
      routeId: get(r, c('route_id')),
      serviceId: get(r, c('service_id')),
      headsign: get(r, c('trip_headsign')),
      shortName: get(r, c('trip_short_name')),
      blockId: get(r, c('block_id')) || null,
      calls: [],
    });
  });

  // Stop times: streamed; this is by far the biggest file.
  let cols = null;
  await src.eachRow('stop_times.txt', (r, h) => {
    if (!cols) {
      const c = colIndex(h);
      cols = {
        trip: c('trip_id'), arr: c('arrival_time'), dep: c('departure_time'), stop: c('stop_id'),
        seq: c('stop_sequence'), pickup: c('pickup_type'), dropoff: c('drop_off_type'),
      };
    }
    const ti = tripIndex.get(get(r, cols.trip));
    if (ti === undefined) return;
    const station = ensureStation(get(r, cols.stop));
    if (station < 0) return;
    feed.trips[ti].calls.push({
      seq: Number(get(r, cols.seq)),
      station,
      arr: parseTime(get(r, cols.arr)),
      dep: parseTime(get(r, cols.dep)),
      pickup: get(r, cols.pickup) !== '1',
      dropoff: get(r, cols.dropoff) !== '1',
    });
  });

  // Freeze trips into typed arrays; interpolate missing times.
  feed.trips = feed.trips.filter((t) => t.calls.length >= 2);
  for (const t of feed.trips) {
    t.calls.sort((a, b) => a.seq - b.seq);
    // Merge consecutive calls at the same station (platform changes within a station).
    const calls = [];
    for (const call of t.calls) {
      const prev = calls[calls.length - 1];
      if (prev && prev.station === call.station) {
        prev.dep = call.dep ?? prev.dep;
        prev.pickup = call.pickup;
      } else calls.push({ ...call });
    }
    interpolate(calls);
    const n = calls.length;
    t.stations = Int32Array.from(calls, (x) => x.station);
    t.arr = Int32Array.from(calls, (x) => x.arr);
    t.dep = Int32Array.from(calls, (x) => x.dep);
    t.pickup = Uint8Array.from(calls, (x, i) => (i < n - 1 && x.pickup ? 1 : 0));
    t.dropoff = Uint8Array.from(calls, (x, i) => (i > 0 && x.dropoff ? 1 : 0));
    delete t.calls;
  }
  feed.trips = feed.trips.filter((t) => t.stations.length >= 2);

  // Transfers: same-station minimum connection times, and links between stations.
  await src.eachRow('transfers.txt', (r, h) => {
    const c = colIndex(h);
    const from = feed.stationIndexByStopId.get(get(r, c('from_stop_id')));
    const to = feed.stationIndexByStopId.get(get(r, c('to_stop_id')));
    if (from === undefined || to === undefined) return;
    const type = get(r, c('transfer_type'));
    if (type === '3' || type === '5') return; // not possible
    const minutes = Math.ceil(Number(get(r, c('min_transfer_time')) || 0) / 60);
    if (from === to) {
      feed.minChange.set(from, minutes);
    } else {
      const mode = get(r, c('transfer_mode')) || 'walk';
      feed.transfers.push({ from, to, minutes: Math.max(minutes, 1), mode });
    }
  });

  // Fares (GTFS fares v1 with origin/destination zones).
  const farePrices = new Map();
  await src.eachRow('fare_attributes.txt', (r, h) => {
    const c = colIndex(h);
    farePrices.set(get(r, c('fare_id')), { price: Number(get(r, c('price'))), currency: get(r, c('currency_type')) || 'GBP' });
  });
  await src.eachRow('fare_rules.txt', (r, h) => {
    const c = colIndex(h);
    const fare = farePrices.get(get(r, c('fare_id')));
    const o = get(r, c('origin_id')), d = get(r, c('destination_id'));
    if (!fare || !o || !d || Number.isNaN(fare.price)) return;
    const key = `${o}|${d}`;
    const existing = feed.fares.get(key);
    if (!existing || fare.price < existing.price) feed.fares.set(key, fare);
  });

  return feed;
}

/** Fill in null arrival/departure times by linear interpolation. */
function interpolate(calls) {
  for (const c of calls) {
    if (c.arr == null) c.arr = c.dep;
    if (c.dep == null) c.dep = c.arr;
  }
  let i = 0;
  while (i < calls.length) {
    if (calls[i].arr != null) { i++; continue; }
    const startIdx = i - 1;
    let endIdx = i;
    while (endIdx < calls.length && calls[endIdx].arr == null) endIdx++;
    if (startIdx < 0 || endIdx >= calls.length) {
      // Cannot interpolate at the ends; drop timing by copying neighbours.
      const fill = startIdx >= 0 ? calls[startIdx].dep : calls[endIdx]?.arr ?? 0;
      for (let k = i; k < endIdx; k++) calls[k].arr = calls[k].dep = fill;
    } else {
      const t0 = calls[startIdx].dep, t1 = calls[endIdx].arr, steps = endIdx - startIdx;
      for (let k = i; k < endIdx; k++) {
        calls[k].arr = calls[k].dep = Math.round(t0 + ((t1 - t0) * (k - startIdx)) / steps);
      }
    }
    i = endIdx;
  }
}
