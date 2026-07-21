// spec: docs/03 §4.3(LeaderboardState 전문 — "TanStack Query 미도입, 자체 SWR 유틸"),
//       docs/04 §2.2(GET /leaderboard 응답 필드), docs/00 §11-D9(랭킹 canonical은 06/runs+lb_best,
//       이 스토어는 그 조회 결과의 클라 캐시일 뿐 — 원천 아님), WT-M2-05
//
// TanStack Query 등 데이터 라이브러리 추가 금지(작업 블록 제약) — net/swr.ts 대신, 여기서는
// stale 60s 캐시를 스토어 자체에서 직접 관리한다(§4.3 인터페이스가 fetch(key):Promise<void> 형태로
// 이미 캐시 소유를 스토어에 두도록 정의돼 있어 useSwr 훅을 경유하지 않는다).

import { create } from 'zustand';
import { apiClient } from '../net/api-client';
import type { Platform } from '../lib/platform';

export type LeaderboardScope = 'daily' | 'weekly' | 'alltime';

/**
 * `${scope}:${mode}:${lang}:${platform}` — 예: "alltime:worldtour:ko:desktop"(§4.3 원문).
 * mode는 GameMode 단순값뿐 아니라 "continent:asia"/"tier:3" 같은 복합 파라미터도 오므로(docs/04
 * §2.2 query 예시) 리터럴 유니온이 아니라 string으로 둔다.
 */
export type BoardKey = `${LeaderboardScope}:${string}:${'ko' | 'en'}:${Platform}`;

export interface RankRow {
  rank: number;
  playerId: string;
  nickname: string;
  score: number;
  pi: number;
  cpm: number;
  accuracy: number;
  elapsedMs: number;
  createdAt: string;
}

interface LeaderboardApiResponse {
  entries: RankRow[];
  nextCursor: string | null;
  snapshotAt: string;
}

interface BoardEntry {
  rows: RankRow[];
  myRow: RankRow | null;
  fetchedAt: number;
}

const STALE_MS = 60_000;

export interface LeaderboardState {
  boards: Map<BoardKey, BoardEntry>;
  fetch(key: BoardKey): Promise<void>;
}

function parseBoardKey(key: BoardKey): { period: string; mode: string; lang: string; platform: string } {
  const [period, mode, lang, platform] = key.split(':');
  return { period: period ?? '', mode: mode ?? '', lang: lang ?? '', platform: platform ?? '' };
}

export const useLeaderboardStore = create<LeaderboardState>()((set, get) => ({
  boards: new Map(),

  fetch: async (key) => {
    const existing = get().boards.get(key);
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;

    const { period, mode, lang, platform } = parseBoardKey(key);
    const query = new URLSearchParams({ period, mode, lang, platform }).toString();

    try {
      const res = await apiClient.get<LeaderboardApiResponse>(`/leaderboard?${query}`);
      const nextBoards = new Map(get().boards);
      nextBoards.set(key, { rows: res.entries, myRow: null, fetchedAt: Date.now() });
      set({ boards: nextBoards });
    } catch (err) {
      // 백엔드 /leaderboard 미구현(M3 이전)이거나 네트워크 실패 — 조회 실패는 화면을 깨뜨리지
      // 않고 이전 캐시를 유지한다(랭킹은 부가 화면, 판정/점수 경로가 아니므로 관대하게 처리).
      console.warn(`[leaderboard] fetch(${key}) failed:`, err);
    }
  },
}));
