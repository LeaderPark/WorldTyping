// spec: docs/05 §2.3-5(봇 채우기·KV ghost:{lang}:{mode}:{piBucket})·§13-F11(KV miss 시 내장 프로필
//       3종 폴백), docs/00 §11 오픈퀘스천 Q4(콜드 스타트 프로필 PI 250/350/450을 파 타임 역산),
//       docs/00 §7.4(KV 키 카탈로그 — kv-keys.ts 경유) + WT-M4-05
//
// 고스트 봇 데이터 계층. 순수 함수(스케줄 역산·링 버퍼 fit)와 KV I/O(적재/조회)만 담당한다 —
// 봇을 방에 삽입하고 tick으로 재생하는 상태 로직은 MatchRoom.ts 소관이다. DOM/네트워크 비의존,
// requiredKeystrokes(@wt/shared 단일 원천)만 소비해 클라·서버 파 타임 정의가 어긋날 수 없게 한다.

import { requiredKeystrokes, type KeystrokeSource } from '@wt/shared';
import type { GhostSource } from '../do/room-state';
import { KV_KEYS } from './kv-keys';

/** 고스트 봇 프로필(콜드 스타트). targetPi = 목표 PI. 클린 재생이므로 acc=1 → PI == cpm. */
export interface GhostProfile {
  id: string;
  nickname: string; // 'GHOST …' — 봇임을 정직 표기(§2.3-5 nickname:'GHOST_…')
  targetPi: number;
}

/**
 * F11 폴백 내장 프로필 3종. Q4 확정값(PI 250/350/450, 중급자 밴드).
 *
 * 역산 근거(deriveBuiltinCumSplits 참조): 봇은 오타 0(클린)이라 acc=1 → PI = cpm(분당 정답 타수).
 * 따라서 targetPi = cpm이 되도록 국가별 스플릿을 정한다. 국가 i의 소요시간(ms) =
 *   requiredKeystrokes(국가 i) / cpm × 60000  (= "파 타임" — 그 국가를 목표 cpm으로 칠 때의 시간).
 * 15개국 누적 합이 곧 완주 시간이고, 총 정답타수 / (총시간/60000) == targetPi 로 정확히 수렴한다.
 * 세트가 매 레이스 달라도(race-mixed 시드 셔플) 국가별 파 타임으로 역산하므로 PI가 프로필값에 고정된다.
 */
export const BUILTIN_GHOST_PROFILES: readonly GhostProfile[] = [
  { id: 'rookie', nickname: 'GHOST 루키', targetPi: 250 },
  { id: 'racer', nickname: 'GHOST 레이서', targetPi: 350 },
  { id: 'ace', nickname: 'GHOST 에이스', targetPi: 450 },
];

/** KV/R2에 적재하는 수집 고스트 1건 — 국가 인덱스별 누적 완료 시각(레이스 상대시간 ms). */
export interface GhostRecording {
  cumSplitsMs: number[];
}

/** piBucket이 없는(bestPi=null) 신규/게스트 유저의 기본 버킷 — Q4 중급자 중앙값(PI 350). */
export const DEFAULT_PI_BUCKET = 350;
/** piBucket당 링 버퍼 최대 보관 수(§2.3-5 "최대 20개"). */
export const GHOST_RING_MAX = 20;
/** 고스트 KV 항목 TTL(90일) — 오래 방치된 버킷 자동 청소(링 버퍼가 크기는 이미 상한). */
export const GHOST_TTL_S = 60 * 60 * 24 * 90;

/** pi → 100 단위 반올림 문자열 버킷. null/비유한값은 기본 버킷(§2.3-5, Q4). */
export function piBucketOf(pi: number | null | undefined): string {
  const v =
    pi === null || pi === undefined || !Number.isFinite(pi)
      ? DEFAULT_PI_BUCKET
      : Math.max(0, Math.round(pi / 100) * 100);
  return String(v);
}

