// spec: docs/09 §8.5(상태 매트릭스 6종), WT-CH-06 acceptance("상태 매트릭스 6종").
import { describe, expect, it } from 'vitest';
import { deriveChipVisualState, type ChipStateInput } from './candidate-state';

const base: ChipStateInput = {
  matching: false,
  danger: false,
  gold: false,
  home: false,
  committed: false,
};

describe('deriveChipVisualState — §8.5 상태 매트릭스 6종 + 우선순위', () => {
  it('idle: 아무 플래그도 없으면 idle', () => {
    expect(deriveChipVisualState(base)).toBe('idle');
  });

  it('matching: 입력 prefix 진행 중', () => {
    expect(deriveChipVisualState({ ...base, matching: true })).toBe('matching');
  });

  it('danger: 경찰 점유', () => {
    expect(deriveChipVisualState({ ...base, danger: true })).toBe('danger');
  });

  it('gold: 금 보유국', () => {
    expect(deriveChipVisualState({ ...base, gold: true })).toBe('gold');
  });

  it('home: 배송지', () => {
    expect(deriveChipVisualState({ ...base, home: true })).toBe('home');
  });

  it('committed: 확정 흡수 소멸 중', () => {
    expect(deriveChipVisualState({ ...base, committed: true })).toBe('committed');
  });

  it('danger+matching 동시 → danger 우선(§8.5 "안전 정보 > 진행 피드백")', () => {
    expect(deriveChipVisualState({ ...base, danger: true, matching: true })).toBe('danger');
  });

  it('committed는 danger보다도 우선(전이 종료 국면)', () => {
    expect(deriveChipVisualState({ ...base, committed: true, danger: true })).toBe('committed');
  });

  it('matching이 gold/home보다 우선', () => {
    expect(deriveChipVisualState({ ...base, matching: true, gold: true, home: true })).toBe('matching');
  });

  it('gold가 home보다 우선', () => {
    expect(deriveChipVisualState({ ...base, gold: true, home: true })).toBe('gold');
  });
});
