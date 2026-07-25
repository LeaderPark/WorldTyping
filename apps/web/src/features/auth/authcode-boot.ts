// spec: docs/00 §11-D68-②(계정 로그인), §11-D86 F4(setAuthToken 검증 경로) + WT-AUTH-REDIRECT
//
// GIS `ux_mode:'redirect'` 로그인의 **클라 착지 처리**. 서버 POST /auth/google/redirect가 계정
// 세션을 발급한 뒤 `/?authcode={32hex}`(성공) 또는 `/?authError=1`(실패)로 302를 돌려주면, 앱
// 부팅 시 이 모듈이 정확히 1회 그 쿼리를 소비한다.
//
//   성공: 쿼리에서 코드 제거(동기) → POST /auth/google/exchange → useAuthStore.login()
//   실패: 쿼리 제거(동기) → 로그인 모달을 열고 기존 generic 에러 문구(auth.error) 노출
//
// [왜 URL을 먼저 지우나] 코드는 60초 1회용이라 그 자체로 자격증명이다 — 주소창·히스토리·사용자가
// 복사해 붙이는 링크에 남으면 안 된다. 그래서 네트워크 왕복 **전에** 동기적으로 제거하고, 이
// 함수를 라우터(createBrowserRouter) 생성보다 먼저 호출해 라우터가 애초에 깨끗한 URL을 본다.
//
// [로그인 성립 경로는 재구현하지 않는다] 토큰 영속(read-back 검증)·프로필 세팅·모달 닫힘은 전부
// useAuthStore.login()이 소유한다(§11-D86 F4). 여기서는 서버 응답을 AccountSession으로 옮겨
// 담기만 한다 — GIS 팝업 경로(useLogin.handleCredential)와 완전히 같은 종착점이다.

import { exchangeAuthCode, type AuthExchangeRes } from '../../net/api-client';
import { useAuthStore, type AccountSession } from '../../stores/auth';

/** 성공 302가 싣는 1회용 코드 쿼리 키. */
const AUTHCODE_PARAM = 'authcode';
/** 실패 302가 싣는 플래그 쿼리 키(값 '1'만 유효). */
const AUTHERROR_PARAM = 'authError';

/** GIS `login_uri`로 넘길 서버 착지 경로. LoginModal이 `location.origin + 이 값`으로 조립한다. */
export const GOOGLE_REDIRECT_LOGIN_PATH = '/api/v1/auth/google/redirect';

/**
 * 로그인 직전 경로를 담는 저장소 키. **sessionStorage**를 쓴다 — 탭 단위로 격리돼 다른 탭의
 * 로그인이 이 탭의 복귀 경로를 덮지 않고, 탭을 닫으면 사라져 잔류가 무해하다(로그인을 시작만
 * 하고 모달을 닫아 키가 남아도 다음 오픈이 덮어쓴다).
 */
export const LOGIN_RETURN_TO_KEY = 'wt:loginReturnTo';

// 부트에서 감지한 로그인 실패를 모달에 전달하는 1회성 플래그. 스토어에 필드를 늘리는 대신 이
// 모듈 지역 상태로 둔다 — 순수 transient(새로고침에 사라져야 하고 persist 대상이 아니다).
let redirectErrorPending = false;

/** LoginModal 전용: 부트에서 감지된 redirect 로그인 실패를 1회 소비한다(읽으면 소멸). */
export function takeAuthRedirectError(): boolean {
  const pending = redirectErrorPending;
  redirectErrorPending = false;
  return pending;
}

/** 테스트 전용: 모듈 플래그 리셋. */
export function __resetAuthRedirectErrorForTests(): void {
  redirectErrorPending = false;
}

function toSession(res: AuthExchangeRes): AccountSession {
  const { user } = res;
  return {
    token: res.token,
    playerId: user.playerId,
    nickname: user.nickname,
    // 서버 ISO → epoch ms. 파싱 실패(방어)는 0으로 두어 즉시 만료 처리되게(useLogin과 동일 규약).
    expiresAt: Number.isNaN(Date.parse(user.expiresAt)) ? 0 : Date.parse(user.expiresAt),
    geo: user.geo,
    profile: {
      // 표시명은 서버가 정제한 nickname을 폴백으로 둔다(name 클레임 부재 계정 대비).
      name: user.name ?? user.nickname,
      picture: user.picture ?? null,
      email: user.email ?? null,
    },
  };
}

