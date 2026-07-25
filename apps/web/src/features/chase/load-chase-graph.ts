// spec: docs/09-chase-mode-goldrunner.md §5.1(chase-graph 산출물 포맷)·§8.1(라우트 직행 — 데이터는
//       chase 진입 시에만 lazy fetch), docs/00 §11-D91-⑥(전쌍 정수 km 행렬), WT-CH-08.
//
// packages/data/src/generated/chase-graph.ts(CH-01 산출물)는 @wt/data devDependency로만 허용되고
// (packages/shared/src/chase/graph.ts 헤더 주석), 런타임 번들에는 절대 정적 import되지 않는다 — 대신
// apps/web/public/data/chase-graph.json을 fetch한다(topology-loader.ts의 "모듈 스코프 1회 캐시" 관례
// 그대로 승계). manifest.json의 chaseGraph.sha256로 캐시버스팅 쿼리를 붙인다(bootLoader.ts
// loadDataVersion/loadCountries와 동일 패턴 — 물음표 중복 방지 로직은 이 파일엔 불필요, dataUrl이
// 항상 고정 상대 경로라 쿼리를 미리 포함할 일이 없다).
//
// 산출 타입은 packages/shared/src/chase/graph.ts의 ChaseGraph(ids/nodes/matrix)와 구조적으로 호환된다
// — 이 로더는 fetch·zod 검증만 하고 그래프 유틸(compileGraph 등)은 재구현하지 않는다(Gotcha 3).
import { z } from 'zod';
import type { ChaseGraph } from '@wt/shared';

const ChaseGraphNearestEntrySchema = z.object({ id: z.string().min(2).max(8), km: z.number().int().nonnegative() });

const ChaseGraphNodeSchema = z.object({
  nearest: z.array(ChaseGraphNearestEntrySchema),
  homeEligible: z.boolean(),
});

const ChaseGraphDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string(),
  nodes: z.record(z.string(), ChaseGraphNodeSchema),
  ids: z.array(z.string().min(2).max(8)),
  matrix: z.string().min(1),
});

interface ManifestChaseGraphField {
  chaseGraph?: { sha256?: string };
}

let cached: ChaseGraph | null = null;
let inflight: Promise<ChaseGraph> | null = null;

async function fetchManifestHash(): Promise<string | null> {
  try {
    const res = await fetch('/data/manifest.json');
    if (!res.ok) return null;
    const manifest = (await res.json()) as ManifestChaseGraphField;
    return manifest.chaseGraph?.sha256?.slice(0, 8) ?? null;
  } catch {
    return null; // 매니페스트 실패는 치명적이지 않다 — 아래에서 버전 쿼리 없이 그대로 fetch한다.
  }
}

/** `/data/chase-graph.json`을 1회만 fetch·zod 검증·캐싱한다(chase 라우트 진입 시에만 호출 —
 *  entry/기존 5모드 청크에서 정적 import되지 않는다, D91-⑥ 데이터 로딩 규약). */
export async function loadChaseGraph(): Promise<ChaseGraph> {
  if (cached) return cached;
  if (!inflight) {
    inflight = (async () => {
      const hash = await fetchManifestHash();
      const url = hash ? `/data/chase-graph.json?v=${hash}` : '/data/chase-graph.json';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`chase-graph.json fetch failed: ${res.status} ${url}`);
      const parsed = ChaseGraphDatasetSchema.parse(await res.json());
      const graph: ChaseGraph = Object.freeze({ ids: parsed.ids, nodes: parsed.nodes, matrix: parsed.matrix });
      cached = graph;
      return graph;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 테스트 전용: 모듈 캐시 리셋(topology-loader.ts __reset* 관례와 동일). */
export function __resetChaseGraphCacheForTests(): void {
  cached = null;
  inflight = null;
}
