// spec: docs/03 §5.4 (리플레이 로그 — RunLog ring buffer 최대 20k), docs/06 §3.2 (RunSubmission),
//       docs/06 §3.4 (inputDigest 간격 통계 {n,mean,stdev,p10,p50,p90,burstMax}),
//       docs/07 WT-M2-02 지시 6.
//
// 모든 TypingEvent + 상대 타임스탬프(플레이 시작 기준)를 고정 용량 순환 버퍼에 축적한다.
// 이 로그는 랭킹 제출 페이로드(06)와 고스트 모드 재생 데이터의 공통 원천이다.
// toSubmissionPayload()가 perCountry 배열 + inputDigest 문자열을 조립한다.
import type { TypingEvent } from './input-controller';

/** ring buffer 최대 엔트리(docs/03 §5.4). 초과분은 가장 오래된 것부터 덮어쓴다. */
export const RUN_LOG_CAPACITY = 20_000;

export interface ReplayEntry {
  readonly event: TypingEvent;
  /** 플레이 시작(카운트다운 종료) 기준 상대 시각(ms). */
  readonly tRelMs: number;
  /** 이 이벤트로 늘어난 자모/문자 수. 비타건 이벤트(blur/bulk/skip 등)는 0. */
  readonly added: number;
}

/** docs/06 §3.4 키 간격 통계 요약. 원시 타임스탬프 대신 이 요약만 서버로 전송한다. */
export interface InputDigest {
  /** 간격 표본 수(= 타건 이벤트 수 − 1, 음수 방지 0 하한). */
  n: number;
  mean: number;
  stdev: number;
  p10: number;
  p50: number;
  p90: number;
  /** 단일 이벤트 최대 삽입 자모/문자 수. 벌크 삽입(§3.4 burstMax>3) 교차 검증용. */
  burstMax: number;
}

/** docs/06 §3.2 perCountry 요소. keystrokes = 정타+오타(ko는 자모 단위). */
export interface SubmissionCountry {
  code: string;
  ms: number;
  keystrokes: number;
  errors: number;
  skipped: boolean;
}

/** docs/06 §3.2 RunSubmission. token은 제출 직전 세션 계층이 채운다(엔진은 원천만 조립). */
export interface RunSubmission {
  token: string;
  perCountry: SubmissionCountry[];
  inputDigest: string;
}

/**
 * 고정 용량 순환 버퍼. count < cap 동안은 단순 push, 가득 차면 head를 옮기며 덮어쓴다.
 * shift() O(n)을 피하기 위한 진짜 ring buffer 구현.
 */
export class RunLog {
  private buf: ReplayEntry[] = [];
  private head = 0; // 가장 오래된 엔트리의 인덱스(가득 찬 상태에서만 의미)
  private count = 0;

  append(event: TypingEvent, tRelMs: number, added: number): void {
    const entry: ReplayEntry = { event, tRelMs, added };
    if (this.count < RUN_LOG_CAPACITY) {
      this.buf.push(entry);
      this.count++;
    } else {
      this.buf[this.head] = entry;
      this.head = (this.head + 1) % RUN_LOG_CAPACITY;
    }
  }

  reset(): void {
    this.buf = [];
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** 축적 순서대로 엔트리를 반환(순환 버퍼가 가득 찬 경우 head부터 재배열). */
  entries(): ReplayEntry[] {
    if (this.count < RUN_LOG_CAPACITY) return this.buf.slice();
    const out: ReplayEntry[] = [];
    for (let i = 0; i < RUN_LOG_CAPACITY; i++) {
      out.push(this.buf[(this.head + i) % RUN_LOG_CAPACITY]!);
    }
    return out;
  }

  /** docs/06 §3.4 간격 통계. 타건 이벤트(added>0)만으로 간격을 산출한다(백스페이스 progress 제외). */
  computeDigest(): InputDigest {
    const times: number[] = [];
    let burstMax = 0;
    for (const e of this.entries()) {
      if (e.added > 0) {
        times.push(e.tRelMs);
        if (e.added > burstMax) burstMax = e.added;
      }
    }
    const intervals: number[] = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i]! - times[i - 1]!);
    const n = intervals.length;
    if (n === 0) {
      return { n: 0, mean: 0, stdev: 0, p10: 0, p50: 0, p90: 0, burstMax };
    }
    let sum = 0;
    for (const v of intervals) sum += v;
    const mean = sum / n;
    let variance = 0;
    for (const v of intervals) variance += (v - mean) ** 2;
    const stdev = Math.sqrt(variance / n);
    const sorted = [...intervals].sort((a, b) => a - b);
    return {
      n,
      mean,
      stdev,
      p10: percentile(sorted, 0.1),
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      burstMax,
    };
  }

  /**
   * docs/06 §3.2 RunSubmission 조립. perCountry는 세션 엔진이 확정한 국가별 기록(keystrokes 포함),
   * token은 제출 계층이 주입한다. inputDigest는 이 로그의 간격 통계를 직렬화한 문자열.
   */
  toSubmissionPayload(perCountry: SubmissionCountry[], token: string): RunSubmission {
    return {
      token,
      perCountry: perCountry.map((p) => ({ ...p })),
      inputDigest: JSON.stringify(this.computeDigest()),
    };
  }
}

/**
 * 정렬된 비어있지 않은 배열의 선형 보간 백분위(q: 0~1).
 * computeDigest가 n===0(간격 없음)을 먼저 걸러내므로 여기 도달할 때 sorted.length>=1이 보장된다.
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
