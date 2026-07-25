// spec: docs/09-chase-mode-goldrunner.md §7.8(SFX 총괄표 — 신규 ≤9종), docs/00 §11-D96, WT-CH-07.
//
// [설계 결정 — 별도 시트, 최종 보고 기재] sprites.ts(기존 5모드 공용 sprite.wav, 7리전)를 직접
// 확장하지 않고 chase 전용 2번째 시트(chase-sprite.wav)를 둔다. 이유: sprite-layout.json은
// sprites.ts가 정적 import하고, sprites.ts는 GamePage(모든 싱글 모드가 거치는 라우트 청크)가
// useSoundManager를 통해 이미 로드하는 공용 인프라다 — 여기에 chase 전용 9리전(≈2초 분량 합성
// 톤)을 얹으면 chase를 플레이하지 않는 4개 모드 플레이어까지 더 큰 sprite.wav를 받는다(docs/09
// §11 "chase 관련 코드·chase-graph·신규 SFX는 전부 /play/chase 라우트 청크로 분리 — entry 불변"의
// 취지를 오디오 자산에도 연장 적용했다). 이 시트는 sound-manager.ts의 지연 로더(ensureChaseLoaded,
// playChase* 최초 호출 시에만 fetch)가 별도로 로드하므로, chase를 플레이하지 않는 세션은 이 파일이
// import하는 chase-sprite-layout.json조차 실행 시 fetch되지 않는다(모듈 자체는 이 파일을 가리키는
// 코드 경로(chase-audio.ts)가 실제로 import될 때만 번들에 포함 — CH-08이 mode==='chase' 분기에서만
// 이 경로를 다이나믹 import하는 것이 전제, 최종 보고 참조).
//
// buildSpriteMap 제네릭(sprites.ts)을 재사용 — 오프셋 계산 로직 재구현 아님(레이아웃 이중 정의 없음).
import layout from './chase-sprite-layout.json';
import { buildSpriteMap, type SpriteRegion } from './sprites';

export type ChaseSpriteName =
  | 'chaseAlarmBeep'
  | 'chaseGlassShatter'
  | 'chaseSirenDoppler'
  | 'chaseRadioStatic'
  | 'chaseHeartbeat'
  | 'chaseGoldCoin'
  | 'chaseVaultClunk'
  | 'chaseCaperFanfare'
  | 'chaseHandcuffs';

/** chase 전용 스프라이트 자산 — sound-manager.ts가 첫 playChase*() 호출 시점에만 지연 fetch한다
 *  (전역 첫 제스처 unlock()과 별개 — 그때 이미 fetch되는 sprite.wav와 달리 chase 플레이 시작 전엔
 *  네트워크를 쓰지 않는다). */
export const CHASE_SPRITE_URL = '/sounds/chase-sprite.wav';

export const CHASE_SPRITE_MAP: Readonly<Record<ChaseSpriteName, SpriteRegion>> = Object.freeze(
  buildSpriteMap<ChaseSpriteName>(layout),
);

/** 스프라이트 시트 전체 길이(초) — 테스트/디버그·재생성 결정성 확인용. */
export const CHASE_SPRITE_TOTAL_DURATION_SEC = Object.values(CHASE_SPRITE_MAP).reduce(
  (max, r) => Math.max(max, r.offset + r.duration),
  0,
);
