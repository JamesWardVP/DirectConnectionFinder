import { RouteMap } from './map.js';
import { ResultsView } from './results.js';
import { KM_PER_MILE, debounce, escapeHtml as esc } from './util.js';

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
  onRouteHover: (id, on) => { results.markRouteHover(id, on); routeMap.highlight(id, on); },
  onRouteClick: (id) => {
    const j = results.journeys?.find((x) => x.routeId === id);
    if (j) results.select(j.id, { scroll: true });
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
  onSelect: (j) => routeMap.select(j ? j.routeId : null),
});
results.showEmpty();

$('#streetmap').addEventListener('change', (e) => routeMap.setStreetMap(e.target.checked));

// ---------------------------------------------------------------- meta
const today = new Date();
const isoToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('#date').value = isoToday;

fetch('/api/meta').then((r) => r.json()).then((meta) => {
  if (meta.demo) $('#demo-banner').hidden = false;
  if (meta.dateRange) {
    $('#date').min = meta.dateRange.start;
    $('#date').max = meta.dateRange.end;
    if (isoToday < meta.dateRange.start || isoToday > meta.dateRange.end) $('#date').value = meta.dateRange.start;
  }
}).catch(() => {});

// ---------------------------------------------------------------- mode panels
function syncMode() {
  const mode = form.elements.mode.value;
  $$('[data-modes]').forEach((el) => { el.hidden = !el.dataset.modes.split(' ').includes(mode); });
}
form.elements.mode.forEach((r) => r.addEventListener('change', syncMode));
syncMode();

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
  $(`#${side}-radius`).value = miles;
  updateRadiusLabel(side);
  refreshAreas(false);
}

function updateRadiusLabel(side) {
  const miles = +$(`#${side}-radius`).value;
  const loc = state[side];
  const out = $(`#${side}-radius-out`);
  if (miles === 0) out.textContent = loc?.type === 'point' ? 'Nearest station' : 'This station only';
  else {
    const n = state.nearby[side]?.length;
    out.textContent = `Within ${miles} mi${n ? ` · ${n} station${n > 1 ? 's' : ''}` : ''}`;
  }
}

const refreshAreas = debounce(async (fit) => {
  const sides = [];
  for (const [side, letter] of [['from', 'A'], ['to', 'B']]) {
    const loc = state[side];
    if (!loc) { sides.push(null); continue; }
    const radiusKm = +$(`#${side}-radius`).value * KM_PER_MILE;
    let stations = [];
    if (radiusKm > 0) {
      try {
        stations = await (await fetch(`/api/nearby?lat=${loc.lat}&lon=${loc.lon}&radiusKm=${radiusKm}`)).json();
      } catch { stations = []; }
    } else if (loc.type === 'station') stations = [loc];
    state.nearby[side] = radiusKm > 0 ? stations : [];
    updateRadiusLabel(side);
    sides.push({ lat: loc.lat, lon: loc.lon, radiusKm, stations, isPoint: loc.type === 'point', letter });
  }
  routeMap.setAreas(sides);
  if (fit && !state.data) routeMap.fitAreas(sides);
}, 150);

for (const side of ['from', 'to']) {
  $(`#${side}-radius`).addEventListener('input', () => { updateRadiusLabel(side); refreshAreas(false); });
  setupCombo(side);
}

$('#swap').addEventListener('click', () => {
  const f = state.from, t = state.to;
  const fr = $('#from-radius').value, tr = $('#to-radius').value;
  $('#from-radius').value = tr; $('#to-radius').value = fr;
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
        html.push(`<li role="option" data-i="${items.length - 1}"><span class="opt-icon place"></span><span class="opt-name">${esc(p.label)}</span></li>`);
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
    try { stations = await (await fetch(`/api/stations?q=${encodeURIComponent(q)}`)).json(); } catch { /* ignore */ }
    if (my !== seq) return;
    renderList(stations.slice(0, 8), [], null);
    if (q.length < 3) return;
    let places = [], err = null;
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (res.ok) places = body; else err = body.error;
    } catch { err = 'Place search unavailable'; }
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
    to: toLoc(state.to),
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
    minChange: +$('#minChange').value,
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
  if (!state.from || !state.to) {
    showError(!state.from ? 'Choose where you are starting from.' : 'Choose where you are going.');
    return;
  }
  const body = payload();
  saveToUrl(body);
  await runSearch(body);
});

async function runSearch(body) {
  const btn = $('.go', form);
  btn.disabled = true;
  results.showLoading();
  try {
    const res = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    state.data = data;
    renderData({ fit: true });
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
    results.showEmpty();
  } finally {
    btn.disabled = false;
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
  const share = { ...body, fromLabel: sideLabel(state.from), toLabel: sideLabel(state.to), fromLoc: state.from, toLoc: state.to };
  history.replaceState(null, '', `#s=${encodeURIComponent(JSON.stringify(share))}`);
}

function restoreFromUrl() {
  const m = /#s=(.+)$/.exec(location.hash);
  if (!m) return;
  let s;
  try { s = JSON.parse(decodeURIComponent(m[1])); } catch { return; }
  if (!s.fromLoc || !s.toLoc) return;
  $('#from-radius').value = Math.round((s.fromRadiusKm || 0) / KM_PER_MILE);
  $('#to-radius').value = Math.round((s.toRadiusKm || 0) / KM_PER_MILE);
  setLocation('from', s.fromLoc, { preview: false });
  setLocation('to', s.toLoc, { preview: false });
  const setRadio = (name, value) => { const r = form.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };
  setRadio('mode', s.mode); setRadio('timeType', s.timeType); setRadio('maxChanges', s.maxChanges);
  if (s.date) $('#date').value = s.date;
  if (s.time) $('#time').value = s.time;
  if (s.windowMins) $('#window').value = String(s.windowMins);
  if (s.weeks) $('#weeks').value = String(s.weeks);
  if (s.minChange) $('#minChange').value = String(s.minChange);
  if (s.sort) $('#sort').value = s.sort;
  $$('input[name="day"]').forEach((c) => { c.checked = (s.days || []).includes(+c.value); });
  syncMode();
  refreshAreas(false);
  runSearch(payload());
}
restoreFromUrl();

