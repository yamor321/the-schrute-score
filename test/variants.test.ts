import { describe, expect, it } from 'vitest';
import { markNewModels } from '../src/newModels.js';
import { computeValueTable } from '../src/scoring.js';
import { parseModels } from '../src/source/artificialAnalysis.js';
import { groupVariants, levelLabel, splitVariant } from '../src/variants.js';
import { defaultConfig } from './helpers.js';

const model = (name: string, ci: number | null, input = 1, output = 3, creator = 'OpenAI') => ({
  id: `id-${name}`,
  name,
  model_creator: { name: creator, slug: creator.toLowerCase() },
  evaluations: { artificial_analysis_coding_index: ci },
  pricing: { price_1m_input_tokens: input, price_1m_output_tokens: output },
});

// Price 2 unless stated. Bar with qualityFloor 0.8 and best 80 → 64.
const body = {
  data: [
    model('Luna (max)', 70),
    model('Luna (xhigh)', 68),
    model('Luna (low)', 40),
    model('Luna (Non-reasoning)', 30),
    model('Sol (xhigh)', 80),
    model('Sol (high)', 76, 0.5, 1.5), // promo: cheaper level, value 76 vs 40
    model('Mini (high)', 50),
    model('Mini (low)', 45),
    model('Gemini 2.5 Pro (May \'25)', 66, 1, 3, 'Google'),
    model('Gemini 2.5 Pro (Mar \'25)', 65, 1, 3, 'Google'),
  ],
};
const table = () => groupVariants(computeValueTable(parseModels(body), defaultConfig({ benchmarkWeights: { codingIndex: 1 }, qualityFloor: 0.8 })));

describe('splitVariant / levelLabel', () => {
  it('treats effort and reasoning words as levels', () => {
    expect(splitVariant('GPT-5.5 (xhigh)')).toEqual({ base: 'GPT-5.5', level: 'xhigh' });
    expect(splitVariant('Claude Opus 5 (Adaptive Reasoning, Max Effort)').base).toBe('Claude Opus 5');
    expect(splitVariant('Claude Fable 5 (Adaptive Reasoning, Max Effort, Opus 4.8 Fallback)').base).toBe('Claude Fable 5');
    expect(splitVariant('Claude 4 Sonnet (Non-reasoning)').base).toBe('Claude 4 Sonnet');
  });

  it('keeps versions and other parentheticals as part of the model name', () => {
    expect(splitVariant("Gemini 2.5 Pro (May '25)").level).toBeNull();
    expect(splitVariant('Qwen3.8 Max (0902)').level).toBeNull();
    expect(splitVariant('Quasar 438B (max, based on GLM-5.2)').level).toBeNull();
  });

  it('prints short level labels', () => {
    expect(levelLabel('Adaptive Reasoning, Max Effort, Default Fallback')).toBe('max');
    expect(levelLabel('Non-reasoning, High Effort')).toBe('non-reasoning · high');
    expect(levelLabel('xhigh')).toBe('xhigh');
    expect(levelLabel(null)).toBe('standard');
  });
});

describe('groupVariants', () => {
  it('gives each model one row, headlined by its best level', () => {
    const { ranked } = table();
    // Values (headline level): Sol 80/2 = 40, Luna 70/2 = 35, Gemini May 66/2 = 33, Mar 65/2 = 32.5.
    expect(ranked.map((r) => r.name)).toEqual(['Sol', 'Luna', "Gemini 2.5 Pro (May '25)", "Gemini 2.5 Pro (Mar '25)"]);
    const luna = ranked.find((r) => r.name === 'Luna')!;
    expect(luna).toMatchObject({ codingScore: 70, headlineLevel: 'max', price: 2, value: 35, rank: 2 });
    expect(luna.id).toBe('model:openai:luna');
  });

  it('ranks the model even though its low levels are below the bar, and keeps every level for the tooltip', () => {
    const luna = table().ranked.find((r) => r.name === 'Luna')!;
    expect(luna.variants!.map((v) => [v.level, v.codingScore, v.status])).toEqual([
      ['max', 70, 'ranked'],
      ['xhigh', 68, 'ranked'],
      ['low', 40, 'below-quality-floor'],
      ['non-reasoning', 30, 'below-quality-floor'],
    ]);
    expect(luna.averageScore).toBe(52);
  });

  it('notes when another level wins on value (e.g. a cheaper price on that level)', () => {
    const sol = table().ranked.find((r) => r.name === 'Sol')!;
    expect(sol.headlineLevel).toBe('xhigh');
    expect(sol.value).toBe(40);
    expect(sol.bestValueLevel).toBe('high');
    expect(table().ranked.find((r) => r.name === 'Luna')!.bestValueLevel).toBeNull();
  });

  it('collapses unranked models to one excluded row that names the best level', () => {
    const { excluded } = table();
    expect(excluded.map((e) => e.name)).toEqual(['Mini']);
    expect(excluded[0]!.detail).toMatch(/best level: high$/);
    expect(excluded[0]!.variants).toHaveLength(2);
  });

  it('reports the best model by its model name', () => {
    expect(table().quality!.bestModel).toBe('Sol');
  });

  it('does not flag a known model as new when the previous snapshot only had its levels', () => {
    const t = table();
    const previous = { models: [], excluded: [{ id: 'id-Luna (max)' } as never] };
    const marked = markNewModels(t, previous);
    expect(marked.ranked.find((r) => r.name === 'Luna')!.isNew).toBeUndefined();
    expect(marked.ranked.find((r) => r.name === 'Sol')!.isNew).toBe(true);
  });
});
