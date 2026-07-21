// spec: docs/06 §4.2 (필터 파이프라인 전문), docs/04 §10.2(예약어), docs/00 §11-D14
//
// 파이프라인(docs/06 §4.2, 순서 고정):
//   lowercase → leet 치환(1→i,0→o,3→e,5→s,@→a,$→s) → 구분자(_,-,공백) 제거 →
//   한글은 @wt/shared의 toJamoSeq로 자모 분해 후 자모열 부분 문자열 매칭 →
//   en allowlist 예외(Scunthorpe 문제) → 예약어 프리픽스 차단
//
// 자모 분해는 재구현하지 않고 @wt/shared toJamoSeq를 그대로 재사용한다(문자 단위 호출).
// "ㅅ1ㅂ"·"시-발" 같은 우회 표기가 걸리는 이유: 두 입력 모두 이 파이프라인을 거치면
// 한글 자모만 남긴 "ko 채널"에서 동일한 자모열로 수렴하기 때문이다(비한글 문자는 ko 채널에서
// 탈락). 사전 단어도 로드 시 동일 파이프라인을 통과시켜 자모열로 비교하므로 이중 구현이 없다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toJamoSeq } from '@wt/shared';

const PACKAGE_ROOT = new URL('../', import.meta.url);

function loadWordlist(relPath: string): string[] {
  const abs = fileURLToPath(new URL(relPath, PACKAGE_ROOT));
  const raw = readFileSync(abs, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** leet 치환 테이블(docs/06 §4.2 전문 — 임의 확장 금지, 과잉 차단 방지). */
const LEET: Readonly<Record<string, string>> = {
  '1': 'i',
  '0': 'o',
  '3': 'e',
  '5': 's',
  '@': 'a',
  $: 's',
};

/** 제거 대상 구분자(밑줄·하이픈) — 공백은 별도의 \s 검사로 함께 제거한다. */
const SEPARATORS = new Set(['_', '-']);

/** 한글 자모(호환 자모 블록, U+3131–U+318E) 여부 — ko 채널에 남길 문자를 가른다. */
function isHangulJamo(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code >= 0x3131 && code <= 0x318e;
}

export interface MatchChannels {
  /** lowercase→leet→구분자 제거→(비한글 통과) toJamoSeq 적용 결과. en 매칭에 쓴다. */
  full: string;
  /** full에서 한글 자모만 남긴 부분열. ko 매칭에 쓴다(우회 문자 삽입을 무력화). */
  ko: string;
  /** full[i]가 유래한 원본 문자열의 코드포인트 인덱스. */
  fullMap: number[];
  /** ko[i]가 유래한 원본 문자열의 코드포인트 인덱스. */
  koMap: number[];
}

/**
 * docs/06 §4.2 파이프라인을 적용해 매칭용 두 채널(full/ko)과 원본 인덱스 역매핑을 만든다.
 * 사전 단어(badwords/allowlist)도 로드 시 동일 함수를 통과시켜 채널 문자열만 비교에 쓴다.
 */
export function buildMatchChannels(text: string): MatchChannels {
  const full: string[] = [];
  const ko: string[] = [];
  const fullMap: number[] = [];
  const koMap: number[] = [];

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const raw = chars[i]!;
    if (/\s/u.test(raw)) continue; // 공백 제거
    const lower = raw.toLowerCase();
    if (SEPARATORS.has(lower)) continue; // 구분자(_,-) 제거
    const substituted = LEET[lower] ?? lower;
    const jamoOut = toJamoSeq(substituted); // @wt/shared 재사용 — 재구현 금지
    for (const c of jamoOut) {
      full.push(c);
      fullMap.push(i);
      if (isHangulJamo(c)) {
        ko.push(c);
        koMap.push(i);
      }
    }
  }

  return { full: full.join(''), ko: ko.join(''), fullMap, koMap };
}

function processedList(words: string[]): { full: string; ko: string }[] {
  return words
    .map((w) => buildMatchChannels(w))
    .filter((c) => c.full.length > 0)
    .map((c) => ({ full: c.full, ko: c.ko }));
}

const KO_BADWORDS = processedList(loadWordlist('badwords.ko.txt'));
const EN_BADWORDS = processedList(loadWordlist('badwords.en.txt'));
const EN_ALLOWLIST = processedList(loadWordlist('allowwords.en.txt'));

/** docs/04 §10.2 / docs/06 §4.2 예약어 프리픽스(시스템 전용 — GUEST_는 리터럴 프리픽스). */
const RESERVED_PREFIXES = [
  'admin',
  'mod',
  'staff',
  'system',
  '운영자',
  '관리자',
  'worldtyping',
  'typetrip',
  'official',
];

function hasReservedPrefix(text: string): boolean {
  if (text.toLowerCase().startsWith('guest_')) return true;
  const { full } = buildMatchChannels(text);
  return RESERVED_PREFIXES.some((w) => {
    const processed = buildMatchChannels(w).full;
    return processed.length > 0 && full.startsWith(processed);
  });
}

/** [start,end) 구간이 en allowlist 단어 하나에 완전히 포함되면 오차단(Scunthorpe 문제)으로 본다. */
function isAllowlisted(channel: string, start: number, end: number): boolean {
  for (const { full: word } of EN_ALLOWLIST) {
    let idx = channel.indexOf(word);
    while (idx !== -1) {
      if (idx <= start && idx + word.length >= end) return true;
      idx = channel.indexOf(word, idx + 1);
    }
  }
  return false;
}

export interface FilterResult {
  blocked: boolean;
  reason?: 'reserved' | 'badword';
  /** 원본 문자열(코드포인트 인덱스) 기준 매치 구간 [start, end] — 마스킹용. */
  span?: [number, number];
}

/**
 * 닉네임·채팅 공용 판정 로직. NICK_RE 형식 검사는 포함하지 않는다(자유 형식 채팅 텍스트도
 * 통과시켜야 하므로) — 닉네임에 대한 형식 검사는 isNicknameAllowed에서 별도로 수행한다.
 */
export function evaluateText(text: string): FilterResult {
  if (hasReservedPrefix(text)) return { blocked: true, reason: 'reserved' };

  const channels = buildMatchChannels(text);

  for (const { ko: bw } of KO_BADWORDS) {
    if (!bw) continue;
    const idx = channels.ko.indexOf(bw);
    if (idx !== -1) {
      const start = channels.koMap[idx]!;
      const end = channels.koMap[idx + bw.length - 1]!;
      return { blocked: true, reason: 'badword', span: [Math.min(start, end), Math.max(start, end)] };
    }
  }

  for (const { full: bw } of EN_BADWORDS) {
    if (!bw) continue;
    let idx = channels.full.indexOf(bw);
    while (idx !== -1) {
      const matchEnd = idx + bw.length;
      if (!isAllowlisted(channels.full, idx, matchEnd)) {
        const start = channels.fullMap[idx]!;
        const stop = channels.fullMap[matchEnd - 1]!;
        return {
          blocked: true,
          reason: 'badword',
          span: [Math.min(start, stop), Math.max(start, stop)],
        };
      }
      idx = channels.full.indexOf(bw, idx + 1);
    }
  }

  return { blocked: false };
}

/**
 * 닉네임 허용 여부. 형식(NICK_RE)은 호출부(nickname.ts 사용처)가 별도로 검사하지 않는 경우를
 * 대비해 이 함수 안에서도 정의를 재-import하지 않고 형식 검사를 생략한다 — 형식은 docs/06 §4.2
 * NICK_RE의 책임이고, 이 함수는 "형식이 유효하다는 전제 하의 콘텐츠 판정"만 맡는다.
 * 형식까지 함께 검사하려면 nickname.ts의 NICK_RE.test(name)를 먼저 호출할 것.
 */
export function isNicknameAllowed(name: string): boolean {
  return !evaluateText(name).blocked;
}

export interface ChatFilterResult {
  blocked: boolean;
  /** 차단된 경우 첫 매치 구간을 '*'로 마스킹한 텍스트. 통과 시 원문과 동일. */
  masked: string;
}

/** 멀티 방 채팅(docs/05) 필터. 닉네임과 동일한 evaluateText를 재사용한다(로직 이중화 금지). */
export function filterChat(text: string): ChatFilterResult {
  const result = evaluateText(text);
  if (!result.blocked || !result.span) {
    return { blocked: result.blocked, masked: text };
  }
  const [start, end] = result.span;
  const chars = Array.from(text);
  for (let i = start; i <= end && i < chars.length; i += 1) chars[i] = '*';
  return { blocked: true, masked: chars.join('') };
}
