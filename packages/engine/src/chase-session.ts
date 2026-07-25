// spec: docs/09 §6.2(ChaseSessionEngine 시그니처·ChaseEngineEvent 유니온 — 임의 확장 금지)·§6.1(모듈 배치)·
//       §2(코어 루프)·§3.2(선택지 3-타깃 판정)·§3.7(종료), docs/00 §11-D97(멀티 타깃 = 후보별 병렬
//       matchInput)·D95(스킵·pause 부재·자수)·D96(히트스톱은 표시 계층 CH-07 소관)·D91(런 로컬 클록·
//       순수 심), docs/03 §2(입력 계층 — 무수정)·§4.5(고빈도 규약)·§5(FSM·EngineEvent·practice 강등),
//       CLAUDE.md Gotcha 1·3, WT-CH-04.
//
// "골드 러너"(chase) 세션 오케스트레이션. 기존 GameSessionEngine은 고정 국가 배열 전제라 그대로 못 쓰고,
// **입력 계층(TypingInputController·KeystrokeAccountant)과 EngineEvent 계약만 재사용**하고 세션 구동만
// 신설한다(docs/09 §6.2). Date.now/performance.now 직접 호출 금지 — deps.now()/deps.schedule() 주입만
// 사용해 가상 시계 테스트가 가능하다.
//
// [설계 결정 — 3-타깃 판정(D97)]
//  handleInput은 입력 계층(TypingInputController)이 방출한 TypingEvent를 소비한다. 컨트롤러는 chase에서
//  **3후보의 acceptedInputs를 합친 타깃 집합**으로 구성된다(호스트/CH-06가 합성 Country를 setCountry —
//  컨트롤러 무수정, IME EXACT 플러시·타수 계상이 그대로 성립). 따라서 컨트롤러의 EXACT는 "3후보 중
//  하나에 완전 일치"의 권위 신호다. 홉 대상 후보의 식별은 그 스냅샷(EXACT 확정 입력)을 **3후보 각각에
//  기존 matchInput으로 병렬 평가**(D97 — matchInput 무수정 재사용, 멀티 타깃 재구현 금지)해 EXACT인
//  후보를 고르는 것으로 한다. 어느 후보도 EXACT가 아니면(호스트 타깃 동기 이탈) bestTarget.key로 소유
//  후보를 방어적으로 역탐색하고, 그래도 없으면 홉을 발생시키지 않는다(회귀 0). 후보별 입력 에코(콜아웃
//  칩 PARTIAL 표시)는 표시 계층(CH-06 prompt-renderer 경로) 소관이며 이 엔진은 방출하지 않는다(§4.5
//  명령형 DOM). p95<16ms(§11)는 CH-10 e2e — 여기서는 3× matchInput이 마이크로초임을 단위 성능 테스트로
//  확인한다.
//
// [설계 결정 — 심 구동·점수]
//  심(simulateChase/advanceChase, @wt/shared)은 완전 결정적 순수 함수다(Gotcha 3 판정·점수 패리티의
//  경찰 심 확장 — D91). 엔진은 홉 확정마다 moveLog에 append하고 advanceChase로 그 시각까지 증분 전진,
//  홉이 없는 구간은 deps.schedule로 "다음 심 이벤트 시각" **하나만** 예약(setInterval 금지·누수 금지)
//  해 저빈도 이벤트(policeUpdated·wantedChanged·gold·delivered·arrested)를 방출한다. 종료는 체포
//  (심 arrested 이벤트) 또는 자수(resign, D95). 최종 점수(computeChaseScore)는 shared/서버·결과 화면이
//  종료 시 finalState로 재계산한다(제출은 moveLog+RunLog가 원천 — 서버가 verifyMoveLog+재시뮬로 검증,
//  §4.4). 엔진이 점수를 계산·복제하지 않는다.
import {
  matchInput,
  compileTargets,
  simulateChase,
  advanceChase,
  type Country,
  type CountryId,
  type CompiledTarget,
  type DifficultyTier,
  type ChaseConstants,
  type ChaseGraph,
  type ChaseWorld,
  type ChaseState,
  type ChaseEvent,
  type MoveLogEntry,
  type PoliceKind,
  type GoldRing,
} from '@wt/shared';
import type { KeystrokeDelta } from './accountant';
import type { TypingEvent } from './input-controller';
import { RunLog, type SubmissionCountry } from './replay';
import { COUNTDOWN_MS, STATS_TICK_MS, type EngineDeps, type EngineEvent, type SessionPhase } from './session';

