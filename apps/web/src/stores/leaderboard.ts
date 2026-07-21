// spec: docs/03 §4.3(LeaderboardState 전문 — "TanStack Query 미도입, 자체 SWR 유틸 ~40줄"),
//       docs/06 §1.1(board_key)·§1.4(조회 계약), docs/00 §11-D9(랭킹 canonical은 06/runs+lb_best,
//       이 스토어는 그 조회 결과의 클라 캐시일 뿐 — 원천 아님), WT-M2-05·WT-M3-06
//
// TanStack Query 등 데이터 라이브러리 추가 금지(작업 블록 제약) — stale 60s 캐시를 스토어
// 자체에서 직접 관리한다(§4.3 인터페이스가 fetch(key):Promise<void> 형태로 캐시 소유를 스토어에
// 두도록 정의돼 있어 useSwr 훅을 경유하지 않는다).
//
// [WT-M3-06] key는 실제 서버 board_key 문자열(`${modeKey}|${lang}|${platform}|${period}`,
// net/api-client.ts의 buildBoardKey/modeKeyFor로 조립)을 그대로 쓴다 — WT-M2-05 초안의
// `${scope}:${mode}:${lang}:${platform}` 축약형은 실 API(GET /api/v1/lb?board=)와 형식이 달라
// 폐기한다(docs/06 §1.1이 canonical). "내 행"은 이 스토어가 아니라 GET /lb/me(rank-of-me,
// docs/06 §1.4-②)로 별도 조회한다 — 스코어/닉네임 없는 다른 응답 모양이라 같은 캐시에 억지로
// 합치지 않는다(RankPage가 각각 훅으로 소비).
import { create } from 'zustand';
import { fetchLbPage, type LbEntry } from '../net/api-client';

/** 서버 board_key와 완전히 동일한 형식 — buildBoardKey()로 조립해서 쓴다. */
export type BoardKey = string;

export type RankRow = LbEntry;

interface BoardEntry {
  rows: RankRow[];
  nextCursor: string | null;
  total: number;
  fetchedAt: number;
}

const STALE_MS = 60_000;

export interface LeaderboardState {
  boards: Map<BoardKey, BoardEntry>;
  /** stale 60s — 첫 페이지(커서 없음) 조회. 캐시가 신선하면 재조회하지 않는다. */
  fetch(key: BoardKey): Promise<void>;
}

export const useLeaderboardStore = create<LeaderboardState>()((set, get) => ({
  boards: new Map(),

  fetch: async (key) => {
    const existing = get().boards.get(key);
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;

    try {
      const res = await fetchLbPage(key);
      const nextBoards = new Map(get().boards);
      nextBoards.set(key, { rows: res.entries, nextCursor: res.nextCursor, total: res.total, fetchedAt: Date.now() });
      set({ boards: nextBoards });
    } catch (err) {
      // 조회 실패는 화면을 깨뜨리지 않고 이전 캐시를 유지한다(랭킹은 부가 화면).
      console.warn(`[leaderboard] fetch(${key}) failed:`, err);
    }
  },
}));
