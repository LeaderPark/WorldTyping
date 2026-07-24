// spec: docs/01 §6.1(RunStats), docs/02 §3.1(MatchState), docs/06 §1(runs.verdict, §11-D9로 canonical)
// 게임 전반의 공용 타입. 판정·점수·프로토콜·랭킹이 공유한다.

/**
 * 게임 모드. 싱글 4모드(continent/tier/worldtour + chase) + daily 챌린지 + race 멀티.
 * spec: docs/03 §5, docs/07 WT-M1-01 산출물 정의.
 * 'chase'(골드 러너)는 docs/09 §0·§13 + docs/00 §11-D90 채택 — 유니온 원천은 이 파일이며
 * (docs/09 §13의 protocol/constants.ts 표기는 D90에서 착오로 정정), auth 토큰·엔진 rules 타입은
 * 유니온 확장으로 자동 수용된다.
 */
export type GameMode = 'continent' | 'tier' | 'worldtour' | 'daily' | 'race' | 'chase';

/**
 * 매 keystroke마다 현재 입력 문자열 전체를 평가해 반환하는 3-상태.
 * spec: docs/02 §3.1 — 이 판정은 클라(즉시 피드백)와 서버(멀티 검증)가 동일 코드로 실행한다.
 */
export type MatchState =
  | 'EXACT' // acceptedInputs 중 하나와 완전 일치 → 정답 처리, 다음 국가로
  | 'PREFIX' // 어떤 acceptedInput의 접두(조합 중 포함) → 계속 입력
  | 'MISS'; // 어떤 것의 접두도 아님 → 오타 카운트 +1, 입력 필드 빨간 플래시

/** 한 국가 구간의 측정 원시값. spec: docs/01 §6.1 */
export interface PerCountryStat {
  code: string;
  ms: number;
  errors: number;
  skipped: boolean;
}

/**
 * 한 판 기준 측정 원시값. 점수·CPM·ACC·PI 계산의 입력(WT-M1-02가 소비).
 * spec: docs/01 §6.1. 타수는 자모/문자 단위(공백 제거 후 — docs/00 §11-D4).
 */
export interface RunStats {
  totalKeystrokes: number; // 정타+오타 (자모/문자 단위, docs/01 §4)
  correctKeystrokes: number;
  elapsedMs: number; // 카운트다운 종료~마지막 확정
  maxCombo: number; // 연속 "노오타·노스킵" 국가 수 최대치
  countriesCleared: number;
  countriesSkipped: number;
  perCountry: PerCountryStat[];
}

/**
 * 제출 기록(runs)의 판정 상태.
 * spec: docs/06 §1 — §11-D9로 06의 runs/lb_best 모델이 canonical이므로 04 §6.4의
 * ('verified'|'flagged'|'practice')가 아니라 06의 4-상태를 사용한다.
 */
export type RunVerdict = 'valid' | 'practice' | 'flagged' | 'rejected';
