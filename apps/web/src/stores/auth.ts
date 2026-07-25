// spec: docs/03 §4.3(스토어 규약 — 6번째 스토어 auth 추가), docs/00 §11-D68(계정 로그인 하이브리드)
//       + WT-AUTH-03
//
// 6번째(마지막) 클라 스토어. Google 계정 로그인 세션과 로그인 모달의 열림 상태만 담는다. 고빈도
// 값(§4.5) 없음 — 로그인은 저빈도 사용자 액션이다.
//
// [토큰 저장 위치] 계정 세션 토큰(wt1)은 이 스토어의 persist 상태가 아니라 net/api-client의 원시 키
// 'wt:authtoken'에 둔다(api-client가 zustand 하이드레이션을 기다리지 않고 동기적으로 Authorization을
// 조립할 수 있어야 하기 때문 — 게스트 세션 토큰과 동일 규약). 이 스토어의 persist('wt:auth')에는
// 표시용 프로필(profile/nickname/playerId/geo/expiresAt)만 담는다.
//
// [만료 자동 로그아웃] 계정 토큰 TTL은 30일(SESSION_TTL_MS)이라 세션 도중 만료는 사실상 없다 —
// 하이드레이션 시점에 expiresAt이 이미 지났으면(오래 뒤 재방문) 조용히 로그아웃해 UI를 로그아웃
// 상태로 되돌리고, 원시 토큰도 지워 api-client가 게스트로 폴백하게 한다.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ApiError,
  AUTH_TOKEN_STORAGE_KEY,
  fetchSessionMe,
  getAuthToken,
  onAccountTokenRejected,
  onLoginRequired,
  setAuthToken,
} from '../net/api-client';

/** Google credential(ID-token JWT)에서 디코드한 표시용 프로필(avatar/이름/이메일). */
export interface GoogleProfile {
  name: string | null;
  /** 아바타 이미지 URL(*.googleusercontent.com). dev 심/디코드 실패 시 null → 이니셜 폴백. */
  picture: string | null;
  email: string | null;
}

/** login()에 넘기는 확정 계정 세션(서버 응답 + 클라 디코드 프로필 조합). */
export interface AccountSession {
  token: string;
  playerId: string;
  nickname: string;
  /** epoch ms(서버 ISO를 환산해 전달). */
  expiresAt: number;
  geo: string;
  profile: GoogleProfile;
}

/** 로그인 모달을 여는 맥락(문구 분기) — 일반/멀티 진입/랭킹 등재/여권 게이팅. */
export type LoginReason = 'general' | 'multi' | 'ranking' | 'passport';

export interface AuthState {
  playerId: string | null;
  nickname: string | null;
  profile: GoogleProfile | null;
  geo: string | null;
  /** epoch ms. null이면 비로그인. */
  expiresAt: number | null;
  /** 로그인 모달 열림 맥락(null이면 닫힘) — persist 대상 아님(transient). */
  loginReason: LoginReason | null;

  login(session: AccountSession): void;
  logout(): void;
  openLogin(reason?: LoginReason): void;
  closeLogin(): void;
}

/** [§11-D86 F4] 토큰 영속 실패로 로그인 성립을 거부할 때 login()이 던진다(LoginModal이 이름으로 판별). */
export class AuthPersistError extends Error {
  constructor() {
    super('account token persist failed (browser storage unavailable)');
    this.name = 'AuthPersistError';
  }
}

/** 컴포넌트 셀렉터: 유효한 로그인 상태인가 — 표시 프로필(playerId 존재 + 미만료)에 더해 **사용 가능한
 *  계정 토큰(wt:authtoken) 실존**을 요구한다(§11-D86: 프로필-토큰 split-brain을 판정 정의에서 봉인).
 *  토큰 만료 검사는 동일 서버 응답에서 함께 세팅된 expiresAt이 대리한다(클라는 HMAC 검증 불가 — 실검증은
 *  verifyAccountSession/서버 401). getAuthToken()은 동기 localStorage 1회 읽기로 저빈도 렌더 경로에서
 *  무해하며(기존에도 Date.now()로 비순수), 반응성은 스토어 전이(storage/focus 리스너·rehydrate·logout)가
 *  담당하고 이 검사는 렌더 시점 최종 방어선이다. */
export const selectIsLoggedIn = (s: AuthState): boolean =>
  s.playerId !== null && s.expiresAt !== null && s.expiresAt > Date.now() && getAuthToken() !== null;

