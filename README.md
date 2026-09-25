# The Schrute Score

**The best AI coding model, at the most sensible price.**

This dashboard isn't looking for the cheapest model, and it isn't only about the top benchmark score either. Only models close to the top on coding qualify, so no cheap-but-weak picks. Among those, the one that gives the most for the money ranks first. It updates itself twice a day from [Artificial Analysis](https://artificialanalysis.ai) data. Each run finds newly released models, recomputes a transparent **value score**, and publishes a static site to GitHub Pages. It all runs on free infrastructure.

**Live dashboard:** https://yamor321.github.io/the-schrute-score/ *(live after the first successful deploy; see [Setup](#setup-one-time))*

> Data from [Artificial Analysis (artificialanalysis.ai)](https://artificialanalysis.ai). The value score is this project's own calculation, not an Artificial Analysis metric. Before promoting the dashboard widely, read [COMPLIANCE.md](COMPLIANCE.md).

---

## How the value score is calculated

The precise version is the doc comment on `computeValueTable` in [`src/scoring.ts`](src/scoring.ts). The dashboard's "How this is calculated" section explains the same steps in plain language.

1. **Drop excluded vendors.** Any model whose creator matches `excludeVendors` in [`config/scoring.yaml`](config/scoring.yaml) is removed. Matching is case-insensitive and ignores surrounding spaces. It checks both the display name (`Google`) and the slug (`google`).
2. **Drop models with too little evidence.** The code counts how many of the configured benchmarks the model actually has results for. Fewer than `minBenchmarksRequired` means the model is excluded.
3. **Compute a coding score (0–100).** Every benchmark is first put on a 0–100 scale. Artificial Analysis's indexes are already 0–100; single benchmarks like LiveCodeBench come as 0–1 fractions and are multiplied by 100. The configured weights are then **rescaled over only the benchmarks the model has**, and a weighted average is taken:

   ```
   codingScore = Σ (weightᵢ / Σ weights of present benchmarks) × scoreᵢ
   ```

   A benchmark the model hasn't been tested on is not counted as zero. The model is scored on the evidence that exists.
4. **Look up the price** (USD per 1M tokens) according to `priceBasis`:
   - `blended`: (input price + output price) / 2. If only one of the two is listed, Artificial Analysis's own 3:1 blended price is used, and the row notes this.
   - `input`: the input price only.
   - `output`: the output price only.

   A missing, zero or negative price excludes the model, because you can't divide by it. Artificial Analysis lists many models at $0, which usually means no price is known.
5. **Quality floor.** Find the best coding score among the remaining (priced) models. Any model below `qualityFloor × best` is excluded. With the current `0.85` and a best score of 81.6, a model needs at least 69.4 to be ranked. This is what keeps cheap-but-weak models out. The floor is relative, so it rises automatically as better models come out.
6. **Value score** = `codingScore ÷ price`. Every model that got this far is already strong, so this picks the one priced most sensibly. A model at 94% of the best score for 1/13 of the price beats the best model itself.
7. **Sort** by value, highest first (ties go to the higher coding score, then alphabetical order), and number the ranks from 1.

Steps 2 and 3 describe the general mechanism for blending several benchmarks. With the default config (Coding Index only), a model either has that score or isn't ranked.

Every excluded model still appears on the dashboard, in a separate list with a one-line reason. Every ranked row carries its raw inputs: each benchmark's raw and normalized value, the weight actually applied, which benchmarks were missing, and the price and its basis. Anyone can check the math.

**One row per model, not per effort level.** Artificial Analysis lists effort and reasoning levels as separate entries: "GPT-5.5 (xhigh)", "GPT-5.5 (high)", "Claude Opus 5 (Adaptive Reasoning, Max Effort)", and so on. Every level is scored first (steps 1–7). Then the levels are grouped into one row per model ([`src/variants.ts`](src/variants.ts)):

- **The headline score is the model's best level:** what it can do when you turn it up. A plain average would be unfair, because each model is tested at a different set of levels. Some include low or non-reasoning and some don't, so the average mostly reflects which levels were tested (e.g. GPT-5.6 Luna: max 71.4, average over its 6 levels 56.3).
- **The model counts as ranked if its best level clears the bar.** Hovering the model name on the dashboard shows every level's score, price and value, plus the average.
- **If a different level also clears the bar and gives at least 5% more value** (e.g. that level is discounted), the tooltip says so.
- **What counts as a level:** only parentheses made entirely of effort/reasoning words. Versions like "(May '25)" or "(0902)" stay separate models.

**Brand-new models: provisional scores.** Artificial Analysis usually publishes a new model's Intelligence Index within a day but can take longer for the Coding Index. Without handling this, a new frontier model (e.g. Claude Opus 5.5 on release) would sit in "no score" for days. So every run, a model released within `provisionalMaxAgeDays` (default 60) that has an Intelligence Index but no Coding Index gets a **provisional** estimate ([`src/provisional.ts`](src/provisional.ts)):
- **How:** a linear fit of Coding Index against Intelligence Index over the 20 models with the closest Intelligence Index that have both scores. The error widens when extrapolating past the best-known models.
- **Marking:** the dashboard shows it as **PROVISIONAL**, with the typical error.
- **Replacement:** it's replaced automatically on the first run after the real score is published.
- **Safety:** estimates never set the quality bar.

**New-model detection** still runs in the data (`isNew` in `latest.json`, one cycle long, matched by model and by level ids). The dashboard doesn't show a badge for it.

---

## Editing `config/scoring.yaml`

You can change what gets ranked, and how, without touching any code. Edit the file on GitHub and commit. The workflow reruns automatically on pushes that touch `config/`, and the dashboard updates a few minutes later.

```yaml
excludeVendors: []
benchmarkWeights:
  codingIndex: 1
qualityFloor: 0.85           # must reach 85% of the best model's coding score
priceBasis: blended          # blended | input | output
minBenchmarksRequired: 1
```

These are site-wide settings. Visitors can also hide vendors for themselves with the checkboxes at the top of the dashboard. That choice is saved in their own browser and changes nothing for anyone else.

### Set how strict the quality bar is

```yaml
qualityFloor: 0.95   # only the very top tier
qualityFloor: 0.9    # near the top
qualityFloor: 0.85   # a bit wider (current)
qualityFloor: 0      # no bar: pure coding-score-per-dollar (favors cheap, weak models)
```

As of September 2026: `0.85` (current) is set so that GPT-5.6 Luna (max, 71.4) and Composer 2.5 (estimated ~70.3) qualify. Qwen3.8-Flash-Next is first, and Luna is the best Cursor pick. `0.9` puts Gemini 3.8 Flash (high) first. `0.95` puts Claude Opus 5 (max effort) first.

### Why only the Coding Index by default

The Artificial Analysis Coding Index is their current composite of several coding evaluations, and it's what frontier models are measured on. Mixing in LiveCodeBench let older models that were only ever tested on that one benchmark rank on a different, non-comparable basis. You can still blend benchmarks (see below).

### Exclude vendors

```yaml
excludeVendors: [deepseek, qwen, google, zhipu]
```

Use the vendor name as shown on the dashboard's filter chips (`Google`, `DeepSeek`, `Z AI`), or Artificial Analysis's slug (`google`, `deepseek`, `zai`). Case doesn't matter. Qwen models are listed under the vendor **Alibaba** (`alibaba`), so exclude that name to remove them.

### Exclude specific models

```yaml
excludeModels:
  - Step 5 Preview
```

Use the model name as shown on the dashboard. Every effort level of that model is removed, and matching ignores case, word order and dashes. Excluded models appear in the "Excluded" list as "excluded by hand".

### Retune the weights

Weights don't need to add up to 1. They are relative:

```yaml
# Care twice as much about agentic terminal work as about the composite index
benchmarkWeights:
  codingIndex: 1
  terminalBench: 2
```

A weight of `0` (or removing the line) drops that benchmark.

### Available benchmark names

| Name in config | Artificial Analysis field | Scale in the API |
|---|---|---|
| `codingIndex` | `artificial_analysis_coding_index` | 0–100 |
| `intelligenceIndex` | `artificial_analysis_intelligence_index` | 0–100 |
| `liveCodeBench` | `livecodebench` | 0–1 |
| `terminalBench` | `terminalbench_hard` (Terminal-Bench Hard) | 0–1 |
| `terminalBenchV2` | `terminalbench_v2_1` (Terminal-Bench v2.1) | 0–1 |
| `sciCode` | `scicode` | 0–1 |
| `gpqa` | `gpqa` | 0–1 |
| `hle` | `hle` (Humanity's Last Exam) | 0–1 |
| `mmluPro` | `mmlu_pro` | 0–1 |
| `ifBench` | `ifbench` | 0–1 |
| `tau2` | `tau2` | 0–1 |

If Artificial Analysis adds a new benchmark, you can use its raw field name directly (e.g. `some_new_bench: 0.2`). It is treated as a 0–1 fraction unless its values are above 1. To pin its scale, add it to `BENCHMARKS` in [`src/benchmarks.ts`](src/benchmarks.ts).

### Require more evidence

```yaml
minBenchmarksRequired: 2   # must have at least 2 of the weighted benchmarks
```

This can't be larger than the number of weighted benchmarks. The config is validated on every run, and a mistake fails the run loudly instead of publishing something odd.

---

## Cursor models

Models you can pick in [Cursor](https://cursor.com/docs/models) are marked with a **Cursor** badge. A switch at the top of the dashboard ("Only models I can use in Cursor") limits the whole page to them. The hero then shows the best pick you can actually use in Cursor.

The list is kept by hand in [`config/cursor-models.yaml`](config/cursor-models.yaml), because Cursor has no public API for it. When Cursor adds or removes a model, edit the list and commit.

```yaml
models:
  - { name: Claude Opus 5 }                              # matched automatically
  - { name: Gemini 3 Pro, aa: Gemini 3 Pro Preview }     # AA uses a different name
  - { name: Composer 2.5, vendor: Cursor }               # not tracked by AA
```

**No duplicates:**
- **Name matching.** It ignores word order, dashes and anything in parentheses. "Claude 4.5 Opus" in Cursor matches "Claude Opus 4.5 (Reasoning)" in Artificial Analysis.
- **Variants.** Every effort/reasoning variant of a Cursor model is marked, since Cursor lets you pick the effort. Cursor's own "(Fast)", "1M" and "500k" entries are listed once.
- **Ranked models** just get the badge. They are never added a second time.
- **Cursor models that aren't ranked** appear once each at the end of the table, under "Also in Cursor, but not ranked", with the reason: below the bar (showing the best variant's score), no price, no Coding Index yet, or not tracked by Artificial Analysis at all (e.g. Composer). They are not repeated in the "Excluded" list.

### Hand-added models (estimates)

Some models aren't in the Artificial Analysis API at all, like Cursor's own **Composer 2.5**. [`config/manual-models.yaml`](config/manual-models.yaml) adds them with an **estimated** Coding Index, a price, an explanation and sources. They're ranked like any other model but marked **EST.** on the dashboard, and the methodology section shows how each estimate was made.

Composer 2.5's estimate (about 70.3): Artificial Analysis's Coding Agent Index scores it 62, against 66 for Claude Opus 4.7 (max) and 65 for GPT-5.5 (xhigh). Those two models score about 1.13× higher on the Coding Index, which gives 62 × 1.13 ≈ 70.3.

When Artificial Analysis adds a hand-added model to its API, their real data is used automatically and the manual entry is skipped. The run log says so, and you can then delete the entry.

---

## Running locally

Requires Node.js 20+ (CI uses 24).

```bash
npm install
npm test                 # offline, fixture-based unit tests
npm run typecheck
```

To fetch live data, set your own Artificial Analysis key **in your shell** (never in a file in this repo):

```bash
# macOS / Linux
export ARTIFICIAL_ANALYSIS_API_KEY=your-key
# Windows PowerShell
$env:ARTIFICIAL_ANALYSIS_API_KEY = "your-key"

npm run update       # fetch → score → detect new → write data/
npm run copy-data    # data/latest.json → site/data.json
npm run preview      # http://localhost:5173
```

`npm run update` writes nothing if only the timestamp would change.

### Layout

| Path | What it is |
|---|---|
| `src/source/artificialAnalysis.ts` | API client: retries with backoff, never retries 401/403, keeps unknown fields in `raw` |
| `src/benchmarks.ts` | Config benchmark names → API fields and scales |
| `src/scoring.ts` | The ranking methodology |
| `src/variants.ts` | Groups effort levels into one row per model |
| `src/provisional.ts` | Provisional Coding Index for brand-new models |
| `src/manualModels.ts` | Hand-added models with estimated scores (`config/manual-models.yaml`) |
| `src/newModels.ts` | `isNew` flag in the data (diff against the previous snapshot) |
| `src/cursor.ts` | Marks models available in Cursor (from `config/cursor-models.yaml`) |
| `src/persist.ts` | Writes `data/raw`, `data/history`, `data/latest.json` |
| `src/update.ts` | Pipeline entry point (`npm run update`) |
| `scripts/copy-data.ts` | Pre-deploy copy to `site/data.json` |
| `site/` | The static dashboard (plain HTML/CSS/JS + Chart.js from a CDN, no build step) |
| `data/raw/YYYY-MM-DDTHH.json` | Unmodified API response per run (for audit/reprocessing) |
| `data/history/YYYY-MM-DDTHH.json` | Computed ranking per run |
| `data/latest.json` | Current ranking (what gets published) |
| `.github/workflows/update.yml` | Schedule, update, deploy, failure tracking |

### The workflow

Runs at 05:00 and 17:00 UTC, on manual **Run workflow**, and on pushes that change config, code or site.

1. **update-data**: typecheck, run the tests, fetch, score and write the data files. The API key secret exists only in this job's fetch and leak-check steps.
2. **deploy-site**: runs only if update-data succeeded. It copies the data into `site/`, commits the data files (only when something meaningful changed), and deploys `site/` to Pages.
3. **report-status**: if anything failed, it opens an issue labelled `pipeline-failure`, or comments on the one already open. When a later run succeeds, it comments and closes that issue. A failed update never touches `data/latest.json`, `site/data.json` or the live site, so stale-but-correct data stays up.

---

## Setup (one-time)

Still to do by the repo owner:

- [ ] Create the public repo **`yamor321/the-schrute-score`** on GitHub (empty, no README) and push this code to `main`.
- [ ] Add the repository secret **Settings → Secrets and variables → Actions → New repository secret**: `ARTIFICIAL_ANALYSIS_API_KEY`. Do this before the first push, because the push itself triggers a run.
- [ ] **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- [ ] **Actions → Update data & deploy dashboard → Run workflow** (twice, to confirm it works end to end).
- [ ] Resolve the question in [COMPLIANCE.md](COMPLIANCE.md) with Artificial Analysis.

---

## Known limitations

- **The benchmarks belong to Artificial Analysis.** Which benchmarks exist, how they're run, and how the Coding Index is composed are Artificial Analysis's choices and can change over time. A shift in their methodology shifts these rankings.
- **"Value" is a simplification, not an objective truth.** It depends entirely on the configured weights, quality floor and price basis. Dividing by price rewards cheap models, which is why the quality floor exists. Inside the floor, a model a few points below the best but many times cheaper will win. If you'd pay almost anything for the last few points, raise `qualityFloor`.
- **The floor is a hard cutoff.** A model at 73.3 is out and one at 73.5 is in, even though the difference is within benchmark noise. The excluded list shows each model's score, so near-misses are visible.
- **Coverage.** Only models with an Artificial Analysis Coding Index result are ranked by default, which leaves out many older or less-tested models (see "Excluded" on the dashboard). If you blend several benchmarks instead, models with results on only some of them are scored on fewer data points.
- **Price is per token, not per task.** Models that "think" longer use more tokens for the same job, so their real cost per task is higher than the per-token price suggests. The blended price here is a plain (input + output) / 2, which differs from Artificial Analysis's own 3:1 blend. It falls back to theirs only when one side is missing.
- **Many models have no usable price.** Artificial Analysis lists some models at $0, usually meaning unknown or not served by a priced provider. These models are excluded, not ranked as infinitely good value.
- **New models are only as fast as Artificial Analysis**, which aims to add models within about 24 hours of release, plus up to 12 hours until our next scheduled run.
- **Provisional scores are estimates.** They come from the Intelligence Index, which tracks coding ability closely but not exactly. At the very top of the field, the fit extrapolates (the error shown widens accordingly). Treat a provisional rank as "roughly here" until the real score arrives.
- **"Best level" favors the top setting.** In practice you may run a model at a lower effort for speed, where it scores lower. Price per token is the same across levels, but higher levels use more tokens per task, so they cost more per task than the per-token price suggests.
- **The repo grows over time.** Each meaningful update commits the raw response (about 0.6 MB, compressed well by git) plus the computed table. Old files in `data/raw/` and `data/history/` can be pruned without affecting the dashboard.
- **Cron runs in UTC**, so the Israel-time schedule shifts by an hour at each DST change. GitHub also sometimes delays scheduled runs.
- **Chart.js loads from a CDN (jsDelivr), and fonts from Google Fonts.** If either is blocked, the page still works: it shows the table without charts, or uses system fonts.
- **The Cursor list is maintained by hand.** It can go stale between edits. The "checked" date in `config/cursor-models.yaml` shows when it was last compared with Cursor's docs. Cursor's own Composer model isn't tracked by Artificial Analysis, so it can't be scored. This project isn't affiliated with Cursor.

---

## License

[MIT](LICENSE). Data is © Artificial Analysis and subject to their terms. See [COMPLIANCE.md](COMPLIANCE.md).