/**
 * 내장 프로필 스플릿 역산(파일 상단 "역산 근거"). 국가별 파 타임을 누적해 완료 시각 배열을 만든다.
 * countries는 레이스 순서(권위 시퀀스)여야 한다. 결과[i] = i번째 국가 완료 누적 ms.
 */
export function deriveBuiltinCumSplits(
  countries: readonly KeystrokeSource[],
  lang: 'ko' | 'en',
  targetPi: number,
): number[] {
  const cum: number[] = [];
  let acc = 0;
  for (const c of countries) {
    const ks = requiredKeystrokes(c, lang);
    const ms = Math.round((ks / targetPi) * 60_000);
    acc += Math.max(ms, 1); // 0국(빈 이름) 방어 — 최소 1ms
    cum.push(acc);
  }
  return cum;
}

/**
 * 수집 고스트의 누적 스플릿을 이번 레이스 세트 길이에 맞춘다. 같은 길이면 그대로, 길면 절단,
 * 짧으면 관측된 평균 구간으로 외삽한다(수집 세트와 재생 세트가 모두 race-mixed 15라 통상 동일).
 */
export function fitRecordingCumSplits(rec: readonly number[], len: number): number[] {
  if (len <= 0) return [];
  if (rec.length === len) return rec.slice();
  if (rec.length > len) return rec.slice(0, len);
  if (rec.length === 0) {
    // 데이터 없음 — 균일 1초 간격 폴백(도달하지 않는 방어 경로).
    return Array.from({ length: len }, (_, i) => (i + 1) * 1000);
  }
  const out = rec.slice();
  const first = rec[0]!;
  const lastVal = rec[rec.length - 1]!;
  const avgDelta = rec.length >= 2 ? (lastVal - first) / (rec.length - 1) : first;
  let last = lastVal;
  while (out.length < len) {
    last += Math.max(avgDelta, 1);
    out.push(Math.round(last));
  }
  return out;
}

/** GhostSource(봇 레코드에 실린 재생 근거) → 이번 세트의 누적 스플릿. */
export function buildGhostCumSplits(
  source: GhostSource,
  countries: readonly KeystrokeSource[],
  lang: 'ko' | 'en',
): number[] {
  if (source.kind === 'recording') return fitRecordingCumSplits(source.cumSplitsMs, countries.length);
  return deriveBuiltinCumSplits(countries, lang, source.targetPi);
}

function isGhostRecording(x: unknown): x is GhostRecording {
  if (typeof x !== 'object' || x === null) return false;
  const arr = (x as { cumSplitsMs?: unknown }).cumSplitsMs;
  return Array.isArray(arr) && arr.length > 0 && arr.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** KV ghost 버킷에서 수집 고스트를 최신 max개 로드(§2.3-5 "1~3개"). miss/파싱실패면 빈 배열. */
export async function loadGhostRecordings(
  kv: KVNamespace,
  lang: string,
  mode: string,
  piBucket: string,
  max: number,
): Promise<GhostRecording[]> {
  const raw = await kv.get(KV_KEYS.ghost(lang, mode, piBucket));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const recs = parsed.filter(isGhostRecording);
  return recs.slice(Math.max(0, recs.length - max)); // 최신 max개
}

/** 수집 고스트 1건을 링 버퍼(최대 GHOST_RING_MAX)로 적재. 오래된 것부터 밀려난다(§2.3-5). */
export async function appendGhostRecording(
  kv: KVNamespace,
  lang: string,
  mode: string,
  piBucket: string,
  rec: GhostRecording,
  max: number = GHOST_RING_MAX,
): Promise<void> {
  const key = KV_KEYS.ghost(lang, mode, piBucket);
  const raw = await kv.get(key);
  let arr: GhostRecording[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed.filter(isGhostRecording);
    } catch {
      arr = [];
    }
  }
  arr.push(rec);
  if (arr.length > max) arr = arr.slice(arr.length - max);
  await kv.put(key, JSON.stringify(arr), { expirationTtl: GHOST_TTL_S });
}
