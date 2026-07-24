// spec: docs/09 §5.1(chase-graph 포맷·행렬 디코드)·§3.4(경찰 탐욕 이동·차단조 경로·헬기 링)·§4.2(결정성),
//       docs/00 §11-D91(⑤ 동률=ISO 사전순 / ⑥ 사전계산 정수 km만 분기)
//
// chase-graph 런타임 타입 + 유틸. **런타임 삼각함수 금지**(D91-⑥) — 모든 거리는 CH-01이 빌드 시
// 사전 계산한 정수 km(전쌍 상삼각 u16 LE base64 행렬)를 디코드해서만 사용한다. 포맷은 CH-01 산출물
// (packages/data/src/generated/chase-graph.ts) 상단 주석과 동일해야 하며, 여기 디코더는 그 포맷의
// 런타임 구현이다(Node Buffer 미사용 — atob 기반, 브라우저/Workers 공통).
//
// 모든 동률 해소는 ISO 코드 사전순(D91-⑤) — 탐욕 이동·BFS 경로·홉거리 링 폴백 어디에도 그 외
// 휴리스틱을 추가하지 않는다. 의존성 0(zod조차 불요), Date.now/Math.random 없음.

import type { CountryId, DifficultyTier } from '../types/country';

/** chase-graph 노드 — nearest 12(대권거리 오름차순) + 홈 후보 여부(tier≤2). */
export interface ChaseGraphNode {
  nearest: readonly { readonly id: CountryId; readonly km: number }[];
  homeEligible: boolean;
}

/**
 * 심이 소비하는 chase-graph 형태. CH-01 산출물 `ChaseGraphDataset`의 런타임 필요 부분집합 —
 * `CHASE_GRAPH`(from @wt/data)를 그대로 대입할 수 있다(구조적 호환).
 */
export interface ChaseGraph {
  /** un195 ISO 코드 오름차순 — matrix 디코드 인덱스의 단일 원천. */
  readonly ids: readonly CountryId[];
  readonly nodes: Readonly<Record<CountryId, ChaseGraphNode>>;
  /** 전쌍 정수 km 상삼각 base64(u16 LE). */
  readonly matrix: string;
}

/** 심에 주입되는 정적 참조 데이터(그래프 + 티어). shared는 런타임 의존 0 — 항상 파라미터 주입. */
export interface ChaseWorld {
  readonly graph: ChaseGraph;
  /** id → 난이도 티어(선택지 버킷·금 고티어 가중용). 국가 테이블에서 구성해 주입. */
  readonly tiers: Readonly<Record<CountryId, DifficultyTier>>;
}

