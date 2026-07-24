// spec: WT-AUTH-03(credential 프로필 디코드는 표시 전용, 서명 검증 아님).
import { describe, expect, it } from 'vitest';
import { decodeGoogleProfile } from './decode-jwt';

/** UTF-8 안전 base64url 인코더(멀티바이트 이름도 정확히 왕복). */
function b64url(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(payload: unknown): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature-not-verified`;
}

describe('decodeGoogleProfile', () => {
  it('extracts name/picture/email from a well-formed credential', () => {
    const jwt = makeJwt({ name: 'Trip Tester', picture: 'https://lh3.googleusercontent.com/a/x.png', email: 't@e.com', sub: '123' });
    expect(decodeGoogleProfile(jwt)).toEqual({
      name: 'Trip Tester',
      picture: 'https://lh3.googleusercontent.com/a/x.png',
      email: 't@e.com',
    });
  });

  it('round-trips a multibyte (Korean) name via UTF-8', () => {
    const jwt = makeJwt({ name: '여행자', picture: null, email: '한글@e.com' });
    const p = decodeGoogleProfile(jwt);
    expect(p.name).toBe('여행자');
    expect(p.email).toBe('한글@e.com');
    expect(p.picture).toBeNull();
  });

  it('returns all-null for a malformed credential (wrong segment count)', () => {
    expect(decodeGoogleProfile('not-a-jwt')).toEqual({ name: null, picture: null, email: null });
    expect(decodeGoogleProfile('')).toEqual({ name: null, picture: null, email: null });
  });

  it('returns null for absent claims', () => {
    const jwt = makeJwt({ sub: 'only-sub' });
    expect(decodeGoogleProfile(jwt)).toEqual({ name: null, picture: null, email: null });
  });
});
