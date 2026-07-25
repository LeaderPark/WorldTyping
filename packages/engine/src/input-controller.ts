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
// 판별한다: ≥2자모 옛-꼬리 전량 재삽입 = 무이벤트 삼킴, 옛 전체값 접두 + 연장 = 접두 가상 스트립
// (Gboard 승계), 그 외 = genuine(단일 자모는 절대 비삼킴 — §2.10 #4 보존. 단 D106 이후 이 계약은
// "keydown 상관이 있는 입력 = 사용자 타"에 한한다). 국가당 3회 삼킴 후 fail-open.
// ③′(D84) 옛 값의 proper 접미(끝음절, ≥2자모)가 첫 입력의 raw 접두로 병합된 경우, 전체 판정 MISS ∧
// 잔여 판정 non-MISS일 때만(의미 중재) 그 접미를 basePrefix로 가상 스트립하고 연장분만 평가(예산 공유).
// ③″(D98) 실기기 IME는 재삽입을 focus 복귀 직후가 아니라 사용자의 다음 키스트로크 시점에 발현시킬 수
// 있어 시간 게이트가 새는 방어였다 → 부분 꼬리 스트립은 윈도우 무관, 전량 삼킴은 윈도우 안=무중재
// (현행 fast-path)·밖=의미 중재(전체 MISS)로만 삼킨다. staleEcho가 "첫 비어있지 않은 입력에서
// one-shot 소거"라 노출은 국가당 1스냅샷으로 유계이고, fail-open은 시간이 아닌 예산이 담당한다.
// ④ getValue()는 기저 접두(basePrefix)를 제외한 실입력을 노출한다(additive).
// ⑤(D104) D98 이후에도 라이브 재현이 남았던 잔여 구멍 2개를 봉인한다.
//   (A) **비조합 flush도 무장한다** — EXACT는 조기 compositionend/Safari 순서 역전에서 microtask
//       재평가(ev=undefined·composing=false)로 확정되고, 스킵 clear()도 비조합이다. 기존 else 분기는
//       거기서 staleEcho를 지워 방어가 아예 무장되지 않았다(이후 어떤 재삽입도 genuine 통과).
//       이제 lang==='ko' ∧ 비우기 전 버퍼가 비어있지 않으면 무장한다(en·빈 버퍼는 기존대로 해제).
//   (B) **삼킴 정리는 조합을 실제로 추적 중일 때만(this.composing) flushIme** — 아니면 신설
//       silentClear(epoch·blur·focus 미유발). 기존엔 이벤트의 isComposing 비트만 보고 삼킴마다
//       blur→focus를 돌려, 그 focus 복귀가 같은 재삽입을 다시 불러 예산(3)만 태우고 fail-open했다.
// ⑥(D106) **점진 재조합 에코** — D104 이후 남은 마지막 라이브 경로. IME가 flush된 끝음절을 자모
//   단위로 되타이핑한다("ㄷ" input → "도" input). 첫 스냅샷 'ㄷ'은 단일 자모라 ③의 §2.10 #4
//   비삼킴에 걸려 genuine으로 통과하면서 staleEcho one-shot까지 소진시키고, 두 번째 '도'는 방어
//   부재로 안착해 사용자 입력과 합쳐져 '도대'가 된다. 값 층만으로는 두 스냅샷이 사용자 타와
//   구별되지 않는다 → **물리 keydown 상관**을 근본 신호로 도입한다: 사용자 타는 input 직전에
//   keydown이 있고(한글 IME 조합 중에도 keyCode 229로 발생한다), 기계 재삽입은 keydown 없이
//   input만 온다. (a) one-shot 소거는 keydown 상관 입력에서만 하고, (b) keydown 없는 스냅샷은
//   [옛 끝음절 자모열의 접두/접미 ∧ 전체 판정이 EXACT가 아님] 하에 단일 자모여도 삼킨다.
//   (c) keydown 있는 입력의 판정은 D98/D104 그대로다(변경 0).
// ⑦(D112) **재정렬 변형 — one-shot 폐기**. ⑥까지의 모든 방어는 "에코가 먼저 온다"를 가정했지만,
//   실기기에는 사용자의 첫 자모('ㄷ', kd=true)가 먼저 도착해 one-shot을 소진시킨 뒤 IME가 다음
//   스냅샷에서 옛 음절을 병합('도대')하는 순서 역전이 존재한다(라이브 잔존 재현의 원인). staleEcho는
//   국가 전환 내내 무장 유지한다 — 해제는 다음 flush의 재무장/클리어뿐. 안전 근거: 모든 삼킴·스트립이
//   [구조 게이트 ∧ 의미 중재(전체 MISS일 때만) ∧ 예산 3회]를 통과해야 하므로 정상 진행(PREFIX/EXACT)은
//   절대 걸리지 않고, 상시 무장으로 새로 노출되는 분기 (2)(옛 전체값 접두)에는 (3)과 동일한 의미
//   중재를 추가한다(인도→인도네시아처럼 새 국가명이 옛 국가명으로 시작하는 genuine 진행 보호).
//   부수 효과: 이미 누수된 버퍼('도대…')도 이후 스냅샷에서 중재 통과 시 자가 치유된다.
// ⑧(D113) **기계 판별 오탐 봉인 — 분기 (0) 중재를 MISS-전용으로 강화**. keydown 상관(80ms)은
//   무거운 프레임/기기 지연에서 빗나갈 수 있고, 그때 사용자의 진짜 첫 자음('ㄷ' = 새 타깃의 유효
//   PREFIX)이 기계로 오인돼 삼켜졌다(D112 상시 무장으로 노출 확대 — "간헐적 첫 자음 소실" 실사용
//   재현). 원칙 확정: **유효 진행(PREFIX/EXACT)은 어떤 판별 실패에도 불가침** — 전 분기가 동일한
//   MISS-전용 중재를 쓴다. 트레이드: 점진 에코 1조각이 유효 접두면 순간 표시되나 다음 조각(MISS)에서
//   즉시 자가 정리된다.
// ⑨(D116) **기저 붕괴에도 동일 중재 — D113 원칙의 마지막 누락 분기**. IME는 분기 (2)(3)이 가상
//   스트립한 반삽입 접두를 다음 스냅샷에서 스스로 걷어내고 value를 자기 조합 상태 기준으로
//   재작성할 수 있다(북한→중국: '한ㅈ' 스트립 후 v='주' — 접두 '한' 증발). 구 base-collapse는
//   붕괴 잔여의 판정 상태를 보지 않고 settleSwallow해, 조합 중 blur가 유효 진행('주'→'중')을
//   파괴하고 데싱크된 IME가 다음 자모만으로 새 조합을 시작했다("ㅈㅜ 소실 후 ㅇ만 잔존" 라이브
//   재현). 이제 붕괴 잔여가 유효 진행(PREFIX/EXACT)이면 접두만 해제하고 그대로 평가한다 — MISS면
//   종전 기구(조용한 리셋·재무장) 불변. 트레이드(D113과 동형): 옛 꼬리가 새 타깃의 유효 접두인
//   전환에서 순수 에코 붕괴 잔여가 보존될 수 있으나(D98-④ 기수용 누수 클래스), 같은 값이 사용자
//   진행일 가능성과 값 층에서 구별 불가하므로 불가침 원칙상 보존이 우선한다.
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
/** flush 직후 이 시간(ms) 안에 도착한 옛-꼬리 전량 재삽입은 무중재로 삼킨다(§2.5·docs/00 §11-D70·D84).
 *  D98: 이 윈도우는 전량 삼킴 분기의 fast-path 전용이다 — 밖에서는 의미 중재를 거쳐 삼키고, 부분
 *  꼬리 스트립(분기 (3))은 시간을 보지 않는다(재삽입 발현 시점이 다음 키스트로크까지 늦춰지므로). */
