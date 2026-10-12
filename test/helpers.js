import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Write a GTFS feed from { 'stops.txt': [[header...], [row...]], ... } into a temp dir. */
export function writeFeed(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-gtfs-'));
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), rows.map((r) => r.join(',')).join('\n') + '\n');
  }
  return dir;
}

/**
 * A small line:  A — B — C — D   plus a branch  C — E, and station W a short
 * walk from D. Times are minutes past the hour for readability.
 *
 *  T1  A 08:00 → B 08:20 → C 08:40 → D 09:00          (direct A→D)
 *  T2  C 08:50 → E 09:20                               (1 change at C)
 *  T3a B 10:00 → C 10:20 } same block: one physical train
 *  T3b C 10:25 → E 10:55 }
 *  T4  A 09:00 → B 09:20 (set down only at B) → C 09:40 (pick up only... set down)
 *  T5  W 09:10 → F 09:40                               (reach F via walk D→W)
 *  T6  E 24:30 → A 25:30                               (after midnight)
 */
export function miniFeed() {
  const stops = [['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'zone_id']];
  const coords = {
    A: [51.0, -1.0], B: [51.2, -1.0], C: [51.4, -1.0], D: [51.6, -1.0], E: [51.4, -0.6], W: [51.601, -0.998], F: [51.9, -0.9],
  };
  for (const [id, [lat, lon]] of Object.entries(coords)) stops.push([id, `X${id}${id}`, `Station ${id}`, lat, lon, id]);
  const st = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type']];
  const add = (trip, calls) => calls.forEach(([stop, arr, dep, pu = 0, dr = 0], i) => st.push([trip, arr, dep, stop, i + 1, pu, dr]));
  add('T1', [['A', '08:00:00', '08:00:00'], ['B', '08:20:00', '08:21:00'], ['C', '08:40:00', '08:41:00'], ['D', '09:00:00', '09:00:00']]);
  add('T2', [['C', '08:50:00', '08:50:00'], ['E', '09:20:00', '09:20:00']]);
  add('T3a', [['B', '10:00:00', '10:00:00'], ['C', '10:20:00', '10:20:00']]);
  add('T3b', [['C', '10:25:00', '10:25:00'], ['E', '10:55:00', '10:55:00']]);
  add('T4', [['A', '09:00:00', '09:00:00'], ['B', '09:20:00', '09:20:00', 1, 0], ['C', '09:40:00', '09:40:00']]);
  add('T5', [['W', '09:10:00', '09:10:00'], ['F', '09:40:00', '09:40:00']]);
  add('T6', [['E', '24:30:00', '24:30:00'], ['A', '25:30:00', '25:30:00']]);
  add('T7', [['C', '08:44:00', '08:44:00'], ['E', '09:10:00', '09:10:00']]);
  return writeFeed({
    'agency.txt': [['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], ['OP', 'Test Rail', 'https://example.test', 'Europe/London']],
    'routes.txt': [['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'], ['R1', 'OP', 'R1', 'Main line', '2', 'DC241F']],
    'stops.txt': stops,
    'trips.txt': [
      ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'block_id'],
      ['R1', 'S', 'T1', 'Station D', ''], ['R1', 'S', 'T2', 'Station E', ''],
      ['R1', 'S', 'T3a', 'Station C', 'BLK'], ['R1', 'S', 'T3b', 'Station E', 'BLK'],
      ['R1', 'S', 'T4', 'Station C', ''], ['R1', 'S', 'T5', 'Station F', ''], ['R1', 'S', 'T6', 'Station A', ''],
      ['R1', 'S', 'T7', 'Station E', ''],
    ],
    'stop_times.txt': st,
    'calendar.txt': [
      ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      ['S', 1, 1, 1, 1, 1, 0, 0, '20260101', '20261231'],
    ],
    'calendar_dates.txt': [['service_id', 'date', 'exception_type'], ['S', '20261016', 2]],
    'transfers.txt': [['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time', 'transfer_mode'], ['D', 'W', 2, 300, 'walk']],
    'fare_attributes.txt': [['fare_id', 'price', 'currency_type', 'payment_method', 'transfers'], ['AD', '50.00', 'GBP', 1, ''], ['AB', '10.00', 'GBP', 1, ''], ['BD', '15.00', 'GBP', 1, '']],
    'fare_rules.txt': [['fare_id', 'origin_id', 'destination_id'], ['AD', 'A', 'D'], ['AB', 'A', 'B'], ['BD', 'B', 'D']],
  });
}
