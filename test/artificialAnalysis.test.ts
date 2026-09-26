import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AaApiError, fetchModels, fetchRaw, parseModels } from '../src/source/artificialAnalysis.js';
import { fixtureBody } from './helpers.js';

const TEST_KEY = 'test-key-not-real';
const noSleep = () => Promise.resolve();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchModels', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('ARTIFICIAL_ANALYSIS_API_KEY', TEST_KEY);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses a successful response and sends the key only as x-api-key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fixtureBody));
    const models = await fetchModels({ sleep: noSleep });

    expect(models).toHaveLength(7);
    const alpha = models[0]!;
    expect(alpha).toMatchObject({
      id: '11111111-aaaa-4000-8000-000000000001',
      name: 'Alpha Coder',
      vendor: 'Anthropic',
      vendorSlug: 'anthropic',
      releaseDate: '2026-05-01',
      pricing: { input: 3, output: 15, blended3to1: 6 },
    });
    expect(alpha.evaluations.artificial_analysis_coding_index).toBe(60);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/v2/data/llms/models');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': TEST_KEY });
  });

  it('preserves fields it does not know about in raw', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fixtureBody));
    const gamma = (await fetchModels({ sleep: noSleep })).find((m) => m.name === 'Gamma Open')!;
    expect(gamma.raw.future_field_not_yet_known).toEqual({ note: 'must survive in raw' });
  });

  it('retries transient failures with exponential backoff, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(fixtureBody));
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    const models = await fetchModels({ sleep, baseDelayMs: 100 });
    expect(models).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it('gives up after 3 attempts', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    await expect(fetchModels({ sleep: noSleep })).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])('does not retry on HTTP %i and points at the secret', async (status) => {
    fetchMock.mockResolvedValue(new Response('no', { status }));
    const err = await fetchModels({ sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AaApiError);
    expect((err as AaApiError).message).toMatch(/ARTIFICIAL_ANALYSIS_API_KEY/);
    expect((err as AaApiError).message).not.toContain(TEST_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails immediately when the key is missing', async () => {
    vi.stubEnv('ARTIFICIAL_ANALYSIS_API_KEY', '');
    await expect(fetchRaw()).rejects.toThrow(/ARTIFICIAL_ANALYSIS_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseModels', () => {
  it('handles models missing optional fields', () => {
    const models = parseModels(fixtureBody);
    const epsilon = models.find((m) => m.name === 'Epsilon Unpriced')!;
    expect(epsilon.pricing).toEqual({ input: null, output: null, blended3to1: null });
    expect(epsilon.evaluations.terminalbench_v2_1).toBeUndefined();

    const delta = models.find((m) => m.name === 'Delta Legacy')!;
    expect(delta.releaseDate).toBeNull();
    expect(delta.evaluations.artificial_analysis_coding_index).toBeNull();

    const eta = models.find((m) => m.name === 'Eta Half')!;
    expect(eta.pricing.output).toBeNull();
  });

  it('skips entries without id/name but keeps the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const models = parseModels({ data: [{ name: 'no id' }, { id: 'x', name: 'ok', model_creator: {} }] });
    expect(models).toHaveLength(1);
    expect(models[0]!.vendor).toBe('Unknown');
    vi.restoreAllMocks();
  });

  it.each([
    ['no data array', { status: 200 }],
    ['empty data', { data: [] }],
    ['not an object', 'nope'],
  ])('rejects a malformed body (%s)', (_label, body) => {
    expect(() => parseModels(body)).toThrow(AaApiError);
  });
});
