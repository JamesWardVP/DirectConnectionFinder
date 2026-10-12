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
const KIND_TRAIN = 1, KIND_WALK = 2;

/**
 * @param {object} day        from Timetable.day()
 * @param {object} feed       loaded GTFS feed (stations, transfers, minChange)
 * @param {object} q
 * @param {number[]} q.origins       station indexes
 * @param {number[]} q.destinations  station indexes
 * @param {number} q.depFrom         earliest departure (minutes on the day clock)
 * @param {number} q.depTo           latest departure
 * @param {number} [q.maxTrains=3]
 * @param {number} [q.minChange=5]   default minutes to change trains at a station
 * @param {number} [q.maxWait=120]   longest wait for a connection
 * @returns {Array<{origin:number, destination:number, legs:object[]}>}
 */
export function searchDay(day, feed, q) {
  const maxTrains = Math.max(1, Math.min(q.maxTrains ?? 3, 6));
  const minChange = q.minChange ?? 5;
  const maxWait = q.maxWait ?? 120;
  const n = feed.stations.length;
  const destSet = new Set(q.destinations);
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
          const ready = L.arr[k - 1][s] + (arrivedBy === KIND_WALK ? 0 : (feed.minChange.get(s) ?? minChange));
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

function relaxFootpaths(footpaths, k, L, marked, updates, originSet) {
  const reachedByTrain = [...marked].filter((s) => L.kind[k][s] === KIND_TRAIN);
  for (const s of reachedByTrain) {
    for (const fp of footpaths.get(s) || []) {
      if (originSet.has(fp.to)) continue;
      const t = L.arr[k][s] + fp.minutes;
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
