import { readFileSync } from 'node:fs';
import { parseModels } from '../src/source/artificialAnalysis.js';
import type { ScoringConfig } from '../src/config.js';

export const fixtureBody: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/aa-models-sample.json', import.meta.url), 'utf8'),
);

export const fixtureModels = () => parseModels(fixtureBody);

/**
 * A three-benchmark config with no quality floor, so tests can exercise
 * renormalization and each exclusion rule in isolation. (The committed
 * config/scoring.yaml is checked separately in scoring.test.ts.)
 */
export const defaultConfig = (overrides: Partial<ScoringConfig> = {}): ScoringConfig => ({
  excludeVendors: [],
  excludeModels: [],
  benchmarkWeights: { codingIndex: 0.5, liveCodeBench: 0.25, terminalBench: 0.25 },
  priceBasis: 'blended',
  minBenchmarksRequired: 1,
  qualityFloor: 0,
  provisionalMaxAgeDays: 0,
  // fixCostUsd 0 ⇒ cost per task ∝ price ÷ score, i.e. the plain score-per-dollar order.
  // Tests that exercise the time term set their own taskModel.
  taskModel: { tokensPerTaskMillions: 0.5, developerHourlyUsd: 0, minutesPerFailedAttempt: 0, fixCostUsd: 0 },
  ...overrides,
});
