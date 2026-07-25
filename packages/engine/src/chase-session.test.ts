// spec: docs/09 §6.2(ChaseSessionEngine·ChaseEngineEvent)·§3.2(3-타깃 판정)·§12("엔진 통합" 행),
//       docs/00 §11-D97·D95·D91, WT-CH-04 acceptance(가상시계 통합 테스트 7종).
//
// 전부 가상 시계(VirtualClock)로 구동한다 — deps.now()/deps.schedule() 주입만(Date.now 직접 호출 없음).
// 심(@wt/shared)은 결정적 순수 함수라 합성 chase-graph(선형 거리) + 커스텀 상수로 시나리오를 고정한다.
import { describe, expect, it } from 'vitest';
import {
  compileTargets,
  matchInput,
  mergeChaseConstants,
  simulateChase,
  type ChaseConstants,
  type ChaseGraph,
  type ChaseGraphNode,
  type ChaseWorld,
  type Country,
  type CountryId,
  type DifficultyTier,
} from '@wt/shared';
import {
  ChaseSessionEngine,
  chaseRules,
  createModeRules,
  COUNTDOWN_MS,
  STATS_TICK_MS,
  type ChaseEngineDeps,
  type ChaseEngineEvent,
} from './index';
import type { TypingEvent } from './input-controller';

// ── 가상 시계(session.test.ts와 동일 패턴) ────────────────────────────────
class VirtualClock {
  nowMs = 0;
  private timers: { due: number; cb: () => void; cancelled: boolean; seq: number }[] = [];
  private seq = 0;

  now = (): number => this.nowMs;

  schedule = (cb: () => void, ms: number): (() => void) => {
    const t = { due: this.nowMs + ms, cb, cancelled: false, seq: this.seq++ };
    this.timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };

  advance(deltaMs: number): void {
    const target = this.nowMs + deltaMs;
    for (;;) {
      let next: (typeof this.timers)[number] | undefined;
      for (const t of this.timers) {
        if (t.cancelled || t.due > target) continue;
        if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      this.nowMs = next.due;
      this.timers = this.timers.filter((t) => t !== next);
      next.cb();
    }
    this.nowMs = target;
  }
}

// ── 픽스처: 합성 chase-graph 빌더 ──────────────────────────────────────────
interface Spec {
  id: CountryId;
  nameKo: string;
  tier: DifficultyTier;
}

function mkCountry(spec: Spec): Country {
  return {
    id: spec.id,
    iso3: spec.id + 'X',
    nameKo: spec.nameKo,
    nameEn: spec.id.toLowerCase(),
    aliasesKo: [],
    aliasesEn: [],
    continent: 'asia',
    subregion: '',
    difficultyTier: spec.tier,
    capitalKo: '',
    capitalEn: '',
    flagEmoji: '',
    population: 0,
    latlng: [0, 0],
    mapFeatureId: null,
    acceptedInputsKo: [spec.nameKo],
    acceptedInputsEn: [spec.id.toLowerCase()],
  };
}

/** 상삼각 u16 LE base64 인코더 — graph.ts 디코더(compileGraph.dist)와 동일 오프셋 공식. */
function encodeMatrix(ids: CountryId[], dist: (a: CountryId, b: CountryId) => number): string {
  const n = ids.length;
  const bytes = new Uint8Array(n * (n - 1)); // (n*(n-1)/2) entries × 2 bytes
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const off = i * n - (i * (i + 1)) / 2 + (j - i - 1);
      const v = dist(ids[i]!, ids[j]!) & 0xffff;
      bytes[off * 2] = v & 0xff;
      bytes[off * 2 + 1] = (v >> 8) & 0xff;
    }
  }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** specs + 거리 함수 → { world, countries }. homeEligible = tier≤2. nearest = 대권거리 오름차순 top12. */
