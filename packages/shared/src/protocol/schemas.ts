// spec: docs/05 §4.2(타입 전문과 1:1 대응하는 zod 스키마, 서버 파싱용 .strict()),
//       docs/00 §11-D7(05 §4.2가 유일한 원천)
// WT-M1-03 — MatchRoom DO가 들어오는 WS 프레임을 파싱할 때 쓰는 유일한 검증기.
// 여기서 정의한 스키마 외의 필드 조합은 전부 거부된다(.strict()).
//
// zod를 @wt/shared의 런타임 의존성으로 추가(docs/00 §6 "의존성 0"의 유일한 예외 —
// 리드 승인, WT-M1-03 세션 어댑테이션 §3). 클라·서버 양쪽에 동일 번들된다.

import { z } from 'zod';
import type {
  C2S_Hello,
  C2S_Join,
  C2S_Ready,
  C2S_Start,
  C2S_Chat,
  C2S_BotAccept,
  C2S_Progress,
  C2S_Complete,
  C2S_TimeSync,
  C2S_Rematch,
  C2S_Leave,
  ClientMessage,
} from './messages';

// ───────────────────────── 타입 레벨 일치 검증 유틸 ─────────────────────────
// z.infer<typeof XSchema>가 messages.ts의 X 타입과 정확히 동일 구조인지 컴파일 타임에 검사한다.
// 불일치 시 해당 _Check* 타입 위치에서 타입 에러가 발생해 빌드가 깨진다(런타임 비용 0).

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// ───────────────────────── 공통 필드 ─────────────────────────

const V1 = z.literal(1);
const SEQ = z.number().int().nonnegative();

// ───────────────────────── Client → Server 스키마 ─────────────────────────

const AuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('guest'), guestId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('session'), token: z.string().min(1) }).strict(),
]);

export const HelloSchema = z
  .object({
    v: V1,
    type: z.literal('hello'),
    seq: SEQ,
    auth: AuthSchema,
    resume: z.object({ playerId: z.string().min(1), resumeKey: z.string().min(1) }).strict().optional(),
    dataVersion: z.string().min(1),
  })
  .strict();
type _CheckHello = Assert<Equal<z.infer<typeof HelloSchema>, C2S_Hello>>;

export const JoinSchema = z
  .object({
    v: V1,
    type: z.literal('join'),
    seq: SEQ,
    nickname: z.string().min(1).max(16),
    passportCover: z.string().min(1),
    joinTicket: z.string().min(1).optional(),
  })
  .strict();
type _CheckJoin = Assert<Equal<z.infer<typeof JoinSchema>, C2S_Join>>;

export const ReadySchema = z
  .object({ v: V1, type: z.literal('ready'), seq: SEQ, ready: z.boolean() })
  .strict();
type _CheckReady = Assert<Equal<z.infer<typeof ReadySchema>, C2S_Ready>>;

export const StartSchema = z.object({ v: V1, type: z.literal('start'), seq: SEQ }).strict();
type _CheckStart = Assert<Equal<z.infer<typeof StartSchema>, C2S_Start>>;

export const ChatSchema = z
  .object({ v: V1, type: z.literal('chat'), seq: SEQ, text: z.string().max(120) })
  .strict();
type _CheckChat = Assert<Equal<z.infer<typeof ChatSchema>, C2S_Chat>>;

export const BotAcceptSchema = z
  .object({ v: V1, type: z.literal('bot-accept'), seq: SEQ, accept: z.boolean() })
  .strict();
type _CheckBotAccept = Assert<Equal<z.infer<typeof BotAcceptSchema>, C2S_BotAccept>>;

export const ProgressSchema = z
  .object({
    v: V1,
    type: z.literal('progress'),
    seq: SEQ,
    idx: z.number().int().nonnegative(),
    ks: z.number().int().nonnegative(),
    err: z.number().int().nonnegative(),
  })
  .strict();
type _CheckProgress = Assert<Equal<z.infer<typeof ProgressSchema>, C2S_Progress>>;

export const CompleteSchema = z
  .object({
    v: V1,
    type: z.literal('complete'),
    seq: SEQ,
    idx: z.number().int().nonnegative(),
    input: z.string().max(64),
    ct: z.number().nonnegative(),
    errThis: z.number().int().nonnegative(),
  })
  .strict();
type _CheckComplete = Assert<Equal<z.infer<typeof CompleteSchema>, C2S_Complete>>;

export const TimeSyncSchema = z
  .object({ v: V1, type: z.literal('timesync'), seq: SEQ, t0: z.number().nonnegative() })
  .strict();
type _CheckTimeSync = Assert<Equal<z.infer<typeof TimeSyncSchema>, C2S_TimeSync>>;

export const RematchSchema = z
  .object({ v: V1, type: z.literal('rematch'), seq: SEQ, vote: z.boolean() })
  .strict();
type _CheckRematch = Assert<Equal<z.infer<typeof RematchSchema>, C2S_Rematch>>;

export const LeaveSchema = z.object({ v: V1, type: z.literal('leave'), seq: SEQ }).strict();
type _CheckLeave = Assert<Equal<z.infer<typeof LeaveSchema>, C2S_Leave>>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  JoinSchema,
  ReadySchema,
  StartSchema,
  ChatSchema,
  BotAcceptSchema,
  ProgressSchema,
  CompleteSchema,
  TimeSyncSchema,
  RematchSchema,
  LeaveSchema,
]);
type _CheckClientMessage = Assert<Equal<z.infer<typeof ClientMessageSchema>, ClientMessage>>;

// ───────────────────────── 파서 ─────────────────────────

export type ParseClientMessageResult =
  | { ok: true; data: ClientMessage }
  | { ok: false; error: string };

/**
 * 원문 WS 프레임(JSON 문자열)을 파싱해 판별 유니온으로 좁힌다.
 * JSON 파싱 실패·스키마 불일치(초과 필드·타입 오류 포함, .strict()에 의해 거부)는
 * 전부 { ok: false }로 반환한다 — 호출부(MatchRoom)가 이 값으로 `error{code:'BAD_MESSAGE'}`를 회신한다.
 */
export function parseClientMessage(raw: string): ParseClientMessageResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, data: result.data };
}
