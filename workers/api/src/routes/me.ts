// spec: docs/06 §6.2(처리 항목 인벤토리)·§6.3(열람/이동권·삭제권 구현 전문)·§6.5(셀프서비스,
//       "수동 처리 없음")·§1.5(KV top-100 캐시 갱신 주기), docs/04 §10.4(GDPR (a) 접근/삭제권),
//       docs/00 §11-D38(user_id=pid, 매핑 테이블 없음) + WT-M6-01
//
// GET /users/me/export — users/runs(요약)/unlocks를 JSON 파일로 즉시 응답(수동 처리 없음).
// DELETE /users/me — 트랜잭션: detail_json 삭제(NOT NULL 컬럼이라 '{}'로), nickname 익명화,
//   lb_best/user_unlocks 삭제, status='deleted', device_hash 매핑 해제.
//
// [device_hash "매핑 해제"의 실제 의미 — docs/00 §11-D38과의 정합, 최종 보고 escalations 참조]
// docs/06 §6.3 원문은 device_hash→user_id 매핑 테이블이 별도로 있다는 전제(초기 06 §1.3의
// UUIDv7 user_id 뉘앙스)에서 쓰인 문장이다. D38 확정 이후 user_id = pid = deterministic
// derive(deviceId)라 "매핑을 끊어 새 user_id를 받게 한다"는 문자 그대로는 성립하지 않는다
// (같은 deviceId는 항상 같은 pid로 되돌아온다 — 이건 설계 의도다, session.ts 상단 주석 참조).
// 이 구현이 채택한 실질적 해석: device_hash 컬럼값을 (역산 불가능한) 센티널로 교체해 "이
// deviceId가 이 계정과 결부되어 있었다"는 흔적을 DB에서 지우고, 동일 deviceId로 재부트스트랩하면
// (routes/session.ts의 reactivateDeletedUser) 닉네임/스트릭/커버가 전부 초기화된 "사실상 신규
// 계정"으로 되살아난다. 즉 "매핑 해제"는 unlink가 아니라 "다음 부트스트랩 시 익명화 리셋"으로
// 구현했다 — 리드 확인 전까지 잠정 해석으로 취급할 것.
import { Hono } from "hono";
import type { Env } from "../env";
import type { UserRow, UserUnlockRow } from "../db/types";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { DIRTY_TTL_SEC } from "../lib/lb";
import { requireAuth, type AuthVariables } from "../mw/auth";

export const me = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/** docs/06 §6.3 원문의 익명화 닉네임. */
const DELETED_NICKNAME = "탈퇴한 여행자";
/** "최대 10분" 고지(§6.3) — 실제로는 삭제 즉시 관련 board_key를 dirty 마킹해 매분 도는
 *  cron(cron/lb-refresher.ts)이 다음 주기 안에 반영하지만, 문서에 박힌 상한값을 그대로
 *  응답에도 실어 클라가 동일 문구를 쓸 수 있게 한다(문서-구현 드리프트 방지). */
const CACHE_MAX_DELAY_SEC = 10 * 60;

// ───────────────────────── GET /users/me/export ─────────────────────────

interface ExportRunSummary {
  runId: string;
  modeKey: string;
  lang: string;
  platform: string;
  score: number;
  pi: number;
  cpm: number;
  accMilli: number;
  elapsedMs: number;
  countriesCleared: number;
  countriesSkipped: number;
  maxCombo: number;
  completed: boolean;
  grade: string;
  verdict: string;
  geo: string | null;
  createdAt: number;
}

interface ExportUnlock {
  type: UserUnlockRow["unlock_type"];
  id: string;
  meta: unknown;
  createdAt: number;
}

interface ExportBody {
  exportedAt: number;
  user: {
    userId: string;
    nickname: string;
    passportCover: string;
    geo: string | null;
    status: UserRow["status"];
    streakDaily: number;
    createdAt: number;
    updatedAt: number;
  };
  runs: ExportRunSummary[];
  unlocks: ExportUnlock[];
}

