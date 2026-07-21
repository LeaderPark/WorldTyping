// @vitest-environment jsdom
//
// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(단일 스프라이트+Web Audio, 첫 제스처 unlock,
//       실패 무음 폴백), WT-M2-07 구현 세부 지시 3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineEvent,
  GameSessionEngine,
  RunResult,
  TypingEvent,
  TypingInputController,
} from '@wt/engine';
import type { MatchDetail } from '@wt/shared';
import { SPRITE_MAP } from './sprites';
import { SoundManager } from './sound-manager';

/** 사운드 매니저는 detail을 읽지 않는다(delta만 소비) — 테스트 전용 더미. */
const DUMMY_DETAIL = {} as unknown as MatchDetail;
const DUMMY_RESULT = {} as unknown as RunResult;

interface FakeGainNode {
  gain: { value: number };
  connect: (dest: unknown) => FakeGainNode;
}
interface FakeSourceNode {
  buffer: unknown;
  playbackRate: { value: number };
  connect: (dest: unknown) => FakeSourceNode;
  start: (when: number, offset: number, duration: number) => void;
}

function installFakeAudioContext(): {
  createBufferSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
} {
  const createBufferSource = vi.fn(
    (): FakeSourceNode => ({
      buffer: null,
      playbackRate: { value: 1 },
      connect(_dest: unknown) {
        return this;
      },
      start: vi.fn(),
    }),
  );
  const createGain = vi.fn(
    (): FakeGainNode => ({
      gain: { value: 1 },
      connect(_dest: unknown) {
        return this;
      },
    }),
  );
  const decodeAudioData = vi.fn().mockResolvedValue({ fakeBuffer: true });

  class FakeAudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
    createBufferSource = createBufferSource;
    createGain = createGain;
    decodeAudioData = decodeAudioData;
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
  return { createBufferSource, createGain, decodeAudioData };
}

function fullVolumeSettings(keySound: 'off' | 'mech' | 'membrane' = 'mech') {
  return { keySound, volume: { master: 1, sfx: 1 } };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SoundManager — 미지원/로딩 실패 = 무음 폴백(입력 블로킹 금지)', () => {
  it('AudioContext 미지원 환경에서 unlock/play* 어느 것도 throw하지 않는다', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const manager = new SoundManager(() => fullVolumeSettings());
    expect(() => {
      manager.unlock();
      manager.playKeyCorrect();
      manager.playMiss();
      manager.playConfirm(10);
      manager.playCheckpoint();
      manager.playCountdown(3);
    }).not.toThrow();
  });

  it('스프라이트 fetch 실패 시 이후 재생은 무음으로 수렴한다(throw 없음)', async () => {
    installFakeAudioContext();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const manager = new SoundManager(() => fullVolumeSettings());

    manager.unlock();
    await flushMicrotasks();

    expect(() => manager.playKeyCorrect()).not.toThrow();
  });
});

describe('SoundManager — 정상 로딩 후 재생(WT-M2-07)', () => {
  it('unlock()을 여러 번 호출해도 스프라이트를 1회만 fetch한다(멱등 가드)', async () => {
    installFakeAudioContext();
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    vi.stubGlobal('fetch', fetchSpy);
    const manager = new SoundManager(() => fullVolumeSettings());

    manager.unlock();
    manager.unlock();
    manager.unlock();
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('키 입력 정타: keySound에 따라 mech/membrane 리전을 재생하고 피치가 ±3% 이내로 지터된다', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    );
    const manager = new SoundManager(() => fullVolumeSettings('mech'));
    manager.unlock();
    await flushMicrotasks();

    manager.playKeyCorrect();

    expect(createBufferSource).toHaveBeenCalledTimes(1);
    const src = createBufferSource.mock.results[0]?.value as FakeSourceNode;
    expect(src.start).toHaveBeenCalledWith(0, SPRITE_MAP.keyMech.offset, SPRITE_MAP.keyMech.duration);
    expect(src.playbackRate.value).toBeGreaterThanOrEqual(0.97);
    expect(src.playbackRate.value).toBeLessThanOrEqual(1.03);
  });

  it('keySound="off"면 정타 재생 자체를 시도하지 않는다', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    );
    const manager = new SoundManager(() => fullVolumeSettings('off'));
    manager.unlock();
    await flushMicrotasks();

    manager.playKeyCorrect();
    expect(createBufferSource).not.toHaveBeenCalled();
  });

  it('master*sfx가 0이면 재생을 시도하지 않는다', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    );
    const manager = new SoundManager(() => ({ keySound: 'mech', volume: { master: 0, sfx: 1 } }));
    manager.unlock();
    await flushMicrotasks();

    manager.playKeyCorrect();
    expect(createBufferSource).not.toHaveBeenCalled();
  });

  it('콤보 피치: ×5마다 반음 상승, ×20 이상은 캡(§13.1)', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    );
    const manager = new SoundManager(() => fullVolumeSettings());
    manager.unlock();
    await flushMicrotasks();

    const semitone = Math.pow(2, 1 / 12);

    manager.playConfirm(0);
    let src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.playbackRate.value).toBeCloseTo(1, 5);

    manager.playConfirm(12); // floor(12/5)=2단계
    src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.playbackRate.value).toBeCloseTo(Math.pow(semitone, 2), 5);

    manager.playConfirm(999); // 캡: 4단계(×20)
    src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.playbackRate.value).toBeCloseTo(Math.pow(semitone, 4), 5);
  });

  it('체크포인트/카운트다운 리전을 정확한 오프셋으로 재생한다', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    );
    const manager = new SoundManager(() => fullVolumeSettings());
    manager.unlock();
    await flushMicrotasks();

    manager.playCheckpoint();
    let src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.start).toHaveBeenCalledWith(0, SPRITE_MAP.checkpoint.offset, SPRITE_MAP.checkpoint.duration);

    manager.playCountdown(3);
    src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.start).toHaveBeenCalledWith(
      0,
      SPRITE_MAP.countdownBeep.offset,
      SPRITE_MAP.countdownBeep.duration,
    );

    manager.playCountdown(0);
    src = createBufferSource.mock.results.at(-1)?.value as FakeSourceNode;
    expect(src.start).toHaveBeenCalledWith(
      0,
      SPRITE_MAP.countdownStart.offset,
      SPRITE_MAP.countdownStart.duration,
    );
  });
});

