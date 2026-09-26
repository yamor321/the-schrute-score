import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { readBenchmark } from './benchmarks.js';
import { modelKey } from './cursor.js';
import type { RankedModel } from './scoring.js';
import type { AaModel } from './source/artificialAnalysis.js';
import type { TaskBenchmark } from './taskBenchmarks.js';

/**
 * Kinds of development work (config/task-types.yaml) visitors can pick on
 * the dashboard. Each type is scored by benchmarks built for that work
 * ("sources"). Picking types swaps the general coding score for their
 * average in the cost-per-task formula; nothing else changes.
 *
 * Per model and source:
 *   measured  → the model's result, put on the coding-score scale
 *               (same mean and spread across the ranked models that have it):
 *               x′ = μ_CI + (x − μ_s) / σ_s × σ_CI
 *   estimated → from the model's general coding score, shrunk toward the
 *               average by how well the two agree (Pearson r across models
 *               that have both), minus one standard error of that estimate:
 *               μ_CI + r × (CI − μ_CI) − σ_CI × √(1 − r²)
 *               (conservative: unmeasured models don't get the benefit of
 *               the doubt over measured ones)
 * A type's score is the mean over its sources; its status is measured (all
 * sources measured), partial, or estimated (none).
 */

export interface TaskType {
  key: string;
  label: string;
  description: string;
  sources: string[];
}

/** Sources that come with every Artificial Analysis API run. */
export const API_SOURCES: Record<string, { label: string; publisher: string; url: string; measures: string }> = {
  codingIndex: {
    label: 'AA Coding Index',
    publisher: 'Artificial Analysis',
    url: 'https://artificialanalysis.ai/methodology/intelligence-benchmarking',
    measures: 'General coding composite.',
  },
  terminalBench: {
    label: 'Terminal-Bench v2.1',
    publisher: 'Artificial Analysis (tbench.ai tasks)',
    url: 'https://www.tbench.ai',
    measures: '89 tasks in a real terminal: system administration, builds, environments, data processing, security.',
  },
  sciCode: {
    label: 'SciCode',
    publisher: 'Artificial Analysis (SciCode authors)',
    url: 'https://scicode-bench.github.io',
    measures: '288 subproblems from 80 real laboratory problems across 16 scientific disciplines.',
  },
};

export function parseTaskTypes(input: unknown, knownSources: Iterable<string>): TaskType[] {
  const known = new Set(knownSources);
  const list = ((input ?? {}) as Record<string, unknown>).types;
  if (!Array.isArray(list) || list.length === 0) throw new Error('task-types.yaml: `types` must be a non-empty list');
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where = `task-types.yaml types[${i}]`;
    for (const f of ['key', 'label', 'description'] as const) {
      if (typeof e[f] !== 'string' || !(e[f] as string).trim()) throw new Error(`${where}: "${f}" is required`);
    }
    const key = (e.key as string).trim();
    if (seen.has(key)) throw new Error(`${where}: duplicate key "${key}"`);
    seen.add(key);
    if (!Array.isArray(e.sources) || e.sources.length === 0) throw new Error(`${where}: sources must be a non-empty list`);
    const sources = e.sources.map(String);
    for (const s of sources) {
      if (!known.has(s)) throw new Error(`${where}: unknown source "${s}" (known: ${[...known].join(', ')})`);
    }
    return { key, label: (e.label as string).trim(), description: (e.description as string).trim(), sources };
  });
}

export function loadTaskTypes(knownSources: Iterable<string>, path = 'config/task-types.yaml'): TaskType[] {
  return parseTaskTypes(yaml.load(readFileSync(path, 'utf8')), knownSources);
}

export type TaskStatus = 'measured' | 'partial' | 'estimated';

export interface SourceSummary {
  key: string;
  label: string;
  publisher: string;
  url: string;
  asOf: string | null;
  measures: string;
  note?: string;
  /** Ranked models with a real result on this source. */
  measured: number;
  /** Agreement with the general coding score across those models (null when too few). */
  fitR: number | null;
}

