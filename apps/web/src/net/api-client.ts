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
// [WT-AUTH-03] 계정(Google 로그인) 세션 토큰. 게스트 세션 토큰('wt:sessiontoken')과 별개의 원시
// 키로 둔다 — 로그인해도 게스트 세션은 그대로 살아 있어야 하고(싱글/데일리 비로그인 플레이 유지,
// §11-D68-①), Authorization은 "계정 > 게스트" 우선순위로 계정 토큰이 있으면 그것을 먼저 쓴다.
const AUTH_TOKEN_KEY = 'wt:authtoken';

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

/** [WT-AUTH-03] 계정 세션 토큰 원문(원시 키 'wt:authtoken'). 없으면 null(게스트). */
export function getAuthToken(): string | null {
  return safeLocalStorage()?.getItem(AUTH_TOKEN_KEY) ?? null;
}

/** [WT-AUTH-03] 계정 세션 토큰 저장/삭제. 스토어(stores/auth)의 login/logout만 이 함수를 호출한다. */
export function setAuthToken(token: string | null): void {
  const store = safeLocalStorage();
  if (!store) return;
  if (token) store.setItem(AUTH_TOKEN_KEY, token);
  else store.removeItem(AUTH_TOKEN_KEY);
}

/** Authorization에 실을 토큰 — 계정 > 게스트 우선순위(§11-D68-①: 로그인 시 계정 신원으로 등재). */
function bearerToken(): string | null {
  return getAuthToken() ?? getSessionToken();
}

// ── LOGIN_REQUIRED 전역 시그널(§11-D68-①: 멀티 4종은 401 LOGIN_REQUIRED) ──
// net은 스토어를 직접 import하지 않는다(순수 유지) — 대신 콜백 등록 채널만 노출하고, 스토어
// (stores/auth)가 모듈 로드 시 onLoginRequired로 자기 핸들러를 건다. 401 + code==='LOGIN_REQUIRED'
// 응답을 만나면 등록된 모든 핸들러를 호출한다("로그인 필요" 모달 트리거 등).
type LoginRequiredHandler = () => void;
const loginRequiredHandlers = new Set<LoginRequiredHandler>();

/** LOGIN_REQUIRED 시그널 구독. 반환 함수로 해제. */
export function onLoginRequired(handler: LoginRequiredHandler): () => void {
  loginRequiredHandlers.add(handler);
  return () => {
    loginRequiredHandlers.delete(handler);
  };
}

function emitLoginRequired(): void {
  for (const handler of loginRequiredHandlers) {
    try {
      handler();
    } catch (err) {
      // 한 구독자의 예외가 다른 구독자/요청 흐름을 막지 않게 격리.
      console.warn('[auth] onLoginRequired handler threw:', err);
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  const token = bearerToken();
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
      if (res.status === 401 && body.error.code === 'LOGIN_REQUIRED') emitLoginRequired();
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
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
};

// ───────────────────────── 세션 부트스트랩(docs/04 §5, docs/06 §4.1) ─────────────────────────

export interface SessionInfo {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
  /** CF-IPCountry 저장값(가입 시 확정, 미확보는 "XX" — docs/00 §11-D44). */
  geo: string;
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

/** 테스트 전용: 모듈 캐시(세션 프라미스)와 저장된 토큰(게스트+계정)을 리셋한다. */
export function __resetSessionForTests(): void {
  sessionPromise = null;
  setSessionToken(null);
  setAuthToken(null);
}

// ───────────────────────── 계정 로그인(§11-D68-②, WT-AUTH-01/03) ─────────────────────────

/**
 * 계정 세션 응답(workers/api/src/routes/auth.ts issueAccountSession가 원천). SessionInfo와 동형 +
 * acct:true, 이메일은 email_verified인 경우에만. 아바타/표시이름 등 프로필은 이 응답이 아니라
 * 클라가 credential(Google ID-token JWT)을 디코드해 얻는다(gis 표준 — decode-jwt.ts).
 */
export interface AuthAccountRes {
  token: string;
  playerId: string;
  nickname: string;
  /** ISO 8601 문자열(서버). 스토어는 epoch ms로 환산해 보관한다. */
  expiresAt: string;
  geo: string;
  acct: true;
  email?: string;
}

/** POST /auth/google — Google GIS ID-token(credential) → 계정 세션 발급. */
export function authGoogle(credential: string): Promise<AuthAccountRes> {
  return apiClient.post<AuthAccountRes>('/auth/google', { credential });
}

/** POST /auth/dev — dev 전용 테스트 심(ENVIRONMENT!=='dev'면 서버가 404). GIS 미설정 DEV 폴백. */
export function authDev(body: { sub: string; name?: string; email?: string }): Promise<AuthAccountRes> {
  return apiClient.post<AuthAccountRes>('/auth/dev', body);
}

export interface SessionMeRes {
  playerId: string;
  nickname: string;
  status: string;
  /** CF-IPCountry 저장값, 미확보는 "XX"(docs/00 §11-D44). */
  geo: string;
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
  /** 이번 제출로 새로 획득한 unlock_id 목록(§9.2~9.4 — 결과 화면 토스트, WT-M5-03). */
  newUnlocks: string[];
  /** 데일리 전용 공유 텍스트(§2.3, WT-M5-04) — daily 모드가 아니면 항상 null. */
  shareText: string | null;
  /** OG 공유 랜딩 단축 id(§9.1, WT-M6-02) — 수리된 기록에만. `/r/{shareId}` 공유. rejected는 null. */
  shareId: string | null;
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

// ───────────────────────── 여권(docs/06 §4.3, WT-M5-03) ─────────────────────────

export interface PassportUnlock {
  type: 'cover' | 'stamp' | 'achievement' | 'tier';
  id: string;
  meta: unknown;
  createdAt: number;
}

export interface PassportRes {
  userId: string;
  nickname: string;
  passportCover: string;
  streakDaily: number;
  bestPi: number | null;
  unlocks: PassportUnlock[];
}

export function fetchPassport(userId: string): Promise<PassportRes> {
  return apiClient.get<PassportRes>(`/users/${encodeURIComponent(userId)}/passport`);
}

export function putPassportCover(coverId: string): Promise<{ passportCover: string }> {
  return apiClient.put<{ passportCover: string }>('/users/me/passport-cover', { coverId });
}

// ───────────────────────── 프라이버시 셀프서비스(docs/06 §6.3, WT-M6-01) ─────────────────────────

/**
 * GET /users/me/export — 서버 응답 스키마가 원천(workers/api/src/routes/me.ts)이라 클라는
 * unknown으로만 다루고 그대로 다운로드 파일로 흘려보낸다("내려받기"가 목적이지 화면 렌더링이
 * 목적이 아니다 — 필드 화이트리스트/가공 없음).
 */
export function fetchMyDataExport(): Promise<unknown> {
  return apiClient.get<unknown>('/users/me/export');
}

export interface DeleteMyAccountRes {
  ok: true;
  deletedAt: number;
  /** §6.3 "최대 10분" 고지와 동일 값(초) — 클라가 문구를 서버 응답에서 그대로 가져다 쓴다. */
  cacheMaxDelaySec: number;
}

/** DELETE /users/me — 즉시 익명화·삭제(§6.3). 로컬 정리(localStorage 전체 삭제)는 호출부
 *  (AppShell SettingsOverlay)가 성공 응답을 받은 뒤 책임진다 — 이 함수는 순수 API 왕복만. */
export function deleteMyAccount(): Promise<DeleteMyAccountRes> {
  return apiClient.delete<DeleteMyAccountRes>('/users/me');
}
