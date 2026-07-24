// spec: docs/00 §6(workers/api — 단일 Cloudflare Worker), docs/04 §1.2(토폴로지)·§2.4(Hono 골격)
//       docs/00 §7(환경/바인딩)·§11-D8(WS 경로 /ws/room/:code)·D16·D19·D25
// WT-M0-02: 정적 자산(SPA) + /api/v1/health를 서빙하는 골격만. 게임 API 라우트(M3)와
// DO 본문(M4)은 아직 채우지 않는다.

import { Hono } from "hono";
import type { Env } from "./env";
import { health } from "./routes/health";
import { session } from "./routes/session";
import { auth } from "./routes/auth";
import { config } from "./routes/config";
import { data } from "./routes/data";
import { runs } from "./routes/runs";
import { lb } from "./routes/lb";
import { daily } from "./routes/daily";
import { nickname } from "./routes/nickname";
import { report } from "./routes/report";
import { multi } from "./routes/multi";
import { users } from "./routes/users";
import { me } from "./routes/me";
import { share } from "./routes/share";
import { t } from "./routes/t";
import { verifyToken, WsTicketPayloadSchema } from "@wt/shared";
import { normalizeRoomCode } from "./lib/room-code";
import { runLbRefresher } from "./cron/lb-refresher";
import { ensureDailySeed } from "./cron/daily-seed";
import { runRetentionJob, runAbuseSurgeCheck } from "./cron/retention";
import { handleQueueBatch } from "./queue/consumer";
import { securityHeaders } from "./mw/security-headers";
import { corsMiddleware } from "./mw/cors";
import { wwwToApexRedirect } from "./mw/www-redirect";
import { apiErrorHandler } from "./lib/api-error";

// ---- 최상위 앱 ------------------------------------------------------------
const app = new Hono<{ Bindings: Env }>();

// docs/04 §2.1 ApiError 전역 통일 — 라우트/미들웨어는 ApiHttpError를 throw하고, 여기 한
// 곳에서만 응답 포맷을 조립한다(lib/api-error.ts, WT-M3-02).
app.onError(apiErrorHandler);

app.use("*", securityHeaders);
// WT-M6-06(docs/06 §10-1): www → apex 301. securityHeaders보다 안쪽에 등록해 리다이렉트 응답에도
// 보안 헤더가 그대로 실린다(securityHeaders는 next() 이후 c.res에 헤더를 세팅하므로 순서 무관하게
// 적용된다 — 안쪽 미들웨어가 next()를 호출하지 않고 바로 반환해도 c.res는 그 응답을 그대로 반영).
app.use("*", wwwToApexRedirect);
app.use("/api/*", corsMiddleware);

// /api/v1/* 라우트 마운트. 주의: Hono의 `app.route(path, subApp)`는 subApp에 등록된
// 개별 라우트만 그 경로 프리픽스를 붙여 상위 app에 "복사"한다 — subApp을 통째로 위임하는
// 게 아니므로 subApp의 notFound() 핸들러는 따라오지 않는다(Hono 4.x `hono-base.js#route`).
// 그래서 "게임 API 라우트 자체는 M3 소관"이지만 이 파일에서 /api/v1/* 미매치 404는
// 직접 등록해야 한다 — 그렇지 않으면 아래 SPA/ASSETS 폴백까지 흘러가 200이 나가버린다.
app.route("/api/v1", health);
app.route("/api/v1", session); // WT-M3-02: POST /session, GET /session/me
app.route("/api/v1", auth); // WT-AUTH-01: POST /auth/google, POST /auth/dev(dev 전용) — 404 캐치 위
app.route("/api/v1", config); // WT-M3-02: GET /config
app.route("/api/v1", data); // WT-M3-02: GET /data/countries (KV 핫스왑 서빙)
app.route("/api/v1", runs); // WT-M3-03: POST /runs/start, POST /runs/submit
app.route("/api/v1", lb); // WT-M3-04: GET /lb, GET /lb/me
app.route("/api/v1", daily); // WT-M3-05: GET /daily/today, GET /daily/me
app.route("/api/v1", nickname); // WT-M3-05: POST /nickname/check, PUT /nickname
app.route("/api/v1", report); // WT-M3-05: POST /report
app.route("/api/v1", multi); // WT-M4-02: POST /match/quick, DELETE /match/quick, POST /rooms,
//                              POST /rooms/:code/join, GET /rooms/public
app.route("/api/v1", users); // WT-M5-03: GET /users/:id/passport, PUT /users/me/passport-cover
app.route("/api/v1", me); // WT-M6-01: GET /users/me/export, DELETE /users/me (프라이버시 셀프서비스)
app.route("/api/v1", t); // WT-M6-03: POST /t — 클라 배칭 텔레메트리(client_error 등)

