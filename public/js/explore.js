import { escapeHtml as esc, fmtDuration, fmtDate, fmtMiles, opColor } from './util.js';

const PAGE = 80;
const SORTS = {
  trains: (a, b) => b.trainsPerDay - a.trainsPerDay || a.fastest - b.fastest,
  fastest: (a, b) => a.fastest - b.fastest,
  name: (a, b) => a.name.localeCompare(b.name),
  distance: (a, b) => b.distanceKm - a.distanceKm,
};

/** List of every station reachable on one train ("Direct from a station"). */
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
    this.limit = PAGE;
    const q = data.query;
    const origin = data.from.stations.length === 1 ? data.from.stations[0].name : `${data.from.stations.length} stations near ${data.from.label}`;
    const when = q.mode === 'date'
      ? fmtDate(q.dates[0], { weekday: 'long', day: 'numeric', month: 'long' })
      : q.mode === 'time' ? `the ${q.dates.length} days from ${fmtDate(q.dates[0])}` : `${q.weekdays.join(', ')} (whole day)`;
    const notes = [];
    if (data.from.fellBackToNearest) notes.push(`No station inside the radius, so the nearest one (${esc(data.from.stations[0].name)}) is used.`);
    if (data.from.stations.length > 1) notes.push(`Starting from ${data.from.stations.map((s) => esc(s.name)).join(', ')}.`);
    if (q.datesWithService.length < q.dates.length) notes.push(`No timetable data for ${q.dates.length - q.datesWithService.length} of the dates searched.`);
    this.el.innerHTML = `
      <div class="summary"><strong>${data.destinations.length}</strong> station${data.destinations.length === 1 ? '' : 's'} direct from <strong>${esc(origin)}</strong> · ${esc(when)}</div>
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
      <h2 class="group-head"><svg viewBox="0 0 46 12" aria-hidden="true"><line x1="4" y1="6" x2="42" y2="6" stroke="#111" stroke-width="5"/></svg>Direct trains<span class="count">${data.destinations.length}</span></h2>
      <div class="ex-list"></div>`;
    this.drawList();
  }

  visible() {
    const f = this.filter.trim().toLowerCase();
    return this.data.destinations
      .filter((d) => !f || d.name.toLowerCase().includes(f) || (d.crs || '').toLowerCase() === f)
      .sort(SORTS[this.sort] || SORTS.trains);
  }

  perDay(d) {
    const mode = this.data.query.mode;
    if (mode === 'date') return `${d.trains} train${d.trains === 1 ? '' : 's'}`;
    return `${d.trainsPerDay} a day`;
  }

  drawList() {
    const list = this.el.querySelector('.ex-list');
    if (!list) return;
    const items = this.visible();
    if (!items.length) {
      list.innerHTML = '<div class="empty"><p>No direct trains found. Try a longer time window, a wider radius or "Days of week".</p></div>';
      return;
    }
    list.innerHTML = items.slice(0, this.limit).map((d) => this.rowHtml(d)).join('')
      + (items.length > this.limit ? `<button type="button" class="more-results" data-act="more">Show ${Math.min(PAGE, items.length - this.limit)} more</button>` : '');
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
          <span class="where">First ${esc(d.first)} · last ${esc(d.last)} · ${fmtMiles(d.distanceKm * 1)} away</span>
          <span class="badges">${ops}</span>
        </button>
        ${sel ? this.detailHtml(d) : ''}
      </article>`;
  }

  detailHtml(d) {
    const multi = this.data.from.stations.length > 1;
    const rows = d.times.map((t) => `
      <li><span class="t">${esc(t.depart)} → ${esc(t.arrive)}${t.nextDay ? ' +1' : ''}</span>
        <span class="d">${fmtDuration(t.duration)}</span>
        <span class="o"><span class="op" style="background:${opColor(t.operator)}">${esc(t.operator.name)}</span>${multi ? ` from ${esc(t.origin.name)}` : ''}${t.runsOn ? ` · ${esc(t.runsOn)}` : ''}</span></li>`).join('');
    return `
      <div class="detail">
        <h3>Departures</h3>
        <ul class="ex-times">${rows}</ul>
        ${d.moreTimes ? `<p class="fare-note">and ${d.moreTimes} more.</p>` : ''}
        <div class="links ex-actions">
          <button type="button" class="primary" data-act="plan">Plan this journey (fares &amp; tickets)</button>
          <button type="button" data-act="explore">Direct trains from ${esc(d.name)}</button>
        </div>
      </div>`;
  }

  handleClick(e) {
    if (this.el.dataset.view !== 'explore') return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const art = e.target.closest('.ex-dest');
    if (act === 'more') { this.limit += PAGE; this.drawList(); return; }
    const dest = art && this.data.destinations.find((d) => d.idx === +art.dataset.idx);
    if (act === 'plan' && dest) { this.callbacks.onPlan?.(dest); return; }
    if (act === 'explore' && dest) { this.callbacks.onExplore?.(dest); return; }
    if (e.target.closest('.ex-card') && dest) {
      this.select(this.selected === dest.idx ? null : dest.idx, { notify: true });
    }
  }

  select(idx, { notify = false, scroll = false } = {}) {
    this.selected = idx;
    if (idx != null && !this.visible().slice(0, this.limit).some((d) => d.idx === idx)) {
      this.filter = '';
      const input = this.el.querySelector('.ex-filter');
      if (input) input.value = '';
      this.limit = Math.max(this.limit, this.visible().findIndex((d) => d.idx === idx) + 1);
    }
    this.drawList();
    if (notify) this.callbacks.onSelect?.(idx == null ? null : this.data.destinations.find((d) => d.idx === idx));
    if (scroll && idx != null) this.el.querySelector(`.ex-dest[data-idx="${idx}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
