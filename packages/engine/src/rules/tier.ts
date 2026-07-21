// spec: docs/01 §7.1 모드별 규칙 매트릭스 — 티어별 행:
//   | 티어별 | 서바이벌 | 국가당 제한: 있음 (§7.2) | 전체 제한: 없음 | 라이프: 3 | 시간초과/스킵: 라이프 −1, 해당 국가 자동 스킵 처리 |
// 제한시간은 @wt/shared time-limit 수식(첫 국가 ×2 포함)을 그대로 위임한다 — 점수/제한시간 공식
// 재구현 금지(docs/07 WT-M2-02 제약, docs/00 §11-D27). 타임아웃 = 자동 스킵이므로 엔진이 공통
// §5.5 페널티를 적용한 뒤 onSkip이 라이프를 −1 한다.
import { timeLimitMs as sharedTimeLimitMs } from '@wt/shared';
import type { ModeRules, MutableRunState } from './index';

export function tierRules(lang: 'ko' | 'en'): ModeRules {
  return {
    id: 'tier',
    lives: 3,
    timeLimitMs: (c, indexInRun) => sharedTimeLimitMs(c, indexInRun, lang),
    onSkip: (s: MutableRunState) => {
      if (s.lives !== null) s.lives -= 1;
    },
    hardCapMs: null,
  };
}
