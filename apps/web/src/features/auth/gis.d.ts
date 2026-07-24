// spec: docs/00 §11-D68-②(GIS ID-token, 프론트=client ID만) + WT-AUTH-03
//
// Google Identity Services(GIS) 최소 타입 선언 + VITE_GOOGLE_CLIENT_ID env 증강. GIS는
// index.html 정적 로드가 아니라 gis-loader.ts가 지연 주입하므로(§11-D68-⑤ 인증 채널 예외),
// 공식 @types 패키지를 번들 의존성으로 두지 않고 여기서 우리가 실제로 쓰는 표면만 선언한다.
//
// ⚠️ 이 파일은 순수 ambient(top-level import/export 없음) — 그래야 `interface Window`/
//    `interface ImportMetaEnv`가 전역 병합된다. import/export를 추가하면 모듈로 바뀌어 병합이
//    깨지므로 절대 넣지 말 것.

interface GsiCredentialResponse {
  /** Google ID-token(JWT). 서버(/auth/google)가 JWKS로 검증한다. */
  credential: string;
  select_by?: string;
}

interface GsiIdConfig {
  client_id: string;
  callback: (response: GsiCredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  use_fedcm_for_prompt?: boolean;
}

interface GsiButtonConfig {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  logo_alignment?: 'left' | 'center';
  width?: number;
  locale?: string;
}

interface GsiIdApi {
  initialize(config: GsiIdConfig): void;
  renderButton(parent: HTMLElement, options: GsiButtonConfig): void;
  prompt(): void;
  cancel(): void;
  disableAutoSelect(): void;
}

interface GoogleAccountsGlobal {
  accounts: { id: GsiIdApi };
}

interface Window {
  google?: GoogleAccountsGlobal;
}

interface ImportMetaEnv {
  /** Google GIS OAuth client ID(공개값). 미설정 시 useLogin이 DEV에서 /auth/dev 폴백을 노출. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
