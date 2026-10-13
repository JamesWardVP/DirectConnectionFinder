// Range-RAPTOR journey search over one day's trains.
//
// For each origin station, departures inside the window are processed from
// latest to earliest while arrival labels persist between iterations. Round
// k holds the best arrival using exactly k trains, and a journey is reported
// only when it beats every later departure with the same number of trains.
// Rounds are deliberately not pruned against each other, so slower routes
// with more changes are still found (the caller flags those a more direct
// train beats). Changes that gain nothing (leaving a train for another that
// reaches the next stop no sooner) are never generated.

const INF = 0x3fffffff;
const NONE = -1;
export const KIND_TRAIN = 1;
const KIND_WALK = 2;

/**
 * @param {object} day        from Timetable.day()
 * @param {object} feed       loaded GTFS feed (stations, transfers, minChange)
 * @param {object} q
 * @param {number[]} q.origins       station indexes
 * @param {number[]|null} q.destinations  station indexes; null for every station,
 *        reported through q.onIteration({ L, updates, origin, tau, reconstruct })
 * @param {number} q.depFrom         earliest departure (minutes on the day clock)
 * @param {number} q.depTo           latest departure
 * @param {number} [q.maxTrains=3]
 * @param {number} [q.minChange=5]   minutes to change trains where the station has no usual time
 * @param {number} [q.fixedChange]   use this change time everywhere instead of each station's own
 * @param {number} [q.maxWait=120]   longest wait for a connection
 * @returns {Array<{origin:number, destination:number, legs:object[]}>}
 */
export function searchDay(day, feed, q) {
  const maxTrains = Math.max(1, Math.min(q.maxTrains ?? 3, 6));
  const minChange = q.minChange ?? 5;
  const changeAt = (s) => q.fixedChange ?? feed.minChange.get(s) ?? minChange;
  const maxWait = q.maxWait ?? 120;
  const n = feed.stations.length;
  const destSet = new Set(q.destinations || []);
  const originSet = new Set(q.origins);
  const footpaths = buildFootpaths(feed);
  const results = [];

  for (const origin of q.origins) {
    if (destSet.has(origin)) continue;
    const L = createLabels(maxTrains, n);
    const deps = day.departures[origin];
    const lo = lowerBound(deps.time, q.depFrom);
    const hi = lowerBound(deps.time, q.depTo + 1);
    // Group departure entries by time, process latest first.
    let i = hi - 1;
    while (i >= lo) {
      const tau = deps.time[i];
      const boardings = [];
      while (i >= lo && deps.time[i] === tau) { boardings.push(i); i--; }
      const updates = [];
      let marked = new Set();

      // Round 1: board each train leaving the origin at tau.
      for (const di of boardings) {
        rideTrain(day.trains[deps.train[di]], deps.train[di], deps.pos[di], origin, 1, L, marked, updates, originSet, destSet);
      }
      relaxFootpaths(footpaths, 1, L, marked, updates, originSet);

      for (let k = 2; k <= maxTrains && marked.size; k++) {
        const next = new Set();
        for (const s of marked) {
          if (destSet.has(s)) continue; // no need to travel beyond a destination
          const arrivedBy = L.kind[k - 1][s];
          const ready = L.arr[k - 1][s] + (arrivedBy === KIND_WALK ? 0 : changeAt(s));
          const prevTrain = arrivedBy === KIND_TRAIN ? L.train[k - 1][s] : NONE;
          const stayOn = prevTrain === NONE ? null : onwardArrivals(day.trains[prevTrain], L.alight[k - 1][s]);
          const travelled = pathStations(L, day, k - 1, s);
          const sd = day.departures[s];
          const seenPatterns = new Set();
          for (let j = lowerBound(sd.time, ready); j < sd.time.length && sd.time[j] <= ready + maxWait; j++) {
            const ti = sd.train[j];
            if (ti === prevTrain) continue;
            const train = day.trains[ti];
            if (seenPatterns.has(train.pattern)) continue;
            seenPatterns.add(train.pattern);
            rideTrain(train, ti, sd.pos[j], s, k, L, next, updates, originSet, destSet, stayOn, travelled);
          }
        }
        relaxFootpaths(footpaths, k, L, next, updates, originSet);
        marked = next;
      }

      // Everywhere reachable ("From a station"): let the caller read the labels.
      if (q.onIteration) {
        q.onIteration({ L, updates, origin, tau, reconstruct: (k, s) => reconstruct(L, day, k, s) });
        continue;
      }
      // Report destinations improved during this iteration.
      const reported = new Set();
      for (const [k, s] of updates) {
        if (!destSet.has(s) || L.kind[k][s] !== KIND_TRAIN) continue;
        const key = k * n + s;
        if (reported.has(key)) continue;
        reported.add(key);
        results.push({ origin, destination: s, legs: reconstruct(L, day, k, s) });
      }
    }
  }
  return results;
}