export interface ModelTaskScores {
  scores: Record<string, number>;
  status: Record<string, TaskStatus>;
  /** Source keys this model was actually measured on. */
  measuredSources: string[];
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** The AA entry behind a ranked model's headline effort level. */
function headlineModel(r: RankedModel, byId: Map<string, AaModel>): AaModel | undefined {
  const v = r.variants?.find((x) => x.level === r.headlineLevel) ?? r.variants?.[0];
  return byId.get(v?.id ?? r.id);
}

export function computeTaskScores(
  ranked: RankedModel[],
  models: AaModel[],
  types: TaskType[],
  external: TaskBenchmark[],
): { perModel: Map<string, ModelTaskScores>; sources: SourceSummary[] } {
  const byId = new Map(models.map((m) => [m.id, m]));
  const ext = new Map(external.map((b) => [b.key, b]));
  const extScores = new Map(external.map((b) => [b.key, new Map(Object.entries(b.scores).map(([n, v]) => [modelKey(n), v]))]));
  const used = [...new Set(types.flatMap((t) => t.sources))];

  const raw = (r: RankedModel, s: string): number | null => {
    if (s === 'codingIndex') return r.codingScore;
    if (s in API_SOURCES) {
      const aa = headlineModel(r, byId);
      return aa ? readBenchmark(aa, s).normalized : null;
    }
    return extScores.get(s)?.get(modelKey(r.name)) ?? null;
  };

  const ciAll = ranked.map((r) => r.codingScore);
  const muCI = mean(ciAll);
  const sdCI = sd(ciAll);

  // Per source: which ranked models were measured, their values on the coding-score scale, and the fit to CI.
  const perSource = new Map<string, { mapped: Map<string, number>; fitR: number | null }>();
  const sources: SourceSummary[] = [];
  for (const s of used) {
    const have = ranked.map((r) => ({ r, v: raw(r, s) })).filter((x): x is { r: RankedModel; v: number } => x.v !== null);
    const mapped = new Map<string, number>();
    let fitR: number | null = null;
    if (s === 'codingIndex') {
      for (const { r, v } of have) mapped.set(r.id, v);
      fitR = 1;
    } else if (have.length >= 3 && sd(have.map((x) => x.v)) > 0 && sdCI > 0) {
      const mu = mean(have.map((x) => x.v));
      const sigma = sd(have.map((x) => x.v));
      for (const { r, v } of have) mapped.set(r.id, muCI + ((v - mu) / sigma) * sdCI);
      fitR = round(pearson(have.map((x) => x.v), have.map((x) => x.r.codingScore)), 2);
    }
    perSource.set(s, { mapped, fitR });
    const meta = ext.get(s) ?? { ...API_SOURCES[s]!, asOf: null, note: undefined };
    sources.push({
      key: s,
      label: meta.label,
      publisher: meta.publisher,
      url: meta.url,
      asOf: meta.asOf ?? null,
      measures: meta.measures,
      ...(meta.note ? { note: meta.note } : {}),
      measured: mapped.size,
      fitR,
    });
  }

  const perModel = new Map<string, ModelTaskScores>();
  for (const r of ranked) {
    const scores: Record<string, number> = {};
    const status: Record<string, TaskStatus> = {};
    const measuredSources = used.filter((s) => perSource.get(s)!.mapped.has(r.id));
    for (const t of types) {
      let measured = 0;
      const vals = t.sources.map((s) => {
        const src = perSource.get(s)!;
        const m = src.mapped.get(r.id);
        if (m !== undefined) {
          measured++;
          return m;
        }
        // Estimate from the general coding score: the regression prediction (shrunk toward the
        // average by the source's agreement with it), minus one standard error of that prediction.
        // A model that hasn't been measured doesn't get the benefit of the doubt over one that has.
        const rho = Math.max(0, src.fitR ?? 1);
        const residualSd = sdCI * Math.sqrt(1 - rho * rho);
        return muCI + rho * (r.codingScore - muCI) - residualSd;
      });
      scores[t.key] = round(mean(vals));
      status[t.key] = measured === t.sources.length ? 'measured' : measured > 0 ? 'partial' : 'estimated';
    }
    perModel.set(r.id, { scores, status, measuredSources });
  }
  return { perModel, sources };
}