function makeWorld(
  specs: Spec[],
  distFn: (ia: number, ib: number) => number,
): { world: ChaseWorld; countries: Country[] } {
  const specById = new Map(specs.map((s) => [s.id, s]));
  const ids = specs.map((s) => s.id).slice().sort();
  const idxOf = new Map(ids.map((id, i) => [id, i]));
  const dist = (a: CountryId, b: CountryId): number =>
    a === b ? 0 : distFn(idxOf.get(a)!, idxOf.get(b)!);

  const nodes: Record<CountryId, ChaseGraphNode> = {};
  for (const id of ids) {
    const others = ids
      .filter((x) => x !== id)
      .map((x) => ({ id: x, km: dist(id, x) }))
      .sort((a, b) => (a.km !== b.km ? a.km - b.km : a.id < b.id ? -1 : 1))
      .slice(0, 12);
    nodes[id] = { nearest: others, homeEligible: (specById.get(id)!.tier as number) <= 2 };
  }
  const graph: ChaseGraph = { ids, nodes, matrix: encodeMatrix(ids, dist) };
  const tiers: Record<CountryId, DifficultyTier> = {};
  for (const s of specs) tiers[s.id] = s.tier;
  const countries = specs.map(mkCountry);
  return { world: { graph, tiers }, countries };
}

/** 선형(index 거리 = |i−j|×1000km) 그래프. C00만 tier1(유일 homeEligible → home 고정). */
function lineWorld(n: number, homeIndex = 0): { world: ChaseWorld; countries: Country[] } {
  const specs: Spec[] = Array.from({ length: n }, (_, i) => ({
    id: `C${String(i).padStart(2, '0')}`,
    nameKo: `국가${String(i).padStart(2, '0')}`,
    tier: (i === homeIndex ? 1 : i % 2 === 0 ? 4 : 3) as DifficultyTier,
  }));
  return makeWorld(specs, (a, b) => Math.abs(a - b) * 1000);
}

// ── 합성 TypingEvent ───────────────────────────────────────────────────────
function exactEvent(country: Country, lang: 'ko' | 'en'): TypingEvent {
  const t = compileTargets(country, lang)[0]!;
  const L = t.key.length;
  return {
    type: 'exact',
    detail: { state: 'EXACT', bestTarget: t, matchedLen: L, inputLen: L },
    delta: { added: L, removed: 0, addedCorrect: L, addedError: 0 },
    elapsedFromShownMs: 0,
  };
}

function missEvent(country: Country, lang: 'ko' | 'en'): TypingEvent {
  const t = compileTargets(country, lang)[0]!;
  return {
    type: 'miss',
    detail: { state: 'MISS', bestTarget: t, matchedLen: 0, inputLen: 1 },
    delta: { added: 1, removed: 0, addedCorrect: 0, addedError: 1 },
  };
}

// ── 하네스 ─────────────────────────────────────────────────────────────────
function setup(opts: {
  world: ChaseWorld;
  countries: Country[];
  constants?: ChaseConstants;
  seed?: number;
  lang?: 'ko' | 'en';
}) {
  const vc = new VirtualClock();
  const events: ChaseEngineEvent[] = [];
  const deps: ChaseEngineDeps = {
    now: vc.now,
    schedule: vc.schedule,
    seed: opts.seed ?? 12345,
    graph: opts.world.graph,
    countries: opts.countries,
    constants: opts.constants ?? mergeChaseConstants({}),
  };
  const engine = new ChaseSessionEngine(deps, opts.lang ?? 'ko');
  engine.subscribe((e) => events.push(e));
  return { engine, vc, events };
}

function byType<T extends ChaseEngineEvent['type']>(
  events: ChaseEngineEvent[],
  type: T,
): Extract<ChaseEngineEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<ChaseEngineEvent, { type: T }>[];
}

/** 현재 후보 중 하나로 홉(선택적 오타 주입). 반환: 홉한 국가 id. */
function hop(
  engine: ChaseSessionEngine,
  countries: Country[],
  pick: (ids: CountryId[]) => CountryId,
  opts?: { errors?: number },
): CountryId {
  const cands = engine.getSnapshot().candidates.map((c) => c.id);
  const targetId = pick(cands);
  const country = countries.find((c) => c.id === targetId)!;
  if (opts?.errors) {
    for (let i = 0; i < opts.errors; i++) engine.handleInput(missEvent(country, 'ko'));
  }
  engine.handleInput(exactEvent(country, 'ko'));
  return targetId;
}

function startPlaying(engine: ChaseSessionEngine, vc: VirtualClock): void {
  engine.start();
  vc.advance(COUNTDOWN_MS);
}

// ── 테스트 ─────────────────────────────────────────────────────────────────

