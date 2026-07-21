// spec: docs/03 §2.4 (KeystrokeAccountant 전문), docs/00 §11-D19(commonPrefixLen는 @wt/shared).
//
// 스냅샷 간 "자모 시퀀스 diff"로 타수·오타를 계상한다. keydown 카운트는 IME 조합 중 keyCode 229만
// 주므로 정타/오타 계상이 불가능하다 — diff 방식이 GDD §6 totalKeystrokes 정의의 유일한 구현이다.
// 도깨비불(받침 이월)은 자모열이 단조 증가하므로 이중 계상 없이 자동 보정된다(§2.4).
import { commonPrefixLen } from '@wt/shared';

export interface KeystrokeDelta {
  /** 이번 스냅샷에서 늘어난 자모 수 (0이면 백스페이스/무변화) */
  added: number;
  /** 이번 스냅샷에서 줄어든 자모 수 (백스페이스). 타수 미가산, 통계용 */
  removed: number;
  /** 늘어난 자모 중 정답 prefix 위로 얹힌 수 */
  addedCorrect: number;
  /** = added - addedCorrect (실제 잘못 친 자모 수, GDD §6 정의) */
  addedError: number;
}

export class KeystrokeAccountant {
  private prevJamo = '';

  reset(): void {
    this.prevJamo = '';
  }

  /**
   * curJamo: 현재 스냅샷의 자모 시퀀스 (en 모드는 normalizeEn 결과 그대로)
   * targetJamo: 현재 국가의 "최장 일치 타깃"의 자모 시퀀스
   *   (acceptedInputs 중 curJamo와 공통 prefix가 가장 긴 타깃 — matchInputDetail.bestTarget.key)
   */
  consume(curJamo: string, targetJamo: string): KeystrokeDelta {
    const common = commonPrefixLen(this.prevJamo, curJamo);
    const removed = this.prevJamo.length - common;
    const addedStr = curJamo.slice(common);
    // 새로 추가된 자모 각각이 targetJamo의 올바른 위치에 놓였는지 판정
    let addedCorrect = 0;
    for (let i = 0; i < addedStr.length; i++) {
      const pos = common + i;
      if (pos < targetJamo.length && targetJamo[pos] === addedStr[i]) addedCorrect++;
      else break; // 첫 불일치 이후는 전부 오타
    }
    this.prevJamo = curJamo;
    return {
      added: addedStr.length,
      removed,
      addedCorrect,
      addedError: addedStr.length - addedCorrect,
    };
  }
}
