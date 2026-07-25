// spec: docs/09-chase-mode-goldrunner.md §8.5(상태 매트릭스 — 칩 테두리+리더 라인 이중 부호화),
//       docs/09a-chase-ui-ux-globe-centric.md §5.3, docs/00 §11-D90~D97, WT-CH-06.
//
// 콜아웃 칩 1개의 시각 상태(§8.5 표 6종) 우선순위 해석 — 표시 전용 순수 함수. 판정 로직 무관.
export type ChipVisualState = 'idle' | 'matching' | 'danger' | 'gold' | 'home' | 'committed';

export interface ChipStateInput {
  /** 입력 prefix가 이 후보의 acceptedInputs 중 하나와 일치 진행 중(§8.5 "matching"). */
  matching: boolean;
  /** 경찰이 이 후보국을 점유(candidateDangerChanged/candidatesShown.danger). */
  danger: boolean;
  /** 이 후보국에 금이 있음(goldSpawned~goldPicked 사이). */
  gold: boolean;
  /** 이 후보국이 홈(배송지)이다. */
  home: boolean;
  /** 방금 확정되어 흡수 소멸 애니메이션 중(hopCommitted.to === 이 후보). */
  committed: boolean;
}

/**
 * §8.5 상태 매트릭스 우선순위: committed(확정, 전이 진행 중이면 다른 무엇보다 우선) >
 * danger(안전 정보 > 진행 피드백 — "danger+matching 동시엔 danger 우선") > matching > gold > home > idle.
 */
export function deriveChipVisualState(input: ChipStateInput): ChipVisualState {
  if (input.committed) return 'committed';
  if (input.danger) return 'danger';
  if (input.matching) return 'matching';
  if (input.gold) return 'gold';
  if (input.home) return 'home';
  return 'idle';
}
