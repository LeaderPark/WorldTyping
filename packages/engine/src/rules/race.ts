// spec: docs/01 §7.1 모드별 규칙 매트릭스 — 멀티 레이스 행:
//   | 멀티 레이스 | 레이스 | 국가당 제한: 10초 고정 | 전체 제한: 180초 하드캡 | 라이프: 없음 | 10초 초과 시 자동 스킵+정확도 페널티, 180초 도달 시 전원 강제 결승 처리 |
// 값은 @wt/shared protocol 상수(PER_COUNTRY_LIMIT_MS=10_000, HARDCAP_MS=180_000)를 재사용해
// 서버(MatchRoom DO)와 단일 원천을 공유한다. 클라 엔진의 이 값들은 "로컬 표시용"이고 최종 순위·
// 판정 권위는 서버다(docs/07 WT-M2-02 지시 4, docs/03 §5.3). 라이프 없음 → onSkip no-op(정확도
// 페널티인 필요 타수 오타 계상은 엔진의 공통 §5.5 경로가 담당).
import { HARDCAP_MS, PER_COUNTRY_LIMIT_MS } from '@wt/shared';
import type { ModeRules } from './index';

export function raceRules(): ModeRules {
  return {
    id: 'race',
    lives: null,
    timeLimitMs: () => PER_COUNTRY_LIMIT_MS,
    onSkip: () => {
      // 라이프 없음 — 레이스 타임아웃/스킵은 §5.5 정확도 페널티만 받는다(엔진 적용).
    },
    hardCapMs: HARDCAP_MS,
  };
}
