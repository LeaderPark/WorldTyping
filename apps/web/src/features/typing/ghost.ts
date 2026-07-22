// spec: docs/01 §9.3(고스트 모드 — "아무 노선 완주 1회" 언락, "자기 최고 기록 고스트와 대결하는
//       싱글 옵션"), docs/03 §4.5(고빈도 값 규약), docs/07 WT-M5-04 [구현 세부 지시 2]
//
// [멀티 봇 고스트와 별개] workers/api/src/lib/ghost.ts는 멀티 레이스에 채워 넣는 "봇" 고스트
// (도로시 §2.3-5, KV ghost:{lang}:{mode}:{piBucket})다 — 이 파일은 그와 무관한 싱글 전용
// 자기 최고 기록 고스트로, localStorage에만 저장되고 서버는 전혀 관여하지 않는다(랭킹 등재
// 대상이 아닌 로컬 진행 캐시일 뿐 — stores/meta.ts의 trackBests와 같은 성격, 별도 파일로 둔
// 이유는 meta.ts의 기존 persist 스키마를 건드리지 않기 위해서다).
import { useEffect, useState } from 'react';
import type { GameSessionEngine } from '@wt/engine';

export interface GhostRecord {
  score: number;
  /** run 시작 기준 누적 완료 시각(ms) — perCountry[i].ms의 누적합. 진행바 마커 재생에 쓴다. */
  cumulativeMs: number[];
}

function ghostKey(mode: string, trackId: string): string {
  return `wt:ghost:${mode}:${trackId}`;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 사생활 모드 등 접근 자체가 throw하는 환경(settings.ts와 동일 방어)
  }
}

/** 저장된 자기 최고 기록 고스트를 읽는다. 형식이 어긋나면(구버전/손상) null로 방어. */
export function loadGhost(mode: string, trackId: string): GhostRecord | null {
  const store = safeLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(ghostKey(mode, trackId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as GhostRecord).score === 'number' &&
      Array.isArray((parsed as GhostRecord).cumulativeMs) &&
      (parsed as GhostRecord).cumulativeMs.every((v) => typeof v === 'number')
    ) {
      return parsed as GhostRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 판 종료(ResultView 마운트 1회) 시 호출. 기존 저장값보다 점수가 높을 때만(자기 최고 기준,
 * stores/meta.ts trackBests와 동일 갱신 규칙) 덮어쓴다 — 완주 여부와 무관하다(부분 진행도
 * 이전 최고보다 나으면 새 목표가 된다).
 */
export function saveGhostIfBest(
  mode: string,
  trackId: string,
  score: number,
  perCountryMs: readonly number[],
): void {
  const store = safeLocalStorage();
  if (!store) return;
  const prev = loadGhost(mode, trackId);
  if (prev && prev.score >= score) return;

  const cumulativeMs: number[] = [];
  let acc = 0;
  for (const ms of perCountryMs) {
    acc += ms;
    cumulativeMs.push(acc);
  }
  try {
    store.setItem(ghostKey(mode, trackId), JSON.stringify({ score, cumulativeMs } satisfies GhostRecord));
  } catch {
    // 쿼터 초과 등 — 고스트는 부가 기능이라 조용히 무시(핵심 제출 경로와 무관).
  }
}

/** 고스트 언락 판정(§9.3 "아무 노선 완주 1회") — trackBests에 completed:true 항목이 하나라도
 *  있으면 해제. meta 스토어를 여기서 직접 구독하지 않고(계층 분리) 호출부가 스냅샷을 넘긴다. */
export function isGhostUnlocked(trackBests: Readonly<Record<string, { completed: boolean }>>): boolean {
  return Object.values(trackBests).some((b) => b.completed);
}

export interface UseGhostProgressOpts {
  engine: GameSessionEngine;
  ghost: GhostRecord | null;
  enabled: boolean;
}

/**
 * 고스트가 현재 위치한 국가 인덱스를 계산한다. 매 프레임 폴링이 아니라 고스트의 누적 완료
 * 시각마다 1회씩만 인덱스를 갱신하는 setTimeout 체인이라(§4.5 "국가 전환 단위 빈도는 React
 * state 허용" — ProgressLine의 ackIndex와 동일 빈도 등급) 고빈도 값 금지 규약과 무관하다.
 * engine/ghost/enabled가 바뀔 때(판 재시작 등)만 재스케줄한다.
 */
export function useGhostProgress(opts: UseGhostProgressOpts): number | null {
  const { engine, ghost, enabled } = opts;
  const [ghostIndex, setGhostIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !ghost || ghost.cumulativeMs.length === 0) {
      setGhostIndex(null);
      return;
    }
    const startTs = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = (i: number): void => {
      if (cancelled) return;
      const targetMs = ghost.cumulativeMs[i];
      if (targetMs === undefined) return; // i가 배열 길이를 넘어섰다 — 고스트 재생 종료.
      const delay = Math.max(0, startTs + targetMs - Date.now());
      timer = setTimeout(() => {
        if (cancelled) return;
        setGhostIndex(i);
        scheduleNext(i + 1);
      }, delay);
    };
    scheduleNext(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [engine, ghost, enabled]);

  return ghostIndex;
}
