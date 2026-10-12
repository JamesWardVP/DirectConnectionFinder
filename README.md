# Direct Connection Finder

Find every train between two places in Great Britain. Direct trains are listed first, then journeys with one change, two changes and so on. Everything is drawn on a white map in the style of the London Underground.

- **Radius search.** Pick a station, town, postcode or a point on the map, then widen the radius to include every station nearby. You can see at a glance whether another station is a better place to start or finish.
- **Ranked list.** Results are ordered by number of trains, then by journey time (or by departure or arrival time).
- **Split tickets count as direct.** If you stay on the same physical train, the journey is direct even when two or more tickets are cheaper. The fare engine finds those splits and shows the saving. Trains that run as several timetable trips but are one physical train (GTFS `block_id`) are also treated as direct.
- **Map with meaning.**
  - The line style shows the number of changes: solid for direct, dashed for 1 change, dotted for 2 changes, dash-dot for 3.
  - Line colour comes from the train operator. Saturation shows rank: the best options are vivid, worse ones fade towards grey.
  - Walking and Underground links are drawn as Tube-style interchange connectors.
- **Journey details.** Click a journey for:
  - a Tube-style line diagram with every calling point
  - the operator, and the fare with a per-ticket breakdown
  - links to check and buy: a National Rail journey-planner link for the trip, one link per ticket when split, and the operator's website
- **Flexible time search.**
  - *On a date*: leave after or arrive by a time, within a window.
  - *Any date*: a time of day, checked over the next 7 days. Trains that run at the same time on several days are grouped, for example "Mon–Fri".
  - *Days of week*: pick weekdays and search the whole day, over 1 to 4 weeks.
- **Shareable searches.** The URL holds the search, so you can bookmark or send it.

## Running it

```bash
npm install
npm start            # http://localhost:3000
npm test
```

Node 20 or newer is required. Set `PORT` to change the port.

## Timetable data

### Demo timetable (default)

`data/demo-gtfs/` is a **synthetic** timetable so the site works straight away:

- about 49 routes and 216 stations
- real station codes, operators and route patterns
- times are generated from distance and typical speeds
- fares are illustrative, with a few pairs set up to show split ticketing

It also includes cross-London Underground links, an overnight sleeper with pick-up-only and set-down-only stops, and a train that runs as two linked trips. **Do not use it to plan real travel.** Regenerate it with `npm run build:demo`.

### Real timetables

Point the server at any GTFS feed, as a directory or a `.zip`:

```bash
DCF_GTFS=/path/to/gb-rail-gtfs.zip npm start
```

For Great Britain, the official timetable is published by the Rail Delivery Group as a CIF file through the [Rail Data Marketplace](https://raildata.org.uk/) (free registration). Tools such as [`dtd2mysql`](https://github.com/planarnetwork/dtd2mysql) convert it to GTFS. The loader:

- collapses platforms onto their parent station
- reads CRS codes from `stop_code` or `stop_id`, falling back to a name match against `data/stations.json`
- uses `pickup_type`/`drop_off_type`, `block_id`, `calendar_dates.txt` and `transfers.txt`

Inter-station links in `transfers.txt` can carry an extra `transfer_mode` column (`walk`, `tube`, `tram` or `bus`) to label the connection.

A full national timetable has millions of `stop_times` rows. Give Node more memory if needed: `NODE_OPTIONS=--max-old-space-size=4096`.

### Fares

Published fares are read from GTFS fares v1: `fare_attributes.txt` and `fare_rules.txt`, using `origin_id`/`destination_id` zones. To make every station its own fare zone, set each stop's `zone_id` to its CRS code. Split tickets are only suggested from published fares. When a journey has no published fare it gets a clearly labelled distance-based **estimate**.

Real GB fares are published by the Rail Delivery Group in a separate fares feed. Converting it to `fare_rules` gives real prices and real split-ticket savings.

### Places and postcodes

Place and postcode searches go through the server to [postcodes.io](https://postcodes.io) and [Nominatim](https://nominatim.org) (OpenStreetMap). Results are cached. Set `DCF_USER_AGENT` to identify your deployment, as Nominatim's usage policy requires. Station names always work offline.

## How it works

| File | Role |
| --- | --- |
| `server/gtfs.js` | Streams a GTFS feed into compact typed arrays. |
| `server/timetable.js` | Builds a per-day index and merges same-block trips into single trains. Each day covers trains still running from the night before and early trains the next day. |
| `server/router.js` | Range-RAPTOR search. Round *k* holds the best arrival using exactly *k* trains, so slower routes with more changes are still found. Changes that gain nothing and routes that double back are pruned. Results a train with fewer changes beats are flagged, and hidden by default in the UI. |
| `server/fares.js` | Dynamic programme over every station the journey calls at, to find the cheapest set of tickets (split ticketing). |
| `server/search.js` | Resolves locations and radii to stations and expands the date modes. Ranks, groups, prices and links journeys, and builds the distinct map routes. |
| `public/` | Static frontend: plain ES modules and Leaflet, no build step. |

The coastline backdrop is simplified from [Natural Earth](https://www.naturalearthdata.com/) (public domain) by `scripts/build-outline.js`. The station list in `data/stations.json` comes from [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) (ODbL), which is derived from Trainline EU's [stations](https://github.com/trainline-eu/stations) dataset.

## API

- `GET /api/meta`: details of the loaded feed
- `GET /api/stations?q=york`: station autocomplete
- `GET /api/nearby?lat=&lon=&radiusKm=`: stations within a radius
- `GET /api/geocode?q=`: place and postcode lookup
- `POST /api/search`, with a body like:

```json
{
  "from": { "type": "station", "crs": "KGX" },
  "to": { "type": "point", "lat": 55.95, "lon": -3.19, "label": "Edinburgh" },
  "fromRadiusKm": 0, "toRadiusKm": 15,
  "mode": "date", "date": "2026-10-14", "time": "08:00", "timeType": "depart", "windowMins": 120,
  "maxChanges": 2, "minChange": 5, "sort": "duration"
}
```

For `mode: "time"`, omit `date`. For `mode: "days"`, pass `days` (0 = Monday) and `weeks` instead of a date and time.
