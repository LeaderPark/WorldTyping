// spec: docs/06 §9.1(공유 랜딩 /r/:shareId + OG 이미지 /og/:shareId.png: shares→runs 조인 1쿼리,
//       immutable+CF 캐시, share_id당 1회 렌더, p95<350ms, 렌더 실패 시 정적 폴백·500 금지)·
//       §9.2(방 초대 /multi/:code OG SSR — 만료 시 대체 랜딩)·§9.4(/r/*는 X-Frame-Options 미적용,
//       게임 라우트는 frame-ancestors 유지 — mw/security-headers.ts), docs/00 §11-D18(노출명 TypeTrip,
//       도메인 PUBLIC_ORIGIN 추상화), WT-M6-02
//
// /r/·/og/·/multi/는 run_worker_first(wrangler.toml)라 Worker가 먼저 먹는다. 이미지는 캐시 miss
// 시에만 satori로 렌더하고 immutable + caches.default에 저장해 share_id당 1회만 렌더한다.
import { Hono } from "hono";
import type { Env } from "../env";
import type { RunGrade, RunLang } from "../db/types";
import { isValidShareId } from "../lib/share-id";
import { renderShareCardPng, type ShareCardData } from "../og/render";
import { fallbackOgPng } from "../og/fallback-og";
import { routeLabel } from "../og/layout";
import { normalizeRoomCode } from "../lib/room-code";

export const share = new Hono<{ Bindings: Env }>();

/** 렌더 결과(성공) 캐시 헤더: share_id는 불변이라 1년 immutable. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** 폴백/미존재는 짧게만 캐시(추후 발급 반영 여지) — 스크레이퍼 재요청 폭주 방지 정도. */
const SHORT_CACHE = "public, max-age=60";

interface ShareJoinRow {
  mode_key: string;
  lang: RunLang;
  grade: RunGrade;
  pi: number;
  cpm: number;
  acc_milli: number;
  elapsed_ms: number;
  detail_json: string;
  nickname: string;
}

/** shares→runs→users 조인 1쿼리(렌더 경로 D1 조회 1회 제약, docs/06 §9.1). */
function loadShare(db: D1Database, shareId: string): Promise<ShareJoinRow | null> {
  return db
    .prepare(
      `SELECT r.mode_key, r.lang, r.grade, r.pi, r.cpm, r.acc_milli, r.elapsed_ms, r.detail_json, u.nickname
       FROM shares s
       JOIN runs r ON r.run_id = s.run_id
       JOIN users u ON u.user_id = r.user_id
       WHERE s.share_id = ?1`,
    )
    .bind(shareId)
    .first<ShareJoinRow>();
}

/** detail_json에서 완주(비스킵) 국가 코드를 방문 순서로 뽑는다(노선 노드). */
function clearedCodes(detailJson: string): string[] {
  try {
    const parsed = JSON.parse(detailJson) as {
      result?: { perCountry?: Array<{ code?: unknown; skipped?: unknown }> };
    };
    const per = parsed.result?.perCountry;
    if (!Array.isArray(per)) return [];
    return per
      .filter((p) => p && typeof p.code === "string" && !p.skipped)
      .map((p) => p.code as string);
  } catch {
    return [];
  }
}

function toCardData(row: ShareJoinRow): ShareCardData {
  return {
    nickname: row.nickname,
    modeKey: row.mode_key,
    lang: row.lang,
    grade: row.grade,
    pi: row.pi,
    cpm: row.cpm,
    accMilli: row.acc_milli,
    elapsedMs: row.elapsed_ms,
    countryCodes: clearedCodes(row.detail_json),
  };
}

function pngResponse(bytes: Uint8Array, cacheControl: string, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": cacheControl,
    },
  });
}

// ───────────────────────── GET /og/:shareId.png ─────────────────────────

