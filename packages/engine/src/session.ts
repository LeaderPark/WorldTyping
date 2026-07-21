// spec: docs/03 §5.1 (세션 FSM·EngineEvent·EngineDeps·GameSessionEngine 시그니처),
//       §5.2 (ModeRules), §5.3 (클라 점수 = @wt/shared computeScore), §5.4 (동기 emit·리플레이 로그),
//       docs/01 §5.5 (스킵 페널티)·§6.1 (국가 단위 콤보·확정 시점 리셋)·§7.1 (모드 규칙 매트릭스),
//       §3.3 + docs/00 §11-D2 (세계일주 체크포인트 10/20/30/40 + 종착 50),
//       docs/07 WT-M2-02 (이 작업 블록).
//
// 프레임워크 독립 게임 엔진. Date.now/performance.now 직접 호출 금지 — deps.now()/deps.schedule()
// 주입만 사용해 가상 시계 테스트가 가능하다(WT-M2-02 세션 조정). 점수/제한시간 공식은 재구현하지
// 않고 @wt/shared를 import한다(클라·서버 단일 원천).
import {
  computeScore,
  requiredKeystrokes,
  type Country,
  type CountryId,
  type GameMode,
  type RunResult as ScoreResult,
  type RunStats,
} from '@wt/shared';
import type { KeystrokeDelta } from './accountant';
import type { TypingEvent } from './input-controller';
import { RunLog, type RunSubmission, type SubmissionCountry } from './replay';
import type { ModeRules, MutableRunState } from './rules';

export type SessionPhase = 'idle' | 'countdown' | 'playing' | 'finished' | 'aborted';

/** 초기 카운트다운(3·2·1) 길이(ms). */
export const COUNTDOWN_MS = 3_000;
/** retry() 재개 카운트다운(ms). docs/03 §5.1 "2초 내 재개 목표". */
export const RETRY_COUNTDOWN_MS = 1_500;
/** statsTick 스로틀 주기(ms, docs/03 §5.1 EngineEvent 주석). */
export const STATS_TICK_MS = 500;

export type EngineEvent =
  | { type: 'phase'; phase: SessionPhase }
  | { type: 'countryShown'; index: number; id: CountryId; timeLimitMs: number | null }
  | {
      type: 'countryCommitted';
      index: number;
      id: CountryId;
      ms: number;
      errors: number;
      skipped: boolean;
      combo: number;
    }
  | { type: 'statsTick'; cpm: number; acc: number; elapsedMs: number } // 500ms 스로틀
  | { type: 'comboChanged'; combo: number }
  | { type: 'lifeChanged'; lives: number }
  | { type: 'checkpoint'; legIndex: number; splitMs: number } // 세계일주
  | { type: 'finished'; result: RunResult }
  | { type: 'degradedToPractice'; reason: 'bulk' | 'blur' | 'devtools' };

export interface EngineDeps {
  /** performance.now 주입(가상 시계 테스트). */
  now(): number;
  /** setTimeout 래퍼. 취소 함수를 반환한다(가상 시계에서 큐 제어). */
  schedule(cb: () => void, ms: number): () => void;
  rules: ModeRules;
}

/**
 * finished 이벤트가 싣는 런 결과. docs/03 §5.1의 `RunResult`를 확장한다: @wt/shared의 점수
 * 산출(ScoreResult)에 더해, 랭킹 제출 가부를 가르는 practice/viaCheckpoint 플래그와 원시 stats,
 * 종료 사유(outcome)를 함께 싣는다(제출·고스트·결과 카드가 공통 소비).
 */
export interface RunResult {
  mode: GameMode;
  lang: 'ko' | 'en';
  /** 'completed' = 전 국가 진행(스킵 포함), 'gameover' = 라이프 소진/하드캡 조기 종료. */
  outcome: 'completed' | 'gameover';
  /** 벌크 삽입/창 블러로 연습 강등된 판(랭킹 제외). */
  practice: boolean;
  /** 세계일주 체크포인트 이어하기 사용(랭킹 제출 제외). */
  viaCheckpoint: boolean;
  stats: RunStats;
  score: ScoreResult;
}

