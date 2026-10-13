# Direct Connection Finder

Find every train between two places in Great Britain. Direct trains are listed first, then journeys with one change, two changes and so on. Everything is drawn on a white map in the style of the London Underground.

It is a static website that runs on **GitHub Pages**. A GitHub Action downloads the national timetable every night, packs it into one compressed data file and redeploys the site. Journey planning happens in your browser, so there is no server to run.

- **Radius search.** Pick a station, town, postcode or a point on the map, then widen the radius to include every station nearby. You can see at a glance whether another station is a better place to start or finish.
- **Ranked list.** Results are ordered by number of trains, then by journey time (or by departure or arrival time).
- **Split tickets count as direct.** If you stay on the same physical train, the journey is direct even when two or more tickets are cheaper. The fare engine finds those splits and shows the saving. Trains that run as several timetable trips but are one physical train are also treated as direct. That covers GTFS `block_id`, and trains that divide or join (CIF associations) when you stay in your seat.
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
- **From a station.** Switch to "From a station", or click any station on the map, to see every station you can reach. Choose *Direct* for stations without changing trains, or *+1*, *+2* or *+3 changes* to see everywhere reachable with that many changes. Results are grouped by the fewest changes needed. Each station shows departures per day, the fastest time (and where it changes), the first and last departure, and the operators. On the map, lines are dashed by changes, and bigger, more saturated circles mean more trains. From any destination you can plan the full journey (fares and tickets) or explore onward from there. With changes, up to a week of dates is searched.
- **Shareable searches.** The URL holds the search, so you can bookmark or send it.

## Publishing on GitHub Pages

