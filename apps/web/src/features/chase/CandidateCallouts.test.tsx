// @vitest-environment jsdom
//
// spec: docs/09 §7.3·§8.5(콜아웃 칩 구현 계약·배치·상태 매트릭스), docs/09a §5, WT-CH-06 acceptance
// ("배치 알고리즘 결정성", "회전 중 고스트→착지 재배치 1회", "상태 매트릭스 6종", "칩 노드 고정·
// [data-candidate]", "에코 분산", "a11y 공지").
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChaseEngineEvent, ChaseSessionEngine } from '@wt/engine';
import { TypingInputController } from '@wt/engine';
import type { Country } from '@wt/shared';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import { CandidateCallouts } from './CandidateCallouts';

function mk(p: Partial<Country> & Pick<Country, 'id' | 'nameKo' | 'nameEn'>): Country {
  return {
    iso3: 'XXX', aliasesKo: [], aliasesEn: [], continent: 'asia', subregion: '',
    difficultyTier: 2, capitalKo: '', capitalEn: '', flagEmoji: '🏳️', population: 0,
    latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: [p.nameKo], acceptedInputsEn: [p.nameEn.toLowerCase()],
    ...p,
  };
}
const MN = mk({ id: 'MN', nameKo: '몽골', nameEn: 'mongolia' });
const JP = mk({ id: 'JP', nameKo: '일본', nameEn: 'japan' });
const KR = mk({ id: 'KR', nameKo: '대한민국', nameEn: 'southkorea', difficultyTier: 1 });
const ALL = [MN, JP, KR];

function mockEngine(home: string | null = 'KR') {
  const listeners = new Set<(e: ChaseEngineEvent) => void>();
  const engine = {
    subscribe: (f: (e: ChaseEngineEvent) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    getSnapshot: () => ({ home }),
  } as unknown as ChaseSessionEngine;
  return {
    engine,
    emit: (e: ChaseEngineEvent) => act(() => listeners.forEach((l) => l(e))),
  };
}

function mockGlobe() {
  const hopCbs = new Set<(phase: 'start' | 'land') => void>();
  const handle = {
    projectAnchor: vi.fn((id: string) => ({ x: 480, y: 100 + id.length })),
    onHopLifecycle: vi.fn((cb: (phase: 'start' | 'land') => void) => {
      hopCbs.add(cb);
      return () => hopCbs.delete(cb);
    }),
    setCandidateAnchors: vi.fn(),
    setCandidatePrehighlight: vi.fn(),
  } as unknown as GlobeChaseHandle & {
    projectAnchor: ReturnType<typeof vi.fn>;
    onHopLifecycle: ReturnType<typeof vi.fn>;
    setCandidateAnchors: ReturnType<typeof vi.fn>;
    setCandidatePrehighlight: ReturnType<typeof vi.fn>;
  };
  return { globe: handle, fireHop: (phase: 'start' | 'land') => act(() => hopCbs.forEach((cb) => cb(phase))) };
}

function shownEvent(candidates: Array<{ id: string; danger: boolean }>, hopIndex = 0): ChaseEngineEvent {
  return { type: 'candidatesShown', hopIndex, candidates };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CandidateCallouts — 칩 노드 고정(§8.5 구현 계약)', () => {
  it('마운트 시 [data-candidate] 노드 3개를 고정 생성한다', () => {
    const { engine } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    const overlay = screen.getByTestId('chase-candidate-overlay');
    expect(overlay.querySelectorAll('[data-candidate]')).toHaveLength(3);
  });

  it('candidatesShown이 여러 번 와도 동일한 3개 노드가 재사용된다(재생성 없음)', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    const overlay = screen.getByTestId('chase-candidate-overlay');
    const before = Array.from(overlay.querySelectorAll('[data-candidate]'));

    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    emit(shownEvent([{ id: 'JP', danger: false }, { id: 'KR', danger: false }, { id: 'MN', danger: false }], 1));

    const after = Array.from(overlay.querySelectorAll('[data-candidate]'));
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('candidatesShown 이후 칩에 후보국 이름/티어가 반영된다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]!.querySelector('.wt-candidate-chip__name')?.textContent).toBe('몽골');
    expect(chips[0]!.querySelector('.wt-candidate-chip__tier')?.textContent).toBe('T2');
  });

  it('globe.setCandidateAnchors가 후보 id 배열로 호출된다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    expect(globe.setCandidateAnchors).toHaveBeenCalledWith(['MN', 'JP', 'KR']);
  });
});

