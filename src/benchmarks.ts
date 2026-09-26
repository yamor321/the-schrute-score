import type { AaModel } from './source/artificialAnalysis.js';

/**
 * Maps the friendly benchmark names used in `config/scoring.yaml` to the
 * Artificial Analysis API field that holds each score.
 *
 * Artificial Analysis reports its composite indexes on a 0–100 scale but
 * individual benchmarks (LiveCodeBench, Terminal-Bench, …) as 0–1 fractions.
 * Averaging those raw would let the index dominate, so every benchmark is
 * converted to 0–100 before weighting (`scale`).
 */
export interface BenchmarkDef {
  field: string;
  label: string;
  scale: number;
}

export const BENCHMARKS: Record<string, BenchmarkDef> = {
  codingIndex: { field: 'artificial_analysis_coding_index', label: 'AA Coding Index', scale: 1 },
  intelligenceIndex: { field: 'artificial_analysis_intelligence_index', label: 'AA Intelligence Index', scale: 1 },
  liveCodeBench: { field: 'livecodebench', label: 'LiveCodeBench', scale: 100 },
  // Terminal-Bench v2.1 is what AA measures on current models (Hard: 8 of 34 ranked models).
  terminalBench: { field: 'terminalbench_v2_1', label: 'Terminal-Bench v2.1', scale: 100 },
  terminalBenchHard: { field: 'terminalbench_hard', label: 'Terminal-Bench Hard', scale: 100 },
  lcr: { field: 'lcr', label: 'AA-LCR (long-context reasoning)', scale: 100 },
  tauBanking: { field: 'tau_banking', label: 'τ²-Bench Banking', scale: 100 },
  sciCode: { field: 'scicode', label: 'SciCode', scale: 100 },
  gpqa: { field: 'gpqa', label: 'GPQA Diamond', scale: 100 },
  hle: { field: 'hle', label: "Humanity's Last Exam", scale: 100 },
  mmluPro: { field: 'mmlu_pro', label: 'MMLU-Pro', scale: 100 },
  ifBench: { field: 'ifbench', label: 'IFBench', scale: 100 },
  tau2: { field: 'tau2', label: 'τ²-Bench', scale: 100 },
};

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export interface BenchmarkReading {
  /** Value exactly as the API reported it. */
  raw: number | null;
  /** Value on the common 0–100 scale. */
  normalized: number | null;
  field: string;
  label: string;
}

/**
 * Reads one configured benchmark for a model. Keys not in `BENCHMARKS` are
 * looked up directly in the API's `evaluations` (as written, then as
 * snake_case) so a new AA benchmark can be used without a code change; such
 * values are treated as 0–1 fractions (×100) unless they are above 1.
 * Add the field to `BENCHMARKS` to pin its scale explicitly.
 */
export function readBenchmark(model: AaModel, key: string): BenchmarkReading {
  const def = BENCHMARKS[key];
  if (def) {
    const raw = model.evaluations[def.field] ?? null;
    return { raw, normalized: raw === null ? null : raw * def.scale, field: def.field, label: def.label };
  }
  for (const field of [key, toSnake(key)]) {
    if (field in model.evaluations) {
      const raw = model.evaluations[field] ?? null;
      const normalized = raw === null ? null : raw <= 1 ? raw * 100 : raw;
      return { raw, normalized, field, label: key };
    }
  }
  return { raw: null, normalized: null, field: toSnake(key), label: key };
}
