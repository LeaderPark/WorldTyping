// spec: docs/06 §10-#5(부하 테스트), docs/00 §1.4(SLO 표), docs/04 §6.1~§6.2(runs 생명주기·검증
//       파이프라인), docs/00 §11-D53(newPidAbuseMaxPerHour 핫스왑) + WT-M6-05
//
// k6 submit.js/leaderboard.js가 소비하는 "정상 페이로드" 픽스처를 사전 발급하는 Node 준비
// 스크립트다. k6(goja 런타임)는 npm 패키지를 import할 수 없어 @wt/shared(HMAC 서명·점수 계산)를
// 테스트 실행 시점에 직접 쓸 수 없다 — 그래서 이 스크립트가 **실행 전 단계**에서 실제
// @wt/shared·@wt/data를 그대로 import해(e2e/helpers/forge.ts의 buildBaseline과 동일 원리 —
// 판정/점수 로직은 shared 밖에서 재구현하지 않는다, forge 로직 "이식") 유효한
// (세션토큰, runToken, 제출바디) 튜플을 미리 만들어 JSON으로 저장한다. k6는 그 결과만 읽어
// 순수 HTTP 부하 생성기 역할만 한다.
//
// [세션 IP 상한 우회 — 임계 완화 아님, 워밍 전용] session(10/60s/IP)·session:new-pid(20/h/IP)
// 두 상한이 수백~수천 건의 사전 발급과 정면 충돌한다. 그래서 이 스크립트는 로컬 KV에
// `config:loadtest`(WT-M6-05 신설, mw/ratelimit.ts 전체 우회)와 `config:anticheat`의
// newPidAbuseMaxPerHour를 준비 단계 동안만 올렸다가, 완료 즉시(성공/실패 무관, finally) 원래
// 상태로 되돌린다. **/runs/start·/runs/submit 자체의 물리 한계·점수 재계산 등 실제 안티치트
// 임계는 전혀 건드리지 않는다** — 오직 "정상 유저 다수가 짧은 시간에 최초 접속하는" 프로비저닝
// 병목만 우회한다(room-sim.ts가 서명을 직접 발급해 우회한 것과 동일한 성격, 다만 여기서는
// runs 테이블의 users FK 때문에 실제 POST /session을 그대로 호출해 users 행을 만든다).
//
// 사용:
//   pnpm --filter @wt/api run e2e:dev                 # 별도 터미널: 격리 wrangler dev @ 8787
//   node --import tsx tooling/ops/loadtest/gen-fixtures.ts
//   SUBMIT_COUNT=1500 CONCURRENCY=40 node --import tsx tooling/ops/loadtest/gen-fixtures.ts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tooling/은 워크스페이스 패키지가 아니다(room-sim.ts와 동일 사유) — @wt/* 런타임 해석 불가,
// 소스 상대경로로 직접 import한다(타입만 @wt/*를 쓰는 build-data.ts와 동형).
import { computeScore, requiredKeystrokes, type ScoreCountry } from "../../../packages/shared/src/index";
import { COUNTRIES } from "../../../packages/data/src/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_API_DIR = path.resolve(HERE, "../../../workers/api");
const PERSIST_DIR = process.env.WT_PERSIST_DIR ?? path.join(WORKERS_API_DIR, ".wrangler", "e2e-state");
const OUT_DIR = path.join(HERE, ".out");

const BASE = process.env.WT_BASE ?? "http://127.0.0.1:8787";
const LANG = (process.env.LANG_SIM ?? "en") as "ko" | "en";
const PLATFORM = "desktop" as const;
const CONTINENT = process.env.CONTINENT_SIM ?? "south-america"; // 12개국(§11-D3) — 대기시간 최소.
const SUBMIT_COUNT = Number(process.env.SUBMIT_COUNT ?? 1500); // submit.js 순수 처리량용(부분 클리어).
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);
const MS_PER_KEYSTROKE = 90; // forge.ts와 동일 상수 — CPM≈667(en), softCap(900) 아래 여유.

const COUNTRY_BY_ID = new Map(COUNTRIES.map((c) => [c.id, c] as const));

const log = (...a: unknown[]): void => console.log("[gen-fixtures]", ...a);

