// spec: docs/00 §11-D12(안티치트 임계 단일 config:anticheat KV 통합 — 확정값)·D53(세션 신규 pid
//       상한 핫스왑화 — M6 이행), docs/04 §6.2(파이프라인 임계)·§6.5·§10.3(시간당 신규 pid 상한),
//       docs/06 §3.3(휴리스틱 표)·§3.4(inputDigest)·§3.5(섀도우밴 누적 3회) + WT-M3-03·WT-M6-04
//
// 검증 파이프라인이 쓰는 **모든 임계값의 단일 원천**. 하드코딩 금지 규약(작업 블록 제약)에 따라
// run-verify.ts/runs.ts는 상수를 직접 쓰지 않고 이 로더가 준 AnticheatConfig만 참조한다.
//
// 원천 우선순위: KV `config:anticheat`(핫스왑, 운영자가 config/anticheat.json을 푸시) →
// 부재/파싱실패/스키마불일치 시 DEFAULT_ANTICHEAT_CONFIG(번들 폴백)로 전량 대체.
//
// [동기화 규약] DEFAULT_ANTICHEAT_CONFIG(번들) ↔ config/anticheat.json(KV 푸시 원본)은 값이
// 동일해야 한다. config/anticheat.json은 워커 rootDir 밖이라 번들로 import하지 않는다 — 값을
// 바꿀 때 반드시 두 곳을 함께 수정할 것(§11-D12가 원천).
import { z } from "zod";
import { KV_KEYS } from "./kv-keys";
import { logError } from "./log";

export interface AnticheatConfig {
  /** §6.2-7·§11-D12: 국가당 물리 한계 ms ≥ L_i × minMsPerKeystroke. */
  minMsPerKeystroke: number;
  /** §6.2-8·§11-D12: 판 단위 CPM 하드캡(초과 → rejected). */
  cpmHardCapKo: number;
  cpmHardCapEn: number;
  /** §3.3-b·§11-D12: 소프트캡(초과 → flagged). */
  cpmSoftCapKo: number;
  cpmSoftCapEn: number;
  /** §3.4·§11-D12: 입력 리듬 봇 시그니처(stdev/mean < cv 또는 p90−p10 < spread → flagged). */
  rhythmCvThreshold: number;
  rhythmSpreadMsThreshold: number;
  /** §3.4·§6.2-10d: 벌크 입력(붙여넣기/스와이프) — burstMax 초과 → practice 강등. */
  burstMaxThreshold: number;
  /** §3.3-e: 개인 성장 점프(직전 베스트 PI 대비 factor 초과 & 표본 ≥ minSample → flagged). */
  growthJumpFactor: number;
  growthMinSample: number;
  /** §3.3-f·§6.2-10c: ACC=100% & CPM > threshold & 첫 제출 → flagged. */
  accComboCpmThreshold: number;
  /** §6.2-3: 시간 봉투 유예(elapsedMs ≤ serverElapsed + graceMs). */
  timeEnvelopeGraceMs: number;
  /** §6.2-6: 합산 정합 Σms ∈ [elapsed×low − flat, elapsed×high + flat]. */
  sumMsToleranceLowFactor: number;
  sumMsToleranceHighFactor: number;
  sumMsToleranceFlatMs: number;
  /** §6.2-9: |serverScore − clientScore| > tolerance → flagged(서버 값으로 항상 덮어씀). */
  scoreMismatchTolerance: number;
  /** §3.5: rejected 누적 이 횟수 도달 → users.status='shadowbanned' 자동. */
  rejectedShadowbanThreshold: number;
  /** 멀티(DO) 전용 — §11-D12에 함께 확정. 싱글 파이프라인은 사용하지 않으나 config 원천 단일화를 위해 보관. */
  multi: { reactionFloorMs: number; maxKps: { ko: number; en: number } };
  /** §11-D53: 세션 신규 pid 어뷰징 상한(동일 IP 해시 시간당). routes/session.ts가 하드코딩 대신
   *  이 값을 사용한다. 기본값 20(§10.3 원값 유지) — 환경별 튜닝 가능. */
  newPidAbuseMaxPerHour: number;
}

