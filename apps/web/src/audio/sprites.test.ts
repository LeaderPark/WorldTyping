// spec: docs/03 §8.2(사운드 스프라이트), WT-M2-07
import { describe, expect, it } from 'vitest';
import { SPRITE_MAP, SPRITE_TOTAL_DURATION_SEC, SPRITE_URL, type SpriteName } from './sprites';

const EXPECTED_NAMES: SpriteName[] = [
  'keyMech',
  'keyMembrane',
  'miss',
  'confirm',
  'checkpoint',
  'countdownBeep',
  'countdownStart',
];

describe('sprites', () => {
  it('exposes exactly the 7 regions the sound table needs (§13.1: 정타×2·오타·확정·체크포인트·카운트다운×2)', () => {
    expect(Object.keys(SPRITE_MAP).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('regions are laid out back-to-back with non-negative, non-overlapping offsets', () => {
    const regions = EXPECTED_NAMES.map((n) => SPRITE_MAP[n]);
    for (const r of regions) {
      expect(r.offset).toBeGreaterThanOrEqual(0);
      expect(r.duration).toBeGreaterThan(0);
    }
    const sorted = [...regions].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      expect(cur.offset).toBeGreaterThanOrEqual(prev.offset + prev.duration);
    }
  });

  it('SPRITE_URL points at the committed public asset path', () => {
    expect(SPRITE_URL).toBe('/sounds/sprite.wav');
  });

  it('total duration is small (sprite budget, docs/03 §8.2 "합계 ~150KB")', () => {
    expect(SPRITE_TOTAL_DURATION_SEC).toBeGreaterThan(0);
    expect(SPRITE_TOTAL_DURATION_SEC).toBeLessThan(3);
  });
});
