import type { AaModel } from './source/artificialAnalysis.js';

/**
 * Provisional Coding Index for brand-new models.
 *
 * Artificial Analysis publishes a new model's Intelligence Index within
 * about a day of release, but its Coding Index can take longer. Without this
 * step a new frontier model (e.g. Claude Opus 5.5, released 2026-09-22) would
 * sit in "no score yet" until AA catches up.
 *
 * For every model released within `maxAgeDays` that has an Intelligence
 * Index but no Coding Index, we estimate the Coding Index with a local
 * linear fit: take the `k` models whose Intelligence Index is closest and
 * that have both scores, fit CodingIndex ≈ a·IntelligenceIndex + b, and
 * predict. The row is marked as a provisional estimate (with the fit's
 * typical error) and is replaced automatically on the first run after AA
 * publishes the real score. Older models without a Coding Index are left
 * alone — there the missing score is not a matter of timing.
 */

const CI = 'artificial_analysis_coding_index';
const II = 'artificial_analysis_intelligence_index';
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface ProvisionalOptions {
  now: Date;
  maxAgeDays: number;
  /** Neighbours used for the local fit. */
  k?: number;
}

export interface ProvisionalFill {
  name: string;
  intelligenceIndex: number;
  estimate: number;
  typicalError: number;
}

export function fillProvisionalCodingIndex(models: AaModel[], opts: ProvisionalOptions): { models: AaModel[]; filled: ProvisionalFill[] } {
  if (opts.maxAgeDays <= 0) return { models, filled: [] };
  const k = opts.k ?? 20;
  const cutoff = new Date(opts.now.getTime() - opts.maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  const reference = models
    .filter((m) => !m.estimate && m.evaluations[CI] != null && m.evaluations[II] != null)
    .map((m) => ({ x: m.evaluations[II]!, y: m.evaluations[CI]! }));
  if (reference.length < 5) return { models, filled: [] };

  const filled: ProvisionalFill[] = [];
  const out = models.map((m) => {
    const ii = m.evaluations[II];
    if (m.estimate || m.evaluations[CI] != null || ii == null || !m.releaseDate || m.releaseDate < cutoff) return m;

    const near = [...reference].sort((a, b) => Math.abs(a.x - ii) - Math.abs(b.x - ii)).slice(0, k);
    const n = near.length;
    const mx = near.reduce((s, p) => s + p.x, 0) / n;
    const my = near.reduce((s, p) => s + p.y, 0) / n;
    const sxx = near.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const slope = sxx > 0 ? near.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : 0;
    const intercept = my - slope * mx;
    const estimate = round1(Math.min(100, Math.max(0, slope * ii + intercept)));
    const resid = Math.sqrt(near.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0) / Math.max(1, n - 2));
    // Extrapolating past the reference range is less certain: widen the error by the distance outside it.
    const maxX = Math.max(...near.map((p) => p.x));
    const minX = Math.min(...near.map((p) => p.x));
    const outside = Math.max(0, ii - maxX, minX - ii);
    const typicalError = round1(resid + outside * Math.abs(slope) * 0.5);

    filled.push({ name: m.name, intelligenceIndex: ii, estimate, typicalError });
    return {
      ...m,
      evaluations: { ...m.evaluations, [CI]: estimate },
      estimate: {
        kind: 'provisional' as const,
        note:
          `Provisional: released ${m.releaseDate}, and Artificial Analysis hasn't published its Coding Index yet. ` +
          `Estimated from its Intelligence Index (${ii}) using the ${n} models with the closest Intelligence Index ` +
          `that have both scores: about ${estimate} (typical error ±${typicalError}). ` +
          'Replaced automatically once the real score is published.',
        sources: ['https://artificialanalysis.ai/models'],
      },
    };
  });
  return { models: out, filled };
}
