// spec: docs/04 §5.1, docs/00 §11-D10, WT-M1-04 — pid/device_hash 파생 결정성·도메인 분리
import { describe, expect, it } from 'vitest';
import { deriveDeviceHash, derivePlayerId } from './derive';

// 테스트 픽스처 시크릿(제약: 시크릿을 테스트 픽스처 외 어디에도 상수로 두지 말 것).
const SECRET = 'test-session-secret-0123456789abcdef';
const SECRET2 = 'other-secret-fedcba9876543210';
const DEVICE_A = '11111111-2222-3333-4444-555555555555';
const DEVICE_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('derivePlayerId', () => {
  it('결정적: 같은 (secret, deviceId) → 같은 12자', async () => {
    const a = await derivePlayerId(SECRET, DEVICE_A);
    const b = await derivePlayerId(SECRET, DEVICE_A);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it('base58 알파벳(0/O/I/l 제외)만', async () => {
    const pid = await derivePlayerId(SECRET, DEVICE_A);
    expect(pid).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}$/);
  });

  it('deviceId가 다르면 pid가 다르다', async () => {
    expect(await derivePlayerId(SECRET, DEVICE_A)).not.toBe(await derivePlayerId(SECRET, DEVICE_B));
  });

  it('secret이 다르면 pid가 다르다(키 회전/유출 격리)', async () => {
    expect(await derivePlayerId(SECRET, DEVICE_A)).not.toBe(await derivePlayerId(SECRET2, DEVICE_A));
  });
});

describe('deriveDeviceHash', () => {
  it('결정적: 같은 (secret, deviceId) → 같은 해시', async () => {
    const a = await deriveDeviceHash(SECRET, DEVICE_A);
    const b = await deriveDeviceHash(SECRET, DEVICE_A);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(12);
  });

  it('deviceId가 다르면 해시가 다르다(UNIQUE 판정 근거)', async () => {
    expect(await deriveDeviceHash(SECRET, DEVICE_A)).not.toBe(
      await deriveDeviceHash(SECRET, DEVICE_B),
    );
  });

  it('같은 (secret, deviceId)라도 playerId와 device_hash는 무관("pid:" 프리픽스 도메인 분리)', async () => {
    const pid = await derivePlayerId(SECRET, DEVICE_A);
    const hash = await deriveDeviceHash(SECRET, DEVICE_A);
    // device_hash는 12자 slice가 아니므로 pid가 그 접두일 이유가 없다.
    expect(hash.startsWith(pid)).toBe(false);
  });
});
