// The Schrute Score dashboard. Reads only the pre-computed ./data.json — no
// API calls, no keys, no server. Everything below is presentation.
'use strict';

const BAR_DEFAULT_COUNT = 40;
const HIDDEN_KEY = 'schrute.hiddenVendors';

const state = {
  data: null,
  vendors: [],            // [{ name, count, color }] — vendors with ranked models
  hidden: new Set(),      // vendor names the visitor unchecked (persisted)
  sort: { key: 'rank', dir: 'asc' },
  search: '',
  barShowAll: false,
  charts: { bar: null, scatter: null },
};

const $ = (sel) => document.querySelector(sel);

// ---------- persistence (per-browser convenience only) ----------
function loadHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
  } catch {
    /* storage unavailable — filter still works for this visit */
  }
}

// ---------- formatting ----------
const fmtScore = (n) => n.toFixed(1);
const fmtValue = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
// Up to 4 decimals below $1 so "value = score ÷ price" can be checked by hand.
const fmtPrice = (n) => '$' + (n >= 1 ? n.toFixed(2) : String(+n.toFixed(4)));
const pct = (n) => Math.round(n * 100) + '%';
const priceBasisLabel = {
  blended: 'blended price (the average of the input and output price)',
  input: 'input price',
  output: 'output price',
};

