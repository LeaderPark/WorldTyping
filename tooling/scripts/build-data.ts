// spec: docs/02 §10 (빌드 파이프라인), WT-M1-05
//
// pnpm build:data 엔트리. 결정적 코어(@wt/data 의 buildDataset)를 실행하고 산출물을 디스크에 쓴다.
// 네트워크 0. 실패는 throw 로 전파(조용히 넘기지 않음). world-countries/world-atlas 는
// packages/data 의 의존이므로, 코어를 상대 경로로 import 해 그 위치에서 해석되게 한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { BUILT_AT, buildDataset, sha256 } from '../../packages/data/src/build/pipeline.ts';
import {
  routeDistanceReport,
  un195ContinentIndex,
  validateContinentRoute,
  validateWorldTour,
} from '../../packages/data/src/build/route.ts';
import {
  buildChaseGraph,
  renderChaseGraphTs,
  validateChaseGraph,
} from '../../packages/data/src/build/chase-graph.ts';
import { buildOgMaps } from './lib/og-maps-extract.ts';
import type { Continent, Country } from '@wt/shared';

const REPO_ROOT = new URL('../../', import.meta.url);
const p = (rel: string) => fileURLToPath(new URL(rel, REPO_ROOT));

function writeOut(rel: string, contents: string): void {
  const abs = p(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  console.log(`  wrote ${rel}`);
}

/** Step 7-(d): routes.ts 존재 시 대륙 노선 6개 + 세계일주를 검증하고 리뷰 로그를 찍는다. */
async function validateRoutesStep(dataset: { countries: Country[] }): Promise<void> {
  const routesPath = p('packages/data/content/routes.ts');
  if (!existsSync(routesPath)) {
    console.warn('[build-data] content/routes.ts 부재 — Step 7-d routes 검증 skip (WT-M1-06 전).');
    return;
  }

  const contentSets = JSON.parse(readFileSync(p('packages/data/overrides/content-sets.json'), 'utf8')) as {
    un195: string[];
    extended: string[];
  };
  const un195 = new Set(contentSets.un195);
  const extended = new Set(contentSets.extended);
  const continentOf = un195ContinentIndex(dataset.countries, un195);
  const latlngById = new Map(dataset.countries.map((c) => [c.id, c.latlng]));

  const byContinent: Record<Continent, Set<string>> = {
    asia: new Set(), europe: new Set(), africa: new Set(),
    'north-america': new Set(), 'south-america': new Set(), oceania: new Set(),
  };
  for (const [id, continent] of continentOf) byContinent[continent].add(id);

  const routesModule = (await import(pathToFileURL(routesPath).href)) as {
    ROUTE_ASIA: string[];
    ROUTE_EUROPE: string[];
    ROUTE_AFRICA: string[];
    ROUTE_NORTH_AMERICA: string[];
    ROUTE_SOUTH_AMERICA: string[];
    ROUTE_OCEANIA: string[];
    ROUTE_WORLD_TOUR: string[];
  };

  const continentRoutes: [Continent, string[]][] = [
    ['asia', routesModule.ROUTE_ASIA],
    ['europe', routesModule.ROUTE_EUROPE],
    ['africa', routesModule.ROUTE_AFRICA],
    ['north-america', routesModule.ROUTE_NORTH_AMERICA],
    ['south-america', routesModule.ROUTE_SOUTH_AMERICA],
    ['oceania', routesModule.ROUTE_OCEANIA],
  ];

  console.log('\n[build-data] Step 7-d routes 검증');
  for (const [continent, route] of continentRoutes) {
    validateContinentRoute(continent, route, byContinent[continent], extended);
    console.log(`  ROUTE_${continent}: ${route.length}개, 집합/중복/시작점 OK`);
  }
  validateWorldTour(routesModule.ROUTE_WORLD_TOUR, continentOf, extended);
  console.log(`  ROUTE_WORLD_TOUR: ${routesModule.ROUTE_WORLD_TOUR.length}개, 50/6대륙/첫5개 OK`);

  console.log('\n[build-data] routes 지리적 자연스러움 리뷰(assert 아님)');
  for (const [name, route] of [...continentRoutes, ['world-tour', routesModule.ROUTE_WORLD_TOUR] as [string, string[]]]) {
    const report = routeDistanceReport(route, latlngById, 5);
    console.log(`  ROUTE_${name}: 총 ${Math.round(report.totalKm).toLocaleString()}km, 최장점프 ${report.longestJumps
      .map((j) => `${j.from}->${j.to}(${Math.round(j.km)}km)`)
      .join(', ')}`);
  }
}

/**
 * Step: chase-graph(WT-CH-01, docs/09 §5.1 + docs/00 §11-D90·D91-⑥) — un195 전용 nearest-12 +
 * homeEligible + 전쌍 정수 km 행렬. buildChaseGraph는 순수 함수, validateChaseGraph가 검증 룰
 * 4종(nearest 정확히 12·연결성·homeEligible>=30·행렬 대칭/양수/일치)을 통과 못 하면 throw한다
 * (빌드 실패 — 우회 금지). anchor 좌표는 dataset.countries의 latlng(GlobeIndex와 동일 원천).
 */
function buildChaseGraphStep(dataset: { countries: Country[] }): {
  chaseGraphJson: string;
  chaseGraphTs: string;
  homeEligibleCount: number;
  idsCount: number;
} {
  const contentSets = JSON.parse(readFileSync(p('packages/data/overrides/content-sets.json'), 'utf8')) as {
    un195: string[];
    extended: string[];
  };
  const un195 = new Set(contentSets.un195);
  const graph = buildChaseGraph(dataset.countries, un195, BUILT_AT);
  const { homeEligibleCount } = validateChaseGraph(graph, un195);
  return {
    chaseGraphJson: JSON.stringify(graph),
    chaseGraphTs: renderChaseGraphTs(graph),
    homeEligibleCount,
    idsCount: graph.ids.length,
  };
}

async function main(): Promise<void> {
  console.log('[build-data] building deterministic country dataset…');

  // Step 7-(e): i18n 키 동일성 검증(WT-M1-07 활성화). docs/02 §9 — en.json은 ko.json과 키
  // 집합이 완전히 동일해야 한다. 카탈로그 부재 시(이전 마일스톤 스냅샷 등)만 skip+경고.
  const koCatalogPath = p('packages/i18n/ko.json');
  const enCatalogPath = p('packages/i18n/en.json');
  if (existsSync(koCatalogPath) && existsSync(enCatalogPath)) {
    const koCatalog = JSON.parse(readFileSync(koCatalogPath, 'utf8')) as Record<string, unknown>;
    const enCatalog = JSON.parse(readFileSync(enCatalogPath, 'utf8')) as Record<string, unknown>;
    const koKeys = new Set(Object.keys(koCatalog));
    const enKeys = new Set(Object.keys(enCatalog));
    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k)).sort();
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k)).sort();
    if (missingInEn.length > 0 || missingInKo.length > 0) {
      throw new Error(
        `[build-data] Step 7-e i18n 키 동일성 실패 — ` +
          `en에 없음: ${JSON.stringify(missingInEn)}, ko에 없음: ${JSON.stringify(missingInKo)}`,
      );
    }
    console.log(`[build-data] Step 7-e i18n 키 동일성 OK (${koKeys.size}개 키, ko/en diff 0)`);
  } else {
    console.warn('[build-data] i18n 카탈로그 부재 — Step 7-e 키 동일성 검증 skip.');
  }

  const { dataset, countriesJson, topojsonJson, manifestJson, generatedTs, stats } = buildDataset();

  await validateRoutesStep(dataset);

  // Step: chase-graph(WT-CH-01) — un195 nearest-12 + 전쌍 정수 km 행렬(docs/09 §5.1, §11-D91-⑥).
  const chase = buildChaseGraphStep(dataset);

  writeOut('apps/web/public/data/countries.json', countriesJson);
  writeOut('apps/web/public/data/countries-110m.json', topojsonJson);
  writeOut('packages/data/src/generated/countries.ts', generatedTs);
  writeOut('apps/web/public/data/chase-graph.json', chase.chaseGraphJson);
  writeOut('packages/data/src/generated/chase-graph.ts', chase.chaseGraphTs);

  // manifest.json: 기존 countries/map 체크섬(§10) + chase-graph 체크섬(WT-CH-01) 병합 — 필드
  // 추가만(기존 소비자는 manifest.countries.sha256만 읽으므로 §10 계약 무회귀, apps/web/src/app/
  // bootLoader.ts·workers/api/src/routes/config.ts 실사 완료).
  const manifestObj = JSON.parse(manifestJson) as Record<string, unknown>;
  manifestObj.chaseGraph = {
    ids: chase.idsCount,
    homeEligible: chase.homeEligibleCount,
    sha256: sha256(chase.chaseGraphJson),
  };
  writeOut('apps/web/public/data/manifest.json', JSON.stringify(manifestObj));

  // Step 7-(f): OG 공유 카드용 대륙 지도 사전 추출(WT-M6-02, docs/06 §9.1 — 런타임 topojson 파싱
  // 금지). 게임과 동일한 960×500 geoNaturalEarth1 투영으로 대륙별 단순 SVG path + 국가 중심점을
  // 계산해 workers/api/src/og/og-maps.json으로 확정 저장한다(결정적 → CI diff 검증 대상).
  const ogMaps = buildOgMaps(JSON.parse(topojsonJson) as never, dataset.countries);
  writeOut('workers/api/src/og/og-maps.json', JSON.stringify(ogMaps));

  // ── stats: mapFeatureId 매칭 통계 ───────────────────────────────
  console.log('\n[build-data] mapFeatureId binding');
  console.log(`  matched (polygon): ${stats.mapMatched}`);
  console.log(`  circle-fallback (null): ${stats.mapCircleFallback}`);
  console.log(`  kosovo(XK) bound id: ${stats.kosovoBound ?? 'null (properties.name geom has no id)'}`);

  // ── stats: 대륙 카운트 ─────────────────────────────────────────
  console.log('\n[build-data] continent counts (un195)');
  for (const [cont, n] of Object.entries(stats.continentCounts)) console.log(`  ${cont.padEnd(16)} ${n}`);

  // ── stats: 티어 분포 표 ────────────────────────────────────────
  const target: Record<number, number> = { 1: 20, 2: 30, 3: 45, 4: 55, 5: 48 };
  console.log('\n[build-data] tier distribution (un195)  target ±5');
  console.log('  tier | count | target | delta');
  for (const t of [1, 2, 3, 4, 5] as const) {
    const n = stats.tierDistribution[t];
    const delta = n - target[t];
    const flag = Math.abs(delta) > 5 ? '  <-- OUT OF RANGE' : '';
    console.log(`  T${t}   | ${String(n).padStart(5)} | ${String(target[t]).padStart(6)} | ${delta >= 0 ? '+' : ''}${delta}${flag}`);
  }
  console.log(`\n  tier overrides applied: ${stats.tierOverridesApplied}`);

  // ── stats: chase-graph(WT-CH-01) ────────────────────────────────
  console.log('\n[build-data] chase-graph (docs/09 §5.1)');
  console.log(`  ids: ${chase.idsCount} (un195)`);
  console.log(`  homeEligible (tier<=2): ${chase.homeEligibleCount} (>= 30 required)`);

  console.log(
    `\n[build-data] done. total=${stats.total} un195=${stats.un195} extended=${stats.extended}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
  throw err;
});
