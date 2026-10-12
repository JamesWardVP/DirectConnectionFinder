// Fare calculation, including split ticketing.
//
// Published fares come from the feed (GTFS fare_rules origin/destination
// zones). A dynamic programme over every station the journey calls at finds
// the cheapest set of tickets, which is how "split saves" are found: you
// stay on the same train but hold two or more tickets. Splits are only
// suggested from published fares; when none are available the whole journey
// gets a clearly-labelled distance-based estimate.

const MAX_TICKETS = 4;

export function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rough UK standard-class single estimate from route distance (km). */
export function estimateFare(km) {
  const tiers = [[50, 0.3], [150, 0.18], [Infinity, 0.1]];
  let remaining = km, price = 3;
  for (const [span, rate] of tiers) {
    const part = Math.min(remaining, span);
    price += part * rate;
    remaining -= part;
    if (remaining <= 0) break;
  }
  return Math.round(price * 10) / 10;
}

function publishedFare(feed, a, b) {
  const za = feed.zoneByStation[a], zb = feed.zoneByStation[b];
  if (!za || !zb) return null;
  return feed.fares.get(`${za}|${zb}`) || null;
}

/**
 * @param {object} feed
 * @param {Array<{station:number, walkFromPrev?:boolean}>} points every station visited, in order
 * @returns {{ total:number, currency:string, source:'published'|'estimate', tickets:Array, split:boolean, through:number|null, saving:number }}
 */
export function priceJourney(feed, points) {
  const st = feed.stations;
  const n = points.length;
  let km = 0;
  for (let i = 1; i < n; i++) km += haversineKm(st[points[i - 1].station], st[points[i].station]);

  const first = points[0].station, last = points[n - 1].station;
  const through = publishedFare(feed, first, last);

  // cost[j][t] = cheapest way to reach point j using t tickets.
  const cost = Array.from({ length: n }, () => new Array(MAX_TICKETS + 1).fill(Infinity));
  const back = Array.from({ length: n }, () => new Array(MAX_TICKETS + 1).fill(null));
  cost[0][0] = 0;
  for (let j = 1; j < n; j++) {
    for (let t = 0; t <= MAX_TICKETS; t++) {
      // A walking link between stations needs no ticket of its own.
      if (points[j].walkFromPrev && cost[j - 1][t] < cost[j][t]) {
        cost[j][t] = cost[j - 1][t];
        back[j][t] = { i: j - 1, walk: true };
      }
    }
    for (let i = 0; i < j; i++) {
      if (points[i].station === points[j].station) continue;
      const fare = publishedFare(feed, points[i].station, points[j].station);
      if (!fare) continue;
      for (let t = 1; t <= MAX_TICKETS; t++) {
        const c = cost[i][t - 1] + fare.price;
        if (c < cost[j][t] - 1e-9) {
          cost[j][t] = c;
          back[j][t] = { i, fare };
        }
      }
    }
  }

  let bestT = -1;
  for (let t = 1; t <= MAX_TICKETS; t++) {
    if (cost[n - 1][t] < Infinity && (bestT < 0 || cost[n - 1][t] < cost[n - 1][bestT] - 1e-9)) bestT = t;
  }

  if (bestT < 0) {
    const price = estimateFare(km);
    return {
      total: price, currency: 'GBP', source: 'estimate',
      tickets: [{ from: first, to: last, price, source: 'estimate' }],
      split: false, through: null, saving: 0, distanceKm: Math.round(km),
    };
  }

  const tickets = [];
  let j = n - 1, t = bestT;
  while (j > 0) {
    const b = back[j][t];
    if (b.walk) { j = b.i; continue; }
    tickets.push({ from: points[b.i].station, to: points[j].station, price: b.fare.price, currency: b.fare.currency, source: 'published' });
    j = b.i; t--;
  }
  tickets.reverse();
  const total = Math.round(cost[n - 1][bestT] * 100) / 100;
  return {
    total,
    currency: tickets[0].currency || 'GBP',
    source: 'published',
    tickets,
    split: tickets.length > 1,
    through: through ? through.price : null,
    saving: through ? Math.max(0, Math.round((through.price - total) * 100) / 100) : 0,
    distanceKm: Math.round(km),
  };
}
