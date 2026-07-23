#!/usr/bin/env node
// spec: docs/03 §8.2(폰트: Pretendard Variable subset + JetBrains Mono latin, preload +
//       font-display:optional), WT-M5-01 세션 특이 조정("폰트 셀프호스트 배선을 이 태스크에서
//       함께 — 실패 시 시스템 폰트 유지").
//
// [범위 — Pretendard는 이번 태스크에서 제외됐다, 최종 보고 escalations 참조]
// npm 레지스트리에서 확인한 두 후보 모두 §8.2 목표(Pretendard Variable subset ~280KB woff2,
// 한글 KS 완성형 2,780자)를 만족하지 못한다:
//   - `pretendard`: PretendardVariable.woff2 전체(미서브셋) 용량이 2.0MB — 예산 대비 7배.
//   - `@fontsource/pretendard`: 배포되는 서브셋이 latin-400-normal뿐(한글 서브셋 파일 자체가
//     없음) — 이 프로덕트의 1순위 언어(한글)에 무용하다.
// 자체 서브셋 파이프라인(fonttools/harfbuzz 등)은 이번 태스크 범위 밖의 새 빌드 도구 도입이라
// 보류하고, index.html의 기존 "시스템 폰트 폴백 유지" 상태를 그대로 둔다(코드 변경 없음).
//
// JetBrains Mono는 `@fontsource/jetbrains-mono`의 latin-{400,700}-normal 서브셋(각 ~24KB로 예산 내)을
// 이 스크립트가 apps/web/public/fonts/에 결정적으로 복사한다(devDependency에서 소스 그대로 — 수정
// 없이 verbatim 카피, "산출물 손편집 금지" 정신과 동일하게 이 스크립트만이 public/fonts/*.woff2의
// 쓰기 주체다). pnpm install 이후 다른 pnpm 버전이 패키지 해시를 바꿔도 이 스크립트가 항상 같은
// 소스에서 다시 복사하므로 재현 가능하다.
//
// [WT-DC-01] 700(Bold) 웨이트를 보강한다 — CPM 다이얼/타이머 숫자를 mono 700으로 렌더하려면
// (globals.css .wt-dial__value·.wt-dashboard__timer-value) 400만으로는 폴백 폰트로 굵어져
// 글자폭이 튄다. globals.css는 이미 @font-face(weight 700, JetBrainsMono-Bold.woff2)를 선언한다.
//
// 실패 시 정책(작업 특이 조정 원문 "실패 시 시스템 폰트 유지하고 notes 기재"): 소스 패키지를
// 찾지 못하면 throw하지 않고 경고만 남기고 0으로 종료한다 — index.html/globals.css는 이미
// 시스템 폰트 스택을 기본으로 폴백하도록 작성돼 있어(§8.1) 폰트 파일 부재가 빌드를 막을 이유가
// 없다.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const FONTS_SRC_DIR = path.join(
  REPO_ROOT,
  'apps/web/node_modules/@fontsource/jetbrains-mono/files',
);
const OUT_DIR = path.join(REPO_ROOT, 'apps/web/public/fonts');

// [weight, 소스 파일, 산출 파일] — verbatim 카피 대상. 웨이트 추가 시 이 표에 한 줄만 더한다.
const FONTS = [
  ['400', 'jetbrains-mono-latin-400-normal.woff2', 'JetBrainsMono-Regular.woff2'],
  ['700', 'jetbrains-mono-latin-700-normal.woff2', 'JetBrainsMono-Bold.woff2'],
];

mkdirSync(OUT_DIR, { recursive: true });

for (const [weight, srcName, outName] of FONTS) {
  const source = path.join(FONTS_SRC_DIR, srcName);
  const outFile = path.join(OUT_DIR, outName);
  if (!existsSync(source)) {
    // 실패 시 정책(위 헤더): throw하지 않고 경고만 — 폰트 파일 부재는 시스템 폰트 스택으로 폴백된다.
    console.warn(
      `[copy-fonts] @fontsource/jetbrains-mono ${weight} 소스를 찾지 못했다(${source}) — ` +
        '시스템 폰트 스택 폴백 유지, 빌드는 계속 진행한다.',
    );
    continue;
  }
  copyFileSync(source, outFile);
  console.log(`[copy-fonts] JetBrains Mono ${weight} self-host 자산 갱신: ${path.relative(REPO_ROOT, outFile)}`);
}