describe('rules/chase + createModeRules 정제', () => {
  it("createModeRules('chase')는 chase 어댑터를 반환한다(throw 스텁 제거)", () => {
    const r = createModeRules('chase', 'ko');
    expect(r.id).toBe('chase');
    expect(r.lives).toBeNull();
    expect(r.hardCapMs).toBeNull();
  });

  it('chaseRules: lives/제한시간/하드캡 전부 부재, onSkip은 무해 no-op(D95)', () => {
    const r = chaseRules();
    expect(r.timeLimitMs(mkCountry({ id: 'C00', nameKo: '가', tier: 1 }), 0)).toBeNull();
    const state = { lives: null as number | null };
    expect(() => r.onSkip(state)).not.toThrow();
    expect(state.lives).toBeNull();
  });
});

describe('ChaseSessionEngine 라이프사이클', () => {
  it('start → countdown → playing, 초기 금 스폰 + 홉0 선택지 방출', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });

    engine.start();
    expect(engine.getSnapshot().phase).toBe('countdown');
    expect(engine.getSnapshot().countdownEndsAt).toBe(COUNTDOWN_MS);

    vc.advance(COUNTDOWN_MS);
    const snap = engine.getSnapshot();
    expect(snap.phase).toBe('playing');
    expect(snap.home).toBe('C00'); // 유일 homeEligible
    expect(snap.player).toBe('C00');

    const shown = byType(events, 'candidatesShown');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.hopIndex).toBe(0);
    expect(shown[0]!.candidates).toHaveLength(3);
    // 초기 금 activeCount(기본 4)개 스폰.
    expect(byType(events, 'goldSpawned')).toHaveLength(4);
    expect(snap.candidates).toHaveLength(3);
  });

  it('playing 이전/이후 handleInput은 무시된다', () => {
    const { world, countries } = lineWorld(16);
    const { engine, events } = setup({ world, countries });
    const c = countries[1]!;
    engine.handleInput(exactEvent(c, 'ko')); // idle
    expect(byType(events, 'hopCommitted')).toHaveLength(0);
  });

  it('abort → aborted (제출 불가 상태)', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.abort();
    expect(engine.getSnapshot().phase).toBe('aborted');
    expect(byType(events, 'phase').at(-1)!.phase).toBe('aborted');
    // aborted에서 start() 재시작 가능.
    engine.start();
    expect(engine.getSnapshot().phase).toBe('countdown');
  });

  it('카운트다운 중 abort → 대기 타이머 해제 + aborted', () => {
    const { world, countries } = lineWorld(16);
    const { engine } = setup({ world, countries });
    engine.start();
    expect(engine.getSnapshot().phase).toBe('countdown');
    engine.abort(); // countdown 타이머 취소 경로
    expect(engine.getSnapshot().phase).toBe('aborted');
  });

  it('start()는 playing 중엔 no-op', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc } = setup({ world, countries });
    startPlaying(engine, vc);
    const before = engine.getSnapshot().phase;
    engine.start();
    expect(engine.getSnapshot().phase).toBe(before);
  });

  it('graph.ids 공집합이면 생성자 throw', () => {
    const emptyGraph: ChaseGraph = { ids: [], nodes: {}, matrix: '' };
    expect(
      () =>
        new ChaseSessionEngine(
          {
            now: () => 0,
            schedule: () => () => {},
            seed: 1,
            graph: emptyGraph,
            countries: [],
            constants: mergeChaseConstants({}),
          },
          'ko',
        ),
    ).toThrow();
  });
});

