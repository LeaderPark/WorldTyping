// spec: docs/09 §4(결정성 계약 — 최중요)·§3.3~3.5(수배·경찰·금 수치)·§4.1(시그니처)·§4.3(동시각 6단계),
//       docs/00 §11-D91(런 로컬 클록·순수 함수·RNG 3스트림·ISO 동률·정수 km)·D93·D94·D95(자수)
//
// 완전 결정적 추격 심. 클라 표시·서버 검증(§4.4)·runs/submit 재계산이 **같은 함수를 import**한다.
// 동일 입력이면 어떤 플랫폼에서도 바이트 동일 결과를 낸다:
//   1) 난수는 mulberry32(shared/protocol/seeding) 스트림 3개(seed^0x1 선택지 / ^0x2 금 / ^0x3 경찰)
//      에서만 나오고, 소비 순서는 이벤트 시각순으로 고정된다(§4.2-1). Math.random 절대 금지.
//   2) 시각은 전부 moveLog/endMs 파라미터. Date.now/performance.now 직접 호출 금지(§4.2-3).
//   3) 모든 거리 분기는 CH-01 사전 계산 정수 km(graph.dist)만 — 런타임 삼각함수 금지(§4.2-4/D91-⑥).
//   4) 동률 해소는 전부 ISO 사전순(D91-⑤).
//   5) 동시각(ms) 이벤트는 §4.3 6단계 우선순위로 처리: ① 플레이어 홉 → ② 금 획득/배송 정산 →
//      ③ 별 변경 → ④ 경찰 스폰/정원 조정 → ⑤ 경찰 틱(id 오름차순) → ⑥ 체포 판정.
//      이 순서 덕에 "경찰이 들어오는 ms에 빠져나가면 생존"이 항상 성립한다.
//
// 증분 API(advanceChase)는 이전 ChaseState를 재수화(RNG 스트림 draws 카운터 복원)해 이어서 전진하며,
// 전체 재계산(simulateChase)과 바이트 동일해야 한다(property 테스트 대상).

import type { CountryId } from '../types/country';
import { mulberry32 } from '../protocol/seeding';
import type { ChaseConstants, GoldRing, PoliceKind } from './constants';
import {
  bfsPath,
  compareId,
  compileGraph,
  hopDistanceMap,
  nextGreedyStep,
  type ChaseWorld,
  type CompiledChaseGraph,
} from './graph';
import { generateCandidates } from './candidates';

// ── 공개 타입 (§4.1) ────────────────────────────────────────────────────────────────────

export interface MoveLogEntry {
  hopIndex: number;
  countryId: CountryId;
  /** 홉 확정 시각(런 로컬 ms). */
  tMs: number;
}

export interface ChaseInput {
  /** 서버 발급 32bit 시드(§9.1). */
  seed: number;
  moveLog: readonly MoveLogEntry[];
  /** 평가 종료 시각(진행 표시=현재, 검증=체포/자수 시각). */
  endMs: number;
  constants: ChaseConstants;
}

export interface PoliceUnit {
  id: number;
  kind: PoliceKind;
  at: CountryId;
  nextTickMs: number;
  spawnedAtMs: number;
}

export interface Gold {
  at: CountryId;
  ring: GoldRing;
  value: number;
}

export interface CarriedGold {
  value: number;
  ring: GoldRing;
}

export type StarChangeReason = 'issued' | 'interval' | 'delivery' | 'escape';

export type ChaseEvent =
  | { type: 'starChanged'; tMs: number; from: number; to: number; direction: 'up' | 'down'; reason: StarChangeReason }
  | { type: 'policeSpawned'; tMs: number; id: number; kind: PoliceKind; at: CountryId }
  | { type: 'policeMoved'; tMs: number; id: number; from: CountryId; to: CountryId }
  | { type: 'policeRemoved'; tMs: number; id: number }
  | { type: 'goldSpawned'; tMs: number; at: CountryId; ring: GoldRing; value: number }
  | { type: 'goldPicked'; tMs: number; at: CountryId; ring: GoldRing; value: number }
  | { type: 'delivered'; tMs: number; count: number; payout: number; starsAfter: number }
  | { type: 'arrested'; tMs: number; by: PoliceKind; at: CountryId }
  | { type: 'candidatesShown'; tMs: number; hopIndex: number; candidates: CountryId[] };

