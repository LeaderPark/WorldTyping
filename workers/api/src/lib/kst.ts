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

/**
 * epoch ms → KST 기준 ISO-8601 주차 'YYYY-Www'(월요일 시작, week-year 기준 — docs/06 §1.1
 * periodKey `w:YYYY-Www`). 주차 롤오버가 연 경계와 어긋나므로 연도는 목요일이 속한 week-year를
 * 쓴다(예: 2025-12-29(월)~2026-01-04(일)은 전부 2026-W01). KST로 시프트한 뒤 UTC 게터로만
 * 계산해 로컬 타임존 함정을 피한다(kstDate와 동일 규약).
 */
export function kstIsoWeek(nowMs: number = Date.now()): string {
  const shifted = new Date(nowMs + KST_OFFSET_MS);
  const d = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
  // 이번 주의 목요일로 이동(ISO week-year 결정). getUTCDay(): 일=0..토=6 → 월=1..일=7.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