const REINSERT_WINDOW_MS = 150;
/** 국가당 재삽입 삼킴 상한 — 넘으면 fail-open(genuine 처리). 무한 삼킴/입력 잠금 방지. */
const MAX_REINSERT_FLUSHES = 3;
/** keydown↔input 상관 인정 창(ms, D106). 브라우저는 물리 키마다 keydown을 먼저 디스패치하고
 *  (IME가 키를 소비하는 조합 중에도 legacy keyCode 229로 발생한다) 곧바로 같은/다음 태스크에서
 *  input을 낸다. 80ms는 IME 파이프라인·이벤트 큐·저사양 기기의 프레임 스톨을 흡수하면서도
 *  "keydown 없이 수백 ms 뒤 스스로 발현하는 재삽입"과는 겹치지 않는 여유값이다. 짧게 잡으면
 *  느린 기기의 사용자 타가 기계로 오인되고(입력 유실), 길게 잡으면 에코가 사용자 타로 위장한다. */
const KEYDOWN_CORRELATION_MS = 80;

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
  /** D106: 마지막 물리 keydown 시각(this.now()). -Infinity = "아직 없음"(항상 무상관으로 시작). */
  private lastKeydownAt = Number.NEGATIVE_INFINITY;
  /** D104 진단 채널: localStorage 'wt:imeTrace'==='1'일 때만 resolveRaw 분기 결정을 로그한다.
   *  생성 시 1회만 읽어 캐시하고 호출측에서 이 불리언으로 먼저 게이트한다 — 꺼져 있으면 핫패스
   *  비용은 불리언 검사 1회(문자열 포맷·객체 할당 없음). */
  private readonly trace = readTraceFlag();

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
      // D106: 값이 아니라 "이 input이 물리 키에서 왔는가"를 기록한다 — IME 재삽입은 keydown 없이
      // input만 내므로, resolveRaw가 이 타임스탬프 하나로 사용자 타와 기계 에코를 가른다.
      // 어떤 키인지는 무관하다(IME 조합 중 keydown은 key='Process'/keyCode 229로 온다).
      this.lastKeydownAt = this.now();
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
   * 분기 순서는 계약(§2.10 #4 보존)이라 바꾸지 않는다: 기저접두[붕괴 시 D116 의미 중재] →
   * 무-staleEcho → 빈값 → [D106 keydown-무상관 꼬리 에코] → 전량삼킴(≥2자모·꼬리일치·상한·
   * [윈도우 밖이면 의미 중재]) → Gboard 전체접두 → 부분꼬리 스트립(D84·의미 중재, 시간 무관 —
   * D98) → genuine.
   * D106 분기만 신설이고 뒤 분기들의 조건·순서는 불변이다 — keydown 상관이 있는 입력(사용자 타)은
   * D106 분기를 무조건 건너뛰므로 기존 경로가 그대로 적용된다.
   */
  private resolveRaw(ev?: Event): string | null {
    const v = this.input.value;
    if (this.basePrefix) {
      if (v.startsWith(this.basePrefix)) return v.slice(this.basePrefix.length);
      if (v.length === 0) {
        this.basePrefix = '';
        return v;
      }
      // ★D116: 기저 붕괴에도 의미 중재(MISS-전용) — IME는 자신이 소유하지 않은 반삽입 접두를
      // 다음 스냅샷에서 걷어내며 value를 자기 조합 상태 기준으로 재작성할 수 있다(북한→중국:
      // '한ㅈ' 스트립 후 v='주'). 붕괴 잔여가 유효 진행(PREFIX/EXACT)이면 사용자 입력이다 —
      // 접두만 해제하고 그대로 평가한다(파일 헤더 ⑨). 구 무중재 settleSwallow는 조합 중 blur로
      // 진행을 파괴해 "ㅈㅜ 소실 후 ㅇ만 잔존"을 만들었다. staleEcho·예산은 불변(보존은 삼킴이
      // 아니고, 무장 유지가 후속 병합 스냅샷의 자가 치유를 보존한다 — D112).
      if (matchInputDetail(v, this.targets, this.lang).state !== 'MISS') {
        if (this.trace) this.traceBranch('base-collapse-genuine', { v, base: this.basePrefix });
        this.basePrefix = '';
        return v;
      }
      if (this.trace) this.traceBranch('base-collapse', { v, base: this.basePrefix });
      this.settleSwallow(); // 기저 붕괴(잔여 MISS) → 조용한 리셋
      return null;
    }
    if (!this.staleEchoJamo) return v;
    if (v.length === 0) return v; // 빈 input은 재삽입 판별 불가 — 가드 유지
    const stale = this.staleEchoJamo;
    const staleRaw = this.staleEchoRaw;
    // ★D112: one-shot 소거 **전면 폐기** — staleEcho는 국가 전환 내내 무장 유지한다(해제는 다음
    // flushIme/silentClear의 재무장 또는 비조합 빈-버퍼 flush의 클리어만). 근거: D106까지의 모든
    // 방어는 "에코가 사용자 타보다 먼저 온다"를 가정했지만, 실기기에서는 사용자의 첫 자모('ㄷ',
    // kd=true)가 먼저 와 one-shot을 소진시킨 뒤 IME가 다음 스냅샷에서 옛 음절을 병합('도대')하는
    // **재정렬 변형**이 존재한다(라이브 잔존 재현의 원인). 상시 무장이 안전한 이유: 삼킴/스트립은
    // 전부 [구조 게이트(꼬리 일치) ∧ 의미 중재(전체 MISS) ∧ 예산 3회]가 지키므로 정상 진행
    // (PREFIX/EXACT)은 어떤 분기에도 걸리지 않고, 오탐 상한은 예산이 계속 담당한다.
    const kd = this.hasRecentKeydown();
    const vJamo = this.jamoOf(v);
    const inWindow = this.now() - this.flushAt <= REINSERT_WINDOW_MS;
    const hasBudget = this.reinsertFlushes < MAX_REINSERT_FLUSHES;
    if (this.trace) {
      // evComposing(이벤트 비트) vs composing(우리가 추적 중인 조합)의 괴리가 구멍 B의 기기 신호다.
      // kd/sinceKd(D106)는 "이 스냅샷이 물리 키에서 왔는가"의 원격 진단 필드다.
      const budget = this.reinsertFlushes;
      const evComposing = readIsComposing(ev);
      const composing = this.composing;
      const sinceKd = this.now() - this.lastKeydownAt;
      this.traceBranch('armed', {
        v,
        vJamo,
        stale,
        inWindow,
        budget,
        evComposing,
        composing,
        kd,
        sinceKd,
      });
    }
    // (0) ★D106-(b): keydown 없는 스냅샷 = 기계 재삽입 후보. 두 게이트를 함께 통과할 때만 삼킨다.
    //     ① 구조: v가 옛 끝음절 자모열의 접두이거나 접미(= 그 음절을 되타이핑하는 중). 무관한 값은
    //        keydown이 없어도 genuine으로 통과시켜 오탐 상한을 둔다.
    //     ② 의미(★D113 강화): 전체 판정이 **MISS일 때만** 삼킨다 — (1)(3)과 동일 중재 기준.
    //        구 기준("EXACT만 보호")은 keydown 상관이 빗나가는 순간(무거운 프레임 등으로 input이
    //        keydown보다 80ms 이상 지연)에 사용자의 진짜 첫 자음('ㄷ' = 대한민국의 유효 PREFIX)을
    //        삼켰다 — D112 상시 무장으로 노출이 넓어지며 실사용 재현("간헐적 첫 자음 소실").
    //        유효 진행(PREFIX/EXACT)은 어떤 판별 실패에도 불가침이 원칙이다. 트레이드: 점진 에코의
    //        1번째 조각('ㄷ')이 새 타깃의 유효 접두면 순간 표시될 수 있으나, 이어지는 조각('도')이
    //        MISS가 되는 즉시 삼켜져 자가 정리된다(§2.10 #4 주석의 keydown 한정 조항은 유지).
    if (!kd && hasBudget && this.isStaleTailEcho(vJamo, staleRaw)) {
      if (matchInputDetail(v, this.targets, this.lang).state === 'MISS') {
        if (this.trace) this.traceBranch('swallow-echo', { v, vJamo, stale });
        this.reinsertFlushes++;
        this.settleSwallow();
        // 앵커 복원: 점진 에코는 여러 스냅샷에 걸쳐 자란다('ㄷ'→'도'). settleSwallow의 재무장이
        // 방금 삼킨 조각으로 기준을 덮으면 다음 조각을 꼬리 에코로 못 알아본다 — 원래 옛 값을
        // 기준으로 되돌려 에코가 끝날 때까지 같은 앵커로 판별한다(flushAt 갱신은 그대로 유지).
        this.staleEchoJamo = stale;
        this.staleEchoRaw = staleRaw;
        return null;
      }
    }
    // (1) 전량 에코 삼킴(D70-③): ≥2자모 조건이 핵심 — 실키스트로크 1타 = 자모 1개 → 확정 직후 0ms
    //     첫 타(§2.10 #4)는 절대 안 삼켜짐. 윈도우 안은 무중재 fast-path(현행 불변).
    //     D106: 이 ≥2자모 게이트는 "사용자 타"를 보호하는 장치다. keydown 없는 기계 스냅샷은 위
    //     (0)에서 이미 처리되므로 여기 도달하는 단일 자모는 언제나 물리 키에서 온 것이다.
    if (vJamo.length >= 2 && stale.endsWith(vJamo) && hasBudget) {
      // D98: 윈도우 밖(늦게 발현한 에코)은 의미 중재를 통과할 때만 삼킨다 — v가 새 타깃의 유효
      // PREFIX/EXACT면 genuine 우선. 알려진 한계: 인도→도미니카처럼 새 타깃이 옛 꼬리로 시작하면
      // 늦은 단독 에코 '도'는 값 층에서 genuine과 구별 불가라 구조적으로 못 잡는다(누수 수용).
      if (inWindow || matchInputDetail(v, this.targets, this.lang).state === 'MISS') {
        if (this.trace) this.traceBranch('swallow', { v, vJamo, stale, inWindow });
        this.reinsertFlushes++;
        this.settleSwallow(); // 재삽입 삼킴 + 정리(예산 소비 규칙은 D70/D84 그대로)
        return null;
      }
    }
    // (2) Gboard 옛 전체값 접두 스트립(D70-③). ★D112: 의미 중재 추가 — staleEcho가 상시 무장으로
    //     바뀌면서, 새 국가명이 옛 국가명으로 시작하는 전환(인도→인도네시아)에서 genuine 진행
    //     "인도네"가 이 분기에 걸릴 수 있게 됐다. (3)과 동일 중재: 전체 해석이 유효(PREFIX/EXACT)
    //     하면 절대 스트립하지 않는다 — Gboard 에코("인도"+연장)는 전체가 MISS라 종전대로 잡힌다.
    if (v.startsWith(staleRaw) && v.length > staleRaw.length && staleRaw.length > 0) {
      const fullG = matchInputDetail(v, this.targets, this.lang);
      const restG = matchInputDetail(v.slice(staleRaw.length), this.targets, this.lang);
      if (fullG.state === 'MISS' && restG.state !== 'MISS') {
        if (this.trace) this.traceBranch('gboard-prefix', { v, staleRaw });
        this.basePrefix = staleRaw; // Gboard 접두 스트립 — 이후 basePrefix 분기가 연장분만 넘긴다
        return v.slice(staleRaw.length);
      }
    }
    // (3) ★D84(버그 W): 끝음절(부분 꼬리) 접미 재삽입이 사용자 첫 타와 병합된 스냅샷 — staleRaw의
    //     최장 proper 접미 r이 v의 raw 접두이고 연장분이 있으면, 의미 중재 통과 시에만 r을 기존
    //     basePrefix 기구로 가상 스트립(지속 스트립·getValue 제외·기저붕괴 조용 flush 승계)하고
    //     연장분만 평가한다. 국가 전환당 최대 1회 실행이라 핫패스 비용 무시 가능.
    //     D98: inWindow 게이트 제거 — 병합 재삽입은 사용자가 다음 키를 칠 때(수백 ms 뒤) 발현한다.
    if (hasBudget) {
      for (let i = 1; i < staleRaw.length; i++) {
        const r = staleRaw.slice(i); // 최장 proper 접미부터
        if (!v.startsWith(r) || v.length <= r.length) continue;
        // §2.10 #4 게이트 — 1자모 에코 해석 금지(D106: 여기 오는 입력은 keydown 상관 = 사용자 타).
        if (this.jamoOf(r).length < 2) break;
        const rest = v.slice(r.length);
        // 의미 중재: genuine 해석(전체 v)이 유효(PREFIX/EXACT)하면 절대 스트립하지 않는다(over-strip 차단).
        const full = matchInputDetail(v, this.targets, this.lang);
        const stripped = matchInputDetail(rest, this.targets, this.lang);
        if (full.state === 'MISS' && stripped.state !== 'MISS') {
          if (this.trace) this.traceBranch('strip', { v, r, rest });
          this.reinsertFlushes++; // 삼킴과 공용 예산 소비(fail-open 일관성)
          this.basePrefix = r;
          return rest;
        }
        break; // 최장 raw 일치 1회만 중재(결정성) — 실패 시 genuine
      }
    }
    if (this.trace) this.traceBranch('genuine', { v, vJamo, stale, hasBudget });
    return v; // genuine 신규 입력
  }

  /**
   * D106: 직전 input이 물리 keydown과 상관되는가(= 사용자 타). 브라우저는 키 입력마다 keydown을
   * input보다 먼저 디스패치하므로(IME 조합 중 포함), 상관이 없는 input은 IME/브라우저가 스스로
   * 만든 스냅샷 — 즉 재삽입 에코 후보다. 값 층(자모열)만으로는 얻을 수 없는 유일한 출처 신호다.
   */
  private hasRecentKeydown(): boolean {
    return this.now() - this.lastKeydownAt <= KEYDOWN_CORRELATION_MS;
  }

  /**
   * D106: 기계 스냅샷 v가 "flush된 끝음절의 (부분) 되타이핑"인가 — v의 자모열이 옛 값 마지막
   * 음절 자모열의 접두이거나 접미면 관련으로 본다. 점진 재조합 에코 'ㄷ'(접두) → '도'(전체)가
   * 여기 걸린다. 꼬리보다 긴 값(= 사용자 입력이 섞여 자란 스냅샷)은 관련 아님으로 떨어져 뒤의
   * 부분꼬리 스트립(3)이 담당한다 — 삼킴이 아니라 스트립이 정답인 경우이기 때문.
   */
  private isStaleTailEcho(vJamo: string, staleRaw: string): boolean {
    const tail = this.jamoOf(staleRaw.slice(-1)); // 마지막 음절의 자모열(예: '인도' → 'ㄷㅗ')
    if (!vJamo || !tail) return false;
    return tail.startsWith(vJamo) || tail.endsWith(vJamo);
  }

  /**
   * 재삽입 삼킴·기저붕괴 정리(D104-B). **실제로 조합 중일 때만**(= 우리가 compositionstart를 보고
   * 추적 중인 this.composing) 기존 flushIme(blur→epoch++→clear→동기 focus)를 쓰고, 그 외에는
   * silentClear로 조용히 정리한다. 판정을 `readIsComposing(ev) || this.composing`에서 this.composing
   * 단독으로 좁힌 것이 이 수정의 핵심이다: IME 재삽입 이벤트 자체가 isComposing=true로 오는 기기
   * (flushIme의 focus() 중에 시작된 조합이라 우리 compositionstart 추적은 이미 false로 덮인다)에서
   * blur→focus를 다시 돌리면 그 focus 복귀가 같은 에코를 한 번 더 부르는 루프가 되어 국가당 예산
   * 3회를 태우고, 4번째부터 fail-open으로 에코가 새 버퍼에 눌러앉는다(라이브 잔여 증상).
   * 조합을 실제로 추적 중일 때는 blur가 조합을 끝내는 유일한 수단이므로 flushIme를 유지한다(§2.5).
   */
  private settleSwallow(): void {
    if (this.composing) this.flushIme(true);
    else this.silentClear();
  }

  /**
   * 조합이 없는 상태의 버퍼 정리(D104-B). flushIme와 달리 epoch를 올리지 않고 blur()/focus()도
   * 부르지 않는다 — 정리 후에도 방어는 계속 무장 상태로 남는다(연속 에코 대응).
   * - blur/focus 미유발: 삼킨 값 자체가 직전 blur→focus가 유발한 재삽입이다. 여기서 또 돌리면
   *   같은 에코를 재유발하는 루프가 되고, 소프트키보드가 깜빡이는 부작용만 남는다.
   * - epoch 미증가: 조합이 없으니 구세대화할 자기유발 compositionend가 없고, 오히려 진행 중인
   *   유효한 compositionend microtask 재평가까지 죽여 정상 입력을 잃는다(§2.5 epoch 계약 보존).
   * 호출 두 지점 모두 v.length>0를 이미 통과했으므로 버퍼는 항상 비어있지 않다 → 무조건 재무장.
   */
  private silentClear(): void {
    const staleRaw = this.input.value;
    this.basePrefix = '';
    this.input.value = '';
    this.staleEchoJamo = this.jamoOf(staleRaw); // 다음 에코 탐지 기준으로 재무장
    this.staleEchoRaw = staleRaw;
    this.flushAt = this.now();
    this.accountant.reset();
  }

  /** 진단 로그 1행(this.trace로 게이트된 호출만 도달한다). */
  private traceBranch(branch: string, fields: Record<string, string | number | boolean>): void {
    console.debug('[wt:ime]', branch, fields);
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
      // ★D104-A: 비조합 flush도 재삽입 방어를 무장한다. EXACT는 조기 compositionend/Safari 순서
      // 역전에서 compositionend가 예약한 microtask 재평가(ev=undefined·composing=false)로 확정될 수
      // 있고 스킵 clear()도 비조합인데, 여기서 staleEcho를 지우면 그 국가 전환에서는 재삽입 방어가
      // 아예 무장되지 않아 이후 어떤 에코도 genuine으로 통과했다(라이브 '도대' 재현의 잔여 구멍).
      // 무장 조건은 [lang==='ko' ∧ 비우기 전 버퍼 비어있지 않음]: en 라틴 경로는 IME 재삽입이
      // 없으므로 기존 계약대로 해제하고(§2.9), 빈 버퍼 clear()도 무장할 대상 자체가 없다.
      if (this.lang === 'ko' && staleRaw.length > 0) {
        this.staleEchoJamo = this.jamoOf(staleRaw);
        this.staleEchoRaw = staleRaw;
        this.flushAt = this.now();
      } else {
        this.staleEchoJamo = '';
        this.staleEchoRaw = '';
      }
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

/**
 * D104 진단 채널 플래그. 컨트롤러 생성 시 1회만 호출된다(핫패스 아님). SSR/node 테스트에는
 * localStorage가 없고, 프라이버시 모드·샌드박스 iframe에서는 접근 자체가 throw할 수 있다.
 */
function readTraceFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('wt:imeTrace') === '1';
  } catch {
    return false;
  }
}

/** InputEvent.isComposing 안전 접근(lib.dom 버전차·plain Event 대응). */
function readIsComposing(ev?: Event): boolean {
  return Boolean((ev as { isComposing?: boolean } | undefined)?.isComposing);
}