/** RNG 스트림 스냅샷 — 증분 실행 재현용(seed + 소비 횟수). */
export interface RngSnapshot {
  seed: number;
  draws: number;
}

/**
 * endMs 시점 스냅샷 + 이벤트 로그(§4.1). 완전 직렬화 가능(number/string/array/null만 — Infinity/undefined/
 * Map/Set 없음). 증분 실행에 필요한 내부 상태(rng 스냅샷·타이머·방문 경로)도 포함한다.
 */
export interface ChaseState {
  home: CountryId;
  player: CountryId;
  stars: number;
  police: PoliceUnit[];
  golds: Gold[];
  carried: CarriedGold[];
  events: ChaseEvent[];
  arrestedAtMs: number | null;

  // ── 재수화용 내부 상태 ──
  /** 심이 전진한 시각(= 이 스냅샷의 endMs). */
  timeMs: number;
  /** 적용된 moveLog 엔트리 수. */
  hopsProcessed: number;
  /** [home, …, player] 방문 경로. */
  visited: CountryId[];
  /** 현재 노출 중인 선택지(§3.2). */
  candidates: CountryId[];
  wantedStartMs: number | null;
  /** 다음 45초 상승 시각(발령 후 항상 스케줄, null은 미발령). */
  nextStarUpMs: number | null;
  /** 마지막으로 "전 유닛 far"가 깨진(=근접) 시각. -1=미확립. */
  lastPoliceCloseMs: number;
  /** 마지막 도주 감소 시각. -1=없음. */
  lastEscapeMs: number;
  nextPoliceId: number;
  rngCandidates: RngSnapshot;
  rngGold: RngSnapshot;
  rngPolice: RngSnapshot;
}

// ── RNG 스트림(mulberry32 재사용, 재수화 가능) ────────────────────────────────────────────

interface LiveRng {
  next(): number;
  snapshot(): RngSnapshot;
}

/** 스냅샷에서 라이브 스트림 복원 — draws만큼 앞으로 감아 상태를 재구성(mulberry32는 호출 횟수의 순함수). */
function liveRng(snap: RngSnapshot): LiveRng {
  const seed = snap.seed >>> 0;
  const fn = mulberry32(seed);
  let d = 0;
  while (d < snap.draws) {
    fn();
    d++;
  }
  return {
    next() {
      const v = fn();
      d++;
      return v;
    },
    snapshot() {
      return { seed, draws: d };
    },
  };
}

// ── 심 실행 컨텍스트(패스 내부 전용) ──────────────────────────────────────────────────────

interface SimCtx {
  state: ChaseState;
  g: CompiledChaseGraph;
  world: ChaseWorld;
  c: ChaseConstants;
  moveLog: readonly MoveLogEntry[];
  rngCandidates: LiveRng;
  rngGold: LiveRng;
  rngPolice: LiveRng;
}

const POLICE_LADDER: Record<number, PoliceKind> = {
  1: 'chaser',
  2: 'chaser',
  3: 'interceptor',
  4: 'chaser',
  5: 'heli',
};

// ── 공개 진입점 ────────────────────────────────────────────────────────────────────────

/** §4.1 완전 결정적 순수 함수. seed·moveLog·endMs·constants + 주입 world → endMs 시점 ChaseState. */
export function simulateChase(input: ChaseInput, world: ChaseWorld): ChaseState {
  const ctx = initCtx(input, world);
  runTo(ctx, input.endMs);
  return finalize(ctx);
}

/**
 * 증분 전진(§4.2-5). prev(이전 ChaseState)를 재수화해 input.endMs까지 이어서 전진한다. input.moveLog는
 * **전체**(prev가 이미 소비한 프리픽스 + 신규)여야 하며, seed/constants/world는 prev와 동일해야 한다.
 * 결과는 simulateChase(input, world)와 바이트 동일하다(property 테스트).
 */
