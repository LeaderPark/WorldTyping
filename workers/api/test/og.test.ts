// spec: docs/06 §9.1(공유 랜딩 /r/:shareId + OG 이미지 /og/:shareId.png — 렌더 왕복·캐시 헤더·
//       미존재 404 셸, 렌더 실패 시 폴백), §9.4(/r/*는 frame-ancestors 미포함·게임 라우트는 'self'),
//       docs/00 §11-D46(Pretendard 서브셋 TTF)·D18(TypeTrip) + WT-M6-02 [완료 조건]
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computeScore, requiredKeystrokes, type CountryId, type ScoreCountry } from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import { renderShareCardPng } from "../src/og/render";
import { OG_COLORS } from "../src/og/layout";

const BASE = "http://local/api/v1";
const BY_ID = new Map(COUNTRIES.map((c) => [c.id, c] as const));
const HUMAN_DIGEST = { n: 15, mean: 150, stdev: 60, p10: 80, p50: 140, p90: 300, burstMax: 1 };

interface StartRes {
  runToken: string;
  countryIds: string[];
}
interface SubmitRes {
  verdict: string;
  shareId: string | null;
}
interface PerCountry {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
  inputUsed: string;
}

async function bootstrap(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  return ((await res.json()) as { token: string }).token;
}

