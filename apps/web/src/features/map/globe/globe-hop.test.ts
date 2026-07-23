// spec: docs/03 §3.7(지구본 홉 수학, 00 §11-D67), WT-DC-08 acceptance 4번(globe-hop 단위).
// 순수 수학 — DOM 불필요(node 환경). bearing 사분면·duration clamp·아크 결정성·isFrontFacing.
import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  easeInOutCubic,
  hopDurationMs,
  isFrontFacing,
  sampleArc,
  type LngLat,
} from './globe-hop';

describe('easeInOutCubic', () => {
  it('경계·중점', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('bearingDeg — 나침반 사분면(0=북, +90=동, -90=서, ±180=남)', () => {
  const o: LngLat = [0, 0];
  it('동쪽 ≈ +90', () => {
    expect(bearingDeg(o, [10, 0])).toBeCloseTo(90, 6);
  });
  it('북쪽 ≈ 0', () => {
    expect(bearingDeg(o, [0, 10])).toBeCloseTo(0, 6);
  });
  it('서쪽 ≈ -90', () => {
    expect(bearingDeg(o, [-10, 0])).toBeCloseTo(-90, 6);
  });
  it('남쪽 ≈ ±180', () => {
    expect(Math.abs(bearingDeg(o, [0, -10]))).toBeCloseTo(180, 6);
  });
  it('북동 1사분면(0~90 사이)', () => {
    const b = bearingDeg(o, [10, 10]);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(90);
  });
});

describe('hopDurationMs — clamp(550 + 400·(각거리/π), 550, 900)', () => {
  it('같은 지점 = 최소 550', () => {
    expect(hopDurationMs([0, 0], [0, 0])).toBe(550);
  });
  it('90° 거리 ≈ 750', () => {
    expect(hopDurationMs([0, 0], [90, 0])).toBeCloseTo(750, 3);
  });
  it('대척점(π) = 900 클램프', () => {
    expect(hopDurationMs([0, 0], [180, 0])).toBe(900);
  });
  it('항상 [550, 900] 범위', () => {
    for (const [a, b] of [
      [[0, 0], [1, 1]],
      [[120, -40], [-30, 60]],
      [[179, 0], [-179, 0]],
    ] as [LngLat, LngLat][]) {
      const d = hopDurationMs(a, b);
      expect(d).toBeGreaterThanOrEqual(550);
      expect(d).toBeLessThanOrEqual(900);
    }
  });
});

describe('sampleArc — geoInterpolate 결정성', () => {
  it('기본 64점, 첫 점=a·끝 점=b', () => {
    const a: LngLat = [10, 20];
    const b: LngLat = [120, -30];
    const arc = sampleArc(a, b);
    expect(arc).toHaveLength(64);
    const first = arc[0]!;
    const last = arc[63]!;
    expect(first[0]).toBeCloseTo(a[0], 6);
    expect(first[1]).toBeCloseTo(a[1], 6);
    expect(last[0]).toBeCloseTo(b[0], 6);
    expect(last[1]).toBeCloseTo(b[1], 6);
  });
  it('동일 입력 → 동일 배열(결정적)', () => {
    const a: LngLat = [0, 0];
    const b: LngLat = [90, 45];
    expect(sampleArc(a, b)).toEqual(sampleArc(a, b));
  });
  it('n 지정 가능', () => {
    expect(sampleArc([0, 0], [10, 0], 8)).toHaveLength(8);
  });
});

describe('isFrontFacing — 카메라 중심 각거리 < π/2', () => {
  const center: LngLat = [0, 0];
  it('중심 자신은 정면', () => {
    expect(isFrontFacing([0, 0], center)).toBe(true);
  });
  it('80° 이내는 정면', () => {
    expect(isFrontFacing([80, 0], center)).toBe(true);
  });
  it('100°는 뒷면', () => {
    expect(isFrontFacing([100, 0], center)).toBe(false);
  });
  it('대척점은 뒷면', () => {
    expect(isFrontFacing([180, 0], center)).toBe(false);
  });
});
