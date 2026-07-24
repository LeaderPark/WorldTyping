// spec: docs/09 §9.4(원격 설정 — KV config:chase·constantsVersion 재계산), docs/00 §11-D93·D94 +
//       WT-CH-09
//
// KV `config:chase` 로더(현행 라이브 오버라이드) + 버전 스냅샷 로더(§9.4 버전 불일치 폴백)의
// 단일 원천. 병합·검증 로직 자체는 재구현하지 않고 @wt/shared의 parseChaseConstants/
// mergeChaseConstants만 재사용한다(Gotcha 3 판정·점수 패리티 원칙을 설정 파싱에도 그대로 적용).
//
// [버전 불일치 재계산 규약 — 코드 주석으로 명시(킷 WT-CH-09 지시 4)] `CHASE_CONSTANTS_VERSION`을
// 올리는 시점(런북 절차 — 갱신 자체는 WT-CH-11/리드 소관)에는, 그 직전까지 유효했던 병합 완료
// ChaseConstants 전체를 `config:chase:v{oldVersion}`에 스냅샷으로 남겨 두어야 발급 시점 버전으로
// 제출되는 진행 중인 런을 정확히 재계산할 수 있다. 스냅샷을 남기지 않고 버전만 올리면, 그 버전으로
// 발급된 런은 기본값→현행 순으로 재계산을 시도하고 그래도 안 맞으면 verdict가 practice로
// 강등된다(치터 오인 방지 — reject 아님, routes/runs.ts의 handleChaseSubmit 참조).
import { CHASE_CONSTANTS_VERSION, mergeChaseConstants, parseChaseConstants, type ChaseConstants } from "@wt/shared";
import { KV_KEYS } from "./kv-keys";

/** KV `config:chase`(현행 라이브 오버라이드) 로드. 부재/파싱 실패/스키마 불일치는 코드 기본값. */
export async function loadChaseConstants(kv?: KVNamespace): Promise<ChaseConstants> {
  if (!kv) return mergeChaseConstants();
  const raw = await kv.get(KV_KEYS.configChase);
  if (!raw) return mergeChaseConstants();
  try {
    return parseChaseConstants(JSON.parse(raw));
  } catch {
    return mergeChaseConstants();
  }
}

/**
 * KV `config:chase:v{version}` 스냅샷 로드(§9.4 버전 불일치 폴백 1순위). 부재/파싱 실패는 null —
 * 호출부(resolveChaseConstantsCandidates)가 기본값→현행 순으로 이어서 시도한다.
 */
export async function loadChaseConstantsSnapshot(
  kv: KVNamespace | undefined,
  version: number,
): Promise<ChaseConstants | null> {
  if (!kv) return null;
  const raw = await kv.get(KV_KEYS.configChaseVersion(version));
  if (!raw) return null;
  try {
    // 스냅샷은 이미 병합 완료된 전체 ChaseConstants 덤프를 기대하지만, 방어적으로 override
    // 스키마로도 재검증한다(부분 필드 결측 시 기본값으로 보완 — parseChaseConstants와 동일 관용).
    return parseChaseConstants(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface ChaseConstantsResolution {
  /** 순서대로 시도할 후보(§9.4). 정상 경로(발급 버전=현행)는 길이 1. */
  candidates: readonly ChaseConstants[];
  /** true면 발급 시점 버전이 현행과 다르다(폴백 경로 — 전부 불일치 시 reject 대신 practice 강등). */
  versionMismatch: boolean;
}

/**
 * 제출 검증이 시도할 상수 후보 목록을 만든다(§9.4). issuedVersion === CHASE_CONSTANTS_VERSION이면
 * 현행 KV 오버라이드 하나만 반환(정상 경로, 심 재실행 1회). 다르면 스냅샷→기본값→현행 순으로
 * 후보를 쌓는다(재계산 시도 각각은 chase-verify.ts가 담당).
 */
export async function resolveChaseConstantsCandidates(
  kv: KVNamespace | undefined,
  issuedVersion: number,
): Promise<ChaseConstantsResolution> {
  const currentLive = await loadChaseConstants(kv);
  if (issuedVersion === CHASE_CONSTANTS_VERSION) {
    return { candidates: [currentLive], versionMismatch: false };
  }
  const snapshot = await loadChaseConstantsSnapshot(kv, issuedVersion);
  const candidates: ChaseConstants[] = [];
  if (snapshot) candidates.push(snapshot);
  candidates.push(mergeChaseConstants()); // 기본값
  candidates.push(currentLive); // 현행
  return { candidates, versionMismatch: true };
}
