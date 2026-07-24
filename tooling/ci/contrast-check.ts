// spec: docs/03 §7.3("대비/색각 … 대륙색 위 텍스트는 WCAG AA(4.5:1) 검사 CI(§11 축소판: 토큰
//       조합 정적 검사 스크립트)"), docs/00 §11(세션 특이 조정 3: "contrast-check(tokens.css
//       WCAG AA 4.5:1) + ci.yml 스텝 추가"), §11-D50(브랜드 색 텍스트 사용 제한 — 텍스트 토큰
//       추가 시 라이트 조합도 등록), §11-D57(WT-UI-01 — 기본 테마 라이트 전환), WT-M5-02 + WT-UI-01
//
// 브라우저 없이(CSS color-mix()/data-theme 스위칭을 실행 엔진 없이) 정적으로 검사한다. 방식:
// (1) apps/web/src/styles/tokens.css의 :root 색 토큰(hex)을 파싱, (2) 실제 코드에서 함께 쓰이는
// "전경 텍스트/배경" 조합만 하드코딩된 목록으로 검사한다(globals.css의 실제 규칙과 대조해
// 작성 — 각 항목에 출처 주석을 남겼다. CSS 셀렉터를 통째로 해석하는 범용 파서가 아니다).
//
// 범위(D57로 갱신): tokens.css의 :root는 이제 **라이트**가 기본이다(구 다크 기본 — docs/01
// §13.2는 D57로 개정됨). 이 스크립트는 두 갈래를 병행 검사한다 —
//   ① 라이트(:root, 제품 기본값): --text/--text-muted on --bg/--surface, --continent-*-text on
//      --surface, .wt-pill의 accent 텍스트. 전부 WT-UI-01에서 신설.
//   ② 다크(옵션, [data-theme='dark']): 등급색·대륙 원색을 다크 페이지 배경 위에서 검사하는
//      기존 WT-M5-02 하드코딩 목록을 그대로 유지한다(다크가 삭제되지 않고 옵션으로 존치되므로
//      회귀 가드도 유지 — PAGE_BG_DARK 등은 tokens.css를 파싱하지 않는 리터럴 상수라 :root의
//      기본 테마가 바뀌어도 그대로 유효하다).
// 대륙색 "원색"(장식·지도 fill 전용, --continent-*)은 여전히 이 스크립트가 텍스트 용도로
// 검사하지 않는다 — GDD가 정한 브랜드 색을 임의로 재정의하지 않기 위함(D50).
//
// 임계값: WCAG 2.1 AA — 일반 텍스트 4.5:1, "large text"(≥24px, 또는 ≥19px굵게) 3:1. 각 항목에
// 실제 렌더 크기 근거를 주석으로 남겨 임계값 선택을 정당화한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TOKENS_CSS_PATH = path.join(REPO_ROOT, 'apps/web/src/styles/tokens.css');

type TokenMap = Map<string, string>;

/** `:root { ... }` 최초 블록(D57 이후 라이트 기본값, `:root[data-theme=...]` 오버라이드 이전)만
 *  파싱한다 — 이 함수가 반환하는 건 그 기본(라이트) 값이다. */
