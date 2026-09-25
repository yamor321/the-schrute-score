import { describe, expect, it } from 'vitest';
import { loadManualModels, mergeManualModels, parseManualModels } from '../src/manualModels.js';
import { computeValueTable } from '../src/scoring.js';
import { defaultConfig, fixtureModels } from './helpers.js';

const composer = {
  models: [
    {
      id: 'manual-composer',
      name: 'Composer 2.5',
      vendor: 'Cursor',
      codingIndex: 70,
      inputPrice: 0.5,
      outputPrice: 2.5,
      estimate: 'Derived from the Coding Agent Index.',
      sources: ['https://example.com/a'],
    },
  ],
};

describe('manual models', () => {
  it('parses an entry into a scoreable model carrying its estimate', () => {
    const [m] = parseManualModels(composer);
    expect(m).toMatchObject({
      id: 'manual-composer',
      name: 'Composer 2.5',
      vendor: 'Cursor',
      evaluations: { artificial_analysis_coding_index: 70 },
      pricing: { input: 0.5, output: 2.5, blended3to1: null },
      estimate: { note: 'Derived from the Coding Agent Index.', sources: ['https://example.com/a'] },
    });
  });

  it('is ranked like any other model, with the estimate passed through', () => {
    const { models } = mergeManualModels(fixtureModels(), parseManualModels(composer));
    const { ranked } = computeValueTable(models, defaultConfig({ benchmarkWeights: { codingIndex: 1 } }));
    const row = ranked.find((r) => r.name === 'Composer 2.5')!;
    expect(row.codingScore).toBe(70);
    expect(row.price).toBe(1.5); // (0.5 + 2.5) / 2
    expect(row.value).toBeCloseTo(70 / 1.5, 5);
    expect(row.estimate?.note).toMatch(/Coding Agent Index/);
    expect(ranked.find((r) => r.name === 'Alpha Coder')!.estimate).toBeUndefined();
  });

  it('is dropped when Artificial Analysis already has the model (no duplicates)', () => {
    const aa = fixtureModels();
    const dup = parseManualModels({ models: [{ ...composer.models[0], name: 'Coder Alpha (max)' }] });
    const merged = mergeManualModels(aa, dup);
    expect(merged.models).toHaveLength(aa.length);
    expect(merged.superseded).toEqual(['Coder Alpha (max)']);
  });

  it('rejects entries without an explanation or with a bad score', () => {
    expect(() => parseManualModels({ models: [{ ...composer.models[0], estimate: '' }] })).toThrow(/estimate/);
    expect(() => parseManualModels({ models: [{ ...composer.models[0], codingIndex: 700 }] })).toThrow(/0–100/);
    expect(() => parseManualModels({ models: [{ ...composer.models[0], inputPrice: 'cheap' }] })).toThrow(/inputPrice/);
  });

  it('loads the committed config/manual-models.yaml', () => {
    const models = loadManualModels();
    expect(models.map((m) => m.name)).toContain('Composer 2.5');
    for (const m of models) expect(m.estimate!.sources.length).toBeGreaterThan(0);
  });
});
