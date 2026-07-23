// spec: docs/06 §1.5(Cron */1 dirty refresher + minute%10 콜드 전량), docs/00 §11-D24(1분 dirty,
//       04의 5분 스냅샷 폐기 · 단일 KV lb: 프리픽스)·§11-D60(WT-OPT-01 — 무-dirty·비-콜드 분
//       KV op=1 get 게이트 + 콜드 분기 D1/KV 프리필터) + WT-M3-04
//
// 매분 실행: (0) dirty sentinel(kv-keys.ts dirtySentinel)이 없고 콜드 분(minute%10!==0)도 아니면
//     즉시 반환한다 — 이 분은 KV op가 정확히 1회(sentinel get)뿐이다(§11-D60).
// (1) dirty:{board} 목록 = 지난 1분간 제출로 변경된 보드만 top-100 재조회 → lb:{board}.
// (2) minute%10===0이면 alltime 콜드 보드를 리프레시하되, lb_best에 실제 행이 있는 보드만
//     골라서(1회 DISTINCT 쿼리로 프리필터) 재조회한다 — 늘 비어있는 모드에 매 10분 D1/KV
//     왕복을 낭비하지 않는다. 캐시는 있는데 현재 행이 0으로 빠진 보드(닉변이 아니라 전원
//     비활성화·삭제로 완전히 비워진 보드)는 KV list 1회로 찾아 캐시만 지운다.
// 제출 핸들러가 dirty 마킹 + sentinel을 함께 남기고(routes/runs.ts), dirty 키는 조회 즉시
// 삭제해 다음 분에 중복 처리되지 않게 한다(TTL 180s 자연 만료도 있지만 명시 삭제로 절감).
// sentinel은 dirty 목록을 list하기 전에 삭제한다 — 삭제 이후 들어오는 새 제출의 dirty 마킹이
// sentinel을 재생성하므로, 이번 실행이 그 사이의 갱신을 놓치더라도 다음 분 실행이 반드시
// 다시 게이트를 통과한다(유실 없음, 레이스는 다음 분으로 이월될 뿐).
import type { Env } from "../env";
import { KV_KEYS } from "../lib/kv-keys";
import { coldAlltimeBoardKeys, refreshBoardCache } from "../lib/lb";

const DIRTY_PREFIX = "dirty:";
const LB_PREFIX = "lb:";

/**
 * lb-refresher 본체. scheduledTime(epoch ms)로 minute%10 콜드 분기를 판정한다(cron minute
 * 경계는 UTC 정렬 — getUTCMinutes()로 :00/:10/:20…에 콜드 전량).
 */
export async function runLbRefresher(env: Env, scheduledTime: number): Promise<void> {
  const kv = env.KV;
  const db = env.DB;
  if (!kv || !db) return;

  const minute = new Date(scheduledTime).getUTCMinutes();
  const isColdMinute = minute % 10 === 0;

  // (0) sentinel 게이트 — dirty 없고 콜드 분도 아니면 KV op 정확히 1회(get)로 조기 반환.
  const sentinelExists = (await kv.get(KV_KEYS.dirtySentinel)) !== null;
  if (!sentinelExists && !isColdMinute) return;

  // sentinel은 list 이전에 지운다(파일 상단 주석 — 레이스는 다음 분으로 이월).
  if (sentinelExists) {
    await kv.delete(KV_KEYS.dirtySentinel);
  }

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

  const boards = new Set<string>(dirtyBoards);

  // (2) 콜드(alltime) 보드 — 10분 주기. lb_best에 실제 행이 있는 보드만 프리필터(1회 DISTINCT).
  if (isColdMinute) {
    const activeAllBoards = await activeAllBoardKeys(db);
    for (const bk of coldAlltimeBoardKeys()) {
      if (activeAllBoards.has(bk)) boards.add(bk);
    }

    // 캐시는 있는데 현재 행이 0인 콜드 보드 정리(전량 비활성화·삭제로 비워진 보드) — KV list 1회.
    const cachedBoards = await listCachedBoardKeys(kv);
    for (const bk of coldAlltimeBoardKeys()) {
      if (cachedBoards.has(bk) && !activeAllBoards.has(bk)) {
        await kv.delete(KV_KEYS.lb(bk));
      }
    }
  }

  // 재조회 + KV 갱신. dirty 키는 처리 후 삭제(중복 방지).
  for (const bk of boards) {
    await refreshBoardCache(db, kv, bk);
  }
  for (const bk of dirtyBoards) {
    await kv.delete(KV_KEYS.dirty(bk));
  }
}

/** 현재 lb_best에 ≥1행이 있는 alltime(`|all`) board_key 전체 — 1회 DISTINCT 쿼리(§11-D60). */
async function activeAllBoardKeys(db: D1Database): Promise<Set<string>> {
  const res = await db
    .prepare(`SELECT DISTINCT board_key FROM lb_best WHERE board_key LIKE '%|all'`)
    .all<{ board_key: string }>();
  return new Set((res.results ?? []).map((r) => r.board_key));
}

/** 현재 `lb:*` KV에 캐시가 존재하는 board_key 전체(프리픽스 벗긴 값) — 1회 list(페이지네이션 포함). */
async function listCachedBoardKeys(kv: KVNamespace): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix: LB_PREFIX, cursor });
    for (const key of listed.keys) out.add(key.name.slice(LB_PREFIX.length));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return out;
}