export type { PoliceKind, GoldRing } from '@wt/shared';

/** 선택지 콜아웃 칩 1개의 저빈도 뷰(§6.2 candidatesShown). danger = 해당 시점 경찰 점유(§3.4 후속 진입). */
export interface CandidateView {
  id: CountryId;
  danger: boolean;
}

/** 경찰 유닛 표시 뷰(§6.2 policeUpdated). 심 PoliceUnit에서 표시 파생만(id·종류·현재국) — 타이머
 *  필드(nextTickMs·spawnedAtMs)는 표시에 불필요해 제외. CH-05 globe-chase.ts의 로컬 PoliceView와
 *  필드 동일(id·kind·at) — CH-06 배선 시 이 canonical 정의로 수렴한다. */
export interface PoliceView {
  id: number;
  kind: PoliceKind;
  at: CountryId;
}

/**
 * docs/09 §6.2 ChaseEngineEvent — 기존 EngineEvent(phase/statsTick/comboChanged/finished/
 * degradedToPractice…)를 전부 승계하고 chase 고유 저빈도 이벤트를 더한다. **이 유니온은 §6.2 전문이며
 * 임의 확장 금지.** goldSpawned/goldPicked는 §6.2의 `'goldSpawned'|'goldPicked'` 합성 변형을 판별
 * 유니온으로 분리한 것(의미 동일, 확장 아님).
 */
export type ChaseEngineEvent =
  | EngineEvent
  | { type: 'candidatesShown'; hopIndex: number; candidates: CandidateView[] }
  | { type: 'hopCommitted'; hopIndex: number; from: CountryId; to: CountryId; ms: number; errors: number }
  | { type: 'wantedChanged'; stars: number; direction: 'up' | 'down' }
  | { type: 'policeUpdated'; units: PoliceView[]; movedUnitId: number | null }
  | { type: 'candidateDangerChanged'; countryId: CountryId; danger: boolean }
  | { type: 'goldSpawned'; at: CountryId; ring: GoldRing }
  | { type: 'goldPicked'; at: CountryId; ring: GoldRing }
  | { type: 'delivered'; count: number; payout: number; starsAfter: number }
  | { type: 'arrested'; by: PoliceKind; at: CountryId; finalState: ChaseState };

/** chase 종료 사유(docs/09 §3.7·D95). abort(이탈)은 phase='aborted'로 별도 처리(제출 불가). */
export type ChaseOutcome = 'arrested' | 'resigned';

/** ChaseSessionEngine 생성 의존성. EngineDeps에서 now/schedule을 재사용하고(rules는 chase 전용이라
 *  내부에서 chaseRules()로 생성 — deps에 요구하지 않는다) chase 전용 파라미터를 더한다(docs/09 §6.2). */
export interface ChaseEngineDeps extends Omit<EngineDeps, 'rules'> {
  /** 서버 발급 시드(§9.1). 홈·선택지·금·경찰 RNG의 단일 원천. */
  seed: number;
  graph: ChaseGraph;
  /** 판정 타깃 컴파일 + 티어(선택지 버킷·금 고티어 가중) 원천. graph.ids ⊆ 이 집합이어야 한다. */
  countries: readonly Country[];
  /** §3 전 수치(KV config:chase 병합 후 — 병합·검증은 상위 계층). */
  constants: ChaseConstants;
}

