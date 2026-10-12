// Main-thread side of the planner: talks to the worker, and answers quick
// station lookups (autocomplete, nearby) from the station list directly.
import { haversineKm } from './core/fares.js';

export class Engine {
  constructor(bundleUrl) {
    this.worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
    };
    this.ready = this.call('load', { url: new URL(bundleUrl, document.baseURI).href }).then((r) => {
      this.meta = r.meta;
      this.stations = r.stations.sort((a, b) => a.name.localeCompare(b.name));
      return r.meta;
    });
  }

  call(type, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async search(body, today) {
    await this.ready;
    return this.call('search', { body, today });
  }

  async findStations(query) {
    await this.ready;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const s of this.stations) {
      const name = s.name.toLowerCase();
      let score = -1;
      if (s.crs && s.crs.toLowerCase() === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.split(/[\s(-]+/).some((w) => w.startsWith(q))) score = 2;
      else if (name.includes(q)) score = 3;
      if (score >= 0) scored.push([score, s]);
    }
    // Best match first; among equal matches, the busiest station first
    // (so "Edinburgh" suggests Edinburgh Waverley before Edinburgh Gateway).
    scored.sort((a, b) => a[0] - b[0] || (b[1].calls || 0) - (a[1].calls || 0) || a[1].name.localeCompare(b[1].name));
    return scored.slice(0, 12).map(([, s]) => s);
  }

  async nearby(lat, lon, radiusKm) {
    await this.ready;
    return this.stations
      .map((s) => ({ ...s, distanceKm: haversineKm({ lat, lon }, s) }))
      .filter((s) => s.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 25);
  }
}
