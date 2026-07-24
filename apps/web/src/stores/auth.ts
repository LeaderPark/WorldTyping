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
import { getAuthToken, onLoginRequired, setAuthToken } from '../net/api-client';

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

/** 컴포넌트 셀렉터: 유효한 로그인 상태인가(playerId 존재 + 미만료). */
export const selectIsLoggedIn = (s: AuthState): boolean =>
  s.playerId !== null && s.expiresAt !== null && s.expiresAt > Date.now();

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
        setAuthToken(session.token);
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
