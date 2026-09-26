/**
 * LMArena Code Arena – WebDev ratings, fetched from the public Hugging Face
 * dataset `lmarena-ai/leaderboard-dataset` (config `webdev`, split `latest`).
 * Blind pairwise votes on building web apps; used for the "UI & web pages"
 * kind of work. No key needed.
 */

const ROWS_URL = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=webdev&split=latest';
const PAGE = 100;

export interface ArenaRow {
  name: string;
  rating: number;
}

export interface ArenaBoard {
  asOf: string | null;
  rows: ArenaRow[];
}

export async function fetchWebDevArena(fetchImpl: typeof fetch = fetch): Promise<ArenaBoard> {
  const rows: ArenaRow[] = [];
  let asOf: string | null = null;
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const res = await fetchImpl(`${ROWS_URL}&offset=${offset}&length=${PAGE}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`LMArena dataset returned HTTP ${res.status}`);
    const body = (await res.json()) as { rows?: { row: Record<string, unknown> }[]; num_rows_total?: number };
    for (const { row } of body.rows ?? []) {
      if (row.category !== 'overall') continue;
      if (typeof row.model_name === 'string' && typeof row.rating === 'number' && Number.isFinite(row.rating)) {
        rows.push({ name: row.model_name, rating: row.rating });
      }
      if (typeof row.leaderboard_publish_date === 'string') asOf = row.leaderboard_publish_date;
    }
    if (!body.rows?.length || offset + PAGE >= (body.num_rows_total ?? 0)) break;
  }
  if (rows.length === 0) throw new Error('LMArena dataset returned no WebDev ratings');
  return { asOf, rows };
}

const EFFORT = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'thinking', 'instant', 'reasoning']);

/**
 * Candidate keys for an arena model name like "claude-opus-4-7-high",
 * "gpt-5.6-sol-xhigh (codex-harness)" or "qwen3.8-max-0902":
 * lowercase, parenthesised notes dropped, "4-7" → "4.7", dates dropped,
 * tokens sorted — once as-is and once with trailing effort words removed
 * ("qwen3.8-max" must still match "Qwen3.8 Max").
 */
export function arenaKeys(name: string): string[] {
  const tokens = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(\d)-(\d)(?!\d{3})/g, '$1.$2')
    .split(/[\s_-]+/)
    .filter((t) => t && !/^\d{8}$/.test(t) && !/^\d+k$/.test(t));
  const trimmed = [...tokens];
  while (trimmed.length > 1 && EFFORT.has(trimmed[trimmed.length - 1]!)) trimmed.pop();
  const key = (t: string[]) => [...t].sort().join(' ');
  return [...new Set([key(tokens), key(trimmed)])];
}

/** Our model name as a key comparable with `arenaKeys` (keeps version notes like "(0902)"). */
export function ourArenaKey(name: string): string {
  return name.toLowerCase().replace(/[()]/g, ' ').split(/[\s_-]+/).filter(Boolean).sort().join(' ');
}

/** Best WebDev rating per model name of ours (a model may appear once per effort level/harness). */
export function matchArena(board: ArenaBoard, names: string[]): Record<string, number> {
  const byKey = new Map<string, number>();
  for (const row of board.rows) {
    for (const k of arenaKeys(row.name)) byKey.set(k, Math.max(byKey.get(k) ?? -Infinity, row.rating));
  }
  const out: Record<string, number> = {};
  for (const n of names) {
    const r = byKey.get(ourArenaKey(n));
    if (r !== undefined) out[n] = Math.round(r * 10) / 10;
  }
  return out;
}
