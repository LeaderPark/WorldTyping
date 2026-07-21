// spec: docs/01 §6.3(PI/등급 컷), WT-M1-02 acceptance (e)
import { describe, expect, it } from 'vitest';
import { computeGrade, computePI, DEFAULT_GRADE_CONFIG, gradeFromPI } from './grade';

describe('computePI — PI = floor(CPM × ACC²) (docs/01 §6.3)', () => {
  it('ACC=1이면 PI=CPM', () => {
    expect(computePI(500, 1)).toBe(500);
    expect(computePI(0, 1)).toBe(0);
  });
  it('ACC<1이면 제곱으로 강하게 감쇠', () => {
    expect(computePI(450, 0.9)).toBe(Math.floor(450 * 0.9 * 0.9)); // 364
    expect(computePI(600, 0.81)).toBe(Math.floor(600 * 0.81 * 0.81)); // 393
  });
  it('소수점은 버림(floor)', () => {
    expect(computePI(451, 0.999)).toBe(Math.floor(451 * 0.999 * 0.999));
  });
});

describe('gradeFromPI — 컷 경계값 (docs/01 §6.3 표, WT-M1-02 acceptance (e))', () => {
  it('PI 449 → A, PI 450 → S', () => {
    expect(gradeFromPI(449)).toBe('A');
    expect(gradeFromPI(450)).toBe('S');
  });
  it('나머지 컷 경계도 표대로: 339/340(B/A), 229/230(C/B), 119/120(D/C)', () => {
    expect(gradeFromPI(339)).toBe('B');
    expect(gradeFromPI(340)).toBe('A');
    expect(gradeFromPI(229)).toBe('C');
    expect(gradeFromPI(230)).toBe('B');
    expect(gradeFromPI(119)).toBe('D');
    expect(gradeFromPI(120)).toBe('C');
  });
  it('cfg 주입 시 그 컷을 사용한다(KV config:client 런타임 원천, 기본값은 폴백)', () => {
    const cfg = { S: 100, A: 90, B: 80, C: 70 };
    expect(gradeFromPI(100, cfg)).toBe('S');
    expect(gradeFromPI(99, cfg)).toBe('A');
    expect(gradeFromPI(0, cfg)).toBe('D');
  });
});

describe('computeGrade — 미완주 캡(docs/01 §6.3 "미완주 시 최대 B")', () => {
  it('완주 시 S/A는 원래대로', () => {
    expect(computeGrade(500, true)).toBe('S');
    expect(computeGrade(400, true)).toBe('A');
  });
  it('미완주면 S/A가 B로 강등된다', () => {
    expect(computeGrade(500, false)).toBe('B');
    expect(computeGrade(400, false)).toBe('B');
  });
  it('미완주라도 B 이하(C/D)는 강등 없이 그대로', () => {
    expect(computeGrade(300, false)).toBe('B');
    expect(computeGrade(150, false)).toBe('C');
    expect(computeGrade(50, false)).toBe('D');
  });
  it('완주 여부와 무관하게 C/D는 동일', () => {
    expect(computeGrade(150, true)).toBe('C');
    expect(computeGrade(50, true)).toBe('D');
  });
});

describe('DEFAULT_GRADE_CONFIG', () => {
  it('docs/01 §6.3 표의 기본 컷과 일치', () => {
    expect(DEFAULT_GRADE_CONFIG).toEqual({ S: 450, A: 340, B: 230, C: 120 });
  });
});