/**
 * 로그인 모달이 열리는 시점의 경로를 기억한다(LoginModal이 호출). GIS redirect는 전체 페이지
 * 이동이라 서버가 항상 `/`로 되돌려 보낸다 — 이 값이 없으면 로비/랭킹에서 로그인한 사용자가
 * 홈에 떨어진다. 저장소 접근이 막힌 브라우저(사생활 모드 등)에서는 조용히 포기하고 홈 착지로
 * 폴백한다 — 복귀는 편의 기능이지 로그인 성립 조건이 아니다.
 */
export function rememberLoginReturnTo(): void {
  try {
    const { pathname, search, hash } = window.location;
    window.sessionStorage.setItem(LOGIN_RETURN_TO_KEY, `${pathname}${search}${hash}`);
  } catch {
    /* no-op */
  }
}

/**
 * 복귀 경로를 1회성으로 소비한다(읽는 즉시 제거 — 다음 부팅에 재사용되지 않게).
 *
 * **오픈 리다이렉트 차단**: 이 값은 저장소를 통해 들어오므로 신뢰 대상이 아니다. `/`로 시작하는
 * 내부 절대 경로만 허용하고, `//evil.com`(프로토콜 상대 URL — 브라우저가 외부 오리진으로 해석)은
 * 명시적으로 거부한다. 부적합하면 null → 호출측이 현재 경로를 그대로 유지한다.
 */
function takeLoginReturnTo(): string | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(LOGIN_RETURN_TO_KEY);
    window.sessionStorage.removeItem(LOGIN_RETURN_TO_KEY);
  } catch {
    return null;
  }
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

/**
 * authcode/authError 쿼리를 제거한 URL로 히스토리를 정리한다(히스토리 미증가). 복귀 경로가
 * 유효하면 그쪽으로 대체하고, 아니면 현재 경로에서 쿼리만 지운다(다른 쿼리·해시는 보존).
 */
function stripAuthParams(url: URL, returnTo: string | null): void {
  url.searchParams.delete(AUTHCODE_PARAM);
  url.searchParams.delete(AUTHERROR_PARAM);
  const search = url.searchParams.toString();
  const here = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
  window.history.replaceState(null, '', returnTo ?? here);
}

/**
 * 앱 부팅 시 1회 호출(main.tsx). authcode/authError 쿼리가 없으면 즉시 no-op이라 일반 방문에는
 * 아무 비용도 없다. 반환 프라미스는 테스트 편의용 — 호출측은 await하지 않는다(부팅을 막지 않음).
 */
export async function consumeAuthRedirect(): Promise<void> {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  const code = url.searchParams.get(AUTHCODE_PARAM);
  const failed = url.searchParams.get(AUTHERROR_PARAM) === '1';
  if (code === null && !failed) return;

  // 성공/실패 공통으로 복귀 경로를 1회 소비한다 — 실패해도 사용자를 원래 있던 화면에 되돌려
  // 놓아야 모달 안내가 맥락을 유지한다. 이 함수는 라우터 생성 **전에** 돌므로 여기서 바꾼
  // 경로가 곧 라우터의 초기 location이 된다(추가 네비게이션 불요).
  const returnTo = takeLoginReturnTo();
  stripAuthParams(url, returnTo); // 네트워크 왕복 전에 동기 제거(위 주석 참조).

  if (failed) {
    redirectErrorPending = true;
    useAuthStore.getState().openLogin('general');
    return;
  }
  if (code === null) return;

  try {
    useAuthStore.getState().login(toSession(await exchangeAuthCode(code)));
  } catch (err) {
    // 코드 만료/재사용(401)·오프라인·저장소 영속 실패(AuthPersistError) — 어느 쪽이든 사용자를
    // 막지 않는다. 조용히 비로그인 상태로 두고 평소처럼 로그인 버튼을 다시 누르게 한다.
    console.warn('[auth] authcode 교환 실패 — 비로그인으로 계속합니다:', err);
  }
}
