// spec: docs/03 §2.8 (프롬프트 렌더러 — METRO식 "슬롯+입력 에코", docs/00 §11-D66),
//       §2.6 (MatchDetail 필드 의미), §4.5 (고빈도 값 React 미경유 불변식),
//       docs/00 §11-D19(@wt/shared 경로)·§11-D22(nameKo 캐노니컬). WT-M2-03 / WT-DC-07.
//
// [표시 모델 — D66] 큰 줄은 목표어가 아니라 **사용자 입력 에코**다(원작 METRO 계승). 캐노니컬
// 표시단위(ko 음절 / en 글자) 수만큼 슬롯을 만들고, 각 슬롯 위에는 정적 소형 힌트(목표 유닛
// 문자)를, 아래에는 사용자가 실제로 친 글리프(초기 빈)를 둔다. 미입력 슬롯은 빈 밑줄(pending).
// 입력이 슬롯 수를 넘으면 tail로 흘러넘친다(error색). 판정·점수·프로토콜·엔진 이벤트 계약은
// 전부 불변 — 이 모듈은 표시 전용이다.
//
// [핫패스에 React 없음] 컨트롤러의 MatchDetail + rawValue를 받아 슬롯 글리프의 textContent·
// className과 커서 위치만 토글하는 명령형 DOM 계층이다. React state/props를 일절 쓰지 않는다.
// 슬롯별 {char,state} 캐시를 diff해 변경된 슬롯만 DOM을 만진다(update 1회당 접촉 ≤ 변경 슬롯 +
// 커서 이동 2). 애니메이션은 transform/opacity + 고정 박스뿐 — width/height 등 레이아웃 유발
// 프로퍼티는 상태에 따라 바뀌지 않는다(§2.8, §3.6 성능 계약: 밑줄 두께 불변·absolute 커서).
//
// [자모 경계 계산] mount는 캐노니컬 표기(ko=nameKo / en=nameEn)를 코드포인트 단위로 쪼개 각
// 유닛의 자모 길이를 toJamoSeq로 계산해 구분자(공백·구두점 = 자모 len 0)를 식별한다(기법은 WT-M2-03
// 마운트와 동일). update는 rawValue를 같은 기법으로 쪼개 각 입력 유닛의 자모 구간 [s,e)를 얻고,
// detail.matchedLen과 비교해 상태를 산정한다.
//
// [자모 채움 행 — docs/00 §11-D69] ko 콘텐츠 슬롯은 힌트/에코 글리프 아래에 캐노니컬 음절 자모
// 길이(cap=toJamoSeq(음절).length)만큼의 밑줄 슬롯 행(.wt-slot__jamo > .wt-jamo × cap)을 mount 시
// 1회 만든다(en·구분자는 미생성). update는 detail.matchedLen/inputLen을 캐노니컬 슬롯 경계 [s,e)에
// 사상해 각 자모 슬롯을 match(정타)/error(오타)/empty(미입력)로 채운다(data-fill — .wt-unit의
// data-state와 별도 네임스페이스라 E2E 셀렉터 계약과 격리). 색: 일치=--wt-prompt-match(=var(--text),
// 테마 자동), 불일치=--wt-prompt-error(#ef4444), 미채움=--wt-prompt-slot(=var(--border)). 치수는
// 상태 불변(색/클래스만) — 리플로우 0(§3.6).
import {
  normalizeEn,
  normalizeKo,
  toJamoSeq,
  type Country,
  type MatchDetail,
} from '@wt/shared';

export type JuiceLevel = 0 | 1 | 2;

/** 슬롯 글리프의 채색 상태(§2.8). 색각 이중 부호화를 위해 error는 색+물결 밑줄. */
export type SyllableState = 'pending' | 'partial' | 'done' | 'error';

/** 스케일 팝 지속(ms, GDD §13.3-1). transform: scale만. */
const POP_MS = 60;
/** 오답 셰이크 지속(ms). 컨테이너 1회 class 토글. */
const SHAKE_MS = 120;
/** 슬롯을 넘어선 초과 입력을 tail에 최대 몇 유닛까지 보일지(§2.8 D66). */
const TAIL_MAX_UNITS = 4;

