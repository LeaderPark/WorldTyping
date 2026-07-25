// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(단일 스프라이트 + Web Audio API, <audio> 태그 금지,
//       첫 제스처 unlock), WT-M2-07 구현 세부 지시 3("엔진 이벤트 구독(정타/오타/확정/체크포인트/
//       카운트다운)"), docs/09 §7.2·§7.6·§7.8(chase SFX), docs/00 §11-D96, WT-CH-07.
//
// <audio> 태그를 쓰지 않는다(§8.2). AudioContext는 첫 사용자 제스처에서 1회 생성하고, 스프라이트
// 로딩(fetch+decodeAudioData)은 그 뒤 비동기로 흘러간다 — 둘 중 어느 쪽이 실패해도(미지원 브라우저,
// 네트워크 실패, 디코드 실패) 이후의 모든 play*() 호출은 조용히 아무 일도 하지 않는다(무음 폴백,
// [제약/금지] "사운드 로딩이 첫 입력을 블로킹하지 말 것"). 이 파일은 재생을 절대 throw하지 않는다.
//
// [WT-CH-07] chase 전용 SFX(playChase*)는 별도 스프라이트(chase-sprites.ts/chase-sprite.wav)를
// **지연 로드**한다 — 첫 제스처 unlock()이 트는 기존 sprite.wav fetch와 달리, chase 시트는 첫
// playChase*() 호출 시점에야 fetch를 시작한다(ensureChaseLoaded). 논-chase 플레이어는 이 자산을
// 전혀 받지 않는다(chase-sprites.ts 헤더 주석 "설계 결정" 참조). bindChase()는 기존 bind()와 같은
// 골격(phase/controller 구독)이되 GameSessionEngine 전용 이벤트(countryCommitted/checkpoint/
// finished)가 없는 ChaseEngineEvent에 맞춰 카운트다운 사운드를 §7.2(경보+유리 쨍)로, 확정 스탬프
// 트리거를 hopCommitted(§6.2)로 교체한다 — 정타/오타/확정 스탬프 3종 자체는 기존 play*() 재사용
// (§7.8 "타건/오타/스탬프 기존 3종 세트 그대로" — 재구현 아님).
import type {
  ChaseEngineEvent,
  ChaseSessionEngine,
  EngineEvent,
  GameSessionEngine,
  TypingEvent,
  TypingInputController,
} from '@wt/engine';
import type { KeySound } from '../stores/settings';
import { CHASE_SPRITE_MAP, CHASE_SPRITE_URL, type ChaseSpriteName } from './chase-sprites';
import { SPRITE_MAP, SPRITE_URL, type SpriteName } from './sprites';

export interface SoundVolumeSnapshot {
  master: number;
  sfx: number;
}

export interface SoundSettingsSnapshot {
  keySound: KeySound;
  volume: SoundVolumeSnapshot;
}

/** docs/01 §13.1 "콤보 ×5마다 반음↑, ×20에서 캡" → 20/5 = 4단계가 상한. */
const COMBO_GLOW_STEP = 5;
const COMBO_STEP_CAP = 4;
const SEMITONE_RATIO = Math.pow(2, 1 / 12);
/** §13.1 "정타 피치 미세 랜덤(±3%)으로 기관총 효과 방지". */
const KEY_JITTER = 0.03;

function comboPlaybackRate(combo: number): number {
  const steps = Math.min(Math.floor(Math.max(combo, 0) / COMBO_GLOW_STEP), COMBO_STEP_CAP);
  return Math.pow(SEMITONE_RATIO, steps);
}

function jitterRate(): number {
  return 1 + (Math.random() * 2 - 1) * KEY_JITTER;
}

type MinimalAudioContext = Pick<
  AudioContext,
  'state' | 'currentTime' | 'destination' | 'decodeAudioData' | 'createBufferSource' | 'createGain' | 'resume'
>;

