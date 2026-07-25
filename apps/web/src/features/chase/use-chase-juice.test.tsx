// @vitest-environment jsdom
//
// spec: docs/09 §7.6(이벤트 시퀀스 4종), WT-CH-07 acceptance. use-chase-juice.ts는 CH-08이
// GamePage(mode=chase)에서 마운트할 훅 — 여기서는 (1) 반환된 layerRef가 실제 DOM에 붙으면
// sequences.ts가 그 레이어에 그린다는 것, (2) 언마운트 시 dispose(구독 해제·타이머 정리)가
// 호출된다는 것, (3) audio/reducedOverride 테스트 오버레이드가 먹힌다는 것만 검증한다(세부
// 타임라인 로직 자체는 sequences.test.ts가 이미 전담).
import '../../app/providers'; // i18next 실 카탈로그 초기화 부수효과(sequences.test.ts와 동일 관례)
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine } from '@wt/engine';
import type { Country } from '@wt/shared';
import type { ChaseAudio } from './chase-audio';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import { useChaseJuice } from './use-chase-juice';

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn'>): Country {
  return {
    iso3: 'XXX', aliasesKo: [], aliasesEn: [], continent: 'asia', subregion: '',
    difficultyTier: 2, capitalKo: '', capitalEn: '', flagEmoji: '', population: 0,
    latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: [p.nameKo], acceptedInputsEn: [p.nameEn.toLowerCase()],
    ...p,
  };
}
const MN = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia' });

function mockEngine() {
  const listeners = new Set<(e: ChaseEngineEvent) => void>();
  const engine = {
    subscribe: (f: (e: ChaseEngineEvent) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    getSnapshot: () => ({ home: 'MN' }),
  } as unknown as ChaseSessionEngine;
  return { engine, emit: (e: ChaseEngineEvent) => act(() => listeners.forEach((l) => l(e))) };
}

function mockGlobe(): GlobeChaseHandle {
  return {
    projectAnchor: vi.fn(() => ({ x: 10, y: 10 })),
    playPickup: vi.fn(),
    playDelivery: vi.fn(),
    playArrest: vi.fn(),
  } as unknown as GlobeChaseHandle;
}

function mockAudio(): ChaseAudio {
  return {
    sirenDoppler: vi.fn(), radioStatic: vi.fn(), goldCoin: vi.fn(), vaultClunk: vi.fn(),
    caperFanfare: vi.fn(), handcuffs: vi.fn(), heartbeatStart: vi.fn(), heartbeatStop: vi.fn(),
  };
}

function Harness({
  engine, globe, audio, onArrestComplete,
}: {
  engine: ChaseSessionEngine;
  globe: GlobeChaseHandle;
  audio: ChaseAudio;
  onArrestComplete?: () => void;
}) {
  const { layerRef } = useChaseJuice(engine, globe, {
    lang: 'ko', countries: [MN], audio, reducedOverride: false, onArrestComplete,
  });
  return <div data-testid="fx-layer" ref={layerRef} />;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useChaseJuice — 마운트 배선(WT-CH-07)', () => {
  it('layerRef가 붙은 DOM에 픽업 플로팅 텍스트를 그린다(sequences.ts 실통합)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const { getByTestId } = render(<Harness engine={engine} globe={globe} audio={audio} />);

    emit({ type: 'goldPicked', at: 'MN', ring: 'near' });
    expect(globe.playPickup).toHaveBeenCalledWith('MN');

    act(() => {
      vi.advanceTimersByTime(240);
    });
    expect(audio.goldCoin).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500); // → 740ms 누적
    });
    expect(getByTestId('fx-layer').textContent).toContain('금 획득 +1');
  });

  it('언마운트 시 dispose되어 이후 이벤트/타이머에 반응하지 않는다(누수 금지)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const { unmount } = render(<Harness engine={engine} globe={globe} audio={audio} />);

    emit({ type: 'goldPicked', at: 'MN', ring: 'near' });
    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(audio.goldCoin).not.toHaveBeenCalled();
  });

  it('체포 시퀀스 종료 시 onArrestComplete 콜백이 호출된다(선택적 훅)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const onArrestComplete = vi.fn();
    render(<Harness engine={engine} globe={globe} audio={audio} onArrestComplete={onArrestComplete} />);

    emit({ type: 'arrested', by: 'chaser', at: 'MN', finalState: {} as never });
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(onArrestComplete).toHaveBeenCalledTimes(1);
  });
});
