// spec: docs/00 §11-D46(OG 렌더러용 Pretendard 서브셋 TTF ~180KB, KS 완성형 + 라틴/숫자 —
//       subset-font(harfbuzzjs) 빌드 스텝을 M6-02에서 신설), docs/06 §9.1(폰트는 Pretendard
//       subset을 Workers Assets로 번들), WT-M6-02
//
// pretendard npm 패키지의 전체 TTF(2.7MB)에서 satori(workers-og)가 OG 카드 렌더에 실제로 쓰는
// 글리프만 남긴 서브셋 TTF(~180KB)를 생성한다. 산출물은 workers/api/src/og/fonts/에 커밋한다:
//   - pretendard-og-subset.ttf        : 사람이 검증 가능한 폰트 산출물(D46 "fonts/에 커밋")
//   - pretendard-og-subset.ts         : 런타임 로더(base64 → Uint8Array). workerd/Workers/Node
//                                       어디서나 추가 module rule 없이 import 가능(.ttf 직접 import는
//                                       번들러 rule 의존이라 회피). render.ts가 이 .ts를 import한다.
//
// [결정성] 입력(pretendard TTF)·글리프 집합·subset-font 옵션이 고정이면 출력 바이트도 고정이다.
// KS 완성형 2350자는 Node 내장 ICU의 EUC-KR 디코더로 결정적으로 열거한다(네트워크 0). 이 스크립트는
// 재실행 가능하고, CI가 `git diff --exit-code`로 신선도를 검증할 수 있다.
//
// 사용법: `node tooling/scripts/build-og-fonts.mjs` (또는 pnpm build:og-fonts).

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);
const REPO_ROOT = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, REPO_ROOT));

/** KS X 1001 완성형 한글 2350자를 EUC-KR(0xB0..0xC8 lead, 0xA1..0xFE trail)로 결정적 열거. */
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

/** 카드 렌더에 등장하는 글리프 집합(결정적 정렬 문자열). */
function buildGlyphText() {
  const cps = new Set();
  // ASCII 인쇄 가능 영역(라틴 대소문자·숫자·문장부호·공백).
  for (let cp = 0x20; cp <= 0x7e; cp++) cps.add(cp);
  // 카드에서 쓰는 라틴-1/기호(중점·엔대시·엠대시·곱셈·불릿·비단절 공백).
  for (const cp of [0x00a0, 0x00b7, 0x00d7, 0x2013, 0x2014, 0x2022, 0x2026]) cps.add(cp);
  // KS 완성형 한글.
  for (const cp of ksHangulSyllables()) cps.add(cp);
  return [...cps].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp)).join('');
}

