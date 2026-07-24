// @vitest-environment jsdom
// spec: docs/05 §4.1(프레임·seq)·§7.2(백오프)·§13-F7, docs/03 §6.1, WT-M4-03 완료조건(모의 WS).
// jsdom: pagehide(window 이벤트)와 fake timer 백오프 검증에 필요. WebSocket은 목을 주입한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectAbortError, WsManager, backoffDelayMs, type WebSocketLike } from './ws-manager';
import type { ServerMessage } from '@wt/shared';

class MockWebSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  // 테스트 헬퍼 — 서버 측 이벤트 시뮬레이션.
  fireOpen(): void {
    this.onopen?.();
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  fireClose(code: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }
}

function makeManager(): { ws: WsManager; sockets: MockWebSocket[] } {
  const sockets: MockWebSocket[] = [];
  const ws = new WsManager({
    createSocket: (url) => {
      const s = new MockWebSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { ws, sockets };
}

const welcomeFrame = JSON.stringify({
  v: 1,
  type: 'welcome',
  ack: 1,
  playerId: 'p1',
  resumeKey: 'k',
  serverTime: 123,
  resumed: false,
});

describe('backoffDelayMs (§7.2 0.5→1→2→4→8s 상한)', () => {
  it('0.5s→1s→2s→4s→8s로 증가하고 8s에서 상한', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });
});

describe('WsManager 송신 큐 + seq 스탬핑', () => {
  it('open 전 send는 큐잉되고 open 시 순서대로 flush + seq 단조 증가', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    const seq1 = ws.send({ v: 1, type: 'ready', ready: true });
    const seq2 = ws.send({ v: 1, type: 'chat', text: 'hi' });
    expect([seq1, seq2]).toEqual([1, 2]);
    expect(sockets[0]!.sent).toEqual([]); // open 전 — 아직 전송 안 됨

    sockets[0]!.fireOpen();
    expect(sockets[0]!.sent.map((s) => JSON.parse(s).seq)).toEqual([1, 2]);

    const seq3 = ws.send({ v: 1, type: 'leave' });
    expect(seq3).toBe(3);
    expect(JSON.parse(sockets[0]!.sent[2]!).seq).toBe(3); // open 후 — 즉시 전송
  });

  it('송신 큐 상한(32) 초과 시 가장 오래된 것부터 폐기', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    for (let i = 0; i < 40; i++) ws.send({ v: 1, type: 'ready', ready: true });
    sockets[0]!.fireOpen();
    const seqs = sockets[0]!.sent.map((s) => JSON.parse(s).seq);
    expect(seqs.length).toBe(32);
    expect(seqs[0]).toBe(9); // seq 1~8 폐기, 9~40 유지
    expect(seqs.at(-1)).toBe(40);
  });
});

describe('WsManager 수신 프레임 파싱(폐기형)', () => {
  it('유효 프레임은 파싱해 리스너에 전달, 손상 프레임은 폐기', () => {
    const { ws, sockets } = makeManager();
    const got: ServerMessage[] = [];
    ws.onMessage((m) => got.push(m));
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();

    sockets[0]!.fireMessage(welcomeFrame);
    sockets[0]!.fireMessage('not json{');
    sockets[0]!.fireMessage(JSON.stringify({ v: 1, type: 'welcome' })); // 필드 누락 → 스키마 위반
    sockets[0]!.fireMessage(JSON.stringify({ v: 1, type: 'unknown-x' })); // 미지 타입

    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe('welcome');
  });
});

