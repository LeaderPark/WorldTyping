// spec: docs/06 §4.2 (필터 파이프라인 전문), docs/04 §10.2(예약어), docs/00 §11-D14 + WT-M3-05
// [작업 특이 조정 5] 로더 주입형 리팩터 — 이 파일은 순수 엔진(단어 배열을 파라미터로 받는다)이고
// node:fs를 포함해 어떤 파일시스템 접근도 하지 않는다. Workers 번들(workers/api)은 이 파일만
// import해 빌드타임 스냅샷 배열을 주입한다 — filter.ts(Node 전용, node:fs로 저장소 .txt 로드)를
// import하면 모듈 최상위에서 즉시 readFileSync가 실행되어 Workers 런타임(파일시스템 없음)에서
// 콜드스타트 자체가 깨진다. 그래서 "순수 엔진(여기)"과 "Node 기본 로더(filter.ts)"를 파일 단위로
// 분리했다 — 어느 한쪽만 import해도 반대쪽의 로딩 방식이 딸려오지 않는다.
//
// 파이프라인(docs/06 §4.2, 순서 고정):
//   lowercase → leet 치환(1→i,0→o,3→e,5→s,@→a,$→s) → 구분자(_,-,공백) 제거 →
//   한글은 @wt/shared의 toJamoSeq로 자모 분해 후 자모열 부분 문자열 매칭 →
//   en allowlist 예외(Scunthorpe 문제) → 예약어 프리픽스 차단
//
// 자모 분해는 재구현하지 않고 @wt/shared toJamoSeq를 그대로 재사용한다(문자 단위 호출).

import { toJamoSeq } from '@wt/shared';

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

function processedList(words: readonly string[]): { full: string; ko: string }[] {
  return words
    .map((w) => buildMatchChannels(w))
    .filter((c) => c.full.length > 0)
    .map((c) => ({ full: c.full, ko: c.ko }));
}

/** docs/04 §10.2 / docs/06 §4.2 예약어 프리픽스(시스템 전용 — GUEST_는 리터럴 프리픽스). 단어
 * 목록과 달리 정책 상수라 lists 주입 대상이 아니다(양쪽 런타임에서 항상 동일해야 함). */
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

export interface FilterResult {
  blocked: boolean;
  reason?: 'reserved' | 'badword';
  /** 원본 문자열(코드포인트 인덱스) 기준 매치 구간 [start, end] — 마스킹용. */
  span?: [number, number];
}

export interface ChatFilterResult {
  blocked: boolean;
  /** 차단된 경우 첫 매치 구간을 '*'로 마스킹한 텍스트. 통과 시 원문과 동일. */
  masked: string;
}

/** createFilter에 주입할 원본(미가공) 단어 배열 3종. */
export interface WordLists {
  /** badwords.ko.txt 상당 — 한글 비속어(자모열로 매칭). */
  ko: readonly string[];
  /** badwords.en.txt 상당 — 영문 비속어(전체 문자열로 매칭). */
  en: readonly string[];
  /** allowwords.en.txt 상당 — en 오차단 예외(Scunthorpe 문제, 부분 포함 시 예외). */
  allow: readonly string[];
}

export interface FilterEngine {
  /** 닉네임·채팅 공용 판정. NICK_RE 형식 검사는 포함하지 않는다(별도 책임 — nickname.ts). */
  evaluateText(text: string): FilterResult;
  /** 닉네임 허용 여부(형식은 이미 유효하다는 전제). */
  isNicknameAllowed(name: string): boolean;
  /** 멀티 방 채팅 필터 — evaluateText와 동일 판정, 마스킹까지 수행. */
  filterChat(text: string): ChatFilterResult;
}

/**
 * 순수 필터 엔진 생성. lists는 이미 로드된 단어 배열(원문 그대로, 전처리는 내부에서 수행)이어야
 * 한다 — 로딩 방식(node:fs 파일 읽기, 빌드타임 스냅샷 상수 등)은 호출자 책임이다.
 */
export function createFilter(lists: WordLists): FilterEngine {
  const koBadwords = processedList(lists.ko);
  const enBadwords = processedList(lists.en);
  const enAllowlist = processedList(lists.allow);

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
    for (const { full: word } of enAllowlist) {
      let idx = channel.indexOf(word);
      while (idx !== -1) {
        if (idx <= start && idx + word.length >= end) return true;
        idx = channel.indexOf(word, idx + 1);
      }
    }
    return false;
  }

  function evaluateText(text: string): FilterResult {
    if (hasReservedPrefix(text)) return { blocked: true, reason: 'reserved' };

    const channels = buildMatchChannels(text);

    for (const { ko: bw } of koBadwords) {
      if (!bw) continue;
      const idx = channels.ko.indexOf(bw);
      if (idx !== -1) {
        const start = channels.koMap[idx]!;
        const end = channels.koMap[idx + bw.length - 1]!;
        return { blocked: true, reason: 'badword', span: [Math.min(start, end), Math.max(start, end)] };
      }
    }

    for (const { full: bw } of enBadwords) {
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

  function isNicknameAllowed(name: string): boolean {
    return !evaluateText(name).blocked;
  }

  function filterChat(text: string): ChatFilterResult {
    const result = evaluateText(text);
    if (!result.blocked || !result.span) {
      return { blocked: result.blocked, masked: text };
    }
    const [start, end] = result.span;
    const chars = Array.from(text);
    for (let i = start; i <= end && i < chars.length; i += 1) chars[i] = '*';
    return { blocked: true, masked: chars.join('') };
  }

  return { evaluateText, isNicknameAllowed, filterChat };
}
