// spec: docs/03 §4.3("메타(업적/여권/스트릭)는 stores/meta.ts(persist)로 분리 — 생략된 형태는
//       동일 패턴"), docs/01 §10.1(S13 여권)·§10.2(S3 모드선택 "완주 4/6"·"진행 T3 도전 중"·
//       "최고: 카이로 도달", S4 노선선택 "최고 S 2:58"), WT-M2-05, WT-M2-07(trackBests/worldtour 확장)
//
// §4.3이 필드 전문을 명시하지 않아(생략) S13 와이어프레임(스트릭·PI 최고·스탬프 그리드)과
// settings.ts의 persist 패턴을 준용해 이 태스크에서 최소 구현한다. 랭킹 걸린 판정 데이터가
// 아니라 로컬 진행 기록 캐시일 뿐이므로 서버 데이터와 충돌 시 서버 값이 항상 우선(비고).
//
// WT-M2-07: ModeSelectPage/TrackSelectPage가 "완주/최고 기록"을 표시하려면 국가 전환 이하
// 빈도(판 종료 1회)로 기록되는 트랙별 최고 기록이 필요하다 — recordRun()이 그 유일한 쓰기
// 진입점이다(ResultView가 finished 1회 호출). 키 규약은 stamps와 동일한 `${mode}:${trackId}`
// (meta.test.ts의 "continent:asia" 관례를 그대로 확장). 세계일주 "최고 도달지"는 CountryId만
// 저장하면 표시 계층이 getBootData()(국가 데이터셋)에 의존하게 되어 ModeSelectPage가 부팅
// 데이터 없이 렌더될 수 없게 된다(라우팅 스모크 테스트가 그 전제로 짜여 있다) — 그래서 기록
// 시점(ResultView가 이미 갖고 있는 countries+lang)에 로컬라이즈된 이름 문자열을 함께 저장한다.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CountryId, Grade } from '@wt/shared';

export interface TrackBest {
  grade: Grade;
  timeMs: number;
  score: number;
  completed: boolean;
}

export interface WorldtourProgress {
  /** perCountry.length - 1 (0-based, 도달한 마지막 국가의 인덱스). */
  index: number;
  countryId: CountryId;
  nameKo: string;
  nameEn: string;
}

export interface RecordRunInput {
  /** 스탬프/trackBests 키 프리픽스(예: "continent", "tier", "worldtour"). */
  mode: string;
  trackId: string;
  dateKST: string;
  pi: number;
  grade: Grade;
  timeMs: number;
  score: number;
  completed: boolean;
}

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
  /** `${mode}:${trackId}` → 최고 기록(점수 기준 갱신). 완주 여부와 무관하게 시도만 해도 남는다
   *  (ModeSelectPage의 "진행: T3 도전 중"이 이 키의 존재 여부로 판정된다). */
  trackBests: Record<string, TrackBest>;
  /** 세계일주 최고 도달지(완주 실패해도 갱신 — §10.2 "최고: 카이로 도달"). */
  worldtourFurthest: WorldtourProgress | null;

  recordPlay(dateKST: string): void;
  setBestPI(pi: number): void;
  unlockAchievement(id: string): void;
  addStamp(key: string): void;
  /** 판 종료 1회(ResultView) — bestPI/recordPlay/trackBests/stamps를 한 번에 갱신. */
  recordRun(input: RecordRunInput): void;
  /** 세계일주 전용: 이번 런의 도달 인덱스가 기존 최고보다 깊으면만 갱신. */
  recordWorldtourProgress(progress: WorldtourProgress): void;
  reset(): void;
}

const INITIAL: Omit<
  MetaState,
  | 'recordPlay'
  | 'setBestPI'
  | 'unlockAchievement'
  | 'addStamp'
  | 'recordRun'
  | 'recordWorldtourProgress'
  | 'reset'
> = {
  streakCount: 0,
  lastPlayedDateKST: null,
  bestPI: null,
  unlockedAchievements: [],
  stamps: {},
  trackBests: {},
  worldtourFurthest: null,
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

      recordRun: (input) => {
        const { mode, trackId, dateKST, pi, grade, timeMs, score, completed } = input;
        get().recordPlay(dateKST);
        get().setBestPI(pi);
        const key = `${mode}:${trackId}`;
        set((s) => {
          const prev = s.trackBests[key];
          const better = !prev || score > prev.score;
          return better
            ? { trackBests: { ...s.trackBests, [key]: { grade, timeMs, score, completed } } }
            : s;
        });
        if (completed) get().addStamp(key);
      },

      recordWorldtourProgress: (progress) =>
        set((s) =>
          !s.worldtourFurthest || progress.index > s.worldtourFurthest.index
            ? { worldtourFurthest: progress }
            : s,
        ),

      reset: () => set({ ...INITIAL }),
    }),
    { name: 'wt:meta' },
  ),
);
