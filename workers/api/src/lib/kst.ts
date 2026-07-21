// spec: docs/06 §1.1(period는 KST(UTC+9) 자정 경계)·§2.1(데일리 날짜 KST 기준)·§2.3(스트릭 KST),
//       docs/00 §11-D5(티어 시드 dateKST) + WT-M3-03
//
// 모든 데일리/티어 시드·스트릭 판정의 날짜 경계는 KST(UTC+9) 자정이다. epoch ms를 KST 날짜
// 'YYYY-MM-DD'로 환산하는 단일 원천 — 로컬 타임존/Date 파싱 함정을 피하려고 산술로만 계산한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** epoch ms → KST 기준 'YYYY-MM-DD'. */
export function kstDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 주어진 KST 날짜의 전날 'YYYY-MM-DD'(스트릭 연속성 판정용). */
export function kstYesterday(dateKst: string): string {
  const midnightUtc = Date.parse(`${dateKst}T00:00:00Z`);
  return new Date(midnightUtc - DAY_MS).toISOString().slice(0, 10);
}
