// spec: docs/03 §4.1(라우터 전문), WT-M2-05
//
// 실제 데이터 라우터(createBrowserRouter/createMemoryRouter)를 initialize하는 렌더 테스트는
// router.test.tsx가 담당하되, 그쪽은 jsdom+undici AbortController interop 문제를 피하려 일반
// <MemoryRouter>로 우회한다(해당 파일 주석 참고). 이 파일은 router.tsx가 실제로 내보내는
// RouteObject 트리 자체(경로 문자열, element vs lazy 구성, lazy 모듈의 `Component` 계약)를
// 렌더 없이 구조적으로 검증한다 — 두 테스트가 상호 보완적으로 §4.1 전문 준수를 커버한다.
import { describe, expect, it } from 'vitest';
import type { RouteObject } from 'react-router-dom';
import { rootRoute, routeChildren } from './router';

function pathsOf(routes: RouteObject[]): (string | undefined)[] {
  return routes.map((r) => r.path ?? (r.index ? '(index)' : undefined));
}

describe('router.tsx wiring (§4.1 원문 대조)', () => {
  it('root route mounts AppShell with errorElement + bootLoader + the full children list', () => {
    expect(rootRoute.path).toBe('/');
    expect(rootRoute.element).toBeDefined();
    expect(rootRoute.errorElement).toBeDefined();
    expect(typeof rootRoute.loader).toBe('function');
    expect(rootRoute.children).toBe(routeChildren);
  });

  it('exposes exactly the S1~S13 route paths from docs/01 §10.1 in order, plus WT-M6-06 launch pages', () => {
    expect(pathsOf(routeChildren)).toEqual([
      '(index)',
      'play',
      'play/:mode',
      'play/:mode/:trackId',
      'rank',
      'multi',
      'multi/:roomCode',
      'passport',
      'privacy',
      'credits',
      'daily',
      '*',
    ]);
  });

  it('uses eager `element` for Home/ModeSelect/TrackSelect/Privacy/Credits/Daily/NotFound and `lazy` for the rest', () => {
    const eagerPaths = new Set(['(index)', 'play', 'play/:mode', 'privacy', 'credits', 'daily', '*']);
    for (const route of routeChildren) {
      const key = route.path ?? '(index)';
      if (eagerPaths.has(key)) {
        expect(route.element, `${key} should use element`).toBeDefined();
        expect(route.lazy, `${key} should not be lazy`).toBeUndefined();
      } else {
        expect(route.lazy, `${key} should be lazy`).toBeTypeOf('function');
        expect(route.element, `${key} should not have a static element`).toBeUndefined();
      }
    }
  });

  it('every lazy route module exports a `Component` (RRv6.4+ lazy contract)', async () => {
    for (const route of routeChildren) {
      if (!route.lazy) continue;
      const mod = (await route.lazy()) as { Component?: unknown };
      expect(typeof mod.Component, `${route.path} lazy module must export Component`).toBe('function');
    }
  });
});
