// spec: docs/05 §7.4(alarm은 DO당 1개 — 다음 만료가 가장 이른 이벤트 하나로 관리, min 패턴),
//       §11.2(hibernation), docs/05 §1.1(CREATED 60s·WAITING idle 10m·COUNTDOWN startAt·
//       RACING hardcap·FINISHED 투표 마감·grace 만료) + WT-M4-01
//
// DO는 alarm을 하나만 가질 수 있으므로 후보 여러 개를 storage 'alarms'에 모아두고, 변경 때마다
// min()으로 setAlarm 한다. alarm() 핸들러는 만기된 후보를 전부 처리 후 다음 min으로 재설정한다.
// 이 파일은 후보 집합의 순수 자료구조 + min 선택만 담당한다(전이 실행은 MatchRoom.ts).

/** 후보 종류. graceDeadlines만 플레이어별 다중(맵), 나머지는 방 단위 단일 슬롯. */
export type AlarmKind =
  | 'autoStart' // 퀵매치 2~3인 15s 자동 시작 (§2.3-4)
  | 'raceStart' // COUNTDOWN startAt 도달 → RACING (§1.1)
  | 'hardcap' // startAt + 180s 강제 종료 (§1.1 RACING)
  | 'voteDeadline' // FINISHED 리매치 투표 마감 (§1.1)
  | 'idleCleanup' // CREATED 60s / WAITING idle 10m → CLOSED (§1.1, §7.4)
  | 'emptyCleanup' // 전원 이탈(연결 0 + grace 0) 60s 후 CLOSED (§7.4)
  | 'persistRetry'; // D1 batch 실패 재시도 (§10.1-7)

export interface AlarmSet {
  autoStart: number | null;
  raceStart: number | null;
  hardcap: number | null;
  voteDeadline: number | null;
  idleCleanup: number | null;
  emptyCleanup: number | null;
  persistRetry: number | null;
  /** playerId → grace 만료 서버시각(§7.1). 만료 시 left 확정. */
  graceDeadlines: Record<string, number>;
}

export function emptyAlarmSet(): AlarmSet {
  return {
    autoStart: null,
    raceStart: null,
    hardcap: null,
    voteDeadline: null,
    idleCleanup: null,
    emptyCleanup: null,
    persistRetry: null,
    graceDeadlines: {},
  };
}

const SCALAR_KINDS: readonly Exclude<AlarmKind, never>[] = [
  'autoStart',
  'raceStart',
  'hardcap',
  'voteDeadline',
  'idleCleanup',
  'emptyCleanup',
  'persistRetry',
];

/**
 * 다음 alarm 시각 = 모든 non-null 후보(스칼라 슬롯 + grace 만료들) 중 최소값. 후보가 없으면 null
 * (→ deleteAlarm). 이것이 §7.4 "다음 만료가 가장 이른 이벤트 하나" 규칙의 단일 구현이다.
 */
export function nextAlarmTime(set: AlarmSet): number | null {
  let min: number | null = null;
  for (const kind of SCALAR_KINDS) {
    const v = set[kind];
    if (v !== null && (min === null || v < min)) min = v;
  }
  for (const playerId of Object.keys(set.graceDeadlines)) {
    const v = set.graceDeadlines[playerId];
    if (v !== undefined && (min === null || v < min)) min = v;
  }
  return min;
}

/** now 시점에 만기된 스칼라 후보들의 종류. 처리 후 호출측이 해당 슬롯을 비운다. */
export function dueScalarKinds(set: AlarmSet, now: number): AlarmKind[] {
  const due: AlarmKind[] = [];
  for (const kind of SCALAR_KINDS) {
    const v = set[kind];
    if (v !== null && v <= now) due.push(kind);
  }
  return due;
}

/** now 시점에 만기된 grace 후보의 playerId 목록. */
export function dueGracePlayers(set: AlarmSet, now: number): string[] {
  const due: string[] = [];
  for (const playerId of Object.keys(set.graceDeadlines)) {
    const v = set.graceDeadlines[playerId];
    if (v !== undefined && v <= now) due.push(playerId);
  }
  return due;
}
