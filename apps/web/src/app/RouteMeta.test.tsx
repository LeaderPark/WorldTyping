// @vitest-environment jsdom
// spec: docs/06 §10-2, WT-M6-06
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from './providers';
import { RouteMeta } from './RouteMeta';

function head(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute('content') ?? null;
}

function renderAt(path: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<RouteMeta />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('RouteMeta', () => {
  afterEach(() => cleanup());

  it('sets a home-specific title/description/OG/Twitter meta at "/"', async () => {
    await act(async () => {
      renderAt('/');
    });

    expect(document.title).toContain('TypeTrip');
    expect(head('meta[name="description"]')).toBeTruthy();
    expect(head('meta[property="og:title"]')).toBe(document.title);
    expect(head('meta[property="og:description"]')).toBeTruthy();
    expect(head('meta[property="og:url"]')).toContain('/');
    expect(head('meta[name="twitter:title"]')).toBe(document.title);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeTruthy();
    expect(document.head.querySelector('link[rel="alternate"][hreflang="ko"]')).toBeTruthy();
    expect(document.head.querySelector('link[rel="alternate"][hreflang="en"]')).toBeTruthy();
    expect(document.head.querySelector('link[rel="alternate"][hreflang="x-default"]')).toBeTruthy();
  });

  it('updates title/description/canonical when navigating to a different route (no duplicate tags)', async () => {
    await act(async () => {
      renderAt('/rank');
    });
    const rankTitle = document.title;
    const rankDesc = head('meta[name="description"]');

    await act(async () => {
      renderAt('/daily');
    });
    const dailyTitle = document.title;
    const dailyDesc = head('meta[name="description"]');

    expect(rankTitle).not.toBe(dailyTitle);
    expect(rankDesc).not.toBe(dailyDesc);
    // 태그를 누적하지 않고 갱신(upsert)한다 — 중복 <meta name="description"> 없음.
    expect(document.head.querySelectorAll('meta[name="description"]').length).toBe(1);
    expect(document.head.querySelectorAll('meta[property="og:title"]').length).toBe(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
  });
});
