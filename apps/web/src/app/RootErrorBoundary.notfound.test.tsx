// @vitest-environment jsdom
//
// spec: docs/06 §10-4(404 "항로 이탈" 콘셉트), WT-M6-06
//
// 404 RouteErrorResponse의 NotFoundPage 위임 경로를 검증한다. RootErrorBoundary.test.tsx가 이미
// 같은 파일에서 react-router-dom을 다른 반환값으로 mock하고 있어(일반 Error → ErrorPage 경로),
// vi.mock은 모듈 단위로 훅스팅되어 한 파일 안에 두 번 등록하면 충돌한다 — 그래서 이 분기는 별도
// 파일로 분리했다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useRouteError: () => ({ status: 404, statusText: 'Not Found', data: undefined, internal: false }),
    isRouteErrorResponse: (e: unknown) => (e as { status?: number })?.status === 404,
  };
});

describe('RootErrorBoundary — 404 delegation (WT-M6-06)', () => {
  afterEach(() => cleanup());

  it('delegates a 404 RouteErrorResponse to NotFoundPage', async () => {
    const { RootErrorBoundary } = await import('./RootErrorBoundary');
    const { AppProviders } = await import('./providers');
    const { MemoryRouter } = await import('react-router-dom');

    render(
      <AppProviders>
        <MemoryRouter>
          <RootErrorBoundary />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument();
  });
});
