import { describe, expect, it } from 'vitest';
import { parseScoringConfig, loadScoringConfig } from '../src/config.js';
import { computeValueTable } from '../src/scoring.js';
import { defaultConfig, fixtureModels } from './helpers.js';

const byName = <T extends { name: string }>(rows: T[], name: string) => rows.find((r) => r.name === name);

describe('computeValueTable', () => {
  it('golden fixture: ranks by codingScore / price with hand-computed values', () => {
    const { ranked, excluded } = computeValueTable(fixtureModels(), defaultConfig());

    // Hand-computed (weights 0.5 / 0.25 / 0.25, blended = (in+out)/2):
    // Gamma: 0.5·50 + 0.25·70 + 0.25·30 = 50;   price (0.2+0.8)/2 = 0.5  → value 100
    // Beta:  (0.5·40 + 0.25·60) / 0.75 = 46.67;  price (0.5+1.5)/2 = 1    → value 46.67
    // Eta:   (0.5·55 + 0.25·50) / 0.75 = 53.33;  price fallback 2.5       → value 21.33
    // Alpha: 0.5·60 + 0.25·80 + 0.25·40 = 60;   price (3+15)/2 = 9       → value 6.67
    expect(ranked.map((r) => [r.rank, r.name])).toEqual([
      [1, 'Gamma Open'],
      [2, 'Beta Mini'],
      [3, 'Eta Half'],
      [4, 'Alpha Coder'],
    ]);
    const expected: Record<string, [number, number, number]> = {
      'Gamma Open': [50, 0.5, 100],
      'Beta Mini': [140 / 3, 1, 140 / 3],
      'Eta Half': [160 / 3, 2.5, 160 / 3 / 2.5],
      'Alpha Coder': [60, 9, 60 / 9],
    };
    for (const row of ranked) {
      const [score, price, value] = expected[row.name]!;
      expect(row.codingScore).toBeCloseTo(score, 5);
      expect(row.price).toBeCloseTo(price, 5);
      expect(row.value).toBeCloseTo(value, 5);
      expect(row.priceBasis).toBe('blended');
    }

    expect(excluded.map((e) => [e.name, e.reason])).toEqual([
      ['Epsilon Unpriced', 'missing-price'],
      ['Zeta Free', 'missing-price'],
      ['Delta Legacy', 'insufficient-benchmarks'],
    ]);
  });

  it('carries every raw input on each row', () => {
    const alpha = byName(computeValueTable(fixtureModels(), defaultConfig()).ranked, 'Alpha Coder')!;
    expect(alpha.benchmarks.liveCodeBench).toEqual({
      label: 'LiveCodeBench',
      field: 'livecodebench',
      raw: 0.8,
      normalized: 80,
      weight: 0.25,
      effectiveWeight: 0.25,
      present: true,
    });
    expect(alpha.benchmarks.codingIndex!.normalized).toBe(60);
    expect(alpha).toMatchObject({ inputPrice: 3, outputPrice: 15, missingBenchmarks: [], priceNote: null });
  });

  it('excludes vendors case-insensitively with trimmed matching (name or slug)', () => {
    const cfg = parseScoringConfig({ ...defaultConfig(), excludeVendors: ['  DeepSeek ', 'XAI'] });
    const { ranked, excluded } = computeValueTable(fixtureModels(), cfg);
    expect(ranked.map((r) => r.name)).toEqual(['Beta Mini', 'Alpha Coder']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    const vendorExcluded = excluded.filter((e) => e.reason === 'vendor-filter').map((e) => e.name);
    expect(vendorExcluded.sort()).toEqual(['Eta Half', 'Gamma Open']);
    expect(byName(excluded, 'Gamma Open')!.detail).toMatch(/vendor filter/);
  });

  it('excludes models below minBenchmarksRequired and says why', () => {
    const { ranked, excluded } = computeValueTable(fixtureModels(), defaultConfig({ minBenchmarksRequired: 3 }));
    // Only Alpha and Gamma have all three benchmarks.
    expect(ranked.map((r) => r.name)).toEqual(['Gamma Open', 'Alpha Coder']);
    const thin = excluded.filter((e) => e.reason === 'insufficient-benchmarks').map((e) => e.name).sort();
    expect(thin).toEqual(['Beta Mini', 'Delta Legacy', 'Epsilon Unpriced', 'Eta Half']);
    expect(byName(excluded, 'Beta Mini')!.detail).toBe('Excluded: has 2 of the 3 scored benchmarks (minimum 3)');
  });

  it('renormalizes weights over the benchmarks a model actually has', () => {
    const beta = byName(computeValueTable(fixtureModels(), defaultConfig()).ranked, 'Beta Mini')!;
    expect(beta.missingBenchmarks).toEqual(['terminalBench']);
    expect(beta.benchmarksUsed).toEqual(['codingIndex', 'liveCodeBench']);
    expect(beta.benchmarks.codingIndex!.effectiveWeight).toBeCloseTo(2 / 3, 5);
    expect(beta.benchmarks.liveCodeBench!.effectiveWeight).toBeCloseTo(1 / 3, 5);
    expect(beta.benchmarks.terminalBench).toMatchObject({ present: false, effectiveWeight: null, raw: null });
    const sum = Object.values(beta.benchmarks).reduce((s, b) => s + (b.effectiveWeight ?? 0), 0);
    expect(sum).toBeCloseTo(1, 5);
    // Not penalized: the missing benchmark is not treated as zero.
    expect(beta.codingScore).toBeGreaterThan(0.5 * 40 + 0.25 * 60);
  });

  it('excludes models with missing or zero price, keeping their coding score for display', () => {
    const { excluded } = computeValueTable(fixtureModels(), defaultConfig());
    expect(byName(excluded, 'Epsilon Unpriced')).toMatchObject({
      reason: 'missing-price',
      detail: 'Excluded: no blended price listed',
    });
    const zeta = byName(excluded, 'Zeta Free')!;
    expect(zeta.detail).toMatch(/\$0/);
    expect(zeta.codingScore).toBeCloseTo(0.5 * 45 + 0.25 * 50 + 0.25 * 20, 5);
  });

  it('uses the configured price basis', () => {
    const { ranked } = computeValueTable(fixtureModels(), defaultConfig({ priceBasis: 'output' }));
    expect(byName(ranked, 'Alpha Coder')!.price).toBe(15);
    // Eta has no output price, so it drops out under this basis.
    expect(byName(ranked, 'Eta Half')).toBeUndefined();
  });

  it('notes when the blended price falls back to AA 3:1 blended', () => {
    const eta = byName(computeValueTable(fixtureModels(), defaultConfig()).ranked, 'Eta Half')!;
    expect(eta.priceNote).toMatch(/3:1/);
  });
});

describe('scoring config', () => {
  it('loads the committed config/scoring.yaml', () => {
    expect(loadScoringConfig()).toEqual(defaultConfig());
  });

  it.each([
    [{ benchmarkWeights: {} }, /at least one positive weight/],
    [{ benchmarkWeights: { codingIndex: 'high' } }, /non-negative number/],
    [{ benchmarkWeights: { codingIndex: 1 }, priceBasis: 'cheapest' }, /priceBasis/],
    [{ benchmarkWeights: { codingIndex: 1 }, minBenchmarksRequired: 2 }, /no model could ever qualify/],
    [{ benchmarkWeights: { codingIndex: 1 }, excludeVendors: 'google' }, /must be a list/],
  ])('rejects invalid config %j', (input, message) => {
    expect(() => parseScoringConfig(input)).toThrow(message);
  });
});