export function advanceChase(prev: ChaseState, input: ChaseInput, world: ChaseWorld): ChaseState {
  const ctx = resumeCtx(prev, input, world);
  runTo(ctx, input.endMs);
  return finalize(ctx);
}

// ── 초기화 / 재수화 ──────────────────────────────────────────────────────────────────────

function initCtx(input: ChaseInput, world: ChaseWorld): SimCtx {
  const g = compileGraph(world.graph);
  const seed = input.seed >>> 0;
  const rngCandidates = liveRng({ seed: (seed ^ 0x1) >>> 0, draws: 0 });
  const rngGold = liveRng({ seed: (seed ^ 0x2) >>> 0, draws: 0 });
  const rngPolice = liveRng({ seed: (seed ^ 0x3) >>> 0, draws: 0 });

  // 홈 선택: 서버 시드로 결정(§3.1) — 3스트림과 무관한 base seed 1회 추출. homeEligible(tier≤2) ISO 오름차순.
  const homeList = g.homeEligibleIds();
  const homePick = mulberry32(seed)();
  const home = homeList[Math.min(Math.floor(homePick * homeList.length), homeList.length - 1)]!;

  const state: ChaseState = {
    home,
    player: home,
    stars: 0,
    police: [],
    golds: [],
    carried: [],
    events: [],
    arrestedAtMs: null,
    timeMs: 0,
    hopsProcessed: 0,
    visited: [home],
    candidates: [],
    wantedStartMs: null,
    nextStarUpMs: null,
    lastPoliceCloseMs: -1,
    lastEscapeMs: -1,
    nextPoliceId: 1,
    rngCandidates: rngCandidates.snapshot(),
    rngGold: rngGold.snapshot(),
    rngPolice: rngPolice.snapshot(),
  };

  const ctx: SimCtx = { state, g, world, c: input.constants, moveLog: input.moveLog, rngCandidates, rngGold, rngPolice };

  // t0: 금 activeCount개 스폰 + 홉0 선택지 생성.
  for (let i = 0; i < input.constants.gold.activeCount; i++) spawnGold(ctx, 0);
  generateAndRecordCandidates(ctx, 0);
  return ctx;
}

function resumeCtx(prev: ChaseState, input: ChaseInput, world: ChaseWorld): SimCtx {
  const g = compileGraph(world.graph);
  const state = structuredClone(prev) as ChaseState;
  const rngCandidates = liveRng(state.rngCandidates);
  const rngGold = liveRng(state.rngGold);
  const rngPolice = liveRng(state.rngPolice);
  return { state, g, world, c: input.constants, moveLog: input.moveLog, rngCandidates, rngGold, rngPolice };
}

function finalize(ctx: SimCtx): ChaseState {
  const s = ctx.state;
  s.rngCandidates = ctx.rngCandidates.snapshot();
  s.rngGold = ctx.rngGold.snapshot();
  s.rngPolice = ctx.rngPolice.snapshot();
  return s;
}

// ── 이벤트 루프 ──────────────────────────────────────────────────────────────────────────

function runTo(ctx: SimCtx, targetEndMs: number): void {
  const s = ctx.state;
  if (s.arrestedAtMs !== null) {
    if (targetEndMs > s.timeMs) s.timeMs = targetEndMs;
    return;
  }
  for (;;) {
    const nextT = computeNextEventTime(ctx);
    if (nextT === null || nextT > targetEndMs) break;
    processTimeStep(ctx, nextT);
    s.timeMs = nextT;
    if (s.arrestedAtMs !== null) return; // 체포 시각에 고정(자수·검증은 endMs=체포시각).
  }
  if (targetEndMs > s.timeMs) s.timeMs = targetEndMs;
}

