# CLAUDE.md

Notes for Claude Code (and people) working on this repository. Read README.md for what the site does; this file is about how to work on it.

## What this is

Direct Connection Finder: a static website (GitHub Pages) that finds every train between two places in Great Britain. Direct trains come first, then 1, 2, 3 changes. Results are drawn on a Tube-style map. Journey planning runs in the browser (a Web Worker) over a packed timetable file; there is no server.

- Live site: https://jameswardvp.github.io/DirectConnectionFinder/
- Repository: https://github.com/JamesWardVP/DirectConnectionFinder
- The owner merges pull requests themselves. Work on a branch, push it, open a PR, and let them merge. Don't push to `main`.

## Run it locally

Needs Node 20+ (CI uses 22) and Python 3 (only to serve files; any static server works).

```bash
npm ci                     # install (leaflet, adm-zip)
npm test                   # unit tests (node --test), ~1 s
npm run build              # build dist/ with the demo timetable (synthetic times)
npm run check              # real-search smoke test over dist/ (most checks need a real timetable)
npm run serve              # http://localhost:8000 serves dist/
```

`npm run build` uses the bundled **demo** timetable unless told otherwise. For the **real** national timetable you need the Network Rail open data account (the same one as the `NROD_USERNAME`/`NROD_PASSWORD` GitHub secrets):

```bash
# .env (git-ignored):  NROD_USERNAME=...  NROD_PASSWORD=...
set -a; source .env; set +a
bash scripts/fetch-timetable.sh                      # -> timetable/toc-full.CIF.gz (~100 MB)
NODE_OPTIONS=--max-old-space-size=6144 \
  node scripts/build-site.js --source cif --input timetable/toc-full.CIF.gz --days 28
npm run check                                        # same checks CI runs before deploying
npm run serve
```

Browser test of a running site (what CI's `test-live` job does after each deploy):

```bash
npm install --no-save playwright@1.56.1 && npx playwright install chromium
node scripts/test-live.mjs http://localhost:8000/
```

Against a demo build, a few of its checks fail by design: "real timetable (no demo banner)", and anything needing the internet (postcode lookup, map tiles), if offline.

## Layout

| Path | What |
| --- | --- |
| `lib/cif.js` | Build time: Network Rail CIF importer (STP rules C < N < O < P, passenger filter, activities, VV/JJ associations, midnight handling). |
| `lib/gtfs.js` | Build time: GTFS importer (also the demo timetable). |
| `lib/interchange.js` + `data/interchange.csv` | Per-station change times: curated for big stations, the rest from how busy the station is. |
| `data/links.csv` | Curated walk/Tube links between nearby stations (cross-London etc.). |
| `data/operators.json`, `data/stations.json` | Operator names/colours; station list with CRS codes and coordinates. |
| `scripts/build-site.js` | Builds `dist/` (copies `public/`, Leaflet, writes `dist/data/timetable.json`). |
| `scripts/check-site.js` | Runs well-known searches over a built timetable; **fails the build (so nothing deploys)** if they look wrong. |
| `scripts/test-live.mjs` | Playwright test of the deployed site. |
| `scripts/fetch-timetable.sh` | Downloads CIF (or GTFS from `TIMETABLE_GTFS_URL`), else falls back to demo. |
| `public/js/core/bundle.js` | Packs/unpacks the timetable (shared calling patterns, day bitmasks). |
| `public/js/core/timetable.js` | Per-day index; merges block/association trips into one physical train. |
| `public/js/core/router.js` | Range-RAPTOR (`searchDay`), per-change-station alternatives (`oneChangeRoutes`). `searchDay` with `destinations: null` + `onIteration` reports every station (used by "From a station"). |
| `public/js/core/search.js` | Journey search: locations/radius, date modes, ranking, fares, links. |
| `public/js/core/destinations.js` | "From a station": direct destinations, or everywhere reachable with up to 3 changes. |
| `public/js/core/fares.js`, `links.js` | Split-ticket fare DP / estimates; National Rail and operator links. |
| `public/js/engine.worker.js`, `engine.js` | Web Worker that runs searches; keeps "From a station" departure lists and sends them per station on demand. |
| `public/js/app.js`, `results.js`, `explore.js`, `map.js`, `geocode.js`, `util.js` | UI (plain ES modules + Leaflet, no framework, no bundler). |
| `test/*.test.js`, `test/helpers.js` | Unit tests on a tiny hand-made GTFS feed (`miniFeed()`), CIF fixtures, and the demo build. |
| `.github/workflows/pages.yml` | Build → check → deploy → live test. |

## How changes ship

1. Branch from `main`, make the change, run `npm test` (and `npm run build && npm run check`).
2. For UI changes, build the demo site, serve it, and drive it with Playwright (see above) — check for console errors.
3. Push the branch. To test against the **real** timetable before merging, run the workflow on the branch: Actions → Build and deploy → Run workflow → pick the branch. Branch runs build and run `check-site` only; they never deploy.
4. Open a PR; the owner merges. The merge to `main` builds, deploys and runs `test-live`.
5. The workflow also runs on a schedule (04:23 and 15:47 UTC) to pick up the new timetable.

## Things that have bitten us

- **Checks against real data must not assume a particular day's service.** Weekend engineering works removed every direct Kings Cross–Edinburgh train, and a seasonal Wakefield–Oxford service disappeared; both made CI fail although the site was right. `test-live` searches the next **Wednesday**; `check-site` uses the first Wednesday in the window; a check that depends on a specific service should first confirm that service runs (see the Wakefield → Beaconsfield check).
- **CIF times:** use public times consistently, and only treat a time going backwards as crossing midnight when it jumps back more than 6 hours (pick-up-only stops publish a departure a minute before the working arrival). Getting this wrong made sleepers take 35–59 hours.
- **Direct = one physical train**: GTFS `block_id` and CIF VV/JJ associations are merged into one train in `timetable.js`; split tickets on one train are still direct.
- **Walking links never chain** (walk → walk) and never start from an origin; `relaxFootpaths` only walks from train arrivals. A chained walk once crashed searches ("reading 'arr'").
- **"From a station" with changes** can reach ~2,500 stations: the worker keeps departure lists and the page fetches one station's list when picked; lines are drawn on a Leaflet canvas. Keep messages to the page small.
- Change times: `feed.minChange` per station (bundle) + `DEFAULT_CHANGE` 5; the UI can force a fixed time everywhere (`fixedChange`).
- Leaflet tooltips/`bringToFront` on hover caused sticky tooltips; the map uses a manual tooltip.

## Style

- Plain modern JavaScript (ES modules), no TypeScript, no framework, no bundler. Two-space indent, single quotes, semicolons.
- Comments explain *why*, briefly. Match the surrounding code.
- UI text and docs: UK English, plain words (the site is for train travellers, not developers).
- Commit messages: a short summary line, then what and why.
