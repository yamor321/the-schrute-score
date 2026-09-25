import { readBenchmark } from './benchmarks.js';
import type { PriceBasis, ScoringConfig } from './config.js';
import type { AaModel } from './source/artificialAnalysis.js';

export interface BenchmarkDetail {
  label: string;
  /** Artificial Analysis field the value came from. */
  field: string;
  /** Value as reported by the API. */
  raw: number | null;
  /** Value on the common 0–100 scale. */
  normalized: number | null;
  /** Weight from config/scoring.yaml. */
  weight: number;
  /** Weight actually applied after renormalizing over present benchmarks (null when missing). */
  effectiveWeight: number | null;
  present: boolean;
}

export interface RankedModel {
  rank: number;
  id: string;
  name: string;
  vendor: string;
  vendorSlug: string | null;
  releaseDate: string | null;
  /** Weighted 0–100 coding score, before price is considered. */
  codingScore: number;
  benchmarks: Record<string, BenchmarkDetail>;
  benchmarksUsed: string[];
  missingBenchmarks: string[];
  /** USD per 1M tokens, resolved per `priceBasis`. */
  price: number;
  priceBasis: PriceBasis;
  /** Set when the price had to come from a fallback. */
  priceNote: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
  /** codingScore ÷ price. Higher = more coding capability per dollar. */
  value: number;
  /** Set by new-model detection (see newModels.ts). */
  isNew?: boolean;
}

export type ExclusionReason = 'vendor-filter' | 'insufficient-benchmarks' | 'missing-price';

export interface ExcludedModel {
  id: string;
  name: string;
  vendor: string;
  releaseDate: string | null;
  reason: ExclusionReason;
  /** One-line human explanation shown on the dashboard. */
  detail: string;
  /** Present when the model got far enough to be scored. */
  codingScore?: number;
  isNew?: boolean;
}

export interface ValueTable {
  ranked: RankedModel[];
  excluded: ExcludedModel[];
}

const normalizeVendor = (v: string) => v.trim().toLowerCase();

/** Trims float noise (0.21000000000000002) from published numbers; 6 decimals is far below display precision. */
const round = (x: number) => Math.round(x * 1e6) / 1e6;

interface ResolvedPrice {
  price: number | null;
  note: string | null;
}

export function resolvePrice(model: AaModel, basis: PriceBasis): ResolvedPrice {
  const { input, output, blended3to1 } = model.pricing;
  if (basis === 'input') return { price: input, note: null };
  if (basis === 'output') return { price: output, note: null };
  if (input !== null && output !== null) return { price: (input + output) / 2, note: null };
  if (blended3to1 !== null) {
    return { price: blended3to1, note: "Only one of input/output price listed; used Artificial Analysis's 3:1 blended price" };
  }
  return { price: null, note: null };
}

/**
 * Builds the cost-benefit ranking. This comment is the precise statement of
 * the methodology; the dashboard's "How this is calculated" section and the
 * README describe the same steps in plain language — keep all three in sync.
 *
 * 1. Vendor exclusion — drop any model whose creator name or slug matches an
 *    entry in `cfg.excludeVendors` (case-insensitive, whitespace-trimmed).
 *
 * 2. Thin-evidence exclusion — count how many of the benchmarks named in
 *    `cfg.benchmarkWeights` have a non-null value for the model. If fewer than
 *    `cfg.minBenchmarksRequired`, drop it.
 *
 * 3. Renormalized weighted coding score — every benchmark is first put on a
 *    common 0–100 scale (AA indexes are already 0–100; single benchmarks are
 *    0–1 fractions and are ×100). Then, over only the benchmarks the model
 *    actually has, the configured weights are rescaled to sum to 1 and the
 *    weighted average is taken:
 *
 *        codingScore = Σ (w_i / Σ w_present) × score_i      for present i
 *
 *    A missing benchmark therefore neither counts as zero nor changes the
 *    scale — the model is judged on the evidence that exists.
 *
 * 4. Price lookup — per `cfg.priceBasis`, in USD per 1M tokens:
 *      input   → input price
 *      output  → output price
 *      blended → (input + output) / 2; if only one side is listed, AA's own
 *                3:1 blended price is used instead (and noted on the row).
 *    A missing, zero or negative price excludes the model (cannot divide by it).
 *
 * 5. Value score — value = codingScore / price. Higher is better: more coding
 *    capability per dollar.
 *
 * 6. Sort by value descending (ties: higher codingScore, then name) and
 *    assign rank 1…n.
 *
 * Every excluded model is returned in `excluded` with a reason, so nothing
 * disappears from the dashboard unexplained. Every ranked row carries all
 * raw inputs (each benchmark's raw and normalized value, the weight applied,
 * which were missing, the price and its basis) so the math can be checked.
 */
