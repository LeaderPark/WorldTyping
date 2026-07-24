// spec: docs/09 §3.2(선택지 생성 결정적 알고리즘)·§4.4(verifyMoveLog 재생성 대조),
//       docs/00 §11-D91(⑤ 동률=ISO / rng_candidates 스트림)
//
// §3.2 선택지 3개 생성(순수 함수) + moveLog 재생성 대조. rng는 호출자가 주입하는 draw 함수
// (rng_candidates 스트림, seed^0x1 — 스트림 소유·소비 순서는 simulate가 관리). 판정(matchInput)은
// 여기 없다 — 이 모듈은 "표시할 후보 3국"을 고르는 로직만이며, 입력 문자열을 다루지 않는다(D97: 판정
// 자체는 기존 matchInput 재사용, CH-04 소관). 항상 정확히 3개·중복 없음·경찰 점유국 배제.

import type { CountryId, DifficultyTier } from '../types/country';
import type { ChaseConstants } from './constants';
import { compareId, compileGraph, type ChaseWorld } from './graph';

/** 선택지 생성에 필요한 arrival 스냅샷. current = visited의 마지막. */
export interface CandidateContext {
  /** [home, …, current] — 방문 경로. current = 마지막 원소. */
  visited: readonly CountryId[];
  home: CountryId;
  /** 소지 금 개수(≥1이면 홈 강제 치환 대상). */
  carriedCount: number;
  /** 해당 시점 경찰 점유국(§3.2 — 항상 배제). */
  policeCountries: ReadonlySet<CountryId>;
}

/** tier 버킷 분류(§3.2 step 3). EASY tier≤2 / MID tier=3 / HARD tier≥4. */
function bucketOf(tier: DifficultyTier): 'easy' | 'mid' | 'hard' {
  if (tier <= 2) return 'easy';
  if (tier === 3) return 'mid';
  return 'hard';
}

/**
 * §3.2 선택지 3개 생성. 결정적: 동일 (ctx, world, constants, rng 소비열)이면 동일 결과.
 * - pool = nearest 상위 N(거리 오름차순, §5.1 사전 계산).
 * - 제외: 현재국, 경찰 점유국(항상), 직전 prevHopsExcluded 홉 방문국(pool<3이면 최근국부터 복원).
 * - 버킷 EASY/MID/HARD에서 1개씩 rng 균등 추첨(순서 EASY→MID→HARD), 빈 버킷은 남은 pool에서 거리순 충원.
 * - 금 ≥1 && 홈이 pool 내 && 홈이 경찰국 아님 → 후보 1개를 홈으로 강제 치환(치환 슬롯 = HARD→MID→EASY
 *   우선순위의 첫 존재 슬롯, RNG 미소비 — 결정성 유지 확정 세부, 킷 §6).
 * 반환은 정확히 3개·중복 없음.
 */
export function generateCandidates(
  ctx: CandidateContext,
  world: ChaseWorld,
  constants: ChaseConstants,
  next: () => number,
): CountryId[] {
  const g = compileGraph(world.graph);
  const current = ctx.visited[ctx.visited.length - 1]!;
  const tierOf = (id: CountryId): DifficultyTier => world.tiers[id] ?? 3;

  const poolIds = g.outNeighbors(current).slice(0, constants.nearestPoolSize);

  // 현재국·경찰국은 항상 배제(경찰국 배제 불변식 §3.2).
  const base = poolIds.filter((id) => id !== current && !ctx.policeCountries.has(id));

  // 직전 prevHopsExcluded 방문국 = current 직전의 N개(핑퐁 파밍 방지). pool<3이면 최근국부터 복원.
  const prevRecent = ctx.visited
    .slice(0, ctx.visited.length - 1)
    .reverse()
    .slice(0, constants.prevHopsExcluded);
  const excluded = new Set<CountryId>(prevRecent);
  let ri = 0;
  while (base.filter((id) => !excluded.has(id)).length < 3 && ri < prevRecent.length) {
    excluded.delete(prevRecent[ri]!);
    ri++;
  }
  const filtered = base.filter((id) => !excluded.has(id)); // 거리 오름차순 보존

  // 버킷 추첨.
  const buckets: Record<'easy' | 'mid' | 'hard', CountryId[]> = { easy: [], mid: [], hard: [] };
  for (const id of filtered) buckets[bucketOf(tierOf(id))].push(id);

  const picked: CountryId[] = [];
  for (const key of ['easy', 'mid', 'hard'] as const) {
    const avail = buckets[key].filter((id) => !picked.includes(id));
    if (avail.length === 0) continue; // 빈 버킷은 draw 미소비 — 뒤에서 거리순 충원
    const idx = Math.floor(next() * avail.length);
    picked.push(avail[Math.min(idx, avail.length - 1)]!);
  }

  // 빈 버킷 보충: 남은 filtered에서 거리 가까운 순(RNG 미소비).
  for (const id of filtered) {
    if (picked.length >= 3) break;
    if (!picked.includes(id)) picked.push(id);
  }

  // pool이 극단적으로 좁아 3개 미달이면(합성 그래프 등) 최후로 prev-exclusion 완전 무시하고 거리순 충원.
  // 경찰국 배제는 여기서도 유지(base가 이미 경찰국을 제외했다). 실 un195(nearest 12)에선 도달 불가.
  if (picked.length < 3) {
    for (const id of base) {
      if (picked.length >= 3) break;
      if (!picked.includes(id)) picked.push(id);
    }
  }

  // 홈 강제 치환(§3.2 step 5).
  const homeInPool = poolIds.includes(ctx.home);
  if (
    ctx.carriedCount >= 1 &&
    homeInPool &&
    !ctx.policeCountries.has(ctx.home) &&
    !picked.includes(ctx.home) &&
    picked.length === 3
  ) {
    const slot = pickHomeReplaceSlot(picked, tierOf);
    picked[slot] = ctx.home;
  }

  return picked;
}

/** 치환 슬롯 = HARD→MID→EASY 우선순위의 첫 존재 슬롯(RNG 미소비, 킷 §6 확정 세부). */
function pickHomeReplaceSlot(
  picked: readonly CountryId[],
  tierOf: (id: CountryId) => DifficultyTier,
): number {
  const order: ('hard' | 'mid' | 'easy')[] = ['hard', 'mid', 'easy'];
  for (const key of order) {
    const idx = picked.findIndex((id) => bucketOf(tierOf(id)) === key);
    if (idx >= 0) return idx;
  }
  return 0; // 도달 불가(3개 존재 시 항상 어느 버킷엔 속함) — 방어적 기본.
}

/** §3.2 선택지 결과가 불변식을 만족하는지(정확히 3·중복 없음·경찰국 없음). 테스트/검증용. */
export function candidatesAreValid(
  candidates: readonly CountryId[],
  policeCountries: ReadonlySet<CountryId>,
): boolean {
  if (candidates.length !== 3) return false;
  if (new Set(candidates).size !== 3) return false;
  for (const id of candidates) if (policeCountries.has(id)) return false;
  return true;
}

export { compareId };
