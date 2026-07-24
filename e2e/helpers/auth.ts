// spec: docs/00 §11-D68(계정 로그인 하이브리드 — 랭킹=로그인 전용·멀티=로그인 필수)·D68-⑩
//       (POST /auth/dev dev 심), workers/api/src/routes/auth.ts, apps/web/src/stores/auth.ts +
//       apps/web/src/net/api-client.ts(토큰 저장 규약), WT-AUTH-08(E2E 이행).
//
// [왜 이 헬퍼가 필요한가] WT-AUTH로 랭킹 제출이 "로그인 전용"이 됐다(§11-D68-①). 비계정(게스트)
// 제출은 서버가 verdict='practice'/reason='guest'로 강등하고, 결과 화면도 result-login-cta만
// 그린다(useRunSubmit이 idle로 남음). 그래서 "유효 제출 → 리더보드 반영"을 검증해야 하는 스펙
// (E1·cheat-suite 등)은 먼저 계정 세션을 확보해야 한다.
//
// [실 Google 호출 금지] 실제 GIS ID-token은 테스트에서 만들 수 없고 CSP도 외부 호출을 막는다.
// 유일하게 허용된 경로는 dev 전용 테스트 심 POST /auth/dev({sub,name?,email?})다 — e2e-dev-server가
// wrangler.toml [vars] ENVIRONMENT="dev"로 기동하므로 활성이다(staging/prod는 404). 이 심은
// Google JWKS 검증만 우회할 뿐 그 뒤 계정 upsert·토큰 발급은 /auth/google과 완전히 동일 경로다.
//
// [UI 로그인 버튼을 쓰지 않는 이유] pnpm e2e webServer는 apps/web을 **프로덕션 빌드**(vite build)해
// 서빙한다 → import.meta.env.DEV=false → LoginModal의 /auth/dev 폴백 버튼(login-dev)이 렌더되지
// 않고(useLogin.DEV_LOGIN_FALLBACK), 실 GIS 버튼은 외부 네트워크가 필요해 쓸 수 없다. 그래서
// 로그인 "상태"는 UI 클릭이 아니라 이 헬퍼가 /auth/dev 응답 토큰을 localStorage에 직접 주입해
// 만든다(앱이 이미 로그인된 채로 부팅). 로그인 모달의 열림/닫힘·게이팅 트리거 자체는 별도 스펙이
// UI로 검증한다(LoginModal은 clientId 부재 시 login-error를 그리지만 열림/닫힘 계약은 그대로다).
//
// [세션 예산] POST /auth/dev는 레이트리밋 대상이 아니다(routes/auth.ts — /auth/google만 rateLimit).
// 신규 pid 어뷰즈 카운터(POST /session 전용)도 타지 않는다. 따라서 이 헬퍼는 세션 슬롯을 예약하지
// 않는다 — 로그인 후 페이지 로드가 유발하는 게스트 부트스트랩(POST /session)은 기존 헬퍼(game.ts의
// gotoBoarding 등)가 reserveSessionSlot으로 계속 정직하게 페이싱한다.

import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/** 앱이 저장하는 계정 세션 원문 + 표시 프로필(localStorage 주입에 필요한 전량). */
export interface DevAccount {
  /** 계정 세션 토큰(wt1, acct:1) — api-client가 원시 키 'wt:authtoken'에서 읽어 Authorization에 싣는다. */
  token: string;
  /** 계정 user_id(= derivePlayerId(secret,"google:"+sub)) — RankPage "내 행" 판정 pid. */
  playerId: string;
  nickname: string;
  /** epoch ms(서버 ISO를 환산). stores/auth의 persist expiresAt은 ms다. */
  expiresAtMs: number;
  geo: string;
  email: string | null;
}

interface AuthDevRes {
  token: string;
  playerId: string;
  nickname: string;
  expiresAt: string;
  geo: string;
  email?: string;
}

/** 30일 TTL(SESSION_TTL_MS)과 동형의 넉넉한 폴백 — 서버 ISO 파싱이 실패해도 로그인 상태가 즉시
 *  만료(로그아웃)되지 않게 한다. 정상 경로에서는 서버 값을 그대로 쓴다. */
const FALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * POST /api/v1/auth/dev로 계정 세션을 발급받는다. `sub`는 결정적 신원 파생 입력이라 **스펙별로
 * 고유값**을 주면 계정이 격리된다(같은 sub = 같은 user_id, 멱등 재로그인). 예: `auth-e1`,
 * `cheat-<uuid>`. 반환값은 localStorage 주입(installAuthSession)에 필요한 전량을 담는다.
 */
export async function createDevAccount(
  request: APIRequestContext,
  sub: string,
  name = 'E2E Tester',
): Promise<DevAccount> {
  const res = await request.post('/api/v1/auth/dev', { data: { sub, name } });
  if (!res.ok()) {
    throw new Error(`createDevAccount: /auth/dev 실패 ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as AuthDevRes;
  const ms = Date.parse(body.expiresAt);
  return {
    token: body.token,
    playerId: body.playerId,
    nickname: body.nickname,
    expiresAtMs: Number.isNaN(ms) ? Date.now() + FALLBACK_TTL_MS : ms,
    geo: body.geo,
    email: body.email ?? null,
  };
}

/**
 * 계정 세션을 이 브라우저 컨텍스트의 localStorage에 주입한다 — 이후 이 컨텍스트에서 여는 모든
 * 페이지가 로그인 상태로 부팅한다(addInitScript는 최초 goto뿐 아니라 reload/신규 탭에도 적용).
 * 반드시 첫 네비게이션(page.goto) **이전**에 호출할 것.
 *
 * 두 원시 키를 함께 심는다(둘 다 없으면 stores/auth의 onRehydrateStorage가 로그아웃으로 정합화한다):
 *  - 'wt:authtoken' = 계정 토큰 원문(api-client가 동기적으로 읽는 원시 키).
 *  - 'wt:auth'      = zustand persist 블롭({state:{...표시 프로필}, version:0}). 만료 검사를
 *                     통과하도록 expiresAt은 미래 ms로 둔다.
 */
export async function installAuthSession(context: BrowserContext, acct: DevAccount): Promise<void> {
  const persist = JSON.stringify({
    state: {
      playerId: acct.playerId,
      nickname: acct.nickname,
      profile: { name: acct.nickname, picture: null, email: acct.email },
      geo: acct.geo,
      expiresAt: acct.expiresAtMs,
    },
    version: 0,
  });
  await context.addInitScript(
    ([token, persistJson]) => {
      try {
        window.localStorage.setItem('wt:authtoken', token);
        window.localStorage.setItem('wt:auth', persistJson);
      } catch {
        // 사생활 모드 등 localStorage 접근 불가 — 로그인 주입은 최적화가 아니라 요구사항이므로
        // 조용히 넘어가면 후속 assert가 로그인 상태 부재로 실패해 원인이 드러난다(무해).
      }
    },
    [acct.token, persist] as const,
  );
}

/**
 * 원스톱: dev 계정 발급 + 컨텍스트 주입. page.goto **이전**에 호출하면 그 페이지(및 같은 컨텍스트의
 * 이후 페이지들)가 로그인된 채 부팅한다. `sub`는 스펙별 고유값을 권장한다(계정 격리 — 위 주석).
 */
export async function loginAs(page: Page, sub: string, name?: string): Promise<DevAccount> {
  const acct = await createDevAccount(page.request, sub, name);
  await installAuthSession(page.context(), acct);
  return acct;
}
