import { RouteMap } from './map.js';
import { ResultsView } from './results.js';
import { ExploreView } from './explore.js';
import {
  KM_PER_MILE, debounce, escapeHtml as esc, fmtDate, fmtMiles, fmtDuration, money, changesLabel, swatchSvg, rankColor, opColor,
} from './util.js';
import { Engine } from './engine.js';
import { geocode } from './geocode.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  from: null, // { type:'station', crs, name, lat, lon } | { type:'point', lat, lon, label }
  to: null,
  picking: null,
  data: null,
  nearby: { from: [], to: [] },
};

const form = $('#search-form');
const errorEl = $('#form-error');

// ---------------------------------------------------------------- map + list
const routeMap = new RouteMap($('#map'), {
  onRouteHover: (id, on) => results.markRouteHover(id, on),
  onRouteClick: (id) => {
    const j = results.journeys?.find((x) => x.routeId === id);
    if (j) selectRoute(id, j.id, { scrollList: true });
  },
  onEmptyClick: () => {
    if (state.picking) return;
    if (routeMap.selected) clearRoute();
    if (state.task === 'explore' && explore.selected != null) clearDestination();
  },
  onStationAction: (action, s) => stationAction(action, s),
  onDestinationClick: (idx) => {
    const d = state.explore?.destinations.find((x) => x.idx === idx);
    if (d) selectDestination(d, { scrollList: true });
  },
  onMapClick: (latlng) => {
    if (!state.picking) return;
    const side = state.picking;
    stopPicking();
    setLocation(side, { type: 'point', lat: latlng.lat, lon: latlng.lng, label: `Map point ${latlng.lat.toFixed(3)}, ${latlng.lng.toFixed(3)}` });
    if (+$(`#${side}-radius`).value === 0) setRadius(side, 5);
  },
});

const results = new ResultsView($('#results'), {
  onHover: (routeId, on) => routeMap.highlight(routeId, on),
  onSelect: (j) => (j ? selectRoute(j.routeId, j.id) : clearRoute()),
});

// ---------------------------------------------------------------- selected route
const panel = $('#route-panel');
const wideScreen = () => window.matchMedia('(min-width: 861px)').matches;

/** Isolate a route on the map and show its train times in a panel. */
function selectRoute(routeId, journeyId, { scrollList = false } = {}) {
  const route = state.routeById?.get(routeId);
  if (!route) return;
  results.select(journeyId, { scroll: scrollList, notify: false });
  renderPanel(route, journeyId);
  if (routeMap.selected !== routeId) {
    // Fit the route into the part of the map the panel does not cover.
    const pad = wideScreen() ? { padRight: panel.offsetWidth + 12 } : { padBottom: panel.offsetHeight + 8 };
    routeMap.select(routeId, pad);
  }
}

function clearRoute() {
  routeMap.select(null);
  if (results.journeys && $('#results').dataset.view === 'journeys') results.select(null, { notify: false });
  panel.hidden = true;
  panel.innerHTML = '';
  panel.parentElement.classList.remove('has-panel');
}

