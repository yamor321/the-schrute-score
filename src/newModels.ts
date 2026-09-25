import type { ValueTable } from './scoring.js';
import type { Snapshot } from './persist.js';

/** Every model id the previous run saw — ranked or excluded. */
export function idsInSnapshot(snapshot: Pick<Snapshot, 'models' | 'excluded'>): Set<string> {
  return new Set([...snapshot.models.map((m) => m.id), ...snapshot.excluded.map((m) => m.id)]);
}

/**
 * Flags models that were not present in the previous `data/latest.json`.
 *
 * The flag is ONE-CYCLE-ONLY: detection always diffs against the immediately
 * prior snapshot, so a model is `isNew` on the first run that sees it and
 * never again (on the next run it is already in the previous snapshot).
 * With two runs a day that means a model is "new" for roughly 12 hours.
 *
 * On the very first run there is no previous snapshot, so nothing is flagged
 * (otherwise the entire initial dataset would show as new).
 *
 * Extension point: for a longer window (e.g. "new for 3 days"), store a
 * `firstSeen: Record<id, ISO date>` map in the snapshot, carry it forward
 * each run, and replace the `!previous.has(id)` test below with
 * `now - firstSeen[id] < window`.
 */
export function markNewModels(table: ValueTable, previous: Pick<Snapshot, 'models' | 'excluded'> | null): ValueTable {
  if (!previous) return table;
  const seen = idsInSnapshot(previous);
  const flag = <T extends { id: string; isNew?: boolean }>(row: T): T => {
    const { isNew: _stale, ...rest } = row;
    return (seen.has(row.id) ? rest : { ...rest, isNew: true }) as T;
  };
  return { ...table, ranked: table.ranked.map(flag), excluded: table.excluded.map(flag) };
}
