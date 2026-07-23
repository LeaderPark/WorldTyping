// spec: docs/06 §5.2(AE 이벤트 스키마 — blobs/doubles 고정 레이아웃), docs/00 §11-D25 + WT-M6-03
//       [완료 조건] "이벤트 레이아웃 스냅샷 — blobs/doubles 인덱스 회귀 방지"
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  sha256Hex16,
  trackClientError,
  trackDailyPlay,
  trackGameFinish,
  trackGameStart,
  trackMpMatchFinish,
  trackMpMatchStart,
  trackMpQueue,
  trackRetentionPing,
  trackShareClick,
  trackVisit,
  writeTelemetryEvent,
} from "../src/lib/telemetry";

const BASE = "http://local/api/v1";

interface Captured {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** 실제 AE writeDataPoint 인자를 그대로 캡처하는 테스트 더블. */
function fakeAe(): { AE: { writeDataPoint: (opts: unknown) => void }; captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    AE: {
      writeDataPoint(opts: unknown) {
        captured.push(opts as Captured);
      },
    },
    captured,
  };
}

describe("telemetry — blobs/doubles 고정 레이아웃(§5.2)", () => {
  it("writeTelemetryEvent: blobs[1..9]·doubles[1..8] 위치가 문서 순서와 정확히 일치한다", () => {
    const { AE, captured } = fakeAe();
    writeTelemetryEvent(
      { AE: AE as unknown as AnalyticsEngineDataset },
      "game_finish",
      {
        userIdHash: "abcd1234abcd1234",
        modeKey: "tier:3",
        lang: "ko",
        platform: "desktop",
        geo: "KR",
        verdict: "valid",
        referrerHost: "x.com",
        utmSource: "x",
        appVersion: "1.0.0",
      },
      {
        score: 100,
        pi: 200,
        cpm: 300,
        accMilli: 950,
        elapsedMs: 12345,
        countriesCleared: 10,
        skipped: 1,
        completed: true,
      },
    );

    expect(captured).toHaveLength(1);
    const row = captured[0]!;
    expect(row.indexes).toEqual(["game_finish"]);
    // blobs 위치 회귀 방지 — 순서를 바꾸면 이 테스트가 즉시 깨진다.
    expect(row.blobs).toEqual([
      "abcd1234abcd1234", // [1] userIdHash
      "tier:3", // [2] modeKey
      "ko", // [3] lang
      "desktop", // [4] platform
      "KR", // [5] geo
      "valid", // [6] verdict
      "x.com", // [7] referrerHost
      "x", // [8] utmSource
      "1.0.0", // [9] appVersion
    ]);
    expect(row.doubles).toEqual([100, 200, 300, 950, 12345, 10, 1, 1]);
  });

  it("필드 생략 시 blobs는 빈 문자열, doubles는 0으로 채워 위치를 보존한다", () => {
    const { AE, captured } = fakeAe();
    writeTelemetryEvent({ AE: AE as unknown as AnalyticsEngineDataset }, "visit", { userIdHash: "h" });
    expect(captured[0]!.blobs).toEqual(["h", "", "", "", "", "", "", "", ""]);
    expect(captured[0]!.doubles).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("AE 미바인딩이면 조용히 no-op(요청을 절대 실패시키지 않음)", () => {
    expect(() => writeTelemetryEvent({ AE: undefined as unknown as AnalyticsEngineDataset }, "visit", { userIdHash: "h" })).not.toThrow();
  });

  it("extraBlob(구현 확장 슬롯)은 10번째 위치에만 추가되고 앞 9개 위치는 그대로 유지된다", () => {
    const { AE, captured } = fakeAe();
    writeTelemetryEvent({ AE: AE as unknown as AnalyticsEngineDataset }, "retention_ping", { userIdHash: "h" }, undefined, "d1:1,d7:0,d30:0");
    expect(captured[0]!.blobs).toHaveLength(10);
    expect(captured[0]!.blobs[9]).toBe("d1:1,d7:0,d30:0");
  });

  it("sha256Hex16: 원문을 절대 그대로 싣지 않고 SHA-256 앞 16자(hex)만 반환한다", async () => {
    const h1 = await sha256Hex16("player-abc");
    const h2 = await sha256Hex16("player-abc");
    const h3 = await sha256Hex16("player-xyz");
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).toBe(h2); // 결정적
    expect(h1).not.toBe(h3);
    expect(h1).not.toContain("player-abc");
  });

  it("이벤트 헬퍼들은 각자의 index1(이벤트명)로 정확히 1행씩 쓴다", async () => {
    const { AE, captured } = fakeAe();
    const e = { AE: AE as unknown as AnalyticsEngineDataset };
    await trackVisit(e, "pid1", { geo: "KR" });
    await trackRetentionPing(e, "pid1", { d1: true, d7: false, d30: false });
    await trackGameStart(e, "pid1", { modeKey: "worldtour", lang: "ko", platform: "desktop" });
    await trackGameFinish(
      e,
      "pid1",
      { modeKey: "worldtour", lang: "ko", platform: "desktop", verdict: "valid" },
      { score: 1 },
    );
    await trackDailyPlay(e, "pid1", { modeKey: "daily:2026-07-22", lang: "ko", platform: "desktop" });
    await trackMpQueue(e, "pid1", { lang: "ko" });
    await trackMpMatchStart(e, ["pid1", "pid2"], { lang: "ko" });
    await trackMpMatchFinish(e, [{ playerId: "pid1", finished: true, cpm: 1, pi: 1, accMilli: 1, elapsedMs: 1 }], { lang: "ko" });
    trackShareClick(e, { utmSource: "x" });
    await trackClientError(e, "pid1", { message: "boom", top3Frames: "at a | at b" });

    const eventNames = captured.map((c) => c.indexes[0]);
    expect(eventNames).toEqual([
      "visit",
      "retention_ping",
      "game_start",
      "game_finish",
      "daily_play",
      "mp_queue",
      "mp_match_start",
      "mp_match_start",
      "mp_match_finish",
      "share_click",
      "client_error",
    ]);
  });
});

describe("텔레메트리 배선 — 서버 트리거 이벤트(§5.2 표)", () => {
  it("POST /session 성공 시 visit 이벤트가 AE에 1회 기록된다", async () => {
    const spy = vi.spyOn(env.AE, "writeDataPoint");
    const res = await SELF.fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    // waitUntil로 예약된 비동기 훅이 끝날 시간을 준다(테스트 환경엔 실제 워커 lifecycle이 없어
    // 짧은 매크로태스크 양보로 충분 — SELF.fetch가 이미 실제 fetch 핸들러를 완주시킨다).
    await new Promise((r) => setTimeout(r, 10));
    const visitCalls = spy.mock.calls.filter((args) => (args[0] as Captured).indexes[0] === "visit");
    expect(visitCalls.length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });

  it("POST /api/v1/t: client_error 배치가 AE에 기록되고 200 ok를 반환한다(인증 없이도 동작)", async () => {
    const spy = vi.spyOn(env.AE, "writeDataPoint");
    const res = await SELF.fetch(`${BASE}/t`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "client_error", ts: Date.now(), message: "boom", stack: "at a\nat b\nat c\nat d" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; received: number };
    expect(body).toEqual({ ok: true, received: 1 });
    const errCalls = spy.mock.calls.filter((args) => (args[0] as Captured).indexes[0] === "client_error");
    expect(errCalls).toHaveLength(1);
    // 스택은 상위 3프레임만(구현 세부 지시) — extraBlob(10번째)에 "frames:" 뒤로 최대 3개.
    const framesBlob = (errCalls[0]![0] as Captured).blobs[9]!;
    expect(framesBlob).toContain("frames:at a | at b | at c");
    expect(framesBlob).not.toContain("at d");
    spy.mockRestore();
  });

  it("POST /api/v1/t: events가 비어있거나 형식이 틀리면 400", async () => {
    const res = await SELF.fetch(`${BASE}/t`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("[WT-OPT-01] POST /api/v1/t: client_error가 여러 건이어도 pid→해시 파생(sha256)은 요청당 1회만 계산된다", async () => {
    const session = await SELF.fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: crypto.randomUUID() }),
    });
    const { token, playerId } = (await session.json()) as { token: string; playerId: string };
    // 세션 부트스트랩 자체가 waitUntil로 예약한 visit 텔레메트리(내부에서 sha256Hex16(pid)를
    // 한 번 더 호출)가 아직 처리 중일 수 있다 — 이 digest 스파이가 그 지연된 호출까지 집계하지
    // 않도록 먼저 정착시킨다(위 "POST /session..." 테스트와 동일한 매크로태스크 양보 패턴).
    await new Promise((r) => setTimeout(r, 10));

    const digestSpy = vi.spyOn(crypto.subtle, "digest");
    const res = await SELF.fetch(`${BASE}/t`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          { type: "client_error", ts: Date.now(), message: "boom1" },
          { type: "client_error", ts: Date.now(), message: "boom2" },
          { type: "client_error", ts: Date.now(), message: "boom3" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: number };
    expect(body.received).toBe(3);

    // 이 요청 안에서 SHA-256(playerId)를 입력으로 한 digest 호출만 골라낸다 — rateLimit("t")의
    // hashIp(IP 문자열)처럼 pid와 무관한 다른 digest 호출(§11-D60 범위 밖)이 같은 요청에 섞여도
    // 오탐하지 않기 위함이다. sha256Hex16(pid)는 이벤트 3건 각각이 아니라 routes/t.ts가 요청당
    // 1회 선계산해 재사용해야 하므로, pid를 해싱한 digest 호출은 정확히 1회여야 한다.
    const decoder = new TextDecoder();
    const pidDigestCalls = digestSpy.mock.calls.filter((args) => {
      const data = args[1] as BufferSource;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer);
      return decoder.decode(bytes) === playerId;
    });
    expect(pidDigestCalls).toHaveLength(1);
    digestSpy.mockRestore();
  });

  it("POST /api/v1/t: share_click 이벤트도 처리된다", async () => {
    const spy = vi.spyOn(env.AE, "writeDataPoint");
    const res = await SELF.fetch(`${BASE}/t`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ type: "share_click", ts: Date.now(), utmSource: "x" }] }),
    });
    expect(res.status).toBe(200);
    const shareCalls = spy.mock.calls.filter((args) => (args[0] as Captured).indexes[0] === "share_click");
    expect(shareCalls).toHaveLength(1);
    spy.mockRestore();
  });
});
