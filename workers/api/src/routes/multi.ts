// spec: docs/05 §2.3(퀵매치 REST 흐름)·§2.4(비공개/공개 방·공개 목록 KV publicroom:*)·§13-F6,
//       docs/04 §5.3(WS 티켓 — RUN_HMAC_SECRET 서명), docs/00 §11-D8(REST 퀵매치 + /ws/room/:code,
//       LobbyDO 폐기)·§11-D17(방 코드)·§11-D23(v1 race-mixed만)·§11-D38(user_id=pid) + WT-M4-02
//
// 멀티 진입 REST. 퀵매치는 Matchmaker DO('mm:{lang}:race-mixed')에 위임하고, 비공개/공개 방은
// Worker가 직접 코드 발급→MatchRoom internal/create→WS 티켓 서명한다. 어느 경로든 응답은
// { roomCode, wsUrl:'/ws/room/{code}', ticket }이며 클라는 `${wsUrl}?ticket=${ticket}`로 접속한다.
// pid는 Bearer 세션 토큰에서만 취한다(§11-D38 user_id=pid) — 바디의 playerId를 신뢰하지 않는다.
import { Hono } from "hono";
import { z } from "zod";
import { signWsTicket } from "@wt/shared";
import type { Env } from "../env";
import { ApiHttpError } from "../lib/api-error";
import { KV_KEYS } from "../lib/kv-keys";
import { claimRoomCode, normalizeRoomCode } from "../lib/room-code";
import { requireAccountAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";
import { trackMpQueue } from "../lib/telemetry";
import { logWarn } from "../lib/log";
// 방 제목 콘텐츠 필터(§11-D68-⑧). 닉네임과 동일 moderation 파이프라인을 재사용한다 — "@wt/moderation"
// 배럴(node:fs)이 아니라 하위 엔진(engine.ts)에 빌드타임 스냅샷을 주입한다(nickname.ts와 동일 패턴).
import { createFilter } from "@wt/moderation/src/engine";
import {
  MODERATION_KO_BADWORDS,
  MODERATION_EN_BADWORDS,
  MODERATION_EN_ALLOWLIST,
} from "../lib/moderation-wordlists.generated";

export const multi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/** 방 제목 콘텐츠 필터(node:fs 없는 빌드타임 스냅샷 주입 — nickname.ts/MatchRoom.ts와 동일 인스턴스 구성). */
const CONTENT_FILTER = createFilter({
  ko: MODERATION_KO_BADWORDS,
  en: MODERATION_EN_BADWORDS,
  allow: MODERATION_EN_ALLOWLIST,
});

const QUICK_MODE = "race-mixed" as const; // §11-D23
const PUBLIC_LIST_CACHE_MS = 3_000; // 3초 논리 캐시(§2.4). KV expirationTtl 최소가 60초라 값에
//                                     builtAt를 실어 읽을 때 신선도를 판정한다(TTL로 못 쓴다).
const PUBLIC_LIST_MAX = 100;

interface RoomStatus {
  phase: string;
  players: number;
  maxPlayers: number;
  roomCode: string | null;
  lang: "ko" | "en" | null;
  isPublic?: boolean;
  title?: string | null;
}

interface WsGrant {
  roomCode: string;
  wsUrl: string;
  ticket: string;
  mode: string;
  lang: "ko" | "en";
  /** §11-D68-⑧ 로비 방 제목(없으면 null). create는 요청 제목, join은 방의 저장 제목을 싣는다. */
  title: string | null;
}

// ───────────────────────── 퀵매치 (§2.3) ─────────────────────────

const QuickSchema = z.object({ lang: z.enum(["ko", "en"]) }).strict();

multi.post("/match/quick", requireAccountAuth, async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = QuickSchema.safeParse(raw);
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "lang(ko|en)이 필요합니다.");
  const mm = c.env.MATCHMAKER;
  if (!mm) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "MATCHMAKER binding not configured");

  const pid = c.get("pid");
  const { lang } = parsed.data;
  const stub = mm.get(mm.idFromName(`mm:${lang}:${QUICK_MODE}`));
  const res = await stub.fetch("http://mm/internal/quick", {
    method: "POST",
    body: JSON.stringify({ lang, playerId: pid }),
  });
  if (!res.ok) throw new ApiHttpError(503, "MATCHMAKING_FAILED", "매칭 서버 오류. 잠시 후 다시 시도해 주세요.");
  const body = await res.json();
  // mp_queue(docs/06 §5.2) — 좌석 배정 성공 시 1회. 응답을 막지 않는다.
  c.executionCtx.waitUntil(
    trackMpQueue(c.env, pid, { lang }).catch((err: unknown) => {
      logWarn("mp_queue_telemetry_failed", { message: err instanceof Error ? err.message : String(err) });
    }),
  );
  return c.json(body);
});

