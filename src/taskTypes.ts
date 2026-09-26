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
 * ("sources"). Each source is a SUCCESS RATE on that kind of task, and it
 * replaces the general coding score as p — the chance a model gets the task
 * right first time — in the cost-per-task formula. Nothing else changes.
 *
 * Per model and source (rates in 0–1):
 *   measured  → the model's own result: pass rate (SWE-Atlas, DeepSWE,
 *               Terminal-Bench, SciCode), precision at full recall (ITBench),
 *               or for LMArena WebDev the Elo win chance against the average
 *               ranked model: 1 / (1 + 10^((R̄ − R)/400)).
 *   estimated → linear fit of the source's rate on the coding score across
 *               the models that have both, minus one residual standard
 *               deviation (conservative: an unmeasured model doesn't get the
 *               benefit of the doubt over a measured one).
 * A type's score is 100 × the mean rate over its sources; its status is
 * measured (all sources measured), partial, or estimated (none).
 *
 * (An earlier version mapped every result onto the coding-score scale; that
 * squeezed a 40% vs 63% gap on codebase QnA into ~3 points, so picking a
 * kind of work barely moved the ranking.)
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
/** Success rates are kept inside (0.02, 0.99) so the cost formula never divides by ~0. */
const clamp = (p: number) => Math.min(0.99, Math.max(0.02, p));
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

  /** Result on the source's own scale (percent for rates, Elo for WebDev), or null if not measured. */
  const raw = (r: RankedModel, s: string): number | null => {
    if (s === 'codingIndex') return r.codingScore;
    if (s in API_SOURCES) {
      const aa = headlineModel(r, byId);
      return aa ? readBenchmark(aa, s).normalized : null;
    }
    return extScores.get(s)?.get(modelKey(r.name)) ?? null;
  };

  // Per source: each measured model's success rate (0–1), plus a conservative estimator for the rest.
  const perSource = new Map<string, { rate: Map<string, number>; estimate: (ci: number) => number; fitR: number | null }>();
  const sources: SourceSummary[] = [];
  for (const s of used) {
    const have = ranked.map((r) => ({ r, v: raw(r, s) })).filter((x): x is { r: RankedModel; v: number } => x.v !== null);
    const isElo = ext.get(s)?.kind === 'elo';
    const eloMean = isElo && have.length ? mean(have.map((x) => x.v)) : 0;
    const toRate = (v: number) => clamp(isElo ? 1 / (1 + 10 ** ((eloMean - v) / 400)) : v / 100);
    const rate = new Map(have.map(({ r, v }) => [r.id, toRate(v)] as const));

    let estimate = (ci: number) => clamp(ci / 100);
    let fitR: number | null = s === 'codingIndex' ? 1 : null;
    if (s !== 'codingIndex' && have.length >= 3) {
      const xs = have.map((x) => x.r.codingScore);
      const ys = have.map((x) => rate.get(x.r.id)!);
      const mx = mean(xs);
      const my = mean(ys);
      const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
      const slope = sxx ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / sxx : 0;
      const intercept = my - slope * mx;
      const residualSd = Math.sqrt(ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i]!)) ** 2, 0) / Math.max(1, ys.length - 2));
      // Prediction from the coding score minus one residual SD: no benefit of the doubt when unmeasured.
      estimate = (ci) => clamp(intercept + slope * ci - residualSd);
      fitR = round(pearson(xs, ys), 2);
    }
    perSource.set(s, { rate, estimate, fitR });
    const meta = ext.get(s) ?? { ...API_SOURCES[s]!, asOf: null, note: undefined };
    sources.push({
      key: s,
      label: meta.label,
      publisher: meta.publisher,
      url: meta.url,
      asOf: meta.asOf ?? null,
      measures: meta.measures,
      ...(meta.note ? { note: meta.note } : {}),
      measured: rate.size,
      fitR,
    });
  }

  const perModel = new Map<string, ModelTaskScores>();
  for (const r of ranked) {
    const scores: Record<string, number> = {};
    const status: Record<string, TaskStatus> = {};
    const measuredSources = used.filter((s) => perSource.get(s)!.rate.has(r.id));
    for (const t of types) {
      let measured = 0;
      const vals = t.sources.map((s) => {
        const src = perSource.get(s)!;
        const v = src.rate.get(r.id);
        if (v !== undefined) {
          measured++;
          return v;
        }
        return src.estimate(r.codingScore);
      });
      // Stored as a percentage so the dashboard uses it exactly like a coding score (p = score / 100).
      scores[t.key] = round(mean(vals) * 100, 4);
      status[t.key] = measured === t.sources.length ? 'measured' : measured > 0 ? 'partial' : 'estimated';
    }
    perModel.set(r.id, { scores, status, measuredSources });
  }
  return { perModel, sources };
}
