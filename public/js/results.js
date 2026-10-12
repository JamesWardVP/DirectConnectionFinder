import {
  escapeHtml as esc, fmtDuration, money, fmtMiles, fmtDate, changesLabel, swatchSvg, rankColor, opColor,
} from './util.js';

const PAGE = 60;

/**
 * Renders the journey list. Journeys arrive already ranked; routes carry the
 * colour ordering shared with the map.
 */
export class ResultsView {
  constructor(el, { onHover, onSelect }) {
    this.el = el;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.selectedId = null;
    this.limit = PAGE;
    el.addEventListener('click', (e) => this.handleClick(e));
    el.addEventListener('mouseover', (e) => this.handleHover(e, true));
    el.addEventListener('mouseout', (e) => this.handleHover(e, false));
  }

  showEmpty() {
    this.el.innerHTML = '';
    this.el.append(document.getElementById('tpl-empty').content.cloneNode(true));
  }

  showLoading() {
    this.el.innerHTML = '<div class="loading">Finding trains…<div class="bar"></div></div>';
  }

  /**
   * data: server response; journeys: visible journeys; routeById: Map of visible routes
   */
  render(data, journeys, routeById, hiddenCount) {
    this.data = data;
    this.journeys = journeys;
    this.routeById = routeById;
    this.hiddenCount = hiddenCount;
    this.limit = PAGE;
    this.selectedId = null;
    this.draw();
  }

  draw() {
    const { data, journeys } = this;
    const q = data.query;
    const parts = [];
    const searched = q.mode === 'date'
      ? fmtDate(q.dates[0], { weekday: 'long', day: 'numeric', month: 'long' })
      : q.mode === 'time'
        ? `the ${q.dates.length} days from ${fmtDate(q.dates[0])}`
        : `${q.dates.length} day${q.dates.length > 1 ? 's' : ''} (${q.dates.map((d) => fmtDate(d, { weekday: 'short', day: 'numeric' })).join(', ')})`;
    parts.push(`<div class="summary"><strong>${journeys.length}</strong> option${journeys.length === 1 ? '' : 's'} on <strong>${this.routeById.size}</strong> route${this.routeById.size === 1 ? '' : 's'} · ${esc(searched)}</div>`);

    const notes = [];
    for (const [side, name] of [[data.from, 'start'], [data.to, 'destination']]) {
      if (side.fellBackToNearest) notes.push(`No station inside the radius of your ${name}, so the nearest one (${esc(side.stations[0].name)}) is used.`);
      else if (side.stations.length > 1) notes.push(`${side.stations.length} stations near your ${name}: ${side.stations.slice(0, 6).map((s) => esc(s.name)).join(', ')}${side.stations.length > 6 ? '…' : ''}`);
    }
    if (q.datesWithService.length < q.dates.length) {
      notes.push(`No timetable data for ${q.dates.length - q.datesWithService.length} of the dates searched.`);
    }
    if (this.hiddenCount) notes.push(`${this.hiddenCount} slower route${this.hiddenCount > 1 ? 's' : ''} with more changes hidden (see More options).`);
    if (data.truncated) notes.push(`Showing the best ${data.journeys.length} of ${data.total}.`);
    if (notes.length) parts.push(`<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`);

    if (!journeys.length) {
      parts.push('<div class="empty"><p>No trains found. Try a wider radius, a longer time window or allowing more changes.</p></div>');
      this.el.innerHTML = parts.join('');
      return;
    }

    let currentChanges = -1;
    const shown = journeys.slice(0, this.limit);
    const counts = new Map();
    for (const j of journeys) counts.set(j.changes, (counts.get(j.changes) || 0) + 1);
    for (const j of shown) {
      if (j.changes !== currentChanges) {
        currentChanges = j.changes;
        parts.push(`<h2 class="group-head">${swatchSvg('#111', j.changes)}${changesLabel(j.changes)}<span class="count">${counts.get(j.changes)}</span></h2>`);
      }
      parts.push(this.cardHtml(j));
    }
    if (journeys.length > shown.length) {
      parts.push(`<button type="button" class="more-results" data-action="more">Show ${Math.min(PAGE, journeys.length - shown.length)} more</button>`);
    }
    this.el.innerHTML = parts.join('');
  }

  cardHtml(j) {
    const route = this.routeById.get(j.routeId);
    const t = route && route.total > 1 ? route.order / (route.total - 1) : 0;
    const firstOp = j.legs.find((l) => l.type === 'train')?.operator;
    const swatch = swatchSvg(rankColor(opColor(firstOp), t), j.changes);
    const dayMark = j.arrive.dayOffset > j.depart.dayOffset ? `<sup>+${j.arrive.dayOffset - j.depart.dayOffset}</sup>` : '';
    const ops = j.operators.map((o) => `<span class="op" style="background:${opColor(o)}">${esc(o.name)}</span>`).join('');
    const badges = [ops];
    if (j.fare.split) badges.push(`<span class="badge split" title="Cheaper with ${j.fare.tickets.length} tickets">Split ticket${j.direct ? ' · same train' : ''}</span>`);
    if (j.runsOn) badges.push(`<span class="badge days">${esc(j.runsOn)}</span>`);
    if (j.beatenByFewerChanges) badges.push('<span class="badge beaten">Slower than a more direct train</span>');
    const dist = (s, label) => (s.distanceKm != null && s.distanceKm >= 0.1 ? ` <span title="Distance from your ${label}">(${fmtMiles(s.distanceKm)})</span>` : '');
    const via = j.legs.filter((l) => l.type === 'train').slice(0, -1).map((l) => l.to.name);
    return `
      <article class="journey${j.id === this.selectedId ? ' selected' : ''}" data-id="${j.id}" data-route="${j.routeId}">
        <button type="button" class="card" aria-expanded="${j.id === this.selectedId}">
          ${swatch}
          <span class="times">${esc(j.depart.time)}<span class="arrow">→</span>${esc(j.arrive.time)}${dayMark}</span>
          <span class="price">${money(j.fare.total)}<small>${j.fare.source === 'estimate' ? 'estimate' : j.fare.split ? `save ${money(j.fare.saving)}` : 'single'}</small></span>
          <span class="where">${esc(j.origin.name)}${dist(j.origin, 'start')} → ${esc(j.destination.name)}${dist(j.destination, 'destination')}<br>
            <span class="duration">${fmtDuration(j.duration)}${via.length ? ` · change at ${via.map(esc).join(', ')}` : ''}</span></span>
          <span class="badges">${badges.join('')}</span>
        </button>
        ${j.id === this.selectedId ? this.detailHtml(j) : ''}
      </article>`;
  }

