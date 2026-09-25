# The Schrute Score

**Which AI coding model gives you the most coding capability per dollar?**

This dashboard doesn't rank models only by how well they score on coding benchmarks. It asks whether the model is *worth it*: how much coding capability you get for what you pay. It updates itself twice a day from [Artificial Analysis](https://artificialanalysis.ai) data. Each run finds newly released models, recomputes a transparent **value score**, and publishes a static site to GitHub Pages. It all runs on free infrastructure.

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
5. **Value score** = `codingScore ÷ price`. Higher means more coding capability per dollar.
6. **Sort** by value, highest first (ties go to the higher coding score, then alphabetical order), and number the ranks from 1.

Every excluded model still appears on the dashboard, in a separate list with a one-line reason. Every ranked row carries its raw inputs: each benchmark's raw and normalized value, the weight actually applied, which benchmarks were missing, and the price and its basis. Anyone can check the math.

**New models.** Each run compares the current model ids with the previous `data/latest.json`. A model that wasn't there before gets `isNew: true` and a NEW badge. The flag lasts **one update cycle** (about 12 hours). On the very first run nothing is flagged.

---

## Editing `config/scoring.yaml`

You can change what gets ranked, and how, without touching any code. Edit the file on GitHub and commit. The workflow reruns automatically on pushes that touch `config/`, and the dashboard updates a few minutes later.

```yaml
excludeVendors: []
benchmarkWeights:
  codingIndex: 0.5
  liveCodeBench: 0.25
  terminalBench: 0.25
priceBasis: blended          # blended | input | output
minBenchmarksRequired: 1
```

### Exclude vendors

```yaml
excludeVendors: [deepseek, qwen, google, zhipu]
```

Use the vendor name as shown on the dashboard's filter chips (`Google`, `DeepSeek`, `Z AI`), or Artificial Analysis's slug (`google`, `deepseek`, `zai`). Case doesn't matter. Qwen models are listed under the vendor **Alibaba** (`alibaba`), so exclude that name to remove them.

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
| `src/newModels.ts` | NEW flag (diff against the previous snapshot) |
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
- **"Value" is a simplification, not an objective truth.** It depends entirely on the configured weights and price basis. Dividing by price strongly rewards very cheap models: a small model with a modest score at a few cents per million tokens can outrank a far stronger one. Use the price-vs-score chart to see the trade-off, and the coding score on its own for raw capability.
- **Uneven evidence.** Many models have results for only some of the configured benchmarks. Renormalization avoids scoring them as zero, but a model scored on one benchmark rests on thinner evidence than one scored on three. The table's "Benchmarks" column (e.g. `1/3`) shows this. Raising `minBenchmarksRequired` trades coverage for rigor.
- **Price is per token, not per task.** Models that "think" longer use more tokens for the same job, so their real cost per task is higher than the per-token price suggests. The blended price here is a plain (input + output) / 2, which differs from Artificial Analysis's own 3:1 blend. It falls back to theirs only when one side is missing.
- **Many models have no usable price.** Artificial Analysis lists some models at $0, usually meaning unknown or not served by a priced provider. These models are excluded, not ranked as infinitely good value.
- **New-model detection is only as fast as Artificial Analysis**, which aims to add models within about 24 hours of release, plus up to 12 hours until our next scheduled run. The NEW flag lasts one cycle (about 12 hours). A longer window is a possible future extension; see the comment in `src/newModels.ts`.
- **Variants are separate rows.** Artificial Analysis lists reasoning modes and effort levels as separate models (e.g. "(high)" vs "(low)"). They're ranked individually.
- **The repo grows over time.** Each meaningful update commits the raw response (about 0.6 MB, compressed well by git) plus the computed table. Old files in `data/raw/` and `data/history/` can be pruned without affecting the dashboard.
- **Cron runs in UTC**, so the Israel-time schedule shifts by an hour at each DST change. GitHub also sometimes delays scheduled runs.
- **Chart.js loads from a CDN (jsDelivr).** If it's blocked, the page still shows the hero, methodology and full table, just without charts.

---

## License

[MIT](LICENSE). Data is © Artificial Analysis and subject to their terms. See [COMPLIANCE.md](COMPLIANCE.md).
