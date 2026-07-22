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
// JetBrains Mono는 `@fontsource/jetbrains-mono`의 latin-400-normal 서브셋이 24KB로 예산 내라
// 이 스크립트가 그 파일 하나만 apps/web/public/fonts/에 결정적으로 복사한다(devDependency에서
// 소스 그대로 — 수정 없이 verbatim 카피, "산출물 손편집 금지" 정신과 동일하게 이 스크립트만이
// public/fonts/*.woff2의 쓰기 주체다). pnpm install 이후 다른 pnpm 버전이 패키지 해시를 바꿔도
// 이 스크립트가 항상 같은 소스에서 다시 복사하므로 재현 가능하다.
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

const SOURCE = path.join(
  REPO_ROOT,
  'apps/web/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
);
const OUT_DIR = path.join(REPO_ROOT, 'apps/web/public/fonts');
const OUT_FILE = path.join(OUT_DIR, 'JetBrainsMono-Regular.woff2');

if (!existsSync(SOURCE)) {
  console.warn(
    `[copy-fonts] @fontsource/jetbrains-mono 소스를 찾지 못했다(${SOURCE}) — ` +
      '시스템 폰트 스택 폴백 유지, 빌드는 계속 진행한다.',
  );
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(SOURCE, OUT_FILE);
console.log(`[copy-fonts] JetBrains Mono self-host 자산 갱신: ${path.relative(REPO_ROOT, OUT_FILE)}`);
