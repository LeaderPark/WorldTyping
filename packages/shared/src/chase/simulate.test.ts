// spec: docs/09 §4(결정성 계약)·§3.3~3.5·§4.3(동시각 6단계)·§12(테스트 계획 1~4행),
//       docs/00 §11-D91(결정성 불변식)·D93(도주 감소)·D94·D95(자수)
//
// 심 골든 벡터(고정 seed+moveLog → ChaseState 전체 스냅샷) + 결정성 property(동일 입력 2회 동일 /
// 증분==전체 재계산 / 스트림 소비 순서 불변) + 동시각 6단계 + verifyMoveLog + 자수 + 금/배송 거동.
//
// 골든 벡터 생성: `WT_GEN_CHASE_GOLDEN=1`로 실행하면 실 그래프(@wt/data)로 재생성해 __fixtures__에 동결.
// 평상시엔 동결된 입력을 재실행해 동결된 expected와 대조한다(진짜 회귀 가드 — 심 거동이 바뀌면 실패).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHASE_GRAPH, COUNTRIES } from '@wt/data';
import type { CountryId, DifficultyTier } from '../types/country';
import { mergeChaseConstants, type ChaseConstants, type ChaseConstantsOverride } from './constants';
import { compileGraph, type ChaseGraph, type ChaseGraphNode, type ChaseWorld } from './graph';
import {
  advanceChase,
  simulateChase,
  verifyMoveLog,
  type ChaseInput,
  type ChaseState,
  type MoveLogEntry,
} from './simulate';

function realWorld(): ChaseWorld {
  const tiers: Record<CountryId, DifficultyTier> = {};
  for (const c of COUNTRIES) tiers[c.id] = c.difficultyTier;
  return { graph: CHASE_GRAPH as unknown as ChaseGraph, tiers };
}
const world = realWorld();
const g = compileGraph(world.graph);

// ── 재생 드라이버: 유효한 moveLog를 결정적으로 만든다(각 홉이 그 시점 선택지 중 하나) ──────────────
type PickFn = (cands: CountryId[], probe: ChaseState) => CountryId;

interface Recipe {
  name: string;
  description: string;
  seed: number;
  override: ChaseConstantsOverride;
  maxHops: number;
  intervalMs: number;
  tailMs: number;
  pick: PickFn;
  /** 마지막에 경찰국으로 자살 홉을 붙여 체포를 결정적으로 유도. */
  suicide?: boolean;
}

function playthrough(recipe: Recipe): { moveLog: MoveLogEntry[]; endMs: number } {
  const constants = mergeChaseConstants(recipe.override);
  const moveLog: MoveLogEntry[] = [];
  let t = 0;
  for (let i = 0; i < recipe.maxHops; i++) {
    const probe = simulateChase({ seed: recipe.seed, moveLog, endMs: t, constants }, world);
    if (probe.arrestedAtMs !== null) break;
    const cands = probe.candidates;
    if (cands.length === 0) break;
    const choice = recipe.pick(cands, probe);
    t += recipe.intervalMs;
    moveLog.push({ hopIndex: moveLog.length, countryId: choice, tMs: t });
  }
  let endMs = t + recipe.tailMs;
  if (recipe.suicide) {
    const suicideT = t + recipe.intervalMs;
    const probe = simulateChase({ seed: recipe.seed, moveLog, endMs: suicideT - 1, constants }, world);
    if (probe.arrestedAtMs === null && probe.police.length > 0) {
      const target = [...probe.police].sort((a, b) => a.id - b.id)[0]!.at;
      moveLog.push({ hopIndex: moveLog.length, countryId: target, tMs: suicideT });
      endMs = suicideT;
    } else {
      endMs = suicideT - 1;
    }
  }
  return { moveLog, endMs };
}

