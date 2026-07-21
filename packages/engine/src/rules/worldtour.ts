// spec: docs/01 §7.1 모드별 규칙 매트릭스 — 세계일주 행:
//   | 세계일주 | 타임어택+라이프 | 국가당 제한: 없음 | 전체 제한: 없음 | 라이프: 3 | 스킵 시 라이프 −1. 라이프 0 → 게임오버(체크포인트 이어하기 1회) |
// 체크포인트는 [10,20,30,40] + 종착(50) — docs/00 §11-D2 확정(50개국 기준 10개국 간격).
// 종착(50)은 "완주"이지 체크포인트 이벤트가 아니므로 checkpoints 배열에 넣지 않는다.
// 라이프 0 게임오버 후 마지막 통과 체크포인트에서 이어하기 1회는 엔진 resumeFromCheckpoint()가 담당.
import type { ModeRules, MutableRunState } from './index';

export function worldtourRules(): ModeRules {
  return {
    id: 'worldtour',
    lives: 3,
    timeLimitMs: () => null,
    onSkip: (s: MutableRunState) => {
      if (s.lives !== null) s.lives -= 1;
    },
    hardCapMs: null,
    checkpoints: [10, 20, 30, 40],
  };
}