export function computeValueTable(models: AaModel[], cfg: ScoringConfig): ValueTable {
  const excludedVendors = new Set(cfg.excludeVendors.map(normalizeVendor));
  const benchmarkKeys = Object.keys(cfg.benchmarkWeights);
  const ranked: Omit<RankedModel, 'rank'>[] = [];
  const excluded: ExcludedModel[] = [];

  for (const m of models) {
    const base = { id: m.id, name: m.name, vendor: m.vendor, releaseDate: m.releaseDate };

    // 1. Vendor exclusion
    const vendorIds = [m.vendor, m.vendorSlug].filter((v): v is string => v !== null).map(normalizeVendor);
    if (vendorIds.some((v) => excludedVendors.has(v))) {
      excluded.push({ ...base, reason: 'vendor-filter', detail: `Excluded: vendor filter (${m.vendor})` });
      continue;
    }

    // 2. Thin-evidence exclusion
    const readings = benchmarkKeys.map((key) => ({ key, reading: readBenchmark(m, key), weight: cfg.benchmarkWeights[key]! }));
    const present = readings.filter((r) => r.reading.normalized !== null);
    if (present.length < cfg.minBenchmarksRequired) {
      excluded.push({
        ...base,
        reason: 'insufficient-benchmarks',
        detail:
          `Excluded: has ${present.length} of the ${benchmarkKeys.length} scored benchmarks ` +
          `(minimum ${cfg.minBenchmarksRequired})`,
      });
      continue;
    }

    // 3. Renormalized weighted coding score
    const presentWeight = present.reduce((sum, r) => sum + r.weight, 0);
    let codingScore = 0;
    const benchmarks: Record<string, BenchmarkDetail> = {};
    for (const { key, reading, weight } of readings) {
      const isPresent = reading.normalized !== null;
      const effectiveWeight = isPresent ? weight / presentWeight : null;
      if (isPresent) codingScore += effectiveWeight! * reading.normalized!;
      benchmarks[key] = {
        label: reading.label,
        field: reading.field,
        raw: reading.raw,
        normalized: reading.normalized === null ? null : round(reading.normalized),
        weight,
        effectiveWeight: effectiveWeight === null ? null : round(effectiveWeight),
        present: isPresent,
      };
    }

    // 4. Price lookup
    const { price, note } = resolvePrice(m, cfg.priceBasis);
    if (price === null || price <= 0) {
      excluded.push({
        ...base,
        reason: 'missing-price',
        detail:
          price === null
            ? `Excluded: no ${cfg.priceBasis} price listed`
            : `Excluded: ${cfg.priceBasis} price is $${price} (not reported or free)`,
        codingScore: round(codingScore),
      });
      continue;
    }

    // 5. Value score
    ranked.push({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      vendorSlug: m.vendorSlug,
      releaseDate: m.releaseDate,
      codingScore: round(codingScore),
      benchmarks,
      benchmarksUsed: present.map((r) => r.key),
      missingBenchmarks: readings.filter((r) => r.reading.normalized === null).map((r) => r.key),
      price: round(price),
      priceBasis: cfg.priceBasis,
      priceNote: note,
      inputPrice: m.pricing.input,
      outputPrice: m.pricing.output,
      value: round(codingScore / price),
    });
  }

  // 6. Sort and rank
  ranked.sort((a, b) => b.value - a.value || b.codingScore - a.codingScore || a.name.localeCompare(b.name));
  const order: Record<ExclusionReason, number> = { 'missing-price': 0, 'insufficient-benchmarks': 1, 'vendor-filter': 2 };
  excluded.sort((a, b) => order[a.reason] - order[b.reason] || a.name.localeCompare(b.name));

  return { ranked: ranked.map((r, i) => ({ rank: i + 1, ...r })), excluded };
}
