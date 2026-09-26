import { describe, expect, it } from 'vitest';
import { computeValueTable } from '../src/scoring.js';
import { parseModels } from '../src/source/artificialAnalysis.js';
import { computeTaskScores, loadTaskTypes, parseTaskTypes } from '../src/taskTypes.js';
import { groupVariants } from '../src/variants.js';
import { defaultConfig } from './helpers.js';

// Five priced models with coding index 70–80; Terminal-Bench and long-context vary independently.
const m = (name: string, ci: number, tb: number | null, lcr: number | null, price = 2) => ({
  id: `id-${name}`,
  name,
  model_creator: { name: 'Lab', slug: 'lab' },
  evaluations: { artificial_analysis_coding_index: ci, terminalbench_v2_1: tb, lcr },
  pricing: { price_1m_input_tokens: price, price_1m_output_tokens: price },
});
const models = parseModels({
  data: [
    m('Terminal Pro', 75, 0.9, 0.7),
    m('Reader', 75, 0.6, 0.9),
    m('Average', 75, 0.75, 0.8),
    m('Strong', 80, 0.8, 0.85),
    m('No TB', 70, null, 0.75),
  ],
});
const types = parseTaskTypes({
  types: [
    { key: 'general', label: 'General', description: 'd', rationale: 'r', proxy: 'general', weights: { codingIndex: 1 } },
    { key: 'infra', label: 'Infra', description: 'd', rationale: 'r', proxy: 'strong', weights: { terminalBench: 1 } },
    { key: 'explore', label: 'Explore', description: 'd', rationale: 'r', proxy: 'weak', weights: { lcr: 0.6, codingIndex: 0.4 } },
  ],
});
type Scores = { general: number; infra: number; explore: number };
const scored = (): Record<string, Scores> => {
  const table = groupVariants(computeValueTable(models, defaultConfig({ benchmarkWeights: { codingIndex: 1 } })));
  const scores = computeTaskScores(table.ranked, models, types);
  return Object.fromEntries(table.ranked.map((r) => [r.name, scores.get(r.id) as Scores]));
};

describe('computeTaskScores', () => {
  it('a codingIndex-only type equals the coding score', () => {
    const s = scored();
    expect(s['Strong']!.general).toBe(80);
    expect(s['No TB']!.general).toBe(70);
  });

  it('maps a benchmark onto the coding-score scale (pool mean → coding-score mean)', () => {
    const s = scored();
    const withTb = ['Terminal Pro', 'Reader', 'Average', 'Strong'];
    // TB pool mean is 0.7625 → the mapped mean over models that have TB equals the pool's coding-score mean (75).
    const mean = withTb.reduce((a, n) => a + s[n]!.infra, 0) / withTb.length;
    expect(mean).toBeCloseTo(75, 5);
    expect(s['Terminal Pro']!.infra).toBeGreaterThan(s['Reader']!.infra);
  });

  it('treats a missing benchmark as neutral (the model\'s own coding score)', () => {
    expect(scored()['No TB']!.infra).toBe(70);
  });

  it('re-orders models with the same coding score by the chosen kind of work', () => {
    const s = scored();
    expect(s['Terminal Pro']!.infra).toBeGreaterThan(s['Reader']!.infra);
    expect(s['Reader']!.explore).toBeGreaterThan(s['Terminal Pro']!.explore);
  });
});

describe('task-types config', () => {
  it('loads the committed config/task-types.yaml', () => {
    const t = loadTaskTypes();
    expect(t.map((x) => x.key)).toEqual(['greenfield', 'legacy', 'explore', 'debug', 'prod', 'infra', 'algorithms', 'ui']);
    for (const x of t) expect(Object.values(x.weights).every((w) => w > 0)).toBe(true);
  });

  it.each([
    [{ types: [] }, /non-empty/],
    [{ types: [{ key: 'a', label: 'A', description: 'd', rationale: 'r', proxy: 'strong', weights: { vibes: 1 } }] }, /unknown benchmark/],
    [{ types: [{ key: 'a', label: 'A', description: 'd', rationale: 'r', proxy: 'meh', weights: { lcr: 1 } }] }, /proxy/],
    [{ types: [{ key: 'a', label: 'A', description: 'd', rationale: 'r', proxy: 'weak', weights: { lcr: 0 } }] }, /> 0/],
  ])('rejects invalid config %#', (input, message) => {
    expect(() => parseTaskTypes(input)).toThrow(message);
  });
});