// ───────────────────────── wrangler CLI(KV) 헬퍼 — forge.ts resolveWranglerBin과 동형 ─────────────────────────

let cachedWranglerBin: string | undefined;
function resolveWranglerBin(): string {
  if (cachedWranglerBin) return cachedWranglerBin;
  const req = createRequire(path.join(WORKERS_API_DIR, "package.json"));
  const pkgJsonPath = req.resolve("wrangler/package.json");
  const pkg = req("wrangler/package.json") as { bin: { wrangler: string } };
  cachedWranglerBin = path.join(path.dirname(pkgJsonPath), pkg.bin.wrangler);
  return cachedWranglerBin;
}

function runWrangler(args: string[]): string {
  const bin = resolveWranglerBin();
  return execFileSync(process.execPath, [bin, ...args], { cwd: WORKERS_API_DIR, encoding: "utf-8" });
}

function kvGet(key: string): string | null {
  try {
    const out = runWrangler([
      "kv",
      "key",
      "get",
      key,
      "--binding",
      "KV",
      "--local",
      "--persist-to",
      PERSIST_DIR,
    ]).trim();
    // wrangler 4.x: 키가 없어도 exit 0 + stdout "Value not found"로 응답한다(예외를 던지지
    // 않음) — 이 경우를 부재로 취급하지 않으면 JSON.parse가 이 문자열에서 깨진다.
    return out === "Value not found" || out === "" ? null : out;
  } catch {
    return null; // 구버전 wrangler 등 비영(exit!=0) 경로도 방어적으로 부재 취급.
  }
}

function kvPut(key: string, value: string, ttlSec?: number): void {
  const args = ["kv", "key", "put", key, value, "--binding", "KV", "--local", "--persist-to", PERSIST_DIR];
  if (ttlSec) args.push("--ttl", String(ttlSec));
  runWrangler(args);
}

function kvDelete(key: string): void {
  try {
    runWrangler(["kv", "key", "delete", key, "--binding", "KV", "--local", "--persist-to", PERSIST_DIR, "--force"]);
  } catch {
    /* 이미 없으면 무해 */
  }
}

// ───────────────────────── 레이트리밋 임시 완화(원복 보장) ─────────────────────────

const LOADTEST_KEY = "config:loadtest";
const ANTICHEAT_KEY = "config:anticheat";

interface Restore {
  loadtestPrevRaw: string | null;
  anticheatPrevRaw: string | null;
}

function relaxForProvisioning(): Restore {
  const loadtestPrevRaw = kvGet(LOADTEST_KEY);
  const anticheatPrevRaw = kvGet(ANTICHEAT_KEY);

  kvPut(LOADTEST_KEY, String(Date.now() + 2 * 60 * 60 * 1000), 2 * 60 * 60); // 2h 세이프가드 TTL.

  // 기존 config:anticheat이 있으면 그 값을 얹어 newPidAbuseMaxPerHour만 올린다. 없으면 번들
  // DEFAULT_ANTICHEAT_CONFIG와 동일한 값(workers/api/src/lib/anticheat-config.ts 동기화 규약,
  // §11-D12)을 그대로 복제해 다른 임계값은 전혀 건드리지 않는다 — 오직 newPidAbuseMaxPerHour만.
  const base = anticheatPrevRaw
    ? (JSON.parse(anticheatPrevRaw) as Record<string, unknown>)
    : {
        minMsPerKeystroke: 35,
        cpmHardCapKo: 1100,
        cpmHardCapEn: 1000,
        cpmSoftCapKo: 950,
        cpmSoftCapEn: 900,
        rhythmCvThreshold: 0.12,
        rhythmSpreadMsThreshold: 25,
        burstMaxThreshold: 3,
        growthJumpFactor: 0.6,
        growthMinSample: 5,
        accComboCpmThreshold: 800,
        timeEnvelopeGraceMs: 3000,
        sumMsToleranceLowFactor: 0.99,
        sumMsToleranceHighFactor: 1.01,
        sumMsToleranceFlatMs: 500,
        scoreMismatchTolerance: 1,
        rejectedShadowbanThreshold: 3,
        multi: { reactionFloorMs: 250, maxKps: { ko: 14, en: 18 } },
        newPidAbuseMaxPerHour: 20,
      };
  const relaxed = { ...base, newPidAbuseMaxPerHour: 1_000_000 };
  kvPut(ANTICHEAT_KEY, JSON.stringify(relaxed));

  log("레이트리밋 완화 적용: config:loadtest 세팅 + config:anticheat.newPidAbuseMaxPerHour=1,000,000");
  return { loadtestPrevRaw, anticheatPrevRaw };
}

