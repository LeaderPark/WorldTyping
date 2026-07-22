// spec: docs/05 §5.1(동시 결승/타이브레이크 — 하드캡 미완주자 순위 ①nextIndex ②ks ③correctKeystrokes
//       ④lastAcceptAt / 이탈자는 재실 인원 아래), §10.1-3(플레이어별 최종 지표 서버 계산),
//       docs/00 §11-D12(순위 계산의 ks는 필요 타수로 클램프 — A6) + WT-M4-01
//
// 순위·지표 산정의 순수 함수(IO 없음). DO 본체에서 분리해 단위 테스트가 결정적으로 4인 시나리오를
// 검증할 수 있게 했다(경합 없는 white-box 테스트). ksPct/ks는 '표시 전용'이라 순위에는 타이브레이크
// ②에서만, 그것도 필요 타수로 클램프한 값(clampedKs)으로만 쓴다(제약: ksPct 표시 전용).

import type { PlayerRecord } from './room-state';

/**
 * 최종 순위 확정(§5.1). 규칙:
 *  1) 완주자(finishedAt != null): finishedAt 오름차순(= DO 승인 순서). 동시각은 lastAcceptAt로 안정화.
 *  2) 미완주 재실자(connState != 'left'): 타이브레이크 ①~④.
 *  3) 미완주 이탈자(connState == 'left'): 항상 재실자 아래, 이탈자끼리 ①~④.
 * player.rank를 1..N으로 채운다.
 *
 * @param clampedKs playerId → 현재 국가 신고 ks를 '필요 타수로 클램프'한 값(타이브레이크 ②).
 */
export function assignFinalRanks(
  players: readonly PlayerRecord[],
  clampedKs: Readonly<Record<string, number>>,
): void {
  const ks = (p: PlayerRecord): number => clampedKs[p.playerId] ?? 0;

  const finished = players
    .filter((p) => p.finishedAt !== null)
    .sort((a, b) => (a.finishedAt! - b.finishedAt!) || (a.lastAcceptAt - b.lastAcceptAt));

  const tiebreak = (a: PlayerRecord, b: PlayerRecord): number =>
    b.nextIndex - a.nextIndex || // ① 진행 인덱스 내림차순
    ks(b) - ks(a) || // ② 현재 국가 신고 ks(클램프) 내림차순
    b.correctKeystrokes - a.correctKeystrokes || // ③ 승인 타수 내림차순
    a.lastAcceptAt - b.lastAcceptAt; // ④ 먼저 도달한 쪽 우선

  const unfinishedAlive = players
    .filter((p) => p.finishedAt === null && p.connState !== 'left')
    .sort(tiebreak);
  const unfinishedLeft = players
    .filter((p) => p.finishedAt === null && p.connState === 'left')
    .sort(tiebreak);

  let rank = 1;
  for (const p of finished) p.rank = rank++;
  for (const p of unfinishedAlive) p.rank = rank++;
  for (const p of unfinishedLeft) p.rank = rank++;
}

export interface PlayerMetrics {
  elapsedMs: number | null; // 완주자만
  activeMs: number; // cpm 분모
  cpm: number;
  acc: number;
  pi: number;
  countriesCleared: number;
}

/**
 * 플레이어 최종 지표 서버 계산(§10.1-3).
 *  - elapsedMs = finishedAt − startAt (완주자) / null
 *  - activeMs  = 완주자 elapsedMs / 미완주자는 (leftAt ?? raceEndAt) − startAt
 *  - cpm = floor(correctKeystrokes / (activeMs/60000))
 *  - acc = correctKeystrokes / (correctKeystrokes + errorKeystrokes)
 *  - pi  = floor(cpm × acc²)
 */
export function computePlayerMetrics(args: {
  correctKeystrokes: number;
  errorKeystrokes: number;
  finishedAt: number | null;
  leftAt: number | null;
  startAt: number;
  raceEndAt: number;
  nextIndex: number;
  skipped: number;
}): PlayerMetrics {
  const { correctKeystrokes, errorKeystrokes, finishedAt, leftAt, startAt, raceEndAt } = args;
  const endAt = finishedAt ?? leftAt ?? raceEndAt;
  const elapsedMs = finishedAt !== null ? Math.max(0, finishedAt - startAt) : null;
  const activeMs = Math.max(0, endAt - startAt);
  const cpm = activeMs > 0 ? Math.floor(correctKeystrokes / (activeMs / 60000)) : 0;
  const denom = correctKeystrokes + errorKeystrokes;
  const acc = denom > 0 ? correctKeystrokes / denom : 0;
  const pi = Math.floor(cpm * acc * acc);
  const countriesCleared = Math.max(0, args.nextIndex - args.skipped);
  return { elapsedMs, activeMs, cpm, acc, pi, countriesCleared };
}