describe('3-타깃 EXACT 분기(D97, prefix 공유 포함)', () => {
  // home C00(tier1 유일) / C01="가"(tier3) / C02="가나"(tier3) / C03="다라"(tier4).
  // C00에서 pool=[C01,C02,C03] → 항상 3개 전부 후보. "가"⊏"가나" prefix 공유.
  function prefixWorld() {
    const specs: Spec[] = [
      { id: 'C00', nameKo: '홈국', tier: 1 },
      { id: 'C01', nameKo: '가', tier: 3 },
      { id: 'C02', nameKo: '가나', tier: 3 },
      { id: 'C03', nameKo: '다라', tier: 4 },
    ];
    return makeWorld(specs, (a, b) => Math.abs(a - b) * 1000);
  }

  it('"가" 입력 → C01로 홉(가나는 PREFIX라 미선택)', () => {
    const { world, countries } = prefixWorld();
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    expect(engine.getSnapshot().candidates.map((c) => c.id).sort()).toEqual(['C01', 'C02', 'C03']);

    engine.handleInput(exactEvent(countries.find((c) => c.id === 'C01')!, 'ko'));
    const hops = byType(events, 'hopCommitted');
    expect(hops).toHaveLength(1);
    expect(hops[0]!.to).toBe('C01');
    expect(hops[0]!.from).toBe('C00');
  });

  it('"가나" 입력 → C02로 홉', () => {
    const { world, countries } = prefixWorld();
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.handleInput(exactEvent(countries.find((c) => c.id === 'C02')!, 'ko'));
    expect(byType(events, 'hopCommitted')[0]!.to).toBe('C02');
  });

  it('matchInput 3후보 판정은 마이크로초(3× 반복 성능 확인, §11 p95<16ms는 CH-10)', () => {
    const { countries } = prefixWorld();
    const lang = 'ko' as const;
    const targets = [countries[1]!, countries[2]!, countries[3]!].map((c) => compileTargets(c, lang));
    // 엔진의 홉 해석과 동일한 연산(matchInput ×3)을 반복 측정.
    const raw = countries[2]!.acceptedInputsKo[0]!;
    const N = 20_000;
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < N; i++) {
      for (const tg of targets) {
        if (matchOne(raw, tg, lang)) hits++;
      }
    }
    const perEval = ((performance.now() - t0) * 1000) / N; // µs per 3-타깃 평가
    expect(hits).toBeGreaterThan(0);
    expect(perEval).toBeLessThan(1000); // 여유(수 µs 예상) — 마이크로초 규모 확인
  });

  it('EXACT지만 후보 매칭 실패 → bestTarget.key 폴백으로 소유 후보 홉', () => {
    const { world, countries } = prefixWorld();
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    // display=''(matchInput→PREFIX, EXACT 아님)이지만 key는 "가나"의 키 → 폴백 경로.
    const t = compileTargets(countries.find((c) => c.id === 'C02')!, 'ko')[0]!;
    engine.handleInput({
      type: 'exact',
      detail: { state: 'EXACT', bestTarget: { display: '', key: t.key }, matchedLen: 0, inputLen: 0 },
      delta: { added: 0, removed: 0, addedCorrect: 0, addedError: 0 },
      elapsedFromShownMs: 0,
    });
    expect(byType(events, 'hopCommitted')[0]!.to).toBe('C02');
  });

  it('매칭·폴백 모두 실패 → 홉 미발생(방어적)', () => {
    const { world, countries } = prefixWorld();
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.handleInput({
      type: 'exact',
      detail: { state: 'EXACT', bestTarget: { display: '', key: 'ㅋㅋㅋㅋ없음' }, matchedLen: 0, inputLen: 0 },
      delta: { added: 0, removed: 0, addedCorrect: 0, addedError: 0 },
      elapsedFromShownMs: 0,
    });
    expect(byType(events, 'hopCommitted')).toHaveLength(0);
    expect(engine.getSnapshot().hopsCommitted).toBe(0);
  });
});

describe('수배 별(wanted) — 45초 상승', () => {
  it('첫 홉 → wantedChanged(issued, up) → 45초 후 interval up', () => {
    const { world, countries } = lineWorld(16);
    // 추격조 틱을 무한대로 얼려 체포 없이 별만 오르게 한다(firstWantedHops=1).
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      wantedIntervalMs: 45_000,
      police: { chaserBaseTickMs: 10_000_000 },
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);

    hop(engine, countries, (ids) => ids[0]!);
    const w1 = byType(events, 'wantedChanged');
    expect(w1).toHaveLength(1);
    expect(w1[0]).toEqual({ type: 'wantedChanged', stars: 1, direction: 'up' });
    expect(engine.getSnapshot().stars).toBe(1);

    vc.advance(45_000);
    const w2 = byType(events, 'wantedChanged');
    expect(w2.at(-1)).toEqual({ type: 'wantedChanged', stars: 2, direction: 'up' });
    expect(engine.getSnapshot().stars).toBe(2);
    // 체포 없음(추격조 동결).
    expect(byType(events, 'arrested')).toHaveLength(0);
    expect(engine.getSnapshot().phase).toBe('playing');
  });
});