describe('CandidateCallouts — 상태 매트릭스(§8.5)', () => {
  it('danger 후보는 data-state="danger"', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: true }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]).toHaveAttribute('data-state', 'danger');
  });

  it('candidateDangerChanged로 danger를 토글한다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    emit({ type: 'candidateDangerChanged', countryId: 'MN', danger: true });
    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]).toHaveAttribute('data-state', 'danger');

    emit({ type: 'candidateDangerChanged', countryId: 'MN', danger: false });
    expect(chips[0]).toHaveAttribute('data-state', 'idle');
  });

  it('goldSpawned로 gold 상태가 되고 goldPicked로 해제된다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    emit({ type: 'goldSpawned', at: 'JP', ring: 'near' });
    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[1]).toHaveAttribute('data-state', 'gold');

    emit({ type: 'goldPicked', at: 'JP', ring: 'near' });
    expect(chips[1]).toHaveAttribute('data-state', 'idle');
  });

  it('home(배송지) 후보는 data-state="home"(다른 상태 없을 때)', () => {
    const { engine, emit } = mockEngine('KR');
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[2]).toHaveAttribute('data-state', 'home');
  });

  it('hopCommitted(to=MN)로 committed 상태가 되고, 타이머 후 원복한다', () => {
    vi.useFakeTimers();
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    emit({ type: 'hopCommitted', hopIndex: 0, from: 'KR', to: 'MN', ms: 400, errors: 0 });
    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]).toHaveAttribute('data-state', 'committed');

    act(() => vi.advanceTimersByTime(200));
    expect(chips[0]).toHaveAttribute('data-state', 'idle');
  });
});

describe('CandidateCallouts — 홉 회전 게이팅(§8.5 배치 알고리즘-5)', () => {
  it("onHopLifecycle('start')에 고스트 클래스가 붙고 ('land')에 해제된다", () => {
    const { engine, emit } = mockEngine();
    const { globe, fireHop } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));

    fireHop('start');
    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]!.className).toContain('wt-candidate-chip--ghost');

    fireHop('land');
    expect(chips[0]!.className).not.toContain('wt-candidate-chip--ghost');
  });

  it("회전 중(start~land) candidatesShown이 와도 즉시 재투영하지 않고 land에서 1회 반영한다", () => {
    const { engine, emit } = mockEngine();
    const { globe, fireHop } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    const callsBeforeRotation = globe.projectAnchor.mock.calls.length;

    fireHop('start');
    emit(shownEvent([{ id: 'JP', danger: false }, { id: 'KR', danger: false }, { id: 'MN', danger: false }], 1));
    // 회전 중엔 projectAnchor가 재배치 목적으로 추가 호출되지 않는다.
    expect(globe.projectAnchor.mock.calls.length).toBe(callsBeforeRotation);

    fireHop('land');
    // 착지 시 1회 재투영(각 후보당 최소 1회 projectAnchor 호출).
    expect(globe.projectAnchor.mock.calls.length).toBeGreaterThan(callsBeforeRotation);
  });
});

