// spec: WT-M4-02 acceptance(조정) — wscat 수동 확인을 Node ws 클라이언트로 자동화.
//   quick → ticket → /ws/room/:code 접속 → hello/welcome 왕복(+ join/room-state)을 실 HTTP/WS
//   경로(wrangler dev 8787)로 검증한다. Node 21+ 내장 global fetch/WebSocket만 사용(추가 의존 0).
//
// 사용법(별도 터미널에서 서버 기동 후):
//   pnpm --filter @wt/api run e2e:dev        # wrangler dev @ 8787 (persist 격리 + 마이그레이션)
//   node tooling/ops/wt-m4-02-ws-roundtrip.mjs
// 성공 시 exit 0, 각 단계 로그를 stdout에 남긴다.

const BASE = process.env.WT_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const log = (...a) => console.log('[roundtrip]', ...a);

async function main() {
  // 1) 익명 세션 부트스트랩
  const sres = await fetch(`${BASE}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  if (!sres.ok) throw new Error(`session ${sres.status}`);
  const { token, playerId } = await sres.json();
  log('session ok — playerId', playerId);

  // 2) 퀵매치 → roomCode + ticket + wsUrl
  const qres = await fetch(`${BASE}/api/v1/match/quick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lang: 'en' }),
  });
  if (!qres.ok) throw new Error(`quick ${qres.status}`);
  const grant = await qres.json();
  log('quick ok —', JSON.stringify({ roomCode: grant.roomCode, wsUrl: grant.wsUrl, mode: grant.mode, retryOnWrongPhase: grant.retryOnWrongPhase }));

  // 3) /ws/room/:code?ticket= 접속 → hello → welcome → join → room-state
  const url = `${WS_BASE}${grant.wsUrl}?ticket=${encodeURIComponent(grant.ticket)}`;
  log('connecting', url);
  const ws = new WebSocket(url);
  const seen = { welcome: false, roomState: false };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting welcome/room-state')), 10_000);
    ws.addEventListener('open', () => {
      log('ws open — sending hello');
      ws.send(JSON.stringify({ v: 1, type: 'hello', seq: 1, auth: { kind: 'session', token }, dataVersion: 'devlocal' }));
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + String(e.message ?? e))));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      log('recv', m.type);
      if (m.type === 'welcome') {
        seen.welcome = true;
        log('welcome ok — resumeKey present:', typeof m.resumeKey === 'string', 'serverTime:', typeof m.serverTime === 'number');
        ws.send(JSON.stringify({ v: 1, type: 'join', seq: 2, nickname: 'RTPROBE', passportCover: 'green' }));
      } else if (m.type === 'room-state') {
        seen.roomState = true;
        log('room-state ok — phase', m.phase, 'players', m.players.length);
        clearTimeout(timer);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(timer);
        reject(new Error('server error: ' + m.code + ' ' + m.message));
      }
    });
  });

  if (!seen.welcome || !seen.roomState) throw new Error('did not complete hello/welcome + join/room-state');
  log('ROUNDTRIP PASS — quick → ticket → /ws/room/:code → hello/welcome → join/room-state');
  // 소켓 close 핸들이 정착한 뒤 종료(Windows libuv UV_HANDLE_CLOSING assertion 회피).
  try { ws.close(1000); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 250));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[roundtrip] FAIL:', err.message);
    process.exit(1);
  },
);
