// Per-day timetable index built on top of a loaded GTFS feed.
//
// A "day" covers trips from the previous service day (still running after
// midnight), the day itself and the early part of the next day, all on one
// clock measured in minutes from midnight of the requested date.
//
// Trips sharing a GTFS block_id that run on continuously from the same
// station are merged into a single "train": a passenger who stays in their
// seat is on one physical train, so it counts as a direct journey.

const DAY = 1440;
const NEXT_DAY_HORIZON = 10 * 60; // include next-day trips departing before 10:00
const BLOCK_MAX_GAP = 60;

/** 'YYYY-MM-DD' or 'YYYYMMDD' -> 'YYYYMMDD' */
export const compactDate = (d) => d.replace(/-/g, '');
/** 'YYYYMMDD' -> 'YYYY-MM-DD' */
export const isoDate = (d) => (d.includes('-') ? d : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);

export function addDays(date, n) {
  const d = new Date(`${isoDate(date)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6 */
export function weekday(date) {
  return (new Date(`${isoDate(date)}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export class Timetable {
  constructor(feed, { cacheSize = 21 } = {}) {
    this.feed = feed;
    this.cache = new Map();
    this.cacheSize = cacheSize;
    this.tripsByService = new Map();
    for (const t of feed.trips) {
      if (!this.tripsByService.has(t.serviceId)) this.tripsByService.set(t.serviceId, []);
      this.tripsByService.get(t.serviceId).push(t);
    }
    this.patternIds = new Map();
  }

  serviceRuns(serviceId, date) {
    const s = this.feed.services.get(serviceId);
    if (!s) return false;
    const d = compactDate(date);
    if (s.removed.has(d)) return false;
    if (s.added.has(d)) return true;
    if (!s.days || d < s.start || d > s.end) return false;
    return s.days[weekday(d)];
  }

  tripsOn(date) {
    const out = [];
    for (const [serviceId, trips] of this.tripsByService) {
      if (this.serviceRuns(serviceId, date)) out.push(...trips);
    }
    return out;
  }

  /** Trains (block-merged trips) for one service day, cached briefly. */
  trainsOn(date) {
    this.trainCache ??= new Map();
    if (!this.trainCache.has(date)) {
      this.trainCache.set(date, mergeBlocks(this.tripsOn(date)));
      if (this.trainCache.size > 4) this.trainCache.delete(this.trainCache.keys().next().value);
    }
    return this.trainCache.get(date);
  }

  /** True if any trip runs on the date. */
  hasServiceOn(date) {
    for (const serviceId of this.tripsByService.keys()) if (this.serviceRuns(serviceId, date)) return true;
    return false;
  }

  day(date) {
    const key = isoDate(date);
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, v);
      return v;
    }
    const built = this.buildDay(key);
    this.cache.set(key, built);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return built;
  }

  buildDay(date) {
    const trains = [];
    const add = (serviceDate, offset, keep) => {
      for (const train of this.trainsOn(serviceDate)) {
        const first = train.dep[0] + offset, last = train.arr[train.arr.length - 1] + offset;
        if (!keep(first, last)) continue;
        trains.push(shiftTrain(train, offset, serviceDate));
      }
    };
    add(addDays(date, -1), -DAY, (first, last) => last >= 0);
    add(date, 0, () => true);
    add(addDays(date, 1), DAY, (first) => first < DAY + NEXT_DAY_HORIZON);

    // Departures per station, sorted by time, in flat typed arrays.
    const nStations = this.feed.stations.length;
    const counts = new Int32Array(nStations + 1);
    trains.forEach((train) => {
      if (!train.patternKey) train.patternKey = Array.prototype.join.call(train.stations, ',');
      if (!this.patternIds.has(train.patternKey)) this.patternIds.set(train.patternKey, this.patternIds.size);
      train.pattern = this.patternIds.get(train.patternKey);
      for (let p = 0; p < train.stations.length - 1; p++) if (train.pickup[p]) counts[train.stations[p] + 1]++;
    });
    for (let i = 0; i < nStations; i++) counts[i + 1] += counts[i];
    const total = counts[nStations];
    const fill = counts.slice(0, nStations);
    const keys = new Float64Array(total), trainOf = new Int32Array(total), posOf = new Int32Array(total);
    trains.forEach((train, ti) => {
      for (let p = 0; p < train.stations.length - 1; p++) {
        if (!train.pickup[p]) continue;
        const k = fill[train.stations[p]]++;
        trainOf[k] = ti;
        posOf[k] = p;
        // Sort key: departure time, then entry number (exact in a double).
        keys[k] = (train.dep[p] + 4096) * 8388608 + k;
      }
    });
    const departures = new Array(nStations);
    for (let s = 0; s < nStations; s++) {
      const a = counts[s], b = counts[s + 1];
      const seg = keys.subarray(a, b).sort();
      const time = new Int32Array(b - a), train = new Int32Array(b - a), pos = new Int32Array(b - a);
      for (let i = 0; i < seg.length; i++) {
        const k = seg[i] % 8388608;
        time[i] = Math.round((seg[i] - k) / 8388608) - 4096;
        train[i] = trainOf[k];
        pos[i] = posOf[k];
      }
      departures[s] = { time, train, pos };
    }
    return { date, trains, departures };
  }
}

