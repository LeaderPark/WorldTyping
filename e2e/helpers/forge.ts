// spec: docs/06 §3.1(제출 생명주기·rejected=HTTP200)·§3.2(재계산)·§3.4(inputDigest)·§3.5(섀도우밴),
//       docs/04 §6.2(검증 파이프라인 10단계 — 실패 사유 카탈로그), docs/00 §11-D38(user_id=pid),
//       WT-M3-07.
//
// 치트 6종 E2E(cheat-suite.spec.ts)가 쓰는 "정상 제출 시뮬레이터 + 변조 유틸". 서버가 재계산에
// 쓰는 것과 동일한 @wt/shared(country-matcher·scoring)·@wt/data(COUNTRIES)를 그대로 import해
// "물리적으로 타당한" 베이스라인을 만든다 — 판정 로직을 여기서 재구현하지 않는다(CLAUDE.md 금지).
//
// [시간 봉투 주의] docs/04 §6.2-③: `result.elapsedMs ≤ serverElapsed(=now−token.startTs) + 3000`.
// 이 검사는 청구 시간이 실제 벽시계 경과보다 클 수 없다는 뜻이라, 베이스라인 제출은 반드시
// "elapsedMs만큼 실제로 기다린 뒤" submit해야 valid가 나온다(그렇지 않으면 전부 time_envelope로
// reject되어 버려 의도한 실패 사유를 관측할 수 없다). submitRun()이 이 대기를 전담한다.
//
// [세트 부분 제출] docs/04 §6.2-④는 perCountry가 fullSet의 prefix이기만 하면 통과한다(중도
// 이탈 허용) — 그래서 베이스라인은 fullSet 전체가 아니라 앞 N개국만 채워 대기시간을 최소화한다.
import type { APIRequestContext } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { COUNTRIES } from '@wt/data';
import { computeScore, requiredKeystrokes, type ScoreCountry, type RunStats } from '@wt/shared';
import { reserveSessionSlot } from './session-budget';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_API_DIR = path.resolve(HERE, '../../workers/api');
// WT-M3-08: webServer(workers/api/scripts/e2e-dev-server.mjs)가 기동한 wrangler dev와 동일한
// 전용 persist 디렉터리를 가리켜야 한다 — 그렇지 않으면 이 조회가 개발자의 기본 .wrangler/state
// (분리 유지 대상, 밀폐화 스크립트가 건드리지 않음)를 보게 되어 항상 빈 결과가 나온다.
const E2E_PERSIST_DIR = path.join(WORKERS_API_DIR, '.wrangler', 'e2e-state');

const COUNTRY_BY_ID = new Map(COUNTRIES.map((c) => [c.id, c]));

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ───────────────────────── 세션/토큰 ─────────────────────────

export interface ForgedSession {
  token: string;
  playerId: string;
}