function createLabels(K, n) {
  const mk = (fill, Ctor = Int32Array) => Array.from({ length: K + 1 }, () => new Ctor(n).fill(fill));
  return {
    K,
    arr: mk(INF),
    kind: mk(0, Uint8Array),
    train: mk(NONE),
    board: mk(NONE),
    alight: mk(NONE),
    from: mk(NONE),
    walk: mk(NONE),
  };
}

const improves = (L, k, s, t) => t < L.arr[k][s];

/** Where the train we just left would have taken us, and when. */
function onwardArrivals(train, fromPos) {
  const m = new Map();
  for (let q = fromPos + 1; q < train.stations.length; q++) {
    if (train.dropoff[q] && !m.has(train.stations[q])) m.set(train.stations[q], train.arr[q]);
  }
  return m;
}

/** Every station passed on the way to station s in round k. */
function pathStations(L, day, k, s) {
  const out = new Set([s]);
  let cur = s;
  while (k > 0) {
    if (L.kind[k][cur] === KIND_WALK) {
      cur = L.from[k][cur];
      out.add(cur);
      continue;
    }
    const train = day.trains[L.train[k][cur]];
    for (let q = L.board[k][cur]; q <= L.alight[k][cur]; q++) out.add(train.stations[q]);
    cur = L.from[k][cur];
    k--;
  }
  return out;
}

function rideTrain(train, ti, boardPos, fromStation, k, L, marked, updates, originSet, destSet, stayOn = null, travelled = null) {
  let passedDestination = false;
  for (let q = boardPos + 1; q < train.stations.length; q++) {
    const s = train.stations[q];
    // Going back over ground already covered is never a sensible route.
    if (travelled && travelled.has(s)) break;
    // Once past a destination, only other destinations are worth labelling.
    if (passedDestination && !destSet.has(s)) continue;
    if (destSet.has(s) && train.dropoff[q]) passedDestination = true;
    if (originSet.has(s)) {
      // After a change, coming back through a starting station is pointless:
      // boarding there would have been better. The first train may pass other
      // starting stations (they are just not destinations of the first leg).
      if (k > 1) break;
      continue;
    }
    if (!train.dropoff[q]) continue;
    const t = train.arr[q];
    // Staying on the previous train would have got here no later.
    if (stayOn && stayOn.has(s) && stayOn.get(s) <= t) continue;
    if (!improves(L, k, s, t)) continue;
    L.arr[k][s] = t;
    L.kind[k][s] = KIND_TRAIN;
    L.train[k][s] = ti;
    L.board[k][s] = boardPos;
    L.alight[k][s] = q;
    L.from[k][s] = fromStation;
    marked.add(s);
    updates.push([k, s]);
  }
}

/**
 * Walking links from stations reached by train in round k. Walks start only
 * from train arrivals (snapshotted first) and never replace a train arrival
 * from the same round, so a walk can never be chained onto another walk.
 */
function relaxFootpaths(footpaths, k, L, marked, updates, originSet) {
  const reachedByTrain = new Map();
  for (const s of marked) if (L.kind[k][s] === KIND_TRAIN) reachedByTrain.set(s, L.arr[k][s]);
  for (const [s, arrived] of reachedByTrain) {
    for (const fp of footpaths.get(s) || []) {
      if (originSet.has(fp.to) || reachedByTrain.has(fp.to)) continue;
      const t = arrived + fp.minutes;
      if (!improves(L, k, fp.to, t)) continue;
      L.arr[k][fp.to] = t;
      L.kind[k][fp.to] = KIND_WALK;
      L.from[k][fp.to] = s;
      L.walk[k][fp.to] = fp.index;
      marked.add(fp.to);
      updates.push([k, fp.to]);
    }
  }
}

function reconstruct(L, day, k, s) {
  const legs = [];
  let cur = s;
  while (k > 0) {
    if (L.kind[k][cur] === KIND_WALK) {
      const from = L.from[k][cur];
      legs.push({ type: 'transfer', from, to: cur, transferIndex: L.walk[k][cur], arrive: L.arr[k][cur] });
      cur = from;
    } else {
      const ti = L.train[k][cur];
      legs.push({
        type: 'train',
        trainIndex: ti,
        train: day.trains[ti],
        boardPos: L.board[k][cur],
        alightPos: L.alight[k][cur],
      });
      cur = L.from[k][cur];
      k--;
    }
  }
  legs.reverse();
  // Fill in walk start times now that the preceding train is known.
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.type === 'transfer') {
      const prev = legs[i - 1];
      leg.depart = prev.train.arr[prev.alightPos];
    }
  }
  return legs;
}

const footpathCache = new WeakMap();
function buildFootpaths(feed) {
  if (footpathCache.has(feed)) return footpathCache.get(feed);
  const map = new Map();
  feed.transfers.forEach((t, index) => {
    if (!map.has(t.from)) map.set(t.from, []);
    map.get(t.from).push({ to: t.to, minutes: t.minutes, index });
  });
  footpathCache.set(feed, map);
  return map;
}

