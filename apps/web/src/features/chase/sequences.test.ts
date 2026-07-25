// @vitest-environment jsdom
//
// spec: docs/09 §7.6(이벤트 시퀀스 연출 4종 타임라인)·§7.4(수배 사운드)·§7.8(SFX 배선), docs/00
// §11-D96(체포 히트스톱 250ms 유일 블로킹 예외), WT-CH-07 acceptance("타임라인 오프셋 상수 검증·
// reduced-motion 분기·취소 경로").
import '../../app/providers'; // i18next 실 카탈로그 초기화 부수효과(WantedHud.test.tsx와 동일 관례)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine } from '@wt/engine';
import type { Country } from '@wt/shared';
import type { ChaseAudio } from './chase-audio';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import {
  ARREST_REDUCED_TIMELINE_MS,
  ARREST_TIMELINE_MS,
  createChaseSequences,
  DELIVERY_TIMELINE_MS,
  PICKUP_TIMELINE_MS,
  WANTED_ISSUANCE_TIMELINE_MS,
} from './sequences';

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
const KR = mk({ id: 'KR', nameKo: '대한민국', nameEn: 'southkorea', difficultyTier: 1 });
const ALL = [MN, KR];

function mockEngine(home: string | null = 'KR') {
  const listeners = new Set<(e: ChaseEngineEvent) => void>();
  const engine = {
    subscribe: (f: (e: ChaseEngineEvent) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    getSnapshot: () => ({ home }),
  } as unknown as ChaseSessionEngine;
  return { engine, emit: (e: ChaseEngineEvent) => listeners.forEach((l) => l(e)) };
}

function mockGlobe() {
  return {
    projectAnchor: vi.fn(() => ({ x: 100, y: 50 })),
    playPickup: vi.fn(),
    playDelivery: vi.fn(),
    playArrest: vi.fn(),
  } as unknown as GlobeChaseHandle;
}

function mockAudio(): ChaseAudio {
  return {
    sirenDoppler: vi.fn(),
    radioStatic: vi.fn(),
    goldCoin: vi.fn(),
    vaultClunk: vi.fn(),
    caperFanfare: vi.fn(),
    handcuffs: vi.fn(),
    heartbeatStart: vi.fn(),
    heartbeatStop: vi.fn(),
  };
}

function mockLayer(): HTMLDivElement {
  const el = document.createElement('div');
  // jsdom의 getBoundingClientRect는 기본 0×0 — fitViewBoxToContainer가 scale 0으로 방어 처리하므로
  // 좌표 계산 자체는 안전하지만, 폭/높이를 실측치로 스텁해 실제 배치와 유사한 스케일을 재현한다.
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    width: 960, height: 500, x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 500, toJSON: () => ({}),
  } as DOMRect);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('sequences — 타임라인 상수(§7.6 표와 diff 대조 가능)', () => {
  it('픽업 900ms · 배송 1600ms · 체포 2800ms(reduced 1000ms) · 수배발령 600ms', () => {
    expect(PICKUP_TIMELINE_MS.total).toBe(900);
    expect(PICKUP_TIMELINE_MS.polygonFlash).toBe(0);
    expect(PICKUP_TIMELINE_MS.riseSparkle).toBe(80);
    expect(PICKUP_TIMELINE_MS.coinSfxAbsorb).toBe(240);
    expect(PICKUP_TIMELINE_MS.badgeFloatingText).toBe(740);

    expect(DELIVERY_TIMELINE_MS.total).toBe(1600);
    expect(DELIVERY_TIMELINE_MS.burstClunk).toBe(0);
    expect(DELIVERY_TIMELINE_MS.goldDropStamps).toBe(150);
    expect(DELIVERY_TIMELINE_MS.scoreRollup).toBe(500);
    expect(DELIVERY_TIMELINE_MS.starDescendOverlapRef).toBe(900);
    expect(DELIVERY_TIMELINE_MS.fanfare).toBe(1300);

    expect(ARREST_TIMELINE_MS.total).toBe(2800);
    expect(ARREST_TIMELINE_MS.hitstop).toBe(0);
    expect(ARREST_TIMELINE_MS.flashTriple).toBe(250);
    expect(ARREST_TIMELINE_MS.polygonHandcuffs).toBe(520);
    expect(ARREST_TIMELINE_MS.cameraShake).toBe(800);
    expect(ARREST_TIMELINE_MS.tonedownStamp).toBe(1200);
    expect(ARREST_TIMELINE_MS.wantedRedo).toBe(1800);
    expect(ARREST_TIMELINE_MS.resultSlide).toBe(2800);

    expect(ARREST_REDUCED_TIMELINE_MS.total).toBe(1000);
    expect(WANTED_ISSUANCE_TIMELINE_MS.total).toBe(600);
  });
});

