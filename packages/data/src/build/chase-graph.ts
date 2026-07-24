// spec: docs/09 §5.1(chase-graph 산출물 스키마·검증 룰)·§4.2-4(정수 km 결정성), docs/00 §11-D90·D91-⑥,
//       WT-CH-01
//
// "골드 러너"(chase) 모드의 유일한 지리 데이터 산출물을 만드는 순수 코어. I/O는
// tooling/scripts/build-data.ts 러너가 담당한다(pipeline.ts·route.ts와 동일 관례) — 이 모듈은 파일을
// 읽거나 쓰지 않는다. anchor 좌표(위경도)는 country.latlng — GlobeIndex(apps/web/src/features/map/
// globe/globe-index.ts)가 소비하는 것과 완전히 동일한 원천(countries.json)이며, 별도 좌표 소스를
// 신설하지 않는다. haversine은 route.ts의 기존 haversineKm을 그대로 재사용한다(재구현 금지).
//
// ── chase-graph 데이터 포맷 동결 (docs/00 §11-D91-⑥) ────────────────────────────────────
//
// nodes: Record<CountryId, ChaseGraphNode> — un195 195개 전체, key = ISO 알파-2(대문자).
//   nearest: 대권거리 오름차순 정확히 12개 {id, km}(정수 km, haversine 반올림). 자기 자신 제외.
//            반올림 후 거리 동률 시 ISO 코드 사전순(§4.2-2/D91-⑤ 동률 해소 규칙).
//   homeEligible: difficultyTier <= 2 (§3.1 홈 후보 조건).
//
// ids: un195 195개 ISO 코드를 오름차순 정렬한 배열 — matrix 디코드 시 인덱스 순서의 단일 원천.
//
// matrix: un195 전쌍 정수 km 거리(§11-D91-⑥ 파생 확정)를 담은 "상삼각(대각선 제외) 패킹"의
//   base64(u16 LE) 인코딩 문자열.
//     n = ids.length
//     엔트리 수 = n*(n-1)/2, 각 엔트리 2바이트(unsigned 16-bit little-endian, 최대 대척점
//       ~20,015km < 65,535 이므로 오버플로 없음)
//     저장 순서 — i를 0..n-1 오름차순으로 순회하며, 각 i에 대해 j를 i+1..n-1 오름차순으로 순회,
//       dist(ids[i], ids[j])를 이 순서 그대로 push한다.
//     임의 쌍 (a, b)의 0-based 엔트리 오프셋(ia=ids.indexOf(a), ib=ids.indexOf(b),
//       i=min(ia,ib), j=max(ia,ib)):
//         offset = i*n - i*(i+1)/2 + (j - i - 1)
//       바이트 오프셋 = offset*2. u16 리틀엔디안 2바이트를 읽으면 km(정수)이다.
//     a === b(자기 자신)는 행렬에 저장되지 않는다 — 값은 항상 0으로 간주한다.
//   런타임 디코더는 WT-CH-02(packages/shared/src/chase/graph.ts) 소관 — 이 포맷을 그대로 따라야
//   한다. 본 파일의 decodeMatrixKm()은 빌드 검증·테스트 전용 참조 구현이며 Buffer(Node 전용) API를
//   쓰므로 런타임(브라우저/Workers) 코드에서 그대로 재사용할 수 없다(재사용 시도 금지 — 별도 구현).
// ─────────────────────────────────────────────────────────────────────────────────────

import type { Country, CountryId } from '@wt/shared';
import { haversineKm } from './route';

export interface ChaseGraphNearestEntry {
  id: CountryId;
  km: number;
}

export interface ChaseGraphNode {
  nearest: ChaseGraphNearestEntry[];
  homeEligible: boolean;
}

export interface ChaseGraphDataset {
  schemaVersion: 1;
  builtAt: string;
  /** un195 전체, key = ISO 코드. 값은 nearest-12 + homeEligible(§5.1). */
  nodes: Record<CountryId, ChaseGraphNode>;
  /** un195 ISO 코드 오름차순 — matrix 디코드 인덱스 원천(위 포맷 주석 참조). */
  ids: CountryId[];
  /** 전쌍 정수 km 상삼각 base64(u16 LE) — 포맷은 위 주석 참조. */
  matrix: string;
}

/** §5.1 검증 룰①: nearest 개수 고정값. */
export const CHASE_GRAPH_NEAREST_COUNT = 12;
/** §5.1 검증 룰③: homeEligible 최소 국가 수. */
export const CHASE_GRAPH_HOME_ELIGIBLE_MIN = 30;
/** §3.1: 홈 후보 = tier <= 2. */
const HOME_ELIGIBLE_MAX_TIER = 2;

