// Compact timetable bundle: the static file the website loads.
//
// encodeBundle() runs at build time (in a GitHub Action) and turns a loaded
// feed (from GTFS or Network Rail CIF) into JSON covering a rolling window
// of dates. decodeBundle() runs in the browser and rebuilds the same feed
// model the router uses.
//
// Size tricks: trips that share a calling pattern and running times share
// one "pattern" (only the start time differs), and each trip's running days
// are a bitmask over the window, deduplicated into a services table.
import { Timetable, addDays, compactDate } from './timetable.js';

export const BUNDLE_FORMAT = 1;

/**
 * @param {object} feed   loaded feed (lib/gtfs.js or lib/cif.js)
 * @param {object} opts
 * @param {string} opts.start  first searchable date, 'YYYY-MM-DD'
 * @param {number} opts.days   number of searchable days
 * @param {object} [opts.source] description of where the data came from
 */
export function encodeBundle(feed, { start, days, source = {}, generated = new Date().toISOString() }) {
  // One extra day before the window so trains running past midnight into the
  // first searchable day are included.
  const windowStart = addDays(start, -1);
  const windowDays = days + 1;
  const dates = Array.from({ length: windowDays }, (_, i) => compactDate(addDays(windowStart, i)));
  const tt = new Timetable(feed);

  // Running days as a hex bitmask over the window.
  const maskByService = new Map();
  for (const serviceId of feed.services.keys()) {
    const bits = dates.map((d) => (tt.serviceRuns(serviceId, d) ? 1 : 0));
    if (!bits.includes(1)) continue;
    maskByService.set(serviceId, bitsToHex(bits));
  }

  const services = [], serviceIndex = new Map();
  const stationMap = new Map(), stations = [];
  const routeMap = new Map(), routes = [];
  const agencyMap = new Map(), agencies = [];
  const patterns = [], patternIndex = new Map();
  const headsigns = [], headsignIndex = new Map();
  const blocks = [], blockIndex = new Map();
  const notes = [], noteIndex = new Map();
  const cols = { id: [], pattern: [], start: [], service: [], route: [], headsign: [], block: [], name: [], note: [] };

  const intern = (list, index, value) => {
    if (!index.has(value)) { index.set(value, list.length); list.push(value); }
    return index.get(value);
  };
  const station = (idx) => {
    if (!stationMap.has(idx)) {
      const s = feed.stations[idx];
      stationMap.set(idx, stations.length);
      stations.push([s.id, s.crs || '', s.name, round(s.lat, 5), round(s.lon, 5), feed.zoneByStation?.[idx] || '']);
    }
    return stationMap.get(idx);
  };
  const agency = (id) => {
    if (!agencyMap.has(id)) {
      const a = feed.agencies.get(id) || { id, name: id, url: '' };
      agencyMap.set(id, agencies.length);
      agencies.push([a.id, a.name, a.url || '']);
    }
    return agencyMap.get(id);
  };
  const route = (id) => {
    if (!routeMap.has(id)) {
      const r = feed.routes.get(id) || { id, agencyId: id, shortName: '', longName: '', color: null };
      routeMap.set(id, routes.length);
      routes.push([r.id, agency(r.agencyId), r.shortName || '', r.longName || '', r.color || '']);
    }
    return routeMap.get(id);
  };

  for (const t of feed.trips) {
    const mask = maskByService.get(t.serviceId);
    if (!mask) continue;
    const n = t.stations.length;
    const st = Array.from(t.stations, station);
    const deltas = [];
    for (let i = 1; i < n; i++) deltas.push(t.arr[i] - t.dep[i - 1], t.dep[i] - t.arr[i]);
    let flags = '';
    for (let i = 0; i < n; i++) flags += String(t.pickup[i] * 2 + t.dropoff[i]);
    const key = `${st.join(',')}|${deltas.join(',')}|${flags}`;
    let p = patternIndex.get(key);
    if (p === undefined) {
      p = patterns.length;
      patternIndex.set(key, p);
      patterns.push([st, deltas, flags]);
    }
    const lastName = feed.stations[t.stations[n - 1]].name;
    cols.id.push(t.id);
    cols.pattern.push(p);
    cols.start.push(t.dep[0]);
    cols.service.push(intern(services, serviceIndex, mask));
    cols.route.push(route(t.routeId));
    cols.headsign.push(!t.headsign || t.headsign === lastName ? -1 : intern(headsigns, headsignIndex, t.headsign));
    cols.block.push(t.blockId ? intern(blocks, blockIndex, t.blockId) : -1);
    cols.name.push(t.shortName || '');
    cols.note.push(t.note ? intern(notes, noteIndex, t.note) : -1);
  }
  if (cols.name.every((x) => !x)) delete cols.name;
  if (cols.block.every((x) => x === -1)) delete cols.block;
  if (cols.headsign.every((x) => x === -1)) delete cols.headsign;
  if (cols.note.every((x) => x === -1)) delete cols.note;

  const transfers = feed.transfers
    .filter((tr) => stationMap.has(tr.from) && stationMap.has(tr.to))
    .map((tr) => [stationMap.get(tr.from), stationMap.get(tr.to), tr.minutes, tr.mode]);
  const minChange = [...feed.minChange]
    .filter(([s]) => stationMap.has(s))
    .map(([s, m]) => [stationMap.get(s), m]);
  const fares = [...feed.fares].map(([key, f]) => {
    const [a, b] = key.split('|');
    return [a, b, f.price, f.currency || 'GBP'];
  });

  return {
    format: BUNDLE_FORMAT,
    generated,
    source,
    info: feed.info || null,
    window: { start: windowStart, days: windowDays },
    searchable: { start, end: addDays(start, days - 1) },
    agencies, routes, stations, services, patterns, headsigns, blocks, notes, trips: cols,
    transfers, minChange, fares,
  };
}