/** [lo,hi]로 클램프(자모 채움 산식 — docs/00 §11-D69). */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Slot {
  /** 세로 칼럼 컨테이너(.wt-slot) — 커서 ::after 앵커. */
  root: HTMLSpanElement;
  /** 위쪽 정적 힌트(.wt-slot__hint) — 목표 유닛 문자. wt-unit class 미부여(E2E 셀렉터 계약). */
  hint: HTMLSpanElement;
  /** 아래쪽 입력 에코 글리프(.wt-unit) — data-state·is-* class를 얹는 대상(E2E 셀렉터 계약). */
  glyph: HTMLSpanElement;
  /** 캐노니컬 유닛 문자(EXACT 시 done으로 되메울 값). */
  canonical: string;
  /** 구분자(자모 len 0: 공백·구두점)면 true — 채색·에코 대상 아님. */
  isSep: boolean;
  /** 마지막으로 적용된 글리프 textContent(변경 시에만 DOM 조작). */
  char: string;
  /** 마지막으로 적용된 상태(sep은 항상 null). */
  state: SyllableState | null;
  // ── D69: 자모 채움 행(ko 콘텐츠 슬롯만 생성; en·구분자는 빈 배열/미생성) ──
  /** 자모 밑줄 슬롯 요소들(.wt-jamo × cap). textContent 없음 — data-fill로만 채색(E2E 격리). */
  jamoEls: HTMLSpanElement[];
  /** 이 슬롯 캐노니컬의 자모 시작 오프셋(콘텐츠 슬롯 누적 cap). matched/inputLen 사상 기준. */
  jamoStart: number;
  /** 마지막으로 적용된 match 자모 수(diff 캐시). */
  jamoM: number;
  /** 마지막으로 적용된 error 자모 수(diff 캐시). */
  jamoX: number;
}

/**
 * 프롬프트 명령형 렌더러(METRO식 슬롯+입력 에코, D66). 한 국가당 mount() 1회 →
 * 키스트로크마다 update(detail, rawValue) 다회 → 확정 시 pop().
 */
export class PromptRenderer {
  private root: HTMLElement | null = null;
  private glyphLayer: HTMLElement | null = null;
  private tail: HTMLElement | null = null;
  private slots: Slot[] = [];
  /** 비구분자 슬롯만(입력 유닛 → 슬롯 매핑·커서 위치 계산용). */
  private contentSlots: Slot[] = [];
  private lang: 'ko' | 'en' = 'ko';
  private juice: JuiceLevel = 2;
  /** 현재 커서를 든 요소(slot.root 또는 tail). 이동 시에만 DOM 토글. */
  private cursorEl: HTMLElement | null = null;
  /** tail의 마지막 텍스트(변경 시에만 DOM 조작). */
  private tailText = '';
  private popTimer: ReturnType<typeof setTimeout> | null = null;
  private shakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** el에 국가 프롬프트를 1회 렌더. 슬롯(힌트+에코 글리프)과 tail을 생성한다. */
  mount(el: HTMLElement, country: Country, lang: 'ko' | 'en'): void {
    this.clearTimers();
    this.lang = lang;
    this.slots = [];
    this.contentSlots = [];
    this.cursorEl = null;
    this.tailText = '';
    this.root = el;

    el.classList.add('wt-prompt');
    // 국가당 clean-slate: 직전 국가에서 진행 중이던 팝/셰이크 애니 class를 제거한다. clearTimers()가
    // 그 제거 타이머를 이미 취소했으므로, 같은 el을 재사용하는 국가 전환에서 이 class가 stuck으로
    // 남지 않게 여기서 명시적으로 지운다(그렇지 않으면 직전 국가의 정타 miss 셰이크가 다음 국가
    // 프롬프트로 새어 보인다 — WT-DC-09 E9b(ii)). unmount()의 정리와 대칭.
    el.classList.remove('wt-prompt--pop', 'wt-prompt--shake');
    el.setAttribute('data-lang', lang);

    el.replaceChildren();
    const glyphLayer = document.createElement('div');
    glyphLayer.className = 'wt-prompt__glyphs';
    glyphLayer.setAttribute('aria-hidden', 'true'); // 낭독은 §7.3 sr-only 라인이 담당
    el.appendChild(glyphLayer);
    this.glyphLayer = glyphLayer;

    const displayText = lang === 'ko' ? country.nameKo : country.nameEn;
    let jamoOffset = 0; // ko 콘텐츠 슬롯 누적 자모 오프셋(자모 채움 사상 기준, D69)
    for (const ch of displayText) {
      const len = this.unitLen(ch);
      const isSep = len === 0;

      const slotEl = document.createElement('span');
      slotEl.className = 'wt-slot';

      const hint = document.createElement('span');
      hint.className = 'wt-slot__hint';
      // 힌트가 캐노니컬 문자를 보존한다 → prompt-mount 전체 textContent는 (에코 글리프가 빈)
      // 국가 전환 직후 국가명과 정확히 일치한다(E2E 계약: game.ts awaitPrompt).
      hint.textContent = ch;
      slotEl.appendChild(hint);

      const glyph = document.createElement('span');
      glyph.className = isSep ? 'wt-unit wt-unit--sep' : 'wt-unit';
      slotEl.appendChild(glyph);

      // 자모 채움 행(D69): ko 콘텐츠 슬롯만. 캐노니컬 음절 자모 수(len=cap)만큼 빈 밑줄 슬롯.
      // textContent는 절대 넣지 않는다(prompt-mount textContent=국가명 계약 + .wt-unit 격리).
      const jamoEls: HTMLSpanElement[] = [];
      let jamoStart = 0;
      if (lang === 'ko' && !isSep) {
        jamoStart = jamoOffset;
        const jamoRow = document.createElement('span');
        jamoRow.className = 'wt-slot__jamo';
        jamoRow.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < len; i++) {
          const j = document.createElement('span');
          j.className = 'wt-jamo';
          j.dataset.fill = 'empty';
          jamoRow.appendChild(j);
          jamoEls.push(j);
        }
        slotEl.appendChild(jamoRow);
        jamoOffset += len;
      }

      glyphLayer.appendChild(slotEl);
      const slot: Slot = {
        root: slotEl,
        hint,
        glyph,
        canonical: ch,
        isSep,
        char: '',
        state: null,
        jamoEls,
        jamoStart,
        jamoM: 0,
        jamoX: 0,
      };
      this.slots.push(slot);
      if (!isSep) this.contentSlots.push(slot);
    }

