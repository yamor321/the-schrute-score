import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export type PriceBasis = 'blended' | 'input' | 'output';

export interface ScoringConfig {
  excludeVendors: string[];
  /** Specific models to drop, by name (all effort levels). */
  excludeModels: string[];
  benchmarkWeights: Record<string, number>;
  priceBasis: PriceBasis;
  minBenchmarksRequired: number;
  /** 0–1: a model must reach this fraction of the best model's coding score to be ranked (0 = no floor). */
  qualityFloor: number;
  /** New models (released within this many days) without a Coding Index get a provisional estimate. 0 = off. */
  provisionalMaxAgeDays: number;
  /** Inputs to "cost per finished task", the ranking metric (see scoring.ts `taskCost`). */
  taskModel: TaskModel;
}

export interface TaskModel {
  /** Tokens (in millions) a typical coding task burns. */
  tokensPerTaskMillions: number;
  /** Fully loaded cost of one developer hour, USD. */
  developerHourlyUsd: number;
  /** Developer minutes lost per failed attempt (spot it, re-prompt, re-review, or fix by hand). */
  minutesPerFailedAttempt: number;
  /** Derived: developerHourlyUsd × minutesPerFailedAttempt / 60. */
  fixCostUsd: number;
}

export const DEFAULT_TASK_MODEL = { tokensPerTaskMillions: 0.27, developerHourlyUsd: 78, minutesPerFailedAttempt: 20 };

export function withFixCost(t: Omit<TaskModel, 'fixCostUsd'>): TaskModel {
  return { ...t, fixCostUsd: Math.round(((t.developerHourlyUsd * t.minutesPerFailedAttempt) / 60) * 100) / 100 };
}

const PRICE_BASES: readonly PriceBasis[] = ['blended', 'input', 'output'];

/** Validates a parsed YAML object. Throws with a readable message on any mistake. */
export function parseScoringConfig(input: unknown): ScoringConfig {
  if (input === null || typeof input !== 'object') throw new Error('scoring config must be a YAML mapping');
  const c = input as Record<string, unknown>;

  const excludeVendors = c.excludeVendors ?? [];
  if (!Array.isArray(excludeVendors)) throw new Error('excludeVendors must be a list, e.g. [deepseek, qwen]');
  const vendors = excludeVendors.map((v) => String(v).trim()).filter((v) => v !== '');

  const excludeModelsRaw = c.excludeModels ?? [];
  if (!Array.isArray(excludeModelsRaw)) throw new Error('excludeModels must be a list, e.g. ["Step 5 Preview"]');
  const excludeModels = excludeModelsRaw.map((v) => String(v).trim()).filter((v) => v !== '');

  const weights = c.benchmarkWeights;
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new Error('benchmarkWeights must be a mapping of benchmark name to weight');
  }
  const benchmarkWeights: Record<string, number> = {};
  for (const [key, w] of Object.entries(weights)) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new Error(`benchmarkWeights.${key} must be a non-negative number (got ${JSON.stringify(w)})`);
    }
    if (w > 0) benchmarkWeights[key] = w;
  }
  if (Object.keys(benchmarkWeights).length === 0) throw new Error('benchmarkWeights needs at least one positive weight');

  const priceBasis = c.priceBasis ?? 'blended';
  if (!PRICE_BASES.includes(priceBasis as PriceBasis)) {
    throw new Error(`priceBasis must be one of ${PRICE_BASES.join(', ')} (got ${JSON.stringify(priceBasis)})`);
  }

  const min = c.minBenchmarksRequired ?? 1;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) {
    throw new Error('minBenchmarksRequired must be a whole number ≥ 1');
  }
  if (min > Object.keys(benchmarkWeights).length) {
    throw new Error(
      `minBenchmarksRequired (${min}) is larger than the number of weighted benchmarks ` +
        `(${Object.keys(benchmarkWeights).length}) — no model could ever qualify`,
    );
  }

  const qualityFloor = c.qualityFloor ?? 0;
  if (typeof qualityFloor !== 'number' || !Number.isFinite(qualityFloor) || qualityFloor < 0 || qualityFloor > 1) {
    throw new Error(`qualityFloor must be a number between 0 and 1, e.g. 0.9 for 90% (got ${JSON.stringify(qualityFloor)})`);
  }

  const provisionalMaxAgeDays = c.provisionalMaxAgeDays ?? 60;
  if (typeof provisionalMaxAgeDays !== 'number' || !Number.isInteger(provisionalMaxAgeDays) || provisionalMaxAgeDays < 0) {
    throw new Error('provisionalMaxAgeDays must be a whole number ≥ 0 (0 turns provisional estimates off)');
  }

  const tm = (c.taskModel ?? {}) as Record<string, unknown>;
  if (tm === null || typeof tm !== 'object' || Array.isArray(tm)) {
    throw new Error('taskModel must be a mapping with tokensPerTaskMillions, developerHourlyUsd and minutesPerFailedAttempt');
  }
  const num = (key: keyof typeof DEFAULT_TASK_MODEL, ok: (v: number) => boolean, hint: string): number => {
    const v = tm[key] ?? DEFAULT_TASK_MODEL[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw new Error(`taskModel.${key} must be ${hint}`);
    return v;
  };
  const taskModel = withFixCost({
    tokensPerTaskMillions: num('tokensPerTaskMillions', (v) => v > 0, 'a number above 0, e.g. 0.27 for 270K tokens'),
    developerHourlyUsd: num('developerHourlyUsd', (v) => v >= 0, 'a number ≥ 0 (USD per hour, employer cost)'),
    minutesPerFailedAttempt: num('minutesPerFailedAttempt', (v) => v >= 0, 'a number ≥ 0 (minutes)'),
  });

  return {
    excludeVendors: vendors,
    excludeModels,
    benchmarkWeights,
    priceBasis: priceBasis as PriceBasis,
    minBenchmarksRequired: min,
    qualityFloor,
    provisionalMaxAgeDays,
    taskModel,
  };
}

export function loadScoringConfig(path = 'config/scoring.yaml'): ScoringConfig {
  return parseScoringConfig(yaml.load(readFileSync(path, 'utf8')));
}