export interface EngineSnapshot {
  phase: SessionPhase;
  mode: GameMode;
  lang: 'ko' | 'en';
  countryCount: number;
  /** 현재 제시 중인 국가 index(0-based). 미시작/종료 시 -1. */
  currentIndex: number;
  currentCountryId: CountryId | null;
  lives: number | null;
  combo: number;
  maxCombo: number;
  countriesCleared: number;
  countriesSkipped: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  elapsedMs: number;
  practice: boolean;
  viaCheckpoint: boolean;
  /** 세계일주 게임오버 후 이어하기 가능 여부. */
  checkpointResumeAvailable: boolean;
  countdownEndsAt: number | null;
  result: RunResult | null;
}

interface CommittedCountry {
  code: CountryId;
  ms: number;
  errors: number;
  skipped: boolean;
  keystrokes: number; // 정타+오타
  correct: number; // 정타
  // EXACT 확정에 쓰인 acceptedInput 원문(docs/06 §3.2 perCountry.inputUsed — 서버가
  // matchInput으로 재검증). 'exact' TypingEvent의 detail.bestTarget.display를 그대로 쓴다:
  // controller.flushIme()가 input.value를 이 이벤트보다 먼저 비우므로(input-controller.ts
  // evaluate()), DOM 스냅샷은 이 시점에 이미 소실돼 있다 — bestTarget.display가 유일하게
  // 남는 "무엇이 EXACT를 이뤘는가"의 원천이다. 스킵 커밋은 ''(서버도 skipped면 검증 skip).
  inputUsed: string;
}

export class GameSessionEngine {
  private phase: SessionPhase = 'idle';
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly runLog = new RunLog();

  // 런 상태(retry/resetRunState에서 초기화).
  private currentIndex = -1;
  private readonly state: MutableRunState = { lives: null };
  private combo = 0;
  private maxCombo = 0;
  private countriesCleared = 0;
  private countriesSkipped = 0;
  private totalKeystrokes = 0;
  private correctKeystrokes = 0;
  // 현재 국가의 미확정 누적(확정/스킵 시 런 총계로 반영 또는 폐기).
  private cAdded = 0;
  private cCorrect = 0;
  private cErrors = 0;
  private committed: CommittedCountry[] = [];
  // 진행 중인 국가에서 마지막으로 관측된 EXACT 매치의 bestTarget.display(commitExact에서 소비).
  private pendingExactDisplay = '';
  private practice = false;
  private viaCheckpointUsed = false;
  private resumeUsed = false;
  private result: RunResult | null = null;

  // 시각(전부 deps.now() 기준).
  private playingStartedAt = 0;
  private countryShownAt = 0;
  private lastCommitAt = 0;
  private countdownEndsAt: number | null = null;

  // 타이머 취소 핸들(min-heap 불필요 — 클라는 deps.schedule 다중 사용 가능).
  private cancelCountdown: (() => void) | null = null;
  private cancelCountryTimeout: (() => void) | null = null;
  private cancelStatsTick: (() => void) | null = null;
  private cancelHardCap: (() => void) | null = null;

