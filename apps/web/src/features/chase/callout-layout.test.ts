// spec: docs/09 §8.5(배치 알고리즘 5단계)·09a §5.2, WT-CH-06 acceptance("배치 알고리즘 결정성").
import { describe, expect, it } from 'vitest';
import {
  CHIP_H,
  CHIP_W,
  GLOBE_VIEWBOX,
  chipEdgeTowardAnchor,
  computeCalloutLayout,
  fitViewBoxToContainer,
  toContainerPx,
  type CalloutAnchor,
} from './callout-layout';

const CENTER = { x: GLOBE_VIEWBOX.w / 2, y: GLOBE_VIEWBOX.h / 2 };

describe('computeCalloutLayout — 결정성(§8.5)', () => {
  it('동일 입력 → 동일 좌표(순수 함수)', () => {
    const anchors: CalloutAnchor[] = [
      { id: 'MN', x: CENTER.x, y: CENTER.y - 150 },
      { id: 'JP', x: CENTER.x + 150, y: CENTER.y + 50 },
      { id: 'KR', x: CENTER.x - 150, y: CENTER.y + 50 },
    ];
    const a = computeCalloutLayout(anchors);
    const b = computeCalloutLayout(anchors);
    expect(a).toEqual(b);
  });

  it('입력 배열 순서를 그대로 보존한다(슬롯 인덱스 안정성)', () => {
    const anchors: CalloutAnchor[] = [
      { id: 'MN', x: CENTER.x, y: CENTER.y - 150 },
      { id: 'JP', x: CENTER.x + 150, y: CENTER.y + 50 },
      { id: 'KR', x: CENTER.x - 150, y: CENTER.y + 50 },
    ];
    const out = computeCalloutLayout(anchors);
    expect(out.map((o) => o.id)).toEqual(['MN', 'JP', 'KR']);
  });

  it('충분히 떨어진 앵커는 방사상 88px 오프셋 방향으로 배치된다(각도 유지)', () => {
    // 정북(위쪽) 앵커 하나 — 중심에서 위쪽으로 방사상 이동해야 하므로 결과도 중심 위쪽(y 감소).
    const anchors: CalloutAnchor[] = [{ id: 'MN', x: CENTER.x, y: CENTER.y - 200 }];
    const [pos] = computeCalloutLayout(anchors);
    expect(pos!.x).toBeCloseTo(CENTER.x, 5);
    expect(pos!.y).toBeLessThan(CENTER.y - 200);
  });

  it('방위각 차 32° 미만인 3개는 등각 분산되어 서로 32° 이상 벌어진다', () => {
    // 세 앵커를 거의 같은 방향(정동쪽 근방, 각도차 <32°)에 배치.
    const mk = (deg: number, dist: number): CalloutAnchor => {
      const rad = (deg * Math.PI) / 180;
      return {
        id: `X${deg}`,
        x: CENTER.x + Math.cos(rad) * dist,
        y: CENTER.y + Math.sin(rad) * dist,
      };
    };
    const anchors = [mk(0, 120), mk(8, 130), mk(16, 125)];
    const out = computeCalloutLayout(anchors);
    const angleOf = (p: { x: number; y: number }) =>
      (Math.atan2(p.y - CENTER.y, p.x - CENTER.x) * 180) / Math.PI;
    const angles = out.map(angleOf).sort((a, b) => a - b);
    expect(angles[1]! - angles[0]!).toBeGreaterThanOrEqual(32 - 1e-6);
    expect(angles[2]! - angles[1]!).toBeGreaterThanOrEqual(32 - 1e-6);
  });

  it('겹치는 두 칩은 서로 밀어내어 AABB가 더 이상 겹치지 않는다(최대 2회)', () => {
    // 두 앵커를 거의 동일 위치에 둬 기본 배치 결과가 강제로 겹치게 만든다.
    const anchors: CalloutAnchor[] = [
      { id: 'A', x: CENTER.x + 100, y: CENTER.y },
      { id: 'B', x: CENTER.x + 101, y: CENTER.y + 1 },
    ];
    const [a, b] = computeCalloutLayout(anchors);
    const overlap = Math.abs(a!.x - b!.x) < CHIP_W && Math.abs(a!.y - b!.y) < CHIP_H;
    expect(overlap).toBe(false);
  });

  it('뷰포트 클램프 — 결과는 항상 [halfW, W-halfW] × [halfH, H-halfH] 안에 있다', () => {
    // 화면 끄트머리에 아주 가까운 앵커(반경 최대 근접)를 둬 클램프가 개입하게 한다.
    const anchors: CalloutAnchor[] = [{ id: 'EDGE', x: 5, y: 5 }];
    const [pos] = computeCalloutLayout(anchors);
    const hw = CHIP_W / 2;
    const hh = CHIP_H / 2;
    expect(pos!.x).toBeGreaterThanOrEqual(hw - 1e-6);
    expect(pos!.x).toBeLessThanOrEqual(GLOBE_VIEWBOX.w - hw + 1e-6);
    expect(pos!.y).toBeGreaterThanOrEqual(hh - 1e-6);
    expect(pos!.y).toBeLessThanOrEqual(GLOBE_VIEWBOX.h - hh + 1e-6);
  });

  it('빈 배열 입력 → 빈 결과(방어적)', () => {
    expect(computeCalloutLayout([])).toEqual([]);
  });
});

describe('chipEdgeTowardAnchor — 리더 라인 칩쪽 끝점', () => {
  it('앵커가 정확히 위쪽에 있으면 끝점은 칩의 상단 변 중앙', () => {
    const center = { x: 100, y: 100 };
    const anchor = { x: 100, y: 0 };
    const edge = chipEdgeTowardAnchor(center, anchor);
    expect(edge.x).toBeCloseTo(100, 5);
    expect(edge.y).toBeCloseTo(100 - CHIP_H / 2, 5);
  });

  it('앵커가 정확히 오른쪽에 있으면 끝점은 칩의 우측 변 중앙', () => {
    const center = { x: 100, y: 100 };
    const anchor = { x: 500, y: 100 };
    const edge = chipEdgeTowardAnchor(center, anchor);
    expect(edge.x).toBeCloseTo(100 + CHIP_W / 2, 5);
    expect(edge.y).toBeCloseTo(100, 5);
  });

  it('앵커==중심(축퇴)이면 중심 그대로 반환', () => {
    const center = { x: 50, y: 50 };
    expect(chipEdgeTowardAnchor(center, center)).toEqual(center);
  });
});

describe('fitViewBoxToContainer / toContainerPx — xMidYMid meet 매핑', () => {
  it('컨테이너가 viewBox와 정확히 같으면 scale=1, offset=0', () => {
    const fit = fitViewBoxToContainer(GLOBE_VIEWBOX.w, GLOBE_VIEWBOX.h);
    expect(fit).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(toContainerPx({ x: 480, y: 250 }, fit)).toEqual({ x: 480, y: 250 });
  });

  it('가로로 더 넓은 컨테이너는 좌우 레터박스(offsetX>0)를 만든다', () => {
    const fit = fitViewBoxToContainer(1920, 500);
    expect(fit.scale).toBeCloseTo(1, 5);
    expect(fit.offsetX).toBeGreaterThan(0);
    expect(fit.offsetY).toBeCloseTo(0, 5);
  });

  it('컨테이너 크기 0(레이아웃 전, jsdom 등) → scale 0, 안전 폴백', () => {
    const fit = fitViewBoxToContainer(0, 0);
    expect(fit.scale).toBe(0);
    expect(toContainerPx({ x: 480, y: 250 }, fit)).toEqual({ x: 0, y: 0 });
  });
});
