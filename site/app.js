// The Schrute Score dashboard. Reads only the pre-computed ./data.json — no
// API calls, no keys, no server. Rankings are re-computed here when the
// visitor changes "Your time" (same formula as src/scoring.ts `taskCost`).
'use strict';

const PAGE = 10; // rows shown at first, and added per "Show more"
const STORE_KEY = 'schrute.filters.v2';

// Earthy categorical palette (light / dark), assigned by vendor size.
const PALETTE = {
  light: ['#2f7d4f', '#c47a17', '#b34a33', '#1f7892', '#7a4b91', '#7f8c22', '#46607e', '#3d9b8f', '#8a6a3d', '#4a52a0'],
  dark: ['#6fcf8f', '#f0a93a', '#e97a5f', '#5cc1db', '#b98ad0', '#b9c64f', '#8fa8c6', '#6fd3c4', '#c9a26e', '#8f98ea'],
};

const state = {
  data: null,
  vendors: [], // [{ name, count, color }] — vendors with ranked models
  hidden: new Set(), // vendor names the visitor unchecked
  cursorOnly: false,
  task: { tokensPerTaskMillions: 0.5, fixCostUsd: 50 }, // overwritten from data.config.taskModel / storage
  sort: { key: 'rank', dir: 'asc' },
  search: '',
  limits: { bar: PAGE, table: PAGE }, // "Show more" paging
  extrasOpen: false, // "Also in Cursor, but not ranked" rows
  charts: { bar: null, scatter: null },
  barModels: [],
  ranked: [], // models sorted by cost under the current task settings
};

const $ = (sel) => document.querySelector(sel);

// ---------- persistence (per-browser convenience only) ----------
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    state.hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter((v) => typeof v === 'string') : []);
    state.cursorOnly = saved.cursorOnly === true;
    if (saved.task && Number.isFinite(saved.task.fixCostUsd) && Number.isFinite(saved.task.tokensPerTaskMillions)) {
      state.task = { fixCostUsd: saved.task.fixCostUsd, tokensPerTaskMillions: saved.task.tokensPerTaskMillions };
    }
  } catch {
    /* storage unavailable or corrupt — start with defaults */
  }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ hidden: [...state.hidden], cursorOnly: state.cursorOnly, task: state.task }));
  } catch {
    /* settings still work for this visit */
  }
}

// ---------- formatting ----------
const fmtScore = (n) => n.toFixed(1);
const fmtMoney = (n) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
// Up to 4 decimals below $1 so the math can be checked by hand.
const fmtPrice = (n) => '$' + (n >= 1 ? n.toFixed(2) : String(+n.toFixed(4)));
const pct = (n) => Math.round(n * 100) + '%';
const fmtTokens = (m) => (m >= 1 ? `${+m.toFixed(2)}M` : `${Math.round(m * 1000)}K`);
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

const estBadge = (est) =>
  est.kind === 'provisional'
    ? el('span', { class: 'badge-est badge-prov', title: est.note }, 'PROVISIONAL')
    : el('span', { class: 'badge-est', title: `Estimated score (not from the Artificial Analysis API). ${est.note}` }, 'EST.');
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

// ---------- the metric ----------
/** Same formula as src/scoring.ts `taskCost`. */
function taskCost(score, price) {
  const p = Math.min(1, Math.max(0.01, score / 100));
  const tokens = (price * state.task.tokensPerTaskMillions) / p;
  const time = (state.task.fixCostUsd * (1 - p)) / p;
  return { tokens, time, total: tokens + time };
}