describe('체포(arrested) — 경찰 틱 도달 → finished', () => {
  it('정지한 플레이어를 추격조가 따라잡아 arrested + phase finished + finalState', () => {
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      police: { chaserBaseTickMs: 1000, chaserMinTickMs: 500 },
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    hop(engine, countries, (ids) => ids[0]!); // 이후 정지 → 추격조가 접근

    vc.advance(300_000); // 충분히 진행 → 반드시 체포
    const arr = byType(events, 'arrested');
    expect(arr).toHaveLength(1);
    expect(arr[0]!.finalState.arrestedAtMs).not.toBeNull();
    const snap = engine.getSnapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.outcome).toBe('arrested');
    expect(snap.endedAtMs).toBe(arr[0]!.finalState.arrestedAtMs);
    expect(snap.finalState).not.toBeNull();
  });

  it('finished 후 스케줄 해제 — 추가 시간 전진에도 콜백 무발화(누수 없음)', () => {
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      police: { chaserBaseTickMs: 1000, chaserMinTickMs: 500 },
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    hop(engine, countries, (ids) => ids[0]!);
    vc.advance(300_000);
    expect(engine.getSnapshot().phase).toBe('finished');
    const countAtFinish = events.length;
    vc.advance(600_000); // 종료 후 대량 전진
    expect(events.length).toBe(countAtFinish); // 어떤 이벤트도 추가되지 않음
  });
});

describe('심 패리티 — 엔진 증분 구동 == simulateChase 직접 재계산(동시각 순서 포함)', () => {
  it('엔진이 만든 moveLog로 직접 재시뮬한 결과가 엔진 finalState와 바이트 동일', () => {
    // 엔진은 홉마다 advanceChase로 증분 전진한다. 그 결과가 동일 (seed, moveLog, endMs)의 simulateChase
    // 전체 재계산과 바이트 동일하면, 엔진이 심을 결정적으로 올바르게 구동했음이 증명된다 — 이 동치는
    // §4.3 동시각 6단계 순서(플레이어 홉 → … → 경찰 틱 → 체포)를 심이 처리하고 엔진이 정확한 tMs·endMs를
    // 주입했음을 함의한다(“경찰이 들어오는 ms에 빠져나가면 생존”의 엔진측 계약). 증분==전체 자체는 CH-02
    // shared property가 보증하고, 여기서는 엔진 구동 경로가 그 입력을 올바르게 만든다는 것을 검증한다.
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      police: { chaserBaseTickMs: 1000, chaserMinTickMs: 500 },
    });
    const seed = 777;
    const { engine, vc } = setup({ world, countries, constants, seed });
    startPlaying(engine, vc);
    hop(engine, countries, (ids) => ids[0]!);
    vc.advance(400); // 첫 틱 전 소폭 전진(홉 시각 다양화)
    if (engine.getSnapshot().phase === 'playing') hop(engine, countries, (ids) => ids[0]!);
    vc.advance(300_000); // 정지 → 반드시 체포

    const snap = engine.getSnapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.outcome).toBe('arrested');

    const moveLog = engine.getMoveLog();
    const recomputed = simulateChase({ seed, moveLog, endMs: snap.endedAtMs!, constants }, world);
    expect(recomputed.arrestedAtMs).toBe(snap.finalState!.arrestedAtMs);
    expect(recomputed.player).toBe(snap.finalState!.player);
    expect(recomputed.stars).toBe(snap.finalState!.stars);
    expect(recomputed.events.length).toBe(snap.finalState!.events.length);
    // 전체 상태(경찰 좌표·RNG 소비·이벤트 로그)까지 바이트 동일.
    expect(recomputed).toEqual(snap.finalState);
  });
});