function parseRootTokens(css: string): TokenMap {
  const rootBlockMatch = /:root\s*\{([^}]*)\}/.exec(css);
  if (!rootBlockMatch) throw new Error('tokens.css: :root 블록을 찾지 못했다');
  const map: TokenMap = new Map();
  const re = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootBlockMatch[1]!))) {
    map.set(m[1]!, m[2]!.toLowerCase());
  }
  return map;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(h.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CSS `color-mix(in srgb, <a> p%, <b>)`의 sRGB 채널별 선형 보간과 동일한 근사 재현
 *  (브라우저의 color-mix in srgb는 감마 보정 없이 채널을 직접 섞는다). */
function mix(a: string, b: string, aPercent: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  const pa = aPercent / 100;
  const pb = 1 - pa;
  const out = [0, 1, 2].map((i) => Math.round(ra[i]! * pa + rb[i]! * pb));
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
}

interface Check {
  /** 어디서 이 조합이 실제로 렌더되는지(파일:규칙) — 유지보수자가 소스와 대조할 수 있도록. */
  label: string;
  fg: string;
  bg: string;
  /** WCAG AA 임계값(4.5=일반 텍스트, 3=large text). */
  minRatio: 4.5 | 3;
}

function loadTokens(): TokenMap {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf-8');
  return parseRootTokens(css);
}

function requireToken(tokens: TokenMap, name: string): string {
  const v = tokens.get(name);
  if (!v) throw new Error(`tokens.css: --${name} 토큰을 찾지 못했다`);
  return v;
}

function buildChecks(tokens: TokenMap): Check[] {
  const BLACK = '#000000';
  const WHITE = '#ffffff';
  // AppShell.tsx: `bg-slate-900`(다크 기본 페이지 배경, Tailwind slate-900).
  const PAGE_BG_DARK = '#0f172a';

  const gradeS = requireToken(tokens, 'grade-s');
  const gradeA = requireToken(tokens, 'grade-a');
  const gradeB = requireToken(tokens, 'grade-b');
  const gradeC = requireToken(tokens, 'grade-c');
  const gradeD = requireToken(tokens, 'grade-d');
  const continentAsia = requireToken(tokens, 'continent-asia');
  const continentEurope = requireToken(tokens, 'continent-europe');
  const continentAfrica = requireToken(tokens, 'continent-africa');
  const continentNA = requireToken(tokens, 'continent-north-america');
  const continentSA = requireToken(tokens, 'continent-south-america');
  const continentOceania = requireToken(tokens, 'continent-oceania');
  const promptError = '#ef4444'; // globals.css .wt-prompt { --wt-prompt-error }
  // WT-DC-07(D66): pending 글리프는 텍스트가 비고 색은 var(--text-muted)를 상속한다(구
  // --wt-prompt-pending 토큰 폐기). 다크 --text-muted(#94a3b8)를 회귀 가드로 유지한다.
  const promptPending = '#94a3b8'; // globals.css .wt-unit.is-pending { color: var(--text-muted) } (dark)

  // WT-UI-01(D57) — 라이트 기본 시맨틱 토큰. 전부 tokens.css :root(라이트) 리터럴.
  const bg = requireToken(tokens, 'bg');
  const surface = requireToken(tokens, 'surface');
  const surfaceSunken = requireToken(tokens, 'surface-sunken');
  const text = requireToken(tokens, 'text');
  const textMuted = requireToken(tokens, 'text-muted');
  const accent = requireToken(tokens, 'accent');

  return [
    // ResultCard(.wt-result-card__grade, font-size:1.5rem/24px font-weight:800) — large text.
    // [WT-UI-09, 낡은 라벨 정리] 이 다섯 항목의 label 문자열은 여전히 구 클래스명 `.wt-grade--*`를
    // 가리키고 있었다 — 그 클래스는 WT-UI-06(결과 화면 리스타일)이 이미 제거하고
    // `.wt-result-card--{S,A,B,C,D}`가 세팅하는 `--wt-grade-color-text`(등급별 개별 대비 보정
    // 계수)로 대체했다(globals.css 참조). 수치 검사(fg=원색 grade 토큰, bg=다크 페이지 배경,
    // minRatio=3)는 그 대체와 무관하게 독립적으로 유효해 그대로 통과 중이었다 — 서술 라벨만
    // 현행 선택자로 정정한다(수치·기준값은 무변경).
    { label: '.wt-result-card__grade (S, 구 .wt-grade--S — WT-UI-06 제거) on dark page bg', fg: gradeS, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-result-card__grade (A, 구 .wt-grade--A — WT-UI-06 제거) on dark page bg', fg: gradeA, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-result-card__grade (B, 구 .wt-grade--B — WT-UI-06 제거) on dark page bg', fg: gradeB, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-result-card__grade (C, 구 .wt-grade--C — WT-UI-06 제거) on dark page bg', fg: gradeC, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-result-card__grade (D, 구 .wt-grade--D — WT-UI-06 제거) on dark page bg', fg: gradeD, bg: PAGE_BG_DARK, minRatio: 3 },

    // 대륙색은 현재 텍스트로 렌더되지 않지만(지도 SVG fill·장식용), §7.3이 명시 지목한 조합이라
    // 회귀 가드로 포함한다(large text 기준 — 향후 노선 배지 등에 쓰일 경우를 대비).
    { label: 'continent-asia (large text) on dark page bg', fg: continentAsia, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: 'continent-europe (large text) on dark page bg', fg: continentEurope, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: 'continent-africa (large text) on dark page bg', fg: continentAfrica, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: 'continent-north-america (large text) on dark page bg', fg: continentNA, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: 'continent-south-america (large text) on dark page bg', fg: continentSA, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: 'continent-oceania (large text) on dark page bg', fg: continentOceania, bg: PAGE_BG_DARK, minRatio: 3 },

    // globals.css .wt-prompt — 프롬프트 글리프는 clamp(2rem,6vw,3.5rem) = large text.
    { label: '.wt-unit.is-error (large text) on dark page bg', fg: promptError, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-unit.is-pending (large text) on dark page bg', fg: promptPending, bg: PAGE_BG_DARK, minRatio: 3 },

    // globals.css .wt-btn--primary — 일반 크기 버튼 텍스트, WT-M5-02에서 color-mix(85%,black)로
    // 보정(원색 대비 실측 3.68:1 실패 — 이 스크립트가 그 회귀를 감시한다).
    {
      label: '.wt-btn--primary white text on color-mix(grade-b 85%, black)',
      fg: WHITE,
      bg: mix(gradeB, BLACK, 85),
      minRatio: 4.5,
    },
    // globals.css .wt-onboarding-tip
    {
      label: '.wt-onboarding-tip white text on color-mix(grade-b 85%, black)',
      fg: WHITE,
      bg: mix(gradeB, BLACK, 85),
      minRatio: 4.5,
    },
    // globals.css .wt-onboarding-toast
    {
      label: '.wt-onboarding-toast white text on color-mix(grade-a 85%, black)',
      fg: WHITE,
      bg: mix(gradeA, BLACK, 85),
      minRatio: 4.5,
    },
    // globals.css .wt-bot-offer__badge
    {
      label: '.wt-bot-offer__badge white text on color-mix(grade-a 70%, black)',
      fg: WHITE,
      bg: mix(gradeA, BLACK, 70),
      minRatio: 4.5,
    },
    // globals.css .wt-pill--active / .wt-daily-page__cta(WT-UI-07) — 채워진 accent 버튼, 동일
    // 85% 기법(.wt-btn--primary와 같은 계수).
    {
      label: '.wt-pill--active / .wt-daily-page__cta white text on color-mix(accent 85%, black)',
      fg: WHITE,
      bg: mix(accent, BLACK, 85),
      minRatio: 4.5,
    },

    // ── WT-UI-01(D57) 라이트 기본 조합 ──────────────────────────────────────
    // .wt-card/.wt-menu-row 본문(15px 규모) — --text on --bg/--surface.
    { label: '--text on --bg (라이트 페이지 배경, 본문)', fg: text, bg, minRatio: 4.5 },
    { label: '--text on --surface (라이트 카드, 본문)', fg: text, bg: surface, minRatio: 4.5 },
    // .wt-menu-row__copy/.wt-token__label(캡션, ~14~15px) — --text-muted on --bg/--surface.
    {
      label: '--text-muted on --surface (카드 캡션, 본문)',
      fg: textMuted,
      bg: surface,
      minRatio: 4.5,
    },
    // [D62, 독립 검증 FAIL 수정] 원 리터럴(#6f766f)은 --bg(#f4f5ef) 위에서 실측 4.26:1로 본문
    // 기준(4.5:1) 미달이었고, pnpm e2e(e10-a11y.spec.ts, axe color-contrast)가 이 값을 그대로
    // 쓰는 하드코딩 text-slate-500 노드(PrivacyPage/CreditsPage — 카드 밖, --bg 위 직접 배치)
    // 에서 실제로 이를 검출했다. --text-muted 라이트 값을 color-mix(85%, black)로 재조정해
    // (tokens.css) 이 조합도 정상(4.5:1) 등급으로 통과하도록 만들었다 — large-text 완화가
    // 아니라 리터럴 자체를 고쳤다.
    {
      label: '--text-muted on --bg (카드 밖 직접 배치, 본문 — PrivacyPage/CreditsPage 실사용)',
      fg: textMuted,
      bg,
      minRatio: 4.5,
    },

    // .wt-kicker(11px/700, large text 아님 → 4.5:1 필요) on --surface, 대륙 6종.
    // [구현 조정, 최종 보고 escalations 참조] 지시문 리터럴 "72% + black" 균일 계수는 3/6
    // 대륙(oceania/north-america/south-america)에서 미달해 대륙별 계수(58~85%)로 대체했다 —
    // tokens.css의 --continent-*-text 정의 및 그 위 주석 참조. 아래는 그 실제 계수를 그대로
    // 재현해 검사한다(색상 자체는 불변, 보정 비율만 대륙별).
    {
      label: '--continent-asia-text (kicker 11px/700) on --surface',
      fg: mix(continentAsia, BLACK, 85),
      bg: surface,
      minRatio: 4.5,
    },
    {
      label: '--continent-europe-text (kicker 11px/700) on --surface',
      fg: mix(continentEurope, BLACK, 82),
      bg: surface,
      minRatio: 4.5,
    },
    {
      label: '--continent-africa-text (kicker 11px/700) on --surface',
      fg: mix(continentAfrica, BLACK, 70),
      bg: surface,
      minRatio: 4.5,
    },
    {
      label: '--continent-north-america-text (kicker 11px/700) on --surface',
      fg: mix(continentNA, BLACK, 62),
      bg: surface,
      minRatio: 4.5,
    },
    {
      label: '--continent-south-america-text (kicker 11px/700) on --surface',
      fg: mix(continentSA, BLACK, 58),
      bg: surface,
      minRatio: 4.5,
    },
    {
      label: '--continent-oceania-text (kicker 11px/700) on --surface',
      fg: mix(continentOceania, BLACK, 65),
      bg: surface,
      minRatio: 4.5,
    },

    // .wt-pill(15px/700) — accent 원색(#0a84ff)은 --surface 위에서 실측 3.65:1로 본문 기준
    // 미달(large text 3:1은 통과). WT-M5-02(.wt-btn--primary)와 동일 기법으로 텍스트만
    // color-mix(accent 80%, black) 보정(globals.css .wt-pill) — 보더는 비텍스트 3:1(WCAG
    // 1.4.11)만 필요해 원색 그대로 둔다(여기서는 텍스트 조합만 검사).
    {
      label: '.wt-pill text color-mix(accent 80%, black) on --surface',
      fg: mix(accent, BLACK, 80),
      bg: surface,
      minRatio: 4.5,
    },

    // ── [D79] S4 트랙선택 콘솔 라이트 재테마 ─────────────────────────────────
    // 중립 토큰 원 글자(T1~T5·✈, 1.05rem/700 = 16.8px — large text 경계(18.66px bold) 미만 → 4.5:1).
    { label: '--text on --surface-sunken (.wt-token__circle--neutral 글자)', fg: text, bg: surfaceSunken, minRatio: 4.5 },
    // 대륙 토큰 원 링(globals .wt-token__circle--*) — 원색 fill이 라이트 --surface 위 3:1 미달인
    // 대륙(SA 1.92 등)이 있어 color-mix(원색 75%, black) 1px 링이 WCAG 1.4.11 경계 식별을 담당.
    // fill 원색 자체는 D50대로 검사하지 않는다(장식 fill) — 링 계수(75%)의 회귀만 가드.
    { label: '.wt-token__circle--asia ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentAsia, BLACK, 75), bg: surface, minRatio: 3 },
    { label: '.wt-token__circle--europe ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentEurope, BLACK, 75), bg: surface, minRatio: 3 },
    { label: '.wt-token__circle--africa ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentAfrica, BLACK, 75), bg: surface, minRatio: 3 },
    { label: '.wt-token__circle--north-america ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentNA, BLACK, 75), bg: surface, minRatio: 3 },
    { label: '.wt-token__circle--south-america ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentSA, BLACK, 75), bg: surface, minRatio: 3 },
    { label: '.wt-token__circle--oceania ring mix(75%,black) on --surface (비텍스트)', fg: mix(continentOceania, BLACK, 75), bg: surface, minRatio: 3 },
    // 콘솔 헤더 LED 도트(.wt-track-select__console-dot) — 장식이지만 75% 계수 회귀 가드.
    { label: '.wt-track-select__console-dot mix(grade-c 75%,black) on --surface (비텍스트)', fg: mix(gradeC, BLACK, 75), bg: surface, minRatio: 3 },
  ];
}

function main(): void {
  const tokens = loadTokens();
  const checks = buildChecks(tokens);

  let failed = 0;
  for (const check of checks) {
    const ratio = contrastRatio(check.fg, check.bg);
    const pass = ratio >= check.minRatio;
    const status = pass ? 'PASS' : 'FAIL';
    console.log(
      `[${status}] ${check.label} — ${ratio.toFixed(2)}:1 (need ≥${check.minRatio}:1, fg=${check.fg} bg=${check.bg})`,
    );
    if (!pass) failed += 1;
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  if (failed > 0) {
    throw new Error(`contrast-check: ${failed} combination(s) failed WCAG AA — see log above.`);
  }
}

main();
