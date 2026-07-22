// spec: docs/05 §2.3-5(봇 채우기·KV ghost 링 버퍼·스케줄 재생)·§13-F11(내장 프로필 폴백),
//       docs/00 §11 Q4(PI 250/350/450 파 타임 역산) + WT-M4-05 [완료 조건]
//
// 고스트 봇 테스트(vitest-pool-workers): (1) 순수 역산/버킷/링버퍼, (2) 컨슈머 ghost-collect → KV,
// (3) DO 종단 — bot-offer(60s)·bot-accept 삽입·tick 재생·is_bot_match·수집 게이팅. KV/DO 상태는
// 유니크 키(버킷·방 코드)로 자체 격리(isolatedStorage=false, 세션 어댑테이션 §2).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_GHOST_PROFILES,
  appendGhostRecording,
  deriveBuiltinCumSplits,
  fitRecordingCumSplits,
  loadGhostRecordings,
  piBucketOf,
} from '../src/lib/ghost';
import { handleQueueBatch, type GhostCollectQueueMessage } from '../src/queue/consumer';
import {
  Client,
  connect,
  createRoom,
  debug,
  fireAlarmAt,
  inputFor,
  newRoomCode,
  runTickAt,
  setSeam,
  sleep,
  startRace,
  stubFor,
  withInstance,
} from './_room-harness';

// ───────────────────────── 순수 함수: 역산·버킷·fit ─────────────────────────

describe('ghost.piBucketOf (100 단위 반올림, Q4 기본 350)', () => {
  it('null/undefined → 기본 버킷 350', () => {
    expect(piBucketOf(null)).toBe('350');
    expect(piBucketOf(undefined)).toBe('350');
  });
  it('100 단위 반올림', () => {
    expect(piBucketOf(423)).toBe('400');
    expect(piBucketOf(449)).toBe('400');
    expect(piBucketOf(451)).toBe('500');
    expect(piBucketOf(80)).toBe('100');
    expect(piBucketOf(40)).toBe('0');
  });
});

describe('ghost.deriveBuiltinCumSplits (PI 파 타임 역산)', () => {
  // en: requiredKeystrokes = 이름 길이. targetPi=300이면 국가별 ms = ks×200(정수, 무손실) →
  // cpm = totalKs / (누적/60000) = 정확히 300으로 수렴한다(역산 근거 검증).
  const countries = Array.from({ length: 15 }, (_, i) => ({
    nameKo: '가'.repeat(i + 3),
    nameEn: 'a'.repeat(i + 3),
  }));

  it('길이 일치 + 단조 증가', () => {
    const cum = deriveBuiltinCumSplits(countries, 'en', 300);
    expect(cum.length).toBe(15);
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThan(cum[i - 1]!);
  });

  it('클린 재생 cpm이 targetPi로 수렴(acc=1 → PI=cpm)', () => {
    for (const pi of [250, 350, 450]) {
      const cum = deriveBuiltinCumSplits(countries, 'en', pi);
      const totalKs = countries.reduce((s, c) => s + c.nameEn.length, 0);
      const cpm = totalKs / (cum[cum.length - 1]! / 60_000);
      expect(Math.abs(cpm - pi)).toBeLessThan(2); // 라운딩 오차 이내
    }
  });

  it('내장 프로필 3종은 PI 250/350/450·GHOST 라벨', () => {
    expect(BUILTIN_GHOST_PROFILES.map((p) => p.targetPi)).toEqual([250, 350, 450]);
    for (const p of BUILTIN_GHOST_PROFILES) expect(p.nickname.startsWith('GHOST')).toBe(true);
  });
});

