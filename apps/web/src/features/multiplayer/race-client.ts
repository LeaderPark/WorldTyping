// spec: docs/05 §4.4(progress 100ms 스로틀+변화시)·§5(낙관 렌더-서버 권위 롤백)·§6.3(권위 시간=서버,
//       ct 참고값)·§7.2(race-sync 재동기)·§8-2(상대 보간·combo 0 셰이크)·§13-F12(3연속 rejected→
//       race-sync), docs/03 §6.3(rollbackTo·완주 게이트)·§6.5(OpponentTracks)·§6.6(서버 권위),
//       docs/00 §11-D7(프로토콜 shared 단일 원천)·D9-A4(클라는 점수·시각 미전송), WT-M4-03
//
// 타이핑 엔진/입력 스트림 ↔ WS 서버를 잇는 레이스 브리지. 내 타이핑은 0ms 로컬(엔진이 판정),
// 서버는 백그라운드 확인이다. complete{idx,input원문,ct,errThis}만 보내고 점수·순위·경과시간은
// 절대 보내지 않는다(§9-A4). 거부/재동기는 엔진 rollbackTo + 입력 버퍼 flush로 흡수한다.
// React 비의존 — 스토어/스케줄러/시계 주입만 사용(단위 테스트 가능).
import { PROGRESS_THROTTLE_MS } from '@wt/shared';
import type { S2C_ProgressTick, S2C_Results, S2C_Start, ServerMessage } from '@wt/shared';
import type { EngineEvent } from '@wt/engine';
import type { TypingEvent } from '@wt/engine';
import type { ClientMessageDraft } from '../../net/ws-manager';
import type { OpponentProgress } from '../../stores/multiplayer';

/** 3연속 거부 시 재동기(F12). */
const MAX_CONSECUTIVE_REJECTS = 3;

/** race-client가 소비하는 멀티 스토어 setter 부분집합(테스트에선 생략 가능). */
export interface RaceStore {
  upsertOpponent(id: string, patch: Partial<OpponentProgress>): void;
  clearOpponents(): void;
  setServerAck(ack: { index: number; serverTime: number } | null): void;
  setRaceResult(result: S2C_Results | null): void;
}

export interface RaceClientDeps {
  /** GameSessionEngine — rollbackTo(권위 롤백) + subscribe(스킵 미러·국가 전환 감지). */
  engine: {
    rollbackTo(index: number): void;
    subscribe(f: (e: EngineEvent) => void): () => void;
  };
  /** TypingInputController — progress/exact 원천. */
  inputEvents: { subscribe(f: (e: TypingEvent) => void): () => void };
  /** 롤백/재동기 시 IME 버퍼 flush(controller.clear()). */
  flushInput: () => void;
  /** ws-manager.send — seq를 스탬핑해 반환(ack 상관용). */
  send: (draft: ClientMessageDraft) => number;
  /** timesync.getOffset() — 서버 epoch = 로컬 perf + offset. */
  offsetMs: () => number;
  /** performance.now(). */
  now: () => number;
  /** progress 스로틀 타이머(기본 setTimeout). */
  schedule?: (cb: () => void, ms: number) => () => void;
  /** 3연속 거부 → race-sync 재동기 요청(재연결 절차 재사용, F12). */
  onDesync?: () => void;
  store?: RaceStore | null;
}

export class RaceClient {
  private countries: readonly string[] = [];
  private localStartPerf: number | null = null;
  private raceIdx = 0;
  private errThis = 0;
  private totalErr = 0;
  private consecutiveRejects = 0;
  private lastTickAt = 0;
  private finishConfirmed = false;
  private readonly pending = new Map<number, number>(); // seq → 주장 idx
  private readonly prevCombo = new Map<string, number>(); // 상대 combo 0 리셋 감지(missFlash)

  // progress 스로틀 상태.
  private lastProgressAt = -Infinity;
  private lastProgressSig = '';
  private pendingProgressKs: number | null = null;
  private progressTimer: (() => void) | null = null;

  private readonly schedule: (cb: () => void, ms: number) => () => void;
  private detachFns: Array<() => void> = [];

