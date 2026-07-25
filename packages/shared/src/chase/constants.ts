// spec: docs/09 §3(게임 규칙 전 수치)·§9.4(KV config:chase 핫스왑), docs/00 §11-D90·D91·D93·D94·D114
//
// "골드 러너"(chase) 모드의 전 게임 수치를 코드화한 단일 원천. 기본값은 docs/09 §3을 1:1 전사한
// 것이며(수치 임의 변경 금지 — 튜닝은 WT-CH-11의 KV 채널 소관이고, 기본값 자체의 변경은 §11 결정
// 행이 있을 때만 — 현재 유일한 개정은 D114-B 경찰 이동 주기 +20%), KV `config:chase`는 이 기본값 위에
// partial 병합된다(§9.4). 병합 입력은 zod `.strict()`로 검증하고, 검증 실패 시 코드 기본값으로
// 폴백한다(§9.4). `constantsVersion`을 시드 발급 응답에 포함해 런 도중 값 변경이 검증 불일치를 만들지
// 않도록 하는 규약은 CH-09(백엔드) 소관이며, 이 파일은 그 버전 상수(CHASE_CONSTANTS_VERSION)를 노출한다.
//
// 이 모듈은 순수(의존성 0, zod 제외) — Date.now/Math.random/DOM 접근 없음.

import { z } from 'zod';
import type { DifficultyTier } from '../types/country';

/** 금 스폰 링 — 홈 기준 대권거리 밴드. */
export type GoldRing = 'near' | 'mid' | 'far';

/** 경찰 유닛 3종(§3.4). */
export type PoliceKind = 'chaser' | 'interceptor' | 'heli';

/** 도주 수배 감소(§3.3·D93) 수치. `enabled=false`면 심에서 완전히 비활성(off 스위치). */
export interface EscapeReductionConstants {
  enabled: boolean;
  /** 최근 이 시간(ms)간 전 유닛과 거리 유지 시 감소 판정. */
  windowMs: number;
  /** "멀다" 기준 대권거리(km) — 정수 행렬 값과 직접 비교(D91-⑥). */
  distanceKm: number;
  /** 감소 재발동 최소 간격(ms). */
  cooldownMs: number;
  /** 1회 감소량(★). */
  starDrop: number;
  /** 감소 하한(★). */
  floor: number;
}

/** 경찰 유닛 파라미터(§3.4 표). */
export interface PoliceConstants {
  /** 추격조 기본 틱(ms) — 실제 틱 = base − perStar×(★−1), 하한 minTickMs. */
  chaserBaseTickMs: number;
  chaserTickPerStarMs: number;
  chaserMinTickMs: number;
  /** 차단조 틱(ms, 고정). */
  interceptorTickMs: number;
  /** 헬기 틱(ms, 고정). */
  heliTickMs: number;
  /** 차단조가 플레이어와 이 홉 이내가 되면 추격 전환. */
  interceptorChaseSwitchHops: number;
  /** 헬기 스폰 링 홉 거리. */
  heliRingHops: number;
  /** 추격조(★1) 스폰 = 플레이어 N홉 전 경로 국가. */
  chaserSpawnHopsBack: number;
}

/** 금 시스템 파라미터(§3.5). */
export interface GoldConstants {
  /** 동시 활성 금 개수(획득 즉시 재스폰해 항상 유지). */
  activeCount: number;
  /** NEAR 링 하한(km) — 이 미만 국가는 금 스폰 대상 아님. */
  ringNearMinKm: number;
  /** NEAR/MID 경계(km). */
  ringNearMaxKm: number;
  /** MID/FAR 경계(km). */
  ringMidMaxKm: number;
  /** 링 추첨 확률(합 1.0). */
  ringNearProb: number;
  ringMidProb: number;
  ringFarProb: number;
  /** 링별 기본 가치. */
  valueNear: number;
  valueMid: number;
  valueFar: number;
  /** 고티어 가중(T4~T5). */
  highTierWeight: number;
  highTierMinTier: DifficultyTier;
}

/** 점수 조립에 쓰이는 chase 고유 계수(§3.6·D94) — 실제 조립은 CH-03 score.ts. */
export interface ChaseScoreConstants {
  /** 배송 콤보 배수 스텝: 정산 = Σ가치 × (1 + step×(개수−1)). */
  haulStep: number;
  /** SurvivalScore = Σ_{s}(별 s 단계 생존 초 × multiplier×s). */
  survivalStarMultiplier: number;
  /** 체포 시 미배송 금 인정 비율(D94). */
  unbankedOnArrestFactor: number;
}

