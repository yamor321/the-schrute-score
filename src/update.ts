/**
 * Pipeline entry point (`npm run update`):
 * fetch → score → new-model detection → write data files.
 *
 * Any failure throws before anything is written, so data/latest.json keeps
 * the last good snapshot. Needs ARTIFICIAL_ANALYSIS_API_KEY in the environment.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadScoringConfig } from './config.js';
import { applyCursor, loadCursorConfig } from './cursor.js';
import { loadManualModels, mergeManualModels } from './manualModels.js';
import { groupVariants } from './variants.js';
import { fillProvisionalCodingIndex } from './provisional.js';
import { markNewModels } from './newModels.js';
import { hasMeaningfulChange, readSnapshot, runStamp, writeRun, type Snapshot } from './persist.js';
import { computeValueTable } from './scoring.js';
import { fetchRaw, parseModels } from './source/artificialAnalysis.js';

const DATA_DIR = 'data';

/** Exposes a step output to later GitHub Actions steps (no-op locally). Supports multi-line values. */
function setActionOutput(name: string, value: string) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${name}_${Date.now()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main() {
  const cfg = loadScoringConfig();
  const cursorCfg = loadCursorConfig();
  const rawBody = await fetchRaw();
  const aaModels = parseModels(rawBody);
  const manual = mergeManualModels(aaModels, loadManualModels());
  if (manual.added.length) console.log(`Hand-added (estimated) models: ${manual.added.join(', ')}`);
  if (manual.superseded.length) {
    console.log(`Now tracked by Artificial Analysis, manual entry skipped: ${manual.superseded.join(', ')} (remove it from config/manual-models.yaml)`);
  }
  const provisional = fillProvisionalCodingIndex(manual.models, { now: new Date(), maxAgeDays: cfg.provisionalMaxAgeDays });
  for (const p of provisional.filled) {
    console.log(`Provisional Coding Index for ${p.name}: ≈${p.estimate} ±${p.typicalError} (from Intelligence Index ${p.intelligenceIndex})`);
  }
  const models = provisional.models;
  // Score every effort level, then collapse levels into one row per model.
  const table = groupVariants(computeValueTable(models, cfg));
  if (table.ranked.length === 0) {
    throw new Error(`All ${models.length} models were excluded — refusing to publish an empty ranking. Check config/scoring.yaml.`);
  }

  const latestPath = join(DATA_DIR, 'latest.json');
  const previous = readSnapshot(latestPath);
  const { table: marked, cursor } = applyCursor(markNewModels(table, previous), cursorCfg);

  const now = new Date();
  const snapshot: Snapshot = {
    generatedAt: now.toISOString(),
    source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai' },
    config: cfg,
    counts: {
      fetched: marked.ranked.length + marked.excluded.length,
      variants: models.length,
      ranked: marked.ranked.length,
      excluded: marked.excluded.length,
    },
    quality: table.quality,
    cursor,
    models: marked.ranked,
    excluded: marked.excluded,
  };
  const cursorRanked = cursor.models.filter((m) => m.status === 'ranked').length;
  console.log(`Cursor: ${cursor.models.length} models listed, ${cursorRanked} ranked.`);

  const newCount = [...marked.ranked, ...marked.excluded].filter((m) => m.isNew).length;
  console.log(
    `Fetched ${models.length} entries = ${snapshot.counts.fetched} models (effort levels grouped) → ` +
      `${marked.ranked.length} ranked, ${marked.excluded.length} excluded, ${newCount} new.`,
  );
  const top = marked.ranked[0]!;
  console.log(
    `#1 by cost per finished task: ${top.name} (${top.vendor}) — score ${top.codingScore.toFixed(1)}, ` +
      `$${top.price}/1M, $${top.effectiveCost.toFixed(2)} per task ` +
      `(${cfg.taskModel.tokensPerTaskMillions}M tokens, $${cfg.taskModel.fixCostUsd} per fix)`,
  );

  if (!hasMeaningfulChange(previous, snapshot)) {
    console.log('No meaningful change since the last snapshot — nothing written.');
    setActionOutput('changed', 'false');
    return;
  }
  const written = writeRun({ dataDir: DATA_DIR, stamp: runStamp(now), rawBody, snapshot });
  for (const path of written) console.log(`wrote ${path}`);
  setActionOutput('changed', 'true');
  setActionOutput('files', written.join('\n'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Update failed: ${message}`);
  if (process.env.GITHUB_ACTIONS) {
    // Public annotation + output for the failure issue, so the cause is visible without opening
    // the log. Error messages never contain the API key (see source/artificialAnalysis.ts).
    console.log(`::error title=Data update failed::${message.replace(/\r?\n/g, ' ')}`);
    setActionOutput('error', message);
  }
  process.exit(1);
});
