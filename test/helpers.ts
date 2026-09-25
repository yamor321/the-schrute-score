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
  benchmarkWeights: { codingIndex: 0.5, liveCodeBench: 0.25, terminalBench: 0.25 },
  priceBasis: 'blended',
  minBenchmarksRequired: 1,
  qualityFloor: 0,
  provisionalMaxAgeDays: 0,
  ...overrides,
});
