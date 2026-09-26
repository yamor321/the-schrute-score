import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { BENCHMARKS, readBenchmark } from './benchmarks.js';
import type { RankedModel } from './scoring.js';
import type { AaModel } from './source/artificialAnalysis.js';

/**
 * Kinds of development work (config/task-types.yaml) that visitors can pick
 * on the dashboard. Each type is a weighted mix of benchmarks; picking types
 * swaps the general coding score for their average in the cost-per-task
 * formula. Nothing else in the ranking changes.
 *
 * To mix benchmarks with different scales and difficulty, each one is mapped
 * onto the coding-score scale across the ranked models (same mean and
 * spread):  x′ = μ_CI + (x − μ_b) / σ_b × σ_CI
 * A model missing a benchmark gets its own coding score for it (neutral),
 * so a gap in the data neither helps nor hurts it.
 */

export type ProxyStrength = 'strong' | 'medium' | 'weak' | 'general';

export interface TaskType {
  key: string;
  label: string;
  description: string;
  /** Benchmark key (see BENCHMARKS) → weight. `codingIndex` means the model's coding score. */
  weights: Record<string, number>;
  proxy: ProxyStrength;
  rationale: string;
}

const PROXIES: readonly ProxyStrength[] = ['strong', 'medium', 'weak', 'general'];

export function parseTaskTypes(input: unknown): TaskType[] {
  const list = ((input ?? {}) as Record<string, unknown>).types;
  if (!Array.isArray(list) || list.length === 0) throw new Error('task-types.yaml: `types` must be a non-empty list');
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where = `task-types.yaml types[${i}]`;
    for (const f of ['key', 'label', 'description', 'rationale'] as const) {
      if (typeof e[f] !== 'string' || !(e[f] as string).trim()) throw new Error(`${where}: "${f}" is required`);
    }
    const key = (e.key as string).trim();
    if (seen.has(key)) throw new Error(`${where}: duplicate key "${key}"`);
    seen.add(key);
    if (!PROXIES.includes(e.proxy as ProxyStrength)) throw new Error(`${where}: proxy must be one of ${PROXIES.join(', ')}`);
    const w = e.weights;
    if (w === null || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).length === 0) {
      throw new Error(`${where}: weights must be a mapping like { codingIndex: 0.5, lcr: 0.5 }`);
    }
    const weights: Record<string, number> = {};
    for (const [b, v] of Object.entries(w)) {
      if (!(b in BENCHMARKS)) throw new Error(`${where}: unknown benchmark "${b}" (known: ${Object.keys(BENCHMARKS).join(', ')})`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${where}: weight for "${b}" must be > 0`);
      weights[b] = v;
    }
    return {
      key,
      label: (e.label as string).trim(),
      description: (e.description as string).trim(),
      weights,
      proxy: e.proxy as ProxyStrength,
      rationale: (e.rationale as string).trim().replace(/\s+/g, ' '),
    };
  });
}

export function loadTaskTypes(path = 'config/task-types.yaml'): TaskType[] {
  return parseTaskTypes(yaml.load(readFileSync(path, 'utf8')));
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** The AA entry behind a ranked model's headline effort level. */
function headlineModel(r: RankedModel, byId: Map<string, AaModel>): AaModel | undefined {
  const v = r.variants?.find((x) => x.level === r.headlineLevel) ?? r.variants?.[0];
  return byId.get(v?.id ?? r.id);
}

/**
 * Per ranked model, a 0–100-ish score for every task type. Returns a map
 * from ranked-row id to { typeKey: score }.
 */
export function computeTaskScores(ranked: RankedModel[], models: AaModel[], types: TaskType[]): Map<string, Record<string, number>> {
  const byId = new Map(models.map((m) => [m.id, m]));
  const benchKeys = [...new Set(types.flatMap((t) => Object.keys(t.weights)))].filter((k) => k !== 'codingIndex');

  // Headline-level readings on the 0–100 scale.
  const rows = ranked.map((r) => {
    const aa = headlineModel(r, byId);
    const vals: Record<string, number | null> = {};
    for (const k of benchKeys) vals[k] = aa ? readBenchmark(aa, k).normalized : null;
    return { r, vals };
  });

  // Mean and spread of each benchmark (and of the coding score) across the pool.
  const stats = (xs: number[]) => {
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
    return { mu, sd, n: xs.length };
  };
  const ci = stats(ranked.map((r) => r.codingScore));
  const bench = Object.fromEntries(
    benchKeys.map((k) => [k, stats(rows.map((x) => x.vals[k]).filter((v): v is number => v !== null))]),
  );

  const mapped = (k: string, r: RankedModel, v: number | null): number => {
    const s = bench[k];
    // Missing value, or too little data to map reliably → neutral (the model's own coding score).
    if (v === null || !s || s.n < 3 || s.sd === 0 || ci.sd === 0) return r.codingScore;
    return ci.mu + ((v - s.mu) / s.sd) * ci.sd;
  };

  const out = new Map<string, Record<string, number>>();
  for (const { r, vals } of rows) {
    const scores: Record<string, number> = {};
    for (const t of types) {
      let sum = 0;
      let wsum = 0;
      for (const [k, w] of Object.entries(t.weights)) {
        sum += w * (k === 'codingIndex' ? r.codingScore : mapped(k, r, vals[k] ?? null));
        wsum += w;
      }
      scores[t.key] = round(sum / wsum);
    }
    out.set(r.id, scores);
  }
  return out;
}
