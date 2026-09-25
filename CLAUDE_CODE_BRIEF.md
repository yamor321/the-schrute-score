# Brief: AI Coding Model "Value" Dashboard (Cost-Benefit, Not Just Quality)

## Context

Build a public, free, automatically-updating dashboard that answers one question: **which AI coding model is most worthwhile from a cost-benefit standpoint** — not simply "which model scores highest on coding benchmarks."

The project will live in a public GitHub repository. A GitHub Actions workflow runs on a schedule (twice a day) plus on manual trigger, pulls fresh model data, computes a transparent "value" score, detects newly-released models automatically, and publishes a static dashboard to GitHub Pages. Everything must run on free infrastructure — no paid hosting, no paid APIs beyond free tiers.

This document is the complete spec. Work through the tasks in order. Ask nothing — if something is genuinely ambiguous, make the most reasonable choice, document it in the README under "Known Limitations," and move on. The one exception is the three prerequisites listed at the very end under "Before you start," which only the repo owner (not you) can supply.

---

## Data source

Use the **Artificial Analysis Data API**:

- Endpoint: `https://artificialanalysis.ai/api/v2/data/llms/models`
- Auth: header `x-api-key: <ARTIFICIAL_ANALYSIS_API_KEY>`
- Free tier: 1,000 requests/day (this project uses ~2/day, so there is huge headroom)
- Artificial Analysis commits to adding new models to their data within ~24 hours of public release — this is what gives us "automatic new-model detection" for free, without us needing to scrape release announcements ourselves.
- The response includes, per model: id, name, creator/vendor, release date, a set of benchmark scores (including a Coding Index, LiveCodeBench, Terminal-Bench, SciCode, GPQA, HLE, and others — exact field set may evolve, so code defensively), and pricing (input price, output price, and sometimes a blended price, all per million tokens).

**Hard security constraints — do not violate these under any circumstance:**

1. `ARTIFICIAL_ANALYSIS_API_KEY` is stored **only** as a GitHub Actions repository secret.
2. It must **never** be committed to the repo in any form (not in code, not in a `.env` committed by mistake, not in a config file, not in a workflow YAML literal).
3. It must **never** appear in anything served to the browser. The `site/` directory (the static dashboard) must not reference, fetch with, or embed the key anywhere — the dashboard reads only pre-computed static JSON that this pipeline generates and commits.
4. It must **never** be printed to logs (be careful with `console.log`-ing full request objects/headers, and with GitHub Actions' own log redaction — don't rely on redaction as your only safeguard, avoid logging it in the first place).

**Attribution requirement:** Artificial Analysis requires attribution when their data is displayed. The dashboard footer must credit "Data from Artificial Analysis (artificialanalysis.ai)" with a link to their site.

**Compliance ambiguity to flag, not resolve:** Artificial Analysis's pricing page mentions "redistribution rights for customer-facing products" as something associated with paid tiers. It is unclear whether a free, public, non-commercial, attributed dashboard like this one requires a paid tier or is fine under the free tier's normal terms. **Do not decide this yourself.** Create a `COMPLIANCE.md` file (Task 9) that states this ambiguity plainly and tells the repo owner to verify directly with Artificial Analysis (e.g., by emailing them or checking current ToS) before making the repo/dashboard widely public. Do not block building the project on this — just flag it clearly.

---

## Task 1 — Data source client (`src/source/artificialAnalysis.ts`)

Write a TypeScript module that fetches model data from the AA API.