function computeNextEventTime(ctx: SimCtx): number | null {
  const s = ctx.state;
  let next: number | null = null;
  const consider = (t: number | null) => {
    if (t === null) return;
    if (next === null || t < next) next = t;
  };

  if (s.hopsProcessed < ctx.moveLog.length) consider(ctx.moveLog[s.hopsProcessed]!.tMs);
  if (s.nextStarUpMs !== null) consider(s.nextStarUpMs);
  for (const u of s.police) consider(u.nextTickMs);
  const te = escapeFireTime(ctx);
  if (te !== null && te > s.timeMs) consider(te);

  return next;
}

/** §4.3 6단계 우선순위로 시각 T의 모든 동시 이벤트를 처리한다. */
function processTimeStep(ctx: SimCtx, T: number): void {
  const s = ctx.state;

  // ① 플레이어 홉
  const hopDue = s.hopsProcessed < ctx.moveLog.length && ctx.moveLog[s.hopsProcessed]!.tMs === T;
  let deliveryPending: { count: number; payout: number } | null = null;
  if (hopDue) {
    const entry = ctx.moveLog[s.hopsProcessed]!;
    s.player = entry.countryId;
    s.visited.push(entry.countryId);
    s.hopsProcessed++;

    // ② 금 배송/획득 (배송 정산액은 여기서 계산, delivered 이벤트는 ③에서 starsAfter 확정 후 발행)
    deliveryPending = applyDelivery(ctx);
    applyPickup(ctx, T);
  }

  // ③ 별 변경: (a) 최초 발령 (b) 45초 상승 (c) 배송 감소 (d) 도주 감소 — 고정 순서(동시각 결정성).
  applyStarChanges(ctx, T, hopDue, deliveryPending);

  // ④ 경찰 스폰/정원 조정(별 변경 결과에 맞춰).
  reconcilePolice(ctx, T);

  // 선택지 생성(arrival 스냅샷: post-hop 위치·post-pickup 소지·post-spawn 경찰, pre-tick).
  if (hopDue) generateAndRecordCandidates(ctx, T);

  // ⑤ 경찰 틱(id 오름차순).
  tickPolice(ctx, T);

  // 근접 추적(도주 감소 윈도우) — 위치 확정 후.
  updatePoliceCloseness(ctx, T);

  // ⑥ 체포 판정.
  checkArrest(ctx, T);
}

// ── ② 금 ────────────────────────────────────────────────────────────────────────────────

function applyDelivery(ctx: SimCtx): { count: number; payout: number } | null {
  const s = ctx.state;
  if (s.player !== s.home || s.carried.length === 0) return null;
  const count = s.carried.length;
  let sum = 0;
  for (const c of s.carried) sum += c.value;
  const payout = Math.round(sum * (1 + ctx.c.score.haulStep * (count - 1)));
  s.carried = [];
  return { count, payout };
}

function applyPickup(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  const idx = s.golds.findIndex((g) => g.at === s.player);
  if (idx < 0) return;
  const gold = s.golds[idx]!;
  s.carried.push({ value: gold.value, ring: gold.ring });
  s.events.push({ type: 'goldPicked', tMs: T, at: gold.at, ring: gold.ring, value: gold.value });
  s.golds.splice(idx, 1);
  spawnGold(ctx, T); // 즉시 재스폰(항상 activeCount 유지).
}

function goldBand(ctx: SimCtx, km: number): GoldRing | null {
  const gc = ctx.c.gold;
  if (km < gc.ringNearMinKm) return null;
  if (km < gc.ringNearMaxKm) return 'near';
  if (km < gc.ringMidMaxKm) return 'mid';
  return 'far';
}

function goldValue(ctx: SimCtx, ring: GoldRing): number {
  const gc = ctx.c.gold;
  return ring === 'near' ? gc.valueNear : ring === 'mid' ? gc.valueMid : gc.valueFar;
}

