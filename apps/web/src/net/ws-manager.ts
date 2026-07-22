// spec: docs/05 §4.1(프레임·seq 규약)·§7.2(재접속 백오프)·§13-F7(4426 DATA_VERSION),
//       docs/03 §6.1(연결 관리자 시그니처·pagehide close(1000))·§6.6(서버 권위),
//       docs/00 §11-D7(프로토콜은 shared 단일 원천)·D8(/ws/room/:code), WT-M4-03
//
// 표준 WebSocket 위의 얇은 연결 관리자: 상태머신 · 지수 백오프 재연결 · open 전 송신 큐 ·
// 클라 단조 seq 스탬핑 · 수신 프레임 zod 파싱(폐기형). socket.io류 금지(WT-M4-03 제약).
// React/DOM 비의존 — WebSocket 생성자를 주입 가능하게 두어(테스트 목) 노드 환경에서도 단위
// 테스트가 돈다. 고빈도 값(진행/입력)은 이 계층을 지나지만 React state에 싣지 않는다(race-client가
// 명령형으로 소비 — docs/03 §4.5).
import type { ClientMessage } from '@wt/shared';
import { parseServerMessage } from './server-messages';
import type { ServerMessage } from '@wt/shared';

/** 연결 상태(멀티 스토어 connection 필드와 동일 열거). */
export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

/** seq는 send()가 스탬핑하므로 호출측은 seq를 뺀 초안을 넘긴다(분배적 Omit). */
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ClientMessageDraft = DistOmit<ClientMessage, 'seq'>;

/** 테스트 주입용 최소 WebSocket 인터페이스(표준 WebSocket이 구조적으로 만족). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
}

export interface WsManagerOptions {
  /** WebSocket 팩토리(기본: 표준 전역 WebSocket). 테스트는 목을 주입한다. */
  createSocket?: (url: string) => WebSocketLike;
}

/** 재연결 백오프: 0.5s→1s→2s→4s→8s(상한), 최대 5회(§7.2, WT-M4-03). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 5;
/** open 전 송신 큐 상한. 초과 시 가장 오래된 것부터 폐기(docs/03 §6.1). */
const SEND_QUEUE_MAX = 32;
/** 정상 종료(재연결 안 함). */
const CLOSE_NORMAL = 1000;

export function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export class WsManager {
  private state: ConnState = 'idle';
  private socket: WebSocketLike | null = null;
  private url: string | null = null;
  private attempt = 0;
  private seqCounter = 0;
  private manualClose = false;
  private readonly sendQueue: ClientMessage[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly messageListeners = new Set<(m: ServerMessage) => void>();
  private readonly stateListeners = new Set<(s: ConnState) => void>();
  private readonly closeListeners = new Set<(code: number, reason?: string) => void>();

  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly pagehideHandler = () => this.close(CLOSE_NORMAL);

  constructor(opts: WsManagerOptions = {}) {
    this.createSocket =
      opts.createSocket ??
      // 표준 WebSocket을 구조적 최소 인터페이스로 취급(any 미사용, 이유 주석). 브라우저 전용 경로.
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  }

  getState(): ConnState {
    return this.state;
  }

  connect(url: string): void {
    this.url = url;
    this.manualClose = false;
    this.attempt = 0;
    this.registerPagehide();
    this.open();
  }

  /** open이면 즉시 전송, 아니면 큐잉. 스탬핑한 seq를 반환(accepted/rejected ack 상관용). */
  send(draft: ClientMessageDraft): number {
    const seq = ++this.seqCounter;
    const msg = { ...draft, seq } as ClientMessage;
    if (this.socket && this.state === 'open') {
      this.socket.send(JSON.stringify(msg));
    } else {
      this.sendQueue.push(msg);
      // 상한 초과 시 가장 오래된 것 폐기(§6.1). hello 유실 방지를 위해 useMultiplayer는 open
      // 직후에만 대량 전송하지 않는다 — 정상 경로에서 큐가 32를 넘지 않는다.
      while (this.sendQueue.length > SEND_QUEUE_MAX) this.sendQueue.shift();
    }
    return seq;
  }

  /** 정상 종료(코드 1000 기본) — 재연결하지 않는다. */
  close(code: number = CLOSE_NORMAL, reason?: string): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.unregisterPagehide();
    const s = this.socket;
    this.socket = null;
    if (s) {
      this.detachSocket(s);
      try {
        s.close(code, reason);
      } catch {
        /* 이미 닫힌 소켓 close는 무시 */
      }
    }
    this.setState('idle');
  }

  onMessage(f: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(f);
    return () => this.messageListeners.delete(f);
  }

  onStateChange(f: (s: ConnState) => void): () => void {
    this.stateListeners.add(f);
    return () => this.stateListeners.delete(f);
  }

  /** 종료 코드 통지(4426 DATA_VERSION 리로드, 4001 superseded, AUTH_FAILED 등 상위 처리용). */
  onClose(f: (code: number, reason?: string) => void): () => void {
    this.closeListeners.add(f);
    return () => this.closeListeners.delete(f);
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private open(): void {
    if (!this.url) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const sock = this.createSocket(this.url);
    this.socket = sock;
    sock.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      this.flushQueue();
    };
    sock.onmessage = (ev) => this.onFrame(ev.data);
    sock.onerror = () => {
      // error는 통상 close를 동반한다 — 여기서 별도 재연결 트리거하지 않고 close 경로에 맡긴다.
    };
    sock.onclose = (ev) => this.onSocketClose(ev.code, ev.reason);
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string') return; // 바이너리 프레임은 프로토콜상 없음 — 폐기
    const parsed = parseServerMessage(data);
    if (!parsed.ok) return; // 스키마 위반/파싱 불가 프레임은 조용히 폐기(§4.1)
    for (const f of this.messageListeners) f(parsed.data);
  }

  private onSocketClose(code: number, reason?: string): void {
    const s = this.socket;
    if (s) this.detachSocket(s);
    this.socket = null;
    for (const f of this.closeListeners) f(code, reason);

    // 정상 종료(1000)·수동 종료·앱레벨 종료(4000+ : DATA_VERSION/superseded/inactive)는 재연결하지 않는다.
    if (this.manualClose || code === CLOSE_NORMAL || code >= 4000) {
      this.setState(code >= 4000 && !this.manualClose ? 'failed' : 'idle');
      return;
    }
    // 비정상 전송 절단(1006 등) → 지수 백오프 재연결.
    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setState('failed');
      return;
    }
    const delay = backoffDelayMs(this.attempt);
    this.attempt++;
    this.setState('reconnecting');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private flushQueue(): void {
    if (!this.socket) return;
    while (this.sendQueue.length > 0) {
      const msg = this.sendQueue.shift()!;
      this.socket.send(JSON.stringify(msg));
    }
  }

  private detachSocket(s: WebSocketLike): void {
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
  }

  private setState(s: ConnState): void {
    if (s === this.state) return;
    this.state = s;
    for (const f of this.stateListeners) f(s);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private registerPagehide(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', this.pagehideHandler);
  }

  private unregisterPagehide(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.pagehideHandler);
  }
}
