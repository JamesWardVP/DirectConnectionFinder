#!/usr/bin/env bash
# Downloads the timetable used to build the site, and reports which source
# was used ("source" and "input" outputs for GitHub Actions).
#
# Sources, in order of preference:
#   1. Network Rail open data (CIF full timetable) when NROD_USERNAME and
#      NROD_PASSWORD are set. Free account: https://publicdatafeeds.networkrail.co.uk
#   2. Any GTFS zip at TIMETABLE_GTFS_URL.
#   3. Otherwise the bundled demo timetable.
set -euo pipefail

DIR="${TIMETABLE_DIR:-timetable}"
mkdir -p "$DIR"

output() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

download() {
  # curl only sends --user credentials to the original host, not to the
  # storage server Network Rail redirects to.
  curl --fail --silent --show-error --location --retry 3 --retry-delay 30 --retry-all-errors \
    --connect-timeout 30 --max-time 1800 "$@"
}

if [ -n "${NROD_USERNAME:-}" ] && [ -n "${NROD_PASSWORD:-}" ]; then
  echo "Downloading the Network Rail CIF timetable..."
  download --user "${NROD_USERNAME}:${NROD_PASSWORD}" -o "$DIR/toc-full.CIF.gz" \
    "https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full.CIF.gz"
  gzip -t "$DIR/toc-full.CIF.gz"
  ls -lh "$DIR/toc-full.CIF.gz"
  output source cif
  output input "$DIR/toc-full.CIF.gz"
elif [ -n "${TIMETABLE_GTFS_URL:-}" ]; then
  echo "Downloading the GTFS timetable..."
  download -o "$DIR/gtfs.zip" "$TIMETABLE_GTFS_URL"
  unzip -tq "$DIR/gtfs.zip" > /dev/null
  ls -lh "$DIR/gtfs.zip"
  output source gtfs
  output input "$DIR/gtfs.zip"
else
  echo "No timetable source configured, so the demo timetable will be used."
  output source demo
  output input ""
fi
