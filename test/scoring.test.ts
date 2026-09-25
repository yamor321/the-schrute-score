import { describe, expect, it } from 'vitest';
import { parseScoringConfig, loadScoringConfig } from '../src/config.js';
import { computeValueTable, taskCost } from '../src/scoring.js';
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

    // Grouped by reason, highest coding score first within a group.
    expect(excluded.map((e) => [e.name, e.reason])).toEqual([
      ['Zeta Free', 'missing-price'],
      ['Epsilon Unpriced', 'missing-price'],
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

  it('excludes specific models by name, ignoring case, word order and variants', () => {
    const { ranked, excluded } = computeValueTable(fixtureModels(), defaultConfig({ excludeModels: ['coder ALPHA'] }));
    expect(ranked.map((r) => r.name)).not.toContain('Alpha Coder');
    expect(excluded.find((e) => e.name === 'Alpha Coder')).toMatchObject({ reason: 'model-filter' });
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

  describe('quality floor', () => {
    // Priced, eligible coding scores: Alpha 60, Eta 53.33, Gamma 50, Beta 46.67.
    it('keeps only models within the floor of the best, then ranks them by value', () => {
      const { ranked, excluded, quality } = computeValueTable(fixtureModels(), defaultConfig({ qualityFloor: 0.8 }));
      expect(quality).toEqual({ ratio: 0.8, bestScore: 60, bestModel: 'Alpha Coder', minScore: 48 });
      // Beta (46.67) is the cheap-but-weaker model that no longer qualifies.
      expect(ranked.map((r) => [r.rank, r.name])).toEqual([
        [1, 'Gamma Open'],
        [2, 'Eta Half'],
        [3, 'Alpha Coder'],
      ]);
      const beta = byName(excluded, 'Beta Mini')!;
      expect(beta.reason).toBe('below-quality-floor');
      expect(beta.detail).toBe('Excluded: coding score 46.7 is below the quality floor of 48.0 (80% of the best, 60.0)');
      expect(excluded[0]!.name).toBe('Beta Mini');
    });

    it('a high floor leaves only the top model', () => {
      const { ranked } = computeValueTable(fixtureModels(), defaultConfig({ qualityFloor: 0.9 }));
      expect(ranked.map((r) => r.name)).toEqual(['Alpha Coder']);
    });

    it('is relative to the best model that has a price (unpriced models cannot raise it)', () => {
      const models = fixtureModels();
      models.find((m) => m.name === 'Zeta Free')!.evaluations.artificial_analysis_coding_index = 100;
      const { quality } = computeValueTable(models, defaultConfig({ qualityFloor: 0.8 }));
      expect(quality!.bestModel).toBe('Alpha Coder');
    });

    it('is relative to the best remaining model after vendor exclusion', () => {
      const { quality, ranked } = computeValueTable(
        fixtureModels(),
        defaultConfig({ qualityFloor: 0.9, excludeVendors: ['anthropic'] }),
      );
      expect(quality!.bestModel).toBe('Eta Half');
      expect(ranked.map((r) => r.name)).toEqual(['Gamma Open', 'Eta Half']);
    });

    it('a floor of 0 ranks everything that has a price', () => {
      expect(computeValueTable(fixtureModels(), defaultConfig({ qualityFloor: 0 })).ranked).toHaveLength(4);
    });
  });

  describe('cost per finished task', () => {
    it('computes tokens (retries included) and your time for failures', () => {
      // Opus 5.5 example from the README: score 80.9, $12/1M, 0.5M tokens, $50 per fix.
      const c = taskCost(80.9, 12, { tokensPerTaskMillions: 0.5, fixCostUsd: 50 });
      expect(c.tokens).toBeCloseTo((12 * 0.5) / 0.809, 5); // 7.42
      expect(c.time).toBeCloseTo((50 * 0.191) / 0.809, 5); // 11.80
      expect(c.total).toBeCloseTo(19.22, 2);
    });

    it('golden fixture: pricing in your time lifts the stronger model', () => {
      const { ranked } = computeValueTable(fixtureModels(), defaultConfig({ taskModel: { tokensPerTaskMillions: 0.5, fixCostUsd: 50 } }));
      // Hand-computed (p = score/100):
      // Alpha 60 @ $9:     (4.5 + 50·0.4) / 0.6            = 40.83
      // Eta   53.33 @ 2.5: (1.25 + 50·0.4667) / 0.5333     = 46.09
      // Gamma 50 @ $0.5:   (0.25 + 50·0.5) / 0.5           = 50.50
      // Beta  46.67 @ $1:  (0.5 + 50·0.5333) / 0.4667      = 58.21
      expect(ranked.map((r) => r.name)).toEqual(['Alpha Coder', 'Eta Half', 'Gamma Open', 'Beta Mini']);
      expect(ranked.map((r) => +r.effectiveCost.toFixed(2))).toEqual([40.83, 46.09, 50.5, 58.21]);
      const alpha = ranked[0]!;
      expect(alpha.costBreakdown.tokens + alpha.costBreakdown.time).toBeCloseTo(alpha.effectiveCost, 5);
    });

    it('with $0 per fix it reduces to the cheapest-per-point order', () => {
      const { ranked } = computeValueTable(fixtureModels(), defaultConfig({ taskModel: { tokensPerTaskMillions: 0.5, fixCostUsd: 0 } }));
      expect(ranked[0]!.name).toBe('Gamma Open');
    });
  });

  it('notes when the blended price falls back to AA 3:1 blended', () => {
    const eta = byName(computeValueTable(fixtureModels(), defaultConfig()).ranked, 'Eta Half')!;
    expect(eta.priceNote).toMatch(/3:1/);
  });
});

describe('scoring config', () => {
  it('loads the committed config/scoring.yaml', () => {
    expect(loadScoringConfig()).toEqual({
      excludeVendors: [],
      excludeModels: ['Step 5 Preview'],
      benchmarkWeights: { codingIndex: 1 },
      priceBasis: 'blended',
      minBenchmarksRequired: 1,
      qualityFloor: 0.85,
      provisionalMaxAgeDays: 60,
      taskModel: { tokensPerTaskMillions: 0.5, fixCostUsd: 50 },
    });
  });

  it('defaults qualityFloor to 0 when omitted', () => {
    expect(parseScoringConfig({ benchmarkWeights: { codingIndex: 1 } }).qualityFloor).toBe(0);
  });

  it.each([
    [{ benchmarkWeights: {} }, /at least one positive weight/],
    [{ benchmarkWeights: { codingIndex: 'high' } }, /non-negative number/],
    [{ benchmarkWeights: { codingIndex: 1 }, priceBasis: 'cheapest' }, /priceBasis/],
    [{ benchmarkWeights: { codingIndex: 1 }, minBenchmarksRequired: 2 }, /no model could ever qualify/],
    [{ benchmarkWeights: { codingIndex: 1 }, excludeVendors: 'google' }, /must be a list/],
    [{ benchmarkWeights: { codingIndex: 1 }, qualityFloor: 90 }, /between 0 and 1/],
    [{ benchmarkWeights: { codingIndex: 1 }, taskModel: { tokensPerTaskMillions: 0 } }, /tokensPerTaskMillions/],
    [{ benchmarkWeights: { codingIndex: 1 }, taskModel: { fixCostUsd: -5 } }, /fixCostUsd/],
    [{ benchmarkWeights: { codingIndex: 1 }, taskModel: 'lots' }, /taskModel/],
    [{ benchmarkWeights: { codingIndex: 1 }, qualityFloor: -0.1 }, /between 0 and 1/],
  ])('rejects invalid config %j', (input, message) => {
    expect(() => parseScoringConfig(input)).toThrow(message);
  });
});
