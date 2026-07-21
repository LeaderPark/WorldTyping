// spec: docs/06 §4.2(닉네임 규칙·필터 파이프라인 전문), docs/04 §2.3-8/9(NicknameCheckReq/Res 스키마
//       — reason vocabulary만 채택, 나머지는 06 승), docs/00 §11-D14(06 승: 2~12자·30일당 2회) +
//       docs/07 WT-M3-05
//
// POST /nickname/check — 부작용 없는 사전 검사(형식·콘텐츠·가용성). PUT /nickname — 실제 확정.
// 형식(NICK_RE)·정규화(normalizeNickname)·비속어/예약어(evaluateText)는 전부 @wt/moderation
// 재사용 — 판정 로직을 이 라우트에서 재구현하지 않는다(CLAUDE.md "판정 로직 복제 금지"와 동형).
import { Hono } from "hono";
import { z } from "zod";
// 주의: "@wt/moderation"(배럴)이 아니라 하위 모듈을 직접 import한다. 배럴은 filter.ts를
// 재-export하고, filter.ts는 모듈 최상위에서 node:fs로 badwords/*.txt를 읽는다 — Workers 런타임에는
// 파일시스템이 없어 그 경로를 import하면 콜드스타트 자체가 깨진다. NICK_RE/normalizeNickname은
// fs 의존이 없어 안전하고, 콘텐츠 필터는 fs 대신 빌드타임 스냅샷을 createFilter(engine.ts)에 직접
// 주입해 만든다(구현 세부 지시 5 — moderation-wordlists.generated.ts).
import { NICK_RE, normalizeNickname } from "@wt/moderation/src/nickname";
import { createFilter } from "@wt/moderation/src/engine";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { requireAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";
import { KV_KEYS } from "../lib/kv-keys";
import {
  MODERATION_KO_BADWORDS,
  MODERATION_EN_BADWORDS,
  MODERATION_EN_ALLOWLIST,
} from "../lib/moderation-wordlists.generated";

/** 빌드타임 스냅샷 주입 인스턴스(node:fs 없이 콘텐츠 필터 재사용, 구현 세부 지시 5). */
const CONTENT_FILTER = createFilter({
  ko: MODERATION_KO_BADWORDS,
  en: MODERATION_EN_BADWORDS,
  allow: MODERATION_EN_ALLOWLIST,
});

type NicknameReason = "TAKEN" | "TOO_SHORT" | "TOO_LONG" | "INVALID_CHARS" | "BLOCKED_WORD" | "RESERVED";

interface NicknameCheckRes {
  ok: boolean;
  reason?: NicknameReason;
}

const NicknameReqSchema = z.object({ nickname: z.string().min(1).max(64) }).strict();

/** 닉네임 변경 정책(§11-D14 — 06 승: 30일당 2회). API 어뷰징 방어(mw/ratelimit.ts의 'nickname'
 * 스코프, 1h/5회)와는 목적이 다른 별도 카운터다. */
const NICKNAME_POLICY_WINDOW_SEC = 30 * 24 * 60 * 60;
const NICKNAME_POLICY_MAX = 2;

export const nickname = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// ───────────────────────── POST /nickname/check ─────────────────────────

nickname.post("/nickname/check", requireAuth, rateLimit("nickname"), async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const parsed = NicknameReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "nickname이 필요합니다.");
  const { nickname: name } = parsed.data;
  const pid = c.get("pid");

  const formatReason = evaluateFormat(name);
  if (formatReason) {
    const body: NicknameCheckRes = { ok: false, reason: formatReason };
    return c.json(body);
  }

  const norm = normalizeNickname(name);
  const owner = await findOwnerByNorm(db, norm);
  if (owner && owner !== pid) {
    const body: NicknameCheckRes = { ok: false, reason: "TAKEN" };
    return c.json(body);
  }

  const body: NicknameCheckRes = { ok: true };
  return c.json(body);
});

// ───────────────────────── PUT /nickname ─────────────────────────

