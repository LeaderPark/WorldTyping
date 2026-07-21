// spec: docs/02 §10 (빌드 파이프라인), WT-M1-05
//
// pnpm build:data 엔트리. 결정적 코어(@wt/data 의 buildDataset)를 실행하고 산출물을 디스크에 쓴다.
// 네트워크 0. 실패는 throw 로 전파(조용히 넘기지 않음). world-countries/world-atlas 는
// packages/data 의 의존이므로, 코어를 상대 경로로 import 해 그 위치에서 해석되게 한다.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildDataset } from '../../packages/data/src/build/pipeline.ts';

const REPO_ROOT = new URL('../../', import.meta.url);
const p = (rel: string) => fileURLToPath(new URL(rel, REPO_ROOT));

function writeOut(rel: string, contents: string): void {
  const abs = p(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  console.log(`  wrote ${rel}`);
}

function main(): void {
  console.log('[build-data] building deterministic country dataset…');

  // Step 7-(d)(e): routes.ts / i18n 키 검증은 WT-M1-06 / WT-M1-07 에서 활성화. 파일 부재 시 skip+경고.
  if (existsSync(p('packages/data/content/routes.ts'))) {
    console.warn('[build-data] content/routes.ts 존재 — routes 검증은 WT-M1-06에서 활성화됩니다.');
  } else {
    console.warn('[build-data] content/routes.ts 부재 — Step 7-d routes 검증 skip (WT-M1-06 전).');
  }
  if (existsSync(p('packages/i18n/ko.json')) && existsSync(p('packages/i18n/en.json'))) {
    console.warn('[build-data] i18n 카탈로그 존재 — 키 동일성 검증은 WT-M1-07에서 활성화됩니다.');
  } else {
    console.warn('[build-data] i18n 카탈로그 부재 — Step 7-e 키 동일성 검증 skip (WT-M1-07 전).');
  }

  const { countriesJson, topojsonJson, manifestJson, generatedTs, stats } = buildDataset();

  writeOut('apps/web/public/data/countries.json', countriesJson);
  writeOut('apps/web/public/data/countries-110m.json', topojsonJson);
  writeOut('apps/web/public/data/manifest.json', manifestJson);
  writeOut('packages/data/src/generated/countries.ts', generatedTs);

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

  console.log(
    `\n[build-data] done. total=${stats.total} un195=${stats.un195} extended=${stats.extended}`,
  );
}

main();