  constructor(
    private readonly deps: EngineDeps,
    private readonly countries: readonly Country[],
    private readonly lang: 'ko' | 'en',
  ) {
    if (countries.length === 0) {
      throw new Error('GameSessionEngine: countries must not be empty (런 배정 국가 없음 — 계약 위반)');
    }
  }

  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'aborted') return;
    this.resetRunState();
    this.enterCountdown(COUNTDOWN_MS);
  }

  retry(): void {
    if (this.phase !== 'finished') return;
    this.resetRunState();
    this.enterCountdown(RETRY_COUNTDOWN_MS);
  }

  abort(): void {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    this.cancelAllTimers();
    this.setPhase('aborted');
  }

  /**
   * 세계일주 전용: 라이프 0 게임오버 후 마지막 통과 체크포인트에서 1회 이어하기.
   * 사용 시 viaCheckpoint=true(랭킹 제출 제외). 조건 불충족이면 false를 반환하고 상태 불변.
   */
  resumeFromCheckpoint(): boolean {
    if (this.phase !== 'finished') return false;
    if (this.deps.rules.id !== 'worldtour') return false;
    if (this.resumeUsed) return false;
    if (this.result?.outcome !== 'gameover') return false;

    const cps = this.deps.rules.checkpoints ?? [];
    const committedCount = this.committed.length;
    let cp = 0; // 마지막 통과 체크포인트(≤ committedCount). 없으면 0(처음부터).
    for (const c of cps) if (c <= committedCount) cp = c;

    this.resumeUsed = true;
    this.viaCheckpointUsed = true;
    this.committed = this.committed.slice(0, cp);
    this.recomputeTotals();
    this.countriesCleared = this.committed.filter((p) => !p.skipped).length;
    this.countriesSkipped = this.committed.filter((p) => p.skipped).length;
    this.combo = 0;
    this.state.lives = this.deps.rules.lives;
    this.result = null;

    this.setPhase('playing');
    if (this.state.lives !== null) this.emit({ type: 'lifeChanged', lives: this.state.lives });
    this.scheduleStatsTick();
    this.showCountry(cp);
    return true;
  }

  /** TypingInputController.subscribe를 그대로 연결한다. playing 이외 phase의 이벤트는 무시. */
  handleInput(e: TypingEvent): void {
    if (this.phase !== 'playing') return;
    const added =
      e.type === 'progress' || e.type === 'miss' || e.type === 'exact' ? e.delta.added : 0;
    this.runLog.append(e, this.now() - this.playingStartedAt, added);

    switch (e.type) {
      case 'progress':
        this.accumulate(e.delta);
        break;
      case 'miss':
        // 콤보는 여기서 리셋하지 않는다 — 확정 시점에 0(GDD §6.1, 확정 전 표시 유지).
        this.accumulate(e.delta);
        break;
      case 'exact':
        this.pendingExactDisplay = e.detail.bestTarget.display;
        this.accumulate(e.delta);
        this.commitExact();
        break;
      case 'skipRequested':
        this.commitSkip();
        break;
      case 'bulkInsert':
        this.degrade('bulk');
        break;
      case 'blurred':
        this.degrade('blur');
        break;
      case 'latinInKoMode':
      case 'refocused':
        break; // 엔진 상태 무관 — UI 계층(WT-M2-03) 소관
    }
  }

  subscribe(f: (e: EngineEvent) => void): () => void {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }

  getSnapshot(): Readonly<EngineSnapshot> {
    const elapsedMs =
      this.phase === 'playing'
        ? this.now() - this.playingStartedAt
        : this.lastCommitAt > this.playingStartedAt
          ? this.lastCommitAt - this.playingStartedAt
          : 0;
    const cur =
      this.currentIndex >= 0 && this.currentIndex < this.countries.length
        ? this.countries[this.currentIndex]!.id
        : null;
    return {
      phase: this.phase,
      mode: this.deps.rules.id,
      lang: this.lang,
      countryCount: this.countries.length,
      currentIndex: this.currentIndex,
      currentCountryId: cur,
      lives: this.state.lives,
      combo: this.combo,
      maxCombo: this.maxCombo,
      countriesCleared: this.countriesCleared,
      countriesSkipped: this.countriesSkipped,
      totalKeystrokes: this.totalKeystrokes,
      correctKeystrokes: this.correctKeystrokes,
      elapsedMs,
      practice: this.practice,
      viaCheckpoint: this.viaCheckpointUsed,
      checkpointResumeAvailable:
        this.phase === 'finished' &&
        this.deps.rules.id === 'worldtour' &&
        !this.resumeUsed &&
        this.result?.outcome === 'gameover',
      countdownEndsAt: this.countdownEndsAt,
      result: this.result,
    };
  }

  /**
   * docs/06 §3.2 RunSubmission 조립(리플레이 로그 + 확정 국가 기록). token은 세션 계층이 주입한다.
   * 엔진은 오리진/네트워크를 모르므로 token 기본값은 빈 문자열이다.
   */
  buildSubmission(token = ''): RunSubmission {
    const perCountry: SubmissionCountry[] = this.committed.map((p) => ({
      code: p.code,
      ms: p.ms,
      keystrokes: p.keystrokes,
      errors: p.errors,
      skipped: p.skipped,
      inputUsed: p.inputUsed,
    }));
    return this.runLog.toSubmissionPayload(perCountry, token);
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now();
  }

  private enterCountdown(ms: number): void {
    this.setPhase('countdown');
    this.countdownEndsAt = this.now() + ms;
    this.cancelCountdown = this.deps.schedule(() => this.beginPlaying(), ms);
  }

  private beginPlaying(): void {
    this.cancelCountdown = null;
    this.playingStartedAt = this.now();
    this.setPhase('playing');
    this.state.lives = this.deps.rules.lives;
    if (this.state.lives !== null) this.emit({ type: 'lifeChanged', lives: this.state.lives });
    this.scheduleStatsTick();
    if (this.deps.rules.hardCapMs !== null) {
      this.cancelHardCap = this.deps.schedule(() => {
        this.cancelHardCap = null;
        this.finishRun('gameover');
      }, this.deps.rules.hardCapMs);
    }
    this.showCountry(0);
  }

  private showCountry(index: number): void {
    this.currentIndex = index;
    const c = this.countries[index]!;
    this.countryShownAt = this.now();
    this.cAdded = 0;
    this.cCorrect = 0;
    this.cErrors = 0;
    const limit = this.deps.rules.timeLimitMs(c, index);
    this.emit({ type: 'countryShown', index, id: c.id, timeLimitMs: limit });
    if (limit !== null) {
      this.cancelCountryTimeout = this.deps.schedule(() => {
        this.cancelCountryTimeout = null;
        this.commitSkip(); // 타임아웃 = 자동 스킵(GDD §7.1)
      }, limit);
    }
  }

  private accumulate(delta: KeystrokeDelta): void {
    this.cAdded += delta.added;
    this.cCorrect += delta.addedCorrect;
    this.cErrors += delta.addedError;
  }

  private commitExact(): void {
    const index = this.currentIndex;
    const country = this.countries[index]!;
    const ms = this.now() - this.countryShownAt;
    this.cancelCountryTimer();

    // 콤보: 해당 국가 오타 0일 때만 +1, 오타가 하나라도 있으면 확정 시점에 0(GDD §6.1).
    this.setCombo(this.cErrors > 0 ? 0 : this.combo + 1);

    this.totalKeystrokes += this.cAdded;
    this.correctKeystrokes += this.cCorrect;
    this.committed.push({
      code: country.id,
      ms,
      errors: this.cErrors,
      skipped: false,
      keystrokes: this.cAdded,
      correct: this.cCorrect,
      inputUsed: this.pendingExactDisplay,
    });
    this.countriesCleared++;
    this.lastCommitAt = this.now();

    this.emit({
      type: 'countryCommitted',
      index,
      id: country.id,
      ms,
      errors: this.cErrors,
      skipped: false,
      combo: this.combo,
    });
    this.afterCommit(index);
  }

  private commitSkip(): void {
    const index = this.currentIndex;
    const country = this.countries[index]!;
    const ms = this.now() - this.countryShownAt;
    this.cancelCountryTimer();

    // GDD §5.5 공통 스킵 페널티: 콤보 0 · 필요 타수 전량 오타 계상 · 국가 점수 0(skipped).
    const L = requiredKeystrokes(country, this.lang);
    this.setCombo(0);
    this.totalKeystrokes += L; // 전량 오타(correctKeystrokes 미가산 → ACC 하락)
    this.committed.push({
      code: country.id,
      ms,
      errors: L,
      skipped: true,
      keystrokes: L,
      correct: 0,
      inputUsed: '',
    });
    this.countriesSkipped++;
    this.lastCommitAt = this.now();

    // 모드별 라이프 정책(서바이벌/세계일주 −1, 대륙/레이스 no-op).
    const before = this.state.lives;
    this.deps.rules.onSkip(this.state);
    if (this.state.lives !== null && this.state.lives !== before) {
      this.emit({ type: 'lifeChanged', lives: this.state.lives });
    }

    this.emit({
      type: 'countryCommitted',
      index,
      id: country.id,
      ms,
      errors: L,
      skipped: true,
      combo: this.combo,
    });

    // 라이프 0 → 게임오버(부분 점수). 라이프 없는 모드는 통과.
    if (this.state.lives !== null && this.state.lives <= 0) {
      this.finishRun('gameover');
      return;
    }
    this.afterCommit(index);
  }

  private afterCommit(index: number): void {
    const committedCount = this.committed.length;
    const cps = this.deps.rules.checkpoints;
    if (cps) {
      const leg = cps.indexOf(committedCount);
      if (leg >= 0) {
        this.emit({
          type: 'checkpoint',
          legIndex: leg,
          splitMs: this.now() - this.playingStartedAt,
        });
      }
    }
    const next = index + 1;
    if (next >= this.countries.length) {
      this.finishRun('completed');
    } else {
      this.showCountry(next);
    }
  }

  private degrade(reason: 'bulk' | 'blur' | 'devtools'): void {
    if (this.practice) return; // 강등은 단방향 — 최초 1회만 이벤트
    this.practice = true;
    this.emit({ type: 'degradedToPractice', reason });
  }

  private setCombo(v: number): void {
    if (v === this.combo) return;
    this.combo = v;
    if (v > this.maxCombo) this.maxCombo = v;
    this.emit({ type: 'comboChanged', combo: v });
  }

  private scheduleStatsTick(): void {
    this.cancelStatsTick = this.deps.schedule(() => {
      this.cancelStatsTick = null;
      if (this.phase !== 'playing') return;
      this.emitStatsTick();
      this.scheduleStatsTick();
    }, STATS_TICK_MS);
  }

  private emitStatsTick(): void {
    const elapsedMs = this.now() - this.playingStartedAt;
    // 미확정 버퍼를 얹어 실시간 표시(확정 원장은 오염하지 않음).
    const liveCorrect = this.correctKeystrokes + this.cCorrect;
    const liveTotal = this.totalKeystrokes + this.cAdded;
    const cpm = elapsedMs > 0 ? Math.floor((liveCorrect * 60000) / elapsedMs) : 0;
    const acc = liveTotal > 0 ? liveCorrect / liveTotal : 0;
    this.emit({ type: 'statsTick', cpm, acc, elapsedMs });
  }

  private finishRun(outcome: 'completed' | 'gameover'): void {
    this.cancelAllTimers();
    const elapsedMs =
      this.lastCommitAt > this.playingStartedAt
        ? this.lastCommitAt - this.playingStartedAt
        : this.now() - this.playingStartedAt;
    const stats: RunStats = {
      totalKeystrokes: this.totalKeystrokes,
      correctKeystrokes: this.correctKeystrokes,
      elapsedMs,
      maxCombo: this.maxCombo,
      countriesCleared: this.countriesCleared,
      countriesSkipped: this.countriesSkipped,
      perCountry: this.committed.map((p) => ({
        code: p.code,
        ms: p.ms,
        errors: p.errors,
        skipped: p.skipped,
      })),
    };
    const score = computeScore(stats, this.countries, this.lang);
    const result: RunResult = {
      mode: this.deps.rules.id,
      lang: this.lang,
      outcome,
      practice: this.practice,
      viaCheckpoint: this.viaCheckpointUsed,
      stats,
      score,
    };
    this.result = result;
    this.setPhase('finished');
    this.emit({ type: 'finished', result });
  }

  private recomputeTotals(): void {
    let tk = 0;
    let ck = 0;
    for (const p of this.committed) {
      tk += p.keystrokes;
      ck += p.correct;
    }
    this.totalKeystrokes = tk;
    this.correctKeystrokes = ck;
  }

  private setPhase(phase: SessionPhase): void {
    this.phase = phase;
    this.emit({ type: 'phase', phase });
  }

  private cancelCountryTimer(): void {
    if (this.cancelCountryTimeout) {
      this.cancelCountryTimeout();
      this.cancelCountryTimeout = null;
    }
  }

  private cancelAllTimers(): void {
    this.cancelCountryTimer();
    if (this.cancelStatsTick) {
      this.cancelStatsTick();
      this.cancelStatsTick = null;
    }
    if (this.cancelHardCap) {
      this.cancelHardCap();
      this.cancelHardCap = null;
    }
    if (this.cancelCountdown) {
      this.cancelCountdown();
      this.cancelCountdown = null;
    }
  }

  private resetRunState(): void {
    this.cancelAllTimers();
    this.currentIndex = -1;
    this.state.lives = null;
    this.combo = 0;
    this.maxCombo = 0;
    this.countriesCleared = 0;
    this.countriesSkipped = 0;
    this.totalKeystrokes = 0;
    this.correctKeystrokes = 0;
    this.cAdded = 0;
    this.cCorrect = 0;
    this.cErrors = 0;
    this.committed = [];
    this.pendingExactDisplay = '';
    this.practice = false;
    this.viaCheckpointUsed = false;
    this.resumeUsed = false;
    this.playingStartedAt = 0;
    this.countryShownAt = 0;
    this.lastCommitAt = 0;
    this.countdownEndsAt = null;
    this.result = null;
    this.runLog.reset();
  }

  private emit(e: EngineEvent): void {
    for (const f of this.listeners) f(e);
  }
}
