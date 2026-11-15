import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonRpcCall } from '../client.js';
import { RATE_LIMIT_RETRY, parseRetryAfter, retryDelayMs } from '../rate-limit.js';
import { BitdefenderApiError, BitdefenderRateLimitError } from '../types.js';
import { httpErrorResponse, jsonRpcErrorResponse, jsonRpcSuccessResponse } from './test-helpers.js';

/** GravityZone's rate-limit answer: HTTP 429 carrying JSON-RPC error -32003. */
function limited(retryAfter?: string, status = 429): Response {
  return new Response(
    JSON.stringify({ id: 'test-id', jsonrpc: '2.0', error: { code: -32003, message: 'Too many requests' } }),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
    },
  );
}

describe('parseRetryAfter', () => {
  it('reads delay-seconds, rounding fractions up', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(' 0 ')).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-3')).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('uses Retry-After when given', () => {
    expect(retryDelayMs(0, 3000, 0)).toBe(3000);
  });

  it('backs off exponentially without Retry-After', () => {
    expect(retryDelayMs(0, undefined, 0, () => 0)).toBe(1000);
    expect(retryDelayMs(1, undefined, 1000, () => 0)).toBe(2000);
  });

  it('stops after maxRetries', () => {
    expect(retryDelayMs(RATE_LIMIT_RETRY.maxRetries, 1000, 0)).toBeUndefined();
  });

  it('does not wait longer than maxWaitMs or past maxTotalWaitMs', () => {
    expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs + 1, 0)).toBeUndefined();
    expect(retryDelayMs(1, 5000, RATE_LIMIT_RETRY.maxTotalWaitMs - 4000)).toBeUndefined();
  });
});

describe('jsonRpcCall retry on 429', () => {
  const fetchMock = vi.fn();
  const creds = { apiKey: 'test-key-123', accessUrl: 'https://gravityzone.example.com/api' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for Retry-After and returns the retried success', async () => {
    fetchMock.mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(jsonRpcSuccessResponse({ items: [] }));

    const pending = jsonRpcCall(creds, 'network', 'getEndpointsList', {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives each attempt a fresh request (new timeout signal)', async () => {
    fetchMock.mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(jsonRpcSuccessResponse([]));

    const pending = jsonRpcCall(creds, 'network', 'getCustomGroupsList', {});
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(first.signal).not.toBe(second.signal);
  });

  it('gives up after maxRetries and reports HTTP 429 with the last Retry-After', async () => {
    fetchMock.mockImplementation(async () => limited('3'));

    const pending = jsonRpcCall(creds, 'reports', 'getReportsList', {});
    const assertion = expect(pending).rejects.toThrow(/HTTP 429.*Try again in 3 s\./);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_RETRY.maxRetries + 1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BitdefenderRateLimitError);
    expect((error as BitdefenderRateLimitError).retryAfterSeconds).toBe(3);
  });

  it('does not wait for a Retry-After longer than the cap', async () => {
    fetchMock.mockResolvedValueOnce(limited('60'));

    await expect(jsonRpcCall(creds, 'network', 'getEndpointsList', {})).rejects.toThrow(
      /HTTP 429.*Try again in 60 s\./,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats JSON-RPC -32003 in a 2xx envelope as a rate limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonRpcErrorResponse(-32003, 'Too many requests'));

    const error = await jsonRpcCall(creds, 'network', 'getEndpointsList', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BitdefenderRateLimitError);
    expect((error as Error).message).toMatch(/-32003.*Try again in 1 s\./);
  });

  it('retries a 503 only when it carries Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(httpErrorResponse(503));
    await expect(jsonRpcCall(creds, 'network', 'getEndpointsList', {})).rejects.toThrow(BitdefenderApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(limited('1', 503)).mockResolvedValueOnce(jsonRpcSuccessResponse([]));
    const pending = jsonRpcCall(creds, 'network', 'getCustomGroupsList', {});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    fetchMock.mockResolvedValueOnce(httpErrorResponse(500));

    await expect(jsonRpcCall(creds, 'network', 'getEndpointsList', {})).rejects.toThrow(BitdefenderApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
