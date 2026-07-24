// spec: docs/09 §5.1(포맷·행렬 디코드)·§3.4(탐욕·BFS·홉거리), docs/00 §11-D91(⑤ ISO 동률/⑥ 정수 km)
import { describe, expect, it } from 'vitest';
import { CHASE_GRAPH } from '@wt/data';
import type { CountryId } from '../types/country';
import {
  bfsPath,
  compareId,
  compileGraph,
  hopDistanceMap,
  nextGreedyStep,
  type ChaseGraph,
  type ChaseGraphNode,
} from './graph';

// ── 합성 그래프 빌더(테스트 전용) ──────────────────────────────────────────────────────────
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function makeGraph(
  ids: string[],
  distMap: Record<string, number>,
  nearestLists: Record<string, string[]>,
  homeEligible: string[],
): ChaseGraph {
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
  return { ids, nodes, matrix: btoa(bin) };
}

describe('compileGraph.dist — 실 chase-graph(@wt/data) 정합', () => {
  const g = compileGraph(CHASE_GRAPH as unknown as ChaseGraph);

  it('a===b → 0', () => {
    expect(g.dist('KR', 'KR')).toBe(0);
  });

  it('nearest의 km와 행렬 디코드 값이 전 노드에서 일치(CH-01 검증④의 런타임 대조)', () => {
    for (const id of CHASE_GRAPH.ids) {
      const node = CHASE_GRAPH.nodes[id]!;
      for (const nb of node.nearest) {
        expect(g.dist(id, nb.id)).toBe(nb.km);
      }
    }
  });

  it('대칭성 dist(a,b) === dist(b,a) (표본)', () => {
    const sample = ['KR', 'JP', 'US', 'BR', 'FR', 'ZA', 'AU', 'IS'];
    for (const a of sample)
      for (const b of sample) expect(g.dist(a, b)).toBe(g.dist(b, a));
  });

  it('unknown id는 throw(계약 위반 조기 검출)', () => {
    expect(() => g.dist('KR', 'ZZ')).toThrow();
    expect(() => g.index('ZZ')).toThrow();
    expect(g.has('KR')).toBe(true);
    expect(g.has('ZZ')).toBe(false);
  });

  it('homeEligibleIds는 tier≤2(홈 후보)만·ISO 오름차순', () => {
    const ids = g.homeEligibleIds();
    expect(ids.length).toBeGreaterThanOrEqual(30);
    for (const id of ids) expect(CHASE_GRAPH.nodes[id]!.homeEligible).toBe(true);
    expect([...ids]).toEqual([...ids].sort(compareId));
  });
});

describe('nextGreedyStep — 탐욕 1스텝, ISO 동률(D91-⑤)', () => {
  // 라인 그래프 A-B-C-D. 각 노드 nearest = 직접 이웃만.
  const g = compileGraph(
    makeGraph(
      ['A', 'B', 'C', 'D'],
      { 'A|B': 100, 'A|C': 200, 'A|D': 300, 'B|C': 100, 'B|D': 200, 'C|D': 100 },
      { A: ['B'], B: ['A', 'C'], C: ['B', 'D'], D: ['C'] },
      ['A'],
    ),
  );

  it('from===target이면 이동하지 않고 머문다(체포 유지)', () => {
    expect(nextGreedyStep(g, 'C', 'C')).toBe('C');
  });

  it('목표 방향으로 한 칸(A→D 목표: A→B)', () => {
    expect(nextGreedyStep(g, 'A', 'D')).toBe('B');
    expect(nextGreedyStep(g, 'B', 'D')).toBe('C');
  });

  it('두 이웃이 목표와 동거리면 ISO 사전순 앞을 택한다', () => {
    // 다이아몬드: A의 이웃 B·C가 둘 다 목표 D와 100으로 동거리 → 'B'(ISO<'C') 선택.
    const g2 = compileGraph(
      makeGraph(
        ['A', 'B', 'C', 'D'],
        { 'A|B': 100, 'A|C': 100, 'A|D': 200, 'B|C': 140, 'B|D': 100, 'C|D': 100 },
        { A: ['B', 'C'], B: ['A', 'D'], C: ['A', 'D'], D: ['B', 'C'] },
        ['A'],
      ),
    );
    expect(g2.dist('B', 'D')).toBe(g2.dist('C', 'D')); // 동거리 확인
    expect(nextGreedyStep(g2, 'A', 'D')).toBe('B');
  });
});

describe('bfsPath / hopDistanceMap — 무향 최단(결정적)', () => {
  const g = compileGraph(
    makeGraph(
      ['A', 'B', 'C', 'D'],
      { 'A|B': 100, 'A|C': 200, 'A|D': 300, 'B|C': 100, 'B|D': 200, 'C|D': 100 },
      { A: ['B'], B: ['A', 'C'], C: ['B', 'D'], D: ['C'] },
      ['A'],
    ),
  );

  it('start===goal → [start]', () => {
    expect(bfsPath(g, 'A', 'A')).toEqual(['A']);
  });

  it('A→D 최단 경로 = [A,B,C,D]', () => {
    expect(bfsPath(g, 'A', 'D')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('홉 거리맵', () => {
    const hop = hopDistanceMap(g, 'A');
    expect(hop.get('A')).toBe(0);
    expect(hop.get('B')).toBe(1);
    expect(hop.get('C')).toBe(2);
    expect(hop.get('D')).toBe(3);
  });

  it('실 그래프에서 임의 국가쌍 경로 존재(연결성)', () => {
    const rg = compileGraph(CHASE_GRAPH as unknown as ChaseGraph);
    const path = bfsPath(rg, 'KR', 'BR');
    expect(path).not.toBeNull();
    expect(path![0]).toBe('KR');
    expect(path![path!.length - 1]).toBe('BR');
  });

  it('연결 안 된 노드는 null(고립 합성)', () => {
    const iso = compileGraph(
      makeGraph(
        ['A', 'B', 'Z'],
        { 'A|B': 100, 'A|Z': 9999, 'B|Z': 9999 },
        { A: ['B'], B: ['A'], Z: [] }, // Z는 이웃 없음 → 고립
        ['A'],
      ),
    );
    expect(bfsPath(iso, 'A', 'Z')).toBeNull();
  });
});

describe('compileGraph WeakMap 캐시', () => {
  it('동일 graph 객체는 동일 컴파일 결과(참조 동일)', () => {
    const graph = CHASE_GRAPH as unknown as ChaseGraph;
    expect(compileGraph(graph)).toBe(compileGraph(graph));
  });
});

// compareId 직접 검증(동률 규칙 단위).
describe('compareId', () => {
  it('ISO 사전순', () => {
    expect(compareId('AD', 'AE')).toBeLessThan(0);
    expect(compareId('ZW', 'AD')).toBeGreaterThan(0);
    expect(compareId('KR', 'KR')).toBe(0);
    const arr: CountryId[] = ['ZW', 'AD', 'KR', 'BR'];
    expect([...arr].sort(compareId)).toEqual(['AD', 'BR', 'KR', 'ZW']);
  });
});
