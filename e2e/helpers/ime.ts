// spec: docs/03 §10.2(E2E — CDP Input.imeSetComposition + Input.insertText 로 한글 조합 재현),
//       §2.10 #3·#4(조합 중 EXACT·확정 직후 0ms 첫 타), §2.3(value-snapshot 판정), WT-M2-08.
//
// 실제 OS IME 없이 CI(Chromium)에서 두벌식 한글 조합 입력을 재현한다. 핵심은 목표 문자열을
// 자모(keystroke) 시퀀스로 분해한 뒤, 두벌식 오토마톤으로 "키를 하나씩 눌렀을 때 화면에 실제로
// 나타나는 조합 중간 상태"를 재생성하는 것이다 — 도깨비불(직전 음절의 받침이 다음 음절 초성으로
// 이월되는 현상, 예: "가"+ㄴ→"간"→+ㅏ→"가나")을 실제 IME와 동일하게 거쳐간다.
//
// [왜 imeSetComposition 위주인가] 이 게임의 입력 컨트롤러(packages/engine/input-controller.ts,
// docs/03 §2.5)는 조합 중(compositionend 대기 없이) 목표와 EXACT가 되는 순간 자동 확정한다
// (Enter·수동 확정 없음). 따라서 이 게임의 "실제 플레이"를 충실히 재현하면 각 국가는 조합 중
// imeSetComposition 열만으로 확정된다 — 컨트롤러가 blur→clear→focus 플러시를 스스로 수행한다.
// Input.insertText 는 명시적 커밋(음절 확정) 경로를 위해 primitive로 함께 제공한다.
//
// [자모 테이블·분해 로직 출처] packages/shared/country-matcher/hangul.ts 의 CHO/JUNG/JONG/COMPOUND를
// 그대로 미러링한다(e2e는 별도 워크스페이스 — Playwright esbuild 로더가 node_modules 심볼릭 링크
// 안의 .ts를 변환하지 않으므로 런타임 크로스임포트 대신 벤더링). 발산 방지를 위해 typeHangul은
// 오토마톤이 만든 마지막 표시 문자열이 목표와 정확히 일치하는지 매 호출 self-check 한다.

import type { CDPSession } from '@playwright/test';

// ── 두벌식 자모 테이블 (packages/shared/country-matcher/hangul.ts 미러) ──────────────
const CHO = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;
const JUNG = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
] as const;
const JONG = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

/** 복합 모음·겹받침 → keystroke 쌍 (toJamoSeq의 재분해 테이블과 동일). */
const COMPOUND: Record<string, string> = {
  ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ',
  ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ',
};

/** 조합 방향(오토마톤용): 두 keystroke 자모 → 합쳐진 복합 모음/겹받침. */
const COMBINE: Record<string, string> = Object.fromEntries(
  Object.entries(COMPOUND).map(([whole, parts]) => [parts, whole]),
);

const CHO_SET = new Set<string>(CHO);
const JONG_SET = new Set<string>(JONG.filter((j) => j !== ''));
/** keystroke 기본 모음(복합 모음은 COMPOUND로 분해되므로 오토마톤 입력엔 기본 모음만 온다). */
const VOWEL_SET = new Set<string>(JUNG.filter((j) => !COMPOUND[j]));

function expand(jamo: string): string {
  return COMPOUND[jamo] ?? jamo;
}

/**
 * 임의 문자열 → keystroke 수준 자모 시퀀스(packages/shared toJamoSeq 미러). 비한글은 그대로 통과.
 */