describe('SoundManager.bind — 엔진/컨트롤러 이벤트 배선(구현 세부 지시 3)', () => {
  function fakeEngine(): { engine: GameSessionEngine; emit: (e: EngineEvent) => void } {
    let listener: ((e: EngineEvent) => void) | null = null;
    const engine = {
      subscribe: (fn: (e: EngineEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    } as unknown as GameSessionEngine;
    return { engine, emit: (e) => listener?.(e) };
  }

  function fakeController(): {
    controller: TypingInputController;
    emit: (e: TypingEvent) => void;
  } {
    let listener: ((e: TypingEvent) => void) | null = null;
    const controller = {
      subscribe: (fn: (e: TypingEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    } as unknown as TypingInputController;
    return { controller, emit: (e) => listener?.(e) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('phase countdown → 3·2·1 비프(1초 간격), phase playing → 출발음', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const beep3 = vi.spyOn(manager, 'playCountdown');
    const { engine, emit } = fakeEngine();
    const { controller } = fakeController();

    manager.bind(engine, controller);
    emit({ type: 'phase', phase: 'countdown' });
    expect(beep3).toHaveBeenNthCalledWith(1, 3);

    vi.advanceTimersByTime(1000);
    expect(beep3).toHaveBeenNthCalledWith(2, 2);

    vi.advanceTimersByTime(1000);
    expect(beep3).toHaveBeenNthCalledWith(3, 1);

    emit({ type: 'phase', phase: 'playing' });
    expect(beep3).toHaveBeenNthCalledWith(4, 0);

    // countdown 재진입 시 이전 타이머가 남아 중복 발사되지 않는다(clearCountdown).
    beep3.mockClear();
    emit({ type: 'phase', phase: 'countdown' });
    vi.advanceTimersByTime(5000);
    expect(beep3).toHaveBeenCalledTimes(3); // 3,2,1만 — 추가 유령 타이머 없음
  });

  it('countryCommitted(스킵 아님) → playConfirm(combo), 스킵이면 미호출', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const confirmSpy = vi.spyOn(manager, 'playConfirm').mockImplementation(() => {});
    const { engine, emit } = fakeEngine();
    const { controller } = fakeController();
    manager.bind(engine, controller);

    emit({ type: 'countryCommitted', index: 0, id: 'KR', ms: 100, errors: 0, skipped: false, combo: 3 });
    expect(confirmSpy).toHaveBeenCalledWith(3);

    confirmSpy.mockClear();
    emit({ type: 'countryCommitted', index: 1, id: 'JP', ms: 100, errors: 0, skipped: true, combo: 0 });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('checkpoint/finished → playCheckpoint', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const cpSpy = vi.spyOn(manager, 'playCheckpoint').mockImplementation(() => {});
    const { engine, emit } = fakeEngine();
    const { controller } = fakeController();
    manager.bind(engine, controller);

    emit({ type: 'checkpoint', legIndex: 1, splitMs: 1000 });
    expect(cpSpy).toHaveBeenCalledTimes(1);

    emit({ type: 'finished', result: DUMMY_RESULT });
    expect(cpSpy).toHaveBeenCalledTimes(2);
  });

  it('controller progress(added>0) → playKeyCorrect, miss → playMiss, added===0인 progress는 무음', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const keySpy = vi.spyOn(manager, 'playKeyCorrect').mockImplementation(() => {});
    const missSpy = vi.spyOn(manager, 'playMiss').mockImplementation(() => {});
    const { engine } = fakeEngine();
    const { controller, emit } = fakeController();
    manager.bind(engine, controller);

    emit({
      type: 'progress',
      detail: DUMMY_DETAIL,
      delta: { added: 1, removed: 0, addedCorrect: 1, addedError: 0 },
      rawValue: 'a',
    });
    expect(keySpy).toHaveBeenCalledTimes(1);

    emit({
      type: 'progress',
      detail: DUMMY_DETAIL,
      delta: { added: 0, removed: 1, addedCorrect: 0, addedError: 0 },
      rawValue: '',
    });
    expect(keySpy).toHaveBeenCalledTimes(1); // 백스페이스만 — 추가 호출 없음

    emit({
      type: 'miss',
      detail: DUMMY_DETAIL,
      delta: { added: 1, removed: 0, addedCorrect: 0, addedError: 1 },
    });
    expect(missSpy).toHaveBeenCalledTimes(1);
  });

  it('반환된 해제 함수를 호출하면 이후 이벤트에 반응하지 않는다', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const cpSpy = vi.spyOn(manager, 'playCheckpoint').mockImplementation(() => {});
    const { engine, emit } = fakeEngine();
    const { controller } = fakeController();
    const unbind = manager.bind(engine, controller);

    unbind();
    emit({ type: 'checkpoint', legIndex: 1, splitMs: 1000 });
    expect(cpSpy).not.toHaveBeenCalled();
  });
});
