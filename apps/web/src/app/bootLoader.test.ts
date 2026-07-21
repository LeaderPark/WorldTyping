import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBootCacheForTests, bootLoader, getBootData } from './bootLoader';

const SAMPLE_DATASET = {
  schemaVersion: 2,
  builtAt: '2026-07-21T00:00:00.000Z',
  sources: { worldCountries: '1.0.0', worldAtlas: '2.0.2' },
  countries: [
    {
      id: 'KR',
      iso3: 'KOR',
      nameKo: '대한민국',
      nameEn: 'South Korea',
      aliasesKo: ['한국'],
      aliasesEn: [],
      continent: 'asia',
      subregion: 'Eastern Asia',
      difficultyTier: 1,
      capitalKo: '서울',
      capitalEn: 'Seoul',
      flagEmoji: '🇰🇷',
      population: 51000000,
      latlng: [37, 127.5],
      mapFeatureId: '410',
      acceptedInputsKo: ['대한민국', '한국'],
      acceptedInputsEn: ['south korea'],
    },
  ],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('bootLoader', () => {
  beforeEach(() => {
    __resetBootCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to bundled config defaults when /api/v1/config is unavailable (M3 not shipped yet)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      if (url.includes('manifest.json')) {
        return Promise.resolve(jsonResponse({ countries: { sha256: 'abcdef0123456789' } }));
      }
      return Promise.resolve(jsonResponse(SAMPLE_DATASET));
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await bootLoader();

    expect(data.config.dataUrl).toBe('/data/countries.json');
    expect(data.config.anticheat).toEqual({ cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 });
    expect(data.dataVersion).toBe('abcdef01');
    expect(data.countries.countries).toHaveLength(1);
    expect(Object.isFrozen(data.countries)).toBe(true);
  });

  it('uses the server config when /api/v1/config succeeds', async () => {
    const serverConfig = {
      schemaVersion: 2,
      dataUrl: '/data/countries.json',
      mapUrl: '/data/countries-110m.json',
      grades: { S: 500, A: 380, B: 250, C: 130 },
      timeLimit: { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 },
      anticheat: { cpmHardCapKo: 1150, cpmHardCapEn: 1050, minMsPerKeystroke: 35 },
      featureFlags: { ghostMode: true },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) return Promise.resolve(jsonResponse(serverConfig));
      if (url.includes('manifest.json')) return Promise.resolve(jsonResponse({ countries: { sha256: 'deadbeef00000000' } }));
      return Promise.resolve(jsonResponse(SAMPLE_DATASET));
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await bootLoader();
    expect(data.config.grades.S).toBe(500);
    expect(data.config.featureFlags.ghostMode).toBe(true);
  });

  it('throws (for the router errorElement) when countries.json fails to load', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) return Promise.resolve(new Response('nf', { status: 404 }));
      if (url.includes('manifest.json')) return Promise.resolve(new Response('nf', { status: 404 }));
      return Promise.resolve(new Response('server error', { status: 500 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootLoader()).rejects.toThrow(/countries\.json fetch failed/);
  });

  it('throws when countries.json fails zod validation', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) return Promise.resolve(new Response('nf', { status: 404 }));
      if (url.includes('manifest.json')) return Promise.resolve(new Response('nf', { status: 404 }));
      return Promise.resolve(jsonResponse({ nope: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootLoader()).rejects.toThrow();
  });

  it('caches the result across calls (single fetch pass)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) return Promise.resolve(new Response('nf', { status: 404 }));
      if (url.includes('manifest.json')) return Promise.resolve(jsonResponse({ countries: { sha256: 'aa11aa11aa11aa11' } }));
      return Promise.resolve(jsonResponse(SAMPLE_DATASET));
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootLoader();
    const callCountAfterFirst = fetchMock.mock.calls.length;
    await bootLoader();
    expect(fetchMock.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('getBootData() throws before bootLoader has resolved', () => {
    expect(() => getBootData()).toThrow();
  });
});