/** Rebuild the router's feed model from a bundle. */
export function decodeBundle(b) {
  if (b.format !== BUNDLE_FORMAT) throw new Error(`Unsupported timetable format ${b.format}`);
  const feed = {
    source: b.source,
    info: b.info,
    generated: b.generated,
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
    dateRange: { start: compactDate(b.searchable.start), end: compactDate(b.searchable.end) },
  };
  for (const [id, name, url] of b.agencies) feed.agencies.set(id, { id, name, url });
  b.routes.forEach(([id, agencyIdx, shortName, longName, color]) => {
    feed.routes.set(id, { id, agencyId: b.agencies[agencyIdx][0], shortName, longName, color: color || null });
  });
  b.stations.forEach(([id, crs, name, lat, lon, zone], idx) => {
    feed.stations.push({ idx, id, crs: crs || null, name, lat, lon });
    feed.zoneByStation.push(zone || null);
    feed.stationIndexByStopId.set(id, idx);
    if (crs && !feed.stationIndexByCrs.has(crs)) feed.stationIndexByCrs.set(crs, idx);
  });
  b.services.forEach((hex, i) => {
    const added = new Set();
    hexToBits(hex, b.window.days).forEach((bit, d) => {
      if (bit) added.add(compactDate(addDays(b.window.start, d)));
    });
    feed.services.set(String(i), { days: null, start: null, end: null, added, removed: new Set() });
  });

  const decoded = b.patterns.map(([st, deltas, flags]) => {
    const n = st.length;
    const stations = Int32Array.from(st);
    const relArr = new Int32Array(n), relDep = new Int32Array(n);
    for (let i = 1; i < n; i++) {
      relArr[i] = relDep[i - 1] + deltas[2 * (i - 1)];
      relDep[i] = relArr[i] + deltas[2 * (i - 1) + 1];
    }
    const pickup = new Uint8Array(n), dropoff = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = flags.charCodeAt(i) - 48;
      pickup[i] = f >> 1;
      dropoff[i] = f & 1;
    }
    return { stations, relArr, relDep, pickup, dropoff };
  });

  const c = b.trips;
  for (let i = 0; i < c.pattern.length; i++) {
    const p = decoded[c.pattern[i]];
    const start = c.start[i];
    const hs = c.headsign ? c.headsign[i] : -1;
    feed.trips.push({
      id: c.id[i],
      routeId: b.routes[c.route[i]][0],
      serviceId: String(c.service[i]),
      headsign: hs >= 0 ? b.headsigns[hs] : feed.stations[p.stations[p.stations.length - 1]].name,
      shortName: c.name ? c.name[i] : '',
      blockId: c.block && c.block[i] >= 0 ? b.blocks[c.block[i]] : null,
      note: c.note && c.note[i] >= 0 ? b.notes[c.note[i]] : null,
      stations: p.stations,
      arr: p.relArr.map((t) => t + start),
      dep: p.relDep.map((t) => t + start),
      pickup: p.pickup,
      dropoff: p.dropoff,
    });
  }
  for (const [from, to, minutes, mode] of b.transfers) feed.transfers.push({ from, to, minutes, mode });
  for (const [s, m] of b.minChange) feed.minChange.set(s, m);
  for (const [a, z, price, currency] of b.fares) feed.fares.set(`${a}|${z}`, { price, currency });
  return feed;
}

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nib = (bits[i] || 0) | ((bits[i + 1] || 0) << 1) | ((bits[i + 2] || 0) << 2) | ((bits[i + 3] || 0) << 3);
    hex += nib.toString(16);
  }
  return hex;
}

function hexToBits(hex, length) {
  const bits = [];
  for (const ch of hex) {
    const nib = parseInt(ch, 16);
    bits.push(nib & 1, (nib >> 1) & 1, (nib >> 2) & 1, (nib >> 3) & 1);
  }
  return bits.slice(0, length);
}
