// spec: docs/04 §5.2·§5.3·§6.1·§7, docs/00 §11-D11, WT-M1-04
//   — 서명 왕복 / 변조 거부 / exp 만료 / 2키 병행 / 스키마 거부 / 성능 스모크
import { describe, expect, it } from 'vitest';
import { bytesToBase64url, utf8ToBytes } from './base64url';
import { hmacSign } from './hmac';
import {
  RUN_TOKEN_TTL_MS,
  RunTokenPayloadSchema,
  SESSION_TTL_MS,
  SessionPayloadSchema,
  WS_TICKET_TTL_MS,
  WsTicketPayloadSchema,
  signRunToken,
  signSessionToken,
  signToken,
  signWsTicket,
  verifyToken,
  type RunTokenPayload,
} from './token';

// 테스트 픽스처 시크릿(제약: 픽스처 외 상수 시크릿 금지). 세션/런 키 격리를 위해 2종.
const SESSION_SECRET = 'session-secret-fixture-0123456789';
const RUN_SECRET = 'run-secret-fixture-abcdefabcdef';
const PID = 'Abc123Def456';

const NOW = 1_800_000_000_000; // 고정 기준 시각(2027년경) — exp 계산을 결정적으로.

describe('세션 토큰 서명/검증 왕복', () => {
  it('발급 토큰이 wt1.<payload>.<sig> 3분절이고 검증 통과', async () => {
    const token = await signSessionToken(SESSION_SECRET, PID, NOW);
    expect(token.split('.')).toHaveLength(3);
    expect(token.startsWith('wt1.')).toBe(true);

    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW + 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.pid).toBe(PID);
      expect(r.payload.exp).toBe(NOW + SESSION_TTL_MS);
    }
  });
});

