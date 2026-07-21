// spec: docs/05 §4.2 (zod 스키마, .strict()), WT-M1-03 vitest 케이스 ⑤⑥
import { describe, expect, it } from 'vitest';
import type { ClientMessage } from './messages';
import { ClientMessageSchema, parseClientMessage } from './schemas';

const samples: ClientMessage[] = [
  {
    v: 1,
    type: 'hello',
    seq: 1,
    auth: { kind: 'guest', guestId: 'g_01J2ZK8Q3W' },
    dataVersion: 'a3f9c1d2',
  },
  {
    v: 1,
    type: 'hello',
    seq: 1,
    auth: { kind: 'session', token: 'tok_abc' },
    resume: { playerId: 'p_1', resumeKey: 'r_1' },
    dataVersion: 'a3f9c1d2',
  },
  { v: 1, type: 'join', seq: 2, nickname: '김치워리어', passportCover: 'green-basic' },
  { v: 1, type: 'join', seq: 2, nickname: 'a', passportCover: 'x', joinTicket: 't1' },
  { v: 1, type: 'ready', seq: 3, ready: true },
  { v: 1, type: 'start', seq: 4 },
  { v: 1, type: 'chat', seq: 5, text: 'hello' },
  { v: 1, type: 'bot-accept', seq: 6, accept: false },
  { v: 1, type: 'progress', seq: 17, idx: 3, ks: 2, err: 1 },
  { v: 1, type: 'complete', seq: 21, idx: 3, input: '태국', ct: 24310, errThis: 0 },
  { v: 1, type: 'timesync', seq: 5, t0: 10321.5 },
  { v: 1, type: 'rematch', seq: 7, vote: true },
  { v: 1, type: 'leave', seq: 8 },
];

describe('parseClientMessage — ⑤ round trip (serialize → parse → deepEqual)', () => {
  it.each(samples)('round-trips %o', (msg) => {
    const raw = JSON.stringify(msg);
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(msg);
    }
  });
});

describe('parseClientMessage — ⑥ rejects malformed frames', () => {
  it('rejects invalid JSON', () => {
    const result = parseClientMessage('{not json');
    expect(result.ok).toBe(false);
  });

  it('rejects unknown message type', () => {
    const result = parseClientMessage(JSON.stringify({ v: 1, type: 'nope', seq: 1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects extra/unrecognized fields (.strict())', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'ready', seq: 1, ready: true, extra: 'field' }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects wrong field type (idx as string instead of number)', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'progress', seq: 1, idx: '3', ks: 2, err: 0 }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing required field', () => {
    const result = parseClientMessage(JSON.stringify({ v: 1, type: 'progress', seq: 1, idx: 0 }));
    expect(result.ok).toBe(false);
  });

  it('rejects nickname over 16 chars', () => {
    const result = parseClientMessage(
      JSON.stringify({
        v: 1,
        type: 'join',
        seq: 1,
        nickname: 'x'.repeat(17),
        passportCover: 'p',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects empty nickname (min 1)', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'join', seq: 1, nickname: '', passportCover: 'p' }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects chat text over 120 chars', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'chat', seq: 1, text: 'a'.repeat(121) }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects complete.input over 64 chars', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'complete', seq: 1, idx: 0, input: 'a'.repeat(65), ct: 0, errThis: 0 }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects negative seq', () => {
    const result = parseClientMessage(JSON.stringify({ v: 1, type: 'leave', seq: -1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer idx in progress', () => {
    const result = parseClientMessage(
      JSON.stringify({ v: 1, type: 'progress', seq: 1, idx: 1.5, ks: 0, err: 0 }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects wrong v (protocol version)', () => {
    const result = parseClientMessage(JSON.stringify({ v: 2, type: 'leave', seq: 1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects auth with unknown kind', () => {
    const result = parseClientMessage(
      JSON.stringify({
        v: 1,
        type: 'hello',
        seq: 1,
        auth: { kind: 'anonymous', guestId: 'g1' },
        dataVersion: 'a3f9c1d2',
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('ClientMessageSchema', () => {
  it('exposes a discriminated union usable directly (safeParse)', () => {
    const result = ClientMessageSchema.safeParse({ v: 1, type: 'leave', seq: 1 });
    expect(result.success).toBe(true);
  });
});