- Export `async function fetchModels(): Promise<AaModel[]>`
- Define an `AaModel` type/interface that captures the fields we know we need (id, name, creator/vendor, releaseDate, benchmark scores, pricing) **but preserve all other fields returned by the API too** (e.g. spread unknown fields into a `raw`/`extra` bag, or use a permissive type) — we don't want to silently drop data we might want to use later.
- Read the API key from `process.env.ARTIFICIAL_ANALYSIS_API_KEY`. If it's missing, throw a clear error immediately (fail loud, don't silently proceed with no data).
- Implement retry with exponential backoff: max 3 attempts, but **do not retry on HTTP 401/403** (bad/missing key — retrying won't help, fail immediately with a clear message telling the user to check the secret).
- Write Vitest unit tests against a saved fixture file at `test/fixtures/aa-models-sample.json` (create a small representative fixture — a handful of models with realistic-looking fields, including at least one model with a missing/null benchmark field and one with a missing price field, since those edge cases matter for Task 3). Tests should cover: successful parse, retry-then-succeed, no-retry-on-401, and graceful handling of a model missing optional fields.

---

## Task 2 — Scoring configuration (`config/scoring.yaml`)

A starter version of this file is provided alongside this brief (see `config/scoring.yaml` in this same folder) — use it as the initial committed config. Its shape:

```yaml
excludeVendors: []          # e.g. [deepseek, qwen, google, zhipu]
benchmarkWeights:
  codingIndex: 0.5
  liveCodeBench: 0.25
  terminalBench: 0.25
priceBasis: blended          # "blended" | "input" | "output"
minBenchmarksRequired: 1
```

- `excludeVendors`: list of vendor/creator identifiers to drop entirely from the dashboard. This is how the repo owner excludes specific companies. Keep the matching case-insensitive and trim whitespace.
- `benchmarkWeights`: which benchmark fields to combine into the composite "coding score," and their relative weights. Weights need not sum to 1 (the code renormalizes — see Task 3).
- `priceBasis`: which price figure to divide by. `blended` = `(input + output) / 2` when both are present.
- `minBenchmarksRequired`: minimum number of the configured benchmark fields that must be present (non-null) for a model to be included at all. Prevents ranking a model on a single thin data point.

The repo owner will hand-edit this file over time (to add/remove excluded vendors, retune weights). Document its format clearly in the README (Task 9) so it's editable without reading code.

---

## Task 3 — Scoring engine (`src/scoring.ts`)

This is the core logic. Export:

```ts
function computeValueTable(models: AaModel[], cfg: ScoringConfig): RankedModel[]
```

**Pipeline (write this as an explicit doc-comment above the function, since it IS the transparency/methodology explanation that Task 6's "how this is calculated" page section and Task 9's README will both quote):**

1. **Vendor exclusion** — drop any model whose vendor/creator matches (case-insensitively) an entry in `excludeVendors`.
2. **Thin-evidence exclusion** — for each remaining model, count how many of the configured `benchmarkWeights` keys have a non-null value for that model. If the count is below `minBenchmarksRequired`, drop the model (and note why, for a "excluded models" debug list — don't just silently vanish them, see below).
3. **Renormalized weighted coding score** — for each model, among only the benchmark fields that are actually present for that model, renormalize the configured weights to sum to 1 (i.e., a model missing one benchmark is scored purely on the ones it has, not penalized by treating the missing one as zero), then compute the weighted average. This produces a single `codingScore` per model, always on the same 0–100-ish scale as the underlying benchmarks (do not blend it with the price yet).
4. **Price lookup** — resolve the model's price per `priceBasis`. If the resolved price is missing, zero, or negative, exclude the model from ranking (can't divide by that) — but still show it in a separate "excluded / insufficient data" list on the dashboard rather than making it disappear without explanation.
5. **Value score** — `value = codingScore / price`. Higher is better ("more coding capability per dollar").
6. Sort descending by `value`. Assign `rank`.

**Full transparency requirement:** every output row must carry the raw inputs, not just the final number — `codingScore`, each individual raw benchmark value that went into it (with which ones were missing/excluded from renormalization noted), the resolved `price`, `priceBasis` used, and `value`. The dashboard (Task 6) will display these so a user can verify the math themselves, not just trust a black-box number.

Write unit tests (Vitest) covering: vendor exclusion, thin-evidence exclusion, renormalization when a benchmark is missing (verify weights are correctly rescaled), zero/missing-price exclusion, and a golden-fixture end-to-end case with hand-computed expected values.

---

## Task 4 — New-model detection

After computing the ranked table for the current run, compare the current run's set of model `id`s against the `id`s present in the **previous** `data/latest.json` (if it exists — handle first-run-ever gracefully, treating nothing as "new" on the very first run so we don't flag the entire initial dataset).

