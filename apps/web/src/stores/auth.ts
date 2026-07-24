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

/** 로그인 모달을 여는 맥락(문구 분기) — 일반/멀티 진입/랭킹 등재. */
export type LoginReason = 'general' | 'multi' | 'ranking';

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
        // 재방문 시 만료됐거나(30일 경과) 원시 토큰이 사라졌으면(수동 정리 등) 로그아웃으로 정합화.
        if (!state) return;
        const expired = state.expiresAt !== null && state.expiresAt <= Date.now();
        if (expired || getAuthToken() === null) state.logout();
        // [§11-D86] 역방향 고아 토큰: 프로필 없이 토큰만 남은 부팅(프로필 persist 실패 등)은 토큰을
        // 소거해 "UI 비로그인인데 계정 토큰 전송" 불일치도 봉인한다(게스트는 토큰 자체가 없어 무관).
        else if (state.playerId === null) setAuthToken(null);
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

/** 테스트 전용: 60s 메모 리셋. */
export function __resetAccountVerifyForTests(): void {
  verifyLastAt = 0;
}