const LOGGED_OUT = {
  playerId: null,
  nickname: null,
  profile: null,
  geo: null,
  expiresAt: null,
} as const;

// [WT-FIX-CROSSTAB-TOKEN, §11-D109 예정] 크로스탭 rehydrate 고아 토큰 스윕을 "최초 부팅 하이드레이션
// 1회"로 게이트하는 모듈 지역 플래그. onRehydrateStorage는 최초 부팅(모듈 로드 시 자동 1회)뿐 아니라
// reconcileAuthWithStorage()가 크로스탭 정합화를 위해 거는 persist.rehydrate()에서도 재호출된다. 이
// 재호출 시점엔 wt:authtoken/wt:auth가 각각 별개 storage 이벤트로 비동기 기록되는 도중이라 "토큰만
// 신값, 프로필(wt:auth)은 아직 구값" 순간이 정상적으로 존재한다 — 뒤이어 도착하는 wt:auth 이벤트의
// reconcile이 프로필을 자연 수화하므로 이 창에서 지우면 안 된다. 게이트 없이 무조건 스윕하면 로그인
// 탭이 방금 발급한 토큰을 관전 탭이 지우고, 그 삭제가 storage 이벤트로 로그인 탭까지 전파돼 연쇄
// 로그아웃된다(2026-07-25 라이브 장애 RCA, 3/3 재현). 최초 부팅의 진짜 고아(프로필 persist 실패 등
// 잔재)만 1회 소거하면 되므로, "최초 호출 여부"만 이 플래그로 기억한다.
let initialHydrationDone = false;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...LOGGED_OUT,
      loginReason: null,

      login: (session) => {
        // [§11-D86 F4] 토큰 영속(read-back 검증) 성공이 로그인 성립의 선행 조건. 실패하면 프로필을
        // 세우지 않고 AuthPersistError를 던진다 — "프로필만 서고 토큰 없음"을 로그인 시점에 원천
        // 차단(LoginModal .catch가 auth.storageError 안내). 토큰-먼저 순서 덕에 성공 시 셀렉터가 즉시
        // true — LobbyPage 보류 액션 재개(isLoggedIn effect)와의 순서 계약도 그대로다.
        if (!setAuthToken(session.token)) {
          setAuthToken(null); // 부분 쓰기 방어적 원복(best-effort).
          throw new AuthPersistError();
        }
        set({
          playerId: session.playerId,
          nickname: session.nickname,
          profile: session.profile,
          geo: session.geo,
          expiresAt: session.expiresAt,
          loginReason: null, // 로그인 성공 시 모달 닫힘.
        });
      },
      logout: () => {
        setAuthToken(null);
        set({ ...LOGGED_OUT });
      },
      openLogin: (reason = 'general') => set({ loginReason: reason }),
      closeLogin: () => set({ loginReason: null }),
    }),
    {
      name: 'wt:auth',
      // 토큰(원시 키)·transient(loginReason)는 제외 — 표시용 프로필만 persist.
      partialize: (s) => ({
        playerId: s.playerId,
        nickname: s.nickname,
        profile: s.profile,
        geo: s.geo,
        expiresAt: s.expiresAt,
      }),
      onRehydrateStorage: () => (state) => {
        // 이 호출이 최초 부팅 하이드레이션인지 먼저 캡처하고 즉시 플래그를 소비한다 — 이후의 모든
        // 호출(크로스탭 rehydrate 등)은 "최초 아님"으로 취급되어 아래 고아 스윕이 다시 열리지 않는다.
        // state가 undefined(역직렬화 실패 등)여도 "호출은 발생했다"는 사실 자체를 기억해야 하므로 이른
        // return보다 먼저 소비한다.
        const isInitialHydration = !initialHydrationDone;
        initialHydrationDone = true;
        if (!state) return;
        // 재방문 시 만료됐거나(30일 경과) 원시 토큰이 사라졌으면(수동 정리 등) 로그아웃으로 정합화.
        // 크로스탭 로그아웃 전파(§11-D86 F1b)가 걸어오는 rehydrate에서도 항상 유지돼야 하므로 최초
        // 호출 여부와 무관하게 게이트하지 않는다.
        const expired = state.expiresAt !== null && state.expiresAt <= Date.now();
        if (expired || getAuthToken() === null) {
          state.logout();
        } else if (state.playerId === null && isInitialHydration) {
          // [§11-D86, WT-FIX-CROSSTAB-TOKEN] 역방향 고아 토큰 스윕은 최초 부팅 1회만 수행한다. 크로스탭
          // rehydrate 도중의 "토큰만 신값, 프로필은 구값" 과도기는 정상이며 지우면 안 된다(위
          // initialHydrationDone 선언부 주석에 RCA 상세). 최초 부팅의 진짜 고아(프로필 persist 실패 등
          // 잔재)만 여기서 소거해 "UI 비로그인인데 계정 토큰 전송" 불일치를 봉인한다.
          setAuthToken(null);
        }
      },
    },
  ),
);

