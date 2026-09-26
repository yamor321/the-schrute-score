import { describe, expect, it } from 'vitest';
import { computeValueTable } from '../src/scoring.js';
import { arenaKeys, fetchWebDevArena, matchArena, ourArenaKey } from '../src/sources/lmarena.js';
import { parseModels } from '../src/source/artificialAnalysis.js';
import { loadTaskBenchmarks, parseTaskBenchmarks, staleBenchmarks, type TaskBenchmark } from '../src/taskBenchmarks.js';
import { API_SOURCES, computeTaskScores, loadTaskTypes, parseTaskTypes } from '../src/taskTypes.js';
import { groupVariants } from '../src/variants.js';
import { defaultConfig } from './helpers.js';

// Five priced models; coding index 70–80, Terminal-Bench varies independently.
const m = (name: string, ci: number, tb: number | null, price = 2) => ({
  id: `id-${name}`,
  name,
  model_creator: { name: 'Lab', slug: 'lab' },
  evaluations: { artificial_analysis_coding_index: ci, terminalbench_v2_1: tb },
  pricing: { price_1m_input_tokens: price, price_1m_output_tokens: price },
});
const models = parseModels({ data: [m('Alpha', 80, 0.8), m('Beta', 75, 0.9), m('Gamma', 75, 0.6), m('Delta', 70, 0.7), m('Eps', 72, null)] });
// A leaderboard with its own scale; Delta leads it despite the lowest coding score.
const board: TaskBenchmark = {
  key: 'qna',
  label: 'QnA',
  publisher: 'X',
  url: 'https://example.com',
  asOf: '2026-09-01',
  measures: 'm',
  scores: { Alpha: 60, Beta: 50, Delta: 70 },
  vendorReported: [],
};
const types = parseTaskTypes(
  {
    types: [
      { key: 'general', label: 'General', description: 'd', sources: ['codingIndex'] },
      { key: 'infra', label: 'Infra', description: 'd', sources: ['terminalBench'] },
      { key: 'explore', label: 'Explore', description: 'd', sources: ['qna'] },
      { key: 'mix', label: 'Mix', description: 'd', sources: ['codingIndex', 'qna'] },
    ],
  },
  [...Object.keys(API_SOURCES), 'qna'],
);
const run = () => {
  const table = groupVariants(computeValueTable(models, defaultConfig({ benchmarkWeights: { codingIndex: 1 } })));
  const res = computeTaskScores(table.ranked, models, types, [board]);
  const by = Object.fromEntries(table.ranked.map((r) => [r.name, res.perModel.get(r.id)!]));
  return { by, sources: res.sources };
};

describe('computeTaskScores', () => {
  it('a coding-index type is always measured and equals the coding score', () => {
    const { by } = run();
    expect(by['Alpha']!.scores.general).toBe(80);
    expect(by['Alpha']!.status.general).toBe('measured');
  });

  it('uses the benchmark\'s own success rate as the score when a model was measured', () => {
    const { by } = run();
    expect(by['Delta']!.status.explore).toBe('measured');
    // Direct pass rates, not squeezed onto the coding-score scale.
    expect(by['Delta']!.scores.explore).toBe(70);
    expect(by['Alpha']!.scores.explore).toBe(60);
    expect(by['Beta']!.scores.explore).toBe(50);
    expect(by['Alpha']!.scores.infra).toBe(80); // Terminal-Bench 0.8
  });

  it('estimates unmeasured models from a fit on the coding score, minus one residual SD', () => {
    const { by, sources } = run();
    const qna = sources.find((s) => s.key === 'qna')!;
    expect(qna.measured).toBe(3);
    expect(by['Gamma']!.status.explore).toBe('estimated');
    // Fit over Alpha (80, .6), Beta (75, .5), Delta (70, .7): slope −0.01, intercept 1.35,
    // residual SD √(0.015/1) ≈ 0.1225 → Gamma (CI 75): 0.60 − 0.1225 = 0.4775.
    expect(qna.fitR!).toBeLessThan(0);
    expect(by['Gamma']!.scores.explore!).toBeCloseTo(47.75, 1);
    // A model measured at the average (Alpha, 60%) beats the unmeasured model's conservative estimate.
    expect(by['Alpha']!.scores.explore!).toBeGreaterThan(by['Gamma']!.scores.explore!);
  });

  it('turns an Elo rating into the chance of beating the average model', () => {
    const arena: TaskBenchmark = { ...board, key: 'arena', kind: 'elo', scores: { Alpha: 1600, Beta: 1500, Delta: 1400 } };
    const t = parseTaskTypes({ types: [{ key: 'ui', label: 'UI', description: 'd', sources: ['arena'] }] }, ['arena']);
    const table = groupVariants(computeValueTable(models, defaultConfig({ benchmarkWeights: { codingIndex: 1 } })));
    const res = computeTaskScores(table.ranked, models, t, [arena]);
    const ui = (n: string) => res.perModel.get(table.ranked.find((r) => r.name === n)!.id)!.scores.ui!;
    expect(ui('Beta')).toBeCloseTo(50, 3); // at the average rating → 50%
    expect(ui('Alpha')).toBeCloseTo(100 / (1 + 10 ** (-100 / 400)), 3); // +100 Elo ≈ 64%
  });

  it('marks a type partial when only some of its sources were measured', () => {
    const { by } = run();
    expect(by['Gamma']!.status.mix).toBe('partial');
    expect(by['Alpha']!.status.mix).toBe('measured');
  });

  it('reports coverage and agreement per source', () => {
    const tb = run().sources.find((s) => s.key === 'terminalBench')!;
    expect(tb.measured).toBe(4);
    expect(tb.label).toBe('Terminal-Bench v2.1');
  });
});

