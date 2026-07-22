// spec: docs/05 §7.1(grace 15s)·§7.2(재접속 절차 — welcome{resumed}·race-sync·구 WS 4001·left→관전)·
//       §13-F1/F2(grace·만료), docs/00 §11-D7 + WT-M4-05 [완료 조건]
//
// 재연결/관전 종단 테스트(vitest-pool-workers). grace 중 resume → connected 복원 + race-sync
// 정확성, grace 만료 후 resume → 관전(입력 거부), 구 WS 4001 대체, 재접속 직후 중복 complete(idx−1)
// 멱등을 검증한다. 시간 게이트는 주입 클록(fireAlarmAt/setSeam)으로 결정적 구동.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DATA_VERSION,
  Client,
  connect,
  createRoom,
  debug,
  fireAlarmAt,
  inputFor,
  newRoomCode,
  rawConnect,
  setSeam,
  sleep,
  startRace,
  stubFor,
  type Stub,
} from './_room-harness';
import type { PlayerRecord } from '../src/do/room-state';

async function resumeKeyOf(stub: Stub, playerId: string): Promise<string> {
  return runInDurableObject(stub, (inst) => {
    const players = (inst as unknown as { players: Map<string, PlayerRecord> }).players;
    return players.get(playerId)!.resumeKey;
  });
}

/** 새 소켓으로 resume hello 전송(재접속). welcome을 반환. */
async function resumeConnect(
  stub: Stub,
  guestId: string,
  playerId: string,
  resumeKey: string,
): Promise<Client> {
  const re = await rawConnect(stub);
  re.send({
    type: 'hello',
    auth: { kind: 'guest', guestId },
    dataVersion: DATA_VERSION,
    resume: { playerId, resumeKey },
  });
  return re;
}

describe('MatchRoom DO — grace 재접속 복원(§7.2)', () => {
  it('grace 중 resume → connected 복원 + race-sync(nextIdx/serverElapsedMs/combo)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const rk = await resumeKeyOf(stub, p1.playerId);
    const { startAt, countries } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    // p1이 2개국 완주(combo 2, nextIdx 2).
    for (let i = 0; i < 2; i++) {
      p1.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 1000, errThis: 0 });
      await p1.take('country-accepted');
    }

    // p1 소켓 끊김 → grace 진입.
    p1.close();
    let graceDeadline = 0;
    for (let i = 0; i < 60 && graceDeadline === 0; i++) {
      const d = await debug(stub);
      const rec = d.players.find((p) => p.id === p1.playerId);
      if (rec && rec.connState === 'grace') graceDeadline = d.alarms.graceDeadlines[p1.playerId] ?? 0;
      await sleep(6);
    }
    expect(graceDeadline).toBeGreaterThan(0);

    // grace 만료 전 재접속 → connected 복원 + race-sync.
    await setSeam(stub, (s) => (s.testClock = startAt + 3000));
    const re = await resumeConnect(stub, 'g1', p1.playerId, rk);
    const welcome = await re.take('welcome');
    expect(welcome.resumed).toBe(true);
    const sync = await re.take('race-sync');
    const me = sync.me as { nextIdx: number; serverElapsedMs: number; combo: number };
    expect(me.nextIdx).toBe(2);
    expect(me.combo).toBe(2);
    expect(me.serverElapsedMs).toBeGreaterThanOrEqual(0);

    const d = await debug(stub);
    expect(d.players.find((p) => p.id === p1.playerId)!.connState).toBe('connected');
    expect(d.alarms.graceDeadlines[p1.playerId]).toBeUndefined();
    re.close();
    p2.close();
  });

  it('재접속 직후 중복 complete(idx−1) 멱등 — 무응답·nextIndex 불변', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const rk = await resumeKeyOf(stub, p1.playerId);
    const { startAt, countries } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));
    p1.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 1000, errThis: 0 });
    await p1.take('country-accepted');

    p1.close();
    await sleep(30);
    const re = await resumeConnect(stub, 'g1', p1.playerId, rk);
    await re.take('welcome');
    await re.take('race-sync');

    // 재접속 직후 이미 승인된 idx=0 재전송(중복) → 조용히 무시.
    re.send({ type: 'complete', idx: 0, input: inputFor(countries[0]!), ct: 1000, errThis: 0 });
    await sleep(50);
    expect(re.has('country-accepted')).toBe(false);
    expect(re.has('country-rejected')).toBe(false);
    expect((await debug(stub)).players.find((p) => p.id === p1.playerId)!.nextIndex).toBe(1);
    re.close();
    p2.close();
  });

  it('구 WS는 새 resume에 4001로 대체(§7.2-5)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const rk = await resumeKeyOf(stub, p1.playerId);
    await startRace(p1, stub);

    let closedCode = 0;
    p1.ws.addEventListener('close', (ev: CloseEvent) => (closedCode = ev.code));
    const re = await resumeConnect(stub, 'g1', p1.playerId, rk);
    await re.take('welcome');
    await sleep(40);
    expect(closedCode).toBe(4001);
    // 활성 소켓은 여전히 1개(중복 아님) — debug players는 2명 유지.
    expect((await debug(stub)).players.length).toBe(2);
    re.close();
    p2.close();
  });
});