/** ISO 사전순 비교자(D91-⑤ 전 모듈 공통 동률 규칙). */
export function compareId(a: CountryId, b: CountryId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 컴파일된 그래프 — 행렬을 1회 디코드하고 인덱스·인접(BFS용 무향)을 사전 구축한 조회 구조.
 * 순수·불변. 동일 graph 객체에 대해 WeakMap 캐시된다(증분 실행에서 재디코드 방지).
 */
export interface CompiledChaseGraph {
  readonly ids: readonly CountryId[];
  /** id → matrix 인덱스. */
  index(id: CountryId): number;
  has(id: CountryId): boolean;
  /** 사전 계산 정수 km(a===b → 0). 없는 id는 throw(계약 위반 조기 검출). */
  dist(a: CountryId, b: CountryId): number;
  /** 노드의 nearest 12 id(대권거리 오름차순, 자기 제외). */
  outNeighbors(id: CountryId): readonly CountryId[];
  /** 무향 인접(a∈nearest(b) 또는 b∈nearest(a)) ISO 오름차순 — BFS 결정성용. */
  undirectedNeighbors(id: CountryId): readonly CountryId[];
  homeEligible(id: CountryId): boolean;
  /** 홈 후보(tier≤2) id — ISO 오름차순. */
  homeEligibleIds(): readonly CountryId[];
}

const compiledCache = new WeakMap<ChaseGraph, CompiledChaseGraph>();

/** graph를 컴파일(또는 캐시 반환). 순수 — 동일 입력이면 동일 조회 결과. */
export function compileGraph(graph: ChaseGraph): CompiledChaseGraph {
  const cached = compiledCache.get(graph);
  if (cached) return cached;

  const ids = graph.ids;
  const n = ids.length;
  const idIndex = new Map<CountryId, number>();
  for (let i = 0; i < n; i++) idIndex.set(ids[i]!, i);

  const bytes = decodeBase64ToBytes(graph.matrix);

  const undirected = new Map<CountryId, Set<CountryId>>();
  for (const id of ids) undirected.set(id, new Set());
  for (const id of ids) {
    const node = graph.nodes[id];
    if (!node) continue;
    for (const nb of node.nearest) {
      undirected.get(id)!.add(nb.id);
      const back = undirected.get(nb.id);
      if (back) back.add(id);
    }
  }
  const undirectedSorted = new Map<CountryId, CountryId[]>();
  for (const [id, set] of undirected) {
    undirectedSorted.set(id, [...set].sort(compareId));
  }

  const homeEligibleList = ids.filter((id) => graph.nodes[id]?.homeEligible === true);

  function index(id: CountryId): number {
    const i = idIndex.get(id);
    if (i === undefined) throw new Error(`chase-graph: unknown id "${id}"`);
    return i;
  }
  function dist(a: CountryId, b: CountryId): number {
    if (a === b) return 0;
    const ia = index(a);
    const ib = index(b);
    const i = ia < ib ? ia : ib;
    const j = ia < ib ? ib : ia;
    const offset = i * n - (i * (i + 1)) / 2 + (j - i - 1);
    const byteOffset = offset * 2;
    return bytes[byteOffset]! | (bytes[byteOffset + 1]! << 8);
  }

  const compiled: CompiledChaseGraph = {
    ids,
    index,
    has: (id) => idIndex.has(id),
    dist,
    outNeighbors: (id) => graph.nodes[id]?.nearest.map((e) => e.id) ?? [],
    undirectedNeighbors: (id) => undirectedSorted.get(id) ?? [],
    homeEligible: (id) => graph.nodes[id]?.homeEligible === true,
    homeEligibleIds: () => homeEligibleList,
  };
  compiledCache.set(graph, compiled);
  return compiled;
}

/**
 * 탐욕 1스텝(§3.4): from의 nearest 12 중 target과의 사전계산 거리 최소국. 동률은 ISO 사전순(D91-⑤).
 * from의 이웃에 target이 있으면 target을 반환(→ 체포로 이어질 수 있음). 이웃이 없으면 from 유지.
 */
export function nextGreedyStep(
  g: CompiledChaseGraph,
  from: CountryId,
  target: CountryId,
): CountryId {
  // 이미 목표국에 있으면 머문다 — 플레이어가 경찰국으로 홉해 들어온 순간 경찰이 벗어나 체포를
  // 놓치는 일을 막는다(§3.4 체포 조건② 보장). 목표에 도달한 유닛은 다음 ⑥에서 체포를 성립시킨다.
  if (from === target) return from;
  const neighbors = g.outNeighbors(from);
  if (neighbors.length === 0) return from;
  let best: CountryId | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const nb of neighbors) {
    const d = g.dist(nb, target);
    if (d < bestDist || (d === bestDist && best !== null && compareId(nb, best) < 0)) {
      bestDist = d;
      best = nb;
    }
  }
  return best!;
}

/**
 * 무향 BFS 최단 홉 경로(§3.4 차단조 "그래프 홉 기준"). 이웃을 ISO 오름차순 순회하므로 부모 배정이
 * 결정적이다(먼저 도달한 경로가 이김). 도달 불가 시 null(CH-01 연결성 검증으로 실 그래프에선 불가).
 * 반환은 [start, …, goal](start===goal이면 [start]).
 */
export function bfsPath(
  g: CompiledChaseGraph,
  start: CountryId,
  goal: CountryId,
): CountryId[] | null {
  if (start === goal) return [start];
  const parent = new Map<CountryId, CountryId>();
  const visited = new Set<CountryId>([start]);
  const queue: CountryId[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of g.undirectedNeighbors(cur)) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      parent.set(nb, cur);
      if (nb === goal) {
        const path: CountryId[] = [goal];
        let node: CountryId = goal;
        while (node !== start) {
          node = parent.get(node)!;
          path.push(node);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

/** 무향 BFS 홉 거리 맵(start=0). 헬기 링(§3.4)·거리 분류에 사용. */
export function hopDistanceMap(g: CompiledChaseGraph, start: CountryId): Map<CountryId, number> {
  const dist = new Map<CountryId, number>([[start, 0]]);
  const queue: CountryId[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const nb of g.undirectedNeighbors(cur)) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      queue.push(nb);
    }
  }
  return dist;
}
