// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S1 "대륙 호버 시 노선색 점등"), docs/03 §3.2(WorldMapHandle 계약 — 새
//       메서드 추가 금지), WT-M2-07 구현 세부 지시 1.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Country } from '@wt/shared';
import { HeroMap } from './HeroMap';

function load(name: string): unknown {
  for (const base of ['public/data', 'apps/web/public/data']) {
    const p = resolve(process.cwd(), base, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`fixture not found: ${name}`);
}

let topology: unknown;
let dataset: { countries: Country[] };

beforeAll(() => {
  topology = load('countries-110m.json');
  dataset = load('countries.json') as { countries: Country[] };
});

vi.mock('../../app/bootLoader', () => ({
  getBootData: () => ({
    countries: { countries: dataset.countries },
    config: { mapUrl: '/data/countries-110m.json' },
    dataVersion: 'test',
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HeroMap — 대륙 호버 점등(setTarget 유사 API 추가 없이 base 레이어 class 토글)', () => {
  it('KR(asia) 위로 pointerover하면 같은 대륙(JP 등)의 국가가 함께 점등되고, 다른 대륙(US)은 아니다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topology) }),
    );
    const { container } = render(<HeroMap />);

    await waitFor(() => expect(container.querySelector('[data-country="KR"]')).not.toBeNull());

    const kr = container.querySelector('[data-country="KR"]') as Element;
    kr.dispatchEvent(new Event('pointerover', { bubbles: true }));

    const jp = container.querySelector('[data-country="JP"]');
    const us = container.querySelector('[data-country="US"]');
    expect(jp?.classList.contains('wt-map__country--hero-lit')).toBe(true);
    expect(us?.classList.contains('wt-map__country--hero-lit')).toBe(false);

    kr.dispatchEvent(new Event('pointerout', { bubbles: true }));
    expect(jp?.classList.contains('wt-map__country--hero-lit')).toBe(false);
  });

  it('지도 로딩 전에는 placeholder를 렌더한다(throw 없음)', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { getByTestId } = render(<HeroMap />);
    expect(getByTestId('hero-map-loading')).toBeInTheDocument();
  });
});
