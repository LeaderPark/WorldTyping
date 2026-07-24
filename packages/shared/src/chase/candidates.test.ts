// spec: docs/09 §3.2(선택지 생성 불변식), docs/00 §11-D91(rng_candidates·ISO 동률·홈 강제 슬롯)
import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '@wt/data';
import { CHASE_GRAPH } from '@wt/data';
import type { CountryId, DifficultyTier } from '../types/country';
import { mulberry32 } from '../protocol/seeding';
import { candidatesAreValid, generateCandidates, type CandidateContext } from './candidates';
import { DEFAULT_CHASE_CONSTANTS } from './constants';
import { compileGraph, type ChaseGraph, type ChaseGraphNode, type ChaseWorld } from './graph';

function realWorld(): ChaseWorld {
  const tiers: Record<CountryId, DifficultyTier> = {};
  for (const c of COUNTRIES) tiers[c.id] = c.difficultyTier;
  return { graph: CHASE_GRAPH as unknown as ChaseGraph, tiers };
}

// ── 합성 그래프(엣지 케이스 정밀 제어) ──────────────────────────────────────────────────────
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
  for (const id of ids) {
    nodes[id] = {
      nearest: (nearestLists[id] ?? []).map((nb) => ({ id: nb, km: d(id, nb) })),
      homeEligible: homeEligible.includes(id),
    };
  }
  return { graph: { ids, nodes, matrix: btoa(bin) }, tiers };
}

