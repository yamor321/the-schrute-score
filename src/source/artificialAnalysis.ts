/**
 * Client for the Artificial Analysis Data API.
 *
 * SECURITY: the API key is read from `process.env.ARTIFICIAL_ANALYSIS_API_KEY`
 * and only ever placed in the `x-api-key` request header. Nothing in this
 * module logs request objects, headers, or the key itself — keep it that way.
 */

export const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

/** A model as we use it. Known fields are normalized; everything else survives in `raw`. */
export interface AaModel {
  id: string;
  name: string;
  slug: string | null;
  /** Display name of the creator/vendor, e.g. "Anthropic". */
  vendor: string;
  /** URL-style creator id, e.g. "anthropic". */
  vendorSlug: string | null;
  releaseDate: string | null;
  /** Every numeric benchmark field the API returned, on the API's own scale. */
  evaluations: Record<string, number | null>;
  pricing: {
    /** USD per 1M input tokens. */
    input: number | null;
    /** USD per 1M output tokens. */
    output: number | null;
    /** AA's own blended price (3:1 input:output), USD per 1M tokens. */
    blended3to1: number | null;
  };
  /** The untouched API object, so no field is ever silently dropped. */
  raw: Record<string, unknown>;
}

export class AaApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AaApiError';
  }
}

export interface FetchOptions {
  /** Defaults to 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff (ms). Defaults to 1000 → waits 1s, 2s, … */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readApiKey(): string {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'ARTIFICIAL_ANALYSIS_API_KEY is not set. Locally, export it in your shell; ' +
        'in GitHub Actions, add it as a repository secret.',
    );
  }
  return key;
}

async function fetchOnce(apiKey: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(AA_MODELS_URL, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
  } catch (err) {
    // Network-level failure (DNS, reset, timeout) — worth retrying.
    throw new AaApiError(`Network error calling Artificial Analysis: ${(err as Error).message}`, null, true);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AaApiError(
      `Artificial Analysis rejected the API key (HTTP ${res.status}). ` +
        'Check that the ARTIFICIAL_ANALYSIS_API_KEY secret is set and still valid.',
      res.status,
      false,
    );
  }
  if (!res.ok) {
    // 429 and 5xx are transient; other 4xx mean the request itself is wrong.
    const retryable = res.status === 429 || res.status >= 500;
    throw new AaApiError(`Artificial Analysis returned HTTP ${res.status}`, res.status, retryable);
  }

  try {
    return await res.json();
  } catch {
    throw new AaApiError('Artificial Analysis returned a response that is not valid JSON', res.status, true);
  }
}

/**
 * Fetches the raw API response body, retrying transient failures with
 * exponential backoff. Never retries 401/403.
 */
export async function fetchRaw(opts: FetchOptions = {}): Promise<unknown> {
  const apiKey = readApiKey();
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(apiKey);
    } catch (err) {
      const retryable = err instanceof AaApiError && err.retryable;
      if (!retryable || attempt >= maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`Attempt ${attempt}/${maxAttempts} failed (${(err as Error).message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Turns a raw API body into `AaModel`s. Throws if the body's overall shape is
 * wrong (so a broken response can never overwrite good data); individual
 * entries without an id or name are skipped with a warning.
 */
export function parseModels(body: unknown): AaModel[] {
  const data = obj(body).data;
  if (!Array.isArray(data)) {
    throw new AaApiError('Unexpected Artificial Analysis response: missing "data" array', null, false);
  }
  if (data.length === 0) {
    throw new AaApiError('Artificial Analysis returned zero models — refusing to publish an empty table', null, false);
  }

  const models: AaModel[] = [];
  for (const entry of data) {
    const raw = obj(entry);
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name) {
      console.warn('Skipping model entry without id/name');
      continue;
    }
    const creator = obj(raw.model_creator);
    const evaluations: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(obj(raw.evaluations))) evaluations[k] = num(v);
    const pricing = obj(raw.pricing);

    models.push({
      id,
      name,
      slug: str(raw.slug),
      vendor: str(creator.name) ?? str(creator.slug) ?? 'Unknown',
      vendorSlug: str(creator.slug),
      releaseDate: str(raw.release_date),
      evaluations,
      pricing: {
        input: num(pricing.price_1m_input_tokens),
        output: num(pricing.price_1m_output_tokens),
        blended3to1: num(pricing.price_1m_blended_3_to_1),
      },
      raw,
    });
  }

  if (models.length === 0) {
    throw new AaApiError('No usable models in the Artificial Analysis response', null, false);
  }
  return models;
}

/** Fetches and parses the current model list. */
export async function fetchModels(opts: FetchOptions = {}): Promise<AaModel[]> {
  return parseModels(await fetchRaw(opts));
}