function renderPanel(route, journeyId) {
  const journeys = results.journeys.filter((j) => j.routeId === route.id);
  const first = journeys[0];
  const trainLegs = first.legs.filter((l) => l.type === 'train');
  const via = trainLegs.slice(0, -1).map((l) => l.to.name);
  const t = route.total > 1 ? route.order / (route.total - 1) : 0;
  const ops = first.operators.map((o) => `<span class="op" style="background:${opColor(o)}">${esc(o.name)}</span>`).join('');
  panel.innerHTML = `
    <div class="rp-head">
      <button type="button" class="rp-close" data-act="close" aria-label="Show all routes">✕</button>
      <div class="rp-kind">${swatchSvg(rankColor(opColor(trainLegs[0].operator), t), route.changes)}${changesLabel(route.changes)}</div>
      <h2>${esc(first.origin.name)} → ${esc(first.destination.name)}</h2>
      ${via.length ? `<p class="rp-via">Change at ${via.map(esc).join(', ')}</p>` : ''}
      <div class="rp-ops">${ops}</div>
    </div>
    <ul class="rp-list" aria-label="Train times on this route">
      ${journeys.map((j) => `
        <li><button type="button" data-id="${j.id}" aria-current="${j.id === journeyId}">
          <span class="rp-time">${esc(j.depart.time)} → ${esc(j.arrive.time)}${j.arrive.dayOffset > j.depart.dayOffset ? ' +1' : ''}</span>
          <span class="rp-price">${money(j.fare.total)}</span>
          <span class="rp-sub">${fmtDuration(j.duration)}${j.runsOn ? ` · ${esc(j.runsOn)}` : ''}${j.fare.split ? ' · split ticket' : ''}${j.fare.source === 'estimate' ? ' · price estimated' : ''}</span>
        </button></li>`).join('')}
    </ul>
    <div class="rp-foot">
      <button type="button" class="primary" data-act="details">Journey details &amp; tickets</button>
      <button type="button" data-act="close">All routes</button>
    </div>`;
  panel.hidden = false;
  panel.parentElement.classList.add('has-panel');
  panel.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

panel.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const pick = e.target.closest('[data-id]')?.dataset.id;
  if (state.task === 'explore') {
    const d = state.explore?.destinations.find((x) => x.idx === explore.selected);
    if (act === 'close') clearDestination();
    else if (act === 'plan' && d) planJourneyTo(d);
    else if (act === 'explore' && d) exploreFrom(d);
    return;
  }
  if (act === 'close') clearRoute();
  else if (act === 'details') {
    const card = document.querySelector(`.journey[data-id="${results.selectedId}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (pick) {
    selectRoute(routeMap.selected, pick, { scrollList: true });
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.closest('input, select')) return;
  if (routeMap.selected) clearRoute();
  if (state.task === 'explore' && explore.selected != null) clearDestination();
});

// ---------------------------------------------------------------- from a station
const explore = new ExploreView($('#results'), {
  onSelect: (d) => (d ? selectDestination(d) : clearDestination()),
  onPlan: (d) => planJourneyTo(d),
  onExplore: (d) => exploreFrom(d),
});

const stationLoc = (s) => ({ type: 'station', crs: s.crs, id: s.id, name: s.name, lat: s.lat, lon: s.lon });

function selectDestination(d, { scrollList = false } = {}) {
  explore.select(d.idx, { scroll: scrollList });
  const origin = state.explore.from.stations.length === 1 ? state.explore.from.stations[0].name : state.explore.from.label;
  const mode = state.explore.query.mode;
  const ops = d.operators.map((o) => `<span class="op" style="background:${opColor(o)}">${esc(o.name)}</span>`).join('');
  const reach = state.explore.query.maxChanges > 0;
  const count = mode === 'date' ? `${d.trains} ${reach ? 'departure' : 'train'}${d.trains === 1 ? '' : 's'}` : `${d.trainsPerDay} ${reach ? 'departures' : 'trains'} a day`;
  panel.innerHTML = `
    <div class="rp-head">
      <button type="button" class="rp-close" data-act="close" aria-label="Show all destinations">✕</button>
      <div class="rp-kind">${swatchSvg('#111', d.changes)}${changesLabel(d.changes)}</div>
      <h2>${esc(origin)} → ${esc(d.name)}</h2>
      <p class="rp-via">${count} · fastest ${fmtDuration(d.fastest)}${d.via.length ? ` via ${d.via.map(esc).join(', ')}` : ''}</p>
      <div class="rp-ops">${ops}</div>
    </div>
    <ul class="rp-list" aria-label="Departures">
      ${d.times.map((t) => `<li><button type="button" tabindex="-1">
        <span class="rp-time">${esc(t.depart)} → ${esc(t.arrive)}${t.nextDay ? ' +1' : ''}</span>
        <span class="rp-price">${fmtDuration(t.duration)}</span>
        <span class="rp-sub">${t.via.length ? `change at ${t.via.map(esc).join(', ')} · ` : ''}${esc(t.operator.name)}${state.explore.from.stations.length > 1 ? ` · from ${esc(t.origin.name)}` : ''}${t.runsOn ? ` · ${esc(t.runsOn)}` : ''}</span>
      </button></li>`).join('')}
    </ul>
    <div class="rp-foot">
      <button type="button" class="primary" data-act="plan">Plan this journey</button>
      <button type="button" data-act="explore">Trains from ${esc(d.name)}</button>
    </div>`;
  panel.hidden = false;
  panel.parentElement.classList.add('has-panel');
  const pad = wideScreen() ? { padRight: panel.offsetWidth + 12 } : { padBottom: panel.offsetHeight + 8 };
  routeMap.selectDestination(d.idx, pad);
}

function clearDestination() {
  explore.select(null);
  routeMap.selectDestination(null);
  panel.hidden = true;
  panel.innerHTML = '';
  panel.parentElement.classList.remove('has-panel');
}

function setTask(task) {
  const r = form.querySelector(`input[name="task"][value="${task}"]`);
  if (r) r.checked = true;
  syncTask();
}

/** Open full journey results (fares, tickets) from the explore origin to a destination. */
function planJourneyTo(d) {
  // Allow at least as many changes as the destinations list did.
  const reach = state.explore?.query.maxChanges || 0;
  if (reach > +form.elements.maxChanges.value) form.querySelector(`input[name="maxChanges"][value="${reach}"]`).checked = true;
  setTask('journey');
  setLocation('to', stationLoc(d), { preview: false });
  setRadius('to', 0);
  form.requestSubmit();
}

/** Show everywhere reachable from another station (same changes setting). */
function exploreFrom(s) {
  setTask('explore');
  setLocation('from', stationLoc(s), { preview: false });
  setRadius('from', 0);
  form.requestSubmit();
}

function stationAction(action, s) {
  if (action === 'explore') exploreFrom(s);
  else if (action === 'from' || action === 'to') {
    setLocation(action, stationLoc(s));
    $(`#${action}-input`).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
results.showEmpty();

$('#streetmap').addEventListener('change', (e) => routeMap.setStreetMap(e.target.checked));

// ---------------------------------------------------------------- meta
const today = new Date();
const isoToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('#date').value = isoToday;

const engine = new Engine('data/timetable.json');
const statusEl = $('#data-status');
statusEl.textContent = 'Loading timetable…';
engine.ready.then((meta) => {
  if (meta.demo) $('#demo-banner').hidden = false;
  if (meta.dateRange) {
    $('#date').min = meta.dateRange.start;
    $('#date').max = meta.dateRange.end;
    if (isoToday < meta.dateRange.start || isoToday > meta.dateRange.end) $('#date').value = meta.dateRange.start;
  }
  const updated = meta.generated ? fmtDate(meta.generated.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  statusEl.textContent = `${meta.source?.name || 'Timetable'}${updated ? ` · updated ${updated}` : ''}`
    + ` · covers ${fmtDate(meta.dateRange.start)} to ${fmtDate(meta.dateRange.end)}`;
}).catch((err) => {
  statusEl.textContent = err.message;
  statusEl.classList.add('error');
});

// ---------------------------------------------------------------- mode panels
const goLabel = () => (form.elements.task.value === 'explore' ? 'Show destinations' : 'Find trains');

function syncTask() {
  const task = form.elements.task.value;
  const wasExplore = state.task === 'explore';
  state.task = task;
  $$('[data-tasks]').forEach((el) => { el.hidden = !el.dataset.tasks.split(' ').includes(task); });
  if (!$('.go', form).disabled) $('.go', form).textContent = goLabel();
  $('.map-wrap').classList.toggle('exploring', task === 'explore');
  // A whole day is more useful when looking at everywhere you can go.
  if (task === 'explore' && !wasExplore && $('#window').value === '120') $('#window').value = '720';
}
form.elements.task.forEach((r) => r.addEventListener('change', syncTask));

function syncMode() {
  const mode = form.elements.mode.value;
  $$('[data-modes]').forEach((el) => { el.hidden = !el.dataset.modes.split(' ').includes(mode); });
}
form.elements.mode.forEach((r) => r.addEventListener('change', syncMode));
syncMode();
syncTask();

// ---------------------------------------------------------------- locations
function sideLabel(loc) {
  if (!loc) return '';
  return loc.type === 'station' ? `${loc.name}${loc.crs ? ` (${loc.crs})` : ''}` : loc.label;
}

function setLocation(side, loc, { preview = true } = {}) {
  state[side] = loc;
  $(`#${side}-input`).value = sideLabel(loc);
  updateRadiusLabel(side);
  if (preview) refreshAreas(true);
}

function setRadius(side, miles) {
  const input = $(`#${side}-radius`);
  input.value = Math.max(+input.min, Math.min(+input.max, miles));
  updateRadiusLabel(side);
  refreshAreas(false);
}

function updateRadiusLabel(side) {
  const input = $(`#${side}-radius`);
  const miles = +input.value;
  input.style.setProperty('--pct', `${(miles / +input.max) * 100}%`);
  const loc = state[side];
  const out = $(`#${side}-radius-out`);
  let text;
  if (miles === 0) text = loc?.type === 'point' ? 'Nearest station only' : 'This station only';
  else {
    const n = state.nearby[side]?.length;
    text = `Within ${miles} mile${miles > 1 ? 's' : ''}${n ? ` · ${n} station${n > 1 ? 's' : ''}` : ''}`;
  }
  out.textContent = text;
  input.setAttribute('aria-valuetext', text);
}

$$('.radius .step').forEach((btn) => btn.addEventListener('click', () => {
  const side = btn.dataset.for.replace('-radius', '');
  setRadius(side, +$(`#${btn.dataset.for}`).value + Number(btn.dataset.step));
}));

const refreshAreas = debounce(async (fit) => {
  const sides = [];
  for (const [side, letter] of [['from', 'A'], ['to', 'B']]) {
    const loc = state[side];
    if (!loc) { sides.push(null); continue; }
    const radiusKm = +$(`#${side}-radius`).value * KM_PER_MILE;
    let stations = [];
    if (radiusKm > 0) {
      try {
        stations = await engine.nearby(loc.lat, loc.lon, radiusKm);
      } catch { stations = []; }
    } else if (loc.type === 'station') stations = [loc];
    state.nearby[side] = radiusKm > 0 ? stations : [];
    updateRadiusLabel(side);
    sides.push({ lat: loc.lat, lon: loc.lon, radiusKm, stations, isPoint: loc.type === 'point', letter });
  }
  routeMap.setAreas(sides);
  if (fit && !state.data && !state.explore) routeMap.fitAreas(sides);
}, 150);

for (const side of ['from', 'to']) {
  $(`#${side}-radius`).addEventListener('input', () => { updateRadiusLabel(side); refreshAreas(false); });
  setupCombo(side);
}

$('#swap').addEventListener('click', () => {
  const f = state.from, t = state.to;
  const fr = $('#from-radius').value, tr = $('#to-radius').value;
  $('#from-radius').value = tr; $('#to-radius').value = fr;
  updateRadiusLabel('from'); updateRadiusLabel('to');
  setLocation('from', t, { preview: false });
  setLocation('to', f, { preview: false });
  refreshAreas(true);
});

// Map picking.
$$('.pick-btn').forEach((btn) => btn.addEventListener('click', () => {
  if (state.picking === btn.dataset.side) { stopPicking(); return; }
  startPicking(btn.dataset.side);
}));
$('#cancel-pick').addEventListener('click', stopPicking);

function startPicking(side) {
  state.picking = side;
  $$('.pick-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
  const hint = $('#pick-hint');
  hint.querySelector('strong').textContent = side === 'from' ? 'your start (A)' : 'your destination (B)';
  hint.hidden = false;
  document.body.classList.add('map-picking');
}
function stopPicking() {
  state.picking = null;
  $$('.pick-btn').forEach((b) => b.classList.remove('active'));
  $('#pick-hint').hidden = true;
  document.body.classList.remove('map-picking');
}

// ---------------------------------------------------------------- autocomplete
function setupCombo(side) {
  const input = $(`#${side}-input`);
  const list = $(`#${side}-options`);
  let items = [];
  let active = -1;
  let seq = 0;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (item) => {
    close();
    if (item.kind === 'station') setLocation(side, { type: 'station', crs: item.crs, id: item.id, name: item.name, lat: item.lat, lon: item.lon });
    else {
      setLocation(side, { type: 'point', lat: item.lat, lon: item.lon, label: item.label });
      if (+$(`#${side}-radius`).value === 0) setRadius(side, 5);
    }
  };
  const renderList = (stations, places, placesError) => {
    items = [];
    const html = [];
    if (stations.length) {
      html.push('<li class="opt-head" role="presentation">Stations</li>');
      for (const s of stations) {
        items.push({ kind: 'station', ...s });
        html.push(`<li role="option" data-i="${items.length - 1}"><span class="opt-icon"></span><span class="opt-name">${esc(s.name)}</span><span class="opt-meta">${esc(s.crs || '')}</span></li>`);
      }
    }
    if (places.length) {
      html.push('<li class="opt-head" role="presentation">Places</li>');
      for (const p of places) {
        items.push({ kind: 'place', ...p });
        const near = p.nearest ? `<span class="opt-meta">${esc(p.nearest.name)} ${fmtMiles(p.nearest.distanceKm)}</span>` : '';
        html.push(`<li role="option" data-i="${items.length - 1}"><span class="opt-icon place"></span><span class="opt-name">${esc(p.label)}</span>${near}</li>`);
      }
    }
    if (placesError && !items.length) html.push(`<li class="opt-head" role="presentation">${esc(placesError)}</li>`);
    list.innerHTML = html.join('');
    list.hidden = !html.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    active = -1;
  };

  const search = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { close(); return; }
    let stations = [];
    try { stations = await engine.findStations(q); } catch { /* ignore */ }
    if (my !== seq) return;
    renderList(stations.slice(0, 8), [], null);
    if (q.length < 3) return;
    let places = [], err = null;
    try {
      places = await geocode(q);
      // Say which station each place is nearest, so places with the same
      // name (Sherburn near Malton, Sherburn-in-Elmet...) can be told apart.
      places = await Promise.all(places.slice(0, 5).map(async (p) => ({ ...p, nearest: (await engine.nearby(p.lat, p.lon, 80))[0] })));
    } catch { err = 'Place search is unavailable right now'; }
    if (my !== seq) return;
    renderList(stations.slice(0, 8), places.slice(0, 5), err);
  }, 220);

  input.addEventListener('input', () => { state[side] = null; search(); });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    const opts = $$('[role="option"]', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden || !opts.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
      opts[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (!list.hidden && opts.length) {
        e.preventDefault();
        choose(items[+(opts[Math.max(active, 0)].dataset.i)]);
      }
    } else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[role="option"]');
    if (!li) return;
    e.preventDefault();
    choose(items[+li.dataset.i]);
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

// ---------------------------------------------------------------- search
function payload() {
  const mode = form.elements.mode.value;
  const toLoc = (loc) => (loc.type === 'station' ? { type: 'station', crs: loc.crs, id: loc.id } : { type: 'point', lat: loc.lat, lon: loc.lon, label: loc.label });
  return {
    from: toLoc(state.from),
    to: state.to ? toLoc(state.to) : null,
    fromRadiusKm: +$('#from-radius').value * KM_PER_MILE,
    toRadiusKm: +$('#to-radius').value * KM_PER_MILE,
    mode,
    date: $('#date').value,
    time: $('#time').value,
    timeType: form.elements.timeType.value,
    windowMins: +$('#window').value,
    days: $$('input[name="day"]:checked').map((c) => +c.value),
    weeks: +$('#weeks').value,
    maxChanges: +form.elements.maxChanges.value,
    reachChanges: +form.elements.reach.value,
    minChange: $('#minChange').value ? +$('#minChange').value : null,
    sort: $('#sort').value,
  };
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  if (state.task === 'explore') {
    if (!state.from) { showError('Choose a station to start from.'); return; }
    const body = payload();
    delete body.to;
    saveToUrl(body);
    await runExplore(body);
    return;
  }
  if (!state.from || !state.to) {
    showError(!state.from ? 'Choose where you are starting from.' : 'Choose where you are going.');
    return;
  }
  const body = payload();
  saveToUrl(body);
  await runSearch(body);
});

/** Show search progress where it is always seen: over the map and on the button. */
function setBusy(text) {
  const btn = $('.go', form), busy = $('#busy');
  btn.disabled = !!text;
  btn.classList.toggle('busy-btn', !!text);
  btn.textContent = text ? 'Searching…' : goLabel();
  if (text) $('.busy-text', busy).textContent = text;
  busy.hidden = !text;
}

async function runExplore(body) {
  const text = body.reachChanges ? 'Finding everywhere you can reach…' : 'Finding every direct train…';
  setBusy(text);
  results.showLoading(text);
  clearRoute();
  try {
    const data = await engine.destinations(body, isoToday);
    state.explore = data;
    state.data = null;
    explore.render(data);
    routeMap.setAreas([{ ...data.from, isPoint: state.from?.type === 'point', letter: 'A' }]);
    routeMap.setExplore(data);
    $('.map-wrap').classList.toggle('reach-changes', data.query.maxChanges > 0);
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
    results.showEmpty();
  } finally {
    setBusy(null);
  }
}

async function runSearch(body) {
  setBusy('Finding trains…');
  results.showLoading();
  clearRoute();
  try {
    const data = await engine.search(body, isoToday);
    state.data = data;
    state.explore = null;
    renderData({ fit: true });
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
    results.showEmpty();
  } finally {
    setBusy(null);
  }
}

$('#showBeaten').addEventListener('change', () => state.data && renderData({ fit: false }));

function renderData({ fit }) {
  const data = state.data;
  const showBeaten = $('#showBeaten').checked;
  const visible = data.journeys.filter((j) => showBeaten || !j.beatenByFewerChanges);
  const hiddenCount = data.journeys.length - visible.length;

  // Re-rank the routes that still have a visible journey.
  const best = new Map();
  for (const j of visible) if (!best.has(j.routeId)) best.set(j.routeId, j);
  const routes = data.routes
    .filter((r) => best.has(r.id))
    .sort((a, b) => a.rank - b.rank)
    .map((r, i, arr) => {
      const j = best.get(r.id);
      const via = j.legs.filter((l) => l.type === 'train').slice(0, -1).map((l) => l.to.name);
      return {
        ...r,
        order: i,
        total: arr.length,
        journeyIds: r.journeyIds.filter((id) => visible.some((v) => v.id === id)),
        summary: `${j.origin.name} → ${j.destination.name}${via.length ? ` via ${via.join(', ')}` : ''}`,
      };
    });
  const routeById = new Map(routes.map((r) => [r.id, r]));
  state.routeById = routeById;
  panel.hidden = true;
  panel.parentElement.classList.remove('has-panel');

  const stations = new Map();
  const endpoints = new Set();
  for (const j of visible) {
    endpoints.add(j.origin.idx); endpoints.add(j.destination.idx);
    for (const l of j.legs) {
      if (l.type === 'train') l.calls.forEach((c) => stations.set(c.idx, c));
      else { stations.set(l.from.idx, l.from); stations.set(l.to.idx, l.to); }
    }
  }

  const sides = [
    { ...data.from, isPoint: state.from?.type === 'point', letter: 'A' },
    { ...data.to, isPoint: state.to?.type === 'point', letter: 'B' },
  ];
  routeMap.setAreas(sides);
  routeMap.setRoutes(routes, stations, [...endpoints]);
  results.render(data, visible, routeById, hiddenCount);
  if (fit) {
    if (routes.length) routeMap.fitRoutes(); else routeMap.fitAreas(sides);
  }
}

// ---------------------------------------------------------------- shareable URL
function saveToUrl(body) {
  const share = { ...body, task: state.task, fromLabel: sideLabel(state.from), toLabel: sideLabel(state.to), fromLoc: state.from, toLoc: state.to };
  history.replaceState(null, '', `#s=${encodeURIComponent(JSON.stringify(share))}`);
}

function restoreFromUrl() {
  const m = /#s=(.+)$/.exec(location.hash);
  if (!m) return;
  let s;
  try { s = JSON.parse(decodeURIComponent(m[1])); } catch { return; }
  const task = s.task === 'explore' ? 'explore' : 'journey';
  if (!s.fromLoc || (task === 'journey' && !s.toLoc)) return;
  setTask(task);
  $('#from-radius').value = Math.round((s.fromRadiusKm || 0) / KM_PER_MILE);
  $('#to-radius').value = Math.round((s.toRadiusKm || 0) / KM_PER_MILE);
  setLocation('from', s.fromLoc, { preview: false });
  if (s.toLoc) setLocation('to', s.toLoc, { preview: false });
  const setRadio = (name, value) => { const r = form.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };
  setRadio('mode', s.mode); setRadio('timeType', s.timeType); setRadio('maxChanges', s.maxChanges); setRadio('reach', s.reachChanges ?? 0);
  if (s.date) $('#date').value = s.date;
  if (s.time) $('#time').value = s.time;
  if (s.windowMins) $('#window').value = String(s.windowMins);
  if (s.weeks) $('#weeks').value = String(s.weeks);
  if (s.minChange) $('#minChange').value = String(s.minChange);
  if (s.sort) $('#sort').value = s.sort;
  $$('input[name="day"]').forEach((c) => { c.checked = (s.days || []).includes(+c.value); });
  syncMode();
  refreshAreas(false);
  const body = payload();
  if (task === 'explore') { delete body.to; runExplore(body); } else runSearch(body);
}
restoreFromUrl();