function resolveAudioContextCtor(): (new () => MinimalAudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: new () => MinimalAudioContext;
    webkitAudioContext?: new () => MinimalAudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Web Audio 단일 스프라이트 재생기. 인스턴스 1개가 앱 전체에서 공유된다(getSoundManager).
 * 실패 경로(미지원/네트워크/디코드)는 전부 무음으로 수렴하고 절대 throw하지 않는다.
 */
export class SoundManager {
  private ctx: MinimalAudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private unlockStarted = false;
  private silent = false;
  // ── WT-CH-07: chase 전용 2번째 시트(지연 로드 — 헤더 주석 참조) ──
  private chaseBuffer: AudioBuffer | null = null;
  private chaseLoadStarted = false;
  private chaseSilent = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly gestureTypes: Array<'pointerdown' | 'keydown' | 'touchstart'> = [
    'pointerdown',
    'keydown',
    'touchstart',
  ];
  private readonly onGesture = (): void => this.unlock();

  constructor(private readonly getSettings: () => SoundSettingsSnapshot) {
    if (typeof window !== 'undefined') {
      for (const type of this.gestureTypes) {
        window.addEventListener(type, this.onGesture, { once: true, passive: true });
      }
    }
  }

  /** 첫 사용자 제스처(또는 테스트에서 수동 호출)에서 1회만 동작. 실패해도 무음 폴백일 뿐. */
  unlock(): void {
    if (this.unlockStarted) return;
    this.unlockStarted = true;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) {
      this.silent = true;
      return;
    }
    try {
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {
          /* 재개 실패는 재생 시점에 또 실패할 뿐 — 여기서 흡수. */
        });
      }
    } catch {
      this.silent = true;
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.ctx) return;
    try {
      const res = await fetch(SPRITE_URL);
      if (!res.ok) throw new Error(`sprite sheet fetch failed: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      // 네트워크/디코드 실패 — 입력을 블로킹하지 않는다(무음 폴백).
      this.silent = true;
      this.buffer = null;
    }
  }

  private play(name: SpriteName, rateMultiplier = 1): void {
    if (this.silent || !this.ctx || !this.buffer) return;
    const region = SPRITE_MAP[name];
    const settings = this.getSettings();
    const gainValue = settings.volume.master * settings.volume.sfx;
    if (!(gainValue > 0)) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = rateMultiplier;
      const gain = this.ctx.createGain();
      gain.gain.value = Math.min(1, gainValue);
      src.connect(gain).connect(this.ctx.destination);
      src.start(this.ctx.currentTime, region.offset, region.duration);
    } catch {
      // 재생 실패는 게임플레이를 막지 않는다(제약사항).
    }
  }

  /** chase 시트 지연 로드 — 멱등(load()와 동일 가드 패턴, unlockStarted/silent와 별개 플래그). ctx가
   *  아직 없으면(첫 제스처 전) 아무 것도 하지 않는다 — playChase()가 매 호출마다 재시도하게 둔다
   *  (제스처는 언제든 올 수 있고, 실패 캐시(chaseSilent)는 fetch/decode 실패에만 선다). */
  private ensureChaseLoaded(): void {
    if (this.chaseLoadStarted || !this.ctx) return;
    this.chaseLoadStarted = true;
    void this.loadChase();
  }

  private async loadChase(): Promise<void> {
    if (!this.ctx) return;
    try {
      const res = await fetch(CHASE_SPRITE_URL);
      if (!res.ok) throw new Error(`chase sprite sheet fetch failed: ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      this.chaseBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      this.chaseSilent = true;
      this.chaseBuffer = null;
    }
  }

  /** play()와 동일 구조 — chase 시트만 별도 버퍼/오프셋 테이블 참조(§7.8). ctx 없으면(제스처 전)
   *  무음(기존 play()와 동일 철학) — chase는 카운트다운 진입 시점 이후에나 호출되므로 실전에서는
   *  이미 unlock된 뒤다. */
  private playChase(name: ChaseSpriteName, rateMultiplier = 1): void {
    if (!this.ctx) return;
    if (!this.chaseLoadStarted) this.ensureChaseLoaded();
    if (this.chaseSilent || !this.chaseBuffer) return;
    const region = CHASE_SPRITE_MAP[name];
    const settings = this.getSettings();
    const gainValue = settings.volume.master * settings.volume.sfx;
    if (!(gainValue > 0)) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.chaseBuffer;
      src.playbackRate.value = rateMultiplier;
      const gain = this.ctx.createGain();
      gain.gain.value = Math.min(1, gainValue);
      src.connect(gain).connect(this.ctx.destination);
      src.start(this.ctx.currentTime, region.offset, region.duration);
    } catch {
      // 재생 실패는 게임플레이를 막지 않는다(제약사항).
    }
  }

  /** 키 입력 정타(docs/01 §13.1 "키보드 타건음 3종 세트"). keySound==='off'면 무음. */
  playKeyCorrect(): void {
    const { keySound } = this.getSettings();
    if (keySound === 'off') return;
    this.play(keySound === 'mech' ? 'keyMech' : 'keyMembrane', jitterRate());
  }

  /** 오타 — "낮은 톡"(§13.1, 처벌감 최소화 톤). */
  playMiss(): void {
    this.play('miss');
  }

  /** 국가 확정 스탬프 + 콤보 단계별 피치 상승(§13.1). */
  playConfirm(combo: number): void {
    this.play('confirm', comboPlaybackRate(combo));
  }

  /** 체크포인트/완주 공통 차임(§13.1 — 표에서 한 행으로 묶여 있다). */
  playCheckpoint(): void {
    this.play('checkpoint');
  }

  /** 카운트다운: 3·2·1은 개찰구 비프, 0(플레이 진입)은 출발음(§13.1 "개찰구 비프 3연 + 출발음"). */
  playCountdown(n: 3 | 2 | 1 | 0): void {
    this.play(n === 0 ? 'countdownStart' : 'countdownBeep');
  }

  // ── WT-CH-07: chase 전용 SFX(§7.8 총괄표) — 전부 playChase() 프라이빗 헬퍼 경유,
  //    실패/무음/설정 3단 존중은 기존 play()와 동일 경로(중복 구현 아님). ──

  /** §7.2 카운트다운 "은행 경보" 1타 — bindChase가 3·2·1 각 틱마다 호출(기존 bind()의
   *  playCountdown(3|2|1) 자리를 대신한다). */
  playChaseAlarmBeep(): void {
    this.playChase('chaseAlarmBeep');
  }

  /** §7.2 "유리 쨍" — bindChase가 phase==='playing' 진입 시 1회(기존 playCountdown(0) 자리). */
  playChaseGlassShatter(): void {
    this.playChase('chaseGlassShatter');
  }

  /** §7.4·§7.8 수배 상승 — 사이렌 도플러 0.6s. */
  playChaseSirenDoppler(): void {
    this.playChase('chaseSirenDoppler');
  }

  /** §7.4·§7.8 무전 치직 — 수배 상승(도플러와 병행)·하강(단독) 공용. */
  playChaseRadioStatic(): void {
    this.playChase('chaseRadioStatic');
  }

  /** §7.6 금 획득 — "2연, 피치 +3% 랜덤"(§7.8). 정타 지터(jitterRate)와 동일 관례 재사용. */
  playChaseGoldCoin(): void {
    this.playChase('chaseGoldCoin', jitterRate());
    setTimeout(() => this.playChase('chaseGoldCoin', jitterRate()), 90);
  }

  /** §7.6 배송 0ms — 금고 철컹. */
  playChaseVaultClunk(): void {
    this.playChase('chaseVaultClunk');
  }

  /** §7.6 배송 1,300ms — 케이퍼 팡파레(완주 차임의 케이퍼 편곡, 0.6s). */
  playChaseCaperFanfare(): void {
    this.playChase('chaseCaperFanfare');
  }

  /** §7.6 체포 520ms — 수갑 철컥. */
  playChaseHandcuffs(): void {
    this.playChase('chaseHandcuffs');
  }

  /**
   * §7.5 위협 앰비언스 하트비트 루프(bpm 가변, "이 모드의 BGM"). 재호출 시 이전 루프를 먼저
   * 정지(간격 변경 시 재시작) — setInterval 1개만 살아있는 것을 항상 보장한다(누수 금지).
   */
  startChaseHeartbeat(bpm: number): void {
    this.stopChaseHeartbeat();
    const intervalMs = 60_000 / Math.max(1, bpm);
    this.playChase('chaseHeartbeat');
    this.heartbeatTimer = setInterval(() => this.playChase('chaseHeartbeat'), intervalMs);
  }

  /** 하트비트 정지(위협 해제/세션 종료/언마운트) — 반드시 짝 호출해 setInterval 누수를 막는다. */
  stopChaseHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 엔진/컨트롤러 이벤트 → 사운드(구현 세부 지시 3의 5개 이벤트만: 정타/오타/확정/체크포인트/
   * 카운트다운). 반환된 함수로 해제한다.
   */
  bind(engine: GameSessionEngine, controller: TypingInputController): () => void {
    let countdownTick1: ReturnType<typeof setTimeout> | null = null;
    let countdownTick2: ReturnType<typeof setTimeout> | null = null;
    const clearCountdown = (): void => {
      if (countdownTick1) clearTimeout(countdownTick1);
      if (countdownTick2) clearTimeout(countdownTick2);
      countdownTick1 = null;
      countdownTick2 = null;
    };

    const unsubEngine = engine.subscribe((e: EngineEvent) => {
      switch (e.type) {
        case 'phase':
          clearCountdown();
          if (e.phase === 'countdown') {
            this.playCountdown(3);
            countdownTick1 = setTimeout(() => this.playCountdown(2), 1000);
            countdownTick2 = setTimeout(() => this.playCountdown(1), 2000);
          } else if (e.phase === 'playing') {
            this.playCountdown(0);
          }
          break;
        case 'countryCommitted':
          if (!e.skipped) this.playConfirm(e.combo);
          break;
        case 'checkpoint':
          this.playCheckpoint();
          break;
        case 'finished':
          this.playCheckpoint();
          break;
        default:
          break;
      }
    });

    const unsubController = controller.subscribe((e: TypingEvent) => {
      switch (e.type) {
        case 'progress':
          // added===0(순수 백스페이스)은 "입력"이 아니라 소리 없음(§13.1은 "키 입력" 기준).
          if (e.delta.added > 0) this.playKeyCorrect();
          break;
        case 'miss':
          this.playMiss();
          break;
        default:
          break;
      }
    });

    return () => {
      clearCountdown();
      unsubEngine();
      unsubController();
    };
  }

  /**
   * chase 전용 배선(WT-CH-07) — bind()와 동일 골격이되 ChaseEngineEvent에 맞춘 3가지 차이만 있다:
   * ① 카운트다운은 §7.2(경보 3연+유리 쨍)로 교체 ② 확정 스탬프 트리거는 countryCommitted가 아니라
   * hopCommitted(§6.2 — combo 필드가 없어 직전 comboChanged 값을 캐시해 사용, commitHop()이
   * setCombo→emit(hopCommitted) 순서로 호출하므로 캐시가 항상 그 홉의 콤보와 일치한다) ③
   * checkpoint/finished 대응 없음(chase는 그 이벤트를 방출하지 않는다 — arrested/기타 4종 연출
   * 사운드는 features/chase/sequences.ts가 이 메서드들의 playChase*를 직접 호출해 담당, 여기서
   * 중복 배선하지 않는다). 정타/오타는 bind()와 완전히 동일(재구현 아님).
   */
  bindChase(engine: ChaseSessionEngine, controller: TypingInputController): () => void {
    let combo = 0;
    let countdownTick1: ReturnType<typeof setTimeout> | null = null;
    let countdownTick2: ReturnType<typeof setTimeout> | null = null;
    const clearCountdown = (): void => {
      if (countdownTick1) clearTimeout(countdownTick1);
      if (countdownTick2) clearTimeout(countdownTick2);
      countdownTick1 = null;
      countdownTick2 = null;
    };

    const unsubEngine = engine.subscribe((e: ChaseEngineEvent) => {
      switch (e.type) {
        case 'phase':
          clearCountdown();
          if (e.phase === 'countdown') {
            this.playChaseAlarmBeep();
            countdownTick1 = setTimeout(() => this.playChaseAlarmBeep(), 1000);
            countdownTick2 = setTimeout(() => this.playChaseAlarmBeep(), 2000);
          } else if (e.phase === 'playing') {
            this.playChaseGlassShatter();
          }
          break;
        case 'comboChanged':
          combo = e.combo;
          break;
        case 'hopCommitted':
          this.playConfirm(combo);
          break;
        default:
          break;
      }
    });

    const unsubController = controller.subscribe((e: TypingEvent) => {
      switch (e.type) {
        case 'progress':
          if (e.delta.added > 0) this.playKeyCorrect();
          break;
        case 'miss':
          this.playMiss();
          break;
        default:
          break;
      }
    });

    return () => {
      clearCountdown();
      this.stopChaseHeartbeat();
      unsubEngine();
      unsubController();
    };
  }
}

let singleton: SoundManager | null = null;

/** 앱 전역 공유 인스턴스(사운드는 상태를 갖는 하드웨어 자원 — 화면마다 새로 만들 이유가 없다). */
export function getSoundManager(getSettings: () => SoundSettingsSnapshot): SoundManager {
  if (!singleton) singleton = new SoundManager(getSettings);
  return singleton;
}

/** 테스트 전용: 모듈 싱글턴을 리셋한다(테스트 간 AudioContext/리스너 누수 방지). */
export function __resetSoundManagerForTests(): void {
  singleton = null;
}