describe('ghost.fitRecordingCumSplits (세트 길이 맞춤)', () => {
  it('같은 길이 → 그대로', () => {
    expect(fitRecordingCumSplits([1000, 2000, 3000], 3)).toEqual([1000, 2000, 3000]);
  });
  it('긴 기록 → 절단', () => {
    expect(fitRecordingCumSplits([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });
  it('짧은 기록 → 단조 증가로 외삽(길이 정합)', () => {
    const out = fitRecordingCumSplits([1000, 2000, 3000], 5);
    expect(out.length).toBe(5);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });
});

// ───────────────────────── KV 링 버퍼 + 컨슈머 ─────────────────────────

describe('ghost KV 링 버퍼(≤20) + loadGhostRecordings', () => {
  it('25건 적재 → 최대 20 보관, 최신순 로드', async () => {
    const bucket = 'unit-ring';
    for (let i = 0; i < 25; i++) {
      await appendGhostRecording(env.KV, 'en', 'race-mixed', bucket, { cumSplitsMs: [i, i + 1] });
    }
    const all = await loadGhostRecordings(env.KV, 'en', 'race-mixed', bucket, 100);
    expect(all.length).toBe(20); // 링 상한
    // 가장 오래된 5건(0~4)은 밀려났다 — 첫 값이 5.
    expect(all[0]!.cumSplitsMs[0]).toBe(5);
    const three = await loadGhostRecordings(env.KV, 'en', 'race-mixed', bucket, 3);
    expect(three.length).toBe(3);
    expect(three[2]!.cumSplitsMs[0]).toBe(24); // 최신
  });

  it('miss → 빈 배열', async () => {
    const recs = await loadGhostRecordings(env.KV, 'en', 'race-mixed', 'no-such-bucket', 3);
    expect(recs).toEqual([]);
  });
});

describe('queue consumer — ghost-collect → KV 적재', () => {
  it('ghost-collect 메시지 → 해당 버킷 링 버퍼에 적재', async () => {
    const bucket = 'consumer-bkt';
    const msg: GhostCollectQueueMessage = {
      type: 'ghost-collect',
      lang: 'en',
      mode: 'race-mixed',
      piBucket: bucket,
      cumSplitsMs: [1000, 2100, 3300],
      createdAt: Date.now(),
    };
    let acked = 0;
    const batch = {
      queue: 'wt-events-dev',
      messages: [{ id: '1', timestamp: new Date(), body: msg, attempts: 1, ack: () => (acked += 1), retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;
    await handleQueueBatch(batch, env);
    expect(acked).toBe(1);
    const recs = await loadGhostRecordings(env.KV, 'en', 'race-mixed', bucket, 10);
    expect(recs.length).toBe(1);
    expect(recs[0]!.cumSplitsMs).toEqual([1000, 2100, 3300]);
  });
});

// ───────────────────────── DO 종단: bot-offer / accept / 재생 ─────────────────────────

describe('MatchRoom DO — bot-offer(§2.3-5, 1인 60초)', () => {
  it('퀵매치 1인 → botOffer 타이머 무장 → 만기 시 bot-offer 수신', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');
    await sleep(30);
    const offerAt = (await debug(stub)).alarms.botOffer;
    expect(offerAt).not.toBeNull();
    await fireAlarmAt(stub, offerAt! + 1);
    const offer = await a.take('bot-offer');
    expect(typeof offer.expiresAt).toBe('number');
    a.close();
  });
});

describe('MatchRoom DO — bot-accept 삽입 + tick 재생(§2.3-5)', () => {
  it('accept → GHOST 봇 삽입 + 스케줄 파생(15) + COUNTDOWN', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'bot-accept', accept: true });
    await a.take('countdown');
    const d = await debug(stub);
    const bots = d.players.filter((p) => p.isBot);
    expect(bots.length).toBeGreaterThanOrEqual(1);
    expect(bots.length).toBeLessThanOrEqual(3);
    for (const b of bots) {
      expect(b.nickname.startsWith('GHOST')).toBe(true);
      expect(b.botScheduleLen).toBe(15); // race-mixed 세트 길이
    }
    a.close();
  });

  it('RACING tick 재생 → 봇 nextIndex 전진 → 완주(rank 확정, suspicion 없음)', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');
    a.send({ type: 'bot-accept', accept: true });
    const cd = await a.take('countdown');
    const start = await a.take('start');
    const startAt = cd.startAt as number;
    await fireAlarmAt(stub, startAt); // → RACING

    // 스케줄 일부만 지난 시점: 봇이 부분 전진(0 < nextIndex < 15).
    await runTickAt(stub, startAt + 3000);
    const mid = (await debug(stub)).players.filter((p) => p.isBot);
    expect(mid.some((b) => b.nextIndex > 0 && b.nextIndex < 15)).toBe(true);

    // 사람도 전 국가 완주(all-finished 성립 조건).
    await setSeam(stub, (s) => (s.testClock = startAt + 2000));
    const countries = start.countries as string[];
    for (let i = 0; i < countries.length; i++) {
      a.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 2000, errThis: 0 });
      await a.take('country-accepted');
    }
    // 스케줄 전체를 지난 tick → 봇 완주 → all-finished.
    await runTickAt(stub, startAt + 120_000);
    const d = await debug(stub);
    const bots = d.players.filter((p) => p.isBot);
    for (const b of bots) {
      expect(b.nextIndex).toBe(15);
      expect(b.finishedAt).not.toBeNull();
      expect(b.rank).not.toBeNull();
      expect(b.suspicionFlags.length).toBe(0); // 봇은 안티치트 대상 아님
    }
    expect(d.phase).toBe('FINISHED');
    a.close();
  });

  it('봇 매치는 is_bot_match=1 (D1) + 고스트 수집 안 함', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code, { quickMatch: true });
    const a = await connect(stub, 'g1', 'Alice');

    // EVENTS 스파이 주입(수집 enqueue 관찰).
    const captured: GhostCollectQueueMessage[] = [];
    await withInstance(stub, (inst) => {
      (inst as { env: { EVENTS: { send: (m: unknown) => Promise<void> } } }).env.EVENTS = {
        send: async (m: unknown) => {
          captured.push(m as GhostCollectQueueMessage);
        },
      };
    });

    a.send({ type: 'bot-accept', accept: true });
    const cd = await a.take('countdown');
    const start = await a.take('start');
    const startAt = cd.startAt as number;
    await fireAlarmAt(stub, startAt);
    await setSeam(stub, (s) => (s.testClock = startAt + 2000));
    const countries = start.countries as string[];
    for (let i = 0; i < countries.length; i++) {
      a.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 2000, errThis: 0 });
      await a.take('country-accepted');
    }
    await runTickAt(stub, startAt + 120_000);
    const results = await a.take('results');

    // D1 matches.is_bot_match=1.
    const raceId = results.raceId as string;
    const row = await env.DB.prepare('SELECT is_bot_match FROM matches WHERE id = ?1').bind(raceId).first<{ is_bot_match: number }>();
    expect(row?.is_bot_match).toBe(1);
    // 봇 매치는 고스트로 재수집하지 않는다.
    expect(captured.length).toBe(0);
    a.close();
  });
});

