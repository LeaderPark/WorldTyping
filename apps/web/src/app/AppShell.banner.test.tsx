// @vitest-environment jsdom
//
// spec: docs/06 §10-4("API 장애 시 배너(KV config:banner) 동작 확인"), WT-M6-06
//
// AppShell.test.tsx/router.test.tsx render AppShell via a classic <MemoryRouter> without ever
// running the data router's root loader (bootLoader) — so BannerBar's getBootData() call always
// throws there and the banner degrades to "none" (by design, see AppShell.tsx comment). To prove
// the banner genuinely renders when GET /api/v1/config carries one, this file drives bootLoader()
// itself (mocked fetch, same fixture shape as app/bootLoader.test.ts) before rendering AppShell —
// that populates the same module-level cache BannerBar reads from.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';
import { __resetBootCacheForTests, bootLoader } from './bootLoader';

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function serverConfig(banner: unknown) {
  return {
    schemaVersion: 2,
    dataUrl: '/data/countries.json',
    mapUrl: '/data/countries-110m.json',
    grades: { S: 450, A: 340, B: 230, C: 120 },
    timeLimit: { base: 1.5, perKey: 0.4, tierRelaxBase: 1.3, tierRelaxStep: 0.075, min: 3, max: 15 },
    anticheat: { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 },
    featureFlags: {},
    banner,
  };
}

function renderAppShell() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('AppShell — config:banner wiring (WT-M6-06)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    __resetBootCacheForTests();
  });

  it('renders the banner message + level once bootLoader has resolved a non-null banner', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) {
        return Promise.resolve(jsonResponse(serverConfig({ message: '일시적인 서비스 지연이 있어요', level: 'warning' })));
      }
      if (url.includes('manifest.json')) return Promise.resolve(jsonResponse({ countries: { sha256: 'aa11aa11aa11aa11' } }));
      return Promise.resolve(jsonResponse(SAMPLE_DATASET));
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootLoader();
    await act(async () => {
      renderAppShell();
    });

    const banner = await screen.findByTestId('app-banner');
    expect(banner).toHaveTextContent('일시적인 서비스 지연이 있어요');
    expect(banner).toHaveAttribute('data-level', 'warning');
  });

  it('renders no banner when bootLoader resolves banner: null', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/config')) return Promise.resolve(jsonResponse(serverConfig(null)));
      if (url.includes('manifest.json')) return Promise.resolve(jsonResponse({ countries: { sha256: 'bb22bb22bb22bb22' } }));
      return Promise.resolve(jsonResponse(SAMPLE_DATASET));
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootLoader();
    await act(async () => {
      renderAppShell();
    });

    // 배너 없음이 확정적으로 반영될 시간을 준 뒤(effect는 이미 마이크로태스크 이후 실행됨) 부재 확인.
    await Promise.resolve();
    expect(screen.queryByTestId('app-banner')).not.toBeInTheDocument();
  });
});
