/* global L */
import { dashFor, rankColor, escapeHtml, changesLabel, fmtDuration, opColor, KM_PER_MILE } from './util.js';

const GB_CENTER = [54.3, -2.6];
const LINE_WEIGHT = 6;

export class RouteMap {
  constructor(el, { onRouteHover, onRouteClick, onMapClick, onEmptyClick, onStationAction, onDestinationClick } = {}) {
    this.map = L.map(el, { zoomSnap: 0.25, zoomControl: true, attributionControl: true, minZoom: 5, maxZoom: 15 })
      .setView(GB_CENTER, 6);
    this.map.attributionControl.setPrefix(false);
    this.map.attributionControl.addAttribution('Coastline: Natural Earth');
    this.callbacks = { onRouteHover, onRouteClick, onMapClick, onEmptyClick, onStationAction, onDestinationClick };
    this.exploreLayer = L.layerGroup().addTo(this.map);
    this.landLayer = L.layerGroup().addTo(this.map);
    this.areaLayer = L.layerGroup().addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.stationLayer = L.layerGroup().addTo(this.map);
    this.labelLayer = L.layerGroup().addTo(this.map);
    this.routeShapes = new Map();
    this.selected = null;
    this.street = null;

    this.map.createPane('land').style.zIndex = 250;
    // One tooltip for routes, opened and closed by hand. It closes whenever
    // the pointer is not over a route, so it can never be left behind.
    this.tip = L.tooltip({ className: 'route-tip', direction: 'top', offset: [0, -10], interactive: false });
    this.hovered = null;
    const isRoute = (e) => {
      const cl = e.originalEvent?.target?.classList;
      return cl?.contains('route-hit') || cl?.contains('station-hit');
    };
    this.map.on('mousemove', (e) => { if (!isRoute(e)) this.clearHover(); });
    this.map.getContainer().addEventListener('mouseleave', () => this.clearHover());
    this.map.on('click', (e) => {
      if (isRoute(e)) return;
      this.callbacks.onMapClick?.(e.latlng);
      this.callbacks.onEmptyClick?.();
    });
    this.map.on('zoomend', () => this.placeLabels());
    this.loadCoastline();
  }

  async loadCoastline() {
    try {
      const res = await fetch('data/coastline.geojson');
      const geo = await res.json();
      L.geoJSON(geo, {
        pane: 'land',
        interactive: false,
        style: (f) => ({
          color: f.properties.home ? '#b9c6d2' : '#d3dbe2',
          weight: 1,
          fillColor: f.properties.home ? '#ffffff' : '#f7f7f5',
          fillOpacity: 1,
        }),
      }).addTo(this.landLayer);
    } catch { /* the map still works without the outline */ }
  }

