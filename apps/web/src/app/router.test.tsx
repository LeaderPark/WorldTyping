// @vitest-environment jsdom
//
// 세션 환경 어댑테이션: "라우트 내비게이션 동작, 언어 게이트 1회 표시 후 재방문 시 미표시"를
// 수동 dev-server 확인 대신 jsdom 렌더 테스트로 자동화 대체(§3 세션 조정).
//
// [WT-AUTH-03] 구 S12 설정 오버레이(?modal=settings) 열림/닫힘·테마 전환 테스트는 오버레이 자체가
// 폐기돼(§11-D68-⑥) 이 파일에서 제거했다 — 테마 전환은 features/auth/ThemeToggle.test.tsx가,
// 로그인 모달은 app/AppShell.test.tsx가 담당한다.
//
// 왜 <MemoryRouter>(classic API)이고 createMemoryRouter(데이터 라우터)가 아닌가: 데이터 라우터는
// initialize() 시점에 내부적으로 fetch Request(+AbortController)를 만드는데, 이 jsdom+Node
// 조합에서 jsdom의 AbortController와 undici Request의 AbortSignal 검증이 realm이 달라 충돌한다
// (known jsdom/undici interop 이슈, 우리 라우팅 로직과 무관 — router-config.test.ts가 실제
// router.tsx의 RouteObject 트리 자체는 별도로 구조 검증한다). AppShell/Outlet/useSearchParams는
// 두 API 모두 동일하게 동작하므로 이 우회는 여기서 검증하려는 동작(게이트/오버레이/테마/내비)에
// 영향이 없다.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';
import { ModeSelectPage } from '../pages/ModeSelectPage';
import { TrackSelectPage } from '../pages/TrackSelectPage';
import { RankPage } from '../pages/RankPage';
import { PassportPage } from '../pages/PassportPage';
import { PrivacyPage } from '../pages/PrivacyPage';
import { CreditsPage } from '../pages/CreditsPage';
import { DailyPage } from '../pages/DailyPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { LobbyPage } from '../pages/multi/LobbyPage';

function renderAt(path: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="play" element={<ModeSelectPage />} />
            <Route path="play/:mode" element={<TrackSelectPage />} />
            <Route path="rank" element={<RankPage />} />
            <Route path="multi" element={<LobbyPage />} />
            <Route path="passport" element={<PassportPage />} />
            <Route path="privacy" element={<PrivacyPage />} />
            <Route path="credits" element={<CreditsPage />} />
            <Route path="daily" element={<DailyPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('app routing/shell (WT-M2-05 smoke)', () => {
  afterEach(() => cleanup());

  it('renders HomePage at / with the S2 language gate shown on first visit', async () => {
    localStorage.removeItem('wt:lang');
    renderAt('/');
    expect(await screen.findByTestId('language-gate')).toBeInTheDocument();
  });

  it('dismisses the language gate after a choice and keeps it hidden on a fresh remount', async () => {
    localStorage.removeItem('wt:lang');
    const { unmount } = renderAt('/');
    const koButton = await screen.findByTestId('lang-ko');
    act(() => koButton.click());
    await waitFor(() => expect(screen.queryByTestId('language-gate')).not.toBeInTheDocument());
    unmount();

    // "재방문" 시뮬레이션: 언마운트 후 새로 렌더 — localStorage 'wt:lang'이 남아 있어야 한다.
    renderAt('/');
    await waitFor(() => expect(screen.queryByTestId('language-gate')).not.toBeInTheDocument());
  });

  it('navigates to each top-level route and renders a non-empty heading', async () => {
    localStorage.setItem('wt:lang', 'en'); // 게이트가 다른 시나리오를 방해하지 않도록 선택 완료 상태로.
    for (const path of [
      '/play',
      '/play/continent',
      '/rank',
      '/multi',
      '/passport',
      '/privacy',
      '/credits',
      '/daily',
      '/this-route-does-not-exist', // WT-M6-06: catch-all → NotFoundPage
    ]) {
      const { unmount } = renderAt(path);
      const heading = await screen.findByRole('heading', { level: 1 });
      expect(heading.textContent).not.toBe('');
      unmount();
    }
  });
});