/** 매 시나리오 독립 계정(신규 deviceId) — 섀도우밴 등 계정 상태 오염이 시나리오 간 번지지 않게 한다. */
export async function bootstrapSession(request: APIRequestContext): Promise<ForgedSession> {
  // WT-M3-08 후속: 스위트 전체의 세션 부트스트랩 총량이 서버 레이트리밋(session: 10회/60초/IP)을
  // 넘지 않도록 자기 페이싱한다(session-budget.ts 주석 참조).
  await reserveSessionSlot();
  const res = await request.post('/api/v1/session', { data: { deviceId: randomUUID() } });
  if (!res.ok()) {
    throw new Error(`bootstrapSession 실패: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; playerId: string };
  return { token: body.token, playerId: body.playerId };
}

export interface StartedRun {
  runToken: string;
  runId: string;
  serverStartTs: number;
  countryIds: string[];
  seed: string;
}

export type SingleModeInput =
  | { mode: 'continent'; continent: string }
  | { mode: 'worldtour' }
  | { mode: 'tier'; tier: 1 | 2 | 3 | 4 | 5 };

/** POST /runs/start — 세트 확정 + 서명 runToken 발급(docs/04 §6.1). */
export async function startRun(
  request: APIRequestContext,
  session: ForgedSession,
  input: SingleModeInput,
  lang: 'ko' | 'en' = 'en',
  platform: 'desktop' | 'mobile' = 'desktop',
): Promise<StartedRun> {
  const res = await request.post('/api/v1/runs/start', {
    headers: { authorization: `Bearer ${session.token}` },
    data: { ...input, lang, platform },
  });
  if (!res.ok()) {
    throw new Error(`startRun 실패: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as StartedRun;
}

// ───────────────────────── 베이스라인(정상 제출 시뮬레이터) ─────────────────────────

export interface PerCountrySubmit {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
  inputUsed: string;
}

export interface SubmitBody {
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

export interface Baseline {
  body: SubmitBody;
  /** 이 베이스라인 청구치가 유효하려면 /runs/start 응답 수신 후 최소 이만큼 실제로 기다려야 한다. */
  waitMs: number;
}

/**
 * "물리적으로 타당한" 베이스라인 제출 페이로드를 만든다. fullSet(started.countryIds)의 앞
 * `countCleared`개국만 채운다(중도 이탈 허용 — 대기시간 최소화). ms = L_i × msPerKeystroke로
 * docs/06 §3.3 물리 한계(minMsPerKeystroke=35)·CPM 소프트캡(ko950/en900)을 여유 있게 통과하고,
 * inputDigest는 stdev/mean·p90-p10을 봇 임계 이상으로 벌려 rhythm_uniform 오탐을 피한다.
 */
export function buildBaseline(
  started: StartedRun,
  lang: 'ko' | 'en',
  opts: { countCleared?: number; msPerKeystroke?: number } = {},
): Baseline {
  const msPerKeystroke = opts.msPerKeystroke ?? 90; // CPM ≈ 667(en) — softCap(900) 아래 여유
  const n = opts.countCleared ?? Math.min(2, started.countryIds.length);
  const ids = started.countryIds.slice(0, n);

  const perCountry: PerCountrySubmit[] = ids.map((id) => {
    const country = COUNTRY_BY_ID.get(id);
    if (!country) throw new Error(`buildBaseline: 알 수 없는 국가 id ${id}`);
    const L = requiredKeystrokes(country, lang);
    return {
      code: id,
      ms: L * msPerKeystroke,
      keystrokes: L,
      errors: 0,
      skipped: false,
      inputUsed: lang === 'ko' ? country.nameKo : country.nameEn,
    };
  });

  const elapsedMs = perCountry.reduce((sum, p) => sum + p.ms, 0);
  const totalKeystrokes = perCountry.reduce((sum, p) => sum + p.keystrokes, 0);

  const stats: RunStats = {
    totalKeystrokes,
    correctKeystrokes: totalKeystrokes, // errors=0
    elapsedMs,
    maxCombo: perCountry.length,
    countriesCleared: perCountry.length,
    countriesSkipped: 0,
    perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
  };
  const fullCountries: ScoreCountry[] = started.countryIds.map((id) => {
    const c = COUNTRY_BY_ID.get(id);
    if (!c) throw new Error(`buildBaseline: fullSet에 알 수 없는 국가 id ${id}`);
    return { nameKo: c.nameKo, nameEn: c.nameEn, difficultyTier: c.difficultyTier };
  });
  const clientScore = computeScore(stats, fullCountries, lang).finalScore;

  return {
    waitMs: elapsedMs,
    body: {
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
      // stdev/mean=0.3(임계 0.12 상회) · p90-p10=0.6×mean(임계 25ms 상회) · burstMax=0(임계 3 이하).
      inputDigest: {
        n: perCountry.length,
        mean: msPerKeystroke,
        stdev: msPerKeystroke * 0.3,
        p10: msPerKeystroke * 0.7,
        p50: msPerKeystroke,
        p90: msPerKeystroke * 1.3,
        burstMax: 0,
      },
    },
  };
}

// ───────────────────────── 제출 ─────────────────────────

export interface SubmitResponseBody {
  verdict: 'valid' | 'practice' | 'flagged' | 'rejected';
  score: number;
  pi: number;
  cpm: number;
  accMilli: number;
  grade: string;
  completed: boolean;
  rank: number | null;
  total: number | null;
  isPersonalBest: boolean | null;
}

/**
 * POST /runs/submit. `waitMs`만큼(베이스라인의 elapsedMs 청구치 기준) 실제로 대기한 뒤 제출한다
 * — 그렇지 않으면 시간 봉투(§6.2-③)에서 전부 time_envelope로 튕겨 나가 의도한 실패 사유를
 * 관측할 수 없다(파일 상단 주석 참조). 변조 시나리오는 body를 미리 한 요소만 바꿔 전달한다.
 */
export async function submitRun(
  request: APIRequestContext,
  session: ForgedSession,
  started: StartedRun,
  body: SubmitBody,
  waitMs: number,
): Promise<{ status: number; json: SubmitResponseBody }> {
  await sleep(waitMs + 300); // +300ms 네트워크/스케줄링 여유
  const res = await request.post('/api/v1/runs/submit', {
    headers: { authorization: `Bearer ${session.token}` },
    data: { runToken: started.runToken, ...body },
  });
  return { status: res.status(), json: (await res.json()) as SubmitResponseBody };
}

// ───────────────────────── D1 직접 조회(검증 전용) ─────────────────────────
//
// docs/06 §3.1: "verdict_reason은 응답에는 노출하지 않는다"(어뷰저에게 탐지 신호를 주지 않기
// 위한 의도적 설계 — runs.ts 주석 동일). 따라서 어떤 실패 사유였는지는 HTTP 응답만으로는
// 검증할 수 없고, 로컬 wrangler dev가 쓰는 D1(SQLite) 파일을 직접 조회해야 한다. 서버 코드를
// 수정하지 않고(작업 지시 금지 사항) 이 목적을 달성하는 유일한 경로 — wrangler CLI(devDependency,
// workers/api에 이미 설치됨)를 자식 프로세스로 실행한다. 신규 의존성 추가 없음.
export interface RunRow {
  verdict: string;
  verdict_reason: string | null;
}

let cachedWranglerBin: string | undefined;

function resolveWranglerBin(): string {
  if (cachedWranglerBin) return cachedWranglerBin;
  // workers/api 디렉터리 관점에서 require를 만들어야 그 패키지의 devDependency(wrangler)를
  // 찾는다(e2e 패키지에는 wrangler가 없다 — 새 의존성 추가 회피).
  const req = createRequire(path.join(WORKERS_API_DIR, 'package.json'));
  const pkgJsonPath = req.resolve('wrangler/package.json');
  const pkg = req('wrangler/package.json') as { bin: { wrangler: string } };
  cachedWranglerBin = path.join(path.dirname(pkgJsonPath), pkg.bin.wrangler);
  return cachedWranglerBin;
}

/** run_id는 서버가 발급한 UUIDv7이라 안전하게 SQL 리터럴에 임베드할 수 있다(영숫자+하이픈만). */
function assertSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
    throw new Error(`assertSafeRunId: 예기치 않은 run_id 형식 — SQL 임베드 거부: ${runId}`);
  }
}

/** `runs` 테이블의 verdict/verdict_reason을 로컬 D1(SQLite, --local)에서 직접 조회한다. */
export function queryRunRow(runId: string): RunRow | undefined {
  assertSafeRunId(runId);
  const bin = resolveWranglerBin();
  const sql = `SELECT verdict, verdict_reason FROM runs WHERE run_id='${runId}'`;
  const out = execFileSync(
    process.execPath,
    [bin, 'd1', 'execute', 'wt-main-dev', '--local', '--persist-to', E2E_PERSIST_DIR, '--json', '--command', sql],
    { cwd: WORKERS_API_DIR, encoding: 'utf-8' },
  );
  const parsed = JSON.parse(out) as Array<{ results: RunRow[] }>;
  return parsed[0]?.results?.[0];
}

/** users.status를 직접 조회한다(섀도우밴 시나리오 검증용). */
export function queryUserStatus(playerId: string): string | undefined {
  assertSafeRunId(playerId); // pid도 base58(영숫자)라 동일 안전 검사 재사용.
  const bin = resolveWranglerBin();
  const sql = `SELECT status FROM users WHERE user_id='${playerId}'`;
  const out = execFileSync(
    process.execPath,
    [bin, 'd1', 'execute', 'wt-main-dev', '--local', '--persist-to', E2E_PERSIST_DIR, '--json', '--command', sql],
    { cwd: WORKERS_API_DIR, encoding: 'utf-8' },
  );
  const parsed = JSON.parse(out) as Array<{ results: Array<{ status: string }> }>;
  return parsed[0]?.results?.[0]?.status;
}
