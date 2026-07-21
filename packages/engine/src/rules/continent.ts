// spec: docs/01 §7.1 모드별 규칙 매트릭스 — 대륙별 행:
//   | 대륙별 | 타임어택 | 국가당 제한: 없음 | 전체 제한: 없음 (시간=점수 요인) | 라이프: 없음 | 스킵만 존재 → §5.5 페널티 |
// 라이프·제한시간·하드캡이 전부 없는 순수 타임어택. 스킵 시 공통 §5.5 페널티(콤보 0/필요 타수 오타/
// 국가 점수 0)는 엔진이 적용하고, 라이프가 없으므로 onSkip은 no-op이다.
import type { ModeRules } from './index';

export function continentRules(): ModeRules {
  return {
    id: 'continent',
    lives: null,
    timeLimitMs: () => null,
    onSkip: () => {
      // 라이프 없음 — 대륙별 스킵은 §5.5 공통 페널티만 받는다(엔진 적용).
    },
    hardCapMs: null,
  };
}