function shiftTrain(train, offset, serviceDate) {
  if (offset === 0) return { ...train, serviceDate };
  return {
    ...train,
    serviceDate,
    arr: train.arr.map((t) => t + offset),
    dep: train.dep.map((t) => t + offset),
  };
}

/**
 * Turn trips into trains. Trips with the same block_id that continue from the
 * station where the previous trip ended become one train.
 */
export function mergeBlocks(trips) {
  const single = [];
  const blocks = new Map();
  for (const t of trips) {
    if (t.blockId) {
      if (!blocks.has(t.blockId)) blocks.set(t.blockId, []);
      blocks.get(t.blockId).push(t);
    } else single.push(t);
  }
  const trains = single.map(trainFromTrip);
  for (const group of blocks.values()) {
    group.sort((a, b) => a.dep[0] - b.dep[0]);
    let current = trainFromTrip(group[0]);
    for (let i = 1; i < group.length; i++) {
      const t = group[i];
      const n = current.stations.length;
      const joins = current.stations[n - 1] === t.stations[0]
        && t.dep[0] >= current.arr[n - 1]
        && t.dep[0] - current.arr[n - 1] <= BLOCK_MAX_GAP;
      if (joins) current = joinTrains(current, t);
      else { trains.push(current); current = trainFromTrip(t); }
    }
    trains.push(current);
  }
  return trains;
}

function trainFromTrip(t) {
  return {
    stations: t.stations, arr: t.arr, dep: t.dep, pickup: t.pickup, dropoff: t.dropoff,
    segments: [{ trip: t, from: 0, to: t.stations.length - 1 }],
  };
}

function joinTrains(a, t) {
  const n = a.stations.length, m = t.stations.length;
  const cat = (A, B, Ctor) => {
    const out = new Ctor(n + m - 1);
    out.set(A, 0);
    out.set(B.subarray(1), n);
    return out;
  };
  const stations = cat(a.stations, t.stations, Int32Array);
  const arr = cat(a.arr, t.arr, Int32Array);
  const dep = cat(a.dep, t.dep, Int32Array);
  const pickup = cat(a.pickup, t.pickup, Uint8Array);
  const dropoff = cat(a.dropoff, t.dropoff, Uint8Array);
  // Joining station: arrive on the first trip, depart on the second.
  dep[n - 1] = t.dep[0];
  pickup[n - 1] = t.pickup[0];
  dropoff[n - 1] = a.dropoff[n - 1];
  return {
    stations, arr, dep, pickup, dropoff,
    segments: [...a.segments, { trip: t, from: n - 1, to: n + m - 2 }],
  };
}
