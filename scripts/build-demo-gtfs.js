// Generates the bundled DEMO timetable in GTFS format (data/demo-gtfs/).
//
// The demo network uses real station codes, real operators and real route
// patterns, but the timings are synthesised from distance and typical
// average speeds and the fares are illustrative. It exists so the site
// works out of the box; point DCF_GTFS at a real GTFS feed for real data.
//
// Usage: node scripts/build-demo-gtfs.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'demo-gtfs');
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8'));
const byCrs = new Map(stations.map((s) => [s.crsCode, s]));

const AGENCIES = {
  GR: ['LNER', 'https://www.lner.co.uk', 'CE0E2D'],
  VT: ['Avanti West Coast', 'https://www.avantiwestcoast.co.uk', '00687A'],
  GW: ['Great Western Railway', 'https://www.gwr.com', '0A493E'],
  EM: ['East Midlands Railway', 'https://www.eastmidlandsrailway.co.uk', '713563'],
  XC: ['CrossCountry', 'https://www.crosscountrytrains.co.uk', '9B1B30'],
  TP: ['TransPennine Express', 'https://www.tpexpress.co.uk', '0096D6'],
  NT: ['Northern', 'https://www.northernrailway.co.uk', '262262'],
  SR: ['ScotRail', 'https://www.scotrail.co.uk', '1E467D'],
  SN: ['Southern', 'https://www.southernrailway.com', '7DBA3C'],
  TL: ['Thameslink', 'https://www.thameslinkrailway.com', 'E9438B'],
  SW: ['South Western Railway', 'https://www.southwesternrailway.com', '3F5AA8'],
  LE: ['Greater Anglia', 'https://www.greateranglia.co.uk', 'D70428'],
  GN: ['Great Northern', 'https://www.greatnorthernrail.com', '6B2C91'],
  CH: ['Chiltern Railways', 'https://www.chilternrailways.co.uk', '00A1E0'],
  LM: ['West Midlands Railway', 'https://www.westmidlandsrailway.co.uk', 'E87722'],
  AW: ['Transport for Wales', 'https://tfw.wales', 'E3002B'],
  CC: ['c2c', 'https://www.c2c-online.co.uk', 'B7007C'],
  SE: ['Southeastern', 'https://www.southeasternrailway.co.uk', '00AFE8'],
  HT: ['Hull Trains', 'https://www.hulltrains.co.uk', '2E3B8F'],
  LD: ['Lumo', 'https://www.lumo.co.uk', '1F45FC'],
  CS: ['Caledonian Sleeper', 'https://www.sleeper.scot', '1D2D44'],
};

// Average speed between stops (km/h) and dwell time (min) by service type.
const PROFILE = {
  intercity: { speed: 128, dwell: 2 },
  regional: { speed: 95, dwell: 1 },
  local: { speed: 62, dwell: 1 },
  sleeper: { speed: 88, dwell: 4 },
};

const WK = 'WK', SA = 'SA', SU = 'SU';
const svc = (first, last, every, days = [WK, SA]) => ({ first, last, every, days });
const std = (every, sundayEvery = every * 2) => [
  svc('06:00', '21:30', every, [WK]),
  svc('07:00', '21:30', every, [SA]),
  svc('09:00', '21:00', sundayEvery, [SU]),
];

