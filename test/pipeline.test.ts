import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markNewModels } from '../src/newModels.js';
import { hasMeaningfulChange, readSnapshot, runStamp, writeRun, type Snapshot } from '../src/persist.js';
import { computeValueTable } from '../src/scoring.js';
import { defaultConfig, fixtureBody, fixtureModels } from './helpers.js';

const makeSnapshot = (generatedAt = '2026-09-25T05:00:00.000Z'): Snapshot => {
  const { ranked, excluded, quality } = computeValueTable(fixtureModels(), defaultConfig());
  return {
    generatedAt,
    source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai' },
    config: defaultConfig(),
    counts: { fetched: 7, ranked: ranked.length, excluded: excluded.length },
    quality,
    cursor: null,
    models: ranked,
    excluded,
  };
};

describe('markNewModels', () => {
  it('flags nothing on the very first run', () => {
    const table = computeValueTable(fixtureModels(), defaultConfig());
    const marked = markNewModels(table, null);
    expect([...marked.ranked, ...marked.excluded].some((m) => m.isNew)).toBe(false);
  });

  it('flags ids missing from the previous snapshot (ranked or excluded)', () => {
    const previous = makeSnapshot();
    previous.models = previous.models.filter((m) => m.name !== 'Beta Mini');
    previous.excluded = previous.excluded.filter((m) => m.name !== 'Zeta Free');

    const marked = markNewModels(computeValueTable(fixtureModels(), defaultConfig()), previous);
    const flagged = [...marked.ranked, ...marked.excluded].filter((m) => m.isNew).map((m) => m.name);
    expect(flagged.sort()).toEqual(['Beta Mini', 'Zeta Free']);
  });

  it('is one-cycle-only: the next run against that snapshot clears the flag', () => {
    const previous = makeSnapshot();
    previous.models = previous.models.filter((m) => m.name !== 'Beta Mini');
    const run1 = markNewModels(computeValueTable(fixtureModels(), defaultConfig()), previous);
    const snapshot1 = { ...makeSnapshot(), models: run1.ranked, excluded: run1.excluded };

    const run2 = markNewModels(computeValueTable(fixtureModels(), defaultConfig()), snapshot1);
    expect(run2.ranked.some((m) => m.isNew)).toBe(false);
  });

  it('treats a model moving from excluded to ranked (config change) as not new', () => {
    const strict = computeValueTable(fixtureModels(), defaultConfig({ minBenchmarksRequired: 3 }));
    const previous = { models: strict.ranked, excluded: strict.excluded };
    const marked = markNewModels(computeValueTable(fixtureModels(), defaultConfig()), previous);
    expect(marked.ranked.some((m) => m.isNew)).toBe(false);
  });
});

describe('persistence', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('formats the run stamp as UTC YYYY-MM-DDTHH', () => {
    expect(runStamp(new Date('2026-09-25T17:04:59Z'))).toBe('2026-09-25T17');
  });

  it('ignores generatedAt when deciding whether anything changed', () => {
    const a = makeSnapshot('2026-09-25T05:00:00.000Z');
    const b = makeSnapshot('2026-09-25T17:00:00.000Z');
    expect(hasMeaningfulChange(null, a)).toBe(true);
    expect(hasMeaningfulChange(a, b)).toBe(false);
    b.models[0]!.price = 0.49;
    expect(hasMeaningfulChange(a, b)).toBe(true);
  });

  it('writes raw, history and latest, and reads latest back', () => {
    dir = mkdtempSync(join(tmpdir(), 'schrute-'));
    const snapshot = makeSnapshot();
    writeRun({ dataDir: dir, stamp: '2026-09-25T05', rawBody: fixtureBody, snapshot });

    expect(readdirSync(join(dir, 'raw'))).toEqual(['2026-09-25T05.json']);
    expect(readdirSync(join(dir, 'history'))).toEqual(['2026-09-25T05.json']);
    expect(JSON.parse(readFileSync(join(dir, 'raw', '2026-09-25T05.json'), 'utf8'))).toEqual(fixtureBody);
    expect(readSnapshot(join(dir, 'latest.json'))).toEqual(snapshot);
  });

  it('returns null when there is no previous latest.json and throws on a corrupt one', () => {
    dir = mkdtempSync(join(tmpdir(), 'schrute-'));
    expect(readSnapshot(join(dir, 'latest.json'))).toBeNull();
    writeFileSync(join(dir, 'latest.json'), '{"generatedAt":"x"}');
    expect(() => readSnapshot(join(dir!, 'latest.json'))).toThrow(/not a valid snapshot/);
  });
});