describe('MatchRoom DO — grace 만료 후 관전(§7.2-4)', () => {
  it('grace 만료 → left 확정 → resume 시 관전 모드(입력 거부, 트랙만)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    const rk = await resumeKeyOf(stub, p1.playerId);
    const { startAt, countries } = await startRace(p1, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 1000));

    // p1 끊김 → grace → 만료 → left.
    p1.close();
    let graceDeadline = 0;
    for (let i = 0; i < 60 && graceDeadline === 0; i++) {
      const d = await debug(stub);
      const rec = d.players.find((p) => p.id === p1.playerId);
      if (rec && rec.connState === 'grace') graceDeadline = d.alarms.graceDeadlines[p1.playerId] ?? 0;
      await sleep(6);
    }
    expect(graceDeadline).toBeGreaterThan(0);
    await fireAlarmAt(stub, graceDeadline + 1);
    expect((await debug(stub)).players.find((p) => p.id === p1.playerId)!.connState).toBe('left');

    // left 후 재접속 → 관전(welcome.resumed + room-state에 본인 left + race-sync).
    await setSeam(stub, (s) => (s.testClock = graceDeadline + 2000));
    const spec = await resumeConnect(stub, 'g1', p1.playerId, rk);
    const welcome = await spec.take('welcome');
    expect(welcome.resumed).toBe(true);
    const rs = (await spec.take('room-state')) as unknown as {
      players: Array<{ playerId: string; connState: string }>;
    };
    expect(rs.players.find((p) => p.playerId === p1.playerId)!.connState).toBe('left');
    await spec.take('race-sync');

    // 관전자의 입력(complete)은 서버가 거부(무시) — nextIndex 불변.
    const before = (await debug(stub)).players.find((p) => p.id === p1.playerId)!.nextIndex;
    spec.send({ type: 'complete', idx: before, input: inputFor(countries[before]!), ct: 5000, errThis: 0 });
    await sleep(50);
    expect(spec.has('country-accepted')).toBe(false);
    const after = (await debug(stub)).players.find((p) => p.id === p1.playerId)!.nextIndex;
    expect(after).toBe(before);
    spec.close();
    p2.close();
  });

  it('resumeKey 불일치 → AUTH_FAILED(관전 불가)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const p1 = await connect(stub, 'g1', 'Alice');
    const p2 = await connect(stub, 'g2', 'Bob');
    await startRace(p1, stub);
    const bad = await resumeConnect(stub, 'g1', p1.playerId, 'deadbeefdeadbeef');
    const err = await bad.take('error');
    expect(err.code).toBe('AUTH_FAILED');
    bad.close();
    p1.close();
    p2.close();
  });
});