/** Recomputes cost and rank for every ranked model under the current "Your time" settings. */
function rerank() {
  for (const m of state.data.models) {
    const c = taskCost(m.codingScore, m.price);
    m.cost = c.total;
    m.costTok = c.tokens;
    m.costTime = c.time;
    // Best-value level: another level above the bar that is ≥5% cheaper per task.
    m.bestLevel = null;
    let best = null;
    for (const v of m.variants ?? []) {
      v.cost = v.codingScore != null && v.price != null ? taskCost(v.codingScore, v.price).total : null;
      if (v.status === 'ranked' && v.cost != null && (!best || v.cost < best.cost)) best = v;
    }
    if (best && best.level !== m.headlineLevel && best.cost <= m.cost * 0.95) m.bestLevel = best.level;
  }
  state.ranked = [...state.data.models].sort((a, b) => a.cost - b.cost || b.codingScore - a.codingScore || a.name.localeCompare(b.name));
  state.ranked.forEach((m, i) => (m.rank = i + 1));
}

// ---------- data helpers ----------
const benchmarkKeys = () => Object.keys(state.data.config.benchmarkWeights);
const bestScore = () => state.data.quality?.bestScore ?? Math.max(...state.data.models.map((m) => m.codingScore));
const relative = (score) => score / bestScore();
const vendorShown = (vendor) => !state.hidden.has(vendor);
const isVisible = (m) => vendorShown(m.vendor) && (!state.cursorOnly || !!m.cursor);
const visibleModels = () => state.ranked.filter(isVisible);
const cursorModels = () => state.data.cursor?.models ?? [];
const levelCount = (m) => m.variants?.length ?? 1;
const leader = () => state.data.models.find((m) => m.name === state.data.quality?.bestModel);

/** Cursor models with no ranked level, shown once each below the ranking. */
const cursorExtras = () => cursorModels().filter((c) => c.status !== 'ranked' && c.status !== 'vendor-filter' && vendorShown(c.vendor));

// ---------- masthead ----------
function renderFacts() {
  const { counts, quality } = state.data;
  $('#fact-tracked').textContent = counts.fetched;
  $('#fact-ranked').textContent = counts.ranked;
  $('#fact-bar').textContent = quality && state.data.config.qualityFloor > 0 ? `≥ ${fmtScore(quality.minScore)}` : 'none';
  const inCursor = cursorModels().filter((c) => c.status === 'ranked').length;
  $('#fact-cursor').textContent = `${inCursor}/${cursorModels().length}`;
  $('#facts').hidden = false;
}