describe('CandidateCallouts — 입력 에코 분산(D97, §7.3)', () => {
  function realController(): { controller: TypingInputController; input: HTMLInputElement } {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const controller = new TypingInputController(input, 'ko');
    controller.attach();
    return { controller, input };
  }

  it('입력 prefix가 특정 후보와 일치하면 그 칩만 matching 상태가 된다', () => {
    const { engine, emit } = mockEngine(null);
    const { globe } = mockGlobe();
    const { controller, input } = realController();
    render(<CandidateCallouts engine={engine} controller={controller} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    // 3후보 acceptedInputs 합성 타깃을 컨트롤러에 주입(D97 배선은 use-chase-engine 소관이라 테스트는
    // 직접 setCountry로 컨트롤러가 EXACT까지 갈 수 있게 구성 — 여기선 progress/echo만 확인).
    controller.setCountry({
      ...MN,
      acceptedInputsKo: [...MN.acceptedInputsKo, ...JP.acceptedInputsKo, ...KR.acceptedInputsKo],
    });

    input.value = '몽';
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));

    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]).toHaveAttribute('data-state', 'matching'); // MN
    expect(chips[1]).toHaveAttribute('data-state', 'idle'); // JP
    expect(chips[2]).toHaveAttribute('data-state', 'idle'); // KR
  });

  it('globe.setCandidatePrehighlight가 matching 후보 id로 호출된다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    const { controller, input } = realController();
    render(<CandidateCallouts engine={engine} controller={controller} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    controller.setCountry({
      ...MN,
      acceptedInputsKo: [...MN.acceptedInputsKo, ...JP.acceptedInputsKo, ...KR.acceptedInputsKo],
    });

    input.value = '몽';
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));

    expect(globe.setCandidatePrehighlight).toHaveBeenCalledWith('MN');
  });

  it('동일 후보가 계속 matching이면 추가 키스트로크에도 setCandidatePrehighlight를 다시 부르지 않는다(성능 — d3 path 재계산 방지)', () => {
    const { engine, emit } = mockEngine(null);
    const { globe } = mockGlobe();
    const { controller, input } = realController();
    render(<CandidateCallouts engine={engine} controller={controller} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: false }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    controller.setCountry({
      ...MN,
      acceptedInputsKo: [...MN.acceptedInputsKo, ...JP.acceptedInputsKo, ...KR.acceptedInputsKo],
    });

    input.value = '몽';
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    expect(globe.setCandidatePrehighlight).toHaveBeenCalledTimes(1);

    // "몽"은 자음+모음 2자모라 "몽"을 넘어서는 완성 음절 추가 입력은 어렵다 — 대신 동일 프리픽스를
    // 유지하는 무해 키(같은 값 재입력)로 "matching 후보가 그대로"인 상황을 재현한다.
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    expect(globe.setCandidatePrehighlight).toHaveBeenCalledTimes(1);
  });

  it('prefix를 공유하는 두 후보는 동시에 matching 상태가 될 수 있다(둘 다 미완성 입력)', () => {
    // A/B는 "가나"를 공통 접두로 공유하되 셋 다 "가나"보다 길어 아직 완성되지 않는다(controller가
    // EXACT로 조기 확정하지 않고 progress로 흘려보내는 조건 — 실제 §7.3 시나리오와 동일).
    const A = mk({ id: 'AA', nameKo: '가나다', nameEn: 'aa', difficultyTier: 3 });
    const B = mk({ id: 'BB', nameKo: '가나마', nameEn: 'bb', difficultyTier: 3 });
    const C = mk({ id: 'CC', nameKo: '다라마', nameEn: 'cc', difficultyTier: 3 });
    const { engine, emit } = mockEngine(null);
    const { globe } = mockGlobe();
    const { controller, input } = realController();
    render(
      <CandidateCallouts engine={engine} controller={controller} globe={globe} countries={[A, B, C]} lang="ko" />,
    );
    emit(shownEvent([{ id: 'AA', danger: false }, { id: 'BB', danger: false }, { id: 'CC', danger: false }]));
    controller.setCountry({ ...A, acceptedInputsKo: ['가나다', '가나마', '다라마'] });

    input.value = '가나';
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));

    const chips = screen.getByTestId('chase-candidate-overlay').querySelectorAll('[data-candidate]');
    expect(chips[0]).toHaveAttribute('data-state', 'matching'); // "가나다" — prefix contains "가나"
    expect(chips[1]).toHaveAttribute('data-state', 'matching'); // "가나마" — prefix contains "가나"
    expect(chips[2]).toHaveAttribute('data-state', 'idle'); // "다라마" — no relation
  });
});

describe('CandidateCallouts — a11y(§8.10)', () => {
  it('aria-live 공지 노드는 aria-hidden 오버레이 밖의 형제 노드다', () => {
    const { engine } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    const overlay = screen.getByTestId('chase-candidate-overlay');
    const announcer = screen.getByTestId('chase-candidate-announcer');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(overlay.contains(announcer)).toBe(false);
  });

  it('danger 후보 발생 시 공지 텍스트가 채워진다', () => {
    const { engine, emit } = mockEngine();
    const { globe } = mockGlobe();
    render(<CandidateCallouts engine={engine} controller={null} globe={globe} countries={ALL} lang="ko" />);
    emit(shownEvent([{ id: 'MN', danger: true }, { id: 'JP', danger: false }, { id: 'KR', danger: false }]));
    expect(screen.getByTestId('chase-candidate-announcer').textContent).not.toBe('');
  });
});