/** docs/00 §11-D12 확정값. config/anticheat.json과 동일하게 유지할 것(파일 상단 동기화 규약). */
export const DEFAULT_ANTICHEAT_CONFIG: Readonly<AnticheatConfig> = {
  minMsPerKeystroke: 35,
  cpmHardCapKo: 1100,
  cpmHardCapEn: 1000,
  cpmSoftCapKo: 950,
  cpmSoftCapEn: 900,
  rhythmCvThreshold: 0.12,
  rhythmSpreadMsThreshold: 25,
  burstMaxThreshold: 3,
  growthJumpFactor: 0.6,
  growthMinSample: 5,
  accComboCpmThreshold: 800,
  timeEnvelopeGraceMs: 3000,
  sumMsToleranceLowFactor: 0.99,
  sumMsToleranceHighFactor: 1.01,
  sumMsToleranceFlatMs: 500,
  scoreMismatchTolerance: 1,
  rejectedShadowbanThreshold: 3,
  multi: { reactionFloorMs: 250, maxKps: { ko: 14, en: 18 } },
  newPidAbuseMaxPerHour: 20,
};

// KV 핫스왑 값은 운영자 입력이라 방어적으로 검증한다 — 잘못된 값이 무배포로 전 서버에 퍼지는
// 사고를 막고, 실패 시 번들 기본값 전체로 폴백한다(config.ts의 config:client 폴백과 동일 정신).
const AnticheatConfigSchema = z
  .object({
    minMsPerKeystroke: z.number().positive(),
    cpmHardCapKo: z.number().positive(),
    cpmHardCapEn: z.number().positive(),
    cpmSoftCapKo: z.number().positive(),
    cpmSoftCapEn: z.number().positive(),
    rhythmCvThreshold: z.number().positive(),
    rhythmSpreadMsThreshold: z.number().nonnegative(),
    burstMaxThreshold: z.number().nonnegative(),
    growthJumpFactor: z.number().positive(),
    growthMinSample: z.number().int().nonnegative(),
    accComboCpmThreshold: z.number().positive(),
    timeEnvelopeGraceMs: z.number().nonnegative(),
    sumMsToleranceLowFactor: z.number().positive(),
    sumMsToleranceHighFactor: z.number().positive(),
    sumMsToleranceFlatMs: z.number().nonnegative(),
    scoreMismatchTolerance: z.number().nonnegative(),
    rejectedShadowbanThreshold: z.number().int().positive(),
    multi: z.object({
      reactionFloorMs: z.number().nonnegative(),
      maxKps: z.object({ ko: z.number().positive(), en: z.number().positive() }),
    }),
    newPidAbuseMaxPerHour: z.number().int().positive(),
  })
  .strict();

/**
 * KV `config:anticheat`를 로드해 검증한다. 부재/파싱실패/스키마불일치 시 번들 기본값 전체로 폴백.
 * KV 미바인딩(로컬/유닛)일 때도 기본값을 반환한다(관대한 폴백 — 다른 라우트와 동일 톤).
 */
export async function loadAnticheatConfig(kv?: KVNamespace): Promise<AnticheatConfig> {
  if (!kv) return { ...DEFAULT_ANTICHEAT_CONFIG };
  const raw = await kv.get(KV_KEYS.configAnticheat);
  if (!raw) return { ...DEFAULT_ANTICHEAT_CONFIG };
  try {
    const parsed = AnticheatConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    // 운영자가 핫스왑한 값이 스키마를 깼다는 신호.
    logError("config_anticheat_schema_invalid", { message: parsed.error.message });
  } catch (err) {
    logError("config_anticheat_json_invalid", { message: err instanceof Error ? err.message : String(err) });
  }
  return { ...DEFAULT_ANTICHEAT_CONFIG };
}
