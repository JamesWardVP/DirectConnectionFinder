import {
  escapeHtml as esc, nearestNote, fmtDuration, fmtDate, fmtMiles, opColor, swatchSvg, changesLabel,
} from './util.js';

const PAGE = 40;
const SORTS = {
  trains: (a, b) => b.trainsPerDay - a.trainsPerDay || a.fastest - b.fastest,
  fastest: (a, b) => a.fastest - b.fastest,
  name: (a, b) => a.name.localeCompare(b.name),
  distance: (a, b) => b.distanceKm - a.distanceKm,
};

/** Every station reachable from a station, directly or with changes ("From a station"). */
export class ExploreView {
  constructor(el, { onSelect, onPlan, onExplore }) {
    this.el = el;
    this.callbacks = { onSelect, onPlan, onExplore };
    el.addEventListener('click', (e) => this.handleClick(e));
    el.addEventListener('input', (e) => {
      if (e.target.matches('.ex-filter')) { this.filter = e.target.value; this.drawList(); }
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('.ex-sort')) { this.sort = e.target.value; this.drawList(); }
    });
  }

  render(data) {
    this.el.dataset.view = 'explore';
    this.data = data;
    this.sort = 'trains';
    this.filter = '';
    this.selected = null;
    this.limits = new Map();
    const q = data.query;
    const origin = data.from.stations.length === 1 ? data.from.stations[0].name : `${data.from.stations.length} stations near ${data.from.label}`;
    const when = q.mode === 'date'
      ? fmtDate(q.dates[0], { weekday: 'long', day: 'numeric', month: 'long' })
      : q.mode === 'time' ? `the ${q.dates.length} days from ${fmtDate(q.dates[0])}` : `${q.weekdays.join(', ')} (whole day)`;
    const notes = [];
    if (data.from.fellBackToNearest) notes.push(nearestNote(data.from, esc(data.from.label)));
    else if (data.from.stations.length > 1) notes.push(`Starting from ${data.from.stations.map((s) => esc(s.name)).join(', ')}.`);
    if (q.datesWithService.length < q.dates.length) notes.push(`No timetable data for ${q.dates.length - q.datesWithService.length} of the dates searched.`);
    if (q.shortened) notes.push(`With changes, only the first ${q.dates.length} of the ${q.shortened} days are searched.`);
    const how = q.maxChanges ? `from <strong>${esc(origin)}</strong> with up to ${q.maxChanges} change${q.maxChanges > 1 ? 's' : ''}` : `direct from <strong>${esc(origin)}</strong>`;
    this.el.innerHTML = `
      <div class="summary"><strong>${data.destinations.length}</strong> station${data.destinations.length === 1 ? '' : 's'} ${how} · ${esc(when)}</div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
      <div class="ex-tools">
        <input type="search" class="ex-filter" placeholder="Filter stations" aria-label="Filter destinations">
        <label class="inline"><span>Sort by</span>
          <select class="ex-sort">
            <option value="trains">Most trains</option>
            <option value="fastest">Fastest</option>
            <option value="distance">Furthest</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <div class="ex-list"></div>`;
    this.drawList();
  }

  visible() {
    const f = this.filter.trim().toLowerCase();
    return this.data.destinations
      .filter((d) => !f || d.name.toLowerCase().includes(f) || (d.crs || '').toLowerCase() === f)
      // Fewest changes first, like journey results; then the chosen order.
      .sort((a, b) => a.changes - b.changes || (SORTS[this.sort] || SORTS.trains)(a, b));
  }

  perDay(d) {
    const mode = this.data.query.mode;
    const what = this.data.query.maxChanges ? 'departure' : 'train';
    if (mode === 'date') return `${d.trains} ${what}${d.trains === 1 ? '' : 's'}`;
    return `${d.trainsPerDay} a day`;
  }

  drawList() {
    const list = this.el.querySelector('.ex-list');
    if (!list) return;
    const items = this.visible();
    if (!items.length) {
      list.innerHTML = '<div class="empty"><p>No trains found. Try a longer time window, a wider radius, allowing changes or "Days of week".</p></div>';
      return;
    }
    // Each group (Direct, 1 change, ...) shows its first rows and its own
    // "Show more", so every group can be seen without paging through others.
    const groups = new Map();
    for (const d of items) {
      if (!groups.has(d.changes)) groups.set(d.changes, []);
      groups.get(d.changes).push(d);
    }
    list.innerHTML = [...groups].map(([changes, ds]) => {
      const limit = this.limitFor(changes);
      return `<h2 class="group-head">${swatchSvg('#111', changes)}${changes ? changesLabel(changes) : 'Direct trains'}<span class="count">${ds.length}</span></h2>`
        + ds.slice(0, limit).map((d) => this.rowHtml(d)).join('')
        + (ds.length > limit ? `<button type="button" class="more-results" data-act="more" data-changes="${changes}">Show ${Math.min(PAGE, ds.length - limit)} more</button>` : '');
    }).join('');
  }

  limitFor(changes) {
    return this.limits.get(changes) ?? PAGE;
  }

  rowHtml(d) {
    const ops = d.operators.map((o) => `<span class="op" style="background:${opColor(o)}">${esc(o.name)}</span>`).join('');
    const sel = d.idx === this.selected;
    return `
      <article class="journey ex-dest${sel ? ' selected' : ''}" data-idx="${d.idx}">
        <button type="button" class="card ex-card" aria-expanded="${sel}">
          <span class="ex-dot" aria-hidden="true"></span>
          <span class="ex-name">${esc(d.name)}${d.crs ? ` <small>${esc(d.crs)}</small>` : ''}</span>
          <span class="price">${esc(this.perDay(d))}<small>fastest ${fmtDuration(d.fastest)}</small></span>
          <span class="where">${d.via.length ? `Fastest via ${d.via.map(esc).join(', ')} · ` : ''}First ${esc(d.first)} · last ${esc(d.last)} · ${fmtMiles(d.distanceKm * 1)} away</span>
          <span class="badges">${ops}</span>
        </button>
        ${sel ? this.detailHtml(d) : ''}
      </article>`;
  }

  detailHtml(d) {
    if (!d.times) return '<div class="detail"><p class="fare-note">Loading departures…</p></div>';
    const multi = this.data.from.stations.length > 1;
    const rows = d.times.map((t) => `
      <li><span class="t">${esc(t.depart)} → ${esc(t.arrive)}${t.nextDay ? ' +1' : ''}</span>
        <span class="d">${fmtDuration(t.duration)}${t.changes ? ` · ${changesLabel(t.changes)}` : ''}</span>
        <span class="o">${t.via.length ? `via ${t.via.map(esc).join(', ')} · ` : ''}<span class="op" style="background:${opColor(t.operator)}">${esc(t.operator.name)}</span>${multi ? ` from ${esc(t.origin.name)}` : ''}${t.runsOn ? ` · ${esc(t.runsOn)}` : ''}</span></li>`).join('');
    return `
      <div class="detail">
        <h3>Departures</h3>
        <ul class="ex-times">${rows}</ul>
        ${d.moreTimes ? `<p class="fare-note">and ${d.moreTimes} more.</p>` : ''}
        <div class="links ex-actions">
          <button type="button" class="primary" data-act="plan">Plan this journey (fares &amp; tickets)</button>
          <button type="button" data-act="explore">Trains from ${esc(d.name)}</button>
        </div>
      </div>`;
  }

  handleClick(e) {
    if (this.el.dataset.view !== 'explore') return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const art = e.target.closest('.ex-dest');
    if (act === 'more') {
      const changes = +e.target.closest('[data-act]').dataset.changes;
      this.limits.set(changes, this.limitFor(changes) + PAGE);
      this.drawList();
      return;
    }
    const dest = art && this.data.destinations.find((d) => d.idx === +art.dataset.idx);
    if (act === 'plan' && dest) { this.callbacks.onPlan?.(dest); return; }
    if (act === 'explore' && dest) { this.callbacks.onExplore?.(dest); return; }
    if (e.target.closest('.ex-card') && dest) {
      this.select(this.selected === dest.idx ? null : dest.idx, { notify: true });
    }
  }

  select(idx, { notify = false, scroll = false } = {}) {
    this.selected = idx;
    const d = idx == null ? null : this.data.destinations.find((x) => x.idx === idx);
    if (d && !this.el.querySelector(`.ex-dest[data-idx="${idx}"]`)) {
      // Picked on the map but not in the list: clear the filter and page to it.
      this.filter = '';
      const input = this.el.querySelector('.ex-filter');
      if (input) input.value = '';
      const pos = this.visible().filter((x) => x.changes === d.changes).findIndex((x) => x.idx === idx);
      this.limits.set(d.changes, Math.max(this.limitFor(d.changes), pos + 1));
    }
    this.drawList();
    if (notify) this.callbacks.onSelect?.(idx == null ? null : this.data.destinations.find((d) => d.idx === idx));
    if (scroll && idx != null) this.el.querySelector(`.ex-dest[data-idx="${idx}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