// /api/v1/* 중 위에서 매칭되지 않은 경로 → docs/04 §2.1 ApiError 포맷 404
// (health를 포함해 이후 마일스톤에서 추가되는 모든 /api/v1/* 라우트는 이 줄보다 위에 등록한다).
app.all("/api/*", (c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

// ── 멀티플레이 WS 업그레이드 라우팅(§11-D8: /ws/room/:code) ────────────────────────
// run_worker_first에 /ws/*가 있어 이 경로는 Worker가 먼저 먹는다. Worker가 티켓을 1차 검증
// (서명/exp/room, RUN_HMAC_SECRET)한 뒤 MatchRoom DO('room:'+code)로 원 요청을 그대로 프록시하고,
// DO가 재검증 + 1회용 소비한다(§5.3 이중 방어). 검증 실패는 WS 핸드셰이크를 4xx로 끊는다.
app.get("/ws/room/:code", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const ns = c.env.MATCH_ROOM;
  if (!ns) return c.text("MATCH_ROOM not configured", 503);
  const code = normalizeRoomCode(c.req.param("code"));
  if (!code) return c.text("invalid room code", 404);
  const ticket = new URL(c.req.url).searchParams.get("ticket");
  if (!ticket) return c.text("missing ticket", 401);
  const res = await verifyToken(ticket, c.env.RUN_HMAC_SECRET, WsTicketPayloadSchema);
  if (!res.ok || res.payload.room !== code) return c.text("invalid ticket", 401);
  const stub = ns.get(ns.idFromName("room:" + code));
  return stub.fetch(c.req.raw);
});

// OG 공유 인프라(WT-M6-02, §11-D18). run_worker_first의 /r/*·/og/*·/multi/*를 Worker가 먹는다.
//   GET /r/:shareId       → OG 메타 HTML 셸 + CTA
//   GET /og/:shareId.png  → 결과 카드 PNG(캐시 miss 시 렌더 → immutable + CF 캐시)
//   GET /multi/:code      → SPA index.html + 방 초대 OG 메타 SSR 주입(만료 시 대체 메타)
app.route("/", share);

// wrangler `assets.run_worker_first`에 없는 경로(SPA 라우트 등)는 Cloudflare가 정적 자산
// 핸들러로 먼저 보내므로(not_found_handling=single-page-application) 아래 라인엔 도달하지
// 않는다. run_worker_first 안(/ws/*, /r/*, /og/*, /multi/*)의 미매치 경로(예: POST /multi/:code,
// share가 처리하지 않는 /multi/* 하위)는 SPA로 폴백한다.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Queue consumer(EVENTS: AE 적재/신고/고스트 저장, §11-D16). v1은 report만 처리(WT-M3-05) —
  // 본문은 queue/consumer.ts, AE 적재·고스트 저장은 후속 마일스톤에서 같은 컨슈머에 타입만 추가.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  // Cron dispatcher. event.cron으로 잡을 라우팅한다(wrangler.toml [triggers].crons).
  //   "0 15 * * *"   → 데일리 시드 발행(WT-M3-05, 이 태스크에서 구현. 티어 시드는 /runs/start가
  //                     요청 시점에 파생하므로 별도 cron 불필요 — set-builder.ts tierSeedHex 참조)
  //   "*/1 * * * *"  → lb-refresher(WT-M3-04)
  //   "*/5 * * * *"  → 부정 급증 자체 체크(WT-M6-04, docs/06 §8.2 — flagged+rejected>5% → Slack)
  //   "30 16 * * *"  → 보존 정리 + kpi_daily 스냅샷(WT-M6-03) + 주간 D1 리포트(WT-M6-04, 월요일만)
  // 미구현 잡을 throw로 두면 그 크론이 매분/매일 에러 로그를 남기므로, 알 수 없는 cron은
  // 조용히 무시한다(구현되는 시점에 case를 추가).
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "0 15 * * *":
        await ensureDailySeed(env, event.scheduledTime);
        return;
      case "*/1 * * * *":
        // scheduled 핸들러는 반환 Promise가 곧 잡 수명 — await로 완주를 보장한다(waitUntil은
        // fetch용이고, --test-scheduled에선 invocation이 먼저 끝나 취소될 수 있다).
        await runLbRefresher(env, event.scheduledTime);
        return;
      case "*/5 * * * *":
        await runAbuseSurgeCheck(env, event.scheduledTime);
        return;
      case "30 16 * * *":
        // 보존 정리 + kpi_daily 스냅샷(WT-M6-03, cron/retention.ts) — 위 case 주석의 "no-op"은
        // 이 태스크 구현 전 상태였다.
        await runRetentionJob(env, event.scheduledTime);
        return;
      default:
        return;
    }
  },
};

// DO 클래스 export (wrangler.toml의 durable_objects 바인딩이 클래스 존재를 요구).
// 본문은 WT-M4-01(MatchRoom)/WT-M4-02(Matchmaker) 소관 — 지금은 빈 스텁.
export { MatchRoomDO } from "./do/MatchRoom";
export { MatchmakerDO } from "./do/Matchmaker";
