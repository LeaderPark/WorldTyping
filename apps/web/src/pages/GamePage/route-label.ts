// spec: docs/01 §10.2(S5 보딩패스·S7 결과의 노선/모드 라벨), WT-M2-06
//
// BoardingPass(S5)·ResultView(S7)가 공유하는 "모드 → 표시 라벨" 헬퍼. i18n 카탈로그 키 조합만
// 하고 문자열을 하드코딩하지 않는다(CLAUDE.md "UI 문자열 하드코딩 금지"). GameMode.race는 이
// 화면에 도달하지 않지만(useGameSession이 거부) 스위치 완전성을 위해 폴백을 둔다.
import type { GameMode } from '@wt/shared';

export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** 보딩패스/결과 카드 상단에 쓰는 노선·모드 표시 라벨. */
export function describeRouteLabel(mode: GameMode, trackId: string, count: number, t: TFn): string {
  switch (mode) {
    case 'continent':
      return t('route.list.name', { continent: t(`continent.${trackId}`), count });
    case 'tier':
      return t('mode.tier.desc', { tier: trackId });
    case 'worldtour':
      return t('mode.worldtour.title');
    case 'daily':
      return t('home.daily.title');
    case 'race':
      return t('menu.multi');
    case 'chase':
      return t('chase.mode.title'); // [WT-CH 조정 스텁] chase 라벨 — WT-CH-06(i18n)/CH-08 정제
  }
}

/** 보딩패스 "규칙: {ruleType}" 줄의 i18n 키(docs/01 §7.1 모드별 규칙 매트릭스 용어 그대로). */
export function ruleTypeKey(mode: GameMode): string {
  switch (mode) {
    case 'continent':
      return 'boarding.ruleType.continent';
    case 'tier':
      return 'boarding.ruleType.tier';
    case 'worldtour':
      return 'boarding.ruleType.worldtour';
    case 'daily':
    case 'race':
    case 'chase':
      return 'boarding.ruleType.daily'; // [WT-CH 조정 스텁] chase는 자체 브리핑 — 이 라인 미사용, WT-CH-08 정제
  }
}
