// spec: docs/02 §10 (빌드 파이프라인 8단계), §1·§3·§4·§5·§7·§8, docs/00 §11-D1·D22, WT-M1-05
//
// 결정적(deterministic) 데이터 빌드의 순수 코어. 파일을 직접 쓰지 않고 산출 문자열을 반환한다
// (I/O 는 tooling/scripts/build-data.ts 러너가 담당). 누락은 조용히 채우지 않고 throw 한다.
//
// 네트워크 0 — 원천은 world-countries(npm) + world-atlas(npm) + overrides/*.json(저장소 내부).
// loadInputs()(디스크·패키지 로드)와 assemble()(순수 변환)을 분리해, 예외 계약을 테스트가
// 크래프트한 입력으로 검증할 수 있게 한다.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worldCountries from 'world-countries';
import { normalizeEn, normalizeKo, toJamoSeq } from '@wt/shared';
import type { Country, CountriesDataset, Continent, DifficultyTier } from '@wt/shared';
import { assignContinent, EXPECTED_CONTINENT_COUNTS } from './continent';
import { computeTier } from './tier';
import { flagEmoji } from './flag';
import { CountriesDatasetSchema } from '../schema';

const require = createRequire(import.meta.url);

/** builtAt 은 결정적 빌드를 위해 벽시계가 아닌 고정 데이터 버전 스탬프를 쓴다(§10 결정성 계약). */
export const BUILT_AT = '2026-07-21T00:00:00.000Z';

const OVERRIDES = new URL('../../overrides/', import.meta.url);
function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, OVERRIDES), 'utf8')) as T;
}
function readPkgVersion(pkg: string): string {
  const p = require.resolve(`${pkg}/package.json`);
  return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
}

interface TopoGeometry {
  id?: string;
  properties?: { name?: string };
}
interface Topology {
  objects: { countries: { geometries: TopoGeometry[] } };
}

/** world-countries 레코드 중 이 파이프라인이 쓰는 필드만 좁힌 형태(테스트 크래프트 용이). */
export interface SourceCountry {
  cca2: string;
  cca3: string;
  ccn3: string;
  name: { common: string };
  translations?: { kor?: { common: string } };
  capital: string[];
  region: string;
  subregion: string;
  latlng: [number, number];
}

export interface PipelineInputs {
  contentSets: { un195: string[]; extended: string[] };
  namesKo: Record<string, string>;
  aliases: Record<string, { ko?: string[]; en?: string[] }>;
  capitalsKo: Record<string, string>;
  capitalsEn: Record<string, string>;
  recognition: Record<string, number>;
  tiers: Record<string, number>;
  population: Record<string, number>;
  topo: Topology;
  source: SourceCountry[];
  sources: { worldCountries: string; worldAtlas: string };
}

export interface BuildStats {
  total: number;
  un195: number;
  extended: number;
  continentCounts: Record<Continent, number>;
  tierDistribution: Record<DifficultyTier, number>;
  mapMatched: number;
  mapCircleFallback: number;
  kosovoBound: string | null;
  tierOverridesApplied: number;
}

export interface BuildResult {
  dataset: CountriesDataset;
  countriesJson: string;
  generatedTs: string;
  topojsonJson: string;
  manifestJson: string;
  stats: BuildStats;
}

/** Step 1: 디스크·패키지에서 전 입력을 로드한다(네트워크 0). */
export function loadInputs(): PipelineInputs {
  return {
    contentSets: readJson('content-sets.json'),
    namesKo: readJson('names.ko.json'),
    aliases: readJson('aliases.json'),
    capitalsKo: readJson('capitals.ko.json'),
    capitalsEn: readJson('capitals.en.json'),
    recognition: readJson('recognition.json'),
    tiers: readJson('tiers.json'),
    population: readJson('population.json'),
    topo: require('world-atlas/countries-110m.json') as Topology,
    source: worldCountries as unknown as SourceCountry[],
    sources: {
      worldCountries: readPkgVersion('world-countries'),
      worldAtlas: readPkgVersion('world-atlas'),
    },
  };
}

/** 순서 유지 dedupe. */
function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/** Country 객체를 스키마 필드 순서(결정성)로 조립한다. */
function assembleKeysInOrder(c: Country): Country {
  return {
    id: c.id,
    iso3: c.iso3,
    nameKo: c.nameKo,
    nameEn: c.nameEn,
    aliasesKo: c.aliasesKo,
    aliasesEn: c.aliasesEn,
    continent: c.continent,
    subregion: c.subregion,
    difficultyTier: c.difficultyTier,
    capitalKo: c.capitalKo,
    capitalEn: c.capitalEn,
    flagEmoji: c.flagEmoji,
    population: c.population,
    latlng: c.latlng,
    mapFeatureId: c.mapFeatureId,
    acceptedInputsKo: c.acceptedInputsKo,
    acceptedInputsEn: c.acceptedInputsEn,
  };
}