// ---------- winner card ----------
function renderHero() {
  const top = visibleModels()[0];
  $('#hero-body').hidden = !top;
  $('#hero-empty').hidden = !!top;
  $('#hero .hero-rank').hidden = !top;
  $('#hero-kicker').textContent = state.cursorOnly
    ? 'Best pick you can use in Cursor'
    : state.hidden.size
      ? 'Best pick among the vendors you selected'
      : 'Best pick right now';

  if (top) {
    $('#hero-name').textContent = top.name;
    $('#hero-badges').replaceChildren(...[top.cursor && cursorBadge(top.cursor), top.estimate && estBadge(top.estimate)].filter(Boolean));
    $('#hero-vendor').textContent =
      `by ${top.vendor}${top.releaseDate ? ` · released ${top.releaseDate}` : ''}` + (top.rank !== 1 ? ` · #${top.rank} overall` : '');
    $('#hero-cost').textContent = fmtMoney(top.cost);
    $('#hero-score').textContent = fmtScore(top.codingScore);
    $('#hero-relative').textContent = pct(relative(top.codingScore));
    $('#hero-price').textContent = fmtPrice(top.price);

    const lead = leader();
    const parts = [
      `${fmtMoney(top.costTok)} in tokens + ${fmtMoney(top.costTime)} of your time per finished task ` +
        `(at ${fmtMoney(state.task.fixCostUsd).replace('.00', '')} per fix, ${fmtTokens(state.task.tokensPerTaskMillions)} tokens per task).`,
    ];
    if (lead && lead.id !== top.id) {
      const diff = lead.cost - top.cost;
      parts.push(
        `The top scorer, ${lead.name} (${fmtScore(lead.codingScore)}), costs ${fmtMoney(lead.cost)} per task, ` +
          (diff >= 0 ? `${fmtMoney(diff)} more.` : `${fmtMoney(-diff)} less, but it's hidden by your filters.`),
      );
    } else if (lead) {
      parts.push('It is also the highest-scoring model.');
    }
    if (levelCount(top) > 1) parts.push(`Scored at its best effort level (${top.headlineLevel}).`);
    if (top.cursor) parts.push(`In Cursor, pick "${top.cursor}".`);
    if (top.estimate) {
      parts.push(
        top.estimate.kind === 'provisional'
          ? 'Its coding score is provisional: Artificial Analysis hasn\'t published it yet, so it\'s estimated (hover the badge for how).'
          : 'Its coding score is estimated by hand (hover the badge for how).',
      );
    }
    $('#hero-note').textContent = parts.join(' ');
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
    ...weights.map(([key, w]) => el('li', {}, el('strong', {}, sample.benchmarks[key]?.label ?? key), single ? '' : ` — ${pct(w / total)} of the score`)),
  );
  $('#method-weights-note').textContent = single
    ? 'This is Artificial Analysis\'s composite coding index. It combines several independent coding evaluations into one 0–100 number, and it\'s what current frontier models are measured on. Models without a result on it aren\'t ranked (unless brand-new, see below).'
    : 'Some benchmarks report 0–100 and others 0–1, so everything is converted to 0–100 first. If a model hasn\'t been tested on one of them yet, that isn\'t counted as a zero; the benchmarks it does have share the weight.';

  $('#method-floor').textContent =
    quality && config.qualityFloor > 0
      ? `To be ranked at all, a model must reach at least ${pct(config.qualityFloor)} of the best coding score. ` +
        `Right now the best is ${quality.bestModel} at ${fmtScore(quality.bestScore)}, so the bar is ${fmtScore(quality.minScore)}. ` +
        'The bar is relative, so it rises automatically as better models come out.'
      : 'There is no quality bar in the current configuration. Every model with a price and a score is ranked.';

  $('#method-price').textContent =
    `Price is the ${priceBasisLabel[config.priceBasis]} in US dollars per million tokens, as listed by Artificial Analysis. ` +
    'It ignores Cursor\'s caching discounts, and real token use per task varies by model, so treat the dollar figures as a fair comparison rather than a bill.';

  renderMethodExample();

  const cur = state.data.cursor;
  $('#method-cursor').textContent = cur
    ? `Models marked Cursor are on Cursor's model list (checked ${cur.checked}). Every effort level of a Cursor model is marked, but a model is never listed twice. ` +
      'Cursor models that aren\'t ranked (below the bar, no price, or no benchmark data) are still shown once at the end of the table, with the reason.'
    : 'No Cursor model list is configured.';

  const estimated = [...state.data.models, ...state.data.excluded].filter((m) => m.estimate?.kind === 'manual');
  const estNode = $('#method-estimates');
  estNode.replaceChildren(
    ...(estimated.length
      ? [
          el('span', {}, 'A few models aren\'t in the Artificial Analysis API, so their coding score is estimated by hand (marked '),
          estBadge({ note: '' }),
          el('span', {}, '):'),
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
  if (config.excludeModels?.length) parts.push(`And these models: ${config.excludeModels.join(', ')}.`);
  parts.push('Every excluded model is listed under "Excluded / not ranked" with its reason.');
  $('#method-exclusions').textContent = parts.join(' ');
  $('#method').hidden = false;
}

/** Worked example comparing the top scorer (or #2) with the #1 pick at the current settings. */
function renderMethodExample() {
  const top = state.ranked[0];
  const lead = leader();
  const other = lead && lead.id !== top.id ? lead : state.ranked[1];
  if (!top || !other) return;
  const line = (m) =>
    `${m.name} (score ${fmtScore(m.codingScore)}, ${fmtPrice(m.price)}/1M): ${fmtMoney(m.costTok)} tokens + ${fmtMoney(m.costTime)} your time = ${fmtMoney(m.cost)}`;
  $('#method-example').textContent =
    `Example at ${fmtMoney(state.task.fixCostUsd).replace('.00', '')} per fix and ${fmtTokens(state.task.tokensPerTaskMillions)} tokens per task — ` +
    `${line(top)}; ${line(other)}.`;
}

// ---------- toolbar ----------
function renderVendorFilters() {
  $('#cursor-only').checked = state.cursorOnly;
  $('#vendor-filters').replaceChildren(
    ...state.vendors.map((v) => {
      const input = el('input', { type: 'checkbox', checked: vendorShown(v.name), value: v.name });
      input.addEventListener('change', () => {
        if (input.checked) state.hidden.delete(v.name);
        else state.hidden.add(v.name);
        savePrefs();
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
  renderToolbarSummaries();
}

function renderToolbarSummaries() {
  const shown = state.vendors.filter((v) => vendorShown(v.name)).length;
  $('#vendor-summary').textContent = shown === state.vendors.length ? 'all' : `${shown}/${state.vendors.length}`;
  $('#pop-vendors').classList.toggle('is-filtered', shown !== state.vendors.length);
  $('#task-summary').textContent = `${fmtMoney(state.task.fixCostUsd).replace('.00', '')}/fix · ${fmtTokens(state.task.tokensPerTaskMillions)}`;
  const d = state.data.config.taskModel;
  $('#pop-task').classList.toggle('is-filtered', state.task.fixCostUsd !== d.fixCostUsd || state.task.tokensPerTaskMillions !== d.tokensPerTaskMillions);
  $('#fix-cost').value = state.task.fixCostUsd;
  $('#fix-out').textContent = fmtMoney(state.task.fixCostUsd).replace('.00', '');
  const sel = $('#task-tokens');
  const val = String(state.task.tokensPerTaskMillions);
  if (![...sel.options].some((o) => o.value === val)) sel.append(el('option', { value: val }, fmtTokens(state.task.tokensPerTaskMillions)));
  sel.value = val;
}

// ---------- table ----------
const matchesSearch = (...texts) => {
  const q = state.search.trim().toLowerCase();
  return !q || texts.some((t) => t && t.toLowerCase().includes(q));
};

function sortedTableRows() {
  const { key, dir } = state.sort;
  const rows = visibleModels().filter((m) => matchesSearch(m.name, m.vendor, m.cursor));
  const get = (m) => (key === 'relative' ? m.codingScore : m[key]);
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * mul || a.rank - b.rank;
  });
}

/** Model name cell. With `model`, hovering/focusing it shows the effort-level popover. */
function nameCell(title, { cursor, estimate, sub, model, vendor } = {}) {
  const levels = model ? levelCount(model) : 0;
  const cell = el(
    'td',
    { class: `name${levels > 1 ? ' has-levels' : ''}` },
    el('span', { class: 'model' }, title),
    cursor || estimate ? el('span', { class: 'badges' }, cursor ? cursorBadge(cursor) : null, estimate ? estBadge(estimate) : null) : null,
    vendor ? el('span', { class: 'sub show-sm' }, vendor) : null,
    sub && [sub].flat().filter(Boolean).length ? el('span', { class: 'sub' }, ...[sub].flat().filter(Boolean)) : null,
  );
  if (model) attachLevelTip(cell, model);
  return cell;
}
const vendorCell = (vendor) =>
  el('td', { class: 'col-vendor' }, el('span', { class: 'vendor-cell' }, el('span', { class: 'swatch', style: `background:${colorOf(vendor)}` }), vendor));

function costCell(m) {
  return el(
    'td',
    { class: 'num cost', title: `${fmtMoney(m.costTok)} tokens (retries included) + ${fmtMoney(m.costTime)} your time fixing failures` },
    el('strong', {}, fmtMoney(m.cost)),
  );
}

/** Shows/labels a "Show more" row for a paged list. */
function renderMore(which, total) {
  const box = $(`#${which}-more`);
  const shown = Math.min(state.limits[which], total);
  box.hidden = total <= shown;
  if (!box.hidden) {
    const next = Math.min(PAGE, total - shown);
    box.querySelector('[data-more]').textContent = `Show ${next} more`;
    box.querySelector('[data-all]').textContent = `Show all ${total}`;
  }
}

function renderTable() {
  const allRows = sortedTableRows();
  // While searching, show every match; otherwise page through the list.
  const rows = state.search.trim() ? allRows : allRows.slice(0, state.limits.table);
  renderMore('table', state.search.trim() ? 0 : allRows.length);
  $('#ranked-body').replaceChildren(
    ...rows.map((m) =>
      el(
        'tr',
        { class: m.cursor ? 'is-cursor' : '' },
        el('td', { class: 'num rank' }, String(m.rank)),
        nameCell(m.name, {
          cursor: m.cursor,
          estimate: m.estimate,
          model: m,
          vendor: m.vendor,
          sub: [
            levelCount(m) > 1 ? `${levelCount(m)} levels · scored at ${m.headlineLevel}` : null,
            m.bestLevel ? ` · "${m.bestLevel}" is cheaper per task now` : null,
          ],
        }),
        vendorCell(m.vendor),
        el('td', { class: 'num' }, fmtScore(m.codingScore)),
        el('td', { class: 'num col-rel' }, pct(relative(m.codingScore))),
        el('td', { class: 'num', title: m.priceNote ?? `${m.priceBasis} price` }, fmtPrice(m.price)),
        costCell(m),
      ),
    ),
  );

  // Cursor models without a ranked level — once each, after the ranking.
  const extras = cursorExtras().filter((c) => matchesSearch(c.name, c.vendor));
  const statusLabel = { 'below-quality-floor': 'below the bar', 'missing-price': 'no price', 'no-score': 'no score yet', 'not-in-aa': 'no data' };
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
              el(
                'button',
                { type: 'button', class: 'extras-toggle', ariaExpanded: String(state.extrasOpen), onclick: () => { state.extrasOpen = !state.extrasOpen; renderTable(); } },
                el('strong', {}, `${state.extrasOpen ? '▾' : '▸'} Also in Cursor, but not ranked (${extras.length})`),
              ),
              el('span', { class: 'muted' }, 'Cursor models that didn\'t make the ranking, each shown once with the reason.'),
            ),
          ),
          ...(state.extrasOpen || state.search.trim() ? extras : []).map((c) => {
            const r = c.representative;
            const row = r && state.data.excluded.find((e) => e.id === r.id);
            const score = r?.codingScore ?? null;
            const cost = score != null && r?.price != null ? taskCost(score, r.price).total : null;
            return el(
              'tr',
              { class: 'is-cursor' },
              el('td', { class: 'num rank' }, '—'),
              nameCell(c.name, {
                cursor: c.name,
                estimate: row?.estimate,
                model: row ?? undefined,
                vendor: c.vendor,
                sub: [
                  el('span', { class: 'status-pill', title: c.detail }, statusLabel[c.status]),
                  ' ',
                  c.status === 'below-quality-floor'
                    ? `needs ${fmtScore(state.data.quality.minScore)}` + (row && levelCount(row) > 1 ? ` · best level: ${row.headlineLevel}` : '')
                    : c.detail,
                ],
              }),
              vendorCell(c.vendor),
              el('td', { class: 'num' }, score == null ? '—' : fmtScore(score)),
              el('td', { class: 'num col-rel' }, score == null ? '—' : pct(relative(score))),
              el('td', { class: 'num' }, r?.price == null ? '—' : fmtPrice(r.price)),
              el('td', { class: 'num' }, cost == null ? '—' : fmtMoney(cost)),
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

function renderExcluded() {
  const shownAbove = new Set(cursorExtras().map((c) => c.representative?.id).filter(Boolean));
  const rows = state.data.excluded.filter((m) => vendorShown(m.vendor) && !shownAbove.has(m.id) && (!state.cursorOnly || m.cursor));
  $('#excluded-count').textContent = rows.length;
  $('#excluded-table tbody').replaceChildren(
    ...rows.map((m) =>
      el(
        'tr',
        {},
        nameCell(m.name, { cursor: m.cursor, estimate: m.estimate, model: m }),
        el('td', {}, m.vendor),
        el('td', { class: 'num' }, m.codingScore == null ? '—' : fmtScore(m.codingScore)),
        el('td', {}, m.detail),
      ),
    ),
  );
  $('#excluded-panel').hidden = false;
}

function renderCountLine() {
  const shown = visibleModels().length;
  const { counts, quality, config } = state.data;
  const bar = quality && config.qualityFloor > 0 ? `passed the quality bar (≥ ${fmtScore(quality.minScore)})` : 'are ranked';
  $('#count-line').textContent =
    `${shown} of the ${counts.ranked} models that ${bar}, cheapest per finished task first` + (state.cursorOnly ? ' · Cursor only.' : '.');
}

// ---------- effort-level popover ----------
const tipModels = new WeakMap();
let tipAnchor = null;

function attachLevelTip(cell, model) {
  tipModels.set(cell, model);
  cell.tabIndex = 0;
}

function levelTipContent(m) {
  const variants = m.variants ?? [];
  const statusText = {
    ranked: 'passes the bar',
    'below-quality-floor': 'below the bar',
    'missing-price': 'no price',
    'insufficient-benchmarks': 'no score',
    'vendor-filter': 'vendor excluded',
    'model-filter': 'excluded by hand',
  };
  const head = el('div', { class: 'tip-head' }, el('strong', {}, m.name), el('span', { class: 'muted' }, ` · ${m.vendor}`));
  const intro =
    variants.length > 1
      ? `${variants.length} effort levels tested. The ranking uses the best one (${m.headlineLevel})` +
        (m.averageScore != null ? `; the average over all levels is ${fmtScore(m.averageScore)}.` : '.')
      : 'One setting tested.';
  const rows = variants.map((v) => {
    const cost = v.codingScore != null && v.price != null ? taskCost(v.codingScore, v.price).total : null;
    return el(
      'tr',
      { class: `${v.level === m.headlineLevel ? 'is-headline' : ''}${v.level === m.bestLevel ? ' is-bestvalue' : ''}` },
      el('td', {}, v.level),
      el('td', { class: 'num' }, v.codingScore == null ? '—' : fmtScore(v.codingScore)),
      el('td', { class: 'num' }, v.price == null ? '—' : fmtPrice(v.price)),
      el('td', { class: 'num' }, cost == null ? '—' : fmtMoney(cost)),
      el('td', { class: 'muted' }, statusText[v.status] ?? v.status),
    );
  });
  const table = el(
    'table',
    { class: 'tip-table' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Level'), el('th', { class: 'num' }, 'Score'), el('th', { class: 'num' }, '$/1M'), el('th', { class: 'num' }, '$/task'), el('th', {}, ''))),
    el('tbody', {}, ...rows),
  );
  const notes = [];
  if (m.bestLevel) notes.push(el('p', { class: 'tip-win' }, `💡 Right now "${m.bestLevel}" is the cheapest level per finished task.`));
  if (m.estimate) notes.push(el('p', { class: 'muted' }, m.estimate.note));
  return [head, el('p', { class: 'tip-intro' }, intro), variants.length ? table : null, ...notes].filter(Boolean);
}

function showLevelTip(cell) {
  const m = tipModels.get(cell);
  const tip = $('#level-tip');
  if (!m || !tip) return;
  tipAnchor = cell;
  tip.replaceChildren(...levelTipContent(m));
  tip.hidden = false;
  const r = cell.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  const below = r.bottom + 6;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
}

function hideLevelTip() {
  tipAnchor = null;
  const tip = $('#level-tip');
  if (tip) tip.hidden = true;
}

// ---------- charts ----------
function chartTheme() {
  return { ink: cssVar('--ink'), muted: cssVar('--muted'), grid: cssVar('--rule'), paper: cssVar('--paper'), green: cssVar('--green'), mono: cssVar('--mono'), time: cssVar('--time') };
}

function tooltipLines(m) {
  const lines = [
    `${m.vendor}${m.cursor ? ` · in Cursor as "${m.cursor}"` : ''}`,
    `Per finished task: ${fmtMoney(m.cost)}  = ${fmtMoney(m.costTok)} tokens + ${fmtMoney(m.costTime)} your time`,
    `Coding score: ${fmtScore(m.codingScore)}${m.estimate ? (m.estimate.kind === 'provisional' ? ' (provisional)' : ' (estimate)') : ''} · ${pct(relative(m.codingScore))} of the best`,
    `Price: ${fmtPrice(m.price)} / 1M tokens (${m.priceBasis})`,
  ];
  if (levelCount(m) > 1) lines.push(`Scored at "${m.headlineLevel}" (${levelCount(m)} levels — hover the name in the table)`);
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
  const models = all.slice(0, state.limits.bar);
  state.barModels = models;
  renderMore('bar', all.length);
  const narrow = window.innerWidth < 600;
  $('#bar-wrap').style.height = `${Math.max(120, models.length * (narrow ? 20 : 24) + 44)}px`;

  const maxLen = narrow ? 18 : 40;
  const data = {
    labels: models.map((m) => (m.name.length > maxLen ? m.name.slice(0, maxLen - 1) + '…' : m.name)),
    datasets: [
      { label: 'Tokens', data: models.map((m) => m.costTok), backgroundColor: models.map((m) => colorOf(m.vendor)), borderRadius: 0, maxBarThickness: 16, stack: 'c' },
      { label: 'Your time', data: models.map((m) => m.costTime), backgroundColor: t.time, borderRadius: 0, maxBarThickness: 16, stack: 'c' },
    ],
  };
  if (state.charts.bar) {
    state.charts.bar.data = data;
    state.charts.bar.update('none');
    return;
  }
  state.charts.bar = new Chart($('#bar-chart'), {
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
            label: (item) => (item.datasetIndex === 0 ? tooltipLines(state.barModels[item.dataIndex]) : null),
          },
          filter: (item) => item.datasetIndex === 0,
        },
      },
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: 'USD per finished task (lower is better)', color: t.muted },
          ticks: { color: t.muted, font: { family: t.mono }, callback: (v) => '$' + v },
          grid: { color: t.grid },
          border: { color: t.grid },
        },
        y: {
          stacked: true,
          ticks: {
            autoSkip: false,
            color: (ctx) => (state.barModels[ctx.index]?.cursor ? t.green : t.ink),
            font: (ctx) => ({ size: narrow ? 11 : 12, weight: state.barModels[ctx.index]?.cursor ? '600' : '400' }),
          },
          grid: { display: false },
          border: { color: t.grid },
        },
      },
    },
  });
}

function renderScatter() {
  const t = chartTheme();
  const models = visibleModels();
  const minCost = Math.min(...state.ranked.map((m) => m.cost));
  const datasets = state.vendors
    .filter((v) => vendorShown(v.name))
    .map((v) => ({
      label: v.name,
      data: models
        .filter((m) => m.vendor === v.name)
        .map((m) => ({ x: m.price, y: m.codingScore, r: 4 + 12 * Math.pow(minCost / m.cost, 2), model: m })),
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
          callbacks: { title: (items) => items[0].raw.model.name, label: (item) => tooltipLines(item.raw.model) },
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
/** Re-renders everything that depends on filters or task settings. */
function refresh() {
  renderToolbarSummaries();
  renderCountLine();
  renderTable();
  if (typeof Chart !== 'undefined') {
    renderBar();
    renderScatter();
  }
  renderHero();
  renderExcluded();
  renderMethodExample();
}

function onTaskChange() {
  rerank();
  savePrefs();
  refresh();
}

function wireControls() {
  for (const btn of document.querySelectorAll('[data-select]')) {
    btn.addEventListener('click', () => {
      state.hidden = btn.dataset.select === 'all' ? new Set() : new Set(state.vendors.map((v) => v.name));
      savePrefs();
      renderVendorFilters();
      refresh();
    });
  }
  $('#cursor-only').addEventListener('change', (e) => {
    state.cursorOnly = e.target.checked;
    savePrefs();
    refresh();
  });
  $('#fix-cost').addEventListener('input', (e) => {
    state.task.fixCostUsd = Number(e.target.value);
    onTaskChange();
  });
  $('#task-tokens').addEventListener('change', (e) => {
    state.task.tokensPerTaskMillions = Number(e.target.value);
    onTaskChange();
  });
  $('#task-reset').addEventListener('click', () => {
    state.task = { ...state.data.config.taskModel };
    onTaskChange();
  });
  for (const btn of document.querySelectorAll('[data-more], [data-all]')) {
    btn.addEventListener('click', () => {
      const which = btn.dataset.more ?? btn.dataset.all;
      state.limits[which] = btn.dataset.all ? Infinity : state.limits[which] + PAGE;
      if (which === 'table') renderTable();
      else if (typeof Chart !== 'undefined') renderBar();
    });
  }
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });
  for (const th of document.querySelectorAll('#ranked-table th')) {
    th.querySelector('button').addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: ['name', 'vendor', 'rank', 'price', 'cost'].includes(key) ? 'asc' : 'desc' };
      renderTable();
    });
  }

  // Toolbar popovers: one open at a time; close on outside click or Escape.
  const pops = [...document.querySelectorAll('details.pop')];
  for (const p of pops) p.addEventListener('toggle', () => p.open && pops.forEach((o) => o !== p && (o.open = false)));

  // Level popover (hover on desktop, tap on touch, focus for keyboard).
  const cellOf = (e) => e.target.closest?.('td.name');
  document.addEventListener('pointerover', (e) => {
    const cell = cellOf(e);
    if (cell && tipModels.has(cell) && e.pointerType === 'mouse') showLevelTip(cell);
  });
  document.addEventListener('pointerout', (e) => {
    const cell = cellOf(e);
    if (cell && cell === tipAnchor && !cell.contains(e.relatedTarget) && e.pointerType === 'mouse') hideLevelTip();
  });
  document.addEventListener('focusin', (e) => {
    const cell = cellOf(e);
    if (cell && tipModels.has(cell)) showLevelTip(cell);
  });
  document.addEventListener('focusout', (e) => cellOf(e) === tipAnchor && hideLevelTip());
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('details.pop')) pops.forEach((p) => (p.open = false));
    const cell = cellOf(e);
    if (cell && tipModels.has(cell)) {
      if (tipAnchor === cell) hideLevelTip();
      else showLevelTip(cell);
    } else if (!e.target.closest?.('#level-tip')) hideLevelTip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideLevelTip();
    pops.forEach((p) => (p.open = false));
  });
  window.addEventListener('scroll', () => tipAnchor && hideLevelTip(), { passive: true });

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

  state.data.config.taskModel ??= { tokensPerTaskMillions: 0.5, fixCostUsd: 50 };
  state.task = { ...state.data.config.taskModel };
  const counts = new Map();
  for (const m of state.data.models) counts.set(m.vendor, (counts.get(m.vendor) ?? 0) + 1);
  state.vendors = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count, color: '' }));
  assignColors();
  loadPrefs();
  rerank();

  const updated = new Date(state.data.generatedAt);
  $('#updated').dateTime = state.data.generatedAt;
  $('#updated').textContent = `${updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${relativeTime(updated)})`;
  $('#strip-updated').textContent = `Updated ${relativeTime(updated)}`;

  status.hidden = true;
  $('#toolbar').hidden = false;
  $('#explore').hidden = false;
  $('#details').hidden = false;
  renderFacts();
  renderVendorFilters();
  renderMethod();

  if (typeof Chart === 'undefined') {
    for (const id of ['#bar-wrap', '.scatter-wrap']) {
      $(id).replaceChildren(el('p', { class: 'muted' }, 'Charts could not load (Chart.js blocked or offline). The table has all the data.'));
    }
  } else {
    Chart.defaults.font.family = cssVar('--sans');
    Chart.defaults.color = cssVar('--muted');
  }
  wireControls();
  refresh();
}

main();