describe('자수(resign, D95)', () => {
  it('resign → finished, outcome=resigned, 제출 가능(arrested 이벤트 없음)', () => {
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      police: { chaserBaseTickMs: 10_000_000 }, // 체포 억제
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    hop(engine, countries, (ids) => ids[0]!);
    vc.advance(5_000);
    engine.resign();
    const snap = engine.getSnapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.outcome).toBe('resigned');
    expect(snap.endedAtMs).not.toBeNull();
    expect(byType(events, 'arrested')).toHaveLength(0);
    const sub = engine.buildSubmission('tok');
    expect(sub.outcome).toBe('resigned');
    expect(sub.token).toBe('tok');
    expect(sub.moveLog).toHaveLength(1);
    expect(sub.perHop).toHaveLength(1);
  });

  it('resign은 playing 이외에서 no-op', () => {
    const { world, countries } = lineWorld(16);
    const { engine } = setup({ world, countries });
    engine.resign();
    expect(engine.getSnapshot().phase).toBe('idle');
  });
});

describe('practice 강등 승계(bulk/blur)', () => {
  it('bulkInsert → degradedToPractice(bulk), 단방향 1회', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.handleInput({ type: 'bulkInsert' });
    engine.handleInput({ type: 'bulkInsert' });
    const deg = byType(events, 'degradedToPractice');
    expect(deg).toHaveLength(1);
    expect(deg[0]!.reason).toBe('bulk');
    expect(engine.getSnapshot().practice).toBe(true);
  });

  it('blurred → degradedToPractice(blur)', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.handleInput({ type: 'blurred' });
    expect(byType(events, 'degradedToPractice')[0]!.reason).toBe('blur');
  });
});

describe('콤보·통계·statsTick', () => {
  it('무오타 홉 → comboChanged +1, 오타 홉 → 콤보 0', () => {
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({ police: { chaserBaseTickMs: 10_000_000 } });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    hop(engine, countries, (ids) => ids[0]!); // 무오타 → combo 1
    hop(engine, countries, (ids) => ids[0]!, { errors: 1 }); // 오타 → combo 0
    const combos = byType(events, 'comboChanged').map((e) => e.combo);
    expect(combos).toEqual([1, 0]);
    expect(engine.getSnapshot().maxCombo).toBe(1);
  });

  it('statsTick는 500ms마다 방출된다', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    vc.advance(STATS_TICK_MS * 3 + 10);
    expect(byType(events, 'statsTick').length).toBeGreaterThanOrEqual(3);
  });

  it('skipRequested/latinInKoMode/refocused는 no-op(홉·throw 없음)', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    engine.handleInput({ type: 'skipRequested' });
    engine.handleInput({ type: 'latinInKoMode' });
    engine.handleInput({ type: 'refocused' });
    expect(byType(events, 'hopCommitted')).toHaveLength(0);
    expect(engine.getSnapshot().phase).toBe('playing');
  });

  it('progress 이벤트는 통계 누적만(홉 없음)', () => {
    const { world, countries } = lineWorld(16);
    const { engine, vc, events } = setup({ world, countries });
    startPlaying(engine, vc);
    const c = countries.find((x) => x.id === engine.getSnapshot().candidates[0]!.id)!;
    const t = compileTargets(c, 'ko')[0]!;
    engine.handleInput({
      type: 'progress',
      detail: { state: 'PREFIX', bestTarget: t, matchedLen: 1, inputLen: 1 },
      delta: { added: 1, removed: 0, addedCorrect: 1, addedError: 0 },
      rawValue: '가',
    });
    expect(byType(events, 'hopCommitted')).toHaveLength(0);
  });
});