// Stop suffixes: ":u" = pick up only, ":d" = set down only.
// splitAt: run as two GTFS trips sharing a block_id (same physical train).
const ROUTES = [
  { id: 'GR-EDB', agency: 'GR', name: 'London Kings Cross – Edinburgh', type: 'intercity', stops: 'KGX PBO YRK DAR NCL ALM BWK EDB', service: std(60) },
  { id: 'GR-EDB-S', agency: 'GR', name: 'London Kings Cross – Edinburgh (stopping)', type: 'intercity', stops: 'KGX SVG PBO GRA NNG DON YRK DAR DHM NCL MPT EDB', service: [svc('07:30', '17:30', 120, [WK, SA]), svc('10:30', '16:30', 180, [SU])] },
  { id: 'GR-LDS', agency: 'GR', name: 'London Kings Cross – Leeds', type: 'intercity', stops: 'KGX SVG PBO GRA NNG DON WKF LDS', service: std(30, 60) },
  { id: 'HT-HUL', agency: 'HT', name: 'London Kings Cross – Hull', type: 'intercity', stops: 'KGX GRA RET DON SBY HOW BUH HUL', service: [svc('07:48', '19:48', 180, [WK, SA]), svc('10:48', '18:48', 240, [SU])] },
  { id: 'LD-EDB', agency: 'LD', name: 'London Kings Cross – Edinburgh (Lumo)', type: 'intercity', stops: 'KGX SVG NNG YRK NCL MPT EDB', service: [svc('06:20', '18:20', 180, [WK, SA, SU])] },
  { id: 'VT-MAN', agency: 'VT', name: 'London Euston – Manchester', type: 'intercity', stops: 'EUS MKC SOT MAC SPT MAN', service: std(30, 60) },
  { id: 'VT-BHM', agency: 'VT', name: 'London Euston – Birmingham', type: 'intercity', stops: 'EUS MKC RUG COV BHI BHM', service: std(30, 60) },
  { id: 'VT-GLC', agency: 'VT', name: 'London Euston – Glasgow', type: 'intercity', stops: 'EUS WFJ MKC CRE WBQ PRE LAN OXN PNR CAR GLC', service: std(60, 120) },
  { id: 'VT-LIV', agency: 'VT', name: 'London Euston – Liverpool', type: 'intercity', stops: 'EUS MKC STA CRE RUN LIV', service: std(60, 120) },
  { id: 'VT-HHD', agency: 'VT', name: 'London Euston – Holyhead', type: 'intercity', stops: 'EUS MKC CRE CTR FLN PRT RHL LLJ BNG HHD', service: [svc('07:10', '19:10', 120, [WK, SA]), svc('10:10', '18:10', 240, [SU])] },
  { id: 'GW-BRI', agency: 'GW', name: 'London Paddington – Bristol', type: 'intercity', stops: 'PAD RDG DID SWI CPM BTH BRI', service: std(30, 60) },
  { id: 'GW-SWA', agency: 'GW', name: 'London Paddington – Swansea', type: 'intercity', stops: 'PAD RDG DID SWI BPW NWP CDF BGN PTA NTH SWA', service: std(60) },
  { id: 'GW-PNZ', agency: 'GW', name: 'London Paddington – Penzance', type: 'intercity', stops: 'PAD RDG TAU EXD NTA TOT PLY LSK BOD PAR SAU TRU RED SER PNZ', service: [svc('06:04', '18:04', 120, [WK, SA]), svc('09:04', '17:04', 240, [SU])] },
  { id: 'GW-OXF', agency: 'GW', name: 'London Paddington – Oxford', type: 'regional', stops: 'PAD RDG DID OXF', service: std(30, 60) },
  { id: 'EM-SHF', agency: 'EM', name: 'London St Pancras – Sheffield', type: 'intercity', stops: 'STP LTN KET MHR LEI LBO DBY CHD SHF', service: std(30, 60) },
  { id: 'EM-NOT', agency: 'EM', name: 'London St Pancras – Nottingham', type: 'intercity', stops: 'STP LTN BDM WEL KET MHR LEI EMD NOT', service: std(30, 60) },
  { id: 'XC-NE', agency: 'XC', name: 'Plymouth – Edinburgh', type: 'intercity', stops: 'PLY NTA EXD TAU BRI CNM BHM BUT DBY SHF WKF LDS YRK DAR DHM NCL EDB', service: std(60, 120) },
  { id: 'XC-SC', agency: 'XC', name: 'Manchester – Bournemouth', type: 'intercity', stops: 'MAN SPT MAC SOT WVH BHM LMS BAN OXF RDG BSK WIN SOA SOU BMH', service: std(60, 120) },
  { id: 'TP-NCL', agency: 'TP', name: 'Liverpool – Newcastle', type: 'intercity', stops: 'LIV WAC MCV HUD DEW LDS YRK THI NTR DAR DHM NCL', service: std(60) },
  { id: 'TP-SCA', agency: 'TP', name: 'Manchester Airport – Scarborough', type: 'intercity', stops: 'MIA MAN MCO HUD LDS YRK SCA', service: std(60) },
  { id: 'TP-CLE', agency: 'TP', name: 'Manchester Airport – Cleethorpes', type: 'regional', stops: 'MIA MAN SPT SHF MHS DON SCU GMB CLE', service: std(60, 120) },
  { id: 'TP-EDB', agency: 'TP', name: 'Manchester Airport – Edinburgh', type: 'intercity', stops: 'MIA MAN PRE LAN OXN PNR CAR HYM EDB', service: std(120) },
  { id: 'NT-CAL', agency: 'NT', name: 'Leeds – Manchester Victoria (Calder Valley)', type: 'local', stops: 'LDS NPD BDI HFX HBD TOD RCD MCV', service: std(30, 60) },
  { id: 'NT-SHF', agency: 'NT', name: 'Sheffield – Leeds', type: 'local', stops: 'SHF MHS BNY WKK LDS', service: std(30, 60) },
  { id: 'NT-HPV', agency: 'NT', name: 'Manchester – Sheffield (Hope Valley)', type: 'local', stops: 'MAN SPT NMC EDL HOP DOR SHF', service: std(60) },
  { id: 'NT-HUL', agency: 'NT', name: 'Leeds – Hull', type: 'regional', stops: 'LDS SBY HOW BUH HUL', service: std(60) },
  { id: 'SR-GLQ', agency: 'SR', name: 'Edinburgh – Glasgow Queen Street', type: 'regional', stops: 'EDB HYM LIN FKK CRO GLQ', service: std(15, 30) },
  { id: 'SR-ABD', agency: 'SR', name: 'Edinburgh – Aberdeen', type: 'intercity', stops: 'EDB HYM INK KDY LEU DEE ARB MTS STN ABD', service: std(60, 120) },
  { id: 'SR-INV', agency: 'SR', name: 'Glasgow Queen Street – Inverness', type: 'intercity', stops: 'GLQ STG PTH DKD PIT AVM INV', service: std(120, 240) },
  { id: 'SR-PTH', agency: 'SR', name: 'Edinburgh – Perth', type: 'regional', stops: 'EDB HYM INK KDY PTH', service: std(120) },
  { id: 'SN-BTN', agency: 'SN', name: 'London Victoria – Brighton', type: 'regional', stops: 'VIC CLJ ECR GTW TBD HHE BTN', service: std(30) },
  { id: 'TL-BTN', agency: 'TL', name: 'Bedford – Brighton', type: 'regional', stops: 'BDM LUT LTN SAC STP ZFD CTK LBG ECR GTW TBD HHE BTN', service: std(30, 60) },
  { id: 'TL-CBG', agency: 'TL', name: 'Cambridge – London Bridge', type: 'regional', stops: 'CBG RYS LET HIT SVG FPK STP ZFD CTK LBG', service: std(30, 60) },
  { id: 'SW-WEY', agency: 'SW', name: 'London Waterloo – Weymouth', type: 'intercity', stops: 'WAT CLJ WOK BSK WIN SOA SOU BCU BMH WEY', service: std(30, 60) },
  { id: 'SW-EXD', agency: 'SW', name: 'London Waterloo – Exeter', type: 'intercity', stops: 'WAT CLJ WOK BSK ADV SAL GIL YVJ HON EXD', service: std(60, 120) },
  { id: 'LE-NRW', agency: 'LE', name: 'London Liverpool Street – Norwich', type: 'intercity', stops: 'LST SRA SNF CHM COL MNG IPS DIS NRW', service: std(30, 60) },
  { id: 'LE-CBG', agency: 'LE', name: 'London Liverpool Street – Cambridge', type: 'regional', stops: 'LST TOM HWN BIS AUD CBG', service: std(30, 60) },
  { id: 'GN-KLN', agency: 'GN', name: 'London Kings Cross – Kings Lynn', type: 'regional', stops: 'KGX FPK SVG HIT LET RYS CBG ELY KLN', service: std(60) },
  { id: 'CH-BMO', agency: 'CH', name: 'London Marylebone – Birmingham Moor Street', type: 'intercity', stops: 'MYB HWY BCS BAN LMS WRW SOL BMO', service: std(60) },
  { id: 'CH-OXF', agency: 'CH', name: 'London Marylebone – Oxford', type: 'regional', stops: 'MYB HWY BIT OXP OXF', service: std(30, 60) },
  { id: 'LM-LIV', agency: 'LM', name: 'Birmingham – Liverpool', type: 'regional', stops: 'BHM WVH STA CRE RUN LIV', service: std(60) },
  { id: 'AW-MAN', agency: 'AW', name: 'Cardiff – Manchester', type: 'intercity', stops: 'CDF NWP AGV HFD LEO SHR CRE MAN', service: std(60, 120), splitAt: 'SHR' },
  { id: 'AW-HHD', agency: 'AW', name: 'Cardiff – Holyhead', type: 'intercity', stops: 'CDF NWP AGV HFD SHR CTR FLN RHL LLJ BNG HHD', service: [svc('06:20', '16:20', 120, [WK, SA]), svc('10:20', '14:20', 240, [SU])] },
  { id: 'CC-SOC', agency: 'CC', name: 'London Fenchurch Street – Southend', type: 'local', stops: 'FST LHS UPM BEF LES SOC', service: std(15, 30) },
  { id: 'SE-DVP', agency: 'SE', name: 'London St Pancras – Dover (High Speed)', type: 'intercity', stops: 'STP SFA EBD AFK FKC DVP', service: std(60) },
  { id: 'SE-CBW', agency: 'SE', name: 'London St Pancras – Canterbury West (High Speed)', type: 'intercity', stops: 'STP SFA EBD AFK CBW', service: std(60) },
  { id: 'SE-HGS', agency: 'SE', name: 'London Charing Cross – Hastings', type: 'regional', stops: 'CHX WAE LBG SEV TON TBW HGS', service: std(30, 60) },
  {
    id: 'CS-INV', agency: 'CS', name: 'Caledonian Sleeper London – Inverness', type: 'sleeper',
    stops: 'EUS:u WFJ:u CRE:u PRE:u DKD:d PIT:d AVM:d INV:d',
    service: [svc('21:15', '21:15', 60, [WK, SU])], oneWay: true,
  },
  {
    id: 'CS-EUS', agency: 'CS', name: 'Caledonian Sleeper Inverness – London', type: 'sleeper',
    stops: 'INV:u AVM:u PIT:u DKD:u PRE:d CRE:d WFJ:d EUS:d',
    service: [svc('20:45', '20:45', 60, [WK, SU])], oneWay: true,
  },
];