share.get("/og/:file", async (c) => {
  const file = c.req.param("file");
  const m = /^([A-Za-z0-9]+)\.png$/.exec(file);
  const shareId = m?.[1];
  // 방 초대·일반용 정적 기본 OG 이미지(브랜드 다크). 항상 200 + immutable.
  if (shareId === "default") return pngResponse(fallbackOgPng(), IMMUTABLE, 200);
  if (!shareId || !isValidShareId(shareId)) {
    // 형식 불량 — 폴백 이미지(스크레이퍼가 항상 이미지를 받게, 500 금지).
    return pngResponse(fallbackOgPng(), SHORT_CACHE, 404);
  }

  // CF 캐시 조회(share_id당 1회 렌더 — CPU 예산 보호). 캐시 API 부재 환경은 조용히 건너뛴다.
  const cache = (globalThis as { caches?: CacheStorage }).caches?.default;
  if (cache) {
    const hit = await cache.match(c.req.raw).catch(() => undefined);
    if (hit) return hit;
  }

  const db = c.env.DB;
  if (!db) return pngResponse(fallbackOgPng(), SHORT_CACHE, 503);

  const row = await loadShare(db, shareId);
  if (!row) return pngResponse(fallbackOgPng(), SHORT_CACHE, 404);

  let png: Uint8Array;
  try {
    png = await renderShareCardPng(toCardData(row));
  } catch (err) {
    // 렌더 실패(§9.1 500 금지) — 폴백. immutable로 캐싱하면 실패가 영구화되니 짧게만.
    console.warn("[og] render failed, serving fallback:", err);
    return pngResponse(fallbackOgPng(), SHORT_CACHE, 200);
  }

  const res = pngResponse(png, IMMUTABLE, 200);
  if (cache) {
    c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()).catch(() => undefined));
  }
  return res;
});

// ───────────────────────── GET /r/:shareId (OG 메타 셸 + CTA) ─────────────────────────

share.get("/r/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const origin = originOf(c.env, c.req.url);

  if (!isValidShareId(shareId)) return htmlResponse(notFoundShell(origin), 404);

  const db = c.env.DB;
  if (!db) return htmlResponse(notFoundShell(origin), 503);

  const row = await loadShare(db, shareId);
  if (!row) return htmlResponse(notFoundShell(origin), 404);

  return htmlResponse(landingShell(origin, shareId, row), 200);
});

// ───────────────────────── GET /multi/:code (방 초대 OG SSR) ─────────────────────────
// SPA 라우트를 보존하면서 <head>에 방 초대 OG 메타만 주입한다 — 실제 유저는 그대로 SPA가 부팅되고,
// 스크레이퍼는 주입된 메타를 읽는다. 방 상태 조회/주입 실패는 전부 원본 index.html로 폴백한다.

share.get("/multi/:code", async (c) => {
  const origin = originOf(c.env, c.req.url);
  const indexHtml = await fetchIndexHtml(c.env, c.req.url);
  const code = normalizeRoomCode(c.req.param("code"));
  if (!code) return htmlResponse(indexHtml, 200); // 코드 형식 불량 — SPA가 자체 처리

  let meta: string;
  try {
    meta = await roomInviteMeta(c.env, code, origin);
  } catch {
    meta = expiredRoomMeta(origin); // 조회 실패 → 만료 대체 메타(SPA는 그대로 부팅)
  }
  return htmlResponse(injectHead(indexHtml, meta), 200);
});

// ───────────────────────── HTML/메타 헬퍼 ─────────────────────────

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": SHORT_CACHE },
  });
}

/** PUBLIC_ORIGIN이 있으면 절대 오리진, 없으면 요청 오리진(§7 gotcha 7 — 하드코딩 금지). */
function originOf(env: Env, reqUrl: string): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, "");
  try {
    return new URL(reqUrl).origin;
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function ogMetaTags(o: {
  title: string;
  description: string;
  image: string;
  url: string;
}): string {
  const t = escapeHtml(o.title);
  const d = escapeHtml(o.description);
  const img = escapeHtml(o.image);
  const url = escapeHtml(o.url);
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="TypeTrip" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
  ].join("");
}

