// spec: docs/02 §2 (수도 한국어명 확보 절차), WT-M1-05
//
// ⚠️ 1회성 시드 스크립트 — CI/빌드 파이프라인에서 실행 금지(네트워크 호출 포함).
// Wikidata SPARQL 로 198개국 수도의 한국어 라벨을 추출해 overrides/capitals.ko.json 초안을
// 만든다. 결과는 사람이 검수·확정한 뒤 커밋하며, 이후 원천은 커밋된 override 파일이다.
// 복수 수도 7개국(ZA/BO/LK/MY/TZ/CI/BI)은 docs/02 §2-2 확정값으로 수동 교정한다.
//
// 실행(수동, 로컬에서만):  tsx tooling/scripts/seed-capitals-ko.ts
// 이 저장소의 capitals.ko.json 은 이미 지식 기반으로 채워 커밋되어 있으므로 재실행은 선택.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worldCountries from 'world-countries';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const QUERY = `
SELECT ?iso2 ?capitalKo WHERE {
  ?country wdt:P297 ?iso2 ; wdt:P36 ?capital .
  ?capital rdfs:label ?capitalKo . FILTER(LANG(?capitalKo) = "ko")
}`;

// docs/02 §2-2: 복수 수도 대표 1개(행정수도 우선) 확정값.
const MULTI_CAPITAL_KO: Record<string, string> = {
  ZA: '프리토리아',
  BO: '라파스',
  LK: '스리자야와르데네푸라코테',
  MY: '쿠알라룸푸르',
  TZ: '도도마',
  CI: '야무수크로',
  BI: '기테가',
};

async function main(): Promise<void> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(QUERY)}`;
  // eslint-disable-next-line no-console
  console.warn('[seed-capitals-ko] Wikidata 네트워크 호출 — 1회성 시드 전용. CI 금지.');
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata SPARQL failed: ${res.status}`);
  const json = (await res.json()) as {
    results: { bindings: { iso2: { value: string }; capitalKo: { value: string } }[] };
  };

  const wanted = new Set(worldCountries.map((c) => c.cca2));
  const seed: Record<string, string> = {};
  for (const b of json.results.bindings) {
    const id = b.iso2.value.toUpperCase();
    if (!wanted.has(id) || seed[id]) continue; // 최초 1개만
    seed[id] = b.capitalKo.value;
  }
  Object.assign(seed, MULTI_CAPITAL_KO); // 복수 수도 확정값으로 덮어쓰기

  const sorted: Record<string, string> = {};
  for (const id of Object.keys(seed).sort()) sorted[id] = seed[id];
  const out = fileURLToPath(new URL('../../packages/data/overrides/capitals.ko.seed.json', import.meta.url));
  writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`[seed-capitals-ko] wrote ${Object.keys(sorted).length} entries → capitals.ko.seed.json (검수 후 capitals.ko.json 으로 확정).`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