function relativeTime(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const newBadge = () => el('span', { class: 'badge-new', title: 'First appeared in the latest update' }, 'NEW');

// ---------- colors ----------
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Stable hue per vendor name so a vendor keeps its color across updates. */
function vendorColor(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = (h * 137.508) % 360;
  return isDark() ? `hsl(${hue.toFixed(0)} 60% 64%)` : `hsl(${hue.toFixed(0)} 58% 44%)`;
}
const colorOf = (vendor) => state.vendors.find((v) => v.name === vendor)?.color ?? cssVar('--muted');

// ---------- data helpers ----------
const benchmarkKeys = () => Object.keys(state.data.config.benchmarkWeights);
const coverage = (m) => m.benchmarksUsed.length;
const bestScore = () => state.data.quality?.bestScore ?? Math.max(...state.data.models.map((m) => m.codingScore));
const relative = (m) => m.codingScore / bestScore();
const isVisible = (m) => !state.hidden.has(m.vendor);
const visibleModels = () => state.data.models.filter(isVisible);

function benchmarkLines(m) {
  return benchmarkKeys().map((key) => {
    const b = m.benchmarks[key];
    if (!b || !b.present) return `${b ? b.label : key}: not tested (weight shared by the others)`;
    const raw = b.raw <= 1 && b.normalized !== b.raw ? ` (raw ${b.raw})` : '';
    const weight = benchmarkKeys().length > 1 ? ` × ${pct(b.effectiveWeight)}` : '';
    return `${b.label}: ${fmtScore(b.normalized)}${raw}${weight}`;
  });
}

// ---------- sections ----------
function renderHero() {
  const visible = visibleModels();
  const top = visible[0];
  $('#hero-body').hidden = !top;
  $('#hero-empty').hidden = !!top;
  $('#hero-kicker').textContent = state.hidden.size ? 'Best pick among the vendors you selected' : 'Best pick right now';
  if (top) {
    $('#hero-name').textContent = top.name;
    $('#hero-new').hidden = !top.isNew;
    $('#hero-vendor').textContent = `by ${top.vendor}${top.releaseDate ? ` · released ${top.releaseDate}` : ''}`;
    $('#hero-value').textContent = fmtValue(top.value);
    $('#hero-score').textContent = `${fmtScore(top.codingScore)} / 100`;
    $('#hero-relative').textContent = pct(relative(top));
    $('#hero-price').textContent = fmtPrice(top.price);

    const q = state.data.quality;
    const leader = q && state.data.models.find((m) => m.name === q.bestModel);
    let note;
    if (!leader || leader.id === top.id) {
      note = 'This is also the highest-scoring model on coding. Nothing close to it is meaningfully cheaper.';
    } else {
      const ratio = leader.price / top.price;
      note =
        `The top-scoring model, ${leader.name}, scores ${fmtScore(leader.codingScore)} at ${fmtPrice(leader.price)} per 1M tokens. ` +
        `This one reaches ${pct(relative(top))} of that score` +
        (ratio >= 1.15 ? ` for ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× less money.` : ' at a similar price.');
    }
    $('#hero-note').textContent = note;
  }

  const fresh = visible.filter((m) => m.isNew);
  const freshExcluded = state.data.excluded.filter((m) => m.isNew && isVisible(m));
  const callout = $('#new-callout');
  callout.hidden = !(fresh.length || freshExcluded.length);
  if (!callout.hidden) {
    callout.replaceChildren(newBadge(), ' ');
    if (fresh.length) callout.append(`New since the last update: ${fresh.map((m) => `${m.name} (#${m.rank})`).join(', ')}.`);
    if (freshExcluded.length) {
      callout.append(` ${freshExcluded.length} other new model${freshExcluded.length === 1 ? ' is' : 's are'} not ranked (see "Excluded").`);
    }
  }
  $('#hero').hidden = false;
}

function renderMethod() {
  const { config, quality } = state.data;
  const sample = state.data.models[0];
  const weights = Object.entries(config.benchmarkWeights);
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const single = weights.length === 1;
  $('#method-weights').replaceChildren(
    ...weights.map(([key, w]) =>
      el('li', {}, el('strong', {}, sample.benchmarks[key]?.label ?? key), single ? '' : ` — ${pct(w / total)} of the score`),
    ),
  );
  $('#method-weights-note').textContent = single
    ? 'This is Artificial Analysis\'s composite coding index. It combines several independent coding evaluations into one number on a 0–100 scale, and it\'s what current frontier models are measured on. Models without a result on it aren\'t ranked.'
    : 'Some benchmarks report 0–100 and others 0–1, so everything is converted to 0–100 first. If a model hasn\'t been tested on one of them yet, that isn\'t counted as a zero; the benchmarks it does have share the weight.';

  $('#method-floor').textContent = quality && config.qualityFloor > 0
    ? `To be ranked at all, a model must reach at least ${pct(config.qualityFloor)} of the best coding score. ` +
      `Right now the best is ${quality.bestModel} at ${fmtScore(quality.bestScore)}, so the bar is ${fmtScore(quality.minScore)}. ` +
      'This keeps cheap-but-weak models out: a model that is cheap only because it is much worse never wins. ' +
      'The bar is relative, so it rises automatically as better models come out.'
    : 'There is no quality bar in the current configuration. Every model with a price and a score is ranked.';

  $('#method-price').textContent =
    `We use the ${priceBasisLabel[config.priceBasis]} in US dollars per million tokens, as listed by Artificial Analysis.` +
    (config.priceBasis === 'blended' ? ' If only one of the two prices is listed, Artificial Analysis\'s own blended price is used instead.' : '');

  const parts = [
    'Models below the quality bar, and models with no price listed (or $0, which usually means the price isn\'t known), aren\'t ranked.',
  ];
  if (config.excludeVendors.length) parts.push(`The site also leaves out these vendors by choice: ${config.excludeVendors.join(', ')}.`);
  parts.push('Every excluded model is listed at the bottom of the page with its reason, so nothing disappears silently.');
  $('#method-exclusions').textContent = parts.join(' ');
  $('#method').hidden = false;
}

function renderVendorFilters() {
  $('#vendor-filters').replaceChildren(
    ...state.vendors.map((v) => {
      const input = el('input', { type: 'checkbox', checked: !state.hidden.has(v.name), value: v.name });
      input.addEventListener('change', () => {
        if (input.checked) state.hidden.delete(v.name);
        else state.hidden.add(v.name);
        saveHidden();
        refresh();
      });
      return el(
        'label',
        { class: 'vendor-chip', title: `${v.count} ranked model${v.count === 1 ? '' : 's'}` },
        input,
        el('span', { class: 'swatch', style: `background:${v.color}` }),
        el('span', { class: 'vendor-name' }, v.name),
        el('span', { class: 'vendor-count' }, String(v.count)),
      );
    }),
  );
}

function sortedTableRows() {
  const { key, dir } = state.sort;
  const q = state.search.trim().toLowerCase();
  const rows = visibleModels().filter((m) => !q || m.name.toLowerCase().includes(q) || m.vendor.toLowerCase().includes(q));
  const get = (m) =>
    key === 'coverage' ? coverage(m) : key === 'relative' ? m.codingScore : key === 'isNew' ? (m.isNew ? 1 : 0) : m[key];
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * mul || a.rank - b.rank;
  });
}

function renderTable() {
  const total = benchmarkKeys().length;
  const rows = sortedTableRows();
  $('#ranked-table').classList.toggle('single-benchmark', total === 1);
  $('#ranked-table tbody').replaceChildren(
    ...rows.map((m) => {
      const cov = coverage(m);
      return el(
        'tr',
        {},
        el('td', { class: 'num' }, String(m.rank)),
        el('td', { class: 'name', title: benchmarkLines(m).join('\n') }, m.name),
        el('td', {}, el('span', { class: 'vendor-cell' }, el('span', { class: 'swatch', style: `background:${colorOf(m.vendor)}` }), m.vendor)),
        el('td', { class: 'num' }, fmtScore(m.codingScore)),
        el('td', { class: 'num' }, pct(relative(m))),
        el('td', { class: `num col-coverage${cov < total ? ' coverage-thin' : ''}`, title: benchmarkLines(m).join('\n') }, `${cov}/${total}`),
        el('td', { class: 'num', title: m.priceNote ?? `${m.priceBasis} price` }, fmtPrice(m.price)),
        el('td', { class: 'num' }, el('strong', {}, fmtValue(m.value))),
        el('td', {}, m.isNew ? newBadge() : ''),
      );
    }),
  );
  $('#table-empty').hidden = rows.length > 0;

  for (const th of document.querySelectorAll('#ranked-table th')) {
    if (th.dataset.key === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
}

function renderExcluded() {
  const rows = state.data.excluded.filter(isVisible);
  $('#excluded-count').textContent = rows.length;
  $('#excluded-table tbody').replaceChildren(
    ...rows.map((m) =>
      el(
        'tr',
        {},
        el('td', {}, m.name, m.isNew ? ' ' : null, m.isNew ? newBadge() : null),
        el('td', {}, m.vendor),
        el('td', { class: 'num' }, m.codingScore == null ? '—' : fmtScore(m.codingScore)),
        el('td', {}, m.detail),
      ),
    ),
  );
}

function renderCountLine() {
  const shown = visibleModels().length;
  const { counts } = state.data;
  const floor = state.data.quality && state.data.config.qualityFloor > 0 ? ` passed the quality bar (≥ ${fmtScore(state.data.quality.minScore)})` : ' ranked';
  $('#count-line').textContent = `Showing ${shown} of ${counts.ranked} models that${floor} · ${counts.fetched} tracked in total`;
}

// ---------- charts ----------
function chartTheme() {
  return { text: cssVar('--text'), muted: cssVar('--muted'), grid: cssVar('--border'), surface: cssVar('--surface') };
}

function tooltipLines(m) {
  const lines = [
    `${m.vendor}${m.isNew ? ' · NEW' : ''}`,
    `Value: ${fmtValue(m.value)}  (= ${fmtScore(m.codingScore)} ÷ ${fmtPrice(m.price)})`,
    `Coding score: ${fmtScore(m.codingScore)} (${pct(relative(m))} of the best)`,
  ];
  if (benchmarkKeys().length > 1) lines.push(...benchmarkLines(m).map((l) => '  ' + l));
  lines.push(
    `Price: ${fmtPrice(m.price)} / 1M tokens (${m.priceBasis})` +
      (m.inputPrice != null && m.outputPrice != null ? ` — in ${fmtPrice(m.inputPrice)}, out ${fmtPrice(m.outputPrice)}` : ''),
  );
  return lines;
}

function baseTooltip(t) {
  return { backgroundColor: t.surface, titleColor: t.text, bodyColor: t.text, borderColor: t.grid, borderWidth: 1, padding: 10, boxPadding: 4 };
}

function renderBar() {
  const t = chartTheme();
  const all = visibleModels();
  const models = state.barShowAll ? all : all.slice(0, BAR_DEFAULT_COUNT);
  const toggle = $('#bar-toggle');
  toggle.hidden = all.length <= BAR_DEFAULT_COUNT;
  toggle.textContent = state.barShowAll ? `Show top ${BAR_DEFAULT_COUNT} only` : `Show all ${all.length}`;
  $('#bar-wrap').style.height = `${Math.max(120, models.length * 24 + 40)}px`;

  const maxLen = window.innerWidth < 600 ? 22 : 42;
  const data = {
    labels: models.map((m) => (m.isNew ? '🆕 ' : '') + (m.name.length > maxLen ? m.name.slice(0, maxLen - 1) + '…' : m.name)),
    datasets: [{ data: models.map((m) => m.value), backgroundColor: models.map((m) => colorOf(m.vendor)), borderRadius: 3, maxBarThickness: 18 }],
  };
  if (state.charts.bar) {
    state.charts.bar.data = data;
    state.charts.bar.$models = models;
    state.charts.bar.update('none');
    return;
  }
  const chart = new Chart($('#bar-chart'), {
    type: 'bar',
    data,
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...baseTooltip(t),
          callbacks: {
            title: (items) => chart.$models[items[0].dataIndex].name,
            label: (item) => tooltipLines(chart.$models[item.dataIndex]),
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Value score (coding score ÷ price)', color: t.muted }, ticks: { color: t.muted }, grid: { color: t.grid } },
        y: { ticks: { color: t.text, autoSkip: false, font: { size: 12 } }, grid: { display: false } },
      },
    },
  });
  chart.$models = models;
  state.charts.bar = chart;
}

function renderScatter() {
  const t = chartTheme();
  const models = visibleModels();
  const maxValue = Math.max(...state.data.models.map((m) => m.value));
  const datasets = state.vendors
    .filter((v) => !state.hidden.has(v.name))
    .map((v) => ({
      label: v.name,
      data: models
        .filter((m) => m.vendor === v.name)
        .map((m) => ({ x: m.price, y: m.codingScore, r: 4 + 14 * Math.sqrt(m.value / maxValue), model: m })),
      backgroundColor: v.color.replace(')', ' / 0.55)'),
      borderColor: v.color,
      borderWidth: 1,
      hoverBorderWidth: 2,
    }));

  if (state.charts.scatter) {
    state.charts.scatter.data.datasets = datasets;
    state.charts.scatter.update('none');
    return;
  }
  state.charts.scatter = new Chart($('#scatter-chart'), {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...baseTooltip(t),
          callbacks: {
            title: (items) => items[0].raw.model.name,
            label: (item) => tooltipLines(item.raw.model),
          },
        },
      },
      scales: {
        x: {
          type: 'logarithmic',
          title: { display: true, text: 'Price per 1M tokens (USD, log scale)', color: t.muted },
          ticks: { color: t.muted, callback: (v) => ([0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100].includes(+v) ? '$' + v : '') },
          grid: { color: t.grid },
        },
        y: { title: { display: true, text: 'Coding score (0–100)', color: t.muted }, ticks: { color: t.muted }, grid: { color: t.grid } },
      },
    },
  });
}