describe('경찰 escalation + 후보 위험(candidateDangerChanged)', () => {
  it('헬기(★5)가 바깥에서 접근하며 현재 후보국에 진입 → candidateDangerChanged(true) 발생', () => {
    const { world, countries } = lineWorld(20); // home C00(끝)
    // 추격조·차단조 동결, 헬기만 이동. 별 빠르게 상승(★5 → 헬기 스폰). 플레이어는 홈 근처에 정지시켜
    // 헬기 4홉 링을 바깥으로 강제(안쪽 링은 홈/라인 끝에 막힘) → 헬기가 바깥 후보국들을 통과.
    const constants = mergeChaseConstants({
      firstWantedHops: 1,
      wantedIntervalMs: 3_000,
      police: { chaserBaseTickMs: 10_000_000, interceptorTickMs: 10_000_000, heliTickMs: 1500 },
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    // 홈(C00)에서 가장 가까운(최소 index) 후보로 한 번만 홉 → 플레이어를 홈 근처에 고정.
    hop(engine, countries, (ids) => ids.slice().sort()[0]!);
    // ★5까지 상승 + 헬기 접근이 후보국을 지나가도록 충분히 전진.
    vc.advance(60_000);
    const dangers = byType(events, 'candidateDangerChanged');
    expect(dangers.length).toBeGreaterThan(0);
    expect(dangers.some((d) => d.danger === true)).toBe(true);
    // 헬기 이동으로 policeUpdated(이동)도 방출됐다.
    expect(byType(events, 'policeUpdated').length).toBeGreaterThan(0);
  });
});

describe('금 획득·배송(goldPicked/delivered)', () => {
  it('금 국가 경유 → goldPicked, 홈 귀환 → delivered', () => {
    const { world, countries } = lineWorld(16);
    // 수배·경찰 억제(firstWantedHops 매우 큼 → 발령 없음). 금 스폰/획득/배송만 관찰.
    const constants = mergeChaseConstants({
      firstWantedHops: 1000,
      police: { chaserBaseTickMs: 10_000_000 },
    });
    const { engine, vc, events } = setup({ world, countries, constants });
    startPlaying(engine, vc);

    const goldSet = (): Set<CountryId> => {
      const s = new Set<CountryId>();
      for (const e of events) {
        if (e.type === 'goldSpawned') s.add(e.at);
        else if (e.type === 'goldPicked') s.delete(e.at);
      }
      return s;
    };

    // 최대 30홉: 금 위의 후보가 있으면 획득, 소지 중이면 홈으로 배송, 아니면 첫 후보.
    for (let i = 0; i < 30; i++) {
      if (engine.getSnapshot().phase !== 'playing') break;
      if (byType(events, 'delivered').length > 0) break;
      const cands = engine.getSnapshot().candidates.map((c) => c.id);
      const golds = goldSet();
      const home = engine.getSnapshot().home!;
      const carrying = byType(events, 'goldPicked').length > byType(events, 'delivered').length;
      let target: CountryId;
      const goldCand = cands.find((c) => golds.has(c));
      if (carrying && cands.includes(home)) target = home; // 배송(홈 강제 치환으로 후보에 홈 등장)
      else if (goldCand) target = goldCand; // 획득
      else target = cands[0]!;
      engine.handleInput(exactEvent(countries.find((c) => c.id === target)!, 'ko'));
      vc.advance(50);
    }

    expect(byType(events, 'goldPicked').length).toBeGreaterThan(0);
    expect(byType(events, 'delivered').length).toBeGreaterThan(0);
    const del = byType(events, 'delivered')[0]!;
    expect(del.count).toBeGreaterThanOrEqual(1);
    expect(del.payout).toBeGreaterThan(0);
  });
});

describe('스냅샷·제출·moveLog API', () => {
  it('getSnapshot/getMoveLog/getCandidateCountries/buildSubmission', () => {
    const { world, countries } = lineWorld(16);
    const constants = mergeChaseConstants({ police: { chaserBaseTickMs: 10_000_000 } });
    const { engine, vc } = setup({ world, countries, constants });
    startPlaying(engine, vc);
    expect(engine.getCandidateCountries()).toHaveLength(3);

    const to = hop(engine, countries, (ids) => ids[0]!);
    expect(engine.getMoveLog()).toHaveLength(1);
    expect(engine.getMoveLog()[0]!.countryId).toBe(to);

    const snap = engine.getSnapshot();
    expect(snap.mode).toBe('chase');
    expect(snap.hopsCommitted).toBe(1);
    expect(snap.totalKeystrokes).toBeGreaterThan(0);

    const sub = engine.buildSubmission();
    expect(sub.seed).toBe(12345);
    expect(sub.perHop[0]!.code).toBe(to);
    expect(sub.perHop[0]!.skipped).toBe(false);
    expect(typeof sub.inputDigest).toBe('string');
  });
});

/** 성능 테스트용 얇은 래퍼 — 엔진 handleInput의 홉 해석(matchInput ×3)과 동일 연산. */
function matchOne(raw: string, targets: ReturnType<typeof compileTargets>, lang: 'ko' | 'en'): boolean {
  return matchInput(raw, targets, lang) === 'EXACT';
}
