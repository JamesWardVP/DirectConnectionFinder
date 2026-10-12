/* global L */
import { dashFor, rankColor, escapeHtml, changesLabel, KM_PER_MILE } from './util.js';

const GB_CENTER = [54.3, -2.6];
const LINE_WEIGHT = 6;

export class RouteMap {
  constructor(el, { onRouteHover, onRouteClick, onMapClick } = {}) {
    this.map = L.map(el, { zoomSnap: 0.25, zoomControl: true, attributionControl: true, minZoom: 5, maxZoom: 15 })
      .setView(GB_CENTER, 6);
    this.map.attributionControl.setPrefix(false);
    this.map.attributionControl.addAttribution('Coastline: Natural Earth');
    this.callbacks = { onRouteHover, onRouteClick, onMapClick };
    this.landLayer = L.layerGroup().addTo(this.map);
    this.areaLayer = L.layerGroup().addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.stationLayer = L.layerGroup().addTo(this.map);
    this.labelLayer = L.layerGroup().addTo(this.map);
    this.routeShapes = new Map();
    this.selected = null;
    this.street = null;

    this.map.createPane('land').style.zIndex = 250;
    this.map.on('click', (e) => this.callbacks.onMapClick?.(e.latlng));
    this.map.on('zoomend', () => this.placeLabels());
    this.loadCoastline();
  }

  async loadCoastline() {
    try {
      const res = await fetch('/data/coastline.geojson');
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
        L.circleMarker([s.lat, s.lon], {
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
      const hit = route.segments.map((seg) => L.polyline(seg.coords, { color: '#000', opacity: 0, weight: 16 }));
      hit.forEach((h) => group.addLayer(h));
      group.bindTooltip(
        `<strong>${changesLabel(route.changes)}</strong> · ${route.journeyIds.length} train time${route.journeyIds.length > 1 ? 's' : ''}<br>${escapeHtml(route.summary)}`,
        { sticky: true, className: 'route-tip' },
      );
      group.on('mouseover', () => this.callbacks.onRouteHover?.(route.id, true));
      group.on('mouseout', () => this.callbacks.onRouteHover?.(route.id, false));
      group.on('click', (e) => { L.DomEvent.stopPropagation(e); this.callbacks.onRouteClick?.(route.id); });
      group.addTo(this.routeLayer);
      this.routeShapes.set(route.id, { group, lines, route, t });
    }

    // Interchange circles at change stations, labels at key stations.
    this.labelCandidates = [];
    const changeSet = new Set();
    routes.slice(0, 40).forEach((r) => r.changeStations.forEach((s) => changeSet.add(s)));
    for (const idx of changeSet) {
      const s = stations.get(idx);
      if (!s) continue;
      L.circleMarker([s.lat, s.lon], { radius: 7, color: '#111', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false })
        .addTo(this.stationLayer);
      this.label(s, 'minor');
    }
    const endpointSet = new Set(endpoints);
    for (const idx of endpointSet) {
      const s = stations.get(idx);
      if (!s) continue;
      L.circleMarker([s.lat, s.lon], { radius: 9, color: '#111', weight: 4, fillColor: '#fff', fillOpacity: 1, interactive: false })
        .addTo(this.stationLayer);
      this.label(s, 'endpoint');
    }
    this.placeLabels();
  }

  label(s, cls) {
    this.labelCandidates.push({ s, cls, priority: cls === 'endpoint' ? 0 : 1 });
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
      const w = s.name.length * (cls === 'endpoint' ? 8.4 : 7) + 4;
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

  /** Temporarily emphasise a route (hover). */
  highlight(routeId, on) {
    if (this.selected) return;
    const shape = this.routeShapes.get(routeId);
    if (!shape) return;
    if (on) shape.group.bringToFront();
    for (const line of shape.lines) line.setStyle({ weight: on ? LINE_WEIGHT + 3 : LINE_WEIGHT });
  }

  /** Select a route: everything else fades; calling points appear. */
  select(routeId, { fit = true } = {}) {
    this.selected = routeId;
    if (this.callingLayer) this.map.removeLayer(this.callingLayer);
    this.callingLayer = null;
    for (const [id, shape] of this.routeShapes) {
      const active = routeId == null || id === routeId;
      shape.group.eachLayer((l) => {
        if (l.options.opacity === 0) return;
        l.setStyle({ opacity: active ? 1 : 0.12 });
      });
      for (const line of shape.lines) line.setStyle({ weight: id === routeId ? LINE_WEIGHT + 2 : LINE_WEIGHT });
    }
    if (routeId == null) return;
    const shape = this.routeShapes.get(routeId);
    if (!shape) return;
    shape.group.bringToFront();
    this.callingLayer = L.layerGroup();
    for (const seg of shape.route.segments) {
      if (seg.type !== 'train') continue;
      seg.stations.slice(1, -1).forEach((idx) => {
        const s = this.stations.get(idx);
        if (!s) return;
        L.circleMarker([s.lat, s.lon], { radius: 3.5, color: rankColor(seg.color, 0), weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(escapeHtml(s.name), { direction: 'top', offset: [0, -3] })
          .addTo(this.callingLayer);
      });
    }
    this.callingLayer.addTo(this.map);
    if (fit) this.map.fitBounds(shape.group.getBounds(), { padding: [60, 60], maxZoom: 11, animate: false });
  }
}
