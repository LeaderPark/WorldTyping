// @vitest-environment jsdom
//
// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(단일 스프라이트+Web Audio, 첫 제스처 unlock,
//       실패 무음 폴백), WT-M2-07 구현 세부 지시 3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChaseEngineEvent,
  ChaseSessionEngine,
  EngineEvent,
  GameSessionEngine,
  RunResult,
  TypingEvent,
  TypingInputController,
} from '@wt/engine';
import type { MatchDetail } from '@wt/shared';
import { CHASE_SPRITE_MAP } from './chase-sprites';
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

// ── WT-CH-07: chase 전용 SFX(§7.8) + bindChase(§7.2 카운트다운 교체) ──────────────────────────

function fakeFetchBothSheets(): ReturnType<typeof vi.fn> {
  // sprite.wav/chase-sprite.wav 어느 URL이 와도 동일한 가짜 arrayBuffer로 응답(디코드는
  // installFakeAudioContext의 decodeAudioData 스텁이 항상 성공하므로 URL 분기가 결과에 영향 없음).
  return vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
}

describe('SoundManager — chase SFX 지연 로드(WT-CH-07, §7.8)', () => {
  it('unlock() 직후에는 chase 시트를 fetch하지 않는다(첫 playChase* 호출 시점에만 지연 로드)', async () => {
    const fetchSpy = fakeFetchBothSheets();
    installFakeAudioContext();
    vi.stubGlobal('fetch', fetchSpy);
    const manager = new SoundManager(() => fullVolumeSettings());

    manager.unlock();
    await flushMicrotasks();

    // 기존 sprite.wav 1회만 — chase-sprite.wav는 아직 요청되지 않는다.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/sounds/sprite.wav');
  });

  it('첫 playChaseX() 호출이 chase-sprite.wav를 지연 fetch하고, 로드 완료 후 재생이 정확한 오프셋으로 재생된다', async () => {
    const { createBufferSource } = installFakeAudioContext();
    const fetchSpy = fakeFetchBothSheets();
    vi.stubGlobal('fetch', fetchSpy);
    const manager = new SoundManager(() => fullVolumeSettings());
    manager.unlock();
    await flushMicrotasks();

    manager.playChaseVaultClunk(); // 워밍업 호출 — 이 시점엔 아직 버퍼가 없어 무음(재생 시도 없음).
    expect(createBufferSource).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith('/sounds/chase-sprite.wav');

    await flushMicrotasks();
    manager.playChaseVaultClunk(); // 이제 chaseBuffer 준비 완료 — 실제 재생.
    expect(createBufferSource).toHaveBeenCalledTimes(1);
    const src = createBufferSource.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(src.start).toHaveBeenCalledWith(
      0,
      CHASE_SPRITE_MAP.chaseVaultClunk.offset,
      CHASE_SPRITE_MAP.chaseVaultClunk.duration,
    );
  });

  it('금 획득 SFX는 2연(±3% 피치 지터, §7.8 "2연 피치 랜덤")', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal('fetch', fakeFetchBothSheets());
    vi.useFakeTimers();
    const manager = new SoundManager(() => fullVolumeSettings());
    manager.unlock();
    await vi.advanceTimersByTimeAsync(0); // unlock()의 load() 마이크로태스크 흘려보내기

    // chase 시트 로더는 지연 재생 없는(1회성) 메서드로 워밍업한다 — playChaseGoldCoin 자체로
    // 워밍업하면 그 호출의 2번째(+90ms) 히트가 버퍼 준비 이후에 발화해 아래 "정확히 2연" 단언과
    // 겹친다(레이스). vaultClunk는 단발이라 겹칠 지연 타이머가 없다.
    manager.playChaseVaultClunk();
    await vi.advanceTimersByTimeAsync(0); // ensureChaseLoaded()의 fetch/decode 완료
    createBufferSource.mockClear(); // 워밍업 재생 자체는 이 테스트의 관심사가 아님

    manager.playChaseGoldCoin(); // 이제부터 순수하게 2연만 관찰
    expect(createBufferSource).toHaveBeenCalledTimes(1); // 1번째 즉시 히트

    vi.advanceTimersByTime(90);
    expect(createBufferSource).toHaveBeenCalledTimes(2); // 90ms 후 2번째 히트

    for (const call of createBufferSource.mock.results) {
      const src = call.value as { playbackRate: { value: number } };
      expect(src.playbackRate.value).toBeGreaterThanOrEqual(0.97);
      expect(src.playbackRate.value).toBeLessThanOrEqual(1.03);
    }
  });

  it('startChaseHeartbeat(bpm)은 60000/bpm 간격으로 반복 재생하고, 재호출 시 이전 루프를 정지한다(중복 방지)', async () => {
    const { createBufferSource } = installFakeAudioContext();
    vi.stubGlobal('fetch', fakeFetchBothSheets());
    vi.useFakeTimers();
    const manager = new SoundManager(() => fullVolumeSettings());
    manager.unlock();
    await vi.advanceTimersByTimeAsync(0);

    manager.startChaseHeartbeat(60); // 워밍업(첫 호출 — 아직 버퍼 없음, 로드만 트리거)
    await vi.advanceTimersByTimeAsync(0);
    manager.stopChaseHeartbeat();
    createBufferSource.mockClear();

    manager.startChaseHeartbeat(60); // 60bpm = 1000ms 간격, 이제 버퍼 준비 완료
    expect(createBufferSource).toHaveBeenCalledTimes(1); // 즉시 1타
    vi.advanceTimersByTime(1000);
    expect(createBufferSource).toHaveBeenCalledTimes(2);

    createBufferSource.mockClear(); // 재시작 직후의 즉시 1타를 이 구간에 포함시키려면 시작 전에 clear
    manager.startChaseHeartbeat(120); // 재시작 — 이전 1000ms 간격 루프는 취소돼야 함
    vi.advanceTimersByTime(1000);
    // 120bpm=500ms 간격이므로 1000ms 동안 즉시 1타 + 500ms/1000ms 두 틱 = 3회(구 1000ms 루프가
    // 살아있었다면 여기서 4회+가 됐을 것).
    expect(createBufferSource).toHaveBeenCalledTimes(3);

    manager.stopChaseHeartbeat();
    createBufferSource.mockClear();
    vi.advanceTimersByTime(5000);
    expect(createBufferSource).not.toHaveBeenCalled(); // 정지 후 완전히 멈춤(누수 없음).
  });
});

