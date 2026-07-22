// spec: docs/03 §4.3(HUD/결과 표시 포매팅 유틸), WT-M2-05
//
// 고빈도 값(입력 버퍼, 실시간 CPM, 콤보, 경과시간) 자체는 여기서 다루지 않는다 — 그 값들은
// §4.5 불변식에 따라 엔진이 DOM을 직접 갱신한다(rAF 루프, 500ms 스로틀). 이 모듈은 저빈도
// 화면(결과·랭킹·보딩패스 등)에서 쓰는 순수 포맷 함수만 제공한다.

/** ms → "m:ss" (예: 125_000 → "2:05"). 음수/NaN은 "0:00"으로 방어. */
export function formatMMSS(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** ms → 초 단위 소수(기본 소수 1자리). result.time i18n 키({seconds}초)에 그대로 꽂는다. */
export function formatSeconds(ms: number, digits = 1): number {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const factor = 10 ** digits;
  return Math.round((safeMs / 1000) * factor) / factor;
}

/** 0~1 비율 → 0~100 정수 퍼센트. hud.accuracy/result.accuracy 키에 꽂는다. */
export function formatPercent(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/** CPM 표시용 정수 반올림(계산은 항상 shared/scoring이 담당 — 이 함수는 표시 단계 반올림만). */
export function formatCpm(cpm: number): number {
  if (!Number.isFinite(cpm)) return 0;
  return Math.max(0, Math.round(cpm));
}

/**
 * unlock_id(예: "ach:first_flight", "cover:continent-asia", "stamp:tier:3:A", "tier:3")를
 * 화면에 걸 수 있는 사람이 읽는 라벨로 변환한다(WT-M5-03). 24종 업적 각각의 정식 i18n 문구
 * 카탈로그는 이 태스크 범위 밖(최종 보고 escalations 참조) — 접두사를 떼고 스네이크/콜론을
 * 공백으로 바꾼 최소 표시만 제공한다. 국가명이 아니므로 docs/02 §9 "국가명은 countries.json
 * 전용" 원칙과 무관하다.
 */
export function humanizeUnlockId(unlockId: string): string {
  const withoutPrefix = unlockId.replace(/^(ach|cover|stamp|tier):/, '');
  return withoutPrefix.replace(/[_:-]+/g, ' ').trim();
}