/** /r/ 공유 랜딩 셸 — OG 메타 + CTA(홈으로). utm은 §9.1 K-factor 측정용. */
function landingShell(origin: string, shareId: string, row: ShareJoinRow): string {
  const lang = row.lang;
  const label = routeLabel(row.mode_key, lang);
  const grade = (row.grade || "D").toUpperCase();
  const pi = Math.round(row.pi);
  const nick = row.nickname;
  const image = `${origin}/og/${shareId}.png`;
  const shareUrl = `${origin}/r/${shareId}`;
  const cta = `${origin}/?utm_source=share&utm_medium=og&utm_campaign=result`;

  const title = lang === "ko" ? `TypeTrip — ${label}` : `TypeTrip — ${label}`;
  const description =
    lang === "ko"
      ? `${nick}님이 ${label}에서 ${grade}등급 · PI ${pi} 기록! 나도 도전해 보세요.`
      : `${nick} scored grade ${grade} · PI ${pi} on ${label}. Can you beat it?`;
  const ctaText = lang === "ko" ? "나도 도전하기" : "Try it yourself";

  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` +
    `<title>${escapeHtml(title)}</title>` +
    ogMetaTags({ title, description, image, url: shareUrl }) +
    `<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;` +
    `background:#0b1220;color:#f8fafc;display:flex;min-height:100vh;align-items:center;justify-content:center;}` +
    `.wt-r{max-width:680px;padding:32px;text-align:center;}` +
    `.wt-r img{max-width:100%;height:auto;border-radius:12px;}` +
    `.wt-r a{display:inline-block;margin-top:24px;padding:14px 28px;border-radius:9999px;background:#38bdf8;` +
    `color:#0b1220;font-weight:700;text-decoration:none;}</style></head>` +
    `<body><div class="wt-r">` +
    `<img src="${escapeHtml(image)}" width="1200" height="630" alt="${escapeHtml(description)}" />` +
    `<div><a href="${escapeHtml(cta)}">${escapeHtml(ctaText)}</a></div>` +
    `</div></body></html>`
  );
}

/** 존재하지 않는 shareId 404 셸(홈 CTA만). */
function notFoundShell(origin: string): string {
  const cta = `${origin}/?utm_source=share&utm_medium=og&utm_campaign=result`;
  return (
    `<!doctype html><html lang="ko"><head><meta charset="UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` +
    `<title>TypeTrip</title>` +
    `<meta property="og:title" content="TypeTrip" />` +
    `<meta property="og:description" content="세계를 타이핑하다 · Type the world" />` +
    `<meta name="twitter:card" content="summary" />` +
    `<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;` +
    `background:#0b1220;color:#f8fafc;display:flex;min-height:100vh;align-items:center;justify-content:center;}` +
    `a{color:#38bdf8;}</style></head>` +
    `<body><div style="text-align:center;padding:32px;">` +
    `<h1>TypeTrip</h1><p>이 기록을 찾을 수 없어요 · This record was not found.</p>` +
    `<p><a href="${escapeHtml(cta)}">홈으로 · Go home</a></p>` +
    `</div></body></html>`
  );
}

// ── /multi OG SSR 헬퍼 ──

interface RoomStatus {
  phase: string;
  players: number;
  maxPlayers: number;
  roomCode: string | null;
  lang: "ko" | "en" | null;
}

async function fetchIndexHtml(env: Env, reqUrl: string): Promise<string> {
  const url = new URL(reqUrl);
  const res = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, { method: "GET" }));
  return res.text();
}

/** 방 상태를 DO에서 조회해 초대 OG 메타를 만든다. 활성 대기방이 아니면 만료 메타. */
async function roomInviteMeta(env: Env, code: string, origin: string): Promise<string> {
  const ns = env.MATCH_ROOM;
  if (!ns) return expiredRoomMeta(origin);
  const stub = ns.get(ns.idFromName("room:" + code));
  const res = await stub.fetch("http://do/internal/room-status");
  if (!res.ok) return expiredRoomMeta(origin);
  const status = (await res.json()) as RoomStatus;
  if (status.roomCode === null || (status.phase !== "WAITING" && status.phase !== "CREATED")) {
    return expiredRoomMeta(origin);
  }
  const lang = status.lang ?? "ko";
  const langLabel = lang === "ko" ? "한국어" : "English";
  const title = lang === "ko" ? "타이핑 레이스 초대" : "Typing Race Invite";
  const description =
    lang === "ko"
      ? `타이핑 레이스에 초대받았어요 — ${langLabel} · ${status.players}/${status.maxPlayers}명`
      : `You're invited to a typing race — ${langLabel} · ${status.players}/${status.maxPlayers} players`;
  return ogMetaTags({
    title,
    description,
    image: `${origin}/og/default.png`,
    url: `${origin}/multi/${code}`,
  });
}

function expiredRoomMeta(origin: string): string {
  return ogMetaTags({
    title: "TypeTrip",
    description: "레이스가 끝났어요 · 새 방 만들기 — This race has ended. Start a new room.",
    image: `${origin}/og/default.png`,
    url: `${origin}/multi`,
  });
}

/** index.html의 </head> 앞에 메타를 주입한다. </head>가 없으면 원본 그대로(안전 폴백). */
function injectHead(html: string, meta: string): string {
  const idx = html.indexOf("</head>");
  if (idx === -1) return html;
  return html.slice(0, idx) + meta + html.slice(idx);
}