describe('SoundManager.bindChase — chase 전용 배선(WT-CH-07, §7.2·§6.2)', () => {
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

  // bind describe 블록의 동일 이름 helper는 그 블록 콜백 스코프에 갇혀 여기서 재사용할 수 없다
  // (별도 top-level describe) — 동일 정의를 여기서 다시 선언한다(재구현 아님, 순수 테스트 픽스처).
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

  it('phase countdown → 경보 3연(1초 간격), phase playing → 유리 쨍(§7.2, 기존 개찰구 비프 자리 대체)', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const alarmSpy = vi.spyOn(manager, 'playChaseAlarmBeep').mockImplementation(() => {});
    const glassSpy = vi.spyOn(manager, 'playChaseGlassShatter').mockImplementation(() => {});
    const { engine, emit } = fakeChaseEngine();
    const { controller } = fakeController();

    manager.bindChase(engine, controller);
    emit({ type: 'phase', phase: 'countdown' });
    expect(alarmSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(alarmSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(alarmSpy).toHaveBeenCalledTimes(3);

    emit({ type: 'phase', phase: 'playing' });
    expect(glassSpy).toHaveBeenCalledTimes(1);

    // countdown 재진입 시 이전 타이머가 남아 중복 발사되지 않는다(clearCountdown, bind()와 동일 보증).
    alarmSpy.mockClear();
    emit({ type: 'phase', phase: 'countdown' });
    vi.advanceTimersByTime(5000);
    expect(alarmSpy).toHaveBeenCalledTimes(3); // 유령 타이머 없음
  });

  it('hopCommitted → playConfirm(직전 comboChanged 값)', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const confirmSpy = vi.spyOn(manager, 'playConfirm').mockImplementation(() => {});
    const { engine, emit } = fakeChaseEngine();
    const { controller } = fakeController();
    manager.bindChase(engine, controller);

    emit({ type: 'comboChanged', combo: 4 });
    emit({ type: 'hopCommitted', hopIndex: 0, from: 'KR', to: 'JP', ms: 500, errors: 0 });
    expect(confirmSpy).toHaveBeenCalledWith(4);

    // 콤보 리셋(0) 후 다음 홉 확정 — 캐시가 최신값으로 갱신됨을 확인.
    emit({ type: 'comboChanged', combo: 0 });
    emit({ type: 'hopCommitted', hopIndex: 1, from: 'JP', to: 'KR', ms: 500, errors: 1 });
    expect(confirmSpy).toHaveBeenLastCalledWith(0);
  });

  it('컨트롤러 progress(added>0)/miss는 기존 bind()와 동일하게 playKeyCorrect/playMiss로 재사용된다', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const keySpy = vi.spyOn(manager, 'playKeyCorrect').mockImplementation(() => {});
    const missSpy = vi.spyOn(manager, 'playMiss').mockImplementation(() => {});
    const { engine } = fakeChaseEngine();
    const { controller, emit } = fakeController();
    manager.bindChase(engine, controller);

    emit({
      type: 'progress',
      detail: DUMMY_DETAIL,
      delta: { added: 1, removed: 0, addedCorrect: 1, addedError: 0 },
      rawValue: 'a',
    });
    expect(keySpy).toHaveBeenCalledTimes(1);

    emit({ type: 'miss', detail: DUMMY_DETAIL, delta: { added: 1, removed: 0, addedCorrect: 0, addedError: 1 } });
    expect(missSpy).toHaveBeenCalledTimes(1);
  });

  it('해제 함수 호출 시 카운트다운 타이머·하트비트가 전부 정리되고 이후 이벤트에 반응하지 않는다', () => {
    const manager = new SoundManager(() => fullVolumeSettings());
    const alarmSpy = vi.spyOn(manager, 'playChaseAlarmBeep').mockImplementation(() => {});
    const heartbeatStopSpy = vi.spyOn(manager, 'stopChaseHeartbeat');
    const { engine, emit } = fakeChaseEngine();
    const { controller } = fakeController();
    const unbind = manager.bindChase(engine, controller);

    emit({ type: 'phase', phase: 'countdown' });
    unbind();
    expect(heartbeatStopSpy).toHaveBeenCalledTimes(1);

    alarmSpy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(alarmSpy).not.toHaveBeenCalled(); // 해제 후 예약됐던 1초/2초 타이머가 발화하지 않음.

    emit({ type: 'phase', phase: 'countdown' });
    expect(alarmSpy).not.toHaveBeenCalled(); // 구독 해제 확인.
  });
});
