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
//
// [버퍼 소유권 — docs/00 §11-D70] ① setCountry가 권위적 클리어를 소유한다("새 국가 = 빈 버퍼").
// ② flushIme의 epoch++는 blur 뒤에 온다 — 자기유발 compositionend가 옛 epoch를 캡처해 구세대화
// 되게(마이크로태스크 재평가 차단). ③ flush 후 첫 입력은 evaluate 단일 관문(resolveRaw)에서
// 판별한다: 48ms 내 ≥2자모 옛-꼬리 재삽입 = 무이벤트 삼킴(국가당 3회 후 fail-open), 옛 전체값
// 접두 + 연장 = 접두 가상 스트립(Gboard 승계), 그 외 = genuine(단일 자모는 절대 비삼킴 —
// §2.10 #4 보존). ④ getValue()는 기저 접두(basePrefix)를 제외한 실입력을 노출한다(additive).
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
/** flush 직후 이 시간(ms) 안에 도착한 "옛-꼬리 재삽입"만 삼킨다(§2.5·docs/00 §11-D70). */
const REINSERT_WINDOW_MS = 48;
/** 국가당 재삽입 삼킴 상한 — 넘으면 fail-open(genuine 처리). 무한 삼킴/입력 잠금 방지. */
const MAX_REINSERT_FLUSHES = 3;

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
  // flushIme()가 조합 중 EXACT를 강제 확정하려고 스스로 input.blur()를 호출하는 동안(§2.5
  // 프로토콜) true — 이 사이에 발생하는 'blur' 네이티브 이벤트는 사용자의 실제 창 이탈이
  // 아니라 컨트롤러 자신이 유발한 것이므로 'blurred' TypingEvent로 승격시키지 않는다. 이 가드가
  // 없으면 실제 한글 IME로 조합 중 확정할 때마다(흔한 경로) 매 국가 확정마다 practice로
  // 강등되는 회귀가 생긴다(blur()/focus()는 동기 이벤트라 불리언 플래그로 안전하게 감쌀 수 있다).
  private selfInducedBlur = false;

  // ── D70: flush 후 재삽입/Gboard 접두 처리 상태 ──────────────────────────────
  // flushIme가 blur→focus로 조합을 강제 종료할 때, 일부 IME(특히 모바일)는 focus 복귀 시 방금
  // 확정한 자모열을 다시 삽입한다. 그 "옛 꼬리"를 다음 국가의 genuine 입력과 구별하기 위한 상태.
  /** 마지막 flush 시점 버퍼의 자모열(재삽입 탐지 기준). 첫 비어있지 않은 입력에서 one-shot 소거. */
  private staleEchoJamo = '';
  /** 그 원문(Gboard 접두 스트립 기준). */
  private staleEchoRaw = '';
  /** 마지막 flush 시각(재삽입 윈도우 판정 기준, this.now()). */
  private flushAt = 0;
  /** Gboard가 남긴 옛 값 접두 — 이 길이만큼 가상으로 잘라 평가/표시(getValue)한다. */
  private basePrefix = '';
  /** 국가당 재삽입 삼킴 횟수(MAX_REINSERT_FLUSHES 상한 — fail-open). setCountry에서 0으로 리셋. */
  private reinsertFlushes = 0;
  /** flushIme 실행 중 blur/focus가 유발할 수 있는 동기 input 재진입 방어 플래그. */
  private flushing = false;

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
    on('blur', () => {
      if (this.selfInducedBlur) return; // flushIme 자기유발 blur — 사용자 이탈 아님(위 주석 참조)
      this.emit({ type: 'blurred' });
    });
    on('focus', () => this.emit({ type: 'refocused' }));
  }

  detach(): void {
    this.detachFns.forEach((f) => f());
    this.detachFns = [];
  }

  /** 엔진이 새 국가를 제시할 때 호출 */
  setCountry(c: Country): void {
    this.targets = compileTargets(c, this.lang);
    // D70: setCountry가 권위적 클리어를 소유한다 — 잔여 버퍼/열린 조합이 있으면 무조건 flush해
    // "새 국가 = 빈 버퍼" 불변식을 세운다. 구 §2.5 "잔여를 새 타깃으로 즉시 재평가"하던 안전망은
    // 폐기됐다(그 재평가가 EXACT 플러시 후 IME 재삽입·스킵 잔여를 다음 국가 첫 입력으로 채택하던
    // 실버그의 근원). EXACT 직후엔 value=''·composing=false라 no-op이다(이중 flush/epoch 없음 →
    // EXACT 재진입 가드 무충돌; 재삽입 탐지용 staleEcho는 그대로 다음 국가로 이월된다).
    if (this.input.value.length > 0 || this.composing) this.flushIme();
    this.accountant.reset();
    this.reinsertFlushes = 0;
    this.shownAt = this.now();
  }

  private evaluate(ev?: Event): void {
    // setCountry 이전의 stray 이벤트 방어: 빈 targets에 matchInputDetail을 태우면 계약 위반 throw.
    if (this.targets.length === 0) return;
    // flushIme의 blur/focus가 동기 input을 유발하는 브라우저에서의 재진입 방어(D70).
    if (this.flushing) return;

    // D70 단일 관문: input.value → "판정에 넣을 실입력". 재삽입/기저붕괴는 여기서 삼킨다(null).
    const raw = this.resolveRaw(ev);
    if (raw === null) return; // 삼킴 — 무이벤트·무계상(flushIme가 이미 버퍼/accountant를 정리)

    const cap = this.epoch;
    const detail = matchInputDetail(raw, this.targets, this.lang);
    const curKey = this.jamoOf(raw);

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

  /** 입력/버퍼 문자열 → 판정용 키(ko=자모 시퀀스 / en=정규화 라틴). 기존 evaluate curKey 식 추출. */
  private jamoOf(s: string): string {
    return this.lang === 'ko' ? toJamoSeq(normalizeKo(s)) : normalizeEn(s);
  }

  /**
   * evaluate 진입 관문(D70). input.value를 "판정에 넣을 실입력"으로 변환해, flush 직후 IME
   * focus-복귀가 유발한 옛-꼬리 재삽입(input 핸들러 · compositionend microtask 두 벡터)을 이 한
   * 지점에서 차단하고 Gboard가 남긴 옛 값 접두를 가상으로 스트립한다.
   *  - `null` 반환 = 이 입력을 삼킴(무이벤트·무계상). `string` 반환 = 그 값으로 평가.
   * 분기 순서는 계약(§2.10 #4 보존)이라 바꾸지 않는다: 기저접두 → 무-staleEcho → 빈값 →
   * 재삽입(≥2자모·윈도우·꼬리일치·상한) → Gboard 접두 → genuine.
   */
  private resolveRaw(ev?: Event): string | null {
    const v = this.input.value;
    if (this.basePrefix) {
      if (v.startsWith(this.basePrefix)) return v.slice(this.basePrefix.length);
      if (v.length === 0) {
        this.basePrefix = '';
        return v;
      }
      this.flushIme(readIsComposing(ev) || this.composing); // 기저 붕괴 → 조용한 리셋
      return null;
    }
    if (!this.staleEchoJamo) return v;
    if (v.length === 0) return v; // 빈 input은 재삽입 판별 불가 — 가드 유지
    const stale = this.staleEchoJamo;
    const staleRaw = this.staleEchoRaw;
    this.staleEchoJamo = ''; // 첫 비어있지 않은 입력에서 one-shot 해제
    this.staleEchoRaw = '';
    const vJamo = this.jamoOf(v);
    // ≥2자모 조건이 핵심: 실키스트로크 1타 = 자모 1개 → 확정 직후 0ms 첫 타(§2.10 #4)는 절대 안 삼켜짐.
    if (
      this.now() - this.flushAt <= REINSERT_WINDOW_MS &&
      vJamo.length >= 2 &&
      stale.endsWith(vJamo) &&
      this.reinsertFlushes < MAX_REINSERT_FLUSHES
    ) {
      this.reinsertFlushes++;
      this.flushIme(readIsComposing(ev) || this.composing); // 재삽입 삼킴 + 재플러시
      return null;
    }
    if (v.startsWith(staleRaw) && v.length > staleRaw.length && staleRaw.length > 0) {
      this.basePrefix = staleRaw; // Gboard 접두 스트립 — 이후 basePrefix 분기가 연장분만 넘긴다
      return v.slice(staleRaw.length);
    }
    return v; // genuine 신규 입력
  }

  private flushIme(isComposing = this.composing): void {
    this.flushing = true;
    const staleRaw = this.input.value;
    this.basePrefix = '';
    if (isComposing) {
      // blur()/focus()는 동기 디스패치라 불리언 플래그로 안전하게 감쌀 수 있다(위 필드 주석).
      this.selfInducedBlur = true;
      this.input.blur(); // compositionend 강제 — 이 시점 epoch는 아직 옛 세대(아래 ++ 이전)
      this.selfInducedBlur = false;
      this.epoch++; // ★ blur 뒤로 재배열(D70): 자기유발 compositionend가 옛 epoch를 캡처해 구세대화
      this.input.value = '';
      this.input.focus(); // 반드시 동기 — setTimeout 금지(iOS 소프트키보드 유지 계약, §2.5)
      this.composing = false;
      this.staleEchoJamo = this.jamoOf(staleRaw); // focus-복귀 재삽입 탐지 기준
      this.staleEchoRaw = staleRaw;
      this.flushAt = this.now();
    } else {
      this.epoch++;
      this.input.value = '';
      this.staleEchoJamo = '';
      this.staleEchoRaw = '';
    }
    this.accountant.reset();
    this.flushing = false;
  }

  /** 스킵/게임오버 등 외부 사유로 버퍼를 비울 때 */
  clear(): void {
    this.flushIme();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /**
   * 표시 계층(별칭 에코 라인 등)이 읽는 실입력 원문(D70, additive). Gboard가 남긴 가상 접두
   * (basePrefix)는 제외해 프롬프트가 재삽입된 옛 값을 에코하지 않게 한다 — 이벤트 계약은 불변이다.
   */
  getValue(): string {
    const v = this.input.value;
    return this.basePrefix && v.startsWith(this.basePrefix) ? v.slice(this.basePrefix.length) : v;
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
