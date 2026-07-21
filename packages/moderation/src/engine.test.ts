// spec: docs/06 §4.2 (필터 파이프라인), WT-M3-05 구현 세부 지시 5(로더 주입형 리팩터)
//
// createFilter(engine.ts)는 filter.ts(Node 기본 로더)가 쓰는 것과 동일한 판정 로직을 lists
// 주입만으로 재현해야 한다 — 이 테스트는 그 동등성과, 주입된 목록 밖의 단어는 걸리지 않는다는
// (즉 하드코딩된 사전이 남아있지 않다는) 경계를 함께 확인한다.
import { describe, expect, it } from 'vitest';
import { createFilter } from './engine';

describe('createFilter (WT-M3-05 injectable loader)', () => {
  it('blocks a ko badword supplied via injected lists (jamo substring match)', () => {
    const engine = createFilter({ ko: ['시발'], en: [], allow: [] });
    expect(engine.evaluateText('시발').blocked).toBe(true);
    expect(engine.evaluateText('시-발').blocked).toBe(true); // 구분자 우회도 여전히 차단
  });

  it('blocks an en badword supplied via injected lists, honoring the allowlist', () => {
    const engine = createFilter({ ko: [], en: ['ass'], allow: ['assassin'] });
    expect(engine.evaluateText('assassin').blocked).toBe(false); // allowlist 예외
    expect(engine.evaluateText('kickass').blocked).toBe(true);
  });

  it('does not block a word absent from the injected lists (no hidden default dictionary)', () => {
    const engine = createFilter({ ko: [], en: [], allow: [] });
    expect(engine.evaluateText('시발').blocked).toBe(false);
    expect(engine.evaluateText('fuck').blocked).toBe(false);
  });

  it('still enforces reserved prefixes regardless of injected lists (policy constant, not data)', () => {
    const engine = createFilter({ ko: [], en: [], allow: [] });
    expect(engine.evaluateText('admin_x').reason).toBe('reserved');
    expect(engine.evaluateText('GUEST_1234').reason).toBe('reserved');
  });

  it('filterChat masks the matched span using the injected lists', () => {
    const engine = createFilter({ ko: [], en: ['fuck'], allow: [] });
    const result = engine.filterChat('fuck you');
    expect(result.blocked).toBe(true);
    expect(result.masked).not.toBe('fuck you');
    expect(result.masked).toContain('*');
  });

  it('two independently created engines with the same lists agree on every verdict', () => {
    const lists = { ko: ['개새끼'], en: ['shit'], allow: [] };
    const a = createFilter(lists);
    const b = createFilter(lists);
    for (const text of ['개새끼', '개-새끼', 'sh1t', 'hello', '안녕하세요']) {
      expect(a.evaluateText(text).blocked).toBe(b.evaluateText(text).blocked);
    }
  });
});