function restoreAfterProvisioning(r: Restore): void {
  if (r.loadtestPrevRaw === null) kvDelete(LOADTEST_KEY);
  else kvPut(LOADTEST_KEY, r.loadtestPrevRaw);

  if (r.anticheatPrevRaw === null) kvDelete(ANTICHEAT_KEY);
  else kvPut(ANTICHEAT_KEY, r.anticheatPrevRaw);

  log("원복 완료: config:loadtest / config:anticheat 이전 상태로 복구");
}

// ───────────────────────── 세션/런 프로비저닝 ─────────────────────────

interface StartRes {
  runToken: string;
  runId: string;
  serverStartTs: number;
  countryIds: string[];
  seed: string;
}

interface PerCountrySubmit {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
  inputUsed: string;
}

interface SubmitBody {
  runToken: string;
  result: {
    elapsedMs: number;
    totalKeystrokes: number;
    correctKeystrokes: number;
    maxCombo: number;
    countriesCleared: number;
    countriesSkipped: number;
    livesLost: number;
    finished: boolean;
    perCountry: PerCountrySubmit[];
  };
  clientScore: number;
  inputDigest: {
    n: number;
    mean: number;
    stdev: number;
    p10: number;
    p50: number;
    p90: number;
    burstMax: number;
  };
}

/** e2e/helpers/forge.ts buildBaseline의 이식판(HTTP fetch 기반, Playwright 비의존). */
function buildSubmitBody(started: StartRes, clearCount: number): { body: SubmitBody; runId: string } {
  const n = Math.min(clearCount, started.countryIds.length);
  const ids = started.countryIds.slice(0, n);

  const perCountry: PerCountrySubmit[] = ids.map((id) => {
    const country = COUNTRY_BY_ID.get(id);
    if (!country) throw new Error(`알 수 없는 국가 id: ${id}`);
    const L = requiredKeystrokes(country, LANG);
    return {
      code: id,
      ms: L * MS_PER_KEYSTROKE,
      keystrokes: L,
      errors: 0,
      skipped: false,
      inputUsed: LANG === "ko" ? country.nameKo : country.nameEn,
    };
  });

  const elapsedMs = perCountry.reduce((s, p) => s + p.ms, 0);
  const totalKeystrokes = perCountry.reduce((s, p) => s + p.keystrokes, 0);
  const fullCountries: ScoreCountry[] = started.countryIds.map((id) => {
    const c = COUNTRY_BY_ID.get(id);
    if (!c) throw new Error(`알 수 없는 국가 id(fullSet): ${id}`);
    return { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  });
  const clientScore = computeScore(
    {
      totalKeystrokes,
      correctKeystrokes: totalKeystrokes,
      elapsedMs,
      maxCombo: perCountry.length,
      countriesCleared: perCountry.length,
      countriesSkipped: 0,
      perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
    },
    fullCountries,
    LANG,
  ).finalScore;

  return {
    runId: started.runId,
    body: {
      runToken: started.runToken,
      result: {
        elapsedMs,
        totalKeystrokes,
        correctKeystrokes: totalKeystrokes,
        maxCombo: perCountry.length,
        countriesCleared: perCountry.length,
        countriesSkipped: 0,
        livesLost: 0,
        finished: n === started.countryIds.length,
        perCountry,
      },
      clientScore,
      inputDigest: {
        n: perCountry.length,
        mean: MS_PER_KEYSTROKE,
        stdev: MS_PER_KEYSTROKE * 0.3,
        p10: MS_PER_KEYSTROKE * 0.7,
        p50: MS_PER_KEYSTROKE,
        p90: MS_PER_KEYSTROKE * 1.3,
        burstMax: 0,
      },
    },
  };
}

interface Provisioned {
  sessionToken: string;
  body: SubmitBody;
}

async function provisionOne(clearCount: number): Promise<Provisioned | null> {
  const deviceId = randomUUID();
  // 서명은 signSessionToken으로 직접 만들 수도 있지만, runs.user_id FK가 실제 users 행을
  // 요구하므로(D1) 반드시 실 POST /session을 태워 서버가 행을 만들게 한다 — 여기서 얻는
  // 값(토큰)을 그대로 쓰는 것이지 pid를 임의로 지어내지 않는다.
  const sessRes = await fetch(`${BASE}/api/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!sessRes.ok) {
    log(`session 실패 ${sessRes.status}`);
    return null;
  }
  const { token } = (await sessRes.json()) as { token: string; playerId: string };

  const startRes = await fetch(`${BASE}/api/v1/runs/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: "continent", continent: CONTINENT, lang: LANG, platform: PLATFORM }),
  });
  if (!startRes.ok) {
    log(`runs/start 실패 ${startRes.status}`);
    return null;
  }
  const started = (await startRes.json()) as StartRes;
  const { body } = buildSubmitBody(started, clearCount);
  return { sessionToken: token, body };
}

