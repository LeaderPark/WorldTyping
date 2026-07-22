// spec: docs/03 §7.3("대비/색각 … 대륙색 위 텍스트는 WCAG AA(4.5:1) 검사 CI(§11 축소판: 토큰
//       조합 정적 검사 스크립트)"), docs/00 §11(세션 특이 조정 3: "contrast-check(tokens.css
//       WCAG AA 4.5:1) + ci.yml 스텝 추가"), WT-M5-02
//
// 브라우저 없이(CSS color-mix()/data-theme 스위칭을 실행 엔진 없이) 정적으로 검사한다. 방식:
// (1) apps/web/src/styles/tokens.css의 :root 색 토큰(hex)을 파싱, (2) 실제 코드에서 함께 쓰이는
// "전경 텍스트/배경" 조합만 하드코딩된 목록으로 검사한다(globals.css의 실제 규칙과 대조해
// 작성 — 각 항목에 출처 주석을 남겼다. CSS 셀렉터를 통째로 해석하는 범용 파서가 아니다).
//
// 범위: 기본(다크) 테마만 강제 검사한다 — 제품 기본값이자 유일하게 규범적으로 확정된 테마다
// (docs/01 §13.2 "다크 모드 기본, 라이트는 옵션"). 라이트 테마의 장식용 팔레트(대륙색 등)는
// 이 스크립트가 검사하지 않는다 — GDD가 정한 브랜드 색을 이 태스크가 임의로 재정의하지 않기
// 위함(발견한 사항은 최종 보고 escalations에 기재, docs/00 §11 에스컬레이션 원칙).
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

/** `:root { ... }` 최초 블록(다크 기본값, `:root[data-theme=...]` 오버라이드 이전)만 파싱한다 —
 *  이 스크립트가 검사하는 건 그 기본(다크) 값이다. */
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
  const promptPending = '#64748b'; // globals.css .wt-prompt { --wt-prompt-pending }

  return [
    // ResultCard(.wt-result-card__grade, font-size:1.5rem/24px font-weight:800) — large text.
    { label: '.wt-grade--S on dark page bg', fg: gradeS, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-grade--A on dark page bg', fg: gradeA, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-grade--B on dark page bg', fg: gradeB, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-grade--C on dark page bg', fg: gradeC, bg: PAGE_BG_DARK, minRatio: 3 },
    { label: '.wt-grade--D on dark page bg', fg: gradeD, bg: PAGE_BG_DARK, minRatio: 3 },

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
