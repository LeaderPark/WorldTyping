// spec: docs/03 §8.4(오프라인 PWA — pendingSubmission 큐, IndexedDB idb-keyval), docs/06 §3.1
//       (runToken TTL 30분), docs/07 WT-M3-06 구현 세부 지시 1("대륙/세계일주는 로컬 세트로
//       진행하되 practice 라벨 … 제출은 큐에 — 서버가 수용 판단")
//
// IndexedDB(idb-keyval) 기반 오프라인/실패 제출 큐. 두 시나리오를 모두 흡수한다:
//   (a) /runs/start 자체가 실패(완전 오프라인 출발) — runToken이 없다. flush 시 새로 start를
//       태워 토큰을 재발급한 뒤 submit한다(대륙/세계일주는 고정 세트라 나중에 다시 start해도
//       동일 세트가 나온다 — set-builder.ts 서버 로직과 대칭).
//   (b) start는 성공했지만 submit 전송이 실패 — runToken이 있다. TTL(RUN_TOKEN_TTL_MS) 내라면
//       그 토큰 그대로 재시도하고, 만료됐으면 (a)와 동일하게 재시작한다.
// 티어/데일리는 애초에 서버 시드 없이는 플레이가 시작되지 않으므로(§11-D5·D21) 이 큐에
// 쌓이는 mode는 사실상 continent/worldtour가 대부분이지만, start 이후 순수 네트워크 실패로
// submit만 못 보낸 케이스는 티어/데일리도 들어올 수 있어 mode 전체를 다룬다.
import { del, get, keys, set } from 'idb-keyval';
import { RUN_TOKEN_TTL_MS, type Continent, type DifficultyTier } from '@wt/shared';
import {
  startRun,
  submitRun,
  type InputDigestSubmit,
  type RunResultSubmit,
} from './api-client';

const KEY_PREFIX = 'wt:pending:';
/** 만료 임박(§3.1 TTL 30분) 판정 안전 여유 — 이 값 이내로 남았으면 재시작 취급. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export interface PendingEntry {
  id: string;
  queuedAt: number;
  mode: 'continent' | 'tier' | 'worldtour' | 'daily';
  continent?: Continent;
  tier?: DifficultyTier;
  lang: 'ko' | 'en';
  platform: 'desktop' | 'mobile';
  /** start가 성공해 토큰이 있으면 재사용 시도(TTL 내에서만, 위 안전 여유 참조). */
  runToken?: string;
  runTokenIssuedAt?: number;
  result: RunResultSubmit;
  clientScore: number;
  inputDigest: InputDigestSubmit;
  nickname?: string;
}

async function pendingKeys(): Promise<string[]> {
  const all = await keys();
  return all.filter((k): k is string => typeof k === 'string' && k.startsWith(KEY_PREFIX));
}

export async function enqueuePending(entry: Omit<PendingEntry, 'id' | 'queuedAt'>): Promise<void> {
  const id = crypto.randomUUID();
  const full: PendingEntry = { ...entry, id, queuedAt: Date.now() };
  await set(KEY_PREFIX + id, full);
}

export async function listPending(): Promise<PendingEntry[]> {
  const ks = await pendingKeys();
  const entries = await Promise.all(ks.map((k) => get<PendingEntry>(k)));
  return entries
    .filter((e): e is PendingEntry => e !== undefined)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function removePending(id: string): Promise<void> {
  await del(KEY_PREFIX + id);
}

export interface FlushResult {
  flushed: number;
  remaining: number;
}

/**
 * 큐를 순서대로(FIFO) 소진 시도한다. 항목별 실패 사유를 구분한다:
 *   - 네트워크 자체 실패(여전히 오프라인으로 추정) → 순서 보존을 위해 그 지점에서 중단(뒤 항목도
 *     같은 이유로 실패할 공산이 크다 — 무의미한 연쇄 실패 방지).
 *   - 서버가 응답은 했으나 거절(rejected 등) → "서버가 수용 판단"을 마쳤으므로 큐에서 제거한다
 *     (영구 재시도 대상이 아니다 — submitRun 자체가 throw하지 않는 한 이 분기로 온다).
 */
export async function flushPendingQueue(): Promise<FlushResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, remaining: (await listPending()).length };
  }

  const entries = await listPending();
  let flushed = 0;
  for (const e of entries) {
    try {
      let token = e.runToken;
      const tokenFresh =
        token !== undefined &&
        e.runTokenIssuedAt !== undefined &&
        Date.now() - e.runTokenIssuedAt < RUN_TOKEN_TTL_MS - TOKEN_SAFETY_MARGIN_MS;

      if (!tokenFresh) {
        const started = await startRun({
          mode: e.mode,
          lang: e.lang,
          platform: e.platform,
          continent: e.continent,
          tier: e.tier,
        });
        token = started.runToken;
      }

      await submitRun({
        runToken: token!,
        result: e.result,
        clientScore: e.clientScore,
        inputDigest: e.inputDigest,
        nickname: e.nickname,
      });
      await removePending(e.id);
      flushed++;
    } catch (err) {
      console.warn('[pending-queue] flush 중단(네트워크 실패로 추정):', err);
      break; // 순서 보존 — 뒤 항목은 다음 flush 기회로 미룬다.
    }
  }

  const remaining = await listPending();
  return { flushed, remaining: remaining.length };
}

let autoFlushRegistered = false;

/**
 * 'online' 복귀 시 자동 flush를 등록한다(멱등 — 여러 번 호출해도 리스너는 1개). 부팅 시 1회
 * 호출은 bootLoader.ts가 담당(ensureSession 성공 이후 즉시 1회 flush 시도 포함).
 */
export function registerPendingQueueAutoFlush(): void {
  if (autoFlushRegistered || typeof window === 'undefined') return;
  autoFlushRegistered = true;
  window.addEventListener('online', () => {
    void flushPendingQueue();
  });
}

/** 테스트 전용: 모듈 레벨 플래그 리셋. */
export function __resetPendingQueueAutoFlushForTests(): void {
  autoFlushRegistered = false;
}