function destroyCharts() {
  for (const k of Object.keys(state.charts)) {
    state.charts[k]?.destroy();
    state.charts[k] = null;
  }
}

// ---------- wiring ----------
/** Re-renders everything that depends on the vendor filter. */
function refresh() {
  renderHero();
  renderCountLine();
  if (typeof Chart !== 'undefined') {
    renderBar();
    renderScatter();
  }
  renderTable();
  renderExcluded();
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-select]')) {
    btn.addEventListener('click', () => {
      state.hidden = btn.dataset.select === 'all' ? new Set() : new Set(state.vendors.map((v) => v.name));
      saveHidden();
      renderVendorFilters();
      refresh();
    });
  }
  $('#bar-toggle').addEventListener('click', () => {
    state.barShowAll = !state.barShowAll;
    if (typeof Chart !== 'undefined') renderBar();
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });
  for (const th of document.querySelectorAll('#ranked-table th')) {
    th.querySelector('button').addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: ['name', 'vendor', 'rank', 'price'].includes(key) ? 'asc' : 'desc' };
      renderTable();
    });
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const v of state.vendors) v.color = vendorColor(v.name);
    renderVendorFilters();
    destroyCharts();
    refresh();
  });
}

async function main() {
  const status = $('#status');
  try {
    const res = await fetch('./data.json?t=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    if (!state.data.models?.length) throw new Error('no ranked models in data.json');
  } catch (err) {
    status.textContent = `Couldn't load the rankings (${err.message}). Please try again later.`;
    status.classList.add('error');
    return;
  }

  const counts = new Map();
  for (const m of state.data.models) counts.set(m.vendor, (counts.get(m.vendor) ?? 0) + 1);
  state.vendors = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count, color: vendorColor(name) }));
  state.hidden = loadHidden();

  const updated = new Date(state.data.generatedAt);
  const time = $('#updated');
  time.dateTime = state.data.generatedAt;
  time.textContent = `${updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${relativeTime(updated)})`;

  status.hidden = true;
  $('#filters-card').hidden = false;
  $('#explore').hidden = false;
  renderVendorFilters();
  renderMethod();

  if (typeof Chart === 'undefined') {
    for (const id of ['#bar-wrap', '.scatter-wrap']) {
      $(id).replaceChildren(el('p', { class: 'muted' }, 'Charts could not load (Chart.js blocked or offline). The table below has all the data.'));
    }
  } else {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  }
  wireControls();
  refresh();
}

main();
