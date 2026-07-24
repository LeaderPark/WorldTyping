// spec: docs/00 §11-D68-②(GIS ID-token) + WT-AUTH-03
//
// Google credential(ID-token JWT)의 payload를 디코드해 표시용 프로필(이름/아바타/이메일)만 뽑는다.
// ⚠️ 이것은 서명 검증이 아니다 — 신뢰 판정은 전적으로 서버(/auth/google JWKS RS256)가 한다. 여기서
// 얻은 값은 오직 UI 표시(프로필 칩 아바타·이름)에만 쓰고, 신원/권한 결정에 쓰지 않는다.

import type { GoogleProfile } from '../../stores/auth';

interface GoogleIdTokenClaims {
  name?: unknown;
  picture?: unknown;
  email?: unknown;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  // UTF-8 안전 디코드(한글 이름 등 멀티바이트) — atob은 latin1이라 그대로 JSON.parse하면 깨진다.
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * credential(JWT)에서 프로필을 디코드한다. 형식이 어긋나거나 디코드에 실패하면 전부 null인 프로필을
 * 돌려준다(로그인 자체를 막지 않는다 — 서버 응답의 nickname으로 여전히 표시 가능).
 */
export function decodeGoogleProfile(credential: string): GoogleProfile {
  try {
    const parts = credential.split('.');
    if (parts.length !== 3 || !parts[1]) return { name: null, picture: null, email: null };
    const claims = JSON.parse(base64UrlDecode(parts[1])) as GoogleIdTokenClaims;
    return {
      name: asStringOrNull(claims.name),
      picture: asStringOrNull(claims.picture),
      email: asStringOrNull(claims.email),
    };
  } catch {
    return { name: null, picture: null, email: null };
  }
}