nickname.put("/nickname", requireAuth, rateLimit("nickname"), async (c) => {
  const db = c.env.DB;
  if (!db) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "DB binding not configured");
  const parsed = NicknameReqSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "nickname이 필요합니다.");
  const { nickname: name } = parsed.data;
  const pid = c.get("pid");

  const formatReason = evaluateFormat(name);
  if (formatReason) {
    throw new ApiHttpError(400, "NICKNAME_REJECTED", formatReason);
  }

  const norm = normalizeNickname(name);
  const owner = await findOwnerByNorm(db, norm);
  if (owner && owner !== pid) {
    throw new ApiHttpError(409, "NICKNAME_TAKEN", "이미 사용 중인 닉네임입니다.");
  }

  const current = await db
    .prepare(`SELECT nickname, nickname_norm FROM users WHERE user_id = ?1`)
    .bind(pid)
    .first<{ nickname: string; nickname_norm: string }>();
  if (!current) throw new ApiHttpError(404, "NOT_FOUND", "세션 pid에 해당하는 유저를 찾을 수 없습니다.");

  // 현재 닉네임과 정규화형이 같으면 "변경"이 아니다 — 정책 카운터를 소모하지 않는 no-op 성공.
  if (current.nickname_norm === norm) {
    const body = { nickname: current.nickname };
    return c.json(body);
  }

  if (c.env.KV) {
    const blocked = await bumpNicknamePolicyCounter(c.env.KV, pid);
    if (blocked) {
      throw new ApiHttpError(429, "NICKNAME_CHANGE_LIMIT", "닉네임 변경은 30일당 2회까지 가능합니다.");
    }
  }

  const now = Date.now();
  try {
    await db
      .prepare(`UPDATE users SET nickname = ?2, nickname_norm = ?3, updated_at = ?4 WHERE user_id = ?1`)
      .bind(pid, name, norm, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 체크→쓰기 사이 레이스로 동시에 같은 닉네임이 선점된 경우 — nickname_norm UNIQUE 위반.
    if (/UNIQUE/i.test(msg)) throw new ApiHttpError(409, "NICKNAME_TAKEN", "이미 사용 중인 닉네임입니다.");
    throw err;
  }

  const body = { nickname: name };
  return c.json(body);
});

// ───────────────────────── 내부 헬퍼 ─────────────────────────

/**
 * 형식(길이·허용 문자)·콘텐츠(비속어·예약어) 검사만 — 가용성(TAKEN)은 별도(DB 조회 필요).
 * 길이는 NICK_RE가 이미 [2,12] 범위를 강제하지만, docs/04 §2.3-9의 세분화된 reason(TOO_SHORT/
 * TOO_LONG/INVALID_CHARS)을 그대로 내려주기 위해 여기서 먼저 갈라 판정한다.
 */
function evaluateFormat(name: string): NicknameReason | null {
  const len = Array.from(name).length; // 코드포인트 기준(docs/06 §4.2)
  if (len < 2) return "TOO_SHORT";
  if (len > 12) return "TOO_LONG";
  if (!NICK_RE.test(name)) return "INVALID_CHARS";

  const content = CONTENT_FILTER.evaluateText(name);
  if (content.blocked) return content.reason === "reserved" ? "RESERVED" : "BLOCKED_WORD";
  return null;
}

async function findOwnerByNorm(db: D1Database, norm: string): Promise<string | null> {
  const row = await db.prepare(`SELECT user_id FROM users WHERE nickname_norm = ?1`).bind(norm).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * 닉네임 변경 정책 카운터(§11-D14 — 30일당 2회). canonical LIMITS 표(docs/04 §6.5) 밖의 정책값이라
 * mw/ratelimit.ts를 거치지 않고 이 라우트에서 직접 KV_KEYS.rateLimit을 쓴다(session.ts의
 * "session:new-pid" IP 어뷰징 카운터와 동일 선례 — 구현 세부 지시 3: "admin 감사 없이 KV
 * rl:nickname 정책 카운터").
 */
async function bumpNicknamePolicyCounter(kv: KVNamespace, pid: string): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / NICKNAME_POLICY_WINDOW_SEC) * NICKNAME_POLICY_WINDOW_SEC;
  const key = KV_KEYS.rateLimit("nickname-policy", pid, windowStart);
  const raw = await kv.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= NICKNAME_POLICY_MAX) return true;
  await kv.put(key, String(count + 1), { expirationTtl: NICKNAME_POLICY_WINDOW_SEC + 5 });
  return false;
}