// Cross-London (and other city) interchange links: [from, to, minutes, mode].
const LINKS = [
  ['KGX', 'STP', 6, 'walk'], ['KGX', 'EUS', 12, 'walk'], ['STP', 'EUS', 12, 'walk'],
  ['KGX', 'PAD', 26, 'tube'], ['EUS', 'PAD', 24, 'tube'], ['STP', 'PAD', 27, 'tube'],
  ['KGX', 'LST', 20, 'tube'], ['STP', 'LST', 20, 'tube'], ['EUS', 'LST', 24, 'tube'],
  ['KGX', 'WAT', 25, 'tube'], ['EUS', 'WAT', 20, 'tube'], ['STP', 'WAT', 25, 'tube'],
  ['KGX', 'VIC', 20, 'tube'], ['EUS', 'VIC', 18, 'tube'], ['STP', 'VIC', 20, 'tube'],
  ['KGX', 'MYB', 18, 'tube'], ['EUS', 'MYB', 15, 'tube'], ['PAD', 'MYB', 14, 'tube'],
  ['PAD', 'WAT', 25, 'tube'], ['PAD', 'VIC', 25, 'tube'], ['PAD', 'LST', 22, 'tube'],
  ['WAT', 'VIC', 16, 'tube'], ['WAT', 'LST', 22, 'tube'], ['WAT', 'LBG', 12, 'tube'],
  ['WAT', 'WAE', 5, 'walk'], ['CHX', 'WAT', 12, 'walk'], ['LST', 'FST', 8, 'walk'],
  ['FST', 'LBG', 15, 'walk'], ['LST', 'LBG', 16, 'tube'], ['VIC', 'LST', 22, 'tube'],
  ['MAN', 'MCV', 15, 'tram'], ['MAN', 'MCO', 8, 'walk'], ['MCO', 'MCV', 15, 'walk'],
  ['GLC', 'GLQ', 10, 'walk'], ['BHM', 'BMO', 8, 'walk'],
];

