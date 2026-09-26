import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Task-specific benchmarks outside the Artificial Analysis API: the
 * hand-kept snapshot in config/task-benchmarks.yaml plus LMArena WebDev
 * (fetched each run). Scores are keyed by our model names.
 */

export interface TaskBenchmark {
  key: string;
  label: string;
  publisher: string;
  url: string;
  /** The leaderboard's own last-update date. */
  asOf: string | null;
  /** When this snapshot was last compared with the leaderboard (drives the staleness warning). */
  checked?: string | null;
  measures: string;
  note?: string;
  /** 'rate' = a percentage of tasks solved (default); 'elo' = an arena rating. */
  kind?: 'rate' | 'elo';
  /** Our model name → score on the benchmark's own scale. */
  scores: Record<string, number>;
  /** Names whose score is the vendor's own report rather than an independent run. */
  vendorReported: string[];
}

export function parseTaskBenchmarks(input: unknown): TaskBenchmark[] {
  const b = ((input ?? {}) as Record<string, unknown>).benchmarks;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Error('task-benchmarks.yaml: `benchmarks` must be a mapping');
  return Object.entries(b as Record<string, Record<string, unknown>>).map(([key, e]) => {
    for (const f of ['label', 'publisher', 'url', 'measures'] as const) {
      if (typeof e[f] !== 'string' || !(e[f] as string).trim()) throw new Error(`task-benchmarks.yaml ${key}: "${f}" is required`);
    }
    const scores: Record<string, number> = {};
    for (const [name, v] of Object.entries((e.scores ?? {}) as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`task-benchmarks.yaml ${key}: score for "${name}" must be a number`);
      scores[name] = v;
    }
    if (Object.keys(scores).length < 3) throw new Error(`task-benchmarks.yaml ${key}: needs at least 3 scores`);
    const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v : null);
    return {
      key,
      label: (e.label as string).trim(),
      publisher: (e.publisher as string).trim(),
      url: (e.url as string).trim(),
      asOf: day(e.asOf),
      checked: day(e.checked),
      measures: (e.measures as string).trim().replace(/\s+/g, ' '),
      ...(typeof e.note === 'string' ? { note: e.note.trim().replace(/\s+/g, ' ') } : {}),
      scores,
      vendorReported: Array.isArray(e.vendorReported) ? e.vendorReported.filter((x): x is string => typeof x === 'string') : [],
    };
  });
}

export function loadTaskBenchmarks(path = 'config/task-benchmarks.yaml'): TaskBenchmark[] {
  return parseTaskBenchmarks(yaml.load(readFileSync(path, 'utf8')));
}

/** Snapshots not checked against their leaderboard for more than `maxAgeDays` (for a run-log warning). */
export function staleBenchmarks(benchmarks: TaskBenchmark[], now: Date, maxAgeDays = 60): string[] {
  return benchmarks
    .map((b) => ({ b, when: b.checked ?? b.asOf }))
    .filter(({ when }) => when && (now.getTime() - new Date(when).getTime()) / 86_400_000 > maxAgeDays)
    .map(({ b, when }) => `${b.label} (last checked ${when})`);
}