const CancelSchema = z.object({ ticket: z.string().min(1) }).strict();

multi.delete("/match/quick", requireAccountAuth, async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = CancelSchema.safeParse(raw);
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "ticket이 필요합니다.");
  const mm = c.env.MATCHMAKER;
  if (!mm) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "MATCHMAKER binding not configured");

  const pid = c.get("pid");
  // 티켓만으로는 어느 lang의 Matchmaker인지 알 수 없다 — 두 언어 큐 모두에 취소를 시도한다
  // (해당 좌석이 없는 쪽은 {ok:false} 반환, 부작용 없음).
  let ok = false;
  for (const lang of ["ko", "en"] as const) {
    const stub = mm.get(mm.idFromName(`mm:${lang}:${QUICK_MODE}`));
    const res = await stub.fetch("http://mm/internal/cancel", {
      method: "POST",
      body: JSON.stringify({ ticket: parsed.data.ticket, playerId: pid }),
    });
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean };
      if (body.ok) ok = true;
    }
  }
  return c.json({ ok });
});

// ───────────────────────── 비공개/공개 방 생성 (§2.4) ─────────────────────────

const CreateRoomSchema = z
  .object({
    lang: z.enum(["ko", "en"]),
    // §11-D23: v1은 race-mixed만. mode를 명시하면 race-mixed만 허용(continent/tier는 예약).
    mode: z.literal("race-mixed").optional(),
    maxPlayers: z.number().int().min(2).max(8).optional(),
    isPublic: z.boolean().optional(),
    // §11-D68-⑧ 방 제목(로비 카드 표시). 1~24자. 미지정이면 제목 없음. 콘텐츠 필터는 파싱 후 적용.
    title: z.string().min(1).max(24).optional(),
  })
  .strict();

multi.post("/rooms", requireAccountAuth, rateLimit("rooms(create)"), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = CreateRoomSchema.safeParse(raw);
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "lang(ko|en)이 필요합니다(mode는 race-mixed만).");
  const ns = c.env.MATCH_ROOM;
  if (!ns) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "MATCH_ROOM binding not configured");

  const pid = c.get("pid");
  const { lang } = parsed.data;
  const maxPlayers = parsed.data.maxPlayers ?? 8;
  const isPublic = parsed.data.isPublic ?? false;

  // §11-D68-⑧ 제목 정규화 + 콘텐츠 필터(닉네임과 동일 moderation 파이프라인). 공백만 남으면 무제목(null),
  //   비속어/예약어 포함이면 400 INVALID_TITLE(닉네임과 달리 로비 표시는 공개 채널이라 그대로 차단).
  const trimmedTitle = parsed.data.title?.trim();
  const title = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : null;
  if (title !== null && CONTENT_FILTER.evaluateText(title).blocked) {
    throw new ApiHttpError(400, "INVALID_TITLE", "방 제목에 사용할 수 없는 표현이 포함되어 있습니다.");
  }

  const roomCode = await claimRoomCode(ns).catch(() => {
    throw new ApiHttpError(500, "ROOM_CODE_EXHAUSTED", "방 코드 발급에 실패했습니다. 다시 시도해 주세요.");
  });
  const stub = ns.get(ns.idFromName("room:" + roomCode));
  const created = await stub.fetch("http://do/internal/create", {
    method: "POST",
    body: JSON.stringify({
      config: { roomCode, lang, mode: QUICK_MODE, poolParam: null, maxPlayers, isPublic, quickMatch: false, title },
    }),
  });
  if (!created.ok) throw new ApiHttpError(503, "ROOM_CREATE_FAILED", "방 생성에 실패했습니다.");

  const grant = await mintGrant(c.env.RUN_HMAC_SECRET, pid, roomCode, lang, title);
  return c.json({ ...grant, maxPlayers, isPublic });
});

// ───────────────────────── 방 참가 (코드/링크, §2.4) ─────────────────────────

const JoinSchema = z.object({ lang: z.enum(["ko", "en"]).optional() }).strict();

