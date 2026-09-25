import { describe, expect, it } from 'vitest';
import { applyCursor, loadCursorConfig, modelKey, parseCursorConfig } from '../src/cursor.js';
import { computeValueTable } from '../src/scoring.js';
import { defaultConfig, fixtureModels } from './helpers.js';

// Fixture at qualityFloor 0.8 (bar 48): ranked Gamma, Eta, Alpha; Beta (46.7) below the bar;
// Zeta & Epsilon have no price; Delta has no benchmarks.
const table = () => computeValueTable(fixtureModels(), defaultConfig({ qualityFloor: 0.8 }));

const cursorCfg = parseCursorConfig({
  source: 'https://cursor.com/docs/models',
  checked: '2026-09-25',
  models: [
    { name: 'Coder Alpha' },            // word order differs from "Alpha Coder"
    { name: 'Beta-Mini' },              // dash vs space
    { name: 'Zeta Free' },
    { name: 'Delta Legacy' },
    { name: 'Gamma', aa: 'Gamma Open' }, // explicit alias
    { name: 'Composer 2.5', vendor: 'Cursor' },
    { name: 'Alpha Coder' },            // duplicate of the first — ignored
  ],
});

describe('modelKey', () => {
  it('ignores case, word order, dashes and parenthesized variants', () => {
    expect(modelKey('Claude 4.5 Opus')).toBe(modelKey('Claude Opus 4.5 (Reasoning)'));
    expect(modelKey('GPT-5.2 Codex')).toBe(modelKey('GPT-5.2 Codex (xhigh)'));
    expect(modelKey('GLM 5.2')).toBe(modelKey('GLM-5.2 (max)'));
    expect(modelKey('GPT-5 Mini')).not.toBe(modelKey('GPT-5 (high)'));
  });
});

describe('applyCursor', () => {
  it('tags every matching ranked and excluded row with the Cursor name', () => {
    const { table: t } = applyCursor(table(), cursorCfg);
    expect(t.ranked.find((r) => r.name === 'Alpha Coder')!.cursor).toBe('Coder Alpha');
    expect(t.ranked.find((r) => r.name === 'Gamma Open')!.cursor).toBe('Gamma');
    expect(t.ranked.find((r) => r.name === 'Eta Half')!.cursor).toBeUndefined();
    expect(t.excluded.find((r) => r.name === 'Beta Mini')!.cursor).toBe('Beta-Mini');
  });

  it('lists each Cursor model once with its status', () => {
    const { cursor } = applyCursor(table(), cursorCfg);
    expect(cursor.models.map((m) => [m.name, m.status])).toEqual([
      ['Coder Alpha', 'ranked'],
      ['Beta-Mini', 'below-quality-floor'],
      ['Zeta Free', 'missing-price'],
      ['Delta Legacy', 'no-score'],
      ['Gamma', 'ranked'],
      ['Composer 2.5', 'not-in-aa'],
    ]);
  });

  it('gives ranked models their best rank and below-bar models one representative row', () => {
    const { cursor } = applyCursor(table(), cursorCfg);
    const byName = Object.fromEntries(cursor.models.map((m) => [m.name, m]));
    expect(byName['Gamma']!.bestRank).toBe(1);
    expect(byName['Coder Alpha']!.bestRank).toBe(3);
    expect(byName['Beta-Mini']!.representative).toMatchObject({ name: 'Beta Mini', price: 1 });
    expect(byName['Beta-Mini']!.representative!.codingScore).toBeCloseTo(46.67, 2);
    expect(byName['Beta-Mini']!.detail).toMatch(/bar: 48\.0/);
    expect(byName['Composer 2.5']).toMatchObject({ vendor: 'Cursor', variants: 0, representative: null });
  });
});

describe('config/cursor-models.yaml', () => {
  it('loads and has no duplicate models', () => {
    const cfg = loadCursorConfig();
    expect(cfg.models.length).toBeGreaterThan(10);
    const keys = cfg.models.map((m) => modelKey(m.aa ?? m.name));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
