// spec: docs/03 §5.2 (ModeRules 전략 객체), docs/01 §7.1 (모드별 규칙 매트릭스),
//       docs/07 WT-M2-02 지시 4 (규칙 5종 1:1 코드화), docs/00 §11-D2 (worldtour 50개국·체크포인트).
//
// ModeRules는 세션 엔진(session.ts)이 모드별 라이프/제한시간/스킵정책/하드캡/체크포인트를
// 위임받는 전략 객체다. GDD §5.5 공통 스킵 페널티(콤보 0·필요 타수 전량 오타 계상·국가 점수 0)는
// 전 모드 공통이라 엔진이 적용하고, onSkip은 모드별로만 갈리는 "라이프 정책"만 캡슐화한다.
import type { Country, GameMode } from '@wt/shared';
import { continentRules } from './continent';
import { tierRules } from './tier';
import { worldtourRules } from './worldtour';
import { dailyRules } from './daily';
import { raceRules } from './race';
import { chaseRules } from './chase';

/**
 * onSkip이 변경할 수 있는 최소 런 상태 뷰. 엔진의 내부 상태 객체가 이 형태를 만족해
 * 그대로 전달된다(onSkip이 lives를 감소시키면 엔진이 되읽는다).
 */
export interface MutableRunState {
  /** 현재 남은 라이프. null이면 라이프 없는 모드(대륙/레이스). */
  lives: number | null;
}

/** spec: docs/03 §5.2. GDD §7.1 매트릭스를 이 인터페이스의 구현 5종으로 1:1 코드화한다. */
export interface ModeRules {
  id: GameMode; // 'continent'|'tier'|'worldtour'|'daily'|'race'
  lives: number | null;
  /** 국가 i(indexInRun 0-based)의 제한시간(ms). null이면 국가당 제한 없음. */
  timeLimitMs(c: Country, indexInRun: number): number | null;
  /** 스킵/타임아웃 시 라이프 정책(모드별). 공통 페널티는 엔진이 적용한다(GDD §5.5). */
  onSkip(s: MutableRunState): void;
  /** race: 180_000. 그 외 null(전체 제한 없음). */
  hardCapMs: number | null;
  /** worldtour: [10,20,30,40] (종착 50은 완주 = 체크포인트 아님, docs/00 §11-D2). */
  checkpoints?: number[];
}

/**
 * 모드 → ModeRules. lang은 서바이벌 제한시간 수식(첫 국가 ×2 포함)에 필요하므로 생성 시 고정한다
 * (ModeRules.timeLimitMs 시그니처에 lang이 없어 여기서 바인딩). 엔진 ctor의 lang과 일치시켜야 한다.
 */
export function createModeRules(mode: GameMode, lang: 'ko' | 'en'): ModeRules {
  switch (mode) {
    case 'continent':
      return continentRules();
    case 'tier':
      return tierRules(lang);
    case 'worldtour':
      return worldtourRules();
    case 'daily':
      return dailyRules(lang);
    case 'race':
      return raceRules();
    // WT-CH-04: chase의 실질 오케스트레이션은 ChaseSessionEngine(chase-session.ts)이며 chaseRules()를
    // 직접 사용한다 — 이 팩토리를 경유하지 않는다. 그럼에도 여기서 조정 스텁(throw)을 얇은 실객체
    // 반환으로 정제한다: 'chase'는 유효한 GameMode이므로 팩토리가 valid GameMode에 throw하는 지뢰를
    // 남기지 않는다(다른 5종과 동일하게 total). 반환값은 ChaseSessionEngine이 쓰는 것과 동일한 얇은
    // ModeRules라 두 경로가 일관된다.
    case 'chase':
      return chaseRules();
  }
}

export { continentRules, tierRules, worldtourRules, dailyRules, raceRules, chaseRules };