  detailHtml(j) {
    const out = ['<div class="detail">'];
    out.push('<h3>Journey</h3>');
    for (const leg of j.legs) {
      if (leg.type === 'transfer') {
        const how = { walk: 'Walk', tube: 'Underground', tram: 'Tram', bus: 'Bus' }[leg.mode] || 'Transfer';
        out.push(`<div class="transfer"><span></span><span class="n">${how} to ${esc(leg.to.name)} · allow ${leg.minutes} min</span></div>`);
        continue;
      }
      const c = opColor(leg.operator);
      const inner = leg.calls.slice(1, -1);
      const first = leg.calls[0], last = leg.calls[leg.calls.length - 1];
      out.push(`<div class="leg" style="--c:${c}">`);
      out.push('<ol class="stops">');
      out.push(`<li class="stop major"><span class="t">${esc(first.depart)}</span><span class="n">${esc(first.name)}</span></li>`);
      out.push(`<li class="calls-wrap" hidden><ol class="stops">${inner.map((s) => `<li class="stop"><span class="t">${esc(s.depart)}</span><span class="n">${esc(s.name)}</span></li>`).join('')}</ol></li>`);
      out.push(`<li class="stop major"><span class="t">${esc(last.arrive)}</span><span class="n">${esc(last.name)}</span></li>`);
      out.push('</ol>');
      const opNames = leg.operators.map((o) => `<span class="op" style="background:${opColor(o)}">${esc(o.name)}</span>`).join(' ');
      out.push(`<div class="leg-meta">${opNames}<span>${esc(leg.service)} · to ${esc(leg.headsign)} · ${fmtDuration(leg.minutes)}</span>`);
      if (leg.joinedTrips) out.push('<span>Runs as one train throughout, so stay on board</span>');
      if (inner.length) out.push(`<button type="button" class="toggle-calls" data-action="calls">${inner.length} stop${inner.length > 1 ? 's' : ''}</button>`);
      out.push('</div></div>');
    }

    // Fares.
    const f = j.fare;
    out.push('<h3>Fare</h3><table class="fare-table">');
    for (const t of f.tickets) {
      out.push(`<tr><td>${esc(t.fromName)} → ${esc(t.toName)}${t.source === 'estimate' ? ' (estimate)' : ''}</td><td>${money(t.price)}</td></tr>`);
    }
    if (f.tickets.length > 1) out.push(`<tr class="total"><td>Total with ${f.tickets.length} tickets</td><td>${money(f.total)}</td></tr>`);
    out.push('</table>');
    if (f.split && f.through) {
      out.push(`<p class="fare-note">Saves ${money(f.saving)} on the ${money(f.through)} through fare. ${j.direct ? 'You stay on the same train; it just has to call at the station where the tickets meet.' : 'Each ticket must cover the trains you take.'}</p>`);
    } else if (f.source === 'estimate') {
      out.push(`<p class="fare-note">Estimated from the ${Math.round(f.distanceKm / 1.609)} mile route. No published fare for this journey in the timetable data. Check the real price before you travel.</p>`);
    } else {
      out.push('<p class="fare-note">Standard single from the published fares in the timetable data.</p>');
    }

    if (j.runsOn) {
      out.push(`<h3>Runs on</h3><p class="runs-dates">${j.dates.map((d) => fmtDate(d)).join(' · ')}</p>`);
    }

    out.push('<h3>Buy tickets</h3><div class="links">');
    j.links.forEach((l, i) => {
      out.push(`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="${i === 0 ? 'primary' : ''}">${esc(l.label)}</a>`);
    });
    out.push('</div></div>');
    return out.join('');
  }

  handleClick(e) {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'more') { this.limit += PAGE; this.draw(); return; }
    if (action === 'calls') {
      const leg = e.target.closest('.leg');
      const wrap = leg.querySelector('.calls-wrap');
      wrap.hidden = !wrap.hidden;
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.closest('.journey').dataset.id;
    this.select(this.selectedId === id ? null : id);
  }

  handleHover(e, on) {
    const art = e.target.closest('.journey');
    if (!art || (e.relatedTarget && art.contains(e.relatedTarget))) return;
    this.onHover?.(art.dataset.route, on);
  }

  select(id, { scroll = false, notify = true } = {}) {
    this.selectedId = id;
    const j = this.journeys.find((x) => x.id === id);
    // Make sure the selected journey is rendered.
    if (j) {
      const pos = this.journeys.indexOf(j);
      if (pos >= this.limit) this.limit = pos + 1;
    }
    this.draw();
    if (notify) this.onSelect?.(j || null);
    if (id) this.el.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: scroll ? 'center' : 'nearest', behavior: 'smooth' });
  }

  markRouteHover(routeId, on) {
    this.el.querySelectorAll(`.journey[data-route="${routeId}"]`).forEach((n) => n.classList.toggle('hover', on));
  }
}
