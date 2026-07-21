// @vitest-environment jsdom
//
// createBrowserRouter/createMemoryRouter(데이터 라우터)를 실제로 initialize하면 이 jsdom+Node
// 조합에서 @remix-run/router가 내부적으로 생성하는 Request의 AbortSignal이 jsdom의
// AbortController 구현과 realm이 달라 충돌한다(known jsdom/undici interop 이슈, 라우팅 로직과
// 무관). RootErrorBoundary 자체는 useRouteError()만 소비하므로 react-router-dom을 부분
// 목킹해 그 함수만 대체하고 나머지는 실제 모듈을 그대로 쓴다 — 전체 데이터 라우터 부팅을
// 우회해 문제의 컴포넌트만 격리 검증한다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useRouteError: () => new Error('boom-from-loader'),
    isRouteErrorResponse: () => false,
  };
});

describe('RootErrorBoundary', () => {
  afterEach(() => cleanup());

  it('renders the boundary title and the thrown error message', async () => {
    const { RootErrorBoundary } = await import('./RootErrorBoundary');
    const { AppProviders } = await import('./providers');

    render(
      <AppProviders>
        <RootErrorBoundary />
      </AppProviders>,
    );

    expect(await screen.findByText('boom-from-loader')).toBeInTheDocument();
  });
});