async function provisionBatch(count: number, clearCount: number, label: string): Promise<Provisioned[]> {
  const out: Provisioned[] = [];
  let done = 0;
  while (done < count) {
    const batchSize = Math.min(CONCURRENCY, count - done);
    const results = await Promise.all(Array.from({ length: batchSize }, () => provisionOne(clearCount)));
    for (const r of results) if (r) out.push(r);
    done += batchSize;
    if (done % (CONCURRENCY * 5) < CONCURRENCY) log(`${label}: ${out.length}/${count} 프로비저닝`);
  }
  return out;
}

async function main(): Promise<void> {
  log(`target=${BASE} continent=${CONTINENT} lang=${LANG} submitCount=${SUBMIT_COUNT}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const restore = relaxForProvisioning();
  try {
    log("submit.js용 부분 클리어(2개국) 픽스처 프로비저닝 시작...");
    const submitFixtures = await provisionBatch(SUBMIT_COUNT, 2, "submit");
    log(`submit 픽스처 완료: ${submitFixtures.length}/${SUBMIT_COUNT}`);

    // [리더보드 시드 = submit.js 실행 그 자체] 별도 "완주" 제출로 미리 시딩하지 않는다 — 완주
    // 여부와 무관하게 verdict='valid'면 lb_best에 반영되므로(runs.ts doBoard 게이트, §1.3),
    // submit.js가 이 SUBMIT_COUNT건을 실제로 제출하는 순간 이 보드가 자연히 채워진다. (이전
    // 버전은 이 단계에서 별도로 "전 국가 완주" 페이로드를 즉시 제출해 시도했으나, 즉시 제출은
    // 청구 elapsedMs가 물리적으로 아직 지나지 않은 실제 시간을 초과해 §6.2-③ 시간 봉투에서
    // 전량 time_envelope로 rejected됐다 — submit.js가 몇 분 뒤에 쏘는 것과 달리 여기서는 발급
    // 직후라 유예(3000ms)를 항상 넘겼다. 완주 페이로드가 굳이 필요 없으므로 이 버그 자체를
    // 근본 제거했다.)
    const board = `continent:${CONTINENT}|${LANG}|${PLATFORM}|all`;

    fs.writeFileSync(
      path.join(OUT_DIR, "submit-fixture.json"),
      JSON.stringify(submitFixtures.map((f) => ({ token: f.sessionToken, ...f.body }))),
    );
    fs.writeFileSync(path.join(OUT_DIR, "lb-board.json"), JSON.stringify({ board }));

    log(`기록 완료: ${path.join(OUT_DIR, "submit-fixture.json")} (${submitFixtures.length}건)`);
    log(`리더보드 보드: ${board} — submit.js 실행 후 이 보드에 valid 건수만큼 등재된다`);
  } finally {
    restoreAfterProvisioning(restore);
  }
}

main().catch((err: unknown) => {
  console.error("[gen-fixtures] FATAL", err);
  process.exitCode = 1;
});