    const tail = document.createElement('span');
    tail.className = 'wt-prompt__tail';
    glyphLayer.appendChild(tail);
    this.tail = tail;

    // 초기 표시: 비구분자 슬롯 전부 빈 pending(빈 밑줄), 커서는 첫 슬롯.
    this.renderClear();
  }

  /**
   * 키스트로크마다 호출. rawValue(사용자 실입력)를 코드포인트 유닛으로 쪼개 각 유닛의 자모
   * 구간 [s,e)를 얻고, detail.matchedLen/inputLen과 비교해 슬롯 글리프를 채운다(순수 재평가).
   */
  update(detail: MatchDetail, rawValue = ''): void {
    if (!this.root) return;

    // EXACT: rawValue가 플러시로 비었으므로(§2.5) 에코 대신 캐노니컬 글리프로 전 슬롯을 done
    // 채우고 커서·tail을 정리한다(확정 순간 국가명 전체가 done으로 점등 → pop). 자모 행은 전량 match.
    if (detail.state === 'EXACT') {
      for (const s of this.contentSlots) {
        this.setGlyph(s, s.canonical, 'done');
        this.fillJamo(s, s.jamoEls.length, 0); // 전 자모 match
      }
      this.setTail('');
      this.moveCursor(null);
      return;
    }

    const matched = Math.max(0, detail.matchedLen);
    const inputLen = detail.inputLen;
    // 오타 구간 존재 여부: 정타 접두를 넘어선 입력 자모가 있으면(=MISS) [matched, inputLen)이 오타.
    const hasError = matched < inputLen;

    // rawValue를 코드포인트 유닛으로 분해해 자모 구간 [s,e) 계산(len 0 입력 문자는 슬롯 미점유).
    let offset = 0;
    let typedCount = 0;
    const overflow: string[] = [];
    for (const ch of rawValue) {
      const len = this.unitLen(ch);
      if (len === 0) continue; // 공백·구두점 등: 슬롯 점유 없음
      const e = offset + len;
      offset = e;
      const state = this.stateFor(e, matched, hasError);
      if (typedCount < this.contentSlots.length) {
        this.setGlyph(this.contentSlots[typedCount]!, ch, state);
      } else {
        overflow.push(ch); // 슬롯 초과분 → tail(아래에서 마지막 TAIL_MAX_UNITS만 표시, error색)
      }
      typedCount++;
    }

    // 잔여(미입력) 슬롯 = 빈 pending(빈 밑줄) [리드 확정 A안].
    for (let k = typedCount; k < this.contentSlots.length; k++) {
      this.setGlyph(this.contentSlots[k]!, '', 'pending');
    }

    // 자모 채움(D69): 캐노니컬 슬롯 경계 [start,end)에 matched/inputLen을 사상한다(글리프 에코와
    // 독립 — rawValue가 아니라 detail만으로 결정). 각 슬롯: 앞 m개 match, 다음 x개 error, 나머지 empty.
    for (const s of this.contentSlots) {
      const cap = s.jamoEls.length;
      if (cap === 0) continue; // en·구분자(자모 행 미생성)
      const start = s.jamoStart;
      const end = start + cap;
      const m = clamp(matched - start, 0, cap);
      const x = clamp(Math.min(end, inputLen) - Math.max(start, matched), 0, cap - m);
      this.fillJamo(s, m, x);
    }

    // 슬롯 초과분 tail = 앞 4유닛 고정이 아니라 **마지막 TAIL_MAX_UNITS 유닛**을 보이는 슬라이딩
    // 윈도우(§11-D83). 앞-4 고정이면 국가명 유닛+4를 넘긴 뒤 타이핑·백스페이스에도 tail 텍스트가
    // 불변이라 "입력이 멈춘 것처럼" 보였다(표시 동결 — 값·이벤트·판정은 정상). 마지막-4로 바꾸면
    // 매 키/백스페이스마다 tail이 최신 입력으로 갱신돼 시각 피드백이 회복된다. 길이는 여전히
    // ≤ TAIL_MAX_UNITS라 고정폭 캡슐(D77)·nowrap·리플로우 0 계약 불변.
    this.setTail(overflow.slice(-TAIL_MAX_UNITS).join(''));

    // 커서: 첫 빈 비구분자 슬롯(= typed 유닛 수 위치). 오버플로 중엔 tail에.
    if (typedCount < this.contentSlots.length) {
      this.moveCursor(this.contentSlots[typedCount]!.root);
    } else {
      this.moveCursor(this.tail);
    }
  }

  /** 국가 확정 순간 스케일 팝(§2.8 juice). juice 0이면 no-op. */
  pop(): void {
    if (this.juice === 0 || !this.root) return;
    const el = this.root;
    el.classList.remove('wt-prompt--pop');
    // 리플로우 강제 없이 다음 프레임 토글 대신, 즉시 추가 후 타이머로 제거(class 토글만).
    void el.offsetWidth; // 애니메이션 재시작 트리거(읽기 1회 — 레이아웃 write 아님)
    el.classList.add('wt-prompt--pop');
    if (this.popTimer) clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => {
      el.classList.remove('wt-prompt--pop');
      this.popTimer = null;
    }, POP_MS);
  }

  /** 오타 셰이크(§2.8 juice). juice 0이면 no-op. */
  shake(): void {
    if (this.juice === 0 || !this.root) return;
    const el = this.root;
    el.classList.add('wt-prompt--shake');
    if (this.shakeTimer) clearTimeout(this.shakeTimer);
    this.shakeTimer = setTimeout(() => {
      el.classList.remove('wt-prompt--shake');
      this.shakeTimer = null;
    }, SHAKE_MS);
  }

  setJuiceLevel(level: JuiceLevel): void {
    this.juice = level;
    if (level === 0) {
      this.root?.classList.remove('wt-prompt--pop', 'wt-prompt--shake');
    }
  }

  /** 진단/테스트용: 각 슬롯 글리프의 현재 상태(구분자는 null). */
  getUnitStates(): (SyllableState | null)[] {
    return this.slots.map((s) => (s.isSep ? null : s.state));
  }

  /** 진단/테스트용: 각 슬롯 자모 행의 채움(match m·error x). 자모 행이 없는 슬롯(en·구분자)은 null. */
  getJamoFills(): Array<{ m: number; x: number } | null> {
    return this.slots.map((s) => (s.jamoEls.length > 0 ? { m: s.jamoM, x: s.jamoX } : null));
  }

  /** 마운트 해제 — 타이머 정리 + DOM 비움(hibernation/누수 방지 습관). */
  unmount(): void {
    this.clearTimers();
    if (this.root) {
      this.root.replaceChildren();
      this.root.classList.remove('wt-prompt', 'wt-prompt--pop', 'wt-prompt--shake');
      this.root.removeAttribute('data-lang');
    }
    this.root = null;
    this.glyphLayer = null;
    this.tail = null;
    this.slots = [];
    this.contentSlots = [];
    this.cursorEl = null;
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  /** 한 입력/표시 유닛(코드포인트)의 자모 길이. ko=toJamoSeq, en=normalizeEn. len 0 = 구분자. */
  private unitLen(ch: string): number {
    return this.lang === 'ko' ? toJamoSeq(normalizeKo(ch)).length : normalizeEn(ch).length;
  }

  /**
   * 입력 유닛 [s,e)의 상태(§2.8 D66). 자모 구간(e)과 matched만으로 결정 — composition 이벤트로
   * 분기하지 않는다(금지 사항).
   *  - e ≤ matched            → done    (정타 접두 안에 완전히 든 유닛)
   *  - hasError && e > matched → error   (정타 접두를 넘어선 오타 유닛)
   *  - !hasError && e > matched → partial (조합 중 꼬리 — 스펙의 s<matched<e를 포함해 안전 처리:
   *    !hasError는 유효 접두 보장이라 오타로 오인하지 않는다. 실입력에선 matched=inputLen이라
   *    거의 발생하지 않는 경계지만, 상태를 산식으로만 결정한다는 계약을 지킨다).
   */
  private stateFor(e: number, matched: number, hasError: boolean): SyllableState {
    if (e <= matched) return 'done';
    if (hasError) return 'error';
    return 'partial';
  }

  /** 슬롯 글리프 diff 반영 — char/state가 바뀐 슬롯만 DOM을 만진다. */
  private setGlyph(slot: Slot, char: string, state: SyllableState): void {
    if (slot.char === char && slot.state === state) return;
    if (slot.char !== char) {
      slot.glyph.textContent = char;
      slot.char = char;
    }
    if (slot.state !== state) {
      slot.glyph.dataset.state = state;
      slot.glyph.className = `wt-unit is-${state}`;
      slot.state = state;
    }
  }

  /**
   * 자모 채움 행 diff 반영(D69) — 앞 m개 match, 다음 x개 error, 나머지 empty. (m,x)가 바뀐 슬롯만
   * DOM을 만진다. 치수 불변이라 data-fill 속성만 토글 → 레이아웃 write 0(§3.6).
   */
  private fillJamo(slot: Slot, m: number, x: number): void {
    if (slot.jamoEls.length === 0) return; // en·구분자: 자모 행 없음
    if (slot.jamoM === m && slot.jamoX === x) return;
    slot.jamoM = m;
    slot.jamoX = x;
    for (let i = 0; i < slot.jamoEls.length; i++) {
      const fill = i < m ? 'match' : i < m + x ? 'error' : 'empty';
      const el = slot.jamoEls[i]!;
      if (el.dataset.fill !== fill) el.dataset.fill = fill;
    }
  }

  /** tail(초과 입력) diff 반영. 비었으면 텍스트만 비운다(색은 CSS 고정). */
  private setTail(text: string): void {
    if (!this.tail || this.tailText === text) return;
    this.tail.textContent = text;
    this.tailText = text;
  }

  /** 커서 이동 — 이전 요소에서 떼고 새 요소에 붙인다(변경 시에만 2회 토글). null=제거. */
  private moveCursor(next: HTMLElement | null): void {
    if (this.cursorEl === next) return;
    if (this.cursorEl) this.cursorEl.classList.remove('is-cursor');
    if (next) next.classList.add('is-cursor');
    this.cursorEl = next;
  }

  /** 초기/재설정: 전 비구분자 슬롯 빈 pending + 자모 행 empty, tail 비움, 커서를 첫 슬롯에. */
  private renderClear(): void {
    for (const s of this.contentSlots) {
      this.setGlyph(s, '', 'pending');
      this.fillJamo(s, 0, 0);
    }
    this.setTail('');
    this.moveCursor(this.contentSlots[0]?.root ?? null);
  }

  private clearTimers(): void {
    if (this.popTimer) {
      clearTimeout(this.popTimer);
      this.popTimer = null;
    }
    if (this.shakeTimer) {
      clearTimeout(this.shakeTimer);
      this.shakeTimer = null;
    }
  }
}
