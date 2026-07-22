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
import { requireAuth, type AuthVariables } from "../mw/auth";
import { rateLimit } from "../mw/ratelimit";

export const multi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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
}

interface WsGrant {
  roomCode: string;
  wsUrl: string;
  ticket: string;
  mode: string;
  lang: "ko" | "en";
}

// ───────────────────────── 퀵매치 (§2.3) ─────────────────────────

const QuickSchema = z.object({ lang: z.enum(["ko", "en"]) }).strict();

multi.post("/match/quick", requireAuth, async (c) => {
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
  return c.json(await res.json());
});

const CancelSchema = z.object({ ticket: z.string().min(1) }).strict();

multi.delete("/match/quick", requireAuth, async (c) => {
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
  })
  .strict();

multi.post("/rooms", requireAuth, rateLimit("rooms(create)"), async (c) => {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = CreateRoomSchema.safeParse(raw);
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "lang(ko|en)이 필요합니다(mode는 race-mixed만).");
  const ns = c.env.MATCH_ROOM;
  if (!ns) throw new ApiHttpError(503, "SERVICE_UNAVAILABLE", "MATCH_ROOM binding not configured");

  const pid = c.get("pid");
  const { lang } = parsed.data;
  const maxPlayers = parsed.data.maxPlayers ?? 8;
  const isPublic = parsed.data.isPublic ?? false;

  const roomCode = await claimRoomCode(ns).catch(() => {
    throw new ApiHttpError(500, "ROOM_CODE_EXHAUSTED", "방 코드 발급에 실패했습니다. 다시 시도해 주세요.");
  });
  const stub = ns.get(ns.idFromName("room:" + roomCode));
  const created = await stub.fetch("http://do/internal/create", {
    method: "POST",
    body: JSON.stringify({
      config: { roomCode, lang, mode: QUICK_MODE, poolParam: null, maxPlayers, isPublic, quickMatch: false },
    }),
  });
  if (!created.ok) throw new ApiHttpError(503, "ROOM_CREATE_FAILED", "방 생성에 실패했습니다.");

  const grant = await mintGrant(c.env.RUN_HMAC_SECRET, pid, roomCode, lang);
  return c.json({ ...grant, maxPlayers, isPublic });
});

// ───────────────────────── 방 참가 (코드/링크, §2.4) ─────────────────────────

const JoinSchema = z.object({ lang: z.enum(["ko", "en"]).optional() }).strict();

multi.post("/rooms/:code/join", requireAuth, async (c) => {
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
  const grant = await mintGrant(c.env.RUN_HMAC_SECRET, pid, code, lang);
  return c.json(grant);
});

// ───────────────────────── 공개 방 목록 (§2.4, KV publicroom:* + 3s 캐시) ─────────────────────────

interface PublicRoomEntry {
  code: string;
  lang: string;
  players: number;
  maxPlayers: number;
}

multi.get("/rooms/public", async (c) => {
  const kv = c.env.KV;
  if (!kv) return c.json({ rooms: [] as PublicRoomEntry[] });

  const cachedRaw = await kv.get(KV_KEYS.publicRoomsListCache);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as { builtAt: number; rooms: PublicRoomEntry[] };
      if (Date.now() - cached.builtAt <= PUBLIC_LIST_CACHE_MS) return c.json({ rooms: cached.rooms });
    } catch {
      /* 손상 캐시 무시 → 재조립 */
    }
  }

  const rooms: PublicRoomEntry[] = [];
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix: KV_KEYS.publicRoomPrefix, cursor });
    for (const key of listed.keys) {
      if (rooms.length >= PUBLIC_LIST_MAX) break;
      const val = await kv.get(key.name);
      if (!val) continue;
      try {
        rooms.push(JSON.parse(val) as PublicRoomEntry);
      } catch {
        /* 손상 항목 무시(표시용) */
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor && rooms.length < PUBLIC_LIST_MAX);

  // TTL 없이 값에 builtAt를 실어 논리적 3초 캐시로 운용(KV 최소 TTL 60초 제약 회피). 다음 조립이
  // 항상 덮어써 무한 성장하지 않는다(단일 키).
  await kv.put(KV_KEYS.publicRoomsListCache, JSON.stringify({ builtAt: Date.now(), rooms }));
  return c.json({ rooms });
});

// ───────────────────────── 내부 헬퍼 ─────────────────────────

async function mintGrant(
  secret: string,
  pid: string,
  roomCode: string,
  lang: "ko" | "en",
): Promise<WsGrant> {
  const ticket = await signWsTicket(secret, pid, roomCode);
  return { roomCode, wsUrl: `/ws/room/${roomCode}`, ticket, mode: QUICK_MODE, lang };
}
