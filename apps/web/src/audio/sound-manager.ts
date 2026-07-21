// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(단일 스프라이트 + Web Audio API, <audio> 태그 금지,
//       첫 제스처 unlock), WT-M2-07 구현 세부 지시 3("엔진 이벤트 구독(정타/오타/확정/체크포인트/
//       카운트다운)")
//
// <audio> 태그를 쓰지 않는다(§8.2). AudioContext는 첫 사용자 제스처에서 1회 생성하고, 스프라이트
// 로딩(fetch+decodeAudioData)은 그 뒤 비동기로 흘러간다 — 둘 중 어느 쪽이 실패해도(미지원 브라우저,
// 네트워크 실패, 디코드 실패) 이후의 모든 play*() 호출은 조용히 아무 일도 하지 않는다(무음 폴백,
// [제약/금지] "사운드 로딩이 첫 입력을 블로킹하지 말 것"). 이 파일은 재생을 절대 throw하지 않는다.
import type { EngineEvent, GameSessionEngine, TypingEvent, TypingInputController } from '@wt/engine';
import type { KeySound } from '../stores/settings';
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
