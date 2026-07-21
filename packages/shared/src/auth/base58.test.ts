// spec: WT-M1-04 — base58 왕복 + 선행 0 보존 + 오류 케이스
import { describe, expect, it } from 'vitest';
import { base58ToBytes, bytesToBase58 } from './base58';

describe('base58 왕복', () => {
  it('빈 입력', () => {
    expect(bytesToBase58(Uint8Array.from([]))).toBe('');
    expect([...base58ToBytes('')]).toEqual([]);
  });

  it('임의 길이 바이트 왕복', () => {
    for (let len = 1; len <= 40; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 53 + 17) & 0xff);
      const enc = bytesToBase58(bytes);
      expect([...base58ToBytes(enc)]).toEqual([...bytes]);
    }
  });

  it('선행 0 바이트는 앞자리 "1"로 보존된다', () => {
    const bytes = Uint8Array.from([0, 0, 0, 5, 9]);
    const enc = bytesToBase58(bytes);
    expect(enc.startsWith('111')).toBe(true);
    expect([...base58ToBytes(enc)]).toEqual([0, 0, 0, 5, 9]);
  });

  it('전부 0 바이트', () => {
    expect(bytesToBase58(Uint8Array.from([0, 0]))).toBe('11');
    expect([...base58ToBytes('11')]).toEqual([0, 0]);
  });

  it('알려진 벡터: [0] → "1"', () => {
    expect(bytesToBase58(Uint8Array.from([0]))).toBe('1');
  });

  it('알파벳(0/O/I/l 제외)만 산출한다', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 91 + 3) & 0xff);
    const enc = bytesToBase58(bytes);
    expect(enc).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
    expect(enc).not.toMatch(/[0OIl]/);
  });
});

describe('base58 오류', () => {
  it('알파벳 밖 문자는 throw', () => {
    expect(() => base58ToBytes('0OIl')).toThrow(/character/);
    expect(() => base58ToBytes('abc$')).toThrow(/character/);
  });
});