function spawnGold(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  const gc = ctx.c.gold;

  // 링 추첨(rng_gold) — 확률 near/mid/far.
  const r = ctx.rngGold.next();
  let drawnRing: GoldRing;
  if (r < gc.ringNearProb) drawnRing = 'near';
  else if (r < gc.ringNearProb + gc.ringMidProb) drawnRing = 'mid';
  else drawnRing = 'far';

  const excluded = new Set<CountryId>([s.home, s.player, ...s.police.map((p) => p.at), ...s.golds.map((g) => g.at)]);

  // 후보 = drawnRing 밴드의 스폰 가능국(ISO 오름차순). 공집합이면 전 밴드로 확장(폴백).
  const inBand: { id: CountryId; band: GoldRing }[] = [];
  const anyBand: { id: CountryId; band: GoldRing }[] = [];
  for (const id of ctx.g.ids) {
    if (excluded.has(id)) continue;
    const band = goldBand(ctx, ctx.g.dist(s.home, id));
    if (band === null) continue;
    anyBand.push({ id, band });
    if (band === drawnRing) inBand.push({ id, band });
  }
  const pool = inBand.length > 0 ? inBand : anyBand;
  if (pool.length === 0) return; // 스폰 가능국 없음(합성 극단) — 개수 미달 감수. 실 그래프 도달 불가.

  // 가중 추첨(T4~T5 highTierWeight, rng_gold).
  const tiers = ctx.world.tiers;
  let total = 0;
  for (const p of pool) total += (tiers[p.id] ?? 3) >= gc.highTierMinTier ? gc.highTierWeight : 1;
  let draw = ctx.rngGold.next() * total;
  let chosen = pool[pool.length - 1]!;
  for (const p of pool) {
    const w = (tiers[p.id] ?? 3) >= gc.highTierMinTier ? gc.highTierWeight : 1;
    if (draw < w) {
      chosen = p;
      break;
    }
    draw -= w;
  }
  const value = goldValue(ctx, chosen.band);
  s.golds.push({ at: chosen.id, ring: chosen.band, value });
  s.events.push({ type: 'goldSpawned', tMs: T, at: chosen.id, ring: chosen.band, value });
}

// ── ③ 별 변경 ────────────────────────────────────────────────────────────────────────────

function emitStar(ctx: SimCtx, T: number, from: number, to: number, reason: StarChangeReason): void {
  if (from === to) return;
  ctx.state.events.push({
    type: 'starChanged',
    tMs: T,
    from,
    to,
    direction: to > from ? 'up' : 'down',
    reason,
  });
}

function applyStarChanges(
  ctx: SimCtx,
  T: number,
  hopDue: boolean,
  deliveryPending: { count: number; payout: number } | null,
): void {
  const s = ctx.state;
  const c = ctx.c;

  // (a) 최초 발령(★0→★1): 홈에서 firstWantedHops 완료 or 홈 거리 ≥ firstWantedDistanceKm (홉에서만 변화).
  if (s.wantedStartMs === null && hopDue) {
    const hopsFromHome = s.hopsProcessed;
    const homeDist = ctx.g.dist(s.player, s.home);
    if (hopsFromHome >= c.firstWantedHops || homeDist >= c.firstWantedDistanceKm) {
      const from = s.stars;
      s.stars = 1;
      s.wantedStartMs = T;
      s.nextStarUpMs = T + c.wantedIntervalMs;
      emitStar(ctx, T, from, s.stars, 'issued');
    }
  }

  // (b) 45초 상승: nextStarUpMs 도달 → +1(최대 clamp). 발령 후 항상 다음 마크로 재스케줄(하락 후 재상승 허용).
  if (s.nextStarUpMs !== null && s.nextStarUpMs === T) {
    const from = s.stars;
    s.stars = Math.min(s.stars + 1, c.wantedMax);
    emitStar(ctx, T, from, s.stars, 'interval');
    s.nextStarUpMs = T + c.wantedIntervalMs;
  }

  // (c) 배송 감소(★−deliveryStarDrop, 하한 wantedFloor) + delivered 이벤트(starsAfter 확정).
  if (deliveryPending !== null) {
    const from = s.stars;
    s.stars = Math.max(s.stars - c.deliveryStarDrop, c.wantedFloor);
    emitStar(ctx, T, from, s.stars, 'delivery');
    s.events.push({ type: 'delivered', tMs: T, count: deliveryPending.count, payout: deliveryPending.payout, starsAfter: s.stars });
  }

  // (d) 도주 감소(D93): escapeFireTime 도달 시.
  if (isEscapeDue(ctx, T)) {
    const from = s.stars;
    s.stars = Math.max(s.stars - c.escapeReduction.starDrop, c.escapeReduction.floor);
    emitStar(ctx, T, from, s.stars, 'escape');
    s.lastEscapeMs = T;
  }
}