export function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Every sensible one-change route, best per change station.
 *
 * RAPTOR keeps only the fastest way to reach each station, so a route through
 * a different change station that gets in a little later (say Wakefield →
 * Oxford → Beaconsfield, when going via London is quicker) is dropped. This
 * looks at each change station separately and keeps the journeys through it
 * that no other journey through the same station beats.
 *
 * Takes the same query as searchDay and returns results in the same shape.
 */
export function oneChangeRoutes(day, feed, q) {
  const minChange = q.minChange ?? 5;
  const changeAt = (s) => q.fixedChange ?? feed.minChange.get(s) ?? minChange;
  const maxWait = q.maxWait ?? 120;
  const destSet = new Set(q.destinations);
  const originSet = new Set(q.origins);
  const footpaths = buildFootpaths(feed);

  // Where each train that reaches a destination can be boarded, by station.
  const feeders = new Map();
  day.trains.forEach((train, ti) => {
    let lastDest = -1;
    for (let p = 0; p < train.stations.length; p++) if (train.dropoff[p] && destSet.has(train.stations[p])) lastDest = p;
    for (let p = 0; p < lastDest; p++) {
      const s = train.stations[p];
      if (!train.pickup[p] || destSet.has(s) || originSet.has(s)) continue;
      if (!feeders.has(s)) feeders.set(s, []);
      feeders.get(s).push({ dep: train.dep[p], ti, pos: p });
    }
  });
  for (const list of feeders.values()) list.sort((a, b) => a.dep - b.dep);

  const results = [];
  for (const origin of q.origins) {
    if (destSet.has(origin)) continue;
    const best = new Map(); // change station|destination → candidates
    const deps = day.departures[origin];
    for (let i = lowerBound(deps.time, q.depFrom); i < deps.time.length && deps.time[i] <= q.depTo; i++) {
      const t1 = deps.train[i], train1 = day.trains[t1], p0 = deps.pos[i];
      // A train that reaches a destination itself needs no change before it.
      let firstDest = train1.stations.length;
      for (let p = p0 + 1; p < train1.stations.length; p++) {
        if (train1.dropoff[p] && destSet.has(train1.stations[p])) { firstDest = p; break; }
      }
      const directArr = firstDest < train1.stations.length ? train1.arr[firstDest] : Infinity;
      const travelled = new Set([train1.stations[p0]]);
      for (let q1 = p0 + 1; q1 < firstDest; q1++) {
        const x = train1.stations[q1];
        travelled.add(x);
        if (!train1.dropoff[q1] || originSet.has(x)) continue;
        const arrX = train1.arr[q1];
        const onward = onwardArrivals(train1, q1);
        const tryFrom = (y, ready, walk) => {
          const list = feeders.get(y);
          if (!list) return;
          for (let j = lowerBoundBy(list, ready); j < list.length && list[j].dep <= ready + maxWait; j++) {
            const { ti: t2, pos: pb } = list[j];
            if (t2 === t1) continue;
            const train2 = day.trains[t2];
            for (let p = pb + 1; p < train2.stations.length; p++) {
              const s = train2.stations[p];
              // Going back over ground already covered is never sensible.
              if (travelled.has(s) || originSet.has(s)) break;
              // Pointless if you could stay on the first train and change later.
              if (!walk && onward.has(s) && train2.pickup[p] && onward.get(s) + changeAt(s) <= train2.dep[p]) break;
              if (!destSet.has(s) || !train2.dropoff[p]) continue;
              const arr = train2.arr[p];
              if (arr >= directArr) break;
              const key = `${y}|${s}`;
              if (!best.has(key)) best.set(key, []);
              best.get(key).push({ dep: train1.dep[p0], arr, t1, p0, q1, x, walk, t2, pb, p, dest: s });
            }
          }
        };
        tryFrom(x, arrX + changeAt(x), null);
        for (const fp of footpaths.get(x) || []) {
          if (originSet.has(fp.to) || travelled.has(fp.to)) continue;
          tryFrom(fp.to, arrX + fp.minutes, fp);
        }
      }
    }
    // Through each change station, keep the journeys nothing else beats there.
    // (Latest departure first; keep each that arrives before all later ones.)
    for (const list of best.values()) {
      list.sort((a, b) => b.dep - a.dep || a.arr - b.arr);
      let earliest = Infinity;
      for (const c of list) {
        if (c.arr >= earliest) continue;
        earliest = c.arr;
        const legs = [{ type: 'train', trainIndex: c.t1, train: day.trains[c.t1], boardPos: c.p0, alightPos: c.q1 }];
        if (c.walk) {
          legs.push({ type: 'transfer', from: c.x, to: c.walk.to, transferIndex: c.walk.index, depart: day.trains[c.t1].arr[c.q1], arrive: day.trains[c.t1].arr[c.q1] + c.walk.minutes });
        }
        legs.push({ type: 'train', trainIndex: c.t2, train: day.trains[c.t2], boardPos: c.pb, alightPos: c.p });
        results.push({ origin, destination: c.dest, legs });
      }
    }
  }
  return results;
}

function lowerBoundBy(list, value) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].dep < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}
