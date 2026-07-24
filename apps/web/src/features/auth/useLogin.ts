// spec: docs/00 §11-D68-②/⑩(GIS ID-token + /auth/dev dev 심) + WT-AUTH-03
//
// 로그인 코어 훅: credential(Google ID-token) → POST /auth/google → auth 스토어 login. DEV이면서
// VITE_GOOGLE_CLIENT_ID가 없으면(로컬 .env.local 미설정) /auth/dev 폴백 경로를 노출한다 —
// GIS 실 client ID 없이도 로컬에서 계정 세션을 발급받아 랭킹/멀티 흐름을 테스트할 수 있게.

import { useCallback } from 'react';
import { authDev, authGoogle, type AuthAccountRes } from '../../net/api-client';
import { useAuthStore, type AccountSession } from '../../stores/auth';
import { decodeGoogleProfile } from './decode-jwt';

/** 프론트가 소비하는 Google client ID(공개값). 프로덕션은 Docker build arg로 주입(WT-AUTH-01 배선). */
export const GOOGLE_CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID;

/** DEV 빌드이면서 client ID가 없을 때만 true — 이 경우 /auth/dev 폴백 버튼을 노출한다. */
export const DEV_LOGIN_FALLBACK: boolean = import.meta.env.DEV && !GOOGLE_CLIENT_ID;

function toSession(res: AuthAccountRes, profile: AccountSession['profile']): AccountSession {
  return {
    token: res.token,
    playerId: res.playerId,
    nickname: res.nickname,
    // 서버 ISO → epoch ms. 파싱 실패(방어)는 0으로 두어 즉시 만료 처리되게(로그인 무효화).
    expiresAt: Number.isNaN(Date.parse(res.expiresAt)) ? 0 : Date.parse(res.expiresAt),
    geo: res.geo,
    profile,
  };
}

export interface UseLogin {
  clientId: string | undefined;
  devFallback: boolean;
  /** GIS 콜백에서 받은 credential로 계정 세션을 발급받아 스토어에 반영. */
  handleCredential(credential: string): Promise<void>;
  /** DEV 폴백: /auth/dev로 결정적 sub의 계정 세션을 발급. */
  loginDev(): Promise<void>;
}

export function useLogin(): UseLogin {
  const login = useAuthStore((s) => s.login);

  const handleCredential = useCallback(
    async (credential: string): Promise<void> => {
      const res = await authGoogle(credential);
      login(toSession(res, decodeGoogleProfile(credential)));
    },
    [login],
  );

  const loginDev = useCallback(async (): Promise<void> => {
    // 결정적 sub — 같은 로컬 기기에서 재로그인 시 동일 계정으로 멱등(서버 upsert 규약).
    const res = await authDev({ sub: 'dev-local', name: 'Dev Tester' });
    login(toSession(res, { name: res.nickname, picture: null, email: res.email ?? null }));
  }, [login]);

  return { clientId: GOOGLE_CLIENT_ID, devFallback: DEV_LOGIN_FALLBACK, handleCredential, loginDev };
}
