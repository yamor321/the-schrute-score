// The Schrute Score dashboard. Reads only the pre-computed ./data.json — no
// API calls, no keys, no server. Everything below is presentation.
'use strict';

const BAR_DEFAULT_COUNT = 25;

const state = {
  data: null,
  vendors: [],            // [{ name, count, color }]
  selected: new Set(),    // vendor names currently shown
  sort: { key: 'rank', dir: 'asc' },
  search: '',
  barShowAll: false,
  charts: { bar: null, scatter: null },
};

const $ = (sel) => document.querySelector(sel);

// ---------- formatting ----------
const fmtScore = (n) => n.toFixed(1);
const fmtValue = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
// Up to 4 decimals below $1 so "value = score ÷ price" can be checked by hand.
const fmtPrice = (n) => '$' + (n >= 1 ? n.toFixed(2) : String(+n.toFixed(4)));
const pct = (n) => Math.round(n * 100) + '%';
const priceBasisLabel = {
  blended: 'blended (average of input and output price)',
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

// ---------- data helpers ----------
const benchmarkKeys = () => Object.keys(state.data.config.benchmarkWeights);
const coverage = (m) => m.benchmarksUsed.length;
const visibleModels = () => state.data.models.filter((m) => state.selected.has(m.vendor));

function benchmarkLines(m) {
  return benchmarkKeys().map((key) => {
    const b = m.benchmarks[key];
    if (!b || !b.present) return `${b ? b.label : key}: not tested (weight shared by the others)`;
    const raw = b.raw <= 1 && b.normalized !== b.raw ? ` (raw ${b.raw})` : '';
    return `${b.label}: ${fmtScore(b.normalized)}${raw} × ${pct(b.effectiveWeight)}`;
  });
}

// ---------- sections ----------
function renderHero() {
  const top = state.data.models[0];
  $('#hero-name').textContent = top.name;
  $('#hero-new').hidden = !top.isNew;
  $('#hero-vendor').textContent = `by ${top.vendor}${top.releaseDate ? ` · released ${top.releaseDate}` : ''}`;
  $('#hero-value').textContent = fmtValue(top.value);
  $('#hero-score').textContent = `${fmtScore(top.codingScore)} / 100`;
  $('#hero-price').textContent = fmtPrice(top.price);
  $('#hero-coverage').textContent = `${coverage(top)} of ${benchmarkKeys().length}`;

  const total = benchmarkKeys().length;
  let note = `${fmtValue(top.value)} coding-score points for every $1 per million tokens.`;
  if (coverage(top) < total) {
    note += ` Heads-up: it has results for ${coverage(top)} of the ${total} benchmarks, so its coding score rests on less evidence than models tested on all of them.`;
  }
  $('#hero-note').textContent = note;

  const fresh = state.data.models.filter((m) => m.isNew);
  const freshExcluded = state.data.excluded.filter((m) => m.isNew);
  const callout = $('#new-callout');
  if (fresh.length || freshExcluded.length) {
    callout.replaceChildren(newBadge(), ' ');
    if (fresh.length) {
      callout.append(`New since the last update: ${fresh.map((m) => `${m.name} (#${m.rank})`).join(', ')}.`);
    }
    if (freshExcluded.length) {
      callout.append(` ${freshExcluded.length} other new model${freshExcluded.length === 1 ? ' is' : 's are'} not ranked yet (see "Excluded").`);
    }
    callout.hidden = false;
  }
  $('#hero').hidden = false;
}

function renderMethod() {
  const { config } = state.data;
  const sample = state.data.models[0];
  const weights = Object.entries(config.benchmarkWeights);
  const total = weights.reduce((s, [, w]) => s + w, 0);
  $('#method-weights').replaceChildren(
    ...weights.map(([key, w]) => el('li', {}, el('strong', {}, sample.benchmarks[key]?.label ?? key), ` — ${pct(w / total)} of the score`)),
  );

  $('#method-price').textContent =
    `We use the ${priceBasisLabel[config.priceBasis]} in US dollars per million tokens, as listed by Artificial Analysis.` +
    (config.priceBasis === 'blended'
      ? ' If only one of the two prices is listed, Artificial Analysis\'s own blended price is used instead.'
      : '');

  const parts = [
    `A model is not ranked if it has results for fewer than ${config.minBenchmarksRequired} of the benchmarks above,`,
    'or if it has no price listed (or a price of $0, which usually means the price isn\'t known). A zero price would make the value infinite.',
  ];
  if (config.excludeVendors.length) {
    parts.push(`This dashboard also leaves out these vendors by choice: ${config.excludeVendors.join(', ')}.`);
  }
  parts.push('Every excluded model is listed at the bottom of the page with its reason, so nothing disappears silently.');
  $('#method-exclusions').textContent = parts.join(' ');
  $('#method').hidden = false;
}

function renderVendorFilters() {
  const list = $('#vendor-filters');
  list.replaceChildren(
    ...state.vendors.map((v) => {
      const input = el('input', { type: 'checkbox', checked: state.selected.has(v.name), value: v.name });
      input.addEventListener('change', () => {
        if (input.checked) state.selected.add(v.name);
        else state.selected.delete(v.name);
        refresh();
      });
      return el('label', { class: 'vendor-chip' }, input, el('span', { class: 'swatch', style: `background:${v.color}` }), `${v.name} (${v.count})`);
    }),
  );
}

function sortedTableRows() {
  const { key, dir } = state.sort;
  const q = state.search.trim().toLowerCase();
  const rows = visibleModels().filter((m) => !q || m.name.toLowerCase().includes(q) || m.vendor.toLowerCase().includes(q));
  const get = (m) => (key === 'coverage' ? coverage(m) : key === 'isNew' ? (m.isNew ? 1 : 0) : m[key]);
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
  const colorOf = Object.fromEntries(state.vendors.map((v) => [v.name, v.color]));
  $('#ranked-table tbody').replaceChildren(
    ...rows.map((m) => {
      const cov = coverage(m);
      return el(
        'tr',
        {},
        el('td', { class: 'num' }, String(m.rank)),
        el('td', { class: 'name', title: benchmarkLines(m).join('\n') }, m.name),
        el('td', {}, el('span', { class: 'vendor-cell' }, el('span', { class: 'swatch', style: `background:${colorOf[m.vendor]}` }), m.vendor)),
        el('td', { class: 'num' }, fmtScore(m.codingScore)),
        el('td', { class: `num${cov < total ? ' coverage-thin' : ''}`, title: benchmarkLines(m).join('\n') }, `${cov}/${total}`),
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
  const rows = state.data.excluded;
  $('#excluded-count').textContent = rows.length;
  $('#excluded-table tbody').replaceChildren(
    ...rows.map((m) =>
      el('tr', {}, el('td', {}, m.name, m.isNew ? ' ' : null, m.isNew ? newBadge() : null), el('td', {}, m.vendor), el('td', {}, m.detail)),
    ),
  );
}

function renderCountLine() {
  const shown = visibleModels().length;
  const { counts } = state.data;
  $('#count-line').textContent = `Showing ${shown} of ${counts.ranked} ranked models · ${counts.excluded} excluded · ${counts.fetched} tracked in total`;
}

// ---------- charts ----------
function chartTheme() {
  return { text: cssVar('--text'), muted: cssVar('--muted'), grid: cssVar('--border'), surface: cssVar('--surface') };
}

function tooltipLines(m) {
  return [
    `${m.vendor}${m.isNew ? ' · NEW' : ''}`,
    `Value: ${fmtValue(m.value)}  (= ${fmtScore(m.codingScore)} ÷ ${fmtPrice(m.price)})`,
    `Coding score: ${fmtScore(m.codingScore)}`,
    ...benchmarkLines(m).map((l) => '  ' + l),
    `Price: ${fmtPrice(m.price)} / 1M tokens (${m.priceBasis})` + (m.inputPrice != null && m.outputPrice != null ? ` — in ${fmtPrice(m.inputPrice)}, out ${fmtPrice(m.outputPrice)}` : ''),
  ];
}

function baseTooltip(t) {
  return {
    backgroundColor: t.surface,
    titleColor: t.text,
    bodyColor: t.text,
    borderColor: t.grid,
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
  };
}

function buildBarData() {
  const models = visibleModels();
  const shown = state.barShowAll ? models : models.slice(0, BAR_DEFAULT_COUNT);
  const toggle = $('#bar-toggle');
  toggle.hidden = models.length <= BAR_DEFAULT_COUNT;
  toggle.textContent = state.barShowAll ? `Show top ${BAR_DEFAULT_COUNT} only` : `Show all ${models.length}`;
  $('#bar-wrap').style.height = `${Math.max(120, shown.length * 22 + 40)}px`;
  return shown;
}

function renderBar() {
  const t = chartTheme();
  const models = buildBarData();
  const colorOf = Object.fromEntries(state.vendors.map((v) => [v.name, v.color]));
  const maxLen = window.innerWidth < 600 ? 22 : 42;
  const data = {
    labels: models.map((m) => (m.isNew ? '🆕 ' : '') + (m.name.length > maxLen ? m.name.slice(0, maxLen - 1) + '…' : m.name)),
    datasets: [{ data: models.map((m) => m.value), backgroundColor: models.map((m) => colorOf[m.vendor]), borderRadius: 3, barThickness: 'flex', maxBarThickness: 16 }],
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
  const byVendor = new Map();
  for (const m of models) {
    if (!byVendor.has(m.vendor)) byVendor.set(m.vendor, []);
    byVendor.get(m.vendor).push(m);
  }
  const datasets = state.vendors
    .filter((v) => byVendor.has(v.name))
    .map((v) => ({
      label: v.name,
      data: byVendor.get(v.name).map((m) => ({ x: m.price, y: m.codingScore, r: 3 + 14 * Math.sqrt(m.value / maxValue), model: m })),
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
function refresh() {
  renderCountLine();
  if (typeof Chart !== 'undefined') {
    renderBar();
    renderScatter();
  }
  renderTable();
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-select]')) {
    btn.addEventListener('click', () => {
      state.selected = btn.dataset.select === 'all' ? new Set(state.vendors.map((v) => v.name)) : new Set();
      renderVendorFilters();
      refresh();
    });
  }
  $('#bar-toggle').addEventListener('click', () => {
    state.barShowAll = !state.barShowAll;
    renderBar();
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
    renderExcluded();
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
  state.selected = new Set(state.vendors.map((v) => v.name));

  const updated = new Date(state.data.generatedAt);
  const time = $('#updated');
  time.dateTime = state.data.generatedAt;
  time.textContent = `${updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${relativeTime(updated)})`;

  status.hidden = true;
  renderHero();
  renderMethod();
  renderVendorFilters();
  renderExcluded();
  $('#explore').hidden = false;

  if (typeof Chart === 'undefined') {
    for (const id of ['#bar-wrap', '.scatter-wrap']) $(id).replaceChildren(el('p', { class: 'muted' }, 'Charts could not load (Chart.js blocked or offline). The table below has all the data.'));
    wireControls();
    refresh();
    return;
  }
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  wireControls();
  refresh();
}

main();