  setStreetMap(on) {
    const container = this.map.getContainer();
    if (on && !this.street) {
      this.street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);
      container.classList.add('street');
    } else if (!on && this.street) {
      this.map.removeLayer(this.street);
      this.street = null;
      container.classList.remove('street');
    }
  }

  /** Draw the search areas: location pins, radius circles and candidate stations. */
  setAreas(sides) {
    this.areaLayer.clearLayers();
    for (const side of sides) {
      if (!side) continue;
      if (side.radiusKm > 0) {
        L.circle([side.lat, side.lon], {
          radius: side.radiusKm * 1000,
          color: '#111', weight: 1.5, dashArray: '4 6', fill: true, fillColor: '#111', fillOpacity: 0.035, interactive: false,
        }).addTo(this.areaLayer);
      }
      if (side.isPoint) {
        L.marker([side.lat, side.lon], {
          icon: L.divIcon({ className: '', html: `<div class="loc-pin">${side.letter}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
          keyboard: false, interactive: false,
        }).addTo(this.areaLayer);
      }
      for (const s of side.stations || []) {
        this.stationMarker(s, {
          radius: 4.5, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1,
        }).bindTooltip(`${escapeHtml(s.name)}${s.distanceKm != null ? ` · ${(s.distanceKm / KM_PER_MILE).toFixed(1)} mi` : ''}`, { direction: 'top', offset: [0, -4] })
          .addTo(this.areaLayer);
      }
    }
  }

  fitAreas(sides) {
    const pts = [];
    for (const side of sides) {
      if (!side) continue;
      pts.push([side.lat, side.lon]);
      if (side.radiusKm > 0) {
        const dLat = side.radiusKm / 111;
        const dLon = side.radiusKm / (111 * Math.cos((side.lat * Math.PI) / 180));
        pts.push([side.lat - dLat, side.lon - dLon], [side.lat + dLat, side.lon + dLon]);
      }
    }
    if (pts.length === 1) this.map.setView(pts[0], 10, { animate: false });
    else if (pts.length > 1) this.map.fitBounds(pts, { padding: [40, 40], maxZoom: 11, animate: false });
  }

  /**
   * routes: [{ id, changes, order, segments:[{type, color, coords, stations}], changeStations }]
   * stations: idx -> {name, lat, lon}
   */
  setRoutes(routes, stations, endpoints) {
    this.clearExplore();
    this.routeLayer.clearLayers();
    this.stationLayer.clearLayers();
    this.labelLayer.clearLayers();
    this.routeShapes.clear();
    this.selected = null;
    this.routes = routes;
    this.stations = stations;
    const n = routes.length;

    // Worst first so the best routes are drawn on top.
    for (const route of [...routes].reverse()) {
      const t = n > 1 ? route.order / (n - 1) : 0;
      const group = L.featureGroup();
      const lines = [];
      for (const seg of route.segments) {
        if (seg.type === 'transfer') {
          group.addLayer(L.polyline(seg.coords, { color: '#111', weight: 9, opacity: 0.9, lineCap: 'round' }));
          group.addLayer(L.polyline(seg.coords, { color: '#fff', weight: 4, opacity: 1, lineCap: 'round' }));
          continue;
        }
        const color = rankColor(seg.color, t);
        group.addLayer(L.polyline(seg.coords, { color: '#fff', weight: LINE_WEIGHT + 5, opacity: 1, lineJoin: 'round', lineCap: 'round' }));
        const line = L.polyline(seg.coords, {
          color, weight: LINE_WEIGHT, opacity: 1, lineJoin: 'round', ...dashFor(route.changes, LINE_WEIGHT),
        });
        line.baseColor = color;
        lines.push(line);
        group.addLayer(line);
      }
      // A wide invisible line makes thin dotted routes easy to hover and click.
      for (const seg of route.segments) {
        group.addLayer(L.polyline(seg.coords, { color: '#000', opacity: 0, weight: 18, className: 'route-hit' }));
      }
      group.on('mousemove', (e) => this.setHover(route, e.latlng));
      group.on('mouseout', () => this.clearHover());
      group.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.clearHover();
        this.callbacks.onRouteClick?.(route.id);
      });
      group.addTo(this.routeLayer);
      this.routeShapes.set(route.id, { group, lines, route, t });
    }

    this.endpoints = endpoints;
    this.drawStations();
  }

  /**
   * Interchange circles at change stations and labels at key stations. With
   * a route selected, only that route's stations are shown, including every
   * calling point.
   */
  drawStations() {
    this.stationLayer.clearLayers();
    this.labelCandidates = [];
    const stations = this.stations;
    const selected = this.selected ? this.routeShapes.get(this.selected)?.route : null;
    const routes = selected ? [selected] : (this.routes || []).slice(0, 40);
    const endpointSet = selected
      ? new Set([selected.segments[0].stations[0], selected.segments.at(-1).stations.at(-1)])
      : new Set(this.endpoints || []);
    const changeSet = new Set();
    routes.forEach((r) => r.changeStations.forEach((s) => changeSet.add(s)));

    if (selected) {
      for (const seg of selected.segments) {
        if (seg.type !== 'train') continue;
        for (const idx of seg.stations.slice(1, -1)) {
          const s = stations.get(idx);
          if (!s || changeSet.has(idx) || endpointSet.has(idx)) continue;
          this.stationMarker(s, { radius: 4, color: rankColor(seg.color, 0), weight: 2.5, fillColor: '#fff', fillOpacity: 1 })
            .addTo(this.stationLayer);
          this.label(s, 'minor', 2);
        }
      }
    }
    for (const idx of changeSet) {
      const s = stations.get(idx);
      if (!s || endpointSet.has(idx)) continue;
      this.stationMarker(s, { radius: 7, color: '#111', weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .addTo(this.stationLayer);
      this.label(s, selected ? 'change' : 'minor', 1);
    }
    for (const idx of endpointSet) {
      const s = stations.get(idx);
      if (!s) continue;
      this.stationMarker(s, { radius: 9, color: '#111', weight: 4, fillColor: '#fff', fillOpacity: 1 })
        .addTo(this.stationLayer);
      this.label(s, 'endpoint', 0);
    }
    this.placeLabels();
  }

  label(s, cls, priority) {
    this.labelCandidates.push({ s, cls, priority });
  }

  /** Place station labels, skipping any that would collide with one already placed. */
  placeLabels() {
    this.labelLayer.clearLayers();
    if (!this.labelCandidates?.length) return;
    const placed = [];
    const overlaps = (b) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    const sorted = [...this.labelCandidates].sort((a, b) => a.priority - b.priority);
    for (const { s, cls } of sorted) {
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      const w = s.name.length * (cls === 'endpoint' ? 8.4 : cls === 'change' ? 7.6 : 7) + 4;
      const h = cls === 'endpoint' ? 18 : 15;
      const right = [pt.x + 10, pt.y - h / 2, pt.x + 12 + w, pt.y + h / 2];
      const left = [pt.x - 12 - w, pt.y - h / 2, pt.x - 10, pt.y + h / 2];
      let direction = null;
      if (!overlaps(right)) { direction = 'right'; placed.push(right); }
      else if (!overlaps(left)) { direction = 'left'; placed.push(left); }
      if (!direction) continue;
      L.tooltip({
        permanent: true, direction, offset: [direction === 'right' ? 10 : -10, 0],
        className: `station-label ${cls}`, interactive: false,
      })
        .setLatLng([s.lat, s.lon])
        .setContent(escapeHtml(s.name))
        .addTo(this.labelLayer);
    }
  }

  fitRoutes() {
    const b = this.routeLayer.getLayers().length ? L.featureGroup(this.routeLayer.getLayers()).getBounds() : null;
    if (b && b.isValid()) this.map.fitBounds(b, { padding: [50, 50], maxZoom: 11, animate: false });
  }

  /**
   * A clickable station circle. Clicking opens a popup offering direct
   * trains from the station, or using it as the start or destination.
   */
  stationMarker(s, style) {
    const m = L.circleMarker([s.lat, s.lon], { ...style, className: 'station-hit' });
    m.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      this.openStationPopup(s);
    });
    return m;
  }

  openStationPopup(s) {
    if (!s.crs && s.idx == null) return;
    const el = document.createElement('div');
    el.className = 'st-pop';
    el.innerHTML = `<strong>${escapeHtml(s.name)}</strong>
      <button type="button" data-a="explore" class="primary">Trains from here</button>
      <div class="st-pop-row"><button type="button" data-a="from">Start here</button><button type="button" data-a="to">End here</button></div>`;
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      this.map.closePopup();
      this.callbacks.onStationAction?.(a, s);
    });
    L.popup({ className: 'station-popup', offset: [0, -6], autoPanPadding: [20, 20] })
      .setLatLng([s.lat, s.lon]).setContent(el).openOn(this.map);
  }

  /** Clear journey routes (used when switching to the destinations view). */
  clearRoutes() {
    this.clearHover();
    this.routeLayer.clearLayers();
    this.stationLayer.clearLayers();
    this.labelLayer.clearLayers();
    this.routeShapes.clear();
    this.routes = [];
    this.labelCandidates = [];
    this.selected = null;
  }

  /**
   * Every station reachable on one train: the path each train takes, and a
   * station circle at each destination, bigger and more saturated the more
   * trains go there.
   */
  setExplore(data) {
    this.clearExplore();
    this.clearRoutes();
    const dests = data.destinations;
    const maxTrains = Math.max(1, ...dests.map((d) => d.trainsPerDay));
    const byIdx = new Map();
    const rank = new Map([...dests].sort((a, b) => b.trainsPerDay - a.trainsPerDay).map((d, i) => [d.idx, i]));
    const n = dests.length;
    // Least-served first so busy lines are drawn on top.
    for (const d of [...dests].sort((a, b) => a.trainsPerDay - b.trainsPerDay)) {
      const t = n > 1 ? rank.get(d.idx) / (n - 1) : 0;
      const color = rankColor(opColor(d.operators[0]), t);
      const coords = d.path.map((p) => [p.lat, p.lon]);
      const line = L.polyline(coords, { color, weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false, ...dashFor(d.changes, 4) });
      const r = 4 + 5 * Math.sqrt(d.trainsPerDay / maxTrains);
      const dot = L.circleMarker([d.lat, d.lon], {
        radius: r, color: '#111', weight: 2.5, fillColor: '#fff', fillOpacity: 1, className: 'station-hit',
      }).bindTooltip(`<strong>${escapeHtml(d.name)}</strong><br>${changesLabel(d.changes)} · ${d.trains === d.trainsPerDay ? d.trains : d.trainsPerDay} ${d.changes ? 'departures' : 'trains'} · fastest ${fmtDuration(d.fastest)}`, { direction: 'top', offset: [0, -r], className: 'route-tip' });
      dot.on('click', (e) => { L.DomEvent.stopPropagation(e); this.callbacks.onDestinationClick?.(d.idx); });
      byIdx.set(d.idx, { d, line, dot, color });
      line.addTo(this.exploreLayer);
    }
    // Dots above every line.
    for (const d of [...dests].sort((a, b) => a.trainsPerDay - b.trainsPerDay)) byIdx.get(d.idx).dot.addTo(this.exploreLayer);
    for (const s of data.from.stations) {
      this.stationMarker(s, { radius: 10, color: '#111', weight: 4, fillColor: '#fff', fillOpacity: 1 }).addTo(this.exploreLayer);
    }
    this.explore = { data, byIdx, selected: null };
    this.labelCandidates = [
      ...data.from.stations.map((s) => ({ s, cls: 'endpoint', priority: 0 })),
      ...[...dests].sort((a, b) => b.trainsPerDay - a.trainsPerDay).map((d, i) => ({ s: d, cls: 'minor', priority: 1 + i })),
    ];
    this.placeLabels();
    const b = L.latLngBounds([...dests.map((d) => [d.lat, d.lon]), ...data.from.stations.map((s) => [s.lat, s.lon])]);
    if (b.isValid()) this.map.fitBounds(b, { padding: [40, 40], maxZoom: 11, animate: false });
  }

  /** Emphasise one destination's line; null shows them all again. */
  selectDestination(idx, { padRight = 0, padBottom = 0 } = {}) {
    if (!this.explore) return;
    this.explore.selected = idx;
    for (const [i, { line, dot }] of this.explore.byIdx) {
      const on = idx == null || i === idx;
      line.setStyle({ opacity: on ? 0.9 : 0.12, weight: i === idx ? 7 : 4 });
      dot.setStyle({ opacity: on ? 1 : 0.25, fillOpacity: on ? 1 : 0.25 });
    }
    if (idx == null) return;
    const { d, line } = this.explore.byIdx.get(idx);
    line.bringToFront();
    const b = L.latLngBounds([...d.path.map((p) => [p.lat, p.lon])]);
    this.map.fitBounds(b, { paddingTopLeft: [40, 40], paddingBottomRight: [40 + padRight, 40 + padBottom], maxZoom: 11, animate: false });
  }

  clearExplore() {
    this.exploreLayer.clearLayers();
    this.explore = null;
  }

  setHover(route, latlng) {
    if (this.hovered !== route.id) {
      this.clearHover();
      this.hovered = route.id;
      this.tip.setContent(`<strong>${changesLabel(route.changes)}</strong> · ${route.journeyIds.length} train time${route.journeyIds.length > 1 ? 's' : ''}<br>${escapeHtml(route.summary)}<br><span class="tip-hint">Click to see this route</span>`);
      this.highlight(route.id, true);
      this.callbacks.onRouteHover?.(route.id, true);
    }
    this.tip.setLatLng(latlng);
    if (!this.map.hasLayer(this.tip)) this.tip.addTo(this.map);
  }

  clearHover() {
    if (this.map.hasLayer(this.tip)) this.map.removeLayer(this.tip);
    if (this.hovered == null) return;
    const id = this.hovered;
    this.hovered = null;
    this.highlight(id, false);
    this.callbacks.onRouteHover?.(id, false);
  }

  /** Emphasise a route while hovered (here or in the list). Never reorders the DOM. */
  highlight(routeId, on) {
    if (this.selected) return;
    const shape = this.routeShapes.get(routeId);
    if (!shape) return;
    for (const line of shape.lines) line.setStyle({ weight: on ? LINE_WEIGHT + 3 : LINE_WEIGHT });
  }

  /**
   * Select a route: every other route is hidden and its stations are
   * labelled. routeId null shows all routes again.
   */
  select(routeId, { fit = true, padRight = 0, padBottom = 0 } = {}) {
    if (routeId != null && !this.routeShapes.has(routeId)) routeId = null;
    this.clearHover();
    this.selected = routeId;
    for (const [id, shape] of this.routeShapes) {
      const show = routeId == null || id === routeId;
      if (show && !this.routeLayer.hasLayer(shape.group)) this.routeLayer.addLayer(shape.group);
      if (!show && this.routeLayer.hasLayer(shape.group)) this.routeLayer.removeLayer(shape.group);
      for (const line of shape.lines) line.setStyle({ weight: id === routeId ? LINE_WEIGHT + 2 : LINE_WEIGHT });
    }
    if (routeId == null) {
      // Put the routes back in rank order (best on top).
      for (const r of [...(this.routes || [])].reverse()) this.routeShapes.get(r.id)?.group.bringToFront();
    }
    this.drawStations();
    if (routeId != null && fit) {
      this.map.fitBounds(this.routeShapes.get(routeId).group.getBounds(), {
        paddingTopLeft: [40, 40], paddingBottomRight: [40 + padRight, 40 + padBottom], maxZoom: 11, animate: false,
      });
    }
  }
}