interface RunSummaryRow {
  run_id: string;
  mode_key: string;
  lang: string;
  platform: string;
  score: number;
  pi: number;
  cpm: number;
  acc_milli: number;
  elapsed_ms: number;
  countries_cleared: number;
  countries_skipped: number;
  max_combo: number;
  completed: 0 | 1;
  grade: string;
  verdict: string;
  geo: string | null;
  created_at: number;
}

me.get("/users/me/export", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const pid = c.get("pid");

  const user = await db
    .prepare(
      `SELECT user_id, nickname, passport_cover, geo, status, streak_daily, created_at, updated_at
         FROM users WHERE user_id = ?1`,
    )
    .bind(pid)
    .first<
      Pick<
        UserRow,
        "user_id" | "nickname" | "passport_cover" | "geo" | "status" | "streak_daily" | "created_at" | "updated_at"
      >
    >();
  if (!user) throw new ApiHttpError(404, "NOT_FOUND", "세션 pid에 해당하는 유저를 찾을 수 없습니다.");

  // "요약"(§6.3) — detail_json(원시 perCountry 입력)은 열람권 대상에서 제외한다. 서버 재계산
  // 결과 필드만 내려준다(클라 조작 원문이 아니라 이미 검증된 요약 통계).
  const { results: runRows } = await db
    .prepare(
      `SELECT run_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms,
              countries_cleared, countries_skipped, max_combo, completed, grade, verdict, geo, created_at
         FROM runs WHERE user_id = ?1 ORDER BY created_at ASC`,
    )
    .bind(pid)
    .all<RunSummaryRow>();

  const { results: unlockRows } = await db
    .prepare(
      `SELECT unlock_type, unlock_id, meta_json, created_at FROM user_unlocks WHERE user_id = ?1 ORDER BY created_at ASC`,
    )
    .bind(pid)
    .all<UserUnlockRow>();

  const body: ExportBody = {
    exportedAt: Date.now(),
    user: {
      userId: user.user_id,
      nickname: user.nickname,
      passportCover: user.passport_cover,
      geo: user.geo,
      status: user.status,
      streakDaily: user.streak_daily,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    },
    runs: (runRows ?? []).map((r) => ({
      runId: r.run_id,
      modeKey: r.mode_key,
      lang: r.lang,
      platform: r.platform,
      score: r.score,
      pi: r.pi,
      cpm: r.cpm,
      accMilli: r.acc_milli,
      elapsedMs: r.elapsed_ms,
      countriesCleared: r.countries_cleared,
      countriesSkipped: r.countries_skipped,
      maxCombo: r.max_combo,
      completed: r.completed === 1,
      grade: r.grade,
      verdict: r.verdict,
      geo: r.geo,
      createdAt: r.created_at,
    })),
    unlocks: (unlockRows ?? []).map((u) => ({
      type: u.unlock_type,
      id: u.unlock_id,
      meta: u.meta_json ? (JSON.parse(u.meta_json) as unknown) : null,
      createdAt: u.created_at,
    })),
  };

  // "JSON 파일로 즉시 응답"(§6.3) — Content-Disposition으로 다운로드 파일명을 실어 브라우저가
  // 저장 대화상자를 띄우게 한다(클라의 fetch+Blob 다운로드 트리거와 함께, 이중 방어).
  c.header("Content-Disposition", `attachment; filename="typetrip-data-${user.user_id}.json"`);
  return c.json(body);
});

// ───────────────────────── DELETE /users/me ─────────────────────────

interface DeleteRes {
  ok: true;
  deletedAt: number;
  /** 클라가 동일 문구를 쓸 수 있도록 상한(초)을 응답에도 싣는다(§6.3 "최대 10분"). */
  cacheMaxDelaySec: number;
}

