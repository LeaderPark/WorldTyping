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
// [§11-D86] 리터럴 중복 방지용 export(값 불변) — stores/auth의 크로스탭 storage 리스너가 이 키
// 문자열을 공유해야 한다. SESSION_TOKEN_KEY는 비공개 유지.
export const AUTH_TOKEN_STORAGE_KEY = 'wt:authtoken';

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
  return safeLocalStorage()?.getItem(AUTH_TOKEN_STORAGE_KEY) ?? null;
}

/** [WT-AUTH-03 → §11-D86 F4] 계정 세션 토큰 저장/삭제. 스토어(stores/auth)의 login/logout만 이 함수를
 *  호출한다. 저장(token!==null)은 setItem 후 read-back 검증까지 성공해야 true — 실패(사생활 모드 접근
 *  차단, 쿼터 초과, 조용한 무시)를 명확한 신호로 승격해 login()이 로그인 성립을 거부할 수 있게 한다.
 *  삭제(null)는 best-effort true(로그아웃을 저장소 오류가 막으면 안 된다). */
export function setAuthToken(token: string | null): boolean {
  const store = safeLocalStorage();
  if (!store) return token === null;
  try {
    if (token !== null) {
      store.setItem(AUTH_TOKEN_STORAGE_KEY, token);
      return store.getItem(AUTH_TOKEN_STORAGE_KEY) === token; // read-back 검증
    }
    store.removeItem(AUTH_TOKEN_STORAGE_KEY);
    return true;
  } catch {
    return token === null; // setItem throw = 저장 실패 / removeItem throw = 삭제는 성공 취급
  }
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

// ── 계정 토큰 거부 시그널(§11-D86 F2) ──
// 401 INVALID_TOKEN이 "이 클라가 계정 토큰을 첨부한 요청"에서 돌아온 경우에만 발화한다(onLoginRequired와
// 동일 패턴, net은 스토어 미참조 유지). 게스트 토큰의 INVALID_TOKEN(만료 등)은 ensureSession 재부트스트랩
// 영역이므로 발화하지 않고, 호출측이 Authorization을 직접 지정한 요청도 제외한다.
type AccountTokenRejectedHandler = () => void;
const accountTokenRejectedHandlers = new Set<AccountTokenRejectedHandler>();

/** 계정 토큰 거부 시그널 구독. 반환 함수로 해제. */
export function onAccountTokenRejected(handler: AccountTokenRejectedHandler): () => void {
  accountTokenRejectedHandlers.add(handler);
  return () => {
    accountTokenRejectedHandlers.delete(handler);
  };
}

function emitAccountTokenRejected(): void {
  for (const handler of accountTokenRejectedHandlers) {
    try {
      handler();
    } catch (err) {
      console.warn('[auth] onAccountTokenRejected handler threw:', err);
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  // 계정 > 게스트 우선순위(§11-D68-①). 첨부 토큰의 출처를 기억해 401 분기(§11-D86 F2b)에서 계정 토큰
  // 거부만 골라낸다 — 게스트 토큰 401이나 호출측이 직접 지정한 Authorization은 제외한다.
  const accountToken = getAuthToken();
  const token = accountToken ?? getSessionToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) };
  const usingAccountToken = accountToken !== null && !headers.Authorization;
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
      if (res.status === 401 && body.error.code === 'INVALID_TOKEN' && usingAccountToken)
        emitAccountTokenRejected();
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

/**
 * [WT-AUTH-REDIRECT] GIS `ux_mode:'redirect'` 로그인의 2단계 응답. 서버가 302로 되돌려준 1회용
 * 코드(`?authcode=`)를 계정 세션으로 교환한 결과다. AuthAccountRes와 같은 필드에 표시 프로필
 * (name/picture)이 더해져 있다 — redirect 모드에서는 클라가 credential(JWT)을 보지 못해
 * decode-jwt로 아바타/이름을 얻을 수 없어서, 서버가 검증된 클레임에서 직접 실어 준다.
 */
export interface AuthExchangeRes {
  token: string;
  /** token은 형제 필드로 분리돼 있다(서버 AuthCodePayload와 동형). */
  user: Omit<AuthAccountRes, 'token'> & { name?: string; picture?: string };
}

/** POST /auth/google/exchange — 1회용 authcode → {token, user}. 만료/재사용은 401. */
export function exchangeAuthCode(code: string): Promise<AuthExchangeRes> {
  return apiClient.post<AuthExchangeRes>('/auth/google/exchange', { code });
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
    case 'chase':
      return 'chase'; // [WT-CH] chase 리더보드 modeKey (lb:chase:*, docs/09 §9.3)
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
  /** [WT-AUTH-04] 게스트→계정 브리지(§11-D68-④). 계정 세션으로 제출하는데 runToken이 로그인 전
   *  (게스트 시절) 발급된 것이면, 그 게스트 세션 토큰(wt:sessiontoken 원문)을 실어 두 신원 동시
   *  보유를 증명한다. runToken이 이미 계정 pid로 발급된 경우엔 서버가 무시하므로 항상 첨부해도
   *  안전(04 §6.2-①, workers/api/src/routes/runs.ts의 verifyPid 분기 참조). */
  guestToken?: string;
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

// ───────────────────────── chase(골드 러너, docs/09 §9.1·§9.2, WT-CH-08) ─────────────────────────
// 기존 5모드 runs/start·submit(RunStartReq/RunSubmitReq)과 바디 모양이 완전히 달라(세트 없음,
// moveLog/runLog/clientResult) 별도 타입·함수로 둔다 — net/run-session.ts의 useRunStart/useRunSubmit은
// mode==='chase'를 이미 조기 return으로 제외하므로(그 파일 무수정) 이 함수들은 features/chase 쪽
// 전용 훅에서만 호출된다. 응답 바디(RunSubmitRes)는 서버 submitRes() 헬퍼가 5모드와 동일하게
// 조립하므로(workers/api/src/routes/runs.ts) 타입을 그대로 재사용한다.

export interface ChaseStartReq {
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
}

export interface ChaseStartRes {
  runToken: string;
  seed: number;
  constantsVersion: number;
}

export function startChase(body: ChaseStartReq): Promise<ChaseStartRes> {
  return apiClient.post<ChaseStartRes>('/chase/start', body);
}

export interface ChaseMoveLogEntrySubmit {
  hopIndex: number;
  countryId: string;
  tMs: number;
}

export interface ChaseHopStatSubmit {
  hopIndex: number;
  keystrokes: number;
  errors: number;
}

export interface ChaseClientResultSubmit {
  score: number;
  pi: number;
  stats: {
    totalKeystrokes: number;
    correctKeystrokes: number;
    elapsedMs: number;
    maxCombo: number;
  };
  outcome: 'arrested' | 'resigned';
  endedAtMs: number;
  arrestedAtMs?: number;
}

export interface ChaseSubmitReq {
  runToken: string;
  moveLog: ChaseMoveLogEntrySubmit[];
  runLog: ChaseHopStatSubmit[];
  clientResult: ChaseClientResultSubmit;
  /** [WT-AUTH-04] 게스트→계정 브리지(§11-D68-④) — RunSubmitReq.guestToken과 동일 계약. */
  guestToken?: string;
}

export function submitChaseRun(body: ChaseSubmitReq): Promise<RunSubmitRes> {
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

// [§11-D88] 닉네임 check/put 클라 래퍼는 폐지됐다 — 표시/멀티 신원 닉네임은 계정(Google) 이름으로
// 일원화(수동 입력 플로우 제거). 서버 routes/nickname.ts·users.nickname은 존치(클라 발화만 소멸).

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
