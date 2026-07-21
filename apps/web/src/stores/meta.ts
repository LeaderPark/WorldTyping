// spec: docs/03 §4.3("메타(업적/여권/스트릭)는 stores/meta.ts(persist)로 분리 — 생략된 형태는
//       동일 패턴"), docs/01 §10.1(S13 여권), WT-M2-05
//
// §4.3이 필드 전문을 명시하지 않아(생략) S13 와이어프레임(스트릭·PI 최고·스탬프 그리드)과
// settings.ts의 persist 패턴을 준용해 이 태스크에서 최소 구현한다. 랭킹 걸린 판정 데이터가
// 아니라 로컬 진행 기록 캐시일 뿐이므로 서버 데이터와 충돌 시 서버 값이 항상 우선(비고).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface MetaState {
  /** 연속 플레이 일수(KST 기준 날짜 문자열로 판정, 예: "2026-07-21"). */
  streakCount: number;
  lastPlayedDateKST: string | null;
  /** 역대 최고 PI(passport.bestPI 표시용). */
  bestPI: number | null;
  /** 잠금 해제된 업적 id 집합. */
  unlockedAchievements: string[];
  /** 완주 기록이 있는 노선/모드 키 → true (passport.stamps 그리드). */
  stamps: Record<string, boolean>;

  recordPlay(dateKST: string): void;
  setBestPI(pi: number): void;
  unlockAchievement(id: string): void;
  addStamp(key: string): void;
  reset(): void;
}

const INITIAL: Omit<
  MetaState,
  'recordPlay' | 'setBestPI' | 'unlockAchievement' | 'addStamp' | 'reset'
> = {
  streakCount: 0,
  lastPlayedDateKST: null,
  bestPI: null,
  unlockedAchievements: [],
  stamps: {},
};

/** 두 KST 날짜 문자열("yyyy-mm-dd")이 정확히 하루 차이인지. */
function isConsecutiveDay(prev: string, next: string): boolean {
  const prevDate = new Date(`${prev}T00:00:00Z`);
  const nextDate = new Date(`${next}T00:00:00Z`);
  const diffDays = Math.round((nextDate.getTime() - prevDate.getTime()) / 86_400_000);
  return diffDays === 1;
}

export const useMetaStore = create<MetaState>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      recordPlay: (dateKST) => {
        const { lastPlayedDateKST, streakCount } = get();
        if (lastPlayedDateKST === dateKST) return; // 하루 중복 기록 방지
        const nextStreak =
          lastPlayedDateKST && isConsecutiveDay(lastPlayedDateKST, dateKST) ? streakCount + 1 : 1;
        set({ streakCount: nextStreak, lastPlayedDateKST: dateKST });
      },
      setBestPI: (pi) => set((s) => ({ bestPI: s.bestPI === null ? pi : Math.max(s.bestPI, pi) })),
      unlockAchievement: (id) =>
        set((s) =>
          s.unlockedAchievements.includes(id)
            ? s
            : { unlockedAchievements: [...s.unlockedAchievements, id] },
        ),
      addStamp: (key) => set((s) => ({ stamps: { ...s.stamps, [key]: true } })),
      reset: () => set({ ...INITIAL }),
    }),
    { name: 'wt:meta' },
  ),
);
