// spec: docs/04 §2.1(공통 규약 — ApiError 포맷/베이스 경로)·§5(세션 모델), docs/06 §1.4(조회 계약)·
//       §2.1/§2.3(데일리)·§3.1(runToken 생명주기)·§4.2(닉네임), docs/00 §11-D18(도메인은
//       PUBLIC_ORIGIN 변수, 오리진 하드코딩 금지)·§11-D38(user_id=pid), WT-M2-05·WT-M3-06
//
// fetch 래퍼 + ApiError 파싱(WT-M2-05 그대로) + 세션 부트스트랩(Authorization 자동 첨부) +
// runs/lb/daily/nickname 타입드 엔드포인트(WT-M3-06). 동일 오리진 설계라 base는 상대 경로
// "/api/v1"로 고정 — 오리진은 항상 현재 페이지 오리진을 그대로 쓴다(하드코딩 금지 원칙).
//
// [세션 토큰 저장] localStorage 'wt:sessiontoken'에 원문 wt1 토큰을 그대로 둔다(HttpOnly 쿠키가
// 아닌 이유: 동일 오리진 SPA + Bearer 헤더 설계, docs/04 §2.1). ensureSession()은 단일 in-flight
// 프라미스로 중복 부팅 호출을 막고, 실패(오프라인) 시 다음 호출에서 재시도할 수 있게 캐시를
// 비운다 — 부팅 시 실패해도 앱은 계속 뜬다(countries.json 로드만 치명적, bootLoader.ts 참조).
import type { Continent, DifficultyTier, GameMode } from '@wt/shared';

const API_BASE = '/api/v1';
const SESSION_TOKEN_KEY = 'wt:sessiontoken';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSec?: number;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object'
  );
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 사생활 모드 등 접근 자체가 throw하는 환경(stores/settings.ts와 동일 방어)
  }
}

export function getSessionToken(): string | null {
  return safeLocalStorage()?.getItem(SESSION_TOKEN_KEY) ?? null;
}

function setSessionToken(token: string | null): void {
  const store = safeLocalStorage();
  if (!store) return;
  if (token) store.setItem(SESSION_TOKEN_KEY, token);
  else store.removeItem(SESSION_TOKEN_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  const token = getSessionToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 서버가 JSON이 아닌 에러 바디를 준 경우(프록시 502 HTML 등) — 상태 텍스트로 폴백.
    }
    if (isApiErrorBody(body)) {
      throw new ApiError(res.status, body.error.code, body.error.message, body.error.retryAfterSec);
    }
    throw new ApiError(res.status, 'UNKNOWN', res.statusText || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiClient = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
};

// ───────────────────────── 세션 부트스트랩(docs/04 §5, docs/06 §4.1) ─────────────────────────

export interface SessionInfo {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
}

let sessionPromise: Promise<SessionInfo | null> | null = null;

/**
 * POST /session 부트스트랩. 성공하면 결과를 캐시(모듈 수명 동안 재호출 no-op), 실패(오프라인
 * 등)하면 캐시를 비워 다음 호출(예: 'online' 복귀)에서 재시도 가능하게 한다. deviceId는
 * settings 스토어의 guestId(§4.5 불변식과 무관 — 저빈도 1회 값)를 그대로 쓴다.
 */
export function ensureSession(deviceId: string): Promise<SessionInfo | null> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const prevToken = getSessionToken();
      const res = await apiClient.post<SessionInfo>(
        '/session',
        prevToken ? { deviceId, prevToken } : { deviceId },
      );
      setSessionToken(res.token);
      return res;
    } catch (err) {
      console.warn('[session] bootstrap failed (오프라인일 수 있음):', err);
      sessionPromise = null; // 다음 호출에서 재시도 허용
      return null;
    }
  })();
  return sessionPromise;
}

/** 테스트 전용: 모듈 캐시(세션 프라미스)를 리셋한다. */
export function __resetSessionForTests(): void {
  sessionPromise = null;
  setSessionToken(null);
}

export interface SessionMeRes {
  playerId: string;
  nickname: string;
  status: string;
}

/** GET /session/me — 현재 세션 pid 자기 조회(RankPage의 "내 행" 하이라이트 판정용). */
export function fetchSessionMe(): Promise<SessionMeRes> {
  return apiClient.get<SessionMeRes>('/session/me');
}

// ───────────────────────── board_key(docs/06 §1.1) ─────────────────────────

export type LbPeriod = 'all' | `d:${string}` | `w:${string}` | `s:${string}`;