// ─────────────── 정적 폴백 OG PNG(satori 렌더 실패 시 500 회피, docs/06 §9.1) ───────────────
// satori/wasm에 의존하지 않는 순수 PNG(Node zlib). 1200×630 대각 그라디언트(브랜드 라이트,
// WT-UI-09 후속 정합 — og/layout.ts OG_COLORS와 동일 팔레트로 재생성. 이 스크립트는 og/layout.ts를
// import하지 않는 독립 산출 스텝이라(결정성·의존 0 유지) 색은 OG_COLORS 값을 사람이 직접 옮겨
// 적은 리터럴이다 — layout.ts OG_COLORS가 바뀌면 이 값도 같이 갱신해야 한다).
// render 실패·404 셸이 이 바이트를 그대로 응답한다.

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function buildFallbackPng() {
  const W = 1200;
  const H = 630;
  // 브랜드 팔레트(layout.ts OG_COLORS와 동조): bg0=#f4f5ef → bg1=#eceee6 대각 그라디언트,
  // 상단 액센트 바는 route=#0a84ff(tokens.css --accent).
  const c0 = [0xf4, 0xf5, 0xef];
  const c1 = [0xec, 0xee, 0xe6];
  const accent = [0x0a, 0x84, 0xff];
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2; // 0..1 대각
      const i = rowStart + 1 + x * 3;
      raw[i] = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      raw[i + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      raw[i + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    }
  }
  // 상단 액센트 바(브랜드 시그니처).
  for (let y = 0; y < 8; y++) {
    const rowStart = y * (1 + W * 3);
    for (let x = 0; x < W; x++) {
      const i = rowStart + 1 + x * 3;
      raw[i] = accent[0];
      raw[i + 1] = accent[1];
      raw[i + 2] = accent[2];
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeFallbackPng() {
  const png = buildFallbackPng();
  const outDir = p('workers/api/src/og');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(p('workers/api/src/og/fallback-og.png'), png);
  const base64 = Buffer.from(png).toString('base64');
  const ts =
    `// GENERATED by tooling/scripts/build-og-fonts.mjs — 편집 금지(재실행으로만 갱신).\n` +
    `// spec: docs/06 §9.1(렌더 실패·404 셸용 정적 폴백 OG PNG, 500 금지), WT-UI-09 후속(og/layout.ts\n` +
    `// OG_COLORS 라이트 팔레트 정합). 1200×630 브랜드 라이트(크림 배경 대각 그라디언트 + 액센트 바).\n` +
    `const BASE64 =\n  '${base64}';\n\n` +
    `/** 정적 폴백 OG PNG 바이트(satori 비의존). */\n` +
    `export function fallbackOgPng(): Uint8Array {\n` +
    `  const bin = atob(BASE64);\n` +
    `  const bytes = new Uint8Array(bin.length);\n` +
    `  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n` +
    `  return bytes;\n` +
    `}\n`;
  writeFileSync(p('workers/api/src/og/fallback-og.ts'), ts);
  console.log(`[build-og-fonts] wrote fallback-og.png (${(png.byteLength / 1024).toFixed(1)}KB) + fallback-og.ts`);
}

async function main() {
  // pretendard의 package.json exports가 서브패스를 매핑하지 않으므로 패키지 루트에서 상대 경로로
  // 접근한다(subpath require.resolve는 MODULE_NOT_FOUND).
  const pkgDir = dirname(require.resolve('pretendard/package.json'));
  const srcTtf = `${pkgDir}/dist/public/static/alternative/Pretendard-Regular.ttf`;
  const source = readFileSync(srcTtf);
  const text = buildGlyphText();

  // NO_LAYOUT_CLOSURE 등 subset-font 기본 옵션 유지 — GSUB/GPOS는 필요 없다(단순 좌→우 라틴/한글).
  const subset = await subsetFont(source, text, { targetFormat: 'truetype' });

  const outDir = p('workers/api/src/og/fonts');
  mkdirSync(outDir, { recursive: true });

  const ttfPath = p('workers/api/src/og/fonts/pretendard-og-subset.ttf');
  writeFileSync(ttfPath, subset);

  const base64 = Buffer.from(subset).toString('base64');
  const tsPath = p('workers/api/src/og/fonts/pretendard-og-subset.ts');
  const ts =
    `// GENERATED by tooling/scripts/build-og-fonts.mjs — 편집 금지(재실행으로만 갱신).\n` +
    `// spec: docs/00 §11-D46. Pretendard Regular 서브셋(KS 완성형 + 라틴/숫자) TTF의 base64.\n` +
    `// render.ts가 satori 폰트 버퍼로 디코드해 쓴다(.ttf 직접 import의 번들러 rule 의존 회피).\n` +
    `const BASE64 =\n  '${base64}';\n\n` +
    `/** 서브셋 TTF 바이트(런타임 1회 디코드). */\n` +
    `export function pretendardSubsetTtf(): Uint8Array {\n` +
    `  const bin = atob(BASE64);\n` +
    `  const bytes = new Uint8Array(bin.length);\n` +
    `  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n` +
    `  return bytes;\n` +
    `}\n`;
  writeFileSync(tsPath, ts);

  writeFallbackPng();

  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`[build-og-fonts] glyphs: ${[...text].length}`);
  console.log(`[build-og-fonts] wrote ${dirname(ttfPath).replace(fileURLToPath(REPO_ROOT), '')}/pretendard-og-subset.ttf (${kb(subset.byteLength)})`);
  console.log(`[build-og-fonts] wrote pretendard-og-subset.ts (base64 ${kb(base64.length)})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  throw err;
});
