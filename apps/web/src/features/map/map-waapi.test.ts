// spec: docs/03 §3.4(WAAPI 800ms 카메라 전이)·§3.5(300ms dash 드로잉), WT-M2-04.
// jsdom은 Web Animations API(element.animate)·getTotalLength를 구현하지 않으므로, 실브라우저에서만
// 도는 이 분기들을 모의 SVG 노드로 직접 커버한다(전이 후 최종 상태 확정 계약 포함).
import { describe, expect, it, vi } from 'vitest';
import { applyCamera } from './camera';
import { animateDash } from './route-layer';

function fakeGraphicsEl(withAnimate: boolean): {
  el: SVGGraphicsElement;
  animate: ReturnType<typeof vi.fn>;
  attrs: Map<string, string>;
} {
  const attrs = new Map<string, string>();
  const animate = vi.fn();
  const el = {
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    ...(withAnimate ? { animate } : {}),
  } as unknown as SVGGraphicsElement;
  return { el, animate, attrs };
}

describe('applyCamera — WAAPI 전이(§3.4)', () => {
  it('animate 지원 시 element.animate 호출 + 최종 transform 확정', () => {
    const { el, animate, attrs } = fakeGraphicsEl(true);
    applyCamera(el, { x: 10, y: 20, k: 2 }, { durationMs: 800 });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(attrs.get('transform')).toBe('translate(10 20) scale(2)');
  });
  it('immediate=true는 animate 미호출·즉시 스냅', () => {
    const { el, animate, attrs } = fakeGraphicsEl(true);
    applyCamera(el, { x: 1, y: 2, k: 3 }, { immediate: true });
    expect(animate).not.toHaveBeenCalled();
    expect(attrs.get('transform')).toBe('translate(1 2) scale(3)');
  });
  it('durationMs<=0도 animate 미호출·즉시 스냅', () => {
    const { el, animate, attrs } = fakeGraphicsEl(true);
    applyCamera(el, { x: 5, y: 5, k: 1 }, { durationMs: 0 });
    expect(animate).not.toHaveBeenCalled();
    expect(attrs.get('transform')).toBe('translate(5 5) scale(1)');
  });
  it('animate 미지원(jsdom류)도 최종 transform 세팅', () => {
    const { el, attrs } = fakeGraphicsEl(false);
    applyCamera(el, { x: 0, y: 0, k: 1 });
    expect(attrs.get('transform')).toBe('translate(0 0) scale(1)');
  });
});

function fakePath(
  len: number | 'throw',
  withAnimate: boolean,
): {
  el: SVGPathElement;
  animate: ReturnType<typeof vi.fn>;
  style: { strokeDasharray?: string; strokeDashoffset?: string };
} {
  const style: { strokeDasharray?: string; strokeDashoffset?: string } = {};
  const animate = vi.fn();
  const el = {
    style,
    getTotalLength:
      len === 'throw'
        ? () => {
            throw new Error('not implemented');
          }
        : () => len,
    ...(withAnimate ? { animate } : {}),
  } as unknown as SVGPathElement;
  return { el, animate, style };
}

describe('animateDash — dashoffset 드로잉(§3.5)', () => {
  it('길이>0·animate 지원 시 드로잉 + 최종 offset 0 확정', () => {
    const { el, animate, style } = fakePath(120, true);
    animateDash(el, 300);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(style.strokeDasharray).toBe('120');
    expect(style.strokeDashoffset).toBe('0');
  });
  it('immediate=true → 완성형(dash 제거)', () => {
    const { el, animate, style } = fakePath(120, true);
    animateDash(el, 300, true);
    expect(animate).not.toHaveBeenCalled();
    expect(style.strokeDasharray).toBe('none');
    expect(style.strokeDashoffset).toBe('0');
  });
  it('길이 0 → 완성형', () => {
    const { el, animate, style } = fakePath(0, true);
    animateDash(el, 300);
    expect(animate).not.toHaveBeenCalled();
    expect(style.strokeDasharray).toBe('none');
  });
  it('getTotalLength throw → safeLength 0 → 완성형', () => {
    const { el, style } = fakePath('throw', true);
    animateDash(el, 300);
    expect(style.strokeDasharray).toBe('none');
  });
});
