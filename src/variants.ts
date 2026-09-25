import type { ExcludedModel, RankedModel, ValueTable } from './scoring.js';

/**
 * Collapses effort / reasoning variants into one row per model.
 *
 * Artificial Analysis lists e.g. "GPT-5.5 (xhigh)", "GPT-5.5 (high)", …
 * separately. In practice the effort level is a setting you change per task
 * inside the same model, so the dashboard ranks the MODEL:
 *
 *   - Headline score = the model's best effort level (what it can do when
 *     you turn it up). A plain average would be unfair: AA tests a different
 *     set of levels per model (some include "low"/"non-reasoning", some
 *     don't), so the average mostly reflects which levels were tested.
 *   - Value = that level's coding score ÷ its price.
 *   - Every level is kept in `variants` (score, price, value, status) for the
 *     tooltip, plus the average over tested levels, and `bestValueLevel`
 *     when a different level that also clears the bar gives clearly more per
 *     dollar (e.g. a level with a promotional price).
 *
 * Parenthesized text only counts as a level when every comma-separated part
 * is an effort/reasoning word ("xhigh", "Max Effort", "Non-reasoning", "…
 * Fallback"). Versions like "(May '25)" or "(0902)" stay separate models.
 */

const LEVEL_PART = /^(adaptive reasoning|reasoning|non-reasoning|thinking|non-thinking|minimal|low|medium|high|xhigh|max|none)( effort)?$|fallback$/i;

export function splitVariant(name: string): { base: string; level: string | null } {
  const m = name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return { base: name, level: null };
  const parts = m[2]!.split(',').map((s) => s.trim());
  return parts.every((p) => LEVEL_PART.test(p)) ? { base: m[1]!.trim(), level: m[2]!.trim() } : { base: name, level: null };
}

/** "Adaptive Reasoning, Max Effort, Default Fallback" → "max"; "Non-reasoning, High Effort" → "non-reasoning · high". */
export function levelLabel(level: string | null): string {
  if (!level) return 'standard';
  const parts = level
    .split(',')
    .map((p) => p.trim())
    .filter((p) => !/^adaptive reasoning$/i.test(p) && !/^default fallback$/i.test(p))
    .map((p) => p.replace(/\s+effort$/i, '').replace(/fallback$/i, 'fallback').toLowerCase());
  return parts.length ? parts.join(' · ') : 'standard';
}

export type VariantStatus = 'ranked' | ExcludedModel['reason'];

export interface VariantSummary {
  id: string;
  name: string;
  level: string;
  codingScore: number | null;
  price: number | null;
  value: number | null;
  status: VariantStatus;
}

export interface ModelGroupInfo {
  /** Every tested level, highest coding score first. */
  variants: VariantSummary[];
  /** Level used for the headline numbers. */
  headlineLevel: string;
  /** Mean coding score over the levels that have one. */
  averageScore: number | null;
  /** Set when another level (also above the bar) gives ≥5% more value than the headline level. */
  bestValueLevel: string | null;
}

type Row = { row: RankedModel | ExcludedModel; status: VariantStatus };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function groupVariants(table: ValueTable): ValueTable {
  const families = new Map<string, { base: string; vendor: string; rows: Row[] }>();
  const add = (row: RankedModel | ExcludedModel, status: VariantStatus) => {
    const { base } = splitVariant(row.name);
    const key = `${row.vendor.toLowerCase()}|${base.toLowerCase()}`;
    if (!families.has(key)) families.set(key, { base, vendor: row.vendor, rows: [] });
    families.get(key)!.rows.push({ row, status });
  };
  for (const r of table.ranked) add(r, 'ranked');
  for (const e of table.excluded) add(e, e.reason);

  const ranked: (RankedModel & ModelGroupInfo)[] = [];
  const excluded: (ExcludedModel & ModelGroupInfo)[] = [];
  const familyOf = new Map<string, string>(); // variant name → model name

  for (const { base, vendor, rows } of families.values()) {
    const id = `model:${slug(vendor)}:${slug(base)}`;
    const variants: VariantSummary[] = rows
      .map(({ row, status }) => ({
        id: row.id,
        name: row.name,
        level: levelLabel(splitVariant(row.name).level),
        codingScore: row.codingScore ?? null,
        price: 'price' in row && row.price !== undefined ? row.price : null,
        value: 'value' in row && row.value !== undefined ? row.value : null,
        status,
      }))
      .sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1) || (b.value ?? -1) - (a.value ?? -1));
    const scored = variants.filter((v) => v.codingScore !== null).map((v) => v.codingScore!);
    const averageScore = scored.length ? round(scored.reduce((s, x) => s + x, 0) / scored.length) : null;
    for (const v of variants) familyOf.set(v.name, base);

    const rankedRows = rows.filter((r) => r.status === 'ranked').map((r) => r.row as RankedModel);
    if (rankedRows.length) {
      const headline = [...rankedRows].sort((a, b) => b.codingScore - a.codingScore || b.value - a.value)[0]!;
      const bestValue = [...rankedRows].sort((a, b) => b.value - a.value)[0]!;
      const { isNew: _n, ...rest } = headline;
      ranked.push({
        ...rest,
        id,
        name: base,
        variants,
        headlineLevel: levelLabel(splitVariant(headline.name).level),
        averageScore,
        bestValueLevel:
          bestValue !== headline && bestValue.value >= headline.value * 1.05 ? levelLabel(splitVariant(bestValue.name).level) : null,
      });
      continue;
    }

    // Not ranked at any level: one excluded row for the model, using its most informative level.
    const priority: ExcludedModel['reason'][] = ['below-quality-floor', 'missing-price', 'insufficient-benchmarks', 'model-filter', 'vendor-filter'];
    const excl = rows.map((r) => r.row as ExcludedModel);
    const rep = priority
      .map((reason) => excl.filter((e) => e.reason === reason).sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1))[0])
      .find(Boolean)!;
    const repLevel = levelLabel(splitVariant(rep.name).level);
    const { isNew: _n, ...rest } = rep;
    excluded.push({
      ...rest,
      id,
      name: base,
      detail:
        variants.length > 1 && rep.reason !== 'vendor-filter' && rep.reason !== 'model-filter' ? `${rep.detail} — best level: ${repLevel}` : rep.detail,
      variants,
      headlineLevel: repLevel,
      averageScore,
      bestValueLevel: null,
    });
  }

  ranked.sort((a, b) => b.value - a.value || b.codingScore - a.codingScore || a.name.localeCompare(b.name));
  const order: Record<ExcludedModel['reason'], number> = {
    'below-quality-floor': 0,
    'missing-price': 1,
    'insufficient-benchmarks': 2,
    'model-filter': 3,
    'vendor-filter': 4,
  };
  excluded.sort((a, b) => order[a.reason] - order[b.reason] || (b.codingScore ?? 0) - (a.codingScore ?? 0) || a.name.localeCompare(b.name));

  return {
    ranked: ranked.map((r, i) => ({ ...r, rank: i + 1 })),
    excluded,
    quality: table.quality ? { ...table.quality, bestModel: familyOf.get(table.quality.bestModel) ?? table.quality.bestModel } : null,
  };
}