  constructor(private readonly deps: RaceClientDeps) {
    this.schedule =
      deps.schedule ??
      ((cb, ms) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      });
  }

  /** 입력·엔진 스트림 구독 시작. */
  attach(): void {
    this.detachFns.push(this.deps.inputEvents.subscribe((e) => this.onTyping(e)));
    this.detachFns.push(this.deps.engine.subscribe((e) => this.onEngine(e)));
  }

  destroy(): void {
    for (const f of this.detachFns) f();
    this.detachFns = [];
    this.cancelProgressTimer();
  }

  /** 결승 연출 게이트: 마지막 complete의 accepted를 받아야 true(§6.3, 블록 §3). */
  isFinishConfirmed(): boolean {
    return this.finishConfirmed;
  }

  /** 서버 권위 다음 인덱스(낙관). 테스트·UI 진단용. */
  getRaceIdx(): number {
    return this.raceIdx;
  }

  /** WS 서버 메시지 라우팅(useMultiplayer가 ws-manager.onMessage에서 위임). */
  handleMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'start':
        this.applyStart(m);
        break;
      case 'race-sync':
        this.applyStart(m.start);
        this.raceIdx = m.me.nextIdx;
        this.errThis = 0;
        this.consecutiveRejects = 0;
        this.deps.engine.rollbackTo(m.me.nextIdx); // nextIdx부터 UI 복원(경과시간은 계속 흐름 §7.2)
        this.deps.flushInput();
        this.applyTick(m.tick);
        break;
      case 'country-accepted':
        this.pending.delete(m.ack);
        this.consecutiveRejects = 0;
        this.deps.store?.setServerAck({ index: m.idx, serverTime: m.serverElapsedMs });
        if (m.finished) this.finishConfirmed = true;
        break;
      case 'country-rejected':
        this.consecutiveRejects += 1;
        this.raceIdx = m.authoritative.nextIdx;
        this.errThis = 0;
        this.pending.clear();
        this.deps.engine.rollbackTo(m.authoritative.nextIdx);
        this.deps.flushInput();
        if (this.consecutiveRejects >= MAX_CONSECUTIVE_REJECTS) {
          this.consecutiveRejects = 0;
          this.deps.onDesync?.(); // F12: race-sync 재동기(재연결 절차 재사용)
        }
        break;
      case 'progress-tick':
        this.applyTick(m);
        break;
      case 'results':
        this.deps.store?.setRaceResult(m); // 서버 값이 유일한 진실(§6.6)
        break;
      default:
        break; // welcome/room-state/countdown/chat 등은 useMultiplayer가 직접 처리
    }
  }

  // ── 입력·엔진 이벤트 ────────────────────────────────────────────────────

  private onTyping(e: TypingEvent): void {
    if (this.localStartPerf === null) return; // 레이스 시작(start) 전 입력은 무시
    switch (e.type) {
      case 'progress':
      case 'miss':
        this.errThis += e.delta.addedError;
        this.totalErr += e.delta.addedError;
        this.queueProgress(e.detail.matchedLen);
        break;
      case 'exact': {
        this.errThis += e.delta.addedError;
        this.totalErr += e.delta.addedError;
        const ct = this.deps.now() - this.localStartPerf;
        const seq = this.deps.send({
          v: 1,
          type: 'complete',
          idx: this.raceIdx,
          input: e.detail.bestTarget.display, // flushIme가 input.value를 비운 뒤라 이 값이 원천
          ct,
          errThis: this.errThis,
        });
        this.pending.set(seq, this.raceIdx);
        this.raceIdx += 1;
        this.errThis = 0;
        break;
      }
      default:
        break; // skipRequested/bulk/blur 등은 서버로 보내지 않는다(자동 스킵·강등은 별 경로)
    }
  }

  private onEngine(e: EngineEvent): void {
    if (e.type === 'countryShown') {
      this.errThis = 0;
    } else if (e.type === 'countryCommitted' && e.skipped) {
      // 서버 10초 자동 스킵(§5) 미러 — complete는 보내지 않고 인덱스만 전진해 엔진과 정합 유지.
      this.raceIdx += 1;
      this.errThis = 0;
    }
  }

  // ── progress 스로틀(100ms + 변화 시, §4.4) ──────────────────────────────

  private queueProgress(ks: number): void {
    const sig = `${this.raceIdx}:${ks}`;
    if (sig === this.lastProgressSig) return; // 내용 변화 없음 → 스킵
    this.pendingProgressKs = ks;
    const elapsed = this.deps.now() - this.lastProgressAt;
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      this.sendProgressNow(ks);
    } else if (this.progressTimer === null) {
      this.progressTimer = this.schedule(() => {
        this.progressTimer = null;
        if (this.pendingProgressKs !== null) this.sendProgressNow(this.pendingProgressKs);
      }, PROGRESS_THROTTLE_MS - elapsed);
    }
  }

  private sendProgressNow(ks: number): void {
    this.lastProgressAt = this.deps.now();
    this.lastProgressSig = `${this.raceIdx}:${ks}`;
    this.pendingProgressKs = null;
    this.deps.send({ v: 1, type: 'progress', idx: this.raceIdx, ks, err: this.totalErr });
  }

  private cancelProgressTimer(): void {
    if (this.progressTimer) {
      this.progressTimer();
      this.progressTimer = null;
    }
  }

  // ── 서버 상태 적용 ──────────────────────────────────────────────────────

  private applyStart(m: S2C_Start): void {
    this.countries = m.countries;
    this.localStartPerf = m.startAt - this.deps.offsetMs();
    this.raceIdx = 0;
    this.errThis = 0;
    this.totalErr = 0;
    this.consecutiveRejects = 0;
    this.lastTickAt = 0;
    this.finishConfirmed = false;
    this.pending.clear();
    this.lastProgressAt = -Infinity;
    this.lastProgressSig = '';
    this.deps.store?.clearOpponents();
  }

  private applyTick(tick: S2C_ProgressTick): void {
    if (tick.at <= this.lastTickAt) return; // at 역전/중복 폐기(순서 방어)
    this.lastTickAt = tick.at;
    const store = this.deps.store;
    if (!store) return;
    for (const p of tick.players) {
      const prev = this.prevCombo.get(p.id) ?? 0;
      const missFlash = p.combo === 0 && prev > 0; // combo 0 리셋 tick → 0.5s 셰이크 근사(§8-2)
      this.prevCombo.set(p.id, p.combo);
      store.upsertOpponent(p.id, {
        idx: p.idx,
        ksPct: p.ksPct,
        combo: p.combo,
        state: p.state,
        rank: p.rank,
        missFlash,
      });
    }
  }
}
