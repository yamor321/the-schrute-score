// The Schrute Score dashboard. Reads only the pre-computed ./data.json — no
// API calls, no keys, no server. Everything below is presentation.
'use strict';

const BAR_DEFAULT_COUNT = 40;
const STORE_KEY = 'schrute.filters.v1';

// Earthy categorical palette (light / dark), assigned by vendor size.
const PALETTE = {
  light: ['#2f7d4f', '#c47a17', '#b34a33', '#1f7892', '#7a4b91', '#7f8c22', '#46607e', '#3d9b8f', '#8a6a3d', '#4a52a0'],
  dark: ['#6fcf8f', '#f0a93a', '#e97a5f', '#5cc1db', '#b98ad0', '#b9c64f', '#8fa8c6', '#6fd3c4', '#c9a26e', '#8f98ea'],
};

const state = {
  data: null,
  vendors: [],            // [{ name, count, color }] — vendors with ranked models
  hidden: new Set(),      // vendor names the visitor unchecked
  cursorOnly: false,
  sort: { key: 'rank', dir: 'asc' },
  search: '',
  barShowAll: false,
  charts: { bar: null, scatter: null },
};

const $ = (sel) => document.querySelector(sel);

// ---------- persistence (per-browser convenience only) ----------
function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    state.hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter((v) => typeof v === 'string') : []);
    state.cursorOnly = saved.cursorOnly === true;
  } catch {
    /* storage unavailable or corrupt — start with defaults */
  }
}
function saveFilters() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ hidden: [...state.hidden], cursorOnly: state.cursorOnly }));
  } catch {
    /* filters still work for this visit */
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
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

const newBadge = () => el('span', { class: 'badge-new', title: 'First appeared in the latest update' }, 'NEW');
const estBadge = (est) =>
  el('span', { class: 'badge-est', title: `Estimated score (not from the Artificial Analysis API). ${est.note}` }, 'EST.');
const cursorBadge = (name) =>
  el('span', { class: 'badge-cursor', title: `Available in Cursor as "${name}"` }, icon('i-pointer'), 'Cursor');

// ---------- colors ----------
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
function assignColors() {
  const palette = isDark() ? PALETTE.dark : PALETTE.light;
  state.vendors.forEach((v, i) => (v.color = palette[i % palette.length]));
}
const colorOf = (vendor) => state.vendors.find((v) => v.name === vendor)?.color ?? cssVar('--muted');
const withAlpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

// ---------- data helpers ----------
const benchmarkKeys = () => Object.keys(state.data.config.benchmarkWeights);
const coverage = (m) => m.benchmarksUsed.length;
const bestScore = () => state.data.quality?.bestScore ?? Math.max(...state.data.models.map((m) => m.codingScore));
const relative = (score) => score / bestScore();
const vendorShown = (vendor) => !state.hidden.has(vendor);
const isVisible = (m) => vendorShown(m.vendor) && (!state.cursorOnly || !!m.cursor);
const visibleModels = () => state.data.models.filter(isVisible);
const cursorModels = () => state.data.cursor?.models ?? [];

/** Cursor models with no ranked variant, shown once each below the ranking (never vendor-filtered by config). */
const cursorExtras = () => cursorModels().filter((c) => c.status !== 'ranked' && c.status !== 'vendor-filter' && vendorShown(c.vendor));

function benchmarkLines(m) {
  return benchmarkKeys().map((key) => {
    const b = m.benchmarks[key];
    if (!b || !b.present) return `${b ? b.label : key}: not tested (weight shared by the others)`;
    const raw = b.raw <= 1 && b.normalized !== b.raw ? ` (raw ${b.raw})` : '';
    const weight = benchmarkKeys().length > 1 ? ` × ${pct(b.effectiveWeight)}` : '';
    return `${b.label}: ${fmtScore(b.normalized)}${raw}${weight}`;
  });
}

// ---------- masthead ----------
function renderFacts() {
  const { counts, quality } = state.data;
  $('#fact-tracked').textContent = counts.fetched;
  $('#fact-ranked').textContent = counts.ranked;
  $('#fact-bar').textContent = quality && state.data.config.qualityFloor > 0 ? `≥ ${fmtScore(quality.minScore)}` : 'none';
  const inCursor = cursorModels().filter((c) => c.status === 'ranked').length;
  $('#fact-cursor').textContent = `${inCursor} / ${cursorModels().length}`;
  $('#facts').hidden = false;
}

// ---------- hero ----------
function renderHero() {
  const visible = visibleModels();
  const top = visible[0];
  $('#hero-body').hidden = !top;
  $('#hero-empty').hidden = !!top;
  $('#hero').querySelector('.hero-rank').hidden = !top;
  $('#hero-kicker').textContent = state.cursorOnly
    ? 'Best pick you can use in Cursor'
    : state.hidden.size
      ? 'Best pick among the vendors you selected'
      : 'Best pick right now';

  if (top) {
    $('#hero-name').textContent = top.name;
    $('#hero-badges').replaceChildren(...[top.cursor && cursorBadge(top.cursor), top.estimate && estBadge(top.estimate), top.isNew && newBadge()].filter(Boolean));
    $('#hero-vendor').textContent =
      `by ${top.vendor}${top.releaseDate ? ` · released ${top.releaseDate}` : ''}` +
      (top.rank !== 1 ? ` · #${top.rank} overall` : '');
    $('#hero-value').textContent = fmtValue(top.value);
    $('#hero-score').textContent = fmtScore(top.codingScore);
    $('#hero-relative').textContent = pct(relative(top.codingScore));
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
        `This one reaches ${pct(relative(top.codingScore))} of that score` +
        (ratio >= 1.15 ? ` for ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× less money.` : ' at a similar price.');
    }
    if (top.cursor) note += ` In Cursor, pick "${top.cursor}".`;
    if (top.estimate) note += ` Its coding score is an estimate: ${top.estimate.note}`;
    $('#hero-note').textContent = note;
  }

  const fresh = visible.filter((m) => m.isNew);
  const freshExcluded = state.data.excluded.filter((m) => m.isNew && vendorShown(m.vendor));
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

// ---------- method ----------
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
    ? 'This is Artificial Analysis\'s composite coding index. It combines several independent coding evaluations into one 0–100 number, and it\'s what current frontier models are measured on. Models without a result on it aren\'t ranked.'
    : 'Some benchmarks report 0–100 and others 0–1, so everything is converted to 0–100 first. If a model hasn\'t been tested on one of them yet, that isn\'t counted as a zero; the benchmarks it does have share the weight.';

  $('#method-floor').textContent =
    quality && config.qualityFloor > 0
      ? `To be ranked at all, a model must reach at least ${pct(config.qualityFloor)} of the best coding score. ` +
        `Right now the best is ${quality.bestModel} at ${fmtScore(quality.bestScore)}, so the bar is ${fmtScore(quality.minScore)}. ` +
        'This keeps cheap-but-weak models out: a model that is cheap only because it is much worse never wins. ' +
        'The bar is relative, so it rises automatically as better models come out.'
      : 'There is no quality bar in the current configuration. Every model with a price and a score is ranked.';

  $('#method-price').textContent =
    `We use the ${priceBasisLabel[config.priceBasis]} in US dollars per million tokens, as listed by Artificial Analysis.` +
    (config.priceBasis === 'blended' ? ' If only one of the two prices is listed, Artificial Analysis\'s own blended price is used instead.' : '');

  const cur = state.data.cursor;
  $('#method-cursor').textContent = cur
    ? `Models marked Cursor are on Cursor's model list (checked ${cur.checked}). Cursor offers each model once, and Artificial Analysis often lists several variants of it (different reasoning effort). So every variant is marked, but a model is never added twice. ` +
      'Cursor models that aren\'t ranked (below the bar, no price, or no benchmark data) are still shown once at the end of the table, with the reason.'
    : 'No Cursor model list is configured.';

  const estimated = [...state.data.models, ...state.data.excluded].filter((m) => m.estimate);
  const estNode = $('#method-estimates');
  estNode.replaceChildren(
    ...(estimated.length
      ? [
          el('span', {}, 'A few models aren\'t in the Artificial Analysis API, so their coding score is estimated by hand (marked '),
          estBadge({ note: '' }),
          el('span', {}, '). How each estimate was made:'),
          el(
            'ul',
            { class: 'weights' },
            ...estimated.map((m) =>
              el(
                'li',
                {},
                el('strong', {}, `${m.name} (≈ ${fmtScore(m.codingScore)}): `),
                m.estimate.note,
                ' ',
                ...m.estimate.sources.flatMap((url, i) => [i ? ' · ' : '', el('a', { href: url, rel: 'noopener' }, new URL(url).hostname)]),
              ),
            ),
          ),
        ]
      : []),
  );
  estNode.hidden = !estimated.length;

  const parts = ['Models below the quality bar, and models with no price listed (or $0, which usually means the price isn\'t known), aren\'t ranked.'];
  if (config.excludeVendors.length) parts.push(`The site also leaves out these vendors by choice: ${config.excludeVendors.join(', ')}.`);
  parts.push('Every excluded model is listed under "Excluded / not ranked" with its reason, so nothing disappears silently.');
  $('#method-exclusions').textContent = parts.join(' ');
  $('#method').hidden = false;
}