me.delete("/users/me", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const pid = c.get("pid");

  const existing = await db
    .prepare(`SELECT status FROM users WHERE user_id = ?1`)
    .bind(pid)
    .first<Pick<UserRow, "status">>();
  if (!existing) throw new ApiHttpError(404, "NOT_FOUND", "세션 pid에 해당하는 유저를 찾을 수 없습니다.");

  const now = Date.now();
  if (existing.status === "deleted") {
    // 이미 삭제된 계정의 중복 삭제 요청 — 멱등 성공(에러로 취급하지 않는다, §6.5 "즉시 처리"
    // 원칙과 동일하게 재시도를 벌하지 않는다).
    return c.json(
      { ok: true, deletedAt: now, cacheMaxDelaySec: CACHE_MAX_DELAY_SEC } satisfies DeleteRes,
    );
  }

  // lb_best 삭제 전에 어느 board_key에 올라 있었는지 알아둔다 — 삭제 후에는 조회 불가하므로
  // dirty 마킹(§1.5, 1분 내 KV 캐시 반영)을 위해 먼저 확보한다.
  const { results: boardRows } = await db
    .prepare(`SELECT board_key FROM lb_best WHERE user_id = ?1`)
    .bind(pid)
    .all<{ board_key: string }>();
  const boardKeys = (boardRows ?? []).map((r) => r.board_key);

  const normDeleted = `deleted:${pid}`; // NICK_RE(§11-D14)가 ':'을 허용하지 않아 실제 닉네임과 충돌 불가.
  const deviceHashReleased = `deleted:${pid}`; // device_hash UNIQUE — 결정적 센티널로 원 파생값을 대체.

  await db.batch([
    // detail_json은 NOT NULL이라 NULL 대신 빈 객체로(§6.3 "detail_json 삭제"의 실질적 구현).
    db.prepare(`UPDATE runs SET detail_json = '{}' WHERE user_id = ?1`).bind(pid),
    db
      .prepare(
        `UPDATE users SET nickname = ?2, nickname_norm = ?3, device_hash = ?4, status = 'deleted', updated_at = ?5
           WHERE user_id = ?1`,
      )
      .bind(pid, DELETED_NICKNAME, normDeleted, deviceHashReleased, now),
    db.prepare(`DELETE FROM lb_best WHERE user_id = ?1`).bind(pid),
    db.prepare(`DELETE FROM user_unlocks WHERE user_id = ?1`).bind(pid),
    // WT-AUTH-01(docs/04 §5.5): 계정 로그인 매핑도 삭제권 대상 — Google sub↔user 연결을 끊는다.
    // 게스트 계정은 auth_identities 행이 없어 no-op. 같은 sub로 재로그인하면 auth.ts가 새로 만들되
    // reactivateAccountUser가 닉네임/스트릭을 초기화한 "사실상 신규 계정"으로 되살린다(§6.3 정합).
    db.prepare(`DELETE FROM auth_identities WHERE user_id = ?1`).bind(pid),
  ]);

  if (c.env.KV) {
    const kv = c.env.KV;
    await Promise.all([
      kv.delete(KV_KEYS.passport(pid)),
      ...boardKeys.map((bk) => kv.put(KV_KEYS.dirty(bk), "1", { expirationTtl: DIRTY_TTL_SEC })),
      // sentinel(§11-D60·WT-OPT-01): lb-refresher가 매분 이 키 하나만으로 "처리할 dirty 보드가
      // 있는지"를 게이트한다 — 이 경로도 routes/runs.ts와 동일하게 dirty 마킹과 항상 함께 남겨야
      // cron이 계정 삭제로 새로 생긴 dirty 보드를 다음 분에 놓치지 않는다. 보드가 하나도 없었으면
      // (원래 리더보드에 등재된 적 없는 계정) sentinel도 남기지 않는다.
      ...(boardKeys.length > 0 ? [kv.put(KV_KEYS.dirtySentinel, "1", { expirationTtl: DIRTY_TTL_SEC })] : []),
    ]);
  }

  return c.json({ ok: true, deletedAt: now, cacheMaxDelaySec: CACHE_MAX_DELAY_SEC } satisfies DeleteRes);
});