// Illustrative published fares (GBP, single, either direction). Chosen so a
// few pairs demonstrate split ticketing; everything else is estimated.
const FARES = [
  ['KGX', 'EDB', 189.0], ['KGX', 'YRK', 89.5], ['YRK', 'EDB', 79.0], ['KGX', 'NCL', 162.0], ['NCL', 'EDB', 38.4],
  ['KGX', 'LDS', 115.6], ['KGX', 'DON', 99.0], ['DON', 'LDS', 14.2],
  ['EUS', 'MAN', 201.0], ['EUS', 'SOT', 118.0], ['SOT', 'MAN', 22.8], ['EUS', 'MKC', 50.4],
  ['EUS', 'BHM', 98.4], ['EUS', 'COV', 72.0], ['COV', 'BHM', 7.9],
  ['PAD', 'BRI', 113.8], ['PAD', 'SWI', 76.4], ['SWI', 'BRI', 25.2], ['PAD', 'RDG', 27.8], ['RDG', 'BRI', 72.1],
  ['STP', 'SHF', 145.0], ['STP', 'LEI', 89.0], ['LEI', 'SHF', 44.9],
  ['EDB', 'GLQ', 15.3], ['MAN', 'LDS', 32.8], ['LDS', 'YRK', 16.1], ['MAN', 'YRK', 42.0],
];