describe('sequences — 금 획득(playPickup, 900ms, 비블로킹)', () => {
  it('0ms 폴리곤 플래시(즉시) → 240ms 코인 SFX → 740ms "+1" 플로팅', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    const controller = createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => false,
    });

    emit({ type: 'goldPicked', at: 'MN', ring: 'near' });
    expect(globe.playPickup).toHaveBeenCalledWith('MN');
    expect(audio.goldCoin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(240);
    expect(audio.goldCoin).toHaveBeenCalledTimes(1);
    expect(layer.textContent).not.toContain('금 획득');

    vi.advanceTimersByTime(500); // → 740ms 누적
    expect(layer.textContent).toContain('금 획득 +1');

    controller.dispose();
  });

  it('reduced일 때 riseSparkle(✨) 플로팅을 생략한다(파티클 off, §7 헤더)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => true,
    });

    emit({ type: 'goldPicked', at: 'MN', ring: 'near' });
    vi.advanceTimersByTime(80);
    expect(layer.textContent).not.toContain('✨');
  });
});

describe('sequences — 배송(playDelivery, 1600ms, 비블로킹)', () => {
  it('0ms 금고 철컹+비컨 → 500ms 정산 롤업(홈 좌표) → 1300ms 팡파레', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine('KR');
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => false,
    });

    emit({ type: 'delivered', count: 2, payout: 2750, starsAfter: 1 });
    expect(audio.vaultClunk).toHaveBeenCalledTimes(1);
    expect(globe.playDelivery).toHaveBeenCalledWith(2750, 2);
    expect(audio.caperFanfare).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(layer.textContent).toContain('배송 완료 +2750');

    vi.advanceTimersByTime(800); // → 1300ms 누적
    expect(audio.caperFanfare).toHaveBeenCalledTimes(1);
  });
});

describe('sequences — 체포(playArrest, 2800ms · D96 유일 블로킹 예외)', () => {
  it('히트스톱(0ms)→플래시(250ms)→체포국 점등+수갑(520ms)→셰이크(800ms)→톤다운+스탬프(1200ms)→전단(1800ms)→완료(2800ms)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    const onArrestComplete = vi.fn();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => false, onArrestComplete,
    });

    emit({ type: 'arrested', by: 'chaser', at: 'MN', finalState: {} as never });
    const overlay = layer.querySelector('.wt-chase-arrest-overlay')!;
    expect(overlay.classList.contains('is-hitstop')).toBe(true);
    expect(globe.playArrest).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(overlay.classList.contains('is-hitstop')).toBe(false);
    expect(overlay.classList.contains('is-flash')).toBe(true);
    expect(audio.sirenDoppler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(270); // → 520ms 누적: 플래시 3연(90×3) 종료 + 체포국 점등/수갑
    expect(overlay.classList.contains('is-flash')).toBe(false);
    expect(globe.playArrest).toHaveBeenCalledWith('MN', 'chaser');
    expect(audio.handcuffs).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(280); // → 800ms
    expect(overlay.classList.contains('is-shake')).toBe(true);

    vi.advanceTimersByTime(400); // → 1200ms
    expect(overlay.classList.contains('is-shake')).toBe(false);
    expect(overlay.classList.contains('is-tonedown')).toBe(true);
    expect(overlay.textContent).toContain('ARRESTED');
    expect(layer.textContent).toContain('몽골에서 검거');

    vi.advanceTimersByTime(600); // → 1800ms
    expect(overlay.classList.contains('is-wanted-redo')).toBe(true);

    expect(onArrestComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // → 2800ms
    expect(onArrestComplete).toHaveBeenCalledTimes(1);
  });

  it('reduced-motion: 히트스톱·플래시·셰이크 생략 — 정적 표시 후 1s 뒤 완료(§7.6)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    const onArrestComplete = vi.fn();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => true, onArrestComplete,
    });

    emit({ type: 'arrested', by: 'heli', at: 'MN', finalState: {} as never });
    const overlay = layer.querySelector('.wt-chase-arrest-overlay')!;
    expect(overlay.classList.contains('is-hitstop')).toBe(false);
    expect(overlay.classList.contains('is-static-arrested')).toBe(true);
    expect(overlay.textContent).toContain('ARRESTED');
    expect(layer.textContent).toContain('몽골에서 검거');
    // 히트스톱/플래시/셰이크가 아예 스케줄되지 않는다(사용되지 않는 타이머 없음 확인).
    vi.advanceTimersByTime(250);
    expect(overlay.classList.contains('is-flash')).toBe(false);

    expect(onArrestComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(750); // → 1000ms 누적
    expect(onArrestComplete).toHaveBeenCalledTimes(1);
  });
});