function roundedKm(a: [number, number], b: [number, number]): number {
  return Math.round(haversineKm(a, b));
}

/** id 사전순 비교자(§4.2-2/D91-⑤ 동률 해소 — 전 모듈 공통 규약). */
function compareId(a: CountryId, b: CountryId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** un195만 남기고 ISO 오름차순 정렬(§10 결정성 관례 승계 — 출력 키 순서 고정). */
function selectUn195Sorted(countries: Country[], un195: ReadonlySet<CountryId>): Country[] {
  return countries
    .filter((c) => un195.has(c.id))
    .slice()
    .sort((a, b) => compareId(a.id, b.id));
}

function encodeMatrixBase64(ids: CountryId[], latlngById: ReadonlyMap<CountryId, [number, number]>): string {
  const n = ids.length;
  const count = (n * (n - 1)) / 2;
  const buf = new ArrayBuffer(count * 2);
  const view = new DataView(buf);
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const a = latlngById.get(ids[i]!)!;
    for (let j = i + 1; j < n; j++) {
      const b = latlngById.get(ids[j]!)!;
      // haversine 최댓값은 대척점 πR≈20,015km로 u16 상한(65,535)에 구조적으로 못 미친다
      // (임의 실수 위경도에서도 삼각함수 유계성 때문에 성립) — 이 상한 초과는 도달 불가능한
      // 분기이므로 방어 코드를 두지 않는다(테스트로 도달시킬 수 없는 throw는 커버리지 사각지대).
      const km = roundedKm(a, b);
      view.setUint16(offset * 2, km, true);
      offset++;
    }
  }
  return Buffer.from(buf).toString('base64');
}

/**
 * 검증·테스트 전용 참조 디코더 — 위 포맷 주석의 참조 구현. 런타임 디코더는 CH-02
 * (packages/shared/src/chase/graph.ts) 소관이며 이 함수를 그대로 재사용하지 않는다(Buffer는
 * Node 전용, shared는 런타임 의존 0 규칙).
 */
export function decodeMatrixKm(graph: Pick<ChaseGraphDataset, 'ids' | 'matrix'>, a: CountryId, b: CountryId): number {
  if (a === b) return 0;
  const n = graph.ids.length;
  const ia = graph.ids.indexOf(a);
  const ib = graph.ids.indexOf(b);
  if (ia < 0) throw new Error(`decodeMatrixKm: unknown id "${a}"`);
  if (ib < 0) throw new Error(`decodeMatrixKm: unknown id "${b}"`);
  const i = Math.min(ia, ib);
  const j = Math.max(ia, ib);
  const offset = i * n - (i * (i + 1)) / 2 + (j - i - 1);
  const bytes = Buffer.from(graph.matrix, 'base64');
  return bytes.readUInt16LE(offset * 2);
}

/**
 * Step: un195 전 국가의 nearest-12 + homeEligible + 전쌍 정수 km 행렬(§5.1, D91-⑥). 순수 함수 —
 * 동일 입력이면 바이트 동일 출력(결정성, §4.2-4).
 */
export function buildChaseGraph(
  countries: Country[],
  un195: ReadonlySet<CountryId>,
  builtAt: string,
): ChaseGraphDataset {
  const sorted = selectUn195Sorted(countries, un195);
  const ids = sorted.map((c) => c.id);
  const latlngById = new Map<CountryId, [number, number]>(sorted.map((c) => [c.id, c.latlng]));
  const tierById = new Map<CountryId, number>(sorted.map((c) => [c.id, c.difficultyTier]));

  const nodes: Record<CountryId, ChaseGraphNode> = {};
  for (const id of ids) {
    const origin = latlngById.get(id)!;
    const distances = ids
      .filter((otherId) => otherId !== id)
      .map((otherId) => ({ id: otherId, km: roundedKm(origin, latlngById.get(otherId)!) }));
    // 오름차순, 반올림 후 동률은 ISO 사전순(§4.2-2/D91-⑤).
    distances.sort((x, y) => (x.km !== y.km ? x.km - y.km : compareId(x.id, y.id)));
    const nearest = distances.slice(0, CHASE_GRAPH_NEAREST_COUNT);
    const tier = tierById.get(id)!;
    nodes[id] = { nearest, homeEligible: tier <= HOME_ELIGIBLE_MAX_TIER };
  }

  const matrix = encodeMatrixBase64(ids, latlngById);
  return { schemaVersion: 1, builtAt, nodes, ids, matrix };
}

