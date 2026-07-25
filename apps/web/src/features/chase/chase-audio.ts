// spec: docs/09-chase-mode-goldrunner.md §7.2(카운트다운 교체)·§7.6(이벤트 타임라인 SFX)·
//       §7.8(SFX 총괄표), docs/00 §11-D96, WT-CH-07.
//
// 이 파일은 두 가지를 노출한다:
//  ① `ChaseAudio` — sequences.ts(4종 이벤트 타임라인)가 소비하는 얇은 재생 포트. 실 구현은
//     apps/web/src/audio/sound-manager.ts의 공유 SoundManager 싱글턴(getSoundManager)이며, 여기서는
//     AudioContext/스프라이트 로딩 로직을 재구현하지 않는다 — 메서드를 그대로 위임만 한다. 포트로
//     감싸는 이유는 sequences.ts/use-chase-juice.test의 단위 테스트가 구체 SoundManager 없이도
//     mock ChaseAudio를 주입해 "무엇을 몇 번·어떤 순서로 호출했는가"만 검증할 수 있게 하기 위함.
//  ② `useChaseAudioBinding(engine, controller)` — apps/web/src/audio/useSoundManager.ts의 chase
//     대응물. SoundManager.bindChase()(키 입력/오타/확정 스탬프 재사용 + §7.2 카운트다운 교체)를
//     그대로 배선한다. 4종 이벤트 타임라인(픽업/배송/체포/수배발령)의 SFX는 이 훅이 아니라
//     use-chase-juice.ts(sequences.ts)가 ChaseAudio를 통해 별도로 트리거한다 — 이 훅은 오직
//     "키 입력 3종 + 카운트다운 + 확정 스탬프"만 담당(bindChase 자체 책임 분리, 중복 배선 없음).
import { useEffect } from 'react';
import type { ChaseSessionEngine, TypingInputController } from '@wt/engine';
import { getSoundManager, type SoundManager } from '../../audio/sound-manager';
import { readSoundSettings } from '../../audio/useSoundManager';

/** sequences.ts가 호출하는 chase SFX 포트 — SoundManager.playChase*()의 부분집합만 노출한다
 *  (playKeyCorrect/playMiss/playConfirm/playCountdown 등 5모드 공용 메서드는 여기 포함하지
 *  않는다 — 그건 bindChase()/useChaseAudioBinding 몫). */
export interface ChaseAudio {
  sirenDoppler(): void;
  radioStatic(): void;
  goldCoin(): void;
  vaultClunk(): void;
  caperFanfare(): void;
  handcuffs(): void;
  heartbeatStart(bpm: number): void;
  heartbeatStop(): void;
}

function toChaseAudio(manager: SoundManager): ChaseAudio {
  return {
    sirenDoppler: () => manager.playChaseSirenDoppler(),
    radioStatic: () => manager.playChaseRadioStatic(),
    goldCoin: () => manager.playChaseGoldCoin(),
    vaultClunk: () => manager.playChaseVaultClunk(),
    caperFanfare: () => manager.playChaseCaperFanfare(),
    handcuffs: () => manager.playChaseHandcuffs(),
    heartbeatStart: (bpm) => manager.startChaseHeartbeat(bpm),
    heartbeatStop: () => manager.stopChaseHeartbeat(),
  };
}

/** 앱 전역 공유 SoundManager(getSoundManager)를 ChaseAudio 포트로 감싼 것 — 싱글턴이므로 매 호출
 *  동일 인스턴스를 감싼 새 얇은 객체를 반환한다(상태는 SoundManager 쪽에만 존재, 이 객체는 상태 없음). */
export function getChaseAudio(): ChaseAudio {
  return toChaseAudio(getSoundManager(readSoundSettings));
}

/**
 * GamePage(chase 분기, WT-CH-08 소관)가 useChaseEngine()의 controller와 함께 마운트하는 배선 훅.
 * apps/web/src/audio/useSoundManager.ts와 동일 패턴 — controller가 아직 없는 동안(HiddenTypingInput
 * ref 부착 전)은 아무것도 하지 않는다.
 */
export function useChaseAudioBinding(
  engine: ChaseSessionEngine,
  controller: TypingInputController | null,
): void {
  useEffect(() => {
    if (!controller) return;
    const manager = getSoundManager(readSoundSettings);
    return manager.bindChase(engine, controller);
  }, [engine, controller]);
}
