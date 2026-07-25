// spec: docs/05 §3 (국가 세트 시딩 — 결정적 RNG, 코드 전문), docs/00 §11-D13(mulberry32 확정,
//       데일리 셔플도 공유 — xoshiro128** 등 다른 PRNG 도입 금지)
// WT-M1-03 — 클라/서버가 공유하는 시딩 모듈. 자구 그대로 전사(§3) — import 경로만 조정했다.
//
// Math.random을 시딩 경로에 쓰지 않는다: 재현·검증·고스트 기록의 결정성이 이 모듈 하나에
// 전부 걸려 있다.
//
// WT-TIER-DIFFICULTY(§11-D107): 티어 서바이벌 세트 생성(buildTierSet)을 서버 lib에서 이 모듈로
// 올리고, T4·T5에 한해 긴 이름 가중 샘플링을 적용한다.

import type { Country, CountryId, DifficultyTier } from '../types/country';
import { requiredKeystrokes } from '../scoring/keystrokes';

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

// ─────────────────────────────────────────────────────────────────────────────
// 티어 서바이벌 세트(§11-D5 일일 시드 20개국) + T4·T5 긴 이름 가중 샘플링(§11-D107)
//
// 세트 생성의 단일 원천. 서버(workers/api set-builder)와 클라가 **이 함수 하나**를 import한다
// (Gotcha 3·5). 시드 자체는 서버 salt 파생이라 서버만 만들 수 있지만(§11-D21), seedHex를 받은
// 쪽은 누구나 동일 세트를 재현할 수 있어야 한다 — 아래 로직에 부동소수 비결정성이 끼면 그
// 재현성이 깨지므로 가중치·선택은 **정수 연산만** 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

/** 티어 세트 크기(§11-D5 — 1런 20개국). */
export const TIER_SET_SIZE = 20;
/** 티어 세트 후보 추출 스트림 id. T1~T3의 단일 셔플 = 종전과 동일 스트림(세트 무변경 보장). */
const TIER_PICK_STREAM = 1;
/** 가중 샘플링(T4·T5) 후 최종 출제 순서 셔플 스트림 id. 뽑기와 순서를 상관시키지 않는다. */
const TIER_ORDER_STREAM = 2;
/** 가중치 스케일(T4의 L^1.5를 정수로 표현하기 위한 배율). 상대 비교만 하므로 절대 크기는 무의미. */
const TIER_WEIGHT_SCALE = 100;

/**
 * mulberry32 스트림에서 원본 32-bit 정수를 복원한다.
 * mulberry32는 `u32 / 2^32`를 반환하고 2의 거듭제곱 나눗셈은 IEEE754에서 정확하므로
 * `r × 2^32`는 원래 u32를 오차 없이 되돌린다(엔진 독립). 가중 샘플링이 float 비교 대신
 * 정수 나머지 연산을 쓸 수 있게 하는 어댑터다.
 */
export function nextUint32(rng: () => number): number {
  return Math.floor(rng() * 4294967296) >>> 0;
}

/**
 * 정수 제곱근(floor). `Math.sqrt`/`Math.pow`는 ECMAScript가 구현 근사를 허용해 엔진 간
 * 마지막 비트가 갈릴 여지가 있다 — 세트 재현성에 그 위험을 남기지 않으려고 Newton 반복을
 * 정수(≤2^53에서 double 연산이 정확)로만 돈다.
 */