describe('WsManager 재연결 백오프(§7.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('비정상 절단(1006) → 500ms 후 재연결', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);
    expect(ws.getState()).toBe('reconnecting');
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1); // 아직
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // 500ms 경과 → 새 소켓
  });

  it('5회 재연결 실패 후 failed', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    // 최초 소켓 포함 6개까지: close마다 백오프 후 재연결, 5회 소진 시 failed.
    sockets[0]!.fireClose(1006);
    for (const d of [500, 1000, 2000, 4000, 8000]) {
      vi.advanceTimersByTime(d);
      const latest = sockets.at(-1)!;
      latest.fireClose(1006);
    }
    expect(sockets).toHaveLength(6); // 초기 1 + 재연결 5
    expect(ws.getState()).toBe('failed');
  });

  it('정상 종료(1000)는 재연결하지 않고 idle', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1000);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(ws.getState()).toBe('idle');
  });

  it('앱레벨 종료(4426 DATA_VERSION)는 재연결하지 않고 failed + onClose 통지', () => {
    const { ws, sockets } = makeManager();
    const closes: number[] = [];
    ws.onClose((code) => closes.push(code));
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(4426);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(ws.getState()).toBe('failed');
    expect(closes).toEqual([4426]);
  });
});

describe('WsManager pagehide', () => {
  it('pagehide 발생 시 close(1000) 호출', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    window.dispatchEvent(new Event('pagehide'));
    expect(sockets[0]!.closed).toEqual({ code: 1000, reason: undefined });
    expect(ws.getState()).toBe('idle');
  });
});

describe('WsManager 재연결 URL 재발급(§11-D89)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('프로바이더가 있으면 1006 절단 후 신선 URL(신규 티켓)로 새 소켓을 연다', async () => {
    const { ws, sockets } = makeManager();
    const provider = vi.fn(async () => 'ws://x/ws/room/AAA?ticket=fresh');
    ws.connect('ws://x/ws/room/AAA?ticket=stale', provider);
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);
    expect(ws.getState()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(500);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe('ws://x/ws/room/AAA?ticket=fresh'); // 죽은 티켓 재사용 아님
  });

  it('프로바이더가 ReconnectAbortError를 던지면 추가 소켓 없이 즉시 failed(터미널 중단)', async () => {
    const { ws, sockets } = makeManager();
    const provider = vi.fn(async () => {
      throw new ReconnectAbortError('ROOM_NOT_FOUND');
    });
    ws.connect('ws://x/ws/room/AAA', provider);
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(1);
    expect(ws.getState()).toBe('failed');
  });

  it('프로바이더 일반 예외는 시도 1회를 소모하고 백오프를 지속해 5회 소진 후 failed', async () => {
    const { ws, sockets } = makeManager();
    const provider = vi.fn(async () => {
      throw new Error('503 transient');
    });
    ws.connect('ws://x/ws/room/AAA', provider);
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);

    for (const d of [500, 1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(d);
    }
    expect(provider).toHaveBeenCalledTimes(5); // 재발급 5회 모두 실패
    expect(sockets).toHaveLength(1); // open에 도달 못 함
    expect(ws.getState()).toBe('failed');
  });

  it('재발급 대기 중 close()면 epoch 가드로 새 소켓을 만들지 않는다', async () => {
    const { ws, sockets } = makeManager();
    let release: (url: string) => void = () => {};
    const provider = vi.fn(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );
    ws.connect('ws://x/ws/room/AAA', provider);
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);

    await vi.advanceTimersByTimeAsync(500); // reopen 시작 → provider await 중
    expect(provider).toHaveBeenCalledTimes(1);

    ws.close(1000); // epoch++ + manualClose — 진행 중 재발급 무효화
    release('ws://x/ws/room/AAA?ticket=late');
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets).toHaveLength(1); // 폐기 — 새 소켓 미생성
    expect(ws.getState()).toBe('idle');
  });

  it('프로바이더가 없으면(1-인자 connect) 동일 URL로 재연결한다(기존 동작 보존)', () => {
    const { ws, sockets } = makeManager();
    ws.connect('ws://x/ws/room/AAA');
    sockets[0]!.fireOpen();
    sockets[0]!.fireClose(1006);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe('ws://x/ws/room/AAA');
  });
});