1. **Turn on Pages.** In the repository, open **Settings → Pages**. Under *Build and deployment*, set **Source** to **GitHub Actions**. (Pages on a private repository needs a paid GitHub plan.)
2. **Give the Action a timetable source.** Without one, it publishes the demo timetable. Go to **Settings → Secrets and variables → Actions** and set one of these:

   | Name | Kind | What it is |
   | --- | --- | --- |
   | `NROD_USERNAME`, `NROD_PASSWORD` | Secrets | A free [Network Rail open data](https://publicdatafeeds.networkrail.co.uk/) account. In the account settings, subscribe to the **SCHEDULE** feed for all train operators. The Action then downloads the full national timetable (CIF) every night. |
   | `TIMETABLE_GTFS_URL` | Variable | Alternatively, the URL of any GTFS zip. |
   | `TIMETABLE_DAYS` | Variable | Optional. How many days ahead to include (default 28). |

3. **Run it.** Push to `main`, or open **Actions → Build and deploy → Run workflow**. After that it runs every night at 04:23 UTC (05:23 UK time in summer), after Network Rail publishes the day's timetable, and again at 15:47 UTC as a backstop, because GitHub can delay or skip scheduled runs when it is busy. Runs started on other branches only build and check the timetable; only `main` deploys.

The site will be at `https://<user>.github.io/<repository>/`. The line under the *Find trains* button shows which timetable is loaded, when it was built, and which dates it covers.

The workflow is `.github/workflows/pages.yml`:

1. Run the tests.
2. `scripts/fetch-timetable.sh` downloads the timetable.
3. `scripts/build-site.js` writes the site and `data/timetable.json` into `dist/`.
4. Deploy `dist/` to Pages.

If a download or build fails, the previous deployment stays live.

## Timetable data

### Demo timetable (default)

`data/demo-gtfs/` is a **synthetic** timetable, published when no real source is configured:

- about 49 routes and 216 stations
- real station codes, operators and route patterns
- times are generated from distance and typical speeds
- fares are illustrative, with a few pairs set up to show split ticketing

**Do not use it to plan real travel.** Regenerate it with `npm run build:demo`.

### Network Rail CIF (recommended for real times)

`lib/cif.js` imports the national timetable in CIF format. It applies:

- **Passenger trains only:** train status P or 1, categories O* and X*. Buses, ships and freight are left out.
- **Short-term planning rules:** for each train and day, cancellations beat new schedules and overlays, which beat permanent schedules.
- **Real calls only:** pick-up-only and set-down-only stops are respected, using public times.
- **Divides and joins** (`VV` and `JJ` associations): staying in your seat counts as a direct journey, and the journey shows a reminder to sit in the right part of the train.
- **Interchange links:** curated links between nearby stations come from `data/links.csv`, for example across London by Underground. Operator names and colours come from `data/operators.json`.

Known gaps:

- **Bank holidays:** the "does not run on bank holidays" flag is ignored, because the extract has no bank-holiday calendar.
- **Change times:** each station has its own usual time to change trains. Big stations are listed in `data/interchange.csv` (for example 15 minutes at the London termini and 10 at Birmingham New Street). Every other station gets a time from how busy it is: 7 minutes at the busiest 3%, 5 at the next busiest, and 4 at small stations. These times are estimates, and you can edit the CSV. Under *More options* you can use one fixed change time everywhere instead.

### GTFS

Any GTFS feed works. The loader:

- collapses platforms onto their parent station
- reads CRS codes from `stop_code` or `stop_id`, falling back to a name match against `data/stations.json`
- uses `pickup_type`/`drop_off_type`, `block_id`, `calendar_dates.txt` and `transfers.txt`

Inter-station links in `transfers.txt` can carry an extra `transfer_mode` column (`walk`, `tube`, `tram` or `bus`). The curated links in `data/links.csv` are added where the feed has none.

### Fares

Published fares are read from GTFS fares v1: `fare_attributes.txt` and `fare_rules.txt`, using `origin_id`/`destination_id` zones. To make every station its own fare zone, set each stop's `zone_id` to its CRS code. Split tickets are only suggested from published fares.

Network Rail's timetable has no fares, so with it every price is a clearly labelled distance-based **estimate**. Real GB fares are published by the Rail Delivery Group in a separate fares feed, through the [Rail Data Marketplace](https://raildata.org.uk/). Converting it to GTFS fare rules gives real prices and real split-ticket savings.

### Places and postcodes

The browser looks up postcodes with [postcodes.io](https://postcodes.io) and places with [Nominatim](https://nominatim.org) (OpenStreetMap). Lookups are cached and spaced out to respect Nominatim's usage policy. Station names always work, because they come from the timetable.

## How it works

| File | Role |
| --- | --- |
| `lib/gtfs.js`, `lib/cif.js` | Build time: import a GTFS feed or a CIF timetable. |
| `public/js/core/bundle.js` | Packs a timetable into `timetable.json`. Trips that share a calling pattern share its stations and running times, and each trip's running days are a bitmask over the date window. The browser unpacks it. A national timetable comes to roughly 20 MB, or about 2 MB gzipped as GitHub Pages serves it. |
| `public/js/core/timetable.js` | Builds a per-day index and merges same-block trips into single trains. Each day covers trains still running from the night before and early trains the next day. |
| `public/js/core/router.js` | Range-RAPTOR search. Round *k* holds the best arrival using exactly *k* trains, so slower routes with more changes are still found. Changes that gain nothing and routes that double back are pruned. A second pass (`oneChangeRoutes`) finds the best journeys through *each* change station. That way a route like Wakefield → Oxford → Beaconsfield is listed even when going via London is a bit quicker, as long as it takes at most 1.5× the fastest journey plus 30 minutes. Results a train with fewer changes beats are flagged. They are shown by default and can be hidden with a tick box. |
| `public/js/core/fares.js` | Dynamic programme over every station the journey calls at, to find the cheapest set of tickets (split ticketing). |
| `public/js/core/search.js` | Resolves locations and radii to stations and expands the date modes. Ranks, groups, prices and links journeys, and builds the distinct map routes. |
| `public/js/engine.worker.js` | Runs the planner in a Web Worker so the page stays responsive. |
| `public/js/*.js`, `public/css/` | The interface: plain ES modules and Leaflet. |

A "Days of week" search with a wide radius covers whole days and can take several seconds on a full national timetable.

The coastline backdrop is simplified from [Natural Earth](https://www.naturalearthdata.com/) (public domain) by `scripts/build-outline.js`. The station list in `data/stations.json` comes from [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) (ODbL), which is derived from Trainline EU's [stations](https://github.com/trainline-eu/stations) dataset.