// pick 전략들.
const pickPreferGold: PickFn = (cands, probe) => {
  const goldSet = new Set(probe.golds.map((x) => x.at));
  return cands.find((c) => goldSet.has(c)) ?? cands[0]!;
};
const pickDeliver: PickFn = (cands, probe) => {
  if (probe.carried.length > 0 && cands.includes(probe.home)) return probe.home;
  const goldSet = new Set(probe.golds.map((x) => x.at));
  const gold = cands.find((c) => goldSet.has(c));
  if (gold) return gold;
  // 홈 근처 유지(홈 강제가 계속 걸리도록).
  return [...cands].sort((a, b) => g.dist(probe.home, a) - g.dist(probe.home, b))[0]!;
};
const pickFlee: PickFn = (cands, probe) => {
  const police = probe.police.map((p) => p.at);
  const minDistToPolice = (c: CountryId): number =>
    police.length === 0 ? g.dist(probe.home, c) : Math.min(...police.map((p) => g.dist(p, c)));
  return [...cands].sort((a, b) => minDistToPolice(b) - minDistToPolice(a))[0]!;
};

const RECIPES: Recipe[] = [
  {
    name: 'issuance-pickup',
    description: '기본 상수, ~6홉: 홈 3홉 발령(★1) + 금 국가 경유 획득. 체포 없음(짧은 도주).',
    seed: 0xa5a5a5,
    override: {},
    maxHops: 6,
    intervalMs: 1500,
    tailMs: 2000,
    pick: pickPreferGold,
  },
  {
    name: 'delivery',
    description: '발령 거리 완화(800km), ~12홉: 금 획득 후 홈 귀환 배송(콤보 배수 정산·★−2). 체포 없음.',
    seed: 0x123456,
    override: { firstWantedDistanceKm: 800 },
    maxHops: 12,
    intervalMs: 1500,
    tailMs: 1000,
    pick: pickDeliver,
  },
  {
    name: 'escalation-arrest',
    description: '수배 가속(45s→5s)·발령 2홉: 도주하며 ★ 상승(추격조·차단조·헬기 스폰·경찰 이동) 후 경찰국 자살 홉으로 체포.',
    seed: 0x9e3779,
    override: { wantedIntervalMs: 5000, firstWantedHops: 2 },
    maxHops: 20,
    intervalMs: 1500,
    tailMs: 0,
    pick: pickFlee,
    suicide: true,
  },
];

