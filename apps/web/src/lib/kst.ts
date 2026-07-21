// spec: docs/06 §1.1(period는 KST(UTC+9) 자정 경계, periodKey `d:YYYY-MM-DD`/`w:YYYY-Www`),
//       WT-M3-06
//
// RankPage가 board_key의 periodKey를 조립하는 데만 쓰는 순수 날짜 산술이다. workers/api의
// lib/kst.ts와 알고리즘이 동일해야 같은 보드를 가리키므로(클라·서버 양쪽이 "오늘"/"이번 주"를
// 다르게 계산하면 다른 board_key를 조회하게 된다) 그 구현을 그대로 이식한다 — 판정·점수 로직이
// 아니라 캘린더 산술이라 packages/shared 판정 재사용 원칙(CLAUDE.md) 대상이 아니다. 서버가
// workers 전용 모듈이라 apps/web이 직접 import할 수 없어(의존 방향 규칙) 부득이 이식한다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** epoch ms → KST 기준 'YYYY-MM-DD'. */
export function kstDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** epoch ms → KST 기준 ISO-8601 주차 'YYYY-Www'(월요일 시작, week-year 기준). */
export function kstIsoWeek(nowMs: number = Date.now()): string {
  const shifted = new Date(nowMs + KST_OFFSET_MS);
  const d = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
