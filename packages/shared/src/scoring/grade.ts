// spec: docs/01 §6.3(PI/등급 컷), WT-M1-02 지시 2
// PI = CPM × ACC²(§6.3 — 모드·세트 길이에 무관한 개인 실력 지표).
// 등급 컷은 KV config:client의 grades가 런타임 원천이며 DEFAULT_GRADE_CONFIG는
// 그 값이 아직 없거나 페치 실패했을 때의 폴백이다(cfg 파라미터로 주입).

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface GradeConfig {
  S: number;
  A: number;
  B: number;
  C: number;
}

/** docs/01 §6.3 표의 기본 컷. KV config:client 페치 실패 시 폴백. */
export const DEFAULT_GRADE_CONFIG: Readonly<GradeConfig> = { S: 450, A: 340, B: 230, C: 120 };

/** PI = floor(CPM × ACC²). CPM은 정수, ACC는 0~1 실수를 기대한다. */
export function computePI(cpm: number, acc: number): number {
  return Math.floor(cpm * acc * acc);
}

/** PI만으로 컷 판정(완주 여부 무관). 완주 캡은 computeGrade가 별도로 적용한다. */
export function gradeFromPI(pi: number, cfg: GradeConfig = DEFAULT_GRADE_CONFIG): Grade {
  if (pi >= cfg.S) return 'S';
  if (pi >= cfg.A) return 'A';
  if (pi >= cfg.B) return 'B';
  if (pi >= cfg.C) return 'C';
  return 'D';
}

/**
 * 최종 등급. docs/01 §6.3 "미완주(서바이벌 탈락/세계일주 게임오버) 시 최대 B" —
 * PI 컷 상 S/A에 해당해도 미완주면 B로 강등한다. B 이하(C/D)는 애초에 상한보다
 * 낮으므로 완주 여부와 무관하게 그대로 유지된다.
 */
export function computeGrade(
  pi: number,
  completed: boolean,
  cfg: GradeConfig = DEFAULT_GRADE_CONFIG,
): Grade {
  const raw = gradeFromPI(pi, cfg);
  if (!completed && (raw === 'S' || raw === 'A')) return 'B';
  return raw;
}