describe('MatchRoom DO — 클린 사람 매치 고스트 수집(§2.3-5)', () => {
  it('is_bot_match=0 클린 완주자 스플릿을 ghost-collect로 enqueue', async () => {
    const code = newRoomCode();
    const stub = stubFor(code);
    await createRoom(stub, code);
    const a = await connect(stub, 'g1', 'Alice');
    const b = await connect(stub, 'g2', 'Bob');

    const captured: GhostCollectQueueMessage[] = [];
    await withInstance(stub, (inst) => {
      (inst as { env: { EVENTS: { send: (m: unknown) => Promise<void> } } }).env.EVENTS = {
        send: async (m: unknown) => {
          captured.push(m as GhostCollectQueueMessage);
        },
      };
    });

    const { startAt, countries } = await startRace(a, stub);
    await setSeam(stub, (s) => (s.testClock = startAt + 2000));
    const finishAll = async (c: Client): Promise<void> => {
      for (let i = 0; i < countries.length; i++) {
        c.send({ type: 'complete', idx: i, input: inputFor(countries[i]!), ct: 2000, errThis: 0 });
        await c.take('country-accepted');
      }
    };
    await finishAll(a);
    await finishAll(b);
    await a.take('results');

    // 두 클린 완주자 각각 ghost-collect enqueue(cumSplitsMs 길이=세트 길이).
    const ghostMsgs = captured.filter((m) => m.type === 'ghost-collect');
    expect(ghostMsgs.length).toBe(2);
    for (const m of ghostMsgs) {
      expect(m.mode).toBe('race-mixed');
      expect(m.cumSplitsMs.length).toBe(countries.length);
      expect(typeof m.piBucket).toBe('string');
    }
    a.close();
    b.close();
  });
});