// ── 도주 감소 타이밍 ──────────────────────────────────────────────────────────────────────

function escapeFireTime(ctx: SimCtx): number | null {
  const s = ctx.state;
  const er = ctx.c.escapeReduction;
  if (!er.enabled) return null;
  if (s.stars <= er.floor) return null;
  if (s.police.length === 0) return null;
  if (s.lastPoliceCloseMs < 0) return null;
  const byWindow = s.lastPoliceCloseMs + er.windowMs;
  const byCooldown = s.lastEscapeMs < 0 ? byWindow : s.lastEscapeMs + er.cooldownMs;
  return Math.max(byWindow, byCooldown);
}

function isEscapeDue(ctx: SimCtx, T: number): boolean {
  const te = escapeFireTime(ctx);
  return te !== null && te === T;
}

/** 위치 확정 후 "전 유닛 far" 여부 갱신 — 근접(< distanceKm) 유닛이 있으면 윈도우 리셋. */
function updatePoliceCloseness(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  if (s.police.length === 0) return;
  const er = ctx.c.escapeReduction;
  for (const u of s.police) {
    if (ctx.g.dist(u.at, s.player) < er.distanceKm) {
      s.lastPoliceCloseMs = T;
      return;
    }
  }
}

// ── ④ 경찰 스폰/정원 조정 ──────────────────────────────────────────────────────────────────

function reconcilePolice(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  while (s.police.length < s.stars) spawnPolice(ctx, T, s.police.length + 1);
  while (s.police.length > s.stars) removeMostRecentPolice(ctx, T);
}

function removeMostRecentPolice(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  let maxIdx = 0;
  for (let i = 1; i < s.police.length; i++) if (s.police[i]!.id > s.police[maxIdx]!.id) maxIdx = i;
  const removed = s.police[maxIdx]!;
  s.police.splice(maxIdx, 1);
  s.events.push({ type: 'policeRemoved', tMs: T, id: removed.id });
}

function policeExcludeSet(ctx: SimCtx): Set<CountryId> {
  const s = ctx.state;
  return new Set<CountryId>([s.player, s.home, ...s.police.map((p) => p.at)]);
}

function firstValid(ids: readonly CountryId[], exclude: ReadonlySet<CountryId>): CountryId | null {
  for (const id of ids) if (!exclude.has(id)) return id;
  return null;
}

function spawnPolice(ctx: SimCtx, T: number, level: number): void {
  const s = ctx.state;
  const kind = POLICE_LADDER[level] ?? 'chaser';
  const at = resolveSpawnCountry(ctx, kind, level);
  const unit: PoliceUnit = { id: s.nextPoliceId++, kind, at, nextTickMs: T + tickInterval(ctx, kind), spawnedAtMs: T };
  s.police.push(unit);
  s.events.push({ type: 'policeSpawned', tMs: T, id: unit.id, kind, at });
  s.lastPoliceCloseMs = T; // 신규 위협 → 도주 윈도우 리셋.
}

