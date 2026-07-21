// spec: docs/06 §4.2 (필터 파이프라인 전문), docs/04 §10.2(예약어), docs/00 §11-D14
// [WT-M3-05 리팩터] 순수 판정 로직(전처리·매칭 파이프라인)은 ./engine.ts로 이관했다. 이 파일은
// Node 전용 진입점으로 남는다: 저장소에 커밋된 badwords/allowwords .txt를 node:fs로 읽어 기본
// 인스턴스를 만들고, 기존 free-function API(evaluateText/isNicknameAllowed/filterChat/
// buildMatchChannels)를 그대로 유지한다 — 이 패키지를 이미 쓰고 있는 코드(닉네임 route 등)와
// 기존 vitest 스위트가 무변경으로 계속 동작해야 하기 때문이다.
//
// Workers 번들(workers/api)은 이 파일을 import하면 안 된다 — 모듈 최상위에서 node:fs가 즉시
// 실행되어(readFileSync) 파일시스템이 없는 Workers 런타임의 콜드스타트를 깨뜨린다. 대신
// engine.ts의 createFilter(...)에 빌드타임 스냅샷 배열을 직접 주입해서 쓴다(구현 세부 지시 5).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFilter, buildMatchChannels } from './engine';
import type { ChatFilterResult, FilterResult, MatchChannels } from './engine';

export { buildMatchChannels };
export type { MatchChannels, FilterResult, ChatFilterResult };

const PACKAGE_ROOT = new URL('../', import.meta.url);

function loadWordlist(relPath: string): string[] {
  const abs = fileURLToPath(new URL(relPath, PACKAGE_ROOT));
  const raw = readFileSync(abs, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const DEFAULT_FILTER = createFilter({
  ko: loadWordlist('badwords.ko.txt'),
  en: loadWordlist('badwords.en.txt'),
  allow: loadWordlist('allowwords.en.txt'),
});

/**
 * 닉네임·채팅 공용 판정 로직. NICK_RE 형식 검사는 포함하지 않는다(자유 형식 채팅 텍스트도
 * 통과시켜야 하므로) — 닉네임에 대한 형식 검사는 isNicknameAllowed에서 별도로 수행한다.
 */
export function evaluateText(text: string): FilterResult {
  return DEFAULT_FILTER.evaluateText(text);
}

/**
 * 닉네임 허용 여부. 형식(NICK_RE)은 호출부(nickname.ts 사용처)가 별도로 검사하지 않는 경우를
 * 대비해 이 함수 안에서도 정의를 재-import하지 않고 형식 검사를 생략한다 — 형식은 docs/06 §4.2
 * NICK_RE의 책임이고, 이 함수는 "형식이 유효하다는 전제 하의 콘텐츠 판정"만 맡는다.
 * 형식까지 함께 검사하려면 nickname.ts의 NICK_RE.test(name)를 먼저 호출할 것.
 */
export function isNicknameAllowed(name: string): boolean {
  return DEFAULT_FILTER.isNicknameAllowed(name);
}

/** 멀티 방 채팅(docs/05) 필터. 닉네임과 동일한 evaluateText를 재사용한다(로직 이중화 금지). */
export function filterChat(text: string): ChatFilterResult {
  return DEFAULT_FILTER.filterChat(text);
}
