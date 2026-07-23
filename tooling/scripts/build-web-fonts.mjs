#!/usr/bin/env node
// spec: docs/00 §11-D58(WT-UI-01 — Pretendard 웹 서브셋 woff2 셀프호스트 허용, subset-font
//       파이프라인 확장, font-display:optional, JS 예산 밖), docs/03 §8.2(폰트 preload +
//       font-display:optional, 프롬프트 폰트 스왑에 의한 레이아웃 튐 금지), WT-UI-01.
//
// tooling/scripts/build-og-fonts.mjs(M6-02, satori/OG용 TTF 서브셋)와 같은 파이프라인
// (subset-font + harfbuzzjs)을 웹 UI용으로 확장한다 — 출력 포맷만 woff2, 가중치는 400/700 두
// 벌(정적 서브셋, variable font 아님 — tailwind.config.ts fontFamily.sans의 "Pretendard"와
// globals.css @font-face 두 블록이 이 두 파일을 각각 font-weight 400/700으로 등록한다).
//
// [결정성] 입력(pretendard npm 패키지의 정적 Regular/Bold TTF)·글리프 집합·subset-font 옵션이
// 고정이면 출력 바이트도 고정이다. KS 완성형 2,350자는 build-og-fonts.mjs와 동일하게 Node 내장
// ICU의 EUC-KR 디코더로 결정적으로 열거한다(네트워크 0). CI가 재실행 후 git diff로 신선도를
// 검증할 수 있다.
//
// [라이선스] Pretendard ⓒ Kil Hyung-jin — SIL Open Font License 1.1(OFL-1.1).
// 원본: https://github.com/orioncactus/pretendard (npm "pretendard" 패키지, package.json
// license: "OFL-1.1"). OFL 4조에 따라 서브셋을 임베딩·재배포할 수 있다(폰트명 변경 없이).
// 산출물 apps/web/public/fonts/pretendard-subset-{400,700}.woff2는 커밋 대상이며, 라이선스
// 고지는 apps/web/src/styles/globals.css의 @font-face 주석에 있다(이 스크립트 자체에도 재기재).
//
// 사용법: `node tooling/scripts/build-web-fonts.mjs` (또는 pnpm build:web-fonts).
// apps/web의 predev/prebuild가 매 실행 전에 이 스크립트를 호출해 산출물을 재생성한다(다른 pnpm
// 버전이 패키지 해시를 바꿔도 항상 같은 소스에서 다시 생성하므로 재현 가능 — copy-fonts.mjs와
// 동일한 관례).

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);
const REPO_ROOT = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, REPO_ROOT));

/** KS X 1001 완성형 한글 2,350자를 EUC-KR(0xB0..0xC8 lead, 0xA1..0xFE trail)로 결정적 열거.
 *  (build-og-fonts.mjs의 ksHangulSyllables()와 동일 — 두 스크립트는 독립 산출물을 만들어
 *  각자 완결되도록 의도적으로 중복시켰다, copy-fonts.mjs/build-og-fonts.mjs 관례와 동일.) */
function ksHangulSyllables() {
  const dec = new TextDecoder('euc-kr', { fatal: true });
  const set = new Set();
  for (let lead = 0xb0; lead <= 0xc8; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      try {
        const s = dec.decode(new Uint8Array([lead, trail]));
        if (s.length === 1) {
          const cp = s.codePointAt(0);
          if (cp >= 0xac00 && cp <= 0xd7a3) set.add(cp);
        }
      } catch {
        /* EUC-KR 미정의 조합 — 건너뜀 */
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** 웹 UI 전역 글리프 집합(결정적 정렬 문자열) — OG 카드보다 넓다(전 화면 공용 서브셋이라
 *  일반적인 UI 기호를 추가로 포함: 화살표·체크·엑스·인용부호·저작권 등). 여기 없는 글리프는
 *  브라우저가 자동으로 tailwind.config.ts의 폴백 스택(system-ui 등)으로 넘어간다(서브셋 폰트가
 *  그 글리프를 담당하지 않을 뿐 렌더 자체가 깨지지 않는다 — 표준 웹폰트 서브셋 관례). */
function buildGlyphText() {
  const cps = new Set();
  // ASCII 인쇄 가능 영역(라틴 대소문자·숫자·문장부호·공백) — <>[]{}|\/`~^%&@#$_+=도 이 범위.
  for (let cp = 0x20; cp <= 0x7e; cp++) cps.add(cp);
  // 라틴-1 보충 + 일반 기호(중점·엔대시·엠대시·곱셈·나눗셈·불릿·말줄임표·저작권/등록/상표·도).
  for (const cp of [
    0x00a0, 0x00a9, 0x00ae, 0x00b0, 0x00b1, 0x00b7, 0x00d7, 0x00f7, 0x2013, 0x2014, 0x2018, 0x2019,
    0x201c, 0x201d, 0x2022, 0x2026, 0x2122,
  ]) {
    cps.add(cp);
  }
  // 화살표·체크·엑스(UI 배지/상태 아이콘 텍스트 대용).
  for (const cp of [0x2190, 0x2191, 0x2192, 0x2193, 0x2713, 0x2717]) cps.add(cp);
  // KS 완성형 한글.
  for (const cp of ksHangulSyllables()) cps.add(cp);
  return [...cps].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp)).join('');
}

const WEIGHTS = [
  { weight: 400, file: 'Pretendard-Regular.ttf', out: 'pretendard-subset-400.woff2' },
  { weight: 700, file: 'Pretendard-Bold.ttf', out: 'pretendard-subset-700.woff2' },
];

async function main() {
  // pretendard의 package.json exports가 서브패스를 매핑하지 않으므로 패키지 루트에서 상대 경로로
  // 접근한다(build-og-fonts.mjs와 동일 사유 — subpath require.resolve는 MODULE_NOT_FOUND).
  const pkgDir = dirname(require.resolve('pretendard/package.json'));
  const text = buildGlyphText();
  const outDir = p('apps/web/public/fonts');
  mkdirSync(outDir, { recursive: true });

  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`[build-web-fonts] glyphs: ${[...text].length}`);

  for (const { weight, file, out } of WEIGHTS) {
    const srcTtf = `${pkgDir}/dist/public/static/alternative/${file}`;
    if (!existsSync(srcTtf)) {
      throw new Error(`[build-web-fonts] pretendard 소스 TTF를 찾지 못했다: ${srcTtf}`);
    }
    const source = readFileSync(srcTtf);
    const subset = await subsetFont(source, text, { targetFormat: 'woff2' });
    const outPath = p(`apps/web/public/fonts/${out}`);
    writeFileSync(outPath, subset);
    console.log(`[build-web-fonts] wrote apps/web/public/fonts/${out} (weight ${weight}, ${kb(subset.byteLength)})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  throw err;
});
