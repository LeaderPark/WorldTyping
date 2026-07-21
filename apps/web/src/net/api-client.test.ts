import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from './api-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('apiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET resolves with parsed JSON on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiClient.get<{ ok: boolean }>('/config');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/config',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
    );
  });

  it('POST sends a JSON body and method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.post('/runs/start', { mode: 'tier' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runs/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'tier' }) }),
    );
  });

  it('throws ApiError with the server error envelope on non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'slow down', retryAfterSec: 5 } },
        { status: 429, statusText: 'Too Many Requests' },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/leaderboard')).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
      retryAfterSec: 5,
    });
  });

  it('falls back to UNKNOWN code when the error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    let err: ApiError | undefined;
    try {
      await apiClient.get('/config');
    } catch (e) {
      err = e as ApiError;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(502);
    expect(err?.code).toBe('UNKNOWN');
  });

  it('returns undefined for 204 No Content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiClient.post('/session');
    expect(result).toBeUndefined();
  });
});
