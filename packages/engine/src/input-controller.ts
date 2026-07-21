/// <reference lib="dom" />
// spec: docs/03 §2.7 (TypingInputController 전문), §2.5 (EXACT 플러시 프로토콜),
//       §2.3 (value-snapshot 판정 원칙), §2.6 (버퍼 상한/MISS), §2.9 (영문·라틴 경로),
//       docs/00 §11-D19(경로 @wt/shared), §11-D4(공백 제거).
//
// [DOM 타입 격리] engine tsconfig의 lib는 ES2022(DOM 없음)다. 이 파일만 상단
// `/// <reference lib="dom" />`로 DOM 타입을 켠다 — engine에서 브라우저를 아는 유일한
// 계층(docs/03 §2.2 계층 A)이기 때문. React import는 eslint no-restricted-imports로 금지.
//
// [핵심 불변식 — epoch 가드] flushIme()만이 epoch를 증가시킨다. 모든 비동기 연속
// (microtask/이벤트)은 진입 시점에 cap=this.epoch를 캡처하고, 실행 시 cap!==this.epoch면
// no-op한다. 따라서 "EXACT 확정 이전에 발생한 어떤 IME 이벤트도 확정 이후 상태를 오염시킬 수
// 없다"가 불변식이다(docs/03 §2.5 · §2.10 #4).
import {
  matchInputDetail,
  compileTargets,
  toJamoSeq,
  normalizeKo,
  normalizeEn,
  type MatchDetail,
  type CompiledTarget,
  type Country,
} from '@wt/shared';
import { KeystrokeAccountant, type KeystrokeDelta } from './accountant';

/** 한 스냅샷에서 이 값을 초과해 자모가 늘면 붙여넣기/스와이프로 간주(§2.4). */
const BULK_INSERT_MAX_ADDED = 8;
/** 버퍼 상한 여유분: bestTarget.key.length + 이 값 초과분은 계상에서 제외(§2.6). */
const BUFFER_SLACK = 8;
/** ko 모드에서 연속 라틴 3자 이상이면 한/영 오입력 신호(§2.9). 오발 방지로 3자 하한. */
const LATIN_RUN_RE = /[A-Za-z]{3,}/;

export type TypingEvent =
  | { type: 'progress'; detail: MatchDetail; delta: KeystrokeDelta; rawValue: string }
  | { type: 'exact'; detail: MatchDetail; delta: KeystrokeDelta; elapsedFromShownMs: number }
  | { type: 'miss'; detail: MatchDetail; delta: KeystrokeDelta } // addedError>0인 progress의 특수화
  | { type: 'bulkInsert' } //   부정 의심 → practice 강등(06 연동)
  | { type: 'latinInKoMode' } // ko 모드 라틴 혼입 최초 1회 → 한/영 토스트(§2.9)
  | { type: 'skipRequested' } // ESC
  | { type: 'blurred' } // 창/포커스 이탈 감지(GDD §5.5)
  | { type: 'refocused' };

export class TypingInputController {
  private epoch = 0;
  private composing = false;
  private targets: CompiledTarget[] = [];
  private accountant = new KeystrokeAccountant();
  private shownAt = 0;
  private latinWarned = false;
  private listeners = new Set<(e: TypingEvent) => void>();
  private detachFns: Array<() => void> = [];

  constructor(
    private input: HTMLInputElement,
    private lang: 'ko' | 'en',
    // performance.now를 주입 가능하게 둔다(가상 시계 테스트). CLAUDE.md §5: engine은 시계를 주입.
    private now: () => number = () => performance.now(),
  ) {}

  attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      k: K,
      f: (e: HTMLElementEventMap[K]) => void,
    ) => {
      this.input.addEventListener(k, f);
      this.detachFns.push(() => this.input.removeEventListener(k, f));
    };

    on('compositionstart', () => {
      this.composing = true;
    });
    on('compositionend', () => {
      const cap = this.epoch;
      this.composing = false;
      // Safari는 compositionend가 마지막 input보다 먼저 온다 → 여기서도 1회 평가해 이벤트 순서
      // 비의존화. 단 그 사이 EXACT 플러시가 지나갔다면(cap!==epoch) 구세대 유령이므로 폐기.
      queueMicrotask(() => {
        if (cap === this.epoch) this.evaluate();
      });
    });
    on('beforeinput', (e) => {
      const t = e.inputType;
      if (t === 'insertFromPaste' || t === 'insertReplacementText' || t === 'insertFromDrop') {
        e.preventDefault(); // 벌크 삽입은 파이프라인에 넣지 않는다
        this.emit({ type: 'bulkInsert' });
      }
    });
    on('input', (e) => {
      this.evaluate(e);
    });
    on('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.emit({ type: 'skipRequested' });
      }
      // 그 외 키는 일절 preventDefault 하지 않는다 — IME 파이프라인 보존(§2.7 제약)
    });
    on('blur', () => this.emit({ type: 'blurred' }));
    on('focus', () => this.emit({ type: 'refocused' }));
  }

  detach(): void {
    this.detachFns.forEach((f) => f());
    this.detachFns = [];
  }

  /** 엔진이 새 국가를 제시할 때 호출 */
  setCountry(c: Country): void {
    this.targets = compileTargets(c, this.lang);
    this.accountant.reset();
    this.shownAt = this.now();
    // 잔여 버퍼가 있으면(§2.5 Gboard 안전망) 즉시 새 타깃으로 평가
    if (this.input.value.length > 0) this.evaluate();
  }

  private evaluate(ev?: Event): void {
    // setCountry 이전의 stray 이벤트 방어: 빈 targets에 matchInputDetail을 태우면 계약 위반 throw.
    if (this.targets.length === 0) return;

    const cap = this.epoch;
    const raw = this.input.value;
    const detail = matchInputDetail(raw, this.targets, this.lang);
    const curKey = this.lang === 'ko' ? toJamoSeq(normalizeKo(raw)) : normalizeEn(raw);

    // 버퍼 상한(§2.6): bestTarget.key.length + BUFFER_SLACK 초과분은 계상에서 제외.
    const bufferCap = detail.bestTarget.key.length + BUFFER_SLACK;
    const cappedKey = curKey.length > bufferCap ? curKey.slice(0, bufferCap) : curKey;
    const delta = this.accountant.consume(cappedKey, detail.bestTarget.key);

    // 붙여넣기/스와이프(§2.4): 한 스냅샷 added>8 → practice 강등 신호.
    if (delta.added > BULK_INSERT_MAX_ADDED) {
      this.emit({ type: 'bulkInsert' });
      return;
    }

    // ko 모드 라틴 혼입(§2.9): 연속 라틴 3자 이상 최초 1회만 신호(한/영 키 안내).
    if (this.lang === 'ko' && !this.latinWarned && LATIN_RUN_RE.test(raw)) {
      this.latinWarned = true;
      this.emit({ type: 'latinInKoMode' });
    }

    if (detail.state === 'EXACT') {
      // isComposing = event.isComposing || controllerComposing (§2.3, Safari 순서 역전 대비).
      const isComposing = readIsComposing(ev) || this.composing;
      const elapsedFromShownMs = this.now() - this.shownAt;
      this.flushIme(isComposing); // ★ §2.5 프로토콜 (epoch++ 포함)
      if (cap !== this.epoch - 1) return; // 재진입 가드: 사이에 다른 플러시가 끼면 중복 emit 방지
      this.emit({ type: 'exact', detail, delta, elapsedFromShownMs });
      return;
    }

    this.emit(
      delta.addedError > 0
        ? { type: 'miss', detail, delta }
        : { type: 'progress', detail, delta, rawValue: raw },
    );
  }

  private flushIme(isComposing = this.composing): void {
    this.epoch++;
    if (isComposing) {
      this.input.blur(); // compositionend 강제(구세대 epoch로 도착 → 무시됨)
      this.input.value = '';
      this.input.focus(); // 반드시 동기 — setTimeout 금지(iOS 소프트키보드 유지 계약, §2.5)
      this.composing = false;
    } else {
      this.input.value = '';
    }
    this.accountant.reset();
  }

  /** 스킵/게임오버 등 외부 사유로 버퍼를 비울 때 */
  clear(): void {
    this.flushIme();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  private emit(e: TypingEvent): void {
    this.listeners.forEach((f) => f(e));
  }

  subscribe(f: (e: TypingEvent) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
}

/** InputEvent.isComposing 안전 접근(lib.dom 버전차·plain Event 대응). */
function readIsComposing(ev?: Event): boolean {
  return Boolean((ev as { isComposing?: boolean } | undefined)?.isComposing);
}
