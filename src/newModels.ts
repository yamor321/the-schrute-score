import type { ValueTable } from './scoring.js';
import type { Snapshot } from './persist.js';

type Rows = Pick<Snapshot, 'models' | 'excluded'>;

/** Every id the previous run saw — models, and the individual effort levels inside them. */
export function idsInSnapshot(snapshot: Rows): Set<string> {
  const ids = new Set<string>();
  for (const row of [...snapshot.models, ...snapshot.excluded]) {
    ids.add(row.id);
    for (const v of row.variants ?? []) ids.add(v.id);
  }
  return ids;
}

/**
 * Flags models that were not present in the previous `data/latest.json`.
 * A model counts as already seen if its own id or any of its effort levels'
 * ids appeared before, so adding a new effort level to a known model does
 * not make the model "new".
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
 * each run, and replace the `seen` test below with `now - firstSeen[id] < window`.
 */
export function markNewModels(table: ValueTable, previous: Rows | null): ValueTable {
  if (!previous) return table;
  const seen = idsInSnapshot(previous);
  const flag = <T extends { id: string; isNew?: boolean; variants?: { id: string }[] }>(row: T): T => {
    const { isNew: _stale, ...rest } = row;
    const known = seen.has(row.id) || (row.variants ?? []).some((v) => seen.has(v.id));
    return (known ? rest : { ...rest, isNew: true }) as T;
  };
  return { ...table, ranked: table.ranked.map(flag), excluded: table.excluded.map(flag) };
}
