import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScoringConfig } from './config.js';
import type { ExcludedModel, RankedModel } from './scoring.js';

/** The document written to data/latest.json and data/history/*.json, and read by the dashboard. */
export interface Snapshot {
  generatedAt: string;
  source: { name: string; url: string };
  config: ScoringConfig;
  counts: { fetched: number; ranked: number; excluded: number };
  models: RankedModel[];
  excluded: ExcludedModel[];
}

/** UTC run stamp used for file names: YYYY-MM-DDTHH. */
export function runStamp(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export function readSnapshot(path: string): Snapshot | null {
  if (!existsSync(path)) return null;
  // A corrupt latest.json should stop the pipeline rather than be silently replaced.
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (!Array.isArray(parsed.models) || !Array.isArray(parsed.excluded)) {
    throw new Error(`${path} is not a valid snapshot (missing models/excluded arrays)`);
  }
  return parsed;
}

/** True when anything other than `generatedAt` differs. */
export function hasMeaningfulChange(previous: Snapshot | null, next: Snapshot): boolean {
  if (!previous) return true;
  const strip = ({ generatedAt: _ignored, ...rest }: Snapshot) => JSON.stringify(rest);
  return strip(previous) !== strip(next);
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface WriteRunInput {
  dataDir: string;
  stamp: string;
  rawBody: unknown;
  snapshot: Snapshot;
}

/** Writes raw/<stamp>.json (minified), history/<stamp>.json and latest.json. Returns the paths written. */
export function writeRun({ dataDir, stamp, rawBody, snapshot }: WriteRunInput): string[] {
  const pretty = JSON.stringify(snapshot, null, 2) + '\n';
  const files: [string, string][] = [
    [join(dataDir, 'raw', `${stamp}.json`), JSON.stringify(rawBody) + '\n'],
    [join(dataDir, 'history', `${stamp}.json`), pretty],
    [join(dataDir, 'latest.json'), pretty],
  ];
  for (const [path, content] of files) writeFile(path, content);
  return files.map(([path]) => path);
}