/** getSnapshot() 반환 — moveLog·통계·종료 상태의 읽기 전용 스냅샷(제출 페이로드 원천은 buildSubmission). */
export interface ChaseSnapshot {
  phase: SessionPhase;
  mode: 'chase';
  lang: 'ko' | 'en';
  home: CountryId | null;
  player: CountryId | null;
  stars: number;
  carriedCount: number;
  /** 확정 홉 수(= moveLog.length). */
  hopsCommitted: number;
  candidates: CandidateView[];
  combo: number;
  maxCombo: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  elapsedMs: number;
  practice: boolean;
  outcome: ChaseOutcome | null;
  endedAtMs: number | null;
  countdownEndsAt: number | null;
  /** 종료(finished) 시점 심 스냅샷 — 결과 화면·점수 재계산(computeChaseScore) 원천. 그 외 null. */
  finalState: ChaseState | null;
}

/**
 * chase 제출 페이로드 원천(WT-CH-09가 최종 포맷 확정). 서버는 seed+moveLog로 verifyMoveLog + simulateChase
 * 재실행해 체포 시각·점수·배송 이력을 재계산 검증하고(§4.4), perHop 타이핑 시간으로 물리적 하한을
 * 교차 검증한다(기존 CPM 상한 정책 재사용). perHop/inputDigest는 기존 RunLog 조립을 그대로 재사용한다.
 */
export interface ChaseRunSubmission {
  token: string;
  seed: number;
  moveLog: MoveLogEntry[];
  endedAtMs: number;
  outcome: ChaseOutcome;
  practice: boolean;
  /** 홉별 기록(code = 도착국). RunLog.toSubmissionPayload 재사용 — 재구현 아님. */
  perHop: SubmissionCountry[];
  inputDigest: string;
}

interface CommittedHop {
  code: CountryId;
  ms: number;
  errors: number;
  keystrokes: number;
  correct: number;
  inputUsed: string;
}

interface CandidateTarget {
  id: CountryId;
  targets: CompiledTarget[];
}

export class ChaseSessionEngine {
  private phase: SessionPhase = 'idle';
  private readonly listeners = new Set<(e: ChaseEngineEvent) => void>();
  private readonly runLog = new RunLog();

  private readonly world: ChaseWorld;
  private readonly countryById = new Map<CountryId, Country>();

  // 심 상태(런 로컬 클록 기준). null = 미시작.
  private simState: ChaseState | null = null;
  private moveLog: MoveLogEntry[] = [];
  /** simState.events 중 이미 ChaseEngineEvent로 번역·방출한 개수. */
  private emittedEvents = 0;

  // 현재 노출 후보(3개) — 판정 타깃 + danger.
  private candidateIds: CountryId[] = [];
  private candidateTargets: CandidateTarget[] = [];
  private candidateDanger = new Map<CountryId, boolean>();

  // 런 통계(GameSessionEngine과 동일 규약).
  private combo = 0;
  private maxCombo = 0;
  private totalKeystrokes = 0;
  private correctKeystrokes = 0;
  // 현재 홉 미확정 누적(확정 시 총계 반영).
  private cAdded = 0;
  private cCorrect = 0;
  private cErrors = 0;
  private committed: CommittedHop[] = [];
  private practice = false;
  private outcome: ChaseOutcome | null = null;
  private endedAtMs: number | null = null;

  // 시각(전부 deps.now() 기준, 런 로컬 = now - playingStartedAt).
  private playingStartedAt = 0;
  private hopShownAtMs = 0; // 현재 후보가 노출된 런 로컬 시각(홉 타이핑 시간 기준점).
  private countdownEndsAt: number | null = null;

  // 타이머 취소 핸들 — 심 웨이크는 항상 "하나만"(단일 예약, setInterval 금지).
  private cancelCountdown: (() => void) | null = null;
  private cancelStatsTick: (() => void) | null = null;
  private cancelSimWake: (() => void) | null = null;

