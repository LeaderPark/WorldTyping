// spec: docs/05 부록A (구현 파일 매니페스트 — constants.ts 값 목록), WT-M1-03
import { describe, expect, it } from 'vitest';
import {
  AUTOSTART_WAIT_MS,
  BOT_OFFER_MS,
  GRACE_MS,
  HARDCAP_MS,
  MAX_KPS,
  PER_COUNTRY_LIMIT_MS,
  PROGRESS_THROTTLE_MS,
  REACTION_FLOOR_MS,
  REMATCH_VOTE_MS,
  TICK_MS,
} from './constants';

describe('protocol constants (docs/05 부록A)', () => {
  it('match the appendix A values exactly', () => {
    expect(TICK_MS).toBe(250);
    expect(PROGRESS_THROTTLE_MS).toBe(100);
    expect(GRACE_MS).toBe(15_000);
    expect(HARDCAP_MS).toBe(180_000);
    expect(PER_COUNTRY_LIMIT_MS).toBe(10_000);
    expect(REACTION_FLOOR_MS).toBe(250);
    expect(MAX_KPS).toEqual({ ko: 14, en: 18 });
    expect(REMATCH_VOTE_MS).toBe(30_000);
    expect(AUTOSTART_WAIT_MS).toBe(15_000);
    expect(BOT_OFFER_MS).toBe(60_000);
  });
});