// ---------- filters ----------
function renderVendorFilters() {
  $('#cursor-only').checked = state.cursorOnly;
  $('#vendor-filters').replaceChildren(
    ...state.vendors.map((v) => {
      const input = el('input', { type: 'checkbox', checked: vendorShown(v.name), value: v.name });
      input.addEventListener('change', () => {
        if (input.checked) state.hidden.delete(v.name);
        else state.hidden.add(v.name);
        saveFilters();
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

// ---------- table ----------
const matchesSearch = (...texts) => {
  const q = state.search.trim().toLowerCase();
  return !q || texts.some((t) => t && t.toLowerCase().includes(q));
};

function sortedTableRows() {
  const { key, dir } = state.sort;
  const rows = visibleModels().filter((m) => matchesSearch(m.name, m.vendor, m.cursor));
  const get = (m) =>
    key === 'coverage' ? coverage(m) : key === 'relative' ? m.codingScore : m[key];
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * mul || a.rank - b.rank;
  });
}

function nameCell(title, { cursor, isNew, estimate, sub, tooltip } = {}) {
  return el(
    'td',
    { class: 'name', title: tooltip ?? '' },
    el('span', { class: 'model' }, title),
    cursor || isNew || estimate
      ? el('span', { class: 'badges' }, cursor ? cursorBadge(cursor) : null, estimate ? estBadge(estimate) : null, isNew ? newBadge() : null)
      : null,
    sub ? el('span', { class: 'sub' }, ...[sub].flat()) : null,
  );
}
const vendorCell = (vendor) =>
  el('td', {}, el('span', { class: 'vendor-cell' }, el('span', { class: 'swatch', style: `background:${colorOf(vendor)}` }), vendor));

function renderTable() {
  const total = benchmarkKeys().length;
  const rows = sortedTableRows();
  $('#ranked-table').classList.toggle('single-benchmark', total === 1);
  $('#ranked-body').replaceChildren(
    ...rows.map((m) => {
      const cov = coverage(m);
      return el(
        'tr',
        { class: m.cursor ? 'is-cursor' : '' },
        el('td', { class: 'num rank' }, String(m.rank)),
        nameCell(m.name, {
          cursor: m.cursor,
          isNew: m.isNew,
          estimate: m.estimate,
          sub: m.cursor && modelKeyLoose(m.cursor) !== modelKeyLoose(m.name) ? `In Cursor: ${m.cursor}` : null,
          tooltip: benchmarkLines(m).join('\n'),
        }),
        vendorCell(m.vendor),
        el('td', { class: 'num' }, fmtScore(m.codingScore)),
        el('td', { class: 'num' }, pct(relative(m.codingScore))),
        el('td', { class: `num col-coverage${cov < total ? ' coverage-thin' : ''}`, title: benchmarkLines(m).join('\n') }, `${cov}/${total}`),
        el('td', { class: 'num', title: m.priceNote ?? `${m.priceBasis} price` }, fmtPrice(m.price)),
        el('td', { class: 'num value' }, el('strong', {}, fmtValue(m.value))),
      );
    }),
  );

  // Cursor models without a ranked variant — once each, after the ranking.
  const extras = cursorExtras().filter((c) => matchesSearch(c.name, c.vendor, c.representative?.name));
  const statusLabel = {
    'below-quality-floor': 'below the bar',
    'missing-price': 'no price',
    'no-score': 'no score yet',
    'not-in-aa': 'no data',
  };
  const order = { 'below-quality-floor': 0, 'missing-price': 1, 'no-score': 2, 'not-in-aa': 3 };
  extras.sort((a, b) => order[a.status] - order[b.status] || (b.representative?.codingScore ?? -1) - (a.representative?.codingScore ?? -1));
  const cols = $('#ranked-table thead tr').children.length;
  $('#cursor-extra-body').replaceChildren(
    ...(extras.length
      ? [
          el(
            'tr',
            { class: 'divider' },
            el(
              'td',
              { colSpan: cols },
              el('strong', {}, 'Also in Cursor, but not ranked'),
              el('span', { class: 'muted' }, `${extras.length} Cursor models that didn't make the ranking. Each is shown once, with the reason.`),
            ),
          ),
          ...extras.map((c) => {
            const r = c.representative;
            const score = r?.codingScore ?? null;
            return el(
              'tr',
              { class: 'is-cursor' },
              el('td', { class: 'num rank' }, '—'),
              nameCell(c.name, {
                cursor: c.name,
                sub: [
                  el('span', { class: 'status-pill', title: c.detail }, statusLabel[c.status]),
                  ' ',
                  c.status === 'below-quality-floor'
                    ? `needs ${fmtScore(state.data.quality.minScore)}` + (r.name !== c.name ? ` · best variant: ${r.name}` : '')
                    : c.detail,
                ],
              }),
              vendorCell(c.vendor),
              el('td', { class: 'num' }, score == null ? '—' : fmtScore(score)),
              el('td', { class: 'num' }, score == null ? '—' : pct(relative(score))),
              el('td', { class: 'num col-coverage' }, '—'),
              el('td', { class: 'num' }, r?.price == null ? '—' : fmtPrice(r.price)),
              el('td', { class: 'num' }, r?.value == null ? '—' : fmtValue(r.value)),
            );
          }),
        ]
      : []),
  );
  $('#table-empty').hidden = rows.length + extras.length > 0;

  for (const th of document.querySelectorAll('#ranked-table th')) {
    if (th.dataset.key === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
}

/** Loose name comparison (mirrors src/cursor.ts modelKey) to skip a redundant "In Cursor:" line. */
function modelKeyLoose(name) {
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

function renderExcluded() {
  // Cursor models already shown once in the table aren't repeated here.
  const shownAbove = new Set(cursorExtras().map((c) => c.representative?.id).filter(Boolean));
  const rows = state.data.excluded.filter((m) => vendorShown(m.vendor) && !shownAbove.has(m.id) && (!state.cursorOnly || m.cursor));
  $('#excluded-count').textContent = rows.length;
  $('#excluded-table tbody').replaceChildren(
    ...rows.map((m) =>
      el(
        'tr',
        {},
        nameCell(m.name, { cursor: m.cursor, isNew: m.isNew }),
        el('td', {}, m.vendor),
        el('td', { class: 'num' }, m.codingScore == null ? '—' : fmtScore(m.codingScore)),
        el('td', {}, m.detail),
      ),
    ),
  );
}

function renderCountLine() {
  const shown = visibleModels().length;
  const { counts, quality, config } = state.data;
  const bar = quality && config.qualityFloor > 0 ? `passed the quality bar (≥ ${fmtScore(quality.minScore)})` : 'are ranked';
  $('#count-line').textContent =
    `Showing ${shown} of the ${counts.ranked} models that ${bar}` + (state.cursorOnly ? ', limited to models available in Cursor.' : '.');
}

// ---------- charts ----------
function chartTheme() {
  return { ink: cssVar('--ink'), muted: cssVar('--muted'), grid: cssVar('--rule'), paper: cssVar('--paper'), green: cssVar('--green'), mono: cssVar('--mono') };
}

function tooltipLines(m) {
  const lines = [
    `${m.vendor}${m.isNew ? ' · NEW' : ''}${m.cursor ? ` · in Cursor as "${m.cursor}"` : ''}`,
    `Value: ${fmtValue(m.value)}  (= ${fmtScore(m.codingScore)} ÷ ${fmtPrice(m.price)})`,
    `Coding score: ${fmtScore(m.codingScore)}${m.estimate ? ' (ESTIMATE)' : ''} (${pct(relative(m.codingScore))} of the best)`,
  ];
  if (m.estimate) lines.push('  Not from the Artificial Analysis API; see the methodology section.');
  if (benchmarkKeys().length > 1) lines.push(...benchmarkLines(m).map((l) => '  ' + l));
  lines.push(
    `Price: ${fmtPrice(m.price)} / 1M tokens (${m.priceBasis})` +
      (m.inputPrice != null && m.outputPrice != null ? ` — in ${fmtPrice(m.inputPrice)}, out ${fmtPrice(m.outputPrice)}` : ''),
  );
  return lines;
}

function baseTooltip(t) {
  return {
    backgroundColor: t.paper,
    titleColor: t.ink,
    bodyColor: t.ink,
    borderColor: t.grid,
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    titleFont: { weight: '600' },
    bodyFont: { family: t.mono, size: 12 },
  };
}

function renderBar() {
  const t = chartTheme();
  const all = visibleModels();
  const models = state.barShowAll ? all : all.slice(0, BAR_DEFAULT_COUNT);
  state.barModels = models;
  const toggle = $('#bar-toggle');
  toggle.hidden = all.length <= BAR_DEFAULT_COUNT;
  toggle.textContent = state.barShowAll ? `Show top ${BAR_DEFAULT_COUNT} only` : `Show all ${all.length}`;
  $('#bar-wrap').style.height = `${Math.max(120, models.length * 24 + 44)}px`;

  const maxLen = window.innerWidth < 600 ? 22 : 44;
  const data = {
    labels: models.map((m) => (m.isNew ? '🆕 ' : '') + (m.name.length > maxLen ? m.name.slice(0, maxLen - 1) + '…' : m.name)),
    datasets: [{ data: models.map((m) => m.value), backgroundColor: models.map((m) => colorOf(m.vendor)), borderRadius: 2, maxBarThickness: 18 }],
  };
  if (state.charts.bar) {
    state.charts.bar.data = data;
    state.barModels = models;
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
            title: (items) => state.barModels[items[0].dataIndex].name,
            label: (item) => tooltipLines(state.barModels[item.dataIndex]),
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Value score (coding score ÷ price)', color: t.muted },
          ticks: { color: t.muted, font: { family: t.mono } },
          grid: { color: t.grid },
          border: { color: t.grid },
        },
        y: {
          ticks: {
            autoSkip: false,
            // Cursor models: green + bold label.
            color: (ctx) => (state.barModels[ctx.index]?.cursor ? t.green : t.ink),
            font: (ctx) => ({ size: 12, weight: state.barModels[ctx.index]?.cursor ? '600' : '400' }),
          },
          grid: { display: false },
          border: { color: t.grid },
        },
      },
    },
  });

  state.charts.bar = chart;
}

function renderScatter() {
  const t = chartTheme();
  const models = visibleModels();
  const maxValue = Math.max(...state.data.models.map((m) => m.value));
  const datasets = state.vendors
    .filter((v) => vendorShown(v.name))
    .map((v) => ({
      label: v.name,
      data: models
        .filter((m) => m.vendor === v.name)
        .map((m) => ({ x: m.price, y: m.codingScore, r: 5 + 13 * Math.sqrt(m.value / maxValue), model: m })),
      backgroundColor: withAlpha(v.color, 0.5),
      borderColor: v.color,
      borderWidth: (ctx) => (ctx.raw?.model?.cursor ? 2 : 1),
      pointStyle: (ctx) => (ctx.raw?.model?.cursor ? 'rectRot' : 'circle'),
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
          ticks: { color: t.muted, font: { family: t.mono }, callback: (v) => ([0.1, 0.3, 1, 3, 10, 30, 100].includes(+v) ? '$' + v : '') },
          grid: { color: t.grid },
          border: { color: t.grid },
        },
        y: {
          title: { display: true, text: 'Coding score', color: t.muted },
          ticks: { color: t.muted, font: { family: t.mono } },
          grid: { color: t.grid },
          border: { color: t.grid },
        },
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
/** Re-renders everything that depends on the filters. */
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
      saveFilters();
      renderVendorFilters();
      refresh();
    });
  }
  $('#cursor-only').addEventListener('change', (e) => {
    state.cursorOnly = e.target.checked;
    saveFilters();
    refresh();
  });
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
    assignColors();
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
    .map(([name, count]) => ({ name, count, color: '' }));
  assignColors();
  loadFilters();

  const updated = new Date(state.data.generatedAt);
  const stamp = updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('#updated').dateTime = state.data.generatedAt;
  $('#updated').textContent = `${stamp} (${relativeTime(updated)})`;
  $('#strip-updated').textContent = `Updated ${relativeTime(updated)}`;

  status.hidden = true;
  $('#filters-card').hidden = false;
  $('#explore').hidden = false;
  renderFacts();
  renderVendorFilters();
  renderMethod();

  if (typeof Chart === 'undefined') {
    for (const id of ['#bar-wrap', '.scatter-wrap']) {
      $(id).replaceChildren(el('p', { class: 'muted' }, 'Charts could not load (Chart.js blocked or offline). The table above has all the data.'));
    }
  } else {
    Chart.defaults.font.family = cssVar('--sans');
    Chart.defaults.color = cssVar('--muted');
  }
  wireControls();
  refresh();
}

main();