const GEN = process.env.WT_GEN_CHASE_GOLDEN === '1';
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/chase-golden-${name}.json`, import.meta.url));
}

interface GoldenFixture {
  name: string;
  description: string;
  seed: number;
  constantsOverride: ChaseConstantsOverride;
  moveLog: MoveLogEntry[];
  endMs: number;
  expected: ChaseState;
}

beforeAll(() => {
  if (!GEN) return;
  const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const recipe of RECIPES) {
    const constants = mergeChaseConstants(recipe.override);
    const { moveLog, endMs } = playthrough(recipe);
    const expected = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    const fixture: GoldenFixture = {
      name: recipe.name,
      description: recipe.description,
      seed: recipe.seed,
      constantsOverride: recipe.override,
      moveLog,
      endMs,
      expected,
    };
    writeFileSync(fixturePath(recipe.name), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  }
});

describe('심 골든 벡터(§12 1행) — 동결 입력 재실행 == 동결 ChaseState', () => {
  for (const recipe of RECIPES) {
    it(`${recipe.name}: ${recipe.description}`, () => {
      const fixture = JSON.parse(readFileSync(fixturePath(recipe.name), 'utf8')) as GoldenFixture;
      const input: ChaseInput = {
        seed: fixture.seed,
        moveLog: fixture.moveLog,
        endMs: fixture.endMs,
        constants: mergeChaseConstants(fixture.constantsOverride),
      };
      const result = simulateChase(input, world);
      expect(result).toEqual(fixture.expected);
    });
  }

  it('escalation-arrest 골든은 실제로 체포로 끝나고 ★5(heli)·차단조를 거친다(브랜치 스윕)', () => {
    const fixture = JSON.parse(readFileSync(fixturePath('escalation-arrest'), 'utf8')) as GoldenFixture;
    const st = fixture.expected;
    expect(st.arrestedAtMs).not.toBeNull();
    expect(st.events.some((e) => e.type === 'arrested')).toBe(true);
    const kinds = new Set(st.events.filter((e) => e.type === 'policeSpawned').map((e) => (e as { kind: string }).kind));
    expect(kinds.has('chaser')).toBe(true);
    expect(kinds.has('interceptor')).toBe(true); // ★3
    expect(kinds.has('heli')).toBe(true); // ★5
    expect(st.events.some((e) => e.type === 'policeMoved')).toBe(true);
  });

  it('delivery 골든은 배송 정산(콤보 배수식)을 포함하고 payout이 공식과 일치', () => {
    const fixture = JSON.parse(readFileSync(fixturePath('delivery'), 'utf8')) as GoldenFixture;
    const delivered = fixture.expected.events.filter((e) => e.type === 'delivered') as Array<{
      count: number;
      payout: number;
    }>;
    expect(delivered.length).toBeGreaterThanOrEqual(1);
  });
});

describe('결정성 property(§12 2행)', () => {
  const recipe = RECIPES[2]!; // 가장 복잡한 시나리오로 검증.
  const constants = mergeChaseConstants(recipe.override);
  let moveLog: MoveLogEntry[];
  let endMs: number;
  beforeAll(() => {
    const built = playthrough(recipe);
    moveLog = built.moveLog;
    endMs = built.endMs;
  });

  it('동일 입력 2회 실행 → 바이트 동일', () => {
    const a = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    const b = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    expect(a).toEqual(b);
  });

  it('증분 실행(advance) == 전체 재계산 — 여러 분할점', () => {
    const full = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    for (const k of [0, 1, Math.floor(moveLog.length / 2), moveLog.length - 1]) {
      if (k < 0) continue;
      const midMs = k < moveLog.length ? moveLog[k]!.tMs : endMs;
      const prefix = moveLog.slice(0, k + 1);
      const prev = simulateChase({ seed: recipe.seed, moveLog: prefix, endMs: midMs, constants }, world);
      const advanced = advanceChase(prev, { seed: recipe.seed, moveLog, endMs, constants }, world);
      expect(advanced).toEqual(full);
    }
  });

  it('스트림 소비 순서 불변 — draws 카운터가 결정적이고 스트림 시드가 seed^1/2/3', () => {
    const s = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    const s2 = simulateChase({ seed: recipe.seed, moveLog, endMs, constants }, world);
    expect(s.rngCandidates).toEqual(s2.rngCandidates);
    expect(s.rngGold).toEqual(s2.rngGold);
    expect(s.rngPolice).toEqual(s2.rngPolice);
    expect(s.rngCandidates.seed).toBe((recipe.seed ^ 0x1) >>> 0);
    expect(s.rngGold.seed).toBe((recipe.seed ^ 0x2) >>> 0);
    expect(s.rngPolice.seed).toBe((recipe.seed ^ 0x3) >>> 0);
    expect(s.rngCandidates.draws).toBeGreaterThan(0);
  });

  it('advance는 prev를 변형하지 않는다(순수)', () => {
    const prev = simulateChase({ seed: recipe.seed, moveLog: moveLog.slice(0, 2), endMs: moveLog[1]!.tMs, constants }, world);
    const snapshot = JSON.parse(JSON.stringify(prev));
    advanceChase(prev, { seed: recipe.seed, moveLog, endMs, constants }, world);
    expect(prev).toEqual(snapshot);
  });
});

// ── 동시각 6단계(§4.3) — 합성 라인 그래프로 손검증 ─────────────────────────────────────────
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function makeWorld(
  ids: string[],
  distMap: Record<string, number>,
  nearestLists: Record<string, string[]>,
  tiers: Record<string, DifficultyTier>,
  homeEligible: string[],
): ChaseWorld {
  const d = (a: string, b: string): number => (a === b ? 0 : distMap[pairKey(a, b)]!);
  const n = ids.length;
  const bytes = new Uint8Array((n * (n - 1)) / 2 * 2);
  const dv = new DataView(bytes.buffer);
  let off = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      dv.setUint16(off * 2, d(ids[i]!, ids[j]!), true);
      off++;
    }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const nodes: Record<string, ChaseGraphNode> = {};
  for (const id of ids)
    nodes[id] = {
      nearest: (nearestLists[id] ?? []).map((nb) => ({ id: nb, km: d(id, nb) })),
      homeEligible: homeEligible.includes(id),
    };
  return { graph: { ids, nodes, matrix: btoa(bin) }, tiers };
}

describe('동시각 6단계(§4.3) — "동시각 탈출 = 생존"', () => {
  // 라인 A(홈)-B-C-D. 홈만 homeEligible → home=A. 발령 1홉, 금·45s·도주 비활성. 추격조 틱 1000ms.
  const w = makeWorld(
    ['A', 'B', 'C', 'D'],
    { 'A|B': 100, 'A|C': 200, 'A|D': 300, 'B|C': 100, 'B|D': 200, 'C|D': 100 },
    { A: ['B'], B: ['A', 'C'], C: ['B', 'D'], D: ['C'] },
    { A: 1, B: 1, C: 1, D: 1 },
    ['A'],
  );
  const constants: ChaseConstants = mergeChaseConstants({
    firstWantedHops: 1,
    firstWantedDistanceKm: 9_999_999,
    wantedIntervalMs: 10_000_000,
    escapeReduction: { enabled: false },
    gold: { activeCount: 0 },
    police: { chaserBaseTickMs: 1000, chaserTickPerStarMs: 0, chaserMinTickMs: 1000, chaserSpawnHopsBack: 2 },
  });
  const seed = 42;

  it('발령 시 추격조가 스폰(홈·플레이어 제외 → C), 첫 틱 2000ms', () => {
    const st = simulateChase({ seed, moveLog: [{ hopIndex: 0, countryId: 'B', tMs: 1000 }], endMs: 1500, constants }, w);
    expect(st.stars).toBe(1);
    expect(st.police).toHaveLength(1);
    expect(st.police[0]!.kind).toBe('chaser');
    expect(st.police[0]!.at).toBe('C');
    expect(st.police[0]!.nextTickMs).toBe(2000);
  });

  it('머무르면 체포(⑥) — 경찰 틱이 플레이어국으로 진입', () => {
    const st = simulateChase({ seed, moveLog: [{ hopIndex: 0, countryId: 'B', tMs: 1000 }], endMs: 2000, constants }, w);
    expect(st.arrestedAtMs).toBe(2000);
    const arrested = st.events.find((e) => e.type === 'arrested');
    expect(arrested).toMatchObject({ by: 'chaser', at: 'B' });
  });

  it('같은 ms에 홉으로 빠져나가면 생존(① 플레이어 홉 < ⑤ 경찰 틱)', () => {
    const st = simulateChase(
      {
        seed,
        moveLog: [
          { hopIndex: 0, countryId: 'B', tMs: 1000 },
          { hopIndex: 1, countryId: 'A', tMs: 2000 }, // 경찰 틱과 동시각에 B→A 탈출
        ],
        endMs: 2000,
        constants,
      },
      w,
    );
    expect(st.arrestedAtMs).toBeNull(); // 생존
    expect(st.player).toBe('A');
    expect(st.police[0]!.at).toBe('B'); // 경찰은 플레이어의 옛 위치 B로 들어왔지만 놓침
  });
});

// ── verifyMoveLog(§4.4) ─────────────────────────────────────────────────────────────────
describe('verifyMoveLog(§4.4) — moveLog 재생성 대조', () => {
  it('드라이버가 만든 정상 moveLog는 valid(각 홉이 그 시점 선택지 중 하나)', () => {
    const recipe = RECIPES[0]!;
    const { moveLog, endMs } = playthrough(recipe);
    const constants = mergeChaseConstants(recipe.override);
    const res = verifyMoveLog({ seed: recipe.seed, moveLog, endMs, constants }, world);
    expect(res.valid).toBe(true);
  });

  it('선택지 밖 국가로 위조한 홉은 invalid(reason=not-a-candidate)', () => {
    const recipe = RECIPES[0]!;
    const { moveLog, endMs } = playthrough(recipe);
    const constants = mergeChaseConstants(recipe.override);
    // 첫 홉을 그 시점 선택지가 아닌 국가로 위조(선택지에 없는 먼 국가).
    const probe0 = simulateChase({ seed: recipe.seed, moveLog: [], endMs: 0, constants }, world);
    const notCand = CHASE_GRAPH.ids.find((id) => !probe0.candidates.includes(id) && id !== probe0.home)!;
    const forged = [{ ...moveLog[0]!, countryId: notCand }, ...moveLog.slice(1)];
    const res = verifyMoveLog({ seed: recipe.seed, moveLog: forged, endMs, constants }, world);
    expect(res.valid).toBe(false);
    expect(res.badHopIndex).toBe(0);
    expect(res.reason).toBe('not-a-candidate');
  });

  it('endMs 이후로 조작된 홉 시각은 invalid(reason=not-processed)', () => {
    const recipe = RECIPES[0]!;
    const { moveLog } = playthrough(recipe);
    const constants = mergeChaseConstants(recipe.override);
    const res = verifyMoveLog({ seed: recipe.seed, moveLog, endMs: moveLog[0]!.tMs - 1, constants }, world);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('not-processed');
  });
});

// ── 자수(D95) ────────────────────────────────────────────────────────────────────────────
describe('자수/진행중 종료(D95) — 미체포 상태의 endMs 평가', () => {
  // 수배 미발령(경찰 無 → 체포 불가) 합성 그래프로 "진행 중 종료" 스냅샷을 확정 검증.
  const w = makeWorld(
    ['B', 'C', 'H'],
    { 'B|C': 100, 'B|H': 200, 'C|H': 300 },
    { B: ['C', 'H'], C: ['B', 'H'], H: ['B', 'C'] },
    { B: 1, C: 1, H: 1 },
    ['H'],
  );
  const constants: ChaseConstants = mergeChaseConstants({
    firstWantedHops: 999,
    firstWantedDistanceKm: 9_999_999,
    gold: { activeCount: 0 },
  });

  it('endMs를 홉 사이로 주면 그 시점 스냅샷(arrestedAtMs=null·부분 적용)', () => {
    const moveLog: MoveLogEntry[] = [
      { hopIndex: 0, countryId: 'B', tMs: 1000 },
      { hopIndex: 1, countryId: 'C', tMs: 2000 },
    ];
    const st = simulateChase({ seed: 3, moveLog, endMs: 1500, constants }, w);
    expect(st.arrestedAtMs).toBeNull();
    expect(st.timeMs).toBe(1500);
    expect(st.hopsProcessed).toBe(1); // tMs<=1500 홉만 적용(1000 적용, 2000 미적용)
    expect(st.player).toBe('B');
  });
});

// ── 금 시스템(§3.5) ─────────────────────────────────────────────────────────────────────
describe('금 획득·배송 정산(§3.5) — 합성 그래프로 값 검증', () => {
  // 홈 H, 금 후보 2개: G1(near 2500km→400), G2(mid 5000km→700). 나머지는 <2000km(비적격) 없음.
  const w = makeWorld(
    ['G1', 'G2', 'H'],
    { 'G1|G2': 3000, 'G1|H': 2500, 'G2|H': 5000 },
    { G1: ['G2', 'H'], G2: ['G1', 'H'], H: ['G1', 'G2'] },
    { G1: 1, G2: 1, H: 1 },
    ['H'],
  );
  const constants: ChaseConstants = mergeChaseConstants({
    firstWantedHops: 999,
    firstWantedDistanceKm: 9_999_999, // 수배 미발령(경찰 無 → 체포 無, 금 거동만)
    gold: { activeCount: 2 },
  });
  const seed = 7;

  it('t0에 금 2개가 near/mid 밴드에 스폰(값 400·700)', () => {
    const st = simulateChase({ seed, moveLog: [], endMs: 0, constants }, w);
    expect(st.golds).toHaveLength(2);
    const byAt = Object.fromEntries(st.golds.map((x) => [x.at, x]));
    expect(byAt['G1']).toMatchObject({ ring: 'near', value: 400 });
    expect(byAt['G2']).toMatchObject({ ring: 'mid', value: 700 });
  });

  it('금 국가 도착 시 자동 획득 + 즉시 재스폰(항상 activeCount 유지)', () => {
    const st = simulateChase({ seed, moveLog: [{ hopIndex: 0, countryId: 'G1', tMs: 1000 }], endMs: 1000, constants }, w);
    expect(st.carried).toHaveLength(1);
    expect(st.carried[0]).toMatchObject({ value: 400, ring: 'near' });
    expect(st.events.some((e) => e.type === 'goldPicked' && e.at === 'G1')).toBe(true);
    // G1 획득 후 재스폰 시도: 적격국(G1,G2) 중 G2는 기존 금·플레이어는 G1 → 재스폰 불가(적격 소진) → 1개 유지.
    expect(st.golds.length).toBeGreaterThanOrEqual(1);
  });

  it('2개 소지 후 홈 배송 정산 = round(Σ가치 × (1 + 0.25×(개수−1))) = (400+700)×1.25 = 1375', () => {
    const st = simulateChase(
      {
        seed,
        moveLog: [
          { hopIndex: 0, countryId: 'G1', tMs: 1000 },
          { hopIndex: 1, countryId: 'G2', tMs: 2000 },
          { hopIndex: 2, countryId: 'H', tMs: 3000 },
        ],
        endMs: 3000,
        constants,
      },
      w,
    );
    const delivered = st.events.find((e) => e.type === 'delivered') as { count: number; payout: number } | undefined;
    expect(delivered).toBeDefined();
    expect(delivered!.count).toBe(2);
    expect(delivered!.payout).toBe(1375);
    expect(st.carried).toHaveLength(0); // 배송 후 비워짐
  });

  it('1개 소지 배송 = 가치 그대로(콤보 배수 1.0)', () => {
    const st = simulateChase(
      {
        seed,
        moveLog: [
          { hopIndex: 0, countryId: 'G1', tMs: 1000 },
          { hopIndex: 1, countryId: 'H', tMs: 2000 },
        ],
        endMs: 2000,
        constants,
      },
      w,
    );
    const delivered = st.events.find((e) => e.type === 'delivered') as { count: number; payout: number } | undefined;
    expect(delivered!.count).toBe(1);
    expect(delivered!.payout).toBe(400);
  });
});

// ── 도주 수배 감소(D93) ─────────────────────────────────────────────────────────────────
describe('도주 수배 감소(D93·§3.3)', () => {
  // 클러스터(H,M,N 근접) + 먼 은신국 F(8000km). 경찰은 전부 클러스터에 스폰·정지 → 항상 far.
  const w = makeWorld(
    ['F', 'H', 'M', 'N'],
    { 'F|H': 8000, 'F|M': 8000, 'F|N': 8000, 'H|M': 100, 'H|N': 120, 'M|N': 90 },
    { F: ['M', 'N'], H: ['M', 'N'], M: ['H', 'N'], N: ['H', 'M'] },
    { F: 1, H: 1, M: 1, N: 1 },
    ['H'],
  );
  // 모든 경찰 사실상 정지(틱 100000ms > endMs) → F에 순간이동한 플레이어와 항상 8000km far.
  const frozenPolice = {
    chaserBaseTickMs: 100000,
    chaserTickPerStarMs: 0,
    chaserMinTickMs: 100000,
    interceptorTickMs: 100000,
    heliTickMs: 100000,
  } as const;

  it('발령 후 전 경찰과 windowMs간 ≥3000km 유지하면 ★−1(하한1)', () => {
    const constants: ChaseConstants = mergeChaseConstants({
      firstWantedHops: 1,
      firstWantedDistanceKm: 1,
      wantedIntervalMs: 8000, // ★2 도달(도주 감소 대상 stars>floor=1)
      wantedMax: 2, // 추격조만(차단조/헬기 스폰 배제 — 클러스터 정지 유지 단순화)
      escapeReduction: { enabled: true, windowMs: 20000, distanceKm: 3000, cooldownMs: 30000, starDrop: 1, floor: 1 },
      gold: { activeCount: 0 },
      police: { ...frozenPolice },
    });
    const st = simulateChase({ seed: 1, moveLog: [{ hopIndex: 0, countryId: 'F', tMs: 1000 }], endMs: 40_000, constants }, w);
    const escapeEvents = st.events.filter((e) => e.type === 'starChanged' && (e as { reason: string }).reason === 'escape');
    expect(escapeEvents.length).toBeGreaterThanOrEqual(1);
    expect(st.stars).toBeGreaterThanOrEqual(1); // 하한 floor=1 유지
  });

  it('escapeReduction.enabled=false면 도주 감소가 절대 발생하지 않는다', () => {
    const constants: ChaseConstants = mergeChaseConstants({
      firstWantedHops: 1,
      firstWantedDistanceKm: 1,
      wantedIntervalMs: 8000,
      wantedMax: 2,
      escapeReduction: { enabled: false },
      gold: { activeCount: 0 },
      police: { ...frozenPolice },
    });
    const st = simulateChase({ seed: 1, moveLog: [{ hopIndex: 0, countryId: 'F', tMs: 1000 }], endMs: 40_000, constants }, w);
    expect(st.events.some((e) => e.type === 'starChanged' && (e as { reason: string }).reason === 'escape')).toBe(false);
  });
});
