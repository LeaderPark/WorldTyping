// spec: docs/06 §1.5(Cron */1 dirty refresher + minute%10 콜드 전량), docs/00 §11-D24(1분 dirty,
//       04의 5분 스냅샷 폐기 · 단일 KV lb: 프리픽스) + WT-M3-04
//
// 매분 실행: (1) dirty:{board} 목록 = 지난 1분간 제출로 변경된 보드만 top-100 재조회 → lb:{board}.
// (2) minute%10===0이면 alltime 콜드 보드 전량 리프레시(닉네임 변경 반영 — 콜드 보드는 dirty
//     마킹이 없으므로). 제출 핸들러가 dirty 마킹을 남기고(routes/runs.ts), dirty 키는 조회 즉시
//     삭제해 다음 분에 중복 처리되지 않게 한다(TTL 180s 자연 만료도 있지만 명시 삭제로 절감).
import type { Env } from "../env";
import { KV_KEYS } from "../lib/kv-keys";
import { coldAlltimeBoardKeys, refreshBoardCache } from "../lib/lb";

const DIRTY_PREFIX = "dirty:";

/**
 * lb-refresher 본체. scheduledTime(epoch ms)로 minute%10 콜드 분기를 판정한다(cron minute
 * 경계는 UTC 정렬 — getUTCMinutes()로 :00/:10/:20…에 콜드 전량).
 */
export async function runLbRefresher(env: Env, scheduledTime: number): Promise<void> {
  const kv = env.KV;
  const db = env.DB;
  if (!kv || !db) return;

  // (1) dirty 보드 수집.
  const dirtyBoards = new Set<string>();
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix: DIRTY_PREFIX, cursor });
    for (const key of listed.keys) {
      dirtyBoards.add(key.name.slice(DIRTY_PREFIX.length));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  // (2) 콜드(alltime) 보드 — 10분 주기.
  const minute = new Date(scheduledTime).getUTCMinutes();
  const boards = new Set<string>(dirtyBoards);
  if (minute % 10 === 0) {
    for (const bk of coldAlltimeBoardKeys()) boards.add(bk);
  }

  // 재조회 + KV 갱신. dirty 키는 처리 후 삭제(중복 방지).
  for (const bk of boards) {
    await refreshBoardCache(db, kv, bk);
  }
  for (const bk of dirtyBoards) {
    await kv.delete(KV_KEYS.dirty(bk));
  }
}
