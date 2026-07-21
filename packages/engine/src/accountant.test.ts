// spec: docs/03 §2.4 (KeystrokeAccountant). 자모열 diff 계상의 순수 단위 검증.
// QA 매트릭스(docs/03 §2.10) 단위 커버: #1(도깨비불 자모 단조 증가), #7(백스페이스 removed).
import { describe, expect, it } from 'vitest';
import { toJamoSeq } from '@wt/shared';
import { KeystrokeAccountant, type KeystrokeDelta } from './accountant';

/** 스냅샷 시퀀스를 순차 consume하며 delta 배열을 반환. */
function run(seq: string[], targetJamo: string): KeystrokeDelta[] {
  const acc = new KeystrokeAccountant();
  return seq.map((s) => acc.consume(s, targetJamo));
}

describe('KeystrokeAccountant', () => {
  // #1 도깨비불: "가나" 조합 스냅샷 ["ㄱ","가","간","가나"] → added 전부 1, 오타 0
  it('counts monotonic jamo growth without double-counting (도깨비불) [#1]', () => {
    const target = toJamoSeq('가나'); // ㄱㅏㄴㅏ
    const deltas = run(['ㄱ', '가', '간', '가나'].map(toJamoSeq), target);
    expect(deltas.map((d) => d.added)).toEqual([1, 1, 1, 1]);
    expect(deltas.map((d) => d.addedError)).toEqual([0, 0, 0, 0]);
    expect(deltas.map((d) => d.addedCorrect)).toEqual([1, 1, 1, 1]);
    // 간(ㄱㅏㄴ)→가나(ㄱㅏㄴㅏ) 전이: common=3, added=ㅏ 1타, removed 0 (이중 계상 없음)
    expect(deltas[3]).toMatchObject({ added: 1, removed: 0 });
  });

  // #7 백스페이스: "간"→"가"→"ㄱ" removed 계상, 오타 아님
  it('counts removed on backspace without marking error [#7]', () => {
    const target = toJamoSeq('가나');
    const deltas = run(['간', '가', 'ㄱ'].map(toJamoSeq), target);
    // 간(ㄱㅏㄴ): 최초 스냅샷 → added 3
    expect(deltas[0]).toMatchObject({ added: 3, removed: 0, addedError: 0 });
    expect(deltas[1]).toMatchObject({ added: 0, removed: 1, addedError: 0 });
    expect(deltas[2]).toMatchObject({ added: 0, removed: 1, addedError: 0 });
  });

  it('marks jamo from the first mismatch onward as error [unit]', () => {
    const acc = new KeystrokeAccountant();
    // target ㄱㅏㄴㅏ, 입력 ㄱㅏㅁ → ㄱ,ㅏ 정타, ㅁ 오타
    expect(acc.consume('ㄱㅏㅁ', 'ㄱㅏㄴㅏ')).toEqual({
      added: 3,
      removed: 0,
      addedCorrect: 2,
      addedError: 1,
    });
  });

  it('marks jamo past the target length as error [unit]', () => {
    const acc = new KeystrokeAccountant();
    acc.consume('ㄱㅏㄴㅏ', 'ㄱㅏㄴㅏ'); // 정타 4
    // pos4가 target 길이(4) 이상 → 오타
    expect(acc.consume('ㄱㅏㄴㅏㅁ', 'ㄱㅏㄴㅏ')).toEqual({
      added: 1,
      removed: 0,
      addedCorrect: 0,
      addedError: 1,
    });
  });

  it('reset() clears the previous snapshot [unit]', () => {
    const acc = new KeystrokeAccountant();
    acc.consume('ㄱㅏ', 'ㄱㅏ');
    acc.reset();
    // prev가 다시 '' → 'ㄱ'은 added 1
    expect(acc.consume('ㄱ', 'ㄱㅏ')).toEqual({
      added: 1,
      removed: 0,
      addedCorrect: 1,
      addedError: 0,
    });
  });

  it('works char-by-char on latin (en degenerate path, §2.9)', () => {
    // en 모드는 normalizeEn 결과를 그대로 자모열로 사용 → 문자 단위 diff.
    const deltas = run(['c', 'ch', 'cha', 'chad'], 'chad');
    expect(deltas.map((d) => d.added)).toEqual([1, 1, 1, 1]);
    expect(deltas.every((d) => d.addedError === 0)).toBe(true);
  });
});