/** docs/09 §3 전 수치. KV `config:chase` partial 오버라이드 병합 대상(§9.4). */
export interface ChaseConstants {
  /** §3.2 선택지 pool 크기(= chase-graph nearest 개수). */
  nearestPoolSize: number;
  /** §3.2 직전 방문국 제외 홉 수(핑퐁 파밍 방지). */
  prevHopsExcluded: number;
  /** §3.3 최초 발령: 홈에서 이 홉 수 완료. */
  firstWantedHops: number;
  /** §3.3 최초 발령: 홈과의 대권거리 ≥ 이 값(km). */
  firstWantedDistanceKm: number;
  /** §3.3 상승 주기(ms). */
  wantedIntervalMs: number;
  /** §3.3 최대 별. */
  wantedMax: number;
  /** §3.3 배송 시 감소량. */
  deliveryStarDrop: number;
  /** §3.3 최초 발령 후 하한(★0 복귀 없음). */
  wantedFloor: number;
  /** §3.3·D93 도주 감소. */
  escapeReduction: EscapeReductionConstants;
  police: PoliceConstants;
  gold: GoldConstants;
  score: ChaseScoreConstants;
}

/**
 * docs/09 §9.4 — 시드 발급 응답에 포함되는 상수 버전. 값 변경 시 CH-11/리드가 증가시킨다.
 *
 * v2(§11-D114-B, WT-CH-DEV-3): 경찰 이동 주기 전 항목 **+20% 감속**(사용자 확정 — "경찰이 살짝
 * 느리게"). 진행 중이던 v1 런은 D93 규약대로 발급 시점 버전으로 재계산되므로 영향이 없다
 * (workers/api/src/lib/chase-config.ts `resolveChaseConstantsCandidates` — 버전 범프 시
 * `config:chase:v1` 스냅샷을 남기는 런북 절차 대상).
 */
export const CHASE_CONSTANTS_VERSION = 2 as const;

/**
 * docs/09 §3 기본값(전사). 이 객체는 절대 런타임 변경 금지 — 병합은 항상 새 객체를 만든다.
 * `ChaseConstants` 주석 대상으로 두어 리터럴(예: highTierMinTier: 4)이 DifficultyTier로 좁혀지게 한다.
 */
const DEFAULT_CHASE_CONSTANTS_BASE: ChaseConstants = {
  nearestPoolSize: 12, // §3.2 pool = nearest 상위 12
  prevHopsExcluded: 2, // §3.2 직전 2홉
  firstWantedHops: 3, // §3.3 홈에서 3홉
  firstWantedDistanceKm: 2000, // §3.3 ≥ 2,000km
  wantedIntervalMs: 45_000, // §3.3 45초마다 +1
  wantedMax: 5, // §3.3 최대 ★5
  deliveryStarDrop: 2, // §3.3 배송 시 ★−2
  wantedFloor: 1, // §3.3 하한 ★1
  escapeReduction: {
    enabled: true, // D93 채택(config off 가능)
    windowMs: 20_000, // §3.3 최근 20초
    distanceKm: 3000, // §3.3 ≥ 3,000km
    cooldownMs: 30_000, // §3.3 쿨다운 30초
    starDrop: 1, // §3.3 ★−1
    floor: 1, // §3.3 하한 ★1
  },
  // 경찰 이동 주기 4항목은 §11-D114-B(WT-CH-DEV-3)로 docs/09 §3.4 원안(4200/300/3000/4200/1800)의
  // **정확히 1.2배**(= +20% 감속)로 개정됐다 — 사용자 확정 "경찰이 살짝 느리게". 4항목을 같은 배율로
  // 함께 올려야 파생 관계(★5 실틱 = base − perStar×4 = minTick)가 유지된다. 스폰 직후 첫 이동
  // (spawnPolice의 `T + tickInterval`)도 같은 상수를 쓰므로 자동으로 동일 비율 지연된다.
  police: {
    chaserBaseTickMs: 5040, // §3.4 4200 − 300×(★−1) ×1.2 → 5040 − 360×(★−1)
    chaserTickPerStarMs: 360,
    chaserMinTickMs: 3600, // §3.4 ★5 = 3000ms ×1.2
    interceptorTickMs: 5040, // §3.4 고정 4200ms ×1.2
    heliTickMs: 2160, // §3.4 고정 1800ms ×1.2
    interceptorChaseSwitchHops: 2, // §3.4 ≤2홉 접근 시 추격 전환(거리 규칙 — 감속 무관)
    heliRingHops: 4, // §3.4 4홉 링(거리 규칙 — 감속 무관)
    chaserSpawnHopsBack: 2, // §3.4 플레이어 2홉 전 경로 국가(거리 규칙 — 감속 무관)
  },
  gold: {
    activeCount: 4, // §3.5 동시 4개
    ringNearMinKm: 2000, // §3.5 NEAR 2,000~4,000
    ringNearMaxKm: 4000,
    ringMidMaxKm: 7000, // §3.5 MID 4,000~7,000, FAR ≥7,000
    ringNearProb: 0.3, // §3.5 30/45/25
    ringMidProb: 0.45,
    ringFarProb: 0.25,
    valueNear: 400, // §3.5 기본 가치
    valueMid: 700,
    valueFar: 1200,
    highTierWeight: 2, // §3.5 T4~T5 2배 가중
    highTierMinTier: 4,
  },
  score: {
    haulStep: 0.25, // §3.5 몰아 배송 배수 스텝
    survivalStarMultiplier: 2, // §3.6 별 s 단계 1초 = 2s점
    unbankedOnArrestFactor: 0.5, // §3.6·D94 미배송 50%
  },
};

