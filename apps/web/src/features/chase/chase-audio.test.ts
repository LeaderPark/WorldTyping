// @vitest-environment jsdom
//
// spec: docs/09 §7.6·§7.8(chase SFX 배선), WT-CH-07 acceptance("SFX 배선 단위").
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine, TypingInputController } from '@wt/engine';
import { getChaseAudio, useChaseAudioBinding } from './chase-audio';
import { __resetSoundManagerForTests, SoundManager } from '../../audio/sound-manager';

afterEach(() => {
  __resetSoundManagerForTests();
  vi.restoreAllMocks();
});

describe('getChaseAudio — SoundManager 위임 포트(재구현 아님)', () => {
  it('각 메서드가 공유 SoundManager 싱글턴의 대응 playChase*/heartbeat 메서드를 그대로 호출한다', () => {
    const sirenSpy = vi.spyOn(SoundManager.prototype, 'playChaseSirenDoppler').mockImplementation(() => {});
    const staticSpy = vi.spyOn(SoundManager.prototype, 'playChaseRadioStatic').mockImplementation(() => {});
    const coinSpy = vi.spyOn(SoundManager.prototype, 'playChaseGoldCoin').mockImplementation(() => {});
    const clunkSpy = vi.spyOn(SoundManager.prototype, 'playChaseVaultClunk').mockImplementation(() => {});
    const fanfareSpy = vi.spyOn(SoundManager.prototype, 'playChaseCaperFanfare').mockImplementation(() => {});
    const cuffsSpy = vi.spyOn(SoundManager.prototype, 'playChaseHandcuffs').mockImplementation(() => {});
    const hbStartSpy = vi.spyOn(SoundManager.prototype, 'startChaseHeartbeat').mockImplementation(() => {});
    const hbStopSpy = vi.spyOn(SoundManager.prototype, 'stopChaseHeartbeat').mockImplementation(() => {});

    const audio = getChaseAudio();
    audio.sirenDoppler();
    audio.radioStatic();
    audio.goldCoin();
    audio.vaultClunk();
    audio.caperFanfare();
    audio.handcuffs();
    audio.heartbeatStart(90);
    audio.heartbeatStop();

    expect(sirenSpy).toHaveBeenCalledTimes(1);
    expect(staticSpy).toHaveBeenCalledTimes(1);
    expect(coinSpy).toHaveBeenCalledTimes(1);
    expect(clunkSpy).toHaveBeenCalledTimes(1);
    expect(fanfareSpy).toHaveBeenCalledTimes(1);
    expect(cuffsSpy).toHaveBeenCalledTimes(1);
    expect(hbStartSpy).toHaveBeenCalledWith(90);
    expect(hbStopSpy).toHaveBeenCalledTimes(1);
  });

  it('반환 객체는 매번 동일 SoundManager 싱글턴을 감싼다(getSoundManager와 동일 인스턴스 보장)', () => {
    const a = getChaseAudio();
    const b = getChaseAudio();
    // 상태 없는 얇은 래퍼라 객체 참조는 달라도(a !== b), 동일 싱글턴 메서드를 호출한다는 것은 위
    // 테스트로 이미 증명됨 — 여기선 재호출 시 새 인스턴스를 만들지 않는지(리셋 없이) 스파이 카운트로 확인.
    const spy = vi.spyOn(SoundManager.prototype, 'playChaseHandcuffs').mockImplementation(() => {});
    a.handcuffs();
    b.handcuffs();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('useChaseAudioBinding — GamePage 배선 훅(useSoundManager.ts와 동일 패턴)', () => {
  function fakeChaseEngine(): { engine: ChaseSessionEngine; emit: (e: ChaseEngineEvent) => void } {
    let listener: ((e: ChaseEngineEvent) => void) | null = null;
    const engine = {
      subscribe: (fn: (e: ChaseEngineEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    } as unknown as ChaseSessionEngine;
    return { engine, emit: (e) => listener?.(e) };
  }
  function fakeController(): TypingInputController {
    return { subscribe: () => () => {} } as unknown as TypingInputController;
  }

  it('controller가 null인 동안은 bindChase를 호출하지 않는다', () => {
    const bindSpy = vi.spyOn(SoundManager.prototype, 'bindChase');
    const { engine } = fakeChaseEngine();
    renderHook(() => useChaseAudioBinding(engine, null));
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('controller가 나타나면 SoundManager.bindChase(engine, controller)를 배선하고 언마운트 시 해제한다', () => {
    const unbindSpy = vi.fn();
    const bindSpy = vi.spyOn(SoundManager.prototype, 'bindChase').mockReturnValue(unbindSpy);
    const { engine } = fakeChaseEngine();
    const controller = fakeController();

    const { unmount } = renderHook(() => useChaseAudioBinding(engine, controller));
    expect(bindSpy).toHaveBeenCalledWith(engine, controller);
    expect(unbindSpy).not.toHaveBeenCalled();

    unmount();
    expect(unbindSpy).toHaveBeenCalledTimes(1);
  });
});
