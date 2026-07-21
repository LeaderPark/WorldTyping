// spec: docs/03 §2.8 (프롬프트 렌더러 — 조합 중 글자의 시각화), §2.6 (MatchDetail 필드 의미),
//       §4.5 (고빈도 값 React 미경유 불변식), docs/00 §11-D19(@wt/shared 경로)·§11-D22(nameKo 캐노니컬).
//       WT-M2-03.
//
// [핫패스에 React 없음] 이 모듈은 컨트롤러의 MatchDetail을 받아 음절/문자 span의 className만
// 토글하는 명령형 DOM 계층이다. React state/props를 일절 쓰지 않는다(엔진/컨트롤러 이벤트 →
// classList 직접 조작). 애니메이션은 transform/opacity만 — width/height/top 등 레이아웃 유발
// 프로퍼티는 절대 건드리지 않는다(§2.8, §3.6 성능 계약).
//
// [자모 경계 사전 계산] 마운트 시 캐노니컬 표기(ko=nameKo / en=nameEn)를 코드포인트 단위로 쪼개
// 각 유닛(ko=음절, en=문자)이 차지하는 자모 시퀀스 구간 [start, start+len)을 toJamoSeq로 1회
// 계산해 span의 data-jamo-start/len에 박아둔다. 이후 update()는 O(유닛 수 ≤ ~16)의 class 토글뿐.
import {
  compileTargets,
  normalizeEn,
  normalizeKo,
  toJamoSeq,
  type Country,
  type MatchDetail,
} from '@wt/shared';

export type JuiceLevel = 0 | 1 | 2;

/** 음절/문자 유닛의 채색 상태(§2.8). 색각 이중 부호화를 위해 error는 색+물결 밑줄. */
export type SyllableState = 'pending' | 'partial' | 'done' | 'error';

/** 스케일 팝 지속(ms, GDD §13.3-1). transform: scale만. */
const POP_MS = 60;
/** 오답 셰이크 지속(ms). 컨테이너 1회 class 토글. */
const SHAKE_MS = 120;

interface Unit {
  el: HTMLSpanElement;
  /** 이 유닛이 차지하는 key(자모/문자) 시퀀스의 시작 오프셋. */
  start: number;
  /** 이 유닛의 key 길이(공백·구두점 등 정규화로 사라지는 문자는 0). */
  len: number;
  /** 마지막으로 적용된 상태(변경 시에만 DOM 조작). */
  applied: SyllableState | null;
}

/**
 * 프롬프트 명령형 렌더러. 한 국가당 mount() 1회 → 키스트로크마다 update() 다회 → 확정 시 pop().
 * 별칭(고수의 지름길, 예: "한국"→대한민국) 입력 중에는 캐노니컬 채색을 동결하고 하단 에코 라인에
 * 실입력을 표시한다(§2.8 — 캐노니컬 글자 위에 억지 매핑하지 않는다).
 */
export class PromptRenderer {
  private root: HTMLElement | null = null;
  private glyphLayer: HTMLElement | null = null;
  private echoLayer: HTMLElement | null = null;
  private units: Unit[] = [];
  private lang: 'ko' | 'en' = 'ko';
  /** 캐노니컬(nameKo/nameEn) 입력의 key. bestTarget.key와 다르면 별칭 경로. */
  private canonicalKey = '';
  private juice: JuiceLevel = 2;
  /** 별칭 경로 진입 시 true — 캐노니컬 채색 동결 플래그. */
  private aliasFrozen = false;
  private popTimer: ReturnType<typeof setTimeout> | null = null;
  private shakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** el에 국가 프롬프트를 1회 렌더. 자모 경계를 사전 계산해 span에 박는다. */
  mount(el: HTMLElement, country: Country, lang: 'ko' | 'en'): void {
    this.clearTimers();
    this.lang = lang;
    this.aliasFrozen = false;
    this.units = [];
    this.root = el;

    el.classList.add('wt-prompt');
    el.setAttribute('data-lang', lang);
    // 캐노니컬 채색·별칭 판정의 기준 key. acceptedInputs[0] = nameKo/nameEn(§11-D22).
    this.canonicalKey = compileTargets(country, lang)[0]!.key;

    el.replaceChildren();
    const glyphLayer = document.createElement('div');
    glyphLayer.className = 'wt-prompt__glyphs';
    glyphLayer.setAttribute('aria-hidden', 'true'); // 낭독은 §7.3 sr-only 라인이 담당
    el.appendChild(glyphLayer);
    this.glyphLayer = glyphLayer;

    const displayText = lang === 'ko' ? country.nameKo : country.nameEn;
    let cursor = 0;
    for (const ch of displayText) {
      const chunk = lang === 'ko' ? toJamoSeq(normalizeKo(ch)) : normalizeEn(ch);
      const len = chunk.length;
      const span = document.createElement('span');
      span.className = 'wt-unit';
      span.textContent = ch;
      span.dataset.jamoStart = String(cursor);
      span.dataset.jamoLen = String(len);
      span.dataset.unit = lang === 'ko' ? 'syllable' : 'char';
      if (len === 0) {
        // 공백·구두점: 정규화에서 사라져 key에 없다 → 채색 대상 아님(구분자).
        span.classList.add('wt-unit--sep');
        this.units.push({ el: span, start: cursor, len: 0, applied: null });
      } else {
        this.units.push({ el: span, start: cursor, len, applied: null });
      }
      glyphLayer.appendChild(span);
      cursor += len;
    }

    const echoLayer = document.createElement('div');
    echoLayer.className = 'wt-prompt__echo';
    echoLayer.setAttribute('aria-hidden', 'true');
    el.appendChild(echoLayer);
    this.echoLayer = echoLayer;

    // 초기 상태: 전부 pending.
    for (const u of this.units) this.applyState(u, u.len === 0 ? null : 'pending');
  }