describe('generateCandidates 불변식 — 실 그래프 전수 스윕', () => {
  const world = realWorld();
  const g = compileGraph(world.graph);

  it('임의 현재국·경찰집합에서 항상 정확히 3개·중복 없음·경찰국 배제', () => {
    const rng = mulberry32(0x51ee11);
    const next = () => rng();
    let checked = 0;
    for (const current of CHASE_GRAPH.ids) {
      const near = g.outNeighbors(current);
      // 경찰 0·1·2기 케이스(경찰은 nearest 상위국에 위치시켜 배제 압박).
      for (const policeN of [0, 1, 2]) {
        const police = new Set<CountryId>(near.slice(0, policeN));
        // 직전 2홉: nearest 3·4번째(있으면).
        const visited: CountryId[] = [near[3] ?? current, near[2] ?? current, current];
        for (const carried of [0, 1]) {
          const home = g.homeEligibleIds()[0]!;
          const ctx: CandidateContext = { visited, home, carriedCount: carried, policeCountries: police };
          const cands = generateCandidates(ctx, world, DEFAULT_CHASE_CONSTANTS, next);
          expect(candidatesAreValid(cands, police)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('금 소지 && 홈이 pool 내 → 홈이 반드시 후보에 포함(귀환 루트 보장)', () => {
    // 홈을 현재국의 nearest 중 하나로 설정해 pool 내 존재를 강제.
    let found = 0;
    const rng = mulberry32(7);
    const next = () => rng();
    for (const current of CHASE_GRAPH.ids.slice(0, 40)) {
      const near = g.outNeighbors(current);
      const home = near[5]!; // pool 내 홈
      const ctx: CandidateContext = {
        visited: [current], // prev 없음(홈 제외 압박 없음)
        home,
        carriedCount: 2,
        policeCountries: new Set(),
      };
      const cands = generateCandidates(ctx, world, DEFAULT_CHASE_CONSTANTS, next);
      expect(cands).toContain(home);
      expect(candidatesAreValid(cands, new Set())).toBe(true);
      found++;
    }
    expect(found).toBe(40);
  });
});

describe('generateCandidates 엣지 — 합성 그래프', () => {
  it('홈 강제 치환 슬롯 = HARD 우선(§3.2 step5, 킷 §6)', () => {
    // C(현재) nearest: E1(easy,100) < HM(easy=홈,300) < M1(mid,400) < Hd1(hard,500).
    // 홈 HM은 직전 방문국으로 제외되지만, 금 소지 시 홈 강제가 HARD 슬롯(Hd1)을 치환한다.
    const world = makeWorld(
      ['C', 'E1', 'HM', 'M1', 'Hd1'],
      {
        'C|E1': 100, 'C|HM': 300, 'C|M1': 400, 'C|Hd1': 500,
        'E1|HM': 250, 'E1|M1': 350, 'E1|Hd1': 450, 'HM|M1': 200, 'HM|Hd1': 260, 'M1|Hd1': 150,
      },
      { C: ['E1', 'HM', 'M1', 'Hd1'], E1: ['C'], HM: ['C'], M1: ['C'], Hd1: ['C'] },
      { C: 1, E1: 1, HM: 2, M1: 3, Hd1: 4 },
      ['HM', 'E1', 'C'],
    );
    const next = () => 0; // 각 버킷 idx0.
    const cands = generateCandidates(
      { visited: ['HM', 'C'], home: 'HM', carriedCount: 1, policeCountries: new Set() },
      world,
      DEFAULT_CHASE_CONSTANTS,
      next,
    );
    expect(cands).toContain('HM'); // 홈 강제 편입
    expect(cands).not.toContain('Hd1'); // HARD 슬롯이 치환됨
    expect(cands).toEqual(['E1', 'M1', 'HM']); // easy·mid 유지 + hard→home
  });

  it('pool<3(직전 방문국 과다 제외)이면 최근국부터 복원해 정확히 3개', () => {
    // C nearest = [P1,P2,P3] (3개뿐). 직전 2홉 = P1,P2 → 제외 시 1개 → 복원.
    const world = makeWorld(
      ['C', 'P1', 'P2', 'P3'],
      { 'C|P1': 100, 'C|P2': 200, 'C|P3': 300, 'P1|P2': 150, 'P1|P3': 250, 'P2|P3': 120 },
      { C: ['P1', 'P2', 'P3'], P1: ['C'], P2: ['C'], P3: ['C'] },
      { C: 3, P1: 1, P2: 3, P3: 5 },
      ['P1'],
    );
    const next = () => 0;
    const cands = generateCandidates(
      { visited: ['P2', 'P1', 'C'], home: 'P1', carriedCount: 0, policeCountries: new Set() },
      world,
      DEFAULT_CHASE_CONSTANTS,
      next,
    );
    expect(cands).toHaveLength(3);
    expect(new Set(cands).size).toBe(3);
  });

  it('경찰 점유국은 pool<3 복원 상황에서도 절대 후보가 되지 않는다', () => {
    // nearest 4개 중 1개가 경찰, 2개가 직전 방문 → 경찰국은 끝까지 배제.
    const world = makeWorld(
      ['C', 'Pol', 'V1', 'V2', 'Free'],
      {
        'C|Pol': 100, 'C|V1': 200, 'C|V2': 300, 'C|Free': 400,
        'Pol|V1': 150, 'Pol|V2': 160, 'Pol|Free': 170, 'V1|V2': 180, 'V1|Free': 190, 'V2|Free': 210,
      },
      { C: ['Pol', 'V1', 'V2', 'Free'], Pol: ['C'], V1: ['C'], V2: ['C'], Free: ['C'] },
      { C: 3, Pol: 1, V1: 2, V2: 3, Free: 4 },
      ['V1'],
    );
    const next = () => 0;
    const cands = generateCandidates(
      { visited: ['V2', 'V1', 'C'], home: 'V1', carriedCount: 0, policeCountries: new Set(['Pol']) },
      world,
      DEFAULT_CHASE_CONSTANTS,
      next,
    );
    expect(cands).not.toContain('Pol');
    expect(cands).toHaveLength(3);
  });
});

describe('candidatesAreValid', () => {
  it('3개·중복 없음·경찰국 없음 판정', () => {
    expect(candidatesAreValid(['A', 'B', 'C'], new Set())).toBe(true);
    expect(candidatesAreValid(['A', 'B'], new Set())).toBe(false);
    expect(candidatesAreValid(['A', 'A', 'C'], new Set())).toBe(false);
    expect(candidatesAreValid(['A', 'B', 'C'], new Set(['B']))).toBe(false);
  });
});
