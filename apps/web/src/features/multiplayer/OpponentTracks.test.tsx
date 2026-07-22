// @vitest-environment jsdom
//
// spec: docs/03 §6.5(OpponentTracks 부분 구독 — "다른 플레이어 tick 갱신 시 리렌더 0"), docs/07
//       WT-M4-04 완료조건("RTL 테스트: 다른 플레이어 tick 갱신 시 내 트랙 외 컴포넌트 리렌더 0 —
//       렌더 카운터")
//
// React.Profiler로 각 트랙(+ 무관한 형제 컴포넌트)의 커밋 횟수를 센다 — 소스에 테스트 전용
// 계측 코드를 넣지 않고도 "리렌더 0"을 정확히 검증할 수 있다(zustand는 선택자 결과가
// Object.is로 동일하면 그 구독 컴포넌트를 애초에 재실행하지 않는다).
import { act, render } from '@testing-library/react';
import { Profiler, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { catalogs } from '@wt/i18n';
import { OpponentTracks } from './OpponentTracks';
import { useMultiplayerStore } from '../../stores/multiplayer';
import type { RoomPlayer } from '../../stores/multiplayer';

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'ko',
  resources: { ko: { translation: catalogs.ko }, en: { translation: catalogs.en } },
  interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
});

function player(id: string, nickname: string): RoomPlayer {
  return {
    playerId: id,
    nickname,
    passportCover: 'basic-green',
    bestPi: null,
    isHost: false,
    isBot: false,
    ready: true,
    connState: 'connected',
  };
}

/** 감시 대상 서브트리를 감싸 커밋 시마다 카운트를 올린다(소스 무변경 계측). */
function Watched({ id, counts, children }: { id: string; counts: Record<string, number>; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={() => { counts[id] = (counts[id] ?? 0) + 1; }}>
      {children}
    </Profiler>
  );
}

describe('OpponentTracks render isolation (WT-M4-04)', () => {
  beforeEach(() => {
    useMultiplayerStore.getState().reset();
    // 부드러운 이동 rAF 루프는 이 테스트의 관심사가 아니다(렌더 카운트만 검증) — 콜백을 아예
    // 실행하지 않는 스텁으로 무한 루프를 막는다(useGameClock.test.tsx와 동일한 관례).
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('오직 갱신된 플레이어의 트랙만 리렌더되고, 다른 트랙·무관한 형제는 리렌더되지 않는다', () => {
    const p1 = player('p1', 'Alice');
    const p2 = player('p2', 'Bob');
    useMultiplayerStore.getState().upsertOpponent('p1', { idx: 1, ksPct: 20 });
    useMultiplayerStore.getState().upsertOpponent('p2', { idx: 2, ksPct: 10 });

    const counts: Record<string, number> = {};

    render(
      <I18nextProvider i18n={i18n}>
        <Watched id="decoy" counts={counts}>
          <div data-testid="prompt-decoy">이것은 프롬프트/입력 경로를 흉내낸 무관한 형제다</div>
        </Watched>
        <Watched id="p1" counts={counts}>
          <OpponentTracks players={[p1]} total={15} />
        </Watched>
        <Watched id="p2" counts={counts}>
          <OpponentTracks players={[p2]} total={15} />
        </Watched>
      </I18nextProvider>,
    );

    const p1AfterMount = counts.p1 ?? 0;
    const p2AfterMount = counts.p2 ?? 0;
    const decoyAfterMount = counts.decoy ?? 0;
    expect(p1AfterMount).toBeGreaterThan(0);
    expect(p2AfterMount).toBeGreaterThan(0);

    // p2만 갱신 — p1/decoy는 그대로여야 한다.
    act(() => {
      useMultiplayerStore.getState().upsertOpponent('p2', { idx: 3, ksPct: 40, combo: 2 });
    });

    expect(counts.p2 ?? 0).toBeGreaterThan(p2AfterMount);
    expect(counts.p1 ?? 0).toBe(p1AfterMount);
    expect(counts.decoy ?? 0).toBe(decoyAfterMount);

    // 반대로 p1만 갱신하면 p2/decoy는 그대로.
    const p2AfterP2Update = counts.p2 ?? 0;
    act(() => {
      useMultiplayerStore.getState().upsertOpponent('p1', { idx: 5, ksPct: 60 });
    });
    expect(counts.p1 ?? 0).toBeGreaterThan(p1AfterMount);
    expect(counts.p2 ?? 0).toBe(p2AfterP2Update);
    expect(counts.decoy ?? 0).toBe(decoyAfterMount);
  });
});