multi.post("/rooms/:code/join", requireAccountAuth, async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = JoinSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "lang은 ko|en이어야 합니다.");
  const ns = c.env.MATCH_ROOM;
  if (!ns) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "MATCH_ROOM binding not configured");

  const code = normalizeRoomCode(c.req.param("code"));
  if (!code) throw new ApiHttpError(404, "ROOM_NOT_FOUND", "방 코드 형식이 올바르지 않습니다.");

  const pid = c.get("pid");
  const stub = ns.get(ns.idFromName("room:" + code));
  const statusRes = await stub.fetch("http://do/internal/room-status");
  if (!statusRes.ok) throw new ApiHttpError(404, "ROOM_NOT_FOUND", "방을 찾을 수 없습니다.");
  const status = (await statusRes.json()) as RoomStatus;

  if (status.roomCode === null) throw new ApiHttpError(404, "ROOM_NOT_FOUND", "방을 찾을 수 없습니다.");
  if (parsed.data.lang && status.lang && parsed.data.lang !== status.lang) {
    throw new ApiHttpError(409, "LANG_MISMATCH", "방의 언어 설정과 일치하지 않습니다.");
  }
  if (status.phase !== "WAITING" && status.phase !== "CREATED") {
    throw new ApiHttpError(409, "ROOM_IN_PROGRESS", "이미 시작된 방입니다.");
  }
  if (status.players >= status.maxPlayers) {
    throw new ApiHttpError(409, "ROOM_FULL", "방이 가득 찼습니다.");
  }

  const lang = status.lang ?? "ko";
  const grant = await mintGrant(c.env.RUN_HMAC_SECRET, pid, code, lang, status.title ?? null);
  return c.json(grant);
});

// ───────────────────────── 공개 방 목록 (§2.4, KV publicroom:* + 3s 캐시) ─────────────────────────

/** MatchRoom.updatePublicRoom가 KV `publicroom:{code}`에 쓰는 레지스트리 엔트리 전문(§11-D68-⑧). */
interface PublicRoomEntry {
  code: string;
  lang: string;
  players: number;
  maxPlayers: number;
  title: string | null;
  isPublic: boolean;
  phase: string;
  hostCover: string | null;
}

/** 목록 응답 카드(공개 방 상세만 — 비공개는 counts로만 노출, D68-⑧). isPublic은 자명하므로 제외. */
type PublicRoomCard = Omit<PublicRoomEntry, "isPublic">;

interface PublicListRes {
  rooms: PublicRoomCard[];
  counts: { public: number; private: number };
}

multi.get("/rooms/public", async (c) => {
  const kv = c.env.KV;
  const empty: PublicListRes = { rooms: [], counts: { public: 0, private: 0 } };
  if (!kv) return c.json(empty);

  const cachedRaw = await kv.get(KV_KEYS.publicRoomsListCache);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as { builtAt: number } & PublicListRes;
      if (cached.rooms && cached.counts && Date.now() - cached.builtAt <= PUBLIC_LIST_CACHE_MS) {
        return c.json({ rooms: cached.rooms, counts: cached.counts });
      }
    } catch {
      /* 손상/구버전 캐시 무시 → 재조립 */
    }
  }

  // 레지스트리에는 공개·비공개가 모두 들어있다(D68-⑧). counts는 전량 집계하되(공개/비공개), 상세
  // 카드는 공개 방만 PUBLIC_LIST_MAX개까지 담는다(비공개는 상세 비노출 — 카운트만).
  const rooms: PublicRoomCard[] = [];
  const counts = { public: 0, private: 0 };
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix: KV_KEYS.publicRoomPrefix, cursor });
    for (const key of listed.keys) {
      const val = await kv.get(key.name);
      if (!val) continue;
      let entry: PublicRoomEntry;
      try {
        entry = JSON.parse(val) as PublicRoomEntry;
      } catch {
        continue; // 손상 항목 무시(표시용)
      }
      if (entry.isPublic) {
        counts.public += 1;
        if (rooms.length < PUBLIC_LIST_MAX) {
          rooms.push({
            code: entry.code,
            lang: entry.lang,
            players: entry.players,
            maxPlayers: entry.maxPlayers,
            title: entry.title ?? null,
            phase: entry.phase,
            hostCover: entry.hostCover ?? null,
          });
        }
      } else {
        counts.private += 1;
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  const res: PublicListRes = { rooms, counts };
  // TTL 없이 값에 builtAt를 실어 논리적 3초 캐시로 운용(KV 최소 TTL 60초 제약 회피). 다음 조립이
  // 항상 덮어써 무한 성장하지 않는다(단일 키).
  await kv.put(KV_KEYS.publicRoomsListCache, JSON.stringify({ builtAt: Date.now(), ...res }));
  return c.json(res);
});

// ───────────────────────── 내부 헬퍼 ─────────────────────────

async function mintGrant(
  secret: string,
  pid: string,
  roomCode: string,
  lang: "ko" | "en",
  title: string | null = null,
): Promise<WsGrant> {
  const ticket = await signWsTicket(secret, pid, roomCode);
  return { roomCode, wsUrl: `/ws/room/${roomCode}`, ticket, mode: QUICK_MODE, lang, title };
}
