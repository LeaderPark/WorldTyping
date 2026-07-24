// spec: docs/00 §11-D90(GameMode 'chase' 반입), docs/09 §6.1(chase 배럴). 배럴 export 배선 + 몇몇
// 도달 가능한 분기(체포 후 advance no-op / verify no-candidates) 커버.
import { describe, expect, it } from 'vitest';
import type { GameMode } from '../types/game';
import * as chase from './index';
import {
  DEFAULT_CHASE_CONSTANTS,
  advanceChase,
  compileGraph,
  generateCandidates,
  mergeChaseConstants,
  simulateChase,
  verifyMoveLog,
  type ChaseWorld,
  type ChaseGraphNode,
  type ChaseConstants,
} from './index';
import type { CountryId, DifficultyTier } from '../types/country';

describe('chase 배럴 + GameMode 반입', () => {
  it("GameMode 유니온에 'chase'가 포함된다(§11-D90)", () => {
    const modes: GameMode[] = ['continent', 'tier', 'worldtour', 'daily', 'race', 'chase'];
    expect(modes).toContain('chase');
    const m: GameMode = 'chase';
    expect(m).toBe('chase');
  });

  it('핵심 심볼이 배럴에서 노출된다', () => {
    expect(typeof chase.simulateChase).toBe('function');
    expect(typeof chase.advanceChase).toBe('function');
    expect(typeof chase.verifyMoveLog).toBe('function');
    expect(typeof chase.generateCandidates).toBe('function');
    expect(typeof chase.compileGraph).toBe('function');
    expect(typeof chase.mergeChaseConstants).toBe('function');
    expect(typeof chase.parseChaseConstants).toBe('function');
    expect(chase.CHASE_CONSTANTS_VERSION).toBe(1);
    expect(chase.DEFAULT_CHASE_CONSTANTS.wantedMax).toBe(5);
  });
});

// 합성 미니 그래프(체포 유도용): 라인 A(홈)-B-C, 추격조 정지 없음.
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

describe('advance/verify 엣지 분기', () => {
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
    police: { chaserBaseTickMs: 1000, chaserTickPerStarMs: 0, chaserMinTickMs: 1000 },
  });

  it('체포 후 advance는 상태를 바꾸지 않고 timeMs만 전진(runTo early-return)', () => {
    const arrested = simulateChase({ seed: 5, moveLog: [{ hopIndex: 0, countryId: 'B', tMs: 1000 }], endMs: 2000, constants }, w);
    expect(arrested.arrestedAtMs).toBe(2000);
    const later = advanceChase(arrested, { seed: 5, moveLog: [{ hopIndex: 0, countryId: 'B', tMs: 1000 }], endMs: 10_000, constants }, w);
    expect(later.arrestedAtMs).toBe(2000); // 변함 없음
    expect(later.player).toBe(arrested.player);
    expect(later.timeMs).toBe(10_000); // endMs로 전진만
    expect(later.events).toEqual(arrested.events);
  });

  it('verifyMoveLog: 처리되지 않은(누락) hopIndex는 no-candidates가 아니라 not-processed로 먼저 걸린다', () => {
    // endMs 이후 시각의 홉 → not-processed.
    const res = verifyMoveLog(
      { seed: 5, moveLog: [{ hopIndex: 0, countryId: 'B', tMs: 5000 }], endMs: 1000, constants },
      w,
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('not-processed');
  });

  it('generateCandidates가 배럴 경유로도 동작(합성)', () => {
    const cands = generateCandidates(
      { visited: ['A'], home: 'A', carriedCount: 0, policeCountries: new Set<CountryId>() },
      w,
      DEFAULT_CHASE_CONSTANTS,
      () => 0,
    );
    expect(cands.length).toBeLessThanOrEqual(3);
    expect(compileGraph(w.graph).has('A')).toBe(true);
  });
});
