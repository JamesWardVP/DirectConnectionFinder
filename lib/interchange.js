// Time allowed to change trains at each station. Curated times for big
// stations come from data/interchange.csv; every other station gets a time
// based on how many trains call there, since busier stations are bigger.
import fs from 'node:fs';

// Share of stations (by number of calls, busiest first) in each size band.
export const BANDS = [
  { share: 0.03, minutes: 7 },  // big hubs
  { share: 0.25, minutes: 5 },  // town stations
  { share: 1, minutes: 4 },     // small stations
];

export function readInterchange(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('crs,'))
    .map((l) => { const [crs, minutes] = l.split(','); return [crs.trim(), Number(minutes)]; });
}

/**
 * Fill feed.minChange for every served station that the feed itself has no
 * time for. Returns counts for the build log.
 */
export function applyChangeTimes(feed, curated) {
  const calls = new Map();
  for (const t of feed.trips) for (const s of t.stations) calls.set(s, (calls.get(s) || 0) + 1);
  const byBusiness = [...calls.keys()].sort((a, b) => calls.get(b) - calls.get(a));
  const counts = { feed: feed.minChange.size, curated: 0, estimated: 0 };
  const fromFeed = new Set(feed.minChange.keys());

  for (const [crs, minutes] of curated) {
    const s = feed.stationIndexByCrs.get(crs);
    if (s === undefined || fromFeed.has(s) || !(minutes > 0)) continue;
    feed.minChange.set(s, minutes);
    counts.curated++;
  }
  byBusiness.forEach((s, rank) => {
    if (feed.minChange.has(s)) return;
    const band = BANDS.find((b) => rank < Math.ceil(b.share * byBusiness.length));
    feed.minChange.set(s, band.minutes);
    counts.estimated++;
  });
  return counts;
}
