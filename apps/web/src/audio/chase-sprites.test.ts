// spec: docs/09 §7.8(chase SFX 총괄표 — 신규 ≤9종), WT-CH-07.
import { describe, expect, it } from 'vitest';
import {
  CHASE_SPRITE_MAP,
  CHASE_SPRITE_TOTAL_DURATION_SEC,
  CHASE_SPRITE_URL,
  type ChaseSpriteName,
} from './chase-sprites';

const EXPECTED_NAMES: ChaseSpriteName[] = [
  'chaseAlarmBeep',
  'chaseGlassShatter',
  'chaseSirenDoppler',
  'chaseRadioStatic',
  'chaseHeartbeat',
  'chaseGoldCoin',
  'chaseVaultClunk',
  'chaseCaperFanfare',
  'chaseHandcuffs',
];

describe('chase-sprites', () => {
  it('exposes exactly the 9 new chase SFX regions(§7.8 "신규 ≤9종")', () => {
    expect(Object.keys(CHASE_SPRITE_MAP).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('regions are laid out back-to-back with non-negative, non-overlapping offsets', () => {
    const regions = EXPECTED_NAMES.map((n) => CHASE_SPRITE_MAP[n]);
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

  it('CHASE_SPRITE_URL points at a distinct asset from the 5-mode shared sprite', () => {
    expect(CHASE_SPRITE_URL).toBe('/sounds/chase-sprite.wav');
  });

  it('total duration stays small (자체 합성 톤 — chase 전용 시트, 논-chase 플레이어는 fetch하지 않음)', () => {
    expect(CHASE_SPRITE_TOTAL_DURATION_SEC).toBeGreaterThan(0);
    expect(CHASE_SPRITE_TOTAL_DURATION_SEC).toBeLessThan(4);
  });
});