// ---------------------------------------------------------------------------

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.long - a.long) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
};

function parseStops(spec) {
  return spec.split(/\s+/).map((tok) => {
    const [crs, flag] = tok.split(':');
    if (!byCrs.has(crs)) throw new Error(`Unknown CRS code ${crs}`);
    return { crs, pickup: flag !== 'd', dropoff: flag !== 'u' };
  });
}

// Running time in minutes between consecutive stops.
function runTimes(stops, profile) {
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    const km = haversineKm(byCrs.get(stops[i - 1].crs), byCrs.get(stops[i].crs)) * 1.18;
    out.push(Math.max(3, Math.round((km / profile.speed) * 60 + 2)));
  }
  return out;
}

const csv = (rows) => rows.map((r) => r.map((v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

const files = {
  agency: [['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang']],
  stops: [['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'zone_id', 'location_type']],
  routes: [['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color']],
  trips: [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'block_id']],
  stop_times: [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type']],
  calendar: [['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']],
  calendar_dates: [['service_id', 'date', 'exception_type']],
  transfers: [['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time', 'transfer_mode']],
  fare_attributes: [['fare_id', 'price', 'currency_type', 'payment_method', 'transfers']],
  fare_rules: [['fare_id', 'origin_id', 'destination_id']],
  feed_info: [['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version']],
};

const START = '20260101', END = '20271231';
files.calendar.push(
  [WK, 1, 1, 1, 1, 1, 0, 0, START, END],
  [SA, 0, 0, 0, 0, 0, 1, 0, START, END],
  [SU, 0, 0, 0, 0, 0, 0, 1, START, END],
);
for (const day of ['20261225', '20271225']) {
  for (const s of [WK, SA, SU]) files.calendar_dates.push([s, day, 2]);
}
files.feed_info.push(['Direct Connection Finder DEMO timetable (synthetic times)', 'https://github.com/JamesWardVP/DirectConnectionFinder', 'en', START, END, 'demo-1']);

for (const [id, [name, url]] of Object.entries(AGENCIES)) {
  files.agency.push([id, name, url, 'Europe/London', 'en']);
}

const usedStops = new Set();
let tripCount = 0;

for (const route of ROUTES) {
  const profile = PROFILE[route.type];
  const color = AGENCIES[route.agency][2];
  files.routes.push([route.id, route.agency, route.agency, route.name, 2, color, 'FFFFFF']);
  const base = parseStops(route.stops);
  const directions = route.oneWay ? [base] : [base, [...base].reverse()];

  directions.forEach((stops, dir) => {
    const runs = runTimes(stops, profile);
    for (const s of stops) usedStops.add(s.crs);
    for (const band of route.service) {
      // Offset reverse workings slightly so they don't mirror exactly.
      const offset = dir === 1 ? 7 : 0;
      for (let t = toMin(band.first) + offset; t <= toMin(band.last) + offset; t += band.every) {
        for (const day of band.days) {
          const tripBase = `${route.id}-${dir}-${day}-${fmt(t).slice(0, 5).replace(':', '')}`;
          // Build the list of (stop, arr, dep).
          const calls = [];
          let clock = t;
          stops.forEach((s, i) => {
            if (i > 0) clock += runs[i - 1];
            const isEnd = i === 0 || i === stops.length - 1;
            const arr = clock;
            const dep = isEnd ? clock : clock + profile.dwell;
            calls.push({ ...s, arr, dep });
            clock = dep;
          });
          const splitIdx = route.splitAt ? calls.findIndex((c) => c.crs === route.splitAt) : -1;
          const parts = splitIdx > 0 ? [calls.slice(0, splitIdx + 1), calls.slice(splitIdx)] : [calls];
          parts.forEach((part, pi) => {
            const tripId = parts.length > 1 ? `${tripBase}-p${pi + 1}` : tripBase;
            const headsign = byCrs.get(calls[calls.length - 1].crs).stationName;
            files.trips.push([route.id, day, tripId, headsign, dir, parts.length > 1 ? tripBase : '']);
            part.forEach((c, i) => {
              const first = i === 0, last = i === part.length - 1;
              files.stop_times.push([
                tripId, fmt(c.arr), fmt(first || !last ? c.dep : c.arr), c.crs, i + 1,
                last || !c.pickup ? 1 : 0,
                first || !c.dropoff ? 1 : 0,
              ]);
            });
            tripCount++;
          });
        }
      }
    }
  });
}

for (const crs of [...usedStops].sort()) {
  const s = byCrs.get(crs);
  files.stops.push([crs, crs, s.stationName, s.lat, s.long, crs, 0]);
}

for (const [a, b, mins, mode] of LINKS) {
  files.transfers.push([a, b, 2, mins * 60, mode], [b, a, 2, mins * 60, mode]);
}

FARES.forEach(([a, b, price], i) => {
  const id = `F${i + 1}`;
  files.fare_attributes.push([id, price.toFixed(2), 'GBP', 1, '']);
  files.fare_rules.push([id, a, b], [id, b, a]);
});

fs.mkdirSync(OUT, { recursive: true });
for (const [name, rows] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, `${name}.txt`), csv(rows));
}
console.log(`Demo GTFS written to ${path.relative(ROOT, OUT)}: ${usedStops.size} stations, ${ROUTES.length} routes, ${tripCount} trips`);