/** 이 판의 modeKey(§1.1). continent/tier는 trackId(대륙명/티어번호)로부터 조립한다. */
export function modeKeyFor(mode: GameMode, trackId: string): string {
  switch (mode) {
    case 'continent':
      return `continent:${trackId}`;
    case 'tier':
      return `tier:${trackId}`;
    case 'worldtour':
      return 'worldtour';
    case 'daily':
      return `daily:${trackId}`;
    case 'race':
      return 'multi';
  }
}

export function buildBoardKey(modeKey: string, lang: 'ko' | 'en', platform: 'desktop' | 'mobile', period: LbPeriod): string {
  return `${modeKey}|${lang}|${platform}|${period}`;
}

// ───────────────────────── runs/start·submit(docs/06 §3.1·§3.2) ─────────────────────────

export interface RunStartReq {
  mode: 'continent' | 'tier' | 'worldtour' | 'daily';
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  continent?: Continent;
  tier?: DifficultyTier;
}

export interface RunStartRes {
  runToken: string;
  runId: string;
  serverStartTs: number;
  countryIds: string[];
  seed: string;
}

export function startRun(body: RunStartReq): Promise<RunStartRes> {
  return apiClient.post<RunStartRes>('/runs/start', body);
}

export interface PerCountrySubmit {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
  inputUsed: string;
}

export interface RunResultSubmit {
  elapsedMs: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  maxCombo: number;
  countriesCleared: number;
  countriesSkipped: number;
  livesLost: number;
  finished: boolean;
  perCountry: PerCountrySubmit[];
}

export interface InputDigestSubmit {
  n: number;
  mean: number;
  stdev: number;
  p10: number;
  p50: number;
  p90: number;
  burstMax: number;
}

export interface RunSubmitReq {
  runToken: string;
  result: RunResultSubmit;
  clientScore: number;
  inputDigest: InputDigestSubmit;
  nickname?: string;
}

export type RunVerdict = 'valid' | 'practice' | 'flagged' | 'rejected';

export interface RunSubmitRes {
  verdict: RunVerdict;
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

export function submitRun(body: RunSubmitReq): Promise<RunSubmitRes> {
  return apiClient.post<RunSubmitRes>('/runs/submit', body);
}

// ───────────────────────── daily(docs/06 §2) ─────────────────────────

export interface DailyTodayRes {
  dailyNo: number;
  dateKst: string;
  seed: string;
  countryIds: string[];
}

export function fetchDailyToday(): Promise<DailyTodayRes> {
  return apiClient.get<DailyTodayRes>('/daily/today');
}

export interface DailyMeRes {
  dateKst: string;
  alreadyPlayed: boolean;
  streakDaily: number;
}

export function fetchDailyMe(): Promise<DailyMeRes> {
  return apiClient.get<DailyMeRes>('/daily/me');
}

// ───────────────────────── 리더보드(docs/06 §1.4) ─────────────────────────

export interface LbEntry {
  rank: number;
  userId: string;
  nickname: string;
  passportCover: string;
  score: number;
  elapsedMs: number;
  accMilli: number;
  achievedAt: number;
}

export interface LbPageRes {
  entries: LbEntry[];
  nextCursor: string | null;
  total: number;
}

export function fetchLbPage(board: string, opts: { cursor?: string; geo?: string } = {}): Promise<LbPageRes> {
  const q = new URLSearchParams({ board });
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.geo) q.set('geo', opts.geo);
  return apiClient.get<LbPageRes>(`/lb?${q.toString()}`);
}

export interface LbMeRes {
  rank: number | null;
  total: number;
  percentile: number | null;
  onBoard: boolean;
}

export function fetchLbMe(board: string, opts: { geo?: string; fresh?: boolean } = {}): Promise<LbMeRes> {
  const q = new URLSearchParams({ board });
  if (opts.geo) q.set('geo', opts.geo);
  if (opts.fresh) q.set('fresh', '1');
  return apiClient.get<LbMeRes>(`/lb/me?${q.toString()}`);
}

// ───────────────────────── 닉네임(docs/06 §4.2) ─────────────────────────

export type NicknameReason = 'TAKEN' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_CHARS' | 'BLOCKED_WORD' | 'RESERVED';

export interface NicknameCheckRes {
  ok: boolean;
  reason?: NicknameReason;
}

export function checkNickname(nickname: string): Promise<NicknameCheckRes> {
  return apiClient.post<NicknameCheckRes>('/nickname/check', { nickname });
}

export function putNickname(nickname: string): Promise<{ nickname: string }> {
  return apiClient.put<{ nickname: string }>('/nickname', { nickname });
}