function resolveSpawnCountry(ctx: SimCtx, kind: PoliceKind, level: number): CountryId {
  const s = ctx.state;
  const exclude = policeExcludeSet(ctx);

  if (kind === 'interceptor') {
    // 플레이어↔홈 최단 경로의 ⌈중간⌉ 국가.
    const path = bfsPath(ctx.g, s.player, s.home);
    if (path && path.length >= 3) {
      const midIdx = Math.ceil((path.length - 1) / 2);
      const ordered = orderByProximity(path, midIdx).filter((id) => !exclude.has(id));
      if (ordered.length > 0) return ordered[0]!;
    }
    return fallbackSpawn(ctx, exclude);
  }

  if (kind === 'heli') {
    // 플레이어 기준 heliRingHops 홉 링에서 rng 추첨. 공집합 폴백: |hop−ring| 최소 → ISO 오름차순.
    const hop = hopDistanceMap(ctx.g, s.player);
    const ring: CountryId[] = [];
    for (const [id, d] of hop) {
      if (d === ctx.c.police.heliRingHops && !exclude.has(id)) ring.push(id);
    }
    ring.sort(compareId);
    const pickSet =
      ring.length > 0
        ? ring
        : closestByHopDelta(hop, ctx.c.police.heliRingHops, exclude);
    if (pickSet.length > 0) {
      const idx = Math.floor(ctx.rngPolice.next() * pickSet.length);
      return pickSet[Math.min(idx, pickSet.length - 1)]!;
    }
    return fallbackSpawn(ctx, exclude);
  }

  // chaser
  const hopsBack = ctx.c.police.chaserSpawnHopsBack;
  if (level === 1) {
    const idx = Math.max(0, s.visited.length - 1 - hopsBack);
    const base = s.visited[idx]!;
    if (!exclude.has(base)) return base;
    const nb = firstValid(ctx.g.outNeighbors(base), exclude);
    if (nb) return nb;
    return fallbackSpawn(ctx, exclude);
  }
  // level 2·4: 기존 유닛 인접국 중 rng.
  const poolSet = new Set<CountryId>();
  for (const u of s.police) for (const nb of ctx.g.outNeighbors(u.at)) if (!exclude.has(nb)) poolSet.add(nb);
  const pool = [...poolSet].sort(compareId);
  if (pool.length > 0) {
    const idx = Math.floor(ctx.rngPolice.next() * pool.length);
    return pool[Math.min(idx, pool.length - 1)]!;
  }
  // 폴백: 추격조 2홉 전 로직.
  const idx = Math.max(0, s.visited.length - 1 - hopsBack);
  const base = s.visited[idx]!;
  if (!exclude.has(base)) return base;
  return fallbackSpawn(ctx, exclude);
}

/** path에서 midIdx에 가까운 순서로 정렬(동거리는 낮은 인덱스 우선). */
function orderByProximity(path: readonly CountryId[], midIdx: number): CountryId[] {
  const idxs = path.map((_, i) => i);
  idxs.sort((a, b) => {
    const da = Math.abs(a - midIdx);
    const db = Math.abs(b - midIdx);
    return da !== db ? da - db : a - b;
  });
  return idxs.map((i) => path[i]!);
}

function closestByHopDelta(
  hop: ReadonlyMap<CountryId, number>,
  ringHops: number,
  exclude: ReadonlySet<CountryId>,
): CountryId[] {
  let bestDelta = Number.POSITIVE_INFINITY;
  const entries: CountryId[] = [];
  for (const [id, d] of hop) {
    if (exclude.has(id)) continue;
    const delta = Math.abs(d - ringHops);
    if (delta < bestDelta) bestDelta = delta;
  }
  if (bestDelta === Number.POSITIVE_INFINITY) return [];
  for (const [id, d] of hop) {
    if (exclude.has(id)) continue;
    if (Math.abs(d - ringHops) === bestDelta) entries.push(id);
  }
  entries.sort(compareId);
  return entries;
}

/** 최후 폴백: 전 국가 ISO 오름차순 중 미제외 첫 국가(도달 불가에 가까운 방어). */
function fallbackSpawn(ctx: SimCtx, exclude: ReadonlySet<CountryId>): CountryId {
  const id = firstValid(ctx.g.ids, exclude);
  return id ?? ctx.state.player;
}

function tickInterval(ctx: SimCtx, kind: PoliceKind): number {
  const p = ctx.c.police;
  if (kind === 'interceptor') return p.interceptorTickMs;
  if (kind === 'heli') return p.heliTickMs;
  return Math.max(p.chaserBaseTickMs - p.chaserTickPerStarMs * (ctx.state.stars - 1), p.chaserMinTickMs);
}