function startRun(token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/runs/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function buildSubmit(countryIds: string[], clearCount: number, msPerKeystroke: number) {
  const cleared = countryIds.slice(0, clearCount);
  const perCountry: PerCountry[] = cleared.map((id) => {
    const c = BY_ID.get(id as CountryId)!;
    const L = requiredKeystrokes(c, "en");
    return { code: id, ms: L * msPerKeystroke, keystrokes: L, errors: 0, skipped: false, inputUsed: c.nameEn };
  });
  const totalKeystrokes = perCountry.reduce((a, p) => a + p.keystrokes, 0);
  const elapsedMs = perCountry.reduce((a, p) => a + p.ms, 0);
  const result = {
    elapsedMs,
    totalKeystrokes,
    correctKeystrokes: totalKeystrokes,
    maxCombo: clearCount,
    countriesCleared: clearCount,
    countriesSkipped: 0,
    livesLost: 0,
    finished: false,
    perCountry,
  };
  const scoreCountries: ScoreCountry[] = countryIds.map((id) => {
    const c = BY_ID.get(id as CountryId)!;
    return { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  });
  const expected = computeScore(
    {
      totalKeystrokes,
      correctKeystrokes: totalKeystrokes,
      elapsedMs,
      maxCombo: clearCount,
      countriesCleared: clearCount,
      countriesSkipped: 0,
      perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
    },
    scoreCountries,
    "en",
  );
  return { result, clientScore: expected.finalScore };
}

/** 유효 제출 왕복으로 shareId를 얻는다(worldtour·2개국 정타 = runs.test 검증된 valid 레시피). */
async function validShareId(): Promise<string> {
  const token = await bootstrap();
  const started = (await (await startRun(token, {
    mode: "worldtour",
    lang: "en",
    platform: "desktop",
  })).json()) as StartRes;
  const built = buildSubmit(started.countryIds, 2, 80);
  const res = await SELF.fetch(`${BASE}/runs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      runToken: started.runToken,
      result: built.result,
      clientScore: built.clientScore,
      inputDigest: HUMAN_DIGEST,
    }),
  });
  const body = (await res.json()) as SubmitRes;
  expect(body.verdict).toBe("valid");
  expect(body.shareId).toBeTruthy();
  return body.shareId!;
}

function isPng(buf: Uint8Array): boolean {
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe("share_id 발급 (runs/submit)", () => {
  it("수리된 기록에 8자 base58 shareId를 발급하고 shares 행을 남긴다", async () => {
    const shareId = await validShareId();
    expect(shareId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{8}$/);
    const row = await env.DB.prepare("SELECT run_id FROM shares WHERE share_id = ?1").bind(shareId).first();
    expect(row).not.toBeNull();
  });
});

describe("GET /og/:shareId.png", () => {
  it("유효 shareId → 200 PNG(1200×630 렌더), immutable 캐시 헤더", async () => {
    const shareId = await validShareId();
    const res = await SELF.fetch(`http://local/og/${shareId}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(isPng(buf)).toBe(true);
    expect(buf.byteLength).toBeGreaterThan(3000);
  });

  it("같은 shareId 재요청도 200 PNG(캐시 경로)", async () => {
    const shareId = await validShareId();
    await SELF.fetch(`http://local/og/${shareId}.png`); // 채우기
    const res = await SELF.fetch(`http://local/og/${shareId}.png`);
    expect(res.status).toBe(200);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("존재하지 않는(형식은 유효) shareId → 404 폴백 PNG(500 아님)", async () => {
    const res = await SELF.fetch(`http://local/og/zzzzzzzz.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("형식 불량 shareId → 404 폴백 PNG", async () => {
    const res = await SELF.fetch(`http://local/og/bad_id.png`);
    expect(res.status).toBe(404);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  it("/og/default.png → 200 정적 폴백 PNG(immutable)", async () => {
    const res = await SELF.fetch(`http://local/og/default.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });
});

describe("GET /r/:shareId (OG 메타 셸)", () => {
  it("유효 shareId → 200 HTML + og:image·twitter:card 메타 + CTA", async () => {
    const shareId = await validShareId();
    const res = await SELF.fetch(`http://local/r/${shareId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`/og/${shareId}.png`);
    expect(html).toContain('property="og:image"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain("TypeTrip");
  });

  it("존재하지 않는 shareId → 404 셸(TypeTrip)", async () => {
    const res = await SELF.fetch(`http://local/r/zzzzzzzz`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("TypeTrip");
  });

  it("형식 불량 shareId → 404 셸", async () => {
    const res = await SELF.fetch(`http://local/r/bad`);
    expect(res.status).toBe(404);
  });
});

describe("frame-ancestors (§9.4)", () => {
  it("/r/* 응답 CSP는 frame-ancestors를 포함하지 않는다(임베드 허용)", async () => {
    const res = await SELF.fetch(`http://local/r/zzzzzzzz`);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("frame-ancestors");
  });

  it("게임/일반 라우트 CSP는 frame-ancestors 'self'를 유지한다", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });
});

describe("renderShareCardPng 직접 렌더", () => {
  it("대륙 모드(continent:europe·크롭 경로) + 한글 닉네임 글리프를 렌더한다", async () => {
    const png = await renderShareCardPng({
      nickname: "여행자김치",
      modeKey: "continent:europe",
      lang: "ko",
      grade: "S",
      pi: 842,
      cpm: 640,
      accMilli: 987,
      elapsedMs: 73200,
      countryCodes: ["FR", "DE", "IT", "ES", "PL", "GB"],
    });
    expect(isPng(png)).toBe(true);
    expect(png.byteLength).toBeGreaterThan(3000);
  });

  it("빈 노선(centroid 부재 코드)에도 폴백 없이 카드를 렌더한다", async () => {
    const png = await renderShareCardPng({
      nickname: "Traveler",
      modeKey: "tier:3",
      lang: "en",
      grade: "B",
      pi: 300,
      cpm: 400,
      accMilli: 900,
      elapsedMs: 45000,
      countryCodes: ["__nonexistent__"],
    });
    expect(isPng(png)).toBe(true);
  });
});

describe("OG_COLORS 라이트 팔레트 (WT-UI-09, docs/00 §11-D57)", () => {
  // og/layout.ts는 Worker(satori)가 CSS 변수를 참조할 수 없어 apps/web/src/styles/tokens.css의
  // :root(라이트 기본) 리터럴을 손으로 옮겨 적는다("리터럴 동기 관례", index.html 정적 셸과 동일
  // 원칙) — WT-M6-02의 구 다크 고정 팔레트(#0b1220 등)를 D57(기본 테마 라이트 전환)에 맞춰
  // 대체했다. 이 테스트는 그 리터럴이 다시 다크로 되돌아가는 회귀를 잡는 가드다(수치 자체가
  // tokens.css를 파싱해 검증하지는 않는다 — og/layout.ts는 apps/web을 import할 수 없는 별도
  // 워크스페이스라 tooling/ci/contrast-check.ts처럼 파일을 직접 파싱하지 않고, 값을 사람이
  // 확인해 리터럴로 못 박는다).
  it("카드 배경·텍스트·강조색이 tokens.css :root 라이트 리터럴과 일치한다", () => {
    expect(OG_COLORS.bg0).toBe("#f4f5ef");
    expect(OG_COLORS.bg1).toBe("#eceee6");
    expect(OG_COLORS.panel).toBe("#ffffff");
    expect(OG_COLORS.land).toBe("#ffffff");
    expect(OG_COLORS.landStroke).toBe("#d9ddd0");
    expect(OG_COLORS.text).toBe("#171b19");
    expect(OG_COLORS.subtext).toBe("#5e645e");
    expect(OG_COLORS.route).toBe("#0a84ff");
    expect(OG_COLORS.node).toBe("#94a3b8");
    expect(OG_COLORS.nodeStart).toBe("#0a84ff");
    expect(OG_COLORS.logo).toBe("#0a84ff");
  });

  it("더 이상 WT-M6-02의 다크 고정 리터럴(#0b1220 배경/#38bdf8 강조)을 쓰지 않는다", () => {
    const values = Object.values(OG_COLORS);
    expect(values).not.toContain("#0b1220");
    expect(values).not.toContain("#111c33");
    expect(values).not.toContain("#38bdf8");
  });
});

describe("렌더 성능(로컬 workerd 정보용 — 밴드 assert 없음, D48 정신)", () => {
  it("결과 카드 10회 렌더 p95를 보고한다", async () => {
    const data = {
      nickname: "여행자김치",
      modeKey: "worldtour",
      lang: "ko" as const,
      grade: "A",
      pi: 512,
      cpm: 560,
      accMilli: 970,
      elapsedMs: 121000,
      countryCodes: ["KR", "JP", "CN", "IN", "FR", "BR", "US", "EG", "AU", "ZA"],
    };
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const png = await renderShareCardPng(data);
      times.push(Date.now() - t0);
      expect(isPng(png)).toBe(true);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!;
    // eslint-disable-next-line no-console
    console.log(`[og p95] render x10 (ms): ${times.join(", ")} → p95=${p95}ms (local workerd)`);
    expect(times.length).toBe(10);
  });
});