export interface ChaseGraphValidationResult {
  homeEligibleCount: number;
}

/**
 * 빌드 게이트(§5.1 검증 룰 4종, 우회 금지) — 실패 시 throw:
 *   ① 전 노드 nearest 정확히 12·전부 un195·자기 미포함·중복 없음·km 오름차순
 *   ② 그래프 연결성(nearest-12 무향 그래프 BFS로 임의 노드에서 전 노드 도달)
 *   ③ homeEligible >= CHASE_GRAPH_HOME_ELIGIBLE_MIN
 *   ④ 행렬 대칭·양수·nearest의 km와 행렬 값 일치
 */
export function validateChaseGraph(
  graph: ChaseGraphDataset,
  un195: ReadonlySet<CountryId>,
): ChaseGraphValidationResult {
  const idSet = new Set(graph.ids);

  if (idSet.size !== graph.ids.length) {
    throw new Error('chase-graph: ids에 중복 존재 (§5.1 검증①)');
  }
  if (idSet.size !== un195.size || [...un195].some((id) => !idSet.has(id))) {
    throw new Error('chase-graph: ids !== un195 집합 (§5.1 검증①)');
  }

  // ① nearest 정확히 12·전부 un195·자기 미포함·중복 없음·오름차순
  for (const id of graph.ids) {
    const node = graph.nodes[id];
    if (!node) throw new Error(`chase-graph: node 누락 "${id}" (§5.1 검증①)`);
    if (node.nearest.length !== CHASE_GRAPH_NEAREST_COUNT) {
      throw new Error(
        `chase-graph: "${id}" nearest.length=${node.nearest.length}, 기대값 ${CHASE_GRAPH_NEAREST_COUNT} (§5.1 검증①)`,
      );
    }
    const seenNeighbors = new Set<CountryId>();
    for (const n of node.nearest) {
      if (n.id === id) throw new Error(`chase-graph: "${id}" nearest에 자기 자신 포함 (§5.1 검증①)`);
      if (!idSet.has(n.id)) throw new Error(`chase-graph: "${id}" nearest에 un195 밖 국가 "${n.id}" (§5.1 검증①)`);
      if (seenNeighbors.has(n.id)) throw new Error(`chase-graph: "${id}" nearest에 중복 "${n.id}" (§5.1 검증①)`);
      seenNeighbors.add(n.id);
    }
    for (let i = 1; i < node.nearest.length; i++) {
      if (node.nearest[i]!.km < node.nearest[i - 1]!.km) {
        throw new Error(`chase-graph: "${id}" nearest가 km 오름차순이 아님 (§5.1 검증①)`);
      }
    }
  }

  // ② 그래프 연결성(nearest-12 무향 그래프 BFS)
  const adjacency = new Map<CountryId, Set<CountryId>>();
  for (const id of graph.ids) adjacency.set(id, new Set());
  for (const id of graph.ids) {
    for (const n of graph.nodes[id]!.nearest) {
      adjacency.get(id)!.add(n.id);
      adjacency.get(n.id)!.add(id);
    }
  }
  const startId = graph.ids[0];
  if (!startId) throw new Error('chase-graph: ids가 비어있음 (§5.1 검증②)');
  const visited = new Set<CountryId>([startId]);
  const queue: CountryId[] = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adjacency.get(cur)!) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  if (visited.size !== graph.ids.length) {
    const unreached = graph.ids.filter((id) => !visited.has(id));
    throw new Error(
      `chase-graph: 그래프 비연결 — 도달 불가 ${unreached.length}개국: ${JSON.stringify(unreached.slice(0, 10))} (§5.1 검증②)`,
    );
  }

  // ③ homeEligible >= 최소치
  const homeEligibleCount = graph.ids.filter((id) => graph.nodes[id]!.homeEligible).length;
  if (homeEligibleCount < CHASE_GRAPH_HOME_ELIGIBLE_MIN) {
    throw new Error(
      `chase-graph: homeEligible ${homeEligibleCount}개 < 최소 ${CHASE_GRAPH_HOME_ELIGIBLE_MIN} (§5.1 검증③)`,
    );
  }

  // ④-a 행렬 바이트 길이 정합 + 전체 양수(대각선 제외 상삼각 전 엔트리 직접 순회) — 길이부터
  // 먼저 확인해야 이어지는 ④-b의 개별 조회가 잘린 버퍼에서 저수준 RangeError 대신 이 메시지로
  // 먼저 걸린다.
  const n = graph.ids.length;
  const expectedByteLength = ((n * (n - 1)) / 2) * 2;
  const bytes = Buffer.from(graph.matrix, 'base64');
  if (bytes.length !== expectedByteLength) {
    throw new Error(
      `chase-graph: matrix 바이트 길이 ${bytes.length} != 기대값 ${expectedByteLength} (§5.1 검증④)`,
    );
  }
  let offset = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const km = bytes.readUInt16LE(offset * 2);
      if (km <= 0) {
        throw new Error(`chase-graph: matrix[${graph.ids[i]}-${graph.ids[j]}] <= 0 (§5.1 검증④)`);
      }
      offset++;
    }
  }

  // ④-b nearest의 km와 행렬 디코드 값 일치. 대칭성은 decodeMatrixKm이 항상 min/max 인덱스로
  // 단일 저장값을 조회하는 구현이라 양방향 호출이 구조적으로 항상 같은 바이트를 읽는다 —
  // 별도 "비대칭" 분기는 도달 불가능해 두지 않는다(불가능한 분기를 만들지 않는다, route.ts §5.2
  // 관례 승계).
  for (const id of graph.ids) {
    for (const n2 of graph.nodes[id]!.nearest) {
      const viaMatrix = decodeMatrixKm(graph, id, n2.id);
      if (viaMatrix !== n2.km) {
        throw new Error(
          `chase-graph: "${id}"-"${n2.id}" nearest km(${n2.km}) != matrix km(${viaMatrix}) (§5.1 검증④)`,
        );
      }
    }
  }

  return { homeEligibleCount };
}

