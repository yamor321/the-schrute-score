import { describe, expect, it } from 'vitest';
import { fillProvisionalCodingIndex } from '../src/provisional.js';
import { computeValueTable } from '../src/scoring.js';
import { parseModels } from '../src/source/artificialAnalysis.js';
import { defaultConfig } from './helpers.js';

const now = new Date('2026-09-25T12:00:00Z');
const m = (name: string, ii: number | null, ci: number | null, release = '2026-01-01', price = 2) => ({
  id: `id-${name}`,
  name,
  release_date: release,
  model_creator: { name: 'Lab', slug: 'lab' },
  evaluations: { artificial_analysis_intelligence_index: ii, artificial_analysis_coding_index: ci },
  pricing: { price_1m_input_tokens: price, price_1m_output_tokens: price },
});

// Reference models lie exactly on CI = 1.5·II + 5.
const reference = [30, 35, 40, 45, 50].map((ii) => m(`Ref ${ii}`, ii, 1.5 * ii + 5));

describe('fillProvisionalCodingIndex', () => {
  it('estimates a new model from models with a similar Intelligence Index and marks it', () => {
    const models = parseModels({ data: [...reference, m('Brand New', 44, null, '2026-09-22')] });
    const { models: out, filled } = fillProvisionalCodingIndex(models, { now, maxAgeDays: 60 });
    expect(filled).toEqual([{ name: 'Brand New', intelligenceIndex: 44, estimate: 71, typicalError: 0 }]);
    const nu = out.find((x) => x.name === 'Brand New')!;
    expect(nu.evaluations.artificial_analysis_coding_index).toBe(71);
    expect(nu.estimate).toMatchObject({ kind: 'provisional' });
    expect(nu.estimate!.note).toMatch(/hasn't published its Coding Index yet/);
  });

  it('widens the error when extrapolating beyond the reference models', () => {
    const models = parseModels({ data: [...reference, m('Frontier', 58, null, '2026-09-22')] });
    const [f] = fillProvisionalCodingIndex(models, { now, maxAgeDays: 60 }).filled;
    expect(f!.estimate).toBe(92);
    expect(f!.typicalError).toBeGreaterThan(0);
  });

  it('leaves old models, models with a real score, and models without an Intelligence Index alone', () => {
    const models = parseModels({
      data: [...reference, m('Old', 44, null, '2025-01-01'), m('Scored', 44, 60, '2026-09-22'), m('No II', null, null, '2026-09-22')],
    });
    const { filled } = fillProvisionalCodingIndex(models, { now, maxAgeDays: 60 });
    expect(filled).toEqual([]);
  });

  it('can be turned off', () => {
    const models = parseModels({ data: [...reference, m('Brand New', 44, null, '2026-09-22')] });
    expect(fillProvisionalCodingIndex(models, { now, maxAgeDays: 0 }).filled).toEqual([]);
  });

  it('estimated scores are ranked but never set the quality bar', () => {
    const models = parseModels({ data: [...reference, m('Frontier', 58, null, '2026-09-22')] });
    const { models: out } = fillProvisionalCodingIndex(models, { now, maxAgeDays: 60 });
    const { ranked, quality } = computeValueTable(out, defaultConfig({ benchmarkWeights: { codingIndex: 1 }, qualityFloor: 0.9 }));
    expect(quality!.bestModel).toBe('Ref 50'); // 80, measured — not Frontier's estimated 92
    expect(ranked.map((r) => r.name)).toContain('Frontier');
    expect(ranked.find((r) => r.name === 'Frontier')!.estimate!.kind).toBe('provisional');
  });
});
