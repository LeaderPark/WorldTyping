// @vitest-environment jsdom
// spec: docs/03 §7.3(라우트 전환 시 h1 포커스 이동), WT-M5-02
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { useRouteFocus } from './useRouteFocus';

afterEach(() => cleanup());

// 실사용(AppShell)과 동일한 형태 — Outlet을 감싸는 이 레이아웃 컴포넌트 자신은 라우트가
// 바뀌어도 리마운트되지 않는다(라우트 트리 안의 "루트"이므로). 페이지별 h1을 리마운트하는
// 하위 요소만 바뀐다 — pathname 변화가 곧 "다른 화면으로 전환됐다"는 신호다.
function Shell() {
  useRouteFocus();
  return <Outlet />;
}

function PageA() {
  return (
    <div>
      <h1 tabIndex={-1} data-testid="h1-a">
        Page A
      </h1>
      <Link to="/b" data-testid="go-b">
        go
      </Link>
    </div>
  );
}

function PageB() {
  return (
    <h1 tabIndex={-1} data-testid="h1-b">
      Page B
    </h1>
  );
}

function Harness() {
  return (
    <MemoryRouter initialEntries={['/a']}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/a" element={<PageA />} />
          <Route path="/b" element={<PageB />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('useRouteFocus', () => {
  it('does not steal focus on initial mount', () => {
    render(<Harness />);
    expect(document.activeElement).not.toBe(screen.getByTestId('h1-a'));
  });

  it('focuses the new page h1 after a route change', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('go-b'));
    expect(document.activeElement).toBe(screen.getByTestId('h1-b'));
  });
});