/** AUTO-GENERATED 산출물(packages/data/src/generated/chase-graph.ts) 상단 주석 — 위 포맷 스펙 요약. */
export const CHASE_GRAPH_FORMAT_NOTE = `chase-graph 데이터 포맷 동결 (docs/09 §5.1, docs/00 §11-D91-⑥)

nodes: Record<CountryId, ChaseGraphNode> — un195 195개 전체, key = ISO 알파-2(대문자).
  nearest: 대권거리 오름차순 정확히 12개 {id, km}(정수, 반올림). 자기 자신 제외.
           반올림 후 거리 동률 시 ISO 코드 사전순.
  homeEligible: difficultyTier <= 2.

ids: un195 195개 ISO 코드, 오름차순 정렬 — matrix 디코드 시 인덱스 순서의 단일 원천.

matrix: un195 전쌍 정수 km 거리를 담은 상삼각(대각선 제외) 패킹의 base64(u16 LE) 인코딩.
  n = ids.length. 엔트리 수 = n*(n-1)/2. 저장 순서 — i를 0..n-1 오름차순으로 순회하며
  각 i에 대해 j를 i+1..n-1 오름차순으로 순회, dist(ids[i], ids[j])를 이 순서로 push.
  임의 쌍 (a, b)의 오프셋(0-based 요소 인덱스, ia=ids.indexOf(a), ib=ids.indexOf(b),
  i=min(ia,ib), j=max(ia,ib)):
    offset = i*n - i*(i+1)/2 + (j - i - 1)
  바이트 오프셋 = offset*2. u16 값을 리틀엔디안으로 read(2바이트) → km(정수).
  a === b(자기 자신)는 행렬에 없음 — 0으로 간주.
  디코더 구현은 WT-CH-02(packages/shared/src/chase/graph.ts) 소관 — 이 포맷을 그대로 따를 것.`;

/** AUTO-GENERATED chase-graph.ts 파일 내용을 생성한다(countries.ts와 동일 관례, §10 Step 8 승계). */
export function renderChaseGraphTs(graph: ChaseGraphDataset): string {
  const noteLines = CHASE_GRAPH_FORMAT_NOTE.split('\n')
    .map((line) => `// ${line}`.trimEnd())
    .join('\n');
  const header =
    '// AUTO-GENERATED by tooling/scripts/build-data.ts (WT-CH-01). DO NOT EDIT BY HAND.\n' +
    '// spec: docs/09 §5.1(chase-graph 산출물)·§4.2-4(결정성), docs/00 §11-D90·D91(전쌍 행렬 파생 확정).\n' +
    '//\n' +
    `${noteLines}\n\n` +
    "import type { ChaseGraphDataset } from '../build/chase-graph';\n\n";
  const body = JSON.stringify(graph, null, 2);
  return `${header}export const CHASE_GRAPH: ChaseGraphDataset = ${body};\n`;
}
