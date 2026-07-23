// spec: docs/00 §11-D64(국기 SVG 자산 — flag-icons 4x3 중 수록 국가 id 집합만 public/flags로 복사),
//       CLAUDE.md "국가 데이터 추가/갱신"(결정적 출력 · git diff 신선도 검사). WT-UI-03.
//
// packages/data/src/generated/countries.ts의 id(ISO2) 집합을 정렬 순회하며 flag-icons(devDep, MIT,
// 4x3 종횡비)의 {cc}.svg를 apps/web/public/flags/{cc}.svg로 그대로 복사한다. 런타임 네트워크 없음:
// 앱은 이 커밋된 정적 자산만 로드하고, 없으면 FlagIcon이 flagEmoji로 폴백한다. 출력은 결정적이어야
// 하며(CI가 `node tooling/scripts/build-flags.mjs && git diff --exit-code apps/web/public/flags`로
// 검사), 그래서 (1) id를 정렬해 순회하고 (2) 대상 집합에 없는 기존 .svg는 제거해 디렉터리를 대상
// 집합과 정확히 일치시킨다. 라이선스 고지는 CreditsPage(WT-UI-09)가 추가한다.
import { readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GENERATED = join(ROOT, 'packages/data/src/generated/countries.ts');
const FLAG_SRC_DIR = join(ROOT, 'node_modules/flag-icons/flags/4x3');
const OUT_DIR = join(ROOT, 'apps/web/public/flags');

function readCountryIds() {
  const src = readFileSync(GENERATED, 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/"id":\s*"([A-Z0-9]{2})"/g)) ids.add(m[1]);
  return [...ids].sort(); // 결정적 순회
}

function main() {
  if (!existsSync(FLAG_SRC_DIR)) {
    console.error(
      `[build-flags] flag-icons 자산을 찾지 못했습니다: ${FLAG_SRC_DIR}\n` +
        `devDependency 'flag-icons'가 설치돼 있어야 합니다 (pnpm add -D flag-icons).`,
    );
    process.exit(1);
  }

  const ids = readCountryIds();
  const want = new Set(ids.map((id) => `${id.toLowerCase()}.svg`));

  mkdirSync(OUT_DIR, { recursive: true });

  // 대상 집합에 없는 기존 .svg 제거(디렉터리를 대상과 정확히 일치 → git diff 결정성).
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.svg') && !want.has(f)) rmSync(join(OUT_DIR, f));
  }

  const missing = [];
  let copied = 0;
  for (const id of ids) {
    const name = `${id.toLowerCase()}.svg`;
    const from = join(FLAG_SRC_DIR, name);
    if (!existsSync(from)) {
      missing.push(id);
      continue;
    }
    copyFileSync(from, join(OUT_DIR, name)); // 원본 바이트 그대로 복사(결정적)
    copied += 1;
  }

  console.log(`[build-flags] ${copied}/${ids.length}개 국기 SVG를 apps/web/public/flags로 복사했습니다.`);
  if (missing.length > 0) {
    // 실패가 아니라 경고: 해당 국가는 런타임에 flagEmoji로 폴백된다(FlagIcon onError).
    console.warn(`[build-flags] flag-icons에 없는 id(${missing.length}): ${missing.join(', ')}`);
  }
}

main();
