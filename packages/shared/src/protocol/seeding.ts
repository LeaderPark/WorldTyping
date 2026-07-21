// spec: docs/05 §3 (국가 세트 시딩 — 결정적 RNG, 코드 전문), docs/00 §11-D13(mulberry32 확정,
//       데일리 셔플도 공유 — xoshiro128** 등 다른 PRNG 도입 금지)
// WT-M1-03 — 클라/서버가 공유하는 시딩 모듈. 자구 그대로 전사(§3) — import 경로만 조정했다.
//
// Math.random을 시딩 경로에 쓰지 않는다: 재현·검증·고스트 기록의 결정성이 이 모듈 하나에
// 전부 걸려 있다.

import type { Country, CountryId, DifficultyTier } from '../types/country';

/** 32-bit mulberry32 PRNG. 의존성 0, 결정적. seed는 부호 없는 32-bit로 취급된다. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seed hex(32자, 128-bit)에서 streamId로 파생된 독립 스트림을 생성한다.
 * streamId를 분리하는 이유: 티어별 셔플·최종 순서 셔플이 서로 상관되지 않게 하기 위함
 * (예: buildRaceSet의 티어별 pick과 최종 셔플은 서로 다른 streamId를 쓴다).
 */
export function rngFromSeedHex(seedHex: string, streamId: number): () => number {
  const parts = [0, 8, 16, 24].map((i) => parseInt(seedHex.slice(i, i + 8), 16) >>> 0);
  // parts는 고정 길이 4의 리터럴 인덱스([0,8,16,24])에서 나온 값이라 항상 존재한다.
  // (noUncheckedIndexedAccess가 tsconfig.base.json에서 켜져 있어 non-null assertion 필요 — 로직은 §3 원문과 동일)
  const state = (parts[0]! ^ parts[1]! ^ parts[2]! ^ parts[3]! ^ Math.imul(streamId, 0x9e3779b9)) >>> 0;
  return mulberry32(state);
}

/** Fisher-Yates 셔플. rng는 [0,1) 반환 함수(mulberry32 등)여야 결정적이다. */
export function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // i는 항상 유효 인덱스, j는 0<=j<=i<a.length이므로 항상 유효 인덱스다.
    // (noUncheckedIndexedAccess 대응 — 스왑 로직 자체는 §3 원문과 동일)
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export type RaceMode = 'race-mixed' | 'race-continent' | 'race-tier';

/**
 * 결정적 레이스 세트 생성. 클라·서버 동일 결과 보장 조건:
 *  - countries는 packages/data 생성물(id 오름차순 고정 정렬, docs/02 §10 Step 8)이어야 한다.
 *  - dataVersion(=manifest.json 해시)이 start 메시지로 함께 전달되어 불일치 시 클라가 강제 리로드한다.
 *
 * countries 파라미터는 un195 필터가 이미 적용된 목록이어야 한다(호출 전에 extended[TW/XK/EH]
 * 등을 제외해 둘 것 — 이 함수 내부에서는 추가 필터링을 하지 않는다).
 */
export function buildRaceSet(
  seedHex: string,
  mode: RaceMode,
  poolParam: string | null,
  countries: readonly Country[], // un195 필터 적용된 목록
): CountryId[] {
  const un195 = countries; // extended(TW/XK/EH)는 호출 전에 제외되어 있어야 함
  if (mode === 'race-mixed') {
    const pick = (tier: DifficultyTier, n: number, stream: number) =>
      seededShuffle(
        un195.filter((c) => c.difficultyTier === tier).map((c) => c.id),
        rngFromSeedHex(seedHex, stream),
      ).slice(0, n);
    const set = [...pick(1, 6, 1), ...pick(2, 5, 2), ...pick(3, 4, 3)];
    return seededShuffle(set, rngFromSeedHex(seedHex, 4)); // 최종 순서 셔플(티어 블록 제거)
  }
  if (mode === 'race-continent') {
    const pool = un195
      .filter((c) => c.continent === poolParam)
      .sort((a, b) => a.difficultyTier - b.difficultyTier)
      .slice(0, Math.max(15, 0));
    return seededShuffle(
      pool.map((c) => c.id),
      rngFromSeedHex(seedHex, 1),
    ).slice(0, 15);
  }
  // race-tier
  const pool = un195.filter((c) => c.difficultyTier === Number(poolParam));
  return seededShuffle(
    pool.map((c) => c.id),
    rngFromSeedHex(seedHex, 1),
  ).slice(0, 15);
}
