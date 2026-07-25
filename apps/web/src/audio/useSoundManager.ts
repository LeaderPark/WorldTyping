// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(사운드 스프라이트 전략), WT-M2-07 구현 세부
//       지시 3("사운드 매니저: 엔진 이벤트 구독")
//
// GamePage(세션 소유자)가 엔진/컨트롤러 생명주기와 함께 마운트하는 얇은 배선 훅. 컨트롤러는
// HiddenTypingInput ref가 부착된 뒤에야 존재하므로(useTypingEngine), null인 동안은 아무것도
// 하지 않는다 — 컨트롤러가 나타나면 그 시점부터 바인딩한다.
import { useEffect } from 'react';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import { useSettingsStore } from '../stores/settings';
import { getSoundManager, type SoundSettingsSnapshot } from './sound-manager';

/** 설정 스토어 스냅샷 읽기(getState — 구독 아님, 재생 시점마다 최신값). WT-CH-07이
 *  features/chase/chase-audio.ts에서 재사용(동일 SoundManager 싱글턴이 동일 설정 원천을 써야
 *  master/sfx 볼륨·keySound가 어긋나지 않는다 — 재구현 아님, 이 함수를 그대로 export만 했다). */
export function readSoundSettings(): SoundSettingsSnapshot {
  const s = useSettingsStore.getState();
  return { keySound: s.keySound, volume: { master: s.volume.master, sfx: s.volume.sfx } };
}

export function useSoundManager(
  engine: GameSessionEngine,
  controller: TypingInputController | null,
): void {
  useEffect(() => {
    if (!controller) return;
    const manager = getSoundManager(readSoundSettings);
    return manager.bind(engine, controller);
  }, [engine, controller]);
}
