import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { ExcludedModel, RankedModel, ValueTable } from './scoring.js';

/**
 * Marks which models can be picked in Cursor, using the hand-maintained list
 * in config/cursor-models.yaml.
 *
 * One Cursor model usually corresponds to several Artificial Analysis rows
 * (effort / reasoning variants). Every matching row gets `cursor: <name>`;
 * the dashboard shows a Cursor model as its own extra row only when none of
 * its variants is ranked — and then only once, via `representative` — so a
 * model never appears twice.
 */

export interface CursorEntry {
  /** As Cursor shows it, e.g. "Claude 4.5 Opus". */
  name: string;
  /** Artificial Analysis name, when it differs beyond word order/variants. */
  aa?: string;
  /** Display vendor for models AA has no data for. */
  vendor?: string;
}

export interface CursorConfig {
  source: string;
  checked: string;
  models: CursorEntry[];
}

export type CursorStatus = 'ranked' | 'below-quality-floor' | 'missing-price' | 'no-score' | 'vendor-filter' | 'not-in-aa';

export interface CursorModelStatus {
  name: string;
  vendor: string;
  status: CursorStatus;
  /** Best rank among the model's variants, when ranked. */
  bestRank: number | null;
  /** How many Artificial Analysis rows (variants) matched. */
  variants: number;
  /** The variant that stands in for this model when it isn't ranked (highest coding score). */
  representative: { id: string; name: string; codingScore: number | null; price: number | null; value: number | null } | null;
  /** One line for the dashboard. */
  detail: string;
}

export interface CursorSummary {
  source: string;
  checked: string;
  models: CursorModelStatus[];
}

export function parseCursorConfig(input: unknown): CursorConfig {
  const c = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(c.models)) throw new Error('cursor-models.yaml: `models` must be a list');
  const models = c.models.map((m, i): CursorEntry => {
    const e = (m ?? {}) as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name.trim()) throw new Error(`cursor-models.yaml: models[${i}] needs a name`);
    return {
      name: e.name.trim(),
      ...(typeof e.aa === 'string' && e.aa.trim() ? { aa: e.aa.trim() } : {}),
      ...(typeof e.vendor === 'string' && e.vendor.trim() ? { vendor: e.vendor.trim() } : {}),
    };
  });
  return { source: String(c.source ?? ''), checked: String(c.checked ?? ''), models };
}

export function loadCursorConfig(path = 'config/cursor-models.yaml'): CursorConfig {
  return parseCursorConfig(yaml.load(readFileSync(path, 'utf8')));
}

/**
 * Name key that ignores case, word order, dashes and anything in
 * parentheses: "Claude 4.5 Opus" and "Claude Opus 4.5 (Reasoning)" → "4.5 claude opus".
 */
export function modelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

type Row = (RankedModel | ExcludedModel) & { cursor?: string };

export function applyCursor(table: ValueTable, cfg: CursorConfig): { table: ValueTable; cursor: CursorSummary } {
  // Unique Cursor models by key (the YAML should not list one twice, but be safe).
  const entries = new Map<string, CursorEntry>();
  for (const e of cfg.models) {
    const key = modelKey(e.aa ?? e.name);
    if (!entries.has(key)) entries.set(key, e);
  }

  const tag = <T extends Row>(row: T): T => {
    const entry = entries.get(modelKey(row.name));
    const { cursor: _stale, ...rest } = row;
    return (entry ? { ...rest, cursor: entry.name } : rest) as T;
  };
  const ranked = table.ranked.map(tag);
  const excluded = table.excluded.map(tag);

  const minScore = table.quality?.minScore;
  const models: CursorModelStatus[] = [...entries.values()].map((entry) => {
    const rankedHits = ranked.filter((r) => r.cursor === entry.name);
    const excludedHits = excluded.filter((r) => r.cursor === entry.name);
    const variants = rankedHits.length + excludedHits.length;
    const vendor = rankedHits[0]?.vendor ?? excludedHits[0]?.vendor ?? entry.vendor ?? 'Unknown';
    const base = { name: entry.name, vendor, variants };

    if (rankedHits.length) {
      const bestRank = Math.min(...rankedHits.map((r) => r.rank));
      return { ...base, status: 'ranked', bestRank, representative: null, detail: `Ranked #${bestRank}` };
    }
    if (!excludedHits.length) {
      return {
        ...base,
        status: 'not-in-aa',
        bestRank: null,
        representative: null,
        detail: 'Not tracked by Artificial Analysis yet, so there is no benchmark data',
      };
    }

    const pick = (reason: ExcludedModel['reason']) =>
      excludedHits
        .filter((r) => r.reason === reason)
        .sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1))[0];
    const rep = (r: ExcludedModel) => ({
      id: r.id,
      name: r.name,
      codingScore: r.codingScore ?? null,
      price: r.price ?? null,
      value: r.value ?? null,
    });

    const below = pick('below-quality-floor');
    if (below) {
      return {
        ...base,
        status: 'below-quality-floor',
        bestRank: null,
        representative: rep(below),
        detail:
          `Below the quality bar: its best variant scores ${below.codingScore!.toFixed(1)}` +
          (minScore !== undefined ? ` (bar: ${minScore.toFixed(1)})` : ''),
      };
    }
    const vendorOut = pick('vendor-filter') ?? pick('model-filter');
    if (vendorOut) {
      return { ...base, status: 'vendor-filter', bestRank: null, representative: rep(vendorOut), detail: vendorOut.detail };
    }
    const noPrice = pick('missing-price');
    if (noPrice) {
      return {
        ...base,
        status: 'missing-price',
        bestRank: null,
        representative: rep(noPrice),
        detail: 'Artificial Analysis lists no price for it, so it cannot be compared on value',
      };
    }
    const noScore = pick('insufficient-benchmarks')!;
    return {
      ...base,
      status: 'no-score',
      bestRank: null,
      representative: rep(noScore),
      detail: 'No Coding Index result on Artificial Analysis yet',
    };
  });

  return {
    table: { ...table, ranked, excluded },
    cursor: { source: cfg.source, checked: cfg.checked, models },
  };
}