describe('LMArena name matching', () => {
  it('matches effort levels, harness notes, dashed versions and dates', () => {
    const b = {
      asOf: '2026-09-25',
      rows: [
        { name: 'claude-opus-5.5-max', rating: 1826.7 },
        { name: 'claude-opus-4-7-high', rating: 1556.7 },
        { name: 'claude-opus-4-7', rating: 1556.1 },
        { name: 'gpt-5.6-sol-xhigh (codex-harness)', rating: 1617.4 },
        { name: 'qwen3.8-max', rating: 1671.5 },
        { name: 'qwen3.8-max-0902', rating: 1661.6 },
        { name: 'deepseek-v4-pro-high-20260813', rating: 1582.0 },
      ],
    };
    expect(matchArena(b, ['Claude Opus 5.5', 'Claude Opus 4.7', 'GPT-5.6 Sol', 'Qwen3.8 Max', 'Qwen3.8 Max (0902)', 'DeepSeek V4 Pro', 'Claude Opus 5'])).toEqual({
      'Claude Opus 5.5': 1826.7,
      'Claude Opus 4.7': 1556.7,
      'GPT-5.6 Sol': 1617.4,
      'Qwen3.8 Max': 1671.5,
      'Qwen3.8 Max (0902)': 1661.6,
      'DeepSeek V4 Pro': 1582,
    });
  });

  it('builds comparable keys', () => {
    expect(arenaKeys('claude-opus-4-7-high')).toContain(ourArenaKey('Claude Opus 4.7'));
    expect(arenaKeys('mimo-v2.6-pro')).toContain(ourArenaKey('MiMo-V2.6-Pro'));
  });

  it('pages through the dataset and keeps only the overall category', async () => {
    const pages = [
      { num_rows_total: 3, rows: [{ row: { model_name: 'a', rating: 1500, category: 'overall', leaderboard_publish_date: '2026-09-25' } }, { row: { model_name: 'b', rating: 1400, category: 'other' } }] },
      { num_rows_total: 3, rows: [{ row: { model_name: 'c', rating: 1300, category: 'overall' } }] },
    ];
    let call = 0;
    const fake = (async () => new Response(JSON.stringify(pages[Math.min(call++, 1)]), { status: 200 })) as unknown as typeof fetch;
    const got = await fetchWebDevArena(fake);
    expect(got.asOf).toBe('2026-09-25');
    expect(got.rows.map((r) => r.name)).toEqual(['a']);
  });
});

describe('config files', () => {
  it('loads the committed task-benchmarks.yaml and task-types.yaml', () => {
    const b = loadTaskBenchmarks();
    expect(b.map((x) => x.key)).toEqual(['sweAtlasQna', 'itbench', 'deepswe']);
    const t = loadTaskTypes([...Object.keys(API_SOURCES), ...b.map((x) => x.key), 'webdev']);
    expect(t.map((x) => x.key)).toEqual(['greenfield', 'legacy', 'explore', 'debug', 'prod', 'infra', 'algorithms', 'ui']);
    expect(t.find((x) => x.key === 'explore')!.sources).toEqual(['sweAtlasQna']);
  });

  it('flags snapshots older than 60 days', () => {
    const [b] = parseTaskBenchmarks({ benchmarks: { x: { label: 'X', publisher: 'P', url: 'u', measures: 'm', asOf: '2026-01-01', scores: { a: 1, b: 2, c: 3 } } } });
    expect(staleBenchmarks([b!], new Date('2026-09-26'))).toEqual(['X (last checked 2026-01-01)']);
    expect(staleBenchmarks([b!], new Date('2026-02-01'))).toEqual([]);
  });

  it.each([
    [{ types: [] }, /non-empty/],
    [{ types: [{ key: 'a', label: 'A', description: 'd', sources: ['vibes'] }] }, /unknown source/],
    [{ types: [{ key: 'a', label: 'A', description: 'd', sources: [] }] }, /sources/],
  ])('rejects invalid task types %#', (input, message) => {
    expect(() => parseTaskTypes(input, Object.keys(API_SOURCES))).toThrow(message);
  });
});
