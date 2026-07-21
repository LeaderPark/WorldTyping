// spec: docs/01 §7.1 모드별 규칙 매트릭스 — 데일리 챌린지 행:
//   | 데일리 챌린지 | 서바이벌 변형 | 국가당 제한: 있음 (§7.2, tier=출제국 티어) | 전체 제한: 없음 | 라이프: 1 | 라이프 0 → 즉시 종료, 그 시점 기록 확정 |
// 티어 모드와 동일한 @wt/shared 제한시간 수식(첫 국가 ×2 포함)을 위임하되 라이프가 1이라
// 첫 스킵/타임아웃에 즉시 게임오버된다(엔진의 라이프 0 종료 경로). 점수 공식 재구현 금지.
import { timeLimitMs as sharedTimeLimitMs } from '@wt/shared';
import type { ModeRules, MutableRunState } from './index';

export function dailyRules(lang: 'ko' | 'en'): ModeRules {
  return {
    id: 'daily',
    lives: 1,
    timeLimitMs: (c, indexInRun) => sharedTimeLimitMs(c, indexInRun, lang),
    onSkip: (s: MutableRunState) => {
      if (s.lives !== null) s.lives -= 1;
    },
    hardCapMs: null,
  };
}
