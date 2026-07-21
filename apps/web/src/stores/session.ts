// spec: docs/03 §4.3(SessionState 전문), §4.5(고빈도 값 절대 금지 불변식), WT-M2-05
//
// ⚠️ 불변식(§4.5): 매 키스트로크마다 변하는 값(입력 버퍼, 실시간 CPM, 콤보, 경과시간, 게이지)은
// 이 스토어에 절대 추가하지 않는다. 여기 담기는 값은 "국가 전환 단위 이하 빈도"만
// (currentIndex, lives, phase) — 위반은 코드리뷰 리젝 사유(§4.5 원문). 엔진(packages/engine의
// GameSessionEngine)이 이 스토어의 유일한 정상 쓰기 주체다: UI 컴포넌트는 setter를 직접 남발하지
// 말고 useGameSession(§4.4, WT-M2-06)을 통해서만 세션을 조작한다.

import { create } from 'zustand';
import type { CountryId, GameMode, RunResult } from '@wt/shared';

export type SessionPhase = 'idle' | 'countdown' | 'playing' | 'finished' | 'aborted';

export interface SessionState {
  phase: SessionPhase;
  mode: GameMode;
  trackId: string;
  countryIds: CountryId[];
  currentIndex: number;
  lives: number | null;
  result: RunResult | null;
  practice: boolean;

  /** 엔진이 판 시작 시 1회 호출 — 확정된 출제 순서/모드를 스토어에 반영. */
  startRun(mode: GameMode, trackId: string, countryIds: CountryId[], lives: number | null): void;
  setPhase(phase: SessionPhase): void;
  /** 국가 전환 시에만 호출(초당 최대 ~1회 — §4.3 주석). */
  setCurrentIndex(index: number): void;
  setLives(lives: number | null): void;
  setPractice(practice: boolean): void;
  /** finished 시 1회 기록(§4.3). */
  finish(result: RunResult): void;
  abort(): void;
  reset(): void;
}

const INITIAL: Omit<
  SessionState,
  | 'startRun'
  | 'setPhase'
  | 'setCurrentIndex'
  | 'setLives'
  | 'setPractice'
  | 'finish'
  | 'abort'
  | 'reset'
> = {
  phase: 'idle',
  mode: 'continent',
  trackId: '',
  countryIds: [],
  currentIndex: 0,
  lives: null,
  result: null,
  practice: false,
};

export const useSessionStore = create<SessionState>()((set) => ({
  ...INITIAL,

  startRun: (mode, trackId, countryIds, lives) =>
    set({
      mode,
      trackId,
      countryIds,
      lives,
      phase: 'countdown',
      currentIndex: 0,
      result: null,
      practice: false,
    }),
  setPhase: (phase) => set({ phase }),
  setCurrentIndex: (index) => set({ currentIndex: index }),
  setLives: (lives) => set({ lives }),
  setPractice: (practice) => set({ practice }),
  finish: (result) => set({ phase: 'finished', result }),
  abort: () => set({ phase: 'aborted' }),
  reset: () => set({ ...INITIAL }),
}));