export function toJamoSeq(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const cho = CHO[Math.floor(idx / 588)]!;
      const jung = JUNG[Math.floor((idx % 588) / 28)]!;
      const jong = JONG[idx % 28]!;
      out += expand(cho) + expand(jung) + (jong ? expand(jong) : '');
    } else if (code >= 0x3131 && code <= 0x3163) {
      out += expand(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

interface SyllableSlots {
  cho: string;
  jung: string;
  jong: string;
}

function empty(): SyllableSlots {
  return { cho: '', jung: '', jong: '' };
}

/** 현재 음절 슬롯 → 표시 문자열. cho+jung이면 완성 음절, 낱자면 호환 자모 그대로. */
function composeSyllable(s: SyllableSlots): string {
  const { cho, jung, jong } = s;
  if (cho && jung) {
    const ci = CHO.indexOf(cho as (typeof CHO)[number]);
    const ji = JUNG.indexOf(jung as (typeof JUNG)[number]);
    const ki = jong ? JONG.indexOf(jong as (typeof JONG)[number]) : 0;
    return String.fromCodePoint(0xac00 + (ci * 21 + ji) * 28 + ki);
  }
  if (cho) return cho; // 초성 낱자 (조합 첫 타)
  if (jung) return jung; // 초성 없는 낱모음(희귀)
  return '';
}

/**
 * 자모 keystroke 배열 → 각 keystroke 직후 화면에 나타나는 표시 문자열의 열.
 * 두벌식 오토마톤: 받침 이월(도깨비불)·복합 모음/겹받침 결합을 실제 IME와 동일하게 처리한다.
 */
export function composeSteps(jamo: readonly string[]): string[] {
  let committed = '';
  let cur = empty();
  const steps: string[] = [];
  const display = (): string => committed + composeSyllable(cur);

  for (const j of jamo) {
    if (VOWEL_SET.has(j)) {
      if (cur.jong) {
        // 도깨비불: 종성(겹받침이면 마지막 자모)이 다음 음절 초성으로 이월된다.
        const split = COMPOUND[cur.jong];
        let remain = '';
        let migrated = cur.jong;
        if (split) {
          const [a, b] = [...split];
          remain = a!;
          migrated = b!;
        }
        committed += composeSyllable({ cho: cur.cho, jung: cur.jung, jong: remain });
        cur = { cho: migrated, jung: j, jong: '' };
      } else if (cur.cho && !cur.jung) {
        cur.jung = j; // 초성 + 중성 = 완성
      } else if (cur.cho && cur.jung) {
        const combined = COMBINE[cur.jung + j];
        if (combined) {
          cur.jung = combined; // 복합 모음 (ㅗ+ㅏ→ㅘ)
        } else {
          committed += composeSyllable(cur); // 모음 연속 → 새 음절(초성 없는 모음)
          cur = { cho: '', jung: j, jong: '' };
        }
      } else {
        cur = { cho: '', jung: j, jong: '' };
      }
    } else if (CHO_SET.has(j)) {
      if (!cur.cho && !cur.jung) {
        cur.cho = j; // 음절 시작
      } else if (cur.cho && !cur.jung) {
        committed += composeSyllable(cur); // 자음 연속(모음 없음) → 앞 자음 확정
        cur = { cho: j, jung: '', jong: '' };
      } else if (cur.jung && !cur.jong) {
        if (JONG_SET.has(j)) {
          cur.jong = j; // 받침으로 부착
        } else {
          committed += composeSyllable(cur); // ㄸㅃㅉ 등 받침 불가 → 앞 음절 확정
          cur = { cho: j, jung: '', jong: '' };
        }
      } else {
        // 이미 종성 존재: 겹받침 결합 시도, 실패 시 앞 음절 확정.
        const combined = COMBINE[cur.jong + j];
        if (combined) {
          cur.jong = combined;
        } else {
          committed += composeSyllable(cur);
          cur = { cho: j, jung: '', jong: '' };
        }
      }
    } else {
      // 숫자·라틴·공백 등 비조합 문자: 앞 음절 확정 후 그대로 append.
      committed += composeSyllable(cur) + j;
      cur = empty();
    }
    steps.push(display());
  }
  return steps;
}

export interface TypeHangulOptions {
  /** 각 조합 스텝(keystroke) 사이 지연(ms). docs/03 §10.2 typeHangul 기본 30ms. */
  delayMs?: number;
  /** 첫 스텝만 이 지연으로(확정 직후 0ms 첫 타 재현, §2.10 #4). 미지정 시 delayMs. */
  firstDelayMs?: number;
}

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * D106 후속: CDP `Input.imeSetComposition`/`Input.insertText`는 keydown을 전혀 발행하지 않는다.
 * 반면 input-controller.ts의 D106 keydown-상관 판정(§attach 'keydown' 리스너, lastKeydownAt)은
 * "input 직전 물리 keydown 유무"로 사용자 타/기계 재삽입 스냅샷을 가른다 — 실제 IME 조합 중에도
 * 브라우저는 keyCode 229(key='Process')로 keydown을 먼저 보내므로, 이 갭을 메우지 않으면 CDP로
 * 재현한 모든 e2e 조합 입력이 "기계 스냅샷"으로 오분류된다. packages/engine/src/input-controller
 * .test.ts의 harness.type()이 같은 처방(keydown 디스패치 후 값 설정)을 쓴다 — 단 그 harness도
 * keyup은 보내지 않는다: input-controller.ts의 attach()는 'keydown' 리스너만 등록하고 keyup을
 * 전혀 구독하지 않으므로(값은 시각만 기록), 대응 keyUp 디스패치는 불필요하다.
 */
async function dispatchImeKeydown(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 229,
    key: 'Process',
  });
}

/** CDP로 현재 조합을 text로 설정(조합 시작/갱신). 커서는 항상 끝. */
export async function setComposition(cdp: CDPSession, text: string): Promise<void> {
  await dispatchImeKeydown(cdp);
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

/** CDP로 확정 텍스트 삽입(음절/단어 커밋 — compositionend 유발). */
export async function commitComposition(cdp: CDPSession, text: string): Promise<void> {
  await dispatchImeKeydown(cdp);
  await cdp.send('Input.insertText', { text });
}

/**
 * 두벌식 조합으로 한글 문자열을 입력한다. 목표를 자모열로 분해 → composeSteps로 조합 중간 상태
 * (도깨비불 포함)를 만든 뒤 각 상태를 imeSetComposition으로 발사한다. 이 게임은 조합 중 EXACT
 * 자동 확정이므로 마지막 스텝(=목표 완성)에서 컨트롤러가 스스로 확정한다(insertText 불필요).
 */
export async function typeHangul(
  cdp: CDPSession,
  text: string,
  opts: TypeHangulOptions = {},
): Promise<void> {
  const delayMs = opts.delayMs ?? 30;
  const firstDelayMs = opts.firstDelayMs ?? delayMs;
  const jamo = [...toJamoSeq(text)];
  const steps = composeSteps(jamo);

  // self-check: 오토마톤이 목표를 정확히 재구성했는지(자모 테이블/분해/오토마톤 상호 정합성).
  const final = steps[steps.length - 1];
  if (final !== text) {
    throw new Error(
      `typeHangul self-check failed: composed ${JSON.stringify(final)} !== target ${JSON.stringify(text)}`,
    );
  }

  for (let i = 0; i < steps.length; i++) {
    if (i > 0) await wait(delayMs);
    else await wait(firstDelayMs);
    await setComposition(cdp, steps[i]!);
  }
}
