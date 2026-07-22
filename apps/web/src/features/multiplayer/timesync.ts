// spec: docs/05 §6.1(오프셋 추정 NTP 축약형·최소 RTT 표본·30ms 유지)·§6.2(동시 출발)·§4.4(빈도:
//       연결 직후 5회 200ms + 10s 주기), docs/03 §6.4(지연 표시), WT-M4-03(timesync.ts)
//
// 서버 클록 오프셋 추정기. offset 정의: 서버 epoch ms = 로컬 performance.now() + offset.
// 따라서 countdown.startAt(서버 epoch)의 로컬 출발 시각(perf) = startAt − offset(§6.2, 블록 §2).
// 프레임워크 비의존 — now/send/schedule 주입만 사용(가상 시계 테스트).
import type { S2C_TimeSync } from '@wt/shared';

export interface TimesyncDeps {
  /** performance.now() 등 단조 로컬 시계(ms). */
  now(): number;
  /** timesync 프레임 전송(t0 = 현재 로컬 시계). ws-manager.send로 배선한다. */
  send(t0: number): void;
  /** setTimeout 래퍼 — 취소 함수를 반환한다(가상 시계 큐 제어). */
  schedule(cb: () => void, ms: number): () => void;
}

/** 연결 직후 버스트 횟수·간격, 이후 주기(§4.4). */
const BURST_COUNT = 5;
const BURST_INTERVAL_MS = 200;
const PERIODIC_MS = 10_000;
/** 표본 갱신 시 offset 변화가 이 값 미만이면 유지(출발선 떨림 방지, §6.1). */
const OFFSET_KEEP_THRESHOLD_MS = 30;

export class Timesync {
  private offset = 0;
  private minRtt = Infinity;
  private readonly pending = new Set<number>();
  private cancels: Array<() => void> = [];
  private stopped = false;

  constructor(private readonly deps: TimesyncDeps) {}

  /** 연결 직후 호출: 200ms 간격 5회 버스트 + 10s 주기. */
  start(): void {
    this.stopped = false;
    for (let i = 0; i < BURST_COUNT; i++) {
      if (i === 0) this.ping();
      else this.cancels.push(this.deps.schedule(() => this.ping(), i * BURST_INTERVAL_MS));
    }
    this.schedulePeriodic();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.cancels) c();
    this.cancels = [];
    this.pending.clear();
  }

  /** S2C timesync 수신 처리. 최소 RTT 표본의 offset을 채택하되 30ms 미만 변화는 유지. */
  onReply(msg: Pick<S2C_TimeSync, 't0' | 't1'>): void {
    const { t0, t1 } = msg;
    if (!this.pending.has(t0)) return; // 우리가 보낸 적 없는(또는 이미 소비한) 표본 무시
    this.pending.delete(t0);
    const t2 = this.deps.now();
    const rtt = t2 - t0;
    if (rtt < 0) return; // 시계 역행 표본 폐기
    const offsetSample = t1 + rtt / 2 - t2;
    if (rtt < this.minRtt) {
      if (this.minRtt === Infinity || Math.abs(offsetSample - this.offset) >= OFFSET_KEEP_THRESHOLD_MS) {
        this.offset = offsetSample;
      }
      this.minRtt = rtt; // 더 나은 표본으로 최소 RTT 갱신(offset은 위 임계로 유지될 수 있음)
    }
  }

  /** 서버 epoch = 로컬 perf + offset. countdown 로컬 출발 = startAt − getOffset(). */
  getOffset(): number {
    return this.offset;
  }

  /** 최소 왕복 지연(ms). HUD latency 뱃지·불안정 배너용(§6.4). 표본 없으면 0. */
  getRttMs(): number {
    return this.minRtt === Infinity ? 0 : this.minRtt;
  }

  private ping(): void {
    if (this.stopped) return;
    const t0 = this.deps.now();
    this.pending.add(t0);
    this.deps.send(t0);
  }

  private schedulePeriodic(): void {
    this.cancels.push(
      this.deps.schedule(() => {
        if (this.stopped) return;
        this.ping();
        this.schedulePeriodic();
      }, PERIODIC_MS),
    );
  }
}