/** Step 2~8: 순수 변환·검증·산출. 입력 누락은 throw(§10 — 조용히 채우지 않는다). */
export function assemble(inputs: PipelineInputs): BuildResult {
  const { contentSets, namesKo, aliases, capitalsKo, capitalsEn, recognition, tiers, population, topo, source, sources } =
    inputs;

  // ── Step 2: 필터 ──────────────────────────────────────────────
  const un195 = new Set(contentSets.un195);
  const extended = new Set(contentSets.extended);
  const wanted = [...un195, ...extended];
  const srcById = new Map(source.map((c) => [c.cca2, c]));
  for (const id of wanted) {
    if (!srcById.has(id)) throw new Error(`content-set id "${id}" not in world-countries (§10 Step 2)`);
  }

  // ── Step 5(사전): topojson geometry id 집합 + 코소보 특례 ───────────
  const geoIds = new Set<string>();
  for (const g of topo.objects.countries.geometries) if (g.id) geoIds.add(g.id);
  const kosovoGeom = topo.objects.countries.geometries.find((g) => g.properties?.name === 'Kosovo');
  const kosovoId = kosovoGeom?.id ?? null;

  // ── Step 3~6: 레코드 조립 ─────────────────────────────────────
  let mapMatched = 0;
  let mapCircleFallback = 0;
  let tierOverridesApplied = 0;
  const countries: Country[] = [];

  for (const id of wanted) {
    const src = srcById.get(id)!;

    // Step 3: 필드 조립
    const nameEn = src.name.common;
    const nameKo = namesKo[id] ?? src.translations?.kor?.common;
    if (!nameKo) throw new Error(`missing nameKo for ${id}: no override and no translations.kor (§10 Step 3)`);
    const aliasesKo = aliases[id]?.ko ?? [];
    const aliasesEn = aliases[id]?.en ?? [];
    const continent = assignContinent(id, src.region, src.subregion);
    const capitalKo = capitalsKo[id];
    if (!capitalKo) throw new Error(`missing capitalKo for ${id} (§10 Step 3 — capitals.ko.json)`);
    const capitalEn = capitalsEn[id] ?? src.capital[0] ?? nameEn;
    const pop = population[id];
    if (pop === undefined) throw new Error(`missing population for ${id} (§10 Step 3 — population.json)`);

    // Step 6: 티어 = 산식 baseline, override 가 최종
    const r = recognition[id];
    if (r === undefined) throw new Error(`missing recognition R for ${id} (§4.1 — recognition.json)`);
    const baseTier = computeTier(r, pop, nameKo);
    const override = tiers[id] as DifficultyTier | undefined;
    const finalTier = override ?? baseTier;
    if (override !== undefined && override !== baseTier) tierOverridesApplied++;

    // Step 4: acceptedInputs (정규화 + dedupe, 순서 = [정식명, ...수동 별칭])
    const acceptedInputsKo = dedupe([normalizeKo(nameKo), ...aliasesKo.map(normalizeKo)]);
    const acceptedInputsEn = dedupe([normalizeEn(nameEn), ...aliasesEn.map(normalizeEn)]);

    // Step 5: mapFeatureId 바인딩(코소보 특례 = properties.name 기반, id 없으면 null)
    const mapFeatureId =
      id === 'XK' ? kosovoId : src.ccn3 && geoIds.has(src.ccn3) ? src.ccn3 : null;
    if (mapFeatureId === null) mapCircleFallback++;
    else mapMatched++;

    countries.push(
      assembleKeysInOrder({
        id,
        iso3: src.cca3,
        nameKo,
        nameEn,
        aliasesKo,
        aliasesEn,
        continent,
        subregion: src.subregion,
        difficultyTier: finalTier,
        capitalKo,
        capitalEn,
        flagEmoji: flagEmoji(id),
        population: pop,
        latlng: src.latlng,
        mapFeatureId,
        acceptedInputsKo,
        acceptedInputsEn,
      }),
    );
  }

  // id 오름차순 정렬(§10 Step 8 결정성)
  countries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── Step 7: 검증 ──────────────────────────────────────────────
  const continentCounts: Record<Continent, number> = {
    asia: 0,
    europe: 0,
    africa: 0,
    'north-america': 0,
    'south-america': 0,
    oceania: 0,
  };
  for (const c of countries) if (un195.has(c.id)) continentCounts[c.continent]++;
  for (const [cont, expected] of Object.entries(EXPECTED_CONTINENT_COUNTS) as [Continent, number][]) {
    if (continentCounts[cont] !== expected) {
      throw new Error(
        `continent count mismatch for ${cont}: got ${continentCounts[cont]}, expected ${expected} (§5.1, §11-D3)`,
      );
    }
  }

  // (b) acceptedInputs 언어별 전역 유일성 + (c) ko 자모 시퀀스 유일성 + (f) 진접두-별칭 금지(D82)
  const koSeen = new Map<string, string>();
  const koJamoSeen = new Map<string, string>();
  const enSeen = new Map<string, string>();
  for (const c of countries) {
    for (const input of c.acceptedInputsKo) {
      const prev = koSeen.get(input);
      if (prev && prev !== c.id) throw new Error(`ko acceptedInput collision "${input}": ${prev} vs ${c.id} (§10 Step 7-b)`);
      koSeen.set(input, c.id);
      const jamo = toJamoSeq(input);
      const prevJamo = koJamoSeen.get(jamo);
      if (prevJamo && prevJamo !== c.id) throw new Error(`ko jamo collision "${input}"(${jamo}): ${prevJamo} vs ${c.id} (§10 Step 7-c)`);
      koJamoSeen.set(jamo, c.id);
    }
    for (const input of c.acceptedInputsEn) {
      const prev = enSeen.get(input);
      if (prev && prev !== c.id) throw new Error(`en acceptedInput collision "${input}": ${prev} vs ${c.id} (§10 Step 7-b)`);
      enSeen.set(input, c.id);
    }

    // (f) 국가 내부 진접두-별칭 금지(D82) — 별칭이 표시 정식명(canonical=acceptedInputs[0])
    // 키의 진접두이면 표시명 타이핑 도중 조기 EXACT가 발화하므로 throw. 방향은 별칭⊂canonical
    // 만 에러 — canonical⊂별칭(체코⊂체코공화국류)·별칭⊂별칭(us⊂usa)은 조기 발화가 아니라 허용.
    const koCanonicalInput = c.acceptedInputsKo[0]!; // Step 4 보장: acceptedInputs[0] = 정식명(항상 존재)
    const koCanonical = toJamoSeq(koCanonicalInput);
    for (const input of c.acceptedInputsKo.slice(1)) {
      const k = toJamoSeq(input);
      if (k.length < koCanonical.length && koCanonical.startsWith(k))
        throw new Error(
          `ko premature-EXACT alias "${input}" is a strict prefix of canonical "${koCanonicalInput}": ${c.id} (§10 Step 7-f, D82)`,
        );
    }
    const enCanonical = c.acceptedInputsEn[0]!; // Step 4 보장: acceptedInputs[0] = 정식명(항상 존재)
    for (const input of c.acceptedInputsEn.slice(1)) {
      if (input.length < enCanonical.length && enCanonical.startsWith(input))
        throw new Error(
          `en premature-EXACT alias "${input}" is a strict prefix of canonical "${enCanonical}": ${c.id} (§10 Step 7-f, D82)`,
        );
    }
  }

  // (a) zod 전체 파싱 — 마지막 계약 게이트
  const dataset: CountriesDataset = { schemaVersion: 2, builtAt: BUILT_AT, sources, countries };
  CountriesDatasetSchema.parse(dataset);

  const tierDistribution: Record<DifficultyTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of countries) if (un195.has(c.id)) tierDistribution[c.difficultyTier]++;

  // ── Step 8: 산출물 문자열 생성 ─────────────────────────────────
  const countriesJson = JSON.stringify(dataset);
  const generatedTs = renderGeneratedTs(countries);
  const topojsonJson = JSON.stringify(topo);
  const manifest = {
    schemaVersion: 2,
    builtAt: BUILT_AT,
    countries: { count: countries.length, sha256: sha256(countriesJson) },
    map: { sha256: sha256(topojsonJson) },
  };
  const manifestJson = JSON.stringify(manifest);

  const stats: BuildStats = {
    total: countries.length,
    un195: countries.filter((c) => un195.has(c.id)).length,
    extended: countries.filter((c) => extended.has(c.id)).length,
    continentCounts,
    tierDistribution,
    mapMatched,
    mapCircleFallback,
    kosovoBound: kosovoId,
    tierOverridesApplied,
  };

  return { dataset, countriesJson, generatedTs, topojsonJson, manifestJson, stats };
}

/** Step 1 + 2~8. pnpm build:data 및 결정성 테스트의 단일 진입점. */
export function buildDataset(): BuildResult {
  return assemble(loadInputs());
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function renderGeneratedTs(countries: Country[]): string {
  const header =
    '// AUTO-GENERATED by tooling/scripts/build-data.ts (WT-M1-05). DO NOT EDIT BY HAND.\n' +
    '// spec: docs/02 §10 Step 8 — Workers 서버 번들용 국가 상수(D1/KV 조회 없이 메모리 검증).\n' +
    "import type { Country } from '@wt/shared';\n\n";
  const body = JSON.stringify(countries, null, 2);
  return `${header}export const COUNTRIES: Country[] = ${body};\n`;
}