describe('runToken / WS 티켓', () => {
  const runFields: Omit<RunTokenPayload, 'startTs' | 'exp'> = {
    rid: 'run-uuid-0001',
    pid: PID,
    mode: 'tier',
    modeKey: 'tier:3',
    lang: 'ko',
    platform: 'desktop',
    setHash: 'a'.repeat(64),
    seed: '0'.repeat(64),
  };

  it('runToken exp = startTs + 30분, 검증 통과', async () => {
    const token = await signRunToken(RUN_SECRET, runFields, NOW);
    const r = await verifyToken(token, RUN_SECRET, RunTokenPayloadSchema, NOW + 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.exp).toBe(NOW + RUN_TOKEN_TTL_MS);
      expect(r.payload.mode).toBe('tier');
      expect(r.payload.setHash).toBe('a'.repeat(64));
    }
  });

  it('WS 티켓 exp = iat + 60초, 검증 통과', async () => {
    const token = await signWsTicket(RUN_SECRET, PID, 'ROOM42', NOW);
    const r = await verifyToken(token, RUN_SECRET, WsTicketPayloadSchema, NOW + 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.exp).toBe(NOW + WS_TICKET_TTL_MS);
      expect(r.payload.room).toBe('ROOM42');
    }
  });

  it('세션 시크릿과 런 시크릿은 격리 — 다른 키로는 검증 실패', async () => {
    const token = await signRunToken(RUN_SECRET, runFields, NOW);
    const r = await verifyToken(token, SESSION_SECRET, RunTokenPayloadSchema, NOW + 1000);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('변조 거부', () => {
  it('페이로드 1바이트 플립 → bad_signature', async () => {
    const token = await signSessionToken(SESSION_SECRET, PID, NOW);
    const parts = token.split('.');
    const p = parts[1]!;
    const mid = Math.floor(p.length / 2);
    const flipped = p[mid] === 'A' ? 'B' : 'A';
    parts[1] = p.slice(0, mid) + flipped + p.slice(mid + 1);
    const tampered = parts.join('.');
    const r = await verifyToken(tampered, SESSION_SECRET, SessionPayloadSchema, NOW + 1000);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('서명 세그먼트 변조 → bad_signature', async () => {
    const token = await signSessionToken(SESSION_SECRET, PID, NOW);
    const parts = token.split('.');
    const s = parts[2]!;
    parts[2] = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const r = await verifyToken(parts.join('.'), SESSION_SECRET, SessionPayloadSchema, NOW + 1000);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('exp 만료', () => {
  it('만료된 토큰 → expired', async () => {
    // iat=0 → exp=30일(≈2.6e9) 은 NOW(1.8e12)보다 과거 → 만료.
    const token = await signSessionToken(SESSION_SECRET, PID, 0);
    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('exp 경계값: exp === now 는 만료로 처리(<= now)', async () => {
    const token = await signSessionToken(SESSION_SECRET, PID, NOW);
    const exp = NOW + SESSION_TTL_MS;
    expect((await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, exp)).ok).toBe(false);
    expect((await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, exp - 1)).ok).toBe(true);
  });

  it('exp가 숫자가 아니면 expired', async () => {
    const token = await signToken({ exp: 'soon' } as unknown as { exp: number }, SESSION_SECRET);
    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('페이로드가 객체가 아니면 expired(방어적)', async () => {
    const token = await signToken(5 as unknown as { exp: number }, SESSION_SECRET);
    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('2키 병행 검증(로테이션 7일)', () => {
  it('구키로 서명한 토큰이 [신키, 구키] 배열로 통과', async () => {
    const oldToken = await signSessionToken('OLD-secret-key', PID, NOW);
    const okBoth = await verifyToken(
      oldToken,
      ['NEW-secret-key', 'OLD-secret-key'],
      SessionPayloadSchema,
      NOW + 1000,
    );
    expect(okBoth.ok).toBe(true);
  });

  it('신키만으로는 구키 서명 토큰이 실패', async () => {
    const oldToken = await signSessionToken('OLD-secret-key', PID, NOW);
    const r = await verifyToken(oldToken, ['NEW-secret-key'], SessionPayloadSchema, NOW + 1000);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('secrets 배열의 undefined prev(로테이션 미진행)는 건너뛴다', async () => {
    const token = await signSessionToken('cur-key', PID, NOW);
    const r = await verifyToken(token, ['cur-key', undefined], SessionPayloadSchema, NOW + 1000);
    expect(r.ok).toBe(true);
  });

  it('빈 secrets 배열 → bad_signature', async () => {
    const token = await signSessionToken('cur-key', PID, NOW);
    const r = await verifyToken(token, [undefined], SessionPayloadSchema, NOW + 1000);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('스키마 거부', () => {
  it('서명·exp는 유효하나 스키마 불일치 → schema', async () => {
    // 유효 서명 + 미래 exp 지만 SessionPayload 형태가 아님(초과 필드/필수 누락).
    const token = await signToken(
      { exp: NOW + 10_000, junk: true } as unknown as { exp: number },
      SESSION_SECRET,
    );
    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'schema' });
  });
});

describe('포맷 오류', () => {
  it('분절 수 오류 / 잘못된 프리픽스 → malformed', async () => {
    expect(await verifyToken('not-a-token', SESSION_SECRET, SessionPayloadSchema, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyToken('wt2.aaa.bbb', SESSION_SECRET, SessionPayloadSchema, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('서명 세그먼트가 base64url이 아니면 malformed', async () => {
    const r = await verifyToken('wt1.abcd.@@@', SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'malformed' });
  });

  it('서명은 맞으나 페이로드가 유효 JSON이 아니면 malformed', async () => {
    // 유효 서명을 가진, 그러나 JSON이 아닌 페이로드를 수동 조립.
    const payloadB64 = bytesToBase64url(utf8ToBytes('{not valid json'));
    const signingInput = 'wt1.' + payloadB64;
    const sig = await hmacSign(SESSION_SECRET, signingInput);
    const token = signingInput + '.' + bytesToBase64url(sig);
    const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW);
    expect(r).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('성능 스모크 — 세션 검증이 병목이 아님(docs/07 WT-M1-04 acceptance)', () => {
  // [WT-M2-07 세션 조정] 판정 대상은 user CPU 상한(D29)뿐이지만, 이 it() 자체의 vitest
  // testTimeout(기본 5000ms)은 2,000회 sign+verify 왕복의 "벽시계" 소요에 걸린다 — 모노레포
  // 전체를 병렬로 돌리는 루트 `pnpm test`(워크스페이스 8개 동시 실행)에서는 코어 오버서브스크립션
  // 때문에 격리 실행 시(≈550ms)보다 벽시계가 몇 배 늘어나 5000ms를 넘겨 타임아웃 처리될 수
  // 있었다(단언 실패가 아니라 프레임워크 타임아웃 — D29가 이미 벽시계를 판정에서 제외한 것과
  // 동일한 비결정성의 다른 얼굴). 판정 로직은 그대로 두고 프레임워크 타임아웃 여유만 늘린다.
  it('생성→검증 1,000회 루프의 compute 상한', async () => {
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const token = await signSessionToken(SESSION_SECRET, PID + i, NOW);
        const r = await verifyToken(token, SESSION_SECRET, SessionPayloadSchema, NOW + 1000);
        if (!r.ok) throw new Error('unexpected verify failure');
      }
    };

    await run(1000); // JIT 워밍업(측정 구간을 hot path로).

    const cpu0 = process.cpuUsage();
    const wall0 = performance.now();
    await run(1000);
    const wallMs = performance.now() - wall0;
    const userMs = process.cpuUsage(cpu0).user / 1000;

    // 벽시계(wallMs)는 vitest 병렬 워커 오버서브스크립션(코어 수 < 동시 워커 수)에 지배되어
    // Node WebCrypto의 비동기 스케줄링과 겹쳐 크게 요동친다(실측 60~430ms) → 단언 대상에서 제외.
    // 계측 비의존적인 user CPU로 compute 상한을 건다: 1,000회 sign+verify+zod의 실제 계산량이
    // 세션 검증 병목이 아님을 확인한다(isolated 실측 ≈ 80ms user / 107ms wall — docs/07 "100ms" 취지 확인).
    // v8 커버리지 계측 하에서는 계측 JS가 user CPU를 부풀리므로 상한을 건너뛰고 완주 정확성만 확인한다.
    if (process.env.WT_VITEST_COVERAGE !== '1') {
      expect(userMs).toBeLessThan(250);
    }
    expect(wallMs).toBeGreaterThan(0);
  }, 20_000);
});