// LOGIN_REQUIRED 전역 시그널 배선(§11-D68-①). 게이팅된 요청이 401 LOGIN_REQUIRED로 막히면 로그인
// 모달을 연다. 이미 다른 맥락으로 열려 있으면(예: 로비가 선제적으로 openLogin('multi')) 덮어쓰지
// 않는다 — 호출측이 세운 더 구체적인 사유가 이긴다.
onLoginRequired(() => {
  if (useAuthStore.getState().loginReason === null) useAuthStore.getState().openLogin('general');
});

// 서버가 계정 토큰을 거부(401 INVALID_TOKEN + 계정 토큰 첨부 요청)하면 즉시 로그아웃 정합화(§11-D86
// F2b) — 죽은 토큰으로 "로그인처럼 보이는" 창을 실패 요청 1회 이내로 좁힌다. logout()이 토큰도 소거.
onAccountTokenRejected(() => {
  const s = useAuthStore.getState();
  if (s.playerId !== null || getAuthToken() !== null) s.logout();
});

// ── 크로스탭/재포커스 정합화(§11-D86 F1) ──
// 다른 탭의 로그아웃/로그인·스토리지 축출을 새로고침 없이 이 탭 스토어에 반영한다. 'storage'는 타 탭
// 변경에서만 발화하고(자기 변경 무발화), 같은 값 재기록은 이벤트를 만들지 않으므로(oldValue===newValue)
// logout()의 persist 재기록이 전파 루프를 만들지 않는다.
function reconcileAuthWithStorage(): void {
  const s = useAuthStore.getState();
  const token = getAuthToken();
  const profileAlive = s.playerId !== null;
  if (profileAlive && (token === null || (s.expiresAt !== null && s.expiresAt <= Date.now()))) {
    s.logout(); // 토큰 소실/만료 → 이 탭도 즉시 로그아웃.
  } else if (!profileAlive && token !== null) {
    void useAuthStore.persist.rehydrate(); // 타 탭 로그인 전파(onRehydrateStorage가 재검증).
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === AUTH_TOKEN_STORAGE_KEY || e.key === 'wt:auth')
      reconcileAuthWithStorage(); // e.key===null = clear() 전체 소거.
  });
  window.addEventListener('focus', reconcileAuthWithStorage); // 이벤트 유실(축출 등) 회수.
}

// ── 멀티 진입 1회 계정 토큰 서버 검증(§11-D86 F2a, 서버 무변경) ──
// 기존 GET /session/me(requireAuth)를 재사용한다 — bearerToken()이 계정>게스트 우선이라 계정 토큰 존재
// 시 이 호출이 그 토큰을 싣고, 200이면 서명·만료·유저 존재가 서버에서 실검증된 것이다. 401(무효 토큰)일
// 때만 로그아웃 강등 — 오프라인/5xx/기타 실패는 판정 불가로 보고 강등하지 않는다(가용성 우선). 진입당
// 1회 제한: 60s 메모(로비→방 연쇄 진입 중복 억제). 게스트(토큰 없음)는 no-op — 추가 콜 0.
const VERIFY_MEMO_MS = 60_000;
let verifyLastAt = 0;
export async function verifyAccountSession(): Promise<void> {
  if (getAuthToken() === null) return;
  const now = Date.now();
  if (now - verifyLastAt < VERIFY_MEMO_MS) return;
  verifyLastAt = now;
  try {
    await fetchSessionMe();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) useAuthStore.getState().logout();
  }
}

/** 테스트 전용(WT-FIX-CROSSTAB-TOKEN): 최초 부팅 하이드레이션 플래그 리셋 — "최초 부팅" 시나리오를
 *  명시적으로 재현할 때 호출한다(크로스탭 rehydrate 시나리오는 리셋 없이 그대로 둔다). */
export function __resetAuthHydrationForTests(): void {
  initialHydrationDone = false;
}

/** 테스트 전용: 60s 메모 리셋. */
export function __resetAccountVerifyForTests(): void {
  verifyLastAt = 0;
}