// ── ⑤ 경찰 틱 ────────────────────────────────────────────────────────────────────────────

function tickPolice(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  const due = s.police.filter((u) => u.nextTickMs === T).sort((a, b) => a.id - b.id);
  for (const u of due) {
    const target = policeTarget(ctx, u);
    const from = u.at;
    const to = nextGreedyStep(ctx.g, u.at, target);
    u.at = to;
    u.nextTickMs = T + tickInterval(ctx, u.kind);
    if (to !== from) s.events.push({ type: 'policeMoved', tMs: T, id: u.id, from, to });
  }
}

function policeTarget(ctx: SimCtx, u: PoliceUnit): CountryId {
  const s = ctx.state;
  if (u.kind === 'interceptor') {
    // ≤ switchHops면 추격 전환.
    const hop = hopDistanceMap(ctx.g, s.player);
    const d = hop.get(u.at);
    if (d !== undefined && d <= ctx.c.police.interceptorChaseSwitchHops) return s.player;
    const path = bfsPath(ctx.g, s.player, s.home);
    if (path && path.length >= 3) return path[Math.ceil((path.length - 1) / 2)]!;
    return s.home;
  }
  return s.player; // chaser·heli
}

// ── ⑥ 체포 ────────────────────────────────────────────────────────────────────────────────

function checkArrest(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  let caughtBy: PoliceUnit | null = null;
  for (const u of s.police) {
    if (u.at === s.player) {
      if (caughtBy === null || u.id < caughtBy.id) caughtBy = u;
    }
  }
  if (caughtBy === null) return;
  s.arrestedAtMs = T;
  s.events.push({ type: 'arrested', tMs: T, by: caughtBy.kind, at: s.player });
}

// ── 선택지 생성 ──────────────────────────────────────────────────────────────────────────

function generateAndRecordCandidates(ctx: SimCtx, T: number): void {
  const s = ctx.state;
  const cands = generateCandidates(
    {
      visited: s.visited,
      home: s.home,
      carriedCount: s.carried.length,
      policeCountries: new Set(s.police.map((p) => p.at)),
    },
    ctx.world,
    ctx.c,
    () => ctx.rngCandidates.next(),
  );
  s.candidates = cands;
  s.events.push({ type: 'candidatesShown', tMs: T, hopIndex: s.hopsProcessed, candidates: cands });
}

// ── moveLog 재생성 대조(§4.4) ──────────────────────────────────────────────────────────────

export interface ChaseVerifyResult {
  valid: boolean;
  /** 최초로 불일치한 홉 인덱스(valid=false일 때). */
  badHopIndex?: number;
  reason?: 'not-a-candidate' | 'no-candidates' | 'not-processed';
}

/**
 * §4.4 서버 검증의 핵심 유틸: moveLog의 각 홉이 그 시점 선택지 3개 중 하나였는지 재생성 대조한다.
 * 재구현 아님 — simulateChase를 그대로 재실행해 각 arrival의 candidatesShown과 대조한다(단일 원천).
 */
export function verifyMoveLog(input: ChaseInput, world: ChaseWorld): ChaseVerifyResult {
  const state = simulateChase(input, world);
  const shownByHop = new Map<number, CountryId[]>();
  for (const e of state.events) {
    if (e.type === 'candidatesShown') shownByHop.set(e.hopIndex, e.candidates);
  }
  for (const entry of input.moveLog) {
    if (entry.tMs > input.endMs) {
      return { valid: false, badHopIndex: entry.hopIndex, reason: 'not-processed' };
    }
    const shown = shownByHop.get(entry.hopIndex);
    if (!shown) return { valid: false, badHopIndex: entry.hopIndex, reason: 'no-candidates' };
    if (!shown.includes(entry.countryId)) {
      return { valid: false, badHopIndex: entry.hopIndex, reason: 'not-a-candidate' };
    }
  }
  return { valid: true };
}