  constructor(
    private readonly deps: ChaseEngineDeps,
    private readonly lang: 'ko' | 'en',
  ) {
    if (deps.graph.ids.length === 0) {
      throw new Error('ChaseSessionEngine: graph.ids must not be empty (chase-graph 미주입 — 계약 위반)');
    }
    const tiers: Record<CountryId, DifficultyTier> = {};
    for (const c of deps.countries) {
      this.countryById.set(c.id, c);
      tiers[c.id] = c.difficultyTier;
    }
    this.world = { graph: deps.graph, tiers };
    // rules/chase.ts(chaseRules)는 기존 5종 레지스트리·결과 화면 모드 분기와의 타입 호환용 얇은
    // ModeRules 어댑터로, createModeRules('chase') 경로가 소비한다(§6.2). 이 엔진은 timeLimit/onSkip/
    // lives가 무의미한 무한 생존형(D95)이라 그 어댑터를 직접 참조하지 않고 세션을 직접 오케스트레이션한다.
  }

  // ── 공개 API ────────────────────────────────────────────────────────────

  /** 카운트다운 후 playing 시작. idle/finished/aborted에서만 유효(재시작 겸용). */
  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'finished' && this.phase !== 'aborted') return;
    this.resetRunState();
    this.setPhase('countdown');
    this.countdownEndsAt = this.now() + COUNTDOWN_MS;
    this.cancelCountdown = this.deps.schedule(() => {
      this.cancelCountdown = null;
      this.beginPlaying();
    }, COUNTDOWN_MS);
  }

  /** 이탈(제출 불가). playing/countdown에서만. 기존 abort 의미 유지(docs/09 §3.7). */
  abort(): void {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    this.cancelAllTimers();
    this.setPhase('aborted');
  }

  /**
   * 자수(D95) — 미체포 상태로 endMs 시점 확정 종료(제출 가능). 심을 현재 시각까지 전진시켜 그 사이 체포가
   * 성립하면 체포로 처리하고, 아니면 outcome='resigned'로 정상 종료한다. 모달 중에도 심은 정지하지 않는
   * 다는 규약(D95)은 상위 UI 소관이며, 엔진은 resign 호출 시점의 런 로컬 시각을 종료 시각으로 확정한다.
   */
  resign(): void {
    if (this.phase !== 'playing') return;
    const endMs = this.runLocal();
    this.advanceSimTo(endMs);
    if (this.simState && this.simState.arrestedAtMs !== null) {
      this.finishArrested();
      return;
    }
    this.outcome = 'resigned';
    this.endedAtMs = endMs;
    this.cancelAllTimers();
    this.setPhase('finished');
  }

  /** TypingInputController.subscribe를 그대로 연결한다. playing 이외 phase의 이벤트는 무시. */
  handleInput(e: TypingEvent): void {
    if (this.phase !== 'playing') return;
    const added =
      e.type === 'progress' || e.type === 'miss' || e.type === 'exact' ? e.delta.added : 0;
    this.runLog.append(e, this.runLocal(), added);

    switch (e.type) {
      case 'progress':
        this.accumulate(e.delta);
        break;
      case 'miss':
        // 콤보는 여기서 리셋하지 않는다 — 홉 확정 시점에 오타 유무로 결정(GDD §6.1).
        this.accumulate(e.delta);
        break;
      case 'exact':
        this.accumulate(e.delta);
        this.commitExactHop(e.detail.bestTarget);
        break;
      case 'skipRequested':
        // D95: chase에 스킵 없음(선택지 3장이 구조적 대체). no-op.
        break;
      case 'bulkInsert':
        this.degrade('bulk');
        break;
      case 'blurred':
        this.degrade('blur');
        break;
      case 'latinInKoMode':
      case 'refocused':
        break; // UI 계층 소관 — 엔진 상태 무관
    }
  }

  subscribe(f: (e: ChaseEngineEvent) => void): () => void {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }

  getSnapshot(): Readonly<ChaseSnapshot> {
    const s = this.simState;
    const elapsedMs =
      this.phase === 'playing' ? this.runLocal() : (this.endedAtMs ?? 0);
    return {
      phase: this.phase,
      mode: 'chase',
      lang: this.lang,
      home: s?.home ?? null,
      player: s?.player ?? null,
      stars: s?.stars ?? 0,
      carriedCount: s?.carried.length ?? 0,
      hopsCommitted: this.moveLog.length,
      candidates: this.candidateIds.map((id) => ({ id, danger: this.candidateDanger.get(id) ?? false })),
      combo: this.combo,
      maxCombo: this.maxCombo,
      totalKeystrokes: this.totalKeystrokes,
      correctKeystrokes: this.correctKeystrokes,
      elapsedMs,
      practice: this.practice,
      outcome: this.outcome,
      endedAtMs: this.endedAtMs,
      countdownEndsAt: this.countdownEndsAt,
      finalState: this.phase === 'finished' ? s : null,
    };
  }

  /** 현재 노출 중인 후보 Country 3개 — 호스트(CH-06)가 컨트롤러 합성 타깃 구성에 사용. */
  getCandidateCountries(): readonly Country[] {
    return this.candidateIds
      .map((id) => this.countryById.get(id))
      .filter((c): c is Country => c !== undefined);
  }

  /** 홉 확정 로그(제출·검증 원천). */
  getMoveLog(): readonly MoveLogEntry[] {
    return this.moveLog.map((m) => ({ ...m }));
  }

  /**
   * 제출 페이로드 원천(§4.4 서버 검증 입력). token은 제출 계층이 주입한다. RunLog 조립(perHop·inputDigest)은
   * 기존 코드 재사용 — 재구현 아님. 최종 포맷은 WT-CH-09가 확정한다.
   */
  buildSubmission(token = ''): ChaseRunSubmission {
    const perHop: SubmissionCountry[] = this.committed.map((h) => ({
      code: h.code,
      ms: h.ms,
      keystrokes: h.keystrokes,
      errors: h.errors,
      skipped: false,
      inputUsed: h.inputUsed,
    }));
    const assembled = this.runLog.toSubmissionPayload(perHop, token);
    return {
      token,
      seed: this.deps.seed,
      moveLog: this.getMoveLog().map((m) => ({ ...m })),
      endedAtMs: this.endedAtMs ?? this.runLocal(),
      outcome: this.outcome ?? 'resigned',
      practice: this.practice,
      perHop: assembled.perCountry,
      inputDigest: assembled.inputDigest,
    };
  }

  // ── 내부: 시각 ────────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now();
  }

  private runLocal(): number {
    return this.now() - this.playingStartedAt;
  }

  // ── 내부: 라이프사이클 ────────────────────────────────────────────────────

  private beginPlaying(): void {
    this.playingStartedAt = this.now();
    this.hopShownAtMs = 0;
    this.setPhase('playing');
    // t0: 심 초기화(금 activeCount 스폰 + 홉0 선택지). endMs=0이라 어떤 홉/틱도 처리하지 않는다.
    this.simState = simulateChase(
      { seed: this.deps.seed, moveLog: [], endMs: 0, constants: this.deps.constants },
      this.world,
    );
    this.emittedEvents = 0;
    this.candidateIds = [];
    this.afterAdvance(); // 초기 goldSpawned×N + candidatesShown(hop0) 방출 + 후보 동기화
    this.scheduleStatsTick();
    this.scheduleSimWake();
  }

  private commitExactHop(bestTarget: CompiledTarget): void {
    // D97: EXACT 확정 입력(정규화 display)을 3후보 각각에 기존 matchInput으로 병렬 평가.
    const raw = bestTarget.display;
    let idx = this.matchCandidate(raw);
    if (idx < 0) {
      // 컨트롤러 EXACT인데 후보 매칭 실패 = 호스트 타깃 동기 이탈. bestTarget.key로 소유 후보 역탐색.
      idx = this.matchCandidateByKey(bestTarget.key);
    }
    if (idx < 0) return; // 방어적: 매칭 불가 시 홉 미발생(회귀 0)
    this.commitHop(this.candidateIds[idx]!, raw);
  }

  /** D97 3-타깃 병렬 판정: 어느 후보가 EXACT인가(없으면 -1). matchInput 무수정 재사용. */
  private matchCandidate(raw: string): number {
    for (let i = 0; i < this.candidateTargets.length; i++) {
      if (matchInput(raw, this.candidateTargets[i]!.targets, this.lang) === 'EXACT') return i;
    }
    return -1;
  }

  private matchCandidateByKey(key: string): number {
    for (let i = 0; i < this.candidateTargets.length; i++) {
      if (this.candidateTargets[i]!.targets.some((t) => t.key === key)) return i;
    }
    return -1;
  }

  private commitHop(to: CountryId, inputUsed: string): void {
    if (!this.simState) return;
    const hopIndex = this.moveLog.length;
    const tMs = this.runLocal();
    const from = this.simState.player;
    this.moveLog.push({ hopIndex, countryId: to, tMs });

    // 홉 타이핑 시간 = 후보 노출~확정. 콤보·통계는 GameSessionEngine과 동일 규약(오타 0일 때만 +1).
    const ms = tMs - this.hopShownAtMs;
    const errs = this.cErrors;
    this.setCombo(errs > 0 ? 0 : this.combo + 1);
    this.totalKeystrokes += this.cAdded;
    this.correctKeystrokes += this.cCorrect;
    this.committed.push({
      code: to,
      ms,
      errors: errs,
      keystrokes: this.cAdded,
      correct: this.cCorrect,
      inputUsed,
    });
    this.cAdded = 0;
    this.cCorrect = 0;
    this.cErrors = 0;

    // §6.2 순서: 홉 확정 → 심 전진 → candidatesShown. hopCommitted를 먼저 방출한다.
    this.emit({ type: 'hopCommitted', hopIndex, from, to, ms, errors: errs });

    // 심 증분 전진(홉 처리 + 금 획득/배송 + 별 변경 + 경찰 재조정 + 새 선택지 + 경찰 틱 + 체포 판정).
    this.advanceSimTo(tMs);
    this.hopShownAtMs = tMs; // 새 후보가 이 시각에 노출됨(다음 홉 타이핑 기준점)

    if (this.simState.arrestedAtMs !== null) {
      this.finishArrested();
    } else {
      this.scheduleSimWake();
    }
  }

  /** 심을 endMs(런 로컬)까지 전진시키고 신규 이벤트를 방출 + 후보/위험 동기화. */
  private advanceSimTo(endMs: number): void {
    if (!this.simState) return;
    this.simState = advanceChase(
      this.simState,
      { seed: this.deps.seed, moveLog: this.moveLog, endMs, constants: this.deps.constants },
      this.world,
    );
    this.afterAdvance();
  }

  private afterAdvance(): void {
    this.processNewSimEvents();
    this.syncCandidates();
  }

  // ── 내부: 심 이벤트 → ChaseEngineEvent 번역 ──────────────────────────────

  private processNewSimEvents(): void {
    const s = this.simState;
    if (!s) return;
    const evs = s.events;
    for (let i = this.emittedEvents; i < evs.length; i++) {
      this.translateSimEvent(evs[i]!);
    }
    this.emittedEvents = evs.length;
  }

  private translateSimEvent(e: ChaseEvent): void {
    switch (e.type) {
      case 'starChanged':
        this.emit({ type: 'wantedChanged', stars: e.to, direction: e.direction });
        break;
      case 'policeSpawned':
        this.emit({ type: 'policeUpdated', units: this.policeViews(), movedUnitId: null });
        break;
      case 'policeMoved':
        this.emit({ type: 'policeUpdated', units: this.policeViews(), movedUnitId: e.id });
        break;
      case 'policeRemoved':
        this.emit({ type: 'policeUpdated', units: this.policeViews(), movedUnitId: null });
        break;
      case 'goldSpawned':
        this.emit({ type: 'goldSpawned', at: e.at, ring: e.ring });
        break;
      case 'goldPicked':
        this.emit({ type: 'goldPicked', at: e.at, ring: e.ring });
        break;
      case 'delivered':
        this.emit({ type: 'delivered', count: e.count, payout: e.payout, starsAfter: e.starsAfter });
        break;
      case 'arrested':
        this.emit({ type: 'arrested', by: e.by, at: e.at, finalState: this.simState! });
        break;
      case 'candidatesShown':
        this.emit({
          type: 'candidatesShown',
          hopIndex: e.hopIndex,
          candidates: e.candidates.map((id) => ({ id, danger: this.policeOccupies(id) })),
        });
        break;
    }
  }

  private policeViews(): PoliceView[] {
    return this.simState ? this.simState.police.map((p) => ({ id: p.id, kind: p.kind, at: p.at })) : [];
  }

  private policeOccupies(id: CountryId): boolean {
    return this.simState ? this.simState.police.some((p) => p.at === id) : false;
  }

  // ── 내부: 후보 동기화 + 위험(danger) 변화 방출 ────────────────────────────

  private syncCandidates(): void {
    const s = this.simState;
    if (!s) return;
    if (!sameIds(s.candidates, this.candidateIds)) {
      // 새 후보 집합(홉) — 판정 타깃 재컴파일 + danger 맵 재구성. candidatesShown 이벤트가 초기 danger를
      // 이미 실었으므로 candidateDangerChanged는 방출하지 않는다.
      this.candidateIds = [...s.candidates];
      this.candidateTargets = this.candidateIds.map((id) => {
        const c = this.countryById.get(id);
        return { id, targets: c ? compileTargets(c, this.lang) : [] };
      });
      this.candidateDanger = new Map(this.candidateIds.map((id) => [id, this.policeOccupies(id)]));
    } else {
      // 동일 후보(홉 없는 심 전진) — 경찰 진입/이탈로 danger가 바뀐 후보만 방출(§3.4 후속 진입).
      for (const id of this.candidateIds) {
        const d = this.policeOccupies(id);
        if (this.candidateDanger.get(id) !== d) {
          this.candidateDanger.set(id, d);
          this.emit({ type: 'candidateDangerChanged', countryId: id, danger: d });
        }
      }
    }
  }

  // ── 내부: 심 웨이크 스케줄(단일 예약) ────────────────────────────────────

  private scheduleSimWake(): void {
    if (this.cancelSimWake) {
      this.cancelSimWake();
      this.cancelSimWake = null;
    }
    const s = this.simState;
    if (!s || s.arrestedAtMs !== null || this.phase !== 'playing') return;
    const nextT = this.nextSimEventTime();
    if (nextT === null) return; // 예약할 심 이벤트 없음(경찰 0·별 타이머 없음) — 다음 홉까지 대기
    const delay = Math.max(0, nextT - this.runLocal());
    this.cancelSimWake = this.deps.schedule(() => {
      this.cancelSimWake = null;
      if (this.phase !== 'playing' || !this.simState) return;
      this.advanceSimTo(nextT);
      if (this.simState.arrestedAtMs !== null) this.finishArrested();
      else this.scheduleSimWake();
    }, delay);
  }

  /** 다음 심 이벤트 시각(런 로컬) = min(경찰 틱, 별 상승, 도주 감소 판정). 없으면 null. 공개 ChaseState
   *  필드만으로 계산한다 — 심이 endMs까지만 처리하므로 이 값이 부정확해도 심 상태는 항상 정확하다
   *  (경찰 틱이 잦은 웨이크를 보장해 도주 감소도 늦어도 다음 틱에 반영). */
  private nextSimEventTime(): number | null {
    const s = this.simState;
    if (!s) return null;
    let next: number | null = null;
    const consider = (t: number | null): void => {
      if (t === null) return;
      if (next === null || t < next) next = t;
    };
    for (const u of s.police) consider(u.nextTickMs);
    consider(s.nextStarUpMs);
    const te = this.nextEscapeFireTime();
    if (te !== null && te > s.timeMs) consider(te);
    return next;
  }

  /** 심 escapeFireTime의 공개 상태 미러(D93 도주 감소). 심 simulate.ts와 동일 규칙 — 스케줄 promptness용. */
  private nextEscapeFireTime(): number | null {
    const s = this.simState;
    if (!s) return null;
    const er = this.deps.constants.escapeReduction;
    if (!er.enabled) return null;
    if (s.stars <= er.floor) return null;
    if (s.police.length === 0) return null;
    if (s.lastPoliceCloseMs < 0) return null;
    const byWindow = s.lastPoliceCloseMs + er.windowMs;
    const byCooldown = s.lastEscapeMs < 0 ? byWindow : s.lastEscapeMs + er.cooldownMs;
    return Math.max(byWindow, byCooldown);
  }

  // ── 내부: 종료 ────────────────────────────────────────────────────────────

  private finishArrested(): void {
    // arrested ChaseEngineEvent는 advanceSimTo(processNewSimEvents)에서 이미 방출됐다.
    this.outcome = 'arrested';
    this.endedAtMs = this.simState?.arrestedAtMs ?? this.runLocal();
    this.cancelAllTimers();
    this.setPhase('finished');
  }

  // ── 내부: 통계·콤보·강등 ──────────────────────────────────────────────────

  private accumulate(delta: KeystrokeDelta): void {
    this.cAdded += delta.added;
    this.cCorrect += delta.addedCorrect;
    this.cErrors += delta.addedError;
  }

  private setCombo(v: number): void {
    if (v === this.combo) return;
    this.combo = v;
    if (v > this.maxCombo) this.maxCombo = v;
    this.emit({ type: 'comboChanged', combo: v });
  }

  private degrade(reason: 'bulk' | 'blur' | 'devtools'): void {
    if (this.practice) return; // 강등은 단방향 — 최초 1회만
    this.practice = true;
    this.emit({ type: 'degradedToPractice', reason });
  }

  private scheduleStatsTick(): void {
    this.cancelStatsTick = this.deps.schedule(() => {
      this.cancelStatsTick = null;
      if (this.phase !== 'playing') return; // 종료 후 자기종료(재스케줄 안 함)
      this.emitStatsTick();
      this.scheduleStatsTick();
    }, STATS_TICK_MS);
  }

  private emitStatsTick(): void {
    const elapsedMs = this.runLocal();
    const liveCorrect = this.correctKeystrokes + this.cCorrect;
    const liveTotal = this.totalKeystrokes + this.cAdded;
    const cpm = elapsedMs > 0 ? Math.floor((liveCorrect * 60000) / elapsedMs) : 0;
    const acc = liveTotal > 0 ? liveCorrect / liveTotal : 0;
    this.emit({ type: 'statsTick', cpm, acc, elapsedMs });
  }

  // ── 내부: FSM·타이머·리셋 ─────────────────────────────────────────────────

  private setPhase(phase: SessionPhase): void {
    this.phase = phase;
    this.emit({ type: 'phase', phase });
  }

  private cancelAllTimers(): void {
    if (this.cancelSimWake) {
      this.cancelSimWake();
      this.cancelSimWake = null;
    }
    if (this.cancelStatsTick) {
      this.cancelStatsTick();
      this.cancelStatsTick = null;
    }
    if (this.cancelCountdown) {
      this.cancelCountdown();
      this.cancelCountdown = null;
    }
  }

  private resetRunState(): void {
    this.cancelAllTimers();
    this.simState = null;
    this.moveLog = [];
    this.emittedEvents = 0;
    this.candidateIds = [];
    this.candidateTargets = [];
    this.candidateDanger = new Map();
    this.combo = 0;
    this.maxCombo = 0;
    this.totalKeystrokes = 0;
    this.correctKeystrokes = 0;
    this.cAdded = 0;
    this.cCorrect = 0;
    this.cErrors = 0;
    this.committed = [];
    this.practice = false;
    this.outcome = null;
    this.endedAtMs = null;
    this.playingStartedAt = 0;
    this.hopShownAtMs = 0;
    this.countdownEndsAt = null;
    this.runLog.reset();
  }

  private emit(e: ChaseEngineEvent): void {
    for (const f of this.listeners) f(e);
  }
}

/** 두 CountryId 배열이 순서·내용 동일한지. */
function sameIds(a: readonly CountryId[], b: readonly CountryId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