- Any `id` present now but not in the previous `latest.json` gets a transient field `isNew: true` on its row.
- This flag is **one-cycle-only** — document this clearly in a code comment: the next run, once that model is no longer "new" relative to its own previous appearance, the flag naturally won't be set again (since detection always diffs against the immediately-prior snapshot, not some fixed "first N days" window). If the repo owner later wants a longer "new" window (e.g., stays flagged for 3 days), that's a possible future enhancement — don't build it now, just leave the code structured so it's an easy extension.

---

## Task 5 — Data output / persistence (git-as-database)

No external database — history lives in the git repo as committed JSON files.

- `data/raw/YYYY-MM-DDTHH.json` — the raw, unmodified API response for that run (for debugging/audit/reprocessing if scoring logic changes later).
- `data/history/YYYY-MM-DDTHH.json` — the computed ranked table for that run (output of Task 3 + Task 4).
- `data/latest.json` — always overwritten each run with the current computed table, plus a top-level `generatedAt` ISO timestamp field. This is the file the dashboard actually reads.
- Only commit when there's a meaningful diff (e.g., skip the commit if `data/latest.json`'s content is byte-identical aside from the timestamp — avoid noisy no-op commits twice a day forever). Comparing without the `generatedAt` field before deciding is a reasonable approach.

---

## Task 6 — Web dashboard (`site/`)

Plain HTML/CSS/vanilla JS. Chart.js via CDN `<script>` tag. **No build step, no framework** — this needs to be simple enough to keep working with zero maintenance.

Sections, top to bottom:

1. **Hero** — the #1 model by `value` score, shown prominently (name, vendor, value score, price, coding score). If any models in the current data are flagged `isNew`, show a small "NEW" badge/callout near them wherever they appear (hero if applicable, and in the table/chart below).
2. **"How this is calculated"** — a plain-language, non-technical explanation of the methodology, directly on the page (not just in a README the visitor has to go find). This section must cover, in plain words: what benchmarks are used and why, how price is factored in, what "value score" means and its formula, what a model needs to be excluded (missing data, or manually excluded by vendor), and a link/credit to Artificial Analysis as the data source. Pull this language from the same methodology description used in Task 3's doc-comment and Task 9's README, so all three stay consistent — write it once conceptually, adapt the phrasing to each audience (code comment = precise, page = plain language, README = readable + linkable).
3. **Bar chart** — horizontal bar chart, all included models ranked by `value`, color-coded by vendor, via Chart.js.
4. **Scatter/bubble chart** — x = price (log scale, since prices span a wide range), y = codingScore, bubble size = value score. Tooltip on hover shows the raw inputs (all individual benchmark values used, price, computed value) — this is where the "explain the ranking" transparency requirement really shows itself visually.
5. **Full sortable table** — every included model, with columns for rank, name, vendor, codingScore, price, value, and a NEW badge column. Include the "excluded / insufficient data" models in a separate, clearly-labeled small table or collapsible section below, each with a one-line reason (e.g. "excluded: vendor filter" / "excluded: missing price" / "excluded: below minimum benchmark count") — so nothing just silently vanishes without explanation.
6. **Filtering** — very simple: a row of vendor checkboxes above the chart/table (auto-generated from whichever vendors are present in the current data) that toggle which vendors are shown in both the chart and the table. This is client-side only, no server round-trip, no complex query builder — just show/hide.
7. **Footer** — timestamp of last update (from `data.json`'s `generatedAt`, rendered in a readable format), link to the GitHub repo, and the required Artificial Analysis attribution/link.

Technical constraints:
- Responsive down to phone width.
- Client-side fetch: `fetch('./data.json?t=' + Date.now())` (cache-bust so visitors always see the latest, since this is a static site with no server logic) reading the co-located `site/data.json` (see Task 7).
- The API key must never appear anywhere in `site/` — grep-verifiable (see Definition of Done).

---

## Task 7 — Pre-deploy data copy

Before deploying the site, copy the freshly-computed `data/latest.json` to `site/data.json`. This can be a small script (`scripts/copy-data.ts` or similar) run as a step in the workflow (Task 8) — keep `data/latest.json` (the canonical history-tracked output) and `site/data.json` (what the deployed site reads) as separate files even though their content is the same at deploy time, so the `site/` directory's only job is "what's currently published," decoupled from the data pipeline's own storage layout.

---

## Task 8 — GitHub Actions workflow (`.github/workflows/update.yml`)

- Trigger: `schedule` cron, twice daily, roughly 12 hours apart (pick two UTC hours; add a YAML comment noting the approximate Israel-time equivalent, and note that it will drift by an hour across DST changes since cron here runs in UTC, not Israel time — that's fine, no need to solve DST, just document it) — plus `workflow_dispatch` so it can be triggered manually for testing or on-demand refreshes.
- **Two jobs:**
  1. **`update-data`**: checkout → install deps → run fetch (Task 1) → run scoring (Task 3) → run new-model detection (Task 4) → write data files (Task 5). If **any** step in this job fails (API error, validation error, etc.):
     - Open or update a tracking GitHub Issue via `actions/github-script`, describing the failure (search for an existing open issue with a known label/title first, e.g. `pipeline-failure`, and update it rather than spamming a new issue every failed run; close/comment when a subsequent run succeeds again).
     - Exit non-zero.
     - **Critically: do not touch `data/latest.json`, `site/data.json`, or trigger a deploy.** Stale-but-correct data must be preserved rather than overwritten with garbage or an empty result. This is a fail-loud, not fail-silent, pipeline.
  2. **`deploy-site`**: `needs: update-data` (only runs if that job succeeded). Copies data into `site/` (Task 7), commits the changed data files (`data/raw/...`, `data/history/...`, `data/latest.json`, `site/data.json`) back to the repo (skip commit if no meaningful diff, per Task 5), then deploys `site/` via `actions/upload-pages-artifact` + `actions/deploy-pages`.
- **Permissions:** minimally scoped `permissions:` block at the workflow or job level — `contents: write` (to commit data), `issues: write` (to open/update the failure-tracking issue), `pages: write` and `id-token: write` (for Pages deployment). Nothing broader.
- The `ARTIFICIAL_ANALYSIS_API_KEY` secret is referenced only inside `update-data`'s environment for the fetch step, never passed to `deploy-site`.

---

## Task 9 — Repo docs

- **`README.md`**: project description; how the value score is calculated (mirror the Task 3 doc-comment, written for a general reader); Artificial Analysis attribution and link; how to edit `config/scoring.yaml` (exclude vendors, retune weights) with examples; how to run locally (`npm install`, `npm run update` or equivalent, with a note that `ARTIFICIAL_ANALYSIS_API_KEY` must be set in the environment for local runs); link to the live dashboard once deployed; a "Known Limitations" section (benchmark methodology can shift over time since it depends entirely on Artificial Analysis's own methodology choices; "value" is a simplification driven by the configured weights, not an objective truth; new-model detection is only as fast as Artificial Analysis's own ~24h commitment).
- **`COMPLIANCE.md`**: the Artificial Analysis redistribution-rights ambiguity, written plainly, instructing the repo owner to verify current terms directly with Artificial Analysis before treating this as a fully resolved, indefinitely-public project.
- **`LICENSE`**: MIT, unless told otherwise (see prerequisites below).

---

## Definition of Done

- [ ] `npm run update` (or equivalent) succeeds locally against the live Artificial Analysis API with a real key.
- [ ] All unit tests pass offline (fixture-based, no live network needed for tests).
- [ ] Exclusion behavior verified for: a vendor-excluded model, a model missing one benchmark (renormalization), a model missing all configured benchmarks (thin-evidence exclusion), a model missing price.
- [ ] Two full green `workflow_dispatch` runs completed in GitHub Actions (to confirm the workflow itself works end-to-end, not just the local script).
- [ ] A full repo-wide grep (including deployed `site/` output) confirms the literal API key value appears nowhere.
- [ ] Dashboard loads on GitHub Pages, shows data, filters work, charts render, methodology section is present and readable.

---

## Before you start — things I (the repo owner) still need to provide

Proceed with placeholders for these and clearly flag any that are still placeholders in the README, rather than blocking on them:

1. A free Artificial Analysis account + API key, to be added as the `ARTIFICIAL_ANALYSIS_API_KEY` GitHub Actions secret.
2. My GitHub username and the repo name to create/use.
3. Confirmation of license (defaulting to MIT if I don't say otherwise).