export const DEFAULT_CHASE_CONSTANTS: Readonly<ChaseConstants> = Object.freeze(
  DEFAULT_CHASE_CONSTANTS_BASE,
);

// ── KV config:chase partial 오버라이드 스키마(zod .strict(), §9.4) ────────────────────────────
// 모든 필드 optional·모든 객체 .strict()(미지의 키 거부). 검증 통과분만 기본값 위에 깊게 병합한다.

const escapeReductionOverrideSchema = z
  .object({
    enabled: z.boolean(),
    windowMs: z.number().int().nonnegative(),
    distanceKm: z.number().int().nonnegative(),
    cooldownMs: z.number().int().nonnegative(),
    starDrop: z.number().int().nonnegative(),
    floor: z.number().int().nonnegative(),
  })
  .partial()
  .strict();

const policeOverrideSchema = z
  .object({
    chaserBaseTickMs: z.number().int().positive(),
    chaserTickPerStarMs: z.number().int().nonnegative(),
    chaserMinTickMs: z.number().int().positive(),
    interceptorTickMs: z.number().int().positive(),
    heliTickMs: z.number().int().positive(),
    interceptorChaseSwitchHops: z.number().int().nonnegative(),
    heliRingHops: z.number().int().positive(),
    chaserSpawnHopsBack: z.number().int().nonnegative(),
  })
  .partial()
  .strict();

const goldOverrideSchema = z
  .object({
    activeCount: z.number().int().positive(),
    ringNearMinKm: z.number().int().nonnegative(),
    ringNearMaxKm: z.number().int().nonnegative(),
    ringMidMaxKm: z.number().int().nonnegative(),
    ringNearProb: z.number().nonnegative(),
    ringMidProb: z.number().nonnegative(),
    ringFarProb: z.number().nonnegative(),
    valueNear: z.number().int().nonnegative(),
    valueMid: z.number().int().nonnegative(),
    valueFar: z.number().int().nonnegative(),
    highTierWeight: z.number().nonnegative(),
    highTierMinTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  })
  .partial()
  .strict();

const scoreOverrideSchema = z
  .object({
    haulStep: z.number().nonnegative(),
    survivalStarMultiplier: z.number().nonnegative(),
    unbankedOnArrestFactor: z.number().min(0).max(1),
  })
  .partial()
  .strict();

/** KV `config:chase` 원문 검증 스키마(§9.4). partial + strict — 미지의 키는 거부한다. */
export const ChaseConstantsOverrideSchema = z
  .object({
    nearestPoolSize: z.number().int().positive(),
    prevHopsExcluded: z.number().int().nonnegative(),
    firstWantedHops: z.number().int().nonnegative(),
    firstWantedDistanceKm: z.number().int().nonnegative(),
    wantedIntervalMs: z.number().int().positive(),
    wantedMax: z.number().int().positive(),
    deliveryStarDrop: z.number().int().nonnegative(),
    wantedFloor: z.number().int().nonnegative(),
    escapeReduction: escapeReductionOverrideSchema,
    police: policeOverrideSchema,
    gold: goldOverrideSchema,
    score: scoreOverrideSchema,
  })
  .partial()
  .strict();

export type ChaseConstantsOverride = z.infer<typeof ChaseConstantsOverrideSchema>;

/**
 * 기본값 위에 partial 오버라이드를 깊게 병합해 완전한 ChaseConstants를 만든다. 중첩 객체
 * (escapeReduction/police/gold/score)는 필드 단위 병합, 최상위 스칼라는 치환. 입력이 이미 검증된
 * override(ChaseConstantsOverride)임을 전제한다 — 미검증 KV 원문은 parseChaseConstants를 쓸 것.
 */
export function mergeChaseConstants(override: ChaseConstantsOverride = {}): ChaseConstants {
  const base = DEFAULT_CHASE_CONSTANTS;
  return {
    ...base,
    ...scalarOnly(override),
    escapeReduction: { ...base.escapeReduction, ...override.escapeReduction },
    police: { ...base.police, ...override.police },
    gold: { ...base.gold, ...override.gold },
    score: { ...base.score, ...override.score },
  };
}

/** override에서 중첩 객체 키를 뺀 최상위 스칼라만 추출(스프레드 시 중첩 undefined 덮어쓰기 방지). */
function scalarOnly(override: ChaseConstantsOverride): Partial<ChaseConstants> {
  const { escapeReduction: _e, police: _p, gold: _g, score: _s, ...scalars } = override;
  return scalars;
}

/**
 * KV `config:chase` 미검증 원문(unknown)을 검증·병합한다. 검증 실패 시 코드 기본값을 반환한다
 * (§9.4 — 잘못된 원격 설정이 서비스를 깨지 않도록). 성공 시 검증 통과분만 병합된 완전한 상수.
 */
export function parseChaseConstants(raw: unknown): ChaseConstants {
  const parsed = ChaseConstantsOverrideSchema.safeParse(raw ?? {});
  if (!parsed.success) return mergeChaseConstants({});
  return mergeChaseConstants(parsed.data);
}
