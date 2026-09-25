import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { modelKey } from './cursor.js';
import type { AaModel } from './source/artificialAnalysis.js';

/**
 * Hand-added models (config/manual-models.yaml) for models the Artificial
 * Analysis API doesn't include, e.g. Cursor's Composer. Each carries an
 * estimated Coding Index and its reasoning, and is scored like any other
 * model. When AA itself lists a model with the same name, AA's data wins
 * and the manual entry is dropped, so a model never appears twice.
 */

const num = (v: unknown, field: string, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`manual-models.yaml: ${name}.${field} must be a non-negative number`);
  }
  return v;
};

export function parseManualModels(input: unknown): AaModel[] {
  const list = ((input ?? {}) as Record<string, unknown>).models ?? [];
  if (!Array.isArray(list)) throw new Error('manual-models.yaml: `models` must be a list');
  return list.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : null;
    if (!name) throw new Error(`manual-models.yaml: models[${i}] needs a name`);
    if (typeof e.estimate !== 'string' || !e.estimate.trim()) {
      throw new Error(`manual-models.yaml: ${name} needs an "estimate" explaining where the score comes from`);
    }
    const codingIndex = num(e.codingIndex, 'codingIndex', name);
    if (codingIndex > 100) throw new Error(`manual-models.yaml: ${name}.codingIndex must be 0–100`);
    const input = num(e.inputPrice, 'inputPrice', name);
    const output = num(e.outputPrice, 'outputPrice', name);
    const vendor = typeof e.vendor === 'string' && e.vendor.trim() ? e.vendor.trim() : 'Unknown';
    return {
      id: typeof e.id === 'string' && e.id ? e.id : `manual-${modelKey(name).replace(/\s+/g, '-')}`,
      name,
      slug: null,
      vendor,
      vendorSlug: vendor.toLowerCase().replace(/\s+/g, '-'),
      releaseDate: e.releaseDate instanceof Date ? e.releaseDate.toISOString().slice(0, 10) : typeof e.releaseDate === 'string' ? e.releaseDate : null,
      evaluations: { artificial_analysis_coding_index: codingIndex },
      pricing: { input, output, blended3to1: null },
      raw: { manual: true, ...e },
      estimate: {
        note: e.estimate.trim().replace(/\s+/g, ' '),
        sources: Array.isArray(e.sources) ? e.sources.filter((s): s is string => typeof s === 'string') : [],
      },
    };
  });
}

export function loadManualModels(path = 'config/manual-models.yaml'): AaModel[] {
  return parseManualModels(yaml.load(readFileSync(path, 'utf8')));
}

/** AA models plus manual ones that AA doesn't already cover. */
export function mergeManualModels(aa: AaModel[], manual: AaModel[]): { models: AaModel[]; added: string[]; superseded: string[] } {
  const aaKeys = new Set(aa.map((m) => modelKey(m.name)));
  const added: string[] = [];
  const superseded: string[] = [];
  const extra = manual.filter((m) => {
    if (aaKeys.has(modelKey(m.name))) {
      superseded.push(m.name);
      return false;
    }
    added.push(m.name);
    return true;
  });
  return { models: [...aa, ...extra], added, superseded };
}