describe('sequences — 수배 발령/상승/하강(§7.4·§7.8 사운드 배선)', () => {
  it('최초 상승(발령)은 도플러+무전 치직, 이후 상승은 도플러만, 하강은 무전 치직만', () => {
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => null, isReduced: () => false,
    });

    emit({ type: 'wantedChanged', stars: 1, direction: 'up' });
    expect(audio.sirenDoppler).toHaveBeenCalledTimes(1);
    expect(audio.radioStatic).toHaveBeenCalledTimes(1);

    emit({ type: 'wantedChanged', stars: 2, direction: 'up' });
    expect(audio.sirenDoppler).toHaveBeenCalledTimes(2);
    expect(audio.radioStatic).toHaveBeenCalledTimes(1); // 재호출 없음(최초 1회만)

    emit({ type: 'wantedChanged', stars: 1, direction: 'down' });
    expect(audio.radioStatic).toHaveBeenCalledTimes(2);
    expect(audio.sirenDoppler).toHaveBeenCalledTimes(2); // 하강엔 도플러 없음
  });

  it('재도전(phase countdown 재진입) 시 다음 상승을 다시 "최초 발령"으로 취급한다', () => {
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => null, isReduced: () => false,
    });

    emit({ type: 'wantedChanged', stars: 1, direction: 'up' });
    expect(audio.radioStatic).toHaveBeenCalledTimes(1);

    emit({ type: 'phase', phase: 'countdown' });
    emit({ type: 'wantedChanged', stars: 1, direction: 'up' });
    expect(audio.radioStatic).toHaveBeenCalledTimes(2); // 리셋 후 다시 "최초"로 발령 사운드
  });
});

describe('sequences — dispose(취소 경로, 누수 금지)', () => {
  it('dispose 이후 대기 중이던 타이머가 발화하지 않는다(구독 해제 포함)', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const globe = mockGlobe();
    const audio = mockAudio();
    const layer = mockLayer();
    const controller = createChaseSequences({
      engine, globe, audio, countries: ALL, lang: 'ko',
      getLayer: () => layer, isReduced: () => false,
    });

    emit({ type: 'goldPicked', at: 'MN', ring: 'near' });
    controller.dispose();
    vi.advanceTimersByTime(5000);

    expect(audio.goldCoin).not.toHaveBeenCalled();
    expect(layer.textContent).not.toContain('금 획득');

    // 구독 해제 확인 — dispose 후 이벤트를 emit해도 아무 반응 없음.
    emit({ type: 'goldPicked', at: 'KR', ring: 'near' });
    vi.advanceTimersByTime(5000);
    expect(audio.goldCoin).not.toHaveBeenCalled();
  });
});