  /**
   * 키스트로크마다 호출. detail.matchedLen(정타 자모 길이)·inputLen(입력 자모 길이)로 각 유닛의
   * 상태를 계산해 class만 토글한다. rawValue는 별칭 에코 라인 표시용 실입력(선택).
   */
  update(detail: MatchDetail, rawValue = ''): void {
    if (!this.root) return;

    // 별칭 경로: bestTarget이 캐노니컬이 아니고 실제 입력이 있을 때(§2.8).
    const isAlias = detail.inputLen > 0 && detail.bestTarget.key !== this.canonicalKey;
    if (isAlias) {
      // 캐노니컬 채색을 동결(현 상태 유지)하고 하단 에코 라인에 실입력을 표시.
      this.aliasFrozen = true;
      this.showEcho(rawValue);
      return;
    }
    if (this.aliasFrozen) {
      // 백스페이스로 캐노니컬 접두로 복귀 → 동결 해제.
      this.aliasFrozen = false;
    }
    this.hideEcho();

    const matched = Math.max(0, detail.matchedLen);
    const inputLen = detail.inputLen;
    // 오타 구간 존재 여부: 정타 접두를 넘어선 입력 자모가 있으면(=MISS) [matched, inputLen)이 오타.
    const hasError = matched < inputLen;

    for (const u of this.units) {
      if (u.len === 0) continue; // 구분자는 상태 없음
      const end = u.start + u.len;
      let next: SyllableState;
      if (hasError) {
        if (end <= matched) next = 'done';
        else if (u.start >= inputLen) next = 'pending';
        else next = 'error'; // matched를 넘어선 자모가 얹힌 첫 음절부터(§2.8)
      } else {
        // 오타 없음(PREFIX/EXACT): matched === inputLen.
        if (end <= matched) next = 'done';
        else if (u.start < matched) next = 'partial'; // 조합 중 — 진행 커서 밑줄
        else next = 'pending';
      }
      this.applyState(u, next);
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

  /** 진단/테스트용: 각 유닛의 현재 상태(구분자는 null). */
  getUnitStates(): (SyllableState | null)[] {
    return this.units.map((u) => u.applied);
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
    this.echoLayer = null;
    this.units = [];
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private applyState(u: Unit, next: SyllableState | null): void {
    if (u.applied === next) return;
    if (u.applied) u.el.classList.remove(stateClass(u.applied));
    if (next) {
      u.el.classList.add(stateClass(next));
      u.el.dataset.state = next;
    } else {
      delete u.el.dataset.state;
    }
    u.applied = next;
  }

  private showEcho(raw: string): void {
    if (!this.echoLayer) return;
    this.echoLayer.textContent = raw;
    this.echoLayer.classList.add('is-visible');
  }

  private hideEcho(): void {
    if (!this.echoLayer) return;
    if (this.echoLayer.textContent !== '') this.echoLayer.textContent = '';
    this.echoLayer.classList.remove('is-visible');
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

function stateClass(s: SyllableState): string {
  return `is-${s}`;
}
