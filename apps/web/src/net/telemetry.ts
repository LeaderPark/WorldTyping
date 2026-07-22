// spec: docs/06 §5.2(클라 전용 이벤트는 POST /api/t 단일 수집 엔드포인트로 배칭(10개/5초) 전송,
//       share_click은 서버 히트 + 클라 공유 버튼 양쪽), docs/03 §8.6(전역 리포터 —
//       window.onerror/unhandledrejection, 자체 경량 리포터 POST /api/telemetry/error,
//       샘플링 10%, 인터페이스 reportError(e, ctx) 추상화 — 실제 엔드포인트는 §5.2의 단일
//       배칭 경로 /api/v1/t로 합류한다, WT-M6-03), docs/00 §11-D25
//
// 클라 배칭 큐: 10개 쌓이거나 5초가 지나면 flush. 실패(오프라인 등)해도 조용히 드롭한다 —
// 텔레메트리는 부가 채널이라 재시도/영속 큐(net/pending-queue.ts)의 신뢰성 계약을 여기까지
// 확장하지 않는다(배치 유실은 허용, docs/06 §5.2 "핵심 지표는 서버 트리거라 무손실"의 반대급부).
import { apiClient } from './api-client';

export type ClientTelemetryEvent =
  | { type: 'client_error'; ts: number; message: string; stack?: string }
  | { type: 'share_click'; ts: number; referrerHost?: string; utmSource?: string };

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;
/** docs/03 §8.6 "샘플링 10%" — client_error에만 적용(share_click은 표본이 아니라 실카운트가
 *  목적이라 샘플링하지 않는다). */
const ERROR_SAMPLE_RATE = 0.1;
const MAX_MESSAGE_LEN = 500;
const MAX_STACK_LEN = 2000;

let queue: ClientTelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let errorHooksRegistered = false;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    await apiClient.post('/t', { events: batch });
  } catch (err) {
    // 오프라인/서버 오류 — 배치를 버린다(위 파일 상단 주석: 텔레메트리는 유실 허용 채널).
    console.warn('[telemetry] flush 실패(배치 드롭):', err);
  }
  if (queue.length > 0) scheduleFlush();
}

function enqueue(ev: ClientTelemetryEvent): void {
  queue.push(ev);
  if (queue.length >= BATCH_SIZE) void flush();
  else scheduleFlush();
}

/** share_click(클라 버튼 경로) — ShareCard의 각 공유 액션에서 호출. */
export function trackShareClick(opts: { referrerHost?: string; utmSource?: string } = {}): void {
  enqueue({ type: 'share_click', ts: Date.now(), ...opts });
}

function reportError(message: string, stack: string | undefined): void {
  if (Math.random() >= ERROR_SAMPLE_RATE) return;
  enqueue({
    type: 'client_error',
    ts: Date.now(),
    message: message.slice(0, MAX_MESSAGE_LEN),
    stack: stack?.slice(0, MAX_STACK_LEN),
  });
}

/** docs/03 §8.6 "reportError(e, ctx)" 추상화 — GameErrorBoundary 등에서 직접 호출 가능. */
export function reportClientError(err: unknown, ctx?: string): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  reportError(ctx ? `[${ctx}] ${message}` : message, stack);
}

/**
 * window.onerror/unhandledrejection 전역 연결(docs/03 §8.6). 앱 부팅 시 1회만 등록(멱등).
 */
export function registerGlobalErrorReporter(): void {
  if (errorHooksRegistered || typeof window === 'undefined') return;
  errorHooksRegistered = true;
  window.addEventListener('error', (e) => {
    reportError(e.message || 'window.onerror', e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportError(message, stack);
  });
}

/** 테스트 전용: 큐/타이머/등록 플래그를 리셋한다. */
export function __resetTelemetryForTests(): void {
  queue = [];
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  errorHooksRegistered = false;
}
