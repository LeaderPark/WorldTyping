// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(사운드: 단일 스프라이트 + Web Audio API,
//       <audio> 태그 금지), WT-M2-07
//
// 스프라이트 레이아웃(오프셋/길이)의 단일 원천은 sprite-layout.json이다 — 이 파일은 그 JSON을
// 읽어 누적 오프셋을 계산만 한다. tooling/scripts/generate-sound-sprite.mjs가 실제 sprite.wav를
// 합성할 때도 동일 JSON을 읽으므로(레이아웃 이중 정의 없음) 오프셋이 어긋날 수 없다.
import layout from './sprite-layout.json';

export type SpriteName =
  | 'keyMech'
  | 'keyMembrane'
  | 'miss'
  | 'confirm'
  | 'checkpoint'
  | 'countdownBeep'
  | 'countdownStart';

export interface SpriteRegion {
  /** 초 단위 시작 오프셋(AudioBufferSourceNode.start(when, offset, duration)에 그대로 전달). */
  offset: number;
  duration: number;
}

/** 부팅 시 fetch할 스프라이트 자산(§8.2 "단일 스프라이트 오디오"). 실패 시 sound-manager가 무음 폴백. */
export const SPRITE_URL = '/sounds/sprite.wav';
/** 참고용 무음 자산 — 현재 코드 경로에서는 fetch하지 않는다(로딩 실패는 재생 자체를 건너뛰는
 *  방식으로 처리, §8.2 "실패 무음 폴백"). 향후 명시적 무음 프리로드가 필요해지면 이 URL을 쓴다. */
export const SILENT_FALLBACK_URL = '/sounds/silence.wav';

/** 레이아웃 JSON(이 파일 · chase-sprites.ts 등 시트별 모듈)의 최소 형태 — 이 스키마 하나로
 *  누적 오프셋 계산이 시트 무관하게 동작한다(WT-CH-07: chase-sprites.ts가 재사용). */
export interface SpriteLayout {
  regions: readonly { name: string; durationSec: number }[];
  gapSec: number;
}

/** 시트 1개(JSON)의 region[] → 누적 {offset,duration} 맵. 시트마다 독립 커서(0부터) — 시트 간
 *  이름이 겹쳐도 서로 다른 Record 타입(N)이라 혼용되지 않는다. */
export function buildSpriteMap<N extends string>(layout: SpriteLayout): Record<N, SpriteRegion> {
  let cursor = 0;
  const map = {} as Record<N, SpriteRegion>;
  for (const region of layout.regions) {
    const name = region.name as N;
    map[name] = { offset: cursor, duration: region.durationSec };
    cursor += region.durationSec + layout.gapSec;
  }
  return map;
}

/** 스프라이트명 → {offset, duration}(초). sound-manager.play()가 조회한다. */
export const SPRITE_MAP: Readonly<Record<SpriteName, SpriteRegion>> = Object.freeze(
  buildSpriteMap<SpriteName>(layout),
);

/** 스프라이트 시트 전체 길이(초) — 테스트/디버그용. */
export const SPRITE_TOTAL_DURATION_SEC = Object.values(SPRITE_MAP).reduce(
  (max, r) => Math.max(max, r.offset + r.duration),
  0,
);
