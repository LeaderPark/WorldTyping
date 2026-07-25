// spec: docs/09 §6.2("rules/chase.ts는 ModeRules 형식 충족용 얇은 객체"), docs/00 §11-D90(chase 채택)·
//       D95(chase 스킵 부재·일시정지 부재), docs/01 §7.1(모드 규칙 매트릭스), WT-CH-04.
//
// "골드 러너"(chase)의 ModeRules 어댑터. 실질 오케스트레이션은 ChaseSessionEngine(chase-session.ts)이
// 전담하고, 이 객체는 기존 5종 레지스트리(createModeRules)·결과 화면 모드 분기와의 **타입 호환**만
// 담당하는 얇은 껍데기다(docs/09 §6.2). chase는 라이프·국가당 제한시간·전체 하드캡·스킵이 전부 없다
// (D95: 선택지 3장이 스킵을 구조적으로 대체 — pause·skip 부재). 따라서 continent/race와 동일한
// no-op onSkip 형태를 취한다.
import type { ModeRules, MutableRunState } from './index';

export function chaseRules(): ModeRules {
  return {
    id: 'chase',
    // 무한 생존형 — 체포가 유일한 종료(docs/09 §3.7). 라이프·제한시간·하드캡 없음.
    lives: null,
    timeLimitMs: () => null,
    onSkip: (_s: MutableRunState) => {
      // D95: chase에 스킵 없음. ChaseSessionEngine은 skipRequested TypingEvent를 no-op으로 흡수하므로
      // (chase-session.ts handleInput) 이 콜백은 chase 실행 경로에서 호출되지 않는다. GameSessionEngine
      // 경유 오사용을 대비해 prod-safe no-op으로 둔다(throw 시 오사용이 크래시가 되므로 no-op이 안전).
    },
    hardCapMs: null,
  };
}