function isqrt(n: number): number {
  if (n < 2) return n < 0 ? 0 : n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

/**
 * 티어 세트 샘플링 가중치(정수, §11-D107).
 * - T5: L²          — 긴 이름을 강하게 선호.
 * - T4: L^1.5       — `L × floor(100·√L)`로 정수화(스케일 100).
 * - T1~T3: 1        — 균등(현행 유지).
 * L은 판정 자모열 길이(requiredKeystrokes: ko=toJamoSeq(normalizeKo(nameKo)).length /
 * en=normalizeEn(nameEn).length) — 판정·점수와 동일한 L_i를 그대로 쓴다(별도 길이 정의 금지).
 */
export function tierSamplingWeight(keystrokes: number, tier: DifficultyTier): number {
  const l = Math.max(1, Math.floor(keystrokes)); // L=0(빈 이름 픽스처) 방어 — 가중치 0 풀 방지
  if (tier === 5) return l * l;
  if (tier === 4) return l * isqrt(l * TIER_WEIGHT_SCALE * TIER_WEIGHT_SCALE);
  return 1;
}

/**
 * 정수 가중치 기반 비복원 추출. 누적합 스캔 + `u32 % total`로 선택한다(부동소수 비교 없음).
 * `% total`의 모듈로 편향은 total ≪ 2^32라 무시 가능하고, 무엇보다 **결정적**이다.
 * 후보 배열의 순서(= 호출자가 넘긴 순서)가 결과에 영향을 주므로 호출자는 결정적 정렬을
 * 보장해야 한다(packages/data 생성물의 id 오름차순).
 */
function weightedPick(ids: readonly CountryId[], weights: readonly number[], n: number, rng: () => number): CountryId[] {
  const restIds = ids.slice();
  const restW = weights.slice();
  let total = restW.reduce((a, b) => a + b, 0);
  const out: CountryId[] = [];
  const take = Math.min(n, restIds.length);
  for (let d = 0; d < take; d++) {
    let sel = 0;
    if (total > 0) {
      const r = nextUint32(rng) % total;
      let acc = 0;
      for (let i = 0; i < restIds.length; i++) {
        acc += restW[i]!;
        if (r < acc) {
          sel = i;
          break;
        }
      }
    }
    // total===0(이론상 도달 불가 — 가중치 하한이 1)이면 남은 순서대로 채운다(결정적 폴백).
    out.push(restIds[sel]!);
    total -= restW[sel]!;
    restIds.splice(sel, 1);
    restW.splice(sel, 1);
  }
  return out;
}

/**
 * 티어 서바이벌 세트(순서 포함) 생성 — /runs/start 발급과 /runs/submit 재현이 공유하는 단일 원천.
 *
 * - T1~T3: 종전 그대로 균등 셔플 후 앞 size개(스트림 1). 기존 세트와 **비트 동일**.
 * - T4·T5: 긴 이름 가중 비복원 추출(스트림 1) → 출제 순서만 균등 셔플(스트림 2).
 *   순서를 다시 섞는 이유: 가중 추출은 뽑힌 순서 자체가 길이에 편향돼 런 초반에 최장국이
 *   몰린다 — 난이도를 올리려는 것이지 첫 3개국에서 라이프를 태우게 하려는 게 아니다.
 *
 * @param countries un195 필터가 끝난 목록(호출 전 extended TW/XK/EH 제외), id 오름차순.
 * @param lang 가중치용 L_i 산출 언어. T4·T5 세트는 **언어별로 갈린다**(ko/en 리더보드가
 *   애초에 분리 보드라 보드 내 공정성은 유지 — §11-D107 결정 표 참조). T1~T3는 lang 무관.
 */
export function buildTierSet(
  seedHex: string,
  tier: DifficultyTier,
  countries: readonly Country[],
  lang: 'ko' | 'en',
  size: number = TIER_SET_SIZE,
): CountryId[] {
  const pool = countries.filter((c) => c.difficultyTier === tier);
  const pickRng = rngFromSeedHex(seedHex, TIER_PICK_STREAM);
  const ids = pool.map((c) => c.id);
  if (tier !== 4 && tier !== 5) {
    return seededShuffle(ids, pickRng).slice(0, size);
  }
  const weights = pool.map((c) => tierSamplingWeight(requiredKeystrokes(c, lang), tier));
  const picked = weightedPick(ids, weights, size, pickRng);
  return seededShuffle(picked, rngFromSeedHex(seedHex, TIER_ORDER_STREAM));
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
